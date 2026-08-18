import type { AIProvider, AIProviderRequest, AIProviderResult, AIImageRequest } from '../types.js';
import { postJson, joinUrl } from '../providerHttp.js';
import { getEffectiveApiKey, getEffectiveBaseUrl, getEffectiveEnabled, getEffectiveDefaultModel } from '../configStore.js';

/** Real Google Generative Language API generateContent endpoint — stable, documented shape. Base
 * URL/key/enabled resolved through configStore.ts (Sprint 3.1B.1); AIProvider interface unchanged
 * from Sprint 3.1B. Auth is a query-string ?key= (this API's documented convention, unlike the
 * Authorization-header pattern the other 3 official providers use) — a relay may or may not
 * preserve that convention, which is exactly why the base URL is configurable rather than assumed. */
const PROVIDER_NAME = 'google';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
interface GoogleGenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };
}

function resolveConfig(overrides?: { apiKey?: string; baseUrl?: string }) {
  const apiKey = overrides?.apiKey || getEffectiveApiKey(PROVIDER_NAME);
  const baseUrl = overrides?.baseUrl || getEffectiveBaseUrl(PROVIDER_NAME, DEFAULT_BASE_URL);
  return { apiKey, baseUrl: baseUrl! };
}

export const googleProvider: AIProvider = {
  isConfigured() {
    return getEffectiveEnabled(PROVIDER_NAME) && !!getEffectiveApiKey(PROVIDER_NAME);
  },
  async analyze(request: AIProviderRequest, overrides?: { apiKey?: string; baseUrl?: string }): Promise<AIProviderResult> {
    const { apiKey, baseUrl } = resolveConfig(overrides);
    if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not set');
    const url = joinUrl(baseUrl, `/models/${encodeURIComponent(request.model)}:generateContent?key=${apiKey}`);
    const data = await postJson<GoogleGenerateContentResponse>(url, { contents: [{ parts: [{ text: request.prompt }] }] }, {}, [apiKey], request.signal);
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    return {
      rawText: text,
      usage: data.usageMetadata
        ? { inputTokens: data.usageMetadata.promptTokenCount, outputTokens: data.usageMetadata.candidatesTokenCount, totalTokens: data.usageMetadata.totalTokenCount }
        : undefined,
      providerRequestId: undefined, // this API does not return a distinct request id in the body
    };
  },
};

/** Sprint 3.1B.1 — Settings page "Test Connection", see openaiProvider.ts's twin for the full
 * rationale (override-aware, no shared/global mutation). */
export async function testGoogleConnection(overrides: { apiKey?: string; baseUrl?: string; model?: string }): Promise<{ rawText: string }> {
  const { apiKey, baseUrl } = resolveConfig(overrides);
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not set');
  const model = overrides.model || getEffectiveDefaultModel(PROVIDER_NAME);
  if (!model) throw new Error('Default Model not set');
  const url = joinUrl(baseUrl, `/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`);
  const data = await postJson<GoogleGenerateContentResponse>(url, { contents: [{ parts: [{ text: 'ping' }] }] }, {}, [apiKey]);
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  return { rawText: text };
}

/** Sprint 3.3B: Image Evidence Parser — Google's multimodal `inline_data` part shape, never used
 * by analyze() above, which still sends a single text part exactly as before. */
export async function analyzeGoogleImage(request: AIImageRequest, overrides?: { apiKey?: string; baseUrl?: string }): Promise<AIProviderResult> {
  const { apiKey, baseUrl } = resolveConfig(overrides);
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not set');
  const url = joinUrl(baseUrl, `/models/${encodeURIComponent(request.model)}:generateContent?key=${apiKey}`);
  const data = await postJson<GoogleGenerateContentResponse>(
    url,
    { contents: [{ parts: [{ text: request.prompt }, { inline_data: { mime_type: request.mimeType, data: request.imageBase64 } }] }] },
    {},
    [apiKey]
  );
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  return {
    rawText: text,
    usage: data.usageMetadata
      ? { inputTokens: data.usageMetadata.promptTokenCount, outputTokens: data.usageMetadata.candidatesTokenCount, totalTokens: data.usageMetadata.totalTokenCount }
      : undefined,
    providerRequestId: undefined,
  };
}
