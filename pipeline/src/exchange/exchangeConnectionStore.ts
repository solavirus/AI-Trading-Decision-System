import { randomUUID } from 'node:crypto';
import type { ExchangeConnection, ExchangeType, ExchangeEnvironment } from './types.js';
import { readJsonStoreOrDefault, withStoreWriteLock } from '../util/safeJsonStore.js';

/** Sprint 3.5B — a dedicated exchange-connection store, structurally the same pattern as
 * ai/connectionStore.ts (separate file, `data/` dir, gitignored, id-keyed map, mask-on-read) but
 * NOT sharing that file — exchange credentials (apiKey + apiSecret, both needed to sign requests)
 * are a different, higher-stakes shape than an AI provider's single apiKey, and mixing them into
 * one store would blur "AI gateway credential" with "exchange trading credential" in a way that
 * makes future auditing harder.
 *
 * Sprint 3.8C.2 — migrated to `util/safeJsonStore.ts` (Section 23 of the spec: Account Identity
 * migration must not keep using the unsafe writeFileSync path just because the Persistence half of
 * this sprint touched other stores first). Reads throw `PersistenceError` on a genuine corrupt/
 * unreadable file instead of silently returning `{}`; writes are atomic + lock-protected. Referential
 * integrity toward ExchangeAccount.preferredConnectionId on delete is deliberately NOT handled inside
 * this file — see `deleteExchangeConnection()`'s own comment — it lives in server.ts's DELETE route,
 * which already imports both this store and exchangeAccountStore.ts, so that neither store needs a
 * circular import on the other. */

const CONFIG_DIR = 'data';
const CONNECTIONS_PATH = CONFIG_DIR + '/exchange_connections.json';
const STORE_NAME = 'ExchangeConnection';

/** Hotfix (test-storage isolation) — `CONNECTIONS_PATH` was a hardcoded relative literal with no way
 * for a test to redirect it, so any test importing this module's real functions directly (not through
 * a mock) wrote straight into whatever `data/exchange_connections.json` happened to resolve to under
 * the process's cwd — including the real one, if a test happened to run from `pipeline/`. This is
 * exactly how a stray `"ValidConn"` connection ended up in real production storage.
 * `__testStoragePathOverride` defaults to `null`, so production behavior (the exact path above) is
 * 100% unchanged unless a test explicitly opts in via `__setExchangeConnectionsPathForTesting()`. No
 * other function in this file changed. */
let __testStoragePathOverride: string | null = null;
export function __setExchangeConnectionsPathForTesting(path: string | null): void {
  __testStoragePathOverride = path;
}
function resolveConnectionsPath(): string {
  return __testStoragePathOverride ?? CONNECTIONS_PATH;
}

type ConnectionsFile = Record<string, ExchangeConnection>;

function loadConnectionsFile(): ConnectionsFile {
  return readJsonStoreOrDefault<ConnectionsFile>(resolveConnectionsPath(), STORE_NAME, {});
}

function looksLikeMaskedKey(v: string): boolean {
  return /^\*{12}/.test(v);
}

export function listExchangeConnections(): ExchangeConnection[] {
  return Object.values(loadConnectionsFile());
}
export function getExchangeConnection(id: string): ExchangeConnection | undefined {
  return loadConnectionsFile()[id];
}

export interface CreateExchangeConnectionInput {
  name: string;
  exchange: ExchangeType;
  environment: ExchangeEnvironment;
  apiKey?: string;
  apiSecret?: string;
  enabled?: boolean;
  /** Sprint 3.6A.2 — set by exchangeAccountService.ts after resolving/creating the bound
   * ExchangeAccount; this store itself never decides account identity, only persists the result. */
  exchangeAccountId?: string | null;
}
export function createExchangeConnection(input: CreateExchangeConnectionInput): ExchangeConnection {
  const id = randomUUID();
  const now = new Date().toISOString();
  const conn: ExchangeConnection = {
    id, name: input.name, exchange: input.exchange, environment: input.environment,
    apiKey: input.apiKey || undefined, apiSecret: input.apiSecret || undefined,
    enabled: input.enabled !== false,
    createdAt: now, updatedAt: now,
    exchangeAccountId: input.exchangeAccountId ?? null,
  };
  withStoreWriteLock<ConnectionsFile>(resolveConnectionsPath(), STORE_NAME, {}, (file) => {
    file[id] = conn;
    return file;
  });
  return conn;
}

export interface UpdateExchangeConnectionInput {
  name?: string; environment?: ExchangeEnvironment; apiKey?: string; apiSecret?: string; enabled?: boolean;
  exchangeAccountId?: string | null;
}
/** apiKey/apiSecret in the patch are only applied if real, non-empty, non-masked values — same
 * blank-means-unchanged contract ai/connectionStore.ts's updateConnection() already established
 * (so re-saving the form without retyping a secret never wipes it). */
export function updateExchangeConnection(id: string, patch: UpdateExchangeConnectionInput): ExchangeConnection | undefined {
  let result: ExchangeConnection | undefined;
  withStoreWriteLock<ConnectionsFile>(resolveConnectionsPath(), STORE_NAME, {}, (file) => {
    const existing = file[id];
    if (!existing) { result = undefined; return file; }
    const next: ExchangeConnection = { ...existing, updatedAt: new Date().toISOString() };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.environment !== undefined) next.environment = patch.environment;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.apiKey && !looksLikeMaskedKey(patch.apiKey)) next.apiKey = patch.apiKey;
    if (patch.apiSecret && !looksLikeMaskedKey(patch.apiSecret)) next.apiSecret = patch.apiSecret;
    if (patch.exchangeAccountId !== undefined) next.exchangeAccountId = patch.exchangeAccountId;
    file[id] = next;
    result = next;
    return file;
  });
  return result;
}

export function recordExchangeConnectionTestResult(id: string, result: { status: 'success' | 'error'; error?: { code: string; message: string } }): void {
  withStoreWriteLock<ConnectionsFile>(resolveConnectionsPath(), STORE_NAME, {}, (file) => {
    const existing = file[id];
    if (!existing) return file;
    file[id] = { ...existing, updatedAt: new Date().toISOString(), lastTestAt: new Date().toISOString(), lastTestStatus: result.status, lastTestError: result.error };
    return file;
  });
}

/** Sprint 3.8C.2, Section 22 — deliberately NOT the place referential-integrity cleanup happens.
 * This function only ever deletes this one connection's own record, safely (locked + atomic) — it
 * does not know about, and must not reach into, ExchangeAccount.preferredConnectionId (that would
 * require importing exchangeAccountStore.ts, which already imports THIS file, and a circular import
 * between the two stores is exactly the kind of accidental complexity Section 9 warns against).
 * server.ts's `DELETE /api/exchange/connections/:id` route — which already imports both stores —
 * is responsible for: (1) checking whether any ExchangeAccount currently has this connection as its
 * preferredConnectionId, (2) if that account has another connection available, refusing the delete
 * and asking the user to explicitly pick a new preferred connection first (never silently falling
 * back), (3) if it has no other connection, nulling out preferredConnectionId FIRST via
 * `updateExchangeAccount()`, and only THEN calling this function — so a failure at step (3) leaves
 * the previous, fully-consistent state untouched instead of a half-migrated dangling reference. */
export function deleteExchangeConnection(id: string): { ok: true } | { ok: false; reason: string } {
  let outcome: { ok: true } | { ok: false; reason: string } = { ok: false, reason: '连接不存在' };
  withStoreWriteLock<ConnectionsFile>(resolveConnectionsPath(), STORE_NAME, {}, (file) => {
    if (!file[id]) { outcome = { ok: false, reason: '连接不存在' }; return file; }
    delete file[id];
    outcome = { ok: true };
    return file;
  });
  return outcome;
}

function maskSecret(key: string | undefined): string | null {
  if (!key) return null;
  return '*'.repeat(12) + key.slice(-4);
}

/** Safe, frontend-facing view. apiKey is masked (same contract as AI Connections); apiSecret is
 * NEVER returned in any form, not even masked — the frontend only ever needs to know whether one
 * is configured (`hasApiSecret`), never what it looks like. */
export function toSafeExchangeConnectionView(c: ExchangeConnection) {
  return {
    id: c.id, name: c.name, exchange: c.exchange, environment: c.environment, enabled: c.enabled,
    hasApiKey: !!c.apiKey, apiKeyMasked: maskSecret(c.apiKey), hasApiSecret: !!c.apiSecret,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
    lastTestAt: c.lastTestAt || null, lastTestStatus: c.lastTestStatus || null, lastTestError: c.lastTestError || null,
    exchangeAccountId: c.exchangeAccountId || null, // Sprint 3.6A.2 — not a secret, safe to expose as-is
  };
}
