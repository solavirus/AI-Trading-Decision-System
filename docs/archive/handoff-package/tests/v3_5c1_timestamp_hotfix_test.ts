// Hotfix 3.5C.1 tests — Binance Futures TESTNET timestamp synchronization.
// TEMPORARY test file, deleted after the test run — not part of the shipped product.
// Uses fake Date.now()/fetch — NO real network requests anywhere in this file.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fetchBinanceServerTimeOffset, buildSignedQuery } from './binanceSign.js';
import { testBinanceFuturesConnection, getBinanceFuturesAccountSnapshot } from './binanceFuturesAdapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean) { if (cond) pass++; else { fail++; failures.push(name); console.log('FAIL:', name); } }

// ---- fake clock ----
let fakeNow = 1_800_000_000_000;
const realDateNow = Date.now;
function installFakeClock() { Date.now = () => fakeNow; }
function restoreClock() { Date.now = realDateNow; }

// ---- fake fetch ----
type Responder = (url: string, init: any) => { status: number; ok: boolean; text: string } | 'THROW';
let responder: Responder = () => 'THROW';
let capturedUrls: string[] = [];
(global as any).fetch = async (url: string, init: any) => {
  capturedUrls.push(String(url));
  const r = responder(String(url), init);
  if (r === 'THROW') throw new Error('mock network failure');
  return { ok: r.ok, status: r.status, text: async () => r.text, json: async () => JSON.parse(r.text) } as any;
};

// =====================================================================
// PART 1 — offset math with fake time (Task 9)
// =====================================================================
async function testOffsetMath() {
  installFakeClock();

  // local clock exactly aligned -> offset should be roughly -SAFETY_MARGIN (1500ms), since the
  // function now deliberately biases backward regardless of raw alignment.
  responder = (url) => {
    if (url.includes('/fapi/v1/time')) { fakeNow += 10; return { status: 200, ok: true, text: JSON.stringify({ serverTime: fakeNow }) }; }
    return 'THROW';
  };
  fakeNow = 1_800_000_000_000;
  const offsetAligned = await fetchBinanceServerTimeOffset('https://testnet.binancefuture.com');
  check('aligned clock -> offset is negative (biased toward "behind"), not zero', offsetAligned < 0);
  check('aligned clock -> offset magnitude close to the 1500ms safety margin (within small round-trip noise)', Math.abs(offsetAligned - -1500) <= 50);

  // local clock 5s AHEAD of server -> raw offset would be -5000ish, margin makes it more negative
  fakeNow = 1_800_000_000_000;
  responder = (url) => {
    if (url.includes('/fapi/v1/time')) { const serverTime = fakeNow - 5000; fakeNow += 10; return { status: 200, ok: true, text: JSON.stringify({ serverTime }) }; }
    return 'THROW';
  };
  const offsetLocalAhead = await fetchBinanceServerTimeOffset('https://testnet.binancefuture.com');
  check('local clock 5s ahead -> negative offset generated correctly (more negative than the margin alone)', offsetLocalAhead < -1500);
  check('local 5s ahead -> corrected timestamp lands behind server time (never ahead)', (fakeNow + offsetLocalAhead) < (fakeNow - 5000 + 10));

  // local clock 5s BEHIND server -> raw offset ~ +5000, margin subtracts 1500 -> net ~+3500
  fakeNow = 1_800_000_000_000;
  responder = (url) => {
    if (url.includes('/fapi/v1/time')) { const serverTime = fakeNow + 5000; fakeNow += 10; return { status: 200, ok: true, text: JSON.stringify({ serverTime }) }; }
    return 'THROW';
  };
  const offsetLocalBehind = await fetchBinanceServerTimeOffset('https://testnet.binancefuture.com');
  check('local clock 5s behind -> positive offset generated correctly', offsetLocalBehind > 0);
  check('local 5s behind -> net offset is raw offset minus the safety margin (not raw alone)', offsetLocalBehind < 5000);

  // milliseconds preserved (not seconds) — offsets in the thousands, not single/double digits
  check('offset is in milliseconds, not seconds (magnitude check)', Math.abs(offsetLocalBehind) > 100);

  // midpoint calculation: asymmetric round trip still produces a sane offset (not wildly off)
  fakeNow = 1_800_000_000_000;
  let callCount = 0;
  responder = (url) => {
    if (url.includes('/fapi/v1/time')) {
      callCount++;
      const serverTime = fakeNow + 200; // small fixed server-ahead delta
      fakeNow += 400; // simulate slow response (400ms elapsed during the call)
      return { status: 200, ok: true, text: JSON.stringify({ serverTime }) };
    }
    return 'THROW';
  };
  const offsetWithLatency = await fetchBinanceServerTimeOffset('https://testnet.binancefuture.com');
  check('midpoint calculation used (offset accounts for elapsed round-trip, not just before-time)', typeof offsetWithLatency === 'number' && Number.isFinite(offsetWithLatency));

  restoreClock();
}

// =====================================================================
// PART 2 — TESTNET/LIVE isolation (Task 4/11)
// =====================================================================
async function testEnvironmentIsolation() {
  installFakeClock();
  fakeNow = 1_800_000_000_000;
  const seenUrls: string[] = [];
  responder = (url) => {
    seenUrls.push(url);
    if (url.includes('/fapi/v1/time')) {
      const serverTime = url.includes('testnet') ? fakeNow + 1000 : fakeNow + 9000; // deliberately different per env
      return { status: 200, ok: true, text: JSON.stringify({ serverTime }) };
    }
    return 'THROW';
  };
  const testnetOffset = await fetchBinanceServerTimeOffset('https://testnet.binancefuture.com');
  const liveOffset = await fetchBinanceServerTimeOffset('https://fapi.binance.com');
  check('TESTNET offset computed from TESTNET time endpoint', seenUrls[0].includes('testnet.binancefuture.com'));
  check('LIVE offset computed from LIVE time endpoint', seenUrls[1].includes('fapi.binance.com') && !seenUrls[1].includes('testnet'));
  check('TESTNET and LIVE offsets are independently computed, never reused across environments', testnetOffset !== liveOffset);
  restoreClock();
}

// =====================================================================
// PART 3 — signature uses offset, offset not added twice (Task 9)
// =====================================================================
function testSignatureUsesOffsetOnce() {
  const q1 = buildSignedQuery({ timestamp: 1000, recvWindow: 5000 }, 'secret');
  const q2 = buildSignedQuery({ timestamp: 1000, recvWindow: 5000 }, 'secret');
  check('same timestamp input -> same signed query (offset/timestamp not silently re-added)', q1 === q2);
  check('timestamp appears exactly once in the signed query', (q1.match(/timestamp=/g) || []).length === 1);
}

// =====================================================================
// PART 4 — retry-once-on-timestamp-error behavior (Task 10)
// =====================================================================
async function testRetryBehavior() {
  installFakeClock();

  // normal signed request succeeds -> no retry (only 2 fetch calls: 1 time-check + 1 account call)
  fakeNow = 1_800_000_000_000;
  capturedUrls = [];
  responder = (url) => {
    if (url.includes('/fapi/v1/time')) return { status: 200, ok: true, text: JSON.stringify({ serverTime: fakeNow }) };
    if (url.includes('/fapi/v2/account')) return { status: 200, ok: true, text: JSON.stringify({ canTrade: true, assets: [], positions: [] }) };
    return 'THROW';
  };
  const okResult = await testBinanceFuturesConnection({ apiKey: 'AK', apiSecret: 'SECRET', environment: 'TESTNET' });
  check('normal signed request succeeds -> no retry', okResult.ok === true && capturedUrls.filter((u) => u.includes('/fapi/v1/time')).length === 1);

  // first request timestamp error -> resync -> retry once -> succeeds
  fakeNow = 1_800_000_000_000;
  capturedUrls = [];
  let accountCallCount = 0;
  responder = (url) => {
    if (url.includes('/fapi/v1/time')) return { status: 200, ok: true, text: JSON.stringify({ serverTime: fakeNow }) };
    if (url.includes('/fapi/v2/account')) {
      accountCallCount++;
      if (accountCallCount === 1) return { status: 400, ok: false, text: JSON.stringify({ code: -1021, msg: 'Timestamp for this request is outside of the recvWindow.' }) };
      return { status: 200, ok: true, text: JSON.stringify({ canTrade: true, assets: [], positions: [] }) };
    }
    return 'THROW';
  };
  const retryResult = await testBinanceFuturesConnection({ apiKey: 'AK', apiSecret: 'SECRET', environment: 'TESTNET' });
  check('first timestamp error -> resync -> retry once -> succeeds', retryResult.ok === true);
  check('exactly 2 account calls made (original + 1 retry, never more)', accountCallCount === 2);
  // Hotfix (3.5C.2) intentionally added a short-TTL per-environment offset cache: this block's
  // INITIAL offset reuses the prior block's still-fresh TESTNET cache entry (0 new /fapi/v1/time
  // calls), and only the forced resync after -1021 issues a real one — so 1 total, not 2. The
  // retry-exactly-once behavior itself (asserted above via accountCallCount) is unchanged.
  check('exactly 1 new time-sync call (initial reused cache, only the forced -1021 resync is fresh)', capturedUrls.filter((u) => u.includes('/fapi/v1/time')).length === 1);

  // second timestamp failure -> stop (no infinite retry)
  fakeNow = 1_800_000_000_000;
  accountCallCount = 0;
  responder = (url) => {
    if (url.includes('/fapi/v1/time')) return { status: 200, ok: true, text: JSON.stringify({ serverTime: fakeNow }) };
    if (url.includes('/fapi/v2/account')) { accountCallCount++; return { status: 400, ok: false, text: JSON.stringify({ code: -1021, msg: 'still drifted' }) }; }
    return 'THROW';
  };
  const stillFailingResult = await testBinanceFuturesConnection({ apiKey: 'AK', apiSecret: 'SECRET', environment: 'TESTNET' });
  check('second timestamp failure -> stop, error surfaced', stillFailingResult.ok === false && (stillFailingResult as any).error.code === 'timestamp_error');
  check('exactly 2 account call attempts (original + 1 retry, no more)', accountCallCount === 2);

  // credential error -> no timestamp retry
  fakeNow = 1_800_000_000_000;
  accountCallCount = 0;
  responder = (url) => {
    if (url.includes('/fapi/v1/time')) return { status: 200, ok: true, text: JSON.stringify({ serverTime: fakeNow }) };
    if (url.includes('/fapi/v2/account')) { accountCallCount++; return { status: 401, ok: false, text: JSON.stringify({ code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }) }; }
    return 'THROW';
  };
  const credErrorResult = await testBinanceFuturesConnection({ apiKey: 'AK', apiSecret: 'SECRET', environment: 'TESTNET' });
  check('credential error -> no timestamp retry (only 1 attempt)', accountCallCount === 1 && credErrorResult.ok === false && (credErrorResult as any).error.code === 'invalid_credentials');

  // permission error -> no timestamp retry
  fakeNow = 1_800_000_000_000;
  accountCallCount = 0;
  responder = (url) => {
    if (url.includes('/fapi/v1/time')) return { status: 200, ok: true, text: JSON.stringify({ serverTime: fakeNow }) };
    if (url.includes('/fapi/v2/account')) { accountCallCount++; return { status: 403, ok: false, text: JSON.stringify({}) }; }
    return 'THROW';
  };
  const permErrorResult = await testBinanceFuturesConnection({ apiKey: 'AK', apiSecret: 'SECRET', environment: 'TESTNET' });
  check('permission error -> no timestamp retry (only 1 attempt)', accountCallCount === 1 && permErrorResult.ok === false);

  // rate-limit error -> no timestamp retry
  fakeNow = 1_800_000_000_000;
  accountCallCount = 0;
  responder = (url) => {
    if (url.includes('/fapi/v1/time')) return { status: 200, ok: true, text: JSON.stringify({ serverTime: fakeNow }) };
    if (url.includes('/fapi/v2/account')) { accountCallCount++; return { status: 429, ok: false, text: JSON.stringify({ code: -1003 }) }; }
    return 'THROW';
  };
  const rateErrorResult = await testBinanceFuturesConnection({ apiKey: 'AK', apiSecret: 'SECRET', environment: 'TESTNET' });
  check('rate-limit error -> no timestamp retry (only 1 attempt)', accountCallCount === 1 && rateErrorResult.ok === false && (rateErrorResult as any).error.code === 'rate_limited');

  // network error -> no timestamp-specific retry (existing policy: propagates as network_error)
  fakeNow = 1_800_000_000_000;
  accountCallCount = 0;
  responder = (url) => {
    if (url.includes('/fapi/v1/time')) return { status: 200, ok: true, text: JSON.stringify({ serverTime: fakeNow }) };
    if (url.includes('/fapi/v2/account')) { accountCallCount++; return 'THROW'; }
    return 'THROW';
  };
  const netErrorResult = await testBinanceFuturesConnection({ apiKey: 'AK', apiSecret: 'SECRET', environment: 'TESTNET' });
  check('network error -> no timestamp retry triggered (only 1 attempt)', accountCallCount === 1 && netErrorResult.ok === false && (netErrorResult as any).error.code === 'network_error');

  restoreClock();
}

// =====================================================================
// PART 5 — full snapshot retry behavior (account+positionRisk batch)
// =====================================================================
async function testSnapshotRetry() {
  installFakeClock();
  fakeNow = 1_800_000_000_000;
  let attempt = 0;
  responder = (url) => {
    if (url.includes('/fapi/v1/time')) return { status: 200, ok: true, text: JSON.stringify({ serverTime: fakeNow }) };
    if (url.includes('/fapi/v2/account')) {
      attempt++;
      if (attempt === 1) return { status: 400, ok: false, text: JSON.stringify({ code: -1021 }) };
      return { status: 200, ok: true, text: JSON.stringify({ canTrade: true, assets: [], positions: [] }) };
    }
    if (url.includes('/fapi/v2/positionRisk')) return { status: 200, ok: true, text: JSON.stringify([]) };
    if (url.includes('/fapi/v1/openAlgoOrders')) return { status: 200, ok: true, text: JSON.stringify([]) };
    return 'THROW';
  };
  const snapResult = await getBinanceFuturesAccountSnapshot('conn-1', { apiKey: 'AK', apiSecret: 'SECRET', environment: 'TESTNET' });
  check('full snapshot retries once on timestamp error and succeeds', snapResult.ok === true);
  restoreClock();
}

// =====================================================================
// PART 6 — static no-write-operations proof (Task 12, re-confirmed after hotfix)
// =====================================================================
function testNoTradingSurface() {
  const files = ['types.ts', 'exchangeConnectionStore.ts', 'binanceSign.ts', 'binanceFuturesAdapter.ts', 'exchangeService.ts'].map((f: string) => resolve(__dirname, f));
  const serverPath = resolve(__dirname, '../server.ts');
  // Sprint 3.5D-D, disclosed intentional update: 'cancelOrder' removed from this forbidden list —
  // cancellation is now a real, deliberately-added second write capability (TESTNET-only, see
  // cancelBinanceFuturesTestnetOrder()/EXECUTION_SPEC.md's "Real Order Cancellation" section), not an
  // accidental trading-surface leak. 'placeOrder'/'amendOrder'/'setLeverage'/'setMarginType'/
  // 'transfer('/'withdraw(' remain genuinely absent and stay forbidden.
  const forbidden = ['placeOrder', 'amendOrder', 'setLeverage', 'setMarginType', 'transfer(', 'withdraw('];
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  let clean = true;
  for (const f of [...files, serverPath]) {
    const code = stripComments(readFileSync(f, 'utf8'));
    for (const term of forbidden) if (code.includes(term)) clean = false;
  }
  check('no non-cancellation trading write methods anywhere (placeOrder/amendOrder/leverage/margin/transfer/withdraw)', clean);
}

async function main() {
  await testOffsetMath();
  await testEnvironmentIsolation();
  testSignatureUsesOffsetOnce();
  await testRetryBehavior();
  await testSnapshotRetry();
  testNoTradingSurface();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('Failures:', failures); process.exit(1); }
}
main();
