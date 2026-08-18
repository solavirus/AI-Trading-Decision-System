/** Sprint 3.6B — Section 15: AUTO Kill Switch. System-level, backend-enforced (not a hideable frontend
 * button — `monitorEngine.ts` checks this before every single AUTO submission, and the submission
 * route itself re-checks it too, same "never trust a single layer" discipline as the TESTNET guard).
 * Pausing blocks all NEW automatic Entry Exposure only — never touches existing SL/TP, never closes a
 * Position, never cancels a live protective order. Defaults to PAUSED — auto-execution is opt-in, not
 * opt-out, on every fresh install. */
import { readJsonStoreOrDefault, withStoreWriteLock } from '../util/safeJsonStore.js';

const CONFIG_DIR = 'data';
const KILL_SWITCH_PATH = CONFIG_DIR + '/strategy_kill_switch.json';
const STORE_NAME = 'KillSwitch';

let __testStoragePathOverride: string | null = null;
export function __setKillSwitchPathForTesting(path: string | null): void {
  __testStoragePathOverride = path;
}
function resolvePath(): string {
  return __testStoragePathOverride ?? KILL_SWITCH_PATH;
}

export type KillSwitchState = 'MONITORED_AUTO_ENABLED' | 'MONITORED_AUTO_PAUSED';

interface KillSwitchFile {
  state: KillSwitchState;
  updatedAt: string;
}

const defaultKillSwitchFile = (): KillSwitchFile => ({ state: 'MONITORED_AUTO_PAUSED', updatedAt: new Date().toISOString() });

/** A genuine read failure now throws (`PersistenceError`) instead of silently reporting PAUSED. The
 * old silent-PAUSED-on-any-error behavior happened to fail in the safe direction for the trading gate
 * itself, but it could also silently mask a real problem (e.g. the switch was actually ENABLED and a
 * transient read glitch made it look paused with zero signal to the operator) — callers already have
 * a safe way to handle the throw (monitor tick's own `.catch()` fails that tick closed; HTTP routes'
 * outer try/catch turns it into a safe 5xx), so surfacing it is strictly better than hiding it. */
export function getKillSwitchState(): KillSwitchState {
  return readJsonStoreOrDefault<KillSwitchFile>(resolvePath(), STORE_NAME, defaultKillSwitchFile()).state;
}

export function setKillSwitchState(state: KillSwitchState): void {
  withStoreWriteLock<KillSwitchFile>(resolvePath(), STORE_NAME, defaultKillSwitchFile(), () => {
    return { state, updatedAt: new Date().toISOString() };
  });
}

export function isAutoExecutionAllowed(): boolean {
  return getKillSwitchState() === 'MONITORED_AUTO_ENABLED';
}
