// Sprint 3.5D-A backend tests — Real Order Lifecycle Foundation (read-only order query).
// Deterministic, mocked-fetch only. NO real network calls to Binance anywhere in this file.

type Handler = { time?: () => Response | Promise<Response>; order?: () => Response | Promise<Response> };
type CallLog = { path: string; symbol?: string; orderId?: string; hasSignal: boolean };
let calls: CallLog[] = [];
let handler: Handler = {};
function resetFetchMock(h: Handler) { calls = []; handler = h; }
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
(global as any).fetch = async (url: string, opts: any) => {
  const u = new URL(String(url));
  const hasSignal = !!(opts && opts.signal);
  if (u.pathname === '/fapi/v1/time') {
    calls.push({ path: 'time', hasSignal });
    if (!handler.time) throw new Error('unexpected /fapi/v1/time call');
    return handler.time();
  }
  if (u.pathname === '/fapi/v1/order') {
    calls.push({ path: 'order', symbol: u.searchParams.get('symbol') || '', orderId: u.searchParams.get('orderId') || '', hasSignal });
    if (!handler.order) throw new Error('unexpected /fapi/v1/order call');
    return handler.order();
  }
  throw new Error('UNEXPECTED PATH in 3.5D-A test: ' + u.pathname);
};

const { normalizeExchangeOrder, getBinanceFuturesOrder } = await import('./binanceFuturesAdapter.js');

const CREDS = { apiKey: 'fake-key-not-real', apiSecret: 'fake-secret-not-real', environment: 'TESTNET' as const };

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean) { if (cond) pass++; else { fail++; failures.push(name); console.log('FAIL:', name); } }

function orderRaw(overrides: any = {}) {
  return Object.assign({
    orderId: 5001, clientOrderId: 'myOrder1', symbol: 'BTCUSDT', status: 'NEW', side: 'BUY',
    positionSide: 'BOTH', type: 'LIMIT', origType: 'LIMIT', origQty: '0.500', price: '65000.00',
    avgPrice: '0.00', executedQty: '0.000', stopPrice: '0.00', reduceOnly: false, closePosition: false,
    time: 1700000000000, updateTime: 1700000000000,
  }, overrides);
}

// ---- Part 1: normalizeExchangeOrder (pure) ----
(function testNormalize() {
  const n1 = normalizeExchangeOrder(orderRaw());
  check('NEW: exchangeOrderId stringified', n1.exchangeOrderId === '5001');
  check('NEW: clientOrderId preserved', n1.clientOrderId === 'myOrder1');
  check('NEW: status preserved raw', n1.status === 'NEW');
  check('NEW: executedQuantity is 0, not null', n1.executedQuantity === 0);
  check('NEW: averagePrice 0.00 -> null (never a fabricated real price)', n1.averagePrice === null);
  check('NEW: price 65000 preserved', n1.price === 65000);
  check('NEW: originalQuantity preserved', n1.originalQuantity === 0.5);
  check('NEW: createdAt/updatedAt from time/updateTime', n1.createdAt === new Date(1700000000000).toISOString() && n1.updatedAt === new Date(1700000000000).toISOString());

  const n2 = normalizeExchangeOrder(orderRaw({ status: 'PARTIALLY_FILLED', executedQty: '0.200', avgPrice: '65010.50' }));
  check('PARTIALLY_FILLED: executedQuantity normalized', n2.executedQuantity === 0.2);
  check('PARTIALLY_FILLED: averagePrice normalized (non-zero)', n2.averagePrice === 65010.5);

  const n3 = normalizeExchangeOrder(orderRaw({ status: 'FILLED', executedQty: '0.500', avgPrice: '65005.00' }));
  check('FILLED: executedQuantity == originalQuantity', n3.executedQuantity === 0.5);

  const n4 = normalizeExchangeOrder(orderRaw({ status: 'CANCELED' }));
  check('CANCELED: raw status preserved as-is (mapping happens elsewhere)', n4.status === 'CANCELED');

  const n5 = normalizeExchangeOrder(orderRaw({ status: 'REJECTED' }));
  check('REJECTED: raw status preserved', n5.status === 'REJECTED');

  const n6 = normalizeExchangeOrder(orderRaw({ status: 'EXPIRED' }));
  check('EXPIRED: raw status preserved', n6.status === 'EXPIRED');

  const n7 = normalizeExchangeOrder(orderRaw({ status: 'SOME_FUTURE_STATUS' }));
  check('unknown remote status: preserved verbatim, not corrupted/guessed', n7.status === 'SOME_FUTURE_STATUS');

  const n8 = normalizeExchangeOrder(orderRaw({ origQty: 'not-a-number', executedQty: 'garbage', avgPrice: 'garbage', price: 'garbage' }));
  check('malformed origQty -> null, never a guess', n8.originalQuantity === null);
  check('malformed executedQty -> 0, never null (0 is meaningful, NaN is not)', n8.executedQuantity === 0);
  check('malformed avgPrice -> null', n8.averagePrice === null);
  check('malformed price -> null', n8.price === null);

  const n9 = normalizeExchangeOrder(orderRaw({ clientOrderId: undefined }));
  check('missing clientOrderId -> null, not undefined/crash', n9.clientOrderId === null);

  const n10 = normalizeExchangeOrder(orderRaw({ side: 'SELL' }));
  check('side SELL preserved', n10.side === 'SELL');
})();

// ---- Part 2: getBinanceFuturesOrder (network + error classification) ----
async function runNetworkTests() {
  // success
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    order: () => jsonResponse(orderRaw({ orderId: 9999, status: 'FILLED', executedQty: '0.500', avgPrice: '65005.00' })),
  });
  {
    const result = await getBinanceFuturesOrder(CREDS, 'BTCUSDT', { orderId: '9999' }); // Sprint 3.5D-B — getBinanceFuturesOrder now takes an OrderLookupId (orderId | origClientOrderId)
    check('success: ok', result.ok === true);
    if (result.ok) {
      check('success: snapshot status FILLED', result.snapshot.status === 'FILLED');
      check('success: exchangeOrderId stringified', result.snapshot.exchangeOrderId === '9999');
    }
    const orderCalls = calls.filter((c) => c.path === 'order');
    check('success: exactly one /fapi/v1/order call', orderCalls.length === 1);
    check('success: call carries the requested symbol', orderCalls[0].symbol === 'BTCUSDT');
    check('success: call carries the requested orderId', orderCalls[0].orderId === '9999');
    check('success: call carries a real abort signal (bounded read, same as account snapshot reads)', orderCalls[0].hasSignal === true);
  }

  // order not found (-2013)
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    order: () => jsonResponse({ code: -2013, msg: 'Order does not exist.' }, 400),
  });
  {
    const result = await getBinanceFuturesOrder(CREDS, 'BTCUSDT', { orderId: '424242' });
    check('order not found: ok=false', result.ok === false);
    if (!result.ok) {
      check('order not found: error code order_not_found', result.error.code === 'order_not_found');
    }
  }

  // network timeout
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    order: () => { const e: any = new Error('timed out'); e.name = 'TimeoutError'; throw e; },
  });
  {
    const result = await getBinanceFuturesOrder(CREDS, 'BTCUSDT', { orderId: '1' });
    check('order query timeout: ok=false', result.ok === false);
    if (!result.ok) check('order query timeout: error code timeout', result.error.code === 'timeout');
  }

  // malformed response
  resetFetchMock({
    time: () => jsonResponse({ serverTime: Date.now() }),
    order: () => new Response('not json{{{', { status: 200 }),
  });
  {
    const result = await getBinanceFuturesOrder(CREDS, 'BTCUSDT', { orderId: '1' });
    check('malformed response: ok=false', result.ok === false);
    if (!result.ok) check('malformed response: error code malformed_response', result.error.code === 'malformed_response');
  }

  console.log(`\n3.5D-A backend tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
}

runNetworkTests();
