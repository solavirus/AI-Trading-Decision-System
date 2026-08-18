/** Sprint 3.7, Section 15/16 — backend-persisted Autonomous Trading permission + limits. Deliberately
 * separate from `autoRiskPolicyStore.ts` (MONITORED_AUTO's own standing policy) — they gate different
 * things (this gates "may the scheduler create/submit a Strategy with NO per-Strategy user click at
 * all", the existing one gates "is a specific already-authorized Strategy's submission within limits
 * right now"). Both remain independently enforced; AUTONOMOUS never weakens or replaces
 * `AutoRiskPolicy` — `evaluateAutoRiskPolicy()` still runs, unchanged, for every AUTONOMOUS submission
 * exactly like every MONITORED_AUTO one (Section 16: "优先复用现有 backend AUTO Risk Policy... 不要再造
 * 第二套"). Same JSON-file-on-disk, fail-closed-by-default discipline as every other store here. */
import { readJsonStoreOrDefault, withStoreWriteLock } from '../util/safeJsonStore.js';

const CONFIG_DIR = 'data';
const POLICY_PATH = CONFIG_DIR + '/strategy_autonomous_policy.json';
const STORE_NAME = 'AutonomousPolicy';

let __testStoragePathOverride: string | null = null;
export function __setAutonomousPolicyPathForTesting(path: string | null): void {
  __testStoragePathOverride = path;
}
function resolvePath(): string {
  return __testStoragePathOverride ?? POLICY_PATH;
}

export interface AutonomousPolicy {
  autonomousEnabled: boolean;
  environment: 'TESTNET'; // frozen — Section 40, no LIVE autonomous ever, not even as a configurable value
  exchangeAccountId: string | null; // which ExchangeAccount the scheduler reads/trades under — null = fail-closed, gate blocks
  allowedSymbols: string[]; // empty = nothing allowed yet (fail-closed default)
  analysisIntervalHours: number; // Section 5 — default 4, kept configurable
  allowLong: boolean;
  allowShort: boolean;
  allowOpen: boolean; // Section 15 — a false value still allows WAIT-only cycles, never OPEN
  maxAutonomousStrategies: number | null; // Section 16 — total concurrently-active AUTONOMOUS StrategyOrders, null = unlimited
  cooldownAfterTradeMinutes: number | null; // Section 16 — null = no cooldown
  /** Sprint 3.9 — additive. The unified Analysis Pipeline's `ScenarioPlan` never carries a position
   * size or leverage (Core Truth Rule, unchanged: "AI 从不建议具体仓位" — see
   * `prototype/index.html`'s `openArmStrategyModal()`), the same as Manual, where the USER types
   * these into the Arm form. AUTONOMOUS has no user to ask, so it needs an explicit,
   * policy-configured default instead — never falls back to a value the AI proposed. `null` (the
   * fail-closed default) means the scheduler cannot create any NEW entry order at all until an
   * operator sets a real number here; Position Management (which never opens a new position) is
   * unaffected by this gate. */
  defaultPositionSizeUsdt: number | null;
  defaultLeverage: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Every limit starts at its safest value: autonomous OFF, no account bound, zero allowed symbols, no
 * OPEN. Opt-in at every layer, never opt-out, same discipline as `defaultAutoRiskPolicy()`. */
export function defaultAutonomousPolicy(): AutonomousPolicy {
  const now = new Date().toISOString();
  return {
    autonomousEnabled: false, environment: 'TESTNET', exchangeAccountId: null, allowedSymbols: [],
    analysisIntervalHours: 4, allowLong: true, allowShort: true, allowOpen: false,
    maxAutonomousStrategies: null, cooldownAfterTradeMinutes: null,
    defaultPositionSizeUsdt: null, defaultLeverage: null,
    createdAt: now, updatedAt: now,
  };
}

export function getAutonomousPolicy(): AutonomousPolicy {
  const raw = readJsonStoreOrDefault<Partial<AutonomousPolicy>>(resolvePath(), STORE_NAME, defaultAutonomousPolicy());
  return { ...defaultAutonomousPolicy(), ...raw, environment: 'TESTNET' };
}

export interface UpdateAutonomousPolicyInput {
  autonomousEnabled?: boolean;
  exchangeAccountId?: string | null;
  allowedSymbols?: string[];
  analysisIntervalHours?: number;
  allowLong?: boolean;
  allowShort?: boolean;
  allowOpen?: boolean;
  maxAutonomousStrategies?: number | null;
  cooldownAfterTradeMinutes?: number | null;
  defaultPositionSizeUsdt?: number | null;
  defaultLeverage?: number | null;
}
export function updateAutonomousPolicy(patch: UpdateAutonomousPolicyInput): AutonomousPolicy {
  return withStoreWriteLock<AutonomousPolicy>(resolvePath(), STORE_NAME, defaultAutonomousPolicy(), (current) => {
    return { ...defaultAutonomousPolicy(), ...current, ...patch, environment: 'TESTNET', updatedAt: new Date().toISOString() };
  });
}
