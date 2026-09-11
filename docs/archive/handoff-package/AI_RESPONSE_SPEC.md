# AI Response Specification

Version: 2.2.0

Status: Frozen

Last Updated: 2026-08-10

Revision note (2.2.0, 2026-08-10, Sprint 3.5D-B.1 — Numeric Scenario Enforcement + Absolute Expiry): additive minor revision, same precedent as 2.0.0→2.1.0 below (a behavioral tightening that adds no new field shapes, removes no field, and renames nothing — only what counts as a *complete* `PRIMARY` plan gets stricter). Freezes the product boundary "Strategy explains, Scenario quantifies, Execution executes": a `PRIMARY` `ScenarioPlan` intended for execution can no longer rely on prose standing in for a number. Summary of what changed and why:
- `entry.type: "CONDITIONAL"` is REMOVED as a valid final execution parameter for the `PRIMARY` plan, regardless of `decision.action` — previously it was the recommended shape for a `WAIT` `PRIMARY`'s not-yet-true condition; that logic now belongs in `triggerStructured`, and `entry` itself must always resolve to a real numeric `MARKET` (ENTER-only)/`LIMIT`/`ZONE`. The `CONDITIONAL` enum value itself is not removed from the type (kept for `ALTERNATIVE`/`INVALIDATION` plans and for tolerating historical records), only disallowed as `PRIMARY`'s final parameter.
- `entry.type: "MARKET"`'s shape is simplified — no `value` is required or expected (a market order's fill price isn't known in advance); it is valid ONLY when the `PRIMARY` plan is immediately actionable (`decision.action = "ENTER"`) — a `WAIT` `PRIMARY` must never use `MARKET`.
- `stopLoss.value` and at least one `takeProfit[].value` are now REQUIRED real numbers for the `PRIMARY` plan specifically — the existing description-only fallback (Numeric Precision, unchanged for `ALTERNATIVE`/`INVALIDATION` plans) no longer satisfies `PRIMARY`'s completeness.
- `reviewHorizon.expiresAt` is now REQUIRED (non-null) for `PRIMARY` — previously optional, `expiresAt?: string | null`, now `expiresAt: string` for `PRIMARY` specifically (still optional/nullable for `ALTERNATIVE`/`INVALIDATION`). It must be a real, timezone/offset-qualified absolute ISO-8601 timestamp, strictly after the analysis's own generation time — a natural-language-only horizon description no longer suffices by itself.
- `triggerStructured` is now REQUIRED (non-null, machine-evaluable using the existing frozen `price`/`candle_close` vocabulary — unchanged, not expanded) for a `PRIMARY` plan specifically when `decision.action = "WAIT"`. It remains optional when `decision.action = "ENTER"` (the setup is already actionable) and for `ALTERNATIVE`/`INVALIDATION` plans.
- A new conservative directional price-sanity rule applies to the `PRIMARY` plan whenever it has a real numeric entry reference price (`LIMIT`'s `value`, or `ZONE`'s midpoint — the midpoint is used ONLY for this sanity comparison, never as an actual order price; `MARKET` has no reference price and is exempt): for `LONG`, `stopLoss` must be below and every numeric `takeProfit` above the reference; for `SHORT`, the reverse. A violation is a hard rejection, never a silent correction.
- `ALTERNATIVE`/`INVALIDATION` plans are unaffected by any hard Parser rule change above (their existing 2.1.0 completeness — non-null object, description-or-value — still applies), but are now explicitly documented as *preferred* to meet the same full numeric standard whenever presented as a real future-actionable plan, enforced instead at the application layer (`evaluateScenarioExecutionReadiness()`, reused identically by Strategy/Execution/TESTNET-submission-eligibility) rather than as a hard Parser rejection for the whole response.
- No field was removed, renamed, or given a new type shape; the `AIResponse`/`ScenarioPlan`/`ReviewHorizon`/`StructuredTrigger` root structures are otherwise byte-for-byte unchanged from 2.1.0.

Revision note (2.1.0, 2026-08, Sprint 3.3D-C — Scenario Execution Contract v2.1): additive minor revision, approved as a Product Design (Scenario Execution Model v1). Every field added is optional; every existing field keeps its shape and meaning; the only behavioral tightening is that `ScenarioPlan.entry`/`stopLoss`/`takeProfit` may no longer be null/empty for ANY plan (including `WAIT`'s) — this refines 2.0.0's own "never an empty plan for WAIT" intent rather than contradicting it. Summary of what changed and why:
- `ScenarioPlan` gains three new optional fields: `triggerStructured` (a machine-parseable form of the existing human-readable `trigger`, using a controlled metric vocabulary), `invalidation` (a distinct concept from `stopLoss` — conditions that void the scenario *before* entry, not after), and `reviewHorizon` (how long the scenario itself stays relevant, distinct from `holdingPeriod`, which is duration *after* entry).
- Completeness is tightened: `entry`, `stopLoss` are no longer nullable and `takeProfit` may no longer be empty, for every `ScenarioPlan` regardless of `decision.action` — a `WAIT` plan must be exactly as complete as an `ENTER` plan, differing only in whether numeric precision is available (see Numeric Precision, unchanged). `reviewHorizon` is required (non-null, non-empty `description`) specifically for the `PRIMARY` plan.
- A controlled, program-owned machine-metric vocabulary is introduced (`price`, `candle_close` only, for now) — deliberately **not** an AI-declared capability flag; see Machine Evaluability below for why.
- `SourceAssessment`, `Decision`, `Confidence`, `Direction Resolution Policy`, `Reasoning`, `Risks`, `Evidence References` are **unchanged**.
- This sprint does not implement `ExecutionMode`, `ExecutionDraft`, monitoring, notifications, or automatic execution — see Scope and Governance.

Revision note (2.0.0, 2026-08, Sprint 3.3D-A — Strategy Decision Model v2): breaking, intentionally major revision, approved as a Product Design (see `product-docs/PRODUCT_STATUS.md`'s Frozen Product Decisions log for the design record). Summary of what changed and why:
- `decision.direction` no longer allows `"NEUTRAL"` — every completed analysis must resolve to `LONG` or `SHORT`. Evidence conflict is expected in a multi-source system and must be resolved, not used as an excuse to avoid a directional judgement.
- `decision.action` no longer allows `"EXIT"`/`"REDUCE"` — these are existing-position-management actions the system has no position-awareness to support yet (see Future Position-Management Compatibility below). Only `"ENTER"`/`"WAIT"` remain.
- `tradingPlan` (a single plan) is replaced by `scenarioPlans` (1–3 conditional plans). This directly fixes a 1.x defect: a `WAIT` decision could legally have `entry:null, stopLoss:null, takeProfit:[]` and no usable plan at all. Under 2.0.0, `WAIT` always ships at least one real conditional plan explaining what would justify acting.
- `weightContribution` is replaced by `sourceAssessments`. The 1.x `influenceScore`/`influenceLevel` fields read too close to "the AI re-weighted the user's source" — a meaning Product Principle 1 explicitly forbids. 2.0.0 replaces them with an explicit `direction`/`evidenceStrength` pair per source: `configuredWeight` still means "how much decision authority the user gave this source" (unchanged, still copied verbatim, still authoritative); the AI only ever reports what a source's current evidence says (direction) and how strong that evidence looks (LOW/MEDIUM/HIGH) — never a number implying it changed the user's weight.
- Confidence is re-anchored: it expresses how strongly the *weighted* evidence supports the *chosen final direction* — not "quality of available evidence" (which said nothing about how one-sided that evidence was).
- A new normative Direction Resolution Policy section is added, describing how the model should resolve conflicting cross-source evidence into one final direction without a runtime scoring formula.
- `reasoning`, `risks`, `evidence`/evidence-reference validation (namespaces, id-matching) are **unchanged** in shape and rules.
- This is a clean major-version cutover: the Parser accepts `responseVersion` major `2` only. Historical major-`1` `AIResponseRecord`s remain stored, immutable, unmigrated, unreparsed — see Compatibility/Versioning below.

Revision note (1.2.0, 2026-08): formalized four boundary conditions surfaced by implementing the Sprint 3.2C Parser against a real model response — `TradingPlan.entry`/`stopLoss` were nullable and `takeProfit` could be empty for non-`ENTER` decisions; `WeightContribution` completeness was an explicit rule; raw response preservation was an explicit rule; added the Compatible Minor-Version Policy. Superseded by 2.0.0 above except where explicitly carried forward (Raw Response Preservation, the reasoning 5-item cap, evidence-reference validation).

Revision note (1.1.0, 2026-08): added `weightContribution` to the AIResponse root and the `WeightContribution` type; added `stance` and `evidenceReferences` to `ReasoningItem`; added the `AIResponseRecord` persistence contract; clarified Missing Data / `dataQuality` handling; added the Scope and Governance section. Superseded by 2.0.0 above except where explicitly carried forward.

---

## Purpose

Defines the standard, provider-independent JSON shape every AI model's response must be parsed into, and the persistence contract for `AIResponseRecord`.

## When To Read

Read this document when:
- Parsing or validating a raw AI provider response
- Changing the Strategy output schema
- Checking what fields Strategy can rely on

Do NOT read this document when:
- Building the Prompt sent TO the AI (see `PROMPT_BUILDER_SPEC.md`)
- Working on provider-specific request/auth logic in `pipeline/src/ai/`

---

# Goal

Define the standard output produced by every AI model.

This specification is independent of:

- OpenAI
- Claude
- Gemini
- DeepSeek
- Local Models

Every AI model must produce the same response structure.

The Strategy page consumes this response.

Execution consumes Strategy.

Learning consumes completed Trade Results.

The AI never creates trades directly.

---

# Principles

The AI is an analysis engine.

It is NOT a trading engine.

It does not execute orders.

It does not modify Research.

It does not update weights.

It only returns one Strategy object.

## User Weight Is Authoritative (2.0.0)

The user-configured Research weight (`sourceWeights` in the Analysis Payload) is the sole, authoritative measure of how much decision authority a source has.

The AI must NEVER:

- change a `configuredWeight`
- normalize it into a "replacement" or "effective" weight
- rebalance it
- invent an "AI weight"

`SourceAssessment.configuredWeight` (below) is always copied verbatim from the Analysis Payload. The AI only ever assesses, per source: **direction** (what the evidence currently supports) and **evidence strength** (how clear/strong that evidence is) — never a competing notion of "how much weight this source should have."

---

# Output Format

The response must be valid JSON.

Markdown is not allowed.

Natural language introductions are not allowed.

The response must be machine-readable.

## Raw Response Preservation (carried forward from 1.2.0, unchanged)

The raw model output (`AIRawResult.rawText`) must always be retained exactly as received — the Parser must never truncate, repair, reorder, delete, or rewrite it, whether or not parsing/validation succeeds. A normalized, validated `AIResponse` object may be produced separately, but it never replaces or mutates the stored raw text.

---

# Root Structure

```ts
type AIResponse = {
  responseVersion: string;
  analysisId: string;
  summary: Summary;
  decision: Decision;
  scenarioPlans: ScenarioPlan[];
  sourceAssessments: SourceAssessment[];
  reasoning: ReasoningItem[];
  risks: RiskItem[];
  evidence: EvidenceReference[];
}
```

`analysisId` must match the `analysisId` of the Analysis Payload this response was generated from (`ANALYSIS_PAYLOAD_SPEC.md`).

`tradingPlan` and `weightContribution` (1.x) no longer exist at the root. See `scenarioPlans`/`sourceAssessments` below.

---

# Summary

Purpose

Provide a concise human-readable overview.

Structure

```ts
type Summary = {
  title: string;
  content: string;
}
```

Rules

- Maximum 150 words.
- No market storytelling.
- No unsupported claims.

(Unchanged from 1.x.)

---

# Decision (2.0.0)

Purpose

Describe the final market call and the current recommended action, as two **separate** questions.

```ts
type Decision = {
  direction: "LONG" | "SHORT";
  action: "ENTER" | "WAIT";
  confidence: number;
}
```

Rules

- `direction` must be exactly one of `LONG`/`SHORT`. **`NEUTRAL` is not a valid final direction.** Every completed analysis resolves to a market direction — see Direction Resolution Policy below for how conflicting source evidence is meant to be resolved into one direction, and Confidence for how an unclear/close call should be expressed instead of avoided.
- `action` must be exactly one of `ENTER`/`WAIT`. `EXIT`/`REDUCE` (1.x) are removed — they describe managing an *existing* position, which this response shape has no data to support yet (see Future Position-Management Compatibility).
- `direction` and `action` are independent questions: `direction` is "which way does the evidence point," `action` is "is it time to act." `LONG`+`WAIT` and `LONG`+`ENTER` are both valid, ordinary outcomes — `WAIT` never means the direction is unresolved.
- `confidence`: 0–100, see Confidence below.

## Future Position-Management Compatibility (2.0.0, design-only, not implemented this sprint)

This shape is designed to extend, in a future minor version, to existing-position management without breaking historical 2.x records:

- An optional top-level `positionContext: {state: "NONE"|"LONG"|"SHORT"}` field may be added.
- `action` may then additively gain `HOLD`/`ADD`/`REDUCE`/`CLOSE`/`REVERSE`, valid only when `positionContext.state !== "NONE"`.
- `ScenarioPlan.action` (below) is deliberately typed to grow the same way, so a future "Scenario A: reduce 50% / Scenario B: close remaining" response needs no new plan shape, only new enum values.

None of this is implemented in 2.0.0. It is recorded here only so a future minor version can add it additively (new optional field + new enum values) rather than requiring another major version.

---

# Confidence (2.0.0 — re-anchored)

Confidence expresses how strongly the total weighted evidence (each `SourceAssessment`'s `direction`/`evidenceStrength`, combined per the user's `configuredWeight`) supports the **selected final direction**.

Confidence is NOT:

- probability of profit
- predicted win rate
- certainty of future price movement
- permission for the AI to override or reinterpret user-configured weights

Confidence and `action` are independent: a low-confidence direction can still be `ENTER` (a real, currently-executable setup can exist even when the weighted evidence is only mildly one-sided), and a high-confidence direction can still be `WAIT` (the evidence may point clearly one way while price hasn't yet reached a sound entry condition).

Numeric field and range (0–100) unchanged from 1.x. The Parser enforces the range; it does not and cannot verify the model's internal reasoning matched this definition.

---

# Direction Resolution Policy (2.0.0, new)

This is normative guidance for the model, not a runtime-computed value — the Prompt states it as a policy; the Parser only validates the resulting contract shape, never re-derives or checks the direction itself.

1. User-configured weights (`sourceWeights`) control how important each source is. The AI never changes them.
2. Each source is independently assessed for `direction` and `evidenceStrength` (see `SourceAssessment` below).
3. Conflicting evidence across sources is expected and normal in a multi-source system.
4. The existence of conflicting evidence is never, by itself, a reason to avoid choosing a final direction.
5. The final `decision.direction` is resolved from the overall *weighted* evidence balance — sources with more configured weight and stronger evidence should count for more than sources with less weight or weaker evidence.
6. Even when the weighted balance is close, the model must still choose `LONG` or `SHORT` — a close balance is expressed through a **lower `confidence`**, never through avoiding the choice.
7. `action` (`ENTER` vs `WAIT`) is decided *after* `direction`, based only on whether a real, currently-executable setup exists (see Scenario Plan below) — never as a proxy for how confident or how contested the direction call was.

---

# Source Assessment (2.0.0 — replaces Weight Contribution)

Purpose

Report what each source's current evidence says, and how strong that evidence looks — never how much weight the AI gave it (that number belongs to the user alone, see User Weight Is Authoritative).

```ts
type SourceAssessment = {
  sourceId: string;
  configuredWeight: number;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  evidenceStrength: "LOW" | "MEDIUM" | "HIGH";
  explanation: string;
  evidenceReferences: string[];
}
```

Rules

- `configuredWeight` must exactly match the corresponding `sourceWeights[sourceId]` value in the Analysis Payload. The AI must never modify or reinterpret it.
- `direction` is per-source and MAY be `NEUTRAL` — unlike `decision.direction` (root), which may never be `NEUTRAL`. A source can honestly have no clear directional read while the overall analysis still resolves to a direction from the other sources.
- `evidenceStrength` is categorical only (`LOW`/`MEDIUM`/`HIGH`) — there is intentionally no numeric strength score in 2.0.0. A model-generated numeric score in this position was found, across the 1.x lineage, to add spurious precision without added value for a source-level qualitative read; the categorical value is simpler, more consistently produced by the model, and sufficient for future Learning (e.g. "this source at `HIGH` was directionally wrong 3 times in a row" is a fully actionable signal without a numeric score).
- `sourceId` values are the same 11 Dashboard source keys used in `AnalysisPayload.sourceWeights`, plus any `additionalEvidence[].id` that meaningfully contributed.
- Every assessment must reference evidence from the Analysis Payload via `evidenceReferences` (same mechanism as Evidence References below).

## Completeness (carried forward from 1.2.0's Weight Contribution Completeness, unchanged rule, renamed field)

For every system source (one of the 11 Dashboard source keys) where `sourceWeights[sourceId] > 0` in the Analysis Payload, `sourceAssessments` must contain exactly one matching entry — even when that source's evidence is unclear or weak. A `NEUTRAL`/`LOW` source must still be reported, never omitted.

A system source with `configuredWeight = 0` does not need to appear. If it does appear, it is reported for completeness only and must not be treated as decision-authoritative (i.e. must not materially affect `decision.direction`).

`additionalEvidence[].id` entries remain optional in `sourceAssessments`, appearing only when they meaningfully contributed.

Invalid:

- A weight > 0 system source missing from `sourceAssessments`.
- A duplicated `sourceId`.
- A `sourceId` that does not correspond to any of the 11 system sources or any `additionalEvidence[].id` in the Payload.
- A mismatched `configuredWeight`.

---

# Scenario Plan (2.0.0 — replaces Trading Plan; completeness tightened and 3 fields added in 2.1.0)

Purpose

Every completed analysis returns 1–3 concrete, conditional trading paths — never a single plan, and never an empty or incomplete plan, for `WAIT` or `ENTER` alike.

```ts
type TriggerCondition = {
  metric: string;                     // controlled vocabulary — see Machine Evaluability below
  operator: "GT" | "GTE" | "LT" | "LTE" | "BETWEEN" | "CROSSES_ABOVE" | "CROSSES_BELOW" | "EQUALS";
  value?: number | string | null;     // required for GT/GTE/LT/LTE/CROSSES_ABOVE/CROSSES_BELOW/EQUALS
  min?: number | null;                // required for BETWEEN
  max?: number | null;                // required for BETWEEN
  timeframe?: string | null;          // required (non-empty) for candle_close; must be null/omitted for price
};

type StructuredTrigger = {
  description: string;
  logic: "ALL" | "ANY";
  conditions: TriggerCondition[];     // at least 1 item
};

type ReviewHorizon = {
  description: string;
  expiresAt?: string | null;          // (2.2.0) REQUIRED non-null for PRIMARY — see PRIMARY Numeric Execution Readiness below; still optional for ALTERNATIVE/INVALIDATION
};

type ScenarioPlan = {
  id: string;
  priority: "PRIMARY" | "ALTERNATIVE" | "INVALIDATION";
  direction: "LONG" | "SHORT";
  action: "ENTER";
  title: string;
  trigger: string;                              // human-readable — always required, never removed
  triggerStructured?: StructuredTrigger | null;  // (2.1.0) machine-parseable form; (2.2.0) REQUIRED non-null+evaluable for a WAIT-decision PRIMARY specifically
  invalidation?: StructuredTrigger | null;       // (2.1.0) conditions that void this scenario BEFORE entry
  reviewHorizon?: ReviewHorizon | null;           // (2.1.0) required (non-null) for the PRIMARY plan; (2.2.0) expiresAt inside it also now required for PRIMARY
  holdingPeriod?: string;
  entry: {
    type: "MARKET" | "LIMIT" | "ZONE" | "CONDITIONAL";  // (2.2.0) CONDITIONAL is no longer a valid PRIMARY final parameter — see PRIMARY Numeric Execution Readiness below
    value?: number | null;                              // (2.2.0) MARKET no longer uses this field at all; LIMIT requires it
    from?: number | null;
    to?: number | null;
    description?: string | null;
  };                                              // (2.1.0) no longer nullable — see Completeness
  stopLoss: {
    value?: number | null;                        // (2.2.0) REQUIRED (finite, >0) for PRIMARY — description alone no longer suffices for PRIMARY
    description?: string | null;
  };                                              // (2.1.0) no longer nullable — see Completeness
  takeProfit: Array<{
    value?: number | null;                        // (2.2.0) at least one item's value REQUIRED for PRIMARY
    description?: string | null;
  }>;                                              // (2.1.0) no longer may be empty — see Completeness
  rationale: string;
  evidenceReferences: string[];
}
```

## Two Different `action` Fields — Do Not Confuse Them

`decision.action` (root) answers: **what should the user do right now?**

`ScenarioPlan.action` answers: **what action does this specific scenario recommend once its `trigger` condition becomes true?**

Because of this, `decision.action = "WAIT"` routinely coexists with `scenarioPlans[].action = "ENTER"` — a `WAIT` decision's Primary Scenario is an entry recipe gated behind a not-yet-true trigger, not a directionless placeholder. `ScenarioPlan.action` only ever legally contains `"ENTER"` (see Future Position-Management Compatibility for why the field exists as an extensible enum rather than a fixed literal).

## Cardinality

- Every response contains 1–3 `scenarioPlans`. 0 or more than 3 is invalid.
- Exactly one plan must have `priority: "PRIMARY"`. `ALTERNATIVE` and `INVALIDATION` are optional — a single `PRIMARY` plan alone is a valid, minimal Strategy.

## Completeness (2.1.0 — tightened, action-independent; 2.2.0 tightens PRIMARY further, see below)

**Every `ScenarioPlan`, regardless of `decision.action`, must be a complete trading plan:**

- `entry` must be a real object (no longer `null`).
- `stopLoss` must be a real object (no longer `null`); at least one of `stopLoss.value`/`stopLoss.description` must contain meaningful content.
- `takeProfit` must contain at least one item (no longer `[]`); each item must contain at least one of `value`/`description`.
- The `PRIMARY` plan specifically must also have a non-null `reviewHorizon` with a non-empty `description`. `ALTERNATIVE`/`INVALIDATION` plans may leave `reviewHorizon` as `null`.

This closes the 2.0.0 gap where a `WAIT` plan's `entry`/`stopLoss`/`takeProfit` could each independently be null/empty — completeness is no longer conditioned on `decision.action` at all. This is the shape-level floor that applies to every plan; the `PRIMARY` plan is held to a strictly higher, numeric-only bar — see PRIMARY Numeric Execution Readiness below.

## PRIMARY Numeric Execution Readiness (2.2.0, new — supersedes description-only completeness for PRIMARY)

Frozen product boundary for this section: **Strategy explains WHY. Scenario quantifies WHAT/WHEN/WHERE. Execution executes numbers.** Natural-language reasoning belongs in `summary`/`reasoning`/`risks`/`rationale`/`explanation` — never as a stand-in for a `PRIMARY` execution field.

**The `PRIMARY` plan must always satisfy ALL of the following, regardless of `decision.action`:**

- `entry` resolves to a real number: `MARKET` (`{type:"MARKET"}`, no `value` — allowed ONLY when `decision.action = "ENTER"`, since a `WAIT` `PRIMARY` has no current price to act on), `LIMIT` (`value` finite and `> 0`), or `ZONE` (`from`/`to` both finite and `> 0`, `from <= to`). **`entry.type: "CONDITIONAL"` is never valid for `PRIMARY`** — this is new in 2.2.0 and stricter than 2.1.0, which allowed it for a `WAIT` `PRIMARY`. A condition that genuinely isn't true yet belongs in `triggerStructured` (see below), not in `entry` — `entry` itself must still be one concrete numeric `LIMIT`/`ZONE` you would act on once triggered.
- `stopLoss.value` is a real, finite, positive number. Description alone (`stopLoss.description`) no longer satisfies `PRIMARY` — it remains a supplementary explanation only.
- `takeProfit` contains at least one item with a real, finite, positive `value`. Multiple numeric targets are welcome; a description-only item does not count toward this requirement.
- `reviewHorizon.expiresAt` is present and a real, timezone/offset-qualified absolute ISO-8601 timestamp, strictly after this analysis's own generation time (see Absolute Expiry below).
- If `decision.action = "WAIT"`: `triggerStructured` is present, non-null, and machine-evaluable using only the frozen `price`/`candle_close` vocabulary (unchanged, not expanded this revision) — see Machine Evaluability. A natural-language-only `trigger` string is no longer sufficient by itself for a `WAIT` `PRIMARY`. If `decision.action = "ENTER"`, `triggerStructured` on `PRIMARY` remains optional (the setup is already actionable).
- Directional price sanity (conservative, structural — see below) is satisfied whenever `entry` has a real reference price.

A `PRIMARY` plan failing any of the above is a hard Parser rejection (`schema_validation_failed`) for a freshly-submitted response — the model must never fabricate a number merely to pass this bar; if real, justified numbers cannot be produced, that is itself a reason to reconsider the plan rather than inventing one (unchanged principle, carried forward from Numeric Precision below).

`ALTERNATIVE`/`INVALIDATION` plans are **not** hard-Parser-rejected by this section — they remain governed by the baseline Completeness rule above (description-or-value still valid for them). They are, however, *strongly preferred* to meet this same numeric bar whenever presented as a real future-actionable plan (never leave an `ALTERNATIVE` as prose while `PRIMARY` is numerically strict) — this preference is enforced at the application layer via `evaluateScenarioExecutionReadiness()` (reused identically by Strategy's execution buttons, the Execution page guard, and TESTNET submission eligibility — see `EXECUTION_SPEC.md`), not as a whole-response Parser rejection.

## Directional Price Sanity (2.2.0, new)

A conservative structural check on the `PRIMARY` plan, applied whenever a real numeric entry reference price exists:

- **Reference price**: `LIMIT` uses its `value`; `ZONE` uses the midpoint of `from`/`to` — **for this sanity check only**, never as an actual order price (order-price resolution for a `ZONE` entry remains a separate, user-driven mechanism downstream in Execution). `MARKET` has no reference price at generation time and is exempt from this check entirely.
- **LONG**: `stopLoss.value` must be below the reference price; every numeric `takeProfit[].value` must be above it.
- **SHORT**: `stopLoss.value` must be above the reference price; every numeric `takeProfit[].value` must be below it.
- A violation is a hard Parser rejection (`schema_validation_failed`) — the Parser never silently corrects or reorders an AI's invalid numbers.

## Numeric Precision

- `entry.type: "CONDITIONAL"` remains valid for `ALTERNATIVE`/`INVALIDATION` plans describing a future execution condition without a fabricated exact price — when used, `entry.description` must be a meaningful non-empty string (e.g. "Enter only after a confirmed breakout above the current resistance zone"). The same description-over-fabrication principle applies to `stopLoss`/`takeProfit` on those plans: when a real number cannot be justified, use `description` instead. **As of 2.2.0, this fallback no longer applies to the `PRIMARY` plan** — see PRIMARY Numeric Execution Readiness above.
- The model must never fabricate `entry`/`stopLoss`/`takeProfit` numeric values, or a `reviewHorizon.expiresAt` timestamp, merely to satisfy the schema shape. A `description`-only value (still available for non-`PRIMARY` plans) is always preferable to an invented number — for `PRIMARY`, an inability to produce real numbers is itself a reason to reconsider the plan, not a license to invent one.

## Machine Evaluability (2.1.0, new)

`triggerStructured` and `invalidation` (both `StructuredTrigger | null`) exist to let a *future* deterministic monitor (not implemented this sprint) evaluate a trigger without a model call. Two rules govern this:

- **The model does not declare machine-evaluability.** There is no `machineExecutable` field anywhere in this schema, and none should ever be added. The Parser — not the AI — is the sole authority on which `metric`/`operator` combinations it accepts; the AI simply attempts to express a trigger using the controlled vocabulary below, or returns `null` when it can't.
- **Controlled metric vocabulary (frozen for 2.1.0): `price`, `candle_close` — nothing else.** Concepts like "support holds," "market stabilizes," "sentiment improves," or "breakout confirms" must stay in the human-readable `trigger`/`description` text; they must never appear as a `TriggerCondition.metric` value. Future minor versions may extend this vocabulary additively.
- `triggerStructured` is **optional** — if a trigger can be truthfully expressed with `price`/`candle_close`, the model should provide it; otherwise `null` is valid and expected. A plan with `triggerStructured: null` remains fully usable for manual execution — only future deterministic monitoring is unavailable for it.
- `TriggerCondition` operator/value requirements: `GT`/`GTE`/`LT`/`LTE`/`CROSSES_ABOVE`/`CROSSES_BELOW`/`EQUALS` require a finite numeric `value`; `BETWEEN` requires finite numeric `min`/`max` with `min <= max`. No string-to-number coercion is performed.
- `timeframe`: required (non-empty) when `metric = "candle_close"`; must be `null`/omitted when `metric = "price"`.

## Invalidation vs Stop Loss — Different Concepts (2.1.0)

`stopLoss` describes how a trade, once entered, is proven wrong — it only matters after entry.

`invalidation` describes conditions that void the *scenario itself*, which can happen **before** entry ever occurs (e.g. "cancel this breakout-long scenario if a 4H candle closes below 63,000 before the breakout happens"). It reuses the `StructuredTrigger` shape — no new primitive type. `invalidation: null` is valid when no such condition can be identified.

This is also distinct from `priority: "INVALIDATION"` (a whole alternate Scenario Plan describing what to do if the primary thesis fails) — do not confuse the two. A plan's own `invalidation` field says "when to discard *this* plan"; a sibling plan with `priority: "INVALIDATION"` says "what to do instead if the primary thesis is wrong."

## Review Horizon vs Holding Period — Different Concepts (2.1.0)

`reviewHorizon` = how long the **scenario itself** remains relevant *before* execution (e.g. "valid for the next 3 4H candles," "valid until the CPI release").

`holdingPeriod` = the expected trade duration *after* entry (unchanged from 2.0.0).

These must never be merged into one field.

## Absolute Expiry (2.2.0, new — supersedes the 2.1.0 "expiresAt only when justified" guidance for PRIMARY)

`reviewHorizon.expiresAt` is now **required** (non-null) for the `PRIMARY` plan — a natural-language-only horizon (e.g. "未来 3 根 4H K线," "未来 12 小时," "CPI 前," "未来 1-3 天" with no resolved timestamp) is no longer sufficient by itself. It remains optional/nullable for `ALTERNATIVE`/`INVALIDATION`.

Requirements for `PRIMARY`'s `expiresAt`:

- A real absolute ISO-8601 timestamp **with an explicit timezone or UTC offset** (e.g. `2026-08-10T17:00:00+08:00`, or a trailing `Z` for UTC). A bare `2026-08-10 17:00` with no zone is invalid — this is deliberate: `new Date()` would otherwise silently assume whichever machine happens to parse it, which is exactly the ambiguity this rule exists to prevent.
- Strictly after the analysis's own generation time. `expiresAt <= ` generation time is a hard rejection.

**Derivation (macro-event precedence)**: the model must derive `expiresAt` as the EARLIEST of its relative review horizon (converted to an absolute timestamp) and the next relevant HIGH-impact macro event visible in the Analysis Payload's `selectedNewsEvents` (if one falls before the horizon completes). If no relevant macro event exists, the horizon alone is used. If multiple qualify, the earliest is used. Exactly one resolved `expiresAt` is ever returned — never two competing deadlines; the model may explain its reasoning (including why a macro event took precedence) in `rationale`/`reasoning`, but `Execution` only ever receives the one final timestamp. This derivation happens entirely at the Prompt/model level — the Parser only validates the resulting timestamp's shape/timezone/futurity, it does not itself compute or verify macro-event precedence.

**Timezone display**: downstream UI displays `expiresAt` in the viewer's own local time with an explicit offset label (e.g. "2026-08-10 17:00 UTC+8") — never a bare, zone-less rendering.

## WAIT Semantics

`decision.action = "WAIT"` means: the final direction has been determined, but the current market snapshot does not yet satisfy the preferred execution condition for any scenario.

`WAIT` does NOT mean: no opinion, no plan, insufficient analysis, "evidence conflicted so I'm not committing," or an incomplete execution plan (no entry/stop/take-profit/review-horizon logic). It also never means an empty or all-null trading plan — that 1.x behavior is explicitly removed. 2.1.0 closed the gap making Completeness unconditional on `decision.action`; **2.2.0 goes further: a `WAIT` `PRIMARY` must be numerically JUST AS complete as an `ENTER` `PRIMARY`, differing only in that it additionally requires a real `triggerStructured` (see PRIMARY Numeric Execution Readiness above) and its `entry` must be `LIMIT`/`ZONE` (never `MARKET`, which has no future price).**

For a `WAIT` decision:

- 1–3 `scenarioPlans` are still required (same cardinality rule as `ENTER` — there is no separate, looser rule for `WAIT`).
- Exactly one `PRIMARY` plan is required, with a non-empty `trigger` (human-readable) AND a non-null, machine-evaluable `triggerStructured` (2.2.0 — see PRIMARY Numeric Execution Readiness), a fully numeric `entry`/`stopLoss`/`takeProfit` (2.2.0 — no more description-only fallback for `PRIMARY`), and a `reviewHorizon` with both a non-empty `description` and a required `expiresAt`.
- **`entry.type = "CONDITIONAL"` is no longer valid for a `WAIT` `PRIMARY` as of 2.2.0** (superseded from the 2.1.0 guidance below). If the trigger condition itself is what's pending, express it numerically in `triggerStructured` — `entry` must still be a concrete numeric `LIMIT`/`ZONE` you would act on once triggered, not a text description.

## ENTER Semantics

`decision.action = "ENTER"` means: the Primary Scenario's setup is actionable now under the current market snapshot.

For a `ENTER` decision, the `PRIMARY` scenario plan must be **executable** (same bar as PRIMARY Numeric Execution Readiness above, restated here for the ENTER-specific nuance):

- `entry.type` must be `MARKET`, `LIMIT`, or `ZONE` — **never `CONDITIONAL`** for an executable Primary. `MARKET` requires no `value` (2.2.0 — previously required one); `LIMIT` requires a finite `value`; `ZONE` requires finite `from` and `to`.
- `stopLoss.value` must be a finite number (a description-only stop is not enough for an executable Primary).
- `takeProfit` must contain at least one entry with a finite numeric `value`.
- `trigger` must be a non-empty string (for `ENTER` this explains why the setup is actionable *now*, not a future condition).
- `holdingPeriod` must be a non-empty string.
- `reviewHorizon` must be present with a non-empty `description` and a required `expiresAt` (2.2.0 — same universal PRIMARY requirement as WAIT).
- Directional price sanity (2.2.0, see above) must hold whenever `entry` has a real reference price (i.e. `LIMIT`/`ZONE`; exempt for `MARKET`).

If the model cannot justify real, executable numeric trade parameters from the evidence, that alone is sufficient reason to choose `WAIT` instead of `ENTER` with fabricated or vague numbers. A response must never claim `ENTER` while describing the Primary plan only in prose.

---

# Reasoning

Purpose

Explain the major supporting factors.

```ts
type ReasoningItem = {
  title: string;
  description: string;
  importance: number;
  stance: "SUPPORT" | "OPPOSE" | "NEUTRAL";
  evidenceReferences: string[];
}
```

Rules (unchanged from 1.2.0)

Maximum 5 items. This is a hard validation failure, not a truncation target — the Parser rejects a response with 6+ items outright.

Importance: 0–100.

`stance` classifies the item relative to the final `decision.direction` (2.0.0 clarification of existing wording): `SUPPORT` supports the chosen direction, `OPPOSE` represents counter-evidence or conflicting evidence considered and outweighed (per Direction Resolution Policy), `NEUTRAL` is relevant background/context that doesn't clearly support either direction. **`NEUTRAL` here describes a reasoning item's relevance, not the final market direction** — the final direction is never `NEUTRAL` (see Decision above).

Every reasoning item must reference evidence via `evidenceReferences`.

This structure must support the existing Strategy UI's supporting-evidence and opposing-evidence views (`SUPPORT`/`OPPOSE` map to those two views; `NEUTRAL` items are contextual and not shown in either view).

---

# Risks

Purpose

Explain major risks.

```ts
type RiskItem = {
  title: string;
  description: string;
  impact: "LOW" | "MEDIUM" | "HIGH";
}
```

Maximum 5 items. (Unchanged from 1.x.)

---

# Evidence References (unchanged from 1.2.0/3.3C.2)

Purpose

Every conclusion must reference evidence.

```ts
type EvidenceReference = {
  reason: string;
  references: string[];
}
```

Allowed reference id namespaces — **exactly these 3, unchanged**:

- `sourceSnapshots:<id>`
- `selectedNewsEvents:<id>`
- `additionalEvidence:<id>`

Never reference information outside the Analysis Payload. No free-text references. No URLs. No new namespaces.

Referenced ids are guaranteed stable only within the one Analysis Payload identified by this response's `analysisId` — see `ANALYSIS_PAYLOAD_SPEC.md`'s Traceability Requirements. Do not assume any id is stable across different analyses.

`reasoning[].evidenceReferences`, `sourceAssessments[].evidenceReferences`, `scenarioPlans[].evidenceReferences`, and `evidence[].references` all validate against the same 3 namespaces via the same mechanism.

---

# General Rules

The AI must never:

- invent facts
- fabricate indicators
- fabricate news
- fabricate prices
- ignore missing data

If evidence is insufficient to justify immediate execution, prefer `WAIT` over `ENTER` — but a final direction is still required (see Decision, Direction Resolution Policy). Insufficient evidence for *execution* is not the same as insufficient evidence for a *direction*.

---

# Evidence Conflict (2.0.0, new — see Direction Resolution Policy)

Opposing evidence across sources must remain visible (via `reasoning[].stance = "OPPOSE"` and per-source `SourceAssessment.direction`) and must be considered, but the existence of opposing evidence is never, by itself, a reason to return `WAIT` or to avoid a final direction.

Example of expected, valid behavior:

```
Direction: LONG
Supporting: Technical (HIGH), ETF (HIGH)
Opposing: Macro (MEDIUM), News (LOW)
Final: LONG
```

---

# Missing Data

If one or more sources are unavailable, the AI must continue analysing using available evidence.

The response should mention important missing sources when relevant.

Clarification (Data Quality)

`dataQuality` (`unavailableSources` / `partialSources` / `staleSources`) remains part of the Analysis Payload — see `ANALYSIS_PAYLOAD_SPEC.md`.

Strategy may display important missing- or stale-data warnings directly from the Payload's own `dataQuality` field. This does not require an AI response field.

`reasoning` and `risks` should mention missing data only when it materially affects the recommendation — not as a routine restatement of `dataQuality`.

The AI does NOT need to duplicate the complete `dataQuality` object anywhere in its response.

---

# Traceability

Every important conclusion should be traceable to one or more evidence references.

Learning depends on this relationship.

---

# AI Response Record (persistence contract)

Purpose

Define the immutable, persisted record wrapping one `AIResponse`. This is the second of the two records downstream of the Analysis Payload — see `ANALYSIS_PAYLOAD_SPEC.md`'s "Relationship to Prompt Record and AI Response Record" and `PROMPT_BUILDER_SPEC.md`'s Prompt Record.

```ts
type AIResponseRecord = {
  analysisId: string;
  responseVersion: string;
  promptVersion: string;
  payloadVersion: string;
  provider: string;
  model: string;
  generatedAt: string;
  response: AIResponse;
}
```

Rules (unchanged shape from 1.x — only the inner `response`'s shape changed)

For the current MVP, AI Response Records are persisted in `localStorage`, linked by `analysisId`, alongside Analysis Payloads and Prompt Records.

Immutable after creation — a retry or a new analysis creates a new `AIResponseRecord`, never overwrites a historical one.

Trade Detail must eventually be able to retrieve the historical `AIResponseRecord` by `analysisId`, so that "AI Strategy" (required by `MVP Handbook.md`'s Trade Detail module list) can be shown as immutable history, not regenerated.

## Historical (major-version-1) Records (2.0.0)

Existing `AIResponseRecord`s created under `responseVersion` major `1` remain stored exactly as they are: not migrated, not rewritten, not re-parsed, not deleted. They are read-only history. The Parser (Sprint 3.3D-A) validates only major `2` going forward — a stored major-`1` record was already validated at the time it was created and is never re-validated on read.

## Historical minor-`2.0.0` Records (2.1.0)

A stored `2.0.0` `AIResponseRecord` (e.g. one whose `WAIT` plan has `entry: null`) also remains stored exactly as-is — not migrated, not rewritten, not re-parsed. Strategy's rendering path never re-validates a stored record against the current Parser (it only performs its own lightweight defensive shape check, unrelated to this specification's completeness rules), so a `2.0.0` record continues to render correctly. Only *newly submitted* raw responses are validated against 2.1.0's tightened Completeness rules — this is the same precedent 1.2.0 already established (a lower, still-compatible minor is accepted at the version-check step, but is separately still subject to whatever that minor's own schema requires).

## Historical minor-`2.1.0` Records (2.2.0)

Same precedent again: a stored `2.1.0` `AIResponseRecord` (e.g. one whose `PRIMARY` plan has `entry.type: "CONDITIONAL"`, a description-only `stopLoss`/`takeProfit`, or `reviewHorizon.expiresAt: null`) remains stored exactly as-is — not migrated, not rewritten, not re-parsed, not deleted. Only *newly submitted* raw responses are validated against 2.2.0's tightened PRIMARY Numeric Execution Readiness rules.

Distinct from storage immutability, however: `evaluateScenarioExecutionReadiness()` (`EXECUTION_SPEC.md`) is an **application-layer, use-time** check, not a Parser re-validation — it runs against ANY scenario (including one from a historical 2.1.0-or-earlier record) at the moment a user tries to act on it via Strategy/Execution/TESTNET submission, using the CURRENT rules. This is why a historical `CONDITIONAL`-entry `WAIT` plan renders correctly as read-only Strategy history, yet cannot be newly confirmed into an `ExecutionDraft` or reach TESTNET submission today — the stored record itself is never touched, but new action on it is gated by today's readiness bar, not the bar in effect when it was generated.

---

# Scope and Governance

This specification, together with `ANALYSIS_PAYLOAD_SPEC.md` and `PROMPT_BUILDER_SPEC.md`, formally authorizes the implementation of AI integration beyond the original clickable-prototype scope defined in `MVP Handbook.md` (which lists "AI API" under Out Of Scope for the initial prototype stage).

This authorization is scoped narrowly:

Learning remains future work and is explicitly NOT part of the current implementation sprint.

The AI never creates a Trade.

Strategy displays AI output. It does not generate or modify it.

Execution creates the Trade only after user confirmation — never automatically from an AI response.

Existing-position management (Future Position-Management Compatibility, above) is a design-only placeholder — no live-account logic, no position data, and no new `action` values beyond `ENTER`/`WAIT` are implemented.

`ExecutionMode` (`MANUAL`/`NOTIFY`/`AUTO`, from the separately-approved Scenario Execution Model v1 design) deliberately does **not** appear anywhere in this specification — it is a user-chosen execution-authorization concept that belongs to a future `ExecutionDraft` object, never to an AI-authored response. Likewise, trigger monitoring, notifications, and automatic order execution are not implemented by this revision — `triggerStructured`/`invalidation` only describe what the AI recommends; nothing in this sprint evaluates them against live data.

Sprint 3.3D-A updated the response contract, Parser, and Prompt for the v2.0.0 breaking rewrite. Sprint 3.3D-B updated Strategy UI to render it. Sprint 3.3D-C (this revision) extends the contract, Parser, and Prompt again for v2.1.0's execution-plan completeness, plus the minimal Strategy UI display needed for the new fields — see `PROJECT.md`'s Sprint 3.3D-C entry.

---

# Compatibility

This specification is consumed by:

- Strategy
- Execution
- Trade Detail
- Learning

Future models must remain compatible with this schema.

Breaking changes require a new specification version.

---

# Versioning

Current Version

2.2.0

## Compatible Minor-Version Policy (carried forward from 1.2.0, unchanged mechanism)

The Parser validates `responseVersion` against this policy explicitly — it never silently accepts an unrecognized version:

- **Major version must match exactly.** The current supported major is `2`. A response reporting any other major (including the entire 1.x line) is rejected as `unsupported_response_version`, unconditionally.
- **Minor version must not exceed the Parser's supported ceiling.** The current ceiling is `2` (`2.2.0`). A `2.0.0`/`2.1.0` response is still accepted at the version-check step, but — same precedent as 1.0.0 vs. 1.1.0 — is separately subject to 2.2.0's own tightened PRIMARY Numeric Execution Readiness rules if freshly submitted; a *stored* `2.0.0`/`2.1.0` record is never re-validated (see Historical minor-`2.0.0`/`2.1.0` Records above).
- **Patch version is ignored** — `2.2.0`, `2.2.1`, `2.2.7` are all treated identically.

Revision history

1.0.0 — initial frozen specification.

1.1.0 (2026-08) — added `weightContribution`/`WeightContribution`, added `stance`/`evidenceReferences` to `ReasoningItem`, added `AIResponseRecord`, clarified Missing Data / `dataQuality`, added Scope and Governance.

1.2.0 (2026-08, Sprint 3.2C) — made `TradingPlan.entry`/`stopLoss` nullable and `takeProfit` optionally empty for non-`ENTER` decisions, formalized `WeightContribution` completeness, formalized Raw Response Preservation, added the Compatible Minor-Version Policy.

2.0.0 (2026-08, Sprint 3.3D-A) — breaking: `decision.direction` drops `NEUTRAL`; `decision.action` drops `EXIT`/`REDUCE`; `tradingPlan` replaced by `scenarioPlans`; `weightContribution` replaced by `sourceAssessments`; Confidence re-anchored; Direction Resolution Policy and Evidence Conflict sections added. Non-breaking carryovers: Reasoning (incl. the 5-item cap), Risks, Evidence References (namespaces/mechanism), Raw Response Preservation, `AIResponseRecord` persistence shape.

2.1.0 (2026-08, Sprint 3.3D-C) — see the revision note at the top of this document. Additive: `ScenarioPlan` gains optional `triggerStructured`/`invalidation`/`reviewHorizon`; `entry`/`stopLoss`/`takeProfit` completeness is tightened to be action-independent (no longer nullable/empty for `WAIT` plans). A controlled, program-owned machine-metric vocabulary (`price`/`candle_close`) is introduced — never an AI-declared capability flag.

2.2.0 (2026-08-10, Sprint 3.5D-B.1) — see the revision note at the top of this document. Additive tightening: `entry.type: "CONDITIONAL"` removed as a valid `PRIMARY` final parameter; `MARKET` no longer takes a `value`; `stopLoss.value`/`takeProfit[].value` now required (real numbers) for `PRIMARY`; `reviewHorizon.expiresAt` now required (timezone-qualified, future) for `PRIMARY`; `triggerStructured` now required+evaluable for a `WAIT`-decision `PRIMARY`; a new directional price-sanity cross-rule added. No field removed/renamed; `ALTERNATIVE`/`INVALIDATION` plans keep 2.1.0's completeness rule unchanged at the Parser level.

Future incompatible changes:

3.0

must preserve backward compatibility where possible, and must be recorded here with the same rationale discipline as 2.0.0's revision note.

---

# Status

Frozen

No implementation should modify this specification without a recorded Product Decision.
