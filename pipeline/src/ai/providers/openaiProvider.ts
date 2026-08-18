import type { AIProvider, AIProviderRequest, AIProviderResult, AIImageRequest } from '../types.js';
import { postJson, joinUrl } from '../providerHttp.js';
import { getEffectiveApiKey, getEffectiveBaseUrl, getEffectiveEnabled, getEffectiveDefaultModel } from '../configStore.js';

/** Real OpenAI Chat Completions API — stable, documented shape. Base URL/key/enabled are resolved
 * through configStore.ts (Settings-file value -> env var -> official default/undefined), added
 * Sprint 3.1B.1 — the AIProvider interface itself (isConfigured/analyze) is unchanged from
 * Sprint 3.1B, only WHERE the values come from changed. */
const PROVIDER_NAME = 'openai';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
interface OpenAIChatResponse {
  id: string;
  choices: { message: { content: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function resolveConfig(overrides?: { apiKey?: string; baseUrl?: string }) {
  const apiKey = overrides?.apiKey || getEffectiveApiKey(PROVIDER_NAME);
  const baseUrl = overrides?.baseUrl || getEffectiveBaseUrl(PROVIDER_NAME, DEFAULT_BASE_URL);
  return { apiKey, baseUrl: baseUrl! };
}

export const openAIProvider: AIProvider = {
  isConfigured() {
    return getEffectiveEnabled(PROVIDER_NAME) && !!getEffectiveApiKey(PROVIDER_NAME);
  },
  async analyze(request: AIProviderRequest, overrides?: { apiKey?: string; baseUrl?: string }): Promise<AIProviderResult> {
    const { apiKey, baseUrl } = resolveConfig(overrides);
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');
    const data = await postJson<OpenAIChatResponse>(
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

/** Sprint 3.1B.1 — Settings page "Test Connection". Separate from analyze() (which never accepts
 * overrides) so an unsaved form value can be tested before committing it via Save, without
 * mutating any shared/global state (no process.env writes, which would race across concurrent
 * requests). Reuses the exact same request shape as analyze(), just with a minimal prompt. */
export async function testOpenAIConnection(overrides: { apiKey?: string; baseUrl?: string; model?: string }): Promise<{ rawText: string }> {
  const { apiKey, baseUrl } = resolveConfig(overrides);
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  const model = overrides.model || getEffectiveDefaultModel(PROVIDER_NAME);
  if (!model) throw new Error('Default Model not set');
  const data = await postJson<OpenAIChatResponse>(
    joinUrl(baseUrl, '/chat/completions'),
    { model, messages: [{ role: 'user', content: 'ping' }] },
    { Authorization: `Bearer ${apiKey}` },
    [apiKey]
  );
  return { rawText: data.choices?.[0]?.message?.content ?? '' };
}

/** Sprint 3.3B: Image Evidence Parser — OpenAI's multimodal message shape (`content` as an array
 * mixing a text part and an `image_url` part with a data: URI), never used by analyze() above,
 * which still sends `content` as a plain string exactly as before. Reuses the same credential
 * resolution and the same postJson() secret-redaction as analyze() — only the request body shape
 * differs. */
export async function analyzeOpenAIImage(request: AIImageRequest, overrides?: { apiKey?: string; baseUrl?: string }): Promise<AIProviderResult> {
  const { apiKey, baseUrl } = resolveConfig(overrides);
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  const data = await postJson<OpenAIChatResponse>(
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
