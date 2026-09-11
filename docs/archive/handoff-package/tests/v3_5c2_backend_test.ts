// Sprint 3.5C.2 hotfix tests — Binance Account Snapshot Hangs During Real Read.
// Deterministic, mocked-fetch only. NO real network calls to Binance anywhere in this file — every
// test supplies synthetic fixtures via a mocked global.fetch. Credentials below are fake TESTNET
// placeholders (never real, never sent anywhere since fetch itself is intercepted).

// ---- fake clock: lets each test group force the per-environment offset cache (TTL 45000ms) to
// expire deterministically, with no real waiting, so request counts stay exact per test group. ----
let fakeNow = 1700000000000;
const realDateNow = Date.now.bind(Date);
(Date as any).now = () => fakeNow;
function advanceClockPastOffsetCache() { fakeNow += 46000; }

// ---- fetch mock -----------------------------------------------------------------------------
type Handler = {
  time?: () => Response | Promise<Response>;
  account?: () => Response | Promise<Response>;
  positionRisk?: () => Response | Promise<Response>;
  openAlgoOrders?: (symbol: string) => Response | Promise<Response>;
};
type CallLog = { path: string; symbol?: string; hasSignal: boolean };
let calls: CallLog[] = [];
let handler: Handler = {};
function resetFetchMock(h: Handler) { calls = []; handler = h; }
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function timeoutError(): Error {
  const e: any = new Error('The operation was aborted due to timeout');
  e.name = 'TimeoutError';
  return e;
}
function networkErr(): Error {
  const e: any = new Error('fetch failed: ECONNRESET');
  e.name = 'FetchError';
  return e;
}
(global as any).fetch = async (url: string, opts: any) => {
  const u = new URL(String(url));
  const hasSignal = !!(opts && opts.signal);
  if (u.pathname === '/fapi/v1/time') {
    calls.push({ path: 'time', hasSignal });
    if (!handler.time) throw new Error('unexpected /fapi/v1/time call');
    return handler.time();
  }
  if (u.pathname === '/fapi/v2/account') {
    calls.push({ path: 'account', hasSignal });
    if (!handler.account) throw new Error('unexpected /fapi/v2/account call');
    return handler.account();
  }
  if (u.pathname === '/fapi/v2/positionRisk') {
    calls.push({ path: 'positionRisk', hasSignal });
    if (!handler.positionRisk) throw new Error('unexpected /fapi/v2/positionRisk call');
    return handler.positionRisk();
  }
  if (u.pathname === '/fapi/v1/openAlgoOrders') {
    const symbol = u.searchParams.get('symbol') || '';
    calls.push({ path: 'openAlgoOrders', symbol, hasSignal });
    if (!handler.openAlgoOrders) throw new Error('unexpected /fapi/v1/openAlgoOrders call');
    return handler.openAlgoOrders(symbol);
  }
  throw new Error('UNEXPECTED PATH in 3.5C.2 test: ' + u.pathname);
};

const { getBinanceFuturesAccountSnapshot, testBinanceFuturesConnection } = await import('./binanceFuturesAdapter.js');

const CREDS = { apiKey: 'fake-key-not-real', apiSecret: 'fake-secret-not-real', environment: 'TESTNET' as const };

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean) { if (cond) pass++; else { fail++; failures.push(name); console.log('FAIL:', name); } }

function accountRaw(overrides: any = {}) {
  return Object.assign({
    canTrade: true, totalWalletBalance: '10000', totalUnrealizedProfit: '0', totalMarginBalance: '10000',
    totalInitialMargin: '0', totalMaintMargin: '0', availableBalance: '10000',
    assets: [{ asset: 'USDT', walletBalance: '10000', availableBalance: '10000' }],
    positions: [{ symbol: 'BTCUSDT', initialMargin: '326', maintMargin: '16.3' }],
  }, overrides);
}
function btcPosition(overrides: any = {}) {
  return Object.assign({
    symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0.5', entryPrice: '65000', markPrice: '65200',
    unRealizedProfit: '100', liquidationPrice: '58000', leverage: '10', marginType: 'isolated',
    isolatedMargin: '3250', notional: '32600', breakEvenPrice: '65010',
  }, overrides);
}
function algoOrder(overrides: any = {}) {
  return Object.assign({
    algoId: 1, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', orderType: 'STOP_MARKET',
    algoStatus: 'NEW', triggerPrice: '60000', quantity: '0.5', closePosition: false, reduceOnly: true,
    createTime: 1700000000000,
  }, overrides);
}

async function run() {
  // 1. account + positionRisk + protection all succeed, one open BTCUSDT position -> snapshot ok,
  //    protectionReadStatus 'OK', protective order attached, exactly 4 requests total.
  advanceClockPastOffsetCache();
  resetFetchMock({
    time: () => jsonResponse({ serverTime: fakeNow }),
    account: () => jsonResponse(accountRaw()),
    positionRisk: () => jsonResponse([btcPosition()]),
    openAlgoOrders: (symbol) => jsonResponse(symbol === 'BTCUSDT' ? [algoOrder()] : []),
  });
  {
    const result = await getBinanceFuturesAccountSnapshot('conn-1', CREDS);
    check('success: ok', result.ok === true);
    if (result.ok) {
      check('success: protectionReadStatus OK', result.snapshot.protectionReadStatus === 'OK');
      check('success: one position', result.snapshot.positions.length === 1);
      check('success: stop-loss attached', result.snapshot.positions[0].protection.stopLossOrders.length === 1);
    }
    check('success: exactly 4 requests (time, account, positionRisk, 1 scoped openAlgoOrders)', calls.length === 4);
    check('success: one openAlgoOrders call', calls.filter((c) => c.path === 'openAlgoOrders').length === 1);
    check('success: openAlgoOrders call is scoped to symbol=BTCUSDT', calls.find((c) => c.path === 'openAlgoOrders')?.symbol === 'BTCUSDT');
    check('success: every Binance (non-time) call carries a real abort signal', calls.filter((c) => c.path !== 'time').every((c) => c.hasSignal));
  }

  // 2. account request times out -> whole snapshot fails (REQUIRED), specific timeout message.
  advanceClockPastOffsetCache();
  resetFetchMock({
    time: () => jsonResponse({ serverTime: fakeNow }),
    account: () => { throw timeoutError(); },
    positionRisk: () => jsonResponse([btcPosition()]),
    openAlgoOrders: () => jsonResponse([]),
  });
  {
    const result = await getBinanceFuturesAccountSnapshot('conn-1', CREDS);
    check('account timeout: ok=false', result.ok === false);
    if (!result.ok) {
      check('account timeout: error code timeout', result.error.code === 'timeout');
      check('account timeout: required-read timeout message', result.error.message === '读取 Binance 账户超时，请稍后重试');
    }
    check('account timeout: no openAlgoOrders call made', calls.filter((c) => c.path === 'openAlgoOrders').length === 0);
  }

  // 3. positionRisk request times out -> whole snapshot fails (REQUIRED).
  advanceClockPastOffsetCache();
  resetFetchMock({
    time: () => jsonResponse({ serverTime: fakeNow }),
    account: () => jsonResponse(accountRaw()),
    positionRisk: () => { throw timeoutError(); },
    openAlgoOrders: () => jsonResponse([]),
  });
  {
    const result = await getBinanceFuturesAccountSnapshot('conn-1', CREDS);
    check('positionRisk timeout: ok=false', result.ok === false);
    if (!result.ok) check('positionRisk timeout: error code timeout', result.error.code === 'timeout');
    check('positionRisk timeout: no openAlgoOrders call made', calls.filter((c) => c.path === 'openAlgoOrders').length === 0);
  }

  // 4. openAlgoOrders (the only open symbol) times out -> snapshot STILL SUCCEEDS (OPTIONAL/best-
  //    effort), protectionReadStatus 'TIMEOUT', protectiveOrders empty (never fabricated as "verified empty").
  advanceClockPastOffsetCache();
  resetFetchMock({
    time: () => jsonResponse({ serverTime: fakeNow }),
    account: () => jsonResponse(accountRaw()),
    positionRisk: () => jsonResponse([btcPosition()]),
    openAlgoOrders: () => { throw timeoutError(); },
  });
  {
    const result = await getBinanceFuturesAccountSnapshot('conn-1', CREDS);
    check('openAlgoOrders timeout: snapshot still ok', result.ok === true);
    if (result.ok) {
      check('openAlgoOrders timeout: protectionReadStatus TIMEOUT', result.snapshot.protectionReadStatus === 'TIMEOUT');
      check('openAlgoOrders timeout: protectiveOrders empty', result.snapshot.protectiveOrders.length === 0);
      check('openAlgoOrders timeout: position still present', result.snapshot.positions.length === 1);
    }
  }

  // 5. openAlgoOrders network error (non-timeout) -> snapshot still succeeds, protectionReadStatus 'UNAVAILABLE'.
  advanceClockPastOffsetCache();
  resetFetchMock({
    time: () => jsonResponse({ serverTime: fakeNow }),
    account: () => jsonResponse(accountRaw()),
    positionRisk: () => jsonResponse([btcPosition()]),
    openAlgoOrders: () => { throw networkErr(); },
  });
  {
    const result = await getBinanceFuturesAccountSnapshot('conn-1', CREDS);
    check('openAlgoOrders network error: snapshot still ok', result.ok === true);
    if (result.ok) check('openAlgoOrders network error: protectionReadStatus UNAVAILABLE', result.snapshot.protectionReadStatus === 'UNAVAILABLE');
  }

  // 6. zero open positions -> zero openAlgoOrders requests at all, protectionReadStatus 'OK'
  //    (genuinely nothing to check, distinct from "couldn't check").
  advanceClockPastOffsetCache();
  resetFetchMock({
    time: () => jsonResponse({ serverTime: fakeNow }),
    account: () => jsonResponse(accountRaw({ positions: [] })),
    positionRisk: () => jsonResponse([btcPosition({ positionAmt: '0' })]), // zero amount -> not an open position
    openAlgoOrders: () => jsonResponse([]),
  });
  {
    const result = await getBinanceFuturesAccountSnapshot('conn-1', CREDS);
    check('zero positions: ok', result.ok === true);
    if (result.ok) {
      check('zero positions: protectionReadStatus OK', result.snapshot.protectionReadStatus === 'OK');
      check('zero positions: positions empty', result.snapshot.positions.length === 0);
    }
    check('zero positions: no openAlgoOrders request made', calls.filter((c) => c.path === 'openAlgoOrders').length === 0);
  }

  // 7. two distinct open-position symbols -> exactly two scoped openAlgoOrders calls.
  advanceClockPastOffsetCache();
  resetFetchMock({
    time: () => jsonResponse({ serverTime: fakeNow }),
    account: () => jsonResponse(accountRaw({ positions: [{ symbol: 'BTCUSDT' }, { symbol: 'ETHUSDT' }] })),
    positionRisk: () => jsonResponse([btcPosition(), btcPosition({ symbol: 'ETHUSDT', positionAmt: '2' })]),
    openAlgoOrders: () => jsonResponse([]),
  });
  {
    const result = await getBinanceFuturesAccountSnapshot('conn-1', CREDS);
    check('two symbols: ok', result.ok === true);
    const algoCalls = calls.filter((c) => c.path === 'openAlgoOrders');
    check('two symbols: exactly two openAlgoOrders calls', algoCalls.length === 2);
    check('two symbols: symbols are BTCUSDT and ETHUSDT', algoCalls.some((c) => c.symbol === 'BTCUSDT') && algoCalls.some((c) => c.symbol === 'ETHUSDT'));
  }

  // 8. hedge-mode duplicate symbol (LONG + SHORT rows on the same symbol) -> deduped to ONE call.
  advanceClockPastOffsetCache();
  resetFetchMock({
    time: () => jsonResponse({ serverTime: fakeNow }),
    account: () => jsonResponse(accountRaw()),
    positionRisk: () => jsonResponse([
      btcPosition({ positionSide: 'LONG', positionAmt: '0.5' }),
      btcPosition({ positionSide: 'SHORT', positionAmt: '-0.3' }),
    ]),
    openAlgoOrders: () => jsonResponse([]),
  });
  {
    const result = await getBinanceFuturesAccountSnapshot('conn-1', CREDS);
    check('hedge-mode dedup: ok', result.ok === true);
    check('hedge-mode dedup: exactly one openAlgoOrders call despite two position rows', calls.filter((c) => c.path === 'openAlgoOrders').length === 1);
    if (result.ok) check('hedge-mode dedup: both position rows still present', result.snapshot.positions.length === 2);
  }

  // 9. two symbols, ONE symbol's protection request fails while the other succeeds -> partial
  //    protection retained (the successful symbol's orders are NOT discarded).
  advanceClockPastOffsetCache();
  resetFetchMock({
    time: () => jsonResponse({ serverTime: fakeNow }),
    account: () => jsonResponse(accountRaw({ positions: [{ symbol: 'BTCUSDT' }, { symbol: 'ETHUSDT' }] })),
    positionRisk: () => jsonResponse([btcPosition(), btcPosition({ symbol: 'ETHUSDT', positionAmt: '2' })]),
    openAlgoOrders: (symbol) => { if (symbol === 'BTCUSDT') return jsonResponse([algoOrder()]); throw timeoutError(); },
  });
  {
    const result = await getBinanceFuturesAccountSnapshot('conn-1', CREDS);
    check('partial success: snapshot still ok', result.ok === true);
    if (result.ok) {
      check('partial success: overall status TIMEOUT (one symbol failed)', result.snapshot.protectionReadStatus === 'TIMEOUT');
      const btc = result.snapshot.positions.find((p) => p.symbol === 'BTCUSDT');
      check('partial success: BTCUSDT protection retained despite ETHUSDT failure', !!btc && btc.protection.stopLossOrders.length === 1);
    }
  }

  // 10. testBinanceFuturesConnection still works standalone (regression: signedGet's added
  //     `environment` parameter didn't break the smallest read, and it never touches positionRisk/openAlgoOrders).
  advanceClockPastOffsetCache();
  resetFetchMock({
    time: () => jsonResponse({ serverTime: fakeNow }),
    account: () => jsonResponse(accountRaw()),
  });
  {
    const result = await testBinanceFuturesConnection(CREDS);
    check('testConnection: still ok after signedGet signature change', result.ok === true);
    check('testConnection: touches neither positionRisk nor openAlgoOrders', calls.filter((c) => c.path === 'positionRisk' || c.path === 'openAlgoOrders').length === 0);
  }

  // 11. offset cache: a second refresh within the TTL reuses the cached offset -> no second
  //     /fapi/v1/time call (the request-count reduction this hotfix claims).
  advanceClockPastOffsetCache();
  resetFetchMock({
    time: () => jsonResponse({ serverTime: fakeNow }),
    account: () => jsonResponse(accountRaw()),
    positionRisk: () => jsonResponse([]),
    openAlgoOrders: () => jsonResponse([]),
  });
  await getBinanceFuturesAccountSnapshot('conn-1', CREDS); // primes the cache
  const timeCallsAfterFirst = calls.filter((c) => c.path === 'time').length;
  await getBinanceFuturesAccountSnapshot('conn-1', CREDS); // within TTL — must NOT re-hit /fapi/v1/time
  const timeCallsAfterSecond = calls.filter((c) => c.path === 'time').length;
  check('offset cache: first refresh fetches server time exactly once', timeCallsAfterFirst === 1);
  check('offset cache: second refresh within TTL reuses cached offset (no extra /fapi/v1/time call)', timeCallsAfterSecond === timeCallsAfterFirst);

  (Date as any).now = realDateNow;
  console.log(`\n3.5C.2 backend tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
}

run();
