// Sprint 3.5D-E backend tests — real protective (STOP_LOSS/TAKE_PROFIT) order submission.
// Deterministic, mocked-fetch only. NO real network calls, no real algo order submitted.

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
  algoOrderPost?: () => Response | Promise<Response>;
  algoOrderDelete?: () => Response | Promise<Response>;
  algoOrderGet?: () => Response | Promise<Response>;
};
type CallLog = { method: string; path: string; params: Record<string, string>; hasSignal: boolean; hasApiKeyHeader: boolean };
let calls: CallLog[] = [];
let handler: Handler = {};
function resetFetchMock(h: Handler) { calls = []; handler = h; }
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function timeoutError(): Error { const e: any = new Error('timed out'); e.name = 'TimeoutError'; return e; }

const REAL_SECRET = 'fake-secret-not-real-0123456789';
(global as any).fetch = async (url: string, opts: any) => {
  const u = new URL(String(url));
  const method = (opts && opts.method) || 'GET';
  const params: Record<string, string> = {};
  u.searchParams.forEach((v, k) => { params[k] = v; });
  const hasApiKeyHeader = !!(opts && opts.headers && opts.headers['X-MBX-APIKEY']);
  calls.push({ method, path: u.pathname, params, hasSignal: !!(opts && opts.signal), hasApiKeyHeader });
  if (u.toString().includes(REAL_SECRET)) throw new Error('TEST FAILURE: raw API secret leaked into request URL');

  if (u.pathname === '/fapi/v1/time') { if (!handler.time) throw new Error('unexpected time call'); return handler.time(); }
  if (u.pathname === '/fapi/v1/exchangeInfo') { if (!handler.exchangeInfo) throw new Error('unexpected exchangeInfo call'); return handler.exchangeInfo(); }
  if (u.pathname === '/fapi/v1/algoOrder' && method === 'POST') { if (!handler.algoOrderPost) throw new Error('unexpected algoOrder POST'); return handler.algoOrderPost(); }
  if (u.pathname === '/fapi/v1/algoOrder' && method === 'DELETE') { if (!handler.algoOrderDelete) throw new Error('unexpected algoOrder DELETE'); return handler.algoOrderDelete(); }
  if (u.pathname === '/fapi/v1/algoOrder' && method === 'GET') { if (!handler.algoOrderGet) throw new Error('unexpected algoOrder GET'); return handler.algoOrderGet(); }
  throw new Error('UNEXPECTED REQUEST in protection test: ' + method + ' ' + u.pathname);
};

const { resolveAndSubmitProtectionOrder, cancelBinanceFuturesProtectionOrder, getBinanceFuturesAlgoOrder, submitBinanceFuturesProtectionOrder } = await import('./binanceFuturesAdapter.js');

const CREDS_TESTNET = { apiKey: 'fake-key-not-real', apiSecret: REAL_SECRET, environment: 'TESTNET' as const };
const CREDS_LIVE = { apiKey: 'fake-key-not-real', apiSecret: REAL_SECRET, environment: 'LIVE' as const };

function exchangeInfoFixture(symbol = 'BTCUSDT') {
  return {
    symbols: [{
      symbol,
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.10', minPrice: '100', maxPrice: '1000000' },
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
        { filterType: 'MARKET_LOT_SIZE', stepSize: '0.01', minQty: '0.01', maxQty: '500' },
        { filterType: 'MIN_NOTIONAL', notional: '100' },
      ],
    }],
  };
}
function algoRawFixture(overrides: any = {}) {
  return Object.assign({
    algoId: 555111, clientAlgoId: 'SL1CLIENT', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH',
    orderType: 'STOP_MARKET', algoStatus: 'NEW', triggerPrice: '63000.00', quantity: '0.020',
    closePosition: false, reduceOnly: true, createTime: 1700000000000,
  }, overrides);
}

async function run() {
  // =====================================================================================
  // PART 1 — one-way mode: reduceOnly sent, positionSide omitted
  // =====================================================================================
  advanceClockPastExchangeInfoCache();
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    exchangeInfo: () => jsonResponse(exchangeInfoFixture()),
    algoOrderPost: () => jsonResponse(algoRawFixture()),
  });
  {
    const result = await resolveAndSubmitProtectionOrder(CREDS_TESTNET, {
      symbol: 'BTC/USDT', side: 'SELL', positionSide: 'BOTH', type: 'STOP_MARKET',
      triggerPrice: 63000, quantity: 0.02, reduceOnly: true, clientAlgoId: 'SL1',
    });
    check('one-way SL: ok', result.ok === true);
    const postCall = calls.find((c) => c.path === '/fapi/v1/algoOrder' && c.method === 'POST');
    check('one-way SL: exactly one POST', calls.filter((c) => c.path === '/fapi/v1/algoOrder' && c.method === 'POST').length === 1);
    check('one-way SL: algoType=CONDITIONAL', !!postCall && postCall.params.algoType === 'CONDITIONAL');
    check('one-way SL: symbol normalized BTC/USDT -> BTCUSDT', !!postCall && postCall.params.symbol === 'BTCUSDT');
    check('one-way SL: type=STOP_MARKET', !!postCall && postCall.params.type === 'STOP_MARKET');
    check('one-way SL: reduceOnly sent as TRUE', !!postCall && postCall.params.reduceOnly === 'TRUE');
    check('one-way SL: positionSide NOT sent (BOTH is Binance default)', !!postCall && postCall.params.positionSide === undefined);
    check('one-way SL: quantity rounded to LOT_SIZE step (0.001), unchanged from 0.02', !!postCall && postCall.params.quantity === '0.02');
    check('one-way SL: clientAlgoId forwarded', !!postCall && postCall.params.clientAlgoId === 'SL1');
    check('one-way SL: workingType=MARK_PRICE default', !!postCall && postCall.params.workingType === 'MARK_PRICE');
    check('one-way SL: priceProtect=TRUE default', !!postCall && postCall.params.priceProtect === 'TRUE');
    check('one-way SL: API key only in header, not URL', !!postCall && postCall.hasApiKeyHeader && !JSON.stringify(postCall.params).includes('fake-key-not-real'));
    check('one-way SL: secret never in params', !!postCall && !JSON.stringify(postCall.params).includes(REAL_SECRET));
    check('one-way SL: carries a real abort signal', !!postCall && postCall.hasSignal);
    if (result.ok) {
      check('one-way SL: algoId stringified', result.snapshot.algoId === '555111');
      check('one-way SL: algoStatus raw preserved (NEW)', result.snapshot.algoStatus === 'NEW');
    }
  }

  // =====================================================================================
  // PART 2 — hedge mode: positionSide sent, reduceOnly never sent even if caller passed true
  // =====================================================================================
  advanceClockPastExchangeInfoCache();
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    exchangeInfo: () => jsonResponse(exchangeInfoFixture()),
    algoOrderPost: () => jsonResponse(algoRawFixture({ positionSide: 'LONG' })),
  });
  {
    const result = await resolveAndSubmitProtectionOrder(CREDS_TESTNET, {
      symbol: 'BTC/USDT', side: 'SELL', positionSide: 'LONG', type: 'STOP_MARKET',
      triggerPrice: 63000, quantity: 0.02, reduceOnly: false, clientAlgoId: 'SL2',
    });
    check('hedge mode SL: ok', result.ok === true);
    const postCall = calls.find((c) => c.path === '/fapi/v1/algoOrder' && c.method === 'POST');
    check('hedge mode SL: positionSide=LONG sent', !!postCall && postCall.params.positionSide === 'LONG');
    check('hedge mode SL: reduceOnly NOT sent (forbidden in Hedge Mode)', !!postCall && postCall.params.reduceOnly === undefined);
  }
  // hedge mode + reduceOnly=true explicitly requested -> BLOCK before any network call (refuse, never silently drop)
  resetFetchMock({});
  {
    const result = await resolveAndSubmitProtectionOrder(CREDS_TESTNET, {
      symbol: 'BTC/USDT', side: 'SELL', positionSide: 'LONG', type: 'STOP_MARKET',
      triggerPrice: 63000, quantity: 0.02, reduceOnly: true, clientAlgoId: 'SL3',
    });
    check('hedge mode + reduceOnly=true: BLOCK before any network call', result.ok === false && calls.length === 0);
  }

  // =====================================================================================
  // PART 3 — TAKE_PROFIT_MARKET, quantity rounding never rounds up
  // =====================================================================================
  advanceClockPastExchangeInfoCache();
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    exchangeInfo: () => jsonResponse(exchangeInfoFixture()),
    algoOrderPost: () => jsonResponse(algoRawFixture({ orderType: 'TAKE_PROFIT_MARKET', side: 'SELL' })),
  });
  {
    const result = await resolveAndSubmitProtectionOrder(CREDS_TESTNET, {
      symbol: 'BTC/USDT', side: 'SELL', positionSide: 'BOTH', type: 'TAKE_PROFIT_MARKET',
      triggerPrice: 66500, quantity: 0.0199, reduceOnly: true, clientAlgoId: 'TP1',
    });
    check('TP order: ok', result.ok === true);
    const postCall = calls.find((c) => c.path === '/fapi/v1/algoOrder' && c.method === 'POST');
    check('TP order: type=TAKE_PROFIT_MARKET', !!postCall && postCall.params.type === 'TAKE_PROFIT_MARKET');
    check('TP order: quantity rounded DOWN to step (0.0199 -> 0.019, never up to 0.02)', !!postCall && postCall.params.quantity === '0.019');
  }

  // =====================================================================================
  // PART 4 — LIVE hard rejected before any network call
  // =====================================================================================
  resetFetchMock({});
  {
    const result = await resolveAndSubmitProtectionOrder(CREDS_LIVE, {
      symbol: 'BTC/USDT', side: 'SELL', positionSide: 'BOTH', type: 'STOP_MARKET',
      triggerPrice: 63000, quantity: 0.02, reduceOnly: true, clientAlgoId: 'SL4',
    });
    check('LIVE: hard rejected', result.ok === false);
    if (!result.ok) check('LIVE: error code live_order_submission_not_supported', result.error.code === 'live_order_submission_not_supported');
    check('LIVE: zero network calls', calls.length === 0);
  }

  // =====================================================================================
  // PART 5 — ambiguous failure: timeout, no auto retry
  // =====================================================================================
  advanceClockPastExchangeInfoCache();
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    exchangeInfo: () => jsonResponse(exchangeInfoFixture()),
    algoOrderPost: () => { throw timeoutError(); },
  });
  {
    const result = await resolveAndSubmitProtectionOrder(CREDS_TESTNET, {
      symbol: 'BTC/USDT', side: 'SELL', positionSide: 'BOTH', type: 'STOP_MARKET',
      triggerPrice: 63000, quantity: 0.02, reduceOnly: true, clientAlgoId: 'SL5',
    });
    check('timeout: ambiguous, no auto retry', result.ok === false && (result as any).ambiguous === true);
    if (!result.ok) check('timeout: error code protection_submission_status_unknown', (result as any).error.code === 'protection_submission_status_unknown');
    check('timeout: exactly one POST attempt', calls.filter((c) => c.method === 'POST').length === 1);
  }

  // =====================================================================================
  // PART 6 — quantity too small (below min notional) -> BLOCK locally, no POST made
  // =====================================================================================
  advanceClockPastExchangeInfoCache();
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    exchangeInfo: () => jsonResponse(exchangeInfoFixture()),
  });
  {
    const result = await resolveAndSubmitProtectionOrder(CREDS_TESTNET, {
      symbol: 'BTC/USDT', side: 'SELL', positionSide: 'BOTH', type: 'STOP_MARKET',
      triggerPrice: 63000, quantity: 0.0001, reduceOnly: true, clientAlgoId: 'SL6', // 0.0001*63000=6.3 << 100 min notional
    });
    check('tiny quantity: BLOCK locally', result.ok === false);
    check('tiny quantity: no POST ever made', calls.filter((c) => c.method === 'POST').length === 0);
  }

  // =====================================================================================
  // PART 7 — Cancel Algo Order: real response shape {algoId, clientAlgoId, code, msg}, symbol not required
  // =====================================================================================
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    algoOrderDelete: () => jsonResponse({ algoId: 555111, clientAlgoId: 'SL1', code: '200', msg: 'success' }),
  });
  {
    const result = await cancelBinanceFuturesProtectionOrder(CREDS_TESTNET, { algoId: '555111' });
    check('cancel: ok', result.ok === true);
    if (result.ok) {
      check('cancel: result.algoId correct (not a fabricated full snapshot)', result.result.algoId === '555111');
      check('cancel: result.clientAlgoId correct', result.result.clientAlgoId === 'SL1');
    }
    const deleteCall = calls.find((c) => c.path === '/fapi/v1/algoOrder' && c.method === 'DELETE');
    check('cancel: no symbol param sent (genuinely not required)', !!deleteCall && deleteCall.params.symbol === undefined);
    check('cancel: algoId param sent', !!deleteCall && deleteCall.params.algoId === '555111');
  }
  // missing both identifiers -> BLOCK before network
  resetFetchMock({});
  {
    const result = await cancelBinanceFuturesProtectionOrder(CREDS_TESTNET, {});
    check('cancel: missing algoId/clientAlgoId -> BLOCK, no network call', result.ok === false && calls.length === 0);
  }

  // =====================================================================================
  // PART 8 — Query Algo Order (recovery lookup): symbol not required, algoId or clientAlgoId
  // =====================================================================================
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    algoOrderGet: () => jsonResponse(algoRawFixture()),
  });
  {
    const result = await getBinanceFuturesAlgoOrder(CREDS_TESTNET, { clientAlgoId: 'SL1CLIENT' });
    check('query by clientAlgoId: ok', result.ok === true);
    const getCall = calls.find((c) => c.path === '/fapi/v1/algoOrder' && c.method === 'GET');
    check('query: clientAlgoId param sent, no symbol', !!getCall && getCall.params.clientAlgoId === 'SL1CLIENT' && getCall.params.symbol === undefined);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
}

run().catch((e) => { console.error('TEST RUNNER ERROR:', e); process.exit(1); });
