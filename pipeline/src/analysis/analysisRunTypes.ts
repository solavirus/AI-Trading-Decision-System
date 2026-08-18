/** Sprint 3.9.1.1 — AnalysisRun: the backend-owned record of ONE analysis EXECUTION IN PROGRESS.
 * Deliberately separate from `AnalysisRecord` (analysis/types.ts) — Section 21's own distinction:
 * AnalysisRun is "what is happening right now" (stages, per-source progress, elapsed time),
 * AnalysisRecord is "what the analysis concluded" (COMPLETED/AI_FAILED/etc, the payload/response).
 * A completed run's AnalysisRecord is looked up by the same `analysisId` — this file never
 * duplicates any business-outcome semantics AnalysisRecord already owns. */
import type { SourceKey } from '../types.js';
import type { AnalysisSource } from './types.js';

/** Section 4 — minimal, real mapping of the actual `runAnalysis()` pipeline steps. Every stage here
 * corresponds to a real, distinct piece of work already present in `analysisEngine.ts`/
 * `snapshotAcquisition.ts` — none are fabricated for visual effect (Section 4's own instruction). */
export type AnalysisRunStage =
  | 'PREPARING' | 'COLLECTING_SOURCES' | 'SYNCING_ACCOUNT' | 'BUILDING_PAYLOAD'
  | 'BUILDING_PROMPT' | 'AI_ANALYSIS' | 'VALIDATING_RESPONSE' | 'FINALIZING'
  | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export const TERMINAL_STAGES: AnalysisRunStage[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export type SourceProgressStatus = 'PENDING' | 'RUNNING' | 'RETRYING' | 'COMPLETED' | 'FAILED';
export interface SourceProgress {
  sourceId: SourceKey;
  label: string;
  status: SourceProgressStatus;
  attempt: number;
  maxAttempts: number;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
}

export type SubStageStatus = 'PENDING' | 'RUNNING' | 'RETRYING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
/** Section 8 — one sub-stage for the account/position read. `SKIPPED` = no exchange account was in
 * scope for this run at all (never a fabricated "N/A" the user could mistake for a real check). */
export interface AccountSnapshotProgress {
  status: SubStageStatus;
  attempt: number;
  maxAttempts: number;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
}

export interface AiStageProgress {
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  startedAt: string | null;
  completedAt: string | null;
  provider: string | null;
  model: string | null;
}

export interface AnalysisRun {
  analysisId: string;
  source: AnalysisSource;
  symbol: string;
  currentStage: AnalysisRunStage;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** Section 18 — Manual-only real cancellation. `cancelRequested` is set the instant the user asks;
   * `cancelled` is set only once the run has actually reached the CANCELLED terminal stage — the gap
   * between them is the (bounded) window where an in-flight step is still winding down safely. */
  cancelRequested: boolean;
  cancelled: boolean;
  error: string | null;
  sources: SourceProgress[];
  accountSnapshot: AccountSnapshotProgress | null;
  aiStage: AiStageProgress;
  triggeredByCycleId: string | null;
}
