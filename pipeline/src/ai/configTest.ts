import { classifyError, getTimeoutConfig } from './engine.js';
import { recordTestResult, getEffectiveDefaultModel } from './configStore.js';
import { testOpenAIConnection } from './providers/openaiProvider.js';
import { testAnthropicConnection } from './providers/anthropicProvider.js';
import { testGoogleConnection } from './providers/googleProvider.js';
import { testDeepSeekConnection } from './providers/deepseekProvider.js';
import { testOpenAICompatibleConnection } from './providers/openaiCompatibleProvider.js';

/** Sprint 3.1B.1: Settings page "Test Connection". Deliberately separate from engine.ts's
 * runAIAnalysis() — that function is the existing, unmodified /api/ai/analyze path; this is new,
 * additive orchestration for the new Settings-page-only test action. Reuses the SAME error
 * classification (classifyError) and each provider's real request-building code (via each
 * adapter's testXConnection export), just with a minimal "ping" prompt and no persistence of the
 * result into qa_ai_raw_results (test results are recorded separately, see configStore.ts). */

type TestFn = (overrides: { apiKey?: string; baseUrl?: string; model?: string }) => Promise<{ rawText: string }>;

const TEST_FUNCTIONS: Record<string, TestFn> = {
  openai: testOpenAIConnection,
  anthropic: testAnthropicConnection,
  google: testGoogleConnection,
  deepseek: testDeepSeekConnection,
  'openai-compatible': testOpenAICompatibleConnection,
};

export interface TestConnectionResult {
  status: 'connected' | 'failed';
  latencyMs: number;
  error?: { code: string; message: string };
}

export async function testProviderConnection(
  provider: string,
  overrides: { apiKey?: string; baseUrl?: string; model?: string }
): Promise<TestConnectionResult> {
  const startedMs = Date.now();
  const testFn = TEST_FUNCTIONS[provider];
  if (!testFn) {
    const result: TestConnectionResult = { status: 'failed', latencyMs: Date.now() - startedMs, error: { code: 'provider_not_supported', message: `未知 provider：${provider}` } };
    recordTestResult(provider, result);
    return result;
  }

  const { timeoutMs } = getTimeoutConfig();
  try {
    await Promise.race([
      testFn(overrides),
      new Promise<never>((_, reject) => setTimeout(() => { const e: any = new Error('timeout'); e.timedOut = true; reject(e); }, timeoutMs)),
    ]);
    const result: TestConnectionResult = { status: 'connected', latencyMs: Date.now() - startedMs };
    recordTestResult(provider, result);
    return result;
  } catch (err: any) {
    // "Default Model not set" / "*_API_KEY or *_BASE_URL not set" thrown directly by the adapter
    // (no HTTP request attempted at all) — classifyError's HTTP-status-based logic would
    // misclassify these as network_error, so they get their own explicit code first.
    if (/not set$/.test(err?.message || '')) {
      const result: TestConnectionResult = { status: 'failed', latencyMs: Date.now() - startedMs, error: { code: 'invalid_request', message: err.message } };
      recordTestResult(provider, result);
      return result;
    }
    // Same diagnostics context as runAIAnalysis() (2026-08-08) — model falls back to the stored
    // default the same way the adapters themselves resolve it, since a Test Connection call often
    // doesn't pass one explicitly (testing the saved config, not a draft edit).
    const classified = classifyError(err, {
      provider, model: overrides.model || getEffectiveDefaultModel(provider), timeoutMs, elapsedMs: Date.now() - startedMs,
    });
    const result: TestConnectionResult = { status: 'failed', latencyMs: Date.now() - startedMs, error: classified };
    recordTestResult(provider, result);
    return result;
  }
}
