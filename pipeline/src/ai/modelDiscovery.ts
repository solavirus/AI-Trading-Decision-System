import { joinUrl } from './providerHttp.js';
import type { ConnectionType } from './connectionStore.js';

/** Sprint 3.3B.2, Task 6: model discovery is per-CONNECTION (its own baseUrl/apiKey), never a
 * global provider-type catalog — nothing here is hardcoded to a fixed model list. Only
 * 'openai-compatible' is implemented, per the task's explicit scope ("For OpenAI-Compatible
 * connections, support: GET {baseUrl}/models"); every other connection type falls through to
 * `supported:false`, telling the frontend to fall back to manual model entry rather than pretend
 * discovery happened. Never surfaces the raw response body on failure — only a fixed, safe message
 * plus the HTTP status — so a relay that echoes headers/config in an error page can't leak
 * anything through this endpoint (deliberately more conservative than postJson()'s redaction
 * approach, since this endpoint has no legitimate reason to show provider-authored text at all). */

export interface DiscoveredModel {
  id: string;
}
export type ModelDiscoveryResult =
  | { ok: true; supported: true; models: DiscoveredModel[] }
  | { ok: true; supported: false } // discovery not implemented for this connection type — use manual entry
  | { ok: false; error: { message: string } };

export async function discoverModels(type: ConnectionType, baseUrl: string | undefined, apiKey: string | undefined): Promise<ModelDiscoveryResult> {
  if (type !== 'openai-compatible' && type !== 'openai') {
    return { ok: true, supported: false };
  }
  const effectiveBaseUrl = baseUrl || (type === 'openai' ? 'https://api.openai.com/v1' : undefined);
  if (!effectiveBaseUrl || !apiKey) {
    return { ok: false, error: { message: '缺少 Base URL 或 API Key，无法查询模型列表' } };
  }
  try {
    const res = await fetch(joinUrl(effectiveBaseUrl, '/models'), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      return { ok: false, error: { message: `无法从该连接获取模型列表（HTTP ${res.status}），可手动输入 Model 名称` } };
    }
    const json: any = await res.json();
    const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : null;
    if (!list) {
      return { ok: false, error: { message: '该连接返回的模型列表格式无法识别，可手动输入 Model 名称' } };
    }
    const models: DiscoveredModel[] = list
      .map((m: any) => ({ id: typeof m === 'string' ? m : m?.id }))
      .filter((m: DiscoveredModel) => typeof m.id === 'string' && m.id);
    return { ok: true, supported: true, models };
  } catch {
    // Never include err.message here — for a fetch-level failure (DNS/connection) it can embed the
    // URL/host in ways that aren't secret but aren't useful either; a fixed message is simpler and
    // strictly safer for an endpoint with no need to show provider-authored text.
    return { ok: false, error: { message: '无法连接到该连接的 Base URL，可手动输入 Model 名称' } };
  }
}
