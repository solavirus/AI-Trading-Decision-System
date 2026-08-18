/** Sprint 3.9 — Unified Analysis Pipeline. Shared types for the ONE analysis engine both Manual and
 * Scheduled/Autonomous triggers call (Section 5 of the spec: "不要机械照抄函数名... 建立唯一正式
 * Analysis Service/Engine"). Ported/adapted from the frontend's own `ANALYSIS_PAYLOAD_SPEC.md` /
 * `AI_RESPONSE_SPEC.md` shapes (`prototype/index.html`'s `buildAnalysisPayload`/`parseAiResponse`),
 * which is why field names mirror those exactly — this is a faithful port, not a redesign, per
 * Section 1's "禁止修改Prompt语义". The one deliberate ADDITIVE extension (Section 18) is
 * `PositionManagementDecision` on `AnalysisRecord`/`AiResponseBody`, which does not exist in the
 * pre-Sprint-3.9 frontend contract at all. */

import type { SourceKey, RawItem } from '../types.js';
import type { ExchangePositionSnapshot } from '../exchange/types.js';

export type AnalysisSource = 'MANUAL' | 'SCHEDULED';

export interface AnalysisEvidenceInput {
  id: string;
  type: string;
  title?: string;
  content?: string;
  reference?: string;
  weight: number;
  /** Populated by the frontend's existing `/api/ai/evidence/image` call BEFORE this engine ever
   * runs — Image Evidence Parsing itself is out of scope for this sprint's unification (Section 1
   * doesn't ask for it, and it already has its own dedicated, already-real backend endpoint). */
  parsedContent?: unknown;
}

export interface SourceSnapshot {
  id: SourceKey;
  name: string;
  status: 'available' | 'partial';
  updatedAt: string;
  values: { label: string; value: string }[];
  summary?: string;
  error: null;
}

export interface SelectedNewsEvent {
  id: string;
  title: string;
  summary: string;
  category: string | undefined;
  publishedAt: string | null;
  sourceCount: number;
  sources: string[];
  importanceScore: number;
  relatedAssets: string[];
  sourceArticleIds: string[];
}

/** Section 15/19 — real backend Position Context, NEVER derived from stale frontend localStorage.
 * `null` explicitly means "confirmed no position for this symbol", distinct from the field being
 * unset — a completed AnalysisRecord always resolves this one way or the other. */
export interface AnalysisPositionContext {
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number | null;
  markPrice: number | null;
  leverage: number | null;
  unrealizedPnl: number | null;
  currentStopLoss: number | null;
  currentTakeProfit: number[];
  protectionStatus: 'PROTECTED' | 'PARTIALLY_PROTECTED' | 'UNPROTECTED' | 'UNKNOWN';
  relatedStrategyOrderId: string | null;
  fetchedAt: string;
}

export interface AnalysisPayload {
  analysisId: string;
  createdAt: string;
  payloadVersion: string;
  symbol: string;
  timeframe: string;
  dateRange: string;
  sourceWeights: Record<string, number>;
  additionalEvidence: AnalysisEvidenceInput[];
  sourceSnapshots: SourceSnapshot[];
  selectedNewsEvents: SelectedNewsEvent[];
  dataQuality: {
    unavailableSources: string[];
    partialSources: string[];
    staleSources: string[];
  };
  /** Section 15/19/20 — additive: absent/undefined on every payload shape that predates Sprint 3.9,
   * so an old stored payload (frontend localStorage, never migrated per Section 29) still satisfies
   * this type. `null` = confirmed no position; present = the real position this analysis saw. */
  positionContext?: AnalysisPositionContext | null;
}

export interface PromptRecord {
  analysisId: string;
  promptVersion: string;
  payloadVersion: string;
  generatedAt: string;
  promptText: string;
}

/** Section 16 — PositionManagementDecision contract. v1 supports exactly these 5 actions;
 * `ADD_POSITION` is explicitly NOT supported (Section 16's own hard requirement) — never add it
 * without a new sprint's explicit sign-off. */
export type PositionManagementAction = 'HOLD' | 'ADJUST_SL' | 'ADJUST_TP' | 'REDUCE' | 'CLOSE';

export interface PositionManagementDecision {
  action: PositionManagementAction;
  rationale: string;
  confidence: number; // 0-100
  newStopLoss?: number; // required for ADJUST_SL
  newTakeProfit?: number; // required for ADJUST_TP
  reducePercent?: number; // required for REDUCE, 0 < x <= 100
}

/** AI_RESPONSE_SPEC.md v2.2.0's root shape, ported verbatim from the frontend parser's expectations
 * (`validateRootFieldsPresent`/`validateAiResponseSchema` in `prototype/index.html`). `positionManagement`
 * is the one Sprint 3.9 additive field (Section 18) — present only when the payload included a
 * `positionContext`, absent/undefined otherwise, so every pre-3.9 response shape is still valid. */
export interface AiResponseBody {
  responseVersion: string;
  analysisId: string;
  summary: { title: string; content: string };
  decision: { direction: 'LONG' | 'SHORT'; action: 'ENTER' | 'WAIT'; confidence: number };
  scenarioPlans: ScenarioPlan[];
  sourceAssessments: SourceAssessment[];
  reasoning: ReasoningItem[];
  risks: RiskItem[];
  evidence: EvidenceItem[];
  positionManagement?: PositionManagementDecision;
}

export interface StructuredTriggerCondition {
  metric: 'price' | 'candle_close';
  operator: 'GT' | 'GTE' | 'LT' | 'LTE' | 'BETWEEN' | 'CROSSES_ABOVE' | 'CROSSES_BELOW' | 'EQUALS';
  value?: number;
  min?: number;
  max?: number;
  timeframe?: string | null;
}
export interface StructuredTrigger {
  description: string;
  logic: 'ALL' | 'ANY';
  conditions: StructuredTriggerCondition[];
}
export interface ScenarioPlan {
  id: string;
  priority: 'PRIMARY' | 'ALTERNATIVE' | 'INVALIDATION';
  direction: 'LONG' | 'SHORT';
  action: 'ENTER';
  title: string;
  trigger: string;
  holdingPeriod?: string;
  entry: { type: 'MARKET' | 'LIMIT' | 'ZONE' | 'CONDITIONAL'; value?: number | null; from?: number | null; to?: number | null; description?: string };
  stopLoss: { value?: number | null; description?: string };
  takeProfit: { value?: number | null; description?: string }[];
  rationale: string;
  evidenceReferences: string[];
  triggerStructured?: StructuredTrigger | null;
  invalidation?: StructuredTrigger | null;
  reviewHorizon?: { description: string; expiresAt?: string | null } | null;
}
export interface SourceAssessment {
  sourceId: string;
  configuredWeight: number;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  evidenceStrength: 'LOW' | 'MEDIUM' | 'HIGH';
  explanation: string;
  evidenceReferences: string[];
}
export interface ReasoningItem { title: string; description: string; importance: number; stance: 'SUPPORT' | 'OPPOSE' | 'NEUTRAL'; evidenceReferences: string[] }
export interface RiskItem { title: string; description: string; impact: 'LOW' | 'MEDIUM' | 'HIGH' }
export interface EvidenceItem { reason: string; references: string[] }

/** Section 25 — unified analysis status. Strictly distinguishes "analysis never started/finished
 * gathering its required inputs" (SNAPSHOT_FAILED) from "analysis ran and concluded" (COMPLETED) —
 * never conflated with a trading NO_ACTION judgment (Section 26), which is a property of the AI's
 * `decision`/`scenarioPlans` content, not of `AnalysisRecord.status`. */
/** Sprint 3.9.1.1, Section 18/21 — `CANCELLED` added: a Manual user cancel is its own distinct
 * terminal outcome, never conflated with `AI_FAILED` (which means the provider itself failed) or
 * silently dropped (Section 18 requires the cancellation to be recorded, just never as COMPLETED). */
/** Sprint — AnalysisRun Lifecycle Safety, Section 3: `FAILED` is a genuine, generic terminal bucket
 * for an UNEXPECTED failure — one that isn't any of the specific, already-meaningful sub-kinds above
 * (SNAPSHOT_FAILED/AI_FAILED/VALIDATION_FAILED each describe a REAL, specific failure domain; forcing
 * an unrelated failure — e.g. a persistence-layer exception mid-pipeline, before the AI was ever
 * called — into one of those would misattribute the cause, which this sprint's own spec explicitly
 * forbids: "不要把它错误标成AI_PROVIDER_FAILED"). Used exclusively alongside
 * `failureStage:'UNEXPECTED'` (see `AnalysisFailureStage` below) and by stale-run reconciliation. */
export type AnalysisStatus = 'COLLECTING' | 'RETRYING_SNAPSHOT' | 'ANALYZING' | 'COMPLETED' | 'SNAPSHOT_FAILED' | 'AI_FAILED' | 'VALIDATION_FAILED' | 'CANCELLED' | 'FAILED';

/** Sprint 3.8E.1, Section 6/14 — a structured, machine-checkable answer to "at which real stage did
 * this analysis stop", independent of the free-text `failureReason` string (which stays exactly as
 * it was — this is additive, not a replacement). Values map 1:1 onto real, already-existing branches
 * in `analysisEngine.ts`/`snapshotAcquisition.ts`/`responseValidator.ts` — none invented for this
 * sprint. `PARSE` = the raw AI text was not valid JSON at all (or was empty); `SCHEMA_VALIDATION` =
 * it parsed as JSON but failed `AI_RESPONSE_SPEC.md` validation (schema/cross-rule/weight/evidence-
 * reference checks alike — `responseValidator.ts` itself does not split these into separate stages,
 * so neither does this field; only PARSE vs. everything-else is split, per Section 10's explicit
 * requirement). `null` on COMPLETED. */
/** Sprint — AnalysisRun Lifecycle Safety, Section 3/7: `UNEXPECTED` — an exception NOT already
 * classified by any of the specific stages above, caught only by `runAnalysis()`'s new top-level
 * safety boundary or by stale-run reconciliation terminalizing a dead, never-cancelled ghost run.
 * Real, honest catch-all — never a claim about WHICH stage actually failed beyond "somewhere this
 * pipeline run didn't reach one of the already-understood failure/success outcomes". */
export type AnalysisFailureStage = 'CONFIG' | 'SOURCES' | 'ACCOUNT_SNAPSHOT' | 'CANCELLED' | 'AI_PROVIDER' | 'PARSE' | 'SCHEMA_VALIDATION' | 'UNEXPECTED';

/** Section 10 — the ONE unified Analysis History record, backend-owned (Section 28: Scheduled truth
 * must survive the browser being closed, so this cannot be localStorage-only). `source` is the only
 * field distinguishing MANUAL from SCHEDULED at this layer, per Section 0's product principle. */
export interface AnalysisRecord {
  analysisId: string;
  source: AnalysisSource;
  symbol: string;
  createdAt: string;
  completedAt: string | null;
  status: AnalysisStatus;
  payload: AnalysisPayload | null;
  promptVersion: string | null;
  aiRawResult: { provider: string; model: string; connectionId?: string; latencyMs: number; status: 'success' | 'error'; errorMessage?: string } | null;
  response: AiResponseBody | null;
  failureReason: string | null;
  /** Sprint 3.8E.1, Section 6/14 — see `AnalysisFailureStage`'s own doc comment. `null` whenever this
   * analysis never reached a FAILED/CANCELLED terminal state (i.e. on COMPLETED, or on any
   * still-in-progress intermediate save — see `analysisEngine.ts`). */
  failureStage: AnalysisFailureStage | null;
  /** Sprint 3.8E.1, Section 8 — the exact final Prompt text this run actually sent to the AI
   * provider (`promptBuilder.ts#buildPromptText`'s output for THIS analysis, not a template and not
   * a reconstruction). `null` only when the run never reached BUILDING_PROMPT (CONFIG/SOURCES/
   * ACCOUNT_SNAPSHOT/CANCELLED-before-prompt failures) — never cleared afterward, including on a
   * later failure, per Section 6's "FAILED must not delete/overwrite earlier evidence". */
  builtPrompt: string | null;
  /** Sprint 3.8E.1, Section 5/9 — the AI provider's raw text output for THIS run, saved the instant
   * `runAIAnalysis()` returns and BEFORE `parseAiResponse()` is ever called (Section 5's explicit
   * ordering requirement — a Parser/Validator throw can never cause this to be lost). Model output
   * only; never a credential/header/key (see `ai/providerHttp.ts` — those never flow through
   * `AIRawResult.rawText` in the first place). Empty string on an AI_PROVIDER failure (a real,
   * honest "no content was ever produced" state, not a placeholder) — `null` only when the run never
   * reached AI_ANALYSIS at all. */
  aiRawResponseText: string | null;
  /** Sprint 3.8E.1, Section 10 — the raw AI response after `JSON.parse()` succeeded, captured
   * REGARDLESS of whether it then passed schema/cross-rule validation — this is what lets a
   * SCHEMA_VALIDATION failure still show the AI's actual structured output (e.g. a real but
   * out-of-range `decision.confidence`), never silently discarded. `null` when the raw text was not
   * valid JSON at all (failureStage=PARSE) or the run never reached AI_ANALYSIS. This is NOT the
   * same object as `response` — `response` only ever holds a FULLY validated `AiResponseBody`. */
  parsedResponseRaw: Record<string, any> | null;
  /** Section 13/14 — Scheduled-only, always null for MANUAL. Links this AnalysisRecord back to the
   * AutonomousCycle that triggered it (the reverse of `AutonomousCycle.strategyOrderId` — see
   * `autonomousScheduler.ts`). */
  triggeredByCycleId: string | null;
  exchangeAccountId: string | null;
  snapshotStartedAt: string;
  snapshotCompletedAt: string | null;
}

export { ExchangePositionSnapshot, RawItem };
