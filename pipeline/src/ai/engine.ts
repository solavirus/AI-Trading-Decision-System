import { randomUUID } from 'node:crypto';
import type { AIAnalyzeRequest, AIRawResult, AIEngineErrorCode } from './types.js';
import { resolveProvider } from './registry.js';
import { getConnection } from './connectionStore.js';
import { summarizeNetworkErrorDiagnostics, type NetworkErrorDiagnostics } from './providerHttp.js';

const MAX_STRING_LEN = 200_000; // real prompts measured ~23k chars in Sprint 3.1A; generous headroom
const MAX_SHORT_FIELD_LEN = 200;

export interface AIEngineTimeoutConfig {
  timeoutMs: number;
}
/** Single source of truth for the default — this literal appears nowhere else in the codebase;
 * every caller goes through getTimeoutConfig(). Configurable via AI_REQUEST_TIMEOUT_MS, read from
 * env at call time (not module load time) so tests can override it.
 *
 * History: 30s -> 120s (2026-08-08, 30s was tripping on legitimately-slow provider/relay responses).
 * Sprint 3.9.1.1: 120s -> 300s — with the Sprint 3.9 Unified Analysis Pipeline, the real Prompt now
 * routinely carries the full 11-source Analysis Payload (~30KB observed), and real successful
 * requests against the current provider have been directly observed taking 45-60s even on a good
 * run; 120s had already caused a real, confirmed production failure (Configured timeout: 120000ms,
 * Elapsed: 120033ms). 300s is a first-pass ceiling, not a claim that every request will succeed
 * within it — see engine.ts's AbortController wiring below for why a request that DOES hit this
 * ceiling now stops for real instead of continuing to burn tokens in the background. */
const DEFAULT_TIMEOUT_MS = 300_000;
export function getTimeoutConfig(): AIEngineTimeoutConfig {
  const fromEnv = Number(process.env.AI_REQUEST_TIMEOUT_MS);
  return { timeoutMs: fromEnv > 0 ? fromEnv : DEFAULT_TIMEOUT_MS };
}

export interface ValidationResult {
  ok: boolean;
  value?: AIAnalyzeRequest;
  error?: { code: AIEngineErrorCode; message: string };
}

/** Structural validation only — the backend does not trust localStorage, but it also doesn't
 * re-derive business meaning from the fields (e.g. it doesn't re-run the news pipeline). Non-empty
 * strings, reasonable length caps to avoid abuse. */
export function validateAIAnalyzeRequest(body: any): ValidationResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: { code: 'invalid_request', message: '请求体缺失或格式不正确' } };
  }
  const shortFields: (keyof AIAnalyzeRequest)[] = ['analysisId', 'promptVersion', 'payloadVersion', 'provider', 'model'];
  for (const f of shortFields) {
    const v = body[f];
    if (typeof v !== 'string' || !v.trim()) return { ok: false, error: { code: 'invalid_request', message: `缺少必填字段：${f}` } };
    if (v.length > MAX_SHORT_FIELD_LEN) return { ok: false, error: { code: 'invalid_request', message: `字段过长：${f}` } };
  }
  if (typeof body.promptText !== 'string' || !body.promptText.trim()) {
    return { ok: false, error: { code: 'invalid_request', message: '缺少必填字段：promptText' } };
  }
  if (body.promptText.length > MAX_STRING_LEN) {
    return { ok: false, error: { code: 'invalid_request', message: 'promptText 超出长度限制' } };
  }
  // Sprint 3.3C: connectionId is optional and purely a passthrough — no length/format validation
  // beyond "if present, must be a non-empty string", since an invalid/unknown id is caught later by
  // runAIAnalysis() itself (connection_not_found), not here.
  const connectionId = typeof body.connectionId === 'string' && body.connectionId.trim() ? body.connectionId.trim() : undefined;
  return {
    ok: true,
    value: {
      analysisId: body.analysisId, promptVersion: body.promptVersion, payloadVersion: body.payloadVersion,
      provider: body.provider, model: body.model, promptText: body.promptText, connectionId,
    },
  };
}

/** Optional diagnostics for the timeout branch only (2026-08-08) — provider/model/timeoutMs are
 * known to both call sites (runAIAnalysis(), testProviderConnection()) before they ever await
 * anything, and elapsedMs is trivial to measure at the catch site, so there's no reason a timeout
 * error should be as bare as "请求超时" when this much context is sitting right there in scope.
 * Never carries anything secret — just identifiers and numbers, never a key/header/URL. */
export interface TimeoutDiagnosticsContext {
  provider?: string;
  model?: string;
  timeoutMs?: number;
  elapsedMs?: number;
}

/** Exported for reuse by configTest.ts (Sprint 3.1B.1's Settings "Test Connection") — same error
 * taxonomy applies whether the request came from /api/ai/analyze or a connection test.
 *
 * The `code` classification (provider_auth_error / provider_rate_limited / provider_error /
 * network_error / provider_timeout) is unchanged from before — this only enriches `message` with
 * whatever detail postJson() (providerHttp.ts) managed to pull off the provider's actual response,
 * instead of a bare "provider 返回错误（HTTP 200）" that discards it. Diagnostics-only change: no
 * new error codes, no change to when each branch fires. Detail is provider-controlled text (already
 * scrubbed of any known secret value by postJson before it reaches here), so it's appended as-is
 * rather than parsed further — this function does not attempt to guess "invalid base URL" vs
 * "model not found" itself, it just stops hiding what the provider actually said.
 *
 * `timeoutContext` (2026-08-08) is optional and only affects the `err.timedOut` branch — passing it
 * turns a bare "请求超时" into the Provider/Model/Configured timeout/Elapsed/Error breakdown; omitting
 * it (or calling from anywhere that doesn't have this context handy) keeps the old terse message. */
export function classifyError(
  err: any,
  timeoutContext?: TimeoutDiagnosticsContext
): { code: AIEngineErrorCode; message: string; diagnostics?: NetworkErrorDiagnostics } {
  if (err?.timedOut) {
    if (timeoutContext) {
      const lines = [
        `Provider: ${timeoutContext.provider ?? 'unknown'}`,
        `Model: ${timeoutContext.model ?? 'unknown'}`,
        `Configured timeout: ${timeoutContext.timeoutMs ?? '?'}ms`,
        `Elapsed: ${timeoutContext.elapsedMs ?? '?'}ms`,
        `Error: Request timeout`,
      ];
      return { code: 'provider_timeout', message: lines.join('\n') };
    }
    return { code: 'provider_timeout', message: '请求超时' };
  }
  const status = err?.status;
  const detail: string | undefined = err?.providerErrorMessage || err?.providerRawText;
  const detailCode: string | undefined = err?.providerErrorCode;
  const suffix = detail ? `：${detail}${detailCode ? `（provider code: ${detailCode}）` : ''}` : '';
  if (status === 401 || status === 403) return { code: 'provider_auth_error', message: `认证失败${suffix || '（请检查后端 API Key 配置）'}` };
  if (status === 429) return { code: 'provider_rate_limited', message: `触发限流${suffix}` };
  if (status === 404) return { code: 'provider_error', message: `请求的接口或模型不存在（HTTP 404，请检查 API Base URL 与 Default Model）${suffix}` };
  if (typeof status === 'number') return { code: 'provider_error', message: `provider 返回错误（HTTP ${status}）${suffix}` };
  // AI Provider Network Diagnostics Hotfix — fetch() itself threw (no HTTP response at all), so
  // `err.networkDiagnostics` (postJson's redacted, allowlisted extraction of err/err.cause) is the
  // only place a genuine root cause (ECONNRESET/ENOTFOUND/ETIMEDOUT/etc.) could still be found.
  // Appended as a second line, never fabricated when postJson found nothing on the allowlist.
  const diagnostics: NetworkErrorDiagnostics | undefined = err?.networkDiagnostics;
  const causeSummary = summarizeNetworkErrorDiagnostics(diagnostics);
  const message = causeSummary ? `网络请求失败${suffix}\n底层原因：${causeSummary}` : `网络请求失败${suffix}`;
  return { code: 'network_error', message, diagnostics };
}

/** Never throws — always returns a well-formed AIRawResult, success or error, so the server route
 * can always respond 200 with the result and let status/error carry the outcome (per spec: don't
 * crash the backend on a provider failure). Assumes `request` already passed
 * validateAIAnalyzeRequest().
 *
 * Sprint 3.3C: when `request.connectionId` is present (the automatic Research -> AI flow always
 * sends one, resolved from the main-analysis Model Role), credentials are resolved from that EXACT
 * AIConnection via `overrides`, never from the global provider-type config — this is what makes
 * two connections sharing the same `type` unambiguous (Sprint 3.3C's Step 5: "critical"). When
 * `connectionId` is absent (every existing caller — the dev Prompt Preview modal — still omits
 * it), behavior is 100% unchanged from before this sprint. */
export async function runAIAnalysis(request: AIAnalyzeRequest): Promise<AIRawResult> {
  const requestId = randomUUID();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  function finish(partial: Omit<AIRawResult, 'requestId' | 'analysisId' | 'provider' | 'connectionId' | 'model' | 'startedAt' | 'completedAt' | 'latencyMs'>): AIRawResult {
    const completedAt = new Date().toISOString();
    return {
      requestId, analysisId: request.analysisId, provider: request.provider, connectionId: request.connectionId, model: request.model,
      startedAt, completedAt, latencyMs: Date.now() - startedMs, ...partial,
    };
  }

  const provider = resolveProvider(request.provider);
  if (!provider) {
    return finish({ rawText: '', status: 'error', error: { code: 'provider_not_supported', message: `未知 provider：${request.provider}` } });
  }

  let overrides: { apiKey?: string; baseUrl?: string } | undefined;
  if (request.connectionId) {
    const connection = getConnection(request.connectionId);
    if (!connection) {
      return finish({ rawText: '', status: 'error', error: { code: 'connection_not_found', message: `连接不存在：${request.connectionId}` } });
    }
    if (!connection.enabled) {
      return finish({ rawText: '', status: 'error', error: { code: 'connection_disabled', message: `连接"${connection.name}"已被禁用` } });
    }
    if (!connection.apiKey) {
      return finish({ rawText: '', status: 'error', error: { code: 'provider_not_configured', message: `连接"${connection.name}"未配置 API Key` } });
    }
    overrides = { apiKey: connection.apiKey, baseUrl: connection.baseUrl };
  } else if (!provider.isConfigured()) {
    return finish({ rawText: '', status: 'error', error: { code: 'provider_not_configured', message: `${request.provider} 未配置 API Key` } });
  }

  const { timeoutMs } = getTimeoutConfig();
  // Sprint 3.9.1.1, Section 16 — real AbortController, not a bare Promise.race. A timeout now
  // actually cancels the in-flight fetch() inside postJson() (verified: postJson forwards `signal`
  // straight into fetch's own `signal` option) — the request stops consuming a connection/tokens the
  // instant this fires, rather than "the caller stopped waiting but the request itself kept going."
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  // Sprint 3.9.1.1, Section 17/18 — a Manual user cancel aborts this SAME controller (not a second
  // one), so the request stops for real exactly like a timeout does; classifyError() below just
  // reports it as a generic abort (not `timedOut`) — analysisEngine.ts is the one that knows WHY
  // the abort happened (it checks its own `isCancelRequested()` after this call returns) and
  // re-labels the outcome as CANCELLED rather than AI_FAILED when that's the real cause.
  const onExternalAbort = () => controller.abort();
  request.externalAbortSignal?.addEventListener('abort', onExternalAbort);
  try {
    const result = await provider.analyze({ model: request.model, prompt: request.promptText, signal: controller.signal }, overrides);
    return finish({ rawText: result.rawText, usage: result.usage, providerRequestId: result.providerRequestId, status: 'success' });
  } catch (err: any) {
    if (timedOut) err.timedOut = true; // preserves classifyError()'s existing err.timedOut contract exactly, regardless of what shape the abort actually threw
    const error = classifyError(err, { provider: request.provider, model: request.model, timeoutMs, elapsedMs: Date.now() - startedMs });
    return finish({ rawText: '', status: 'error', error });
  } finally {
    clearTimeout(timer);
    request.externalAbortSignal?.removeEventListener('abort', onExternalAbort);
  }
}
