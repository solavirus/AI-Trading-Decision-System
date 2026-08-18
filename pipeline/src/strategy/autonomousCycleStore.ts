/** Sprint 3.7, Section 6/31 — backend-persisted AutonomousCycle records. Same JSON-file CRUD
 * discipline as `strategyOrderStore.ts`. `genAutonomousCycleId()` is the whole idempotency mechanism
 * (Section 6/30): deterministic from `symbol + scheduledAt`, so the SAME slot can never produce two
 * cycle records no matter how many times the scheduler tick re-evaluates it (including across a
 * restart) — the caller's own "does a cycle already exist for this id" check is what actually
 * prevents a re-run; this module only stores/retrieves. */
import type { AutonomousCycle } from './types.js';
import { readJsonStoreOrDefault, withStoreWriteLock } from '../util/safeJsonStore.js';

const CONFIG_DIR = 'data';
const CYCLES_PATH = CONFIG_DIR + '/strategy_autonomous_cycles.json';
const STORE_NAME = 'AutonomousCycle';

let __testStoragePathOverride: string | null = null;
export function __setAutonomousCyclesPathForTesting(path: string | null): void {
  __testStoragePathOverride = path;
}
function resolvePath(): string {
  return __testStoragePathOverride ?? CYCLES_PATH;
}

type StoreFile = Record<string, AutonomousCycle>;

function loadFile(): StoreFile {
  return readJsonStoreOrDefault<StoreFile>(resolvePath(), STORE_NAME, {});
}

export function listAutonomousCycles(): AutonomousCycle[] {
  return Object.values(loadFile()).sort((a, b) => new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime());
}
export function getAutonomousCycle(cycleId: string): AutonomousCycle | undefined {
  return loadFile()[cycleId];
}
export function saveAutonomousCycle(cycle: AutonomousCycle): AutonomousCycle {
  withStoreWriteLock<StoreFile>(resolvePath(), STORE_NAME, {}, (file) => {
    file[cycle.cycleId] = cycle;
    return file;
  });
  return cycle;
}

/** Deterministic — same symbol + same scheduled slot always yields the same id, regardless of how
 * many times it's computed (restart, duplicate tick, manual "Run Analysis Now" landing on the exact
 * same slot boundary). `manual` cycles get a distinct prefix so a manual run never collides with — or
 * gets silently treated as — that slot's real scheduled cycle. */
export function genAutonomousCycleId(symbol: string, scheduledAt: string, manual: boolean): string {
  const safeSymbol = symbol.replace(/[^A-Za-z0-9]/g, '');
  const safeTime = scheduledAt.replace(/[^0-9]/g, '');
  return `AC_${manual ? 'MANUAL_' : ''}${safeSymbol}_${safeTime}`;
}
