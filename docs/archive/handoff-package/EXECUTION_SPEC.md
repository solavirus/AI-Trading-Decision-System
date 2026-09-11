# Execution Specification

Version: 1.7.0

Status: Frozen MVP Contract

Last Updated: 2026-08-10 (Sprint 3.6A)

Revision note (1.0.0, 2026-08, Sprint 3.4B.1 — Execution Contract Freeze): initial version. This document does not introduce any new behavior — it freezes, as a durable contract, the `ExecutionDraft`/`ExecutionMode`/`TriggerStatus` model and the deterministic Trigger Monitor already implemented and verified across Sprint 3.4A (`ExecutionDraft` + `MANUAL`) and Sprint 3.4B (Trigger Monitor + `NOTIFY`). Where this document and any earlier design prose disagree, the current verified implementation in `prototype/index.html` is the source of truth, and this document was written to match it.

Revision note (1.1.0, 2026-08-09, Sprint 3.5D-A — Real Order Lifecycle Foundation): additive. Defines, for the first time, real `RealOrder`/`RealTrade` lifecycle fields and a strictly read-only exchange order-sync flow — see "Real Order Lifecycle Sync" below. Does not touch `ExecutionDraft`/`ExecutionMode`/`TriggerStatus`/the Trigger Monitor at all; still no order submission, no `AUTO`, no Position.

Revision note (1.2.0, 2026-08-09, Sprint 3.5D-B — Binance TESTNET Manual Order Submission): additive. Defines the app's first real exchange WRITE capability — a manual, TESTNET-only, entry-order-only submission path — see "Real Order Submission" below. `ExecutionDraft`/`ExecutionMode`/`TriggerStatus`/the Trigger Monitor still untouched. LIVE, `AUTO`, cancel/amend, leverage/margin-mode mutation, and stop-loss/take-profit submission all remain unimplemented and explicitly out of scope.

Revision note (1.3.0, 2026-08-10, Sprint 3.5D-B.1 — Numeric Scenario Enforcement + Absolute Expiry): additive. Adds one new gate — `evaluateScenarioExecutionReadiness()` — required, in addition to every existing check, before Strategy's execution buttons act, before the Execution page renders an editable form, and before TESTNET submission eligibility passes; see "Scenario Execution Readiness Gate" below. This is a consequence of `AI_RESPONSE_SPEC.md` v2.2.0's tightened `PRIMARY` numeric-completeness rule — no `ExecutionDraft`/`RealOrder`/`RealTrade` field shape changed, no TESTNET/Risk Guard/LIVE/`AUTO` boundary was touched or weakened.

Revision note (1.4.0, 2026-08-10, Sprint 3.5D-C — Position Sync + Real Fill Lifecycle): additive. `Position` is, for the first time, formally defined and implemented as a local, read-only mirror (`RealPosition`, `qa_positions`) synced exclusively from real exchange position data — see "Real Position Sync" below. Reuses the existing `GET .../account` route; no new backend endpoint, no new write capability, no cancel/amend/leverage mutation. `ExecutionDraft`/`ExecutionMode`/`TriggerStatus`/Trigger Monitor/Real Order Submission all unchanged.

Revision note (1.5.0, 2026-08-10, Sprint 3.5D-D — Binance TESTNET Manual Order Cancellation): additive. Defines the app's SECOND real exchange write capability — a manual, TESTNET-only cancellation of an already-submitted entry order (`SUBMITTED`/`PARTIALLY_FILLED` only) — see "Real Order Cancellation" below. LIVE cancellation, amend/replace, leverage/margin-mode mutation, and protective-order submission all remain unimplemented and explicitly out of scope. No `ExecutionDraft`/`RealOrder`/`RealTrade`/`RealPosition` field shape changed; the existing Trade-lifecycle propagation function is reused verbatim for the cancellation outcome, never a second/diverging implementation.

Revision note (1.6.0, 2026-08-10, Sprint 3.5D-E — Full Trade Plan: Real Stop Loss / Take Profit Protection): additive. Defines the app's THIRD and FOURTH real exchange write capabilities — TESTNET-only protective (`STOP_LOSS`/`TAKE_PROFIT`) order submission and cancellation via Binance's Algo Service (`POST`/`DELETE /fapi/v1/algoOrder`) — see "Real Trade Protection" below. `RealOrder.role` additively gains `'STOP_LOSS'`/`'TAKE_PROFIT'` (plus `targetIndex`/`portion` on take-profit orders); `RealTrade` additively gains `protectionStatus`; `ExecutionDraft.userOverrides.takeProfit[i]` additively gains `portion`. No existing field renamed/removed. LIVE, `AUTO`, order amendment, leverage/margin-mode mutation remain unimplemented and explicitly out of scope. Protection quantity is always derived from real filled/position data, never from `positionSizeUsdt` — same Core Truth Rule discipline as Real Position Sync (1.4.0).

Revision note (1.7.0, 2026-08-10, Sprint 3.6A — Position Allocation + Account Management Foundation): additive. Defines `PositionAllocation` — a local attribution model letting multiple `RealTrade`s share one real exchange net Position without ever assuming exclusive ownership — see "Position Allocation" below. Defines the app's FIFTH real exchange write capability, TESTNET-only leverage change (`POST /fapi/v1/leverage`), reached only through an explicit user-confirmed recovery flow off the existing `leverage_mismatch` BLOCK — see "Real Leverage Sync" below. Adds a real-time (SSE) low-latency update channel layered on top of, and never replacing, REST reconciliation — see "Real-Time Account Updates" below. Adds a new top-level Account/Portfolio page (read-only position/order/algo-order overview, App vs External ownership distinction, external-order cancellation with an extra-strong warning). No `ExecutionDraft`/`RealOrder`/`RealTrade`/`RealPosition` field renamed or removed. Hedge Mode switching, margin-mode mutation, and automatic CLOSE/REDUCE/REVERSE remain explicitly out of scope.

---

## Purpose

Defines the `ExecutionDraft` object, its two currently implemented execution modes (`MANUAL`, `NOTIFY`), the `TriggerStatus` monitoring model, and the deterministic Trigger Monitor that evaluates a `ScenarioPlan`'s structured trigger/invalidation conditions against live market data.

## When To Read

Read this document when:
- Working on `ExecutionDraft` creation, editing, confirmation, or cancellation
- Working on the Trigger Monitor (`evaluateTrigger`, `runTriggerMonitorTick`, and related functions)
- Changing what Strategy's "手动执行"/"触发时提醒" buttons do
- Deciding whether a new capability belongs in `AUTO`, Risk Guard, or an Order/Position model

Do NOT read this document when:
- Changing the AI response contract itself (see `AI_RESPONSE_SPEC.md`)
- Working on the Prompt sent to the AI (see `PROMPT_BUILDER_SPEC.md`)
- Working on Dashboard/Research data collection (see `DATA_SOURCE_SPEC.md`)

---

# Goal

Define the standard shape and lifecycle of an `ExecutionDraft` — the one mutable object that separates "what the AI recommended" from "what the user decided to do about it."

This specification is independent of any exchange, broker, or account system — none is integrated yet.

Strategy produces `ScenarioPlan`s (see `AI_RESPONSE_SPEC.md`). Execution consumes exactly one `ScenarioPlan` per `ExecutionDraft`. Execution never produces a `ScenarioPlan`, never edits one, and never feeds anything back into `AIResponseRecord`.

---

# Principles

Execution always separates the AI recommendation from the human decision (Frozen Product Principle, `PROJECT.md`).

The AI is an analysis engine. It does not execute orders. `ExecutionDraft` is the only place user execution intent is recorded, and only a human action (never a scheduled process, never a re-run of the AI) can move it toward `CONFIRMED`.

`AIResponseRecord` is immutable. `ExecutionDraft` is mutable. This document defines the mutable side only.

---

# Root Structure

```ts
type ExecutionDraft = {
  executionId: string;
  analysisId: string;
  scenarioPlanId: string;

  executionMode: "MANUAL" | "NOTIFY";

  createdAt: string;
  updatedAt: string;

  userOverrides: {
    entry: EntryOverride | null;
    stopLoss: StopLossOverride | null;
    takeProfit: TakeProfitOverride[] | null;
    positionSize: number | null;
    leverage: number | null;
    notes: string;
    orderResolution: { type: "MARKET" | "LIMIT" | null; price: number | null } | null; // (Sprint 3.4C) resolves a ZONE/CONDITIONAL entry into one executable price before an Order can be generated — never AI-owned, never a fabricated ZONE midpoint
  };

  status: "DRAFT" | "CONFIRMED" | "CANCELLED";

  triggerStatus:
    | "NOT_MONITORED"
    | "PENDING"
    | "TRIGGERED"
    | "INVALIDATED"
    | "EXPIRED"
    | "CANCELLED";

  monitoring: {
    startedAt: string | null;
    lastCheckedAt: string | null;
    triggeredAt: string | null;
    invalidatedAt: string | null;
    expiredAt: string | null;
    lastObservedDataAt: string | null;
  } | null;
}
```

This is the exact shape implemented in `prototype/index.html` (`createOrReuseExecutionDraft()`), not a proposal. `AUTO` does not appear in `executionMode` because it is not implemented — see Non-Goals and the AUTO extension boundary below.

`monitoring` is `null` for `MANUAL` drafts (there is nothing to monitor) and populated at creation time for `NOTIFY` drafts.

Persisted, keyed by `executionId`, in the `qa_execution_drafts` `localStorage` map (`loadExecutionDrafts()`/`saveExecutionDraftMap()`) — the same storage pattern as `qa_analysis_payloads`/`qa_ai_response_records` elsewhere in this codebase.

---

# Identity / Traceability

`analysisId` + `scenarioPlanId` are the frozen, immutable reference back to the AI recommendation. `ExecutionDraft` never copies the full `ScenarioPlan` — it is re-resolved fresh from the immutable `AIResponseRecord` every time, via `resolveScenarioPlan(analysisId, scenarioPlanId)`.

Traceability chain:

```
Analysis Payload
→ Prompt Record
→ AIRawResult
→ AIResponseRecord
→ ScenarioPlan          (immutable — AI_RESPONSE_SPEC.md)
→ ExecutionDraft         (mutable — this document)
```

`AIResponseRecord` remains immutable after creation (`AI_RESPONSE_SPEC.md`'s persistence contract). `ExecutionDraft` is the first and only mutable object in this chain. Because "what did the AI recommend" is always re-read from the immutable record rather than copied, the two can never drift apart — editing a draft's `userOverrides` can never accidentally change what the AI actually said.

---

# AI Recommendation vs. User Execution

This distinction is frozen and must never blur.

**AI-owned, immutable** (lives on `ScenarioPlan`, `AI_RESPONSE_SPEC.md`):
- entry
- stopLoss
- takeProfit
- triggerStructured / trigger
- invalidation
- reviewHorizon
- direction / action

**User-owned, mutable** (lives on `ExecutionDraft`, this document):
- userOverrides (entry / stopLoss / takeProfit / positionSize / leverage / notes)
- executionMode
- execution lifecycle (`status`)
- monitoring lifecycle (`triggerStatus`, `monitoring`)

A user override never overwrites the AI's `ScenarioPlan` — the `ScenarioPlan` is read-only for the entire lifetime of the draft. The two are combined only at render/confirm time:

```
effective execution values = AI ScenarioPlan + userOverrides
```

Implemented as `effectiveExecutionPlan(plan, overrides)` — one pure function, used identically by rendering and by confirmation, so "what was shown" and "what was confirmed" can never disagree. A `null`/absent override field means "use the AI recommendation as-is"; only a field the user actually touched is populated, and each of `entry`/`stopLoss`/`takeProfit` is snapshotted independently on first edit (`exec2EnsureOverrideEntry()` etc.) — never all three at once, never at draft-creation time.

---

# ExecutionMode

Currently implemented values:

```
"MANUAL" | "NOTIFY"
```

**`AUTO` is NOT implemented.** It does not appear in the `executionMode` type, is never produced by any code path, and must not be treated as a currently valid value. `AI_RESPONSE_SPEC.md`'s Scope and Governance section already reserves the name (`ExecutionMode (MANUAL/NOTIFY/AUTO)`) as belonging to a separately-approved future design — this document is the first to actually define `MANUAL`/`NOTIFY` behavior, and explicitly declines to define `AUTO` behavior (see the AUTO extension boundary below).

---

# MANUAL Semantics

`executionMode: "MANUAL"` means:

- No trigger monitoring exists for this draft. `triggerStatus` is `NOT_MONITORED` for the draft's entire lifetime.
- The user may review and edit the AI's execution parameters (`userOverrides`).
- The user may confirm the draft (`status → CONFIRMED`).
- No exchange order is submitted. No real position is created. No AI call occurs anywhere in this flow.

**WAIT Scenarios**: manually executing a `ScenarioPlan` whose `decision.action = "WAIT"` (i.e. its trigger has not yet been satisfied under the current snapshot) is allowed, never blocked. The Execution page displays an explicit warning ("当前 Scenario 的触发条件尚未满足。你正在提前执行 AI 的等待方案。"). The AI's `decision`/`ScenarioPlan` are never modified by this. User authority is final — the system's role is to disclose, not to gate.

**ENTER Scenarios**: when the selected `PRIMARY` plan's parent decision is `decision.action = "ENTER"`, the Execution page instead shows an informational note ("AI 认为该 PRIMARY 方案在当前快照下已经可以执行") — never an auto-confirm, never an auto-created anything.

---

# NOTIFY Semantics

`executionMode: "NOTIFY"` means:

> monitor the selected Scenario's machine-evaluable structured trigger, and notify the user in-app when it becomes true.

`NOTIFY` does **not** mean: auto-execute, auto-confirm the draft, create a Trade, create an order, or create a position. None of these ever happen automatically under `NOTIFY`.

Lifecycle:

```
create ExecutionDraft(executionMode="NOTIFY")
  → status=DRAFT, triggerStatus=PENDING
      ↓
  deterministic Trigger Monitor evaluation (no LLM)
      ↓
  triggerStatus → TRIGGERED | INVALIDATED | EXPIRED
      ↓
  user opens Execution
      ↓
  user reviews / edits userOverrides / confirms manually
      ↓
  status → CONFIRMED   (still not an order, not a position — see Execution Confirmation Boundary)
```

---

# Machine-Evaluable Eligibility

Eligibility for `NOTIFY` is determined entirely by system code, never by any AI-declared field. `AI_RESPONSE_SPEC.md`'s Machine Evaluability section is explicit that no `machineExecutable`-style field exists or should ever be added — the Parser (for schema acceptance) and the Strategy/Execution UI (for whether to offer `NOTIFY`) are the sole authorities.

Implemented as `isMachineEvaluableTrigger(triggerStructured)`: returns `true` only if `triggerStructured` is present, has at least one condition, and every condition's `metric`/`operator` are both in the controlled vocabulary below. This one function is the single source of truth for the "可结构化监控" Strategy badge, the "触发时提醒" button's enabled state, and the click handler's own re-check (never trusts stale rendered state).

**Current machine metrics**: `price`, `candle_close`.

**Current operators**: `GT`, `GTE`, `LT`, `LTE`, `BETWEEN`, `CROSSES_ABOVE`, `CROSSES_BELOW`, `EQUALS`.

Both lists are frozen at their `AI_RESPONSE_SPEC.md` v2.1.0 values. This document does not add to them — extending the vocabulary is an `AI_RESPONSE_SPEC.md` change first, an Execution change second.

---

# Trigger Evaluation Model

Every condition evaluates to one of three states — **not boolean**:

```
"MATCHED" | "UNMATCHED" | "UNRESOLVED"
```

`UNRESOLVED` means "cannot yet be determined" (missing data, or a `CROSSES_*` condition with no prior observation) — distinct from `UNMATCHED` ("determined, and false"). This distinction exists so an incomplete observation can never be silently treated as a match.

**`ALL` logic**: the trigger matches only if every condition is `MATCHED`. Any `UNMATCHED` or `UNRESOLVED` condition prevents the trigger from firing.

**`ANY` logic**: the trigger matches if at least one condition is `MATCHED`. An `UNRESOLVED` sibling condition never blocks a genuine match elsewhere in the same trigger. If nothing is `MATCHED`, the trigger has not fired.

Implemented in `evaluateTrigger(structuredTrigger, ctxResolver)`, which first requires `isMachineEvaluableTrigger()` to be true (an inherently non-evaluable trigger returns `{evaluable:false, matched:false}` rather than guessing), then combines per-condition results (`isConditionMet()`/`evalOperator()`) using the exact rule above.

## Cross Semantics

```
CROSSES_ABOVE:  previous < value  AND  current >= value
CROSSES_BELOW:  previous > value  AND  current <= value
```

With no previous observation available, the result is `UNRESOLVED` — never inferred from the current value alone.

The "previous observation" cache (`triggerMonitorPrevPrice`, `triggerMonitorPrevCandle`) is **in-memory only**, never persisted to `localStorage`. This is deliberate: after an app restart or page reload, a `CROSSES_*` condition correctly returns to `UNRESOLVED` for one monitoring tick rather than fabricating a "previous" value that was never actually observed this session. Document this as a known, accepted limitation of the current MVP, not a bug to silently work around.

---

# Market Observation Contract

The monitor consumes only the minimal structured values a condition needs — never the full Research Analysis Payload:

- `symbol` — resolved from the draft's Analysis Payload (`payload.symbol`)
- `price` observation: `{ value: number, observedAt: string }`
- `candle_close` observation: `{ timeframe: string, value: number, closedAt: string }` — the most recently **fully closed** candle for that timeframe, never the currently forming one
- the corresponding previous observation, where available, for `CROSSES_*` evaluation

This is deliberately a small, purpose-built shape (`ctxResolver()`'s per-condition context), not a reuse of the Research Analysis Payload's much larger structure.

---

# Data Sources

```
price        → GET /api/prices
candle_close → GET /api/market/detail?symbol=&interval=&limit=3
```

Both reuse existing, already-live market-data paths — no new provider was added for this feature.

- `/api/prices` is the exact endpoint the Dashboard ticker (`refreshTickerPrices()`) already polls every 20s; it is already cached 20s server-side (`CACHE_TTL_MS`) and already returns every tracked symbol in one batched response.
- `/api/market/detail` is the same endpoint Research's own K-line detail view uses; it is not server-side cached — every call hits Binance directly.

**Candle-close derivation (current MVP limitation, documented deliberately, not as ideal permanent architecture)**: the backend's `klines` response mapping (`pipeline/src/sources/marketDetail.ts`) does not currently expose Binance's own `closeTime` field, even though the underlying connector fetches it. Rather than extend the backend for this feature, the close time is derived on the frontend as `openTime + this timeframe's fixed duration` (`TRIGGER_TIMEFRAME_MS = {'1H':3600000,'4H':14400000,'1D':86400000,'1W':604800000}`), and the monitor scans the returned klines backward for the first one whose computed close time has already passed. The forming (most recent, not-yet-closed) candle is never used as a `candle_close` observation.

---

# Freshness

`price` and `candle_close` observations are only ever used the moment they are freshly fetched within a monitor tick — there is no separate staleness-timestamp check layered on top, because the monitor never reuses an old fetch result across ticks (each tick re-fetches everything it needs). If a fetch fails or returns nothing, the affected condition resolves `UNRESOLVED` (see Trigger Evaluation Model) rather than being treated as matched.

Frozen principle: **stale or unavailable required data never triggers a Scenario.** `NOTIFY` never silently claims a condition matched when the underlying observation could not be obtained — the draft simply stays `PENDING` and is re-evaluated on the next tick. No specific staleness threshold (e.g. "reject an observation older than N seconds") is implemented in the current MVP beyond "each tick fetches its own fresh data" — this document does not invent one.

---

# Polling Architecture

```
TRIGGER_MONITOR_TICK_MS = 30000
```

One shared timer for **all** pending `NOTIFY` drafts combined — never one timer per Scenario. Started once at app init (`startTriggerMonitorLoop()`), idempotent (a second call is a no-op if already running).

- Zero pending drafts → zero monitoring requests that tick.
- `/api/prices`: exactly one request per tick, covering every symbol any pending draft needs, regardless of how many drafts or symbols are involved.
- `/api/market/detail`: one request per **distinct** `(symbol, timeframe)` pair across all pending drafts combined — never one request per draft. Multiple drafts watching the same symbol/timeframe share a single fetch.

Request-rate implications: `price` traffic is bounded at ≤120 requests/hour regardless of draft count. `candle_close` traffic is bounded at ≤120×K requests/hour, where K is the number of distinct `(symbol,timeframe)` pairs actually being monitored at once (typically small in practice). This architecture is not to be redesigned as part of documenting it.

---

# Invalidation

`scenario.invalidation` (a `StructuredTrigger | null`, `AI_RESPONSE_SPEC.md`) is evaluated only while `triggerStatus = PENDING`.

If `invalidation` is present, machine-evaluable, and matches (per the `ALL`/`ANY` rule above) **before** the entry trigger does:

```
triggerStatus → INVALIDATED
```

Monitoring for that draft stops. There is no automatic switch to any other Scenario — invalidating one plan never activates another plan's monitoring.

**Same-cycle precedence**: within a single monitor tick, invalidation is evaluated **before** the entry trigger. If both would match in the same tick, `INVALIDATED` wins ("prefer safety").

---

# Expiration

Only a real, deterministic, parseable `reviewHorizon.expiresAt` timestamp can cause an automatic:

```
triggerStatus → EXPIRED
```

A natural-language-only `reviewHorizon` (e.g. "未来 3 根 4H K线内有效", with no `expiresAt`) is displayed as-is and **never** automatically expires the draft. No natural-language parser and no AI call is used to interpret it. This is a known, deliberate limitation, not an oversight — expiration by description alone would require either guessing or an LLM call, both explicitly excluded from this deterministic monitor.

---

# Triggered

```
triggerStatus: PENDING → TRIGGERED
```

Records `monitoring.triggeredAt`. Monitoring for that draft stops (the tick loop only ever processes `triggerStatus === 'PENDING'` drafts).

`TRIGGERED` does **not**: confirm the `ExecutionDraft` (`status` stays `DRAFT`), create a Trade, create an Order, create a Position, call the AI, or submit any exchange request. The user must still open Execution and confirm manually — `NOTIFY` never becomes `AUTO` by virtue of firing.

If the selected Scenario's trigger is **already** satisfied at the moment `NOTIFY` is activated (relevant mainly for an `ENTER` decision, but not exclusive to it), the monitor evaluates immediately rather than waiting for the next scheduled tick — the draft is not left artificially `PENDING` for up to 30 seconds when the condition is already true.

---

# Cancellation

For an active `NOTIFY` draft still `triggerStatus = PENDING`:

```
status → CANCELLED
triggerStatus → CANCELLED
```

If `triggerStatus` had already reached a terminal state (`TRIGGERED`/`INVALIDATED`/`EXPIRED`) before cancellation, that terminal state is preserved as historical fact — only `status` moves to `CANCELLED`; `triggerStatus` is not overwritten (the monitor had already stopped watching it regardless).

The draft is never deleted. History remains persisted. `AIResponseRecord` is never modified by cancellation.

---

# Duplicate Active Draft Rule

For the exact same `(analysisId, scenarioPlanId, executionMode)`:

- **`MANUAL`**: any existing draft with `status = 'DRAFT'` is reused. A `CONFIRMED`/`CANCELLED` draft is terminal — a fresh click creates a new draft.
- **`NOTIFY`**: an existing draft with `status = 'DRAFT'` **and** `triggerStatus` in `{'PENDING', 'TRIGGERED'}` is reused (i.e. genuinely still "in flight"). A `CONFIRMED`/`CANCELLED`/`INVALIDATED`/`EXPIRED` draft is terminal — a fresh "触发时提醒" click starts a new draft.

Repeated activation never creates duplicate monitoring for the same Scenario. This rule is read directly from `createOrReuseExecutionDraft()` — not inferred.

---

# Multiple Plans

- Multiple distinct `NOTIFY` drafts (different `scenarioPlanId` and/or different `analysisId`) may be actively monitored simultaneously — there is no global single-monitor limit.
- No portfolio-level conflict detection exists (e.g. two simultaneously monitored Scenarios recommending opposite directions on the same symbol are not flagged against each other).
- No symbol-level lock exists — nothing prevents monitoring the same symbol from more than one Scenario/draft at once.
- A new Research analysis produces a new `analysisId` and never mutates, migrates, or otherwise touches an existing pending `NOTIFY` draft tied to an older `analysisId`.

---

# Persistence / Resume

`localStorage` key: `qa_execution_drafts` (one JSON map, `executionId → ExecutionDraft`).

On app startup, `startTriggerMonitorLoop()` starts the shared 30s timer and immediately runs one tick. Each tick (`runTriggerMonitorTick()`) re-derives its entire worklist fresh from `qa_execution_drafts` via `collectPendingNotifyDrafts()` — filtering for `executionMode='NOTIFY', status='DRAFT', triggerStatus='PENDING'`. There is no separate persisted "which drafts was I watching" bookkeeping: "resuming" is simply "start the interval again," since the worklist is always recomputed from scratch.

Terminal `triggerStatus` values (`TRIGGERED`/`INVALIDATED`/`EXPIRED`/`CANCELLED`) are never resumed as active monitors — only `PENDING` drafts are picked up.

`startTriggerMonitorLoop()` is idempotent: calling it a second time while already running is a no-op.

---

# Current Monitoring Limitations (Mandatory Section)

**Monitoring works when:**
- the app/tab is open, on any route (not gated to a specific page)
- the user navigates across routes within the app
- the page reloads (the app restarts and resumes from persisted `PENDING` drafts)

**Monitoring does NOT work when:**
- the browser tab is closed
- the app is closed
- the computer is off

No background service exists. No Service Worker exists. No OS-level daemon exists. No server-side monitor exists — all evaluation happens in the browser tab's own JavaScript timer.

Do not describe this capability as "continuous monitoring" without qualification. The correct description is:

> **Foreground / app-open monitoring, with persisted resume across reloads and navigation — not a background service.**

---

# Notification Boundary

Current notifications are **in-app only**:
- a toast (`toast()`, the same pattern used elsewhere in this app), with an actionable link to the relevant Execution page on `TRIGGERED`
- persisted, visible status on the Strategy Scenario card (`scenarioMonitorBadge()`: 监控中/已触发/已失效/已过期) and on the Execution page's own "监控状态" section — the durable indicators, not the transient toast

**Not implemented, and must not be described as available**: browser push notifications, OS-level notifications, email, SMS, webhooks, Telegram/Discord integration, or any other channel.

---

# Execution Confirmation Boundary

```
status: DRAFT → CONFIRMED
```

`CONFIRMED` currently means **only**: the user confirmed the `ExecutionDraft`'s execution intent.

It does **not** mean: an exchange accepted an order, an order filled, a position was opened, or a Trade is running.

No legacy Trade record is created when a draft is confirmed (a deliberate Sprint 3.4A decision, unchanged). The existing mock Trade shape (`status:"running"`, simulated live P&L, "执行下单（开仓）" timeline text) specifically models "a position that is now live" — a stronger claim than "the user confirmed execution intent" — so it is deliberately not reused here. A confirmed `ExecutionDraft` is visible only via its own `executionId`; no `#/trades/:id` record is created by this flow. Do not blur this distinction in future work without a recorded product decision.

---

# Legacy Execution (Unchanged, Not Part of This Contract)

`Store.draft.strategy`, `ensureExecDraft()`, and the legacy `confirmExecution()` path are legacy/mock-only code, already unreachable before Sprint 3.4A (`generateStrategy()`, the only thing that ever populated `Store.draft.strategy`, has zero call sites in the reachable UI). This document does not cover them, and no code change was made to them in this sprint. Real v2 execution exclusively uses the chain:

```
AIResponseRecord → ScenarioPlan → ExecutionDraft
```

---

# Error / Invalid States

Resolved by `resolveExecutionView(executionId)`, the single source of truth both rendering and confirmation use to agree on whether an `executionId` is currently usable:

```
missing_execution_id
execution_draft_not_found
invalid_execution_draft
analysis_response_not_found
unsupported_response_version
scenario_plan_not_found
```

Each maps to a specific, readable user-facing message (`EXECUTION_UNAVAILABLE_MESSAGES`) — never a silent mock fallback. These are the exact currently implemented codes; this document does not add new ones.

---

# Non-Goals

Current Execution v1 (Sprint 3.4A + 3.4B) does **NOT** include:

- `AUTO` execution mode
- Full/production-grade Risk Guard (account balances, exchange-verified exposure) — an MVP local Risk Guard (settings + local Trade/Order state only) is implemented as of Sprint 3.5A, see Future Extension Boundary — Risk Guard below
- exchange connectivity of any kind
- real order placement
- ~~position tracking~~ (superseded, Sprint 3.5D-C — see "Real Position Sync" below: a read-only, manually-triggered mirror of real exchange positions now exists)
- ~~protective-order (stop-loss/take-profit) submission~~ (superseded, Sprint 3.5D-E — see "Real Trade Protection" below: real STOP_LOSS/TAKE_PROFIT orders are now submitted via Binance's Algo Service, TESTNET only; automatic/background reconciliation beyond a user's own manual sync still does not exist)
- order lifecycle
- real Trade lifecycle (confirming a draft never creates a Trade record)
- account balances
- portfolio exposure tracking
- portfolio conflict detection across multiple monitored Scenarios
- background monitoring while the app/tab is closed
- push / email / SMS notifications
- AI-based recurring trigger checks (the monitor is fully deterministic; it never calls an AI provider)
- automatic Scenario switching (e.g. auto-activating an `ALTERNATIVE` plan when `PRIMARY` is invalidated)
- `HOLD` / `ADD` / `REDUCE` / `CLOSE` / `REVERSE` actions (only `ENTER`/`WAIT` exist at the `decision` level; `ScenarioPlan.action` is always `"ENTER"`)

This section exists specifically so a future session does not assume any of the above already exists.

---

# Future Extension Boundary — AUTO

This document defines only the architectural boundary, not `AUTO`'s runtime semantics — those belong to a future version of this specification.

`AUTO` must eventually require **all** of:

- a machine-evaluable trigger (the same eligibility check `NOTIFY` already uses)
- explicit user authorization to run in `AUTO` mode for that specific draft
- a Risk Guard (see below)
- a real account/exchange connection (as of Sprint 3.5B, a **read-only** Binance USDT-M Futures connection exists — Settings' "交易所连接" section, `pipeline/src/exchange/*` — used only to display account balances/positions; it has no order-placement capability at all, so this prerequisite is only partially met)
- fresh market data (the same freshness guarantees `NOTIFY` already relies on)
- a defined Order model

None of these exist today. `AUTO` may be added to `ExecutionMode` in a future minor/major version of this document once they do — it is not implicitly enabled by anything currently implemented.

# Future Extension Boundary — Risk Guard

Frozen principle: risk authority belongs to **user settings + account state + the execution plan** — never to the AI. The AI cannot grant permission to exceed a user-defined max risk, max leverage, max exposure, or any other user-defined execution limit.

**As of Sprint 3.5A, a deterministic Risk Guard is implemented** (`evaluateRiskGuard()` + six pure per-rule evaluators) and runs automatically right after a confirmed `ExecutionDraft` produces its `Trade`(`PLANNED`)/`Order`(`DRAFT`), plus on-demand via an explicit "重新检查风险" recheck. It is program logic only — it never calls the AI, Prompt Builder, or Evidence Parser, and rule inputs come solely from user-configured `RiskSettings` (`qa_risk_settings`), the `ExecutionDraft`/`Order`/`Trade`, and current market state. A `PASS` result is persisted on the `Order` (`order.riskGuard`) and is a local eligibility signal only — it does **not** change `Order.status` away from `DRAFT`, does not submit anything, and does not imply exchange approval. Full rule/result-shape detail lives in code comments around `evaluateRiskGuard()`, not duplicated here.

**As of Sprint 3.5C, Risk Guard is additionally account-aware.** Three more rules (`account_balance`, `exchange_position_conflict`, `existing_position_protection`) read a live, read-only `ExchangeAccountSnapshot` (balance + full position detail + protective orders, via the Sprint 3.5B/3.5C exchange connection) and — unlike the six local rules — are never individually toggle-able: if no enabled/selected exchange connection can be resolved, or the real account cannot be read, all three deliberately `BLOCK` rather than silently falling back to a local-only `PASS`. This is a frozen safety choice, not an oversight. Risk Guard still never places, cancels, or amends anything — it only reads.

# Future Order / Position / Trade Boundary

`Position` is now formally defined as of Sprint 3.5D-C — see "Real Position Sync" below. It exists only as a **read-only mirror of real exchange data**, never as a locally-computed or AI/plan-derived object. The existing mock `Trade` shape (used by the legacy Trade List/Detail pages) must not be reused as this contract — it models a different, stronger claim ("a position is live, with simulated P&L") than anything here represents, real Order sync and real Position sync both included.

```
ExecutionDraft → Order → Position → Trade lifecycle
```

`Order`/`Trade`/`Position` are all now real, see below.

---

# Scenario Execution Readiness Gate (Sprint 3.5D-B.1)

Freezes the product boundary: **Strategy explains WHY. Scenario quantifies WHAT/WHEN/WHERE. Execution executes numbers.** `AI_RESPONSE_SPEC.md` v2.2.0 tightened what counts as a numerically-complete `PRIMARY` `ScenarioPlan` (real `entry`/`stopLoss`/`takeProfit`/`expiresAt`, plus a real `triggerStructured` for a `WAIT`-decision `PRIMARY`) — this section defines the ONE runtime gate that enforces the same bar against ANY scenario a user tries to act on, including a historical record stored under an older, looser Parser version.

**`evaluateScenarioExecutionReadiness(scenario, decision, referenceTime)`** — one pure function, `prototype/index.html`, returning `{ready: boolean, reasons: string[]}`. Never duplicated: this exact function is the sole authority reused by all three call sites below.

- `scenario`: any `ScenarioPlan` (not only `PRIMARY` — an `ALTERNATIVE`/`INVALIDATION` plan is evaluated the same way, since Strategy's "手动执行" is offered on every plan card).
- `decision`: the root `Decision` (`direction`/`action`/`confidence`) — used to know whether THIS plan is the immediately-actionable one (`priority==='PRIMARY' && decision.action==='ENTER'`, the only case `entry.type==='MARKET'` is valid) or a `WAIT`-gated one (requiring a real `triggerStructured`).
- `referenceTime`: whatever instant `expiresAt` should be checked against — the Parser passes the analysis's own generation time (rejecting an already-nonsensical AI output); UI call sites pass the real current time (catching a plan that has gone stale since it was generated, which is also exactly what makes a historical `CONDITIONAL`-entry record "cannot execute going forward" without any special-casing or record migration).

**The three call sites, all requiring `ready === true` before proceeding:**

1. **Strategy's execution buttons** ("手动执行"/"触发时提醒") — a not-ready plan renders both buttons unavailable (disabled/absent, never a working `data-action`) with an inline "该方案缺少可执行数值参数" explanation and the specific reasons; the click handlers re-check independently (never trust stale rendered state, same established pattern as `isMachineEvaluableTrigger()`'s own re-check).
2. **The Execution page guard** — a `DRAFT` (not-yet-confirmed) `ExecutionDraft` whose scenario fails readiness renders a block screen ("该方案不满足执行就绪要求" + the specific reasons) instead of the normal editable form — never an editable prose field standing in for an order parameter. This gate applies ONLY to `status==='DRAFT'`: an already-`CONFIRMED` draft is immutable history (Frozen Product Principle) and continues to render normally even under today's stricter bar.
3. **TESTNET submission eligibility** (`checkOrderSubmissionEligibility()`, Sprint 3.5D-B) — readiness is now required IN ADDITION to every existing check (`Execution CONFIRMED`, `Order DRAFT` with no `exchangeOrderId`, fresh Risk Guard `PASS`, TESTNET-only). This sprint does not submit any order — it only tightens the local eligibility gate a real submission would need to pass.

No `ExecutionDraft`/`RealOrder`/`RealTrade` field shape changed. The TESTNET hard guard, the fresh-Risk-Guard-recheck-before-write requirement, the LIVE prohibition, and the absence of `AUTO` are all unmodified — this gate is a fourth, additive check layered on top of them, never a replacement for any of them.

---

# Real Order Lifecycle Sync (Sprint 3.5D-A)

`RealOrder`/`RealTrade` (created by `createOrReuseRealTradeAndOrder()` on `ExecutionDraft` confirmation, `prototype/index.html`) gained a real, strictly **read-only-against-Binance** synchronization flow. Order submission itself remains unimplemented — every locally created `RealOrder` still starts `status: "DRAFT"`, `exchangeOrderId: null`, and nothing in this app ever sets `exchangeOrderId` to a non-null value. This section documents what happens once an order *does* carry a real `exchangeOrderId` (via a future submission sprint, or a synthetic test fixture).

**`RealOrder.status` lifecycle**: `DRAFT → SUBMITTED → PARTIALLY_FILLED → FILLED`, or `→ CANCELLED | REJECTED | EXPIRED` from `SUBMITTED`/`PARTIALLY_FILLED`. Never set directly from Binance's own raw status string — always through `mapExchangeOrderStatusToLocalOrderStatus()` (`NEW→SUBMITTED`, `PARTIALLY_FILLED→PARTIALLY_FILLED`, `FILLED→FILLED`, `CANCELED→CANCELLED`, `REJECTED→REJECTED`, `EXPIRED→EXPIRED`, anything else → `null`, safely rejected rather than guessed).

**Exchange read**: `GET /fapi/v1/order` (Binance USDT-M Futures, weight 1, verified against live docs 2026-08-09), proxied read-only by the backend at `GET /api/exchange/connections/:id/order?symbol=&orderId=`. No amend route exists alongside it (Sprint 3.5D-D adds a real cancel route elsewhere — see "Real Order Cancellation" below — this GET route itself remains read-only). The backend has no concept of a local `RealOrder` at all — `RealOrder`/`RealTrade` live only in the frontend's `localStorage`, exactly like `ExecutionDraft`; this route is a stateless proxy, parallel to the existing `/account` route.

**Connection resolution**: the sync flow resolves "the" exchange connection via the exact same rule Risk Guard already uses (`resolveRiskExchangeConnectionId()` — `RiskSettings.exchangeConnectionId` if set, else auto-resolve only when exactly one enabled connection exists, else a safe sync error). Never a second, independently-diverging choice.

**Required vs. never-attempted**: an order with `exchangeOrderId: null` is never looked up — the UI shows "尚未提交至交易所，无法同步订单状态" and offers no sync action. An order that IS exchange-linked exposes a manual "同步订单状态" button in Trade Detail only (`syncRealOrderFromExchange(orderId)`). **No automatic polling** — this is a manual-only capability, same restraint as `NOTIFY`'s Trigger Monitor being the only existing polling loop in this app.

**Failure handling**: any sync failure (missing/disabled connection, order not found, timestamp/network/rate-limit error, malformed response, unrecognized remote status) writes only `RealOrder.sync` (`{lastSyncedAt, lastSyncStatus:'SUCCESS'|'ERROR', lastSyncError}`) — `status`/`filled`/`exchangeSnapshot` are left exactly as they were. An unrecognized remote status is reported as `unsupported_exchange_order_status` and never corrupts local lifecycle.

**Trade propagation**: `RealTrade.status` only ever moves forward from the ENTRY order's synced state — `SUBMITTED`/`PARTIALLY_FILLED` → `OPENING` (from `PLANNED`), `FILLED` → `OPEN` (from `PLANNED`/`OPENING`, `openedAt` set from Binance's own `updateTime`, never a fabricated local timestamp), `CANCELLED`/`REJECTED`/`EXPIRED` with **zero** cumulative fill → `CANCELLED` (a partial fill already existing means the Trade is left alone, never auto-cancelled out from under it). An already-`OPEN`/further-along Trade is never regressed by a later sync — this is also what makes repeated sync idempotent (no duplicate Trade, no duplicate Order, no re-fired lifecycle event for a status already observed).

**Still explicitly not implemented (as of 3.5D-A)**: order submission/cancellation/amendment, `Position`, fees, and any automatic reconciliation/polling of Order state. Sprint 3.5D-B implements ONE narrow slice of submission — see below; cancellation, amendment, `Position`, and fees remain unimplemented even after 3.5D-B.

---

# Real Order Submission (Sprint 3.5D-B)

The app's first real exchange WRITE capability: `POST /fapi/v1/order` on Binance USDT-M Futures **TESTNET only**. At the time of this sprint (3.5D-B), everything else that could mutate exchange state — cancel, amend, leverage, margin mode, transfer, withdraw, protective-order (stop-loss/take-profit) submission, batch orders, LIVE, `AUTO` — remained unimplemented; Sprint 3.5D-D subsequently added cancellation (see "Real Order Cancellation" below) — everything else in that list is still unimplemented, and adding any of it remains a new, separate product decision, not an extension of this one.

**Eligibility**: only a `RealOrder` with `status: "DRAFT"` and `exchangeOrderId: null`, whose `role` is `"ENTRY"`/`intent` is `"OPEN"`, whose `orderType` is `"MARKET"` or `"LIMIT"` (nothing else), whose `RealTrade.status` is `"PLANNED"`, and whose `ExecutionDraft.status` is `"CONFIRMED"`. Any other state is rejected before any network call.

**Trigger**: exactly one explicit user click ("提交到 TESTNET" on Trade Detail), followed by a mandatory confirmation modal (symbol/side/order type/limit price/notional/leverage/environment, always visibly labelled TESTNET) — never automatic on `ExecutionDraft` confirmation, Risk Guard PASS, `NOTIFY` trigger, page load, or Order creation.

**Pre-submission Risk Guard**: the persisted `order.riskGuard` is never trusted for this decision — `runRiskGuardForOrder()` is re-run fresh (fresh market read, fresh account snapshot, fresh evaluation) immediately before the write, and a `BLOCKED` result (whether newly blocked or previously PASS and now blocked) stops submission.

**Scenario execution readiness** (Sprint 3.5D-B.1): `checkOrderSubmissionEligibility()` additionally requires `evaluateScenarioExecutionReadiness()` to report `ready:true` for the underlying `ScenarioPlan` — see "Scenario Execution Readiness Gate" above. This closes the gap where a user could otherwise manually patch numeric values into Execution's override fields for a plan that never itself passed numeric completeness (e.g. a historical `CONDITIONAL`-entry `WAIT` plan) and still reach TESTNET submission.

**Quantity resolution**: never client-computed. The backend resolves `quantity` itself from `positionSizeUsdt` (`ExecutionDraft`'s notional, NOT divided by leverage) ÷ a reference price (the LIMIT price, or a fresh `markPrice` for MARKET), against `GET /fapi/v1/exchangeInfo`'s `LOT_SIZE`/`MARKET_LOT_SIZE`/`MIN_NOTIONAL` filters, rounded DOWN to the valid step (decimal-safe, never a bare float `toFixed()`, never rounds up). Any validation failure (below min qty, above max qty, off-step, below min notional) BLOCKs locally — no request ever reaches Binance.

**Leverage**: never mutated. The account's real, already-configured leverage for the symbol is read via `GET /fapi/v2/positionRisk?symbol=` (also the source of the MARKET reference price) and compared against the plan's leverage; a mismatch, or an unreadable value, BLOCKs with "当前执行计划杠杆与交易所当前杠杆设置不一致。本版本不会自动修改交易所杠杆。" No `setLeverage`/`setMarginType` call exists anywhere.

**TESTNET hard guard**: enforced at three independent layers — `exchangeService.submitEntryOrderToBinanceTestnet()`, `binanceFuturesAdapter.resolveAndSubmitEntryOrder()`, and `submitBinanceFuturesEntryOrder()` itself — none trusts the others alone, and the frontend performs its own check before ever showing the confirmation modal. A LIVE connection returns `live_order_submission_not_supported`; there is no override.

**Route**: `POST /api/exchange/connections/:id/orders` — the one write route in this app, alongside the pre-existing read-only `GET .../account` and `GET .../order`. Backend-side structural validation (symbol/side/orderType/limitPrice shape) happens independently of whatever the frontend already checked; account-level Risk Guard logic itself still lives frontend-only (documented limitation — a future server-side Risk Guard would be needed before LIVE could ever be considered).

**Network ambiguity**: a write timeout or network error is fundamentally different from a read one — it might have reached Binance before the response was lost. Never auto-retried. Reported as `submission_status_unknown`, and the local `RealOrder.pendingClientOrderId` (set BEFORE the POST, so it survives a lost response) blocks a naive resubmission until resolved via `GET .../order?...&origClientOrderId=` (the same clientOrderId this app generated, from the local `orderId`) — found → treated as a successful submission; genuinely not found → cleared, safe to resubmit. A deterministic HTTP-level rejection (bad params, `-1021`, insufficient margin, filter failure) is never retried automatically either — no order was created, and the user may retry manually.

**Immediate fill**: MARKET orders on TESTNET can fill instantly. The response's real status (`NEW`/`PARTIALLY_FILLED`/`FILLED`) is mapped truthfully through the existing `mapExchangeOrderStatusToLocalOrderStatus()` — never forced to `SUBMITTED` — and `RealTrade.status` propagates through the same, reused `propagateEntryOrderStatusToTrade()` from 3.5D-A. No `Position` is created even on a full fill; Trade Detail's Position/PnL text is fill-state-aware (distinguishes no-fill / real-partial-fill / real-full-fill) but always says Position/PnL sync itself is not yet implemented — never a fabricated number.

**Still explicitly not implemented after 3.5D-B**: order cancellation, order amendment, leverage/margin-mode mutation, protective-order (stop-loss/take-profit) submission (a persistent on-screen disclosure says so once an order is submitted), `Position`, fees, LIVE, `AUTO`, and any automatic polling/reconciliation.

---

# Real Position Sync (Sprint 3.5D-C)

**Core Truth Rule (frozen)**: a local `RealPosition` may only ever be created or updated from a real, non-zero exchange position read (`GET /fapi/v2/positionRisk`, proxied by the existing `GET /api/exchange/connections/:id/account` route — no new backend endpoint was introduced). It is never created or inferred from an AI recommendation, a `ScenarioPlan`, an `ExecutionDraft` confirmation, or a local `RealOrder`'s status alone — a locally-observed `FILLED` order does not by itself create a `Position`; only a subsequent real exchange sync can.

**Persistence**: `qa_positions` (`localStorage`, `positionId → RealPosition`), the same pattern as `qa_orders`/`qa_trades_real`. `RealPosition` field names are deliberately kept aligned to the existing `ExchangePositionSnapshot` shape (Sprint 3.5B/3.5C) so the same `renderPositionCard()` renderer is reused verbatim in Trade Detail — no parallel rendering logic was written.

**Identity**: `(exchangeConnectionId, symbol, positionSide)`. `positionSide` is Binance's own raw hedge-mode label (`'BOTH'` in one-way mode, `'LONG'`/`'SHORT'` in hedge mode), already present on every `ExchangePositionSnapshot` since `normalizePositionRisk()` — this makes the identity key hedge-mode-safe by construction, without any separate "detect account mode" API call: one-way mode naturally collapses to one net Position per symbol; hedge mode naturally keeps two distinct Positions.

**Sync flow**: `syncPositionsFromExchange(connectionId)` reads a fresh account snapshot and, for every non-zero exchange position returned, creates-or-updates the matching local `RealPosition` by identity, overwriting every mutable field (quantity, prices, PnL, margin, liquidation price, protection) from the fresh read — **exchange always wins**, a local sync never merges or preserves a stale local value. Any previously-`OPEN` local Position for that connection absent from the fresh read is exchange-confirmed zero exposure and is marked `CLOSED` (never deleted — history is retained). Manual-only, triggered by the "同步交易状态" button (Trade Detail, combined with order sync) or "同步本地镜像" (Settings account page) — no automatic polling, same restraint as Real Order Lifecycle Sync and `NOTIFY`'s Trigger Monitor.

**Position ↔ Trade linking**: `linkPositionToTrade()` only links when exactly one local `RealTrade` satisfies the full defensible chain — same exchange-native symbol, same direction, an ENTRY `RealOrder` with a real `exchangeOrderId` and `filled.quantity > 0`, and (when the order's own `exchangeConnectionId` is known) the same connection. Zero matches (a pre-existing exchange position this app never created) or more than one match (ambiguous) both leave the Position unlinked (`sourceTradeIds: []`) — the linkage is never guessed. Idempotent: an already-linked Position is never re-evaluated on a later sync, so it can never be silently reassigned.

**Trade Detail rendering**: fully truthful, three-way state — no real fill yet ("尚未建立仓位"), real fill but not yet synced to a Position ("订单已成交，等待交易所持仓同步"), or a linked `RealPosition` (real `renderPositionCard()`, real `unrealizedPnl` in the header). A real `OPEN` Position with an empty `protection.stopLossOrders` shows a prominent warning ("当前真实仓位尚未检测到止损保护。当前版本不会自动提交 AI 计划中的止损/止盈订单。"). AI-planned protection (`effective.stopLoss`/`effective.takeProfit`) is always rendered in a separate, clearly-labeled block ("AI 计划保护（尚未提交至交易所）") — never merged into the real exchange protection list, so a plan level can never be mistaken for a live exchange order. An unlinkable-but-matching real position renders an explicit ambiguity notice rather than guessing.

**Still explicitly not implemented after 3.5D-C**: automatic/background position reconciliation, protective-order (stop-loss/take-profit) submission, fees, realized-PnL/history tracking, order cancellation/amendment, leverage/margin-mode mutation, LIVE, `AUTO`.

---

# Real Order Cancellation (Sprint 3.5D-D)

The app's SECOND real exchange write capability (at the time of this sprint, 3.5D-D; Sprint 3.5D-E subsequently added a third and fourth — see "Real Trade Protection" below): `DELETE /fapi/v1/order` on Binance USDT-M Futures **TESTNET only**. Amend/replace, leverage/margin-mode mutation, transfer, withdraw, LIVE, and `AUTO` all remain unimplemented; adding any of them is still a new, separate product decision.

**Eligibility**: only a `RealOrder` with `status: "SUBMITTED"` or `"PARTIALLY_FILLED"` AND a real `exchangeOrderId`. `DRAFT`/`FILLED`/`CANCELLED`/`REJECTED`/`EXPIRED`, or any order missing `exchangeOrderId`, is rejected before any network call — no exchange cancellation is ever attempted for a terminal or not-yet-submitted order.

**Trigger**: exactly one explicit user click ("撤销 TESTNET 订单" on Trade Detail) — never automatic on Scenario expiry, a Risk Guard result changing, a Position update, or page load. See "Non-Automatic Boundaries" below.

**Fresh pre-cancel check (mandatory, before any confirmation UI)**: reuses the existing read-only order-sync flow (`syncRealOrderFromExchange()`, Sprint 3.5D-A) verbatim — never a second, diverging GET path. The local order is always re-synced to the exchange's CURRENT real status before a cancellation is ever attempted:
- Remote `FILLED` → no `DELETE` is ever sent; local state is synced to `FILLED` (truthfully, via the existing sync path) and a Position Sync runs immediately, since a full fill may have just created real exposure.
- Remote `CANCELED`/`REJECTED`/`EXPIRED` (already terminal — e.g. a previous cancellation already went through) → no `DELETE`, local state synced to match. This is also the mechanism that makes repeated cancel clicks idempotent (see below) — a stale click can never send a second `DELETE` once exchange truth is terminal, because this fresh check always runs first.
- Remote `NEW`/`PARTIALLY_FILLED` (still genuinely live) → proceeds to the mandatory confirmation modal, populated with the just-refreshed data.

**Confirmation modal**: shows environment (always visibly TESTNET), symbol, side, order type, `exchangeOrderId`, current exchange status, committed/executed/remaining quantity, and average fill price if any. For a `PARTIALLY_FILLED` order, an explicit warning is shown: cancellation only cancels the remaining unfilled quantity — the already-filled portion is never rolled back. Never a one-click cancel.

**Backend route**: `DELETE /api/exchange/connections/:id/orders/:exchangeOrderId?symbol=` — the app's second write route, alongside the existing `POST .../orders` (submission). Enforces TESTNET, a resolvable/enabled connection with credentials, a normalized symbol, and a numeric-looking order id shape before ever calling the exchange. Ownership boundary, documented honestly (not pretended away): this backend has no concept of a local `RealOrder` — `RealOrder`/`RealTrade` live only in the frontend's `localStorage` — so it cannot verify that the `exchangeOrderId` passed to it actually "belongs" to whoever is calling. The frontend's own client-side guard only ever operates on an `exchangeOrderId` already associated with the current local `RealOrder` (never a free-text field a user could type an arbitrary id into).

**TESTNET hard guard**: enforced at three independent layers — `exchangeService.cancelEntryOrderOnBinanceTestnet()`, `binanceFuturesAdapter.cancelBinanceFuturesTestnetOrder()`, and the frontend's own pre-modal check — same discipline as submission. A LIVE connection returns `live_order_cancellation_not_supported`; there is no override.

**Symbol normalization**: reuses the existing `toBinanceFuturesSymbol()` adapter-boundary conversion (the symbol-normalization hotfix) — never a second implementation.

**Network ambiguity**: identical philosophy to submission (Sprint 3.5D-B) — a `DELETE` timeout or network error might have reached Binance before the response was lost, so it is never auto-retried. Reported as `cancellation_status_unknown`; the user recovers via the existing "同步订单状态" sync action (the same `GET .../order` path), never a second automatic `DELETE`. A deterministic HTTP-level rejection (e.g. Binance `-2011`, "order does not exist" — already filled/cancelled/never existed) is likewise never retried; it is mapped to `order_not_cancellable`.

**Response normalization**: reuses the existing `normalizeExchangeOrder()` normalizer and `mapExchangeOrderStatusToLocalOrderStatus()` mapper — never a second, parallel implementation. The remote status is never forced to `CANCELED`; whatever Binance actually returns is what gets mapped and stored.

**Fill truth is never erased by cancellation**: on a confirmed cancellation, `RealOrder.filled.quantity`/`filled.averagePrice` are always preserved from the last known real fill — never reset to zero. `RealOrder.status` moves to whatever the mapped remote status is (typically `CANCELLED`).

**Trade lifecycle**: reuses the existing `propagateEntryOrderStatusToTrade()` function verbatim (Sprint 3.5D-A) — no new lifecycle logic was written for cancellation. Zero cumulative fill at the moment of cancellation → `RealTrade.status → CANCELLED` (matches the function's existing CANCELLED/REJECTED/EXPIRED branch). Any partial fill (`filled.quantity > 0`) → the Trade is left exactly as-is (already-real exposure is never wiped out by a cancellation of the remaining unfilled quantity).

**Position Sync after cancellation**: if the cancelled order had `filled.quantity > 0`, a fresh `syncPositionsFromExchange()` (Sprint 3.5D-C) runs immediately after a confirmed cancellation — exchange truth decides whether a real `Position` exists; none is ever fabricated if the exchange reports none. A zero-fill cancellation never triggers a Position Sync (nothing real to sync, and Position Sync is never called speculatively).

**Non-Automatic Boundaries (frozen, explicit)**:
- **Scenario expiry never auto-cancels a live exchange order.** If the Scenario's `reviewHorizon.expiresAt` has passed while the entry order is still `SUBMITTED`/`PARTIALLY_FILLED` on the exchange, Trade Detail shows a passive notice ("策略方案已过期，但交易所订单仍有效。请手动决定是否撤单。") — the order itself is never touched. This is a deliberate current-MVP boundary, not an oversight; automatic reconciliation is a future, separate product decision.
- **A Risk Guard result becoming `BLOCKED` after submission never auto-cancels.** Risk Guard's persisted/rechecked result is surfaced (existing `renderRiskGuardCard()`/"重新检查风险"), but nothing in this app connects a `BLOCKED` Risk Guard result to any cancellation call — cancellation remains a manual, one-click-at-a-time user decision at all times.

**Idempotency**: a repeated click of "撤销 TESTNET 订单" on an order that was already successfully cancelled (by an earlier click, or by an earlier ambiguous `DELETE` that actually succeeded) can never send a second `DELETE` — the mandatory fresh pre-cancel check always runs first and will discover the terminal state before any write is attempted.

**Local records are never deleted by cancellation** — `RealOrder`/`RealTrade`/`ExecutionDraft`/`AIResponseRecord` all persist through a cancellation; only `RealOrder.status` (and, for zero-fill, `RealTrade.status`) transitions. Full traceability is preserved, matching the Trade Detail "read-only, immutable history" principle at the record level (status transitions are the one exception that principle already allows, same as every other real order-lifecycle transition in this app).

**Still explicitly not implemented after 3.5D-D**: order amendment/replacement, leverage/margin-mode mutation, protective-order (stop-loss/take-profit) submission, automatic/scheduled cancellation of any kind, LIVE (submission or cancellation), `AUTO`, fees, and any automatic reconciliation/polling.

---

# Real Trade Protection (Sprint 3.5D-E)

Upgrades the previously entry-only write path into a full trade plan: `ExecutionDraft → RealTrade → Entry Order → Real Fill/Position → Stop Loss Protection → Take Profit Protection → Protection Verification`. The app's THIRD and FOURTH real exchange write capabilities: `POST`/`DELETE /fapi/v1/algoOrder` on Binance USDT-M Futures **TESTNET only**, via Binance's Algo Service.

**Before Coding research (2026-08-10, live-verified, not assumed from memory or from this codebase's pre-existing read-only comments)**: conditional orders (`STOP_MARKET`/`TAKE_PROFIT_MARKET`/`STOP`/`TAKE_PROFIT`/`TRAILING_STOP_MARKET`) migrated off `/fapi/v1/order` on 2025-12-09 and are created via `POST /fapi/v1/algoOrder` (`algoType=CONDITIONAL`). Cancelled via `DELETE /fapi/v1/algoOrder` and queried singly via `GET /fapi/v1/algoOrder` — both accept either `algoId` or `clientAlgoId`, and **neither requires `symbol`** (confirmed against two independent sources — this genuinely differs from the plain-order cancel/query endpoints, which do require `symbol`). The existing read-only `GET /fapi/v1/openAlgoOrders` (Sprint 3.5C) is unchanged and remains correct for listing currently-open protective orders. Cancel Algo Order's real response shape is `{algoId, clientAlgoId, code, msg}` — deliberately NOT reused as the full order-snapshot type, to avoid fabricating defaulted values for fields it doesn't actually return.

**Core Truth Rule (frozen, same discipline as Real Position Sync)**: protection quantity is ALWAYS derived from a real filled order quantity or real `RealPosition.quantity` — **never** from `ExecutionDraft.userOverrides.positionSize` (USDT) or any AI/plan text. Protection quantity never exceeds the real position quantity (`Math.min(position.quantity, entryOrder.filled.quantity)`), rounded down to the real `LOT_SIZE` step (reuses the existing `roundDownToStep()`/`extractSymbolFilters()`, never rounds up).

**Take-Profit portions**: `ScenarioPlan`/`AI_RESPONSE_SPEC.md` do not define a `portion` field (checked before writing any code) — this is purely an `ExecutionDraft.userOverrides.takeProfit[i].portion` concept. Strict rule, enforced by `validateTakeProfitPortions()`: every portion must be `>0`, and the sum across all take-profit targets must equal exactly `100` (1e-6 floating-point tolerance only — never a real rounding allowance). The system never auto-splits or auto-corrects an incomplete/invalid portion set; the user must supply valid values, or submission is blocked. If a `ScenarioPlan.takeProfit[i].portion` value is ever present (not currently possible — no Parser/Prompt change was made this sprint), it is used as the initial suggested value only, same override-snapshot mechanism as every other user-editable field.

**Stop Loss semantics**: exactly one `STOP_MARKET` order, always covering 100% of the real protectable quantity — no user-editable portion for stop loss this sprint.

**`RealOrder.role` extension (additive)**: gains `'STOP_LOSS'` and `'TAKE_PROFIT'` (alongside the existing `'ENTRY'`), with `intent: 'CLOSE'` (vs entry's `'OPEN'`) so no existing `role==='ENTRY' && intent==='OPEN'` filter (e.g. `checkOrderSubmissionEligibility()`) ever mistakes a protection order for an entry order. `TAKE_PROFIT` orders additionally carry `targetIndex` (which take-profit target, 0-based) and `portion` — never a copy of the whole `ScenarioPlan`. `exchangeOrderId`/`clientOrderId` semantically hold the real `algoId`/`clientAlgoId` once submitted — no new fields were needed for this, and no separate id generator either (`genOrderId()` is reused verbatim).

**`RealTrade.protectionStatus` (additive)**: `NOT_REQUIRED | PENDING_ENTRY_FILL | PENDING_PROTECTION | PROTECTED | PARTIALLY_PROTECTED | PROTECTION_FAILED`. Starts `NOT_REQUIRED` at Trade creation (no fill exists yet). Only `reconcileTradeProtection()` and the entry-order cancellation path (below) ever transition it.

**Entry submission orchestration**: MARKET (and a LIMIT that happens to fill immediately on TESTNET) — if the entry order comes back `FILLED` with `filled.quantity>0`, `reconcileTradeProtection()` is triggered immediately as part of that same submission call, never a second user click. A LIMIT entry that reaches the exchange as `NEW`/`SUBMITTED` with zero fill is marked `PENDING_ENTRY_FILL` — no protection order is ever submitted while zero-fill. When the user's own manual "同步订单状态"/"同步交易状态" action later discovers a real fill, `reconcileTradeProtection()` continues automatically as part of that same manual sync (never automatic background polling) — the user never needs a second, separate "submit protection" click. Absolute rule, verified by tests: a failed/ambiguous entry submission never reaches protection logic at all.

**`reconcileTradeProtection(tradeId)`**: the ONE reconciliation function. Reads the real `RealTrade`/`RealOrder`/`RealPosition` plus a fresh `syncPositionsFromExchange()` call, and creates ONLY what protection is currently missing (one `STOP_LOSS`, one `TAKE_PROFIT` per valid portion target) — idempotent and safe to call repeatedly; an existing active protection order for a given `(role, targetIndex)` slot is never resubmitted. Deliberately does **not** amend or auto-cancel/auto-recreate an existing protection order under any circumstance this sprint (a documented, deliberate MVP boundary — if a real fill quantity later grows beyond what an already-active protection order covers, this is reported honestly as `PARTIALLY_PROTECTED`, never silently fixed). The same function powers: the automatic post-fill continuation above, the manual "重新建立保护" button (Trade Detail — re-runs reconciliation only, **never** resubmits the entry order), and the cancellation-interaction rule below.

**TESTNET hard guard**: enforced at three independent layers — `binanceFuturesAdapter.resolveAndSubmitProtectionOrder()`/`cancelBinanceFuturesProtectionOrder()`, `exchangeService.submitProtectionOrderToBinanceTestnet()`/`cancelProtectionOrderOnBinanceTestnet()`, and `reconcileTradeProtection()`'s own frontend-side connection-environment check (added after a test caught its absence — see Regression below) — identical discipline to entry submission/cancellation. A LIVE connection blocks before any network call; there is no override.

**Duplicate prevention**: identical `pendingClientOrderId`-before-POST discipline as entry-order submission (Sprint 3.5D-B) — persisted before the network call, survives a lost response. A write timeout/network failure is reported ambiguous and never auto-retried; recovery is via `GET /fapi/v1/algoOrder?clientAlgoId=` (`getBinanceFuturesAlgoOrder()`/`recoverAmbiguousProtectionSubmission()`), never a second blind `POST`.

**Hedge Mode / Position Side (Task K/M)**: never assumes one-way mode. `position.positionSide` — Binance's own raw hedge-mode label, already present on every synced `RealPosition` since Sprint 3.5D-C — decides the parameter shape: one-way mode (`'BOTH'`) sends `reduceOnly=true` with `positionSide` omitted; Hedge Mode (`'LONG'`/`'SHORT'`) sends `positionSide` explicitly and never sends `reduceOnly` (Binance rejects `reduceOnly` in Hedge Mode — refused locally before any network call rather than silently dropped if the caller requests it). Protection side is always the closing side: a `LONG` position gets a `SELL` protection order; a `SHORT` position gets `BUY`.

**Cancellation interaction (Task R)**: cancelling a zero-fill entry order sets `protectionStatus → NOT_REQUIRED` (nothing was ever filled). Cancelling the remaining quantity of a partially-filled entry order **never** removes existing protection — `reconcileTradeProtection()` is invoked instead, honestly re-confirming coverage of whatever real exposure still exists.

**Scenario expiry / Risk Guard state changes (Task S)**: neither ever triggers any automatic action on Entry, Position, or Protection — real exchange state always takes priority over the AI Scenario's own lifecycle once a real trade has begun. Trade Detail shows a passive notice only.

**UI**: the Execution page's take-profit editor gains a required, live-validated portion input per target (Task C). The confirmation modal (Trade Detail, "提交完整交易计划到 TESTNET" — renamed from "提交到 TESTNET") now shows the full plan (entry + stop loss + every take-profit target with its portion), not entry alone. Trade Detail gains a "保护状态" card showing each real protection order's trigger price/portion/status/protected quantity/`algoId`, with an honest `保护状态未知` state (never a false "no stop loss" claim) when protection-read itself failed. The existing Position card's real exchange protection (from `RealPosition.protection`, Sprint 3.5D-C) and the separately-labeled "AI 计划保护" block remain fully distinct, as already established.

**Still explicitly not implemented after 3.5D-E**: order amendment, leverage/margin-mode mutation, LIVE (any write), `AUTO`, trailing-stop strategy generation, OCO linking, automatic cancel+recreate of an under-sized protection order, fees, and any automatic reconciliation/polling beyond what a user's own manual sync action already triggers.

---

# Position Allocation (Sprint 3.6A)

Formalizes a fact already empirically observed during Sprint 3.5D-E.1's real verification: in One-way Mode, one real exchange net `RealPosition` can be the combined result of MULTIPLE local `RealTrade`s' entries, plus quantity this app never touched at all (a pre-existing or externally-placed contribution). `linkPositionToTrade()` (Sprint 3.5D-C) remains unchanged — still exactly-one-link-ever, still used only for the Position Card's "查看关联交易详情" convenience link. `PositionAllocation` is a purely additive, more honest model layered alongside it.

**Shape** (`qa_position_allocations`, `allocationId → PositionAllocation`): `{allocationId, positionId, tradeId, exchangeConnectionId, symbol, side, quantity, sourceOrderId, createdAt, updatedAt}`.

**Creation rule (frozen, Core Truth Rule)**: `reconcilePositionAllocations(position)` is the ONE place an allocation is ever created — only for a `status:'OPEN'` Position, only for a Trade whose ENTRY `RealOrder` has a real `exchangeOrderId` and `filled.quantity > 0` on the same connection/symbol/direction (identical candidate criteria to `linkPositionToTrade()`), and `quantity` is always exactly that Trade's own real filled ENTRY quantity — never `positionSizeUsdt`, never AI/plan/DRAFT data. Unlike `linkPositionToTrade()`, exclusivity is never enforced: every qualifying Trade gets its own allocation row. Idempotent per `(tradeId, positionId)` — an existing allocation's `quantity` is NEVER rewritten by a later reconciliation; a Trade's own ENTRY fill quantity is a frozen historical fact once it exists.

**`allocationStatus` (computed, never persisted)**: `getPositionAllocationSummary(position)` sums every known allocation's `quantity` and compares against the real Position's current `quantity`. `'OK'` when the sum is within real quantity — the remainder (`unattributedQuantity`) is honestly shown as external/pre-existing exposure this app never claims ownership of. `'CONFLICT'` when the sum EXCEEDS real quantity (an external reduction, or a Trade's own protection order partially closing its share) — flagged to the user, never silently resolved, and no allocation's `quantity` is ever auto-adjusted to make the numbers agree.

**Disclosed MVP limitation**: a later partial close of a Trade's own share (its own take-profit target filling, for example) is not separately tracked — it shows as `CONFLICT` rather than going silently stale, but the model does not attempt to guess which Trade's share actually shrank. This is intentional, not an oversight: guessing under ambiguity is exactly what this model refuses to do.

**UI**: `renderPositionAllocationBlock(position)` (a "仓位归因" block, header note: "该持仓可能由交易所层面的同一净仓位与其他来源共享") is folded into `renderPositionCard()` itself when a local `RealPosition` is resolvable — so both Trade Detail (which already renders `renderPositionCard()` verbatim) and the new Account page's position list show it automatically, with zero duplicated rendering logic.

---

# Real Leverage Sync (Sprint 3.6A)

The app's FIFTH real exchange write capability: `POST /fapi/v1/leverage` (verified live 2026-08-10 — request `{symbol, leverage}`, response `{leverage, maxNotionalValue, symbol}`) on Binance USDT-M Futures **TESTNET only**. No margin-type (`setMarginType`) mutation exists anywhere in this app.

**Origin**: Sprint 3.5D-B's entry-submission leverage check (`leverage_mismatch` — the account's real configured leverage differs from the plan's) was, until this sprint, a dead end: a BLOCK with no in-app recovery path. `resolveAndSubmitEntryOrder()` now additionally returns `leverageMismatch: {symbol, current, required}` on that specific rejection (still never calling `setLeverage` itself — the mismatch check and the leverage-change write remain two fully separate code paths).

**Trigger**: never silent, never automatic. `submitRealOrderToTestnet()`'s caller receives `leverageMismatch` and opens `openLeverageSyncConfirmationModal()`, which shows current vs. required leverage, an environment=TESTNET badge, and an extra-strong warning if a real `RealPosition` already exists for that symbol on that connection (leverage changes affect that position's margin/liquidation-price math) — before the user ever sees a "取消" / "调整为 Nx 并继续" choice.

**Confirm → change → read-back-verify → rerun Risk Guard → continue**: `confirmLeverageSyncAndResubmit()` calls the real write, then — on success — calls `submitRealOrderToTestnet()` again. This is a deliberate, disclosed reuse rather than a second implementation: `resolveAndSubmitEntryOrder()`'s own leverage-match gate (`getSymbolLeverageAndMarkPrice`, unchanged since 3.5D-B) already re-reads REAL leverage via `positionRisk` before ever writing an order, and `submitRealOrderToTestnet()` already reruns Risk Guard fresh regardless — so the resubmission itself IS the read-back verification, never a second, potentially-diverging check. If the change did not actually take effect, resubmission fails again with a fresh `leverage_mismatch`, and the modal reopens with the newly-current numbers — never silently retried beyond this one explicit click each time.

**TESTNET hard guard**: enforced at three independent layers — `exchangeService.changeLeverageOnBinanceTestnet()`, `binanceFuturesAdapter.changeBinanceFuturesLeverage()`, and the fact this flow is only ever reachable from a `leverage_mismatch` response that itself can only occur inside the already-TESTNET-gated submission chain. A LIVE connection is rejected before any network call.

**Network ambiguity**: identical philosophy to every other write in this app — a timeout/network failure on the leverage-change call is reported `leverage_change_status_unknown`/`ambiguous:true` and never auto-retried; no resubmission is attempted until the user re-triggers the flow.

**Route**: `POST /api/exchange/connections/:id/leverage` — the app's fifth write route.

**Still explicitly not implemented**: margin-type mutation, Hedge/One-way Position Mode switching, batch/multi-symbol leverage changes, and any leverage change outside this one explicit recovery flow (there is no standalone "change leverage" button anywhere in the UI).

---

# Real-Time Account Updates (Sprint 3.6A)

A low-latency SSE channel layered on top of — and never replacing — REST reconciliation. Read-only capability, allowed for LIVE connections too (same as the pre-existing `GET .../account` snapshot route) since it only relays account/order event data, never a write.

**Before Coding research (2026-08-10)**: USDS-M Futures User Data Streams still require a `listenKey` (`POST`/`PUT`/`DELETE /fapi/v1/listenKey`, API-key-header-only, no HMAC signature — confirmed against the official docs' own examples, genuinely differing from every other endpoint in this app). LIVE's WebSocket architecture migrated to a split `/public`/`/market`/`/private` structure (legacy `wss://fstream.binance.com/ws`/`/stream` decommissioned 2026-04-23 per Binance's own "Important WebSocket Change Notice") — user data now connects at `wss://fstream.binance.com/private/ws/<listenKey>`. TESTNET's own documentation/community reports were observed inconsistent on whether the same split has been applied there yet (disclosed, not silently assumed) — TESTNET keeps the long-standing classic `wss://stream.binancefuture.com/ws/<listenKey>` host+path. Event field names (`ORDER_TRADE_UPDATE`'s `o.s/S/o/q/p/ap/sp/R/ps/X/z/i`, `ACCOUNT_UPDATE`'s `a.m/B[a,wb,cw]/P[s,pa,ep,up,mt,ps,bep]`) were cross-verified against Binance's own partial live examples plus this app's existing, already-trusted REST field mapping (`normalizeExchangeOrder()`) rather than a single unreliable doc fetch — disclosed as a real, if minor, verification limitation, and mitigated architecturally: see below.

**Architecture**: backend-only credentials (`pipeline/src/exchange/userDataStreamManager.ts`) — the browser never receives a `listenKey` or API key, only already-normalized event JSON over SSE (`GET /api/exchange/connections/:id/stream`). One `ConnectionStream` per `connectionId`, reference-counted across SSE subscribers (two browser tabs share one upstream Binance connection), auto-reconnecting with exponential backoff, `listenKey` refreshed every 50 minutes (Binance expires it after 60). Idle-teardown 30 seconds after the last SSE subscriber disconnects — an abandoned tab does not leak a `listenKey`/WebSocket forever.

**Trust boundary (frozen, the single most important rule in this section)**: a stream event is NEVER treated as complete truth. `NormalizedStreamEvent` (`ORDER_UPDATE`/`ACCOUNT_UPDATE`/`ACCOUNT_CONFIG_UPDATE`/`STATUS`) only ever schedules a debounced (2s) REST reconciliation (`loadAccountPageData()`, reusing the existing `syncPositionsFromExchange()`/account-snapshot/open-orders reads verbatim) — it never directly mutates displayed state. A burst of events collapses into exactly one REST refresh, never one per event. If a field the mitigated-verification-limitation above got wrong ever caused a malformed nudge, the worst case is a slightly-delayed refresh trigger — never a fabricated trading decision, since nothing safety-relevant is ever gated on stream data alone.

**Connection status**: `STATUS` events (`CONNECTING`/`CONNECTED`/`RECONNECTING`/`DISCONNECTED`) reflect the real upstream Binance WebSocket state, shown as a pill on the Account page; last-REST-sync time is shown separately. The UI never claims "已连接" while actually disconnected/reconnecting. The manual "立即刷新" button remains the recovery/debug path regardless of stream state — REST is never made unreachable by the stream's presence.

**Route**: `GET /api/exchange/connections/:id/stream` — read-only, no new write capability.

**Still explicitly not implemented**: WebSocket API (order placement over the stream connection itself), any write triggered by a stream event, and full field-by-field verified parity with Binance's own live `ACCOUNT_UPDATE` schema beyond the fields this app actually consumes (disclosed above).

---

# Account / Portfolio Page (Sprint 3.6A)

A new top-level page (`#/account`, sidebar "账户"), distinct from Settings (which remains connection/credential configuration only). Read-only: shows real account overview (`renderExchangeAccountSummary()`, reused verbatim from Settings), every real Position (App-originated and external undifferentiated in the list — each renders its own allocation breakdown per "Position Allocation" above), every real ordinary open Order, and every real open Algo/Protection order.

**App vs External ownership**: decided entirely by the frontend comparing a real exchange record's id (`exchangeOrderId`/algo `algoId`) against locally-known `RealOrder.exchangeOrderId`s for the same connection — the backend has no concept of a local Order at all (same honesty boundary as every prior write/cancel route). Never guessed from symbol/side/quantity similarity alone.

**Ordinary open orders**: `GET /api/exchange/connections/:id/open-orders` (new, read-only, reuses `normalizeExchangeOrder()`). Manual cancel available for BOTH ownership kinds — an App order reuses the existing `cancelRealOrderOnTestnet()`/confirmation-modal flow unchanged; an External order uses a new, parallel `cancelExternalOrderOnTestnet()` (same real `DELETE /fapi/v1/order` call, same TESTNET guard) behind a confirmation modal carrying an EXTRA, stronger warning ("这不是本应用提交的订单，本应用无法验证它的真实归属或用途") — since there is no local pre-cancel fresh-check path to reuse for an order this app never created.

**Algo/protection orders**: read from the existing account-snapshot's `protectiveOrders` (no new backend read). Deliberately NO cancel action in this UI — Sprint 3.5D-E's own decision ("撤销保护单需在对应交易详情页操作, avoiding a decontextualized cancel") is preserved, not revisited this sprint.

**Position-management actions**: exactly three, all read-only drill-downs — "查看详情" (navigates to the linked Trade if `sourceTradeIds` resolves one, else an honest "未关联" message), "查看保护" (a focused modal listing only that Position's real protective orders), "查看归因" (a focused modal listing only that Position's allocation breakdown). `ADD`/`REDUCE`/`CLOSE`/`REVERSE` do not exist anywhere in this UI, not even as disabled placeholders.

**Still explicitly not implemented**: any position-size-mutating action, Hedge Mode switching, margin-type mutation, portfolio-level aggregation/analytics beyond the per-connection view shown.

---

# Versioning

Current Version: **1.7.0**

- **Patch** (`1.0.x`): clarifications, wording fixes — no semantic changes.
- **Minor** (`1.x.0`): additive execution state/fields/modes, compatible with existing persisted `ExecutionDraft`s (e.g. adding `AUTO` once its prerequisites exist, adding a new `TriggerStatus` value additively) — or, as of 1.1.0, additive `RealOrder`/`RealTrade` lifecycle definition that doesn't touch `ExecutionDraft` at all.
- **Major** (`x.0.0`): destructive changes to `ExecutionDraft`'s shape or state-machine semantics (e.g. removing/renaming a field, changing what a `status`/`triggerStatus` value means).

Revision history:

1.0.0 (2026-08, Sprint 3.4B.1) — initial frozen contract, documenting the `ExecutionDraft`/`ExecutionMode`/`TriggerStatus` model and deterministic Trigger Monitor exactly as implemented and verified in Sprint 3.4A/3.4B. No behavioral changes.
1.1.0 (2026-08-09, Sprint 3.5D-A) — additive: documents the real, read-only `RealOrder`/`RealTrade` exchange-order-sync flow ("Real Order Lifecycle Sync" section). `ExecutionDraft`/`ExecutionMode`/`TriggerStatus`/Trigger Monitor unchanged. Order submission, `Position`, and `AUTO` remain unimplemented.
1.2.0 (2026-08-09, Sprint 3.5D-B) — additive: documents the app's first real exchange write, TESTNET-only manual entry-order submission ("Real Order Submission" section). `ExecutionDraft`/`ExecutionMode`/`TriggerStatus`/Trigger Monitor unchanged. LIVE, `AUTO`, cancel/amend, leverage/margin-mode mutation, protective-order submission, and `Position` remain unimplemented.
1.3.0 (2026-08-10, Sprint 3.5D-B.1) — additive: documents the new Scenario Execution Readiness Gate (`evaluateScenarioExecutionReadiness()`), required at Strategy's execution buttons, the Execution page guard, and TESTNET submission eligibility, in response to `AI_RESPONSE_SPEC.md` v2.2.0's tightened PRIMARY numeric-completeness rule. No `ExecutionDraft`/`RealOrder`/`RealTrade` field shape changed; TESTNET hard guard, Risk Guard recheck, no-LIVE, no-`AUTO` all unmodified.
1.4.0 (2026-08-10, Sprint 3.5D-C) — additive: formally defines `Position` for the first time (`RealPosition`, "Real Position Sync" section) as a read-only local mirror synced exclusively from real exchange data, never from AI/plan/local-order-status alone. Reuses the existing `GET .../account` route — no new backend endpoint, no new write capability. `ExecutionDraft`/`ExecutionMode`/`TriggerStatus`/Trigger Monitor/Real Order Submission unchanged; TESTNET hard guard, no-LIVE, no-`AUTO`, no cancel/amend/leverage-mutation all unmodified.
1.5.0 (2026-08-10, Sprint 3.5D-D) — additive: documents the app's second real exchange write, TESTNET-only manual order cancellation ("Real Order Cancellation" section, `DELETE /fapi/v1/order`). Reuses the existing Trade-lifecycle propagation function and status mapper verbatim — no new lifecycle logic. `ExecutionDraft`/`ExecutionMode`/`TriggerStatus`/Trigger Monitor/Real Order Submission/Real Position Sync unchanged; TESTNET hard guard, no-LIVE, no-`AUTO`, no amend/leverage-mutation all unmodified. Scenario expiry and Risk Guard state changes are explicitly documented as never auto-cancelling.
1.6.0 (2026-08-10, Sprint 3.5D-E) — additive: documents the app's third and fourth real exchange writes, TESTNET-only Stop Loss/Take Profit protection order submission and cancellation via Binance's Algo Service ("Real Trade Protection" section, `POST`/`DELETE /fapi/v1/algoOrder`). `RealOrder.role` gains `STOP_LOSS`/`TAKE_PROFIT` (plus `targetIndex`/`portion`); `RealTrade` gains `protectionStatus`; `ExecutionDraft.userOverrides.takeProfit[i]` gains `portion` — all additive, nothing renamed/removed. Protection quantity always derived from real filled/position data (never `positionSizeUsdt`), same Core Truth Rule as Real Position Sync (1.4.0). TESTNET hard guard, no-LIVE, no-`AUTO`, no amend/leverage-mutation all unmodified; no automatic action on Scenario expiry or Risk Guard state changes.
1.7.0 (2026-08-10, Sprint 3.6A) — additive: documents `PositionAllocation` ("Position Allocation" section — multiple `RealTrade`s may share one real net Position, attribution never exclusive, `allocationStatus: OK|CONFLICT` computed and never silently resolved); the app's fifth real exchange write, TESTNET-only leverage change ("Real Leverage Sync" section, `POST /fapi/v1/leverage`, reachable only via an explicit user-confirmed recovery off the existing `leverage_mismatch` BLOCK); a real-time SSE update channel that never replaces REST reconciliation ("Real-Time Account Updates" section); and a new top-level, read-only Account/Portfolio page ("Account / Portfolio Page" section). No `ExecutionDraft`/`RealOrder`/`RealTrade`/`RealPosition` field renamed or removed. Hedge Mode switching, margin-type mutation, and automatic CLOSE/REDUCE/REVERSE remain unimplemented and explicitly out of scope.

Future incompatible changes must be recorded here with the same rationale discipline as `AI_RESPONSE_SPEC.md`'s revision notes.

---

# Status

Frozen MVP Contract
