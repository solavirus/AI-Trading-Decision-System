/** Sprint — AnalysisRun Lifecycle Safety, Section 7/8/9/10 — closes the second half of the real
 * AMSXAPKWWA604 incident: even with `runAnalysis()`'s new top-level safety boundary (analysisEngine.ts)
 * guaranteeing every FUTURE run reaches a terminal state, a run that died BEFORE that boundary existed
 * (or one whose owning process no longer exists at all — a restart) is still sitting non-terminal in
 * `data/analysis_runs.json` right now. This file is the ONE place a persisted non-terminal
 * `AnalysisRun` gets reconciled against reality — "reality" meaning the in-memory Active Execution
 * Registry (`analysisEngine.ts#isExecutionActive`), never persisted state alone (Section 7's own
 * warning: "Persisted currentStage 本身不足以判断是否 active"). */
import { getAnalysisRun, setStage, listAllAnalysisRuns, requestCancel } from './analysisRunStore.js';
import type { AnalysisRun } from './analysisRunTypes.js';
import { TERMINAL_STAGES } from './analysisRunTypes.js';
import { isExecutionActive, requestAbortForActiveExecution } from './analysisEngine.js';
import { getAnalysisRecord, saveAnalysisRecord } from './analysisRecordStore.js';

/** Sprint — AnalysisRun Lifecycle Safety, Section 8 — derived from real, code-confirmed constants,
 * not a guessed round number:
 *  - Per-source worst case: `util/http.ts#DEFAULT_TIMEOUT_MS`=8000ms per fetch attempt,
 *    `retryPolicy.ts#RETRY_DELAYS_MS`=[3000,10000] across 3 attempts total
 *    → 3×8s (attempts) + 3s + 10s (inter-attempt waits) = 37s worst case for ONE source.
 *  - `snapshotAcquisition.ts#MAX_SOURCE_CONCURRENCY`=6, up to 11 sources → 2 concurrency waves
 *    → ≈74s worst case for ALL sources.
 *  - Account snapshot: same retry shape, assumed up to ~15s/attempt for a multi-call Binance
 *    sequence → 3×15s + 3s + 10s ≈ 58s worst case.
 *  - AI provider: `ai/engine.ts#DEFAULT_TIMEOUT_MS`=300_000ms (5 min) — the single largest term.
 *  - Payload/prompt building: near-instant (<1s); ignored.
 *  - Sum: 74s + 58s + 300s + ~10s buffer ≈ 442s (~7.4 min) worst-case legitimate lifecycle.
 * Doubled for a healthy safety margin against clock/scheduling jitter → 900_000ms (15 min). Must be
 * "明显高于合法最大 Analysis 生命周期" (Section 8) — 15 min is roughly 2x the ~7.4 min worst case. */
export const ANALYSIS_STALE_AFTER_MS = 900_000;

/** Section 4 — never let a raw exception's message flow verbatim into a persisted `failureReason` or
 * `error`; same discipline as `analysisEngine.ts#safeErrorMessage` (kept as a separate copy here to
 * avoid exporting an internal helper across module boundaries just for this one shared rule). */
function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 500);
  return String(err).slice(0, 500);
}

/** Section 9/10/12 — the ONE place a ghost `AnalysisRun` actually gets terminalized, shared by
 * runtime reconciliation, startup reconciliation, and the cancel route's dead-execution branch, so
 * the Run/Record consistency rule (Section 12) is enforced in exactly one place, not three. Never
 * deletes anything — only ever transitions status/failure fields, preserving every evidence field
 * (`payload`/`builtPrompt`/`aiRawResponseText`/`parsedResponseRaw`) already captured on the Record. */
function terminalizeGhostRun(analysisId: string, terminal: 'CANCELLED' | 'FAILED', reason: string): AnalysisRun | undefined {
  const updatedRun = setStage(analysisId, terminal, { error: reason, cancelled: terminal === 'CANCELLED' });

  try {
    const existing = getAnalysisRecord(analysisId);
    if (existing && existing.status !== 'COMPLETED' && existing.status !== 'CANCELLED' && existing.status !== 'FAILED') {
      saveAnalysisRecord({
        ...existing,
        status: terminal,
        failureStage: terminal === 'CANCELLED' ? 'CANCELLED' : 'UNEXPECTED',
        failureReason: reason,
        completedAt: existing.completedAt ?? new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error(`[analysisRunReconciliation] FAILED to align AnalysisRecord for ${analysisId} (evidence preserved, status may be inconsistent):`, safeErrorMessage(err));
  }

  return updatedRun;
}

/** Section 7/9 — runtime reconciliation: called before `findActiveRun(symbol)` on the
 * `POST /api/analysis/run` route (Section 9's recommended placement). Registry-aware and
 * threshold-gated — NEVER touches a run the registry says is genuinely live (Case J: "still fresh
 * enough" is actually irrelevant once the registry says live; a live run is never closed regardless
 * of age), and never closes a persisted non-terminal run before it's had a fair chance to actually be
 * `ANALYSIS_STALE_AFTER_MS` old (Case J: not yet stale → left alone). */
export function reconcileStaleAnalysisRuns(symbol?: string): AnalysisRun[] {
  const candidates = listAllAnalysisRuns(symbol).filter((r) => !TERMINAL_STAGES.includes(r.currentStage));
  const reconciled: AnalysisRun[] = [];
  for (const run of candidates) {
    if (isExecutionActive(run.analysisId)) continue; // genuinely live in THIS process — never touched by age alone
    const ageMs = Date.now() - new Date(run.updatedAt).getTime();
    if (ageMs < ANALYSIS_STALE_AFTER_MS) continue; // Case J — not stale yet, leave alone
    const terminal = run.cancelRequested ? 'CANCELLED' : 'FAILED';
    const reason = run.cancelRequested
      ? 'CANCELLED：分析在取消请求后长时间未结束（无存活执行，判定为已终止的僵尸 Run）'
      : `UNEXPECTED_ERROR: stale analysis run — no active execution found and stage unchanged for over ${Math.round(ANALYSIS_STALE_AFTER_MS / 60000)} minutes`;
    const updated = terminalizeGhostRun(run.analysisId, terminal, reason);
    if (updated) reconciled.push(updated);
  }
  return reconciled;
}

/** Section 10 — startup-only: called ONCE at backend boot, BEFORE the server accepts requests
 * (mirrors the existing `ensureAccountsBootstrapped()` placement precedent). Deliberately does NOT
 * reuse `reconcileStaleAnalysisRuns()`'s threshold gate — the in-memory registry is GUARANTEED empty
 * in a freshly-started process (no execution from a previous process can possibly have survived), so
 * EVERY persisted non-terminal run found here is unconditionally orphaned, regardless of age. Waiting
 * out `ANALYSIS_STALE_AFTER_MS` here would wrongly leave a run created seconds before a restart stuck
 * non-terminal for up to 15 more minutes for no reason — the process that owned it is simply gone. */
export function reconcileOrphanedRunsOnStartup(): { total: number; cancelled: number; failed: number } {
  const nonTerminal = listAllAnalysisRuns().filter((r) => !TERMINAL_STAGES.includes(r.currentStage));
  let cancelled = 0;
  let failed = 0;
  for (const run of nonTerminal) {
    const terminal = run.cancelRequested ? 'CANCELLED' : 'FAILED';
    const reason = run.cancelRequested
      ? 'CANCELLED：后端重启后发现该分析此前已请求取消但未完成，判定为已终止'
      : 'UNEXPECTED_ERROR: ORPHANED_AFTER_RESTART — backend restarted while this analysis was still in progress; the previous process no longer exists';
    terminalizeGhostRun(run.analysisId, terminal, reason);
    if (terminal === 'CANCELLED') cancelled++; else failed++;
  }
  return { total: nonTerminal.length, cancelled, failed };
}

/** Section 5 — the cancel route's real live-vs-dead branching, extracted here so both the route and
 * any future caller share ONE implementation. (A) Live: request abort on the registry's
 * AbortController and let the normal pipeline (`analysisEngine.ts`'s own CANCELLED `fail()` branch)
 * close it — this function does NOT itself terminalize a live run, since the pipeline's own race-safe
 * check (Section 18, pre-existing) is what actually owns that transition once the AI call unwinds.
 * (B) Dead: no live execution exists for this id in THIS process, so nothing will ever close it on its
 * own — terminalize immediately via the shared `terminalizeGhostRun` helper. */
export function cancelAnalysisRun(analysisId: string): { ok: true; run: AnalysisRun | undefined; live: boolean } | { ok: false; error: string } {
  const run = getAnalysisRun(analysisId);
  if (!run) return { ok: false, error: 'AnalysisRun 不存在' };
  if (TERMINAL_STAGES.includes(run.currentStage)) return { ok: true, run, live: false };

  const abortedLive = requestAbortForActiveExecution(analysisId);
  if (abortedLive) {
    // Section 5.A — persist the request so the pipeline's own post-await race check (Section 18)
    // sees it too, then let the live execution close itself out via the normal CANCELLED path.
    const updated = requestCancel(analysisId);
    return { ok: true, run: updated ?? run, live: true };
  }

  // Section 5.B — no live execution in this process: nothing will ever finish this run on its own.
  const terminalized = terminalizeGhostRun(analysisId, 'CANCELLED', 'CANCELLED：用户已取消分析（无存活执行，立即终结）');
  return { ok: true, run: terminalized, live: false };
}
