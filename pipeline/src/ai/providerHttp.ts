/** Joins a configurable base URL with a fixed path, tolerating a trailing slash on the base
 * (`OPENAI_BASE_URL=https://x/v1/` and `=https://x/v1` both work). Shared so the "strip trailing
 * slash, then append" rule lives in exactly one place across all 5 provider adapters. */
export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}

const MAX_DETAIL_LEN = 400;

/** Errors thrown by postJson() carry these extra fields (all optional) so callers — currently
 * engine.ts's classifyError(), for both /api/ai/analyze and Settings' Test Connection — can surface
 * the provider's own words instead of just an HTTP status number. `providerErrorCode`/
 * `providerErrorMessage` are set when the body was JSON with a recognizable error shape;
 * `providerRawText` is set instead when the body was plain text or an unrecognized JSON shape.
 * `networkDiagnostics` (AI Provider Network Diagnostics Hotfix) is set only for the network-level
 * failure branch — fetch() itself threw, never got an HTTP response at all. */
export interface ProviderHttpError extends Error {
  status?: number;
  providerErrorCode?: string;
  providerErrorMessage?: string;
  providerRawText?: string;
  networkDiagnostics?: NetworkErrorDiagnostics;
}

/** AI Provider Network Diagnostics Hotfix — a fixed allowlist of SAFE fields pulled from a raw
 * fetch() network failure: the outer error's own name/message, plus (when present) Node/undici's
 * `.cause`, which is where the actually-diagnostic detail lives (errno/code/syscall/hostname/
 * address/port) — `err.message` alone is just the literal string "fetch failed" and tells nobody
 * anything. Every string field is redacted via redactSecrets() before it's ever stored here; the
 * raw err/cause object itself is NEVER stringified/spread/logged anywhere, only these named
 * primitives, so no unexpected property on a provider- or Node-internal error object can leak
 * through this path. */
export interface NetworkErrorDiagnostics {
  name?: string;
  message?: string;
  causeName?: string;
  causeCode?: string;
  causeErrno?: number;
  causeSyscall?: string;
  causeHostname?: string;
  causeAddress?: string;
  causePort?: number;
  causeMessage?: string;
}

/** Every secret value the caller knows about (the real API key, mainly) is scrubbed from any text
 * pulled off the provider's response before it's ever attached to a thrown error — defense in
 * depth against a broken relay echoing the request back in its error body. This is the only place
 * that matters for Google, whose key travels in the request URL's query string rather than a
 * header (see googleProvider.ts) — postJson never has reason to put the URL itself in an error
 * message, so the query-string key can only leak here, via an echoed response body. */
function redactSecrets(text: string, secrets?: string[]): string {
  if (!secrets || secrets.length === 0) return text;
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('[REDACTED]');
  }
  return out;
}

function safeStr(v: unknown, secrets?: string[]): string | undefined {
  return typeof v === 'string' ? redactSecrets(v, secrets) : undefined;
}
function safeNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** AI Provider Network Diagnostics Hotfix — reads ONLY the fixed allowlist above off `err` and
 * `err.cause`; never stringifies/spreads either object, so an unknown/unexpected property on a
 * provider- or Node-internal error object can never leak through. Returns undefined when nothing
 * on the allowlist was present, so callers can cheaply tell "no diagnostics available" apart from
 * "diagnostics with every field empty". */
function extractNetworkErrorDiagnostics(err: any, secrets?: string[]): NetworkErrorDiagnostics | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const cause = err.cause;
  const diag: NetworkErrorDiagnostics = {
    name: safeStr(err.name, secrets),
    message: safeStr(err.message, secrets),
  };
  if (cause && typeof cause === 'object') {
    diag.causeName = safeStr((cause as any).name, secrets);
    diag.causeCode = safeStr((cause as any).code, secrets);
    diag.causeErrno = safeNum((cause as any).errno);
    diag.causeSyscall = safeStr((cause as any).syscall, secrets);
    diag.causeHostname = safeStr((cause as any).hostname, secrets);
    diag.causeAddress = safeStr((cause as any).address, secrets);
    diag.causePort = safeNum((cause as any).port);
    diag.causeMessage = safeStr((cause as any).message, secrets);
  }
  const hasAnyField = Object.values(diag).some((v) => v !== undefined);
  return hasAnyField ? diag : undefined;
}

/** Short, redacted one-line summary built ONLY from the allowlisted fields above (never the raw
 * err/cause) — e.g. "ECONNRESET · socket hang up" or "ENOTFOUND". Prefers the cause's own code
 * (the actually-useful Node/undici detail: ECONNRESET/ENOTFOUND/ETIMEDOUT/etc.), falls back to the
 * cause's name, and returns undefined when there's genuinely nothing beyond the bare "fetch
 * failed" outer message — callers must never fabricate a cause that wasn't actually observed. */
export function summarizeNetworkErrorDiagnostics(diag?: NetworkErrorDiagnostics): string | undefined {
  if (!diag) return undefined;
  const code = diag.causeCode || diag.causeName;
  if (!code) return undefined;
  const detail = diag.causeMessage && diag.causeMessage !== code ? ` · ${diag.causeMessage}` : '';
  return `${code}${detail}`;
}

/** Best-effort extraction of a human-readable error code/message from a provider's JSON error
 * body. Providers use different shapes — OpenAI/DeepSeek/openai-compatible: `{error:{message,
 * code,type}}`; Anthropic: `{type:'error', error:{type,message}}`; Google: `{error:{code,message,
 * status}}` — so this tries the common shapes generically rather than hardcoding one provider's
 * schema, since a generic relay (openai-compatible) may mimic any of them. Returns null when the
 * body isn't JSON or doesn't contain anything resembling an error message, so the caller falls
 * back to exposing the raw text instead. */
function extractProviderError(text: string): { code?: string; message?: string } | null {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const e = parsed?.error && typeof parsed.error === 'object' ? parsed.error : parsed;
  if (!e || typeof e !== 'object') return null;
  const message = typeof e.message === 'string' ? e.message : undefined;
  const code = typeof e.code === 'string' || typeof e.code === 'number' ? String(e.code)
    : typeof e.type === 'string' ? e.type
    : typeof e.status === 'string' ? e.status
    : undefined;
  if (!message && !code) return null;
  return { code, message };
}

/** Shared by all 5 provider adapters so HTTP-error classification logic lives in one place
 * (the engine reads err.status off whatever this throws) instead of being duplicated 5 times.
 * `secrets` (optional) — real values like the API key — are scrubbed out of any diagnostic text
 * before it's attached to the thrown error; pass the resolved apiKey here from every call site.
 * `signal` (Sprint 3.9.1.1, Section 16) — when provided and later aborted, this REALLY cancels the
 * underlying `fetch()` (a real network-level abort, not just a caller giving up on awaiting it) —
 * fixes the previously-confirmed gap where a provider request kept running in the background after
 * `runAIAnalysis()`'s old `Promise.race` timeout "won". */
export async function postJson<T = any>(url: string, body: unknown, headers: Record<string, string>, secrets?: string[], signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch (err: any) {
    // fetch() itself threw — DNS/connection failure, not an HTTP response. No .status, so the
    // engine classifies this as network_error rather than a provider-side error. The underlying
    // error text (e.g. "getaddrinfo ENOTFOUND ...") is exactly what tells a user their Base URL
    // is wrong, so it's kept, not discarded.
    const detail = redactSecrets(String(err?.message ?? err), secrets);
    const httpErr: ProviderHttpError = new Error(`network request failed: ${detail}`);
    httpErr.providerRawText = detail.slice(0, MAX_DETAIL_LEN);
    httpErr.networkDiagnostics = extractNetworkErrorDiagnostics(err, secrets);
    throw httpErr;
  }
  const rawText = redactSecrets(await res.text(), secrets);
  if (!res.ok) {
    const parsed = extractProviderError(rawText);
    const err: ProviderHttpError = new Error(
      parsed?.message ? `provider HTTP ${res.status}: ${parsed.message}` : `provider HTTP ${res.status}: ${rawText.slice(0, MAX_DETAIL_LEN)}`
    );
    err.status = res.status;
    if (parsed?.code) err.providerErrorCode = parsed.code;
    if (parsed?.message) err.providerErrorMessage = parsed.message;
    if (!parsed?.message) err.providerRawText = rawText.slice(0, MAX_DETAIL_LEN);
    throw err;
  }
  try {
    return JSON.parse(rawText) as T;
  } catch {
    // A 200 with a body that isn't valid JSON — most commonly a misconfigured Base URL landing on
    // the wrong endpoint (an HTML page, an empty body, a differently-shaped success payload from a
    // relay). Still surfaced as an error (the caller expected a specific JSON shape and didn't get
    // one), with the actual body attached instead of a bare "HTTP 200".
    const err: ProviderHttpError = new Error('provider returned a 200 response that was not the expected JSON shape');
    err.status = res.status;
    err.providerRawText = rawText.slice(0, MAX_DETAIL_LEN);
    throw err;
  }
}
