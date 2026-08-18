/** Sprint 3.6B — backend-persisted StrategyOrder store. Backend-persisted (not browser localStorage)
 * because backend-owned monitoring (Section 10 of the spec) must keep evaluating triggers and expiry
 * even when no browser tab is open — the existing RealOrder/RealTrade/RealPosition/PositionAllocation
 * chain stays exactly where it is (browser localStorage, untouched). Same JSON-file CRUD discipline as
 * `exchangeAccountStore.ts`/`exchangeConnectionStore.ts` — separate file, separate test-isolation
 * override, never mixed with either.
 *
 * Sprint 3.8C.2 — migrated to `util/safeJsonStore.ts` after the StrategyOrder Persistence Integrity
 * Audit confirmed a real incident: the old `try{...}catch{}return {}` load pattern let a single
 * transient read failure look like "store is empty", and the next save would overwrite the whole file
 * with only the one order being processed — silently erasing every other order
 * (`SO1902ffe3-...`'s real disappearance). Reads now throw `PersistenceError` on a genuine read/parse
 * failure instead of returning an empty map (READ FAILURE ≠ EMPTY STORE); writes go through a
 * same-directory atomic temp-file+rename, inside a short cross-process lock, so two Node processes
 * (realistically: an old backend not yet fully killed + a new one from `tsx watch`) can no longer
 * race into one silently discarding the other's data. */
import { randomUUID } from 'node:crypto';
import type { StrategyOrder, StrategyOrderStatus } from './types.js';
import { STRATEGY_ORDER_TRANSITIONS } from './types.js';
import { readJsonStoreOrDefault, withStoreWriteLock } from '../util/safeJsonStore.js';

const CONFIG_DIR = 'data';
const STRATEGY_ORDERS_PATH = CONFIG_DIR + '/strategy_orders.json';
const STORE_NAME = 'StrategyOrder';

let __testStoragePathOverride: string | null = null;
export function __setStrategyOrdersPathForTesting(path: string | null): void {
  __testStoragePathOverride = path;
}
function resolvePath(): string {
  return __testStoragePathOverride ?? STRATEGY_ORDERS_PATH;
}

type StoreFile = Record<string, StrategyOrder>;

/** Throws `PersistenceError` (from `safeJsonStore.ts`) if the file exists but can't be read/parsed —
 * never silently returns `{}` for a genuinely-corrupt file (only for "file doesn't exist yet", the
 * legitimate first-run case). Callers already tolerate this: HTTP routes have an outer try/catch that
 * turns it into a safe 5xx (`err.message` never contains a secret), and both the Monitoring Engine
 * tick and the Autonomous Scheduler tick are wrapped in their own `.catch(...)` in `server.ts`, so a
 * read failure fails just that one tick closed (logged, no order touched) rather than crashing the
 * process or fabricating an empty store. */
function loadFile(): StoreFile {
  return readJsonStoreOrDefault<StoreFile>(resolvePath(), STORE_NAME, {});
}

export function listStrategyOrders(): StrategyOrder[] {
  return Object.values(loadFile());
}
export function getStrategyOrder(id: string): StrategyOrder | undefined {
  return loadFile()[id];
}
/** Sprint 3.8C.2 — the load→modify→write sequence now runs inside `withStoreWriteLock()`, so a
 * concurrent writer (another process, or another call racing in) can't load a stale/empty snapshot
 * between this function's own load and write. On a read failure inside the lock, `withStoreWriteLock`
 * still throws (never falls back to `{}`) — the previous on-disk file is left completely untouched. */
export function saveStrategyOrder(order: StrategyOrder): StrategyOrder {
  order.updatedAt = new Date().toISOString();
  withStoreWriteLock<StoreFile>(resolvePath(), STORE_NAME, {}, (file) => {
    file[order.strategyOrderId] = order;
    return file;
  });
  return order;
}

export function genStrategyOrderId(): string {
  return 'SO' + randomUUID();
}

/** The ONE place a StrategyOrder's `.status` is ever allowed to change. Throws on an illegal
 * transition rather than silently applying it — callers (routes, monitor engine) must catch and turn
 * this into a 400/decision-blocked response, never swallow it. A same-status "transition" (no-op) is
 * always allowed (idempotent re-application, e.g. a restart re-checking an already-ARMED order). */
export function assertValidTransition(from: StrategyOrderStatus, to: StrategyOrderStatus): void {
  if (from === to) return;
  const allowed = STRATEGY_ORDER_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new Error(`invalid StrategyOrder transition: ${from} -> ${to}`);
  }
}

/** Applies a status transition + saves, in one place, so no caller can update `.status` without going
 * through `assertValidTransition`. `patch` may update any other field in the same write. */
export function transitionStrategyOrder(order: StrategyOrder, to: StrategyOrderStatus, patch?: Partial<StrategyOrder>): StrategyOrder {
  assertValidTransition(order.status, to);
  const updated: StrategyOrder = { ...order, ...(patch || {}), status: to };
  return saveStrategyOrder(updated);
}
