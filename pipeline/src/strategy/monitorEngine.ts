/** Sprint 3.6B — backend-owned Monitoring Engine (Section 10). Owns: expiry evaluation, trigger
 * evaluation (via `triggerEngine.ts`), the Execution Guard + Risk Guard + submit chain (Section 13),
 * and crash/restart idempotency (Section 20). The browser is never the source of truth for any of
 * this — it only displays what this engine reports over SSE (`GET /api/strategy/stream`) and via
 * plain GET routes. Reuses the EXISTING real-write pipeline (`exchangeService.submitEntryOrderToBinanceTestnet`)
 * — this file is a new CALLER, never a second order-submission implementation. */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { StrategyOrder, StrategyOrderStatus } from './types.js';
import { listStrategyOrders, getStrategyOrder, transitionStrategyOrder, saveStrategyOrder } from './strategyOrderStore.js';
import { evaluateStrategyTrigger, requiredCandleTimeframes, requiresPrice, type MarketObservation } from './triggerEngine.js';
import { evaluateExecutionGuard } from './executionGuard.js';
import { evaluateAutoRiskGuard, type AutoAccountContext } from './riskGuardCore.js';
import { getAutoRiskPolicy } from './autoRiskPolicyStore.js';
import { evaluateAutoRiskPolicy } from './autoRiskPolicyCore.js';
import { isAutoExecutionAllowed } from './killSwitch.js';
import { appendAuditEvent } from './auditLogStore.js';
import { resolvePreferredConnectionForAccount } from '../exchange/exchangeAccountStore.js';
import { getExchangeConnection } from '../exchange/exchangeConnectionStore.js';
import { fetchExchangeAccountSnapshot, submitEntryOrderToBinanceTestnet, fetchExchangeOrderSnapshot, cancelEntryOrderOnBinanceTestnet, fetchProtectiveOrdersForSymbol } from '../exchange/exchangeService.js';
import { syncStrategyOrderExecutionState } from './orderReconciliation.js';
import { reconcileStrategyOrderProtection } from './protectionReconciliation.js';
import { toBinanceFuturesSymbol } from '../exchange/binanceFuturesAdapter.js';
import { computeExecutionReadiness } from './executionReadiness.js';

// Sprint 3.8C — re-exported so autonomousScheduler.ts's existing `import {
// resolvePreferredConnectionForAccount } from './monitorEngine.js'` keeps working unchanged; the real
// implementation now lives in exchangeAccountStore.ts (see that file's own comment for why it moved).
export { resolvePreferredConnectionForAccount };

export const strategyEvents = new EventEmitter();
strategyEvents.setMaxListeners(50);
function emit(event: Record<string, unknown>): void {
  strategyEvents.emit('event', { ...event, emittedAt: new Date().toISOString() });
}

let __baseUrl = 'http://localhost:8787';
export function configureMonitorEngine(opts: { baseUrl: string }): void {
  __baseUrl = opts.baseUrl;
}

const ACTIVE_STATUSES: StrategyOrderStatus[] = ['ARMED', 'TRIGGERED', 'ENTRY_SUBMITTED', 'PARTIALLY_FILLED', 'POSITION_ACTIVE'];
const PRE_ENTRY_STATUSES: StrategyOrderStatus[] = ['READY', 'WAITING_TRIGGER', 'ARMED', 'PAUSED'];

/** Section 8 — Deterministic ONLY: `expiresAt` is either past or it isn't, no ambiguity. */
function isExpired(order: StrategyOrder, now: Date): boolean {
  if (!order.expiresAt) return false;
  const t = new Date(order.expiresAt).getTime();
  return Number.isFinite(t) && t <= now.getTime();
}

function genClientOrderId(): string {
  // <=36 chars, matches Binance's newClientOrderId charset — see resolveAndSubmitEntryOrder()'s own validation.
  return 'AUTO' + Date.now().toString(36).toUpperCase() + randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
}

async function fetchPriceMap(symbols: string[]): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  if (!symbols.length) return map;
  try {
    const res = await fetch(`${__baseUrl}/api/prices`);
    if (!res.ok) return map;
    const rows = (await res.json()) as { symbol: string; price: number }[];
    for (const r of rows) if (symbols.includes(r.symbol)) map[r.symbol] = r.price;
  } catch { /* transient miss — dependent conditions resolve UNRESOLVED, never fabricated */ }
  return map;
}
const TIMEFRAME_TO_INTERVAL: Record<string, string> = { '1H': '1h', '4H': '4h', '1D': '1d', '1W': '1w' };
const TIMEFRAME_MS: Record<string, number> = { '1H': 3600000, '4H': 14400000, '1D': 86400000, '1W': 604800000 };
async function fetchCandleClose(symbol: string, timeframe: string): Promise<number | null> {
  const interval = TIMEFRAME_TO_INTERVAL[timeframe];
  const durationMs = TIMEFRAME_MS[timeframe];
  if (!interval || !durationMs) return null;
  try {
    const res = await fetch(`${__baseUrl}/api/market/detail?symbol=${symbol.replace('/', '')}&interval=${interval}&limit=3`);
    if (!res.ok) return null;
    const data = (await res.json()) as { klines?: { openTime: number; close: number }[] };
    const klines = data.klines || [];
    const now = Date.now();
    for (let i = klines.length - 1; i >= 0; i--) {
      const closeTime = klines[i].openTime + durationMs;
      if (closeTime <= now) return klines[i].close;
    }
    return null;
  } catch { return null; }
}

function toAutoAccountContext(snapshot: { ok: true; snapshot: { accountRisk: { availableBalance: number | null }; positions: { symbol: string; side: string }[] } } | { ok: false }): AutoAccountContext {
  if (!snapshot.ok) return { ok: false, availableBalance: null, positions: [] };
  return {
    ok: true,
    availableBalance: snapshot.snapshot.accountRisk.availableBalance,
    positions: snapshot.snapshot.positions.map((p) => ({ symbol: p.symbol, side: p.side as 'LONG' | 'SHORT' })),
  };
}

/** Section 13 — the 9-step gate, run once a trigger has fired (or immediately at authorization for an
 * EXCHANGE_NATIVE decision). Any failure -> NO ORDER, status moves to a terminal-for-this-attempt
 * state with a recorded reason. Never fail-open. */
async function attemptAutoSubmission(order: StrategyOrder, referencePrice: number, observedPrice: number): Promise<void> {
  const now = new Date();

  // 1/5. Strategy not expired, still authorized.
  if (isExpired(order, now)) {
    transitionStrategyOrder(order, 'EXPIRED', { failureReason: '触发时已超过 expiresAt' });
    appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'AUTO_SUBMISSION_BLOCKED', previousStatus: order.status, newStatus: 'EXPIRED', reason: '触发时已超过 expiresAt' });
    emit({ type: 'expired', strategyOrderId: order.strategyOrderId });
    return;
  }
  if (!order.authorization || (order.authorization.mode !== 'MONITORED_AUTO' && order.authorization.mode !== 'AUTONOMOUS')) {
    transitionStrategyOrder(order, 'EXECUTION_BLOCKED', { failureReason: '授权已失效或不存在' });
    appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'AUTO_SUBMISSION_BLOCKED', previousStatus: order.status, newStatus: 'EXECUTION_BLOCKED', reason: '授权已失效或不存在' });
    return;
  }
  // 15. Kill switch.
  if (!isAutoExecutionAllowed()) {
    transitionStrategyOrder(order, 'EXECUTION_BLOCKED', { failureReason: 'AUTO Kill Switch 已暂停自动执行' });
    appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'KILL_SWITCH_BLOCK', previousStatus: order.status, newStatus: 'EXECUTION_BLOCKED', reason: 'Kill Switch 暂停' });
    emit({ type: 'blocked', strategyOrderId: order.strategyOrderId, reason: 'kill_switch' });
    return;
  }
  // Execution Guard.
  const guardResult = evaluateExecutionGuard(order.executionGuard, referencePrice, observedPrice);
  if (guardResult.status === 'BLOCKED') {
    transitionStrategyOrder(order, 'EXECUTION_BLOCKED', { failureReason: guardResult.message });
    appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'EXECUTION_GUARD_BLOCK', previousStatus: order.status, newStatus: 'EXECUTION_BLOCKED', reason: guardResult.message, executionGuardResult: guardResult });
    emit({ type: 'blocked', strategyOrderId: order.strategyOrderId, reason: 'execution_guard' });
    return;
  }
  appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'EXECUTION_GUARD_PASS', previousStatus: order.status, newStatus: order.status, reason: guardResult.message, executionGuardResult: guardResult });

  // 2. Resolve current valid ExchangeAccount/Connection.
  if (!order.submission.exchangeAccountId) {
    transitionStrategyOrder(order, 'EXECUTION_BLOCKED', { failureReason: '未绑定 ExchangeAccount' });
    appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'AUTO_SUBMISSION_BLOCKED', previousStatus: order.status, newStatus: 'EXECUTION_BLOCKED', reason: '未绑定 ExchangeAccount' });
    return;
  }
  const resolvedConn = resolvePreferredConnectionForAccount(order.submission.exchangeAccountId);
  if (!resolvedConn.ok) {
    transitionStrategyOrder(order, 'EXECUTION_BLOCKED', { failureReason: resolvedConn.reason });
    appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'AUTO_SUBMISSION_BLOCKED', previousStatus: order.status, newStatus: 'EXECUTION_BLOCKED', reason: resolvedConn.reason });
    emit({ type: 'blocked', strategyOrderId: order.strategyOrderId, reason: 'connection_unresolvable' });
    return;
  }
  const connection = getExchangeConnection(resolvedConn.connectionId);
  if (!connection || connection.environment !== 'TESTNET') {
    // 14 — LIVE hard block, even with a valid authorization.
    transitionStrategyOrder(order, 'EXECUTION_BLOCKED', { failureReason: '解析到的连接不是 TESTNET，自动提交被硬性阻止' });
    appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'AUTO_SUBMISSION_BLOCKED', previousStatus: order.status, newStatus: 'EXECUTION_BLOCKED', reason: 'LIVE hard block' });
    return;
  }

  // 1. Fresh account read.
  const snapshot = await fetchExchangeAccountSnapshot(resolvedConn.connectionId);
  const accountContext = toAutoAccountContext(snapshot);

  // Section 6/7/8 of 3.6B.1 — AUTO Risk Policy: standing permission/limits, independent of and in
  // addition to the existing account-aware Risk Guard rules below. Never weaker than manual execution
  // — this is an EXTRA gate, never a replacement for the existing checks.
  const otherActiveSymbols = listStrategyOrders()
    .filter((o) => o.strategyOrderId !== order.strategyOrderId && ACTIVE_STATUSES.includes(o.status))
    .map((o) => o.symbol);
  const policy = getAutoRiskPolicy();
  const policyResult = evaluateAutoRiskPolicy(policy, {
    connectionEnvironment: connection.environment, symbol: order.symbol,
    positionSizeUsdt: order.executionIntent.positionSizeUsdt, leverage: order.executionIntent.leverage,
    entryPrice: order.executionIntent.entryPrice, stopLoss: order.executionIntent.stopLoss,
    activeTradesCount: otherActiveSymbols.length,
  });
  if (policyResult.status === 'BLOCKED') {
    transitionStrategyOrder(order, 'EXECUTION_BLOCKED', { failureReason: 'AUTO Risk Policy BLOCKED: ' + policyResult.checks.filter((c) => c.status === 'BLOCKED').map((c) => c.message).join('; ') });
    appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'AUTO_RISK_BLOCK', previousStatus: order.status, newStatus: 'EXECUTION_BLOCKED', reason: 'auto_risk_policy_blocked', riskResultSummary: policyResult });
    emit({ type: 'blocked', strategyOrderId: order.strategyOrderId, reason: 'auto_risk_policy' });
    return;
  }
  appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'AUTO_RISK_PASS', previousStatus: order.status, newStatus: order.status, reason: 'auto_risk_policy_pass', riskResultSummary: policyResult });

  // 7. Fresh Risk Guard rerun — the existing account-aware rules, unchanged, applied IN ADDITION to
  // the AUTO Risk Policy above (Section 8: "must not silently skip a known relevant rule").
  const riskResult = evaluateAutoRiskGuard({
    symbol: order.symbol,
    stopLoss: order.executionIntent.stopLoss,
    positionSizeUsdt: order.executionIntent.positionSizeUsdt,
    leverage: order.executionIntent.leverage,
    otherActiveSymbols,
    marketObservedAt: now.toISOString(), // the price we just used to evaluate the trigger this same tick
    account: accountContext,
  });
  if (riskResult.status === 'BLOCKED') {
    transitionStrategyOrder(order, 'EXECUTION_BLOCKED', { failureReason: 'Risk Guard BLOCKED: ' + riskResult.checks.filter((c) => c.status === 'BLOCKED').map((c) => c.message).join('; ') });
    appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'AUTO_RISK_BLOCK', previousStatus: order.status, newStatus: 'EXECUTION_BLOCKED', reason: 'risk_guard_blocked', riskResultSummary: riskResult });
    emit({ type: 'blocked', strategyOrderId: order.strategyOrderId, reason: 'risk_guard' });
    return;
  }
  appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'AUTO_RISK_PASS', previousStatus: order.status, newStatus: order.status, reason: 'risk_guard_pass', riskResultSummary: riskResult });

  // 9. Only now submit — idempotency key set BEFORE the write, same discipline as the frontend.
  const clientOrderId = genClientOrderId();
  const triggeredOrder = transitionStrategyOrder(order, order.status === 'TRIGGERED' ? 'TRIGGERED' : 'TRIGGERED', {
    submission: { ...order.submission, exchangeConnectionId: resolvedConn.connectionId, pendingClientOrderId: clientOrderId },
  });
  appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'SUBMISSION_STARTED', previousStatus: order.status, newStatus: 'TRIGGERED', reason: 'guards passed, submitting', riskResultSummary: riskResult, executionGuardResult: guardResult });

  const side = order.direction === 'LONG' ? 'BUY' : 'SELL';
  const result = await submitEntryOrderToBinanceTestnet(resolvedConn.connectionId, {
    symbol: order.symbol, side, orderType: order.executionIntent.entryType,
    limitPrice: order.executionIntent.entryPrice, positionSizeUsdt: order.executionIntent.positionSizeUsdt,
    leverage: order.executionIntent.leverage, localOrderId: clientOrderId,
  });

  if (result.ok) {
    const submitted = transitionStrategyOrder(triggeredOrder, 'ENTRY_SUBMITTED', {
      submission: { ...triggeredOrder.submission, clientOrderId: result.snapshot.clientOrderId || clientOrderId, exchangeOrderId: String(result.snapshot.exchangeOrderId), submittedAt: now.toISOString() },
    });
    appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'SUBMISSION_CONFIRMED', previousStatus: 'TRIGGERED', newStatus: 'ENTRY_SUBMITTED', reason: '真实 TESTNET 订单已提交', exchangeOrderId: submitted.submission.exchangeOrderId });
    emit({ type: 'execution_submitted', strategyOrderId: order.strategyOrderId, exchangeOrderId: submitted.submission.exchangeOrderId });
    return;
  }
  if (result.ambiguous) {
    // Leave status TRIGGERED with pendingClientOrderId set — recovery (below/on restart) resolves it.
    appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'AUTO_SUBMISSION_AMBIGUOUS', previousStatus: 'TRIGGERED', newStatus: 'TRIGGERED', reason: result.error.message });
    emit({ type: 'execution_error', strategyOrderId: order.strategyOrderId, reason: 'ambiguous' });
    return;
  }
  const errored = transitionStrategyOrder(triggeredOrder, 'ERROR', { failureReason: result.error.message, submission: { ...triggeredOrder.submission, pendingClientOrderId: null } });
  appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'AUTO_SUBMISSION_REJECTED', previousStatus: 'TRIGGERED', newStatus: 'ERROR', reason: result.error.message });
  emit({ type: 'execution_error', strategyOrderId: order.strategyOrderId, reason: result.error.message });
  void errored;
}

/** Section 20 — recovers an ambiguous or in-flight submission by querying Binance for the
 * clientOrderId set BEFORE the write, exactly the same recovery pattern the frontend already uses
 * (`recoverAmbiguousSubmission`/`origClientOrderId`). Never re-submits blindly. */
async function recoverPendingSubmission(order: StrategyOrder): Promise<void> {
  const pending = order.submission.pendingClientOrderId;
  if (!pending || order.submission.exchangeOrderId) return;
  const connectionId = order.submission.exchangeConnectionId;
  if (!connectionId) return;
  const result = await fetchExchangeOrderSnapshot(connectionId, order.symbol, { origClientOrderId: pending });
  if (result.ok) {
    const submitted = transitionStrategyOrder(order, 'ENTRY_SUBMITTED', {
      submission: { ...order.submission, exchangeOrderId: String(result.snapshot.exchangeOrderId), clientOrderId: result.snapshot.clientOrderId || pending, submittedAt: order.submission.submittedAt || new Date().toISOString() },
    });
    appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'RECOVERY_RECONCILIATION', previousStatus: order.status, newStatus: 'ENTRY_SUBMITTED', reason: '重启后按 clientOrderId 恢复，确认订单已存在于交易所，未重复提交', exchangeOrderId: submitted.submission.exchangeOrderId });
    return;
  }
  if (result.error.code === 'order_not_found') {
    // Never reached Binance — safe to clear and let the next tick retry from ARMED.
    const cleared = transitionStrategyOrder(order, order.status === 'TRIGGERED' ? 'ARMED' : order.status, { submission: { ...order.submission, pendingClientOrderId: null, exchangeConnectionId: null } });
    appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'RECOVERY_RECONCILIATION', previousStatus: order.status, newStatus: cleared.status, reason: '交易所未找到该 clientOrderId，确认从未提交成功，已清除待确认状态' });
  }
  // Any other error (network/timeout) — leave as-is, retry recovery on the next tick/restart.
}

const IN_FLIGHT_STATUSES: StrategyOrderStatus[] = ['ENTRY_SUBMITTED', 'PARTIALLY_FILLED'];

/** Section 13 — a Strategy expiring while its entry order still has an unfilled remainder must cancel
 * ONLY that remainder, never touch any already-confirmed fill. Safe to call every tick until the real
 * order status reflects the cancellation (Binance rejects a cancel on an already-terminal order
 * harmlessly — no risk from a redundant attempt, same as the existing manual cancel path's own
 * idempotency). */
async function cancelRemainderIfExpired(order: StrategyOrder): Promise<void> {
  if (!isExpired(order, new Date())) return;
  if (order.execution.orderStatus !== 'NEW' && order.execution.orderStatus !== 'PARTIALLY_FILLED') return;
  const connectionId = order.submission.exchangeConnectionId;
  const exchangeOrderId = order.submission.exchangeOrderId;
  if (!connectionId || !exchangeOrderId) return;
  const result = await cancelEntryOrderOnBinanceTestnet(connectionId, { symbol: toBinanceFuturesSymbol(order.symbol), exchangeOrderId });
  appendAuditEvent({
    strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'CANCEL_REMAINDER',
    previousStatus: order.status, newStatus: order.status,
    reason: result.ok ? '已撤销剩余未成交数量（已确认成交部分不受影响）' : ((result as any).error?.message || '撤销剩余数量失败，下一 tick 重试'),
  });
}

/** Section 2-4/14 — the headless post-submission lifecycle: order fill detection -> position sync ->
 * allocation (frozen once set, confirmed-fill-only) -> protection reconciliation -> verification. Runs
 * from both the regular tick and startup recovery, entirely backend-side. Every step here reuses
 * existing `exchangeService` read/write functions — no fabricated RealPosition/RealOrder, no new
 * Binance capability. Audits only real state CHANGES, never once per tick regardless (Section 18). */
async function progressStrategyOrderPostSubmission(order: StrategyOrder): Promise<void> {
  const connectionId = order.submission.exchangeConnectionId;
  if (!connectionId) return;

  const prevOrderStatus = order.execution.orderStatus;
  const syncResult = await syncStrategyOrderExecutionState(order, connectionId);
  if (!syncResult.ok || !syncResult.execution) return; // transient read failure — retried next tick, never guessed

  let current = saveStrategyOrder({ ...order, execution: syncResult.execution });

  if (syncResult.execution.orderStatus !== prevOrderStatus) {
    appendAuditEvent({ strategyOrderId: current.strategyOrderId, tradeId: current.tradeId, eventType: 'ORDER_RECONCILED', previousStatus: current.status, newStatus: current.status, reason: `order status ${prevOrderStatus ?? 'null'} -> ${syncResult.execution.orderStatus}` });
    if (syncResult.execution.orderStatus === 'PARTIALLY_FILLED') {
      appendAuditEvent({ strategyOrderId: current.strategyOrderId, tradeId: current.tradeId, eventType: 'PARTIAL_FILL', previousStatus: current.status, newStatus: current.status, reason: `filled ${syncResult.execution.filledQuantity}` });
      if (current.status === 'ENTRY_SUBMITTED') current = transitionStrategyOrder(current, 'PARTIALLY_FILLED', {});
    }
    if (syncResult.execution.orderStatus === 'FILLED') {
      appendAuditEvent({ strategyOrderId: current.strategyOrderId, tradeId: current.tradeId, eventType: 'FILLED', previousStatus: current.status, newStatus: current.status, reason: `filled ${syncResult.execution.filledQuantity}` });
    }
  }

  const filledQty = current.execution.filledQuantity;
  if (filledQty > 0) {
    // Position sync — real exchange quantity, never derived from the intended/planned size.
    const snap = await fetchExchangeAccountSnapshot(connectionId);
    if (snap.ok) {
      const binanceSymbol = toBinanceFuturesSymbol(current.symbol);
      const position = snap.snapshot.positions.find((p) => p.symbol === binanceSymbol);
      const newPositionQty = position ? position.quantity : 0;
      if (current.execution.positionQuantity !== newPositionQty) {
        current = saveStrategyOrder({ ...current, execution: { ...current.execution, positionQuantity: newPositionQty, positionLastSyncedAt: new Date().toISOString() } });
        appendAuditEvent({ strategyOrderId: current.strategyOrderId, tradeId: current.tradeId, eventType: 'POSITION_SYNCED', previousStatus: current.status, newStatus: current.status, reason: `real position quantity ${newPositionQty}` });
      }
      // Allocation — Section 21: only a confirmed real Fill creates a contribution, set ONCE, never
      // rewritten (mirrors `PositionAllocation.quantity`'s frozen-once-created rule). Never
      // `executionIntent.positionSizeUsdt` — only `filledQuantity`, the real confirmed fill.
      if (current.execution.allocationQuantity == null) {
        current = saveStrategyOrder({ ...current, execution: { ...current.execution, allocationQuantity: filledQty } });
        appendAuditEvent({ strategyOrderId: current.strategyOrderId, tradeId: current.tradeId, eventType: 'ALLOCATION_RECONCILED', previousStatus: current.status, newStatus: current.status, reason: `allocation quantity ${filledQty} (from confirmed fill only)` });
      }
    }

    // Protection reconciliation — Section 14/15: create only missing, verify by real read, never mark
    // protected merely because the POST returned success.
    const prevProtectionStatus = current.execution.protectionStatus;
    const prevOrderCount = current.execution.protectionOrders.filter((p) => p.exchangeOrderId).length;
    const protectionResult = await reconcileStrategyOrderProtection(current, connectionId);
    current = saveStrategyOrder({ ...current, execution: protectionResult.execution });
    const newOrderCount = protectionResult.execution.protectionOrders.filter((p) => p.exchangeOrderId).length;
    if (newOrderCount > prevOrderCount) {
      appendAuditEvent({ strategyOrderId: current.strategyOrderId, tradeId: current.tradeId, eventType: 'PROTECTION_CREATED', previousStatus: current.status, newStatus: current.status, reason: `${newOrderCount - prevOrderCount} protection order(s) submitted` });
    }
    if (protectionResult.execution.protectionStatus !== prevProtectionStatus) {
      const eventType = protectionResult.execution.protectionStatus === 'PROTECTED' ? 'PROTECTION_VERIFIED'
        : protectionResult.execution.protectionStatus === 'PROTECTION_FAILED' ? 'PROTECTION_FAILED'
        : protectionResult.execution.protectionStatus === 'PROTECTION_UNVERIFIED' ? 'PROTECTION_UNVERIFIED'
        : 'PROTECTION_VERIFIED'; // PARTIALLY_PROTECTED — still a verification outcome, just incomplete
      appendAuditEvent({ strategyOrderId: current.strategyOrderId, tradeId: current.tradeId, eventType, previousStatus: current.status, newStatus: current.status, reason: protectionResult.reason || protectionResult.execution.protectionStatus });
      emit({ type: protectionResult.execution.protectionStatus === 'PROTECTION_FAILED' || protectionResult.execution.protectionStatus === 'PROTECTION_UNVERIFIED' ? 'protection_problem' : 'protection_verified', strategyOrderId: current.strategyOrderId, protectionStatus: protectionResult.execution.protectionStatus });
    }
  }

  // Status transitions — Section 4: ENTRY_SUBMITTED/PARTIALLY_FILLED -> POSITION_ACTIVE once entry is
  // done (fully filled, OR terminated with SOME confirmed fill — Section 13's partial-fill-then-expire
  // case: the confirmed portion still needs Position Management, remainder cancellation is separate).
  if (current.execution.orderStatus === 'FILLED' && current.status !== 'POSITION_ACTIVE') {
    current = transitionStrategyOrder(current, 'POSITION_ACTIVE', {});
  } else if (current.execution.orderStatus && ['CANCELLED', 'REJECTED', 'EXPIRED'].includes(current.execution.orderStatus)) {
    if (current.execution.filledQuantity > 0) {
      if (current.status !== 'POSITION_ACTIVE') current = transitionStrategyOrder(current, 'POSITION_ACTIVE', {});
    } else if (!['CANCELLED', 'EXPIRED', 'ERROR'].includes(current.status)) {
      current = transitionStrategyOrder(current, current.execution.orderStatus === 'EXPIRED' ? 'EXPIRED' : 'CANCELLED', {});
    }
  }
}

const MANAGED_POSITION_STATUSES: StrategyOrderStatus[] = ['POSITION_ACTIVE'];

/** Sprint 3.6B.2, Section 2-11 — External Position Closure Reconciliation. Detects a real Position
 * fully closing on the exchange (manually, or by any means outside this app) for a StrategyOrder
 * already at POSITION_ACTIVE, and completes the Strategy lifecycle from that real observation ALONE —
 * never from Strategy expiry, a browser click, or a stale local Position object (Section 2's Core
 * Truth Rule). A nonzero-but-changed quantity (partial reduction) only re-syncs `positionQuantity`,
 * exactly like `progressStrategyOrderPostSubmission()`'s own position-sync step — intentionally the
 * same real-quantity-only discipline, never a fabricated exit Fill/price/PnL (Section 17). Runs from
 * both the regular tick and startup recovery (Section 11), entirely backend-side. */
async function detectExternalPositionClose(order: StrategyOrder): Promise<void> {
  const connectionId = order.submission.exchangeConnectionId;
  if (!connectionId) return;
  const snap = await fetchExchangeAccountSnapshot(connectionId);
  if (!snap.ok) return; // transient read failure — retried next tick, never guessed

  const binanceSymbol = toBinanceFuturesSymbol(order.symbol);
  const position = snap.snapshot.positions.find((p) => p.symbol === binanceSymbol);
  const newPositionQty = position ? position.quantity : 0;

  if (newPositionQty > 0) {
    // Still open, or an external PARTIAL reduction — Section 18: only a confirmed FULL zero ever
    // completes the Strategy; a partial reduction just keeps the real quantity fresh.
    if (order.execution.positionQuantity !== newPositionQty) {
      const updated = saveStrategyOrder({ ...order, execution: { ...order.execution, positionQuantity: newPositionQty, positionLastSyncedAt: new Date().toISOString() } });
      appendAuditEvent({ strategyOrderId: updated.strategyOrderId, tradeId: updated.tradeId, eventType: 'POSITION_SYNCED', previousStatus: updated.status, newStatus: updated.status, reason: `real position quantity ${newPositionQty}` });
    }
    return;
  }

  // Exchange confirms zero/absent for this account+symbol — Section 3's account-scoped identity
  // (exchangeAccountId is implicit here: `connectionId` was resolved from THIS StrategyOrder's own
  // ExchangeAccount at submission time, and one connection's snapshot IS that account's real state).
  // Sprint 3.6B.2.1, Section 2/3 — Trade/Strategy lifecycle completion is a dimension deliberately
  // INDEPENDENT of protection-cleanup state: it completes here unconditionally the moment quantity
  // hits zero, never blocked or delayed by a protection read. `execution.protectionStatus` is left
  // untouched (frozen historical fact — see its own doc comment); current-after-close protection
  // truth lives in the separate `postCloseProtectionState` dimension, which starts `null` (not yet
  // reconciled) here and is populated by `reconcileClosedPositionProtection()` below, on this same
  // tick's later step and every subsequent tick/restart until terminal.
  const now = new Date().toISOString();
  const completed = transitionStrategyOrder(order, 'COMPLETED', {
    completionSource: 'EXTERNAL_POSITION_CLOSE', closedAt: now, failureReason: null,
    execution: { ...order.execution, positionQuantity: 0, positionLastSyncedAt: now },
  });
  appendAuditEvent({
    strategyOrderId: completed.strategyOrderId, tradeId: completed.tradeId, eventType: 'POSITION_CLOSED_EXTERNAL',
    previousStatus: 'POSITION_ACTIVE', newStatus: 'COMPLETED', reason: '交易所确认该 Position 已被外部关闭',
  });
  emit({ type: 'position_closed_external', strategyOrderId: completed.strategyOrderId });
}

/** Sprint 3.6B.2.1, Section 3-8 — post-close protection-CLEANUP reconciliation: a dimension
 * deliberately separate from Trade/Strategy completion above (Section 2's "these are different
 * dimensions" — a Strategy may be `COMPLETED` while `postCloseProtectionState` is simultaneously
 * `ORPHANED_PROTECTION`). Runs for every `COMPLETED`-via-`EXTERNAL_POSITION_CLOSE` order whose state
 * isn't yet terminal, on every tick and at restart recovery — this is both (a) what lets a real
 * orphaned SL/TP get flagged even if the very first read after close happened to race Binance's own
 * cleanup (Section 1's real bug: `fetchProtectiveOrdersForSymbol` itself was proven correct by a
 * direct re-invocation: the bug was a single-read snapshot being finalized as permanent truth) and
 * (b) what lets a later external cancellation of those orders self-heal the local state with no code
 * change and no manual edit (Section 7). Ownership matching is unchanged from `detectExternalPositionClose`'s
 * original logic — only this StrategyOrder's own attempted `exchangeOrderId`s ever count as App-owned
 * (Section 8); an unrelated external algo order for the same symbol is never claimed and never
 * contributes to `orphaned`. `CONFIRMED_NONE` is only ever reached after TWO CONSECUTIVE clean reads
 * (Section 5) — one transient/empty read alone can never finalize "no orphan", whether that's the very
 * first read after close or a read following a `READ_FAILED`/`ORPHANED_PROTECTION` state. */
async function reconcileClosedPositionProtection(order: StrategyOrder): Promise<void> {
  if (order.status !== 'COMPLETED' || order.completionSource !== 'EXTERNAL_POSITION_CLOSE') return;
  const prevState = order.execution.postCloseProtectionState;
  if (prevState === 'CONFIRMED_NONE') return; // terminal — stop reconciling
  const connectionId = order.submission.exchangeConnectionId;
  if (!connectionId) return;

  const protectiveRead = await fetchProtectiveOrdersForSymbol(connectionId, order.symbol);
  if (!protectiveRead.ok) {
    if (prevState !== 'READ_FAILED') {
      const updated = saveStrategyOrder({ ...order, execution: { ...order.execution, postCloseProtectionState: 'READ_FAILED' } });
      appendAuditEvent({ strategyOrderId: updated.strategyOrderId, tradeId: updated.tradeId, eventType: 'PROTECTION_RECONCILIATION_READ_FAILED', previousStatus: updated.status, newStatus: updated.status, reason: '平仓后保护单核实读取失败，下一次 tick/重启重试' });
    }
    return; // never treated as "confirmed no orphan" — that would be a guess
  }

  const liveIds = new Set(protectiveRead.orders.map((o) => o.exchangeOrderId));
  const attemptedIds = order.execution.protectionOrders.map((p) => p.exchangeOrderId).filter((id): id is string => !!id);
  // Sprint 3.7, Section 67 — the precise, currently-live subset (not the whole historical
  // `protectionOrders` array, which also includes orders the exchange itself later REJECTED/CANCELED).
  const currentlyLiveOwnIds = attemptedIds.filter((id) => liveIds.has(id));
  const orphaned = currentlyLiveOwnIds.length > 0;
  const nextState: NonNullable<StrategyOrder['execution']['postCloseProtectionState']> =
    orphaned ? 'ORPHANED_PROTECTION' : prevState === 'PENDING' ? 'CONFIRMED_NONE' : 'PENDING';
  const nextActiveIds = orphaned ? currentlyLiveOwnIds : [];
  if (nextState === prevState && JSON.stringify(nextActiveIds) === JSON.stringify(order.execution.activeOrphanProtectionOrderIds)) return; // no real change — no audit noise

  const updated = saveStrategyOrder({ ...order, execution: { ...order.execution, postCloseProtectionState: nextState, activeOrphanProtectionOrderIds: nextActiveIds } });
  const reason = nextState === 'ORPHANED_PROTECTION'
    ? '交易所确认本策略提交的保护单仍然存在（遗留保护单，未自动撤销）'
    : nextState === 'CONFIRMED_NONE'
      ? '连续两次读取确认交易所已无本策略遗留的活动保护单'
      : '本次读取未发现遗留保护单，等待下一次独立读取确认后才能判定为已清理';
  appendAuditEvent({ strategyOrderId: updated.strategyOrderId, tradeId: updated.tradeId, eventType: 'PROTECTION_RECONCILIATION_UPDATED', previousStatus: updated.status, newStatus: updated.status, reason });
  emit({ type: 'closed_protection_reconciled', strategyOrderId: updated.strategyOrderId, postCloseProtectionState: nextState });
}

/** Gate for the loop below — anything not yet at the terminal `CONFIRMED_NONE` state keeps getting
 * re-checked, including `null` (never reconciled at all yet). */
function needsClosedProtectionReconciliation(order: StrategyOrder): boolean {
  return order.status === 'COMPLETED' && order.completionSource === 'EXTERNAL_POSITION_CLOSE' && order.execution.postCloseProtectionState !== 'CONFIRMED_NONE';
}

/** Section 20 — called once at process startup. Never re-submits; only re-validates and, if a prior
 * tick crashed mid-submission, resolves the ambiguity by real read. */
export async function recoverOnStartup(): Promise<void> {
  const now = new Date();
  for (const order of listStrategyOrders()) {
    if (order.submission.pendingClientOrderId && !order.submission.exchangeOrderId) {
      await recoverPendingSubmission(getStrategyOrder(order.strategyOrderId) || order);
    }
    if (PRE_ENTRY_STATUSES.includes(order.status) && isExpired(order, now)) {
      const fresh = getStrategyOrder(order.strategyOrderId) || order;
      if (PRE_ENTRY_STATUSES.includes(fresh.status)) {
        transitionStrategyOrder(fresh, 'EXPIRED', { failureReason: '启动恢复时发现已过期' });
        appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'RECOVERY_EXPIRED', previousStatus: fresh.status, newStatus: 'EXPIRED', reason: '启动恢复时发现已过期' });
      }
    }
    if (order.status === 'ARMED') {
      const fresh = getStrategyOrder(order.strategyOrderId);
      if (fresh) {
        fresh.monitoringState = { ...fresh.monitoringState, health: 'RUNNING', lastCheckedAt: null };
        saveStrategyOrder(fresh);
      }
    }
  }
  // Section 16D/16E — an entry that already filled (fully or partially) or has protection in flight
  // before a restart must keep progressing headlessly: detect the real fill, continue protection
  // reconciliation, create only what's still missing — never a duplicate entry, never a duplicate SL/TP.
  for (const order of listStrategyOrders()) {
    if (IN_FLIGHT_STATUSES.includes(order.status)) {
      const fresh = getStrategyOrder(order.strategyOrderId);
      if (fresh) await progressStrategyOrderPostSubmission(fresh);
    }
  }
  // Sprint 3.6B.2, Section 11 — mandatory restart scenario: the Position was closed on the exchange
  // while the backend was offline. Must be detected and completed on the very next startup, exactly
  // like any other tick — no duplicate Trade, no duplicate Position, no fake Fill, no new exchange write.
  for (const order of listStrategyOrders()) {
    if (MANAGED_POSITION_STATUSES.includes(order.status)) {
      const fresh = getStrategyOrder(order.strategyOrderId);
      if (fresh) await detectExternalPositionClose(fresh);
    }
  }
  // Sprint 3.6B.2.1, Section 12 — mandatory restart scenario: protection reconciliation must resume
  // exactly where it left off (PENDING/READ_FAILED/ORPHANED_PROTECTION), read-only, no new Entry, no
  // new Protection POST, no cancel.
  for (const order of listStrategyOrders()) {
    if (needsClosedProtectionReconciliation(order)) {
      const fresh = getStrategyOrder(order.strategyOrderId);
      if (fresh) await reconcileClosedPositionProtection(fresh);
    }
  }
}

/** The main tick — Section 10/13. Idempotent per call; safe to invoke concurrently-free (single
 * setInterval owner in server.ts). */
export async function runMonitorTick(): Promise<void> {
  const now = new Date();
  const all = listStrategyOrders();

  // 1) Expiry — pre-entry states past expiresAt never produce new entry exposure (Section 8.A/B).
  for (const order of all) {
    if (PRE_ENTRY_STATUSES.includes(order.status) && isExpired(order, now)) {
      transitionStrategyOrder(order, 'EXPIRED', { failureReason: 'expiresAt reached before any entry order existed' });
      appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'EXPIRED', previousStatus: order.status, newStatus: 'EXPIRED', reason: 'expiresAt reached' });
      emit({ type: 'expired', strategyOrderId: order.strategyOrderId });
    }
  }

  // 2) Recovery — any TRIGGERED order with a pending submission that never confirmed.
  for (const order of all) {
    if (order.status === 'TRIGGERED' && order.submission.pendingClientOrderId && !order.submission.exchangeOrderId) {
      await recoverPendingSubmission(order);
    }
  }

  // 2.5) Section 2-4/14 — headless post-submission progression for every in-flight order: fill
  // detection, position sync, allocation, protection reconciliation/verification. Runs on every tick
  // regardless of whether any order is ARMED right now — this is what makes the full lifecycle work
  // with no browser ever opening. Expiry-driven remainder cancellation (Section 13) runs first.
  for (const order of all) {
    if (IN_FLIGHT_STATUSES.includes(order.status)) {
      await cancelRemainderIfExpired(order);
      const fresh = getStrategyOrder(order.strategyOrderId);
      if (fresh) await progressStrategyOrderPostSubmission(fresh);
    }
  }

  // 2.6) Sprint 3.6B.2 — External Position Closure Reconciliation (Section 2-10): a POSITION_ACTIVE
  // Strategy keeps getting its real Position quantity re-checked every tick, forever, until the
  // exchange confirms zero — this is what makes a manually-closed Position (or any other
  // non-app-initiated close) complete the Strategy with no browser ever needing to open.
  for (const order of all) {
    if (MANAGED_POSITION_STATUSES.includes(order.status)) {
      await detectExternalPositionClose(order);
    }
  }

  // 2.7) Sprint 3.6B.2.1 — post-close protection-cleanup reconciliation (Section 3-8): a COMPLETED
  // order whose external-close protection state isn't yet terminal keeps getting re-checked every
  // tick, forever, until two consecutive clean reads confirm CONFIRMED_NONE or an orphan is found and
  // (later) self-heals. Uses `all` (captured at the top of this tick) same as step 2.6 — an order that
  // completes THIS tick via step 2.6 is picked up starting next tick, giving its first protection read
  // real temporal separation from the completion moment rather than a same-millisecond re-check.
  for (const order of all) {
    if (needsClosedProtectionReconciliation(order)) {
      await reconcileClosedPositionProtection(order);
    }
  }

  // 3) Trigger evaluation for ARMED (non-paused, authorized, not expired) orders.
  const armed = listStrategyOrders().filter((o) => o.status === 'ARMED' && o.authorization);
  if (!armed.length) return;

  const symbolsForPrice = new Set<string>();
  const candleKeys = new Set<string>();
  for (const o of armed) {
    if (!o.trigger) continue;
    if (requiresPrice(o.trigger)) symbolsForPrice.add(o.symbol);
    for (const tf of requiredCandleTimeframes(o.trigger)) candleKeys.add(o.symbol + '|' + tf);
  }
  const priceMap = await fetchPriceMap([...symbolsForPrice]);
  const candleMap: Record<string, number> = {};
  await Promise.all([...candleKeys].map(async (key) => {
    const [symbol, timeframe] = key.split('|');
    const close = await fetchCandleClose(symbol, timeframe);
    if (close != null) candleMap[key] = close;
  }));

  for (const order of armed) {
    const fresh = getStrategyOrder(order.strategyOrderId);
    if (!fresh || fresh.status !== 'ARMED') continue; // may have changed since the list was built
    const observation: MarketObservation = {
      price: priceMap[fresh.symbol] ?? null,
      candles: {},
    };
    if (fresh.trigger) {
      for (const tf of requiredCandleTimeframes(fresh.trigger)) {
        observation.candles[tf] = candleMap[fresh.symbol + '|' + tf] ?? null;
      }
    }
    fresh.monitoringState = {
      ...fresh.monitoringState,
      lastCheckedAt: now.toISOString(),
      nextCheckAt: null,
      lastObservedDataAt: (observation.price != null || Object.values(observation.candles).some((v) => v != null)) ? now.toISOString() : fresh.monitoringState.lastObservedDataAt,
      health: 'RUNNING',
    };

    // Sprint 3.8C, Section 11 — Execution Readiness is checked PROACTIVELY every tick for every ARMED
    // order, independent of whether the trigger itself fires this tick. This is what lets a broken
    // ExchangeAccount/Connection binding (or a degraded/erroring Exchange Runtime Sync) surface to the
    // user BEFORE the price condition is ever met, instead of only discovering it at
    // attemptAutoSubmission() time. Never mutates the safety chain itself (see executionReadiness.ts).
    const previousReadinessStatus = fresh.executionReadiness?.status ?? null;
    const readiness = computeExecutionReadiness(fresh);
    fresh.executionReadiness = readiness;
    saveStrategyOrder(fresh);
    // Section 21 — audit only a REAL transition (READY<->BLOCKED<->DEGRADED<->UNKNOWN), never one row
    // per tick; a same-status recompute produces zero new audit rows, matching this file's existing
    // "no audit noise for a no-op" discipline elsewhere (e.g. monitoringState updates above are never
    // audited either).
    if (previousReadinessStatus !== readiness.status) {
      appendAuditEvent({
        strategyOrderId: fresh.strategyOrderId, tradeId: fresh.tradeId, eventType: 'EXECUTION_READINESS_CHANGED',
        previousStatus: previousReadinessStatus, newStatus: readiness.status,
        reason: `${readiness.reasonCode}: ${readiness.userMessage}`,
      });
    }

    const result = evaluateStrategyTrigger(fresh.trigger, observation);
    if (!result.evaluable || !result.matched) continue;

    const referencePrice = fresh.executionIntent.entryType === 'LIMIT' && fresh.executionIntent.entryPrice != null
      ? fresh.executionIntent.entryPrice
      : (observation.price ?? (fresh.trigger!.conditions[0] as any).value);
    const observedPrice = observation.price ?? referencePrice;

    // Section 15 (Sprint 3.6B.2) — a fresh trigger attempt starts here; any PRIOR block's reason must
    // not linger as if it were still the current blocker once this attempt runs (and clears itself
    // again below if this attempt also blocks).
    const triggered = transitionStrategyOrder(fresh, 'TRIGGERED', { failureReason: null });
    appendAuditEvent({ strategyOrderId: fresh.strategyOrderId, tradeId: fresh.tradeId, eventType: 'TRIGGERED', previousStatus: 'ARMED', newStatus: 'TRIGGERED', reason: '触发条件满足', triggerSnapshot: result });
    emit({ type: 'triggered', strategyOrderId: fresh.strategyOrderId });

    await attemptAutoSubmission(triggered, referencePrice, observedPrice);
  }
}

const MONITOR_TICK_MS = 15000;
let monitorTimer: NodeJS.Timeout | null = null;
export function startMonitorLoop(): void {
  if (monitorTimer) return;
  monitorTimer = setInterval(() => { runMonitorTick().catch((err) => console.error('[strategy monitor] tick failed:', err?.message || err)); }, MONITOR_TICK_MS);
}
export function stopMonitorLoopForTesting(): void {
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
}

/** Exposed for the EXCHANGE_NATIVE immediate-submission path (Section 16) — authorization itself is
 * the trigger moment, so the route handler calls this directly instead of waiting for a tick. */
export async function triggerImmediateExchangeNativeSubmission(order: StrategyOrder): Promise<void> {
  const referencePrice = order.executionIntent.entryPrice ?? 0;
  const priceMap = await fetchPriceMap([order.symbol]);
  const observedPrice = priceMap[order.symbol] ?? referencePrice;
  const triggered = transitionStrategyOrder(order, 'TRIGGERED', { failureReason: null });
  appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'TRIGGERED', previousStatus: 'ARMED', newStatus: 'TRIGGERED', reason: 'EXCHANGE_NATIVE：授权即提交' });
  await attemptAutoSubmission(triggered, referencePrice, observedPrice);
}

/** Sprint 3.7 — the AUTONOMOUS `OPEN` decision's immediate-submission path. Structurally identical to
 * `triggerImmediateExchangeNativeSubmission()` above (transition ARMED->TRIGGERED, run the exact same
 * Execution Guard/AUTO Risk Policy/Risk Guard/submit chain via `attemptAutoSubmission` — Section 4/21:
 * never a second execution implementation) — kept as its own named function rather than a blind alias
 * so the audit trail records an honest, source-specific reason instead of the EXCHANGE_NATIVE-specific
 * "授权即提交" text, which would misdescribe an AUTONOMOUS OPEN (there is no user authorization click
 * here, and no exchange-native trigger routing — Section 14's "no trigger to wait for" case). */
export async function triggerImmediateAutonomousSubmission(order: StrategyOrder): Promise<void> {
  const referencePrice = order.executionIntent.entryPrice ?? 0;
  const priceMap = await fetchPriceMap([order.symbol]);
  const observedPrice = priceMap[order.symbol] ?? referencePrice;
  const triggered = transitionStrategyOrder(order, 'TRIGGERED', { failureReason: null });
  appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'TRIGGERED', previousStatus: 'ARMED', newStatus: 'TRIGGERED', reason: 'AUTONOMOUS OPEN：AI 决策后立即提交' });
  await attemptAutoSubmission(triggered, referencePrice, observedPrice);
}
