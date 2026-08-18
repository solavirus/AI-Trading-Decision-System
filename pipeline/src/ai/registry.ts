import type { AIProvider } from './types.js';
import { openAIProvider } from './providers/openaiProvider.js';
import { anthropicProvider } from './providers/anthropicProvider.js';
import { googleProvider } from './providers/googleProvider.js';
import { deepseekProvider } from './providers/deepseekProvider.js';
import { openAICompatibleProvider } from './providers/openaiCompatibleProvider.js';

/** Single resolution point for "provider name" -> adapter. The engine looks up here instead of
 * an if/else chain, so adding another provider later is "write one adapter file, add one line
 * here" — nothing else in the engine or frontend needs to change. `openai-compatible` is a
 * generic 5th entry for third-party relay/gateway services, added alongside the 4 official
 * adapters — none of the existing 4 were replaced or had their request/response logic changed. */
export const PROVIDERS: Record<string, AIProvider> = {
  openai: openAIProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
  deepseek: deepseekProvider,
  'openai-compatible': openAICompatibleProvider,
};

export function resolveProvider(name: string): AIProvider | undefined {
  return PROVIDERS[name];
}
