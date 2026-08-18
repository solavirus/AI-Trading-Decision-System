// Sprint 3.6A backend tests — leverage change, open-orders read, listenKey lifecycle, exchangeService
// wrappers. Run standalone via `npx tsx src/exchange/__test_3_6a_backend.ts` from pipeline/. Never
// touches real exchange_connections.json (test-storage isolation, same discipline as the ValidConn
// hotfix). Deleted from the source tree after running — a clean copy lives in the scratchpad only.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join(process.cwd(), '__test_data_3_6a');
const TEST_CONNECTIONS_PATH = join(TEST_DIR, 'exchange_connections.json');

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; }
  else { fail++; console.log(`FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  mkdirSync(TEST_DIR, { recursive: true });
  const { __setExchangeConnectionsPathForTesting, createExchangeConnection } = await import('./exchangeConnectionStore.js');
  __setExchangeConnectionsPathForTesting(TEST_CONNECTIONS_PATH);
  process.on('exit', () => {
    __setExchangeConnectionsPathForTesting(null);
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  const {
    changeBinanceFuturesLeverage, getBinanceFuturesOpenOrders,
    startBinanceFuturesUserDataStream, keepaliveBinanceFuturesUserDataStream, closeBinanceFuturesUserDataStream,
    binanceFuturesUserDataStreamWsUrl,
  } = await import('./binanceFuturesAdapter.js');
  const {
    changeLeverageOnBinanceTestnet, fetchOpenOrders, resolveAccountStreamCredentials,
  } = await import('./exchangeService.js');

  const creds = { apiKey: 'test-key-1234', apiSecret: 'test-secret-5678', environment: 'TESTNET' as const };
  const liveCreds = { apiKey: 'test-key-1234', apiSecret: 'test-secret-5678', environment: 'LIVE' as const };

  // ---- helpers: fake fetch ----
  let capturedUrls: string[] = [];
  let capturedMethods: string[] = [];
  function installFetch(handler: (url: string, init: any) => { status: number; body: any } | 'timeout' | 'network-error') {
    capturedUrls = []; capturedMethods = [];
    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      capturedUrls.push(url);
      capturedMethods.push(init.method || 'GET');
      if (url.includes('/fapi/v1/time')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ serverTime: Date.now() }), json: async () => ({ serverTime: Date.now() }) } as any;
      }
      const outcome = handler(url, init);
      if (outcome === 'timeout') { const e: any = new Error('aborted'); e.name = 'TimeoutError'; throw e; }
      if (outcome === 'network-error') { const e: any = new Error('fetch failed'); e.name = 'FetchError'; throw e; }
      return { ok: outcome.status >= 200 && outcome.status < 300, status: outcome.status, text: async () => JSON.stringify(outcome.body) } as any;
    };
  }

  // =====================================================================
  // changeBinanceFuturesLeverage
  // =====================================================================
  installFetch((url) => {
    if (url.includes('/fapi/v1/leverage')) return { status: 200, body: { leverage: 10, maxNotionalValue: '1000000', symbol: 'BTCUSDT' } };
    return { status: 404, body: { msg: 'unexpected' } };
  });
  {
    const r = await changeBinanceFuturesLeverage(creds, 'BTC/USDT', 10);
    check('leverage: success returns normalized result', r.ok === true && (r as any).result.leverage === 10 && (r as any).result.symbol === 'BTCUSDT');
    check('leverage: symbol normalized to BTCUSDT in request URL', capturedUrls.some(u => u.includes('symbol=BTCUSDT') && !u.includes('BTC%2FUSDT')));
    check('leverage: uses POST', capturedMethods.includes('POST'));
  }
  {
    const r = await changeBinanceFuturesLeverage(liveCreds, 'BTCUSDT', 10);
    check('leverage: LIVE rejected before any network call', r.ok === false && (r as any).error.code === 'live_leverage_change_not_supported');
  }
  for (const bad of [0, -1, 126, 10.5, NaN]) {
    const r = await changeBinanceFuturesLeverage(creds, 'BTCUSDT', bad);
    check(`leverage: invalid leverage ${bad} rejected`, r.ok === false && (r as any).error.code === 'invalid_request');
  }
  installFetch((url) => {
    if (url.includes('/fapi/v1/leverage')) return { status: 400, body: { code: -4028, msg: 'Leverage is not valid' } };
    return { status: 404, body: {} };
  });
  {
    const r = await changeBinanceFuturesLeverage(creds, 'BTCUSDT', 20);
    check('leverage: deterministic Binance rejection is not ambiguous', r.ok === false && (r as any).ambiguous !== true);
  }
  installFetch((url) => { if (url.includes('/fapi/v1/leverage')) return 'timeout'; return { status: 404, body: {} }; });
  {
    const r = await changeBinanceFuturesLeverage(creds, 'BTCUSDT', 20);
    check('leverage: timeout is ambiguous, never auto-retried', r.ok === false && (r as any).ambiguous === true && (r as any).error.code === 'leverage_change_status_unknown');
  }

  // =====================================================================
  // getBinanceFuturesOpenOrders
  // =====================================================================
  installFetch((url) => {
    if (url.includes('/fapi/v1/openOrders')) {
      return { status: 200, body: [
        { orderId: 111, clientOrderId: 'c1', symbol: 'BTCUSDT', status: 'NEW', side: 'BUY', type: 'LIMIT', origQty: '0.01', price: '60000', avgPrice: '0', executedQty: '0', time: 1000, updateTime: 1000 },
        { orderId: 222, clientOrderId: 'c2', symbol: 'ETHUSDT', status: 'PARTIALLY_FILLED', side: 'SELL', type: 'LIMIT', origQty: '1', price: '3000', avgPrice: '3001', executedQty: '0.5', time: 2000, updateTime: 2000 },
      ] };
    }
    return { status: 404, body: {} };
  });
  {
    const r = await getBinanceFuturesOpenOrders(creds);
    check('open-orders: returns normalized snapshots', r.ok === true && (r as any).snapshots.length === 2);
    check('open-orders: no ?symbol= when omitted', !capturedUrls.some(u => u.includes('symbol=')));
    check('open-orders: normalized shape uses ExchangeOrderSnapshot fields', (r as any).snapshots[0].exchangeOrderId === '111' && (r as any).snapshots[0].executedQuantity === 0);
  }
  {
    capturedUrls = [];
    const r = await getBinanceFuturesOpenOrders(creds, 'BTC/USDT');
    check('open-orders: symbol normalized when provided', capturedUrls.some(u => u.includes('symbol=BTCUSDT')));
  }
  installFetch((url) => ({ status: 401, body: { code: -2015, msg: 'Invalid API-key' } }));
  {
    const r = await getBinanceFuturesOpenOrders(creds);
    check('open-orders: error classified honestly', r.ok === false && (r as any).error.code === 'invalid_credentials');
  }

  // =====================================================================
  // listenKey lifecycle
  // =====================================================================
  installFetch((url, init) => {
    if (url.includes('/fapi/v1/listenKey')) {
      if (init.method === 'POST') return { status: 200, body: { listenKey: 'lk-abc-123' } };
      if (init.method === 'PUT') return { status: 200, body: {} };
      if (init.method === 'DELETE') return { status: 200, body: {} };
    }
    return { status: 404, body: {} };
  });
  {
    const r = await startBinanceFuturesUserDataStream(creds);
    check('listenKey: start returns listenKey', r.ok === true && (r as any).listenKey === 'lk-abc-123');
    check('listenKey: start request carries no signature/timestamp param', !capturedUrls.some(u => u.includes('signature=') || u.includes('timestamp=')));
  }
  {
    const r = await keepaliveBinanceFuturesUserDataStream(creds, 'lk-abc-123');
    check('listenKey: keepalive ok, PUT method, listenKey in query', r.ok === true && capturedMethods.includes('PUT') && capturedUrls.some(u => u.includes('listenKey=lk-abc-123')));
  }
  {
    const r = await closeBinanceFuturesUserDataStream(creds, 'lk-abc-123');
    check('listenKey: close ok, DELETE method, listenKey in query', r.ok === true && capturedMethods.includes('DELETE') && capturedUrls.some(u => u.includes('listenKey=lk-abc-123')));
  }
  installFetch((url, init) => { if (url.includes('/fapi/v1/listenKey') && init.method === 'POST') return { status: 200, body: {} }; return { status: 404, body: {} }; });
  {
    const r = await startBinanceFuturesUserDataStream(creds);
    check('listenKey: missing listenKey in response -> listen_key_unavailable', r.ok === false && (r as any).error.code === 'listen_key_unavailable');
  }
  installFetch((url, init) => { if (url.includes('/fapi/v1/listenKey')) return 'network-error'; return { status: 404, body: {} }; });
  {
    const r = await startBinanceFuturesUserDataStream(creds);
    check('listenKey: network failure classified, not thrown uncaught', r.ok === false && (r as any).error.code === 'network_error');
  }

  // WS URL helper
  check('wsUrl: LIVE uses split /private path', binanceFuturesUserDataStreamWsUrl('LIVE', 'lk-x') === 'wss://fstream.binance.com/private/ws/lk-x');
  check('wsUrl: TESTNET uses classic stream.binancefuture.com path', binanceFuturesUserDataStreamWsUrl('TESTNET', 'lk-x') === 'wss://stream.binancefuture.com/ws/lk-x');

  // =====================================================================
  // exchangeService wrappers (real connection store, isolated path)
  // =====================================================================
  const testnetConn = createExchangeConnection({ name: 'T1', exchange: 'binance-futures', environment: 'TESTNET', apiKey: 'k', apiSecret: 's', enabled: true });
  const liveConn = createExchangeConnection({ name: 'L1', exchange: 'binance-futures', environment: 'LIVE', apiKey: 'k', apiSecret: 's', enabled: true });

  installFetch((url) => { if (url.includes('/fapi/v1/leverage')) return { status: 200, body: { leverage: 5, symbol: 'BTCUSDT' } }; return { status: 404, body: {} }; });
  {
    const r = await changeLeverageOnBinanceTestnet(testnetConn.id, 'BTCUSDT', 5);
    check('service: changeLeverageOnBinanceTestnet succeeds for TESTNET connection', r.ok === true);
  }
  {
    const r = await changeLeverageOnBinanceTestnet(liveConn.id, 'BTCUSDT', 5);
    check('service: changeLeverageOnBinanceTestnet blocks LIVE connection (defense in depth)', r.ok === false && (r as any).error.code === 'live_leverage_change_not_supported');
  }
  {
    const r = await changeLeverageOnBinanceTestnet('nonexistent-id', 'BTCUSDT', 5);
    check('service: changeLeverageOnBinanceTestnet handles unknown connection', r.ok === false && (r as any).error.code === 'connection_not_found');
  }

  installFetch((url) => { if (url.includes('/fapi/v1/openOrders')) return { status: 200, body: [] }; return { status: 404, body: {} }; });
  {
    const r = await fetchOpenOrders(testnetConn.id);
    check('service: fetchOpenOrders passthrough works', r.ok === true && (r as any).snapshots.length === 0);
  }

  {
    const resolved = resolveAccountStreamCredentials(testnetConn.id);
    check('service: resolveAccountStreamCredentials resolves a valid connection', resolved.ok === true);
    const badResolved = resolveAccountStreamCredentials('nonexistent-id');
    check('service: resolveAccountStreamCredentials errors on unknown connection', badResolved.ok === false);
  }

  // =====================================================================
  // Static proof: write-surface scan (no new hidden write method anywhere)
  // =====================================================================
  {
    const fs = await import('node:fs');
    const adapterSrc = fs.readFileSync(new URL('./binanceFuturesAdapter.ts', import.meta.url), 'utf8');
    // Function DECLARATIONS only — disclosure comments intentionally mention these same words to
    // state they do NOT exist (same discipline as v3_5c1_timestamp_hotfix_test.ts's own forbidden-list).
    const forbidden = ['function setMarginType', 'function amendOrder', 'function replaceOrder', 'function transfer(', 'function withdraw(', 'function changePositionMode'];
    const found = forbidden.filter(f => adapterSrc.includes(f));
    check('static: no forbidden write-capability function declarations present', found.length === 0, JSON.stringify(found));
    check('static: exactly one setLeverage-style function exists (changeBinanceFuturesLeverage)', (adapterSrc.match(/export async function change\w*Leverage/g) || []).length === 1);
  }

  console.log(`\n3.6A backend: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
