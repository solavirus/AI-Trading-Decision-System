// Hotfix — Exchange Connection selection safety regression (Task 9, Cases D/E/F).
// Same vm-slicing technique as prior sprints. No real network calls (this file never mocks fetch to
// return anything beyond what's needed to prove the SELECTION logic never silently falls back).
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('c:/Users/surface/Documents/Obsidian Vault/量化/prototype/index.html', 'utf8');
const scriptStart = html.indexOf('<script>') + '<script>'.length;
const marker = '/* ---------- Interactions ---------- */';
const markerIdx = html.indexOf(marker, scriptStart);
let slice = html.slice(scriptStart, markerIdx);

const EXPORT_NAMES = [
  'resolveRiskExchangeConnectionId', 'loadRiskSettings', 'saveRiskSettings',
  'checkOrderSubmissionEligibility', 'submitRealOrderToTestnet',
  'createOrReuseExecutionDraft', 'confirmExecutionDraft', 'resolveExecutionView', 'getRealTradeByExecutionId',
  'loadRealOrders', 'getRealOrderById', 'saveRealOrder', 'loadRealTrades', 'getRealTradeById', 'saveRealTrade',
  'Store',
];
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

let fetchCallLog = [];
let connectionsFixture = [];
async function fetch(url, opts) {
  const method = (opts && opts.method) || 'GET';
  fetchCallLog.push({ url: String(url), method });
  const u = String(url);
  if (u.includes('/api/prices')) return { ok: true, json: async () => [] };
  if (u.endsWith('/api/exchange/connections')) return { ok: true, json: async () => ({ ok: true, connections: connectionsFixture }) };
  throw new Error('UNEXPECTED FETCH in connection-selection test: ' + method + ' ' + u);
}

const sandbox = {
  localStorage, document, location, window, fetch, requestAnimationFrame, wireInteractions,
  console, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
  setTimeout, clearTimeout, setInterval, clearInterval, confirm: () => true, encodeURIComponent,
  AbortSignal, AbortController,
};
const vmCtx = vm.createContext(sandbox);
vm.runInContext(slice, vmCtx, { filename: 'index-slice.js' });
const M = sandbox.__exports;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond) { if (cond) pass++; else { fail++; failures.push(name); console.log('FAIL:', name); } }
function resetAll() { store = {}; fetchCallLog = []; connectionsFixture = []; }

const CONN_REAL = { id: 'real-conn-id', enabled: true, environment: 'TESTNET', name: '币安' };
const CONN_VALIDCONN = { id: 'validconn-id', enabled: true, environment: 'LIVE', name: 'ValidConn' };

// =====================================================================
// PART D — two enabled connections: Risk Guard must NOT implicitly pick the first one
// =====================================================================
(function testCaseD() {
  resetAll();
  const riskSettings = { exchangeConnectionId: null };
  const r1 = M.resolveRiskExchangeConnectionId(riskSettings, [CONN_REAL, CONN_VALIDCONN]);
  check('Case D: two enabled, no explicit selection -> BLOCK (not implicit first-pick)', r1.ok === false);
  check('Case D: reason mentions multiple enabled connections', r1.ok === false && /多个已启用/.test(r1.reason));

  // order reversed -> still blocks, never silently resolves to whichever is now first
  const r2 = M.resolveRiskExchangeConnectionId(riskSettings, [CONN_VALIDCONN, CONN_REAL]);
  check('Case D: reversed array order -> still BLOCK, not silently resolved', r2.ok === false);
})();

// =====================================================================
// PART E — RiskSettings points to a connectionId that no longer exists (e.g. after ValidConn deleted)
// =====================================================================
(function testCaseE() {
  resetAll();
  const staleRiskSettings = { exchangeConnectionId: 'validconn-id' }; // ValidConn already deleted from connections list
  const r = M.resolveRiskExchangeConnectionId(staleRiskSettings, [CONN_REAL]); // only the real connection remains
  check('Case E: stale connectionId (deleted) -> BLOCK, never silently switches to another real account', r.ok === false);
  check('Case E: does NOT silently resolve to the remaining real connection', !(r.ok === true && r.connectionId === CONN_REAL.id));
  check('Case E: reason indicates the selected connection no longer exists', r.ok === false && /不存在/.test(r.reason));
})();

// =====================================================================
// PART F — Order Submission: explicit connectionId, array order must not change the outcome
// =====================================================================
async function testCaseF() {
  resetAll();
  const explicitRiskSettings = { exchangeConnectionId: CONN_REAL.id };
  const rA = M.resolveRiskExchangeConnectionId(explicitRiskSettings, [CONN_REAL, CONN_VALIDCONN]);
  const rB = M.resolveRiskExchangeConnectionId(explicitRiskSettings, [CONN_VALIDCONN, CONN_REAL]);
  check('Case F: explicit connectionId resolves the same regardless of array order (A)', rA.ok === true && rA.connectionId === CONN_REAL.id);
  check('Case F: explicit connectionId resolves the same regardless of array order (B)', rB.ok === true && rB.connectionId === CONN_REAL.id);
  check('Case F: never resolves to connections[0] blindly', !(rB.ok === true && rB.connectionId === CONN_VALIDCONN.id));

  // End-to-end: submitRealOrderToTestnet must reach the SAME resolved connectionId check before ever
  // reaching a network call — verified by forcing an eligibility failure and confirming it never
  // reaches out to a fetch call with the wrong connection.
  connectionsFixture = [CONN_VALIDCONN, CONN_REAL]; // ValidConn listed FIRST
  const riskSettings = { exchangeConnectionId: CONN_REAL.id };
  M.saveRiskSettings(riskSettings);
  const fakeOrder = { orderId: 'OR1', tradeId: 'T1', executionId: 'E1', role: 'ENTRY', intent: 'OPEN', orderType: 'MARKET', status: 'DRAFT', exchangeOrderId: null, pendingClientOrderId: null, symbol: 'BTC/USDT', side: 'BUY' };
  M.saveRealOrder(fakeOrder);
  // No matching Trade/Draft exists, so this will fail at an earlier eligibility check — but the point
  // is to confirm no fetch ever reaches '/orders' (a POST) using the wrong connectionId, i.e. this
  // never even gets far enough to submit against the wrong (or right) connection without full setup.
  const result = await M.submitRealOrderToTestnet('OR1');
  check('Case F: incomplete fixture correctly rejected before any submission network call', result.ok === false);
  check('Case F: no POST /orders call ever made with incomplete fixture', !fetchCallLog.some((c) => c.method === 'POST' && c.url.includes('/orders')));
}
testCaseF().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
});
