import { getRoleConfig } from './configStore.js';
import { getConnection, type AIConnection } from './connectionStore.js';

/** Sprint 3.3B.2, Task 15: generic role -> connection resolution, shared by any role that follows
 * the `{connectionId, model}` shape (Product Decision 1's Model Role). Prepares the main-analysis
 * role for connection-based resolution WITHOUT wiring it into /api/ai/analyze yet — that route
 * still takes provider/model directly from the request body (the dev Prompt Preview modal's
 * existing "Send to AI Engine" flow), completely unchanged this sprint. A future sprint's
 * Research -> AI -> Strategy automation is expected to call resolveMainAnalysisConnection()
 * instead of asking the frontend to pass a raw provider string. */

export type RoleResolution =
  | { ok: true; connection: AIConnection; model: string }
  | { ok: false; code: 'role_not_configured' | 'connection_not_found' | 'connection_disabled' | 'connection_not_configured'; message: string };

export function resolveRoleConnection(role: string): RoleResolution {
  const cfg = getRoleConfig(role);
  const connectionId = cfg.connectionId || cfg.provider; // pre-3.3B.2 role records only had `provider`
  if (!connectionId || !cfg.model) {
    return { ok: false, code: 'role_not_configured', message: `角色 "${role}" 尚未配置连接/模型` };
  }
  const connection = getConnection(connectionId);
  if (!connection) {
    return { ok: false, code: 'connection_not_found', message: `角色 "${role}" 引用的连接（${connectionId}）不存在，可能已被删除` };
  }
  if (!connection.enabled) {
    return { ok: false, code: 'connection_disabled', message: `角色 "${role}" 引用的连接"${connection.name}"已被禁用` };
  }
  if (!connection.apiKey) {
    return { ok: false, code: 'connection_not_configured', message: `角色 "${role}" 引用的连接"${connection.name}"未配置 API Key` };
  }
  return { ok: true, connection, model: cfg.model };
}

export function resolveMainAnalysisConnection(): RoleResolution {
  return resolveRoleConnection('main-analysis');
}
