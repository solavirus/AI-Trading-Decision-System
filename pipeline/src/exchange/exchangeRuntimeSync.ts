/** Sprint 3.8C — Exchange Runtime Sync. Backend-owned, startup-driven account/connection truth —
 * "Frontend is a viewer/controller, Backend is the trading system" (Section 0 of the spec): whether
 * the frontend is open, closed, or refreshed must never affect whether this exists. Reuses the
 * EXISTING account-snapshot/open-orders reads (`exchangeService.ts`, itself a thin wrapper over
 * `binanceFuturesAdapter.ts`) — this file is a new CALLER on a timer, never a second Binance client
 * and never a duplicate of that request logic.
 *
 * In-memory only (Section 21 — "Runtime State vs Business Records"): every field here is cheaply,
 * fully re-derivable from a fresh read, so persisting it to disk would just be a stale copy of
 * something this module recomputes on its own every SYNC_INTERVAL_MS anyway; it is intentionally
 * NOT in `data/*.json` and is naturally reset (correctly, to STARTING) on every process restart.
 *
 * WebSocket (`userDataStreamManager.ts`) is unaffected and untouched by this file — it remains the
 * low-latency, frontend-subscription-driven NUDGE channel (Section 6: "WebSocket 负责低延迟事件更新").
 * This module is the periodic REST reconciliation half of that same section's explicitly-required
 * hybrid: the thing that keeps working with zero frontend subscribers, zero WebSocket, across a
 * restart, and is the only thing `executionReadiness.ts` is allowed to depend on for exchange truth. */
import { listExchangeAccounts, resolvePreferredConnectionForAccount } from './exchangeAccountStore.js';
import { getExchangeConnection } from './exchangeConnectionStore.js';
import { fetchExchangeAccountSnapshot as realFetchExchangeAccountSnapshot, fetchOpenOrders as realFetchOpenOrders } from './exchangeService.js';
import type { ExchangeAccountSnapshot, ExchangeOrderSnapshot, ExchangeEnvironment } from './types.js';

// Sprint 3.8C Closeout, Section 6 — the minimal DI seam this file's own failure-injection tests need
// (real network failures must never be the only way to test failure handling). Defaults to the real
// functions in every real caller (server.ts never touches these) — a test-only override function is
// the ONLY way to change them, so production behavior is unaffected unless a test explicitly opts in.
type FetchAccountSnapshotFn = typeof realFetchExchangeAccountSnapshot;
type FetchOpenOrdersFn = typeof realFetchOpenOrders;
let fetchAccountSnapshotImpl: FetchAccountSnapshotFn = realFetchExchangeAccountSnapshot;
let fetchOpenOrdersImpl: FetchOpenOrdersFn = realFetchOpenOrders;
export function __setExchangeServiceFunctionsForTesting(overrides: { fetchAccountSnapshot?: FetchAccountSnapshotFn | null; fetchOpenOrders?: FetchOpenOrdersFn | null } | null): void {
  fetchAccountSnapshotImpl = overrides?.fetchAccountSnapshot ?? realFetchExchangeAccountSnapshot;
  fetchOpenOrdersImpl = overrides?.fetchOpenOrders ?? realFetchOpenOrders;
}

export type SyncHealth = 'STARTING' | 'HEALTHY' | 'DEGRADED' | 'ERROR' | 'DISABLED';

export interface AccountRuntimeState {
  exchangeAccountId: string;
  connectionId: string | null; // the resolved preferredConnectionId at last attempt; null when unresolvable
  environment: ExchangeEnvironment | null;
  syncHealth: SyncHealth;
  lastAttemptAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastError: { code: string; message: string } | null;
  /** Last KNOWN-GOOD read — never cleared by a later failed attempt (Section 22: "失败 ≠ 空账户").
   * `null` only until the very first successful sync has ever completed. */
  snapshot: ExchangeAccountSnapshot | null;
  openOrders: ExchangeOrderSnapshot[] | null;
}

// Section 7/21 — ONE place these numbers live, never duplicated across files.
// Sprint 3.8C Closeout — raised from 20s to 10s (product decision: more timely account truth is
// worth the extra request volume; see the Closeout report's Rate Safety section for the actual
// request/minute/account cost this implies). Still a minute-scale strategy system, not HFT.
export const SYNC_INTERVAL_MS = 10_000;
// DEGRADED once we're more than 3 missed cycles past the last success (one real transient miss is
// normal and should NOT immediately alarm) — HEALTHY still holds through a single blip.
const DEGRADED_AFTER_MS = SYNC_INTERVAL_MS * 3; // 30s at the current 10s interval
// ERROR only once a successful sync hasn't happened in a while that's clearly no longer "a blip" —
// 9 missed cycles. Below this, still DEGRADED (stale but plausibly transient).
const ERROR_AFTER_MS = SYNC_INTERVAL_MS * 9; // 90s at the current 10s interval

const state = new Map<string, AccountRuntimeState>(); // key: exchangeAccountId

function emptyState(exchangeAccountId: string): AccountRuntimeState {
  return {
    exchangeAccountId, connectionId: null, environment: null, syncHealth: 'STARTING',
    lastAttemptAt: null, lastSuccessfulSyncAt: null, lastError: null, snapshot: null, openOrders: null,
  };
}

export function getAccountRuntimeState(exchangeAccountId: string): AccountRuntimeState | undefined {
  return state.get(exchangeAccountId);
}
export function getAllAccountRuntimeStates(): AccountRuntimeState[] {
  return Array.from(state.values());
}

/** Recomputes `syncHealth` from real timestamps every time it's read/updated — never a value that
 * can silently go stale itself (Section 19: "必须定义 stale 概念... 不要隐藏 stale 数据"). Called both
 * right after a sync attempt AND on-demand by `getAccountRuntimeState()` callers indirectly via this
 * module's own writes — there is no separate "staleness sweep" timer, since every read already goes
 * through the freshest state this map holds and the next sync tick will naturally recompute health
 * again in ≤SYNC_INTERVAL_MS regardless. */
function deriveHealthFromFreshness(prev: AccountRuntimeState, now: number): SyncHealth {
  if (!prev.lastSuccessfulSyncAt) {
    // Never succeeded yet. Only ERROR once we've clearly given it a fair chance (ERROR_AFTER_MS since
    // the FIRST attempt) — otherwise still STARTING, per Section 17's explicit requirement.
    if (!prev.lastAttemptAt) return 'STARTING';
    const sinceFirstAttempt = now - new Date(prev.lastAttemptAt).getTime();
    return sinceFirstAttempt >= ERROR_AFTER_MS ? 'ERROR' : 'STARTING';
  }
  const age = now - new Date(prev.lastSuccessfulSyncAt).getTime();
  if (age >= ERROR_AFTER_MS) return 'ERROR';
  if (age >= DEGRADED_AFTER_MS) return 'DEGRADED';
  return 'HEALTHY';
}

/** One account's sync attempt. Never throws — a network/auth/rate-limit failure updates `syncHealth`
 * and `lastError`, keeps the last known-good `snapshot`/`openOrders` exactly as they were (Section 22
 * — a failed request is never allowed to look like "balance: 0, positions: []"), and returns quietly
 * so the caller's loop over every account is never interrupted by one account's failure. */
async function syncOneAccount(exchangeAccountId: string): Promise<void> {
  const prev = state.get(exchangeAccountId) ?? emptyState(exchangeAccountId);
  const nowIso = new Date().toISOString();

  const resolved = resolvePreferredConnectionForAccount(exchangeAccountId);
  if (!resolved.ok) {
    // Structurally unsyncable (Bug found in the prior read-only audit: exactly this case, e.g. the
    // known BTC/USDT SHORT StrategyOrder's account). No network call is even attempted — DISABLED,
    // not ERROR, since this isn't a transient failure that a retry could ever fix on its own.
    state.set(exchangeAccountId, {
      ...prev, connectionId: null, syncHealth: 'DISABLED',
      lastAttemptAt: nowIso, lastError: { code: 'connection_unresolvable', message: resolved.reason },
    });
    return;
  }
  const connection = getExchangeConnection(resolved.connectionId);
  if (!connection || !connection.enabled) {
    state.set(exchangeAccountId, {
      ...prev, connectionId: resolved.connectionId, syncHealth: 'DISABLED',
      lastAttemptAt: nowIso, lastError: { code: 'connection_disabled', message: '首选连接已被禁用或不存在' },
    });
    return;
  }

  const withAttempt: AccountRuntimeState = { ...prev, connectionId: connection.id, environment: connection.environment, lastAttemptAt: nowIso };

  const [snapResult, ordersResult] = await Promise.all([
    fetchAccountSnapshotImpl(connection.id),
    fetchOpenOrdersImpl(connection.id),
  ]);

  if (!snapResult.ok) {
    const next: AccountRuntimeState = { ...withAttempt, lastError: snapResult.error };
    next.syncHealth = deriveHealthFromFreshness(next, Date.now());
    state.set(exchangeAccountId, next);
    return;
  }

  const next: AccountRuntimeState = {
    ...withAttempt,
    lastSuccessfulSyncAt: nowIso,
    lastError: null,
    snapshot: snapResult.snapshot,
    openOrders: ordersResult.ok ? ordersResult.snapshots : withAttempt.openOrders, // open-orders is best-effort; a failure here alone doesn't invalidate the account snapshot that DID succeed
  };
  next.syncHealth = 'HEALTHY';
  state.set(exchangeAccountId, next);
}

/** Section 20 — every ExchangeAccount is synced independently, keyed by its own id; one account's
 * data is never read/derived from another's request. Runs sequentially per account (not
 * `Promise.all` across accounts) — deliberately conservative request pacing (Section 7: "不要高频轰炸
 * Binance"), and with realistically 1-4 accounts in this app, the difference is milliseconds. */
export async function runExchangeRuntimeSyncOnce(): Promise<void> {
  for (const account of listExchangeAccounts()) {
    await syncOneAccount(account.id);
  }
}

let syncTimer: NodeJS.Timeout | null = null;
export function startExchangeRuntimeSyncLoop(): void {
  if (syncTimer) return;
  syncTimer = setInterval(() => {
    runExchangeRuntimeSyncOnce().catch((err) => console.error('[exchange runtime sync] tick failed:', err?.message || err));
  }, SYNC_INTERVAL_MS);
}
export function stopExchangeRuntimeSyncLoopForTesting(): void {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
}
/** Test-only — clears in-memory state between isolated test runs (this module has no disk file to
 * redirect via a path override, unlike every other store in this codebase, so this is its equivalent
 * of `__set*PathForTesting(null)`). */
export function __resetExchangeRuntimeStateForTesting(): void {
  state.clear();
  __setExchangeServiceFunctionsForTesting(null);
}
/** Test-only — lets executionReadiness.ts's tests (and this module's own) set up a specific
 * syncHealth without a real Binance call. Never used by production code (nothing in server.ts or
 * this file's own sync loop calls it) — the ONLY writer of real state is `syncOneAccount()` above. */
export function __setAccountRuntimeStateForTesting(exchangeAccountId: string, partial: Partial<AccountRuntimeState>): void {
  state.set(exchangeAccountId, { ...emptyState(exchangeAccountId), ...partial });
}

/** Safe projection — never includes anything beyond what `ExchangeAccountSnapshot`/
 * `ExchangeOrderSnapshot` already exposed to the rest of this app (no credential ever enters this
 * module in the first place; `exchangeService.ts`'s existing functions already resolve/redact that
 * boundary). Exists so `server.ts`'s route can return this directly with zero extra filtering logic
 * to get wrong. */
export function toSafeAccountRuntimeView(s: AccountRuntimeState) {
  return {
    exchangeAccountId: s.exchangeAccountId,
    connectionId: s.connectionId,
    environment: s.environment,
    syncHealth: s.syncHealth,
    lastAttemptAt: s.lastAttemptAt,
    lastSuccessfulSyncAt: s.lastSuccessfulSyncAt,
    lastError: s.lastError,
    accountRisk: s.snapshot?.accountRisk ?? null,
    balances: s.snapshot?.balances ?? null,
    positions: s.snapshot?.positions ?? null,
    openOrders: s.openOrders,
  };
}
