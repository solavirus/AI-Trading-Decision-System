# Product Status

Updated At: 2026-08-08 00:40
Current Version: v0.1.0 (pipeline package version; no unified product version exists)

---

## Current Product Flow

Dashboard

↓

Research Input

↓

Strategy

↓

Execution

↓

Trade List

↓

Trade Detail

This is the frozen workflow defined in `MVP Handbook.md` ("Core Workflow... This workflow is frozen. Do NOT redesign it."), confirmed implemented end-to-end in `prototype/index.html` (all 5 transitions verified navigable). No additional modules exist in the product's core workflow today. "Learning" remains a disabled sidebar entry; "Settings" gained its first real subpage (AI Connections) in Sprint 3.1B.1 — see Future Pages.

---

## Analysis Lifecycle (Frozen Product Decision — Analysis Snapshot Integrity, 2026-08-07)

**Status: Frozen (decision). Implemented as of Sprint 3.2B (2026-08-08)**, up through Build Prompt — see `PROJECT.md` for current status (full implementation history: `product-docs/archive/DEV_STATUS.md`). Sprint 3.2A ("Analysis Runner" overlay on Research's Run Analysis button) first built the UX as a visual mock; Sprint 3.2B replaced the mock with the real lifecycle: real concurrent per-source collection (only weight>0 sources, only after Run Analysis, never Dashboard's cache), real independent timeouts, real validation (empty content ≠ failure), real cancel-on-any-failure, real Snapshot freeze feeding the existing `buildAnalysisPayload()`/`buildPromptRecord()`. Stops there — no AI call yet (Sprint 3.2C's job).

This section governs what happens between Research Input and Strategy — it does not add, remove, or reorder any of the 6 pages in Current Product Flow above; it defines, for the first time, the internal contract for the "Research → Strategy" step.

### Decision

Every AI analysis must be based only on data successfully retrieved AFTER the user explicitly starts the analysis. Dashboard data must never be reused as Analysis data. Historical cache must never be used to replace failed real-time requests.

### Lifecycle

Research Configuration
↓
User clicks Run Analysis
↓
Collect Real-Time Data
↓
Validate Required Sources
↓
Freeze Analysis Snapshot
↓
Build Analysis Payload
↓
Build Prompt
↓
AI Engine
↓
Strategy
↓
Execution (after user confirmation)

### Dashboard

Dashboard remains an independent real-time monitoring page. Its cached data is never used as the Analysis Snapshot. Dashboard refreshes do not modify existing Analysis Payloads.

### Data Collection Rules

Only collect sources whose configured weight is greater than zero. Weight = 0 means: do not fetch, do not wait, do not include in Payload.

### Validation Rules

If any required source fails during collection, the analysis is cancelled. Do not continue. Do not replace with cached data. Do not silently ignore the failure. Display a clear message explaining which source failed — example: "ETF data could not be retrieved. This source participates in the current experiment. Please retry."

### Snapshot

When every required source succeeds, freeze the dataset immediately. Create exactly one immutable Analysis Payload. This payload becomes the only source of truth for: Prompt Builder, AI Engine, Strategy, Trade Detail, Learning. Dashboard updates must never modify it.

### No Cached Data

Cached data may exist for Dashboard performance. Cached data must never be used during AI analysis. No stale fallback. No automatic replacement. Fresh data only.

### Product Principle

Analysis is an experiment. Every experiment must have one unique immutable snapshot. The same snapshot must always reproduce the same Prompt. The same Prompt must always reproduce the same AI request. This guarantees experiment traceability.

### Relationship to what's already implemented

`buildAnalysisPayload()` (Sprint 2.2, `prototype/index.html`) already produced an immutable, `analysisId`-keyed Payload — the "Snapshot" concept above was never new in kind. What this decision added, and what was missing until Sprint 3.2B, was the collection discipline feeding it: `buildAnalysisPayload()` used to deep-copy `getResearchSourceSummaries()`, which read whatever Dashboard already had loaded in `Store.live`/`Store.liveMeta` (from app boot, potentially stale) rather than collecting fresh data on Run Analysis, and there was no Validate/cancel-on-failure step at all — a failed source just showed up in the Payload's `dataQuality.unavailableSources` list rather than cancelling the analysis. **Sprint 3.2B closed this gap**: `buildAnalysisPayload()` now takes freshly-collected, just-frozen snapshots as a parameter (the Dashboard-cache-reading adapter is deleted), and any required source's failure cancels the whole analysis before a Payload is ever built. What's still not implemented is everything from AI Engine onward (Sprint 3.2C).

---

## Frozen Pages

Purpose/responsibility for all 6 pages below is frozen per `MVP Handbook.md` ("Status: Frozen", "This document has the highest priority"). Frozen here means responsibility and information architecture are locked — implementation work (real data wiring, interaction completion, bug fixes) continues per `PROJECT.md`'s Current Product Status and is not a violation of freeze.

### Dashboard

Status

Frozen (purpose) / Ready for Review (implementation — see `PROJECT.md`)

Purpose

Display all available market data sources. No AI, no trading strategy, no AI suggestion — only raw data.

Entry

App entry point (no prior page)

Exit

Research Input (via "New Trade Experiment")

Editable

No

Notes

Every Dashboard card must correspond 1:1 to a configurable data source weight in Research (MVP Handbook Principle 5). Currently 11/11 cards are wired to real external data (see `PROJECT.md`) — this is real-data completion, not a responsibility change.

---

### Research Input

Status

Frozen (purpose) / In Progress (implementation)

Purpose

Configure ONE analysis: asset, timeframe, data source weight, additional evidence (each with its own weight, contributing to the same 100% total). Not for browsing information.

Entry

Dashboard

Exit

Strategy (via "Analyze")

Editable

No

Notes

Does NOT perform AI analysis itself. Sprint 2.2 added a real, immutable Analysis Payload built on submission (real weights, real evidence, real deep-copied source snapshots, ≤10 real news events selected by a deterministic non-AI pipeline) plus a small read-only news-inspection addition — the smallest UI change consistent with "do not redesign the frozen page." Sprint 3.1A added a real, deterministic Prompt Record built immediately after the Payload on the same submission, plus a sidebar (not on the Research page itself) dev-only preview. Sprint 3.1B added a real backend AI Engine (4 real provider adapters behind a registry) that the same dev-only preview can now send a Prompt Record to — but zero AI provider credentials exist in this environment, so every real request honestly reports "not configured." No AI model has ever produced a real completion. Neither the Payload, Prompt Record, nor any AI response is consumed by Strategy yet. Sprint 3.1B.2 improved the QUALITY of what Research feeds the Prompt Builder, still within this page's frozen "configure inputs" responsibility: Additional Evidence now starts empty (was 4 seeded fake cards) and supports click/drag/paste upload with no auto-generated titles; the Analysis Payload's `sourceSnapshots.news` no longer duplicates every fetched headline `selectedNewsEvents` already carries, and asset-specific modules (market/technical/derivatives) are trimmed to the selected asset only — a real measured 36.1% prompt-size reduction, with `selectedNewsEvents` itself confirmed unchanged. **2026-08-07 — Analysis Snapshot Integrity** (see the Analysis Lifecycle section above) is the frozen governing decision for what "submitting Research" must do: collect fresh, on-demand data (never Dashboard's cache), validate every weight>0 source, and cancel rather than silently degrade on failure. **Implemented as of Sprint 3.2B (2026-08-08)**: clicking "开始 AI 分析" now runs a real, terminal-styled Analysis Runner overlay through real concurrent per-source collection, real validation/timeout/cancel-on-failure, and real snapshot freeze, before building the Payload/Prompt Record exactly as before — stopping short of the AI Engine (Sprint 3.2C).

---

### Strategy

Status

Frozen (purpose) / Ready for Review (implementation)

Purpose

Display AI-generated strategy: summary, trading plan, weight contribution, reasoning, actions. The ONLY page where AI output appears.

Entry

Research Input

Exit

Execution

Editable

No

Notes

No market browsing, no configuration on this page. Currently the "AI" output is a deterministic mock signal model (`signalFor()`/`signalForText()`), not a real model call — see `PROJECT.md`. Strategy generation does NOT consume the Analysis Payload Research now builds (Sprint 2.2) — this is a deliberate boundary, not an oversight, so that Strategy stays clearly and honestly Mock rather than looking more "real" than it is.

---

### Execution

Status

Frozen (purpose) / Ready for Review (implementation)

Purpose

Record actual execution, separating the AI recommendation from the human decision (execute as AI / execute with modification / cancel). Records entry, stop loss, take profit, position, leverage, notes.

Entry

Strategy

Exit

Trade List

Editable

No

Notes

This distinction (AI recommendation vs. human decision) is explicitly called out in `Quant Decision System.md` as "critical for future learning."

---

### Trade List

Status

Frozen (purpose) / Ready for Review (implementation)

Purpose

Manage the lifecycle of every trade experiment (Running / Closed / Cancelled).

Entry

Execution (after a trade is created); also reachable directly from the sidebar

Exit

Trade Detail (each row)

Editable

No

Notes

—

---

### Trade Detail

Status

Frozen (purpose) / Ready for Review (implementation)

Purpose

View the complete, immutable lifecycle of ONE trade — AI strategy, execution, timeline, current position, notes.

Entry

Trade List

Exit

None (terminal page; read-only)

Editable

No

Notes

Do NOT regenerate strategy. Do NOT modify weight. History is immutable per `Quant Decision System.md`.

---

## Pages Under Development

None — all 6 in-scope pages exist and are navigable. Implementation completeness (real data, real persistence) varies per page; see `PROJECT.md`'s Current Product Status table.

---

## Future Pages

- **Learning** — appears as a disabled sidebar entry (`学习中心`, clicking it shows "该功能在本原型范围之外"). Explicitly confirmed as future work in `Quant Decision System.md`'s "# Future" section: Learning → Weight Optimization → Decision Model Evolution. `MVP Handbook.md` explicitly lists Learning and Weight Optimization as Out Of Scope for the current prototype.
- **Settings** — Sprint 3.1B.1 (2026-08-07) gave this its first real subpage, `AI Connections` (`#/settings/ai-connections`), scoped narrowly to configuring the AI Engine's 5 provider connections (enable/disable, base URL, API Key, default model, test connectivity) — explicitly NOT prompt editing, strategy generation, AI response viewing, learning, or token statistics. See the Frozen Product Decisions entry below for the authorization (same override-the-Out-Of-Scope-list precedent as `DATA_SOURCE_SPEC.md`). The sidebar `设置` entry is a real, enabled route now, not a `scope-toast` placeholder. No other Settings subpage exists yet.

**Learning** has a defined future direction (see `Quant Decision System.md`'s "# Future" section) but no purpose, entry/exit, or implementation — still a placeholder only, not in progress.

---

## Product Principles

Sourced verbatim/near-verbatim from `MVP Handbook.md` and `Quant Decision System.md` (both Status: Frozen) — none invented:

- This is not a trading terminal, not TradingView, not CoinGlass, not Bloomberg. The core asset is the Decision Weight Model, not market data.
- Every trade is an experiment; every experiment improves the user's decision model.
- Each page has ONLY ONE responsibility — do not mix responsibilities.
- AI appears ONLY in Strategy. Dashboard, Research, Execution, Trade List, and Trade Detail contain no AI.
- Dashboard is a Data Hub. Research is an Input Configuration. Strategy is AI Output. Never mix them.
- Research is NOT for browsing information — Research is ONLY for configuring inputs.
- Dashboard and Research use the SAME data sources, one-to-one — a new data source must be added to both.
- Execution separates AI Recommendation from Human Decision; this distinction is critical for future learning.
- Trade Detail is read-only, immutable history — nothing is ever regenerated.
- All weights (data sources + additional evidence) sum to 100%.
- Learning will optimize Weight in the future; the current product does not implement learning yet.
- Priority order for this build: Workflow > Interaction > Visual consistency > Animation — explicitly NOT Business Logic.

---

## Current User Journey

A user opens the Dashboard and sees all 11 live data source cards (real external data, no AI). They click "新建交易实验" (New Trade Experiment), landing on Research Input, where they pick an asset/timeframe, adjust weight sliders across the same data sources shown on the Dashboard, and optionally attach additional evidence (screenshot/news/tweet/opinion/PDF), each carrying its own weight. Clicking "分析" (Analyze) generates a Strategy page showing a summary, trading plan, weight contribution breakdown, and reasoning — today this content is a deterministic mock signal, not a real model call. From Strategy, the user proceeds to Execution, where they either execute as recommended, execute with modification, or cancel — recording the real parameters (entry/stop-loss/take-profit/position/leverage/notes) as they actually chose to act, distinct from what the "AI" suggested. The trade then appears in Trade List with a running/closed/cancelled status, and opening it shows Trade Detail — the immutable, read-only full history of that one trade. All trade/draft state persists in the browser's `localStorage`, not a backend database.

---

## Frozen Product Decisions

**2026-08-05** — `MVP Handbook.md` v1.0 and `Quant Decision System.md` v1.0 frozen. Product pivoted from an earlier, more ambitious "Decision Case OS" concept to a simpler, scope-constrained "Quant Decision System": core object renamed to "Trade Experiment," workflow fixed to the 6 pages above, Dashboard confirmed as a pure data hub (no AI), AI confined exclusively to the Strategy page. Explicitly Out Of Scope: AI API, backend, database, login, exchange API, auto trading, learning, weight optimization, portfolio, backtest, notification, settings, admin panel.

**2026-08-05** — `DATA_SOURCE_SPEC.md` v1.0 frozen, explicitly redesigning the Dashboard's data layer (Connector → Normalize → Snapshot per source, real Detail Pages) — this authorizes real backend/database/external-API work specifically for Dashboard data sourcing, which otherwise would have remained blocked by MVP Handbook's "no backend/database" Out Of Scope list. Market and Liquidation were built out first as the reference implementation; the remaining 9 sources still use the simpler direct-fetch pattern without a dedicated Detail Page.

**2026-08-06** — News source management extended past a UI mock into a fully real backend (SQLite `news_sources` table, real CRUD REST API, real per-source fetch testing) — the same "real backend for a Dashboard-adjacent feature" precedent as DATA_SOURCE_SPEC.md, applied to news source configuration specifically.

**2026-08-06** — Sprint 2.1: a unified data adapter (`getResearchSourceSummaries()`) was built to normalize all 11 Dashboard sources for future reuse by Research/Strategy, explicitly as data-layer preparation only — Research Input's UI, responsibility, and workflow position remain exactly as frozen in `MVP Handbook.md`; only its future implementation is expected to change once the adapter is actually wired in.

**2026-08-07** — Sprint 2.2: Research no longer passes raw UI state directly to Strategy — every submission now produces one immutable Analysis Payload (real weights, real evidence, real 11-source snapshots, ≤10 real news events selected by a deterministic non-AI pipeline). Strategy was deliberately NOT changed to consume this payload, keeping it honestly Mock rather than partially-real. This is additive to Research's frozen responsibility ("configure inputs"), not a redefinition of it — the payload IS the configured input, just formalized into one object instead of scattered `Store.draft` fields.

**2026-08-07** — `AI_RESPONSE_SPEC.md` v1.0.0 and `PROMPT_BUILDER_SPEC.md` v1.0.0 frozen, defining (not yet implementing) how a real AI model will eventually plug into Strategy. `AI_RESPONSE_SPEC.md` fixes the exact JSON shape every model (any provider) must return (`summary`/`decision`/`tradingPlan`/`reasoning`/`risks`/`evidence`), explicitly re-affirming existing principles from `MVP Handbook.md`/`Quant Decision System.md`: the AI is an analysis engine, never a trading engine, never creates trades directly, and must prefer WAIT over an unsupported directional call. `PROMPT_BUILDER_SPEC.md` fixes how the (now-existing) Analysis Payload gets deterministically formatted into a 4-section prompt (System Prompt → Trading Rules → Analysis Payload → Output Contract) — explicitly a formatter with no AI calls, no business logic, no provider-specific branching. No code was implemented against either spec this turn; both exist purely as frozen governing documents for a future sprint.

**2026-08-07** — Sprint 3.1A: the Prompt Builder is implemented, matching `PROMPT_BUILDER_SPEC.md` v1.1.0 and consuming `ANALYSIS_PAYLOAD_SPEC.md` v1.0.0 as its upstream contract. `buildAnalysisPayload()` was migrated to write the canonical `payloadVersion` field (was `version`); a read-time-only normalizer keeps pre-migration Payloads working without rewriting them on disk. The data flow now reaches: Research → Analysis Payload → Prompt Record, and stops there — no AI Engine, no provider call, no response parsing exist yet. A dev-only Prompt preview was added to the sidebar (not the Research page itself, to avoid touching its frozen layout).

**2026-08-07** — Architecture review of the three AI-related specs found: (a) `ANALYSIS_PAYLOAD_SPEC.md` had never actually been frozen as its own document despite both other specs assuming its contract; (b) `MVP Handbook.md`'s frozen "Weight Contribution" and "Strategy Reasoning" Strategy modules had no corresponding fields in `AI_RESPONSE_SPEC.md`; (c) no persistence contract existed for the Prompt or the AI Response, threatening Trade Detail's frozen "immutable history" requirement; (d) neither AI spec explicitly cited its own authorization to exceed `MVP Handbook.md`'s "no AI API" Out Of Scope line (unlike `DATA_SOURCE_SPEC.md`, which named its own authorization explicitly). All four were resolved by documentation only, no code changed: `ANALYSIS_PAYLOAD_SPEC.md` v1.0.0 created (formalizing `buildAnalysisPayload()` as-implemented, `payloadVersion` established as the canonical field name — code still says `version`, migration deferred); `AI_RESPONSE_SPEC.md` bumped to v1.1.0 (added `weightContribution`/`WeightContribution`, added `stance`/`evidenceReferences` to `ReasoningItem`, added the `AIResponseRecord` persistence contract, added an explicit Scope and Governance section citing the `DATA_SOURCE_SPEC.md` precedent); `PROMPT_BUILDER_SPEC.md` bumped to v1.1.0 (added the `PromptRecord` persistence contract, cross-referenced `ANALYSIS_PAYLOAD_SPEC.md` instead of restating its fields). All three records (Analysis Payload, Prompt Record, AI Response Record) are now defined as linked by `analysisId`, immutable, and `localStorage`-persisted for the current MVP — none of the latter two are implemented in code yet.

**2026-08-07** — Sprint 3.1B.1: `Settings → AI Connections` becomes the product's first implemented Settings subpage, explicitly authorized to override `MVP Handbook.md`'s Out Of Scope list ("settings" is named there) — same precedent as `DATA_SOURCE_SPEC.md` overriding "no backend/database" and the AI specs overriding "no AI API". Scope is deliberately narrow: configuring the 5 AI Engine provider connections (enable/disable, base URL, API Key, default model, test connectivity) only — explicitly NOT prompt editing, strategy generation, AI response viewing, learning, or token statistics, none of which this sprint touches. API Keys are held only in a new backend-local JSON config file (`pipeline/data/ai_provider_config.json`, gitignored, not a database), layered on top of Sprint 3.1B's env-var configuration rather than replacing it; the frontend never receives a real key, only a fixed-length mask. This does not reopen or redefine any of the 6 frozen core-workflow pages above — Dashboard/Research/Strategy/Execution/Trade List/Trade Detail are all unchanged.

**2026-08-07** — Sprint 3.1B: a real backend AI Engine now exists (`pipeline/src/ai/`), reaching `POST /api/ai/analyze`. Real adapters for all 4 providers named in `AI_RESPONSE_SPEC.md`'s Compatibility section (OpenAI/Anthropic/Google/DeepSeek) were built against each provider's real documented API, behind a registry — adding a 5th provider later is one adapter file, not a rewrite. Confirmed by design and by inspection: no AI provider API key can reach the frontend, `localStorage`, or any network response — keys exist only in backend env vars, which this environment does not currently have any of (checked before starting; all 4 providers correctly self-report `provider_not_configured`, and no real model completion has been produced). The data flow now reaches Research → Analysis Payload → Prompt Record → AI Engine → raw provider response, and stops there — no response parsing against `AI_RESPONSE_SPEC.md`, no `AIResponseRecord`, no Strategy wiring yet (Sprint 3.1C). The existing sidebar dev-only Prompt preview (not the Research page) was extended, not replaced, with a provider/model picker and a real send-and-inspect control.

**2026-08-07** — Sprint 3.1B.2, Improve AI Input Quality: a quality/size pass on what Research feeds the Prompt Builder — explicitly NOT touching the AI Engine, AI response parsing, Strategy, Execution, or Learning, so no new Out-Of-Scope authorization is needed (unlike 3.1B.1's Settings page, this stays entirely inside Research's already-frozen "configure inputs" responsibility). Two real problems fixed: (1) Additional Evidence used to seed 4 fake cards on every fresh draft, one with a title ("BTC 关键支撑区域截图") describing content that was never actually uploaded — now starts empty, supports click/drag/paste upload (image/PDF/TXT/Markdown), auto-detects file kind from the file itself, and never auto-generates a title (this prototype has no real recognition capability to base one on, so the field is left blank rather than guessed, per explicit instruction); (2) the Analysis Payload/Prompt duplicated news (`sourceSnapshots.news` carried every fetched headline, the same ones `selectedNewsEvents` already carries in full) and included all 6 tracked assets' market/technical/derivatives data regardless of which one asset was actually being analyzed. Both fixed in `buildAnalysisPayload()` only — `selectedNewsEvents` and every non-asset-specific snapshot (macro/etf/onchain/sentiment/stablecoin/liquidation/options) are untouched. Measured on a real BTC/USDT submission against the live backend: promptText 21,762 → 13,905 characters (−36.1%), news snapshot rows 64 → 4, market/technical/derivatives rows 6 → 1 each.

**2026-08-07** — Analysis Snapshot Integrity, a new frozen decision, documentation only (see the "Analysis Lifecycle" section near the top of this document for the full text). Establishes, for the first time, an explicit internal contract for what "Research → Strategy" must do: collect real-time data only after the user clicks Run Analysis (never reuse Dashboard's already-loaded cache), collect only sources with configured weight > 0, cancel the analysis outright (never silently degrade or fall back to cache) if any required source fails, and freeze exactly one immutable Analysis Payload once every required source succeeds — the same snapshot must always reproduce the same Prompt, the same Prompt must always reproduce the same AI request, guaranteeing experiment traceability. This does not redefine any of the 6 frozen core-workflow pages or their responsibilities (Dashboard remains a pure, independent real-time monitor; Research remains "configure inputs only") — it governs the previously-undocumented internal mechanics of the transition between them. `buildAnalysisPayload()` (Sprint 2.2) already implements the "one immutable Payload" half of this; the "collect fresh, validate, cancel-on-failure" half does not exist yet (it currently reads Dashboard's already-loaded data and never cancels on a failed source) — this is a known, now-documented gap, not implemented by this decision itself. Implementation is explicitly deferred to a future sprint's planning, per the decision's own instruction.

**2026-08-07, same day** — Sprint 3.2A, Analysis Runner UI Prototype: first movement on the decision above, deliberately UI-only. Built the staged, terminal-styled overlay (visual language explicitly NOT the app's wizard-notebook theme, per direction to feel like professional trading software) shown on Run Analysis, with a scripted success/failure/slow-network dev toggle standing in for real outcomes. No real collection, no real validation, no AI call — a faithful preview of the intended UX, not the decision's implementation.

**2026-08-08** — Sprint 3.2B, Analysis Runner Logic: implements the decision for real, closing the gap the original entry documented. Every data source with `weight > 0` is now collected concurrently, fresh, from the live backend (`GET /api/sources/:key?fresh=1`, bypassing the shared cache Dashboard's own polling also uses), each with its own timeout and validation (empty content is explicitly not a failure, per the decision's News/Liquidation examples); any required failure cancels the whole analysis before a Payload is ever built; only once everything succeeds does the snapshot freeze and feed the existing, unmodified `buildAnalysisPayload()`/`buildPromptRecord()`. Stops there — no AI call (Sprint 3.2C). AI Engine, Prompt Builder, Strategy, Execution, and Learning are all confirmed untouched by this sprint.

**2026-08-08** — Sprint 3.2C, AI Response Parser: `AI_RESPONSE_SPEC.md` bumped to v1.2.0 and its Parser implemented (`prototype/index.html`, alongside the Prompt Builder). Four boundary conditions were formalized in the spec, then enforced by the Parser: (a) `TradingPlan.entry`/`stopLoss` are nullable and `takeProfit` may be empty whenever `decision.action != "ENTER"` or `decision.direction === "NEUTRAL"` — the model is never required to fabricate trade levels it doesn't have; (b) `reasoning`'s 5-item cap is a hard rejection, never a silent truncation; (c) every system source with `configuredWeight > 0` must appear exactly once in `weightContribution`, even at zero influence; (d) the raw response text is never repaired/reordered/truncated/rewritten by the Parser, valid or not. The pipeline (strict JSON parse → version check → schema validation → trading-plan cross rules → analysisId match → weight cross-validation → evidence-reference resolution against the originating Analysis Payload) produces one of 9 structured error codes on failure, or persists exactly one immutable `AIResponseRecord` per `analysisId` (`qa_ai_response_records`, `localStorage`) on success — a second valid attempt for the same `analysisId` is rejected (`response_already_exists`) rather than silently overwriting the first. No literal "first real AI response" exists anywhere in this repo (confirmed by search — no provider key has ever been configured in this environment, per Sprint 3.1B's entry above); the regression fixture described in this sprint's task (6 `reasoning` items, a missing `weightContribution` entry, WAIT nullability) was therefore reconstructed synthetically from that description, not taken from a captured file, and is disclosed as such rather than presented as a literal artifact. Verified against 30 scenarios (a Node `vm`-sandboxed extraction of the pure-JS Parser code, no browser, no network) covering every case the task listed plus the reconstructed real-shaped fixture; all 30 passed. Reachable only via a new "解析并校验" button on the existing dev-only Prompt Preview modal (Sprint 3.1B's same modal, not a new page) — Strategy, Execution, Trade List/Detail, Prompt Builder, Analysis Runner, and the AI Engine's provider architecture are all confirmed untouched by this sprint.
