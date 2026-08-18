# Prompt Builder Specification

Version: 1.1.0

Status: Frozen

Last Updated: 2026-08

Revision note (1.1.0, 2026-08): added the `PromptRecord` persistence contract; cross-referenced `ANALYSIS_PAYLOAD_SPEC.md` (the now-frozen upstream contract this document previously assumed without citing) for `payloadVersion` and Section 3's field list; added a Scope and Governance cross-reference. See `product-docs/PRODUCT_STATUS.md`'s Frozen Product Decisions log. No code implements this specification yet.

---

## Purpose

Defines how one Analysis Payload is deterministically transformed into one Prompt Record — the 4 fixed prompt sections, and the persistence contract for `PromptRecord`.

## When To Read

Read this document when:
- Changing how the Payload is formatted into a prompt
- Adding or modifying a prompt section
- Checking what a Prompt Record contains or guarantees

Do NOT read this document when:
- Changing what data the Payload itself contains (see `ANALYSIS_PAYLOAD_SPEC.md`)
- Working on AI provider request/response handling (see `AI_RESPONSE_SPEC.md`)

---

# Goal

Define how an Analysis Payload is transformed into one deterministic prompt.

The Prompt Builder is responsible only for assembling prompts.

It does NOT perform analysis.

It does NOT call any AI model.

It does NOT parse responses.

It does NOT contain business logic.

---

# Responsibilities

Input

Analysis Payload

↓

Output

Final Prompt

The Prompt Builder is a formatter.

It transforms structured objects into structured prompts.

---

# Product Flow

Research

↓

Analysis Payload

↓

Prompt Builder

↓

Final Prompt

↓

AI Engine

↓

AI Response

---

# Principles

The same Analysis Payload must always produce the same prompt.

No randomness.

No hidden state.

No external requests.

No runtime-generated content.

Prompt generation must be deterministic.

---

# Prompt Structure

The final prompt is assembled from four sections.

Order must always remain the same.

1.

System Prompt

↓

2.

Trading Rules

↓

3.

Analysis Payload

↓

4.

Output Contract

---

# Section 1

System Prompt

Purpose

Describe the AI role.

Contains

- identity
- responsibilities
- behaviour
- constraints

Must NOT contain

- payload data
- trading signals
- user configuration

Reusable.

---

# Section 2

Trading Rules

Purpose

Provide global trading behaviour.

Examples

- evidence first
- risk management
- WAIT when evidence is insufficient
- never invent facts
- explain conflicting evidence
- strategy only
- never execute trades

Reusable.

Must remain model-independent.

---

# Section 3

Analysis Payload

Purpose

Inject the current experiment.

Must include

- symbol
- timeframe
- date range
- source weights
- normalized source summaries (`AnalysisPayload.sourceSnapshots`)
- selected news events (`AnalysisPayload.selectedNewsEvents`)
- additional evidence
- data quality

The full, canonical field-by-field definition of the Analysis Payload — including required/optional status, types, and the `payloadVersion` field — is `ANALYSIS_PAYLOAD_SPEC.md`. This section names which parts of that Payload get injected; it does not redefine their shape.

Rules

Do not modify values.

Do not summarize.

Do not reorder unless required for formatting.

Payload content must remain faithful to the stored Analysis Payload.

---

# Section 4

Output Contract

Purpose

Define the required response format.

The Prompt Builder must reference

AI_RESPONSE_SPEC.md

The AI must return

JSON only.

No markdown.

No explanations outside JSON.

---

# Prompt Templates

Prompt templates must be reusable.

Suggested project structure

/prompts

system.md

trading_rules.md

output_contract.md

builder.ts

Equivalent naming is acceptable.

---

# Prompt Version

Every generated prompt must include

promptVersion

Example

1.0.0

Prompt version is independent from

Analysis Payload version

AI Response version

AI model version

Each version evolves independently.

---

# Prompt Metadata

Every generated prompt should preserve

- promptVersion
- analysisId
- payloadVersion

These values may be stored separately from the prompt text if preferred.

`payloadVersion` here is the same field defined canonically in `ANALYSIS_PAYLOAD_SPEC.md` — copied from the source Analysis Payload at generation time, not independently assigned.

---

# Prompt Record (persistence contract)

Purpose

Define the immutable, persisted record wrapping one generated prompt. This is the first of the two records downstream of the Analysis Payload — see `ANALYSIS_PAYLOAD_SPEC.md`'s "Relationship to Prompt Record and AI Response Record" and `AI_RESPONSE_SPEC.md`'s AI Response Record.

```ts
type PromptRecord = {
  analysisId: string;
  promptVersion: string;
  payloadVersion: string;
  generatedAt: string;
  promptText: string;
}
```

Rules

For the current MVP, Prompt Records are persisted in `localStorage`, linked by `analysisId`, alongside the source Analysis Payload and the eventual AI Response Record.

Immutable after creation — a retry or a new analysis creates a new `PromptRecord`, never overwrites a historical one.

This persistence is a frozen contract only. It is NOT implemented in code as of this revision.

---

# Formatting Rules

The Prompt Builder may:

- format JSON
- indent content
- improve readability

The Prompt Builder must NOT:

- infer new facts
- remove payload fields
- modify payload values
- reorder evidence by opinion

---

# Model Independence

The Prompt Builder must not contain provider-specific logic.

Examples

Do NOT write

if GPT

if Claude

if Gemini

Provider-specific behaviour belongs to the AI Engine.

Prompt Builder remains identical for every model.

---

# Error Handling

If the Analysis Payload is invalid

Prompt generation must fail.

Do not silently repair payloads.

Return a structured error.

---

# Debug Mode

Development mode may expose

- generated prompt
- prompt length
- prompt version

This functionality is for development only.

It must not affect prompt generation.

---

# Scope

Prompt Builder does NOT

- call AI
- execute HTTP requests
- parse AI responses
- create strategies
- modify payloads
- update trades
- update learning

Scope and Governance authorization (the formal statement that this specification authorizes AI-integration work beyond `MVP Handbook.md`'s original Out Of Scope list) is defined once, in `AI_RESPONSE_SPEC.md`'s "Scope and Governance" section, and applies to this specification too. It is not restated here to avoid drift between copies.

---

# Compatibility

Consumed by

AI Engine

Compatible with

- GPT
- Claude
- Gemini
- DeepSeek
- Qwen
- Local Models

Future providers must reuse the same Prompt Builder.

---

# Versioning

Current Version

1.1.0

Revision history

1.0.0 — initial frozen specification.

1.1.0 (2026-08) — added `PromptRecord`, cross-referenced `ANALYSIS_PAYLOAD_SPEC.md` as the canonical source for Payload field definitions, added the Scope and Governance cross-reference. Additive only — no existing field or rule was removed or redefined, so this revision is backward-compatible with 1.0.0.

Breaking changes require a new specification version.

---

# Status

Frozen

No implementation should change this specification without a recorded Product Decision.
