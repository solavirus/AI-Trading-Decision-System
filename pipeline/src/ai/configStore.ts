import { readJsonStoreOrDefault, withStoreWriteLock } from '../util/safeJsonStore.js';

/** Sprint 3.1B.1: persisted, UI-editable provider configuration — a JSON file, not a database
 * (explicitly not required per this sprint's scope), gitignored the same way `data/etf_flows.
 * sqlite` and `.env` already are (confirmed: `data/` and `.env` are both in .gitignore). Survives
 * backend restart. This is a SECOND configuration layer on top of Sprint 3.1B's pure-env-var
 * setup, not a replacement — every effective-value getter below falls through to the env var,
 * then to an official default, so a deployment that never touches this file (or the new Settings
 * page) behaves exactly as it did before this sprint.
 *
 * Sprint 3.8C.2 — migrated both stores in this file (provider config + role config below) to
 * `util/safeJsonStore.ts`: a genuine read failure now throws `PersistenceError` instead of being
 * treated as "no config saved yet", and writes are atomic + lock-protected. */

const CONFIG_DIR = 'data';
const CONFIG_PATH = CONFIG_DIR + '/ai_provider_config.json';
const CONFIG_STORE_NAME = 'AiProviderConfig';

export interface StoredProviderConfig {
  enabled?: boolean;
  baseUrl?: string;
  defaultModel?: string;
  apiKey?: string;
  lastTestAt?: string;
  lastTestStatus?: 'connected' | 'failed';
  lastTestError?: { code: string; message: string };
}
type ConfigFile = Record<string, StoredProviderConfig>;

function loadConfigFile(): ConfigFile {
  return readJsonStoreOrDefault<ConfigFile>(CONFIG_PATH, CONFIG_STORE_NAME, {});
}

/** A masked key (`************abcd`) accidentally round-tripped back from the frontend must never
 * be saved as if it were a real new key — this is the defense-in-depth check on the backend side;
 * the frontend's own design (API Key input always starts blank, never pre-filled with the mask)
 * is the primary guard, this is the belt-and-suspenders one. */
function looksLikeMaskedKey(v: string): boolean {
  return /^\*{12}/.test(v);
}

export function getStoredProviderConfig(provider: string): StoredProviderConfig {
  return loadConfigFile()[provider] || {};
}

export function getAllStoredConfig(): ConfigFile {
  return loadConfigFile();
}

export interface ProviderConfigPatch {
  enabled?: boolean;
  baseUrl?: string;
  defaultModel?: string;
  apiKey?: string;
}
/** apiKey in the patch is only applied if it's a real, non-empty, non-masked value — an absent or
 * blank apiKey means "keep the existing stored key unchanged", per the spec's masking contract. */
export function saveProviderConfig(provider: string, patch: ProviderConfigPatch): StoredProviderConfig {
  let next: StoredProviderConfig = {};
  withStoreWriteLock<ConfigFile>(CONFIG_PATH, CONFIG_STORE_NAME, {}, (cfg) => {
    const existing = cfg[provider] || {};
    next = { ...existing };
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl;
    if (patch.defaultModel !== undefined) next.defaultModel = patch.defaultModel;
    if (patch.apiKey && !looksLikeMaskedKey(patch.apiKey)) next.apiKey = patch.apiKey;
    cfg[provider] = next;
    return cfg;
  });
  return next;
}

export function recordTestResult(provider: string, result: { status: 'connected' | 'failed'; error?: { code: string; message: string } }): void {
  withStoreWriteLock<ConfigFile>(CONFIG_PATH, CONFIG_STORE_NAME, {}, (cfg) => {
    const existing = cfg[provider] || {};
    cfg[provider] = { ...existing, lastTestAt: new Date().toISOString(), lastTestStatus: result.status, lastTestError: result.error };
    return cfg;
  });
}

const ENV_KEY_NAMES: Record<string, string> = {
  openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GOOGLE_AI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY', 'openai-compatible': 'CUSTOM_AI_API_KEY',
};
const ENV_BASE_URL_NAMES: Record<string, string> = {
  openai: 'OPENAI_BASE_URL', anthropic: 'ANTHROPIC_BASE_URL', google: 'GOOGLE_AI_BASE_URL',
  deepseek: 'DEEPSEEK_BASE_URL', 'openai-compatible': 'CUSTOM_AI_BASE_URL',
};

/** Resolution order: Settings-file value -> env var -> undefined (not configured). */
export function getEffectiveApiKey(provider: string): string | undefined {
  const stored = getStoredProviderConfig(provider).apiKey;
  if (stored) return stored;
  const envName = ENV_KEY_NAMES[provider];
  return envName ? process.env[envName] : undefined;
}

/** Resolution order: Settings-file value -> env var -> officialDefault (may be undefined, e.g.
 * for openai-compatible, which has no official endpoint to fall back to). */
export function getEffectiveBaseUrl(provider: string, officialDefault?: string): string | undefined {
  const stored = getStoredProviderConfig(provider).baseUrl;
  if (stored) return stored;
  const envName = ENV_BASE_URL_NAMES[provider];
  const envVal = envName ? process.env[envName] : undefined;
  return envVal || officialDefault;
}

export function getEffectiveDefaultModel(provider: string): string | undefined {
  return getStoredProviderConfig(provider).defaultModel;
}

/** Undefined/never-configured defaults to true — a pure-env-var setup that has never touched the
 * Settings page must keep working exactly as it did before this sprint. */
export function getEffectiveEnabled(provider: string): boolean {
  const stored = getStoredProviderConfig(provider).enabled;
  return stored === undefined ? true : stored;
}

/** Fixed-length mask regardless of real key length, so length itself isn't leaked either. */
export function maskApiKey(key: string | undefined): string | null {
  if (!key) return null;
  return '*'.repeat(12) + key.slice(-4);
}

/** Sprint 3.3B: model "roles" — which already-configured provider+model a specific purpose (e.g.
 * the Image Evidence Parser) should route to. Deliberately a SEPARATE small file, not a new field
 * shape inside ai_provider_config.json's ConfigFile (which is strictly Record<providerId,
 * StoredProviderConfig> — a role isn't a provider identity, it's a pointer at one). Same directory,
 * same load/save pattern, same `data/` gitignore coverage as the provider config file. A role never
 * stores its own apiKey/baseUrl — those keep coming from the pointed-at provider's own config via
 * getEffectiveApiKey()/getEffectiveBaseUrl() above, so credentials are configured in exactly one
 * place regardless of how many roles point at that provider. */
const ROLE_CONFIG_PATH = CONFIG_DIR + '/ai_role_config.json';
const ROLE_CONFIG_STORE_NAME = 'AiRoleConfig';

/** Sprint 3.7 — same rationale as connectionStore.ts's identical addition: no prior test-isolation
 * override existed here, and the Autonomous Scheduler reads this exact module (`getRoleConfig('main-analysis')`)
 * on every cycle. Unset (every existing caller) is byte-for-byte unchanged behavior. */
let __testRoleConfigPathOverride: string | null = null;
export function __setAiRoleConfigPathForTesting(path: string | null): void {
  __testRoleConfigPathOverride = path;
}
function resolveRoleConfigPath(): string {
  return __testRoleConfigPathOverride ?? ROLE_CONFIG_PATH;
}

export interface RoleConfig {
  /** Sprint 3.3B.2: the current, canonical field — points at an AIConnection id (connectionStore.ts).
   * `provider` below is kept only for reading role records saved before this sprint (Sprint 3.3B
   * stored `{provider, model}`, no connectionId). Nothing writes `provider` anymore; a role saved
   * from now on always has `connectionId` only. Readers should treat `connectionId || provider` as
   * the effective connection id — this works because migrated connections (connectionStore.ts's
   * migrateLegacyConfig()) reuse the legacy provider TYPE string as their connection id. */
  connectionId?: string;
  provider?: string;
  model?: string;
}
type RoleConfigFile = Record<string, RoleConfig>;

function loadRoleConfigFile(): RoleConfigFile {
  return readJsonStoreOrDefault<RoleConfigFile>(resolveRoleConfigPath(), ROLE_CONFIG_STORE_NAME, {});
}

export function getRoleConfig(role: string): RoleConfig {
  return loadRoleConfigFile()[role] || {};
}

export function saveRoleConfig(role: string, patch: RoleConfig): RoleConfig {
  let next: RoleConfig = {};
  withStoreWriteLock<RoleConfigFile>(resolveRoleConfigPath(), ROLE_CONFIG_STORE_NAME, {}, (cfg) => {
    next = { ...(cfg[role] || {}), ...patch };
    cfg[role] = next;
    return cfg;
  });
  return next;
}
