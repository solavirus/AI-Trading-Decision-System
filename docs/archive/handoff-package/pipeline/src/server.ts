import { createServer } from 'node:http';
import { loadEnvFile } from './util/env.js';
loadEnvFile();

import type { SourceKey, SourceResult } from './types.js';
import { FETCHERS } from './fetchers.js';
import { fetchGlobalMarketCap } from './sources/market.js';
import { getMarketDetail } from './sources/marketDetail.js';
import { getLiquidationDetail } from './sources/liquidationDetail.js';
import { startLiquidationCollector } from './collectors/liquidationCollector.js';
import {
  listNewsSources, getNewsSource, insertNewsSource, updateNewsSource, deleteNewsSource,
  updateNewsSourceFetchStatus, seedNewsSourcesIfEmpty, type NewsSourceRow,
} from './db.js';
import {
  BUILTIN_SEED as NEWS_BUILTIN_SEED, isSourceFetchable, fetchArticlesForSource,
} from './sources/news.js';
import { validateAIAnalyzeRequest, runAIAnalysis, getTimeoutConfig } from './ai/engine.js';
import { testProviderConnection } from './ai/configTest.js';
import { getAllStoredConfig, saveProviderConfig, maskApiKey, getEffectiveEnabled, getRoleConfig, saveRoleConfig } from './ai/configStore.js';
import { PROVIDERS } from './ai/registry.js';
import { runEvidenceImageParse, providerSupportsImageInput } from './ai/evidenceParser.js';
import {
  listConnections, getConnection, createConnection, updateConnection, deleteConnection,
  toSafeConnectionView, type ConnectionType,
} from './ai/connectionStore.js';
import { testConnection } from './ai/connectionTest.js';
import { discoverModels } from './ai/modelDiscovery.js';
import {
  listExchangeConnections, createExchangeConnection, updateExchangeConnection,
  deleteExchangeConnection, toSafeExchangeConnectionView,
} from './exchange/exchangeConnectionStore.js';
import {
  testExchangeConnection, fetchExchangeAccountSnapshot, fetchExchangeOrderSnapshot, submitEntryOrderToBinanceTestnet, cancelEntryOrderOnBinanceTestnet,
  submitProtectionOrderToBinanceTestnet, cancelProtectionOrderOnBinanceTestnet, fetchProtectionOrderSnapshot,
  fetchOpenOrders, changeLeverageOnBinanceTestnet, resolveAccountStreamCredentials, subscribeAccountEventStream,
} from './exchange/exchangeService.js';
import type { ExchangeType, ExchangeEnvironment } from './exchange/types.js';

const PORT = Number(process.env.PORT) || 8787;
const CACHE_TTL_MS = 20_000;

/** Sprint 3.6A, Task 33 — makes backend staleness (old tsx process still running after a source edit)
 * detectable without manually comparing `Get-Process` start time against file mtimes by hand, a
 * recurring real problem this session. `startedAt` is captured once at module load (this exact
 * process's actual start moment); `runtimeVersion` is a monotonically-increasing marker bumped by
 * hand alongside real backend changes — not a semantic-version claim, just "did this process load
 * code newer than commit-marker N." */
const RUNTIME_VERSION = 'r3.6a-1';
const STARTED_AT = new Date().toISOString();

const cache = new Map<SourceKey, { data: SourceResult; at: number }>();
const inflight = new Map<SourceKey, Promise<SourceResult>>();

let marketCapCache: { data: { totalUsd: number; changePct24h: number }; at: number } | null = null;
async function getGlobalMarketCap() {
  if (marketCapCache && Date.now() - marketCapCache.at < CACHE_TTL_MS) return marketCapCache.data;
  const data = await fetchGlobalMarketCap();
  marketCapCache = { data, at: Date.now() };
  return data;
}

/** `fresh: true` (Sprint 3.2B — Analysis Runner) bypasses only the cache READ, so a caller that
 * genuinely needs a request issued after this exact moment (the frozen Analysis Snapshot Integrity
 * decision's "every source must perform a fresh request" rule) can't be served data Dashboard's own
 * polling happened to cache seconds ago. Still writes the result to the shared cache afterward (so
 * Dashboard benefits from the freshly-fetched data too) and still coalesces onto an already-inflight
 * request for the same key — this only ever skips the "was it fetched recently enough" check, never
 * duplicates an upstream call that's already in progress. Omitting the option (every existing
 * caller) is byte-for-byte the same behavior as before this change. */
async function getSource(key: SourceKey, opts?: { fresh?: boolean }): Promise<SourceResult> {
  if (!opts?.fresh) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;
  }
  // Coalesce concurrent requests for the same key instead of firing duplicate upstream calls.
  let promise = inflight.get(key);
  if (!promise) {
    promise = FETCHERS[key]()
      .then((data) => { cache.set(key, { data, at: Date.now() }); return data; })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
  }
  return promise;
}

/** The prototype's ASSETS array needs plain {symbol, price, changePct} to drive prices used
 * throughout the trading workflow (not just the dashboard card) — parsed back out of market's
 * display-formatted RawItem.value ("64,358.70 (+1.50%)") rather than duplicating the fetch. */
function parsePrices(marketResult: SourceResult): { symbol: string; price: number; changePct: number }[] {
  const out: { symbol: string; price: number; changePct: number }[] = [];
  for (const item of marketResult.itemsRaw) {
    const m = item.value.match(/^([\d,]+\.?\d*)\s*\(([+-]?[\d.]+)%\)/);
    if (!m) continue;
    out.push({ symbol: item.label, price: parseFloat(m[1].replace(/,/g, '')), changePct: parseFloat(m[2]) });
  }
  return out;
}

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: import('node:http').IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve(null);
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function serializeSource(row: NewsSourceRow) {
  return { ...row, enabled: !!row.enabled, fetchable: isSourceFetchable(row.type, row.url) };
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true, uptime: process.uptime(), startedAt: STARTED_AT, runtimeVersion: RUNTIME_VERSION });

    if (url.pathname === '/api/sources') {
      const keys = Object.keys(FETCHERS) as SourceKey[];
      const entries = await Promise.all(
        keys.map(async (k) => [k, await getSource(k).catch((e) => ({ key: k, status: 'error', fetchedAt: Date.now(), itemsRaw: [], note: e.message }))] as const)
      );
      return sendJson(res, 200, Object.fromEntries(entries));
    }

    if (url.pathname === '/api/prices') {
      const market = await getSource('market');
      return sendJson(res, 200, parsePrices(market));
    }

    if (url.pathname === '/api/marketcap') {
      try {
        return sendJson(res, 200, await getGlobalMarketCap());
      } catch (err: any) {
        return sendJson(res, 502, { error: err.message });
      }
    }

    if (url.pathname === '/api/market/detail') {
      const symbol = url.searchParams.get('symbol');
      const interval = url.searchParams.get('interval') || '1h';
      const limit = Number(url.searchParams.get('limit')) || 100;
      if (!symbol) return sendJson(res, 400, { error: 'missing ?symbol=' });
      try {
        return sendJson(res, 200, await getMarketDetail(symbol, interval, limit));
      } catch (err: any) {
        return sendJson(res, 502, { error: err.message });
      }
    }

    if (url.pathname === '/api/liquidation/detail') {
      return sendJson(res, 200, getLiquidationDetail());
    }

    /** 新闻源管理 — real CRUD backed by SQLite (news_sources table, db.ts), replacing the old
     * frontend localStorage config. Every action the modal offers (list/add/edit/delete/toggle)
     * genuinely persists here; sources/news.ts's fetchNews() reads straight from this table. */
    if (url.pathname === '/api/news-sources') {
      seedNewsSourcesIfEmpty(NEWS_BUILTIN_SEED);
      if (req.method === 'GET') {
        return sendJson(res, 200, { ok: true, sources: listNewsSources().map(serializeSource) });
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body || typeof body.name !== 'string' || !body.name.trim()) return sendJson(res, 400, { ok: false, error: '缺少 name' });
        const type = body.type;
        if (!['rss', 'official', 'api', 'scrape'].includes(type)) return sendJson(res, 400, { ok: false, error: '非法 type' });
        // Real reachability test before persisting, for anything genuinely fetchable — rss/
        // official always, api only when the url matches a known exchange adapter (see
        // sources/news.ts's isSourceFetchable). Everything else has no fetcher yet, so it's just
        // stored as-is (never fake-tested).
        let testedCount: number | undefined;
        if (isSourceFetchable(type, body.url)) {
          if (!body.url) return sendJson(res, 400, { ok: false, error: '该类型需要提供地址' });
          try {
            const items = await fetchArticlesForSource(body.url);
            if (items.length === 0) return sendJson(res, 200, { ok: false, error: '地址可访问，但没有解析到任何新闻条目' });
            testedCount = items.length;
          } catch (err: any) {
            return sendJson(res, 200, { ok: false, error: `地址不可访问：${err.message}` });
          }
        }
        const row = insertNewsSource({
          name: body.name.trim(), url: body.url || null, type, category: body.category || null,
          enabled: body.enabled !== false,
          fetch_interval_minutes: Number(body.fetch_interval_minutes) || 15,
          lookback_hours: Number(body.lookback_hours) || 24,
        });
        if (testedCount !== undefined) updateNewsSourceFetchStatus(row.id, { fetchedAt: Date.now(), status: 'ok', itemCount: testedCount });
        return sendJson(res, 200, { ok: true, source: serializeSource(getNewsSource(row.id)!) });
      }
      return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }

    /** 新闻源管理 "测试并保存" — a genuine reachability/format test (fetch + parse), not a faked
     * success, per this project's standing "never fake data" rule. Routes through a known
     * exchange adapter when the url matches one (Binance/OKX/Bybit), otherwise the generic RSS
     * parser. Standalone pre-add validation; POST /api/news-sources does the same real test
     * again at persist time. */
    if (url.pathname === '/api/news-sources/test') {
      const feedUrl = url.searchParams.get('url');
      if (!feedUrl) return sendJson(res, 400, { ok: false, error: '缺少 ?url=' });
      try {
        const items = await fetchArticlesForSource(feedUrl);
        if (items.length === 0) return sendJson(res, 200, { ok: false, error: '地址可访问，但没有解析到任何新闻条目' });
        return sendJson(res, 200, {
          ok: true,
          count: items.length,
          sample: items.slice(0, 3).map((i) => ({ title: i.title, pubDate: i.pubDate })),
        });
      } catch (err: any) {
        return sendJson(res, 200, { ok: false, error: `地址不可访问：${err.message}` });
      }
    }

    const nsIdMatch = url.pathname.match(/^\/api\/news-sources\/([\w-]+)$/);
    if (nsIdMatch) {
      const id = nsIdMatch[1];
      if (req.method === 'PATCH') {
        const existing = getNewsSource(id);
        if (!existing) return sendJson(res, 404, { ok: false, error: 'not found' });
        const body = await readJsonBody(req);
        // "测试并保存" applies on edit too, same as add — but only when the wizard actually
        // submits url/type (a plain enabled-toggle PATCH from the table's switch shouldn't pay a
        // network round-trip just to flip a boolean).
        const touchesFetchTarget = !!body && (body.url !== undefined || body.type !== undefined);
        const nextType = body?.type ?? existing.type;
        const nextUrl = body?.url !== undefined ? body.url : existing.url;
        let testedCount: number | undefined;
        if (touchesFetchTarget && isSourceFetchable(nextType, nextUrl)) {
          if (!nextUrl) return sendJson(res, 400, { ok: false, error: '该类型需要提供地址' });
          try {
            const items = await fetchArticlesForSource(nextUrl);
            if (items.length === 0) return sendJson(res, 200, { ok: false, error: '地址可访问，但没有解析到任何新闻条目' });
            testedCount = items.length;
          } catch (err: any) {
            return sendJson(res, 200, { ok: false, error: `地址不可访问：${err.message}` });
          }
        }
        const row = updateNewsSource(id, body || {});
        if (!row) return sendJson(res, 404, { ok: false, error: 'not found' });
        if (testedCount !== undefined) updateNewsSourceFetchStatus(row.id, { fetchedAt: Date.now(), status: 'ok', itemCount: testedCount });
        return sendJson(res, 200, { ok: true, source: serializeSource(getNewsSource(row.id)!) });
      }
      if (req.method === 'DELETE') {
        const removed = deleteNewsSource(id);
        if (!removed) return sendJson(res, 404, { ok: false, error: 'not found' });
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }

    /** Sprint 3.1B: Multi-Model AI Engine Foundation. Never accepts an API key from the request
     * body — AIAnalyzeRequest has no such field, and validateAIAnalyzeRequest() only reads the 6
     * whitelisted fields, so anything else the client sends is simply never looked at. Keys live
     * only in this process's own env vars (see ai/providers/*.ts). Stops at the raw provider
     * response (AIRawResult) — no parsing against AI_RESPONSE_SPEC.md, no Strategy wiring, that's
     * Sprint 3.1C. */
    if (url.pathname === '/api/ai/analyze') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const body = await readJsonBody(req);
      const validation = validateAIAnalyzeRequest(body);
      if (!validation.ok) return sendJson(res, 400, { ok: false, error: validation.error });
      const result = await runAIAnalysis(validation.value!);
      return sendJson(res, 200, { ok: true, result });
    }

    /** Sprint 3.1B.1: AI Connections Settings page backend. Every response below is built through
     * maskApiKey() — the real stored key is NEVER included in any response body. Config is a JSON
     * file (configStore.ts), not a database, gitignored the same way .env already is. */
    if (url.pathname === '/api/ai/config') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const stored = getAllStoredConfig();
      const providers: Record<string, any> = {};
      for (const name of Object.keys(PROVIDERS)) {
        const cfg = stored[name] || {};
        providers[name] = {
          enabled: getEffectiveEnabled(name),
          baseUrl: cfg.baseUrl || '',
          defaultModel: cfg.defaultModel || '',
          hasApiKey: !!cfg.apiKey,
          apiKeyMasked: maskApiKey(cfg.apiKey),
          lastTestAt: cfg.lastTestAt || null,
          lastTestStatus: cfg.lastTestStatus || null,
          lastTestError: cfg.lastTestError || null,
        };
      }
      return sendJson(res, 200, { ok: true, providers });
    }

    const configMatch = url.pathname.match(/^\/api\/ai\/config\/([a-z-]+)$/);
    if (configMatch) {
      const provider = configMatch[1];
      if (!PROVIDERS[provider]) return sendJson(res, 404, { ok: false, error: `未知 provider：${provider}` });
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体格式不正确' });
      const patch: { enabled?: boolean; baseUrl?: string; defaultModel?: string; apiKey?: string } = {};
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (typeof body.baseUrl === 'string') patch.baseUrl = body.baseUrl.trim();
      if (typeof body.defaultModel === 'string') patch.defaultModel = body.defaultModel.trim();
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) patch.apiKey = body.apiKey.trim();
      const saved = saveProviderConfig(provider, patch);
      return sendJson(res, 200, {
        ok: true,
        config: {
          enabled: getEffectiveEnabled(provider),
          baseUrl: saved.baseUrl || '',
          defaultModel: saved.defaultModel || '',
          hasApiKey: !!saved.apiKey,
          apiKeyMasked: maskApiKey(saved.apiKey),
        },
      });
    }

    const testMatch = url.pathname.match(/^\/api\/ai\/config\/([a-z-]+)\/test$/);
    if (testMatch) {
      const provider = testMatch[1];
      if (!PROVIDERS[provider]) return sendJson(res, 404, { ok: false, error: `未知 provider：${provider}` });
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const body = (await readJsonBody(req)) || {};
      const overrides: { apiKey?: string; baseUrl?: string; model?: string } = {};
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) overrides.apiKey = body.apiKey.trim();
      if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) overrides.baseUrl = body.baseUrl.trim();
      if (typeof body.model === 'string' && body.model.trim()) overrides.model = body.model.trim();
      const result = await testProviderConnection(provider, overrides);
      return sendJson(res, 200, { ok: true, result });
    }

    /** Sprint 3.3B.2: Model Role config — generic over role name (Task 4: at minimum main-analysis
     * and evidence-parser). Stores {connectionId, model} — a POINTER at a connection, never a
     * second copy of credentials. No apiKey field exists on this endpoint at all. Replaces the old
     * provider-keyed /api/ai/roles/evidence-parser shape ({provider,model}) — configStore.ts's
     * RoleConfig still reads a legacy `.provider`-only record as a fallback connectionId, so an
     * evidence-parser role saved before this sprint keeps working without a manual re-save. */
    const roleMatch = url.pathname.match(/^\/api\/ai\/roles\/([a-z-]+)$/);
    if (roleMatch) {
      const role = roleMatch[1];
      const KNOWN_ROLES = ['main-analysis', 'evidence-parser'];
      if (!KNOWN_ROLES.includes(role)) return sendJson(res, 404, { ok: false, error: `未知角色：${role}` });
      if (req.method === 'GET') {
        const cfg = getRoleConfig(role);
        return sendJson(res, 200, { ok: true, role: { connectionId: cfg.connectionId || cfg.provider || '', model: cfg.model || '' } });
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体格式不正确' });
        const connectionId = typeof body.connectionId === 'string' ? body.connectionId.trim() : undefined;
        const model = typeof body.model === 'string' ? body.model.trim() : undefined;
        if (connectionId) {
          const connection = getConnection(connectionId);
          if (!connection) return sendJson(res, 400, { ok: false, error: { code: 'connection_not_found', message: `连接不存在：${connectionId}` } });
          if (role === 'evidence-parser' && !providerSupportsImageInput(connection.type)) {
            return sendJson(res, 400, { ok: false, error: { code: 'evidence_model_not_multimodal', message: `连接类型 ${connection.type} 不支持图片输入` } });
          }
        }
        const saved = saveRoleConfig(role, { connectionId, model });
        return sendJson(res, 200, { ok: true, role: { connectionId: saved.connectionId || '', model: saved.model || '' } });
      }
      return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }

    /** Sprint 3.3B.2, Task 3: Connection CRUD — the smallest backend API needed to manage multiple
     * AI gateway/relay connections. Every response is built through toSafeConnectionView() —
     * apiKey is NEVER included, only apiKeyMasked/hasApiKey, same masking contract as the legacy
     * /api/ai/config endpoints. */
    if (url.pathname === '/api/ai/connections') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { ok: true, connections: listConnections().map(toSafeConnectionView) });
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体格式不正确' });
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const type = typeof body.type === 'string' ? body.type : '';
        const VALID_TYPES: ConnectionType[] = ['openai-compatible', 'openai', 'anthropic', 'google', 'deepseek'];
        if (!name) return sendJson(res, 400, { ok: false, error: '缺少连接名称' });
        if (!VALID_TYPES.includes(type as ConnectionType)) return sendJson(res, 400, { ok: false, error: `未知连接类型：${type}` });
        const conn = createConnection({
          name, type: type as ConnectionType,
          baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl.trim() : undefined,
          apiKey: typeof body.apiKey === 'string' ? body.apiKey.trim() : undefined,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
          defaultModel: typeof body.defaultModel === 'string' ? body.defaultModel.trim() : undefined,
        });
        return sendJson(res, 200, { ok: true, connection: toSafeConnectionView(conn) });
      }
      return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }

    const connTestMatch = url.pathname.match(/^\/api\/ai\/connections\/([^/]+)\/test$/);
    if (connTestMatch) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const body = (await readJsonBody(req)) || {};
      const overrides: { apiKey?: string; baseUrl?: string; model?: string } = {};
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) overrides.apiKey = body.apiKey.trim();
      if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) overrides.baseUrl = body.baseUrl.trim();
      if (typeof body.model === 'string' && body.model.trim()) overrides.model = body.model.trim();
      const result = await testConnection(connTestMatch[1], overrides);
      return sendJson(res, 200, { ok: true, result });
    }

    const connModelsMatch = url.pathname.match(/^\/api\/ai\/connections\/([^/]+)\/models$/);
    if (connModelsMatch) {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const connection = getConnection(connModelsMatch[1]);
      if (!connection) return sendJson(res, 404, { ok: false, error: '连接不存在' });
      const result = await discoverModels(connection.type, connection.baseUrl, connection.apiKey);
      if (!result.ok) return sendJson(res, 200, { ok: false, error: result.error });
      if (!result.supported) return sendJson(res, 200, { ok: true, supported: false, models: [] });
      return sendJson(res, 200, { ok: true, supported: true, models: result.models });
    }

    const connIdMatch = url.pathname.match(/^\/api\/ai\/connections\/([^/]+)$/);
    if (connIdMatch) {
      const id = connIdMatch[1];
      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体格式不正确' });
        const patch: { name?: string; type?: ConnectionType; baseUrl?: string; apiKey?: string; enabled?: boolean; defaultModel?: string } = {};
        if (typeof body.name === 'string') patch.name = body.name.trim();
        if (typeof body.type === 'string') patch.type = body.type as ConnectionType;
        if (typeof body.baseUrl === 'string') patch.baseUrl = body.baseUrl.trim();
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
        if (typeof body.defaultModel === 'string') patch.defaultModel = body.defaultModel.trim();
        if (typeof body.apiKey === 'string' && body.apiKey.trim()) patch.apiKey = body.apiKey.trim();
        const updated = updateConnection(id, patch);
        if (!updated) return sendJson(res, 404, { ok: false, error: '连接不存在' });
        return sendJson(res, 200, { ok: true, connection: toSafeConnectionView(updated) });
      }
      if (req.method === 'DELETE') {
        const findReferencingRole = (connectionId: string): string | null => {
          for (const role of ['main-analysis', 'evidence-parser']) {
            const cfg = getRoleConfig(role);
            if ((cfg.connectionId || cfg.provider) === connectionId) return role;
          }
          return null;
        };
        const result = deleteConnection(id, findReferencingRole);
        if (!result.ok) return sendJson(res, 409, { ok: false, error: result.reason });
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }

    /** Sprint 3.5B — Exchange Connections. STRICTLY READ-ONLY: this route group's entire surface is
     * CRUD on connection metadata + "test" (one signed read-only account call, no order) + "account"
     * (a normalized read-only snapshot). There is deliberately no order/cancel/amend/leverage/
     * transfer route anywhere — see exchange/binanceFuturesAdapter.ts's own header comment for why.
     * Every response is built through toSafeExchangeConnectionView() — apiSecret is NEVER included
     * in any response, apiKey only ever as apiKeyMasked, same masking discipline as AI Connections
     * above. */
    if (url.pathname === '/api/exchange/connections') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { ok: true, connections: listExchangeConnections().map(toSafeExchangeConnectionView) });
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体格式不正确' });
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const exchange = typeof body.exchange === 'string' ? body.exchange : '';
        const environment = typeof body.environment === 'string' ? body.environment : '';
        const VALID_EXCHANGES: ExchangeType[] = ['binance-futures'];
        const VALID_ENVIRONMENTS: ExchangeEnvironment[] = ['LIVE', 'TESTNET'];
        if (!name) return sendJson(res, 400, { ok: false, error: '缺少连接名称' });
        if (!VALID_EXCHANGES.includes(exchange as ExchangeType)) return sendJson(res, 400, { ok: false, error: `未知交易所类型：${exchange}` });
        if (!VALID_ENVIRONMENTS.includes(environment as ExchangeEnvironment)) return sendJson(res, 400, { ok: false, error: `未知环境：${environment}` });
        const conn = createExchangeConnection({
          name, exchange: exchange as ExchangeType, environment: environment as ExchangeEnvironment,
          apiKey: typeof body.apiKey === 'string' ? body.apiKey.trim() : undefined,
          apiSecret: typeof body.apiSecret === 'string' ? body.apiSecret.trim() : undefined,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
        });
        return sendJson(res, 200, { ok: true, connection: toSafeExchangeConnectionView(conn) });
      }
      return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }

    const exchTestMatch = url.pathname.match(/^\/api\/exchange\/connections\/([^/]+)\/test$/);
    if (exchTestMatch) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const result = await testExchangeConnection(exchTestMatch[1]);
      return sendJson(res, 200, { ok: true, result });
    }

    const exchAccountMatch = url.pathname.match(/^\/api\/exchange\/connections\/([^/]+)\/account$/);
    if (exchAccountMatch) {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const result = await fetchExchangeAccountSnapshot(exchAccountMatch[1]);
      if (!result.ok) return sendJson(res, 200, { ok: false, error: result.error });
      return sendJson(res, 200, { ok: true, snapshot: result.snapshot });
    }

    /** Sprint 3.5D-A — one more strictly-read-only proxy, same shape as `/account` above: a single
     * already-known exchange order (`GET /fapi/v1/order`, weight 1). Stateless — this route has no
     * concept of a local RealOrder at all (RealOrder/RealTrade live only in the frontend's
     * localStorage, never on this backend); the caller supplies exactly the symbol + exchangeOrderId
     * it already has, and this route never looks anything up by any other identifier. No
     * cancel/amend route exists alongside it. */
    const exchOrderMatch = url.pathname.match(/^\/api\/exchange\/connections\/([^/]+)\/order$/);
    if (exchOrderMatch) {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const symbol = url.searchParams.get('symbol') || '';
      const orderId = url.searchParams.get('orderId') || '';
      const origClientOrderId = url.searchParams.get('origClientOrderId') || '';
      // Sprint 3.5D-B, Task 27 — origClientOrderId is the recovery path for an ambiguous submission
      // (no exchangeOrderId yet). Exactly one of the two identifiers is required.
      if (!symbol || (!orderId && !origClientOrderId)) return sendJson(res, 400, { ok: false, error: '缺少 symbol，以及 orderId 或 origClientOrderId 中的至少一个' });
      const result = await fetchExchangeOrderSnapshot(exchOrderMatch[1], symbol, orderId ? { orderId } : { origClientOrderId });
      if (!result.ok) return sendJson(res, 200, { ok: false, error: result.error });
      return sendJson(res, 200, { ok: true, snapshot: result.snapshot });
    }

    /** Sprint 3.5D-B — the FIRST exchange write route in this app (Sprint 3.5D-D adds a second, the
     * DELETE cancellation route further below). TESTNET-only, enforced inside
     * submitEntryOrderToBinanceTestnet()/resolveAndSubmitEntryOrder()/submitBinanceFuturesEntryOrder()
     * (three independent layers, Task 2). This route itself does the cheap structural body-shape
     * validation (Task 24/25) before ever calling the exchange service — unknown fields are simply
     * ignored (never trusted), not merged into the request; only the exact fields below are ever read
     * off `body`. Still no amend/leverage/margin-mode route exists anywhere in this app. */
    const exchOrdersMatch = url.pathname.match(/^\/api\/exchange\/connections\/([^/]+)\/orders$/);
    if (exchOrdersMatch) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体格式不正确' });
      const symbol = typeof body.symbol === 'string' ? body.symbol.trim() : '';
      const side = body.side === 'BUY' || body.side === 'SELL' ? body.side : null;
      const orderType = body.orderType === 'MARKET' || body.orderType === 'LIMIT' ? body.orderType : null;
      const limitPrice = typeof body.limitPrice === 'number' ? body.limitPrice : null;
      const positionSizeUsdt = typeof body.positionSizeUsdt === 'number' ? body.positionSizeUsdt : NaN;
      const leverage = typeof body.leverage === 'number' ? body.leverage : NaN;
      const localOrderId = typeof body.localOrderId === 'string' ? body.localOrderId : '';
      if (!symbol) return sendJson(res, 400, { ok: false, error: '缺少 symbol' });
      if (!side) return sendJson(res, 400, { ok: false, error: 'side 必须为 BUY 或 SELL' });
      if (!orderType) return sendJson(res, 400, { ok: false, error: 'orderType 必须为 MARKET 或 LIMIT' });
      if (orderType === 'LIMIT' && !(typeof limitPrice === 'number' && Number.isFinite(limitPrice) && limitPrice > 0)) {
        return sendJson(res, 400, { ok: false, error: '限价单缺少有效的 limitPrice' });
      }
      if (!localOrderId) return sendJson(res, 400, { ok: false, error: '缺少 localOrderId' });
      const result = await submitEntryOrderToBinanceTestnet(exchOrdersMatch[1], { symbol, side, orderType, limitPrice, positionSizeUsdt, leverage, localOrderId });
      if (!result.ok) return sendJson(res, 200, { ok: false, error: result.error, ambiguous: result.ambiguous === true, leverageMismatch: result.leverageMismatch || null });
      return sendJson(res, 200, { ok: true, snapshot: result.snapshot });
    }

    /** Sprint 3.5D-D — the SECOND and, as of this sprint, LAST planned exchange write route in this
     * app. TESTNET-only, enforced inside cancelEntryOrderOnBinanceTestnet()/
     * cancelBinanceFuturesTestnetOrder() (two independent layers below this one, Task 23). Task 24 —
     * this route (like the POST /orders route above it) has no concept of a local RealOrder and
     * cannot verify the caller actually "owns" `exchangeOrderId` — RealOrder/RealTrade live only in
     * the frontend's localStorage, never on this backend. At minimum this route enforces: TESTNET,
     * a resolvable/enabled connection with credentials, a normalized symbol, and a numeric-looking
     * order id shape — documented honestly as the real boundary, not a claim of server-side ownership
     * verification that doesn't exist. No amend/replace route exists alongside it. */
    const exchOrderCancelMatch = url.pathname.match(/^\/api\/exchange\/connections\/([^/]+)\/orders\/([^/]+)$/);
    if (exchOrderCancelMatch) {
      if (req.method !== 'DELETE') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const symbol = url.searchParams.get('symbol') || '';
      const exchangeOrderId = exchOrderCancelMatch[2];
      if (!symbol) return sendJson(res, 400, { ok: false, error: '缺少 symbol' });
      const result = await cancelEntryOrderOnBinanceTestnet(exchOrderCancelMatch[1], { symbol, exchangeOrderId });
      if (!result.ok) return sendJson(res, 200, { ok: false, error: result.error, ambiguous: result.ambiguous === true });
      return sendJson(res, 200, { ok: true, snapshot: result.snapshot });
    }

    /** Sprint 3.5D-E — real protective (STOP_LOSS/TAKE_PROFIT) order submission via Binance's Algo
     * Service. TESTNET-only, enforced inside submitProtectionOrderToBinanceTestnet()/
     * resolveAndSubmitProtectionOrder()/submitBinanceFuturesProtectionOrder() (three independent
     * layers, same discipline as entry-order submission). This route does the cheap structural
     * body-shape validation before ever calling the exchange service — unknown fields are ignored,
     * never merged into the request. */
    const algoOrdersMatch = url.pathname.match(/^\/api\/exchange\/connections\/([^/]+)\/algo-orders$/);
    if (algoOrdersMatch) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体格式不正确' });
      const symbol = typeof body.symbol === 'string' ? body.symbol.trim() : '';
      const side = body.side === 'BUY' || body.side === 'SELL' ? body.side : null;
      const positionSide = body.positionSide === 'BOTH' || body.positionSide === 'LONG' || body.positionSide === 'SHORT' ? body.positionSide : null;
      const type = body.type === 'STOP_MARKET' || body.type === 'TAKE_PROFIT_MARKET' ? body.type : null;
      const triggerPrice = typeof body.triggerPrice === 'number' ? body.triggerPrice : NaN;
      const quantity = typeof body.quantity === 'number' ? body.quantity : NaN;
      const reduceOnly = typeof body.reduceOnly === 'boolean' ? body.reduceOnly : false;
      const clientAlgoId = typeof body.clientAlgoId === 'string' ? body.clientAlgoId : '';
      if (!symbol) return sendJson(res, 400, { ok: false, error: '缺少 symbol' });
      if (!side) return sendJson(res, 400, { ok: false, error: 'side 必须为 BUY 或 SELL' });
      if (!positionSide) return sendJson(res, 400, { ok: false, error: 'positionSide 必须为 BOTH、LONG 或 SHORT' });
      if (!type) return sendJson(res, 400, { ok: false, error: 'type 必须为 STOP_MARKET 或 TAKE_PROFIT_MARKET' });
      if (!clientAlgoId) return sendJson(res, 400, { ok: false, error: '缺少 clientAlgoId' });
      const result = await submitProtectionOrderToBinanceTestnet(algoOrdersMatch[1], { symbol, side, positionSide, type, triggerPrice, quantity, reduceOnly, clientAlgoId });
      if (!result.ok) return sendJson(res, 200, { ok: false, error: result.error, ambiguous: result.ambiguous === true });
      return sendJson(res, 200, { ok: true, snapshot: result.snapshot });
    }

    /** Sprint 3.5D-E — cancels an existing protective order (used only by the reconciliation
     * function's disclosed "cancel old, create corrected" fallback — never a blind amend). Same
     * ownership-boundary honesty as the entry-order cancel route: this backend cannot verify the
     * caller "owns" `algoId`, only that TESTNET/connection/credentials are valid. */
    const algoOrderCancelMatch = url.pathname.match(/^\/api\/exchange\/connections\/([^/]+)\/algo-orders\/([^/]+)$/);
    if (algoOrderCancelMatch) {
      if (req.method !== 'DELETE') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const algoId = algoOrderCancelMatch[2];
      const result = await cancelProtectionOrderOnBinanceTestnet(algoOrderCancelMatch[1], { algoId });
      if (!result.ok) return sendJson(res, 200, { ok: false, error: result.error, ambiguous: result.ambiguous === true });
      return sendJson(res, 200, { ok: true, result: result.result });
    }

    /** Sprint 3.5D-E — read-only recovery lookup for an ambiguous protection submission/cancellation,
     * by algoId or clientAlgoId (symbol genuinely not required by the real Binance endpoint — see
     * binanceFuturesAdapter.ts's research note). Stateless proxy, parallel to the existing
     * `/order` route. */
    const algoOrderMatch = url.pathname.match(/^\/api\/exchange\/connections\/([^/]+)\/algo-order$/);
    if (algoOrderMatch) {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const algoId = url.searchParams.get('algoId') || '';
      const clientAlgoId = url.searchParams.get('clientAlgoId') || '';
      if (!algoId && !clientAlgoId) return sendJson(res, 400, { ok: false, error: '缺少 algoId 或 clientAlgoId 中的至少一个' });
      const result = await fetchProtectionOrderSnapshot(algoOrderMatch[1], algoId ? { algoId } : { clientAlgoId });
      if (!result.ok) return sendJson(res, 200, { ok: false, error: result.error });
      return sendJson(res, 200, { ok: true, snapshot: result.snapshot });
    }

    /** Sprint 3.6A — read-only, all currently-open plain orders (App vs External ownership decided
     * entirely by the frontend — this route has no concept of a local Order). Optional `?symbol=`
     * scoping mirrors the existing `/order` route's own weight-conscious design. */
    const exchOpenOrdersMatch = url.pathname.match(/^\/api\/exchange\/connections\/([^/]+)\/open-orders$/);
    if (exchOpenOrdersMatch) {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const symbol = url.searchParams.get('symbol') || undefined;
      const result = await fetchOpenOrders(exchOpenOrdersMatch[1], symbol);
      if (!result.ok) return sendJson(res, 200, { ok: false, error: result.error });
      return sendJson(res, 200, { ok: true, snapshots: result.snapshots });
    }

    /** Sprint 3.6A — the app's FIFTH write route: leverage change. TESTNET-only, enforced inside
     * changeLeverageOnBinanceTestnet()/changeBinanceFuturesLeverage() (two independent layers below
     * this one — the frontend's confirm-then-verify flow is the third). Never invoked by any
     * automatic code path — only ever reached from an explicit user click on a modal that already
     * showed current vs. requested leverage. */
    const exchLeverageMatch = url.pathname.match(/^\/api\/exchange\/connections\/([^/]+)\/leverage$/);
    if (exchLeverageMatch) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体格式不正确' });
      const symbol = typeof body.symbol === 'string' ? body.symbol.trim() : '';
      const leverage = typeof body.leverage === 'number' ? body.leverage : NaN;
      if (!symbol) return sendJson(res, 400, { ok: false, error: '缺少 symbol' });
      if (!Number.isFinite(leverage)) return sendJson(res, 400, { ok: false, error: '缺少有效的 leverage' });
      const result = await changeLeverageOnBinanceTestnet(exchLeverageMatch[1], symbol, leverage);
      if (!result.ok) return sendJson(res, 200, { ok: false, error: result.error, ambiguous: result.ambiguous === true });
      return sendJson(res, 200, { ok: true, result: result.result });
    }

    /** Sprint 3.6A — Task 38: real-time account/order updates. Server-Sent Events (one-way is
     * sufficient — the frontend never needs to send anything back over this channel), relaying
     * normalized Binance User Data Stream events (see exchange/userDataStreamManager.ts). Credentials
     * never leave this backend: the browser only ever receives already-normalized event JSON, never a
     * listenKey or API key. Read-only capability — allowed for LIVE connections too (same as the
     * existing `/account` snapshot route), unlike the TESTNET-gated trading writes above. */
    const exchStreamMatch = url.pathname.match(/^\/api\/exchange\/connections\/([^/]+)\/stream$/);
    if (exchStreamMatch) {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const resolved = resolveAccountStreamCredentials(exchStreamMatch[1]);
      if (!resolved.ok) return sendJson(res, 200, { ok: false, error: resolved.error });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const send = (evt: unknown) => { try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch {} };
      const unsubscribe = subscribeAccountEventStream(exchStreamMatch[1], resolved.creds, send);
      const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
      return;
    }

    const exchIdMatch = url.pathname.match(/^\/api\/exchange\/connections\/([^/]+)$/);
    if (exchIdMatch) {
      const id = exchIdMatch[1];
      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体格式不正确' });
        const patch: { name?: string; environment?: ExchangeEnvironment; apiKey?: string; apiSecret?: string; enabled?: boolean } = {};
        if (typeof body.name === 'string') patch.name = body.name.trim();
        if (typeof body.environment === 'string') patch.environment = body.environment as ExchangeEnvironment;
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
        if (typeof body.apiKey === 'string' && body.apiKey.trim()) patch.apiKey = body.apiKey.trim();
        if (typeof body.apiSecret === 'string' && body.apiSecret.trim()) patch.apiSecret = body.apiSecret.trim();
        const updated = updateExchangeConnection(id, patch);
        if (!updated) return sendJson(res, 404, { ok: false, error: '连接不存在' });
        return sendJson(res, 200, { ok: true, connection: toSafeExchangeConnectionView(updated) });
      }
      if (req.method === 'DELETE') {
        const result = deleteExchangeConnection(id);
        if (!result.ok) return sendJson(res, 404, { ok: false, error: result.reason });
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }

    /** Sprint 3.3B: real image bytes in, structured evidence out — never a filename, never a fake
     * OCR string. Never touches qa_ai_raw_results/AI Response Parser/Prompt Builder; this is a
     * fully separate, additive endpoint (Analysis Runner Integration's "smallest compatible
     * backend integration"/"dedicated endpoint" instruction), not an overload of /api/ai/analyze. */
    if (url.pathname === '/api/ai/evidence/image') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体格式不正确' });
      const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64 : '';
      const mimeType = typeof body.mimeType === 'string' && body.mimeType ? body.mimeType : 'image/jpeg';
      const evidenceId = typeof body.evidenceId === 'string' ? body.evidenceId : '';
      if (!imageBase64 || !evidenceId) return sendJson(res, 400, { ok: false, error: '缺少 imageBase64 或 evidenceId' });
      const result = await runEvidenceImageParse({ imageBase64, mimeType, evidenceId });
      return sendJson(res, 200, result);
    }

    const m = url.pathname.match(/^\/api\/sources\/([a-z]+)$/);
    if (m) {
      const key = m[1] as SourceKey;
      if (!FETCHERS[key]) return sendJson(res, 404, { error: 'unknown source: ' + key });
      const fresh = url.searchParams.get('fresh') === '1';
      const data = await getSource(key, { fresh });
      return sendJson(res, 200, data);
    }

    sendJson(res, 404, { error: 'not found', routes: ['/health', '/api/sources', '/api/sources/:key[?fresh=1]', '/api/prices', '/api/marketcap', '/api/market/detail?symbol=', '/api/liquidation/detail', 'GET|POST /api/news-sources', 'PATCH|DELETE /api/news-sources/:id', '/api/news-sources/test?url=', 'POST /api/ai/analyze', 'GET /api/ai/config', 'POST /api/ai/config/:provider', 'POST /api/ai/config/:provider/test', 'GET|POST /api/ai/roles/:role', 'POST /api/ai/evidence/image', 'GET|POST /api/ai/connections', 'PUT|DELETE /api/ai/connections/:id', 'POST /api/ai/connections/:id/test', 'GET /api/ai/connections/:id/models', 'GET|POST /api/exchange/connections', 'PUT|DELETE /api/exchange/connections/:id', 'POST /api/exchange/connections/:id/test', 'GET /api/exchange/connections/:id/account', 'GET /api/exchange/connections/:id/order?symbol=&orderId=|origClientOrderId=', 'GET /api/exchange/connections/:id/open-orders[?symbol=]', 'POST /api/exchange/connections/:id/orders', 'DELETE /api/exchange/connections/:id/orders/:exchangeOrderId?symbol=', 'POST /api/exchange/connections/:id/algo-orders', 'DELETE /api/exchange/connections/:id/algo-orders/:algoId', 'GET /api/exchange/connections/:id/algo-order?algoId=|clientAlgoId=', 'POST /api/exchange/connections/:id/leverage (TESTNET-only)', 'GET /api/exchange/connections/:id/stream (SSE, read-only real-time updates)'] });
  } catch (err: any) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`quant-pipeline local server running: http://localhost:${PORT}`);
  console.log(`  GET /api/sources        全部 11 个数据源（含市场行情/技术指标/衍生品的 OKX 兜底）`);
  console.log(`  GET /api/sources/:key   单个数据源；?fresh=1 绕过 20s 缓存读（Analysis Runner 用，仍会写回缓存）`);
  console.log(`  GET /api/prices         精简结构化价格，供前端 ASSETS 同步用`);
  console.log(`  GET /api/marketcap`);
  console.log(`  GET /api/market/detail?symbol=BTCUSDT&interval=1h&limit=100   Market 模块 Detail Page（K线/波动率/自采快照历史）`);
  console.log(`  GET /api/liquidation/detail   Liquidation 模块 Detail Page（1H/4H/24H 历史/资产分布/交易所分布/最近事件）`);
  console.log(`  GET/POST /api/news-sources           新闻源列表 / 新增（真实持久化到 SQLite，见 db.ts news_sources 表）`);
  console.log(`  PATCH/DELETE /api/news-sources/:id   编辑 / 删除新闻源`);
  console.log(`  GET /api/news-sources/test?url=      新闻源管理"测试并保存"用，真实抓取+解析 RSS`);
  console.log(`  POST /api/ai/analyze   AI Engine（多 provider，key 只在后端 env，见 .env.example）——本阶段只到 raw provider response，不解析/不接 Strategy`);
  console.log(`  GET /api/ai/config                     AI Connections 设置页：读取 5 个 provider 的配置（key 已遮罩）`);
  console.log(`  POST /api/ai/config/:provider          保存单个 provider 配置；apiKey 留空=不修改已保存的 key`);
  console.log(`  POST /api/ai/config/:provider/test     真实测试连接（最小 prompt），不落盘到 qa_ai_raw_results`);
  console.log(`  GET/POST /api/ai/roles/:role            Model Role 配置（main-analysis / evidence-parser），指向一个 connectionId + model`);
  console.log(`  POST /api/ai/evidence/image             图片证据解析（真实图片 bytes → 结构化证据，含来源身份，不生成交易建议）`);
  console.log(`  GET/POST /api/ai/connections            AI 连接管理：列出 / 新建连接（可同时存在多个同类型连接）`);
  console.log(`  PUT/DELETE /api/ai/connections/:id      更新 / 删除单个连接；删除前会检查是否仍被某个角色引用`);
  console.log(`  POST /api/ai/connections/:id/test       测试指定连接`);
  console.log(`  GET /api/ai/connections/:id/models      按连接发现可用模型（目前仅 openai-compatible 类型支持）`);
  console.log(`  GET/POST /api/exchange/connections               交易所连接管理：列出 / 新建（目前仅 binance-futures，只读，无下单接口）`);
  console.log(`  PUT/DELETE /api/exchange/connections/:id         更新 / 删除单个交易所连接`);
  console.log(`  POST /api/exchange/connections/:id/test          测试连接（一次签名的只读账户请求，不会下单）`);
  console.log(`  GET /api/exchange/connections/:id/account        读取归一化账户快照（余额 + 持仓，只读）`);
  console.log(`  GET /api/exchange/connections/:id/order?symbol=&orderId=|origClientOrderId=   查询单个已知交易所订单状态（只读，无撤单/改单接口）`);
  console.log(`  POST /api/exchange/connections/:id/orders   提交入场订单（写接口一，仅 TESTNET，仅 MARKET/LIMIT）`);
  console.log(`  DELETE /api/exchange/connections/:id/orders/:exchangeOrderId?symbol=   撤销入场订单（写接口二，仅 TESTNET，仅 SUBMITTED/PARTIALLY_FILLED，无改单/杠杆/保证金模式接口）`);
  console.log(`  POST /api/exchange/connections/:id/algo-orders   提交保护单 STOP_MARKET/TAKE_PROFIT_MARKET（写接口三，仅 TESTNET，走 Binance Algo Service）`);
  console.log(`  DELETE /api/exchange/connections/:id/algo-orders/:algoId   撤销保护单（写接口四，仅 TESTNET）`);
  console.log(`  GET /api/exchange/connections/:id/algo-order?algoId=|clientAlgoId=   查询单个保护单状态（只读，用于歧义提交/撤单的恢复）`);
  console.log(`  GET /api/exchange/connections/:id/open-orders[?symbol=]   全部当前挂单（只读，App/External 归属由前端判断）`);
  console.log(`  POST /api/exchange/connections/:id/leverage   调整杠杆（写接口五，仅 TESTNET，从不自动调用，需前端显式确认）`);
  console.log(`  GET /api/exchange/connections/:id/stream   实时账户/订单更新（SSE，只读，LIVE/TESTNET 均可用，凭证不出后端）`);
  console.log(`  GET /health   含 startedAt/runtimeVersion，便于判断后端进程是否为最新代码`);
  console.log(`\nprototype/index.html 需要把 BACKEND_URL 指向这里（默认已配置为 http://localhost:${PORT}）`);
  // Safe diagnostic (2026-08-08): effective value only, never the source of secrets — lets a stale
  // running process (old in-memory code from before an engine.ts edit) be told apart from a real
  // env override, without ever needing a real provider request to find out.
  console.log(`AI request timeout: ${getTimeoutConfig().timeoutMs}ms`);
});

startLiquidationCollector();
