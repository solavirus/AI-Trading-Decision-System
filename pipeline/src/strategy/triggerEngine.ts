/** Sprint 3.6B — deterministic trigger evaluation, backend copy. Same semantics as the frontend's
 * existing NOTIFY Trigger Monitor (`evaluateTrigger`/`isConditionMet`/`evalOperator` in
 * `prototype/index.html`, Sprint 3.4B) — ported rather than shared because that code runs in the
 * browser and this runs in the backend process, which is the whole point of Section 10's
 * "backend-owned, not browser setInterval" requirement. Scope is intentionally narrower than the
 * frontend version: only `PRICE`/`CANDLE_CLOSE_PRICE` with `GT`/`GTE`/`LT`/`LTE` (Section 6 — no
 * CROSSES_ABOVE/CROSSES_BELOW/BETWEEN/EQUALS for StrategyOrder triggers this sprint), and
 * `SINGLE`/`AND`/`OR` logic (no nested trees). Never non-deterministic, never AI-adjudicated. */
import type { Trigger, TriggerCondition } from './types.js';

export type ConditionResultState = 'MATCHED' | 'UNMATCHED' | 'UNRESOLVED';

export interface MarketObservation {
  price: number | null;
  candles: Record<string, number | null>; // timeframe -> most recent CLOSED candle's close price, or null if unavailable
}

export function evalCondition(condition: TriggerCondition, observation: MarketObservation): ConditionResultState {
  let current: number | null = null;
  if (condition.metric === 'PRICE') {
    current = observation.price;
  } else if (condition.metric === 'CANDLE_CLOSE_PRICE') {
    if (!condition.timeframe) return 'UNRESOLVED';
    current = observation.candles[condition.timeframe] ?? null;
  }
  if (current == null) return 'UNRESOLVED';
  switch (condition.operator) {
    case 'GT': return current > condition.value ? 'MATCHED' : 'UNMATCHED';
    case 'GTE': return current >= condition.value ? 'MATCHED' : 'UNMATCHED';
    case 'LT': return current < condition.value ? 'MATCHED' : 'UNMATCHED';
    case 'LTE': return current <= condition.value ? 'MATCHED' : 'UNMATCHED';
    default: return 'UNRESOLVED';
  }
}

export interface TriggerEvaluationResult {
  matched: boolean;
  evaluable: boolean;
  conditionResults: { condition: TriggerCondition; result: ConditionResultState }[];
}

/** `logic==='SINGLE'` requires exactly one condition. `AND` requires every condition MATCHED (any
 * UNMATCHED/UNRESOLVED keeps it false). `OR` fires on any single MATCHED regardless of siblings being
 * UNRESOLVED — an unresolved sibling never blocks a real match. Same rule as the frontend's existing
 * `evaluateTrigger()`, deliberately kept identical. */
export function evaluateStrategyTrigger(trigger: Trigger | null, observation: MarketObservation): TriggerEvaluationResult {
  if (!trigger || !Array.isArray(trigger.conditions) || trigger.conditions.length === 0) {
    return { matched: false, evaluable: false, conditionResults: [] };
  }
  if (trigger.logic === 'SINGLE' && trigger.conditions.length !== 1) {
    return { matched: false, evaluable: false, conditionResults: [] };
  }
  const conditionResults = trigger.conditions.map((c) => ({ condition: c, result: evalCondition(c, observation) }));
  const matched = trigger.logic === 'AND'
    ? conditionResults.every((r) => r.result === 'MATCHED')
    : conditionResults.some((r) => r.result === 'MATCHED'); // SINGLE and OR share "at least one MATCHED" semantics
  return { matched, evaluable: true, conditionResults };
}

/** Every distinct timeframe a trigger's CANDLE_CLOSE_PRICE conditions need — used by the monitor tick
 * to batch/dedupe real market-data fetches across every ARMED StrategyOrder, same discipline as the
 * frontend Trigger Monitor's "one request per distinct (symbol,timeframe) pair" rule. */
export function requiredCandleTimeframes(trigger: Trigger | null): string[] {
  if (!trigger) return [];
  const set = new Set<string>();
  for (const c of trigger.conditions) {
    if (c.metric === 'CANDLE_CLOSE_PRICE' && c.timeframe) set.add(c.timeframe);
  }
  return [...set];
}
export function requiresPrice(trigger: Trigger | null): boolean {
  if (!trigger) return false;
  return trigger.conditions.some((c) => c.metric === 'PRICE');
}
