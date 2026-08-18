import { randomUUID } from 'node:crypto';
import { getAllStoredConfig } from './configStore.js';
import { readJsonStoreOrDefault, withStoreWriteLock } from '../util/safeJsonStore.js';

/** Sprint 3.3B.2: Connection vs. Model Role are now separate concepts (Product Decision 1).
 * A Connection is "where/how requests are sent" — multiple connections of the same `type` may
 * exist simultaneously (e.g. two different OpenAI-Compatible relays), which the old
 * configStore.ts (Record<providerType, StoredProviderConfig>, exactly one config per type) could
 * never express. This file does NOT replace configStore.ts's provider-keyed storage — that file,
 * and the /api/ai/analyze main engine path that still resolves credentials through it, are
 * untouched this sprint (Task 15: "prepare", not "redesign"). This is a parallel, additive store;
 * see migrateLegacyConfig() below for how the two relate. */

const CONFIG_DIR = 'data';
const CONNECTIONS_PATH = CONFIG_DIR + '/ai_connections.json';
const STORE_NAME = 'AiConnection';

/** Sprint 3.7 — this store previously had no test-isolation override at all (unlike every other
 * store in this codebase), which would have meant any test exercising the real Autonomous Scheduler
 * pipeline (which reads/writes real AIConnections via this exact module) could only do so against
 * REAL production storage — an unacceptable risk this sprint's own safety rules explicitly forbid
 * ("Real stores modified: NO" during coding/testing). Purely additive: an unset override (every
 * existing caller, forever) is byte-for-byte the same behavior as before this sprint. */
let __testStoragePathOverride: string | null = null;
export function __setAiConnectionsPathForTesting(path: string | null): void {
  __testStoragePathOverride = path;
}
function resolveConnectionsPath(): string {
  return __testStoragePathOverride ?? CONNECTIONS_PATH;
}

export type ConnectionType = 'openai-compatible' | 'openai' | 'anthropic' | 'google' | 'deepseek';

export interface AIConnection {
  id: string;
  name: string;
  type: ConnectionType;
  baseUrl?: string;
  apiKey?: string;
  enabled: boolean;
  defaultModel?: string;
  lastTestAt?: string;
  lastTestStatus?: 'connected' | 'failed';
  lastTestError?: { code: string; message: string };
}
type ConnectionsFile = Record<string, AIConnection>;

const LEGACY_DISPLAY_NAMES: Record<string, string> = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', deepseek: 'DeepSeek',
  'openai-compatible': 'OpenAI-Compatible',
};

/** One-time, idempotent migration from the old provider-type-keyed ai_provider_config.json
 * (configStore.ts) into connection records. Never mutates or deletes the old file — it stays on
 * disk exactly as it was, so "existing saved provider configuration must not be silently
 * destroyed" holds trivially (nothing is destroyed, a new derived file is created alongside it).
 * Migrated connection ids deliberately REUSE the legacy provider TYPE string itself (e.g. id
 * 'openai-compatible' for the old 'openai-compatible' entry) — this keeps ids stable across
 * repeated migrations (calling this twice produces the same ids) and lets a pre-existing
 * evidence-parser RoleConfig that still only has `.provider` (the Sprint 3.3B shape, before this
 * sprint introduced `.connectionId`) resolve correctly as a connectionId with zero extra
 * migration step — see evidenceParser.ts's role resolution. */
function migrateLegacyConfig(): ConnectionsFile {
  const legacy = getAllStoredConfig();
  const migrated: ConnectionsFile = {};
  for (const [type, cfg] of Object.entries(legacy)) {
    if (!cfg || (!cfg.apiKey && !cfg.baseUrl && !cfg.defaultModel)) continue; // never migrate an untouched/empty legacy entry
    migrated[type] = {
      id: type,
      name: LEGACY_DISPLAY_NAMES[type] || type,
      type: type as ConnectionType,
      baseUrl: cfg.baseUrl || undefined,
      apiKey: cfg.apiKey || undefined,
      enabled: cfg.enabled !== false,
      defaultModel: cfg.defaultModel || undefined,
      lastTestAt: cfg.lastTestAt,
      lastTestStatus: cfg.lastTestStatus,
      lastTestError: cfg.lastTestError,
    };
  }
  return migrated;
}

const MISSING = Symbol('missing');
/** Sprint 3.8C.2 — a genuine read/parse failure on an EXISTING file now throws `PersistenceError`
 * (via `readJsonStoreOrDefault`) instead of being indistinguishable from "never created yet" and
 * silently triggering the legacy-config migration below, which would overwrite a real, merely-
 * unreadable-at-that-instant file with freshly re-derived (and potentially stale/incomplete)
 * migrated content. Migration only ever runs for the genuine CASE A (file doesn't exist). */
function loadConnectionsFile(): ConnectionsFile {
  const path = resolveConnectionsPath();
  const result = readJsonStoreOrDefault<ConnectionsFile | typeof MISSING>(path, STORE_NAME, MISSING);
  if (result !== MISSING) return result;
  // Sprint 3.7 — under a test override, never fall back to reading/migrating REAL legacy provider
  // config into a test's isolated file; only the real, unoverridden path ever does that migration.
  if (__testStoragePathOverride) return {};
  const migrated = migrateLegacyConfig();
  saveConnectionsFile(migrated); // persist once so ids are stable on every subsequent load, not re-derived each time
  return migrated;
}
function saveConnectionsFile(file: ConnectionsFile): void {
  withStoreWriteLock<ConnectionsFile>(resolveConnectionsPath(), STORE_NAME, {}, () => file);
}

function looksLikeMaskedKey(v: string): boolean {
  return /^\*{12}/.test(v);
}

export function listConnections(): AIConnection[] {
  return Object.values(loadConnectionsFile());
}
export function getConnection(id: string): AIConnection | undefined {
  return loadConnectionsFile()[id];
}

export interface CreateConnectionInput {
  name: string;
  type: ConnectionType;
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
  defaultModel?: string;
}
export function createConnection(input: CreateConnectionInput): AIConnection {
  loadConnectionsFile(); // ensures the one-time legacy migration has already persisted, if this is truly the first-ever call
  const id = randomUUID();
  const conn: AIConnection = {
    id, name: input.name, type: input.type,
    baseUrl: input.baseUrl || undefined, apiKey: input.apiKey || undefined,
    enabled: input.enabled !== false, defaultModel: input.defaultModel || undefined,
  };
  withStoreWriteLock<ConnectionsFile>(resolveConnectionsPath(), STORE_NAME, {}, (file) => {
    file[id] = conn;
    return file;
  });
  return conn;
}

export interface UpdateConnectionInput {
  name?: string; type?: ConnectionType; baseUrl?: string; apiKey?: string; enabled?: boolean; defaultModel?: string;
}
/** apiKey in the patch is only applied if it's a real, non-empty, non-masked value — same
 * blank-means-unchanged contract as configStore.ts's saveProviderConfig(). */
export function updateConnection(id: string, patch: UpdateConnectionInput): AIConnection | undefined {
  loadConnectionsFile();
  let result: AIConnection | undefined;
  withStoreWriteLock<ConnectionsFile>(resolveConnectionsPath(), STORE_NAME, {}, (file) => {
    const existing = file[id];
    if (!existing) { result = undefined; return file; }
    const next: AIConnection = { ...existing };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.type !== undefined) next.type = patch.type;
    if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl || undefined;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.defaultModel !== undefined) next.defaultModel = patch.defaultModel || undefined;
    if (patch.apiKey && !looksLikeMaskedKey(patch.apiKey)) next.apiKey = patch.apiKey;
    file[id] = next;
    result = next;
    return file;
  });
  return result;
}

export function recordConnectionTestResult(id: string, result: { status: 'connected' | 'failed'; error?: { code: string; message: string } }): void {
  loadConnectionsFile();
  withStoreWriteLock<ConnectionsFile>(resolveConnectionsPath(), STORE_NAME, {}, (file) => {
    const existing = file[id];
    if (!existing) return file;
    file[id] = { ...existing, lastTestAt: new Date().toISOString(), lastTestStatus: result.status, lastTestError: result.error };
    return file;
  });
}

/** Reject deletion if any role still references this connection — the caller (server.ts) supplies
 * the actual role-lookup so this file never needs to import roleConfig/evidenceParser logic (no
 * circular dependency). Surfaced as a 409 by the route, never a silent delete-and-orphan. */
export function deleteConnection(id: string, findReferencingRole: (connectionId: string) => string | null): { ok: true } | { ok: false; reason: string } {
  loadConnectionsFile();
  let outcome: { ok: true } | { ok: false; reason: string } = { ok: false, reason: '连接不存在' };
  withStoreWriteLock<ConnectionsFile>(resolveConnectionsPath(), STORE_NAME, {}, (file) => {
    if (!file[id]) { outcome = { ok: false, reason: '连接不存在' }; return file; }
    const referencingRole = findReferencingRole(id);
    if (referencingRole) { outcome = { ok: false, reason: `该连接仍被角色 "${referencingRole}" 引用，请先修改该角色的连接配置` }; return file; }
    delete file[id];
    outcome = { ok: true };
    return file;
  });
  return outcome;
}

/** Fixed-length mask regardless of real key length — same contract as configStore.ts's own
 * maskApiKey(), duplicated rather than imported since connections are a structurally different
 * record (this avoids a cross-file coupling for one three-line function). */
export function maskConnectionApiKey(key: string | undefined): string | null {
  if (!key) return null;
  return '*'.repeat(12) + key.slice(-4);
}

/** Safe, frontend-facing view — apiKey is NEVER included, only hasApiKey + apiKeyMasked. */
export function toSafeConnectionView(c: AIConnection) {
  return {
    id: c.id, name: c.name, type: c.type, baseUrl: c.baseUrl || '', enabled: c.enabled,
    defaultModel: c.defaultModel || '', hasApiKey: !!c.apiKey, apiKeyMasked: maskConnectionApiKey(c.apiKey),
    lastTestAt: c.lastTestAt || null, lastTestStatus: c.lastTestStatus || null, lastTestError: c.lastTestError || null,
  };
}
