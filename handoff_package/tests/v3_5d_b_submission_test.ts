// Sprint 3.5D-B backend tests — Binance TESTNET Manual Order Submission.
// Deterministic, mocked-fetch only. NO real network calls to Binance anywhere in this file, and NO
// real order is ever submitted — every POST /fapi/v1/order call in this file hits a mock.

import assert from 'node:assert';
import { roundDownToStep, computeRawEntryQuantity, validateOrderQuantity, resolveEntryQuantity, type BinanceSymbolFilters } from './orderSizing.js';

// exchangeInfo is cached per-environment with a 30-minute TTL (see binanceFuturesAdapter.ts) — a
// fake, advanceable clock lets a later test case force a fresh fetch instead of silently reusing an
// earlier test case's cached response within the same process.
let fakeNow = 1700000000000;
const realDateNow = Date.now.bind(Date);
(Date as any).now = () => fakeNow;
function advanceClockPastExchangeInfoCache() { fakeNow += 31 * 60 * 1000; }

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean) { if (cond) pass++; else { fail++; failures.push(name); console.log('FAIL:', name); } }

// =====================================================================================
// PART 1 — orderSizing.ts pure math (Task 36)
// =====================================================================================
(function testSizingMath() {
  check('roundDownToStep: 0.012345 / 0.001 -> 0.012 (example from spec)', roundDownToStep(0.012345, 0.001) === 0.012);
  check('roundDownToStep: exact multiple unchanged', roundDownToStep(0.02, 0.001) === 0.02);
  check('roundDownToStep: below one step -> 0', roundDownToStep(0.0004, 0.001) === 0);
  check('roundDownToStep: fine step (0.00001)', roundDownToStep(1.234567, 0.00001) === 1.23456);
  check('roundDownToStep: integer step', roundDownToStep(17, 1) === 17);
  check('roundDownToStep: never rounds UP', roundDownToStep(0.0199, 0.01) === 0.01);

  check('computeRawEntryQuantity: 1000 USDT / 50000 -> 0.02', computeRawEntryQuantity(1000, 50000) === 0.02);
  check('computeRawEntryQuantity: 250 USDT / 65000', Math.abs(computeRawEntryQuantity(250, 65000) - 0.0038461538461538464) < 1e-12);

  const filters = { minQty: 0.001, maxQty: 1000, stepSize: 0.001, minNotional: 100 };
  check('validateOrderQuantity: valid passes', validateOrderQuantity({ quantity: 0.02, referencePrice: 65000, filters }).ok === true);
  check('validateOrderQuantity: below minQty fails', validateOrderQuantity({ quantity: 0.0001, referencePrice: 65000, filters }).ok === false);
  check('validateOrderQuantity: above maxQty fails', validateOrderQuantity({ quantity: 5000, referencePrice: 65000, filters }).ok === false);
  check('validateOrderQuantity: off-step fails', validateOrderQuantity({ quantity: 0.0205, referencePrice: 65000, filters }).ok === false);
  check('validateOrderQuantity: below minNotional fails', validateOrderQuantity({ quantity: 0.001, referencePrice: 50, filters }).ok === false); // 0.001*50=0.05 < 100
  check('validateOrderQuantity: non-finite quantity fails', validateOrderQuantity({ quantity: NaN, referencePrice: 65000, filters }).ok === false);
  check('validateOrderQuantity: zero/negative quantity fails', validateOrderQuantity({ quantity: 0, referencePrice: 65000, filters }).ok === false);

  const symbolFilters: BinanceSymbolFilters = { stepSize: 0.001, minQty: 0.001, maxQty: 1000, marketStepSize: 0.01, marketMinQty: 0.01, marketMaxQty: 500, minNotional: 100 };
  const limitResult = resolveEntryQuantity('LIMIT', 1300, 65000, symbolFilters);
  check('resolveEntryQuantity LIMIT: uses LOT_SIZE step (0.001)', limitResult.ok === true && (limitResult as any).quantity === 0.02);
  const marketResult = resolveEntryQuantity('MARKET', 1300, 65000, symbolFilters);
  check('resolveEntryQuantity MARKET: uses MARKET_LOT_SIZE step (0.01), rounds down from 0.02 -> 0.02', marketResult.ok === true && (marketResult as any).quantity === 0.02);
  const marketFallback = resolveEntryQuantity('MARKET', 1300, 65000, { ...symbolFilters, marketStepSize: null, marketMinQty: null, marketMaxQty: null });
  check('resolveEntryQuantity MARKET: falls back to LOT_SIZE when no MARKET_LOT_SIZE filter exists', marketFallback.ok === true && (marketFallback as any).quantity === 0.02);
  check('resolveEntryQuantity: no positionSize -> BLOCK', resolveEntryQuantity('LIMIT', 0, 65000, symbolFilters).ok === false);
  check('resolveEntryQuantity: negative positionSize -> BLOCK', resolveEntryQuantity('LIMIT', -100, 65000, symbolFilters).ok === false);
  check('resolveEntryQuantity: no reference price -> BLOCK', resolveEntryQuantity('LIMIT', 1300, 0, symbolFilters).ok === false);
  check('resolveEntryQuantity: invalid stepSize -> BLOCK', resolveEntryQuantity('LIMIT', 1300, 65000, { ...symbolFilters, stepSize: NaN }).ok === false);
  check('resolveEntryQuantity: too-small notional -> BLOCK (min notional)', resolveEntryQuantity('LIMIT', 10, 65000, symbolFilters).ok === false); // 10 USDT << 100 min notional
})();

// =====================================================================================
// PART 2 — adapter network tests (mocked fetch)
// =====================================================================================
type Handler = {
  time?: () => Response | Promise<Response>;
  exchangeInfo?: () => Response | Promise<Response>;
  positionRisk?: () => Response | Promise<Response>;
  orderPost?: () => Response | Promise<Response>;
  orderGet?: () => Response | Promise<Response>;
};
type CallLog = { method: string; path: string; params: Record<string, string>; hasSignal: boolean; hasApiKeyHeader: boolean };
let calls: CallLog[] = [];
let handler: Handler = {};
function resetFetchMock(h: Handler) { calls = []; handler = h; }
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function timeoutError(): Error { const e: any = new Error('timed out'); e.name = 'TimeoutError'; return e; }
function networkErr(): Error { const e: any = new Error('ECONNRESET'); e.name = 'FetchError'; return e; }

const REAL_SECRET = 'fake-secret-not-real-0123456789';
(global as any).fetch = async (url: string, opts: any) => {
  const u = new URL(String(url));
  const method = (opts && opts.method) || 'GET';
  const params: Record<string, string> = {};
  u.searchParams.forEach((v, k) => { params[k] = v; });
  const hasApiKeyHeader = !!(opts && opts.headers && opts.headers['X-MBX-APIKEY']);
  calls.push({ method, path: u.pathname, params, hasSignal: !!(opts && opts.signal), hasApiKeyHeader });

  // Task 38 — the raw API secret string must never appear anywhere in the URL (only used as the HMAC key).
  if (u.toString().includes(REAL_SECRET)) throw new Error('TEST FAILURE: raw API secret leaked into request URL');

  if (u.pathname === '/fapi/v1/time') { if (!handler.time) throw new Error('unexpected time call'); return handler.time(); }
  if (u.pathname === '/fapi/v1/exchangeInfo') { if (!handler.exchangeInfo) throw new Error('unexpected exchangeInfo call'); return handler.exchangeInfo(); }
  if (u.pathname === '/fapi/v2/positionRisk') { if (!handler.positionRisk) throw new Error('unexpected positionRisk call'); return handler.positionRisk(); }
  if (u.pathname === '/fapi/v1/order' && method === 'POST') { if (!handler.orderPost) throw new Error('unexpected order POST call'); return handler.orderPost(); }
  if (u.pathname === '/fapi/v1/order' && method === 'GET') { if (!handler.orderGet) throw new Error('unexpected order GET call'); return handler.orderGet(); }
  throw new Error('UNEXPECTED REQUEST in 3.5D-B test: ' + method + ' ' + u.pathname);
};

const { submitBinanceFuturesEntryOrder, resolveAndSubmitEntryOrder, extractSymbolFilters, getBinanceFuturesOrder } = await import('./binanceFuturesAdapter.js');

const CREDS_TESTNET = { apiKey: 'fake-key-not-real', apiSecret: REAL_SECRET, environment: 'TESTNET' as const };
const CREDS_LIVE = { apiKey: 'fake-key-not-real', apiSecret: REAL_SECRET, environment: 'LIVE' as const };

function exchangeInfoFixture(overrides: any = {}) {
  return {
    symbols: [Object.assign({
      symbol: 'BTCUSDT',
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.10', minPrice: '100', maxPrice: '1000000' },
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
        { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '500' },
        { filterType: 'MIN_NOTIONAL', notional: '100' },
      ],
    }, overrides)],
  };
}
function positionRiskFixture(overrides: any = {}) {
  return [Object.assign({ symbol: 'BTCUSDT', positionAmt: '0', entryPrice: '0', markPrice: '65000.00', leverage: '10', marginType: 'cross' }, overrides)];
}
function orderPostRawFixture(overrides: any = {}) {
  return Object.assign({
    orderId: 123456789, clientOrderId: 'OR1TESTCLIENT', symbol: 'BTCUSDT', status: 'NEW', side: 'BUY',
    type: 'LIMIT', origType: 'LIMIT', origQty: '0.020', price: '65000.00', avgPrice: '0.00', executedQty: '0.000',
    time: 1700000000000, updateTime: 1700000000000,
  }, overrides);
}

async function runAdapterTests() {
  // ---- extractSymbolFilters ----
  {
    const info = exchangeInfoFixture();
    const filters = extractSymbolFilters(info.symbols[0] as any);
    check('extractSymbolFilters: stepSize parsed', filters.stepSize === 0.001);
    check('extractSymbolFilters: MARKET_LOT_SIZE parsed separately', filters.marketStepSize === 0.001 && filters.marketMaxQty === 500);
    check('extractSymbolFilters: MIN_NOTIONAL parsed', filters.minNotional === 100);
  }
  {
    // MIN_NOTIONAL renamed to NOTIONAL in some API generations — accept either
    const info = exchangeInfoFixture({ filters: [{ filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' }, { filterType: 'NOTIONAL', notional: '5' }] });
    const filters = extractSymbolFilters(info.symbols[0] as any);
    check('extractSymbolFilters: accepts NOTIONAL as alias for MIN_NOTIONAL', filters.minNotional === 5);
  }

  // ---- submitBinanceFuturesEntryOrder: LIVE hard rejected, zero network calls ----
  resetFetchMock({});
  {
    const result = await submitBinanceFuturesEntryOrder(CREDS_LIVE, { symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.02, price: 65000, newClientOrderId: 'OR1' });
    check('LIVE: hard rejected', result.ok === false);
    if (!result.ok) check('LIVE: error code live_order_submission_not_supported', result.error.code === 'live_order_submission_not_supported');
    check('LIVE: zero network calls made (no override possible)', calls.length === 0);
  }

  // ---- submitBinanceFuturesEntryOrder: MARKET payload correct ----
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    orderPost: () => jsonResponse(orderPostRawFixture({ type: 'MARKET', origType: 'MARKET', price: '0.00' })),
  });
  {
    const result = await submitBinanceFuturesEntryOrder(CREDS_TESTNET, { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.02, newClientOrderId: 'OR1MARKET' });
    check('MARKET submit: ok', result.ok === true);
    const postCall = calls.find((c) => c.path === '/fapi/v1/order' && c.method === 'POST');
    check('MARKET submit: exactly one POST call', calls.filter((c) => c.path === '/fapi/v1/order' && c.method === 'POST').length === 1);
    check('MARKET submit: payload has type=MARKET, quantity, no price/timeInForce', !!postCall && postCall.params.type === 'MARKET' && postCall.params.quantity === '0.02' && !postCall.params.price && !postCall.params.timeInForce);
    check('MARKET submit: newClientOrderId included', !!postCall && postCall.params.newClientOrderId === 'OR1MARKET');
    check('MARKET submit: API key only in header, not URL', !!postCall && postCall.hasApiKeyHeader && !JSON.stringify(postCall.params).includes('fake-key-not-real'));
    check('MARKET submit: carries a real abort signal', !!postCall && postCall.hasSignal);
  }

  // ---- submitBinanceFuturesEntryOrder: LIMIT payload correct, GTC included ----
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    orderPost: () => jsonResponse(orderPostRawFixture()),
  });
  {
    const result = await submitBinanceFuturesEntryOrder(CREDS_TESTNET, { symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.02, price: 65000, newClientOrderId: 'OR1LIMIT' });
    check('LIMIT submit: ok', result.ok === true);
    const postCall = calls.find((c) => c.path === '/fapi/v1/order' && c.method === 'POST');
    check('LIMIT submit: payload has price + timeInForce=GTC', !!postCall && postCall.params.price === '65000' && postCall.params.timeInForce === 'GTC');
    if (result.ok) {
      check('LIMIT submit: clientOrderId echoed in normalized snapshot', result.snapshot.clientOrderId === 'OR1TESTCLIENT');
      check('LIMIT submit: exchangeOrderId persisted (stringified)', result.snapshot.exchangeOrderId === '123456789');
      check('LIMIT submit: NEW status preserved raw (mapping is a separate frontend step)', result.snapshot.status === 'NEW');
    }
  }

  // ---- immediate fill / partial fill response mapping through normalizeExchangeOrder ----
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    orderPost: () => jsonResponse(orderPostRawFixture({ status: 'FILLED', executedQty: '0.020', avgPrice: '65005.00' })),
  });
  {
    const result = await submitBinanceFuturesEntryOrder(CREDS_TESTNET, { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.02, newClientOrderId: 'OR1FILL' });
    check('MARKET immediate FILLED: status FILLED, not forced to NEW/SUBMITTED', result.ok === true && result.snapshot.status === 'FILLED');
    check('MARKET immediate FILLED: executedQuantity/averagePrice normalized', result.ok === true && result.snapshot.executedQuantity === 0.02 && result.snapshot.averagePrice === 65005);
  }
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    orderPost: () => jsonResponse(orderPostRawFixture({ status: 'PARTIALLY_FILLED', executedQty: '0.010', avgPrice: '65002.00' })),
  });
  {
    const result = await submitBinanceFuturesEntryOrder(CREDS_TESTNET, { symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.02, price: 65000, newClientOrderId: 'OR1PARTIAL' });
    check('LIMIT immediate PARTIALLY_FILLED preserved', result.ok === true && result.snapshot.status === 'PARTIALLY_FILLED');
  }

  // ---- Task 27/39 — network timeout does NOT auto-retry, reports ambiguous ----
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    orderPost: () => { throw timeoutError(); },
  });
  {
    const result = await submitBinanceFuturesEntryOrder(CREDS_TESTNET, { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.02, newClientOrderId: 'OR1TIMEOUT' });
    check('write timeout: ok=false', result.ok === false);
    if (!result.ok) {
      check('write timeout: ambiguous=true', result.ambiguous === true);
      check('write timeout: error code submission_status_unknown', result.error.code === 'submission_status_unknown');
    }
    check('write timeout: exactly ONE POST attempt, no retry', calls.filter((c) => c.path === '/fapi/v1/order' && c.method === 'POST').length === 1);
  }

  // ---- generic network error also does NOT auto-retry, also ambiguous ----
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    orderPost: () => { throw networkErr(); },
  });
  {
    const result = await submitBinanceFuturesEntryOrder(CREDS_TESTNET, { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.02, newClientOrderId: 'OR1NETERR' });
    check('generic network error: ambiguous=true', result.ok === false && (result as any).ambiguous === true);
    check('generic network error: exactly ONE POST attempt', calls.filter((c) => c.path === '/fapi/v1/order' && c.method === 'POST').length === 1);
  }

  // ---- Task 28 — deterministic -1021 timestamp rejection does NOT auto-resubmit ----
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    orderPost: () => jsonResponse({ code: -1021, msg: 'Timestamp for this request is outside of the recvWindow.' }, 400),
  });
  {
    const result = await submitBinanceFuturesEntryOrder(CREDS_TESTNET, { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.02, newClientOrderId: 'OR1TS' });
    check('-1021 on write: ok=false, deterministic (not ambiguous)', result.ok === false && (result as any).ambiguous !== true);
    if (!result.ok) check('-1021 on write: error code timestamp_error', result.error.code === 'timestamp_error');
    check('-1021 on write: exactly ONE POST attempt, no automatic resubmission', calls.filter((c) => c.path === '/fapi/v1/order' && c.method === 'POST').length === 1);
  }

  // ---- deterministic Binance rejection (filter failure) ----
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    orderPost: () => jsonResponse({ code: -1013, msg: 'Filter failure: LOT_SIZE' }, 400),
  });
  {
    const result = await submitBinanceFuturesEntryOrder(CREDS_TESTNET, { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.02, newClientOrderId: 'OR1FILTER' });
    check('filter failure: ok=false, deterministic', result.ok === false && (result as any).ambiguous !== true);
    if (!result.ok) check('filter failure: error code filter_failure', result.error.code === 'filter_failure');
  }

  // ---- insufficient margin ----
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    orderPost: () => jsonResponse({ code: -2019, msg: 'Margin is insufficient.' }, 400),
  });
  {
    const result = await submitBinanceFuturesEntryOrder(CREDS_TESTNET, { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.02, newClientOrderId: 'OR1MARGIN' });
    check('insufficient margin: error code insufficient_margin', result.ok === false && (result as any).error.code === 'insufficient_margin');
  }

  // ---- getBinanceFuturesOrder: origClientOrderId lookup path (Task 27 recovery) ----
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    orderGet: () => jsonResponse(orderPostRawFixture()),
  });
  {
    const result = await getBinanceFuturesOrder(CREDS_TESTNET, 'BTCUSDT', { origClientOrderId: 'OR1TESTCLIENT' });
    check('recovery lookup by origClientOrderId: ok', result.ok === true);
    const getCall = calls.find((c) => c.path === '/fapi/v1/order' && c.method === 'GET');
    check('recovery lookup: query carries origClientOrderId, not orderId', !!getCall && getCall.params.origClientOrderId === 'OR1TESTCLIENT' && !getCall.params.orderId);
  }

  console.log('adapter tests done');
}

// =====================================================================================
// PART 3 — resolveAndSubmitEntryOrder full orchestration (Task 13/29/37)
// =====================================================================================
async function runOrchestrationTests() {
  // success path end-to-end
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    exchangeInfo: () => jsonResponse(exchangeInfoFixture()),
    positionRisk: () => jsonResponse(positionRiskFixture({ leverage: '10', markPrice: '65000.00' })),
    orderPost: () => jsonResponse(orderPostRawFixture()),
  });
  {
    const result = await resolveAndSubmitEntryOrder(CREDS_TESTNET, { symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', limitPrice: 65000, positionSizeUsdt: 1300, leverage: 10, localOrderId: 'OR1E2E' });
    check('orchestration success: ok', result.ok === true);
    const postCall = calls.find((c) => c.path === '/fapi/v1/order' && c.method === 'POST');
    check('orchestration success: computed quantity sent to Binance matches sizing math (0.02)', !!postCall && postCall.params.quantity === '0.02');
  }

  // leverage mismatch -> BLOCK, no POST ever made
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    exchangeInfo: () => jsonResponse(exchangeInfoFixture()),
    positionRisk: () => jsonResponse(positionRiskFixture({ leverage: '5' })), // account actually configured at 5x
  });
  {
    const result = await resolveAndSubmitEntryOrder(CREDS_TESTNET, { symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', limitPrice: 65000, positionSizeUsdt: 1300, leverage: 10, localOrderId: 'OR1LEVMISMATCH' });
    check('leverage mismatch: BLOCK', result.ok === false);
    if (!result.ok) check('leverage mismatch: error code leverage_mismatch', result.error.code === 'leverage_mismatch');
    check('leverage mismatch: no POST /fapi/v1/order ever made', calls.filter((c) => c.path === '/fapi/v1/order' && c.method === 'POST').length === 0);
  }

  // leverage unverifiable (empty positionRisk rows) -> BLOCK
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    exchangeInfo: () => jsonResponse(exchangeInfoFixture()),
    positionRisk: () => jsonResponse([]),
  });
  {
    const result = await resolveAndSubmitEntryOrder(CREDS_TESTNET, { symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', limitPrice: 65000, positionSizeUsdt: 1300, leverage: 10, localOrderId: 'OR1LEVUNK' });
    check('leverage unverifiable: BLOCK', result.ok === false);
    if (!result.ok) check('leverage unverifiable: error code leverage_unverifiable', result.error.code === 'leverage_unverifiable');
    check('leverage unverifiable: no POST ever made', calls.filter((c) => c.path === '/fapi/v1/order' && c.method === 'POST').length === 0);
  }

  // quantity too small (below min notional) -> BLOCK locally, no POST made
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    exchangeInfo: () => jsonResponse(exchangeInfoFixture()),
    positionRisk: () => jsonResponse(positionRiskFixture({ leverage: '10' })),
  });
  {
    const result = await resolveAndSubmitEntryOrder(CREDS_TESTNET, { symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', limitPrice: 65000, positionSizeUsdt: 10, leverage: 10, localOrderId: 'OR1TINY' });
    check('quantity below min notional: BLOCK', result.ok === false);
    if (!result.ok) check('quantity below min notional: error code invalid_quantity', result.error.code === 'invalid_quantity');
    check('quantity below min notional: no POST ever made (Task 12 — never send to Binance)', calls.filter((c) => c.path === '/fapi/v1/order' && c.method === 'POST').length === 0);
  }

  // MARKET uses fresh markPrice as reference (no limitPrice provided)
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    exchangeInfo: () => jsonResponse(exchangeInfoFixture()),
    positionRisk: () => jsonResponse(positionRiskFixture({ leverage: '10', markPrice: '50000.00' })),
    orderPost: () => jsonResponse(orderPostRawFixture({ type: 'MARKET', origType: 'MARKET' })),
  });
  {
    const result = await resolveAndSubmitEntryOrder(CREDS_TESTNET, { symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', limitPrice: null, positionSizeUsdt: 1000, leverage: 10, localOrderId: 'OR1MKTREF' });
    check('MARKET orchestration: ok using markPrice as reference', result.ok === true);
    const postCall = calls.find((c) => c.path === '/fapi/v1/order' && c.method === 'POST');
    check('MARKET orchestration: quantity computed from markPrice (1000/50000=0.02)', !!postCall && postCall.params.quantity === '0.02');
  }

  // exchangeInfo unavailable -> BLOCK, never reaches leverage/submission
  advanceClockPastExchangeInfoCache(); // force a fresh exchangeInfo fetch instead of reusing an earlier test's cached BTCUSDT entry
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    exchangeInfo: () => jsonResponse({ symbols: [] }),
  });
  {
    const result = await resolveAndSubmitEntryOrder(CREDS_TESTNET, { symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', limitPrice: 65000, positionSizeUsdt: 1300, leverage: 10, localOrderId: 'OR1NOINFO' });
    check('missing exchangeInfo for symbol: BLOCK', result.ok === false);
    if (!result.ok) check('missing exchangeInfo: error code exchange_info_unavailable', result.error.code === 'exchange_info_unavailable');
  }

  // invalid clientOrderId format -> BLOCK before any network call at all except the initial offset sync
  resetFetchMock({ time: () => jsonResponse({ serverTime: Date.now() }) });
  {
    const result = await resolveAndSubmitEntryOrder(CREDS_TESTNET, { symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', limitPrice: 65000, positionSizeUsdt: 1300, leverage: 10, localOrderId: '包含中文的非法ID' });
    check('invalid localOrderId charset: BLOCK', result.ok === false);
    if (!result.ok) check('invalid localOrderId: error code invalid_request', result.error.code === 'invalid_request');
  }

  console.log('orchestration tests done');
}

(async function main() {
  await runAdapterTests();
  await runOrchestrationTests();
  (Date as any).now = realDateNow;
  console.log(`\n3.5D-B backend tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
})();
