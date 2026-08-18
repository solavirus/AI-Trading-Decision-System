/** Sprint 3.9.1.1, Section 4/20 — backend-owned AnalysisRun persistence, using the Sprint 3.8C.2 Safe
 * JSON Persistence Primitive (fail-closed load, atomic write, cross-process lock) — no new unsafe
 * `catch{}→default` store invented for this. A run is the ONE thing that makes "frontend refresh
 * recovers progress" (Section 11) and "Monitoring page shows a live Scheduled run" (Section 23)
 * possible without either side re-deriving truth itself. */
import { readJsonStoreOrDefault, withStoreWriteLock } from '../util/safeJsonStore.js';
import type { AnalysisRun, AnalysisRunStage, SourceProgress } from './analysisRunTypes.js';
import { TERMINAL_STAGES } from './analysisRunTypes.js';
import type { AnalysisSource } from './types.js';

const CONFIG_DIR = 'data';
const RUNS_PATH = CONFIG_DIR + '/analysis_runs.json';
const STORE_NAME = 'AnalysisRun';

let __testStoragePathOverride: string | null = null;
export function __setAnalysisRunsPathForTesting(path: string | null): void {
  __testStoragePathOverride = path;
}
function resolvePath(): string {
  return __testStoragePathOverride ?? RUNS_PATH;
}

type StoreFile = Record<string, AnalysisRun>;
function loadFile(): StoreFile {
  return readJsonStoreOrDefault<StoreFile>(resolvePath(), STORE_NAME, {});
}

export function getAnalysisRun(analysisId: string): AnalysisRun | undefined {
  return loadFile()[analysisId];
}

export function createAnalysisRun(input: {
  analysisId: string; source: AnalysisSource; symbol: string; sourceKeys: SourceProgress['sourceId'][];
  sourceLabels: Record<string, string>; hasAccountInScope: boolean; triggeredByCycleId: string | null;
}): AnalysisRun {
  const now = new Date().toISOString();
  const run: AnalysisRun = {
    analysisId: input.analysisId, source: input.source, symbol: input.symbol,
    currentStage: 'PREPARING', createdAt: now, updatedAt: now, completedAt: null,
    cancelRequested: false, cancelled: false, error: null,
    sources: input.sourceKeys.map((sourceId) => ({
      sourceId, label: input.sourceLabels[sourceId] || sourceId, status: 'PENDING',
      attempt: 0, maxAttempts: 3, startedAt: null, completedAt: null, lastError: null,
    })),
    accountSnapshot: input.hasAccountInScope ? { status: 'PENDING', attempt: 0, maxAttempts: 3, startedAt: null, completedAt: null, lastError: null } : null,
    aiStage: { status: 'PENDING', startedAt: null, completedAt: null, provider: null, model: null },
    triggeredByCycleId: input.triggeredByCycleId,
  };
  withStoreWriteLock<StoreFile>(resolvePath(), STORE_NAME, {}, (file) => {
    file[run.analysisId] = run;
    return file;
  });
  return run;
}

/** Every progress update goes through this one locked read-modify-write — Section 8's own
 * write-transaction discipline (3.8C.2), applied here too: no caller ever does its own
 * load→mutate→save outside a lock. `mutate` receives the CURRENT persisted run and returns the next
 * one; returns `undefined` if the run doesn't exist (never silently fabricates one). */
function mutateRun(analysisId: string, mutate: (run: AnalysisRun) => AnalysisRun): AnalysisRun | undefined {
  let result: AnalysisRun | undefined;
  withStoreWriteLock<StoreFile>(resolvePath(), STORE_NAME, {}, (file) => {
    const existing = file[analysisId];
    if (!existing) return file;
    const next = mutate(existing);
    file[analysisId] = next;
    result = next;
    return file;
  });
  return result;
}

export function setStage(analysisId: string, stage: AnalysisRunStage, extra?: Partial<Pick<AnalysisRun, 'error' | 'cancelled'>>): AnalysisRun | undefined {
  return mutateRun(analysisId, (run) => ({
    ...run, currentStage: stage, updatedAt: new Date().toISOString(),
    completedAt: TERMINAL_STAGES.includes(stage) ? new Date().toISOString() : run.completedAt,
    ...extra,
  }));
}

export function requestCancel(analysisId: string): AnalysisRun | undefined {
  return mutateRun(analysisId, (run) => ({ ...run, cancelRequested: true, updatedAt: new Date().toISOString() }));
}

function updateSource(analysisId: string, sourceId: string, patch: Partial<SourceProgress>): void {
  mutateRun(analysisId, (run) => ({
    ...run, updatedAt: new Date().toISOString(),
    sources: run.sources.map((s) => (s.sourceId === sourceId ? { ...s, ...patch } : s)),
  }));
}
function updateAccount(analysisId: string, patch: Partial<NonNullable<AnalysisRun['accountSnapshot']>>): void {
  mutateRun(analysisId, (run) => (run.accountSnapshot ? { ...run, updatedAt: new Date().toISOString(), accountSnapshot: { ...run.accountSnapshot, ...patch } } : run));
}
function updateAi(analysisId: string, patch: Partial<AnalysisRun['aiStage']>): void {
  mutateRun(analysisId, (run) => ({ ...run, updatedAt: new Date().toISOString(), aiStage: { ...run.aiStage, ...patch } }));
}

/** Section 5/7/8 — the interface `snapshotAcquisition.ts`/`analysisEngine.ts` call into; keeps them
 * decoupled from the storage details (they never touch the JSON file directly). `isCancelRequested`
 * lets a long loop (source-by-source collection) check for a Manual cancel between steps without
 * needing its own separate polling mechanism (Section 18's cooperative-cancellation boundary). */
export interface AnalysisProgressReporter {
  setStage(stage: AnalysisRunStage, extra?: Partial<Pick<AnalysisRun, 'error' | 'cancelled'>>): void;
  sourceStarted(sourceId: string, attempt: number, maxAttempts: number): void;
  sourceRetrying(sourceId: string, attempt: number, maxAttempts: number, lastError: string): void;
  sourceCompleted(sourceId: string): void;
  sourceFailed(sourceId: string, lastError: string): void;
  accountStarted(attempt: number, maxAttempts: number): void;
  accountRetrying(attempt: number, maxAttempts: number, lastError: string): void;
  accountCompleted(): void;
  accountFailed(lastError: string): void;
  aiStarted(provider: string, model: string): void;
  aiCompleted(): void;
  aiFailed(): void;
  isCancelRequested(): boolean;
}

export function createProgressReporter(analysisId: string): AnalysisProgressReporter {
  const now = () => new Date().toISOString();
  return {
    setStage(stage, extra) { setStage(analysisId, stage, extra); },
    sourceStarted(sourceId, attempt, maxAttempts) { updateSource(analysisId, sourceId, { status: 'RUNNING', attempt, maxAttempts, startedAt: now() }); },
    sourceRetrying(sourceId, attempt, maxAttempts, lastError) { updateSource(analysisId, sourceId, { status: 'RETRYING', attempt, maxAttempts, lastError }); },
    sourceCompleted(sourceId) { updateSource(analysisId, sourceId, { status: 'COMPLETED', completedAt: now(), lastError: null }); },
    sourceFailed(sourceId, lastError) { updateSource(analysisId, sourceId, { status: 'FAILED', completedAt: now(), lastError }); },
    accountStarted(attempt, maxAttempts) { updateAccount(analysisId, { status: 'RUNNING', attempt, maxAttempts, startedAt: now() }); },
    accountRetrying(attempt, maxAttempts, lastError) { updateAccount(analysisId, { status: 'RETRYING', attempt, maxAttempts, lastError }); },
    accountCompleted() { updateAccount(analysisId, { status: 'COMPLETED', completedAt: now(), lastError: null }); },
    accountFailed(lastError) { updateAccount(analysisId, { status: 'FAILED', completedAt: now(), lastError }); },
    aiStarted(provider, model) { updateAi(analysisId, { status: 'RUNNING', startedAt: now(), provider, model }); },
    aiCompleted() { updateAi(analysisId, { status: 'COMPLETED', completedAt: now() }); },
    aiFailed() { updateAi(analysisId, { status: 'FAILED', completedAt: now() }); },
    isCancelRequested() { return getAnalysisRun(analysisId)?.cancelRequested ?? false; },
  };
}

/** Section 12.D — the duplicate-submission guard's real backing query: is there already a
 * non-terminal run for this symbol, Manual OR Scheduled? Adopted policy: only ONE unified-analysis
 * run per symbol at a time regardless of source — never two simultaneous BTC analyses, whether both
 * are Manual, both Scheduled, or one of each. Manual's route uses this to attach the caller to an
 * already-running analysis instead of starting a second one; the Monitoring page (Section 23) uses
 * the SAME query to find a live Scheduled run to show progress for, reusing this one lookup for both
 * purposes rather than building a second one. */
export function findActiveRun(symbol: string): AnalysisRun | undefined {
  const all = Object.values(loadFile());
  return all.find((r) => r.symbol === symbol && !TERMINAL_STAGES.includes(r.currentStage));
}

/** Sprint — AnalysisRun Lifecycle Safety, Section 7/9/10 — the one place `analysisRunReconciliation.ts`
 * enumerates every run (optionally scoped to one symbol) to check for staleness/orphaning. Read-only,
 * no lock needed (mirrors every other plain-read export in this file). */
export function listAllAnalysisRuns(symbol?: string): AnalysisRun[] {
  const all = Object.values(loadFile());
  return symbol ? all.filter((r) => r.symbol === symbol) : all;
}
