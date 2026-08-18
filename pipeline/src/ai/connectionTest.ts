import { classifyError, getTimeoutConfig } from './engine.js';
import { getConnection, recordConnectionTestResult } from './connectionStore.js';
import { testOpenAIConnection } from './providers/openaiProvider.js';
import { testAnthropicConnection } from './providers/anthropicProvider.js';
import { testGoogleConnection } from './providers/googleProvider.js';
import { testDeepSeekConnection } from './providers/deepseekProvider.js';
import { testOpenAICompatibleConnection } from './providers/openaiCompatibleProvider.js';
import type { NetworkErrorDiagnostics } from './providerHttp.js';

/** Sprint 3.3B.2: Connection-based twin of configTest.ts's testProviderConnection() — same error
 * classification, same per-type testXConnection() adapter functions, but resolves credentials
 * from a specific AIConnection record (by id) instead of the old global provider-type config.
 * configTest.ts itself is untouched — the old /api/ai/config/:provider/test route still works
 * exactly as before, for backward compatibility. */

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
  /** `diagnostics` — same additive, redacted-allowlist field classifyError() now returns for a
   * network_error (AI Provider Network Diagnostics Hotfix); undefined for every other error code. */
  error?: { code: string; message: string; diagnostics?: NetworkErrorDiagnostics };
}

export async function testConnection(
  connectionId: string,
  overrides: { apiKey?: string; baseUrl?: string; model?: string }
): Promise<TestConnectionResult> {
  const startedMs = Date.now();
  const connection = getConnection(connectionId);
  if (!connection) {
    return { status: 'failed', latencyMs: Date.now() - startedMs, error: { code: 'invalid_request', message: `连接不存在：${connectionId}` } };
  }
  const testFn = TEST_FUNCTIONS[connection.type];
  if (!testFn) {
    const result: TestConnectionResult = { status: 'failed', latencyMs: Date.now() - startedMs, error: { code: 'provider_not_supported', message: `未知连接类型：${connection.type}` } };
    recordConnectionTestResult(connectionId, result);
    return result;
  }

  const resolvedOverrides = {
    apiKey: overrides.apiKey || connection.apiKey,
    baseUrl: overrides.baseUrl || connection.baseUrl,
    model: overrides.model || connection.defaultModel,
  };

  const { timeoutMs } = getTimeoutConfig();
  try {
    await Promise.race([
      testFn(resolvedOverrides),
      new Promise<never>((_, reject) => setTimeout(() => { const e: any = new Error('timeout'); e.timedOut = true; reject(e); }, timeoutMs)),
    ]);
    const result: TestConnectionResult = { status: 'connected', latencyMs: Date.now() - startedMs };
    recordConnectionTestResult(connectionId, result);
    return result;
  } catch (err: any) {
    if (/not set$/.test(err?.message || '')) {
      const result: TestConnectionResult = { status: 'failed', latencyMs: Date.now() - startedMs, error: { code: 'invalid_request', message: err.message } };
      recordConnectionTestResult(connectionId, result);
      return result;
    }
    const classified = classifyError(err, {
      provider: connection.type, model: resolvedOverrides.model, timeoutMs, elapsedMs: Date.now() - startedMs,
    });
    const result: TestConnectionResult = { status: 'failed', latencyMs: Date.now() - startedMs, error: classified };
    recordConnectionTestResult(connectionId, result);
    return result;
  }
}
