/** Sprint 3.7 — Autonomous Trading V1 orchestration. See EXECUTION_SPEC.md's own section for the full
 * contract. Owns exactly one thing end-to-end: turning a due scheduled slot into, at most, one
 * validated AI decision and, at most, one resulting StrategyOrder — then handing off entirely to the
 * EXISTING StrategyOrder/Monitor Engine/Execution Guard/AUTO Risk Policy/Risk Guard/Kill Switch chain
 * (Section 4's architecture diagram: this file never talks to Binance, never talks to the AI provider
 * except through the existing `runAIAnalysis()`, and never creates a RealOrder/RealTrade/Position —
 * all of that remains exactly where 3.6B/3.6B.1/3.6B.2/3.6B.2.1 left it).
 *
 * Sprint 3.9 — Unified Analysis Pipeline. This file no longer gathers its own "price + account
 * balance" snapshot, builds its own prompt, or validates its own decision contract — the OLD
 * `autonomousPrompt.ts`/`autonomousDecisionContract.ts` AI Brain is no longer called from here (see
 * their own now-deprecated header comments). Every cycle instead calls `analysis/analysisEngine.ts`'s
 * `runAnalysis({source:'SCHEDULED', ...})` — the EXACT SAME pipeline Manual analysis calls (Section
 * 0/5 of the spec: "Manual + Scheduled 必须真正共用同一套完整 Analysis Pipeline"). The only things
 * still owned here: the scheduler timing/idempotency/permission gates (Section 23), and turning the
 * unified AI response into either a Position Management record (when a real position already exists,
 * Section 14) or a new StrategyOrder (Section 13) — never a second AI-decision schema. */
import type { AutonomousCycle, StrategyMaterializationReasonCode, StrategyOrder, Trigger } from './types.js';
import { getAutonomousPolicy } from './autonomousPolicyStore.js';
import { getAutonomousSchedulerState, saveAutonomousSchedulerState } from './autonomousSchedulerStore.js';
import { getAutonomousCycle, saveAutonomousCycle, genAutonomousCycleId, listAutonomousCycles } from './autonomousCycleStore.js';
import { saveStrategyOrder, transitionStrategyOrder, listStrategyOrders } from './strategyOrderStore.js';
import { appendAuditEvent } from './auditLogStore.js';
import { isAutoExecutionAllowed } from './killSwitch.js';
import { routeTriggerCapability } from './capabilityRouter.js';
import { resolvePreferredConnectionForAccount, triggerImmediateExchangeNativeSubmission, triggerImmediateAutonomousSubmission } from './monitorEngine.js';
import { getExchangeAccount } from '../exchange/exchangeAccountStore.js';
import { getExchangeConnection } from '../exchange/exchangeConnectionStore.js';
import { fetchExchangeAccountSnapshot } from '../exchange/exchangeService.js';
import { toBinanceFuturesSymbol } from '../exchange/binanceFuturesAdapter.js';
import { getRoleConfig } from '../ai/configStore.js';
import { getConnection as getAiConnection } from '../ai/connectionStore.js';
import { runAnalysis } from '../analysis/analysisEngine.js';
import { WEIGHT_DEFS, SOURCE_LABELS } from '../analysis/weightDefs.js';
import { genAnalysisId } from '../analysis/payloadBuilder.js';
import { createAnalysisRun, createProgressReporter } from '../analysis/analysisRunStore.js';
import type { SourceKey } from '../types.js';
import { materializeScenarioPlan } from '../analysis/scenarioToStrategyOrder.js';
import { withRetry } from '../analysis/retryPolicy.js';
import { decidePreflightBlock } from './automationReadiness.js';

let __baseUrl = 'http://localhost:8787';
export function configureAutonomousScheduler(opts: { baseUrl: string }): void {
  __baseUrl = opts.baseUrl;
}

const ACTIVE_STRATEGY_STATUSES = ['WAITING_TRIGGER', 'ARMED', 'TRIGGERED', 'ENTRY_SUBMITTED', 'PARTIALLY_FILLED', 'POSITION_ACTIVE'];

/** Sprint 3.9 — every autonomous cycle analyzes with the canonical default source weights (the same
 * defaults `WEIGHT_DEFS` proposes for a fresh Manual draft). There is no per-cycle UI to configure
 * these for a headless scheduled run, and Section 2 explicitly forbids a reduced/simplified data set
 * — using the full canonical weighting (every source > 0) guarantees every required source is
 * actually gathered, never a smaller "autonomous-only" subset. */
const AUTONOMOUS_SOURCE_WEIGHTS: Record<string, number> = Object.fromEntries(WEIGHT_DEFS.map((w) => [w.key, w.def]));
const AUTONOMOUS_TIMEFRAME = '4H';
const AUTONOMOUS_DATE_RANGE = '最近7天';

/** Section 10 — a small, self-contained mutable accumulator for one cycle's own audit trail (never
 * the shared `AuditEvent` log, which requires a real `strategyOrderId` — most cycles never produce
 * one; see `AutonomousCycle`'s own doc comment in types.ts). */
class CycleBuilder {
  cycle: AutonomousCycle;
  constructor(cycleId: string, symbol: string, scheduledAt: string, manual: boolean) {
    this.cycle = {
      cycleId, symbol, scheduledAt, startedAt: new Date().toISOString(), completedAt: null,
      status: 'RUNNING', manual, skipReason: null, marketSnapshotRef: null, accountSnapshotRef: null,
      decision: null, invalidDecisionReason: null, strategyOrderId: null, failureReason: null, events: [],
      analysisId: null, positionManagementAction: null,
      strategyMaterializationStatus: null, strategyMaterializationReasonCode: null,
    };
  }
  log(eventType: string, reason: string): void {
    this.cycle.events.push({ timestamp: new Date().toISOString(), eventType, reason });
  }
  persist(): AutonomousCycle {
    return saveAutonomousCycle(this.cycle);
  }
  skip(reason: string): AutonomousCycle {
    this.log('CYCLE_SKIPPED', reason);
    this.cycle = { ...this.cycle, status: 'SKIPPED', skipReason: reason, completedAt: new Date().toISOString() };
    return this.persist();
  }
  /** Sprint 3.8C.3, Section 5/8/15 — the pre-AI preflight determined a NEW entry can't be created
   * (static config missing) and no existing position needs managing instead. `analysisId` stays
   * `null` — `runAnalysis()` was never called, zero AI cost. Distinct from `error()`: this is an
   * expected, deterministic business outcome, not a failure. */
  configurationBlocked(reasonCode: StrategyMaterializationReasonCode): AutonomousCycle {
    this.log('CONFIGURATION_BLOCKED', reasonCode);
    this.cycle = {
      ...this.cycle, status: 'CONFIGURATION_BLOCKED', skipReason: reasonCode, completedAt: new Date().toISOString(),
      strategyMaterializationStatus: 'BLOCKED_CONFIGURATION', strategyMaterializationReasonCode: reasonCode,
    };
    return this.persist();
  }
  /** Reserved for genuine, unexpected failures: AI/provider error, a snapshot read that still failed
   * after retry, an invalid AI decision, storage failure — never for an expected business state like
   * missing static config (Section 9/25). */
  error(reason: string): AutonomousCycle {
    this.log('ERROR', reason);
    this.cycle = { ...this.cycle, status: 'ERROR', failureReason: reason, completedAt: new Date().toISOString() };
    return this.persist();
  }
  complete(): AutonomousCycle {
    this.cycle = { ...this.cycle, status: 'COMPLETED', completedAt: new Date().toISOString() };
    return this.persist();
  }
}

/** Section 15/19 — a decision that's structurally VALID but not currently PERMITTED (wrong direction,
 * or OPEN when the policy doesn't allow it) still produces a durable, auditable StrategyOrder rather
 * than silently vanishing as a cycle-level error (Section 28: "为什么没有执行" must stay answerable).
 * Drives the order through the SAME ARMED->TRIGGERED->EXECUTION_BLOCKED sequence the existing engine
 * already uses for any other guard failure — this is a policy pre-check ahead of that chain, not a
 * second implementation of it. */
function blockAutonomousStrategy(order: StrategyOrder, reason: string): StrategyOrder {
  const armed = transitionStrategyOrder(order, 'ARMED', {});
  appendAuditEvent({ strategyOrderId: armed.strategyOrderId, tradeId: null, eventType: 'ARMED', previousStatus: order.status, newStatus: 'ARMED', reason: 'AUTONOMOUS 授权' });
  const triggered = transitionStrategyOrder(armed, 'TRIGGERED', {});
  appendAuditEvent({ strategyOrderId: triggered.strategyOrderId, tradeId: null, eventType: 'TRIGGERED', previousStatus: 'ARMED', newStatus: 'TRIGGERED', reason: 'AUTONOMOUS 决策后立即评估' });
  const blocked = transitionStrategyOrder(triggered, 'EXECUTION_BLOCKED', { failureReason: reason });
  appendAuditEvent({ strategyOrderId: blocked.strategyOrderId, tradeId: null, eventType: 'STRATEGY_BLOCKED', previousStatus: 'TRIGGERED', newStatus: 'EXECUTION_BLOCKED', reason });
  return blocked;
}

/** Section 4 — the full per-symbol cycle pipeline: Pre-AI Gate -> Unified Analysis -> Position
 * Management OR new-entry StrategyOrder. Idempotent by construction: `cycleId` is deterministic from
 * `symbol+scheduledAt(+manual)`, and the very first thing this function does is check whether that
 * cycle already exists — if so, it returns the existing record untouched rather than doing anything
 * again (Section 6/30's whole idempotency guarantee lives here, not in the caller). */
export async function runAutonomousCycleForSymbol(symbol: string, opts: { scheduledAt: string; manual: boolean }): Promise<AutonomousCycle> {
  const cycleId = genAutonomousCycleId(symbol, opts.scheduledAt, opts.manual);
  const existing = getAutonomousCycle(cycleId);
  if (existing) return existing;

  const b = new CycleBuilder(cycleId, symbol, opts.scheduledAt, opts.manual);
  b.log('CYCLE_STARTED', opts.manual ? '手动触发（Run Analysis Now）' : '定时触发');
  b.persist(); // persisted as RUNNING immediately — a crash from here on leaves this exact slot "handled" (never silently re-attempted), matching Section 29's failure philosophy

  // ---- Pre-AI Gate (Section 8) — every check below costs zero AI tokens. ----
  const policy = getAutonomousPolicy();
  if (!policy.autonomousEnabled) return b.skip('AUTONOMOUS_DISABLED：自主交易未启用');
  if (!isAutoExecutionAllowed()) return b.skip('KILL_SWITCH_SKIP：Kill Switch 已暂停，跳过本轮 AI 调用');
  const canonicalSymbol = toBinanceFuturesSymbol(symbol);
  if (!policy.allowedSymbols.some((s) => toBinanceFuturesSymbol(s) === canonicalSymbol)) return b.skip('SYMBOL_NOT_ALLOWED：该交易对不在允许列表中');
  if (!policy.exchangeAccountId) return b.skip('NO_EXCHANGE_ACCOUNT_BOUND：未绑定 ExchangeAccount');
  const account = getExchangeAccount(policy.exchangeAccountId);
  if (!account) return b.skip('EXCHANGE_ACCOUNT_NOT_FOUND：绑定的 ExchangeAccount 不存在');
  const resolvedConn = resolvePreferredConnectionForAccount(policy.exchangeAccountId);
  if (!resolvedConn.ok) return b.skip(`CONNECTION_UNRESOLVABLE：${resolvedConn.reason}`);
  const connection = getExchangeConnection(resolvedConn.connectionId);
  if (!connection || connection.environment !== 'TESTNET') return b.skip('LIVE_AUTONOMOUS_BLOCK：解析到的连接不是 TESTNET，自主交易硬性阻止'); // Section 40

  if (policy.maxAutonomousStrategies != null) {
    const totalActiveAutonomous = listStrategyOrders().filter((o) => o.source === 'AUTONOMOUS' && ACTIVE_STRATEGY_STATUSES.includes(o.status)).length;
    if (totalActiveAutonomous >= policy.maxAutonomousStrategies) return b.skip('MAX_AUTONOMOUS_STRATEGIES_REACHED：已达到最大并发自主 Strategy 数量'); // Section 9 — global cap, independent of any one symbol's position, so it stays a pre-AI gate
  }

  const roleCfg = getRoleConfig('main-analysis');
  if (!roleCfg.connectionId || !roleCfg.model) return b.skip('AI_PROVIDER_NOT_CONFIGURED：main-analysis Model Role 未配置');
  const aiConnection = getAiConnection(roleCfg.connectionId);
  if (!aiConnection || !aiConnection.enabled) return b.skip('AI_PROVIDER_NOT_CONFIGURED：AI 连接不存在或已禁用');

  // ---- Automation Preflight (Sprint 3.8C.3, Section 5/6/7/8) — a deterministic, static config gap
  // (missing default position size/leverage) must never cost an AI call, UNLESS a real position
  // already exists (Section 6 — Position Management doesn't need these fields at all) or the policy
  // doesn't even intend to create a new entry this cycle (Section 7 — allowOpen=false means
  // analysis-only, no entry materialization ever attempted this cycle, WAIT or OPEN alike). Only
  // checked when a block is actually POSSIBLE (allowOpen=true AND something is missing) — a
  // fully-configured policy, or one that isn't trying to open new entries at all, never pays for this
  // extra read. ----
  const configMissing = policy.defaultPositionSizeUsdt == null || policy.defaultLeverage == null;
  if (policy.allowOpen && configMissing) {
    const preflightSnapshot = await withRetry(async () => {
      const snap = await fetchExchangeAccountSnapshot(resolvedConn.connectionId);
      if (!snap.ok) return { ok: false as const, error: snap.error.message };
      return { ok: true as const, value: snap.snapshot };
    });
    if (!preflightSnapshot.ok) {
      // Section 25 — a transient runtime read failure, NOT a static config block; a genuine ERROR
      // (real retried attempts were made and all failed), never CONFIGURATION_BLOCKED.
      return b.error(`ACCOUNT_SNAPSHOT_UNAVAILABLE：账户快照读取失败（已重试）：${preflightSnapshot.lastError}`);
    }
    const hasExistingPosition = preflightSnapshot.value!.positions.some((p) => toBinanceFuturesSymbol(p.symbol) === canonicalSymbol && p.quantity !== 0);
    const decision = decidePreflightBlock(policy, hasExistingPosition);
    if (decision.block) return b.configurationBlocked(decision.reasonCode);
    // else: a real position exists -> fall through to the unified analysis, which will correctly
    // route to Position Management (Section 6) regardless of missing entry-sizing config.
  }

  // ---- Unified Analysis Pipeline (Sprint 3.9, Section 4/5/9) — everything above this line is
  // guaranteed zero-token; from here on, the SAME `runAnalysis()` Manual calls does snapshot
  // acquisition (with retry, Section 7), payload/prompt build, exactly ONE AI call, and response
  // validation. `POSITION_ALREADY_EXISTS` is deliberately no longer a pre-AI skip (Sprint 3.7's old
  // behavior) — Section 14 wants a real position to be ANALYZED (Position Management), not skipped. ----
  // ---- Sprint 3.9.1.1, Section 19/23 — the SAME AnalysisRun engine Manual uses, so a Scheduled
  // cycle's real progress is visible on the Monitoring page (via `GET /api/analysis/runs/active`)
  // through the exact same mechanism as Manual reload-recovery, never a second progress model. The
  // scheduler still owns cycle lifecycle (this function); AnalysisRun only owns analysis-execution
  // progress within it (Section 19's own distinction). ----
  const analysisId = genAnalysisId();
  const requiredKeys = WEIGHT_DEFS.filter((w) => Number(AUTONOMOUS_SOURCE_WEIGHTS[w.key]) > 0).map((w) => w.key) as SourceKey[];
  createAnalysisRun({
    analysisId, source: 'SCHEDULED', symbol, sourceKeys: requiredKeys, sourceLabels: SOURCE_LABELS,
    hasAccountInScope: true, triggeredByCycleId: cycleId, // policy.exchangeAccountId already confirmed non-null by the Pre-AI Gate above
  });
  const reporter = createProgressReporter(analysisId);

  b.log('ANALYSIS_STARTED', `统一分析流水线, symbol=${symbol}`);
  const analysisResult = await runAnalysis({
    source: 'SCHEDULED', symbol, timeframe: AUTONOMOUS_TIMEFRAME, dateRange: AUTONOMOUS_DATE_RANGE,
    sourceWeights: AUTONOMOUS_SOURCE_WEIGHTS, additionalEvidence: [],
    exchangeAccountId: policy.exchangeAccountId, triggeredByCycleId: cycleId,
    analysisId, reporter,
  });
  b.cycle.analysisId = analysisResult.record.analysisId;

  if (!analysisResult.ok) {
    b.log('ANALYSIS_FAILED', analysisResult.record.failureReason || 'unknown');
    return b.error(analysisResult.record.failureReason || `${analysisResult.stage}：分析失败`); // Section 25/29 — a real failure, not a policy skip; no retry this tick, next scheduled cycle tries again
  }
  const record = analysisResult.record;
  const payload = record.payload!;
  const response = record.response!;
  b.log('ANALYSIS_COMPLETED', `analysisId=${record.analysisId}`);

  // ---- Position Management branch (Section 14/15/16/17) — record only, NEVER executed. ----
  if (payload.positionContext) {
    const pm = response.positionManagement; // guaranteed present+valid: runAnalysis requested it whenever positionContext is set
    b.log('POSITION_MANAGEMENT_DECISION', pm ? `action=${pm.action}` : 'missing (unexpected)');
    b.cycle.positionManagementAction = pm ? pm.action : null;
    b.cycle.strategyMaterializationStatus = 'NOT_APPLICABLE'; // Sprint 3.8C.3, Section 3 — a real position existed, so materialization was never attempted, by design
    return b.complete();
  }

  // ---- No position: possible new entry (Section 13). ACTIVE_STRATEGY_EXISTS moved here (was a
  // pre-AI gate through Sprint 3.7) — it only matters for creating a NEW order, and a real position
  // (handled above) would itself already show as an active StrategyOrder for most cases, which used
  // to wrongly block Position Management before it could ever run. ----
  const activeAutonomousForSymbol = listStrategyOrders().filter((o) => o.source === 'AUTONOMOUS' && toBinanceFuturesSymbol(o.symbol) === canonicalSymbol && ACTIVE_STRATEGY_STATUSES.includes(o.status));
  if (activeAutonomousForSymbol.length > 0) {
    b.log('ACTIVE_STRATEGY_EXISTS', '该交易对已存在活跃的自主 StrategyOrder，本轮分析结果不据以创建新订单'); // Section 9 — analysis itself still succeeded and is fully recorded via analysisId
    return b.complete();
  }

  const direction = response.decision.direction;
  const primary = response.scenarioPlans.find((p) => p.priority === 'PRIMARY')!;
  const decisionType: 'WAIT' | 'OPEN' = response.decision.action === 'ENTER' ? 'OPEN' : 'WAIT';

  // Sprint 3.8C.3, Section 7 — allowOpen=false means automation is analysis-only this cycle: it
  // never attempts to materialize a new entry, WAIT or OPEN alike (a WAIT-created order would still
  // eventually open a real position once triggered, so the exemption has to cover both). The AI's
  // real decision/ScenarioPlan is still fully analyzed and recorded via `analysisId` above — only
  // materialization is skipped.
  if (!policy.allowOpen) {
    b.log('MATERIALIZATION_SKIPPED', 'AUTOMATION_PERMISSION_DISABLED：allowOpen=false，本轮不创建新 StrategyOrder');
    b.cycle.strategyMaterializationStatus = 'NOT_CREATED';
    b.cycle.strategyMaterializationReasonCode = 'AUTOMATION_PERMISSION_DISABLED';
    return b.complete();
  }

  // Sprint 3.8C.3, Section 9 — ScenarioPlan -> StrategyOrder is now one explicit, non-throwing step.
  // BLOCKED_CONFIGURATION here should be rare (the preflight above already covers the common "no
  // position, size/leverage missing" case before any AI cost was spent) — this remains as an honest
  // fallback for `TRIGGER_NOT_MAPPABLE`, which can only be known after seeing the real AI decision.
  const materialized = materializeScenarioPlan({
    cycleId, analysisId: record.analysisId, symbol, direction, decisionType, primary,
    exchangeAccountId: policy.exchangeAccountId, defaultPositionSizeUsdt: policy.defaultPositionSizeUsdt, defaultLeverage: policy.defaultLeverage,
  });
  if (materialized.status === 'BLOCKED_CONFIGURATION') {
    b.log('STRATEGY_MATERIALIZATION_BLOCKED', materialized.reasonCode);
    b.cycle.strategyMaterializationStatus = 'BLOCKED_CONFIGURATION';
    b.cycle.strategyMaterializationReasonCode = materialized.reasonCode;
    return b.complete(); // NOT b.error() — analysis succeeded; Section 0's expected business state
  }

  const order = saveStrategyOrder(materialized.order);
  b.cycle.strategyMaterializationStatus = 'CREATED';
  appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: null, eventType: 'CREATED', previousStatus: null, newStatus: 'READY', reason: `source=AUTONOMOUS, cycleId=${cycleId}, analysisId=${record.analysisId}` });

  const directionAllowed = direction === 'LONG' ? policy.allowLong : policy.allowShort;
  if (!directionAllowed) {
    const blocked = blockAutonomousStrategy(order, `AUTONOMOUS 方向限制：不允许 ${direction}`);
    b.log('STRATEGY_BLOCKED', blocked.failureReason || '');
    b.cycle.strategyOrderId = blocked.strategyOrderId;
    return b.complete();
  }
  // Note: a `decisionType==='OPEN' && !policy.allowOpen` check is no longer needed here — the
  // `!policy.allowOpen` branch above already returned before materialization was ever attempted.

  const authorizedAt = new Date().toISOString();
  let armed = transitionStrategyOrder(order, 'ARMED', {
    authorization: { mode: 'AUTONOMOUS', authorizedAt, authorizedExecutionSnapshot: { trigger: order.trigger as Trigger, executionIntent: order.executionIntent, executionGuard: order.executionGuard, expiresAt: order.expiresAt } },
    monitoringState: { lastCheckedAt: null, nextCheckAt: null, lastObservedDataAt: null, health: 'RUNNING' },
  });
  appendAuditEvent({ strategyOrderId: armed.strategyOrderId, tradeId: null, eventType: 'AUTHORIZED', previousStatus: 'READY', newStatus: 'ARMED', reason: 'AUTONOMOUS：账户级权限自动授权' });

  if (decisionType === 'WAIT') {
    const capability = routeTriggerCapability(armed.trigger, armed.executionIntent, armed.expiresAt, direction);
    armed = saveStrategyOrder({ ...armed, capabilityDecision: capability.decision });
    b.log('WAIT_CREATED', `capability=${capability.decision}`);
    b.cycle.strategyOrderId = armed.strategyOrderId;
    // Sprint 3.7 — unlike the /authorize HTTP route (which fires-and-forgets to keep the HTTP
    // response fast), the scheduler has no request/response latency to protect: it AWAITS the
    // immediate submission so the cycle's own COMPLETED status honestly reflects "the full handoff,
    // including any immediate exchange-native submission attempt, has actually finished" rather than
    // "queued but still in flight". A submission failure here still never throws (attemptAutoSubmission
    // itself never throws — every branch ends in a status transition), so this can't fail the cycle.
    if (capability.decision === 'EXCHANGE_NATIVE') {
      await triggerImmediateExchangeNativeSubmission(armed).catch((err) => console.error('[autonomous] immediate exchange-native submission failed:', err?.message || err));
    }
    return b.complete();
  }

  // OPEN — immediate, no trigger to wait for (Section 14).
  b.log('OPEN_CREATED', 'AUTONOMOUS OPEN：立即进入执行链');
  b.cycle.strategyOrderId = armed.strategyOrderId;
  await triggerImmediateAutonomousSubmission(armed).catch((err) => console.error('[autonomous] immediate OPEN submission failed:', err?.message || err));
  return b.complete();
}

/** Section 33 — "Run Analysis Now": the exact same pipeline, `manual:true` so its `cycleId` can never
 * collide with (or be silently treated as) that slot's real scheduled cycle, still subject to every
 * single gate above (never a "force ignore schedule and just submit" shortcut). */
/** Section 5/6/27 — the periodic check. Runs frequently (every `SCHEDULER_TICK_MS`) but only actually
 * DOES anything (advances the schedule, calls AI) once every `analysisIntervalHours`; symbols within
 * one due slot run serially (Section 27 — "避免5 symbols同时请求AI导致rate limit/cost burst"). */
export async function runAutonomousSchedulerTick(): Promise<void> {
  const policy = getAutonomousPolicy();
  const state = getAutonomousSchedulerState();
  const now = new Date();

  if (!policy.autonomousEnabled) return; // idle — nextRunAt intentionally left untouched (Section 6: no immediate double-run once re-enabled)
  if (!state.nextRunAt) {
    // First-ever enable (or a fresh install) — initialize one interval out, never run immediately on enable.
    saveAutonomousSchedulerState({ nextRunAt: new Date(now.getTime() + policy.analysisIntervalHours * 3600_000).toISOString() });
    return;
  }
  if (new Date(state.nextRunAt).getTime() > now.getTime()) return; // not due yet

  const scheduledAt = state.nextRunAt;
  saveAutonomousSchedulerState({ lastRunAt: now.toISOString() });
  let anyFailure = false;
  let failureDetail: string | null = null;
  for (const symbol of policy.allowedSymbols) {
    try {
      const cycle = await runAutonomousCycleForSymbol(symbol, { scheduledAt, manual: false });
      if (cycle.status === 'ERROR') { anyFailure = true; failureDetail = `${symbol}: ${cycle.failureReason}`; }
    } catch (err: any) {
      anyFailure = true;
      failureDetail = `${symbol}: ${err?.message || err}`;
    }
  }

  // Section 30 — never schedule a next slot already in the past (avoids an immediate-retry storm
  // after a long outage); always at least now + one full interval from here.
  const naturalNext = new Date(new Date(scheduledAt).getTime() + policy.analysisIntervalHours * 3600_000);
  const safeNext = naturalNext.getTime() > now.getTime() ? naturalNext : new Date(now.getTime() + policy.analysisIntervalHours * 3600_000);
  saveAutonomousSchedulerState({
    nextRunAt: safeNext.toISOString(),
    lastSuccessfulRunAt: anyFailure ? state.lastSuccessfulRunAt : now.toISOString(),
    lastFailureReason: anyFailure ? failureDetail : null,
  });
}

const SCHEDULER_TICK_MS = 60_000;
let schedulerTimer: NodeJS.Timeout | null = null;
export function startAutonomousSchedulerLoop(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => { runAutonomousSchedulerTick().catch((err) => console.error('[autonomous scheduler] tick failed:', err?.message || err)); }, SCHEDULER_TICK_MS);
}
export function stopAutonomousSchedulerLoopForTesting(): void {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
}

export function listRecentAutonomousCycles(limit = 50): AutonomousCycle[] {
  return listAutonomousCycles().slice(0, limit);
}
