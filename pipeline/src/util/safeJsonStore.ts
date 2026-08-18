/** Sprint 3.8C.2 — Safe JSON Persistence Primitive. Fixes the confirmed real persistence bug found
 * during the StrategyOrder Persistence Integrity Audit: every store in this project used to follow
 * `try { JSON.parse(readFileSync(...)) } catch {} return {}` — indistinguishable from "store is
 * genuinely empty", so a single transient read/parse failure (most plausibly a cross-process race
 * during one of this project's frequent `tsx watch` restarts) could make a caller believe an
 * established store was empty, then overwrite the whole file with just whatever ONE record it was
 * saving at that moment — permanently erasing every other record. This is exactly what happened to
 * `SO1902ffe3-...` (see the Persistence Integrity Audit report).
 *
 * Core principle (Section 4 of the spec): READ FAILURE ≠ EMPTY STORE.
 *   - File genuinely absent (first run, nothing ever written yet) → legitimate default value.
 *   - File exists but can't be read/parsed → throws `PersistenceError`. The caller must NOT silently
 *     treat this as empty and must NOT proceed to write (a write built on an unreadable base would
 *     itself risk clobbering real data).
 *
 * Also provides atomic writes (temp file in the same directory + rename, never a direct
 * `writeFileSync(finalPath, ...)`) and a small per-store, cross-process advisory lock (exclusive-
 * create lock file + bounded synchronous wait + stale-lock takeover) so two Node processes
 * (realistically: an old backend not yet fully killed + a new one started by `tsx watch`) can't both
 * load-modify-save the same file and have one's write silently discard the other's.
 *
 * Deliberately NOT a database, NOT a generic ORM, NOT a job queue — Section 9 of the spec is explicit
 * ("不要overengineer... 目标：小而可靠"). This stays a thin, synchronous (matching every existing
 * caller's synchronous style, so no call site becomes async) wrapper around the same
 * readFileSync/writeFileSync primitives this codebase already uses everywhere. */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { dirname, basename } from 'node:path';

/** Never includes the raw underlying error object (which could, in principle, echo file contents or
 * other context) — only a short, already-a-string `.message`, and even that is capped in length.
 * Never includes anything from the FILE CONTENTS itself (a store holding credentials must never leak
 * them into an error message just because a read failed). */
export class PersistenceError extends Error {
  readonly storeName: string;
  readonly fileName: string;
  readonly operation: string;
  constructor(storeName: string, fileName: string, operation: string, causeMessage: string) {
    super(`persistence error in store "${storeName}" (${fileName}) during ${operation}: ${causeMessage.slice(0, 300)}`);
    this.name = 'PersistenceError';
    this.storeName = storeName;
    this.fileName = fileName;
    this.operation = operation;
  }
}

function safeCauseMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** CASE A (file doesn't exist) → `defaultValue`, the normal "store not initialized yet" state.
 * CASE B (file exists but empty/corrupt/unreadable) → throws `PersistenceError`, NEVER `defaultValue`.
 * This is the one behavioral change that matters — every other function in this module exists to
 * support this contract (atomic write so a reader never sees a half-written CASE B in the first
 * place; locking so two writers can't race into producing one). */
export function readJsonStoreOrDefault<T>(path: string, storeName: string, defaultValue: T): T {
  if (!existsSync(path)) return defaultValue;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new PersistenceError(storeName, basename(path), 'read', safeCauseMessage(err));
  }
  if (raw.trim() === '') {
    throw new PersistenceError(storeName, basename(path), 'read', 'file exists but is empty (0 readable bytes)');
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new PersistenceError(storeName, basename(path), 'parse', safeCauseMessage(err));
  }
}

/** temp file lives in the SAME directory as the final path (never os.tmpdir()) so the final
 * `renameSync` is a same-filesystem rename — the only way Node/Windows can guarantee it's atomic.
 * On success, the temp file never remains (rename consumes it). On a thrown error, the temp file may
 * remain on disk (harmless, doesn't affect the final file, cleaned up defensively next call — see
 * `cleanupStaleTempFiles` below is intentionally NOT added, keeping this "small", per Section 9; an
 * orphaned `.tmp-*` file is inert and easy to spot/remove manually if it ever happens). */
export function writeJsonStoreAtomic(path: string, data: unknown, storeName: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, path);
  } catch (err) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best-effort cleanup only */ }
    throw new PersistenceError(storeName, basename(path), 'write', safeCauseMessage(err));
  }
}

// ---------------------------------------------------------------------------
// Cross-process write lock — Section 7/8. Exclusive-create lock file + bounded synchronous wait
// (this codebase is synchronous end-to-end for these stores; converting every caller to async to use
// a "proper" async mutex would be the overengineering Section 9 explicitly warns against). Contention
// is expected to be extremely rare in practice (only during the few-hundred-ms window where an old
// backend process hasn't fully exited before `tsx watch` starts a new one) and the critical section
// itself is a couple of synchronous fs calls — sub-millisecond — so a short, bounded busy-wait is an
// honest trade-off, not a hidden foot-gun: it can only ever block the event loop for at most
// LOCK_TIMEOUT_MS, and only when a real second writer is genuinely active.
// ---------------------------------------------------------------------------
const LOCK_TIMEOUT_MS = 2000;
const LOCK_POLL_MS = 25;
const STALE_LOCK_MS = 30_000; // a lock file older than this is assumed to be from a crashed/killed holder

function syncSleep(ms: number): void {
  // Documented Node pattern for an in-process, no-dependency synchronous sleep — never spawns a
  // process, never touches the filesystem beyond what this module already does.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(lockPath: string, storeName: string): void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), { flag: 'wx' });
      return; // acquired
    } catch (err: any) {
      if (err?.code !== 'EEXIST') {
        throw new PersistenceError(storeName, basename(lockPath), 'lock', safeCauseMessage(err));
      }
      // Someone else holds it — check for a stale (abandoned) lock before waiting further.
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          try { unlinkSync(lockPath); continue; } catch { /* raced with the real holder releasing it — fine, just retry */ }
        }
      } catch { /* lock file vanished between EEXIST and stat — fine, just retry */ }
      if (Date.now() >= deadline) {
        throw new PersistenceError(storeName, basename(lockPath), 'lock_timeout', `could not acquire write lock within ${LOCK_TIMEOUT_MS}ms — a fresh write was refused rather than risk an unsynchronized overwrite`);
      }
      syncSleep(LOCK_POLL_MS);
    }
  }
}
function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* already gone / never acquired — nothing to clean up */ }
}

/** The one function every store's `saveX()` should route through for a load→modify→write sequence
 * that must not lose a concurrent writer's update (Section 8: "load → modify → save 应该在同一个
 * store write lock 保护范围内执行"). `fn` receives the freshly, safely loaded current file content
 * (via `readJsonStoreOrDefault`, so CASE B still throws and aborts — never silently treated as empty
 * even inside the lock) and returns the new full content to persist atomically. Lock is always
 * released, success or failure (`finally`) — a thrown error here means NOTHING was written, the
 * previous on-disk file is untouched, matching Section 5's "无法可靠读取旧 store → 绝不覆盖它". */
export function withStoreWriteLock<T>(path: string, storeName: string, defaultValue: T, fn: (current: T) => T): T {
  const lockPath = `${path}.lock`;
  acquireLock(lockPath, storeName);
  try {
    const current = readJsonStoreOrDefault<T>(path, storeName, defaultValue);
    const next = fn(current);
    writeJsonStoreAtomic(path, next, storeName);
    return next;
  } finally {
    releaseLock(lockPath);
  }
}
