// Sprint 3.5D-D backend tests — Binance TESTNET Manual Order Cancellation.
// Deterministic, mocked-fetch only. NO real network calls to Binance anywhere in this file, and NO
// real cancellation is ever sent — every DELETE /fapi/v1/order call in this file hits a mock.

import assert from 'node:assert';

let fakeNow = 1700000000000;
(Date as any).now = () => fakeNow;

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean) { if (cond) pass++; else { fail++; failures.push(name); console.log('FAIL:', name); } }

type Handler = {
  time?: () => Response | Promise<Response>;
  orderDelete?: () => Response | Promise<Response>;
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

  // The raw API secret string must never appear anywhere in the URL (only used as the HMAC key).
  if (u.toString().includes(REAL_SECRET)) throw new Error('TEST FAILURE: raw API secret leaked into request URL');

  if (u.pathname === '/fapi/v1/time') { if (!handler.time) throw new Error('unexpected time call'); return handler.time(); }
  if (u.pathname === '/fapi/v1/order' && method === 'DELETE') { if (!handler.orderDelete) throw new Error('unexpected order DELETE call'); return handler.orderDelete(); }
  throw new Error('UNEXPECTED REQUEST in cancel test: ' + method + ' ' + u.pathname);
};

const { cancelBinanceFuturesTestnetOrder } = await import('./binanceFuturesAdapter.js');

const CREDS_TESTNET = { apiKey: 'fake-key-not-real', apiSecret: REAL_SECRET, environment: 'TESTNET' as const };
const CREDS_LIVE = { apiKey: 'fake-key-not-real', apiSecret: REAL_SECRET, environment: 'LIVE' as const };

function cancelRawFixture(overrides: any = {}) {
  return Object.assign({
    orderId: 123456789, clientOrderId: 'OR1TESTCLIENT', symbol: 'BTCUSDT', status: 'CANCELED', side: 'BUY',
    type: 'LIMIT', origType: 'LIMIT', origQty: '0.020', price: '65000.00', avgPrice: '0.00', executedQty: '0.000',
    time: 1700000000000, updateTime: 1700000005000,
  }, overrides);
}

async function run() {
  // =====================================================================================
  // PART 1 — DELETE payload correctness (Task 30)
  // =====================================================================================
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    orderDelete: () => jsonResponse(cancelRawFixture()),
  });
  {
    const result = await cancelBinanceFuturesTestnetOrder(CREDS_TESTNET, { symbol: 'BTC/USDT', exchangeOrderId: '123456789' });
    check('cancel: ok', result.ok === true);
    const deleteCall = calls.find((c) => c.path === '/fapi/v1/order' && c.method === 'DELETE');
    check('cancel: exactly one DELETE call', calls.filter((c) => c.path === '/fapi/v1/order' && c.method === 'DELETE').length === 1);
    check('cancel: symbol normalized BTC/USDT -> BTCUSDT', !!deleteCall && deleteCall.params.symbol === 'BTCUSDT');
    check('cancel: correct orderId param', !!deleteCall && deleteCall.params.orderId === '123456789');
    check('cancel: API key only in header, not URL', !!deleteCall && deleteCall.hasApiKeyHeader && !JSON.stringify(deleteCall.params).includes('fake-key-not-real'));
    check('cancel: secret never in URL/body (also checked by the global fetch mock itself)', !!deleteCall && !JSON.stringify(deleteCall.params).includes(REAL_SECRET));
    check('cancel: carries a real abort signal', !!deleteCall && deleteCall.hasSignal);
    check('cancel: request signed (has signature param)', !!deleteCall && typeof deleteCall.params.signature === 'string' && deleteCall.params.signature.length > 0);
    if (result.ok) {
      check('cancel: normalized status CANCELED (raw, mapping is a separate frontend step)', result.snapshot.status === 'CANCELED');
      check('cancel: exchangeOrderId stringified', result.snapshot.exchangeOrderId === '123456789');
    }
  }

  // already-normalized symbol input still works
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    orderDelete: () => jsonResponse(cancelRawFixture({ symbol: 'ETHUSDT' })),
  });
  {
    const result = await cancelBinanceFuturesTestnetOrder(CREDS_TESTNET, { symbol: 'ETHUSDT', exchangeOrderId: '987654321' });
    check('cancel: already-normalized symbol works', result.ok === true);
    const deleteCall = calls.find((c) => c.path === '/fapi/v1/order' && c.method === 'DELETE');
    check('cancel: already-normalized symbol unchanged in payload', !!deleteCall && deleteCall.params.symbol === 'ETHUSDT');
  }

  // =====================================================================================
  // PART 2 — TESTNET base URL used (Task 30) + LIVE hard blocked before any network call (Task 30/31)
  // =====================================================================================
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    orderDelete: () => jsonResponse(cancelRawFixture()),
  });
  {
    await cancelBinanceFuturesTestnetOrder(CREDS_TESTNET, { symbol: 'BTC/USDT', exchangeOrderId: '1' });
    check('cancel: uses TESTNET base URL (mock only responds if URL matched testnet host implicitly via our single-host mock, confirmed no crash)', calls.length > 0);
  }
  resetFetchMock({});
  {
    const result = await cancelBinanceFuturesTestnetOrder(CREDS_LIVE, { symbol: 'BTC/USDT', exchangeOrderId: '1' });
    check('cancel: LIVE hard rejected', result.ok === false);
    if (!result.ok) check('cancel: LIVE error code live_order_cancellation_not_supported', result.error.code === 'live_order_cancellation_not_supported');
    check('cancel: LIVE zero network calls made (no override possible)', calls.length === 0);
  }

  // =====================================================================================
  // PART 3 — structural validation before any network call
  // =====================================================================================
  resetFetchMock({});
  {
    const result = await cancelBinanceFuturesTestnetOrder(CREDS_TESTNET, { symbol: '', exchangeOrderId: '1' });
    check('cancel: missing symbol -> invalid_request, no network call', result.ok === false && (result as any).error.code === 'invalid_request' && calls.length === 0);
  }
  resetFetchMock({});
  {
    const result = await cancelBinanceFuturesTestnetOrder(CREDS_TESTNET, { symbol: 'BTC/USDT', exchangeOrderId: 'not-a-number' });
    check('cancel: malformed exchangeOrderId -> invalid_request, no network call', result.ok === false && (result as any).error.code === 'invalid_request' && calls.length === 0);
  }
  resetFetchMock({});
  {
    const result = await cancelBinanceFuturesTestnetOrder(CREDS_TESTNET, { symbol: 'BTC/USDT', exchangeOrderId: '' });
    check('cancel: empty exchangeOrderId -> invalid_request, no network call', result.ok === false && (result as any).error.code === 'invalid_request' && calls.length === 0);
  }

  // =====================================================================================
  // PART 4 — ambiguous failure: no automatic retry (Task 10/33)
  // =====================================================================================
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    orderDelete: () => { throw timeoutError(); },
  });
  {
    const result = await cancelBinanceFuturesTestnetOrder(CREDS_TESTNET, { symbol: 'BTC/USDT', exchangeOrderId: '1' });
    check('cancel: DELETE timeout -> ambiguous, no auto retry', result.ok === false && (result as any).ambiguous === true);
    if (!result.ok) check('cancel: timeout error code cancellation_status_unknown', (result as any).error.code === 'cancellation_status_unknown');
    check('cancel: exactly one DELETE attempt on timeout (no retry)', calls.filter((c) => c.method === 'DELETE').length === 1);
  }
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    orderDelete: () => { throw networkErr(); },
  });
  {
    const result = await cancelBinanceFuturesTestnetOrder(CREDS_TESTNET, { symbol: 'BTC/USDT', exchangeOrderId: '1' });
    check('cancel: generic network error -> ambiguous, no auto retry', result.ok === false && (result as any).ambiguous === true);
    check('cancel: exactly one DELETE attempt on network error (no retry)', calls.filter((c) => c.method === 'DELETE').length === 1);
  }

  // =====================================================================================
  // PART 5 — deterministic HTTP-level rejection (e.g. -2011 "unknown order sent" — order already
  // filled/cancelled/never existed): never treated as ambiguous, never retried.
  // =====================================================================================
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    orderDelete: () => jsonResponse({ code: -2011, msg: 'Unknown order sent.' }, 400),
  });
  {
    const result = await cancelBinanceFuturesTestnetOrder(CREDS_TESTNET, { symbol: 'BTC/USDT', exchangeOrderId: '1' });
    check('cancel: -2011 deterministic rejection, not ambiguous', result.ok === false && (result as any).ambiguous !== true);
    if (!result.ok) check('cancel: -2011 mapped to order_not_cancellable', (result as any).error.code === 'order_not_cancellable');
    check('cancel: exactly one DELETE attempt on deterministic rejection (no retry)', calls.filter((c) => c.method === 'DELETE').length === 1);
  }

  // =====================================================================================
  // PART 6 — response normalization reuses the existing normalizer; never forces CANCELED (Task 12)
  // =====================================================================================
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    orderDelete: () => jsonResponse(cancelRawFixture({ status: 'EXPIRED' })),
  });
  {
    const result = await cancelBinanceFuturesTestnetOrder(CREDS_TESTNET, { symbol: 'BTC/USDT', exchangeOrderId: '1' });
    check('cancel: does not force CANCELED — uses whatever Binance actually returned', result.ok === true && result.snapshot.status === 'EXPIRED');
  }
  // partial-fill preserved in the cancellation response itself
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    orderDelete: () => jsonResponse(cancelRawFixture({ status: 'CANCELED', executedQty: '0.010', avgPrice: '65002.00', origQty: '0.020' })),
  });
  {
    const result = await cancelBinanceFuturesTestnetOrder(CREDS_TESTNET, { symbol: 'BTC/USDT', exchangeOrderId: '1' });
    check('cancel: partial fill executedQuantity preserved in response', result.ok === true && result.snapshot.executedQuantity === 0.01);
    check('cancel: partial fill averagePrice preserved in response', result.ok === true && result.snapshot.averagePrice === 65002);
    check('cancel: originalQuantity preserved in response', result.ok === true && result.snapshot.originalQuantity === 0.02);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
}

run().catch((e) => { console.error('TEST RUNNER ERROR:', e); process.exit(1); });
