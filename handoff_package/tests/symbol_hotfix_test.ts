// Hotfix — Binance Futures Symbol Normalization. Deterministic, mocked-fetch only. NO real network
// calls in this file, NO order is ever submitted for real — every POST /fapi/v1/order call here hits
// a mock, and this file's own public-exchangeInfo root-cause confirmation was run separately (real,
// unauthenticated GET only, disclosed in the final report — not repeated here).

import assert from 'node:assert';

let fakeNow = 1700000000000;
(Date as any).now = () => fakeNow;
function advanceClockPastExchangeInfoCache() { fakeNow += 31 * 60 * 1000; }

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean) { if (cond) pass++; else { fail++; failures.push(name); console.log('FAIL:', name); } }

type Handler = {
  time?: () => Response | Promise<Response>;
  exchangeInfo?: () => Response | Promise<Response>;
  positionRisk?: () => Response | Promise<Response>;
  orderPost?: () => Response | Promise<Response>;
  orderGet?: () => Response | Promise<Response>;
};
type CallLog = { method: string; path: string; params: Record<string, string> };
let calls: CallLog[] = [];
let handler: Handler = {};
function resetFetchMock(h: Handler) { calls = []; handler = h; }
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const REAL_SECRET = 'fake-secret-not-real-0123456789';
(global as any).fetch = async (url: string, opts: any) => {
  const u = new URL(String(url));
  const method = (opts && opts.method) || 'GET';
  const params: Record<string, string> = {};
  u.searchParams.forEach((v, k) => { params[k] = v; });
  calls.push({ method, path: u.pathname, params });
  if (u.pathname === '/fapi/v1/time') { if (!handler.time) throw new Error('unexpected time call'); return handler.time(); }
  if (u.pathname === '/fapi/v1/exchangeInfo') { if (!handler.exchangeInfo) throw new Error('unexpected exchangeInfo call'); return handler.exchangeInfo(); }
  if (u.pathname === '/fapi/v2/positionRisk') { if (!handler.positionRisk) throw new Error('unexpected positionRisk call'); return handler.positionRisk(); }
  if (u.pathname === '/fapi/v1/order' && method === 'POST') { if (!handler.orderPost) throw new Error('unexpected order POST call'); return handler.orderPost(); }
  if (u.pathname === '/fapi/v1/order' && method === 'GET') { if (!handler.orderGet) throw new Error('unexpected order GET call'); return handler.orderGet(); }
  throw new Error('UNEXPECTED REQUEST in symbol hotfix test: ' + method + ' ' + u.pathname);
};

const { toBinanceFuturesSymbol, resolveAndSubmitEntryOrder, getBinanceFuturesOrder, extractSymbolFilters } = await import('./binanceFuturesAdapter.js');

const CREDS_TESTNET = { apiKey: 'fake-key-not-real', apiSecret: REAL_SECRET, environment: 'TESTNET' as const };

function exchangeInfoFixture(symbol = 'BTCUSDT') {
  return {
    symbols: [{
      symbol,
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.10', minPrice: '100', maxPrice: '1000000' },
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
        { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '500' },
        { filterType: 'MIN_NOTIONAL', notional: '100' },
      ],
    }],
  };
}
function positionRiskFixture(symbol = 'BTCUSDT', overrides: any = {}) {
  return [Object.assign({ symbol, positionAmt: '0', entryPrice: '0', markPrice: '65000.00', leverage: '10', marginType: 'cross' }, overrides)];
}
function orderPostRawFixture(symbol = 'BTCUSDT', overrides: any = {}) {
  return Object.assign({
    orderId: 123456789, clientOrderId: 'OR1TESTCLIENT', symbol, status: 'NEW', side: 'BUY',
    type: 'LIMIT', origType: 'LIMIT', origQty: '0.020', price: '65000.00', avgPrice: '0.00', executedQty: '0.000',
    time: 1700000000000, updateTime: 1700000000000,
  }, overrides);
}
function orderGetRawFixture(symbol = 'BTCUSDT', overrides: any = {}) {
  return Object.assign({
    orderId: 123456789, clientOrderId: 'OR1TESTCLIENT', symbol, status: 'FILLED', side: 'BUY',
    type: 'LIMIT', origType: 'LIMIT', origQty: '0.020', price: '65000.00', avgPrice: '65005.00', executedQty: '0.020',
    time: 1700000000000, updateTime: 1700000000000,
  }, overrides);
}

async function run() {
  // =====================================================================================
  // PART 1 — toBinanceFuturesSymbol() pure unit tests
  // =====================================================================================
  check('BTC/USDT -> BTCUSDT', toBinanceFuturesSymbol('BTC/USDT') === 'BTCUSDT');
  check('BTCUSDT -> BTCUSDT (already normalized, idempotent)', toBinanceFuturesSymbol('BTCUSDT') === 'BTCUSDT');
  check('ETH/USDT -> ETHUSDT', toBinanceFuturesSymbol('ETH/USDT') === 'ETHUSDT');
  check('lowercase input uppercased', toBinanceFuturesSymbol('btc/usdt') === 'BTCUSDT');
  check('empty/null input -> empty string, never throws', toBinanceFuturesSymbol('' as any) === '' && toBinanceFuturesSymbol(null as any) === '');

  // =====================================================================================
  // PART 2 — root-cause reproduction: exchangeInfo lookup fails without normalization, succeeds with it
  // =====================================================================================
  advanceClockPastExchangeInfoCache();
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    exchangeInfo: () => jsonResponse(exchangeInfoFixture('BTCUSDT')), // Binance's real shape: no slash
    positionRisk: () => jsonResponse(positionRiskFixture('BTCUSDT', { leverage: '10' })),
    orderPost: () => jsonResponse(orderPostRawFixture('BTCUSDT')),
  });
  {
    // app-canonical display symbol, exactly what RealOrder.symbol / prototype/index.html sends
    const result = await resolveAndSubmitEntryOrder(CREDS_TESTNET, { symbol: 'BTC/USDT', side: 'BUY', orderType: 'LIMIT', limitPrice: 65000, positionSizeUsdt: 1300, leverage: 10, localOrderId: 'OR1SLASH' });
    check('display symbol BTC/USDT: submission now succeeds (was the reported bug)', result.ok === true);
    const exchangeInfoCall = calls.find((c) => c.path === '/fapi/v1/exchangeInfo');
    check('exchangeInfo call made', !!exchangeInfoCall);
    const postCall = calls.find((c) => c.path === '/fapi/v1/order' && c.method === 'POST');
    check('submission payload uses BTCUSDT, never BTC/USDT, never URL-encoded slash', !!postCall && postCall.params.symbol === 'BTCUSDT');
    const positionRiskCall = calls.find((c) => c.path === '/fapi/v2/positionRisk');
    check('positionRisk (leverage/markPrice read) uses BTCUSDT', !!positionRiskCall && positionRiskCall.params.symbol === 'BTCUSDT');
  }

  // =====================================================================================
  // PART 3 — already-normalized input still works (idempotent through the full path)
  // =====================================================================================
  advanceClockPastExchangeInfoCache();
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    exchangeInfo: () => jsonResponse(exchangeInfoFixture('ETHUSDT')),
    positionRisk: () => jsonResponse(positionRiskFixture('ETHUSDT', { leverage: '10' })),
    orderPost: () => jsonResponse(orderPostRawFixture('ETHUSDT')),
  });
  {
    const result = await resolveAndSubmitEntryOrder(CREDS_TESTNET, { symbol: 'ETHUSDT', side: 'BUY', orderType: 'LIMIT', limitPrice: 65000, positionSizeUsdt: 1300, leverage: 10, localOrderId: 'OR1NOSLASH' });
    check('already-normalized ETHUSDT: submission succeeds', result.ok === true);
    const postCall = calls.find((c) => c.path === '/fapi/v1/order' && c.method === 'POST');
    check('already-normalized: payload still ETHUSDT', !!postCall && postCall.params.symbol === 'ETHUSDT');
  }

  // =====================================================================================
  // PART 4 — genuinely unknown symbol still fails safely, with a diagnostic (non-raw-payload) message
  // =====================================================================================
  advanceClockPastExchangeInfoCache();
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    exchangeInfo: () => jsonResponse(exchangeInfoFixture('BTCUSDT')), // does not contain DOGE/USDT or DOGEUSDT
  });
  {
    const result = await resolveAndSubmitEntryOrder(CREDS_TESTNET, { symbol: 'DOGE/USDT', side: 'BUY', orderType: 'LIMIT', limitPrice: 0.1, positionSizeUsdt: 100, leverage: 10, localOrderId: 'OR1UNKNOWN' });
    check('unknown symbol: BLOCK, not a crash', result.ok === false);
    if (!result.ok) {
      check('unknown symbol: exchange_info_unavailable code', result.error.code === 'exchange_info_unavailable');
      check('unknown symbol: diagnostic message names the normalized symbol', result.error.message.includes('DOGEUSDT'));
      check('unknown symbol: message does not dump raw exchangeInfo payload', !result.error.message.includes('filterType') && !result.error.message.includes('symbols'));
    }
    check('unknown symbol: no POST ever made', calls.filter((c) => c.path === '/fapi/v1/order' && c.method === 'POST').length === 0);
  }

  // =====================================================================================
  // PART 5 — LOT_SIZE / MARKET_LOT_SIZE / MIN_NOTIONAL still resolve correctly post-fix
  // =====================================================================================
  {
    const info = exchangeInfoFixture('BTCUSDT');
    const filters = extractSymbolFilters(info.symbols[0] as any);
    check('LIMIT sizing gets LOT_SIZE stepSize', filters.stepSize === 0.001);
    check('MARKET sizing gets MARKET_LOT_SIZE stepSize (separate from LOT_SIZE)', filters.marketStepSize === 0.001 && filters.marketMaxQty === 500);
    check('MIN_NOTIONAL still resolves', filters.minNotional === 100);
  }

  // =====================================================================================
  // PART 6 — order GET path (sync / origClientOrderId recovery) also normalizes
  // =====================================================================================
  resetFetchMock({
    orderGet: () => jsonResponse(orderGetRawFixture('BTCUSDT')),
  });
  {
    const result = await getBinanceFuturesOrder(CREDS_TESTNET, 'BTC/USDT', { orderId: '123456789' });
    check('order-query (sync): display symbol accepted, submission succeeds', result.ok === true);
    const getCall = calls.find((c) => c.path === '/fapi/v1/order' && c.method === 'GET');
    check('order-query: request uses BTCUSDT', !!getCall && getCall.params.symbol === 'BTCUSDT');
  }
  resetFetchMock({
    orderGet: () => jsonResponse(orderGetRawFixture('BTCUSDT')),
  });
  {
    // origClientOrderId recovery path (Sprint 3.5D-B Task 27) — same normalization must apply
    const result = await getBinanceFuturesOrder(CREDS_TESTNET, 'BTC/USDT', { origClientOrderId: 'OR1TESTCLIENT' });
    check('order-query (recovery via origClientOrderId): succeeds with display symbol input', result.ok === true);
    const getCall = calls.find((c) => c.path === '/fapi/v1/order' && c.method === 'GET');
    check('order-query (recovery): request uses BTCUSDT', !!getCall && getCall.params.symbol === 'BTCUSDT');
  }

  // =====================================================================================
  // PART 7 — LIVE hard guard unchanged by this hotfix
  // =====================================================================================
  resetFetchMock({});
  {
    const CREDS_LIVE = { apiKey: 'fake-key-not-real', apiSecret: REAL_SECRET, environment: 'LIVE' as const };
    const result = await resolveAndSubmitEntryOrder(CREDS_LIVE, { symbol: 'BTC/USDT', side: 'BUY', orderType: 'LIMIT', limitPrice: 65000, positionSizeUsdt: 1300, leverage: 10, localOrderId: 'OR1LIVE' });
    check('LIVE still hard rejected regardless of symbol form', result.ok === false);
    if (!result.ok) check('LIVE: error code unchanged', result.error.code === 'live_order_submission_not_supported');
    check('LIVE: zero network calls made', calls.length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
}

run().catch((e) => { console.error('TEST RUNNER ERROR:', e); process.exit(1); });
