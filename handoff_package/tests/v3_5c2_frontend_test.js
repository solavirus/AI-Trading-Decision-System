// Sprint 3.5C.2 hotfix frontend tests — loadExchangeAccountSnapshot loading-state finalization +
// renderPositionCard protection-status wording. Same vm-slicing technique as prior sprints.
// global.fetch mocked (backend endpoints only — no real network calls anywhere in this file).
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('c:/Users/surface/Documents/Obsidian Vault/量化/prototype/index.html', 'utf8');
const scriptStart = html.indexOf('<script>') + '<script>'.length;
const marker = '/* ---------- Interactions ---------- */';
const markerIdx = html.indexOf(marker, scriptStart);
let slice = html.slice(scriptStart, markerIdx);

const EXPORT_NAMES = ['Store', 'loadExchangeAccountSnapshot', 'renderPositionCard', 'renderExchangeAccountSnapshotBlock'];
slice += `\nObject.assign((globalThis.__exports = globalThis.__exports || {}), {${EXPORT_NAMES.join(',')}});\n`;

let store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
function fakeEl() {
  return {
    _innerHTML: '', get innerHTML() { return this._innerHTML; }, set innerHTML(v) { this._innerHTML = v; },
    classList: { add() {}, remove() {} }, appendChild() {}, remove() {}, addEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, dataset: {},
  };
}
const document = {
  getElementById() { return fakeEl(); },
  createElement() { return { innerHTML: '', content: { firstElementChild: fakeEl() } }; },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
};
const location = { hash: '#/dashboard' };
const window = { addEventListener() {}, scrollTo() {} };
function requestAnimationFrame(cb) {}
function wireInteractions() {}

// ---- mock fetch: /api/exchange/connections/:id/account only (this suite's scope) ----
let fetchCallLog = [];
let accountBehavior = 'ok'; // 'ok' | 'error' | 'abort'
let accountSnapshotFixture = null;
async function fetch(url, opts) {
  fetchCallLog.push(String(url));
  const acctMatch = String(url).match(/\/api\/exchange\/connections\/([^/]+)\/account$/);
  if (acctMatch) {
    if (accountBehavior === 'abort') {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    }
    if (accountBehavior === 'error') return { ok: true, json: async () => ({ ok: false, error: { code: 'network_error', message: '无法读取真实账户状态' } }) };
    return { ok: true, json: async () => ({ ok: true, snapshot: accountSnapshotFixture }) };
  }
  throw new Error('UNEXPECTED FETCH in 3.5C.2 frontend test: ' + url);
}

const sandbox = {
  localStorage, document, location, window, fetch, requestAnimationFrame, wireInteractions,
  console, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
  setTimeout, clearTimeout, setInterval, clearInterval, confirm: () => true,
  AbortSignal, AbortController,
};
const vmCtx = vm.createContext(sandbox);
vm.runInContext(slice, vmCtx, { filename: 'index-slice.js' });
const M = sandbox.__exports;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond) { if (cond) pass++; else { fail++; failures.push(name); console.log('FAIL:', name); } }

function baseSnapshot(overrides) {
  return Object.assign({
    connectionId: 'conn-1', exchange: 'binance-futures', environment: 'TESTNET', fetchedAt: new Date().toISOString(),
    account: { canTrade: true },
    accountRisk: { totalWalletBalance: 10000, totalUnrealizedPnl: 0, totalMarginBalance: 10000, totalInitialMargin: 0, totalMaintMargin: 0, availableBalance: 10000 },
    balances: [], positions: [], protectiveOrders: [], protectionReadStatus: 'OK',
  }, overrides);
}
function makePosition(overrides) {
  return Object.assign({
    symbol: 'BTCUSDT', side: 'LONG', quantity: 0.5, entryPrice: 65000, markPrice: 65200, notional: 32600,
    unrealizedPnl: 100, leverage: 10, marginType: 'ISOLATED', isolatedMargin: 3250, positionInitialMargin: 3260,
    maintenanceMargin: 163, liquidationPrice: 58000, breakEvenPrice: 65010, positionSide: 'BOTH',
    distanceToLiquidationPct: 11.04,
    protection: { stopLossOrders: [], takeProfitOrders: [], trailingStopOrders: [], otherOrders: [] },
  }, overrides);
}

async function testLoadingClearsOnSuccess() {
  store = {}; fetchCallLog = []; accountBehavior = 'ok'; accountSnapshotFixture = baseSnapshot();
  await M.loadExchangeAccountSnapshot('conn-1');
  const s = M.Store.exchangeAccountSnapshots['conn-1'];
  check('success: loading cleared', s.loading === false);
  check('success: snapshot stored, no error', !!s.snapshot && s.error === null);
}

async function testLoadingClearsOnBackendError() {
  store = {}; fetchCallLog = []; accountBehavior = 'error'; accountSnapshotFixture = null;
  await M.loadExchangeAccountSnapshot('conn-1');
  const s = M.Store.exchangeAccountSnapshots['conn-1'];
  check('backend error: loading cleared', s.loading === false);
  check('backend error: snapshot null, error set', s.snapshot === null && !!s.error);
}

async function testLoadingClearsOnFetchAbort() {
  store = {}; fetchCallLog = []; accountBehavior = 'abort'; accountSnapshotFixture = null;
  await M.loadExchangeAccountSnapshot('conn-1');
  const s = M.Store.exchangeAccountSnapshots['conn-1'];
  check('fetch abort: loading cleared (no permanent spinner)', s.loading === false);
  check('fetch abort: snapshot null', s.snapshot === null);
  check('fetch abort: friendly Chinese timeout message, not a raw AbortError', s.error === '读取账户超时，请稍后重试');
}

(function testProtectionWordingOK() {
  const pos = makePosition();
  const html2 = M.renderPositionCard(pos, 'OK');
  check('protection OK + no orders: shows "未检测到有效止损保护" (genuinely verified empty)', html2.includes('当前读取范围内未检测到有效止损保护'));
  check('protection OK: does NOT show the read-failed warning', !html2.includes('止盈止损订单暂时读取失败'));
})();

(function testProtectionWordingTimeout() {
  const pos = makePosition();
  const html2 = M.renderPositionCard(pos, 'TIMEOUT');
  check('protection TIMEOUT: shows read-failed warning, not "未检测到"', html2.includes('止盈止损订单暂时读取失败') && !html2.includes('当前读取范围内未检测到有效止损保护'));
})();

(function testProtectionWordingUnavailable() {
  const pos = makePosition();
  const html2 = M.renderPositionCard(pos, 'UNAVAILABLE');
  check('protection UNAVAILABLE: shows read-failed warning, not "未检测到"', html2.includes('止盈止损订单暂时读取失败') && !html2.includes('当前读取范围内未检测到有效止损保护'));
})();

(function testAccountBlockPassesRealStatusNotArrayIndex() {
  // Regression for the fixed .map(renderPositionCard) bug: the second positional arg must be the
  // real protectionReadStatus string, never the array index that `.map()` would otherwise pass.
  const snap = baseSnapshot({ positions: [makePosition({ symbol: 'BTCUSDT' }), makePosition({ symbol: 'ETHUSDT' })], protectionReadStatus: 'TIMEOUT' });
  M.Store.exchangeAccountSnapshots = { 'conn-1': { loading: false, snapshot: snap, error: null } };
  const block = M.renderExchangeAccountSnapshotBlock('conn-1');
  const warningCount = (block.match(/止盈止损订单暂时读取失败/g) || []).length;
  check('positions.map call site: both position cards receive the real TIMEOUT status (not index 0/1)', warningCount === 2);
})();

(async function runSequenced() {
  await testLoadingClearsOnSuccess();
  await testLoadingClearsOnBackendError();
  await testLoadingClearsOnFetchAbort();
  console.log(`\n3.5C.2 frontend tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
})();
