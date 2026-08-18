import { randomUUID } from 'node:crypto';
import type { ExchangeAccount, ExchangeType, ExchangeEnvironment } from './types.js';
import { listExchangeConnections, updateExchangeConnection, getExchangeConnection } from './exchangeConnectionStore.js';
import { readJsonStoreOrDefault, withStoreWriteLock } from '../util/safeJsonStore.js';

/** Sprint 3.6A.2 — Exchange Account Identity Foundation. Same isolation/storage discipline as
 * exchangeConnectionStore.ts (separate `data/` file, gitignored, id-keyed map), deliberately a
 * SEPARATE file/override from it — an account-store test can be isolated independently of a
 * connection-store test, and vice versa, without either accidentally sharing state.
 *
 * Sprint 3.8C.2 — migrated to `util/safeJsonStore.ts` (see strategyOrderStore.ts's own comment for
 * the full incident this fixes across every store in this project, not just this one): reads throw
 * `PersistenceError` on a genuine corrupt/unreadable file instead of silently returning `{}`; writes
 * go through a same-directory atomic temp-file+rename inside a short cross-process lock. */

const CONFIG_DIR = 'data';
const ACCOUNTS_PATH = CONFIG_DIR + '/exchange_accounts.json';
const STORE_NAME = 'ExchangeAccount';

let __testStoragePathOverride: string | null = null;
export function __setExchangeAccountsPathForTesting(path: string | null): void {
  __testStoragePathOverride = path;
}
function resolveAccountsPath(): string {
  return __testStoragePathOverride ?? ACCOUNTS_PATH;
}

type AccountsFile = Record<string, ExchangeAccount>;

function loadAccountsFile(): AccountsFile {
  return readJsonStoreOrDefault<AccountsFile>(resolveAccountsPath(), STORE_NAME, {});
}

export function listExchangeAccountsRaw(): ExchangeAccount[] {
  return Object.values(loadAccountsFile());
}
export function getExchangeAccount(id: string): ExchangeAccount | undefined {
  return loadAccountsFile()[id];
}

export interface CreateExchangeAccountInput {
  exchange: ExchangeType;
  environment: ExchangeEnvironment;
  displayName: string;
  preferredConnectionId?: string | null;
}
export function createExchangeAccount(input: CreateExchangeAccountInput): ExchangeAccount {
  const id = randomUUID();
  const now = new Date().toISOString();
  const acc: ExchangeAccount = {
    id, exchange: input.exchange, environment: input.environment, displayName: input.displayName,
    preferredConnectionId: input.preferredConnectionId ?? null,
    createdAt: now, updatedAt: now,
  };
  withStoreWriteLock<AccountsFile>(resolveAccountsPath(), STORE_NAME, {}, (file) => {
    file[id] = acc;
    return file;
  });
  return acc;
}

export interface UpdateExchangeAccountInput {
  displayName?: string;
  preferredConnectionId?: string | null;
}
export function updateExchangeAccount(id: string, patch: UpdateExchangeAccountInput): ExchangeAccount | undefined {
  let result: ExchangeAccount | undefined;
  withStoreWriteLock<AccountsFile>(resolveAccountsPath(), STORE_NAME, {}, (file) => {
    const existing = file[id];
    if (!existing) { result = undefined; return file; }
    const next: ExchangeAccount = { ...existing, updatedAt: new Date().toISOString() };
    if (patch.displayName !== undefined) next.displayName = patch.displayName;
    if (patch.preferredConnectionId !== undefined) next.preferredConnectionId = patch.preferredConnectionId;
    file[id] = next;
    result = next;
    return file;
  });
  return result;
}

/** Sprint 3.8C.2, Section 25 — the one place a whole ExchangeAccount record is ever removed. Kept
 * deliberately minimal (no cascading checks here) — callers (server.ts's cleanup route/script) are
 * responsible for having already verified zero references before calling this; this function itself
 * only guarantees the deletion write is safe (locked, atomic), not that it was a good idea to call. */
export function deleteExchangeAccount(id: string): { ok: true } | { ok: false; reason: string } {
  let outcome: { ok: true } | { ok: false; reason: string } = { ok: false, reason: '账户不存在' };
  withStoreWriteLock<AccountsFile>(resolveAccountsPath(), STORE_NAME, {}, (file) => {
    if (!file[id]) { outcome = { ok: false, reason: '账户不存在' }; return file; }
    delete file[id];
    outcome = { ok: true };
    return file;
  });
  return outcome;
}

/** Task 6/7 of the Phase 1 investigation report, now implemented conservatively: every
 * ExchangeConnection that does not yet have an `exchangeAccountId` gets its own brand-new, 1:1
 * ExchangeAccount — never merged with any other connection's account, never guessed. Additive-only:
 * never touches a connection that already has an `exchangeAccountId`, never deletes/merges an
 * existing ExchangeAccount, never makes a Binance request, never reads a credential value. This is
 * intentionally NOT a one-shot migration script — it is ordinary, deterministic store logic — but as
 * of Sprint 3.6A.2.1 it is called exactly once, at backend process startup (`server.ts`), never from
 * inside a GET/read route. It remains idempotent (safe to call again on the next process start,
 * including a `tsx watch` restart) precisely because ordinary request-time GET routes no longer call
 * it — idempotency is what makes startup-only invocation safe, not a license to call it from a read
 * path again in the future. */
export function ensureAccountsBootstrapped(): void {
  const connections = listExchangeConnections();
  for (const conn of connections) {
    if (conn.exchangeAccountId) continue;
    const acc = createExchangeAccount({
      exchange: conn.exchange, environment: conn.environment,
      displayName: conn.name, preferredConnectionId: conn.id,
    });
    updateExchangeConnection(conn.id, { exchangeAccountId: acc.id });
  }
}

/** Sprint 3.6A.2.1 — Hotfix: this is now a PURE read, never a mutation. It used to call
 * `ensureAccountsBootstrapped()` on every invocation, which meant an ordinary `GET
 * /api/exchange/accounts`/`GET /api/exchange/connections` request could silently create an
 * ExchangeAccount or write to `ExchangeConnection.exchangeAccountId` — an implicit persistent write
 * hiding inside a read path. Bootstrap now runs exactly once, at backend process startup
 * (`server.ts`, right before `server.listen()`), never per-request. Every route that used to rely on
 * this function bootstrapping-on-read now simply assumes bootstrap already happened at startup — safe
 * because bootstrap is additive-only (per-connection, idempotent) and startup always runs before any
 * request can be served. */
export function listExchangeAccounts(): ExchangeAccount[] {
  return listExchangeAccountsRaw();
}

/** Sprint 3.8C — moved here (verbatim, no behavior change) from monitorEngine.ts, where it was
 * originally added in Sprint 3.6B, so both monitorEngine.ts's own trigger-time resolution AND the
 * new executionReadiness.ts (Sprint 3.8C) can share ONE implementation without a circular import
 * between strategy/ and exchange/. monitorEngine.ts and autonomousScheduler.ts both keep importing
 * this exact name from monitorEngine.ts via a re-export, so neither of those files' own imports had
 * to change. Same "explicit preferredConnectionId, never implicit `.find()`" discipline as the
 * frontend's `resolvePreferredConnectionForAccount()` (Sprint 3.6A.2) — a missing/disabled preferred
 * connection BLOCKS, never silently substitutes another connection for a write. */
export function resolvePreferredConnectionForAccount(exchangeAccountId: string): { ok: true; connectionId: string } | { ok: false; reason: string } {
  const account = getExchangeAccount(exchangeAccountId);
  if (!account) return { ok: false, reason: 'ExchangeAccount 不存在' };
  if (!account.preferredConnectionId) return { ok: false, reason: '账户未设置首选连接' };
  const conn = getExchangeConnection(account.preferredConnectionId);
  if (!conn) return { ok: false, reason: '首选连接不存在（可能已被删除）' };
  if (!conn.enabled) return { ok: false, reason: '首选连接已被禁用' };
  if (conn.exchangeAccountId !== account.id) return { ok: false, reason: '首选连接与账户绑定不一致' };
  return { ok: true, connectionId: conn.id };
}

/** Sprint 3.8C.2, Section 18 — "is this ExchangeAccount usable for a NEW StrategyOrder right now?"
 * Structural checks only (existence/enabled/environment consistency) — does NOT consider Exchange
 * Runtime Sync health (that layer lives in `exchange/exchangeRuntimeSync.ts`, which itself imports
 * this function; keeping the runtime-health opinion OUT of this file avoids a circular import and
 * keeps this a pure, cheap, no-I/O-beyond-the-JSON-stores check). Callers that also care about
 * runtime sync health (e.g. `executionReadiness.ts`) layer that check on top of this one. */
export function isExchangeAccountStructurallyUsable(exchangeAccountId: string): boolean {
  const resolved = resolvePreferredConnectionForAccount(exchangeAccountId);
  if (!resolved.ok) return false;
  const conn = getExchangeConnection(resolved.connectionId);
  return !!conn && conn.environment === 'TESTNET';
}

/** Sprint 3.8C.2, Section 19 — `usable` lets the frontend distinguish "币安 · TESTNET · 可执行" from
 * "连接已失效" without itself re-deriving the same structural checks `isExchangeAccountStructurallyUsable()`
 * already encodes (Section 18's exact usability definition, kept in ONE place). */
export function toSafeExchangeAccountView(a: ExchangeAccount) {
  return {
    id: a.id, exchange: a.exchange, environment: a.environment, displayName: a.displayName,
    preferredConnectionId: a.preferredConnectionId || null,
    usable: isExchangeAccountStructurallyUsable(a.id),
    createdAt: a.createdAt, updatedAt: a.updatedAt,
  };
}

/** Sprint 3.6A.2 — the one place a connection's `exchangeAccountId` is ever resolved (moved here from
 * server.ts so it's a real, independently testable, non-request-scoped function rather than a closure
 * re-created on every HTTP request). Never guesses: `accountBinding` omitted -> a brand-new 1:1
 * account (the same conservative default `ensureAccountsBootstrapped()` uses for a pre-existing
 * connection); `mode:'NEW'` -> explicit new account; `mode:'EXISTING'` -> explicit bind, hard-rejected
 * if exchange/environment don't match (TESTNET and LIVE can never share one ExchangeAccount — Task 5
 * of the Phase 1 investigation). `currentExchangeAccountId` lets an update (PUT) keep an
 * already-compatible binding untouched without the caller having to resend it every time. */
export function resolveAccountBindingForConnection(opts: {
  accountBinding: any; exchange: ExchangeType; environment: ExchangeEnvironment;
  fallbackDisplayName: string; currentExchangeAccountId?: string | null;
}): { ok: true; exchangeAccountId: string } | { ok: false; error: string } {
  const { accountBinding, exchange, environment, fallbackDisplayName, currentExchangeAccountId } = opts;
  if (!accountBinding) {
    if (currentExchangeAccountId) {
      const acc = getExchangeAccount(currentExchangeAccountId);
      if (acc && acc.exchange === exchange && acc.environment === environment) return { ok: true, exchangeAccountId: currentExchangeAccountId };
      if (acc) return { ok: false, error: '连接的 exchange/environment 已变更，与当前绑定账户不一致，请明确选择新建账户或绑定到其他已有账户' };
    }
    const acc = createExchangeAccount({ exchange, environment, displayName: fallbackDisplayName });
    return { ok: true, exchangeAccountId: acc.id };
  }
  if (accountBinding.mode === 'NEW') {
    const displayName = typeof accountBinding.displayName === 'string' && accountBinding.displayName.trim() ? accountBinding.displayName.trim() : fallbackDisplayName;
    const acc = createExchangeAccount({ exchange, environment, displayName });
    return { ok: true, exchangeAccountId: acc.id };
  }
  if (accountBinding.mode === 'EXISTING') {
    const targetId = typeof accountBinding.exchangeAccountId === 'string' ? accountBinding.exchangeAccountId : '';
    if (!targetId) return { ok: false, error: '缺少要绑定的 exchangeAccountId' };
    const acc = getExchangeAccount(targetId);
    if (!acc) return { ok: false, error: '要绑定的账户不存在' };
    if (acc.exchange !== exchange || acc.environment !== environment) return { ok: false, error: '不允许绑定到 exchange/environment 不一致的账户（TESTNET 与 LIVE 不能共用同一账户）' };
    return { ok: true, exchangeAccountId: acc.id };
  }
  return { ok: false, error: 'accountBinding.mode 必须为 NEW 或 EXISTING' };
}
