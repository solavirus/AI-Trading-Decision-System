import type { AIProvider, AIProviderRequest, AIProviderResult, AIImageRequest } from '../types.js';
import { postJson, joinUrl } from '../providerHttp.js';
import { getEffectiveApiKey, getEffectiveBaseUrl, getEffectiveEnabled, getEffectiveDefaultModel } from '../configStore.js';

/** Generic adapter for any third-party relay/gateway that exposes an OpenAI-Chat-Completions-
 * compatible API (this is a very common convention for such relays). Unlike the 4 official
 * providers, there is no "official endpoint" fallback here — both the key AND the base URL must
 * be explicitly configured (Settings-file or env var), or this provider reports not-configured.
 * The model name is whatever the frontend/caller supplies verbatim — no hardcoded model list,
 * since a relay's available models are entirely operator-defined. Base URL/key/enabled resolved
 * through configStore.ts (Sprint 3.1B.1); AIProvider interface unchanged from Sprint 3.1B. */
const PROVIDER_NAME = 'openai-compatible';
interface OpenAICompatibleChatResponse {
  id: string;
  choices: { message: { content: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function resolveConfig(overrides?: { apiKey?: string; baseUrl?: string }) {
  const apiKey = overrides?.apiKey || getEffectiveApiKey(PROVIDER_NAME);
  const baseUrl = overrides?.baseUrl || getEffectiveBaseUrl(PROVIDER_NAME); // no official default
  return { apiKey, baseUrl };
}

export const openAICompatibleProvider: AIProvider = {
  isConfigured() {
    const { apiKey, baseUrl } = resolveConfig();
    return getEffectiveEnabled(PROVIDER_NAME) && !!apiKey && !!baseUrl;
  },
  async analyze(request: AIProviderRequest, overrides?: { apiKey?: string; baseUrl?: string }): Promise<AIProviderResult> {
    const { apiKey, baseUrl } = resolveConfig(overrides);
    if (!apiKey || !baseUrl) throw new Error('CUSTOM_AI_API_KEY or CUSTOM_AI_BASE_URL not set');
    const data = await postJson<OpenAICompatibleChatResponse>(
      joinUrl(baseUrl, '/chat/completions'),
      { model: request.model, messages: [{ role: 'user', content: request.prompt }] },
      { Authorization: `Bearer ${apiKey}` },
      [apiKey], request.signal
    );
    return {
      rawText: data.choices?.[0]?.message?.content ?? '',
      usage: data.usage
        ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens, totalTokens: data.usage.total_tokens }
        : undefined,
      providerRequestId: data.id,
    };
  },
};

/** Sprint 3.1B.1 — Settings page "Test Connection", see openaiProvider.ts's twin for the full
 * rationale (override-aware, no shared/global mutation). Both apiKey and baseUrl are required
 * (no official-endpoint fallback exists for a generic relay). */
export async function testOpenAICompatibleConnection(overrides: { apiKey?: string; baseUrl?: string; model?: string }): Promise<{ rawText: string }> {
  const { apiKey, baseUrl } = resolveConfig(overrides);
  if (!apiKey || !baseUrl) throw new Error('CUSTOM_AI_API_KEY or CUSTOM_AI_BASE_URL not set');
  const model = overrides.model || getEffectiveDefaultModel(PROVIDER_NAME);
  if (!model) throw new Error('Default Model not set');
  const data = await postJson<OpenAICompatibleChatResponse>(
    joinUrl(baseUrl, '/chat/completions'),
    { model, messages: [{ role: 'user', content: 'ping' }] },
    { Authorization: `Bearer ${apiKey}` },
    [apiKey]
  );
  return { rawText: data.choices?.[0]?.message?.content ?? '' };
}

/** Sprint 3.3B: Image Evidence Parser — assumes the relay mirrors OpenAI's multimodal `image_url`
 * content-block convention, the same assumption analyze() already makes for the plain-text shape
 * (this adapter has always assumed OpenAI-Chat-Completions-compatible wire format; this is that
 * same assumption extended to images, not a new one). If a specific relay doesn't support this,
 * the real HTTP error it returns surfaces via the normal error path — no silent fallback. */
export async function analyzeOpenAICompatibleImage(request: AIImageRequest, overrides?: { apiKey?: string; baseUrl?: string }): Promise<AIProviderResult> {
  const { apiKey, baseUrl } = resolveConfig(overrides);
  if (!apiKey || !baseUrl) throw new Error('CUSTOM_AI_API_KEY or CUSTOM_AI_BASE_URL not set');
  const data = await postJson<OpenAICompatibleChatResponse>(
    joinUrl(baseUrl, '/chat/completions'),
    {
      model: request.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: request.prompt },
          { type: 'image_url', image_url: { url: `data:${request.mimeType};base64,${request.imageBase64}` } },
        ],
      }],
    },
    { Authorization: `Bearer ${apiKey}` },
    [apiKey]
  );
  return {
    rawText: data.choices?.[0]?.message?.content ?? '',
    usage: data.usage
      ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens, totalTokens: data.usage.total_tokens }
      : undefined,
    providerRequestId: data.id,
  };
}
