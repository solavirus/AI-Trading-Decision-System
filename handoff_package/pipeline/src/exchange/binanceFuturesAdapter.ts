import { buildSignedQuery, fetchBinanceServerTimeOffset } from './binanceSign.js';
import type {
  ExchangeAccountSnapshot, ExchangeEnvironment, ExchangeErrorInfo, NormalizedBalance,
  ExchangePositionSnapshot, ExchangeProtectiveOrder, ExchangeAccountRiskSummary, PositionProtectionKind,
  ProtectionReadStatus, ExchangeOrderSnapshot, EntryOrderSubmissionRequest,
  ExchangeAlgoOrderSnapshot, ProtectionOrderSubmissionRequest, CancelProtectionOrderRequest, ExchangeAlgoCancelResult,
  LeverageChangeResult,
} from './types.js';
import { resolveEntryQuantity, resolveProtectionQuantity } from './orderSizing.js';

/** Sprint 3.5B/3.5C — Binance USDT-M Futures adapter. Originally strictly read-only
 * (testConnection()/getAccountSnapshot(), backed by signed GET calls to /fapi/v2/account,
 * /fapi/v2/positionRisk, and /fapi/v1/openAlgoOrders — Task 1/2 of 3.5C, verified against live
 * Binance docs 2026-08-09: conditional TP/SL orders — STOP_MARKET/TAKE_PROFIT_MARKET/STOP/
 * TAKE_PROFIT/TRAILING_STOP_MARKET — migrated to the Algo Service 2025-12-09, and can only be read
 * via /fapi/v1/openAlgoOrders now; the legacy /fapi/v1/openOrders no longer carries them). Sprint
 * 3.5D-B added the first write (`submitBinanceFuturesEntryOrder`/`resolveAndSubmitEntryOrder`,
 * `POST /fapi/v1/order`, TESTNET only); Sprint 3.5D-D added the second (`cancelBinanceFuturesTestnetOrder`,
 * `DELETE /fapi/v1/order`); Sprint 3.5D-E added the third/fourth (`POST`/`DELETE /fapi/v1/algoOrder`,
 * protective orders); Sprint 3.6A adds the fifth (`changeBinanceFuturesLeverage`,
 * `POST /fapi/v1/leverage`, TESTNET only, never auto-invoked — see its own comment) plus read-only
 * `getBinanceFuturesOpenOrders()` and the User Data Stream listenKey lifecycle
 * (`start`/`keepalive`/`closeBinanceFuturesUserDataStream`). Still no amendOrder/replaceOrder/
 * setMarginType/transfer/withdraw/Hedge-Mode-switch function exists anywhere in this file, and none
 * should ever be added without a new, explicit product decision (see EXECUTION_SPEC.md's AUTO/Risk
 * Guard extension boundaries). */

const BASE_URLS: Record<ExchangeEnvironment, string> = {
  LIVE: 'https://fapi.binance.com',
  TESTNET: 'https://testnet.binancefuture.com',
};

/** Hotfix (Binance Futures Symbol Normalization) — the app's canonical trading-pair representation
 * (`"BTC/USDT"`, used everywhere in `prototype/index.html`: `ASSETS`, Analysis Payload, ScenarioPlan,
 * RealOrder.symbol, etc.) is a DISPLAY symbol, not a Binance exchange symbol. Every Binance Futures
 * endpoint keyed by `symbol` (`exchangeInfo`, `positionRisk`, `GET/POST /fapi/v1/order`) expects the
 * exchange's own concatenated form (`"BTCUSDT"`) with no separator — confirmed against a real public
 * `GET /fapi/v1/exchangeInfo` on TESTNET: the response contains `"BTCUSDT"`, never `"BTC/USDT"`.
 * This is the ONE conversion point for that boundary — inspected first: only the `"BTC/USDT"` slash
 * form actually occurs anywhere in this codebase today (no `-`/`_` separator ever appears as a symbol
 * representation), so this deliberately does not build a parser for forms that don't exist yet.
 * Idempotent — already-normalized input (`"BTCUSDT"`) passes through unchanged. Adapter-boundary only:
 * this never touches what's persisted in `RealOrder.symbol` or displayed in the UI — those keep
 * `"BTC/USDT"`; only the value actually sent to/matched against a real Binance API is normalized. */
export function toBinanceFuturesSymbol(symbol: string): string {
  return String(symbol || '').replace(/\//g, '').toUpperCase();
}

const RECV_WINDOW_MS = 5000;
/** Hotfix (3.5C.2) — one named, bounded timeout for every Binance HTTP read, enforced via real
 * network cancellation (AbortSignal.timeout(), not a bare Promise.race that leaves the underlying
 * request running). 10s, not 2-3s: a live diagnostic on this machine measured ~2.2s round-trip to
 * Binance TESTNET, so a tight timeout would false-positive on ordinary latency; not longer either,
 * so a genuinely stuck request still surfaces as an error within a bounded, human-reasonable wait. */
const BINANCE_READ_TIMEOUT_MS = 10000;
/** Sprint 3.5D-B — a separate, slightly more generous bound for the one WRITE this app makes
 * (`POST /fapi/v1/order`). Deliberately not reused/retried the way reads are: see
 * `submitBinanceFuturesEntryOrder()`'s own header comment for why a write timeout/network error is
 * treated as `submission_status_unknown` rather than automatically retried. */
const BINANCE_WRITE_TIMEOUT_MS = 15000;

export interface BinanceFuturesCredentials {
  apiKey: string;
  apiSecret: string;
  environment: ExchangeEnvironment;
}

function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('[REDACTED]');
  }
  return out;
}

interface BinanceApiError extends Error {
  httpStatus?: number;
  binanceCode?: number;
  networkError?: boolean;
  timedOut?: boolean;
  malformed?: boolean;
}

/** Task 1 of 3.5C — the server-time offset is fetched ONCE per snapshot (not once per signed call)
 * and shared across all signed requests in that batch; callers needing exactly one signed call
 * (testConnection) go through signedGet(), which still only fetches the offset once for itself.
 * Hotfix (3.5C.2): distinguishes a genuine timeout (`AbortSignal.timeout()` firing — real network
 * cancellation, not a bare `Promise.race` that leaves the request running in the background) from
 * other network failures, so callers (esp. the best-effort protective-order path) can report
 * `TIMEOUT` vs `UNAVAILABLE` accurately instead of collapsing every failure into one bucket. */
async function signedGetWithOffset<T>(baseUrl: string, path: string, creds: BinanceFuturesCredentials, offset: number, extraParams?: Record<string, string | number>): Promise<T> {
  const query = buildSignedQuery({ ...(extraParams || {}), timestamp: Date.now() + offset, recvWindow: RECV_WINDOW_MS }, creds.apiSecret);
  const url = `${baseUrl}${path}?${query}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { 'X-MBX-APIKEY': creds.apiKey }, signal: AbortSignal.timeout(BINANCE_READ_TIMEOUT_MS) });
  } catch (err: any) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const e: BinanceApiError = new Error(`${isTimeout ? 'request timed out' : 'network request failed'}: ${redactSecrets(String(err?.message ?? err), [creds.apiKey, creds.apiSecret])}`);
    e.networkError = true;
    e.timedOut = isTimeout;
    throw e;
  }

  const rawText = redactSecrets(await res.text(), [creds.apiKey, creds.apiSecret]);
  if (!res.ok) {
    let parsed: { code?: number; msg?: string } | null = null;
    try { parsed = JSON.parse(rawText); } catch {}
    const e: BinanceApiError = new Error(parsed?.msg ? `Binance error: ${parsed.msg}` : `Binance HTTP ${res.status}`);
    e.httpStatus = res.status;
    e.binanceCode = parsed?.code;
    throw e;
  }
  try {
    return JSON.parse(rawText) as T;
  } catch {
    const e: BinanceApiError = new Error('Binance returned a response that was not valid JSON');
    e.malformed = true;
    throw e;
  }
}
/** Sprint 3.5D-B — the WRITE counterpart of signedGetWithOffset(), used for exactly one endpoint
 * (`POST /fapi/v1/order`). Deliberately a SEPARATE function, not a `method` parameter bolted onto
 * signedGetWithOffset() — the two must never accidentally share retry/timeout behavior, since a write
 * timeout/network failure means "unknown outcome, do not retry" (Task 27) while a read timeout simply
 * means "try again safely." Same signature construction (query-string signing — Binance accepts
 * signed params as a query string on POST too, so no new signing helper is needed) and same
 * timeout/error-tagging shape as the read path, just a longer bound (BINANCE_WRITE_TIMEOUT_MS) and no
 * caller-side retry wrapper (there is no `signedPost()` equivalent to `signedGet()` — callers use this
 * function directly, exactly once). */
async function signedPostWithOffset<T>(baseUrl: string, path: string, creds: BinanceFuturesCredentials, offset: number, extraParams: Record<string, string | number>): Promise<T> {
  const query = buildSignedQuery({ ...extraParams, timestamp: Date.now() + offset, recvWindow: RECV_WINDOW_MS }, creds.apiSecret);
  const url = `${baseUrl}${path}?${query}`;

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'X-MBX-APIKEY': creds.apiKey }, signal: AbortSignal.timeout(BINANCE_WRITE_TIMEOUT_MS) });
  } catch (err: any) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const e: BinanceApiError = new Error(`${isTimeout ? 'write request timed out' : 'write network request failed'}: ${redactSecrets(String(err?.message ?? err), [creds.apiKey, creds.apiSecret])}`);
    e.networkError = true;
    e.timedOut = isTimeout;
    throw e;
  }

  const rawText = redactSecrets(await res.text(), [creds.apiKey, creds.apiSecret]);
  if (!res.ok) {
    let parsed: { code?: number; msg?: string } | null = null;
    try { parsed = JSON.parse(rawText); } catch {}
    const e: BinanceApiError = new Error(parsed?.msg ? `Binance error: ${parsed.msg}` : `Binance HTTP ${res.status}`);
    e.httpStatus = res.status;
    e.binanceCode = parsed?.code;
    throw e; // an HTTP-level rejection (4xx/5xx with a parsed Binance error) is a DETERMINISTIC "no order created" — never treated as ambiguous
  }
  try {
    return JSON.parse(rawText) as T;
  } catch {
    const e: BinanceApiError = new Error('Binance returned a response that was not valid JSON');
    e.malformed = true;
    throw e;
  }
}
/** Sprint 3.5D-D — the second WRITE this app makes (`DELETE /fapi/v1/order`). Structurally identical
 * to signedPostWithOffset() (same signing/timeout/error-tagging shape, same "no caller-side retry"
 * contract — a cancellation timeout/network failure is exactly as ambiguous as a submission one: the
 * DELETE may have reached Binance before the response was lost), but kept as its own function rather
 * than a shared `method` parameter — cancellation and submission must never accidentally share retry
 * semantics just because they're both "the write helper." */
async function signedDeleteWithOffset<T>(baseUrl: string, path: string, creds: BinanceFuturesCredentials, offset: number, extraParams: Record<string, string | number>): Promise<T> {
  const query = buildSignedQuery({ ...extraParams, timestamp: Date.now() + offset, recvWindow: RECV_WINDOW_MS }, creds.apiSecret);
  const url = `${baseUrl}${path}?${query}`;

  let res: Response;
  try {
    res = await fetch(url, { method: 'DELETE', headers: { 'X-MBX-APIKEY': creds.apiKey }, signal: AbortSignal.timeout(BINANCE_WRITE_TIMEOUT_MS) });
  } catch (err: any) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const e: BinanceApiError = new Error(`${isTimeout ? 'cancel request timed out' : 'cancel network request failed'}: ${redactSecrets(String(err?.message ?? err), [creds.apiKey, creds.apiSecret])}`);
    e.networkError = true;
    e.timedOut = isTimeout;
    throw e;
  }

  const rawText = redactSecrets(await res.text(), [creds.apiKey, creds.apiSecret]);
  if (!res.ok) {
    let parsed: { code?: number; msg?: string } | null = null;
    try { parsed = JSON.parse(rawText); } catch {}
    const e: BinanceApiError = new Error(parsed?.msg ? `Binance error: ${parsed.msg}` : `Binance HTTP ${res.status}`);
    e.httpStatus = res.status;
    e.binanceCode = parsed?.code;
    throw e; // an HTTP-level rejection is a DETERMINISTIC outcome (e.g. "order does not exist" -2011) — never treated as ambiguous
  }
  try {
    return JSON.parse(rawText) as T;
  } catch {
    const e: BinanceApiError = new Error('Binance returned a response that was not valid JSON');
    e.malformed = true;
    throw e;
  }
}

/** Hotfix (3.5C.1), Task 6 — even with the safety-margin bias, a single transient latency spike
 * could still occasionally trip -1021, so a signed GET gets AT MOST ONE retry, and only when the
 * failure is specifically identified as timestamp drift (binanceCode -1021) — never for credential/
 * permission/rate-limit/network errors, and never more than once. The retry re-fetches a FRESH
 * server-time offset (not the stale one that just failed, and bypassing the cache below) and
 * rebuilds the signature from scratch. */
async function signedGet<T>(baseUrl: string, environment: ExchangeEnvironment, path: string, creds: BinanceFuturesCredentials, extraParams?: Record<string, string | number>): Promise<T> {
  const offset = await getServerTimeOffsetCached(baseUrl, environment, creds);
  try {
    return await signedGetWithOffset<T>(baseUrl, path, creds, offset, extraParams);
  } catch (err: any) {
    if (err?.binanceCode !== -1021) throw err;
    const freshOffset = await getServerTimeOffsetCached(baseUrl, environment, creds, true);
    return await signedGetWithOffset<T>(baseUrl, path, creds, freshOffset, extraParams); // one retry only — any further error propagates as-is
  }
}
/** Task 8 — safe diagnostic only: the numeric offset itself (never the timestamp query, signature,
 * API key, or secret). Helps confirm/debug clock-drift issues like this hotfix's own root cause
 * without ever risking a credential leak in logs. */
async function fetchServerTimeOffsetSafe(baseUrl: string, creds: BinanceFuturesCredentials): Promise<number> {
  try {
    const offset = await fetchBinanceServerTimeOffset(baseUrl);
    console.log(`[binance] clock offset for ${baseUrl}: ${offset >= 0 ? '+' : ''}${offset}ms`);
    return offset;
  } catch (err: any) {
    const e: BinanceApiError = new Error(`network request failed (server time): ${redactSecrets(String(err?.message ?? err), [creds.apiKey, creds.apiSecret])}`);
    e.networkError = true;
    throw e;
  }
}

/** Hotfix (3.5C.2), Task 8 — the observed ~2.2s TESTNET round trip makes a fresh /fapi/v1/time call
 * before EVERY signed request meaningfully slow (a single account refresh previously made 2 separate
 * time-sync round trips: one shared by account+positionRisk, one for openAlgoOrders). A short-lived,
 * per-ENVIRONMENT cache (Task 4/8: TESTNET and LIVE never share an offset) removes that redundancy
 * for calls within the same refresh — and across refreshes within the TTL — while never risking a
 * stale-forever offset: a timestamp (-1021) error always forces an immediate, uncached resync
 * (`forceRefresh=true`), and the TTL itself bounds the worst case even if -1021 never fires. */
const OFFSET_CACHE_TTL_MS = 45000;
const offsetCache: Partial<Record<ExchangeEnvironment, { offset: number; fetchedAt: number }>> = {};
async function getServerTimeOffsetCached(baseUrl: string, environment: ExchangeEnvironment, creds: BinanceFuturesCredentials, forceRefresh = false): Promise<number> {
  const cached = offsetCache[environment];
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < OFFSET_CACHE_TTL_MS) return cached.offset;
  const offset = await fetchServerTimeOffsetSafe(baseUrl, creds);
  offsetCache[environment] = { offset, fetchedAt: Date.now() };
  return offset;
}

/** Task 2 — safe per-request timing diagnostics: start/elapsed/outcome only, never any credential-
 * bearing value. This is exactly what lets a real hang be pinpointed to one specific sub-request
 * instead of just "the account read is slow." */
async function timedRead<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  console.log(`[binance-account] ${label} start`);
  try {
    const result = await fn();
    console.log(`[binance-account] ${label} ok ${Date.now() - t0}ms`);
    return result;
  } catch (err: any) {
    const kind = err?.timedOut ? 'timeout' : err?.binanceCode ? `binance ${err.binanceCode}` : err?.networkError ? 'network' : 'error';
    console.log(`[binance-account] ${label} failed(${kind}) ${Date.now() - t0}ms`);
    throw err;
  }
}

/** Task 22/27 (3.5B) — one place mapping Binance's status/error-code taxonomy to safe, Chinese-facing
 * messages. Never surfaces the raw response body, the signature, or any secret. */
function classifyBinanceError(err: any): ExchangeErrorInfo {
  // Hotfix (3.5C.2), Task 11 — checked BEFORE the generic networkError branch: a timeout is a
  // networkError too, but deserves its own specific, actionable message rather than the generic one.
  if (err?.timedOut) return { code: 'timeout', message: '读取 Binance 账户超时，请稍后重试' };
  if (err?.networkError) return { code: 'network_error', message: '网络请求失败，请检查本机网络连接' };
  if (err?.malformed) return { code: 'malformed_response', message: '交易所返回的数据格式无法解析' };
  const status = err?.httpStatus;
  const code = err?.binanceCode;
  if (code === -1021) return { code: 'timestamp_error', message: '请求时间戳与交易所服务器时间偏差过大，请重试' };
  if (code === -2013) return { code: 'order_not_found', message: '交易所未找到该订单（可能已被撤销超出查询范围，或订单编号有误）' };
  if (code === -2011) return { code: 'order_not_cancellable', message: '订单无法撤销（可能已成交、已撤销或不存在）' };
  if (code === -2019) return { code: 'insufficient_margin', message: '账户可用保证金不足，无法提交该订单' };
  if (code === -1013 || code === -4164 || code === -4003 || code === -4005) return { code: 'filter_failure', message: '订单数量、价格或名义金额不满足交易所过滤器要求' };
  if (code === -1022) return { code: 'invalid_signature', message: '签名校验失败，请检查 API Secret 是否正确' };
  if (code === -2014 || code === -2015) return { code: 'invalid_credentials', message: 'API Key 无效，或该 Key 的 IP 白名单/权限设置不允许此操作，请检查 API Key、IP 白名单与读取权限' };
  if (status === 429 || code === -1003) return { code: 'rate_limited', message: '请求过于频繁，触发交易所限流，请稍后重试' };
  if (status === 401 || status === 403) return { code: 'permission_denied', message: '权限不足或身份校验失败，请检查 API Key 权限设置' };
  if (typeof status === 'number') return { code: 'exchange_error', message: `交易所返回错误（HTTP ${status}）${err?.message ? '：' + String(err.message).replace(/^Binance error:\s*/, '') : ''}` };
  return { code: 'unknown_error', message: '连接交易所时发生未知错误' };
}

function safeNum(v: unknown): number | null {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
/** Binance reports "0" (or omits the field) for liquidationPrice when there is no meaningful value
 * for the current mode (Task 4 — never invent one; render 不可用 instead). */
function safeLiquidationPrice(v: unknown): number | null {
  const n = safeNum(v);
  return n !== null && n > 0 ? n : null;
}

interface BinanceAccountAssetRaw { asset: string; walletBalance: string; availableBalance: string; }
interface BinanceAccountPositionRaw { symbol: string; initialMargin?: string; maintMargin?: string; }
interface BinanceAccountRaw {
  canTrade?: boolean;
  totalWalletBalance?: string;
  totalUnrealizedProfit?: string;
  totalMarginBalance?: string;
  totalInitialMargin?: string;
  totalMaintMargin?: string;
  availableBalance?: string;
  assets: BinanceAccountAssetRaw[];
  positions: BinanceAccountPositionRaw[];
}
interface BinancePositionRiskRaw {
  symbol: string; positionSide?: string; positionAmt: string; entryPrice: string; markPrice?: string;
  unRealizedProfit?: string; liquidationPrice?: string; leverage?: string; marginType?: string;
  isolatedMargin?: string; notional?: string; breakEvenPrice?: string;
}
interface BinanceAlgoOrderRaw {
  algoId: number | string; clientAlgoId?: string; symbol: string; side: string; positionSide?: string; orderType: string;
  algoStatus: string; triggerPrice?: string; price?: string; quantity?: string;
  closePosition?: boolean; reduceOnly?: boolean; createTime?: number;
}

function normalizeBalances(assets: BinanceAccountAssetRaw[]): NormalizedBalance[] {
  return (assets || [])
    .map((a): NormalizedBalance | null => {
      const total = safeNum(a.walletBalance);
      const free = safeNum(a.availableBalance);
      if (total === null || free === null) return null; // malformed numeric data — excluded, never guessed
      return { asset: a.asset, free, locked: Math.max(0, total - free), total };
    })
    .filter((b): b is NormalizedBalance => b !== null && b.total > 0);
}

function normalizeAccountRisk(raw: BinanceAccountRaw): ExchangeAccountRiskSummary {
  return {
    totalWalletBalance: safeNum(raw.totalWalletBalance),
    totalUnrealizedPnl: safeNum(raw.totalUnrealizedProfit),
    totalMarginBalance: safeNum(raw.totalMarginBalance),
    totalInitialMargin: safeNum(raw.totalInitialMargin),
    totalMaintMargin: safeNum(raw.totalMaintMargin),
    availableBalance: safeNum(raw.availableBalance),
  };
}

/** Task 9 — purely descriptive derived metric, never exchange truth, never used as a hard Risk
 * Guard rule this sprint (Task 26). null unless both markPrice and liquidationPrice are valid. */
function computeDistanceToLiquidationPct(side: 'LONG' | 'SHORT', markPrice: number | null, liquidationPrice: number | null): number | null {
  if (markPrice === null || liquidationPrice === null || markPrice <= 0 || liquidationPrice <= 0) return null;
  const pct = side === 'LONG' ? ((markPrice - liquidationPrice) / markPrice) * 100 : ((liquidationPrice - markPrice) / markPrice) * 100;
  return Number.isFinite(pct) ? pct : null;
}

/** Task 3/33 — pure, exported, independently testable. Builds full position detail primarily from
 * /fapi/v2/positionRisk (the only source with liquidationPrice/marginType/breakEvenPrice/leverage —
 * Task 1's verified finding), then merges position-level margin fields (positionInitialMargin/
 * maintenanceMargin) from the account endpoint's own positions[] by symbol match — never merges an
 * ACCOUNT-level total into a position's own fields (Task 5). */
export function normalizePositionRisk(positionRiskRaw: BinancePositionRiskRaw[], accountPositions: BinanceAccountPositionRaw[]): ExchangePositionSnapshot[] {
  const marginBySymbol = new Map<string, { positionInitialMargin: number | null; maintenanceMargin: number | null }>();
  (accountPositions || []).forEach((p) => {
    marginBySymbol.set(p.symbol, { positionInitialMargin: p.initialMargin !== undefined ? safeNum(p.initialMargin) : null, maintenanceMargin: p.maintMargin !== undefined ? safeNum(p.maintMargin) : null });
  });

  return (positionRiskRaw || [])
    .map((p): ExchangePositionSnapshot | null => {
      const amt = safeNum(p.positionAmt);
      if (amt === null || amt === 0) return null; // zero/malformed quantity — not an open position
      const side: 'LONG' | 'SHORT' = amt > 0 ? 'LONG' : 'SHORT';
      const markPrice = p.markPrice !== undefined ? safeNum(p.markPrice) : null;
      const liquidationPrice = p.liquidationPrice !== undefined ? safeLiquidationPrice(p.liquidationPrice) : null;
      const margin = marginBySymbol.get(p.symbol) || { positionInitialMargin: null, maintenanceMargin: null };
      return {
        symbol: p.symbol,
        side,
        quantity: Math.abs(amt),
        entryPrice: safeNum(p.entryPrice),
        markPrice,
        notional: p.notional !== undefined ? safeNum(p.notional) : null,
        unrealizedPnl: p.unRealizedProfit !== undefined ? safeNum(p.unRealizedProfit) : null,
        leverage: p.leverage !== undefined ? safeNum(p.leverage) : null,
        marginType: typeof p.marginType === 'string' && p.marginType ? p.marginType.toUpperCase() : null,
        isolatedMargin: p.isolatedMargin !== undefined ? safeNum(p.isolatedMargin) : null,
        positionInitialMargin: margin.positionInitialMargin,
        maintenanceMargin: margin.maintenanceMargin,
        liquidationPrice,
        breakEvenPrice: p.breakEvenPrice !== undefined ? safeNum(p.breakEvenPrice) : null,
        positionSide: p.positionSide || null,
        distanceToLiquidationPct: computeDistanceToLiquidationPct(side, markPrice, liquidationPrice),
        protection: { stopLossOrders: [], takeProfitOrders: [], trailingStopOrders: [], otherOrders: [] },
      };
    })
    .filter((p): p is ExchangePositionSnapshot => p !== null);
}

export function normalizeProtectiveOrders(raw: BinanceAlgoOrderRaw[]): ExchangeProtectiveOrder[] {
  return (raw || []).map((o) => ({
    exchangeOrderId: String(o.algoId),
    symbol: o.symbol,
    side: o.side === 'SELL' ? 'SELL' : 'BUY', // defensive default; Binance always returns BUY|SELL here
    orderType: o.orderType || 'UNKNOWN',
    status: o.algoStatus || 'UNKNOWN',
    triggerPrice: o.triggerPrice !== undefined ? safeNum(o.triggerPrice) : null,
    price: o.price !== undefined ? safeNum(o.price) : null,
    quantity: o.quantity !== undefined ? safeNum(o.quantity) : null,
    closePosition: typeof o.closePosition === 'boolean' ? o.closePosition : null,
    reduceOnly: typeof o.reduceOnly === 'boolean' ? o.reduceOnly : null,
    createdAt: o.createTime ? new Date(o.createTime).toISOString() : null,
    positionSide: o.positionSide || null,
  }));
}

/** Task 12 — order type is the PRIMARY semantic source, never trigger-price-vs-current-price.
 * A LONG position's protective close orders should be SELL; a SHORT position's should be BUY.
 * Inconsistent/ambiguous side-vs-direction relationships classify OTHER rather than guessing. */
export function classifyPositionProtection(order: ExchangeProtectiveOrder, positionSide: 'LONG' | 'SHORT'): PositionProtectionKind {
  const expectedCloseSide = positionSide === 'LONG' ? 'SELL' : 'BUY';
  if (order.side !== expectedCloseSide) return 'OTHER';
  const t = order.orderType;
  if (t === 'STOP_MARKET' || t === 'STOP') return 'STOP_LOSS';
  if (t === 'TAKE_PROFIT_MARKET' || t === 'TAKE_PROFIT') return 'TAKE_PROFIT';
  if (t === 'TRAILING_STOP_MARKET') return 'TRAILING_STOP';
  return 'OTHER';
}

function attachProtection(positions: ExchangePositionSnapshot[], protectiveOrders: ExchangeProtectiveOrder[]): void {
  positions.forEach((pos) => {
    protectiveOrders.filter((o) => o.symbol === pos.symbol).forEach((o) => {
      const kind = classifyPositionProtection(o, pos.side);
      if (kind === 'STOP_LOSS') pos.protection.stopLossOrders.push(o);
      else if (kind === 'TAKE_PROFIT') pos.protection.takeProfitOrders.push(o);
      else if (kind === 'TRAILING_STOP') pos.protection.trailingStopOrders.push(o);
      else pos.protection.otherOrders.push(o);
    });
  });
}

/** Task 11/33 (3.5B, extended 3.5C) — pure normalization, exported and independently testable
 * against synthetic fixtures. Filters zero-balance assets and zero-quantity positions (Binance
 * returns every tradable symbol regardless of whether a position exists) so the frontend never has
 * to re-derive this filtering itself. */
export function normalizeBinanceFuturesAccount(
  connectionId: string, environment: ExchangeEnvironment,
  accountRaw: BinanceAccountRaw, positionRiskRaw: BinancePositionRiskRaw[], algoOrdersRaw: BinanceAlgoOrderRaw[],
  protectionReadStatus: ProtectionReadStatus = 'OK',
): ExchangeAccountSnapshot {
  const balances = normalizeBalances(accountRaw.assets);
  const positions = normalizePositionRisk(positionRiskRaw, accountRaw.positions);
  const protectiveOrders = normalizeProtectiveOrders(algoOrdersRaw);
  attachProtection(positions, protectiveOrders);

  return {
    connectionId, exchange: 'binance-futures', environment,
    fetchedAt: new Date().toISOString(),
    account: { canTrade: typeof accountRaw.canTrade === 'boolean' ? accountRaw.canTrade : null },
    accountRisk: normalizeAccountRisk(accountRaw),
    balances, positions, protectiveOrders, protectionReadStatus,
  };
}

/** Task 9 (3.5B) — the smallest authenticated read-only request: a single /fapi/v2/account call,
 * response discarded. Never places a test order. Unchanged in 3.5C — Test Connection intentionally
 * stays the cheapest possible signed read, not the full 3-endpoint snapshot fetch. */
export async function testBinanceFuturesConnection(creds: BinanceFuturesCredentials): Promise<{ ok: true; latencyMs: number } | { ok: false; error: ExchangeErrorInfo }> {
  const started = Date.now();
  try {
    await signedGet<BinanceAccountRaw>(BASE_URLS[creds.environment], creds.environment, '/fapi/v2/account', creds);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, error: classifyBinanceError(err) };
  }
}

/** Hotfix (3.5C.2), Task 6 — Binance's own docs warn that GET /fapi/v1/openAlgoOrders carries
 * request weight 40 with `symbol` omitted vs weight 1 with it supplied; this app previously always
 * omitted it, unconditionally querying the WHOLE account's algo orders even for a single open
 * position (or none at all) — very likely the actual cause of the observed hang/slowness on
 * TESTNET. Now scoped to exactly the distinct symbols with an open position (deduped — hedge-mode
 * LONG+SHORT on the same symbol must not double-query it), fetched independently per symbol via
 * Promise.allSettled so one symbol's failure never discards another symbol's successful read (Task
 * 12's "partial protection retained"). Zero open positions -> zero requests, per Task 6's explicit
 * "if no positions: do not call openAlgoOrders at all". */
async function fetchProtectiveOrdersForSymbols(baseUrl: string, environment: ExchangeEnvironment, creds: BinanceFuturesCredentials, offset: number, symbols: string[]): Promise<{ raw: BinanceAlgoOrderRaw[]; status: ProtectionReadStatus }> {
  if (symbols.length === 0) return { raw: [], status: 'OK' };
  const results = await Promise.allSettled(
    symbols.map((symbol) => timedRead(`openAlgoOrders(${symbol})`, () => signedGetWithOffset<BinanceAlgoOrderRaw[]>(baseUrl, '/fapi/v1/openAlgoOrders', creds, offset, { symbol }))),
  );
  const raw: BinanceAlgoOrderRaw[] = [];
  let anyTimeout = false, anyOtherFailure = false;
  results.forEach((r) => {
    if (r.status === 'fulfilled') raw.push(...r.value);
    else if ((r.reason as any)?.timedOut) anyTimeout = true;
    else anyOtherFailure = true;
  });
  const status: ProtectionReadStatus = anyTimeout ? 'TIMEOUT' : anyOtherFailure ? 'UNAVAILABLE' : 'OK';
  return { raw, status };
}

/** Task 18/28 (3.5C) — account + positionRisk are both REQUIRED (either failing fails the whole
 * snapshot, matching Task 27's "account fetch fails -> BLOCK" at the Risk Guard layer above this).
 * Protective algo orders are fetched BEST-EFFORT and now symbol-scoped (see
 * fetchProtectiveOrdersForSymbols() above) — a failure there degrades to whatever succeeded plus an
 * honest `protectionReadStatus` (Task 4/5 of this hotfix), never silently treated as "confirmed no
 * protection." The server-time offset is cached per environment (Task 8 of this hotfix) so a normal
 * refresh reuses it across all calls instead of re-syncing before every single one. */
export async function getBinanceFuturesAccountSnapshot(connectionId: string, creds: BinanceFuturesCredentials): Promise<{ ok: true; snapshot: ExchangeAccountSnapshot } | { ok: false; error: ExchangeErrorInfo }> {
  const baseUrl = BASE_URLS[creds.environment];
  let offset: number;
  try {
    offset = await getServerTimeOffsetCached(baseUrl, creds.environment, creds);
  } catch (err) {
    return { ok: false, error: classifyBinanceError(err) };
  }

  const fetchAccountAndPositionRisk = (o: number) => Promise.all([
    timedRead('account', () => signedGetWithOffset<BinanceAccountRaw>(baseUrl, '/fapi/v2/account', creds, o)),
    timedRead('positionRisk', () => signedGetWithOffset<BinancePositionRiskRaw[]>(baseUrl, '/fapi/v2/positionRisk', creds, o)),
  ]);

  let accountRaw: BinanceAccountRaw;
  let positionRiskRaw: BinancePositionRiskRaw[];
  try {
    [accountRaw, positionRiskRaw] = await fetchAccountAndPositionRisk(offset);
  } catch (err: any) {
    // Hotfix (3.5C.1), Task 6/10 — at most ONE retry, and only for timestamp drift specifically;
    // any other error (credentials/permission/rate-limit/network/timeout) fails immediately, no retry.
    if (err?.binanceCode !== -1021) return { ok: false, error: classifyBinanceError(err) };
    try {
      offset = await getServerTimeOffsetCached(baseUrl, creds.environment, creds, true);
      [accountRaw, positionRiskRaw] = await fetchAccountAndPositionRisk(offset);
    } catch (err2) {
      return { ok: false, error: classifyBinanceError(err2) };
    }
  }

  // Task 6 — scope the (optional, best-effort) protective-order read to exactly the symbols with a
  // real open position, deduped (hedge-mode LONG+SHORT on one symbol must not double-query it), and
  // skip the call entirely when there are none.
  const openSymbols = Array.from(new Set((positionRiskRaw || []).filter((p) => { const amt = safeNum(p.positionAmt); return amt !== null && amt !== 0; }).map((p) => p.symbol)));
  const { raw: algoOrdersRaw, status: protectionReadStatus } = await fetchProtectiveOrdersForSymbols(baseUrl, creds.environment, creds, offset, openSymbols);

  return { ok: true, snapshot: normalizeBinanceFuturesAccount(connectionId, creds.environment, accountRaw, positionRiskRaw, algoOrdersRaw, protectionReadStatus) };
}

interface BinanceOrderRaw {
  orderId: number | string; clientOrderId?: string; symbol: string; status: string; side: string;
  positionSide?: string; type: string; origType?: string; origQty?: string; price?: string;
  avgPrice?: string; executedQty?: string; stopPrice?: string; reduceOnly?: boolean;
  closePosition?: boolean; time?: number; updateTime?: number;
}

/** Sprint 3.5D-A, Task 4 — pure, exported, independently testable. `avgPrice`/`price` follow
 * Binance's own "0" convention for "not applicable yet" (no fill / pure MARKET order) -> null, never
 * a fabricated real 0 price (same rule as `safeLiquidationPrice()` above). `executedQuantity` is
 * never null — 0 is itself a meaningful, real "no fill yet" value, unlike price. */
export function normalizeExchangeOrder(raw: BinanceOrderRaw): ExchangeOrderSnapshot {
  const avgPrice = safeNum(raw.avgPrice);
  const price = safeNum(raw.price);
  return {
    exchangeOrderId: String(raw.orderId),
    clientOrderId: raw.clientOrderId || null,
    symbol: raw.symbol,
    side: raw.side === 'SELL' ? 'SELL' : 'BUY',
    orderType: raw.type || raw.origType || 'UNKNOWN',
    status: raw.status || 'UNKNOWN',
    originalQuantity: raw.origQty !== undefined ? safeNum(raw.origQty) : null,
    executedQuantity: safeNum(raw.executedQty) ?? 0,
    averagePrice: avgPrice !== null && avgPrice > 0 ? avgPrice : null,
    price: price !== null && price > 0 ? price : null,
    stopPrice: raw.stopPrice !== undefined ? safeNum(raw.stopPrice) : null,
    reduceOnly: typeof raw.reduceOnly === 'boolean' ? raw.reduceOnly : null,
    closePosition: typeof raw.closePosition === 'boolean' ? raw.closePosition : null,
    createdAt: raw.time ? new Date(raw.time).toISOString() : null,
    updatedAt: raw.updateTime ? new Date(raw.updateTime).toISOString() : null,
  };
}

/** Sprint 3.5D-A, Task 3/23 — the ONLY read for one already-known exchange order (`GET
 * /fapi/v1/order`, weight 1, verified against live Binance USDT-M Futures docs 2026-08-09). Never
 * queries by an arbitrary user-entered id — the caller (exchangeService.fetchExchangeOrderSnapshot)
 * only ever passes an exchangeOrderId already associated with a local RealOrder (Task 23), never one
 * typed fresh by a user. Uses signedGet() — same offset cache + at-most-one -1021 retry as every
 * other read in this module, no second/parallel signing path. This function itself is read-only;
 * still no placeOrder/amendOrder anywhere in this file (Sprint 3.5D-D adds a real cancel capability
 * elsewhere in this file — see `cancelBinanceFuturesTestnetOrder()` — this GET is not it). */
export interface OrderLookupId { orderId?: string; origClientOrderId?: string }
export async function getBinanceFuturesOrder(creds: BinanceFuturesCredentials, symbol: string, lookup: OrderLookupId): Promise<{ ok: true; snapshot: ExchangeOrderSnapshot } | { ok: false; error: ExchangeErrorInfo }> {
  // Sprint 3.5D-B, Task 27 recovery path — accepts EITHER identifier (Binance supports both natively
  // on the same endpoint). `origClientOrderId` lookup exists specifically so an ambiguous submission
  // (network failure/timeout AFTER the POST may have reached Binance) can be resolved by the
  // clientOrderId this app generated and already knows, even with no exchangeOrderId yet.
  const extraParams: Record<string, string> = lookup.orderId ? { orderId: lookup.orderId } : { origClientOrderId: lookup.origClientOrderId! };
  try {
    const raw = await signedGet<BinanceOrderRaw>(BASE_URLS[creds.environment], creds.environment, '/fapi/v1/order', creds, { symbol: toBinanceFuturesSymbol(symbol), ...extraParams });
    return { ok: true, snapshot: normalizeExchangeOrder(raw) };
  } catch (err) {
    return { ok: false, error: classifyBinanceError(err) };
  }
}

// ================================================================================================
// Sprint 3.5D-B — the FIRST write capability in this module: POST /fapi/v1/order, TESTNET only.
// Enforced backend-side (never a frontend-only gate) at THREE independent layers: here
// (submitBinanceFuturesEntryOrder), in exchangeService.submitEntryOrderToBinanceTestnet, and again by
// server.ts's route validation — see EXECUTION_SPEC.md's "Real Order Submission" section for the
// full boundary. Sprint 3.5D-D adds a SECOND write (DELETE /fapi/v1/order, cancellation — see its own
// banner comment further below). Still no amendOrder/replaceOrder/setLeverage/setMarginType/
// transfer/withdraw/protective-order-write anywhere in this file.
// ================================================================================================

interface BinanceExchangeInfoFilterRaw { filterType: string; stepSize?: string; minQty?: string; maxQty?: string; notional?: string; tickSize?: string; minPrice?: string; maxPrice?: string }
interface BinanceExchangeInfoSymbolRaw { symbol: string; filters: BinanceExchangeInfoFilterRaw[] }
interface BinanceExchangeInfoRaw { symbols: BinanceExchangeInfoSymbolRaw[] }

/** Task 10 — `GET /fapi/v1/exchangeInfo` (public, unauthenticated, weight 1; verified against live
 * docs 2026-08-09). Task 10 "cache briefly if useful": per-environment, 30-minute TTL — filters
 * change rarely (a symbol's step/notional rules), but never cached forever, so a genuine exchange
 * change is picked up within a bounded window rather than requiring a process restart. */
const EXCHANGE_INFO_CACHE_TTL_MS = 30 * 60 * 1000;
const exchangeInfoCache: Partial<Record<ExchangeEnvironment, { bySymbol: Map<string, BinanceExchangeInfoSymbolRaw>; fetchedAt: number }>> = {};
async function getExchangeInfoSymbol(baseUrl: string, environment: ExchangeEnvironment, symbol: string): Promise<BinanceExchangeInfoSymbolRaw | null> {
  const cached = exchangeInfoCache[environment];
  if (cached && Date.now() - cached.fetchedAt < EXCHANGE_INFO_CACHE_TTL_MS) return cached.bySymbol.get(symbol) || null;
  const { fetchJson } = await import('../util/http.js');
  const data = await fetchJson<BinanceExchangeInfoRaw>(`${baseUrl}/fapi/v1/exchangeInfo`, { timeoutMs: BINANCE_READ_TIMEOUT_MS });
  const bySymbol = new Map<string, BinanceExchangeInfoSymbolRaw>();
  for (const s of data.symbols || []) bySymbol.set(s.symbol, s);
  exchangeInfoCache[environment] = { bySymbol, fetchedAt: Date.now() };
  return bySymbol.get(symbol) || null;
}

/** Task 8/10 — extracts exactly the filters this app validates against; never hardcodes a step size
 * for any symbol (Task 10's explicit "do not hardcode BTC step size"). Returns null fields for a
 * filter type the symbol doesn't carry (e.g. no separate MARKET_LOT_SIZE) rather than guessing. */
export function extractSymbolFilters(symbolInfo: BinanceExchangeInfoSymbolRaw): import('./orderSizing.js').BinanceSymbolFilters {
  const find = (t: string) => symbolInfo.filters.find((f) => f.filterType === t);
  const lot = find('LOT_SIZE');
  const marketLot = find('MARKET_LOT_SIZE');
  const minNotional = find('MIN_NOTIONAL') || find('NOTIONAL'); // Binance has used both names across API generations — accept either, never assume one
  return {
    stepSize: safeNum(lot?.stepSize) ?? NaN,
    minQty: safeNum(lot?.minQty) ?? NaN,
    maxQty: safeNum(lot?.maxQty) ?? NaN,
    marketStepSize: marketLot ? safeNum(marketLot.stepSize) : null,
    marketMinQty: marketLot ? safeNum(marketLot.minQty) : null,
    marketMaxQty: marketLot ? safeNum(marketLot.maxQty) : null,
    minNotional: minNotional ? safeNum(minNotional.notional) : null,
  };
}

/** Task 13 — reads the account's REAL, already-configured leverage for one symbol without ever
 * calling set-leverage. Scoped to one symbol (`?symbol=`) specifically so it works even with zero
 * open position — `/fapi/v2/account`'s positions[] only lists symbols with an existing
 * position/open order (verified against live docs 2026-08-09), which would make leverage
 * unreadable for a fresh entry; `/fapi/v2/positionRisk?symbol=` is queried instead, and also
 * supplies `markPrice` in the same call — reused as the MARKET order's fresh reference price (Task
 * 9), avoiding a second read. Binance's docs don't clearly guarantee a row is always returned for a
 * zero-position symbol — if none comes back, leverage is treated as unverifiable (`null`), and the
 * caller BLOCKs per Task 13's explicit instruction rather than assuming a default. */
async function getSymbolLeverageAndMarkPrice(baseUrl: string, environment: ExchangeEnvironment, creds: BinanceFuturesCredentials, offset: number, symbol: string): Promise<{ leverage: number | null; markPrice: number | null }> {
  const rows = await signedGetWithOffset<BinancePositionRiskRaw[]>(baseUrl, '/fapi/v2/positionRisk', creds, offset, { symbol });
  if (!rows || rows.length === 0) return { leverage: null, markPrice: null };
  const row = rows[0];
  return { leverage: safeNum((row as any).leverage), markPrice: row.markPrice !== undefined ? safeNum(row.markPrice) : null };
}

export interface EntryOrderAdapterParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  quantity: number;
  price?: number; // required for LIMIT, ignored for MARKET
  newClientOrderId: string;
}

/** Task 1-3/16-18 — the ONE write call. TESTNET hard guard re-checked HERE too (defense in depth —
 * exchangeService also enforces it before calling this function; neither layer trusts the other
 * alone). Exactly ONE POST attempt, no retry wrapper of any kind (Task 27/28): the clock is
 * force-resynced immediately before submitting (bypassing the read-path's cache, since a write is
 * too consequential to risk a stale offset) but a -1021 rejection here is a clean, deterministic
 * "no order created" — never auto-resubmitted; the caller may choose to retry manually. A
 * timeout/network failure, by contrast, is genuinely ambiguous (the POST may have reached Binance
 * before the response was lost) and is reported as `submission_status_unknown` with `ambiguous:true`
 * — the caller must never treat this the same as a clean rejection. */
export async function submitBinanceFuturesEntryOrder(creds: BinanceFuturesCredentials, params: EntryOrderAdapterParams): Promise<{ ok: true; snapshot: ExchangeOrderSnapshot } | { ok: false; error: ExchangeErrorInfo; ambiguous?: boolean }> {
  if (creds.environment !== 'TESTNET') {
    return { ok: false, error: { code: 'live_order_submission_not_supported', message: '当前版本不支持 LIVE 环境下单，仅支持 TESTNET' } };
  }
  const baseUrl = BASE_URLS[creds.environment];

  let offset: number;
  try {
    offset = await getServerTimeOffsetCached(baseUrl, creds.environment, creds, true); // Task 28 — always force-fresh before a write, never the cached read-path offset
  } catch (err) {
    return { ok: false, error: classifyBinanceError(err) };
  }

  const extraParams: Record<string, string | number> = {
    symbol: params.symbol, side: params.side, type: params.type, quantity: params.quantity, newClientOrderId: params.newClientOrderId,
  };
  if (params.type === 'LIMIT') {
    extraParams.price = params.price!;
    extraParams.timeInForce = 'GTC';
  }

  try {
    const raw = await timedRead('submitEntryOrder', () => signedPostWithOffset<BinanceOrderRaw>(baseUrl, '/fapi/v1/order', creds, offset, extraParams));
    return { ok: true, snapshot: normalizeExchangeOrder(raw) };
  } catch (err: any) {
    if (err?.timedOut || err?.networkError) {
      // Task 27 — the single most important branch in this file: never assume rejection, never retry.
      return { ok: false, ambiguous: true, error: { code: 'submission_status_unknown', message: '订单提交结果未知，请先同步/查询交易所订单，避免重复下单。' } };
    }
    return { ok: false, error: classifyBinanceError(err) }; // deterministic HTTP-level rejection — no order was created, safe for the user to retry manually
  }
}

/** Task 9-14/25 — the full resolve-then-submit orchestration: structural validation -> exchangeInfo
 * filters -> real configured leverage + fresh mark price (one combined read) -> leverage-match check
 * -> deterministic quantity sizing/rounding/validation -> exactly one submission attempt. Every BLOCK
 * here happens BEFORE any write request reaches Binance (Task 12). This is the single entry point
 * exchangeService.submitEntryOrderToBinanceTestnet() calls — kept in this file (not exchangeService)
 * because every step needs baseUrl/offset-cache internals that are private to this module. */
export async function resolveAndSubmitEntryOrder(creds: BinanceFuturesCredentials, request: EntryOrderSubmissionRequest): Promise<{ ok: true; snapshot: ExchangeOrderSnapshot } | { ok: false; error: ExchangeErrorInfo; ambiguous?: boolean; leverageMismatch?: { symbol: string; current: number; required: number } }> {
  if (creds.environment !== 'TESTNET') {
    return { ok: false, error: { code: 'live_order_submission_not_supported', message: '当前版本不支持 LIVE 环境下单，仅支持 TESTNET' } };
  }
  const baseUrl = BASE_URLS[creds.environment];

  // Task 25 — structural safety, enforced here regardless of what the frontend already checked.
  if (!request.symbol) return { ok: false, error: { code: 'invalid_request', message: '缺少交易对 symbol' } };
  if (request.side !== 'BUY' && request.side !== 'SELL') return { ok: false, error: { code: 'invalid_request', message: 'side 必须为 BUY 或 SELL' } };
  if (request.orderType !== 'MARKET' && request.orderType !== 'LIMIT') return { ok: false, error: { code: 'invalid_request', message: 'orderType 必须为 MARKET 或 LIMIT（本版本不支持其他类型）' } };
  if (request.orderType === 'LIMIT' && !(Number.isFinite(request.limitPrice as number) && (request.limitPrice as number) > 0)) return { ok: false, error: { code: 'invalid_request', message: '限价单缺少有效的 limitPrice' } };
  if (!Number.isFinite(request.positionSizeUsdt) || request.positionSizeUsdt <= 0) return { ok: false, error: { code: 'invalid_request', message: '仓位大小（USDT）无效' } };
  if (!Number.isFinite(request.leverage) || request.leverage <= 0) return { ok: false, error: { code: 'invalid_request', message: '杠杆倍数无效' } };
  if (!request.localOrderId || !/^[.A-Za-z0-9_:/-]{1,36}$/.test(request.localOrderId)) return { ok: false, error: { code: 'invalid_request', message: '本地订单编号不符合交易所 newClientOrderId 格式要求' } };

  // Hotfix — normalized exactly once here; every downstream call in this function (exchangeInfo,
  // leverage/markPrice read, the final submit) uses this same value, never `request.symbol` again.
  // `request.symbol`/`RealOrder.symbol` itself is never rewritten — this is a local conversion, not a
  // mutation of anything persisted or displayed.
  const binanceSymbol = toBinanceFuturesSymbol(request.symbol);

  let offset: number;
  try {
    offset = await getServerTimeOffsetCached(baseUrl, creds.environment, creds, true);
  } catch (err) {
    return { ok: false, error: classifyBinanceError(err) };
  }

  let symbolInfo: BinanceExchangeInfoSymbolRaw | null;
  try {
    symbolInfo = await getExchangeInfoSymbol(baseUrl, creds.environment, binanceSymbol);
  } catch (err) {
    return { ok: false, error: { code: 'exchange_info_unavailable', message: '无法读取交易对规则（exchangeInfo），无法安全计算下单数量' } };
  }
  if (!symbolInfo) return { ok: false, error: { code: 'exchange_info_unavailable', message: `未找到 ${binanceSymbol} 的 Binance Futures 交易规则` } };
  const filters = extractSymbolFilters(symbolInfo);
  if (!Number.isFinite(filters.stepSize) || !Number.isFinite(filters.minQty) || !Number.isFinite(filters.maxQty)) {
    return { ok: false, error: { code: 'exchange_info_unavailable', message: '交易对缺少必要的数量过滤器（LOT_SIZE）' } };
  }

  let leverage: number | null, markPrice: number | null;
  try {
    const r = await getSymbolLeverageAndMarkPrice(baseUrl, creds.environment, creds, offset, binanceSymbol);
    leverage = r.leverage; markPrice = r.markPrice;
  } catch (err) {
    return { ok: false, error: classifyBinanceError(err) };
  }
  // Task 13 — never call set-leverage; a mismatch (or an unreadable value) BLOCKs instead.
  if (leverage === null) return { ok: false, error: { code: 'leverage_unverifiable', message: '无法读取交易所当前杠杆设置，为避免隐性风险已阻止提交' } };
  // Sprint 3.6A — still never calls set-leverage itself (that stays the frontend's explicit,
  // user-confirmed leverage-sync flow, see changeLeverageOnBinanceTestnet) — but now reports the
  // real current vs. required leverage so the caller can OFFER that recovery instead of a dead end.
  if (leverage !== request.leverage) return { ok: false, error: { code: 'leverage_mismatch', message: '当前执行计划杠杆与交易所当前杠杆设置不一致。' }, leverageMismatch: { symbol: binanceSymbol, current: leverage, required: request.leverage } };

  const referencePrice = request.orderType === 'LIMIT' ? (request.limitPrice as number) : markPrice;
  if (referencePrice === null || !Number.isFinite(referencePrice) || referencePrice <= 0) {
    return { ok: false, error: { code: 'reference_price_unavailable', message: '无法获取有效的市场参考价格，无法计算下单数量' } };
  }

  const sizing = resolveEntryQuantity(request.orderType, request.positionSizeUsdt, referencePrice, filters);
  if (!sizing.ok) return { ok: false, error: { code: 'invalid_quantity', message: sizing.reason } };

  return submitBinanceFuturesEntryOrder(creds, {
    symbol: binanceSymbol, side: request.side, type: request.orderType, quantity: sizing.quantity,
    price: request.orderType === 'LIMIT' ? (request.limitPrice as number) : undefined,
    newClientOrderId: request.localOrderId,
  });
}

// ================================================================================================
// Sprint 3.5D-D — the SECOND write capability in this module: DELETE /fapi/v1/order, TESTNET only.
// Same three-independent-layer TESTNET guard discipline as submission (here, exchangeService's
// cancelEntryOrderOnBinanceTestnet, and server.ts's route). Still no amendOrder/replaceOrder/
// setLeverage/setMarginType/transfer/withdraw/protective-order-write anywhere in this file — this
// adds exactly one new capability, nothing else.
// ================================================================================================

export interface CancelOrderAdapterParams {
  symbol: string;
  exchangeOrderId: string;
}

/** Task 9 — the ONE cancel call. Input is deliberately narrow (symbol + exchangeOrderId only, never
 * an arbitrary payload) — connection/credentials/environment all come from the caller's already-
 * resolved `creds`. TESTNET hard guard re-checked HERE too (defense in depth, same pattern as
 * `submitBinanceFuturesEntryOrder()`). Exactly ONE DELETE attempt, no retry wrapper (Task 10/11): the
 * clock is force-resynced immediately before the call (never the read-path's cached offset) but a
 * deterministic HTTP-level rejection (e.g. -2011 "already filled/cancelled/unknown") is a clean,
 * final outcome — never retried, the caller decides what to do next (typically: sync to learn the
 * real current state). A timeout/network failure is genuinely ambiguous (the DELETE may have reached
 * Binance before the response was lost) and is reported as `cancellation_status_unknown` with
 * `ambiguous:true` — never auto-retried, never silently treated as "not cancelled." */
export async function cancelBinanceFuturesTestnetOrder(creds: BinanceFuturesCredentials, params: CancelOrderAdapterParams): Promise<{ ok: true; snapshot: ExchangeOrderSnapshot } | { ok: false; error: ExchangeErrorInfo; ambiguous?: boolean }> {
  if (creds.environment !== 'TESTNET') {
    return { ok: false, error: { code: 'live_order_cancellation_not_supported', message: '当前版本不支持 LIVE 环境撤单，仅支持 TESTNET' } };
  }
  const baseUrl = BASE_URLS[creds.environment];

  if (!params.symbol) return { ok: false, error: { code: 'invalid_request', message: '缺少交易对 symbol' } };
  if (!params.exchangeOrderId || !/^\d+$/.test(String(params.exchangeOrderId))) {
    return { ok: false, error: { code: 'invalid_request', message: '订单编号（exchangeOrderId）格式不正确' } };
  }

  const binanceSymbol = toBinanceFuturesSymbol(params.symbol);

  let offset: number;
  try {
    offset = await getServerTimeOffsetCached(baseUrl, creds.environment, creds, true); // Task 11 — always force-fresh before a write, never the cached read-path offset
  } catch (err) {
    return { ok: false, error: classifyBinanceError(err) };
  }

  try {
    const raw = await timedRead('cancelOrder', () => signedDeleteWithOffset<BinanceOrderRaw>(baseUrl, '/fapi/v1/order', creds, offset, { symbol: binanceSymbol, orderId: params.exchangeOrderId }));
    return { ok: true, snapshot: normalizeExchangeOrder(raw) };
  } catch (err: any) {
    if (err?.timedOut || err?.networkError) {
      // Task 10/26 — never assume the cancellation went through OR didn't; never retried.
      return { ok: false, ambiguous: true, error: { code: 'cancellation_status_unknown', message: '撤单结果未知，请先查询交易所订单状态，避免重复操作。' } };
    }
    return { ok: false, error: classifyBinanceError(err) }; // deterministic HTTP-level rejection — safe for the caller to re-verify current state, never auto-retried
  }
}

// ================================================================================================
// Sprint 3.5D-E — real protective (STOP_LOSS/TAKE_PROFIT) orders via Binance's Algo Service. Before
// Coding research (2026-08-10, verified live against developers.binance.com and cross-checked
// against the tiagosiebler/binance TypeScript connector's actual implementation — not assumed from
// memory or from this codebase's own pre-existing READ-only comments):
//   CREATE: POST /fapi/v1/algoOrder   (algoType=CONDITIONAL; type=STOP_MARKET|TAKE_PROFIT_MARKET|
//           STOP|TAKE_PROFIT|TRAILING_STOP_MARKET — this app only ever sends STOP_MARKET/
//           TAKE_PROFIT_MARKET). quantity and closePosition are mutually exclusive; reduceOnly cannot
//           be sent in Hedge Mode and cannot combine with closePosition; clientAlgoId is optional
//           (auto-generated if omitted) — this app always sends one explicitly (Task Q dedup).
//   QUERY:  GET /fapi/v1/algoOrder    (either algoId or clientAlgoId required; symbol NOT required)
//   CANCEL: DELETE /fapi/v1/algoOrder (either algoId or clientAlgoId required; symbol NOT required —
//           this genuinely differs from the plain-order cancel endpoint, which DOES require symbol;
//           confirmed via two independent sources, not assumed to mirror the plain-order shape)
// GET /fapi/v1/openAlgoOrders (already used by the pre-existing read-only account-snapshot path) is
// unchanged and remains correct — this section adds CREATE/CANCEL/single-QUERY only. Still no
// amendOrder/replaceOrder/setLeverage/setMarginType/transfer/withdraw anywhere in this file.
// ================================================================================================

/** Sprint 3.5D-E, Task L/M — reuses `roundDownToStep`+LOT_SIZE filters exactly like entry sizing;
 * `quantity` is always an explicit, verifiable value (never `closePosition=true`), so "protection
 * quantity never exceeds real position quantity" stays checkable by the caller (frontend) both
 * before submission and via the returned snapshot afterward. */
export function normalizeAlgoOrderSubmission(raw: BinanceAlgoOrderRaw): ExchangeAlgoOrderSnapshot {
  return {
    algoId: String(raw.algoId),
    clientAlgoId: raw.clientAlgoId || null,
    symbol: raw.symbol,
    side: raw.side === 'SELL' ? 'SELL' : 'BUY',
    positionSide: raw.positionSide || null,
    orderType: raw.orderType || 'UNKNOWN',
    algoStatus: raw.algoStatus || 'UNKNOWN',
    triggerPrice: raw.triggerPrice !== undefined ? safeNum(raw.triggerPrice) : null,
    quantity: raw.quantity !== undefined ? safeNum(raw.quantity) : null,
    reduceOnly: typeof raw.reduceOnly === 'boolean' ? raw.reduceOnly : null,
    closePosition: typeof raw.closePosition === 'boolean' ? raw.closePosition : null,
    createdAt: raw.createTime ? new Date(raw.createTime).toISOString() : null,
  };
}

export interface ProtectionOrderAdapterParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  triggerPrice: number;
  quantity: number; // already rounded to a valid LOT_SIZE step — never re-derived here
  reduceOnly: boolean;
  clientAlgoId: string;
}

/** Task J/M — the ONE write call that creates a real protective order. TESTNET hard guard re-checked
 * HERE too (defense in depth, identical discipline to `submitBinanceFuturesEntryOrder()`). Exactly
 * ONE POST attempt, no retry wrapper (Task Q/F): a write timeout/network failure is genuinely
 * ambiguous (the order may have reached Binance before the response was lost) and is reported as
 * `protection_submission_status_unknown`, `ambiguous:true` — never auto-retried; recoverable only via
 * `getBinanceFuturesAlgoOrder()` querying by the same `clientAlgoId`. A deterministic HTTP-level
 * rejection (bad params, insufficient margin, `reduceOnly` violation, etc.) means Binance definitely
 * did not create the order — never retried automatically either, the caller decides what to do. */
export async function submitBinanceFuturesProtectionOrder(creds: BinanceFuturesCredentials, params: ProtectionOrderAdapterParams): Promise<{ ok: true; snapshot: ExchangeAlgoOrderSnapshot } | { ok: false; error: ExchangeErrorInfo; ambiguous?: boolean }> {
  if (creds.environment !== 'TESTNET') {
    return { ok: false, error: { code: 'live_order_submission_not_supported', message: '当前版本不支持 LIVE 环境下单，仅支持 TESTNET' } };
  }
  const baseUrl = BASE_URLS[creds.environment];

  let offset: number;
  try {
    offset = await getServerTimeOffsetCached(baseUrl, creds.environment, creds, true);
  } catch (err) {
    return { ok: false, error: classifyBinanceError(err) };
  }

  const extraParams: Record<string, string | number> = {
    algoType: 'CONDITIONAL', symbol: params.symbol, side: params.side, type: params.type,
    triggerPrice: params.triggerPrice, quantity: params.quantity, clientAlgoId: params.clientAlgoId,
    workingType: 'MARK_PRICE', // Task M-adjacent safety default: MARK_PRICE is less susceptible to thin-orderbook wick-triggering than CONTRACT_PRICE (last trade) — a deliberate, documented default, not a Binance-forced requirement
    priceProtect: 'TRUE',
  };
  if (params.positionSide !== 'BOTH') extraParams.positionSide = params.positionSide;
  // Task M — reduceOnly is Binance-forbidden in Hedge Mode; only ever sent in one-way mode.
  if (params.reduceOnly && params.positionSide === 'BOTH') extraParams.reduceOnly = 'TRUE';

  try {
    const raw = await timedRead('submitProtectionOrder', () => signedPostWithOffset<BinanceAlgoOrderRaw>(baseUrl, '/fapi/v1/algoOrder', creds, offset, extraParams));
    return { ok: true, snapshot: normalizeAlgoOrderSubmission(raw) };
  } catch (err: any) {
    if (err?.timedOut || err?.networkError) {
      return { ok: false, ambiguous: true, error: { code: 'protection_submission_status_unknown', message: '保护单提交结果未知，请先查询交易所保护单状态，避免重复提交。' } };
    }
    return { ok: false, error: classifyBinanceError(err) };
  }
}

/** Task L — the resolve-then-submit orchestration for protection orders: structural validation ->
 * exchangeInfo filters -> deterministic LOT_SIZE rounding/validation of the caller-supplied raw
 * quantity -> exactly one submission attempt. Every BLOCK here happens BEFORE any write request
 * reaches Binance. Deliberately simpler than `resolveAndSubmitEntryOrder()` — there is no USDT-
 * notional-to-quantity conversion or leverage-match check here; the caller already knows the target
 * base-asset quantity (a real filled/position amount, or a TP portion of it), computed from local
 * Trade/Order/Position records this backend has no visibility into. */
export async function resolveAndSubmitProtectionOrder(creds: BinanceFuturesCredentials, request: ProtectionOrderSubmissionRequest): Promise<{ ok: true; snapshot: ExchangeAlgoOrderSnapshot } | { ok: false; error: ExchangeErrorInfo; ambiguous?: boolean }> {
  if (creds.environment !== 'TESTNET') {
    return { ok: false, error: { code: 'live_order_submission_not_supported', message: '当前版本不支持 LIVE 环境下单，仅支持 TESTNET' } };
  }
  const baseUrl = BASE_URLS[creds.environment];

  if (!request.symbol) return { ok: false, error: { code: 'invalid_request', message: '缺少交易对 symbol' } };
  if (request.side !== 'BUY' && request.side !== 'SELL') return { ok: false, error: { code: 'invalid_request', message: 'side 必须为 BUY 或 SELL' } };
  if (request.positionSide !== 'BOTH' && request.positionSide !== 'LONG' && request.positionSide !== 'SHORT') {
    return { ok: false, error: { code: 'invalid_request', message: 'positionSide 无效' } };
  }
  if (request.type !== 'STOP_MARKET' && request.type !== 'TAKE_PROFIT_MARKET') {
    return { ok: false, error: { code: 'invalid_request', message: '保护单类型必须为 STOP_MARKET 或 TAKE_PROFIT_MARKET' } };
  }
  if (!Number.isFinite(request.triggerPrice) || request.triggerPrice <= 0) return { ok: false, error: { code: 'invalid_request', message: '触发价格无效' } };
  if (!Number.isFinite(request.quantity) || request.quantity <= 0) return { ok: false, error: { code: 'invalid_request', message: '保护数量无效' } };
  if (!request.clientAlgoId || !/^[.A-Za-z0-9_:/-]{1,32}$/.test(request.clientAlgoId)) {
    return { ok: false, error: { code: 'invalid_request', message: '本地订单编号不符合交易所 clientAlgoId 格式要求' } };
  }
  // Task M — refuse rather than silently drop: Hedge Mode + reduceOnly is a Binance-level rejection
  // waiting to happen, and this app never overrides/reinterprets the caller's stated intent.
  if (request.positionSide !== 'BOTH' && request.reduceOnly) {
    return { ok: false, error: { code: 'invalid_request', message: 'Hedge Mode 下不应发送 reduceOnly' } };
  }

  const binanceSymbol = toBinanceFuturesSymbol(request.symbol);

  let symbolInfo: BinanceExchangeInfoSymbolRaw | null;
  try {
    symbolInfo = await getExchangeInfoSymbol(baseUrl, creds.environment, binanceSymbol);
  } catch (err) {
    return { ok: false, error: { code: 'exchange_info_unavailable', message: '无法读取交易对规则（exchangeInfo），无法安全计算保护单数量' } };
  }
  if (!symbolInfo) return { ok: false, error: { code: 'exchange_info_unavailable', message: `未找到 ${binanceSymbol} 的 Binance Futures 交易规则` } };
  const filters = extractSymbolFilters(symbolInfo);
  if (!Number.isFinite(filters.stepSize) || !Number.isFinite(filters.minQty) || !Number.isFinite(filters.maxQty)) {
    return { ok: false, error: { code: 'exchange_info_unavailable', message: '交易对缺少必要的数量过滤器（LOT_SIZE）' } };
  }

  const sizing = resolveProtectionQuantity(request.quantity, request.triggerPrice, filters);
  if (!sizing.ok) return { ok: false, error: { code: 'invalid_quantity', message: sizing.reason } };

  return submitBinanceFuturesProtectionOrder(creds, {
    symbol: binanceSymbol, side: request.side, positionSide: request.positionSide, type: request.type,
    triggerPrice: request.triggerPrice, quantity: sizing.quantity, reduceOnly: request.reduceOnly, clientAlgoId: request.clientAlgoId,
  });
}

/** Task Q — read-only recovery lookup for an ambiguous protection submission, mirroring
 * `getBinanceFuturesOrder()`'s `origClientOrderId` recovery pattern exactly. `GET /fapi/v1/algoOrder`
 * genuinely does not require `symbol` (confirmed research finding, not assumed from the plain-order
 * endpoint's shape) — accepts algoId or clientAlgoId alone. */
export interface AlgoOrderLookupId { algoId?: string; clientAlgoId?: string }
export async function getBinanceFuturesAlgoOrder(creds: BinanceFuturesCredentials, lookup: AlgoOrderLookupId): Promise<{ ok: true; snapshot: ExchangeAlgoOrderSnapshot } | { ok: false; error: ExchangeErrorInfo }> {
  const extraParams: Record<string, string> = lookup.algoId ? { algoId: lookup.algoId } : { clientAlgoId: lookup.clientAlgoId! };
  try {
    const raw = await signedGet<BinanceAlgoOrderRaw>(BASE_URLS[creds.environment], creds.environment, '/fapi/v1/algoOrder', creds, extraParams);
    return { ok: true, snapshot: normalizeAlgoOrderSubmission(raw) };
  } catch (err) {
    return { ok: false, error: classifyBinanceError(err) };
  }
}

interface BinanceAlgoCancelRaw { algoId: number | string; clientAlgoId?: string; code?: string | number; msg?: string }

/** Task N/Failure-handling — cancels an existing protective order. TESTNET-guarded (defense in
 * depth, same as every other write in this file). `DELETE /fapi/v1/algoOrder` genuinely does not
 * require `symbol` — confirmed research finding, cross-checked against two independent sources. The
 * response is genuinely `{algoId, clientAlgoId, code, msg}` (verified live) — NOT the full order
 * snapshot shape, so this returns `ExchangeAlgoCancelResult`, never a fabricated full snapshot. Same
 * no-auto-retry discipline as `cancelBinanceFuturesTestnetOrder()`: a timeout/network failure is
 * ambiguous and never retried; the caller recovers via `getBinanceFuturesAlgoOrder()`. */
export async function cancelBinanceFuturesProtectionOrder(creds: BinanceFuturesCredentials, params: CancelProtectionOrderRequest): Promise<{ ok: true; result: ExchangeAlgoCancelResult } | { ok: false; error: ExchangeErrorInfo; ambiguous?: boolean }> {
  if (creds.environment !== 'TESTNET') {
    return { ok: false, error: { code: 'live_order_cancellation_not_supported', message: '当前版本不支持 LIVE 环境撤单，仅支持 TESTNET' } };
  }
  if (!params.algoId && !params.clientAlgoId) {
    return { ok: false, error: { code: 'invalid_request', message: '缺少 algoId 或 clientAlgoId' } };
  }
  const baseUrl = BASE_URLS[creds.environment];

  let offset: number;
  try {
    offset = await getServerTimeOffsetCached(baseUrl, creds.environment, creds, true);
  } catch (err) {
    return { ok: false, error: classifyBinanceError(err) };
  }

  const extraParams: Record<string, string> = params.algoId ? { algoId: params.algoId } : { clientAlgoId: params.clientAlgoId! };
  try {
    const raw = await timedRead('cancelProtectionOrder', () => signedDeleteWithOffset<BinanceAlgoCancelRaw>(baseUrl, '/fapi/v1/algoOrder', creds, offset, extraParams));
    return { ok: true, result: { algoId: String(raw.algoId), clientAlgoId: raw.clientAlgoId || null } };
  } catch (err: any) {
    if (err?.timedOut || err?.networkError) {
      return { ok: false, ambiguous: true, error: { code: 'cancellation_status_unknown', message: '撤单结果未知，请先查询交易所保护单状态，避免重复操作。' } };
    }
    return { ok: false, error: classifyBinanceError(err) };
  }
}

// ================================================================================================
// Sprint 3.6A — read-only additions: GET /fapi/v1/openOrders (all currently-open plain orders, the
// "all of them" sibling of Sprint 3.5D-A's single-order GET /fapi/v1/order), plus the FIFTH write
// capability, POST /fapi/v1/leverage (TESTNET only, never invoked automatically — see
// changeBinanceFuturesLeverage()'s own comment). Still no setMarginType/amendOrder/replaceOrder/
// transfer/withdraw anywhere in this file, and no Hedge-Mode-switching call either.
// ================================================================================================

/** Sprint 3.6A — `GET /fapi/v1/openOrders` (verified live 2026-08-10: weight 1 with `symbol`
 * supplied, weight 40 for the whole account without it — same weight-scoping lesson already applied
 * to `openAlgoOrders` in 3.5C.2; `symbol` is optional here since the Account/Portfolio page needs the
 * WHOLE account's open plain orders, not one symbol at a time). Same raw response shape as
 * `GET /fapi/v1/order` (Sprint 3.5D-A) — reuses `normalizeExchangeOrder()` verbatim, never a second,
 * diverging normalizer. Purely additive to the read surface; still no cancel/amend added by this
 * function itself (the existing DELETE /orders/:id route, Sprint 3.5D-D, is reused unchanged for
 * cancelling anything this read surfaces). */
export async function getBinanceFuturesOpenOrders(creds: BinanceFuturesCredentials, symbol?: string): Promise<{ ok: true; snapshots: ExchangeOrderSnapshot[] } | { ok: false; error: ExchangeErrorInfo }> {
  try {
    const raw = await signedGet<BinanceOrderRaw[]>(BASE_URLS[creds.environment], creds.environment, '/fapi/v1/openOrders', creds, symbol ? { symbol: toBinanceFuturesSymbol(symbol) } : undefined);
    return { ok: true, snapshots: (raw || []).map(normalizeExchangeOrder) };
  } catch (err) {
    return { ok: false, error: classifyBinanceError(err) };
  }
}

/** Sprint 3.6A — the FIFTH real write capability: `POST /fapi/v1/leverage` (verified live
 * 2026-08-10 — request `{symbol, leverage}`, response `{leverage, maxNotionalValue, symbol}`).
 * TESTNET-guarded here (defense in depth, same three-independent-layers discipline as every other
 * write: this function, exchangeService, and the frontend's own confirm-then-verify flow never
 * calls this without the user first seeing current-vs-requested leverage and explicitly confirming).
 * Never bundled with margin-type changes — no `setMarginType`/`marginType` mutation exists anywhere
 * in this file. A timeout/network failure is exactly as ambiguous as every other write in this app
 * (the change may have reached Binance before the response was lost) — never auto-retried; the
 * caller must re-read real leverage via the account snapshot before considering another attempt. */
export async function changeBinanceFuturesLeverage(creds: BinanceFuturesCredentials, symbol: string, leverage: number): Promise<{ ok: true; result: LeverageChangeResult } | { ok: false; error: ExchangeErrorInfo; ambiguous?: boolean }> {
  if (creds.environment !== 'TESTNET') {
    return { ok: false, error: { code: 'live_leverage_change_not_supported', message: '当前版本不支持 LIVE 环境调整杠杆，仅支持 TESTNET' } };
  }
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) {
    return { ok: false, error: { code: 'invalid_request', message: '杠杆倍数必须是 1-125 之间的整数' } };
  }
  const baseUrl = BASE_URLS[creds.environment];
  const binanceSymbol = toBinanceFuturesSymbol(symbol);

  let offset: number;
  try {
    offset = await getServerTimeOffsetCached(baseUrl, creds.environment, creds, true); // force-fresh before a write, never the cached read-path offset
  } catch (err) {
    return { ok: false, error: classifyBinanceError(err) };
  }

  try {
    const raw = await timedRead('changeLeverage', () => signedPostWithOffset<{ symbol: string; leverage: number; maxNotionalValue?: string }>(baseUrl, '/fapi/v1/leverage', creds, offset, { symbol: binanceSymbol, leverage }));
    return { ok: true, result: { symbol: raw.symbol, leverage: raw.leverage, maxNotionalValue: raw.maxNotionalValue ?? null } };
  } catch (err: any) {
    if (err?.timedOut || err?.networkError) {
      return { ok: false, ambiguous: true, error: { code: 'leverage_change_status_unknown', message: '杠杆调整结果未知，请重新查询账户确认当前杠杆后再继续，不要重复提交。' } };
    }
    return { ok: false, error: classifyBinanceError(err) }; // deterministic HTTP-level rejection — no change was applied
  }
}

// ================================================================================================
// Sprint 3.6A — User Data Stream lifecycle (listenKey). Verified live 2026-08-10:
// POST/PUT/DELETE /fapi/v1/listenKey all require ONLY the X-MBX-APIKEY header — no HMAC signature,
// unlike every other endpoint in this file (confirmed: the official docs' own examples for these
// three endpoints show no `signature`/`timestamp` query param). A listenKey is not itself a trading
// credential (it only grants read access to this account's own user-data event stream) but is still
// never logged here, consistent with this file's redaction discipline for apiKey/apiSecret.
// ================================================================================================

interface BinanceListenKeyRaw { listenKey?: string }

async function listenKeyRequest(baseUrl: string, method: 'POST' | 'PUT' | 'DELETE', creds: BinanceFuturesCredentials, listenKey?: string): Promise<BinanceListenKeyRaw> {
  const url = new URL(`${baseUrl}/fapi/v1/listenKey`);
  if (listenKey && method !== 'POST') url.searchParams.set('listenKey', listenKey);

  let res: Response;
  try {
    res = await fetch(url.toString(), { method, headers: { 'X-MBX-APIKEY': creds.apiKey }, signal: AbortSignal.timeout(BINANCE_READ_TIMEOUT_MS) });
  } catch (err: any) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const e: BinanceApiError = new Error(`${isTimeout ? 'listenKey request timed out' : 'listenKey network request failed'}: ${redactSecrets(String(err?.message ?? err), [creds.apiKey, creds.apiSecret])}`);
    e.networkError = true;
    e.timedOut = isTimeout;
    throw e;
  }

  const rawText = redactSecrets(await res.text(), [creds.apiKey, creds.apiSecret]);
  if (!res.ok) {
    let parsed: { code?: number; msg?: string } | null = null;
    try { parsed = JSON.parse(rawText); } catch {}
    const e: BinanceApiError = new Error(parsed?.msg ? `Binance error: ${parsed.msg}` : `Binance HTTP ${res.status}`);
    e.httpStatus = res.status;
    e.binanceCode = parsed?.code;
    throw e;
  }
  if (!rawText) return {};
  try { return JSON.parse(rawText) as BinanceListenKeyRaw; } catch { return {}; }
}

export async function startBinanceFuturesUserDataStream(creds: BinanceFuturesCredentials): Promise<{ ok: true; listenKey: string } | { ok: false; error: ExchangeErrorInfo }> {
  try {
    const { listenKey } = await listenKeyRequest(BASE_URLS[creds.environment], 'POST', creds);
    if (!listenKey) return { ok: false, error: { code: 'listen_key_unavailable', message: '交易所未返回 listenKey' } };
    return { ok: true, listenKey };
  } catch (err) {
    return { ok: false, error: classifyBinanceError(err) };
  }
}
export async function keepaliveBinanceFuturesUserDataStream(creds: BinanceFuturesCredentials, listenKey: string): Promise<{ ok: true } | { ok: false; error: ExchangeErrorInfo }> {
  try { await listenKeyRequest(BASE_URLS[creds.environment], 'PUT', creds, listenKey); return { ok: true }; }
  catch (err) { return { ok: false, error: classifyBinanceError(err) }; }
}
export async function closeBinanceFuturesUserDataStream(creds: BinanceFuturesCredentials, listenKey: string): Promise<{ ok: true } | { ok: false; error: ExchangeErrorInfo }> {
  try { await listenKeyRequest(BASE_URLS[creds.environment], 'DELETE', creds, listenKey); return { ok: true }; }
  catch (err) { return { ok: false, error: classifyBinanceError(err) }; }
}

/** Sprint 3.6A — Before Coding research (2026-08-10): LIVE migrated to Binance's split websocket
 * architecture (legacy `wss://fstream.binance.com/ws`/`/stream` decommissioned 2026-04-23 per the
 * official "Important WebSocket Change Notice"; user-data streams now live under
 * `wss://fstream.binance.com/private/ws/<listenKey>`). TESTNET's own documentation/community reports
 * were observed inconsistent on whether the same split has been applied there yet (disclosed, not
 * silently assumed) — TESTNET keeps the long-standing classic single-stream host+path. Both forms
 * take the listenKey as the final path segment. */
export function binanceFuturesUserDataStreamWsUrl(environment: ExchangeEnvironment, listenKey: string): string {
  return environment === 'LIVE'
    ? `wss://fstream.binance.com/private/ws/${listenKey}`
    : `wss://stream.binancefuture.com/ws/${listenKey}`;
}
