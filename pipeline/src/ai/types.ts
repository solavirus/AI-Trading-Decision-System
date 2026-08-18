/** Sprint 3.1B: Multi-Model AI Engine Foundation. Provider-independent types only — no
 * provider-specific HTTP logic here (that belongs in ai/providers/*.ts), per the frontend/engine
 * "must not contain provider-specific HTTP logic" requirement. */
import type { NetworkErrorDiagnostics } from './providerHttp.js';

export interface AIProviderRequest {
  model: string;
  prompt: string;
  /** Sprint 3.9.1.1, Section 16 — real cancellation. When the caller's timeout fires (or a user
   * cancel is honored, Manual only), this signal aborts the underlying `fetch()` inside `postJson()`
   * for real, instead of merely losing a `Promise.race` while the request keeps running in the
   * background burning tokens. Optional so every existing call site that doesn't care about
   * cancellation (Settings "Test Connection", Image Evidence Parser) is unaffected. */
  signal?: AbortSignal;
}

export interface AIProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AIProviderResult {
  rawText: string;
  usage?: AIProviderUsage;
  providerRequestId?: string;
}

/** One adapter per provider. isConfigured() lets the engine short-circuit to
 * provider_not_configured with zero network calls when a key is missing — never a faked
 * successful response. `overrides` (Sprint 3.3C) mirrors the same optional {apiKey, baseUrl} tuple
 * analyzeXImage() already accepted since Sprint 3.3B.2 — when omitted, behavior is byte-identical
 * to before (falls through to the adapter's own global provider-type-keyed config), so every
 * EXISTING caller (the dev Prompt Preview modal's manual /api/ai/analyze calls) is unaffected.
 * Passing it lets a caller that already resolved a SPECIFIC AIConnection (connectionStore.ts) run
 * the request against that exact connection's credentials, not just "the provider type". */
export interface AIProvider {
  isConfigured(): boolean;
  analyze(request: AIProviderRequest, overrides?: { apiKey?: string; baseUrl?: string }): Promise<AIProviderResult>;
}

/** POST /api/ai/analyze request body. Deliberately has NO field for an API key — the backend
 * never accepts one from the frontend; keys live only in backend env vars (see ai/providers/*.ts).
 * `connectionId` (Sprint 3.3C, optional) — when present, engine.ts resolves credentials from that
 * EXACT AIConnection instead of the global provider-type config, so two connections sharing the
 * same `type` are never ambiguous. Omitting it preserves the original, unmodified behavior — the
 * dev Prompt Preview modal never sends one. */
export interface AIAnalyzeRequest {
  analysisId: string;
  promptVersion: string;
  payloadVersion: string;
  provider: string;
  model: string;
  promptText: string;
  connectionId?: string;
  /** Sprint 3.9.1.1, Section 17/18 — Manual-only real cancel. When set and it fires, engine.ts
   * aborts the SAME underlying fetch the internal timeout controller would abort — one real
   * cancellation mechanism, two possible triggers (timeout vs. user cancel), never two parallel
   * abort code paths. Absent for every caller that doesn't support cancellation (Scheduled runs,
   * Settings "Test Connection", the dev Prompt Preview modal). */
  externalAbortSignal?: AbortSignal;
}

export type AIEngineErrorCode =
  | 'invalid_request'
  | 'provider_not_supported'
  | 'provider_not_configured'
  | 'provider_auth_error'
  | 'provider_rate_limited'
  | 'provider_timeout'
  | 'provider_error'
  | 'network_error'
  | 'connection_not_found'
  | 'connection_disabled';

/** Sprint 3.3B: Image Evidence Parser — a separate, additive capability, deliberately NOT part of
 * AIProviderRequest/AIProvider (keeps the main AI Engine's provider contract/analyze() untouched).
 * Only the 4 image-capable adapters (openai/anthropic/google/openai-compatible) export a matching
 * analyzeXImage(request: AIImageRequest) function; DeepSeek's adapter has none, since its public
 * API has no image input support to wrap. */
export interface AIImageRequest {
  model: string;
  prompt: string;
  imageBase64: string; // raw base64, no "data:...;base64," prefix
  mimeType: string; // e.g. 'image/png' | 'image/jpeg' | 'image/webp'
}

export interface AIRawResult {
  requestId: string;
  analysisId: string;
  provider: string;
  /** Sprint 3.3C: which specific AIConnection this request actually used, when the caller resolved
   * one (the automatic Research -> AI flow always does; the dev Prompt Preview modal's manual
   * calls still omit it, exactly as before). Runtime metadata only — not part of the frozen
   * AI_RESPONSE_SPEC.md contract, so adding it here doesn't touch that spec at all. */
  connectionId?: string;
  model: string;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  usage?: AIProviderUsage;
  rawText: string;
  providerRequestId?: string;
  status: 'success' | 'error';
  /** `diagnostics` (AI Provider Network Diagnostics Hotfix) is set only for a `network_error` that
   * fetch() itself threw for (never for an HTTP-status error, never for a timeout) — a fixed,
   * redacted allowlist of Node/undici fields (see providerHttp.ts's NetworkErrorDiagnostics), never
   * the raw exception object. Purely additive diagnostic metadata; `code`/`message` are unchanged. */
  error?: { code: AIEngineErrorCode; message: string; diagnostics?: NetworkErrorDiagnostics };
}
