# Changelog

## 2026-08-08 — Sprint 3.2B: Analysis Runner Logic

Goal: implement the real Analysis Runner workflow, replacing Sprint 3.2A's scripted mock with real data collection. No AI integration yet, no AI Response parsing, Strategy/Execution/Learning untouched. The Analysis Runner becomes the only component responsible for creating a valid Analysis Payload; Prompt Builder and AI Engine remain unchanged.

### Added
- `pipeline/src/server.ts`: `getSource()` gained an opt-in `fresh` option and `GET /api/sources/:key` an opt-in `?fresh=1` query param, bypassing the existing 20s cache *read* (still writes to cache, still coalesces concurrent in-flight requests). Backward-compatible — every existing caller (Dashboard's polling, `/api/prices`, the bulk `/api/sources`) omits it and is unaffected.
- `prototype/index.html`: `ANALYSIS_SOURCE_TIMEOUT_MS` — single named constant for the per-source collection timeout, used in exactly one place. `arCollectOneSource(key, runner)` — real, concurrent, independently-timed-out, independently-validated fetch of one required source; never throws, records success into `runner.collected` or failure into `runner.failures`. `arValidateEvidenceStage()` — MVP evidence check (file-type items must have an uploaded file; no OCR/parsing). `freshSourceResultToSnapshot()` — converts one just-fetched `SourceResult` into the existing `ResearchSourceSummary` shape. Developer Diagnostics panel (`arDiagnosticsHtml()`) and its sidebar on/off toggle (分析诊断信息，开发用).

### Changed
- `buildAnalysisPayload()` no longer calls `getResearchSourceSummaries()` (read Dashboard's cache); it now takes the freshly-collected, frozen snapshots and fresh news items as parameters. Same output shape, same persistence, same weight/evidence mapping — only the data source changed.
- `runNewsPipeline()` gained an optional 3rd parameter (fresh news `itemsRaw`) — existing 2-arg call sites (Research's live preview stats, the selected-events modal) are unaffected and still read `Store.live.news` as before; only the Analysis Runner's real run passes the 3rd arg.
- `startAnalysisRunner()`/`buildAnalysisRunnerStages()`/`renderAnalysisRunnerOverlay()` rewritten: concurrent real collection replaces the old sequential mock loop; stages list no longer includes an 'ai' stage; the terminal "success" phase is renamed "ready" ("分析已就绪 / Prompt 已成功构建") and no longer auto-navigates to Strategy; the failure banner now lists every failed source, not just one (collection is concurrent, so multiple can fail together); Cancel is enabled through the whole run (no more AI-stage-specific disabling, since there's no AI stage this sprint) and now actually aborts every in-flight request via `AbortController`, not just ignores their eventual result.
- Sidebar dev toggle: the 3.2A success/failure/slow-network scripted-outcome `<select>` (meaningless once collection became real) replaced with the Developer Diagnostics on/off `<button class="switch">`.

### Fixed
- The UX bug this whole sprint exists to fix: `buildAnalysisPayload()` read Dashboard's already-loaded cache instead of collecting fresh data, per the Analysis Snapshot Integrity decision.
- A real, screenshot-caught bug: with Developer Diagnostics on, the overlay's action buttons could scroll out of view below the fold — `.ar-foot` is now `position:sticky; bottom:0`.

### Removed
- `getResearchSourceSummaries()`/`researchSourceSummaryFor()` (Sprint 2.1's Dashboard-cache adapter) — fully unused now that `buildAnalysisPayload()` no longer calls them. `RESEARCH_STALE_AFTER_MS` — no longer meaningful (freshly-collected data can't be "stale"). 3.2A's `AR_DURATIONS`/`AR_COLLECT_KINDS` mock-timing constants and the `Store.devAnalysisMode` field.
- Stale screenshots from Sprint 3.2A (`analysis-runner-progress.png`/`-success.png`/`-failed.png`) — showed the now-removed sequential mock reveal and auto-navigate ending; replaced by real-flow screenshots (see Verification).

### Verification
Real jsdom harness against the live backend (not hand-copied logic) + real headless-browser screenshots — see `DEV_STATUS.md` Section 11 for full detail:
- Real cache-bypass proof via `curl`: same key without `?fresh=1` → identical `fetchedAt` twice; with it → a genuinely newer `fetchedAt`.
- Real concurrency proof: 9 of 11 collect stages sampled simultaneously `running` mid-run.
- Real multi-failure proof: a genuine 10.2-second timeout (the actual configured constant) and a genuine HTTP 500 failed together, both correctly reported, banner listing both names.
- Real Cancel-aborts-network proof: 11 real in-flight requests, all 11 genuinely aborted on Cancel (counted via listener, not inferred from the UI).
- Real "exactly one Payload/Prompt per successful run" and "zero Payload on failure" proofs via `localStorage` map size deltas.
- Regression: `generateStrategy`/`buildPromptText`/`confirmExecution` confirmed unchanged as functions; `pipeline/src/ai/**` file modification times confirmed untouched this sprint.
- `npm run typecheck` and frontend `node --check` both passed.

### Remaining Issues
- No AI call anywhere in this flow — deliberately deferred to Sprint 3.2C, which will consume the real Prompt Record this sprint now produces.
- `ANALYSIS_SOURCE_TIMEOUT_MS` is a single named constant, not yet a user-configurable Settings value.

---

## 2026-08-07 — Sprint 3.2A: Analysis Runner UI Prototype

Goal: design the complete Analysis Runner user experience as a UI-only prototype. No real data collection, no AI call, no changes to Prompt Builder or Strategy — everything driven by mock/scripted state, per explicit sprint scope.

### Added
- Full-screen Analysis Runner overlay (`#analysis-runner-bg`, `renderAnalysisRunnerOverlay()`, `startAnalysisRunner()`) shown on "开始 AI 分析" instead of the old instant progress bar. Deliberately its own dark, monospace, minimally-rounded look — not the app's warm wizard-notebook theme — per explicit direction to feel like professional trading software, not a consumer chat app; fixed dark palette regardless of the site's own light/dark toggle. A separate overlay from the shared `#modal-bg` system specifically so it can omit backdrop-click-to-dismiss — dismissal only ever happens through its own Cancel/Retry/Close buttons.
- `buildAnalysisRunnerStages()` — one "采集 X" stage per data source with configured weight > 0 (weight = 0 sources aren't shown at all, foreshadowing the frozen Analysis Snapshot Integrity decision's collection rule), an evidence-processing stage only when evidence exists, then fixed Validate/Freeze/Build Payload/Build Prompt/AI stages.
- 5 stage visual states (waiting/running/success/failed/skipped), a live elapsed-time readout, and a scripted failure path (`Store.devAnalysisMode==='failure'`) that fails at the last collect/evidence stage with a "分析已取消" banner + [重试]/[关闭] buttons.
- Cancel button, enabled through every stage except the final AI stage (rendered `disabled` there, not hidden) — matches "Cancel becomes disabled" once the AI request would begin.
- Dev-only Review Mode toggle in the sidebar (成功/失败/网络较慢), the only way to pick which scripted outcome plays — no code change needed to demo any of the 3 paths.
- First 5 real, committed screenshots in this repo's history, in `product-docs/screenshots/`, captured with `puppeteer-core` driving the system's actually-installed Edge browser headlessly (not hand-described, not jsdom, since jsdom has no real rendering).

### Changed
- `buildAnalysisPayload()`/`buildPromptRecord()` — still the exact same, unmodified calls as before this sprint, but now invoked at the moment their own overlay stage's turn comes up in the sequence, rather than both firing up front. No change to their internal logic.

### Fixed
Both caught during this sprint's own real verification, not found in review:
- Clicking Cancel threw an unhandled `TypeError: Cannot read properties of null (reading 'cancelled')` — the async stage loop checked `Store.analysisRunner.cancelled` after every `await`, but the Cancel handler had already set `Store.analysisRunner` to `null`. Fixed by having the loop check a locally-captured `const runner` instead of re-reading the (possibly nulled) global.
- The failure banner read "未能获取期权数据**数据**" — visibly duplicated "数据" for the 5 of 11 sources whose own label already ends in that word. Fixed by rephrasing to "{label}未能成功获取", safe for every label regardless of its own wording. Caught only via a real screenshot — no functional assertion had checked the exact banner text.
- The elapsed timer froze at "00:00.0" on the final "分析完成"/"分析已取消" frame instead of the real elapsed time, because re-rendering the overlay recreates the timer DOM element (resetting it to a static template default) after the interval that would have corrected it had already been stopped. Fixed with `arFinishTimerDisplay()`, which stamps the true final elapsed time onto the freshly-rendered element. Also only caught via a real screenshot.

### Removed
- `runAnalyzeAnimation()` (the old generic progress-bar modal) and `analyzingStepLabels()` (only used there) — both fully replaced. `analysisStepLabels()`, a similarly-named but distinct function used by the (untouched) Strategy page, was not removed.

### Verification
- `npm run typecheck` and frontend `node --check` both passed.
- Real jsdom harness (not hand-copied logic) covering: success path end-to-end (16 stages → navigates to `#/strategy` → real `generateStrategy()`/`buildAnalysisPayload()` ran); failure path (fails at the correct last stage, every later stage skipped, Retry/Close both functional); cancel path (overlay closes, sequence genuinely stops — confirmed by waiting past when it would have finished); Cancel disabled once the AI stage starts; regression on Dashboard/Trade List/Research rendering; the `draftTotal()!==100` guard holding both at the button level and inside the function itself; the real click-dispatch entry point (not just calling the function directly); dev Review Mode persistence to `localStorage`.
- Real headless-browser screenshots against the actual page (not jsdom) caught the 2 bugs listed under Fixed — both re-verified with fresh screenshots after the fix.

### Remaining Issues
- This is explicitly a UI mock of the Analysis Snapshot Integrity decision, not its implementation — `buildAnalysisPayload()` still reads Dashboard's already-loaded cache and has no real validate/cancel-on-failure logic. See `DEV_STATUS.md` Section 8 for the tracked gap.
- Only Research's own new state and the Analysis Runner overlay have real committed screenshots; Dashboard/Strategy/Execution/Trade List/Trade Detail/Settings still don't.

---

## 2026-08-07 — Product Decision: Analysis Snapshot Integrity (documentation only)

Frozen Product Decision, recorded by the product owner — no code changes. Establishes, for the first time, an explicit internal contract for the "Research → Strategy" transition: real-time data is collected only after the user clicks Run Analysis (Dashboard's already-loaded cache must never be reused as Analysis data, and a failed source must never fall back to stale cache); only sources with configured weight greater than zero are collected; any required-source failure cancels the analysis outright with a clear message, rather than continuing or silently degrading; once every required source succeeds, exactly one immutable Analysis Payload is frozen immediately and becomes the sole source of truth for Prompt Builder, AI Engine, Strategy, Trade Detail, and Learning. Product principle: same snapshot → same Prompt → same AI request, always, guaranteeing experiment traceability.

### Added
- New "Analysis Lifecycle" section in `product-docs/PRODUCT_STATUS.md`, documenting the full decision, its 8-step lifecycle diagram, and its relationship to what's already implemented.
- New Frozen Product Decisions log entry in `product-docs/PRODUCT_STATUS.md`.
- New "Addendum — Analysis Snapshot Integrity" section appended to `MVP Handbook.md` and to `Quant Decision System.md` (both frozen founding documents), each clearly marked as not modifying the original frozen content, cross-referencing `PRODUCT_STATUS.md` for the full text.
- New P1 row in `DEV_STATUS.md`'s Known Issues: `buildAnalysisPayload()` currently reads Dashboard's already-loaded `Store.live`/`Store.liveMeta` instead of collecting fresh data on Run Analysis, and has no validate/cancel-on-failure step — both required by this decision, neither implemented yet.
- New note in `DEV_STATUS.md`'s Recommended Next Step flagging an open sequencing question (implement this decision before, or combined with, Sprint 3.1C's response parsing) for future planning.

### Changed
—

### Fixed
—

### Removed
—

### Verification
Documentation only — no code was written or run this round, so there is nothing to verify by execution. Cross-references between the 4 updated documents were checked by hand for consistency (same decision text, same "not yet implemented" status, same pointer back to `PRODUCT_STATUS.md` as the canonical source).

### Remaining Issues
- Not implemented. Per the decision's own explicit instruction, implementation planning is deferred to a future sprint — this entry is documentation only.

---

## 2026-08-07 — Sprint 3.1B.2: Improve AI Input Quality

Goal: improve the quality/size of information reaching the AI, without touching the AI Engine, AI response parsing, Strategy, Execution, or Learning. All 7 tasks are frontend-only (`prototype/index.html`) — no backend/pipeline files changed.

### Added
- `detectFileEvidenceType(file)` — classifies an uploaded/dropped/pasted file as 截图(Image)/PDF/TXT/Markdown from its MIME type or extension; returns null for anything unsupported.
- `attachFileToEvidence(evId, file)` — single shared path for click-upload, drag&drop, and paste, so all 3 input methods produce identical results (sets `type`+`fileName`/`fileSize`/`fileData`, never touches `label`/title).
- Drag&drop (`dragover`/`drop`) listeners on each evidence dropzone, plus a global `paste` listener (image-only — PDF/TXT/Markdown have no standard OS clipboard "paste as file" gesture) that targets the last-focused empty file-type evidence card, or auto-creates a new one if there isn't one (Research can now start with zero cards, so paste needs to work without first clicking "+ Add Evidence").
- `TXT` and `Markdown` evidence types, alongside the existing 截图/PDF.
- A title input, now shown unconditionally for every evidence card — previously shown ONLY for non-file evidence types, meaning a file-type card's title (which flows into `additionalEvidence[].title` in the Analysis Payload) had no way to be seen or edited in the UI at all.
- `filterSourceSnapshotsToAsset(sourceSnapshots, selectedAssetSymbol)` — trims `market`/`technical`/`derivatives` (each structured one `values` row per tracked symbol) down to just the selected asset's row.
- `summarizeNewsSnapshot(sourceSnapshots, newsPipelineStats)` — replaces the `news` snapshot's per-headline `values` (one row per fetched article) with 4 fixed summary counts (fetched/filtered/clustered/selected), reusing the same stats already computed for Research's on-page news stats line.
- `devAiModelForProvider()`/`devAiProviderChanged()`/`ensureAiProviderConfigLoadedForDevModal()` — the dev Prompt Preview modal's Model field now auto-fills from the real Settings-configured `defaultModel` for whichever provider is selected.

### Changed
- `freshEvidence()` now returns `[]` (was 4 seeded fake cards). `EVIDENCE_TYPE_ICON`/`EVIDENCE_FILE_TYPES` extended to include TXT/Markdown.
- `buildAnalysisPayload()` now calls the two new filter functions once, right after its existing deep copy of `getResearchSourceSummaries()`. `selectedNewsEvents` and every other snapshot (macro/etf/onchain/sentiment/stablecoin/liquidation/options) are untouched.
- Evidence dropzone's file `accept` attribute broadened to all 4 supported kinds at once (type is auto-detected from whatever's actually uploaded, not from a pre-selected dropdown).

### Fixed
- File-type evidence could carry a title that was never visible or editable anywhere in the UI (only shown for non-file types) — now always shown, for every type.
- The dev Prompt Preview's provider picker required manually typing a model name for `openai-compatible` (and relied on hardcoded, potentially-stale model names for the other 4 providers) — now reads the real configured default.

### Removed
- `EVIDENCE_DEFAULTS` — the 4-item fake evidence seed array (including a title, "BTC 关键支撑区域截图", that named specific content no real upload had ever produced).
- `DEV_AI_PROVIDER_MODEL_PRESETS` — the hardcoded per-provider model name object.

### Verification
Real jsdom harness driving the actual `prototype/index.html` code against the live backend (not hand-copied logic) — see `DEV_STATUS.md` Section 11 for full detail:
- `npm run typecheck` (pipeline, sanity-only — no backend files touched) and frontend `node --check` both passed.
- Real BTC/USDT submission: `promptText.length` 21,762 → 13,905 chars (**−36.1%**); news snapshot rows 64 → 4; market/technical/derivatives rows 6 → 1 each; the other 7 (global) snapshots unchanged in row count.
- `selectedNewsEvents` confirmed byte-identical to a fresh, independent `runNewsPipeline()` call.
- `Store.live.market.itemsRaw.length` confirmed unchanged (6) before and after `buildAnalysisPayload()` — the new filtering never mutates the shared data Dashboard reads.
- Research UI regression: fresh draft → 0 evidence cards → empty-state hint shown → simulated "+ Add" → exactly 1 card rendered.
- A real `POST /api/ai/analyze` call using the new, smaller prompt returned `HTTP 200`/`provider_not_configured` (expected — no real credentials in this environment) with no request-shape error, confirming the backend accepts the new Prompt unmodified.

### Remaining Issues
- No real AI provider credentials exist in this environment (unchanged from every prior round) — the verification above proves the request/response plumbing and the measured size reduction, not a real model completion's quality.
- No screenshot yet of the new empty-evidence Research state or the drag&drop/paste interactions.

---

## 2026-08-07 — Dev Prompt Preview: add `openai-compatible` to the Provider picker

Small follow-up — the AI Connections Settings page (Sprint 3.1B.1) and the backend registry/adapter for the generic `openai-compatible` provider were already complete (added in the earlier same-day Relay/Gateway prep round); only the unrelated dev-only Prompt Preview modal's Provider dropdown had never been updated to list it. No backend, AI Engine, Strategy, or parser changes.

### Added
- `openai-compatible` entry in `prototype/index.html`'s `DEV_AI_PROVIDER_MODEL_PRESETS` (empty-string model preset — a relay's available models are operator-defined, so the Model field is left for the dev to type rather than guessing a name). The Provider `<select>` in `openPromptPreviewModal()` already rendered its options from `Object.keys(DEV_AI_PROVIDER_MODEL_PRESETS)`, so no markup change was needed.

### Changed
—

### Fixed
- Known Issues item ("frontend dev preview's provider dropdown still only lists the 4 original providers") from the Relay/Gateway prep round, now resolved.

### Removed
—

### Verification
- Frontend script extracted from `index.html` and checked with `node --check` — passed.
- Real end-to-end check: `POST /api/ai/analyze` with `provider:"openai-compatible"` — the response's `AIRawResult.provider` field came back as `"openai-compatible"`, unchanged, confirming the picker's value flows straight through to the backend request exactly as the other 4 providers' values already did.
- Model field confirmed to remain a free-text, editable input regardless of which provider is selected — no change to that field's markup.

---

## 2026-08-07 — AI Provider Test Connection: Diagnostics Improvement

Follow-up to Sprint 3.1B.1. Fixes a real bug found in that sprint's own verification: a Test Connection failure with an HTTP 200 status (Anthropic) surfaced only as `provider 返回错误（HTTP 200）`, discarding the provider's actual response body entirely. Diagnostics-only change — no AI Engine architecture change, no new error codes, no frontend redesign (the Settings page already displays `error.message` as-is, so it picks up the richer text automatically).

### Added
- `pipeline/src/ai/providerHttp.ts` — `postJson()` now attaches `providerErrorCode`/`providerErrorMessage` (parsed from the provider's JSON error body, trying the common OpenAI/Anthropic/Google error shapes generically) or `providerRawText` (raw body, truncated to 400 chars, when the body isn't JSON or isn't a recognizable error shape — including the 200-but-not-JSON case) to every thrown error. New optional `secrets?: string[]` 4th parameter scrubs any given secret value (the real API key) out of all captured response text before it's attached to an error — defense in depth against a broken relay echoing the request back, covers Google's URL-embedded key too even though it never appears in a header.

### Changed
- `pipeline/src/ai/engine.ts` — `classifyError()` now appends the provider's real detail (from the fields above) to its message when available, e.g. `认证失败：Incorrect API key provided: sk-fake-***0000...`. The `code` classification taxonomy itself is unchanged (`provider_auth_error`/`provider_rate_limited`/`provider_error`/`network_error`/`provider_timeout`); a dedicated 404 branch was added within `provider_error` for a clearer generic message ("请求的接口或模型不存在") before the real detail suffix. Applies to both `/api/ai/analyze` and Settings' Test Connection, since both already shared this function.
- All 5 provider adapters (`openai`/`anthropic`/`google`/`deepseek`/`openai-compatible`Provider.ts) now pass the resolved `apiKey` as `postJson()`'s new `secrets` argument, at both their `analyze()` and `testXConnection()` call sites (10 call sites total).

### Fixed
- The exact reported bug: an HTTP-200-but-unparseable-body Test Connection failure (observed for real against Anthropic during Sprint 3.1B.1 verification) now surfaces the actual response body instead of a bare, uninformative "HTTP 200".

### Removed
—

### Verification
- `npm run typecheck` — passed.
- Real Test Connection calls against real providers with intentionally-fake keys, backend restarted first: Anthropic → `认证失败：invalid x-api-key（provider code: authentication_error）` (was previously just `provider 返回错误（HTTP 200）`, the exact bug being fixed); OpenAI → `认证失败：Incorrect API key provided: sk-fake-********0000...（provider code: invalid_api_key）` (note: the partial key shown is OpenAI's own well-known self-masking format for support identification, not a leak of our redaction — matches the same masked style OpenAI shows in its own dashboard); Google → `provider 返回错误（HTTP 400）：API key not valid. Please pass a valid API key.（provider code: 400）`.
- Non-JSON body path (the original bug's shape) reproduced against two real unrelated HTTP endpoints via `openai-compatible`'s configurable base URL: a 503 HTML error page and a 405 HTML error page both had their real body (truncated to 400 chars) surfaced in the message, instead of a bare HTTP-status-only message.
- Regression: `POST /api/ai/analyze` still correctly returns `provider_not_configured` for an unconfigured provider; the "not set" precheck path (no default model configured) still short-circuits before any network call, unaffected by this change.
- Test data cleared from `pipeline/data/ai_provider_config.json` back to `{}` after verification.

---

## 2026-08-07 — Sprint 3.1B.1: AI Connections Settings Page

### Added
- `pipeline/src/ai/configStore.ts` — new JSON-file-backed configuration store (`pipeline/data/ai_provider_config.json`, gitignored via the pre-existing `data/` entry, survives backend restart, no database). Layered resolution per provider: Settings-file value → env var → official default. `saveProviderConfig()` rejects an incoming `apiKey` that looks like the display mask (`looksLikeMaskedKey()`), so a client that merely echoes back what it was shown can never overwrite the real key. `maskApiKey()` returns a fixed 12-asterisk prefix + last 4 real chars, deliberately not proportional to real key length.
- `pipeline/src/ai/configTest.ts` — `testProviderConnection()`, the Test Connection orchestrator; reuses `engine.ts`'s `classifyError()`/`getTimeoutConfig()` so a test failure and an `/api/ai/analyze` failure are classified identically.
- `testXConnection(overrides)` export added to each of the 5 provider adapter files (`openai`/`anthropic`/`google`/`deepseek`/`openai-compatible`Provider.ts) — separate from the unchanged `AIProvider` interface, lets Test Connection verify draft (possibly-unsaved) form values via explicit parameter overrides rather than mutating shared state.
- 3 new backend routes in `pipeline/src/server.ts`: `GET /api/ai/config` (masked view of all 5 providers), `POST /api/ai/config/:provider` (save; blank `apiKey` = don't change the saved key), `POST /api/ai/config/:provider/test` (real Test Connection, result not persisted to `qa_ai_raw_results`).
- New page in `prototype/index.html`: `Settings → AI Connections` (`#/settings/ai-connections`) — 5 provider cards (enable toggle, API Base URL, API Key with show/hide toggle + masked-key display, Default Model free-text field with no hardcoded validation list, connection status, Test Connection button, Save button). `iconEye`/`iconEyeOff` icons added to the existing hand-drawn outline icon system.

### Changed
- All 5 provider adapters now resolve API key / base URL / enabled flag / default model through `configStore.ts`'s effective-value functions instead of reading `process.env` directly — Sprint 3.1B's original pure-env-var configuration still works unchanged when a provider has never been touched via Settings (`getEffectiveEnabled()` defaults to `true` when unconfigured).
- `pipeline/src/ai/engine.ts` — `classifyError()` changed from module-private to exported, for reuse by `configTest.ts`. No other change to `engine.ts`; `validateAIAnalyzeRequest()`/`runAIAnalysis()` untouched.
- Sidebar `设置` nav-item switched from a disabled `scope-toast` placeholder to a real route.

### Fixed
—

### Removed
—

### Verification
(No real, non-fake AI provider key exists anywhere in this environment — same as every prior AI Engine round. One deliberate real network call was made against DeepSeek with a fake key, to prove the failure path end-to-end.)
- `npm run typecheck` (pipeline) — passed. Frontend script extracted from `index.html` and checked with `node --check` — passed.
- Backend restarted; `GET /health` confirmed working with the 3 new routes registered.
- Save → load round trip confirmed live (not cached): `POST /api/ai/config/deepseek` with a fake key, then `GET /api/ai/config` immediately after, returned the identical fixed-length mask.
- Masking confirmed by comparing the raw on-disk JSON file (real key, cleartext, local-only) against every API response (mask + `hasApiKey` boolean only, never the real key).
- Re-submitting the exact displayed mask string as a new key was correctly rejected server-side; the raw file's real key was confirmed unchanged before/after.
- Test Connection real-failure path (DeepSeek, fake key): real 1521ms network round trip → correctly classified `provider_auth_error`.
- Test Connection precheck path (OpenAI, no default model set): 3ms, `invalid_request`/`"...not set"`, no network call attempted — confirmed distinct from the network-error path above.
- Unknown provider name on the test route → clean `{ok:false, error:...}`, not a crash.
- Regression: existing `POST /api/ai/analyze` still correctly returns `provider_not_configured` for an unconfigured provider — this sprint's config-layer change didn't alter existing AI Engine behavior.
- Test data cleared from `pipeline/data/ai_provider_config.json` back to `{}` after verification — no fake config left behind.

### Remaining Issues
- Still 0 of 5 providers have real credentials anywhere in this environment.
- No confirmation screenshot yet of a *successful* (Connected) Test Connection result, since no real key exists to produce one.

---

## 2026-08-07 — AI Engine: Relay/Gateway Support (pre-3.1C prep)

### Added
- `pipeline/src/ai/providers/openaiCompatibleProvider.ts` — 5th provider, `openai-compatible`, for third-party relay/gateway services exposing an OpenAI-Chat-Completions-compatible API. Requires both `CUSTOM_AI_API_KEY` and `CUSTOM_AI_BASE_URL` (no official-endpoint fallback for a generic relay). Model name passed through verbatim, no hardcoded list.
- `joinUrl()` helper in `pipeline/src/ai/providerHttp.ts`
- 9 new `.env.example` placeholders: `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL`/`GOOGLE_AI_BASE_URL`/`DEEPSEEK_BASE_URL`/`CUSTOM_AI_API_KEY`/`CUSTOM_AI_BASE_URL`

### Changed
- All 4 existing official provider adapters (`openaiProvider.ts`/`anthropicProvider.ts`/`googleProvider.ts`/`deepseekProvider.ts`) now read an optional `*_BASE_URL` env var, falling back to a `DEFAULT_BASE_URL` constant (the real official endpoint) when unset. Request/response parsing logic itself is unchanged — only the endpoint is now configurable.
- `pipeline/src/ai/registry.ts` — extended from 4 to 5 entries; none of the existing 4 replaced or altered.

### Fixed
—

### Removed
—

### Verification
(No paid AI request made — no valid relay configuration exists yet in this environment.)
- All 5 providers still resolve and correctly report `provider_not_configured` (no keys anywhere in this environment)
- Default fallback proven with a real request: `OPENAI_BASE_URL` left unset still reached the real official OpenAI API (real 401, 1877ms latency) — refactor didn't break the default path
- Override proven with a real redirected request: a local mock HTTP server + `OPENAI_BASE_URL` pointed at it → confirmed the actual request hit the mock at the correct path with the correct auth header, not just that the code compiles
- `openai-compatible` correctly required BOTH `CUSTOM_AI_API_KEY` and `CUSTOM_AI_BASE_URL` (partial config still `provider_not_configured`); with both set against a second local mock, succeeded with an arbitrary non-preset model name passed through untouched
- Security re-confirmed: frontend source has zero matches for any of the 9 new env-var names
- `npm run typecheck` — passed; `GET /health` — confirmed working after restart

### Remaining Issues
- Still 0 of 5 providers have real credentials in this environment
- Frontend dev preview's provider dropdown still only lists the original 4 providers, not `openai-compatible` (backend fully supports it via curl/API; not added to the dev UI dropdown since not requested this round)

---

## 2026-08-07 — Sprint 3.1B: Multi-Model AI Engine Foundation

### Added
- `pipeline/src/ai/types.ts` — `AIProvider`/`AIProviderRequest`/`AIProviderResult`/`AIAnalyzeRequest`/`AIRawResult` types, 8-category `AIEngineErrorCode`
- `pipeline/src/ai/providers/{openai,anthropic,google,deepseek}Provider.ts` — 4 real provider adapters, each `isConfigured()` + `analyze()`, built against each provider's real documented API
- `pipeline/src/ai/providerHttp.ts` — shared HTTP helper (single place HTTP-error classification info originates from)
- `pipeline/src/ai/registry.ts` — `PROVIDERS` map + `resolveProvider()`
- `pipeline/src/ai/engine.ts` — `validateAIAnalyzeRequest()`, `runAIAnalysis()` (timeout via `Promise.race`, error classification, never throws)
- `POST /api/ai/analyze` route in `pipeline/src/server.ts`
- `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`GOOGLE_AI_API_KEY`/`DEEPSEEK_API_KEY`/`AI_REQUEST_TIMEOUT_MS` placeholders in `pipeline/.env.example`
- Frontend: `devSendToAiEngine()`, `qa_ai_raw_results` persistence (`saveAiRawResult()`/`loadAiRawResults()`/`getAiRawResultsByAnalysisId()`), provider/model picker + attempt-history list added to the existing Sprint 3.1A Prompt-preview modal

### Changed
—

### Fixed
—

### Removed
—

### Verification
- All 4 providers, no keys configured anywhere in this environment → all correctly return `provider_not_configured`, zero network calls (`latencyMs:0`)
- Unsupported provider name → `provider_not_supported`; malformed request → `400 invalid_request`
- Temporary fake keys (isolated test process only, never in `.env`) proved all 4 adapters' real request shapes against each provider's real live API: OpenAI/Anthropic/DeepSeek → real 401 → `provider_auth_error`; Google → real 400 → `provider_error` (correct per Google's actual behavior). No fake key ever appeared in any response.
- Security: no key field in any request/response type; frontend source confirmed to contain no provider env-var names; no key in any network payload
- Full jsdom regression: dev UI round trip (send → real `AIRawResult` → persisted, retrievable by `analysisId`), 2 attempts for one analysis preserved separately, source Payload unchanged throughout, Dashboard/Research/Strategy(mock)/Execution/Trade List all still rendering
- `npm run typecheck` — passed

### Remaining Issues
- **0 of 4 AI providers have real credentials in this environment — no real model completion has ever been produced.** Architecture and request shapes are verified; a live completion is not.
- Response parsing/validation against `AI_RESPONSE_SPEC.md` and Strategy integration do not exist yet (Sprint 3.1C)
- Timeout uses `Promise.race`, not true request cancellation — documented tradeoff, matches the spec's exact `AIProvider` interface

---

## 2026-08-07 — Sprint 3.1A: Prompt Builder

### Added
- `buildPromptRecord(payload)` in `prototype/index.html` — deterministic Analysis Payload → Prompt Record builder, idempotent per `analysisId`
- 4 fixed-order prompt-section functions (`buildSystemPromptSection`/`buildTradingRulesSection`/`buildPayloadSection`/`buildOutputContractSection`) + `buildPromptText()` orchestrator
- `normalizeAnalysisPayload()` — read-time-only legacy `version:1` → `payloadVersion:"1.0.0"` compatibility shim, never mutates stored data
- `validateNormalizedPayload()` — structured error codes for missing/malformed Payload fields
- Prompt Record persistence: `savePromptRecord()`/`loadPromptRecords()`/`getPromptRecordByAnalysisId(id)` (`localStorage` key `qa_prompt_records`)
- Sidebar dev-only "查看最近 Prompt" preview modal (`openPromptPreviewModal()`)

### Changed
- `buildAnalysisPayload()` now writes `payloadVersion:"1.0.0"` instead of `version:1`, per `ANALYSIS_PAYLOAD_SPEC.md`'s canonical field name
- `analyze` action handler now also builds the Prompt Record immediately after the Analysis Payload, both synchronously, no AI call

### Fixed
—

### Removed
—

### Verification
- Real Research submission → real Prompt Record: all 4 sections present in order, exact `analysisId`, all 11 source weights, all 10 selected news events, all 4 evidence items, all 11 source-snapshot statuses, complete Output Contract (23,014-character `promptText` in the verification run)
- Same Payload → byte-identical `promptText`; rebuilding an existing analysis returns the original record (`generatedAt` unchanged); a second analysis creates a genuinely separate record
- Hand-crafted legacy Payload (`version:1`) correctly normalized for prompt generation, never rewritten on disk
- All 5 malformed-input fixtures (no payload, malformed weights/evidence/snapshots/news-events) threw the correct structured error code
- Dashboard, Research, Strategy (still Mock), Execution, Trade List all confirmed rendering with no regressions
- `npm run typecheck` — passed (backend untouched)

### Remaining Issues
- Strategy still does not consume the Prompt Record or any AI output — no AI model has been called anywhere in this codebase yet
- Sprint 3.1B (AI Engine) will need to resolve API-key handling for a client-only prototype with no backend AI proxy — flagged as a discovered risk, not yet decided

---

## 2026-08-07 — Sprint 2.2: Analysis Payload Builder + News Event Selection

### Added
- `buildAnalysisPayload()` in `prototype/index.html` — builds one immutable `AnalysisPayload` per Research submission (source weights, additional evidence, deep-copied 11-source snapshots, ≤10 selected news events, data-quality summary), persisted to `localStorage` (`qa_analysis_payloads`), retrievable by `analysisId` via `getAnalysisPayload(id)`
- News Pipeline v1: `runNewsPipeline()` + 6 stage functions (`newsStage1TimeFilter`/`newsStage2AssetRelevance`/`newsStage3Dedup`/`newsStage4Cluster`/`newsStage5Score` + top-10 selection) — deterministic, no AI model, operating on already-loaded `Store.live.news.itemsRaw`
- Bilingual keyword tables (`NEWS_ASSET_KEYWORDS`, `NEWS_MACRO_KEYWORDS`, `NEWS_MAJOR_EVENT_KEYWORDS`) — centralized, configurable
- Research UI: compact inline stats line on the news weight-item row (fetched/filtered/clustered/selected counts) + a read-only "查看已选择新闻事件" modal (`openSelectedNewsModal()`)

### Changed
- `analyze` action handler now calls `buildAnalysisPayload()` before the existing mock analysis animation runs. Nothing else changed — `generateStrategy()` is untouched and does not consume the payload.

### Fixed
- Stage 4 clustering bug (caught by fixture verification, not inspection): comparing full `label+detail` text let two unrelated stories from the same news outlet falsely merge on shared "来源：X" boilerplate. Fixed via `newsContentText()`, which extracts only the headline + English-original text for all content-similarity comparisons (Stages 2, 4, 5).

### Removed
—

### Verification
- Real data: 69 fetched → 21 after time+asset+dedup → 21 clusters → 10 selected (BTC/USDT, 最近7天)
- Full Research submission → payload created with all 11 source weights, all 4 evidence items, 11 deep-copied source snapshots, 10 selected news events
- Second submission → different `analysisId`; live-state mutation + Dashboard refresh → saved payload unchanged (immutability confirmed)
- Fixture suite: exact-duplicate URL removed, near-duplicate story clustered, unrelated story correctly kept separate (post-fix), no-timestamp-official-source item retained, no-timestamp-non-official item dropped
- Simulated total news-source failure did not block payload creation
- Dashboard, Strategy, Execution, Trade List, Trade Detail all confirmed rendering with no regressions
- `npm run typecheck` — passed (backend untouched)

### Remaining Issues
- Strategy does not consume the Analysis Payload (deliberate scope boundary — see DEV_STATUS.md Decisions Needed #3)
- News-event `relatedAssets` is single-asset-scoped, matching Research's current single-asset-per-analysis UI
- Research implementation status remains **In Progress**; Strategy remains documented as **Mock**

---

## 2026-08-06 — Sprint 2.1: Research Data Adapter

### Added
- `getResearchSourceSummaries()` / `researchSourceSummaryFor()` in `prototype/index.html` — normalizes all 11 Dashboard data sources into one unified `ResearchSourceSummary` shape (`status`, `updatedAt`, `values[]`, `summary`, `detailRoute`, `error`)

### Changed
—

### Fixed
—

### Removed
—

### Verification
- jsdom test against the real running backend — all 11 sources produced valid shapes; live statuses observed: 9× available, 1× partial (liquidation, honest empty-events note)
- Simulated single-source failure (options) confirmed isolated — other 10 entries unaffected
- Staleness detection (>5min since `updatedAt`) confirmed functional
- `detailRoute` confirmed correct: `market-detail`/`liquidation-detail` for the 2 sources with real Detail Pages, `null` for the other 9
- Dashboard (11/11 cards) and Research (unchanged UI) both confirmed rendering normally
- `npm run typecheck` — passed (backend untouched)

### Remaining Issues
- Adapter is not yet consumed by any page — Research UI, weight sliders, Strategy, Execution, Trade, Dashboard layout, and navigation are all unchanged this sprint (by design)
- Research page status remains **In Progress**

---

## 2026-08-06 — CoinGlass Liquidation Connector (Reserved)

### Added
- `pipeline/src/connectors/coinglassLiquidationConnector.ts` — CoinGlass liquidation API connector (polling, 24h backfill on start, per-symbol incremental cursor)
- `getActiveLiquidationSource()` export on `liquidationCollector.ts`

### Changed
- `pipeline/src/collectors/liquidationCollector.ts` — branches on `COINGLASS_API_KEY` presence; falls back to existing Binance WebSocket connector when absent
- `pipeline/src/normalize/liquidation.ts` — accepts either connector's raw event shape
- `pipeline/src/sources/liquidation.ts` — source label ("Binance"/"CoinGlass") now reflects the actually-active connector

### Fixed
—

### Removed
—

### Verification
- `npm run typecheck` — passed
- Real server restart with `COINGLASS_API_KEY` blank — confirmed Binance-only behavior unchanged
- Real (unauthenticated + garbage-key) requests against the live CoinGlass API — confirmed request shape and error-handling correctness
- No paid key available — authenticated response shape and long/short side mapping remain unverified

### Remaining Issues
- CoinGlass `side` field long/short mapping is an educated guess pending real-key verification (see DEV_STATUS.md Known Issues)
- Not yet activated — `COINGLASS_API_KEY` intentionally left blank in `.env`

---

## 2026-08-06 — Ticker Price Auto-Refresh

### Added
- `refreshTickerPrices()` and `renderTickerStrip()` in `prototype/index.html` — 20s auto-refresh for the top-banner BTC/ETH/TOTAL MKT CAP numbers only

### Changed
- `.ticker-strip` container given a stable `id` for targeted DOM updates (no full-page re-render on refresh)

### Fixed
—

### Removed
—

### Verification
- jsdom test against the real running backend — confirmed a focused/typed-into search input and an open modal both survive a `refreshTickerPrices()` call unchanged
- Confirmed no-op when off the Dashboard route or when the tab is backgrounded (`document.hidden`)

### Remaining Issues
- Sparkline chart does not auto-refresh (numbers only, by design — see DEV_STATUS.md)

---

## 2026-08-06 — News Source Management: Real Backend + Exchange Adapters + Preset Catalog

### Added
- `news_sources` SQLite table (`pipeline/src/db.ts`) and full CRUD REST API (`GET/POST /api/news-sources`, `PATCH/DELETE /api/news-sources/:id`) in `pipeline/src/server.ts`
- Real exchange-announcement parsers for Binance/OKX/Bybit (`pipeline/src/sources/news.ts`'s `EXCHANGE_ADAPTERS`)
- `NEWS_SOURCE_PRESETS` curated catalog + "浏览预设源" one-click-adopt UI (`prototype/index.html`)

### Changed
- `pipeline/src/sources/news.ts`'s `fetchNews()` now reads sources from the SQLite table (respecting each source's own fetch interval and lookback window) instead of a hardcoded feed list
- News source management UI (`prototype/index.html`) — all add/edit/delete/toggle actions now call the real backend; no `localStorage` fallback remains

### Fixed
—

### Removed
- `localStorage`-based news source config (`qa_news_sources`) — fully superseded by the SQLite-backed API
- 保留历史 (article retention) control from the add/edit wizard — no persisted-article table exists for it to act on

### Verification
- Real curl/`fetch()` round-trips against the running backend for every CRUD operation
- Full jsdom test driving actual UI clicks (not internal function calls) against the live backend — add/edit/toggle/delete/preset-adopt, including deleting a builtin source, zero JS errors
- Confirmed via `GET /api/sources/news` that adopted exchange sources' real articles appear in the aggregated news feed

### Remaining Issues
- `api`/`scrape`-type sources without a matched exchange adapter remain real-but-unfetched placeholders (honestly labeled in UI)
- The Block RSS preset currently rate-limited by its own server (transient, not a code issue)
