/** Sprint 3.6B — Execution Guard (Section 12). Trigger TRUE does not mean submit — this is a second,
 * deterministic, price-deviation check run at the instant of firing, comparing the trigger-time
 * observed price against the plan's own reference price. Never AI-adjudicated, never skippable by
 * anything other than an explicit `maxPriceDeviationPct: null` (no guard configured). */
import type { ExecutionGuard } from './types.js';

export interface ExecutionGuardResult {
  status: 'PASS' | 'BLOCKED' | 'SKIPPED';
  message: string;
}

/** `referencePrice` is the plan's own intended entry reference (the LIMIT price, or the trigger
 * condition's own value for a MARKET entry — resolved by the caller). `observedPrice` is the real
 * market price read at the moment the trigger fired. */
export function evaluateExecutionGuard(guard: ExecutionGuard, referencePrice: number, observedPrice: number): ExecutionGuardResult {
  if (guard.maxPriceDeviationPct == null) {
    return { status: 'SKIPPED', message: '未配置执行保护（价格偏离）' };
  }
  if (!Number.isFinite(referencePrice) || !Number.isFinite(observedPrice) || referencePrice <= 0) {
    return { status: 'BLOCKED', message: '参考价格或触发时行情无效，无法验证执行保护' };
  }
  const deviationPct = Math.abs(observedPrice - referencePrice) / referencePrice * 100;
  if (deviationPct > guard.maxPriceDeviationPct) {
    return { status: 'BLOCKED', message: `触发时行情 ${observedPrice} 相对参考价 ${referencePrice} 偏离 ${deviationPct.toFixed(2)}%，超过执行保护上限 ${guard.maxPriceDeviationPct}%` };
  }
  return { status: 'PASS', message: `触发时行情 ${observedPrice} 相对参考价 ${referencePrice} 偏离 ${deviationPct.toFixed(2)}%，未超过执行保护上限 ${guard.maxPriceDeviationPct}%` };
}
