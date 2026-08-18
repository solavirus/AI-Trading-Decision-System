import type { AIProvider, AIProviderRequest, AIProviderResult, AIImageRequest } from '../types.js';
import { postJson, joinUrl } from '../providerHttp.js';
import { getEffectiveApiKey, getEffectiveBaseUrl, getEffectiveEnabled, getEffectiveDefaultModel } from '../configStore.js';

/** Real Anthropic Messages API — stable, documented shape. Base URL/key/enabled resolved through
 * configStore.ts (Sprint 3.1B.1); AIProvider interface unchanged from Sprint 3.1B. max_tokens is
 * required by this API and has no universal default; 4096 is a reasonable, generous ceiling for a
 * strategy-analysis reply. */
const PROVIDER_NAME = 'anthropic';
const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicMessagesResponse {
  id: string;
  content: { type: string; text?: string }[];
  usage?: { input_tokens: number; output_tokens: number };
}

function resolveConfig(overrides?: { apiKey?: string; baseUrl?: string }) {
  const apiKey = overrides?.apiKey || getEffectiveApiKey(PROVIDER_NAME);
  const baseUrl = overrides?.baseUrl || getEffectiveBaseUrl(PROVIDER_NAME, DEFAULT_BASE_URL);
  return { apiKey, baseUrl: baseUrl! };
}

export const anthropicProvider: AIProvider = {
  isConfigured() {
    return getEffectiveEnabled(PROVIDER_NAME) && !!getEffectiveApiKey(PROVIDER_NAME);
  },
  async analyze(request: AIProviderRequest, overrides?: { apiKey?: string; baseUrl?: string }): Promise<AIProviderResult> {
    const { apiKey, baseUrl } = resolveConfig(overrides);
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    const data = await postJson<AnthropicMessagesResponse>(
      joinUrl(baseUrl, '/messages'),
      { model: request.model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: request.prompt }] },
      { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      [apiKey], request.signal
    );
    const text = data.content?.find((c) => c.type === 'text')?.text ?? '';
    return {
      rawText: text,
      usage: data.usage
        ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens, totalTokens: data.usage.input_tokens + data.usage.output_tokens }
        : undefined,
      providerRequestId: data.id,
    };
  },
};

/** Sprint 3.1B.1 — Settings page "Test Connection", see openaiProvider.ts's twin for the full
 * rationale (override-aware, no shared/global mutation). */
export async function testAnthropicConnection(overrides: { apiKey?: string; baseUrl?: string; model?: string }): Promise<{ rawText: string }> {
  const { apiKey, baseUrl } = resolveConfig(overrides);
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const model = overrides.model || getEffectiveDefaultModel(PROVIDER_NAME);
  if (!model) throw new Error('Default Model not set');
  const data = await postJson<AnthropicMessagesResponse>(
    joinUrl(baseUrl, '/messages'),
    { model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] },
    { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    [apiKey]
  );
  const text = data.content?.find((c) => c.type === 'text')?.text ?? '';
  return { rawText: text };
}

/** Sprint 3.3B: Image Evidence Parser — Anthropic's multimodal content-block shape (`image` block
 * with base64 `source`), never used by analyze() above, which still sends plain string content
 * exactly as before. */
export async function analyzeAnthropicImage(request: AIImageRequest, overrides?: { apiKey?: string; baseUrl?: string }): Promise<AIProviderResult> {
  const { apiKey, baseUrl } = resolveConfig(overrides);
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const data = await postJson<AnthropicMessagesResponse>(
    joinUrl(baseUrl, '/messages'),
    {
      model: request.model, max_tokens: MAX_TOKENS,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: request.prompt },
          { type: 'image', source: { type: 'base64', media_type: request.mimeType, data: request.imageBase64 } },
        ],
      }],
    },
    { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    [apiKey]
  );
  const text = data.content?.find((c) => c.type === 'text')?.text ?? '';
  return {
    rawText: text,
    usage: data.usage
      ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens, totalTokens: data.usage.input_tokens + data.usage.output_tokens }
      : undefined,
    providerRequestId: data.id,
  };
}
