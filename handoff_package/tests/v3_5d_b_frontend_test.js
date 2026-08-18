// Sprint 3.5D-B frontend tests — Binance TESTNET Manual Order Submission.
// Same vm-slicing technique as prior sprints. global.fetch mocked (backend endpoints only) — NO real
// network calls, and every mocked "submission" response is synthetic; nothing here ever reaches Binance.
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('c:/Users/surface/Documents/Obsidian Vault/量化/prototype/index.html', 'utf8');
const scriptStart = html.indexOf('<script>') + '<script>'.length;
const marker = '/* ---------- Interactions ---------- */';
const markerIdx = html.indexOf(marker, scriptStart);
let slice = html.slice(scriptStart, markerIdx);

const EXPORT_NAMES = [
  'checkOrderSubmissionEligibility', 'submitRealOrderToTestnet', 'recoverAmbiguousSubmission', 'applyOrderSubmissionSuccess',
  'createOrReuseExecutionDraft', 'confirmExecutionDraft', 'resolveExecutionView', 'getRealTradeByExecutionId',
  'loadRealOrders', 'getRealOrderById', 'saveRealOrder', 'getRealTradeById', 'saveRealTrade', 'renderRealTradeDetail',
  'loadRiskSettings', 'saveRiskSettings', 'resolveRiskExchangeConnectionId', 'mapExchangeOrderStatusToLocalOrderStatus',
  'REAL_ORDER_STATUS_LABEL', 'Store',
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

// ---- mock fetch ----
let fetchCallLog = [];
let connectionsFixture = [{ id: 'conn1', enabled: true, environment: 'TESTNET', name: 'test' }];
let accountSnapshotFixture = null; // null = unresolvable account -> account-aware Risk Guard rules BLOCK
let priceFixture = [{ symbol: 'BTC/USDT', price: 65000, changePct: 1 }];
let submitBehavior = 'ok'; // 'ok' | 'error' | 'ambiguous'
let submitResponseFixture = null;
let submitErrorFixture = { code: 'invalid_quantity', message: '数量无效' };
let recoveryBehavior = 'ok'; // 'ok' | 'not-found' | 'error'
let recoveryResponseFixture = null;

async function fetch(url, opts) {
  const method = (opts && opts.method) || 'GET';
  fetchCallLog.push({ url: String(url), method });
  const u = String(url);
  if (u.includes('/api/prices')) return { ok: true, json: async () => priceFixture };
  if (u.endsWith('/api/exchange/connections')) return { ok: true, json: async () => ({ ok: true, connections: connectionsFixture }) };
  const acctMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/account$/);
  if (acctMatch) {
    if (!accountSnapshotFixture) return { ok: true, json: async () => ({ ok: false, error: { code: 'network_error', message: '无法读取真实账户状态' } }) };
    return { ok: true, json: async () => ({ ok: true, snapshot: accountSnapshotFixture }) };
  }
  const ordersMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/orders$/);
  if (ordersMatch && method === 'POST') {
    if (submitBehavior === 'ambiguous') return { ok: true, json: async () => ({ ok: false, error: { code: 'submission_status_unknown', message: '订单提交结果未知，请先同步/查询交易所订单，避免重复下单。' }, ambiguous: true }) };
    if (submitBehavior === 'error') return { ok: true, json: async () => ({ ok: false, error: submitErrorFixture }) };
    return { ok: true, json: async () => ({ ok: true, snapshot: submitResponseFixture }) };
  }
  const orderGetMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/order\?/);
  if (orderGetMatch) {
    if (recoveryBehavior === 'not-found') return { ok: true, json: async () => ({ ok: false, error: { code: 'order_not_found', message: '交易所未找到该订单' } }) };
    if (recoveryBehavior === 'error') return { ok: true, json: async () => ({ ok: false, error: { code: 'network_error', message: '网络错误' } }) };
    return { ok: true, json: async () => ({ ok: true, snapshot: recoveryResponseFixture }) };
  }
  throw new Error('UNEXPECTED FETCH in 3.5D-B test: ' + method + ' ' + u);
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
function resetAll() {
  store = {}; fetchCallLog = [];
  connectionsFixture = [{ id: 'conn1', enabled: true, environment: 'TESTNET', name: 'test' }];
  accountSnapshotFixture = healthyAccountSnapshot();
  priceFixture = [{ symbol: 'BTC/USDT', price: 65000, changePct: 1 }];
  submitBehavior = 'ok'; submitResponseFixture = orderSnap();
  recoveryBehavior = 'ok'; recoveryResponseFixture = orderSnap();
}

function healthyAccountSnapshot() {
  return {
    connectionId: 'conn1', exchange: 'binance-futures', environment: 'TESTNET', fetchedAt: new Date().toISOString(),
    account: { canTrade: true },
    accountRisk: { totalWalletBalance: 100000, totalUnrealizedPnl: 0, totalMarginBalance: 100000, totalInitialMargin: 0, totalMaintMargin: 0, availableBalance: 100000 },
    balances: [{ asset: 'USDT', free: 100000, locked: 0, total: 100000 }],
    positions: [], protectiveOrders: [], protectionReadStatus: 'OK',
  };
}
function orderSnap(overrides) {
  return Object.assign({
    exchangeOrderId: '9999', clientOrderId: null, symbol: 'BTC/USDT', side: 'BUY', orderType: 'MARKET', status: 'NEW',
    originalQuantity: 0.02, executedQuantity: 0, averagePrice: null, price: null, stopPrice: null,
    reduceOnly: false, closePosition: false, createdAt: '2026-08-09T10:00:00.000Z', updatedAt: '2026-08-09T10:00:00.000Z',
  }, overrides);
}

let seq = 0;
function makePlan(overrides) {
  seq++;
  return Object.assign({
    id: 'plan' + seq, priority: 'PRIMARY', direction: 'LONG', action: 'ENTER', title: 'Test Plan ' + seq,
    trigger: '突破 65000', triggerStructured: null, invalidation: null,
    reviewHorizon: { description: '有效期 3 天', expiresAt: '2030-08-10T17:00:00+08:00' }, holdingPeriod: '1-3 天', // Sprint 3.5D-B.1: now required for PRIMARY execution readiness
    entry: { type: 'MARKET', value: null, from: null, to: null, description: null },
    // Sprint 3.5D-E, disclosed intentional update: portion:100 added — checkOrderSubmissionEligibility()
    // now additionally requires valid take-profit portions (sum=100) for the full-trade-plan gate;
    // a single TP target's natural portion is 100%.
    stopLoss: { value: 63000, description: null }, takeProfit: [{ value: 68000, description: null, portion: 100 }],
    rationale: '测试理由', evidenceReferences: ['ref1'],
  }, overrides);
}
function makeFixture(planOverrides) {
  seq++;
  const analysisId = 'A' + seq;
  const plan = makePlan(planOverrides);
  const payload = { analysisId, symbol: 'BTC/USDT', collectedAt: new Date().toISOString() };
  const record = {
    analysisId, responseVersion: '2.1.0', promptVersion: '1.0.0', payloadVersion: '1.1.0',
    provider: 'test', model: 'test-model', generatedAt: new Date().toISOString(),
    response: {
      responseVersion: '2.1.0', decision: { direction: plan.direction, action: 'ENTER', confidence: 70 },
      scenarioPlans: [plan], sourceAssessments: [], reasoning: { main: [], support: [], against: [] }, risks: [], evidenceReferences: ['ref1'],
    },
  };
  const payloads = JSON.parse(localStorage.getItem('qa_analysis_payloads') || '{}');
  payloads[analysisId] = payload; localStorage.setItem('qa_analysis_payloads', JSON.stringify(payloads));
  const records = JSON.parse(localStorage.getItem('qa_ai_response_records') || '{}');
  records[analysisId] = record; localStorage.setItem('qa_ai_response_records', JSON.stringify(records));
  const draft = M.createOrReuseExecutionDraft(analysisId, plan.id, 'MANUAL');
  return { analysisId, plan, payload, record, draft };
}
/** Confirms a draft (creating a real DRAFT Order + PLANNED Trade via the actual confirm flow) with
 * positionSize/leverage pre-filled — required for submission eligibility (Task 9). */
async function makeConfirmedFixture(planOverrides) {
  const f = makeFixture(planOverrides);
  const view = M.resolveExecutionView(f.draft.executionId);
  view.draft.userOverrides.positionSize = 1000;
  view.draft.userOverrides.leverage = 10;
  const map = JSON.parse(localStorage.getItem('qa_execution_drafts'));
  map[f.draft.executionId] = view.draft;
  localStorage.setItem('qa_execution_drafts', JSON.stringify(map));
  await M.confirmExecutionDraft(f.draft.executionId);
  const trade = M.getRealTradeByExecutionId(f.draft.executionId);
  const order = Object.values(M.loadRealOrders()).find((o) => o.tradeId === trade.tradeId && o.role === 'ENTRY');
  return { ...f, trade, order };
}

// =====================================================================
// PART A — checkOrderSubmissionEligibility (pure-ish gate)
// =====================================================================
(function testEligibility() {
  // Sprint 3.5D-B.1, Task 27: checkOrderSubmissionEligibility() now ALSO resolves the real
  // ExecutionDraft/ScenarioPlan chain via resolveExecutionView(order.executionId) to run the
  // readiness check — it is no longer a pure function of just (order,trade,draft) shape. The
  // synthetic okOrder/okTrade/okDraft below have no real backing executionId, so the true "fully
  // eligible -> ok:true" path can only be verified against a REAL fixture (see Part C's "TESTNET
  // DRAFT + PASS: submission succeeds" below, which exercises this exact path end-to-end via
  // submitRealOrderToTestnet -> checkOrderSubmissionEligibility). Every NEGATIVE case below still
  // short-circuits on an earlier check before ever reaching resolveExecutionView, so they remain
  // valid as pure synthetic-object tests.
  const okOrder = { status: 'DRAFT', exchangeOrderId: null, pendingClientOrderId: null, role: 'ENTRY', intent: 'OPEN', orderType: 'MARKET' };
  const okTrade = { status: 'PLANNED' };
  const okDraft = { status: 'CONFIRMED' };
  check('missing order -> not ok', M.checkOrderSubmissionEligibility(null, okTrade, okDraft).ok === false);
  check('exchangeOrderId already set -> not ok', M.checkOrderSubmissionEligibility({ ...okOrder, exchangeOrderId: '1' }, okTrade, okDraft).ok === false);
  check('status SUBMITTED -> not ok (already submitted)', M.checkOrderSubmissionEligibility({ ...okOrder, status: 'SUBMITTED' }, okTrade, okDraft).ok === false);
  check('status FILLED -> not ok', M.checkOrderSubmissionEligibility({ ...okOrder, status: 'FILLED' }, okTrade, okDraft).ok === false);
  check('status CANCELLED -> not ok', M.checkOrderSubmissionEligibility({ ...okOrder, status: 'CANCELLED' }, okTrade, okDraft).ok === false);
  check('pendingClientOrderId set -> not ok, requiresRecovery', (() => { const r = M.checkOrderSubmissionEligibility({ ...okOrder, pendingClientOrderId: 'X' }, okTrade, okDraft); return r.ok === false && r.requiresRecovery === true; })());
  check('role != ENTRY -> not ok', M.checkOrderSubmissionEligibility({ ...okOrder, role: 'STOP_LOSS' }, okTrade, okDraft).ok === false);
  check('orderType STOP -> not ok (unsupported type)', M.checkOrderSubmissionEligibility({ ...okOrder, orderType: 'STOP' }, okTrade, okDraft).ok === false);
  check('orderType TAKE_PROFIT_MARKET -> not ok', M.checkOrderSubmissionEligibility({ ...okOrder, orderType: 'TAKE_PROFIT_MARKET' }, okTrade, okDraft).ok === false);
  check('trade not PLANNED -> not ok', M.checkOrderSubmissionEligibility(okOrder, { status: 'OPEN' }, okDraft).ok === false);
  check('draft not CONFIRMED -> not ok', M.checkOrderSubmissionEligibility(okOrder, okTrade, { status: 'DRAFT' }).ok === false);
})();

// =====================================================================
// PART B — status mapping regression (reused function, still correct)
// =====================================================================
(function testStatusMapping() {
  check('NEW -> SUBMITTED', M.mapExchangeOrderStatusToLocalOrderStatus('NEW') === 'SUBMITTED');
  check('FILLED -> FILLED', M.mapExchangeOrderStatusToLocalOrderStatus('FILLED') === 'FILLED');
  check('unknown -> null', M.mapExchangeOrderStatusToLocalOrderStatus('WEIRD') === null);
})();

// =====================================================================
// PART C — submission safety (Task 37)
// =====================================================================
async function testSubmissionSafety() {
  // 1. TESTNET DRAFT PASS eligible -> success
  resetAll();
  {
    const f = await makeConfirmedFixture();
    submitResponseFixture = orderSnap({ status: 'NEW', clientOrderId: f.order.orderId });
    const result = await M.submitRealOrderToTestnet(f.order.orderId);
    check('TESTNET DRAFT + PASS: submission succeeds', result.ok === true);
    if (result.ok) {
      check('success: exchangeOrderId persisted', result.order.exchangeOrderId === '9999');
      check('success: status mapped to SUBMITTED', result.order.status === 'SUBMITTED');
      check('success: pendingClientOrderId cleared', result.order.pendingClientOrderId === null);
      check('success: Trade -> OPENING', result.trade.status === 'OPENING');
    }
    const postCalls = fetchCallLog.filter((c) => c.method === 'POST' && c.url.includes('/orders'));
    check('success: exactly one POST /orders call', postCalls.length === 1);
  }

  // 2. LIVE hard rejected — no /orders POST ever attempted
  resetAll();
  connectionsFixture = [{ id: 'conn1', enabled: true, environment: 'LIVE', name: 'live-conn' }];
  {
    const f = await makeConfirmedFixture();
    const result = await M.submitRealOrderToTestnet(f.order.orderId);
    check('LIVE: rejected', result.ok === false);
    check('LIVE: rejection message mentions TESTNET/环境', /TESTNET|环境/.test(result.error || ''));
    const postCalls = fetchCallLog.filter((c) => c.method === 'POST' && c.url.includes('/orders'));
    check('LIVE: zero /orders POST calls made', postCalls.length === 0);
  }

  // 3. BLOCKED Risk Guard rejected (unresolvable account) — no /orders POST attempted
  resetAll();
  accountSnapshotFixture = null;
  {
    const f = await makeConfirmedFixture();
    const result = await M.submitRealOrderToTestnet(f.order.orderId);
    check('Risk Guard BLOCKED: submission rejected', result.ok === false && result.riskBlocked === true);
    const postCalls = fetchCallLog.filter((c) => c.method === 'POST' && c.url.includes('/orders'));
    check('Risk Guard BLOCKED: zero /orders POST calls made', postCalls.length === 0);
  }

  // 4. already exchange-linked rejected
  resetAll();
  {
    const f = await makeConfirmedFixture();
    f.order.exchangeOrderId = '111'; M.saveRealOrder(f.order);
    const result = await M.submitRealOrderToTestnet(f.order.orderId);
    check('already linked: rejected without any network call', result.ok === false);
    check('already linked: no /orders POST made', fetchCallLog.filter((c) => c.method === 'POST' && c.url.includes('/orders')).length === 0);
  }

  // 5. non-DRAFT rejected
  resetAll();
  {
    const f = await makeConfirmedFixture();
    f.order.status = 'CANCELLED'; M.saveRealOrder(f.order);
    const result = await M.submitRealOrderToTestnet(f.order.orderId);
    check('non-DRAFT (CANCELLED): rejected', result.ok === false);
  }

  // 6. duplicate click does not send twice
  resetAll();
  {
    const f = await makeConfirmedFixture();
    submitResponseFixture = orderSnap({ status: 'NEW' });
    const [r1, r2] = await Promise.all([M.submitRealOrderToTestnet(f.order.orderId), (async () => { await new Promise((r) => setTimeout(r, 5)); return M.submitRealOrderToTestnet(f.order.orderId); })()]);
    const postCalls = fetchCallLog.filter((c) => c.method === 'POST' && c.url.includes('/orders'));
    check('duplicate click: at most one POST /orders reaches Binance', postCalls.length <= 1);
    check('duplicate click: exactly one of the two calls succeeded', (r1.ok ? 1 : 0) + (r2.ok ? 1 : 0) === 1);
  }

  console.log('submission safety tests done');
}

// =====================================================================
// PART D — network ambiguity (Task 39)
// =====================================================================
async function testAmbiguity() {
  // ambiguous submission -> pendingClientOrderId set, exchangeOrderId still null
  resetAll();
  submitBehavior = 'ambiguous';
  {
    const f = await makeConfirmedFixture();
    const result = await M.submitRealOrderToTestnet(f.order.orderId);
    check('ambiguous submission: ok=false, ambiguous=true', result.ok === false && result.ambiguous === true);
    const stored = M.getRealOrderById(f.order.orderId);
    check('ambiguous submission: pendingClientOrderId set (survives)', stored.pendingClientOrderId === f.order.orderId);
    check('ambiguous submission: exchangeOrderId still null (never guessed)', stored.exchangeOrderId === null);
    check('ambiguous submission: local Order remains DRAFT', stored.status === 'DRAFT');

    // eligibility now requires recovery, not a normal resubmit
    const eligibility = M.checkOrderSubmissionEligibility(stored, M.getRealTradeById(stored.tradeId), M.resolveExecutionView(stored.executionId).draft);
    check('ambiguous: further eligibility check requires recovery', eligibility.ok === false && eligibility.requiresRecovery === true);

    // recovery: found on exchange -> success path applied
    recoveryResponseFixture = orderSnap({ status: 'NEW', clientOrderId: stored.pendingClientOrderId });
    const recovered = await M.recoverAmbiguousSubmission(f.order.orderId);
    check('recovery (found): ok, found=true', recovered.ok === true && recovered.found === true);
    check('recovery (found): exchangeOrderId now set', recovered.order.exchangeOrderId === '9999');
    check('recovery (found): pendingClientOrderId cleared', recovered.order.pendingClientOrderId === null);
  }

  // ambiguous submission, then recovery finds nothing -> cleared, allowed to retry
  resetAll();
  submitBehavior = 'ambiguous';
  {
    const f = await makeConfirmedFixture();
    await M.submitRealOrderToTestnet(f.order.orderId);
    recoveryBehavior = 'not-found';
    const recovered = await M.recoverAmbiguousSubmission(f.order.orderId);
    check('recovery (not found): ok, cleared=true', recovered.ok === true && recovered.cleared === true);
    const stored = M.getRealOrderById(f.order.orderId);
    check('recovery (not found): pendingClientOrderId cleared, order still DRAFT', stored.pendingClientOrderId === null && stored.status === 'DRAFT');
    check('recovery (not found): exchangeOrderId still null, eligible to retry', stored.exchangeOrderId === null);
    const eligibility = M.checkOrderSubmissionEligibility(stored, M.getRealTradeById(stored.tradeId), M.resolveExecutionView(stored.executionId).draft);
    check('recovery (not found): now eligible for a fresh submission', eligibility.ok === true);
  }

  console.log('ambiguity tests done');
}

// =====================================================================
// PART E — Trade lifecycle after submission (Task 40)
// =====================================================================
async function testTradeLifecycleAfterSubmission() {
  // FILLED immediate response
  resetAll();
  submitResponseFixture = orderSnap({ status: 'FILLED', executedQuantity: 0.02, averagePrice: 65005, updatedAt: '2026-08-09T12:00:00.000Z' });
  {
    const f = await makeConfirmedFixture();
    const result = await M.submitRealOrderToTestnet(f.order.orderId);
    check('immediate FILLED: Order status FILLED (not forced SUBMITTED)', result.ok === true && result.order.status === 'FILLED');
    check('immediate FILLED: Trade -> OPEN', result.trade.status === 'OPEN');
    check('immediate FILLED: openedAt from exchange timestamp', result.trade.openedAt === '2026-08-09T12:00:00.000Z');
    check('immediate FILLED: filled quantity/avgPrice persisted', result.order.filled.quantity === 0.02 && result.order.filled.averagePrice === 65005);
  }

  // PARTIALLY_FILLED immediate response
  resetAll();
  submitResponseFixture = orderSnap({ status: 'PARTIALLY_FILLED', executedQuantity: 0.01, averagePrice: 65002 });
  {
    const f = await makeConfirmedFixture();
    const result = await M.submitRealOrderToTestnet(f.order.orderId);
    check('immediate PARTIALLY_FILLED: Order status PARTIALLY_FILLED', result.ok === true && result.order.status === 'PARTIALLY_FILLED');
    check('immediate PARTIALLY_FILLED: Trade -> OPENING', result.trade.status === 'OPENING');
  }

  console.log('lifecycle-after-submission tests done');
}

// =====================================================================
// PART F — Trade Detail UI (Task 27/31/32/40)
// =====================================================================
async function testUi() {
  // eligible DRAFT shows submit button
  resetAll();
  {
    const f = await makeConfirmedFixture();
    const htmlOut = M.renderRealTradeDetail(f.trade);
    check('eligible DRAFT: shows 提交到 TESTNET button', new RegExp(`data-action="submit-real-order"[^>]*data-order-id="${f.order.orderId}"`).test(htmlOut));
  }

  // pendingClientOrderId set -> shows recovery action, not submit button
  resetAll();
  submitBehavior = 'ambiguous';
  {
    const f = await makeConfirmedFixture();
    await M.submitRealOrderToTestnet(f.order.orderId);
    const trade = M.getRealTradeById(f.trade.tradeId);
    const htmlOut = M.renderRealTradeDetail(trade);
    check('ambiguous pending: shows recovery button', new RegExp(`data-action="recover-ambiguous-order"[^>]*data-order-id="${f.order.orderId}"`).test(htmlOut));
    check('ambiguous pending: does NOT show normal submit button', !new RegExp(`data-action="submit-real-order"`).test(htmlOut));
  }

  // FILLED with real fill -> truthful Position/PnL text, no fake numbers
  resetAll();
  submitResponseFixture = orderSnap({ status: 'FILLED', executedQuantity: 0.02, averagePrice: 65005 });
  {
    const f = await makeConfirmedFixture();
    await M.submitRealOrderToTestnet(f.order.orderId);
    const trade = M.getRealTradeById(f.trade.tradeId);
    const htmlOut = M.renderRealTradeDetail(trade);
    // Sprint 3.5D-C, disclosed intentional reword: Position Sync now genuinely exists, so a real fill
    // with no linked local Position yet (this test never calls syncPositionsFromExchange) shows the
    // new honest "等待交易所持仓同步" wording instead of the old "本地 Position Sync 尚未完成".
    check('FILLED: position text truthful (real fill, no local Position)', /订单已成交，等待交易所持仓同步/.test(htmlOut));
    check('FILLED: no fake Position created language ("尚未建立仓位（尚无真实成交）") remains for a filled order', !/尚未建立仓位（尚无真实成交）/.test(htmlOut));
    check('FILLED: pnl text truthful, no fabricated number', /等待持仓同步以显示真实盈亏/.test(htmlOut));
    check('FILLED: still no fake numeric PnL rendered (no +/-$ digits in pnl line context)', !/[+-]\$[\d,]+\.\d\d/.test(htmlOut.match(/dt-pnl[\s\S]{0,300}/)[0]));
  }

  // no fill (DRAFT) -> still the original honest empty text
  resetAll();
  {
    const f = await makeConfirmedFixture();
    const htmlOut = M.renderRealTradeDetail(f.trade);
    check('no fill: position text is the no-fill variant', /尚未建立仓位（订单尚无真实成交）/.test(htmlOut));
    check('no fill: pnl text unchanged baseline', /暂无真实成交，暂无盈亏/.test(htmlOut));
  }

  // stop/TP warning shown once submitted
  resetAll();
  {
    const f = await makeConfirmedFixture();
    await M.submitRealOrderToTestnet(f.order.orderId);
    const trade = M.getRealTradeById(f.trade.tradeId);
    const htmlOut = M.renderRealTradeDetail(trade);
    check('submitted: stop/TP warning shown', /当前版本只提交入场订单。AI 计划中的止损\/止盈尚未自动挂到交易所。/.test(htmlOut));
  }

  console.log('ui tests done');
}

(async function main() {
  await testSubmissionSafety();
  await testAmbiguity();
  await testTradeLifecycleAfterSubmission();
  await testUi();
  console.log(`\n3.5D-B frontend tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
})();
