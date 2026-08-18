/** Sprint 3.9, Section 5 — the ONE unified Analysis Service/Engine entry point. Manual and Scheduled
 * both call `runAnalysis()` — this file is the single place "start an analysis" means anything, from
 * either trigger. Order: Snapshot Acquisition (retried, Section 7) -> AnalysisPayload -> PromptRecord
 * -> AI call (reusing the EXISTING `ai/engine.ts#runAIAnalysis`, never a second AI-calling path) ->
 * Response validation -> persist ONE AnalysisRecord. Section 24: exactly one AI generation per call —
 * this function never calls `runAIAnalysis` more than once.
 *
 * Sprint 3.9.1.1, Section 4/21 — `analysisId` is now ALWAYS supplied by the caller (generated once,
 * before this function is even entered, by whoever created the backend-owned `AnalysisRun` — see
 * `analysisRunStore.ts`), instead of being minted partway through by `buildAnalysisPayload()`. An
 * optional `AnalysisProgressReporter` drives that same `AnalysisRun`'s stage transitions in real time
 * as this function progresses; omitting it (existing direct test callers) reproduces the exact
 * pre-3.9.1.1 behavior with zero progress side effects.
 *
 * Sprint 3.8E.1 — Analysis Observability Recovery. `record` is now built up INCREMENTALLY and
 * re-persisted (`saveAnalysisRecord`, an upsert keyed by `analysisId`) at every real checkpoint that
 * produces new evidence (payload built, prompt built, AI raw response received), instead of only
 * ever being saved once at the very end. This is the actual fix for "a VALIDATION_FAILED run loses
 * everything that happened before validation" — the built Prompt and the AI's raw response are now
 * saved BEFORE `parseAiResponse()` is ever called, so a validator throw/reject can never take them
 * down with it (Section 5's explicit ordering requirement). Nothing about WHEN/WHY an analysis
 * succeeds or fails changes — every existing branch keeps its exact original condition and
 * `failureReason` text; this only adds `failureStage`/`builtPrompt`/`aiRawResponseText`/
 * `parsedResponseRaw` alongside what was already being saved. */
import type { SourceKey } from '../types.js';
import { WEIGHT_DEFS } from './weightDefs.js';
import { acquireUnifiedSnapshot } from './snapshotAcquisition.js';
import { buildAnalysisPayload } from './payloadBuilder.js';
import { buildPromptRecord } from './promptBuilder.js';
import { parseAiResponse } from './responseValidator.js';
import { saveAnalysisRecord, getAnalysisRecord } from './analysisRecordStore.js';
import type { AnalysisEvidenceInput, AnalysisFailureStage, AnalysisRecord, AnalysisSource } from './types.js';
import { runAIAnalysis } from '../ai/engine.js';
import { getRoleConfig } from '../ai/configStore.js';
import { getConnection as getAiConnection } from '../ai/connectionStore.js';
import type { AnalysisProgressReporter } from './analysisRunStore.js';

/** Sprint — AnalysisRun Lifecycle Safety, Section 6 — the in-memory Active Execution Registry.
 * Backend-process-local liveness tracking ONLY — never persisted, never business data (Section 6's
 * own instruction). Exists purely to answer two questions no persisted `AnalysisRun` field alone
 * can: (a) "is there truly still a live promise chain running for this analysisId, right now, in
 * THIS process" (used by cancel finalization and stale-run reconciliation — `analysisRunReconciliation.ts`
 * — to tell a genuinely-running analysis apart from a persisted ghost), and (b) "if there IS one,
 * how do we actually interrupt it, immediately, rather than waiting for the next 1s cooperative
 * poll." Registered at the very start of `runAnalysis()`, unregistered in a `finally` — guaranteed
 * cleanup regardless of COMPLETED/FAILED/CANCELLED/UNEXPECTED (Section 6's own "must use finally"). */
interface ActiveExecution { startedAt: number; abortController: AbortController }
const activeAnalysisExecutions = new Map<string, ActiveExecution>();

export function isExecutionActive(analysisId: string): boolean {
  return activeAnalysisExecutions.has(analysisId);
}
/** Section 5.A — requests abort on a genuinely LIVE execution's registry-level AbortController,
 * threaded (see `runAnalysisPipeline` below) into the SAME AI-stage `cancelController` a timeout
 * would already abort — one real cancellation mechanism, now with an immediate external trigger in
 * addition to the existing 1s cooperative poll, not a second competing one. Returns `false` when no
 * live execution exists for this id — the caller (the cancel route) then knows to fall back to
 * Section 5.B's dead-execution path instead. */
export function requestAbortForActiveExecution(analysisId: string): boolean {
  const exec = activeAnalysisExecutions.get(analysisId);
  if (!exec) return false;
  exec.abortController.abort();
  return true;
}

/** Section 4 — never let a raw exception's message (which could, in principle, echo file paths,
 * connection strings, or other internal detail) flow verbatim into a persisted `failureReason`.
 * Keeps only the error's name + message, length-capped — the same "short, safe, already-a-string"
 * discipline `PersistenceError` itself already follows (see `util/safeJsonStore.ts`). Never includes
 * `err.stack`, headers, or any request/response body. */
function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 500);
  return String(err).slice(0, 500);
}

function minimalUnexpectedFailureRecord(input: RunAnalysisInput, failureReason: string): AnalysisRecord {
  const now = new Date().toISOString();
  return {
    analysisId: input.analysisId, source: input.source, symbol: input.symbol,
    createdAt: now, completedAt: now, status: 'FAILED',
    payload: null, promptVersion: null, aiRawResult: null, response: null,
    failureReason, failureStage: 'UNEXPECTED', builtPrompt: null, aiRawResponseText: null, parsedResponseRaw: null,
    triggeredByCycleId: input.triggeredByCycleId ?? null, exchangeAccountId: input.exchangeAccountId,
    snapshotStartedAt: now, snapshotCompletedAt: null,
  };
}

/** Section 2/3 — the ONE true catch-all. Reached only when `runAnalysisPipeline()` throws something
 * NOT already caught by one of its own explicit `fail()` branches (Section 2's own list: an
 * exception from `buildAnalysisPayload`, `saveAnalysisRecord`, `reporter.setStage`,
 * `buildPromptRecord`, AI stage setup, the parser/validator, or any other genuinely unanticipated
 * error). Never re-throws — always resolves to a real terminal `RunAnalysisResult`, per Section 3's
 * "任何没有被已有显式failure branch捕获的异常都必须进入terminal state". `failureStage:'UNEXPECTED'`
 * is used specifically so this is never misattributed as `AI_PROVIDER_FAILED` (Section 3's explicit
 * warning — this exact class of bug killed a real run, AMSXAPKWWA604, before the AI stage ever
 * started). */
async function handleUnexpectedFailure(input: RunAnalysisInput, err: unknown): Promise<RunAnalysisResult> {
  const failureReason = 'UNEXPECTED_ERROR：' + safeErrorMessage(err);
  console.error(`[runAnalysis] UNEXPECTED exception for analysisId=${input.analysisId}:`, err);

  try {
    input.reporter?.setStage('FAILED', { error: failureReason });
  } catch (reporterErr) {
    // Section 13 — even the terminal-state WRITE can itself fail (e.g. the store is genuinely
    // unwritable). Never silently swallowed; disk truth may honestly be unable to reflect this run's
    // real outcome in that case — logged loudly rather than pretended away.
    console.error(`[runAnalysis] FAILED to persist terminal AnalysisRun state for ${input.analysisId} (store may be unwritable):`, reporterErr);
  }

  let record: AnalysisRecord;
  try {
    const existing = getAnalysisRecord(input.analysisId);
    if (existing && (existing.status === 'COMPLETED' || existing.status === 'CANCELLED')) {
      record = existing; // an already-real terminal record — never overwritten by this catch-all
    } else if (existing) {
      // Section 12 — preserve every field already captured (payload/builtPrompt/aiRawResponseText/
      // parsedResponseRaw survive exactly as `AnalysisRecord`'s own incremental-save design intends);
      // only the terminal status/failure fields are added.
      record = { ...existing, status: 'FAILED', failureStage: 'UNEXPECTED', failureReason, completedAt: existing.completedAt ?? new Date().toISOString() };
      saveAnalysisRecord(record);
    } else {
      // Section 3 — the exception hit before the very first saveAnalysisRecord() call ever ran; still
      // guarantee a valid, honest, minimal terminal record rather than leaving none at all.
      record = minimalUnexpectedFailureRecord(input, failureReason);
      saveAnalysisRecord(record);
    }
  } catch (recordErr) {
    console.error(`[runAnalysis] FAILED to persist terminal AnalysisRecord state for ${input.analysisId}:`, recordErr);
    record = minimalUnexpectedFailureRecord(input, failureReason); // best available in-memory approximation — Section 13's honest disclosure: disk truth is not guaranteed here
  }
  return { ok: false, record, stage: 'UNEXPECTED' };
}

export interface RunAnalysisInput {
  source: AnalysisSource;
  symbol: string;
  timeframe: string;
  dateRange: string;
  sourceWeights: Record<string, number>;
  additionalEvidence: AnalysisEvidenceInput[];
  /** Section 6/19 — when set, the engine fetches a REAL account+position snapshot and includes it
   * for BOTH Manual and Scheduled (same builder, same prompt, per Section 0). `null` is valid (no
   * bound account yet) — analysis still runs, just with no position context. */
  exchangeAccountId: string | null;
  /** Section 13/14 — Scheduled-only; links the resulting AnalysisRecord back to its AutonomousCycle. */
  triggeredByCycleId?: string | null;
  /** Sprint 3.9.1.1, Section 4/21 — the id of the AnalysisRun this call reports progress against; the
   * resulting AnalysisRecord always uses this SAME id as its own `analysisId` (the join key between
   * the two, per Section 21). */
  analysisId: string;
  reporter?: AnalysisProgressReporter;
}

export type RunAnalysisResult =
  | { ok: true; record: AnalysisRecord }
  | { ok: false; record: AnalysisRecord; stage: 'SNAPSHOT_FAILED' | 'AI_FAILED' | 'VALIDATION_FAILED' | 'CONFIG_FAILED' | 'CANCELLED' | 'UNEXPECTED' };

function requiredSourceKeys(sourceWeights: Record<string, number>): SourceKey[] {
  return WEIGHT_DEFS.filter((w) => Number(sourceWeights[w.key]) > 0).map((w) => w.key);
}

/** Sprint 3.8E.1, Section 10 — the ONE place PARSE vs SCHEMA_VALIDATION is decided, from the SAME
 * `ParserError.code` values `responseValidator.ts` already produces (never a second error taxonomy).
 * `invalid_json`/`empty_response` mean the raw text never became a usable JSON object at all;
 * `raw_request_failed` can't actually occur here (this function only ever calls `parseAiResponse`
 * after already confirming `rawResult.status==='success'`) but is included for exhaustiveness against
 * `responseValidator.ts`'s real code list, not fabricated for this sprint. Everything else means the
 * JSON parsed fine and failed a real content rule. */
const PARSE_ERROR_CODES = new Set(['invalid_json', 'empty_response', 'raw_request_failed']);
function failureStageForParserErrorCode(code: string): 'PARSE' | 'SCHEMA_VALIDATION' {
  return PARSE_ERROR_CODES.has(code) ? 'PARSE' : 'SCHEMA_VALIDATION';
}

/** Sprint — AnalysisRun Lifecycle Safety, Section 2/6 — the ORIGINAL `runAnalysis()` body, unchanged
 * in its own internal branch logic (every `fail()` call and its exact `failureStage`/`failureReason`
 * text is identical to before this sprint), renamed and given one new parameter: `executionSignal`,
 * the registry's per-execution AbortSignal (see `runAnalysis` below). Threaded into the EXISTING
 * AI-stage `cancelController` alongside the existing 1s cooperative poll — see the `addEventListener`
 * call just before the AI request — so a registry-driven abort (from the cancel route's live-execution
 * branch, Section 5.A) takes effect immediately rather than waiting up to 1s. */
async function runAnalysisPipeline(input: RunAnalysisInput, executionSignal: AbortSignal): Promise<RunAnalysisResult> {
  const snapshotStartedAt = new Date().toISOString();
  const analysisId = input.analysisId;
  const reporter = input.reporter;
  let record: AnalysisRecord = {
    analysisId, source: input.source, symbol: input.symbol, createdAt: snapshotStartedAt, completedAt: null,
    status: 'COLLECTING', payload: null, promptVersion: null, aiRawResult: null, response: null,
    failureReason: null, failureStage: null, builtPrompt: null, aiRawResponseText: null, parsedResponseRaw: null,
    triggeredByCycleId: input.triggeredByCycleId ?? null,
    exchangeAccountId: input.exchangeAccountId, snapshotStartedAt, snapshotCompletedAt: null,
  };

  function fail(patch: Partial<AnalysisRecord> & { failureStage: AnalysisFailureStage }): AnalysisRecord {
    record = { ...record, ...patch, completedAt: patch.completedAt ?? new Date().toISOString() };
    saveAnalysisRecord(record);
    if (record.status === 'CANCELLED') reporter?.setStage('CANCELLED', { error: record.failureReason, cancelled: true });
    else reporter?.setStage('FAILED', { error: record.failureReason });
    return record;
  }

  // ---- Section 25 — a role/connection config problem is caught BEFORE any snapshot work, same as
  // both pre-3.9 pipelines already did (manual resolves the role client-side before collecting;
  // autonomousScheduler checks AI_PROVIDER_NOT_CONFIGURED before its snapshot work too). ----
  const roleCfg = getRoleConfig('main-analysis');
  if (!roleCfg.connectionId || !roleCfg.model) {
    fail({ status: 'AI_FAILED', failureStage: 'CONFIG', failureReason: 'AI_PROVIDER_NOT_CONFIGURED：main-analysis Model Role 未配置' });
    return { ok: false, record, stage: 'CONFIG_FAILED' };
  }
  const aiConnection = getAiConnection(roleCfg.connectionId);
  if (!aiConnection || !aiConnection.enabled) {
    fail({ status: 'AI_FAILED', failureStage: 'CONFIG', failureReason: 'AI_PROVIDER_NOT_CONFIGURED：AI 连接不存在或已禁用' });
    return { ok: false, record, stage: 'CONFIG_FAILED' };
  }

  // ---- Section 6/7/8/9 — Unified Snapshot Acquisition, retried, no partial analysis. ----
  const snapshot = await acquireUnifiedSnapshot({
    symbol: input.symbol, requiredSourceKeys: requiredSourceKeys(input.sourceWeights),
    exchangeAccountId: input.exchangeAccountId, reporter,
  });
  if (!snapshot.ok) {
    if (snapshot.failureStage === 'CANCELLED') {
      fail({ status: 'CANCELLED', failureStage: 'CANCELLED', snapshotCompletedAt: snapshot.snapshotCompletedAt, failureReason: 'CANCELLED：用户已取消分析' });
      return { ok: false, record, stage: 'CANCELLED' };
    }
    // Section 14 — a real snapshot/account failure now records a structured failureStage (SOURCES vs
    // ACCOUNT_SNAPSHOT) alongside the existing free-text failureReason; the underlying retry
    // policy/business logic in snapshotAcquisition.ts is untouched.
    fail({
      status: 'SNAPSHOT_FAILED', failureStage: snapshot.failureStage === 'ACCOUNT' ? 'ACCOUNT_SNAPSHOT' : 'SOURCES',
      snapshotCompletedAt: snapshot.snapshotCompletedAt, failureReason: `SNAPSHOT_FAILED（${snapshot.failureStage}）：${snapshot.failureReason}`,
    });
    return { ok: false, record, stage: 'SNAPSHOT_FAILED' };
  }

  // ---- Section 3 — AnalysisPayload, the SAME builder for both sources. ----
  reporter?.setStage('BUILDING_PAYLOAD');
  const payload = buildAnalysisPayload({
    analysisId, symbol: input.symbol, timeframe: input.timeframe, dateRange: input.dateRange,
    sourceWeights: input.sourceWeights, additionalEvidence: input.additionalEvidence,
    sourceResults: snapshot.sourceResults, positionContext: snapshot.positionContext,
  });
  // Sprint 3.8E.1, Section 5/7 — Input Data persisted the moment it's real, well before the AI is
  // ever involved: if anything downstream fails unexpectedly, what was actually analyzed is never in
  // doubt.
  record = { ...record, payload, snapshotCompletedAt: snapshot.snapshotCompletedAt };
  saveAnalysisRecord(record);

  // ---- Section 4 — the SAME Prompt Builder for both sources (additive Position Management section
  // only appears when payload.positionContext is non-null). ----
  reporter?.setStage('BUILDING_PROMPT');
  const promptRecord = buildPromptRecord(payload);
  // Sprint 3.8E.1, Section 5/8 — the real, final Prompt text persisted BEFORE the AI call even
  // starts, so it survives regardless of what the AI provider does next.
  record = { ...record, promptVersion: promptRecord.promptVersion, builtPrompt: promptRecord.promptText };
  saveAnalysisRecord(record);

  // ---- Sprint 3.9.1.1, Section 17/18 — Manual-only real cancel: while the AI call is in flight,
  // poll `reporter.isCancelRequested()` and abort the SAME controller a timeout would abort. Never
  // built for Scheduled (its reporter's cancelRequested can never become true — no route sets it),
  // so this is inert overhead there, not a behavior difference. ----
  reporter?.setStage('AI_ANALYSIS');
  reporter?.aiStarted(aiConnection.type, roleCfg.model);
  const cancelController = new AbortController();
  const cancelPollTimer = reporter && input.source === 'MANUAL'
    ? setInterval(() => { if (reporter.isCancelRequested()) cancelController.abort(); }, 1000)
    : null;
  // Sprint — AnalysisRun Lifecycle Safety, Section 5.A — an external abort request (registry-driven,
  // e.g. from the cancel route finding a genuinely LIVE execution) takes effect immediately, the same
  // way a timeout already would, instead of waiting for the next 1s poll to notice `cancelRequested`.
  const onExternalAbort = () => cancelController.abort();
  executionSignal.addEventListener('abort', onExternalAbort);
  let rawResult;
  try {
    rawResult = await runAIAnalysis({
      analysisId: payload.analysisId, promptVersion: promptRecord.promptVersion, payloadVersion: payload.payloadVersion,
      provider: aiConnection.type, model: roleCfg.model, promptText: promptRecord.promptText, connectionId: roleCfg.connectionId,
      externalAbortSignal: cancelController.signal,
    });
  } finally {
    if (cancelPollTimer) clearInterval(cancelPollTimer);
    executionSignal.removeEventListener('abort', onExternalAbort);
  }

  // Sprint 3.8E.1, Section 5/9 — the AI's raw text output persisted IMMEDIATELY, BEFORE
  // `parseAiResponse()` is ever called below — this is the actual fix: a Parser/Validator
  // throw/reject can no longer take the raw response down with it, because it's already durable by
  // the time parsing even starts. Empty string on a real provider failure (rawResult.rawText is '')
  // is honest — it means no content was ever produced, not that it was lost.
  record = { ...record, aiRawResponseText: rawResult.rawText ?? '' };
  saveAnalysisRecord(record);

  // Section 18's race: check AFTER the call resolves, regardless of what it returned — a cancel
  // requested while the AI call was in flight always wins, even if the provider's response happened
  // to arrive at the same moment. Exactly one terminal state ever results: CANCELLED.
  if (input.source === 'MANUAL' && reporter?.isCancelRequested()) {
    reporter.aiFailed();
    fail({ status: 'CANCELLED', failureStage: 'CANCELLED', failureReason: 'CANCELLED：用户已取消分析' });
    return { ok: false, record, stage: 'CANCELLED' };
  }

  if (rawResult.status !== 'success') {
    reporter?.aiFailed();
    fail({
      status: 'AI_FAILED', failureStage: 'AI_PROVIDER',
      aiRawResult: { provider: rawResult.provider, model: rawResult.model, connectionId: rawResult.connectionId, latencyMs: rawResult.latencyMs, status: 'error', errorMessage: rawResult.error?.message },
      failureReason: `AI_FAILED：${rawResult.error?.message || 'unknown error'}`,
    });
    return { ok: false, record, stage: 'AI_FAILED' };
  }
  reporter?.aiCompleted();

  // ---- Section 5 (AI Response Parser/Validator) — the SAME validator for both sources; requires
  // positionManagement only when this analysis actually had a real position in scope. Sprint
  // 3.8E.1: `parsed.parsedRaw` is the JSON-parsed-but-not-necessarily-schema-valid object, present
  // whenever JSON.parse() itself succeeded, regardless of what happens after (see
  // responseValidator.ts's own doc comment on this field). ----
  reporter?.setStage('VALIDATING_RESPONSE');
  const parsed = parseAiResponse({
    rawResult: { status: rawResult.status, rawText: rawResult.rawText, error: rawResult.error },
    payload, promptVersion: promptRecord.promptVersion,
    expectPositionManagement: payload.positionContext != null,
  });

  const aiRawResultSummary = { provider: rawResult.provider, model: rawResult.model, connectionId: rawResult.connectionId, latencyMs: rawResult.latencyMs, status: 'success' as const };

  if (!parsed.ok) {
    fail({
      status: 'VALIDATION_FAILED', failureStage: failureStageForParserErrorCode(parsed.error.code),
      aiRawResult: aiRawResultSummary, parsedResponseRaw: parsed.parsedRaw,
      failureReason: `VALIDATION_FAILED（${parsed.error.code}）：${parsed.error.message}`,
    });
    return { ok: false, record, stage: 'VALIDATION_FAILED' };
  }

  reporter?.setStage('FINALIZING');
  record = {
    ...record, status: 'COMPLETED', completedAt: parsed.generatedAt,
    aiRawResult: aiRawResultSummary, response: parsed.response, parsedResponseRaw: parsed.parsedRaw,
  };
  saveAnalysisRecord(record);
  reporter?.setStage('COMPLETED');
  return { ok: true, record };
}

/** Sprint — AnalysisRun Lifecycle Safety, Section 2/6 — the real, exported entry point (same name,
 * same signature as before this sprint — every existing caller, Manual's route and the Scheduled
 * autonomous cycle, needs zero changes). Now a thin wrapper: registers this analysisId's liveness in
 * `activeAnalysisExecutions` BEFORE anything else runs, delegates the entire original pipeline to
 * `runAnalysisPipeline()` inside a real try/catch (Section 2's "覆盖完整函数生命周期" — this is what
 * closed the exact gap that killed AMSXAPKWWA604, which died between a payload save and the next
 * stage transition with no enclosing catch of any kind), and unregisters in `finally` — guaranteed
 * regardless of which terminal outcome was reached (Section 6's "finally：unregister"). */
export async function runAnalysis(input: RunAnalysisInput): Promise<RunAnalysisResult> {
  const abortController = new AbortController();
  activeAnalysisExecutions.set(input.analysisId, { startedAt: Date.now(), abortController });
  try {
    return await runAnalysisPipeline(input, abortController.signal);
  } catch (err) {
    return await handleUnexpectedFailure(input, err);
  } finally {
    activeAnalysisExecutions.delete(input.analysisId);
  }
}
