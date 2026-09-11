/** Sprint 3.5D-B — deterministic, pure, independently testable TESTNET order-sizing math. Nothing in
 * this file touches the network; it exists specifically so quantity-conversion correctness (Task
 * 9-12) can be verified without ever needing a real Binance call. */

export interface BinanceSymbolFilters {
  stepSize: number; minQty: number; maxQty: number; // LOT_SIZE (used for LIMIT)
  marketStepSize: number | null; marketMinQty: number | null; marketMaxQty: number | null; // MARKET_LOT_SIZE (used for MARKET); null if the symbol has no separate market filter — falls back to LOT_SIZE
  minNotional: number | null; // MIN_NOTIONAL.notional, if the symbol has one
}

/** Task 9 — `effective notional = ExecutionDraft.positionSize (USDT)`, never divided by leverage here
 * (leverage only determines required margin, checked separately by Risk Guard's existing
 * account_balance rule and by this sprint's own leverage-match check). Reference price is the
 * caller's job to pick (limitPrice for LIMIT, fresh markPrice for MARKET — Task 9). */
export function computeRawEntryQuantity(positionSizeUsdt: number, referencePrice: number): number {
  return positionSizeUsdt / referencePrice;
}

/** Task 11 — decimal-safe round-DOWN to a valid exchange step size, never up (never accidentally
 * exceed the user's intended notional), never a bare `toFixed()` (which rounds, and is not
 * exchange-precision-safe under floating point). Works by scaling both operands to integers using
 * the step size's own decimal precision, flooring in integer space, then scaling back — avoids the
 * classic `0.012345 / 0.001` floating-point drift (e.g. `12.999999999999998`) that a naive
 * `Math.floor` would mis-round. */
export function roundDownToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return NaN;
  const stepStr = step.toString();
  const decimalIdx = stepStr.indexOf('.');
  const decimals = decimalIdx === -1 ? 0 : stepStr.length - decimalIdx - 1;
  // A tiny epsilon added before flooring cancels ONLY floating-point representation noise (e.g. a
  // value that is mathematically exactly on a step boundary but stored as `11.999999999997`) — it
  // must never be large enough to change which step bucket a genuinely-in-between value falls into,
  // or this degrades into rounding (which can round UP) instead of a true floor.
  const EPS = 1e-9;
  const steps = Math.floor(value / step + EPS);
  const raw = steps * step;
  const scale = Math.pow(10, decimals);
  return Math.round(raw * scale) / scale; // fixes float noise from the steps*step multiplication itself (e.g. 12*0.001 -> 0.012000000000000002), never changes the value
}

export interface QuantityValidationInput {
  quantity: number;
  referencePrice: number;
  filters: { minQty: number; maxQty: number; stepSize: number; minNotional: number | null };
}

/** Task 12 — every check that must pass before a request is ever sent to Binance; any failure BLOCKs
 * locally with a specific, readable reason. Never silently clamps an out-of-range value into range. */
export function validateOrderQuantity(input: QuantityValidationInput): { ok: true } | { ok: false; reason: string } {
  const { quantity, referencePrice, filters } = input;
  if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, reason: '计算出的下单数量无效（非有限正数）' };
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return { ok: false, reason: '参考价格无效，无法校验下单数量' };
  if (quantity < filters.minQty) return { ok: false, reason: `下单数量 ${quantity} 小于交易所最小数量 ${filters.minQty}` };
  if (quantity > filters.maxQty) return { ok: false, reason: `下单数量 ${quantity} 大于交易所最大数量 ${filters.maxQty}` };
  const rounded = roundDownToStep(quantity, filters.stepSize);
  if (Math.abs(rounded - quantity) > 1e-12) return { ok: false, reason: `下单数量 ${quantity} 不符合交易所步长 ${filters.stepSize}` };
  if (filters.minNotional !== null) {
    const notional = quantity * referencePrice;
    if (notional < filters.minNotional) return { ok: false, reason: `预估名义金额 ${notional.toFixed(4)} USDT 小于交易所最小名义金额 ${filters.minNotional}` };
  }
  return { ok: true };
}

/** Task 9-12, composed — the one function exchangeService calls. Picks LOT_SIZE vs MARKET_LOT_SIZE
 * by order type (Task 8's symbol filter distinction), computes the raw quantity, rounds down, then
 * validates the ROUNDED value (never the raw one — Task 12 must check what will actually be sent). */
export function resolveEntryQuantity(
  orderType: 'MARKET' | 'LIMIT',
  positionSizeUsdt: number,
  referencePrice: number,
  filters: BinanceSymbolFilters,
): { ok: true; quantity: number } | { ok: false; reason: string } {
  if (!Number.isFinite(positionSizeUsdt) || positionSizeUsdt <= 0) return { ok: false, reason: '仓位大小（USDT）无效，无法计算下单数量' };
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return { ok: false, reason: '参考价格无效，无法计算下单数量' };

  const stepSize = orderType === 'MARKET' && filters.marketStepSize !== null ? filters.marketStepSize : filters.stepSize;
  const minQty = orderType === 'MARKET' && filters.marketMinQty !== null ? filters.marketMinQty : filters.minQty;
  const maxQty = orderType === 'MARKET' && filters.marketMaxQty !== null ? filters.marketMaxQty : filters.maxQty;
  if (!Number.isFinite(stepSize) || stepSize <= 0) return { ok: false, reason: '交易所未返回有效的数量步长，无法计算下单数量' };

  const raw = computeRawEntryQuantity(positionSizeUsdt, referencePrice);
  const rounded = roundDownToStep(raw, stepSize);
  const validation = validateOrderQuantity({ quantity: rounded, referencePrice, filters: { minQty, maxQty, stepSize, minNotional: filters.minNotional } });
  if (!validation.ok) return { ok: false, reason: validation.reason };
  return { ok: true, quantity: rounded };
}

/** Sprint 3.5D-E — protection (STOP_LOSS/TAKE_PROFIT) order sizing. Unlike entry sizing, the caller
 * (frontend) already knows the target quantity in base-asset units (a real filled/position quantity,
 * or a TP portion of it) — there is no USDT-notional-to-quantity conversion step here, only rounding
 * DOWN to the real exchange step (never up, so a protection order can never accidentally exceed the
 * real position it's covering) and the same LOT_SIZE-filter validation used everywhere else. Always
 * LOT_SIZE, never MARKET_LOT_SIZE — a conditional/algo order is filtered by the symbol's standard
 * LOT_SIZE rule, not the plain-MARKET-order-specific filter. `referencePrice` for the MIN_NOTIONAL
 * check is the order's own `triggerPrice` — the best available real reference for a not-yet-triggered
 * conditional order. */
export function resolveProtectionQuantity(
  rawQuantity: number,
  triggerPrice: number,
  filters: BinanceSymbolFilters,
): { ok: true; quantity: number } | { ok: false; reason: string } {
  if (!Number.isFinite(rawQuantity) || rawQuantity <= 0) return { ok: false, reason: '保护数量无效，无法计算下单数量' };
  if (!Number.isFinite(filters.stepSize) || filters.stepSize <= 0) return { ok: false, reason: '交易所未返回有效的数量步长，无法计算保护单数量' };
  const rounded = roundDownToStep(rawQuantity, filters.stepSize);
  const validation = validateOrderQuantity({ quantity: rounded, referencePrice: triggerPrice, filters: { minQty: filters.minQty, maxQty: filters.maxQty, stepSize: filters.stepSize, minNotional: filters.minNotional } });
  if (!validation.ok) return { ok: false, reason: validation.reason };
  return { ok: true, quantity: rounded };
}
