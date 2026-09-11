// Sprint 3.5D-B.1 UI tests — Strategy numeric display, Execution readiness guard, TESTNET
// eligibility readiness gate, historical CONDITIONAL blocking. Same vm-slicing technique as prior
// sprints. global.fetch mocked — no real network calls anywhere in this file.
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('c:/Users/surface/Documents/Obsidian Vault/量化/prototype/index.html', 'utf8');
const scriptStart = html.indexOf('<script>') + '<script>'.length;
const marker = '/* ---------- Interactions ---------- */';
const markerIdx = html.indexOf(marker, scriptStart);
let slice = html.slice(scriptStart, markerIdx);

const EXPORT_NAMES = [
  'renderScenarioPlanCard', 'renderExecutionReal', 'resolveExecutionView', 'createOrReuseExecutionDraft',
  'evaluateScenarioExecutionReadiness', 'checkOrderSubmissionEligibility',
  'getRealOrderById', 'saveRealOrder', 'getRealTradeById', 'saveRealTrade', 'getRealTradeByExecutionId',
  'loadRealOrders', 'confirmExecutionDraft', 'getExecutionDraft', 'saveExecutionDraft',
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
let connectionsFixture = [{ id: 'conn1', enabled: true, environment: 'TESTNET', name: 'test' }];
let accountSnapshotFixture = {
  connectionId: 'conn1', exchange: 'binance-futures', environment: 'TESTNET', fetchedAt: new Date().toISOString(),
  account: { canTrade: true },
  accountRisk: { totalWalletBalance: 100000, totalUnrealizedPnl: 0, totalMarginBalance: 100000, totalInitialMargin: 0, totalMaintMargin: 0, availableBalance: 100000 },
  balances: [], positions: [], protectiveOrders: [], protectionReadStatus: 'OK',
};
let priceFixture = [{ symbol: 'BTC/USDT', price: 65000, changePct: 1 }];
async function fetch(url) {
  fetchCallLog.push(String(url));
  const u = String(url);
  if (u.includes('/api/prices')) return { ok: true, json: async () => priceFixture };
  if (u.endsWith('/api/exchange/connections')) return { ok: true, json: async () => ({ ok: true, connections: connectionsFixture }) };
  const acctMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/account$/);
  if (acctMatch) return { ok: true, json: async () => ({ ok: true, snapshot: accountSnapshotFixture }) };
  throw new Error('UNEXPECTED FETCH in 3.5D-B.1 UI test: ' + u);
}

const sandbox = {
  localStorage, document, location, window, fetch, requestAnimationFrame, wireInteractions,
  console, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
  setTimeout, clearTimeout, setInterval, clearInterval, confirm: () => true,
};
const vmCtx = vm.createContext(sandbox);
vm.runInContext(slice, vmCtx, { filename: 'index-slice.js' });
const M = sandbox.__exports;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond) { if (cond) pass++; else { fail++; failures.push(name); console.log('FAIL:', name); } }
function resetAll() {
  store = {}; fetchCallLog = [];
  connectionsFixture = [{ id: 'conn1', enabled: true, environment: 'TESTNET', name: 'test' }];
}

let seq = 0;
function makePlan(overrides) {
  seq++;
  const base = {
    id: 'plan' + seq, priority: 'PRIMARY', direction: 'LONG', action: 'ENTER',
    title: 'Numeric WAIT plan', trigger: '4H 收盘 >= 65,200', holdingPeriod: '1-3 天',
    reviewHorizon: { description: '未来 3 根 4H K线内有效', expiresAt: '2030-08-10T17:00:00+08:00' },
    triggerStructured: { description: '4H 收盘 >= 65200', logic: 'ALL', conditions: [{ metric: 'candle_close', operator: 'GTE', value: 65200, timeframe: '4H' }] },
    entry: { type: 'ZONE', from: 65200, to: 65400 },
    stopLoss: { value: 63900 },
    // Sprint 3.5D-E, disclosed intentional update: portions added, summing to 100 — the full-trade-plan
    // eligibility gate now additionally requires valid take-profit portions.
    takeProfit: [{ value: 67000, portion: 50 }, { value: 68500, portion: 50 }],
    rationale: 'synthetic rationale text unique-marker-XYZ',
    evidenceReferences: ['sourceSnapshots:technical'],
  };
  if (typeof overrides === 'function') return { ...base, ...overrides(base) };
  return overrides ? { ...base, ...overrides } : base;
}
function makeFixtureRecord(planOverrides, decisionOverrides) {
  seq++;
  const analysisId = 'A' + seq;
  const plan = makePlan(planOverrides);
  const payload = { analysisId, symbol: 'BTC/USDT', collectedAt: new Date().toISOString() };
  const decision = Object.assign({ direction: 'LONG', action: 'WAIT', confidence: 60 }, decisionOverrides);
  const record = {
    analysisId, responseVersion: '2.2.0', promptVersion: '2.2.0', payloadVersion: '1.1.0',
    provider: 'test', model: 'test-model', generatedAt: new Date().toISOString(),
    response: { responseVersion: '2.2.0', decision, scenarioPlans: [plan], sourceAssessments: [], reasoning: [], risks: [], evidence: [] },
  };
  const payloads = JSON.parse(localStorage.getItem('qa_analysis_payloads') || '{}');
  payloads[analysisId] = payload; localStorage.setItem('qa_analysis_payloads', JSON.stringify(payloads));
  const records = JSON.parse(localStorage.getItem('qa_ai_response_records') || '{}');
  records[analysisId] = record; localStorage.setItem('qa_ai_response_records', JSON.stringify(records));
  return { analysisId, plan, payload, decision, record };
}

// =====================================================================
// PART A — Strategy scenario card numeric display (Task 33)
// =====================================================================
resetAll();
(function testStrategyCardNumericDisplay() {
  const f = makeFixtureRecord();
  const html2 = M.renderScenarioPlanCard(f.plan, f.decision, 2, f.analysisId);
  check('Strategy card shows numeric entry (ZONE range)', /65,200.*68,500|65,200/.test(html2) && html2.includes('65,200'));
  check('Strategy card shows numeric stop', html2.includes('63,900'));
  check('Strategy card shows multiple numeric TP targets', html2.includes('67,000') && html2.includes('68,500'));
  check('Strategy card shows explicit expiry timestamp (有效至)', /有效至/.test(html2) && /2030/.test(html2));
  check('Strategy card shows WAIT numeric trigger text', html2.includes('4H 收盘'));
  check('Strategy card: ready plan shows enabled 手动执行 (data-action present)', /data-action="manual-execute-scenario"/.test(html2));
  check('Strategy card: ready plan shows 触发时提醒 (machine-evaluable trigger)', /data-action="notify-execute-scenario"/.test(html2));
  check('Strategy card: rationale (explanation) still present in card, separate from numeric plan-grid', html2.includes('unique-marker-XYZ'));
})();

(function testStrategyCardNotReady() {
  const f = makeFixtureRecord(p => ({ triggerStructured: null })); // WAIT PRIMARY missing required numeric trigger
  const html2 = M.renderScenarioPlanCard(f.plan, f.decision, 2, f.analysisId);
  check('not-ready plan: shows 缺少可执行数值参数 indicator', /缺少可执行数值参数/.test(html2));
  check('not-ready plan: 手动执行 button disabled, no data-action', !/data-action="manual-execute-scenario"/.test(html2) && /disabled/.test(html2));
  check('not-ready plan: no 触发时提醒 action offered', !/data-action="notify-execute-scenario"/.test(html2));
})();

// =====================================================================
// PART B — Execution readiness guard / no prose fallback (Task 18/19/22/24)
// =====================================================================
(function testExecutionReadyRenders() {
  resetAll();
  const f = makeFixtureRecord();
  const draft = M.createOrReuseExecutionDraft(f.analysisId, f.plan.id, 'MANUAL');
  const html2 = M.renderExecutionReal(draft.executionId);
  check('ready scenario: Execution page renders normal editable form (confirm button present)', /data-action="confirm-execution-draft"/.test(html2));
  check('ready scenario: does NOT show the not-ready block message', !/该方案不满足执行就绪要求/.test(html2));
})();

(function testExecutionBlockedForNotReady() {
  resetAll();
  // Historical-style CONDITIONAL PRIMARY (Task 24) — legal shape-wise under an older record, but must
  // never be treated as execution-ready by the CURRENT gate.
  const f = makeFixtureRecord(p => ({ entry: { type: 'CONDITIONAL', description: 'wait for structure confirmation' } }), { action: 'WAIT' });
  const draft = M.createOrReuseExecutionDraft(f.analysisId, f.plan.id, 'MANUAL');
  const html2 = M.renderExecutionReal(draft.executionId);
  check('historical CONDITIONAL: Execution shows not-ready block message', /该方案不满足执行就绪要求/.test(html2));
  check('historical CONDITIONAL: no confirm-execution-draft action offered', !/data-action="confirm-execution-draft"/.test(html2));
  check('historical CONDITIONAL: no editable numeric input rendered as if it were an order parameter', !/data-action="exec2-entry-value"/.test(html2) && !/data-action="exec2-entry-from"/.test(html2));
  check('historical CONDITIONAL: specific reason listed', /CONDITIONAL/.test(html2) || /入场类型/.test(html2));
})();

// =====================================================================
// PART C — TESTNET eligibility checks readiness (Task 27)
// =====================================================================
async function testTestnetEligibilityReadiness() {
  resetAll();
  // eligible: fully numeric plan, confirmed draft with real Order/Trade created via the real confirm flow
  {
    const f = makeFixtureRecord(p => ({}), { action: 'ENTER' }); // ENTER-ready plan (ZONE numeric still requires user order resolution downstream, so use LIMIT for a clean ENTER path)
    const planLimit = M.getExecutionDraft; // no-op reference just to keep linter-style usage minimal
    const draft = M.createOrReuseExecutionDraft(f.analysisId, f.plan.id, 'MANUAL');
    // resolve ZONE order price so confirmExecutionDraft can create a real Order
    const view = M.resolveExecutionView(draft.executionId);
    view.draft.userOverrides.orderResolution = { type: null, price: 65300 };
    view.draft.userOverrides.positionSize = 1000;
    view.draft.userOverrides.leverage = 10;
    M.saveExecutionDraft(view.draft);
    await M.confirmExecutionDraft(draft.executionId);
    const trade = M.getRealTradeByExecutionId(draft.executionId);
    const order = trade ? Object.values(M.loadRealOrders()).find(o => o.tradeId === trade.tradeId && o.role === 'ENTRY') : null;
    check('eligible fixture: real Trade/Order created', !!trade && !!order);
    if (order) {
      const eligibility = M.checkOrderSubmissionEligibility(order, trade, M.getExecutionDraft(draft.executionId));
      check('TESTNET eligibility: ready scenario -> ok', eligibility.ok === true);
    }
  }

  // not eligible: not-ready plan (missing triggerStructured under WAIT) even if somehow an Order got created
  {
    const f = makeFixtureRecord(p => ({ triggerStructured: null }), { action: 'WAIT' });
    const draft = M.createOrReuseExecutionDraft(f.analysisId, f.plan.id, 'MANUAL');
    const view = M.resolveExecutionView(draft.executionId);
    view.draft.userOverrides.orderResolution = { type: null, price: 65300 };
    view.draft.userOverrides.positionSize = 1000;
    view.draft.userOverrides.leverage = 10;
    // force status CONFIRMED directly (bypassing the now-blocking Execution UI) to prove the
    // TESTNET-eligibility layer catches it independently even if an earlier layer were somehow skipped
    view.draft.status = 'CONFIRMED';
    M.saveExecutionDraft(view.draft);
    const now = new Date().toISOString();
    const trade = { schemaVersion: 'real-v1', tradeId: 'TRX1', analysisId: f.analysisId, executionIds: [draft.executionId], scenarioPlanId: f.plan.id, symbol: 'BTC/USDT', thesisDirection: 'LONG', status: 'PLANNED', openedAt: null, closedAt: null, orderIds: ['ORX1'], positionId: null, createdAt: now, updatedAt: now };
    const order = { schemaVersion: 'real-v1', orderId: 'ORX1', tradeId: 'TRX1', executionId: draft.executionId, analysisId: f.analysisId, scenarioPlanId: f.plan.id, symbol: 'BTC/USDT', side: 'BUY', intent: 'OPEN', role: 'ENTRY', orderType: 'LIMIT', quantity: null, limitPrice: 65300, stopPrice: null, status: 'DRAFT', filled: { quantity: 0, averagePrice: null }, createdAt: now, submittedAt: null, updatedAt: now, exchangeOrderId: null, sync: { lastSyncedAt: null, lastSyncStatus: null, lastSyncError: null }, exchangeSnapshot: null, clientOrderId: null, pendingClientOrderId: null };
    M.saveRealTrade(trade); M.saveRealOrder(order);
    const eligibility = M.checkOrderSubmissionEligibility(order, trade, M.getExecutionDraft(draft.executionId));
    check('TESTNET eligibility: not-ready scenario -> ok=false with readiness reason', eligibility.ok === false && /执行就绪要求/.test(eligibility.reason));
  }

  console.log('testnet eligibility readiness tests done');
}

(async function main() {
  await testTestnetEligibilityReadiness();
  console.log(`\n3.5D-B.1 UI tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
})();
