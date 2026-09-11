# Screenshot Guide

Updated At: 2026-08-08 00:55

Checklist used for product reviews. `product-docs/screenshots/` has real, committed screenshots (first captured Sprint 3.2A, replaced Sprint 3.2B once the flow they showed became real) — captured with a real headless browser (puppeteer-core driving the system's installed Edge, not a mockup), not hand-described. Everything else below is still not committed; prior sessions' claims that screenshots existed only in "ephemeral session temp storage" no longer apply to Research/the Analysis Runner overlay specifically, but still apply to the other pages.

| Page | Exists | Latest Screenshot | Needs Update |
|---|---|---|---|
| Dashboard | Yes | None committed | Yes |
| Research | Yes | `research-empty-evidence.png` (Sprint 3.2A — weights configured, ready to Run Analysis; doesn't scroll far enough to show the empty-evidence section itself) | Partial — news-inspection UI from Sprint 2.2 and the click/drag/paste upload UI from Sprint 3.1B.2 still not separately screenshotted |
| Strategy | Yes | None committed | Yes |
| Execution | Yes | None committed | Yes |
| Trade List | Yes | None committed | Yes |
| Trade Detail | Yes | None committed | Yes |
| Settings / AI Connections | Yes (Sprint 3.1B.1) | None committed | Yes — first screenshot needed; ideally one card showing a saved+masked config and one showing a Failed Test Connection result with a readable error |
| Learning | No — disabled placeholder nav item only, page does not exist | N/A | N/A |

**Analysis Runner overlay** (UI built Sprint 3.2A, real logic Sprint 3.2B — see `DEV_STATUS.md`/`CHANGELOG.md`): not one of the 7 pages above, a full-screen overlay shown on top of Research when the user clicks "开始 AI 分析". 4 real screenshots committed, all against the live backend with no scripted outcomes:
- `analysis-runner-real-progress.png` — mid-run, 9 of 11 collect stages simultaneously ⏳ running (real concurrent requests, not the old one-at-a-time reveal), live elapsed timer, Cancel enabled.
- `analysis-runner-ready.png` — all 15 stages ✓, "分析已就绪 / Prompt 已成功构建", real Developer Diagnostics panel (collected/skipped/failed counts, collection duration, Payload/Prompt sizes, Prompt build duration — all real numbers), sticky footer keeping [查看 Prompt（开发用）]/[关闭] visible even with the extra diagnostics content.
- `analysis-runner-real-failed.png` — 2 sources really failed together (real HTTP 500 + real network error, via a test-only fetch intercept reproducing real conditions), banner correctly lists both with pluralized phrasing, diagnostics shows "—" for the never-reached Payload/Prompt fields, [重试]/[关闭].
- `sidebar-dev-review-mode.png` — the dev-only "分析诊断信息（开发用）" switch in the sidebar (filename kept from 3.2A for continuity; content re-captured this sprint to show the current switch control, replacing 3.2A's now-removed 成功/失败/网络较慢 dropdown).

**Sidebar dev-only Prompt/AI Engine preview** (not one of the 7 pages above, a visible UI surface since Sprint 3.1A, extended in Sprint 3.1B, provider/model auto-fill added Sprint 3.1B.2): the "查看最近 Prompt（开发用）" modal, reachable from every page's sidebar — has a provider/model picker (Model auto-fills from Settings), a "发送到 AI Engine" button, and an attempt-history list. **Needs a first screenshot** (still none committed).

Every other existing page ("Exists: Yes") still needs its first screenshot committed to `product-docs/screenshots/`.
