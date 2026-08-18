/** Sprint 3.6B.1, Section 6 — backend-persisted AUTO Risk Policy. Deliberately separate from the
 * existing manual Risk Guard settings (`qa_risk_settings`, browser localStorage) — migrating that
 * whole model backend would expand scope well beyond "make AUTO safe and headless" (Section 6: "Do
 * NOT necessarily migrate the entire existing manual Risk Guard configuration"). This is the ONLY
 * settings object that gates `MONITORED_AUTO` submission; the manual execution path is unaffected. */
import { readJsonStoreOrDefault, withStoreWriteLock } from '../util/safeJsonStore.js';

const CONFIG_DIR = 'data';
const POLICY_PATH = CONFIG_DIR + '/strategy_auto_risk_policy.json';
const STORE_NAME = 'AutoRiskPolicy';

let __testStoragePathOverride: string | null = null;
export function __setAutoRiskPolicyPathForTesting(path: string | null): void {
  __testStoragePathOverride = path;
}
function resolvePath(): string {
  return __testStoragePathOverride ?? POLICY_PATH;
}

export interface AutoRiskPolicy {
  enabled: boolean;
  environment: 'TESTNET'; // frozen — AUTO never supports LIVE, not even as a configurable value
  allowedSymbols: string[]; // empty = nothing allowed yet (fail-closed default, never "everything")
  maxNotionalPerTrade: number | null;
  maxLeverage: number | null;
  maxActiveTrades: number | null;
  maxRiskPerTrade: number | null; // USDT, deterministic: |entryPrice - stopLoss| / entryPrice * positionSizeUsdt when both are known
  autoEntryEnabled: boolean;
  autoProtectionEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Every limit starts at its safest value: policy OFF, zero allowed symbols, entry/protection both
 * off. AUTO is opt-in at every layer, never opt-out. */
export function defaultAutoRiskPolicy(): AutoRiskPolicy {
  const now = new Date().toISOString();
  return {
    enabled: false, environment: 'TESTNET', allowedSymbols: [],
    maxNotionalPerTrade: null, maxLeverage: null, maxActiveTrades: null, maxRiskPerTrade: null,
    autoEntryEnabled: false, autoProtectionEnabled: true,
    createdAt: now, updatedAt: now,
  };
}

export function getAutoRiskPolicy(): AutoRiskPolicy {
  const raw = readJsonStoreOrDefault<Partial<AutoRiskPolicy>>(resolvePath(), STORE_NAME, defaultAutoRiskPolicy());
  return { ...defaultAutoRiskPolicy(), ...raw, environment: 'TESTNET' };
}

export interface UpdateAutoRiskPolicyInput {
  enabled?: boolean;
  allowedSymbols?: string[];
  maxNotionalPerTrade?: number | null;
  maxLeverage?: number | null;
  maxActiveTrades?: number | null;
  maxRiskPerTrade?: number | null;
  autoEntryEnabled?: boolean;
  autoProtectionEnabled?: boolean;
}
export function updateAutoRiskPolicy(patch: UpdateAutoRiskPolicyInput): AutoRiskPolicy {
  return withStoreWriteLock<AutoRiskPolicy>(resolvePath(), STORE_NAME, defaultAutoRiskPolicy(), (current) => {
    return { ...defaultAutoRiskPolicy(), ...current, ...patch, environment: 'TESTNET', updatedAt: new Date().toISOString() };
  });
}
