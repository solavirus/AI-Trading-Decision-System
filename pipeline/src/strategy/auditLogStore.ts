/** Sprint 3.6B — Section 19: minimal append-only Strategy/Auto-execution audit log. Never records
 * apiSecret/credentials/headers — only decision-relevant facts. Same JSON-file-on-disk pattern as
 * every other store this project uses, kept as a flat array (append-only, never mutated in place).
 *
 * Sprint 3.8C.2 — migrated to `util/safeJsonStore.ts` (Section 10 of the spec: audit history is
 * itself a critical historical fact and must not be exposed to the same "read failure treated as
 * empty, then overwritten" risk the StrategyOrder store had — see strategyOrderStore.ts's own
 * comment for the full incident). Append now runs load→push→atomic-write inside a cross-process
 * lock; a genuine read failure throws instead of silently starting a fresh `[]` (which would have
 * meant the very next `appendAuditEvent()` call permanently erasing this project's entire audit
 * history, keeping only the one new event). */
import { randomUUID } from 'node:crypto';
import { readJsonStoreOrDefault, withStoreWriteLock } from '../util/safeJsonStore.js';

const CONFIG_DIR = 'data';
const AUDIT_LOG_PATH = CONFIG_DIR + '/strategy_audit_log.json';
const STORE_NAME = 'StrategyAuditLog';

let __testStoragePathOverride: string | null = null;
export function __setAuditLogPathForTesting(path: string | null): void {
  __testStoragePathOverride = path;
}
function resolvePath(): string {
  return __testStoragePathOverride ?? AUDIT_LOG_PATH;
}

export interface AuditEvent {
  eventId: string;
  timestamp: string;
  strategyOrderId: string;
  tradeId: string | null;
  eventType: string;
  previousStatus: string | null;
  newStatus: string | null;
  reason: string;
  triggerSnapshot?: unknown;
  executionGuardResult?: unknown;
  riskResultSummary?: unknown;
  realOrderId?: string | null;
  exchangeOrderId?: string | null;
}

function loadAll(): AuditEvent[] {
  return readJsonStoreOrDefault<AuditEvent[]>(resolvePath(), STORE_NAME, []);
}

export function appendAuditEvent(event: Omit<AuditEvent, 'eventId' | 'timestamp'>): AuditEvent {
  const full: AuditEvent = { eventId: randomUUID(), timestamp: new Date().toISOString(), ...event };
  withStoreWriteLock<AuditEvent[]>(resolvePath(), STORE_NAME, [], (all) => {
    all.push(full);
    return all;
  });
  return full;
}
export function listAuditEventsForStrategyOrder(strategyOrderId: string): AuditEvent[] {
  return loadAll().filter((e) => e.strategyOrderId === strategyOrderId);
}
/** Sprint — Orphan RealTrade Reconciliation, Section 5. The audit log's `tradeId` field is what
 * survives even after the owning StrategyOrder's own record is lost (the log is append-only,
 * independent of whether that record still exists) — this is the ONE lookup that lets a `tradeId`
 * (all the frontend RealTrade/RealOrder mirror ever carries) be traced back to real historical
 * terminal evidence without needing to already know the strategyOrderId. Read-only, same underlying
 * store as listAuditEventsForStrategyOrder() — no second audit store. */
export function listAuditEventsForTrade(tradeId: string): AuditEvent[] {
  return loadAll().filter((e) => e.tradeId === tradeId);
}
export function listAllAuditEvents(): AuditEvent[] {
  return loadAll();
}
