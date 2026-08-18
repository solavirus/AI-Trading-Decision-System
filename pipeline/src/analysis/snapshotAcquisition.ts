/** Sprint 3.9, Section 6/7/8/9 — Unified Snapshot Acquisition: the ONE place both Manual and
 * Scheduled gather (a) the full 11-source market data set (the same `FETCHERS` registry the manual
 * pipeline already used via `/api/sources/:key`) and (b) a REAL Account + Position snapshot (which
 * the pre-3.9 manual pipeline never gathered at all — see the Manual Pipeline trace, point 3: "No
 * account/position field exists"). Every required snapshot goes through the shared retry policy
 * (Section 7) — no `setTimeout` scattered elsewhere, no first-failure-skips-forever (the confirmed
 * root cause of the real `ACCOUNT_SNAPSHOT_UNAVAILABLE` skip, Section 21).
 *
 * Sprint 3.9.1.1, Section 5/7/8/18 — every source/account attempt now reports real progress through
 * an `AnalysisProgressReporter` (optional — omitting it reproduces the exact pre-3.9.1.1 behavior).
 *
 * Sprint 3.8E.2 — Parallel Data Source Collection. The market-source loop below used to be a strict
 * `for` loop (one source fully retried before the next even started). A real dependency audit (this
 * sprint's own report) confirmed ZERO of the 11 registered sources import, call, or otherwise
 * consume another's output — `technical.ts` fetches and computes its own klines independently of
 * `market.ts`, contrary to the naive assumption that it might. All required sources therefore form
 * a single dependency tier and are now launched concurrently (bounded by `MAX_SOURCE_CONCURRENCY`,
 * see below) via `runWithConcurrencyLimit`. Cancellation now also aborts a source's own in-progress
 * RETRY WAIT, not just the gap between sources (Section 12) — see `retryPolicy.ts`'s additive
 * `isCancelled` option. Account Snapshot is untouched: still sequential, still after all sources,
 * per this sprint's own Section 6 ("暂时保持现有语义"). */
import type { SourceKey, SourceResult } from '../types.js';
import { FETCHERS } from '../fetchers.js';
import { withRetry } from './retryPolicy.js';
import { runWithConcurrencyLimit } from './concurrencyLimiter.js';
import type { AnalysisPositionContext } from './types.js';
import type { AnalysisProgressReporter } from './analysisRunStore.js';
import { getExchangeAccount, resolvePreferredConnectionForAccount } from '../exchange/exchangeAccountStore.js';
import { fetchExchangeAccountSnapshot } from '../exchange/exchangeService.js';
import { toBinanceFuturesSymbol } from '../exchange/binanceFuturesAdapter.js';
import type { ExchangePositionSnapshot } from '../exchange/types.js';

/** Sprint 3.8E.2, Section 5 — a single global cap, not a per-provider-group scheduler. The real
 * audit found overlapping upstream hosts are diffuse: at most 2 of the 11 sources hit the same host
 * as their PRIMARY provider (`api.binance.com`: `market` + `technical`), one 2-way overlap on a
 * secondary provider (`xoomar.com`: `macro` + `etf`), and a 3-way overlap (`www.okx.com`: `market`/
 * `technical`/`derivatives`) that only fires as a conditional FALLBACK when Binance itself is
 * already failing — never a steady-state load. No provider in this project ever receives anywhere
 * close to an 11-way simultaneous hit. A global cap of 6 — a common, familiar reference point (it
 * matches typical browser per-host connection limits) — keeps the worst REALISTIC concurrent hit on
 * any single host (2-3, per the audit above) comfortably under it, while still collapsing the worst
 * case from 11 sequential round-trips down to two waves of ≤6. A full per-provider-group scheduler
 * would add real complexity this sprint's own audit found no evidence of actually needing. */
export const MAX_SOURCE_CONCURRENCY = 6;

export interface SnapshotAcquisitionInput {
  symbol: string;
  requiredSourceKeys: SourceKey[];
  /** `null` = no account context requested at all (caller has no bound account) — position context
   * is then always `null`, never an error; Section 6 only requires REAL data when an account IS in
   * scope, it doesn't invent a requirement to always have one. */
  exchangeAccountId: string | null;
  reporter?: AnalysisProgressReporter;
}

export type SnapshotAcquisitionResult =
  | {
      ok: true;
      sourceResults: Partial<Record<SourceKey, SourceResult>>;
      positionContext: AnalysisPositionContext | null;
      exchangeConnectionId: string | null;
      snapshotStartedAt: string;
      snapshotCompletedAt: string;
    }
  | {
      ok: false;
      failureStage: 'SOURCES' | 'ACCOUNT' | 'CANCELLED';
      failureReason: string;
      snapshotStartedAt: string;
      snapshotCompletedAt: string;
    };

function positionToContext(pos: ExchangePositionSnapshot, fetchedAt: string): AnalysisPositionContext {
  const hasSL = pos.protection.stopLossOrders.length > 0;
  const hasTP = pos.protection.takeProfitOrders.length > 0;
  const protectionStatus: AnalysisPositionContext['protectionStatus'] =
    hasSL && hasTP ? 'PROTECTED' : hasSL || hasTP ? 'PARTIALLY_PROTECTED' : 'UNPROTECTED';
  return {
    symbol: pos.symbol, side: pos.side, quantity: pos.quantity, entryPrice: pos.entryPrice, markPrice: pos.markPrice,
    leverage: pos.leverage, unrealizedPnl: pos.unrealizedPnl,
    currentStopLoss: pos.protection.stopLossOrders[0]?.triggerPrice ?? null,
    currentTakeProfit: pos.protection.takeProfitOrders.map((o) => o.triggerPrice).filter((v): v is number => v != null),
    protectionStatus, relatedStrategyOrderId: null, fetchedAt,
  };
}

/** Section 7 — one required source fetch attempt. A thrown exception (network-level) is a retryable
 * failure; a resolved `SourceResult` with `status:'error'` is ALSO retryable (Section 7 draws no
 * distinction between "the fetch rejected" and "the fetch resolved but reports it couldn't get real
 * data"); `status:'stub'`/`'ok'` are both acceptable (a stub is real, valid, just data-limited — same
 * as the pre-3.9 manual pipeline's own `partialSources` handling).
 *
 * Sprint 3.8E.2, Section 4/12 — `isCancelled`, when provided, is threaded straight into `withRetry`
 * so a cancel mid-retry-wait stops THIS source's own retry sequence promptly (not just the gap
 * between sources). Per-source retry stays fully independent either way — nothing here changes
 * about the 3s/10s/fail policy itself, only who else may be running concurrently while it waits. */
async function fetchOneSourceWithRetry(key: SourceKey, reporter?: AnalysisProgressReporter, isCancelled?: () => boolean): Promise<{ ok: true; value: SourceResult } | { ok: false; error: string; cancelled?: boolean }> {
  let lastErrorSeen = '';
  const result = await withRetry<SourceResult>(
    async () => {
      try {
        const r = await FETCHERS[key]();
        if (r.status === 'error') { lastErrorSeen = r.note || `${key} 数据源返回 error 状态`; return { ok: false, error: lastErrorSeen }; }
        return { ok: true, value: r };
      } catch (err: any) {
        lastErrorSeen = err?.message || String(err);
        return { ok: false, error: lastErrorSeen };
      }
    },
    { onAttempt: (attempt, total) => { if (attempt === 1) reporter?.sourceStarted(key, attempt, total); else reporter?.sourceRetrying(key, attempt, total, lastErrorSeen); }, isCancelled },
  );
  if (result.cancelled) return { ok: false, error: '用户已取消分析', cancelled: true }; // per-source status is left at whatever it last really was (RUNNING/RETRYING/PENDING) — never fabricated as a fake terminal state
  if (result.ok) { reporter?.sourceCompleted(key); return { ok: true, value: result.value as SourceResult }; }
  reporter?.sourceFailed(key, `已重试 ${result.attempts} 次：${result.lastError}`);
  return { ok: false, error: `${key}：${result.lastError}（已重试 ${result.attempts} 次）` };
}

/** Section 7/21 — the real fix for the 21:21 incident: an account-snapshot read failure now retries
 * (3s, then 10s) before giving up, instead of skipping the entire cycle on the very first failure. */
async function fetchAccountSnapshotWithRetry(connectionId: string, reporter?: AnalysisProgressReporter) {
  let lastErrorSeen = '';
  const result = await withRetry(
    async () => {
      const snap = await fetchExchangeAccountSnapshot(connectionId);
      if (!snap.ok) { lastErrorSeen = snap.error.message || '账户快照读取失败'; return { ok: false as const, error: lastErrorSeen }; }
      return { ok: true as const, value: snap.snapshot };
    },
    { onAttempt: (attempt, total) => { if (attempt === 1) reporter?.accountStarted(attempt, total); else reporter?.accountRetrying(attempt, total, lastErrorSeen); } },
  );
  if (result.ok) reporter?.accountCompleted(); else reporter?.accountFailed(`已重试 ${result.attempts} 次：${result.lastError}`);
  return result;
}

export async function acquireUnifiedSnapshot(input: SnapshotAcquisitionInput): Promise<SnapshotAcquisitionResult> {
  const snapshotStartedAt = new Date().toISOString();
  input.reporter?.setStage('COLLECTING_SOURCES');

  // ---- Market data: every required (weight > 0) source, each independently retried, now launched
  // concurrently (Section 2/5) instead of one-at-a-time. `stopLaunching` — Section 9/12 — flips true
  // the instant a real failure OR a cancellation is observed anywhere; sources ALREADY in flight at
  // that moment are left to finish naturally (never artificially cut short just because a sibling
  // failed), but no NEW source is ever launched afterward — the existing "any required failure blocks
  // the whole analysis" business rule (owned by analysisEngine.ts, untouched here) makes launching
  // more sources at that point pure waste, not a business decision this scheduling layer is making. ----
  type SourceOutcome = { ok: true; value: SourceResult } | { ok: false; error: string; cancelled?: boolean };
  let stopLaunching = false;
  const outcomes = await runWithConcurrencyLimit<SourceKey, SourceOutcome>(
    input.requiredSourceKeys, MAX_SOURCE_CONCURRENCY,
    async (key) => {
      if (stopLaunching) return { ok: false, error: '未启动（已停止调度新的数据源）', cancelled: true };
      if (input.reporter?.isCancelRequested()) { stopLaunching = true; return { ok: false, error: '用户已取消分析', cancelled: true }; }
      const outcome = await fetchOneSourceWithRetry(key, input.reporter, () => input.reporter?.isCancelRequested() ?? false);
      if (!outcome.ok) stopLaunching = true;
      return outcome;
    },
  );

  // Section 18/12 — real user cancellation always takes priority over reporting a (possibly stale,
  // possibly coincidental) source failure, matching the exact precedent already established for the
  // pre-parallel serial loop.
  if (input.reporter?.isCancelRequested()) {
    return { ok: false, failureStage: 'CANCELLED', failureReason: '用户已取消分析', snapshotStartedAt, snapshotCompletedAt: new Date().toISOString() };
  }
  // Section 11 — determinism: if more than one source failed, ALWAYS report the same one regardless
  // of which network response happened to arrive/fail first — the first failure in fixed registry
  // order (input.requiredSourceKeys, itself sourced from WEIGHT_DEFS), never completion order.
  const firstFailureIndex = outcomes.findIndex((o) => !o.ok && !o.cancelled);
  if (firstFailureIndex !== -1) {
    const failure = outcomes[firstFailureIndex] as { ok: false; error: string };
    return { ok: false, failureStage: 'SOURCES', failureReason: failure.error, snapshotStartedAt, snapshotCompletedAt: new Date().toISOString() };
  }

  // Section 11 — assembled in fixed registry order, never completion order: sourceResults' own key
  // insertion order (and therefore payloadBuilder.ts's later Object.entries() iteration order) is
  // deterministic regardless of which source's network request actually finished first.
  const sourceResults: Partial<Record<SourceKey, SourceResult>> = {};
  input.requiredSourceKeys.forEach((key, i) => {
    const outcome = outcomes[i];
    if (outcome.ok) sourceResults[key] = outcome.value;
  });

  if (input.reporter?.isCancelRequested()) {
    return { ok: false, failureStage: 'CANCELLED', failureReason: '用户已取消分析', snapshotStartedAt, snapshotCompletedAt: new Date().toISOString() };
  }

  // ---- Account + Position: Section 6 — a real backend Account Snapshot, not price+balance-only. ----
  let positionContext: AnalysisPositionContext | null = null;
  let exchangeConnectionId: string | null = null;
  if (input.exchangeAccountId) {
    input.reporter?.setStage('SYNCING_ACCOUNT');
    const account = getExchangeAccount(input.exchangeAccountId);
    if (!account) {
      return { ok: false, failureStage: 'ACCOUNT', failureReason: '绑定的 ExchangeAccount 不存在', snapshotStartedAt, snapshotCompletedAt: new Date().toISOString() };
    }
    const resolved = resolvePreferredConnectionForAccount(input.exchangeAccountId);
    if (!resolved.ok) {
      return { ok: false, failureStage: 'ACCOUNT', failureReason: resolved.reason, snapshotStartedAt, snapshotCompletedAt: new Date().toISOString() };
    }
    exchangeConnectionId = resolved.connectionId;
    const snapResult = await fetchAccountSnapshotWithRetry(resolved.connectionId, input.reporter);
    if (!snapResult.ok) {
      return { ok: false, failureStage: 'ACCOUNT', failureReason: `账户快照读取失败：${snapResult.lastError}（已重试 ${snapResult.attempts} 次）`, snapshotStartedAt, snapshotCompletedAt: new Date().toISOString() };
    }
    const snapshot = snapResult.value!;
    const canonicalSymbol = toBinanceFuturesSymbol(input.symbol);
    const pos = snapshot.positions.find((p) => toBinanceFuturesSymbol(p.symbol) === canonicalSymbol && p.quantity !== 0);
    positionContext = pos ? positionToContext(pos, snapshot.fetchedAt) : null;
  }

  return {
    ok: true, sourceResults, positionContext, exchangeConnectionId,
    snapshotStartedAt, snapshotCompletedAt: new Date().toISOString(),
  };
}
