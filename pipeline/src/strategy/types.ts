/** Sprint 3.6B — StrategyOrder domain. Sits between the immutable AI ScenarioPlan and the frozen
 * RealOrder/RealTrade/RealPosition/PositionAllocation chain (all untouched by this sprint). A
 * StrategyOrder is never itself exchange truth — it can move through its whole lifecycle
 * (WAITING_TRIGGER/ARMED/EXPIRED/CANCELLED) with zero real Binance writes. Only once it reaches
 * ENTRY_SUBMITTED does a real write exist, and even then the actual RealOrder/RealTrade/RealPosition
 * mirror is only ever created by the EXISTING frontend reconciliation pipeline (`syncPositionsFromExchange`
 * etc.) the next time the app is open — this file/module never fabricates one. */

export type StrategyOrderSource = 'USER' | 'AI_MANUAL' | 'AUTONOMOUS';

/** Frozen this sprint: `AUTONOMOUS` may be recorded as a source (Section 27 — reserved for Sprint
 * 3.7A's scheduler) but must never itself carry `authorization` — enforced in strategyOrderStore.ts's
 * `authorizeStrategyOrder()`, not just by convention. */
export type ExecutionMode = 'MANUAL' | 'MONITORED_AUTO' | 'AUTONOMOUS';

export type StrategyOrderStatus =
  | 'READY'               // 待决策 — created, no execution mode chosen yet
  | 'WAITING_TRIGGER'      // 等待触发 — MANUAL mode, user has not yet armed monitoring or executed
  | 'ARMED'                // 监控待执行 — MONITORED_AUTO, authorized, backend is evaluating the trigger
  | 'PAUSED'               // 暂停 — ARMED but monitoring suspended, never auto-executes while paused
  | 'TRIGGERED'            // 已触发 — trigger fired, about to run Execution Guard + Risk Guard
  | 'EXECUTION_BLOCKED'    // 风险阻止 — guard or risk check failed at trigger time
  | 'ENTRY_SUBMITTED'      // 订单待成交 — real write sent, exchange order exists
  | 'PARTIALLY_FILLED'     // 部分成交
  | 'POSITION_ACTIVE'      // 持仓中 — entry fully filled, Position Management lifecycle owns it now
  | 'EXPIRED'              // 已失效
  | 'CANCELLED'            // 已取消
  | 'COMPLETED'            // 已完成 — terminal, position fully closed downstream (informational only)
  | 'ERROR';                // ambiguous/unexpected failure, never auto-retried

/** Legal transitions, centralized — see `strategyOrderStore.ts#assertValidTransition`. UI/routes must
 * never assign `.status` directly. */
export const STRATEGY_ORDER_TRANSITIONS: Record<StrategyOrderStatus, StrategyOrderStatus[]> = {
  READY: ['WAITING_TRIGGER', 'ARMED', 'CANCELLED', 'EXPIRED', 'ENTRY_SUBMITTED'],
  WAITING_TRIGGER: ['ARMED', 'CANCELLED', 'EXPIRED', 'ENTRY_SUBMITTED'],
  ARMED: ['TRIGGERED', 'PAUSED', 'CANCELLED', 'EXPIRED', 'ERROR'],
  PAUSED: ['ARMED', 'CANCELLED', 'EXPIRED'],
  // ARMED is included for Section 20 crash recovery: if a prior tick set a pendingClientOrderId and
  // crashed before confirming the outcome, and restart recovery proves that submission never actually
  // reached Binance (order_not_found), the safe move is back to ARMED for a fresh attempt next tick —
  // never silently stuck in TRIGGERED, never a blind resubmit.
  TRIGGERED: ['ENTRY_SUBMITTED', 'EXECUTION_BLOCKED', 'EXPIRED', 'ERROR', 'ARMED'],
  EXECUTION_BLOCKED: ['ARMED', 'CANCELLED', 'EXPIRED'],
  ENTRY_SUBMITTED: ['PARTIALLY_FILLED', 'POSITION_ACTIVE', 'CANCELLED', 'EXPIRED', 'ERROR'],
  PARTIALLY_FILLED: ['POSITION_ACTIVE', 'CANCELLED', 'EXPIRED'],
  POSITION_ACTIVE: ['COMPLETED'],
  EXPIRED: [],
  CANCELLED: [],
  COMPLETED: [],
  ERROR: ['ARMED', 'CANCELLED'],
};

export type TriggerMetric = 'PRICE' | 'CANDLE_CLOSE_PRICE';
export type TriggerOperator = 'GT' | 'GTE' | 'LT' | 'LTE';
export type TriggerLogic = 'AND' | 'OR';

export interface TriggerCondition {
  metric: TriggerMetric;
  operator: TriggerOperator;
  value: number;
  timeframe?: string; // required for CANDLE_CLOSE_PRICE — '1H'|'4H'|'1D'|'1W', same vocabulary as the existing NOTIFY trigger monitor
  priceType?: 'LAST'; // reserved; only LAST supported this sprint
}

/** A single condition OR a boolean combination — `children` present only for AND/OR nodes. Kept
 * shallow (one level of AND/OR over leaf conditions) — deliberately not a full expression tree,
 * matching Section 6's "don't chase every technical indicator" scope. */
export interface Trigger {
  logic: TriggerLogic | 'SINGLE';
  conditions: TriggerCondition[]; // used when logic==='SINGLE' (exactly one) or as the AND/OR operand list
}

export type CapabilityDecision = 'EXCHANGE_NATIVE' | 'APP_MONITORED' | 'UNSUPPORTED';

export interface ExecutionIntent {
  entryType: 'MARKET' | 'LIMIT';
  entryPrice: number | null; // required for LIMIT, null for MARKET
  positionSizeUsdt: number;
  leverage: number;
  stopLoss: number | null;
  takeProfit: { price: number; portion: number }[]; // portions must sum to 100 when non-empty
}

/** Deterministic, checked once more at the instant a trigger fires — never AI-adjudicated (Section 12). */
export interface ExecutionGuard {
  maxPriceDeviationPct: number | null; // null = no guard configured; BLOCK is impossible to trigger from this rule
}

/** Sprint 3.7 — `AUTONOMOUS` added alongside `MONITORED_AUTO`. Structurally identical (same frozen
 * snapshot discipline); the difference is WHO grants it: `MONITORED_AUTO` is granted by a user's
 * explicit per-Strategy click (`POST /authorize`, still hard-blocked for `source==='AUTONOMOUS'` —
 * see that route). `AUTONOMOUS` is granted internally by `autonomousScheduler.ts` the instant a
 * validated AI `WAIT`/`OPEN` decision creates the StrategyOrder, standing in for the account-level
 * `AutonomousPolicy.autonomousEnabled` permission the user granted once for the whole system (Section
 * 15 of the Sprint 3.7 spec: "用户先授权整个 autonomous system，而不是每笔 Strategy"). Both modes
 * flow through the exact same downstream gates (`attemptAutoSubmission`'s Execution Guard/AUTO Risk
 * Policy/Risk Guard/Kill Switch/TESTNET-only chain) — this field only records provenance. */
export interface StrategyOrderAuthorization {
  mode: 'MONITORED_AUTO' | 'AUTONOMOUS';
  authorizedAt: string;
  /** Frozen snapshot of exactly what the user saw and approved — trigger + executionIntent +
   * executionGuard + expiresAt, byte-for-byte at authorization time. Any later change to any of
   * those fields invalidates authorization (Section 11) — enforced by `strategyOrderStore.ts`. */
  authorizedExecutionSnapshot: {
    trigger: Trigger;
    executionIntent: ExecutionIntent;
    executionGuard: ExecutionGuard;
    expiresAt: string | null;
  };
}

export interface StrategyOrderDecision {
  at: string;
  outcome: 'PASS' | 'BLOCKED' | 'EXPIRED' | 'ERROR';
  reason: string;
}

export interface StrategyOrder {
  strategyOrderId: string;
  tradeId: string | null; // populated once a local RealTrade exists for this strategy (MANUAL confirm, or AUTO reconciliation)
  symbol: string;
  direction: 'LONG' | 'SHORT';
  source: StrategyOrderSource;
  analysisId: string | null;
  scenarioPlanId: string | null;
  createdAt: string;
  updatedAt: string;

  status: StrategyOrderStatus;

  /** Frozen at creation time — the AI's own recommendation, verbatim. Never overwritten. */
  originalStrategy: {
    entryType: 'MARKET' | 'LIMIT' | 'ZONE' | 'CONDITIONAL';
    entryValue: number | null;
    stopLoss: number | null;
    takeProfit: { price: number; portion: number }[];
    trigger: Trigger | null;
    reviewHorizonExpiresAt: string | null;
  };
  /** The user's current intent — starts as a best-effort resolution of originalStrategy, mutated only
   * via explicit "修改执行参数". */
  effectiveStrategy: {
    executionIntent: ExecutionIntent;
    trigger: Trigger | null;
  };

  trigger: Trigger | null; // null = no trigger configured (immediate-only strategy)
  executionIntent: ExecutionIntent;
  executionGuard: ExecutionGuard;
  expiresAt: string | null;

  executionMode: ExecutionMode;
  authorization: StrategyOrderAuthorization | null;
  capabilityDecision: CapabilityDecision | null;

  monitoringState: {
    lastCheckedAt: string | null;
    nextCheckAt: string | null;
    lastObservedDataAt: string | null;
    health: 'RUNNING' | 'DEGRADED' | 'PAUSED' | 'ERROR';
  };

  /** Sprint 3.8C — "if this order's trigger fired right now, could it actually reach submission?",
   * computed PROACTIVELY every monitor tick for an ARMED order (see monitorEngine.ts), independent of
   * `status` (an order can be ARMED with executionReadiness.status==='BLOCKED' — see
   * executionReadiness.ts's own header comment for the full boundary, including why this NEVER
   * replaces the real Kill Switch/Execution Guard/AUTO Risk Policy/Risk Guard chain re-run at actual
   * trigger time). `null` only for an order created before this field existed, or one that has never
   * been ARMED (readiness is not computed/persisted for other statuses). */
  executionReadiness?: import('./executionReadiness.js').ExecutionReadiness | null;

  lastDecision: StrategyOrderDecision | null;

  /** Submission idempotency — set BEFORE the real write, matching the existing `pendingClientOrderId`
   * discipline from `submitRealOrderToTestnet()`. Survives a backend restart (Section 20). */
  submission: {
    exchangeConnectionId: string | null;
    exchangeAccountId: string | null;
    pendingClientOrderId: string | null;
    clientOrderId: string | null;
    exchangeOrderId: string | null;
    submittedAt: string | null;
  };

  linkedRealOrderIds: string[]; // populated once a local RealOrder mirror exists (frontend, display-only — see Section 5 of 3.6B.1)
  linkedTradeId: string | null; // same as tradeId, kept for audit-log readability

  failureReason: string | null;

  /** Sprint 3.6B.2 — set only when `status` becomes `COMPLETED`. `EXTERNAL_POSITION_CLOSE` is the only
   * value this sprint produces (Section 6): the backend observed, via real exchange reconciliation,
   * that this StrategyOrder's Position no longer has any exchange quantity — the app did not execute
   * the close. Distinct from `EXPIRED` (authorization/entry never completed) — this is a real fill
   * later closing, a different lifecycle event entirely. */
  completionSource: 'EXTERNAL_POSITION_CLOSE' | null;
  closedAt: string | null;

  /** Sprint 3.6B.1 — Section 2-5/14: the backend's OWN confirmed post-submission truth, so the full
   * fill→position→allocation→protection→verify lifecycle can complete with no browser open. This is
   * NEVER a fabricated RealPosition/RealOrder — every field here is set only after a real exchange
   * read confirms it (Core Truth Rule unchanged). The frontend's local RealOrder/RealTrade/
   * RealPosition/PositionAllocation mirror is a DOWNSTREAM DISPLAY copy of this, created once the app
   * is next open — never a second, independent decision-maker (Section 5: "do not leave two
   * independent reconciliation owners"). */
  execution: {
    orderStatus: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED' | null;
    filledQuantity: number;
    averagePrice: number | null;
    lastOrderSyncAt: string | null;
    positionQuantity: number | null; // real exchange position quantity for this symbol/account, last confirmed
    positionLastSyncedAt: string | null;
    /** This StrategyOrder's own confirmed contribution — set ONCE, the moment a real fill is first
     * confirmed, and never rewritten afterward (mirrors the frozen-once-created rule
     * `reconcilePositionAllocations()` already applies to `PositionAllocation.quantity`). Never
     * derived from `executionIntent.positionSizeUsdt` — only from `filledQuantity`. */
    allocationQuantity: number | null;
    /** Same enum + semantics as the existing `RealTrade.protectionStatus`, plus two additions:
     * PROTECTION_UNVERIFIED — a protection order was submitted but the real read-back has not yet
     * confirmed it (distinct from PROTECTION_FAILED, which means a definite failure). Section 15:
     * this state must never be allowed to look like "healthy/completed". ORPHANED_PROTECTION (Sprint
     * 3.6B.2) — set only when the Position has externally closed (`status` moves to `COMPLETED`) while
     * an app-submitted SL/TP order this StrategyOrder created is STILL live on the exchange (Section 8B
     * — detect + display honestly, never auto-cancel this sprint). */
    protectionStatus: 'NOT_REQUIRED' | 'PENDING_ENTRY_FILL' | 'PENDING_PROTECTION' | 'PROTECTED' | 'PARTIALLY_PROTECTED' | 'PROTECTION_UNVERIFIED' | 'PROTECTION_FAILED' | 'ORPHANED_PROTECTION';
    protectionOrders: { role: 'STOP_LOSS' | 'TAKE_PROFIT'; targetIndex: number | null; exchangeOrderId: string | null; pendingClientOrderId: string | null; status: string | null; quantity: number | null }[];
    protectionLastVerifiedAt: string | null;

    /** Sprint 3.6B.2.1 — a dimension deliberately SEPARATE from `protectionStatus` above (Section 2/3:
     * "these are different dimensions"; "do not overload old PROTECTED to mean was protected
     * historically"). `protectionStatus` is frozen the instant `status` becomes `COMPLETED` — it never
     * changes again, and describes what was true WHILE the Position was still active. This field
     * describes the CURRENT post-close protection-cleanup truth instead, populated only by
     * `reconcileClosedPositionProtection()`: `null` — not yet reconciled; `PENDING` — one successful
     * read found no App-owned live protection, but a transient/empty read is never final truth on its
     * own (Section 5), so a second independent successful read is required before `CONFIRMED_NONE`;
     * `ORPHANED_PROTECTION` — a read found an App-owned SL/TP still live after close; `CONFIRMED_NONE`
     * — terminal, two consecutive clean reads; `READ_FAILED` — the read itself failed, retried next
     * tick/restart, never treated as "confirmed clean". Self-heals from `ORPHANED_PROTECTION` back
     * toward `CONFIRMED_NONE` if the orphan orders are later cancelled by any means (Section 7) — no
     * local state edit required, no code change, same reconciliation function either way. */
    postCloseProtectionState: 'PENDING' | 'ORPHANED_PROTECTION' | 'CONFIRMED_NONE' | 'READ_FAILED' | null;
    /** Sprint 3.7, Section 67 — fixes the disclosed 3.6B.2.1 UI imprecision: `protectionOrders` above
     * accumulates every protection order this StrategyOrder EVER attempted (including ones later
     * REJECTED/CANCELED by the exchange itself, e.g. via TP/SL triggering or manual cancellation), so
     * `protectionOrders.length` overstates the CURRENT live orphan count once some of those are no
     * longer actually live. This field holds only the `exchangeOrderId`s `reconcileClosedPositionProtection()`'s
     * most recent successful read confirmed are STILL live on the exchange right now — set together
     * with `postCloseProtectionState`, `[]` whenever that state isn't `ORPHANED_PROTECTION`. */
    activeOrphanProtectionOrderIds: string[];
  };
}

/* ==========================================================================================
 * Sprint 3.7 — Autonomous Trading V1. See EXECUTION_SPEC.md's own section for the full contract.
 * A StrategyOrder produced by this pipeline is a StrategyOrder like any other (source:'AUTONOMOUS',
 * executionMode:'AUTONOMOUS') — no second Trade/Order/Position model. These types describe only the
 * NEW layer above it: the scheduler, the AI decision contract, and the audit-friendly cycle record.
 * ========================================================================================== */

/** Section 10/11 — deliberately NOT a reuse of the full `AI_RESPONSE_SPEC.md` multi-`ScenarioPlan`/
 * evidence-citation contract (that pipeline stays frontend-only, Research-workflow-specific, and
 * un-redesigned by this sprint). This is a new, narrow, strictly machine-readable contract for one
 * question only: "what should THIS one autonomous cycle do, right now, for THIS one symbol" — reusing
 * existing FIELD SHAPES (`Trigger`, `ExecutionIntent`) where they already match, never a second
 * duplicate Strategy schema (Section 10's own instruction). */
export interface AutonomousDecisionStrategy {
  entryType: 'MARKET' | 'LIMIT';
  entryPrice: number | null;
  triggerStructured: Trigger | null; // null only ever valid for an OPEN decision (immediate, no wait)
  stopLoss: number;
  takeProfit: { price: number; portion: number }[];
  leverage: number;
  positionSizeUsdt: number;
  expiresAt: string; // absolute ISO — Section 11's "expiresAt 无绝对时间 -> INVALID"
  executionGuard: ExecutionGuard;
}

export interface AutonomousDecision {
  decision: 'NO_ACTION' | 'WAIT' | 'OPEN';
  symbol: string;
  direction?: 'LONG' | 'SHORT';
  rationale: string;
  confidence?: number;
  strategy?: AutonomousDecisionStrategy;
}

/** Sprint 3.8C.3, Section 15 — `CONFIGURATION_BLOCKED` added. Fires ONLY from the pre-AI preflight
 * (Section 5/8): static config (default position size/leverage) is missing AND the cycle would
 * otherwise have attempted a NEW entry — the cycle never calls `runAnalysis()`, `analysisId` stays
 * `null`, zero AI cost. This is distinct from `ERROR` (a genuine, unexpected failure — AI/provider
 * error, a snapshot read that failed even after retry, storage failure) and distinct from `COMPLETED`
 * (which now also covers "analysis succeeded, StrategyOrder materialization was blocked by the SAME
 * kind of missing config discovered AFTER analysis, e.g. Manual-triggered runs that skip the
 * preflight" — see `AutonomousCycle.strategyMaterializationStatus`). `SKIPPED` remains reserved for
 * every pre-existing static/policy gate (disabled/kill-switch/symbol/account/connection/TESTNET/
 * max-concurrent) — none of those needed AI cost either, but they're a DIFFERENT category from "would
 * have run, but the entry can't be materialized" (Section 0's Analysis/Strategy/Execution split). */
export type AutonomousCycleStatus = 'RUNNING' | 'SKIPPED' | 'COMPLETED' | 'ERROR' | 'CONFIGURATION_BLOCKED';

/** Sprint 3.8C.3, Section 3 — Strategy Materialization is a SEPARATE concern from Analysis Outcome
 * (Section 0's core principle). `NOT_APPLICABLE` = a real position existed, so Position Management
 * was evaluated instead of a new entry (materialization was never attempted, by design — Section 6).
 * `NOT_CREATED` = materialization was intentionally not attempted (e.g. `allowOpen=false` — Section 7
 * — automation is analysis-only this cycle). `CREATED` = a StrategyOrder now exists (`strategyOrderId`
 * is set). `BLOCKED_CONFIGURATION` = analysis succeeded, but a StrategyOrder could not be built from
 * the result due to missing/unusable static config (`strategyMaterializationReasonCode` explains
 * which). `null` = this cycle never reached the point where materialization is decided (any pre-AI
 * gate, or a genuine ERROR before analysis completed). */
export type StrategyMaterializationStatus = 'NOT_APPLICABLE' | 'NOT_CREATED' | 'CREATED' | 'BLOCKED_CONFIGURATION';
/** Sprint 3.8C.3, Section 3 — only the reason codes this project currently has a real cause for. Never
 * conflated with a transient runtime/network failure (those stay `ERROR`, Section 25). */
export type StrategyMaterializationReasonCode = 'POSITION_SIZE_NOT_CONFIGURED' | 'LEVERAGE_NOT_CONFIGURED' | 'TRIGGER_NOT_MAPPABLE' | 'AUTOMATION_PERMISSION_DISABLED' | 'ACCOUNT_UNAVAILABLE';

/** Section 28/31 — one small append-only record per cycle attempt, self-contained (never depends on
 * the shared `AuditEvent` log, which requires a real `strategyOrderId` — most cycles never produce
 * one). `events` is this cycle's own mini audit trail; once a StrategyOrder IS created, its OWN
 * existing audit log takes over from `STRATEGY_CREATED` onward (cross-linked via
 * `StrategyOrder.analysisId = cycleId`, reusing an existing field rather than inventing a new one).
 * Deliberately does NOT store the full prompt text (Section 31: "不要把所有 AI prompt 全量无限永久存储") —
 * only small structured snapshot refs. */
export interface AutonomousCycle {
  cycleId: string; // deterministic: derived from symbol + scheduledAt — same slot never runs twice
  symbol: string;
  scheduledAt: string;
  startedAt: string | null;
  completedAt: string | null;
  status: AutonomousCycleStatus;
  manual: boolean; // Section 33 — "Run Analysis Now", still subject to every normal gate
  skipReason: string | null;
  /** Sprint 3.7 fields — still populated for cycles that never reach the unified Analysis Pipeline
   * (any pre-AI-gate skip: disabled/kill-switch/symbol/account/connection/max-concurrent — none of
   * those need a real analysis to know). Left `null` for a cycle that DID run a real analysis
   * (`analysisId` is set instead) — Sprint 3.9, Section 10: "不要保存第二份分析真相"; the full
   * market/account/position truth for such a cycle lives in its `AnalysisRecord`, not duplicated
   * here as a shrunken second copy. */
  marketSnapshotRef: { price: number | null; fetchedAt: string } | null;
  accountSnapshotRef: { fetchedAt: string; availableBalance: number | null; hasExistingPosition: boolean } | null;
  /** Sprint 3.7 field — no longer written by any cycle that reaches the unified Analysis Pipeline
   * (Sprint 3.9 removed the separate `AutonomousDecision` contract entirely; see `decision` field's
   * own doc comment below). Still present, and still populated, for historical pre-3.9 cycle
   * records (Section 29 — never migrated/rewritten). */
  decision: AutonomousDecision | null;
  invalidDecisionReason: string | null;
  strategyOrderId: string | null;
  failureReason: string | null;
  events: { timestamp: string; eventType: string; reason: string }[];
  /** Sprint 3.9, Section 10/13 — the ONE link from a cycle to the unified analysis it triggered
   * (`AnalysisRecord`, `analysis/analysisRecordStore.ts`). `null` for a cycle that never reached the
   * unified pipeline (skipped by a pre-AI gate) and for every historical pre-3.9 cycle (Section 29 —
   * never backfilled/guessed). */
  analysisId: string | null;
  /** Sprint 3.9, Section 14/15 — set only when this cycle found a real existing position and
   * produced a `PositionManagementDecision` (the decision's full content, including rationale, lives
   * on the `AnalysisRecord.response.positionManagement` this `analysisId` points to — this field is
   * only a cheap display summary, never a second copy of the reasoning). */
  positionManagementAction: 'HOLD' | 'ADJUST_SL' | 'ADJUST_TP' | 'REDUCE' | 'CLOSE' | null;
  /** Sprint 3.8C.3, Section 0/3 — Strategy Materialization outcome, SEPARATE from `status`/analysis
   * outcome. `null` only for a cycle that never reached the point materialization is decided (any
   * pre-AI/preflight gate, or a genuine pre-analysis `ERROR`). This is what lets the UI (and, later,
   * Attribution/Learning — Section 14/16) tell "AI analyzed fine, we just couldn't turn it into an
   * order" apart from "something actually went wrong." */
  strategyMaterializationStatus: StrategyMaterializationStatus | null;
  strategyMaterializationReasonCode: StrategyMaterializationReasonCode | null;
}

