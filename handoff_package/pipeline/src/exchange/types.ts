/** Sprint 3.5B — Exchange Connection Foundation. READ-ONLY this sprint: no order placement,
 * cancellation, amendment, leverage/margin-mode changes, transfers, deposits, or withdrawals exist
 * anywhere in this module — see server.ts's route list for the full, deliberately short surface. */

/** Only Binance USDT-M Futures this sprint (Task 12 — Spot and Futures have structurally different
 * account/position models; ExecutionDraft/RealOrder/Risk Guard already model leverage and LONG/
 * SHORT exposure, which only Futures actually has, so the value is deliberately `binance-futures`,
 * not a generic `binance`, to leave room for a future non-conflicting `binance-spot` type). */
export type ExchangeType = 'binance-futures';
export type ExchangeEnvironment = 'LIVE' | 'TESTNET';

export interface ExchangeConnection {
  id: string;
  name: string;
  exchange: ExchangeType;
  environment: ExchangeEnvironment;
  enabled: boolean;
  apiKey?: string;
  apiSecret?: string;
  createdAt: string;
  updatedAt: string;
  lastTestAt?: string;
  lastTestStatus?: 'success' | 'error';
  lastTestError?: { code: string; message: string };
}

/** Normalized, exchange-agnostic account read. Never a second local source of truth for Position —
 * this is a point-in-time read of exchange reality, kept only inside the latest snapshot (Task 14,
 * 3.5B; reaffirmed Task 31/32, 3.5C), never written into qa_positions or any RealTrade/RealOrder
 * record, and never linked to a local tradeId (Task 32 — same symbol/direction is not proof a
 * Position originated from this app). */
export interface NormalizedBalance {
  asset: string;
  free: number;
  locked: number;
  total: number;
}

/** Sprint 3.5C, Task 10 — a read-only conditional order (STOP_MARKET/TAKE_PROFIT_MARKET/STOP/
 * TAKE_PROFIT/TRAILING_STOP_MARKET), sourced from Binance's Algo Service (GET /fapi/v1/openAlgoOrders
 * — conditional TP/SL orders migrated there 2025-12-09, confirmed current as of this sprint). Field
 * names follow the real algo-order response shape, not the legacy plain-order shape. */
export interface ExchangeProtectiveOrder {
  exchangeOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: string; // STOP_MARKET | TAKE_PROFIT_MARKET | STOP | TAKE_PROFIT | TRAILING_STOP_MARKET | other
  status: string; // algoStatus, e.g. NEW
  triggerPrice: number | null;
  price: number | null;
  quantity: number | null;
  closePosition: boolean | null;
  reduceOnly: boolean | null;
  createdAt: string | null;
  positionSide: string | null;
}

/** Task 12 — classification output, computed from orderType as the primary signal (never solely
 * from trigger-price-vs-current-price comparison) plus side-vs-position-direction consistency. */
export type PositionProtectionKind = 'STOP_LOSS' | 'TAKE_PROFIT' | 'TRAILING_STOP' | 'OTHER';

export interface ExchangePositionProtection {
  stopLossOrders: ExchangeProtectiveOrder[];
  takeProfitOrders: ExchangeProtectiveOrder[];
  trailingStopOrders: ExchangeProtectiveOrder[];
  otherOrders: ExchangeProtectiveOrder[];
}

/** Task 3 — full Futures position detail. Position-level fields ONLY (Task 5 — account-level totals
 * live in ExchangeAccountRiskSummary, never duplicated here as if they were one position's own).
 * `liquidationPrice` is exchange-provided only (GET /fapi/v2/positionRisk) — never locally
 * calculated (Task 4); `null` (rendered "不可用") when Binance reports 0/absent rather than a
 * meaningful value. `distanceToLiquidationPct` is a derived, clearly-labelled DISPLAY metric only
 * (Task 9), not exchange truth, and is never used as a Risk Guard rule input this sprint (Task 26). */
export interface ExchangePositionSnapshot {
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number | null;
  markPrice: number | null;
  notional: number | null;
  unrealizedPnl: number | null;
  leverage: number | null;
  marginType: string | null; // ISOLATED | CROSSED | null
  isolatedMargin: number | null;
  positionInitialMargin: number | null; // from /fapi/v2/account's positions[].initialMargin — position-level, not account-level
  maintenanceMargin: number | null; // from /fapi/v2/account's positions[].maintMargin
  liquidationPrice: number | null; // from /fapi/v2/positionRisk — exchange truth only
  breakEvenPrice: number | null;
  positionSide: string | null; // BOTH | LONG | SHORT (hedge-mode label, not used for side derivation)
  distanceToLiquidationPct: number | null; // derived display-only metric, see above
  protection: ExchangePositionProtection;
}

/** Task 6 — account-level margin/risk summary ONLY, sourced from the account endpoint's root
 * fields. Never merged into any one position's own fields (Task 5). */
export interface ExchangeAccountRiskSummary {
  totalWalletBalance: number | null;
  totalUnrealizedPnl: number | null;
  totalMarginBalance: number | null;
  totalInitialMargin: number | null;
  totalMaintMargin: number | null;
  availableBalance: number | null;
}

/** Hotfix (3.5C.2), Task 4/5 — distinguishes "the protective-order query succeeded and found
 * nothing" from "the query itself could not be completed" (timed out, or failed for another
 * reason). Critical: the UI must never say "未检测到止损保护" (as if verified) when the real
 * answer is "couldn't check" — those are different facts. `OK` = every queried symbol's algo-order
 * read succeeded (including the zero-open-positions case, where nothing was queried at all — see
 * fetchProtectiveOrdersForSymbols()). `TIMEOUT` = at least one symbol's read hit the bounded read
 * timeout. `UNAVAILABLE` = at least one symbol's read failed for a non-timeout reason (network/
 * exchange error), with no timeout involved. Positions whose own symbol read failed still show
 * whatever OTHER symbols' reads succeeded — partial results are kept, never discarded wholesale. */
export type ProtectionReadStatus = 'OK' | 'UNAVAILABLE' | 'TIMEOUT';

export interface ExchangeAccountSnapshot {
  connectionId: string;
  exchange: ExchangeType;
  environment: ExchangeEnvironment;
  fetchedAt: string;
  account: {
    canTrade: boolean | null;
  };
  accountRisk: ExchangeAccountRiskSummary;
  balances: NormalizedBalance[];
  positions: ExchangePositionSnapshot[];
  protectiveOrders: ExchangeProtectiveOrder[]; // ALL observed protective orders, unfiltered by symbol — also attached per-symbol inside positions[].protection
  protectionReadStatus: ProtectionReadStatus;
}

export interface ExchangeErrorInfo {
  code: string;
  message: string;
}

/** Sprint 3.5D-A — Real Order Lifecycle Foundation. STRICTLY READ-ONLY: this shape is sourced only
 * from `GET /fapi/v1/order` (verified against live Binance USDT-M Futures docs 2026-08-09; weight 1
 * signed read, requires symbol + orderId|origClientOrderId). No order placement/cancel/amend call
 * exists anywhere in this module — see binanceFuturesAdapter.ts's own header comment. `status` keeps
 * Binance's own raw enum (plus an open-ended `string` fallback for a future/unrecognized value) —
 * mapping to the app's local RealOrder lifecycle enum is a separate, explicit function
 * (`mapExchangeOrderStatusToLocalOrderStatus()` in prototype/index.html), never done here, so an
 * unrecognized remote status can be safely rejected by the caller instead of silently normalized
 * into something wrong. */
export type BinanceRawOrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED' | string;

export interface ExchangeOrderSnapshot {
  exchangeOrderId: string;
  clientOrderId: string | null;

  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: string; // Binance `type` (MARKET/LIMIT/STOP_MARKET/... ) — kept as-is, not re-classified here

  status: BinanceRawOrderStatus;

  originalQuantity: number | null; // Binance `origQty`
  executedQuantity: number; // Binance `executedQty` — never null; 0 when nothing has filled yet
  averagePrice: number | null; // Binance `avgPrice`; null when 0/absent (nothing filled yet — never treated as a real price)
  price: number | null; // Binance `price` (limit price; 0/absent for a pure MARKET order -> null)
  stopPrice: number | null;

  reduceOnly: boolean | null;
  closePosition: boolean | null;

  createdAt: string | null; // from Binance `time`
  updatedAt: string | null; // from Binance `updateTime` — the best available real exchange timestamp for a status transition
}

/** Sprint 3.5D-B — the ONE real write capability this app has: `POST /fapi/v1/order`, TESTNET only
 * (enforced backend-side, see exchangeService.submitEntryOrderToBinanceTestnet). The response shape
 * Binance actually returns for a successful New Order is a subset/near-duplicate of
 * `ExchangeOrderSnapshot` (verified against live docs 2026-08-09) — reusing that type directly, via
 * this alias, keeps ONE normalizer (`normalizeExchangeOrder()`) for both the read path (3.5D-A) and
 * this write path's response, rather than a second, potentially-diverging shape. */
export type ExchangeOrderSubmissionResult = ExchangeOrderSnapshot;

/** Sprint 3.5D-B, Task 16 — normalized, safe submission input. Never raw frontend-generated query
 * params passed straight through — the backend (exchangeService.resolveAndSubmitEntryOrder) resolves
 * `quantity` itself from `positionSizeUsdt`/`leverage`/exchange filters/a fresh reference price; the
 * frontend never computes or sends a final `quantity`. */
export interface EntryOrderSubmissionRequest {
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  limitPrice: number | null; // required (finite, >0) when orderType==='LIMIT'; ignored for MARKET
  positionSizeUsdt: number; // ExecutionDraft's user-entered notional (Task 9 — NOT divided by leverage; leverage only affects margin, checked separately)
  leverage: number; // must match the account's real configured leverage for this symbol (Task 13) — never used to call set-leverage
  localOrderId: string; // the local RealOrder.orderId — becomes Binance's newClientOrderId verbatim (Task 18), never analysis text/username/secrets
}

/** Sprint 3.5D-E — real protective (STOP_LOSS/TAKE_PROFIT) order via Binance's Algo Service
 * (verified live 2026-08-10: conditional orders migrated off `/fapi/v1/order` on 2025-12-09;
 * creation is `POST /fapi/v1/algoOrder`, algoType=CONDITIONAL). Response shape is intentionally its
 * own type (not reusing `ExchangeOrderSnapshot`) — an algo order's identity is `algoId`/`clientAlgoId`
 * and its status field is `algoStatus`, structurally distinct from a plain order's `orderId`/`status`,
 * and conflating them risks a future field-name bug. */
export interface ExchangeAlgoOrderSnapshot {
  algoId: string;
  clientAlgoId: string | null;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: string | null; // Binance raw: 'BOTH' | 'LONG' | 'SHORT'
  orderType: string; // STOP_MARKET | TAKE_PROFIT_MARKET (only types this app ever submits)
  algoStatus: string; // NEW | TRIGGERED | CANCELED | ... — kept raw, mapped to local enum by the frontend, same discipline as ExchangeOrderSnapshot.status
  triggerPrice: number | null;
  quantity: number | null;
  reduceOnly: boolean | null;
  closePosition: boolean | null;
  createdAt: string | null;
}

/** Sprint 3.5D-E, Task L/M — `quantity` and `reduceOnly`/`positionSide` are never computed backend-
 * side from a USDT notional (unlike entry sizing, there is no independent "position size" to convert
 * here) — the frontend resolves them from REAL filled/position quantity + exchangeInfo LOT_SIZE
 * filters + the real exchange `positionSide` of the position being protected, and this backend only
 * does structural validation before forwarding, exactly like EntryOrderSubmissionRequest already
 * does for symbol/side/orderType. Never closePosition — always an explicit, verifiable quantity, so
 * "protection quantity never exceeds real position quantity" is checkable by the caller. */
export interface ProtectionOrderSubmissionRequest {
  symbol: string;
  side: 'BUY' | 'SELL'; // the CLOSING side — opposite of the position direction
  positionSide: string; // 'BOTH' | 'LONG' | 'SHORT', taken verbatim from the real RealPosition/exchange read, never guessed
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  triggerPrice: number;
  quantity: number; // already rounded to the real LOT_SIZE step by the caller — never re-derived here
  reduceOnly: boolean; // true only in one-way mode (positionSide='BOTH'); Binance rejects reduceOnly in Hedge Mode, so this must be false when positionSide is LONG/SHORT
  clientAlgoId: string; // the local protection RealOrder.orderId, becomes Binance's clientAlgoId verbatim — never analysis text/secrets
}

export interface CancelProtectionOrderRequest {
  algoId?: string;
  clientAlgoId?: string;
}

/** Sprint 3.5D-E — Cancel Algo Order's REAL response shape (verified live 2026-08-10, `DELETE
 * /fapi/v1/algoOrder`) is genuinely `{algoId, clientAlgoId, code, msg}` — NOT the full
 * `ExchangeAlgoOrderSnapshot` shape (no `symbol`/`side`/`orderType`/`algoStatus`/etc. are returned).
 * Reusing `ExchangeAlgoOrderSnapshot` for a cancel result would silently fabricate defaulted/garbage
 * values for every missing field — this is a deliberately separate, honest type. */
export interface ExchangeAlgoCancelResult {
  algoId: string;
  clientAlgoId: string | null;
}

/** Sprint 3.6A — the FIFTH real write capability: `POST /fapi/v1/leverage` (verified live
 * 2026-08-10, response `{leverage, maxNotionalValue, symbol}`), TESTNET only, never invoked
 * automatically — only from an explicit user confirmation showing current vs. requested leverage
 * first. No margin-type (`marginType`) mutation exists anywhere — that stays out of scope. */
export interface LeverageChangeResult {
  symbol: string;
  leverage: number;
  maxNotionalValue: string | null;
}

/** Sprint 3.6A — normalized real-time User Data Stream event, relayed backend->frontend over SSE.
 * `ORDER_UPDATE` reuses `ExchangeOrderSnapshot` (same shape the REST order-sync path already
 * produces) so the frontend has exactly one order-shape to reason about regardless of source.
 * `ACCOUNT_UPDATE`'s balances/positions are intentionally a smaller, partial shape than the full
 * REST snapshot (Binance's own push payload does not carry every REST field, e.g. no
 * liquidationPrice/leverage on a position update) — the frontend must treat a stream event as a
 * low-latency NUDGE to re-render with already-known data or trigger a REST reconciliation, never as
 * a complete replacement for a REST-sourced ExchangePositionSnapshot. */
export type NormalizedStreamEvent =
  | { kind: 'STATUS'; eventTime: string; data: { status: 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED' } }
  | { kind: 'ORDER_UPDATE'; eventTime: string; data: ExchangeOrderSnapshot }
  | { kind: 'ACCOUNT_UPDATE'; eventTime: string; data: {
      reason: string | null;
      balances: { asset: string; walletBalance: number; crossWalletBalance: number }[];
      positions: { symbol: string; positionAmt: number; entryPrice: number; unrealizedPnl: number; marginType: string | null; positionSide: string | null; breakEvenPrice: number | null }[];
    } }
  | { kind: 'ACCOUNT_CONFIG_UPDATE'; eventTime: string; data: { symbol: string | null; leverage: number | null } };
