/** Sprint 3.7, Section 5/6/7 — backend-persisted Autonomous Scheduler OPERATIONAL state. Separate
 * from `autonomousPolicyStore.ts` (user-configured permission/limits, changes rarely) — this changes
 * every cycle (Section 6: must survive a backend restart without re-running an already-covered slot).
 * `health` is derived display state only, computed from these fields + `AutonomousPolicy.autonomousEnabled`
 * at read time (`computeSchedulerHealth()`), never stored redundantly. */
import { readJsonStoreOrDefault, withStoreWriteLock } from '../util/safeJsonStore.js';

const CONFIG_DIR = 'data';
const STATE_PATH = CONFIG_DIR + '/strategy_autonomous_scheduler.json';
const STORE_NAME = 'AutonomousSchedulerState';

let __testStoragePathOverride: string | null = null;
export function __setAutonomousSchedulerPathForTesting(path: string | null): void {
  __testStoragePathOverride = path;
}
function resolvePath(): string {
  return __testStoragePathOverride ?? STATE_PATH;
}

export interface AutonomousSchedulerState {
  nextRunAt: string | null; // null = never initialized (autonomous never enabled yet, or freshly reset)
  lastRunAt: string | null; // last time the scheduler attempted a slot (regardless of outcome)
  lastSuccessfulRunAt: string | null; // last time a slot completed with status COMPLETED (NO_ACTION counts as success)
  lastFailureReason: string | null;
}

function defaultState(): AutonomousSchedulerState {
  return { nextRunAt: null, lastRunAt: null, lastSuccessfulRunAt: null, lastFailureReason: null };
}

export function getAutonomousSchedulerState(): AutonomousSchedulerState {
  const raw = readJsonStoreOrDefault<Partial<AutonomousSchedulerState>>(resolvePath(), STORE_NAME, defaultState());
  return { ...defaultState(), ...raw };
}

export function saveAutonomousSchedulerState(patch: Partial<AutonomousSchedulerState>): AutonomousSchedulerState {
  return withStoreWriteLock<AutonomousSchedulerState>(resolvePath(), STORE_NAME, defaultState(), (current) => {
    return { ...defaultState(), ...current, ...patch };
  });
}

export type SchedulerHealth = 'RUNNING' | 'PAUSED' | 'STALE' | 'ERROR';

/** Section 7 — pure display classification, never persisted. `STALE` fires when a `nextRunAt` slot is
 * significantly overdue (more than one full interval past due) while still enabled — signals the tick
 * loop itself may not be running, distinct from `ERROR` (the scheduler DID run but the last attempt
 * failed). `ERROR` takes precedence when both are technically true (a stale AND failing scheduler is
 * more accurately "erroring", not just "delayed"). */
export function computeSchedulerHealth(autonomousEnabled: boolean, state: AutonomousSchedulerState, intervalHours: number, now: Date = new Date()): SchedulerHealth {
  if (!autonomousEnabled) return 'PAUSED';
  if (state.lastFailureReason && state.lastRunAt && state.lastRunAt !== state.lastSuccessfulRunAt) return 'ERROR';
  if (state.nextRunAt) {
    const overdueMs = now.getTime() - new Date(state.nextRunAt).getTime();
    if (overdueMs > intervalHours * 3600_000) return 'STALE';
  }
  return 'RUNNING';
}
