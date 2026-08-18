/** Sprint 3.6B, semantically corrected in 3.6B.1 — Trigger Capability Router. See
 * docs/BINANCE_CAPABILITY_MATRIX.md for the live-verified Binance research this decision logic is
 * built on. Principle (Section 11 of the 3.6B.1 spec): EXCHANGE_NATIVE only when Binance can natively
 * express behavior SEMANTICALLY EQUIVALENT to the Strategy trigger/execution — never a proximity
 * heuristic ("price is close/far from current market"), which this function has never used for
 * classification (distance only ever belongs in Execution Guard, evaluated separately at trigger
 * time). APP_MONITORED for anything needing real evaluation logic (AND/OR, candle-close, or a price
 * trigger paired with a MARKET entry — MARKET has no "wait for this price" semantics of its own).
 *
 * 3.6B.1 fix: the original version only checked "single PRICE condition + LIMIT entry", without
 * verifying the trigger's own price level actually IS the LIMIT order's price, or that the
 * operator's direction matches how a plain LIMIT order naturally fills. A Binance LIMIT BUY only
 * ever fills when price drops to/below its price (native LTE/LT semantics for a LONG entry); a LIMIT
 * SELL only fills when price rises to/above its price (native GTE/GT semantics for a SHORT entry). A
 * GTE/GT trigger paired with a LONG LIMIT buy (a breakout-style "buy once price rises past X") has NO
 * native single-order equivalent — Binance would need a stop/conditional order for that, which this
 * app does not submit as an entry order — so it must stay APP_MONITORED, not be misclassified as
 * "the LIMIT order itself IS the trigger." Both the price LEVEL and the operator DIRECTION must match. */
import type { Trigger, ExecutionIntent, CapabilityDecision } from './types.js';

const GTD_MIN_LEAD_MS = 600_000; // Binance: goodTillDate must be > now + 600s
const PRICE_LEVEL_EPSILON = 1e-9; // floating-point-safe equality for the trigger value vs. entryPrice check

export interface CapabilityRouterResult {
  decision: CapabilityDecision;
  reason: string;
  canUseGtd: boolean;
}

/** The side a plain LIMIT order at `intent.entryPrice` would be submitted as, given `direction` —
 * mirrors the exact mapping `monitorEngine.ts`/the frontend already use (`LONG`->`BUY`, `SHORT`->`SELL`). */
function nativelyMatchingOperators(direction: 'LONG' | 'SHORT'): Array<'LTE' | 'LT' | 'GTE' | 'GT'> {
  // LONG = BUY: a resting LIMIT buy fills as price falls to/through the order price -> LTE/LT.
  // SHORT = SELL: a resting LIMIT sell fills as price rises to/through the order price -> GTE/GT.
  return direction === 'LONG' ? ['LTE', 'LT'] : ['GTE', 'GT'];
}

export function routeTriggerCapability(trigger: Trigger | null, intent: ExecutionIntent, expiresAt: string | null, direction: 'LONG' | 'SHORT' = 'LONG', now: Date = new Date()): CapabilityRouterResult {
  if (!trigger || trigger.conditions.length === 0) {
    return { decision: 'UNSUPPORTED', reason: '未配置触发条件', canUseGtd: false };
  }
  for (const c of trigger.conditions) {
    if (c.metric !== 'PRICE' && c.metric !== 'CANDLE_CLOSE_PRICE') {
      return { decision: 'UNSUPPORTED', reason: `不支持的 trigger metric: ${c.metric}`, canUseGtd: false };
    }
    if (!['GT', 'GTE', 'LT', 'LTE'].includes(c.operator)) {
      return { decision: 'UNSUPPORTED', reason: `不支持的 trigger operator: ${c.operator}`, canUseGtd: false };
    }
  }

  const isLimitEntry = intent.entryType === 'LIMIT' && typeof intent.entryPrice === 'number' && Number.isFinite(intent.entryPrice);
  const singleCondition = trigger.logic === 'SINGLE' && trigger.conditions.length === 1 ? trigger.conditions[0] : null;
  const isSinglePriceCondition = !!singleCondition && singleCondition.metric === 'PRICE';

  if (!isSinglePriceCondition || !isLimitEntry) {
    return { decision: 'APP_MONITORED', reason: 'AND/OR、CANDLE_CLOSE_PRICE 条件，或非 LIMIT 入场，需要应用侧监控评估', canUseGtd: false };
  }

  // 3.6B.1 — the two semantic-equivalence checks a proximity heuristic would have skipped.
  const priceLevelMatches = Math.abs(singleCondition!.value - (intent.entryPrice as number)) < PRICE_LEVEL_EPSILON;
  const directionMatches = nativelyMatchingOperators(direction).includes(singleCondition!.operator as any);
  if (!priceLevelMatches) {
    return { decision: 'APP_MONITORED', reason: '触发条件的价格水平与 LIMIT 入场价不一致，原生订单无法表达该触发时机，需要应用侧监控评估', canUseGtd: false };
  }
  if (!directionMatches) {
    return { decision: 'APP_MONITORED', reason: `触发方向（${singleCondition!.operator}）与 ${direction === 'LONG' ? 'LIMIT 买单' : 'LIMIT 卖单'}的原生成交方向不匹配（需要条件/止损类订单才能表达），需要应用侧监控评估`, canUseGtd: false };
  }

  let canUseGtd = false;
  if (expiresAt) {
    const exp = new Date(expiresAt).getTime();
    if (Number.isFinite(exp) && exp - now.getTime() > GTD_MIN_LEAD_MS) canUseGtd = true;
  }
  return {
    decision: 'EXCHANGE_NATIVE',
    reason: canUseGtd ? '单一价格条件与 LIMIT 入场价一致，方向匹配，可用原生 LIMIT 订单（GTD）表达' : '单一价格条件与 LIMIT 入场价一致，方向匹配，可用原生 LIMIT 订单表达（到期时间不满足 GTD 最小提前量，到期由应用侧撤单）',
    canUseGtd,
  };
}
