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
  listExchangeConnections, createExchangeConnection, updateExchangeConnection, getExchangeConnection,
  deleteExchangeConnection, toSafeExchangeConnectionView,
} from './exchange/exchangeConnectionStore.js';
import {
  listExchangeAccounts, getExchangeAccount, createExchangeAccount, updateExchangeAccount,
  toSafeExchangeAccountView, resolveAccountBindingForConnection, ensureAccountsBootstrapped,
  isExchangeAccountStructurallyUsable,
} from './exchange/exchangeAccountStore.js';
import {
  testExchangeConnection, fetchExchangeAccountSnapshot, fetchExchangeOrderSnapshot, submitEntryOrderToBinanceTestnet, cancelEntryOrderOnBinanceTestnet,
  submitProtectionOrderToBinanceTestnet, cancelProtectionOrderOnBinanceTestnet, fetchProtectionOrderSnapshot,
  fetchOpenOrders, changeLeverageOnBinanceTestnet, resolveAccountStreamCredentials, subscribeAccountEventStream,
} from './exchange/exchangeService.js';
import type { ExchangeType, ExchangeEnvironment } from './exchange/types.js';
import {
  runExchangeRuntimeSyncOnce, startExchangeRuntimeSyncLoop, getAllAccountRuntimeStates, toSafeAccountRuntimeView,
} from './exchange/exchangeRuntimeSync.js';
import {
  listStrategyOrders, getStrategyOrder, saveStrategyOrder, genStrategyOrderId, transitionStrategyOrder, assertValidTransition,
} from './strategy/strategyOrderStore.js';
import type { StrategyOrder, Trigger, ExecutionIntent, ExecutionGuard } from './strategy/types.js';
import { routeTriggerCapability } from './strategy/capabilityRouter.js';
import { listAuditEventsForStrategyOrder, listAuditEventsForTrade, appendAuditEvent } from './strategy/auditLogStore.js';
import { getKillSwitchState, setKillSwitchState } from './strategy/killSwitch.js';
import { getAutoRiskPolicy, updateAutoRiskPolicy } from './strategy/autoRiskPolicyStore.js';
import {
  strategyEvents, configureMonitorEngine, startMonitorLoop, recoverOnStartup, triggerImmediateExchangeNativeSubmission,
} from './strategy/monitorEngine.js';
import { getAutonomousPolicy, updateAutonomousPolicy } from './strategy/autonomousPolicyStore.js';
import { computeAutomationReadiness } from './strategy/automationReadiness.js';
import { getAutonomousSchedulerState, computeSchedulerHealth } from './strategy/autonomousSchedulerStore.js';
import { getAutonomousCycle, listAutonomousCycles } from './strategy/autonomousCycleStore.js';
import { configureAutonomousScheduler, startAutonomousSchedulerLoop } from './strategy/autonomousScheduler.js';
import { runAnalysis } from './analysis/analysisEngine.js';
import { getAnalysisRecord, listAnalysisRecords } from './analysis/analysisRecordStore.js';
import { genAnalysisId } from './analysis/payloadBuilder.js';
import { WEIGHT_DEFS, SOURCE_LABELS } from './analysis/weightDefs.js';
import {
  createAnalysisRun, getAnalysisRun, createProgressReporter, findActiveRun,
} from './analysis/analysisRunStore.js';
import { reconcileStaleAnalysisRuns, reconcileOrphanedRunsOnStartup, cancelAnalysisRun } from './analysis/analysisRunReconciliation.js';
import { genAutonomousCycleId } from './strategy/autonomousCycleStore.js';
import { runAutonomousCycleForSymbol } from './strategy/autonomousScheduler.js';

const PORT = Number(process.env.PORT) || 8787;
const CACHE_TTL_MS = 20_000;

/** Sprint 3.6A, Task 33 — makes backend staleness (old tsx process still running after a source edit)
 * detectable without manually comparing `Get-Process` start time against file mtimes by hand, a
 * recurring real problem this session. `startedAt` is captured once at module load (this exact
 * process's actual start moment); `runtimeVersion` is a monotonically-increasing marker bumped by
 * hand alongside real backend changes — not a semantic-version claim, just "did this process load
 * code newer than commit-marker N." */
const RUNTIME_VERSION = 'r-analysisrun-lifecycle-safety-1';
const STARTED_AT = new Date().toISOString();

/** Sprint 3.6A.2.1 — set once by the startup bootstrap call below (never by a request handler).
 * Surfaced on `/health` so a failed/half-migrated ExchangeAccount bootstrap is diagnosable instead of
 * silently leaving the account model in a partial state — see the try/catch right before
 * `server.listen()`. `null` means either bootstrap succeeded or hasn't run yet (module still loading);
 * once set to a string it stays set until the process restarts. */
let accountBootstrapError: string | null = null;

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
  // `PUT` was missing here — a real, genuine bug (found while investigating a real "AI Connection
  // edit doesn't work" report): the frontend is served as a static file, a different origin than this
  // API, so a browser sends a CORS preflight for any PUT request (e.g. connectionFormSave()'s edit
  // path); with PUT absent from this list, the browser blocks the actual request before it's ever
  // sent — the backend never even sees it. This affected every PUT-based route in the app (Exchange
  // Accounts, Strategy Orders, Kill Switch, AUTO/Autonomous Risk Policy, AI Connections), not just
  // this one — curl/Node-fetch-based tests never caught it because CORS is a browser-only enforcement.
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true, uptime: process.uptime(), startedAt: STARTED_AT, runtimeVersion: RUNTIME_VERSION, accountBootstrapError });

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

    /** Sprint 3.6A.2 — Exchange Account list/update. Read-only-against-Binance, same as Exchange
     * Connections below (no order/cancel/amend/transfer route here either). Sprint 3.6A.2.1 hotfix:
     * `listExchangeAccounts()` is now a pure read — bootstrap runs exactly once, at process startup
     * (see `ensureAccountsBootstrapped()` call right before `server.listen()` below), never here. */
    if (url.pathname === '/api/exchange/accounts') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return sendJson(res, 200, { ok: true, accounts: listExchangeAccounts().map(toSafeExchangeAccountView) });
    }

    /** Sprint 3.8C — Backend-owned Exchange Runtime Sync truth, one call, already-computed (Section
     * 24: "不要让 Frontend 自己把五个 endpoint 拼起来再推断 health"). In-memory only (see
     * exchangeRuntimeSync.ts) — reflects whatever this process has synced since it started, completely
     * independent of whether any frontend has ever opened Account/Monitoring. Never includes a
     * credential — `toSafeAccountRuntimeView()` only ever projects fields `ExchangeAccountSnapshot`/
     * `ExchangeOrderSnapshot` already exposed elsewhere in this app. */
    if (url.pathname === '/api/exchange/runtime') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return sendJson(res, 200, { ok: true, accounts: getAllAccountRuntimeStates().map(toSafeAccountRuntimeView) });
    }
    const exchAccountUpdateMatch = url.pathname.match(/^\/api\/exchange\/accounts\/([^/]+)$/);
    if (exchAccountUpdateMatch) {
      if (req.method !== 'PUT') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体格式不正确' });
      const patch: { displayName?: string; preferredConnectionId?: string | null } = {};
      if (typeof body.displayName === 'string') patch.displayName = body.displayName.trim();
      if (body.preferredConnectionId !== undefined) {
        if (body.preferredConnectionId === null) patch.preferredConnectionId = null;
        else if (typeof body.preferredConnectionId === 'string') {
          // Task 8 — deterministic only: the connection being set as preferred must actually exist and
          // actually belong to this account. Never silently accept an unrelated connectionId.
          const acc = getExchangeAccount(exchAccountUpdateMatch[1]);
          if (!acc) return sendJson(res, 404, { ok: false, error: '账户不存在' });
          const conn = getExchangeConnection(body.preferredConnectionId);
          if (!conn || conn.exchangeAccountId !== acc.id) return sendJson(res, 400, { ok: false, error: '该连接不属于此账户，无法设为首选连接' });
          patch.preferredConnectionId = body.preferredConnectionId;
        }
      }
      const updated = updateExchangeAccount(exchAccountUpdateMatch[1], patch);
      if (!updated) return sendJson(res, 404, { ok: false, error: '账户不存在' });
      return sendJson(res, 200, { ok: true, account: toSafeExchangeAccountView(updated) });
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
        // Sprint 3.6A.2.1 hotfix: no longer calls listExchangeAccounts()/bootstrap here — this is now a
        // pure read. Bootstrap already ran once at process startup, so every connection already carries
        // a real exchangeAccountId by the time any request can reach this handler.
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
        const binding = resolveAccountBindingForConnection({
          accountBinding: body.accountBinding, exchange: exchange as ExchangeType, environment: environment as ExchangeEnvironment,
          fallbackDisplayName: name,
        });
        if (!binding.ok) return sendJson(res, 400, { ok: false, error: binding.error });
        const conn = createExchangeConnection({
          name, exchange: exchange as ExchangeType, environment: environment as ExchangeEnvironment,
          apiKey: typeof body.apiKey === 'string' ? body.apiKey.trim() : undefined,
          apiSecret: typeof body.apiSecret === 'string' ? body.apiSecret.trim() : undefined,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
          exchangeAccountId: binding.exchangeAccountId,
        });
        // A brand-new account created above (mode NEW / no binding given) has no preferredConnectionId
        // yet — this new connection is the obvious, deterministic first choice. An EXISTING-account
        // bind never touches the account's already-set preferredConnectionId.
        const acc = getExchangeAccount(binding.exchangeAccountId);
        if (acc && !acc.preferredConnectionId) updateExchangeAccount(acc.id, { preferredConnectionId: conn.id });
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
        const existing = getExchangeConnection(id);
        if (!existing) return sendJson(res, 404, { ok: false, error: '连接不存在' });
        const patch: { name?: string; environment?: ExchangeEnvironment; apiKey?: string; apiSecret?: string; enabled?: boolean; exchangeAccountId?: string | null } = {};
        if (typeof body.name === 'string') patch.name = body.name.trim();
        if (typeof body.environment === 'string') patch.environment = body.environment as ExchangeEnvironment;
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
        if (typeof body.apiKey === 'string' && body.apiKey.trim()) patch.apiKey = body.apiKey.trim();
        if (typeof body.apiSecret === 'string' && body.apiSecret.trim()) patch.apiSecret = body.apiSecret.trim();
        // Sprint 3.6A.2 — re-resolve the account binding whenever environment changes or the caller
        // explicitly supplies accountBinding; otherwise the existing binding is left completely alone.
        if (body.accountBinding || (patch.environment && patch.environment !== existing.environment)) {
          const binding = resolveAccountBindingForConnection({
            accountBinding: body.accountBinding, exchange: existing.exchange, environment: patch.environment || existing.environment,
            fallbackDisplayName: patch.name || existing.name, currentExchangeAccountId: existing.exchangeAccountId,
          });
          if (!binding.ok) return sendJson(res, 400, { ok: false, error: binding.error });
          patch.exchangeAccountId = binding.exchangeAccountId;
        }
        const updated = updateExchangeConnection(id, patch);
        if (!updated) return sendJson(res, 404, { ok: false, error: '连接不存在' });
        return sendJson(res, 200, { ok: true, connection: toSafeExchangeConnectionView(updated) });
      }
      if (req.method === 'DELETE') {
        /** Sprint 3.8C.2, Section 22 — referential integrity on delete. This orchestration lives here
         * (not inside either store) precisely because it needs BOTH exchangeConnectionStore.ts and
         * exchangeAccountStore.ts, and those two files already import from each other in the other
         * direction — putting the cascade inside either store would create a circular import.
         * Ordering matters: if this connection is currently some account's preferredConnection and
         * that account has NO other connection, the account's preferredConnectionId is nulled out
         * FIRST, and the connection itself is only deleted AFTER that succeeds. If the null-out step
         * throws (e.g. a lock timeout), the delete never runs — the previous, fully-consistent state
         * is left untouched rather than a half-migrated dangling reference (Section 27: no partial
         * update). Never a silent fallback to some other connection (Section 22). */
        const target = getExchangeConnection(id);
        if (!target) return sendJson(res, 404, { ok: false, error: '连接不存在' });
        if (target.exchangeAccountId) {
          const account = getExchangeAccount(target.exchangeAccountId);
          if (account && account.preferredConnectionId === id) {
            const otherConnections = listExchangeConnections().filter((c) => c.exchangeAccountId === account.id && c.id !== id);
            if (otherConnections.length > 0) {
              return sendJson(res, 409, {
                ok: false,
                error: '该连接是账户当前的首选连接，且账户还有其它可用连接。请先在账户设置中选择新的首选连接，再删除此连接。',
              });
            }
            updateExchangeAccount(account.id, { preferredConnectionId: null });
          }
        }
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

    /** Sprint 3.9 — the unified Analysis Service entry point (Section 5). Manual triggers this route;
     * `autonomousScheduler.ts` calls `runAnalysis()` directly (same function, no HTTP hop needed since
     * it already runs in-process) — see that file. `exchangeAccountId` is optional: if omitted, the
     * backend auto-resolves it the same safe way Strategy ARM does (Section 18/19's discipline, reused,
     * not reinvented) — exactly one structurally-usable TESTNET account -> use it; 0 or 2+ -> proceed
     * with no account/position context rather than guessing or blocking the whole analysis on an
     * unrelated ambiguity.
     *
     * Sprint 3.9.1.1, Section 10/11/12 — no longer awaits the full pipeline before responding: the
     * real regression this sprint fixes is the frontend's own HTTP request staying open for 2-5
     * minutes with zero visible progress. Now: validate -> duplicate-guard (Section 12.D, one active
     * run per symbol regardless of source) -> create the AnalysisRun (fast, synchronous) -> respond
     * immediately with `{analysisId}` -> run the real pipeline as an un-awaited background promise
     * (the same fire-and-forget pattern `/authorize`'s `triggerImmediateExchangeNativeSubmission`
     * already established in Sprint 3.7 — Node keeps an un-awaited async function running to
     * completion regardless of whether the HTTP response was already sent). The frontend polls
     * `GET /api/analysis/runs/:id` for real progress. */
    if (url.pathname === '/api/analysis/run') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体格式不正确' });
      if (typeof body.symbol !== 'string' || !body.symbol) return sendJson(res, 400, { ok: false, error: '缺少 symbol' });
      if (typeof body.timeframe !== 'string' || !body.timeframe) return sendJson(res, 400, { ok: false, error: '缺少 timeframe' });
      if (typeof body.dateRange !== 'string' || !body.dateRange) return sendJson(res, 400, { ok: false, error: '缺少 dateRange' });
      if (!body.sourceWeights || typeof body.sourceWeights !== 'object' || Array.isArray(body.sourceWeights)) return sendJson(res, 400, { ok: false, error: 'sourceWeights 格式不正确' });
      const additionalEvidence = Array.isArray(body.additionalEvidence) ? body.additionalEvidence : [];

      let exchangeAccountId: string | null = typeof body.exchangeAccountId === 'string' ? body.exchangeAccountId : null;
      if (!exchangeAccountId) {
        const usable = listExchangeAccounts().filter((a) => isExchangeAccountStructurallyUsable(a.id));
        exchangeAccountId = usable.length === 1 ? usable[0].id : null;
      }

      // Sprint — AnalysisRun Lifecycle Safety, Section 9 — reconcile any stale/ghost run for this
      // SAME symbol BEFORE deciding whether to attach or create, so a persisted-but-dead run (like
      // the real incident, AMSXAPKWWA604) never permanently blocks new analyses of that symbol from
      // ever reconnecting to anything real. A genuinely live run is left untouched (registry-checked
      // inside `reconcileStaleAnalysisRuns`), so the duplicate-analysis guard below is preserved.
      reconcileStaleAnalysisRuns(body.symbol);

      // Section 12.D — one unified-analysis run per symbol at a time, Manual or Scheduled alike; a
      // second Manual submission for the same symbol attaches to the existing run instead of
      // starting a duplicate (this IS the backend-side guard even if a future frontend bug bypasses
      // its own button-state check).
      const active = findActiveRun(body.symbol);
      if (active) {
        return sendJson(res, 200, { ok: true, analysisId: active.analysisId, attached: true });
      }

      const analysisId = genAnalysisId();
      const requiredKeys = WEIGHT_DEFS.filter((w) => Number(body.sourceWeights[w.key]) > 0).map((w) => w.key);
      createAnalysisRun({
        analysisId, source: 'MANUAL', symbol: body.symbol, sourceKeys: requiredKeys, sourceLabels: SOURCE_LABELS,
        hasAccountInScope: exchangeAccountId != null, triggeredByCycleId: null,
      });
      const reporter = createProgressReporter(analysisId);
      runAnalysis({
        source: 'MANUAL', symbol: body.symbol, timeframe: body.timeframe, dateRange: body.dateRange,
        sourceWeights: body.sourceWeights, additionalEvidence, exchangeAccountId, analysisId, reporter,
      }).catch((err) => console.error(`[analysis/run] background run ${analysisId} threw:`, err?.message || err));

      return sendJson(res, 200, { ok: true, analysisId });
    }

    /** Sprint 3.9.1.1, Section 11/23 — reload/reconnect recovery without needing a remembered
     * `analysisId`: "is there currently a running analysis for this symbol at all" (Manual OR
     * Scheduled — Section 23 reuses this exact lookup for the Monitoring page's "查看进度" link, so
     * there is only ONE query for "what's running right now", not a Manual-only and a Scheduled-only
     * version). MUST be registered before the generic `:id` route below — the literal path segment
     * "active" would otherwise be captured by that route's `[^/]+` and always 404 as "not found"
     * (caught via a real live-server smoke test during this sprint's own regression pass; the routes
     * were originally ordered the other way around). */
    if (url.pathname === '/api/analysis/runs/active') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const symbol = url.searchParams.get('symbol');
      if (!symbol) return sendJson(res, 400, { ok: false, error: '缺少 symbol' });
      const run = findActiveRun(symbol);
      return sendJson(res, 200, { ok: true, run: run || null });
    }

    /** Sprint 3.9.1.1, Section 17/18 — real cancel: Manual-only, sets `cancelRequested` (checked
     * cooperatively by `snapshotAcquisition.ts`'s source loop and `analysisEngine.ts`'s AI-stage poll,
     * both of which then abort/stop and drive the run to CANCELLED for real) — never a bare UI-hide.
     * Also registered before the generic `:id` route below (harmless either order for this one — the
     * `/cancel` suffix means `:id`'s own end-anchored regex never matches it — but kept alongside
     * `/active` for consistency).
     *
     * Sprint — AnalysisRun Lifecycle Safety, Section 5 — now branches on whether the run is actually
     * LIVE in this process (registry-checked via `cancelAnalysisRun`): a live run gets a real abort
     * signal immediately, on top of the existing cooperative `cancelRequested` flag; a run with no
     * live execution (e.g. AMSXAPKWWA604's exact shape — `cancelRequested` already true but nothing
     * left to ever notice it) is terminalized to CANCELLED right here instead of being left to rot. */
    const analysisRunCancelMatch = url.pathname.match(/^\/api\/analysis\/runs\/([^/]+)\/cancel$/);
    if (analysisRunCancelMatch) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const run = getAnalysisRun(analysisRunCancelMatch[1]);
      if (!run) return sendJson(res, 404, { ok: false, error: 'AnalysisRun 不存在' });
      if (run.source !== 'MANUAL') return sendJson(res, 400, { ok: false, error: '仅 Manual 分析支持取消' });
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.currentStage)) {
        return sendJson(res, 200, { ok: true, run }); // already terminal — idempotent no-op, not an error
      }
      const result = cancelAnalysisRun(analysisRunCancelMatch[1]);
      if (!result.ok) return sendJson(res, 404, { ok: false, error: result.error });
      return sendJson(res, 200, { ok: true, run: result.run });
    }

    /** Sprint 3.9.1.1, Section 10/11 — real-time progress polling target for a single run; also what
     * a page reload uses (given a remembered `analysisId`) to resume showing the real current stage
     * instead of regressing to "暂无分析" (Section 11's hard acceptance criterion). Registered AFTER
     * `/active` and `/cancel` above so neither literal suffix is ever swallowed by this `[^/]+` id
     * match. */
    const analysisRunMatch = url.pathname.match(/^\/api\/analysis\/runs\/([^/]+)$/);
    if (analysisRunMatch) {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const run = getAnalysisRun(analysisRunMatch[1]);
      if (!run) return sendJson(res, 404, { ok: false, error: 'AnalysisRun 不存在' });
      return sendJson(res, 200, { ok: true, run });
    }

    if (url.pathname === '/api/analysis/records') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const source = url.searchParams.get('source');
      const limitRaw = url.searchParams.get('limit');
      const records = listAnalysisRecords({
        source: source === 'MANUAL' || source === 'SCHEDULED' ? source : undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
      });
      return sendJson(res, 200, { ok: true, records });
    }

    const analysisRecordMatch = url.pathname.match(/^\/api\/analysis\/records\/([^/]+)$/);
    if (analysisRecordMatch) {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const record = getAnalysisRecord(analysisRecordMatch[1]);
      if (!record) return sendJson(res, 404, { ok: false, error: 'AnalysisRecord 不存在' });
      return sendJson(res, 200, { ok: true, record });
    }

    /** Sprint 3.6B — StrategyOrder. Backend-persisted (Section 10 — monitoring must survive the
     * browser being closed); never touches RealOrder/RealTrade/RealPosition/PositionAllocation, all of
     * which remain exactly where they were (browser localStorage). See docs/ARCHITECTURE_INDEX.md. */
    if (url.pathname === '/api/strategy/orders') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { ok: true, orders: listStrategyOrders() });
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体格式不正确' });
        if (typeof body.symbol !== 'string' || !body.symbol) return sendJson(res, 400, { ok: false, error: '缺少 symbol' });
        if (body.direction !== 'LONG' && body.direction !== 'SHORT') return sendJson(res, 400, { ok: false, error: 'direction 必须为 LONG 或 SHORT' });
        if (!['USER', 'AI_MANUAL', 'AUTONOMOUS'].includes(body.source)) return sendJson(res, 400, { ok: false, error: 'source 无效' });
        const intent = body.executionIntent;
        if (!intent || typeof intent !== 'object') return sendJson(res, 400, { ok: false, error: '缺少 executionIntent' });
        if (intent.entryType !== 'MARKET' && intent.entryType !== 'LIMIT') return sendJson(res, 400, { ok: false, error: 'executionIntent.entryType 必须为 MARKET 或 LIMIT' });
        if (intent.entryType === 'LIMIT' && !(Number.isFinite(intent.entryPrice) && intent.entryPrice > 0)) return sendJson(res, 400, { ok: false, error: 'LIMIT 入场缺少有效 entryPrice' });
        if (!(Number.isFinite(intent.positionSizeUsdt) && intent.positionSizeUsdt > 0)) return sendJson(res, 400, { ok: false, error: 'executionIntent.positionSizeUsdt 无效' });
        if (!(Number.isFinite(intent.leverage) && intent.leverage > 0)) return sendJson(res, 400, { ok: false, error: 'executionIntent.leverage 无效' });
        const now = new Date().toISOString();
        const order: StrategyOrder = {
          strategyOrderId: genStrategyOrderId(), tradeId: null, symbol: body.symbol, direction: body.direction,
          source: body.source, analysisId: body.analysisId || null, scenarioPlanId: body.scenarioPlanId || null,
          createdAt: now, updatedAt: now, status: 'READY',
          originalStrategy: body.originalStrategy || { entryType: intent.entryType, entryValue: intent.entryPrice, stopLoss: intent.stopLoss ?? null, takeProfit: intent.takeProfit || [], trigger: body.trigger || null, reviewHorizonExpiresAt: body.expiresAt || null },
          effectiveStrategy: { executionIntent: intent, trigger: body.trigger || null },
          trigger: body.trigger || null,
          executionIntent: intent,
          executionGuard: body.executionGuard || { maxPriceDeviationPct: null },
          expiresAt: body.expiresAt || null,
          executionMode: 'MANUAL', authorization: null, capabilityDecision: null,
          monitoringState: { lastCheckedAt: null, nextCheckAt: null, lastObservedDataAt: null, health: 'PAUSED' },
          lastDecision: null,
          submission: { exchangeConnectionId: null, exchangeAccountId: null, pendingClientOrderId: null, clientOrderId: null, exchangeOrderId: null, submittedAt: null },
          linkedRealOrderIds: [], linkedTradeId: null, failureReason: null,
          completionSource: null, closedAt: null,
          execution: {
            orderStatus: null, filledQuantity: 0, averagePrice: null, lastOrderSyncAt: null,
            positionQuantity: null, positionLastSyncedAt: null, allocationQuantity: null,
            protectionStatus: 'NOT_REQUIRED', protectionOrders: [], protectionLastVerifiedAt: null,
            postCloseProtectionState: null, activeOrphanProtectionOrderIds: [],
          },
        };
        saveStrategyOrder(order);
        appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: null, eventType: 'CREATED', previousStatus: null, newStatus: 'READY', reason: `source=${order.source}` });
        return sendJson(res, 200, { ok: true, order });
      }
      return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }

    const soIdMatch = url.pathname.match(/^\/api\/strategy\/orders\/([^/]+)$/);
    if (soIdMatch) {
      const order = getStrategyOrder(soIdMatch[1]);
      if (!order) return sendJson(res, 404, { ok: false, error: 'StrategyOrder 不存在' });
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, order });
      if (req.method === 'PUT') {
        // Section 5.2 — modifying risk-relevant fields invalidates any existing authorization.
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体格式不正确' });
        const riskRelevantKeys = ['executionIntent', 'trigger', 'executionGuard', 'expiresAt'] as const;
        const changesRiskRelevant = riskRelevantKeys.some((k) => body[k] !== undefined);
        const patch: Partial<StrategyOrder> = {};
        if (body.executionIntent) patch.executionIntent = body.executionIntent as ExecutionIntent;
        if (body.trigger !== undefined) patch.trigger = body.trigger as Trigger | null;
        if (body.executionGuard) patch.executionGuard = body.executionGuard as ExecutionGuard;
        if (body.expiresAt !== undefined) patch.expiresAt = body.expiresAt;
        if (patch.executionIntent || patch.trigger !== undefined) {
          patch.effectiveStrategy = { executionIntent: patch.executionIntent || order.executionIntent, trigger: patch.trigger !== undefined ? patch.trigger : order.trigger };
        }
        if (changesRiskRelevant && order.authorization) {
          patch.authorization = null;
          if (order.status === 'ARMED') patch.status = undefined; // stays ARMED per store rules but no longer authorized — arm route re-requires authorize
        }
        const updated = saveStrategyOrder({ ...order, ...patch });
        appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'MODIFIED', previousStatus: order.status, newStatus: updated.status, reason: changesRiskRelevant && order.authorization ? '风险相关字段变更，原授权已失效' : '修改执行参数' });
        return sendJson(res, 200, { ok: true, order: updated });
      }
      return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }

    /** Section 7 — preview-only, does not mutate anything. */
    if (url.pathname === '/api/strategy/capability-check') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体格式不正确' });
      const result = routeTriggerCapability(body.trigger || null, body.executionIntent, body.expiresAt || null, body.direction === 'SHORT' ? 'SHORT' : 'LONG');
      return sendJson(res, 200, { ok: true, ...result });
    }

    /** Section 11 — Armed Auto Authorization. Requires the FULL current trigger/executionIntent/
     * executionGuard/expiresAt to be sent back so the server can verify the client actually saw what
     * it's approving (never trusts a bare "yes" against server-side state the client may not have
     * re-displayed). `AUTONOMOUS` source can never reach this — Section 27. */
    const authorizeMatch = url.pathname.match(/^\/api\/strategy\/orders\/([^/]+)\/authorize$/);
    if (authorizeMatch) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const order = getStrategyOrder(authorizeMatch[1]);
      if (!order) return sendJson(res, 404, { ok: false, error: 'StrategyOrder 不存在' });
      if (order.source === 'AUTONOMOUS') return sendJson(res, 403, { ok: false, error: 'AUTONOMOUS 来源的 StrategyOrder 本 Sprint 不允许获得执行授权' });
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体格式不正确' });
      if (JSON.stringify(body.trigger || null) !== JSON.stringify(order.trigger)
        || JSON.stringify(body.executionIntent) !== JSON.stringify(order.executionIntent)
        || JSON.stringify(body.executionGuard) !== JSON.stringify(order.executionGuard)
        || (body.expiresAt || null) !== order.expiresAt) {
        return sendJson(res, 409, { ok: false, error: '提交授权的内容与服务端当前记录不一致，请刷新后重试' });
      }
      if (!order.submission.exchangeAccountId && !body.exchangeAccountId) return sendJson(res, 400, { ok: false, error: '缺少 exchangeAccountId' });
      const exchangeAccountId = body.exchangeAccountId || order.submission.exchangeAccountId;
      /** Sprint 3.8C.2, Section 28 — backend is the real security boundary, not just the frontend's
       * account picker: a stale UI or a direct API call could still submit an exchangeAccountId that
       * no longer resolves to a usable account (orphaned/dangling preferredConnection, disabled
       * connection, wrong environment). Reject BEFORE ever entering ARMED — never let an order sit
       * "successfully authorized" against an account that cannot actually execute. */
      if (!isExchangeAccountStructurallyUsable(exchangeAccountId)) {
        return sendJson(res, 400, { ok: false, error: '所选交易账户当前不可执行（连接缺失、已禁用或环境不一致），请先在设置中检查交易连接' });
      }
      const capability = routeTriggerCapability(order.trigger, order.executionIntent, order.expiresAt, order.direction);
      if (capability.decision === 'UNSUPPORTED') return sendJson(res, 400, { ok: false, error: '当前触发条件无法被评估（UNSUPPORTED），无法启动自动监控：' + capability.reason });
      const authorizedAt = new Date().toISOString();
      let updated = transitionStrategyOrder(order, 'ARMED', {
        executionMode: 'MONITORED_AUTO',
        capabilityDecision: capability.decision,
        authorization: {
          mode: 'MONITORED_AUTO', authorizedAt,
          authorizedExecutionSnapshot: { trigger: order.trigger as Trigger, executionIntent: order.executionIntent, executionGuard: order.executionGuard, expiresAt: order.expiresAt },
        },
        submission: { ...order.submission, exchangeAccountId },
        monitoringState: { lastCheckedAt: null, nextCheckAt: null, lastObservedDataAt: null, health: 'RUNNING' },
      });
      appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'AUTHORIZED', previousStatus: order.status, newStatus: 'ARMED', reason: `capability=${capability.decision}` });
      appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'ARMED', previousStatus: order.status, newStatus: 'ARMED', reason: '监控已启动' });
      sendJson(res, 200, { ok: true, order: updated });
      if (capability.decision === 'EXCHANGE_NATIVE') {
        triggerImmediateExchangeNativeSubmission(updated).catch((err) => console.error('[strategy] immediate submission failed:', err?.message || err));
      }
      return;
    }

    const pauseMatch = url.pathname.match(/^\/api\/strategy\/orders\/([^/]+)\/pause$/);
    if (pauseMatch) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const order = getStrategyOrder(pauseMatch[1]);
      if (!order) return sendJson(res, 404, { ok: false, error: 'StrategyOrder 不存在' });
      try {
        const updated = transitionStrategyOrder(order, 'PAUSED', { monitoringState: { ...order.monitoringState, health: 'PAUSED' } });
        appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'PAUSED', previousStatus: order.status, newStatus: 'PAUSED', reason: '用户手动暂停' });
        return sendJson(res, 200, { ok: true, order: updated });
      } catch (err: any) { return sendJson(res, 409, { ok: false, error: err.message }); }
    }
    /** Section 9.1 — resume re-validates not-expired/authorization-present before returning to ARMED;
     * never silently re-arms something that has gone stale while paused. */
    const resumeMatch = url.pathname.match(/^\/api\/strategy\/orders\/([^/]+)\/resume$/);
    if (resumeMatch) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const order = getStrategyOrder(resumeMatch[1]);
      if (!order) return sendJson(res, 404, { ok: false, error: 'StrategyOrder 不存在' });
      if (order.expiresAt && new Date(order.expiresAt).getTime() <= Date.now()) {
        const expired = transitionStrategyOrder(order, 'EXPIRED', { failureReason: '恢复前发现已过期' });
        appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'EXPIRED', previousStatus: order.status, newStatus: 'EXPIRED', reason: '恢复前发现已过期' });
        return sendJson(res, 409, { ok: false, error: '该 StrategyOrder 已过期，无法恢复', order: expired });
      }
      if (!order.authorization) return sendJson(res, 409, { ok: false, error: '授权已失效，请重新授权后再恢复' });
      try {
        // Section 15 (Sprint 3.6B.2) — a resume is the start of a fresh attempt; the PRIOR block's
        // reason must not linger and look like a still-current blocker once monitoring resumes.
        const updated = transitionStrategyOrder(order, 'ARMED', { monitoringState: { ...order.monitoringState, health: 'RUNNING' }, failureReason: null });
        appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'RESUMED', previousStatus: order.status, newStatus: 'ARMED', reason: '用户手动恢复' });
        return sendJson(res, 200, { ok: true, order: updated });
      } catch (err: any) { return sendJson(res, 409, { ok: false, error: err.message }); }
    }
    const cancelMatch = url.pathname.match(/^\/api\/strategy\/orders\/([^/]+)\/cancel$/);
    if (cancelMatch) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const order = getStrategyOrder(cancelMatch[1]);
      if (!order) return sendJson(res, 404, { ok: false, error: 'StrategyOrder 不存在' });
      try {
        const updated = transitionStrategyOrder(order, 'CANCELLED', {});
        appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: order.tradeId, eventType: 'CANCELLED', previousStatus: order.status, newStatus: 'CANCELLED', reason: '用户手动取消' });
        return sendJson(res, 200, { ok: true, order: updated });
      } catch (err: any) { return sendJson(res, 409, { ok: false, error: err.message }); }
    }
    /** The frontend calls this once it has (via the EXISTING reconciliation pipeline — never a new
     * one) created/matched a local RealTrade+RealOrder mirroring a real exchange order this
     * StrategyOrder caused. Never called for anything the frontend hasn't itself verified against a
     * real exchange read. */
    const linkMatch = url.pathname.match(/^\/api\/strategy\/orders\/([^/]+)\/link-real-order$/);
    if (linkMatch) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const order = getStrategyOrder(linkMatch[1]);
      if (!order) return sendJson(res, 404, { ok: false, error: 'StrategyOrder 不存在' });
      const body = await readJsonBody(req);
      if (!body || typeof body.tradeId !== 'string' || typeof body.realOrderId !== 'string') return sendJson(res, 400, { ok: false, error: '缺少 tradeId 或 realOrderId' });
      const updated = saveStrategyOrder({ ...order, tradeId: body.tradeId, linkedTradeId: body.tradeId, linkedRealOrderIds: [...new Set([...order.linkedRealOrderIds, body.realOrderId])] });
      appendAuditEvent({ strategyOrderId: order.strategyOrderId, tradeId: body.tradeId, eventType: 'LINKED_REAL_ORDER', previousStatus: order.status, newStatus: order.status, reason: '前端已将真实成交对账为本地 RealOrder/RealTrade', realOrderId: body.realOrderId });
      return sendJson(res, 200, { ok: true, order: updated });
    }
    const auditMatch = url.pathname.match(/^\/api\/strategy\/orders\/([^/]+)\/audit-log$/);
    if (auditMatch) {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return sendJson(res, 200, { ok: true, events: listAuditEventsForStrategyOrder(auditMatch[1]) });
    }
    /** Sprint — Orphan RealTrade Reconciliation, Section 5. A narrow, read-only addition: the
     * frontend's local RealTrade/RealOrder mirror only ever knows its own `tradeId`, never a
     * `strategyOrderId` (that link lives only on the backend StrategyOrder's own `linkedTradeId`
     * field) — so tracing a stale local trade back to real historical terminal evidence (e.g. a
     * StrategyOrder whose own record was later lost to the pre-3.8C.2 persistence bug, but whose
     * audit trail survives) requires a lookup keyed by tradeId, which no existing endpoint provides.
     * Reuses the exact same append-only audit store `/audit-log` above already reads — no second
     * audit store, no write capability, no field beyond what AuditEvent already exposes (never a
     * credential/secret). */
    if (url.pathname === '/api/strategy/audit/search') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const tradeId = url.searchParams.get('tradeId');
      if (!tradeId) return sendJson(res, 400, { ok: false, error: '缺少 tradeId' });
      return sendJson(res, 200, { ok: true, events: listAuditEventsForTrade(tradeId) });
    }

    /** Section 15 — AUTO Kill Switch. Backend-enforced: `monitorEngine.ts` checks this before every
     * single automatic submission, not just here. Defaults to PAUSED (opt-in). */
    if (url.pathname === '/api/strategy/kill-switch') {
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, state: getKillSwitchState() });
      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        if (!body || (body.state !== 'MONITORED_AUTO_ENABLED' && body.state !== 'MONITORED_AUTO_PAUSED')) return sendJson(res, 400, { ok: false, error: 'state 必须为 MONITORED_AUTO_ENABLED 或 MONITORED_AUTO_PAUSED' });
        setKillSwitchState(body.state);
        return sendJson(res, 200, { ok: true, state: body.state });
      }
      return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }

    /** Sprint 3.6B.1, Section 9 — AUTO Risk Policy. Standing permission/risk limits for the
     * MONITORED_AUTO path only (distinct from the Kill Switch's immediate-emergency-stop role) —
     * TESTNET configuration only, `environment` is never accepted from the client. */
    if (url.pathname === '/api/strategy/auto-risk-policy') {
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, policy: getAutoRiskPolicy() });
      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体格式不正确' });
        const patch: Record<string, unknown> = {};
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
        if (Array.isArray(body.allowedSymbols)) patch.allowedSymbols = body.allowedSymbols.filter((s: unknown) => typeof s === 'string');
        if (body.maxNotionalPerTrade === null || Number.isFinite(body.maxNotionalPerTrade)) patch.maxNotionalPerTrade = body.maxNotionalPerTrade;
        if (body.maxLeverage === null || Number.isFinite(body.maxLeverage)) patch.maxLeverage = body.maxLeverage;
        if (body.maxActiveTrades === null || Number.isFinite(body.maxActiveTrades)) patch.maxActiveTrades = body.maxActiveTrades;
        if (body.maxRiskPerTrade === null || Number.isFinite(body.maxRiskPerTrade)) patch.maxRiskPerTrade = body.maxRiskPerTrade;
        if (typeof body.autoEntryEnabled === 'boolean') patch.autoEntryEnabled = body.autoEntryEnabled;
        if (typeof body.autoProtectionEnabled === 'boolean') patch.autoProtectionEnabled = body.autoProtectionEnabled;
        return sendJson(res, 200, { ok: true, policy: updateAutoRiskPolicy(patch) });
      }
      return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }

    /** Sprint 3.7, Section 15 — Autonomous Trading account-level permission. Distinct from AUTO Risk
     * Policy (which stays untouched and still applies to every AUTONOMOUS submission) — this gates
     * whether the scheduler may create/submit a StrategyOrder with NO per-Strategy user click at all.
     * TESTNET configuration only, `environment` is never accepted from the client (Section 40). */
    if (url.pathname === '/api/strategy/autonomous-policy') {
      if (req.method === 'GET') {
        const policy = getAutonomousPolicy();
        return sendJson(res, 200, { ok: true, policy, readiness: computeAutomationReadiness(policy) });
      }
      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体格式不正确' });
        const patch: Record<string, unknown> = {};
        if (typeof body.autonomousEnabled === 'boolean') patch.autonomousEnabled = body.autonomousEnabled;
        if (body.exchangeAccountId === null || typeof body.exchangeAccountId === 'string') patch.exchangeAccountId = body.exchangeAccountId;
        if (Array.isArray(body.allowedSymbols)) patch.allowedSymbols = body.allowedSymbols.filter((s: unknown) => typeof s === 'string');
        if (Number.isFinite(body.analysisIntervalHours) && body.analysisIntervalHours > 0) patch.analysisIntervalHours = body.analysisIntervalHours;
        if (typeof body.allowLong === 'boolean') patch.allowLong = body.allowLong;
        if (typeof body.allowShort === 'boolean') patch.allowShort = body.allowShort;
        if (typeof body.allowOpen === 'boolean') patch.allowOpen = body.allowOpen;
        if (body.maxAutonomousStrategies === null || Number.isFinite(body.maxAutonomousStrategies)) patch.maxAutonomousStrategies = body.maxAutonomousStrategies;
        if (body.cooldownAfterTradeMinutes === null || Number.isFinite(body.cooldownAfterTradeMinutes)) patch.cooldownAfterTradeMinutes = body.cooldownAfterTradeMinutes;
        if (body.defaultPositionSizeUsdt === null || (Number.isFinite(body.defaultPositionSizeUsdt) && body.defaultPositionSizeUsdt > 0)) patch.defaultPositionSizeUsdt = body.defaultPositionSizeUsdt;
        if (body.defaultLeverage === null || (Number.isFinite(body.defaultLeverage) && body.defaultLeverage > 0)) patch.defaultLeverage = body.defaultLeverage;
        const updated = updateAutonomousPolicy(patch);
        return sendJson(res, 200, { ok: true, policy: updated, readiness: computeAutomationReadiness(updated) });
      }
      return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }

    /** Sprint 3.7, Section 7/32 — read-only scheduler operational status for the Control Center UI. */
    if (url.pathname === '/api/strategy/autonomous-scheduler') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const policy = getAutonomousPolicy();
      const state = getAutonomousSchedulerState();
      const health = computeSchedulerHealth(policy.autonomousEnabled, state, policy.analysisIntervalHours);
      return sendJson(res, 200, { ok: true, state, health });
    }

    /** Sprint 3.7, Section 28/31/34 — read-only cycle history for the Control Center / decision list. */
    if (url.pathname === '/api/strategy/autonomous-cycles') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const limitParam = Number(url.searchParams.get('limit'));
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50;
      return sendJson(res, 200, { ok: true, cycles: listAutonomousCycles().slice(0, limit) });
    }
    /** Sprint 3.7, Section 33 — "Run Analysis Now": the exact same gated pipeline as a scheduled
     * cycle, never a shortcut around Autonomous enabled/Kill Switch/Risk Policy/existing Position/
     * existing Strategy — see `runManualAutonomousCycle()`'s own doc comment.
     *
     * Sprint 3.7.1 — this static route MUST be checked before the generic `:cycleId` match directly
     * below (real root-cause of the 3.7.1 hotfix: `POST .../run-now` was being caught by the generic
     * match first, which is GET-only, so this handler was completely unreachable via HTTP — the
     * internal `runManualAutonomousCycle()` function itself was always correct; only the route order
     * in front of it was broken). Static-before-dynamic is the ordering rule for this whole route
     * family now — see the `cycleIdMatch` guard below for the second, defense-in-depth layer. */
    /** Sprint 3.9.1.1, Section 10/12.C — also made fire-and-forget: pre-3.9.1.1 this blocked the HTTP
     * response for the full 45-90+s cycle (Section 0's exact regression, reproduced here too). Cycle
     * idempotency is untouched — `cycleId` is still the SAME deterministic
     * `genAutonomousCycleId(symbol, scheduledAt, manual=true)` `runAutonomousCycleForSymbol()` itself
     * uses as its own first-line idempotency check; only the HTTP response TIMING changed, never the
     * scheduler gating semantics (Kill Switch/Risk Policy/allowedSymbols/etc. all still apply, still
     * evaluated inside `runAutonomousCycleForSymbol()` exactly as before). Progress for this cycle's
     * analysis is visible the same way any Scheduled run's is: `GET /api/analysis/runs/active?symbol=`. */
    if (url.pathname === '/api/strategy/autonomous-cycles/run-now') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const body = await readJsonBody(req);
      if (!body || typeof body.symbol !== 'string' || !body.symbol) return sendJson(res, 400, { ok: false, error: '缺少 symbol' });
      const scheduledAt = new Date().toISOString();
      const cycleId = genAutonomousCycleId(body.symbol, scheduledAt, true);
      runAutonomousCycleForSymbol(body.symbol, { scheduledAt, manual: true })
        .catch((err) => console.error(`[run-now] background cycle ${cycleId} threw:`, err?.message || err));
      return sendJson(res, 200, { ok: true, cycleId });
    }
    /** Sprint 3.7.1 — defense-in-depth: even if a future static path gets added below this point and
     * someone forgets the "static before dynamic" ordering rule again, `cycleIdMatch` itself never
     * treats an arbitrary path segment as a real cycleId. Real cycleIds are never arbitrary strings —
     * `genAutonomousCycleId()` (autonomousCycleStore.ts) always produces `AC_...`/`AC_MANUAL_...` —
     * reusing that existing, real format rather than inventing a new one or a hand-maintained
     * reserved-word list that would need updating every time a new static route is added. */
    const cycleIdMatch = url.pathname.match(/^\/api\/strategy\/autonomous-cycles\/([^/]+)$/);
    if (cycleIdMatch && cycleIdMatch[1].startsWith('AC_')) {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const cycle = getAutonomousCycle(cycleIdMatch[1]);
      if (!cycle) return sendJson(res, 404, { ok: false, error: 'cycle 不存在' });
      return sendJson(res, 200, { ok: true, cycle });
    }

    /** Real-time StrategyOrder events (Section 10/18) — same SSE-is-a-notification-layer-only
     * discipline as the exchange account stream: the persisted StrategyOrder/audit log is always the
     * source of truth; this is purely a "go re-fetch" nudge for the frontend. */
    if (url.pathname === '/api/strategy/stream') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const send = (evt: unknown) => { try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch {} };
      const listener = (evt: unknown) => send(evt);
      strategyEvents.on('event', listener);
      const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(heartbeat); strategyEvents.off('event', listener); });
      return;
    }

    const m = url.pathname.match(/^\/api\/sources\/([a-z]+)$/);
    if (m) {
      const key = m[1] as SourceKey;
      if (!FETCHERS[key]) return sendJson(res, 404, { error: 'unknown source: ' + key });
      const fresh = url.searchParams.get('fresh') === '1';
      const data = await getSource(key, { fresh });
      return sendJson(res, 200, data);
    }

    sendJson(res, 404, { error: 'not found', routes: ['/health', '/api/sources', '/api/sources/:key[?fresh=1]', '/api/prices', '/api/marketcap', '/api/market/detail?symbol=', '/api/liquidation/detail', 'GET|POST /api/news-sources', 'PATCH|DELETE /api/news-sources/:id', '/api/news-sources/test?url=', 'POST /api/ai/analyze', 'GET /api/ai/config', 'POST /api/ai/config/:provider', 'POST /api/ai/config/:provider/test', 'GET|POST /api/ai/roles/:role', 'POST /api/ai/evidence/image', 'GET|POST /api/ai/connections', 'PUT|DELETE /api/ai/connections/:id', 'POST /api/ai/connections/:id/test', 'GET /api/ai/connections/:id/models', 'GET /api/exchange/accounts', 'PUT /api/exchange/accounts/:id', 'GET /api/exchange/runtime', 'GET|POST /api/exchange/connections', 'PUT|DELETE /api/exchange/connections/:id', 'POST /api/exchange/connections/:id/test', 'GET /api/exchange/connections/:id/account', 'GET /api/exchange/connections/:id/order?symbol=&orderId=|origClientOrderId=', 'GET /api/exchange/connections/:id/open-orders[?symbol=]', 'POST /api/exchange/connections/:id/orders', 'DELETE /api/exchange/connections/:id/orders/:exchangeOrderId?symbol=', 'POST /api/exchange/connections/:id/algo-orders', 'DELETE /api/exchange/connections/:id/algo-orders/:algoId', 'GET /api/exchange/connections/:id/algo-order?algoId=|clientAlgoId=', 'POST /api/exchange/connections/:id/leverage (TESTNET-only)', 'GET /api/exchange/connections/:id/stream (SSE, read-only real-time updates)', 'GET|POST /api/strategy/orders', 'GET|PUT /api/strategy/orders/:id', 'POST /api/strategy/orders/:id/authorize|pause|resume|cancel|link-real-order', 'GET /api/strategy/orders/:id/audit-log', 'POST /api/strategy/capability-check', 'GET|PUT /api/strategy/kill-switch', 'GET|PUT /api/strategy/auto-risk-policy', 'GET|PUT /api/strategy/autonomous-policy', 'GET /api/strategy/autonomous-scheduler', 'GET /api/strategy/autonomous-cycles[?limit=]', 'GET /api/strategy/autonomous-cycles/:id', 'POST /api/strategy/autonomous-cycles/run-now', 'GET /api/strategy/stream'] });
  } catch (err: any) {
    sendJson(res, 500, { error: err.message });
  }
});

/** Sprint 3.6A.2.1 — the ONE place ensureAccountsBootstrapped() is ever called: exactly once, here,
 * at process startup, before the server accepts any request. Never from a GET/read route (fixed this
 * sprint — see the /api/exchange/accounts and /api/exchange/connections handlers above). Makes zero
 * Binance requests and reads no credential value — it only inspects/writes exchange/environment/name
 * metadata already present in the local connection store. A failure here does not crash the process
 * (bootstrap is per-connection and additive-only, so a partial failure still leaves whatever did
 * succeed usable) but is never swallowed silently either — logged loudly and surfaced on /health so a
 * half-migrated account model is diagnosable rather than a silent mystery later. */
try {
  ensureAccountsBootstrapped();
} catch (err: any) {
  accountBootstrapError = err?.message || String(err);
  console.error(`[startup] ExchangeAccount bootstrap failed: ${accountBootstrapError}`);
}

/** Sprint 3.9.1.1, Section 20 (superseded by Sprint — AnalysisRun Lifecycle Safety, Section 10) —
 * exactly once, here, before the server accepts requests (same placement discipline as
 * `ensureAccountsBootstrapped()` above). A run left non-terminal by a PREVIOUS process can never
 * actually still be running — the in-flight provider request/snapshot fetch it was awaiting died with
 * that process — so it's terminalized now (CANCELLED if a cancel had already been requested, else
 * FAILED/ORPHANED_AFTER_RESTART) via the real reconciliation code path, the SAME `terminalizeGhostRun`
 * helper runtime reconciliation and the cancel route use, rather than a hand-rolled one-off. This is
 * also the real code path that resolves the historical incident run AMSXAPKWWA604 the next time this
 * process restarts — not a manual JSON edit. */
try {
  const { total, cancelled, failed } = reconcileOrphanedRunsOnStartup();
  if (total > 0) console.log(`[startup] reconciled ${total} orphaned AnalysisRun(s) from a previous process (${cancelled} CANCELLED, ${failed} FAILED)`);
} catch (err: any) {
  console.error(`[startup] reconcileOrphanedRunsOnStartup failed: ${err?.message || err}`);
}

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
  console.log(`  GET /api/exchange/runtime   Backend-owned Exchange Runtime Sync 真相（3.8C，只读，与前端是否打开无关，20s 周期）`);
  console.log(`  GET/POST /api/strategy/orders                    StrategyOrder 列表 / 新建（Sprint 3.6B）`);
  console.log(`  GET/PUT /api/strategy/orders/:id                 读取 / 修改执行参数（风险相关字段变更会使已有授权失效）`);
  console.log(`  POST /api/strategy/orders/:id/authorize          用户预授权条件自动执行，ARMED`);
  console.log(`  POST /api/strategy/orders/:id/pause|resume|cancel`);
  console.log(`  POST /api/strategy/orders/:id/link-real-order    前端对账真实成交为本地 RealOrder/RealTrade 后回写`);
  console.log(`  GET /api/strategy/orders/:id/audit-log           该 StrategyOrder 的完整审计事件`);
  console.log(`  GET /api/strategy/audit/search?tradeId=          按 tradeId 查询审计事件（即使对应 StrategyOrder 主记录已丢失）`);
  console.log(`  POST /api/strategy/capability-check              触发条件路由预览（EXCHANGE_NATIVE/APP_MONITORED/UNSUPPORTED），不落盘`);
  console.log(`  GET/PUT /api/strategy/kill-switch                AUTO Kill Switch，仅阻止新自动开仓，不影响已有 SL/TP`);
  console.log(`  GET/PUT /api/strategy/auto-risk-policy           AUTO Risk Policy（3.6B.1）：标准许可/风险上限，TESTNET-only`);
  console.log(`  POST /api/analysis/run                           统一 Analysis Pipeline（3.9）：Manual 触发，source=MANUAL，立即返回 analysisId（3.9.1.1，后台执行）`);
  console.log(`  GET /api/analysis/runs/:id                       AnalysisRun 实时进度（轮询）：stage/per-source progress/AI elapsed`);
  console.log(`  GET /api/analysis/runs/active?symbol=            该 symbol 当前是否有运行中的分析（Manual 或 Scheduled）`);
  console.log(`  POST /api/analysis/runs/:id/cancel               取消一个 Manual AnalysisRun（真实取消，非仅关闭 UI）`);
  console.log(`  GET /api/analysis/records[?source=&limit=]       统一 Analysis History（只读，Manual+Scheduled 同一列表）`);
  console.log(`  GET /api/analysis/records/:id                    单条 AnalysisRecord（只读）`);
  console.log(`  GET/PUT /api/strategy/autonomous-policy          Autonomous 账户级权限（3.7）：TESTNET-only，autonomousEnabled 默认 false`);
  console.log(`  GET /api/strategy/autonomous-scheduler           Autonomous 调度器状态（只读）：nextRunAt/lastRunAt/health`);
  console.log(`  GET /api/strategy/autonomous-cycles[?limit=]     Autonomous 分析轮次历史（只读）`);
  console.log(`  GET /api/strategy/autonomous-cycles/:id          单个 Autonomous 分析轮次详情（只读）`);
  console.log(`  POST /api/strategy/autonomous-cycles/run-now     立即触发一次 Autonomous 分析（仍受全部门控约束，见 Section 33）`);
  console.log(`  GET /api/strategy/stream                         StrategyOrder 实时事件（SSE，只读）`);
  console.log(`  GET /health   含 startedAt/runtimeVersion/accountBootstrapError，便于判断后端进程是否为最新代码、ExchangeAccount 启动迁移是否成功`);
  console.log(`\nprototype/index.html 需要把 BACKEND_URL 指向这里（默认已配置为 http://localhost:${PORT}）`);
  // Safe diagnostic (2026-08-08): effective value only, never the source of secrets — lets a stale
  // running process (old in-memory code from before an engine.ts edit) be told apart from a real
  // env override, without ever needing a real provider request to find out.
  console.log(`AI request timeout: ${getTimeoutConfig().timeoutMs}ms`);
});

startLiquidationCollector();

/** Sprint 3.8C — Exchange Runtime Sync: "Frontend is a viewer/controller, Backend is the trading
 * system" (Section 0). An immediate sync at startup (Section 17/27A: "Backend startup: 立即 sync 一
 * 次") followed by its own independent periodic loop — completely decoupled from whether any
 * frontend ever opens Account/Monitoring, and started BEFORE the Monitoring Engine's own recovery
 * below so an ARMED order's very first post-restart Execution Readiness check has the best chance of
 * already seeing fresh (not STARTING) exchange state, though the design tolerates either order (a
 * still-STARTING readiness on the very first monitor tick is expected and handled honestly, not
 * treated as an error — see executionReadiness.ts). A failure here never crashes the server — every
 * account's own sync failure is caught and reflected in that account's own `syncHealth` only. */
runExchangeRuntimeSyncOnce()
  .catch((err) => console.error('[exchange runtime sync] initial sync failed:', err?.message || err))
  .finally(() => startExchangeRuntimeSyncLoop());

/** Sprint 3.6B — Section 10/20: the Monitoring Engine is configured once, recovers persisted
 * StrategyOrder state BEFORE the tick loop starts (never re-submits, only re-validates/resolves
 * ambiguity — see monitorEngine.ts#recoverOnStartup), and only then begins ticking. A recovery
 * failure is logged but never blocks the server itself from serving other traffic. */
configureMonitorEngine({ baseUrl: `http://localhost:${PORT}` });
recoverOnStartup()
  .catch((err) => console.error('[strategy monitor] startup recovery failed:', err?.message || err))
  .finally(() => startMonitorLoop());

/** Sprint 3.7, Section 5/6/30 — the Autonomous Scheduler's own periodic tick (separate loop from the
 * Monitoring Engine's 15s tick above — Section 38's explicit "these are two different cadences,
 * don't conflate them"). No explicit startup-recovery call is needed here (unlike monitorEngine's
 * `recoverOnStartup()`): `AutonomousSchedulerState` is fully persisted and re-read fresh on every
 * tick, and every cycle's idempotency lives in its own deterministic `cycleId` — the periodic tick
 * loop starting fresh after a restart is already correct by construction (see `autonomousScheduler.ts`'s
 * own doc comments). */
configureAutonomousScheduler({ baseUrl: `http://localhost:${PORT}` });
startAutonomousSchedulerLoop();
