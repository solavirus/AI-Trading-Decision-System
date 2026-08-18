/** Sprint 3.8C — Execution Readiness. Answers, PROACTIVELY (before a trigger ever fires — Section
 * 11 of the spec), "if this StrategyOrder's trigger fired right now, would it actually be able to
 * reach the submission chain?" — distinct from `StrategyOrder.status` (an order can be `ARMED` while
 * `executionReadiness.status` is `BLOCKED`; those are two different questions, never conflated).
 *
 * This is READ-ONLY diagnosis. It NEVER replaces or short-circuits the real safety chain — Kill
 * Switch / Execution Guard / AUTO Risk Policy / Risk Guard are re-run in full at actual trigger time
 * regardless of what this function last reported (see monitorEngine.ts#attemptAutoSubmission, which
 * this file does not touch). `READY` only means "known blockers, as of this check, are absent" — it
 * is never a guarantee a future trigger will actually submit. */
import type { StrategyOrder } from './types.js';
import { resolvePreferredConnectionForAccount } from '../exchange/exchangeAccountStore.js';
import { getExchangeConnection } from '../exchange/exchangeConnectionStore.js';
import { getAccountRuntimeState } from '../exchange/exchangeRuntimeSync.js';

export type ExecutionReadinessStatus = 'READY' | 'BLOCKED' | 'DEGRADED' | 'UNKNOWN';

/** Only the reason codes this system can actually produce today — Section 10's own instruction
 * ("只实现当前真实需要的，不要预造几十种枚举"). Machine-readable; `userMessage` on the result is the
 * one honest, short sentence a normal user should see. */
export type ExecutionReadinessReasonCode =
  | 'READY'
  | 'ACCOUNT_MISSING'
  | 'CONNECTION_MISSING'
  | 'CONNECTION_DISABLED'
  | 'ENVIRONMENT_MISMATCH'
  | 'EXCHANGE_SYNC_STARTING'
  | 'EXCHANGE_SYNC_STALE'
  | 'EXCHANGE_SYNC_ERROR';

export interface ExecutionReadiness {
  status: ExecutionReadinessStatus;
  reasonCode: ExecutionReadinessReasonCode;
  userMessage: string;
  technicalDetail: string | null;
  checkedAt: string;
}

function result(status: ExecutionReadinessStatus, reasonCode: ExecutionReadinessReasonCode, userMessage: string, technicalDetail: string | null): ExecutionReadiness {
  return { status, reasonCode, userMessage, technicalDetail, checkedAt: new Date().toISOString() };
}

/** Classifies `resolvePreferredConnectionForAccount()`'s existing, frozen reason strings into a
 * stable machine-readable code — never changes that function's own behavior or wording, only reads
 * its output. An unrecognized reason (future addition to that function) still surfaces safely as
 * `CONNECTION_MISSING` with the real reason preserved in `technicalDetail`, never silently dropped. */
function classifyResolutionFailure(reason: string): ExecutionReadinessReasonCode {
  if (reason.includes('禁用')) return 'CONNECTION_DISABLED';
  return 'CONNECTION_MISSING'; // covers "账户不存在" / "未设置首选连接" / "连接不存在" / "绑定不一致"
}

/** Only meaningful for a StrategyOrder that could still reach submission (Section 11 scope — an
 * already-terminal order's readiness is not recomputed; callers only call this for ARMED orders
 * today, see monitorEngine.ts). Never mutates `order` — the caller decides whether/how to persist
 * the result (`saveStrategyOrder`), matching the read/compute vs. write separation the rest of this
 * codebase already uses (e.g. `evaluateStrategyTrigger()`). */
export function computeExecutionReadiness(order: StrategyOrder): ExecutionReadiness {
  const accountId = order.submission.exchangeAccountId;
  if (!accountId) {
    return result('UNKNOWN', 'ACCOUNT_MISSING', '尚未绑定交易账户，暂时无法判断执行能力', null);
  }

  const resolved = resolvePreferredConnectionForAccount(accountId);
  if (!resolved.ok) {
    const reasonCode = classifyResolutionFailure(resolved.reason);
    const userMessage = reasonCode === 'CONNECTION_DISABLED'
      ? '无法执行：交易账户连接已被禁用'
      : '无法执行：交易账户连接已失效';
    return result('BLOCKED', reasonCode, userMessage, resolved.reason);
  }

  const connection = getExchangeConnection(resolved.connectionId);
  if (!connection || connection.environment !== 'TESTNET') {
    // Same hard LIVE block as attemptAutoSubmission() itself (Section 14 of the original 3.6B spec) —
    // Execution Readiness must never say READY for something the real submission chain would refuse.
    return result('BLOCKED', 'ENVIRONMENT_MISMATCH', '无法执行：解析到的连接不是 TESTNET 环境', null);
  }

  const runtime = getAccountRuntimeState(accountId);
  if (!runtime || runtime.syncHealth === 'STARTING') {
    return result('UNKNOWN', 'EXCHANGE_SYNC_STARTING', '正在确认交易账户状态…', null);
  }
  if (runtime.syncHealth === 'ERROR' || runtime.syncHealth === 'DISABLED') {
    return result('BLOCKED', 'EXCHANGE_SYNC_ERROR', '无法执行：交易账户状态长时间无法确认', runtime.lastError?.message ?? null);
  }
  if (runtime.syncHealth === 'DEGRADED') {
    return result('DEGRADED', 'EXCHANGE_SYNC_STALE', '交易账户状态更新延迟，执行能力暂不确定', runtime.lastError?.message ?? null);
  }

  return result('READY', 'READY', '已就绪', null);
}
