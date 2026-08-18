/** Sprint 3.6B.1, Section 3/14/15 — backend protection reconciliation for AUTO-submitted entries.
 * Ported decision logic from the frontend's existing `reconcileTradeProtection()`/
 * `resolveProtectionSideParams()`/`createAndSubmitProtectionOrder()` (`prototype/index.html`, Sprint
 * 3.5D-E) — same rules: quantity is ALWAYS `min(realPositionQuantity, realFilledQuantity)`, never
 * `positionSizeUsdt`; only missing protection is ever created; nothing is ever amended or
 * auto-cancelled/auto-recreated. The frontend version cannot run headless (it reads
 * `RealTrade`/`RealOrder`/`RealPosition` from browser localStorage) — this operates entirely on the
 * backend-persisted `StrategyOrder.execution` state instead, calling the SAME underlying
 * `exchangeService` write/read functions (no new Binance capability). */
import { randomUUID } from 'node:crypto';
import type { StrategyOrder } from './types.js';
import { fetchExchangeAccountSnapshot, submitProtectionOrderToBinanceTestnet } from '../exchange/exchangeService.js';
import { toBinanceFuturesSymbol } from '../exchange/binanceFuturesAdapter.js';

type ProtectionOrderState = StrategyOrder['execution']['protectionOrders'][number];

function resolveProtectionSideParams(positionSide: 'LONG' | 'SHORT', rawPositionSide: string | null) {
  const side: 'BUY' | 'SELL' = positionSide === 'LONG' ? 'SELL' : 'BUY';
  const effectivePositionSide = rawPositionSide || 'BOTH';
  const reduceOnly = effectivePositionSide === 'BOTH';
  return { side, positionSide: effectivePositionSide, reduceOnly };
}

function genClientAlgoId(): string {
  return 'AUTOP' + Date.now().toString(36).toUpperCase() + randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

export interface ProtectionReconciliationResult {
  execution: StrategyOrder['execution'];
  reason?: string;
}

/** The one reconciliation function for the AUTO path — idempotent, safe to call repeatedly (drives
 * both the monitor tick's automatic post-fill continuation and any future manual "重新建立保护"
 * equivalent). Never resubmits an already-tracked protection order (checked via
 * `execution.protectionOrders`, the AUTO-path equivalent of the frontend's `findActiveProtectionOrder`). */
export async function reconcileStrategyOrderProtection(order: StrategyOrder, connectionId: string): Promise<ProtectionReconciliationResult> {
  const exec = order.execution;
  if (!(exec.filledQuantity > 0)) {
    return { execution: { ...exec, protectionStatus: 'NOT_REQUIRED' } };
  }

  const snapshot = await fetchExchangeAccountSnapshot(connectionId);
  if (!snapshot.ok) {
    return { execution: { ...exec, protectionStatus: 'PROTECTION_FAILED' }, reason: snapshot.error.message };
  }
  const binanceSymbol = toBinanceFuturesSymbol(order.symbol);
  const position = snapshot.snapshot.positions.find((p) => p.symbol === binanceSymbol);
  if (!position) {
    // No real open position — either it's already fully closed (protection is moot) or something is
    // genuinely wrong. Never fabricate a quantity to protect either way.
    return { execution: { ...exec, protectionStatus: 'PROTECTION_FAILED' }, reason: '未找到与该 StrategyOrder 关联的真实持仓' };
  }

  const protectableQty = Math.min(position.quantity, exec.filledQuantity);
  const stopLoss = order.executionIntent.stopLoss;
  if (stopLoss == null || !Number.isFinite(stopLoss) || stopLoss <= 0) {
    return { execution: { ...exec, protectionStatus: 'PROTECTION_FAILED' }, reason: '缺少有效的数值止损，无法建立保护' };
  }
  const { side, positionSide, reduceOnly } = resolveProtectionSideParams(position.side, position.positionSide);

  const protectionOrders: ProtectionOrderState[] = exec.protectionOrders.map((p) => ({ ...p }));
  function findExisting(role: 'STOP_LOSS' | 'TAKE_PROFIT', targetIndex: number | null): ProtectionOrderState | undefined {
    return protectionOrders.find((p) => p.role === role && p.targetIndex === targetIndex);
  }

  async function submitIfMissing(role: 'STOP_LOSS' | 'TAKE_PROFIT', targetIndex: number | null, triggerPrice: number, quantity: number): Promise<void> {
    let record = findExisting(role, targetIndex);
    if (record && (record.exchangeOrderId || record.pendingClientOrderId)) return; // confirmed, or an ambiguous prior attempt awaiting read-back recovery — never resubmit
    const clientAlgoId = genClientAlgoId();
    if (!record) {
      record = { role, targetIndex, exchangeOrderId: null, pendingClientOrderId: clientAlgoId, status: null, quantity };
      protectionOrders.push(record);
    } else {
      record.pendingClientOrderId = clientAlgoId; // retrying a previous deterministic (non-ambiguous) rejection
    }
    const result = await submitProtectionOrderToBinanceTestnet(connectionId, {
      symbol: binanceSymbol, side, positionSide, type: role === 'STOP_LOSS' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET',
      triggerPrice, quantity, reduceOnly, clientAlgoId,
    });
    if (result.ok) {
      record.exchangeOrderId = result.snapshot.algoId;
      record.pendingClientOrderId = null;
      record.status = result.snapshot.algoStatus;
    } else if (!result.ambiguous) {
      // A deterministic rejection (bad price/quantity/etc — Binance definitively did not create an
      // order) is NOT left "pending": clearing pendingClientOrderId lets the NEXT tick's `findExisting`
      // guard fall through and retry automatically, instead of getting stuck forever looking like an
      // unresolved in-flight submission. An ambiguous (network/timeout) failure, by contrast, keeps
      // pendingClientOrderId set — real state is unknown, so it must be resolved by read, never blindly retried.
      record.pendingClientOrderId = null;
    }
  }

  await submitIfMissing('STOP_LOSS', null, stopLoss, protectableQty);
  const takeProfit = order.executionIntent.takeProfit || [];
  const portionSum = takeProfit.reduce((s, tp) => s + (tp.portion || 0), 0);
  const portionsValid = takeProfit.length === 0 || Math.abs(portionSum - 100) < 0.01;
  if (portionsValid) {
    for (let i = 0; i < takeProfit.length; i++) {
      const tp = takeProfit[i];
      if (!(tp.price > 0) || !(tp.portion > 0)) continue;
      const qty = protectableQty * (tp.portion / 100);
      await submitIfMissing('TAKE_PROFIT', i, tp.price, qty);
    }
  }

  // Read-back verification (Section 14: "perform real read reconciliation path... do not mark
  // protected merely because protection POST returned success").
  const verify = await fetchExchangeAccountSnapshot(connectionId);
  const now = new Date().toISOString();
  if (!verify.ok) {
    return { execution: { ...exec, protectionOrders, protectionStatus: 'PROTECTION_UNVERIFIED', protectionLastVerifiedAt: null }, reason: '保护单已提交，但读取验证失败' };
  }
  const verifyPosition = verify.snapshot.positions.find((p) => p.symbol === binanceSymbol);
  const liveAlgoIds = new Set((verifyPosition?.protection.stopLossOrders || []).concat(verifyPosition?.protection.takeProfitOrders || []).map((o) => o.exchangeOrderId));
  const attempted = protectionOrders.filter((p) => p.role === 'STOP_LOSS' || p.role === 'TAKE_PROFIT');
  const confirmed = attempted.filter((p) => p.exchangeOrderId && liveAlgoIds.has(p.exchangeOrderId));
  const expectedCount = 1 + takeProfit.filter((tp) => tp.price > 0 && tp.portion > 0 && portionsValid).length;

  let protectionStatus: StrategyOrder['execution']['protectionStatus'];
  if (confirmed.length >= expectedCount && expectedCount > 0) protectionStatus = 'PROTECTED';
  else if (confirmed.length > 0) protectionStatus = 'PARTIALLY_PROTECTED';
  else if (attempted.some((p) => p.pendingClientOrderId)) protectionStatus = 'PROTECTION_UNVERIFIED';
  else protectionStatus = 'PROTECTION_FAILED';

  return { execution: { ...exec, protectionOrders, protectionStatus, protectionLastVerifiedAt: now } };
}
