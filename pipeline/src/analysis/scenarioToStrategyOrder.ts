/** Sprint 3.9, Section 12/13 — bridges the unified AI response (`ScenarioPlan`/`decision`, this
 * module's own `types.ts`) into a real `StrategyOrder` (`strategy/types.ts`). This is the ONE place
 * a ScenarioPlan becomes a StrategyOrder for the AUTONOMOUS/SCHEDULED path — `autonomousScheduler.ts`
 * calls it instead of its old, now-removed `buildStrategyOrderFromDecision(AutonomousDecision)`.
 * `mapScenarioTriggerToStrategyTrigger` is a faithful backend port of the identically-named function
 * in `prototype/index.html` (Sprint 3.6A), which the MANUAL arm flow already uses for the exact same
 * translation — same narrower `Trigger` vocabulary (GT/GTE/LT/LTE only; BETWEEN / CROSSES_ABOVE /
 * CROSSES_BELOW / EQUALS can't be expressed and map to `null`, same limitation Manual already has and displays honestly
 * rather than working around). */
import type { StructuredTrigger, ScenarioPlan } from './types.js';
import type { ExecutionGuard, ExecutionIntent, StrategyMaterializationReasonCode, StrategyOrder, Trigger, TriggerMetric, TriggerOperator } from '../strategy/types.js';
import { genStrategyOrderId } from '../strategy/strategyOrderStore.js';

const TRIGGER_TIMEFRAME_MS: Record<string, number> = { '1H': 3600000, '4H': 14400000, '1D': 86400000, '1W': 604800000 };

export function mapScenarioTriggerToStrategyTrigger(triggerStructured: StructuredTrigger | null | undefined): Trigger | null {
  if (!triggerStructured || !Array.isArray(triggerStructured.conditions) || !triggerStructured.conditions.length) return null;
  const metricMap: Record<string, TriggerMetric> = { price: 'PRICE', candle_close: 'CANDLE_CLOSE_PRICE' };
  const allowedOps: TriggerOperator[] = ['GT', 'GTE', 'LT', 'LTE'];
  const conditions: Trigger['conditions'] = [];
  for (const c of triggerStructured.conditions) {
    const metric = metricMap[c.metric];
    if (!metric || !allowedOps.includes(c.operator as TriggerOperator) || typeof c.value !== 'number' || !Number.isFinite(c.value)) return null;
    const cond: Trigger['conditions'][number] = { metric, operator: c.operator as TriggerOperator, value: c.value };
    if (metric === 'CANDLE_CLOSE_PRICE') {
      if (!c.timeframe || !TRIGGER_TIMEFRAME_MS[c.timeframe]) return null;
      cond.timeframe = c.timeframe;
    }
    conditions.push(cond);
  }
  const logic = conditions.length === 1 ? 'SINGLE' : triggerStructured.logic === 'ALL' ? 'AND' : 'OR';
  return { logic, conditions };
}

/** Resolves a ScenarioPlan's numeric entry/stopLoss/takeProfit into a `StrategyOrder.executionIntent`.
 * Only called for a PRIMARY plan that already passed `evaluateScenarioExecutionReadiness` (i.e. the
 * unified response validator already guarantees numeric completeness) — this function does not
 * re-validate, only re-shapes. `positionSizeUsdt`/`leverage` are NOT part of `ScenarioPlan` (Core
 * Truth Rule — AI never dictates position size/leverage, Manual always requires the user to type
 * them in the Arm form); for AUTONOMOUS, they come from policy-configured, backend-owned defaults
 * instead — see `autonomousScheduler.ts`'s caller. */
export function scenarioPlanToExecutionIntent(plan: ScenarioPlan, positionSizeUsdt: number, leverage: number): ExecutionIntent {
  const entryType: 'MARKET' | 'LIMIT' = plan.entry.type === 'MARKET' ? 'MARKET' : 'LIMIT';
  const entryPrice = entryType === 'LIMIT' ? (plan.entry.type === 'ZONE' ? (plan.entry.from! + plan.entry.to!) / 2 : plan.entry.value!) : null;
  const tpSrc = (plan.takeProfit || []).filter((tp) => typeof tp.value === 'number' && Number.isFinite(tp.value));
  const takeProfit = tpSrc.map((tp, i) => ({
    price: tp.value as number,
    portion: i === tpSrc.length - 1 ? 100 - Math.floor(100 / tpSrc.length) * (tpSrc.length - 1) : Math.floor(100 / tpSrc.length),
  }));
  return { entryType, entryPrice, positionSizeUsdt, leverage, stopLoss: plan.stopLoss.value ?? null, takeProfit };
}

export function scenarioPlanToExecutionGuard(): ExecutionGuard {
  return { maxPriceDeviationPct: 1 }; // same default Manual's Arm form pre-fills (index.html openArmStrategyModal)
}

/** Sprint 3.9, Section 12/13 — the one place a validated unified AI decision (PRIMARY `ScenarioPlan`
 * + root `decision`) becomes a real StrategyOrder for the AUTONOMOUS path. `originalStrategy` freezes
 * the AI's own structured output verbatim (Section 19 — never silently adjusted); `effectiveStrategy`/
 * `executionIntent` are the deterministic normalization of it. Moved here (from
 * `autonomousScheduler.ts`) in Sprint 3.8C.3 so `materializeScenarioPlan()` below can call it as one
 * cohesive "plan -> order or explicit block reason" unit. */
function buildAutonomousStrategyOrder(
  cycleId: string, analysisId: string, symbol: string, direction: 'LONG' | 'SHORT', decisionType: 'WAIT' | 'OPEN',
  trigger: Trigger | null, executionIntent: ExecutionIntent, executionGuard: ExecutionGuard,
  expiresAt: string, exchangeAccountId: string,
): StrategyOrder {
  const now = new Date().toISOString();
  return {
    strategyOrderId: genStrategyOrderId(), tradeId: null, symbol, direction, source: 'AUTONOMOUS',
    analysisId, scenarioPlanId: null, createdAt: now, updatedAt: now, status: 'READY',
    originalStrategy: { entryType: executionIntent.entryType, entryValue: executionIntent.entryPrice, stopLoss: executionIntent.stopLoss, takeProfit: executionIntent.takeProfit, trigger: decisionType === 'WAIT' ? trigger : null, reviewHorizonExpiresAt: expiresAt },
    effectiveStrategy: { executionIntent, trigger: decisionType === 'WAIT' ? trigger : null },
    trigger: decisionType === 'WAIT' ? trigger : null, executionIntent, executionGuard, expiresAt,
    executionMode: 'AUTONOMOUS', authorization: null, capabilityDecision: null,
    monitoringState: { lastCheckedAt: null, nextCheckAt: null, lastObservedDataAt: null, health: 'PAUSED' },
    lastDecision: null,
    submission: { exchangeConnectionId: null, exchangeAccountId, pendingClientOrderId: null, clientOrderId: null, exchangeOrderId: null, submittedAt: null },
    linkedRealOrderIds: [], linkedTradeId: null, failureReason: null, completionSource: null, closedAt: null,
    execution: {
      orderStatus: null, filledQuantity: 0, averagePrice: null, lastOrderSyncAt: null,
      positionQuantity: null, positionLastSyncedAt: null, allocationQuantity: null,
      protectionStatus: 'NOT_REQUIRED', protectionOrders: [], protectionLastVerifiedAt: null,
      postCloseProtectionState: null, activeOrphanProtectionOrderIds: [],
    },
  };
}

export interface MaterializeScenarioPlanInput {
  cycleId: string;
  analysisId: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  decisionType: 'WAIT' | 'OPEN';
  primary: ScenarioPlan;
  exchangeAccountId: string;
  defaultPositionSizeUsdt: number | null;
  defaultLeverage: number | null;
}
export type MaterializeScenarioPlanResult =
  | { status: 'CREATED'; reasonCode: null; order: StrategyOrder }
  | { status: 'BLOCKED_CONFIGURATION'; reasonCode: StrategyMaterializationReasonCode; order: null };

/** Sprint 3.8C.3, Section 9 — "把 AI ScenarioPlan -> StrategyOrder 明确变成一个独立步骤... 不要通过
 * throw Error 表达正常业务状态". Every reason a plan can't be materialized right now (missing size,
 * missing leverage, an unmappable trigger) is an EXPECTED business outcome, not an exception — this
 * function never throws for any of them; it only throws (by NOT catching) a genuine unexpected
 * exception from its own callees (storage failure, invalid invariant), matching Section 9's own
 * boundary. Pure and synchronous — makes zero network/storage calls beyond `genStrategyOrderId()`
 * (an in-memory UUID). Never touches Binance in any way. */
export function materializeScenarioPlan(input: MaterializeScenarioPlanInput): MaterializeScenarioPlanResult {
  // Core Truth Rule (unchanged, project-wide): AI never dictates position size/leverage — Manual
  // requires the user to type them in; AUTONOMOUS has no user, so it requires an explicit
  // policy-configured default instead of ever reading one off the AI response (the unified
  // ScenarioPlan schema doesn't even have such fields, by the same rule).
  if (input.defaultPositionSizeUsdt == null) return { status: 'BLOCKED_CONFIGURATION', reasonCode: 'POSITION_SIZE_NOT_CONFIGURED', order: null };
  if (input.defaultLeverage == null) return { status: 'BLOCKED_CONFIGURATION', reasonCode: 'LEVERAGE_NOT_CONFIGURED', order: null };

  let trigger: Trigger | null = null;
  if (input.decisionType === 'WAIT') {
    trigger = mapScenarioTriggerToStrategyTrigger(input.primary.triggerStructured);
    if (!trigger) return { status: 'BLOCKED_CONFIGURATION', reasonCode: 'TRIGGER_NOT_MAPPABLE', order: null };
  }

  const executionIntent = scenarioPlanToExecutionIntent(input.primary, input.defaultPositionSizeUsdt, input.defaultLeverage);
  const executionGuard = scenarioPlanToExecutionGuard();
  const expiresAt = input.primary.reviewHorizon!.expiresAt!; // guaranteed present+future for a validated PRIMARY
  const order = buildAutonomousStrategyOrder(input.cycleId, input.analysisId, input.symbol, input.direction, input.decisionType, trigger, executionIntent, executionGuard, expiresAt, input.exchangeAccountId);
  return { status: 'CREATED', reasonCode: null, order };
}
