import type { AIProvider, AIProviderRequest, AIProviderResult } from '../types.js';
import { postJson, joinUrl } from '../providerHttp.js';
import { getEffectiveApiKey, getEffectiveBaseUrl, getEffectiveEnabled, getEffectiveDefaultModel } from '../configStore.js';

/** Real DeepSeek API — deliberately OpenAI-Chat-Completions-compatible per DeepSeek's own public
 * docs, so the request/response shape mirrors openaiProvider.ts. Base URL/key/enabled resolved
 * through configStore.ts (Sprint 3.1B.1); AIProvider interface unchanged from Sprint 3.1B. */
const PROVIDER_NAME = 'deepseek';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
interface DeepSeekChatResponse {
  id: string;
  choices: { message: { content: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function resolveConfig(overrides?: { apiKey?: string; baseUrl?: string }) {
  const apiKey = overrides?.apiKey || getEffectiveApiKey(PROVIDER_NAME);
  const baseUrl = overrides?.baseUrl || getEffectiveBaseUrl(PROVIDER_NAME, DEFAULT_BASE_URL);
  return { apiKey, baseUrl: baseUrl! };
}

export const deepseekProvider: AIProvider = {
  isConfigured() {
    return getEffectiveEnabled(PROVIDER_NAME) && !!getEffectiveApiKey(PROVIDER_NAME);
  },
  async analyze(request: AIProviderRequest, overrides?: { apiKey?: string; baseUrl?: string }): Promise<AIProviderResult> {
    const { apiKey, baseUrl } = resolveConfig(overrides);
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');
    const data = await postJson<DeepSeekChatResponse>(
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
 * rationale (override-aware, no shared/global mutation). */
export async function testDeepSeekConnection(overrides: { apiKey?: string; baseUrl?: string; model?: string }): Promise<{ rawText: string }> {
  const { apiKey, baseUrl } = resolveConfig(overrides);
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');
  const model = overrides.model || getEffectiveDefaultModel(PROVIDER_NAME);
  if (!model) throw new Error('Default Model not set');
  const data = await postJson<DeepSeekChatResponse>(
    joinUrl(baseUrl, '/chat/completions'),
    { model, messages: [{ role: 'user', content: 'ping' }] },
    { Authorization: `Bearer ${apiKey}` },
    [apiKey]
  );
  return { rawText: data.choices?.[0]?.message?.content ?? '' };
}
