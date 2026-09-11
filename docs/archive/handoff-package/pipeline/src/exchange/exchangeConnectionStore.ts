import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import type { ExchangeConnection, ExchangeType, ExchangeEnvironment } from './types.js';

/** Sprint 3.5B — a dedicated exchange-connection store, structurally the same pattern as
 * ai/connectionStore.ts (separate file, `data/` dir, gitignored, id-keyed map, mask-on-read) but
 * NOT sharing that file — exchange credentials (apiKey + apiSecret, both needed to sign requests)
 * are a different, higher-stakes shape than an AI provider's single apiKey, and mixing them into
 * one store would blur "AI gateway credential" with "exchange trading credential" in a way that
 * makes future auditing harder. */

const CONFIG_DIR = 'data';
const CONNECTIONS_PATH = CONFIG_DIR + '/exchange_connections.json';

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
  try {
    const path = resolveConnectionsPath();
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  } catch {}
  return {};
}
function saveConnectionsFile(file: ConnectionsFile): void {
  const path = resolveConnectionsPath();
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2));
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
}
export function createExchangeConnection(input: CreateExchangeConnectionInput): ExchangeConnection {
  const file = loadConnectionsFile();
  const id = randomUUID();
  const now = new Date().toISOString();
  const conn: ExchangeConnection = {
    id, name: input.name, exchange: input.exchange, environment: input.environment,
    apiKey: input.apiKey || undefined, apiSecret: input.apiSecret || undefined,
    enabled: input.enabled !== false,
    createdAt: now, updatedAt: now,
  };
  file[id] = conn;
  saveConnectionsFile(file);
  return conn;
}

export interface UpdateExchangeConnectionInput {
  name?: string; environment?: ExchangeEnvironment; apiKey?: string; apiSecret?: string; enabled?: boolean;
}
/** apiKey/apiSecret in the patch are only applied if real, non-empty, non-masked values — same
 * blank-means-unchanged contract ai/connectionStore.ts's updateConnection() already established
 * (so re-saving the form without retyping a secret never wipes it). */
export function updateExchangeConnection(id: string, patch: UpdateExchangeConnectionInput): ExchangeConnection | undefined {
  const file = loadConnectionsFile();
  const existing = file[id];
  if (!existing) return undefined;
  const next: ExchangeConnection = { ...existing, updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.environment !== undefined) next.environment = patch.environment;
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.apiKey && !looksLikeMaskedKey(patch.apiKey)) next.apiKey = patch.apiKey;
  if (patch.apiSecret && !looksLikeMaskedKey(patch.apiSecret)) next.apiSecret = patch.apiSecret;
  file[id] = next;
  saveConnectionsFile(file);
  return next;
}

export function recordExchangeConnectionTestResult(id: string, result: { status: 'success' | 'error'; error?: { code: string; message: string } }): void {
  const file = loadConnectionsFile();
  const existing = file[id];
  if (!existing) return;
  file[id] = { ...existing, updatedAt: new Date().toISOString(), lastTestAt: new Date().toISOString(), lastTestStatus: result.status, lastTestError: result.error };
  saveConnectionsFile(file);
}

export function deleteExchangeConnection(id: string): { ok: true } | { ok: false; reason: string } {
  const file = loadConnectionsFile();
  if (!file[id]) return { ok: false, reason: '连接不存在' };
  delete file[id];
  saveConnectionsFile(file);
  return { ok: true };
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
  };
}
