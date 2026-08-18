// Sprint 3.5D-D frontend tests — Binance TESTNET Manual Order Cancellation.
// Same vm-slicing technique as prior sprints. global.fetch mocked (backend endpoints only) — NO real
// network calls, and every mocked "cancel" response is synthetic; nothing here ever reaches Binance.
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('c:/Users/surface/Documents/Obsidian Vault/量化/prototype/index.html', 'utf8');
const scriptStart = html.indexOf('<script>') + '<script>'.length;
const marker = '/* ---------- Interactions ---------- */';
const markerIdx = html.indexOf(marker, scriptStart);
let slice = html.slice(scriptStart, markerIdx);

const EXPORT_NAMES = [
  'checkOrderCancellationEligibility', 'openCancelOrderConfirmationModal', 'cancelRealOrderOnTestnet',
  'triggerPositionSyncForOrder', 'syncRealOrderFromExchange', 'mapExchangeOrderStatusToLocalOrderStatus',
  'propagateEntryOrderStatusToTrade', 'checkOrderSubmissionEligibility', 'submitRealOrderToTestnet',
  'createOrReuseExecutionDraft', 'confirmExecutionDraft', 'resolveExecutionView', 'getRealTradeByExecutionId',
  'loadRealOrders', 'getRealOrderById', 'saveRealOrder', 'loadRealTrades', 'getRealTradeById', 'saveRealTrade',
  'loadRealPositions', 'loadRiskSettings', 'saveRiskSettings', 'renderRealTradeDetail', 'REAL_ORDER_STATUS_LABEL',
  'Store',
];
slice += `\nObject.assign((globalThis.__exports = globalThis.__exports || {}), {${EXPORT_NAMES.join(',')}});\n`;

let store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
// Elements are persisted by id (unlike a bare fresh-object-per-call mock) specifically so modal
// content (openModal() writes into 'modal-body') can be inspected after the fact — needed for Task 34's
// "confirmation modal shows TESTNET" / "partial fill warning visible" checks.
const elementsById = {};
function fakeEl(id) {
  const el = {
    _innerHTML: '', get innerHTML() { return this._innerHTML; }, set innerHTML(v) { this._innerHTML = v; },
    classList: { add() {}, remove() {} }, appendChild() {}, remove() {}, addEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, dataset: {},
  };
  if (id) elementsById[id] = el;
  return el;
}
const document = {
  getElementById(id) { return elementsById[id] || fakeEl(id); },
  createElement() { return { innerHTML: '', content: { firstElementChild: fakeEl() } }; },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
};
const location = { hash: '#/dashboard' };
const window = { addEventListener() {}, scrollTo() {} };
function requestAnimationFrame(cb) {}
function wireInteractions() {}

let fetchCallLog = [];
let connectionsFixture = [{ id: 'conn1', enabled: true, environment: 'TESTNET', name: 'test' }];
let orderGetFixture = null; // controls the fresh pre-cancel GET /order response
let orderGetBehavior = 'ok'; // 'ok' | 'error'
let deleteFixture = null; // controls the DELETE response
let deleteBehavior = 'ok'; // 'ok' | 'timeout' | 'network' | 'deterministic-error'
let accountSnapFixture = null;

async function fetch(url, opts) {
  const method = (opts && opts.method) || 'GET';
  fetchCallLog.push({ url: String(url), method });
  const u = String(url);
  if (u.includes('/api/prices')) return { ok: true, json: async () => [] };
  if (u.endsWith('/api/exchange/connections')) return { ok: true, json: async () => ({ ok: true, connections: connectionsFixture }) };
  const acctMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/account$/);
  if (acctMatch) {
    if (!accountSnapFixture) return { ok: true, json: async () => ({ ok: false, error: { code: 'network_error', message: '无法读取真实账户状态' } }) };
    return { ok: true, json: async () => ({ ok: true, snapshot: accountSnapFixture }) };
  }
  const orderCancelMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/orders\/([^/?]+)\?/);
  if (orderCancelMatch && method === 'DELETE') {
    if (deleteBehavior === 'timeout' || deleteBehavior === 'network') {
      throw new Error('mock network failure: ' + deleteBehavior);
    }
    if (deleteBehavior === 'deterministic-error') {
      return { ok: true, json: async () => ({ ok: false, error: { code: 'order_not_cancellable', message: '订单无法撤销（可能已成交、已撤销或不存在）' } }) };
    }
    return { ok: true, json: async () => ({ ok: true, snapshot: deleteFixture }) };
  }
  const orderGetMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/order\?/);
  if (orderGetMatch) {
    if (orderGetBehavior === 'error') return { ok: true, json: async () => ({ ok: false, error: { code: 'network_error', message: '网络错误' } }) };
    return { ok: true, json: async () => ({ ok: true, snapshot: orderGetFixture }) };
  }
  throw new Error('UNEXPECTED FETCH in cancel-frontend test: ' + method + ' ' + u);
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
  elementsById['modal-body'] = fakeEl('modal-body');
  elementsById['modal-bg'] = fakeEl('modal-bg');
  connectionsFixture = [{ id: 'conn1', enabled: true, environment: 'TESTNET', name: 'test' }];
  orderGetFixture = null; orderGetBehavior = 'ok';
  deleteFixture = null; deleteBehavior = 'ok';
  accountSnapFixture = accountSnap([]);
}

function accountSnap(positions) {
  return {
    connectionId: 'conn1', exchange: 'binance-futures', environment: 'TESTNET', fetchedAt: new Date().toISOString(),
    account: { canTrade: true },
    accountRisk: { totalWalletBalance: 100000, totalUnrealizedPnl: 0, totalMarginBalance: 100000, totalInitialMargin: 0, totalMaintMargin: 0, availableBalance: 100000 },
    balances: [{ asset: 'USDT', free: 100000, locked: 0, total: 100000 }],
    positions: positions || [], protectiveOrders: [], protectionReadStatus: 'OK',
  };
}
function positionSnap(overrides) {
  return Object.assign({
    symbol: 'BTCUSDT', side: 'LONG', positionSide: 'BOTH', marginType: 'ISOLATED',
    quantity: 0.01, entryPrice: 65000, markPrice: 65500, breakEvenPrice: 65010,
    unrealizedPnl: 5, leverage: 10, isolatedMargin: 65, positionInitialMargin: 65,
    maintenanceMargin: 3, liquidationPrice: 59000, distanceToLiquidationPct: 10,
    protection: { stopLossOrders: [], takeProfitOrders: [], trailingStopOrders: [] },
  }, overrides);
}
function orderGetSnap(overrides) {
  return Object.assign({
    exchangeOrderId: '9999', clientOrderId: 'OR1CLIENT', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', status: 'NEW',
    originalQuantity: 0.02, executedQuantity: 0, averagePrice: null, price: 65000, stopPrice: null,
    reduceOnly: false, closePosition: false, createdAt: '2026-08-10T10:00:00.000Z', updatedAt: '2026-08-10T10:00:00.000Z',
  }, overrides);
}
function cancelSnap(overrides) {
  return Object.assign({
    exchangeOrderId: '9999', clientOrderId: 'OR1CLIENT', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', status: 'CANCELED',
    originalQuantity: 0.02, executedQuantity: 0, averagePrice: null, price: 65000, stopPrice: null,
    reduceOnly: false, closePosition: false, createdAt: '2026-08-10T10:00:00.000Z', updatedAt: '2026-08-10T10:05:00.000Z',
  }, overrides);
}

let seq = 0;
function makePlan(overrides) {
  seq++;
  return Object.assign({
    id: 'plan' + seq, priority: 'PRIMARY', direction: 'LONG', action: 'ENTER', title: 'Test Plan ' + seq,
    trigger: '突破 65000', triggerStructured: null, invalidation: null,
    reviewHorizon: { description: '有效期 3 天', expiresAt: '2030-08-10T17:00:00+08:00' }, holdingPeriod: '1-3 天',
    entry: { type: 'MARKET', value: null, from: null, to: null, description: null },
    stopLoss: { value: 63000, description: null }, takeProfit: [{ value: 68000, description: null }],
    rationale: '测试理由', evidenceReferences: ['ref1'],
  }, typeof overrides === 'function' ? overrides({}) : overrides);
}
function makeFixture(planOverrides) {
  seq++;
  const analysisId = 'A' + seq;
  const plan = makePlan(planOverrides);
  const payload = { analysisId, symbol: 'BTC/USDT', collectedAt: new Date().toISOString() };
  const record = {
    analysisId, responseVersion: '2.2.0', promptVersion: '2.2.0', payloadVersion: '1.1.0',
    provider: 'test', model: 'test-model', generatedAt: new Date().toISOString(),
    response: {
      responseVersion: '2.2.0', decision: { direction: plan.direction, action: 'ENTER', confidence: 70 },
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
/** Confirms a draft (real DRAFT Order + PLANNED Trade), then hand-advances the Order to a real
 * SUBMITTED/PARTIALLY_FILLED state with a genuine exchangeOrderId/exchangeConnectionId — exactly the
 * state a real TESTNET submission (Sprint 3.5D-B, already covered by its own test suite) would reach.
 * Never goes through the actual submission code path itself (out of scope for this file). */
async function makeLiveOrderFixture(orderOverrides, planOverrides) {
  const f = makeFixture(planOverrides);
  const view = M.resolveExecutionView(f.draft.executionId);
  view.draft.userOverrides.positionSize = 1300;
  view.draft.userOverrides.leverage = 10;
  const map = JSON.parse(localStorage.getItem('qa_execution_drafts'));
  map[f.draft.executionId] = view.draft;
  localStorage.setItem('qa_execution_drafts', JSON.stringify(map));
  await M.confirmExecutionDraft(f.draft.executionId);
  const trade = M.getRealTradeByExecutionId(f.draft.executionId);
  const order = Object.values(M.loadRealOrders()).find((o) => o.tradeId === trade.tradeId && o.role === 'ENTRY');
  Object.assign(order, {
    status: 'SUBMITTED', exchangeOrderId: '9999', exchangeConnectionId: 'conn1', symbol: 'BTC/USDT',
    filled: { quantity: 0, averagePrice: null },
  }, orderOverrides);
  M.saveRealOrder(order);
  trade.status = 'OPENING';
  M.saveRealTrade(trade);
  return { ...f, trade, order };
}

async function run() {
  // =====================================================================
  // PART A — Task 28: Cancellation eligibility (pure function)
  // =====================================================================
  {
    const base = { exchangeOrderId: '9999', status: 'SUBMITTED' };
    check('eligibility: SUBMITTED + exchangeOrderId -> cancellable', M.checkOrderCancellationEligibility({ ...base, status: 'SUBMITTED' }).ok === true);
    check('eligibility: PARTIALLY_FILLED -> cancellable', M.checkOrderCancellationEligibility({ ...base, status: 'PARTIALLY_FILLED' }).ok === true);
    check('eligibility: DRAFT -> not cancellable', M.checkOrderCancellationEligibility({ ...base, status: 'DRAFT' }).ok === false);
    check('eligibility: FILLED -> not cancellable', M.checkOrderCancellationEligibility({ ...base, status: 'FILLED' }).ok === false);
    check('eligibility: CANCELLED -> not cancellable', M.checkOrderCancellationEligibility({ ...base, status: 'CANCELLED' }).ok === false);
    check('eligibility: REJECTED -> not cancellable', M.checkOrderCancellationEligibility({ ...base, status: 'REJECTED' }).ok === false);
    check('eligibility: EXPIRED -> not cancellable', M.checkOrderCancellationEligibility({ ...base, status: 'EXPIRED' }).ok === false);
    check('eligibility: missing exchangeOrderId -> not cancellable', M.checkOrderCancellationEligibility({ status: 'SUBMITTED', exchangeOrderId: null }).ok === false);
    check('eligibility: null order -> not cancellable', M.checkOrderCancellationEligibility(null).ok === false);
  }

  // =====================================================================
  // PART B — Task 29: Fresh pre-cancel query branching
  // =====================================================================
  async function testCaseB() {
    // remote NEW -> confirmation modal shown (TESTNET + confirm button present)
    resetAll();
    const f1 = await makeLiveOrderFixture();
    orderGetFixture = orderGetSnap({ status: 'NEW' });
    await M.openCancelOrderConfirmationModal(f1.order.orderId);
    const modalHtml1 = sandbox.document.getElementById('modal-body').innerHTML;
    check('pre-cancel: remote NEW -> modal shown', modalHtml1.includes('确认撤销 TESTNET 订单'));
    check('pre-cancel: remote NEW -> modal shows TESTNET', modalHtml1.includes('TESTNET'));
    check('pre-cancel: remote NEW -> local synced to SUBMITTED', M.getRealOrderById(f1.order.orderId).status === 'SUBMITTED');
    check('pre-cancel: remote NEW -> no DELETE sent yet', !fetchCallLog.some((c) => c.method === 'DELETE'));

    // remote PARTIALLY_FILLED -> modal shown with partial-fill warning
    resetAll();
    const f2 = await makeLiveOrderFixture();
    orderGetFixture = orderGetSnap({ status: 'PARTIALLY_FILLED', executedQuantity: 0.01, avgPrice: 65010 });
    await M.openCancelOrderConfirmationModal(f2.order.orderId);
    const modalHtml2 = sandbox.document.getElementById('modal-body').innerHTML;
    check('pre-cancel: remote PARTIALLY_FILLED -> modal shown', modalHtml2.includes('确认撤销 TESTNET 订单'));
    check('pre-cancel: remote PARTIALLY_FILLED -> partial-fill warning visible in modal', modalHtml2.includes('已部分成交') && modalHtml2.includes('已成交部分不会被撤销'));
    check('pre-cancel: remote PARTIALLY_FILLED -> local synced', M.getRealOrderById(f2.order.orderId).status === 'PARTIALLY_FILLED');

    // remote FILLED -> no DELETE, no modal, sync to FILLED, Position Sync triggered
    resetAll();
    const f3 = await makeLiveOrderFixture();
    orderGetFixture = orderGetSnap({ status: 'FILLED', executedQuantity: 0.02, avgPrice: 65005 });
    accountSnapFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG' })]);
    await M.openCancelOrderConfirmationModal(f3.order.orderId);
    const modalHtml3 = sandbox.document.getElementById('modal-body').innerHTML;
    check('pre-cancel: remote FILLED -> no confirmation modal shown', !modalHtml3.includes('确认撤销 TESTNET 订单'));
    check('pre-cancel: remote FILLED -> local synced to FILLED', M.getRealOrderById(f3.order.orderId).status === 'FILLED');
    check('pre-cancel: remote FILLED -> no DELETE ever sent', !fetchCallLog.some((c) => c.method === 'DELETE'));
    check('pre-cancel: remote FILLED -> Position Sync triggered (account fetched)', fetchCallLog.some((c) => c.url.includes('/account')));
    check('pre-cancel: remote FILLED -> real Position created from the sync', Object.keys(M.loadRealPositions()).length === 1);

    // remote CANCELED (already cancelled elsewhere) -> no DELETE, no modal
    resetAll();
    const f4 = await makeLiveOrderFixture();
    orderGetFixture = orderGetSnap({ status: 'CANCELED', executedQuantity: 0 });
    await M.openCancelOrderConfirmationModal(f4.order.orderId);
    const modalHtml4 = sandbox.document.getElementById('modal-body').innerHTML;
    check('pre-cancel: remote CANCELED -> no modal', !modalHtml4.includes('确认撤销 TESTNET 订单'));
    check('pre-cancel: remote CANCELED -> local synced to CANCELLED', M.getRealOrderById(f4.order.orderId).status === 'CANCELLED');
    check('pre-cancel: remote CANCELED -> no DELETE ever sent', !fetchCallLog.some((c) => c.method === 'DELETE'));

    // remote EXPIRED -> no DELETE, no modal
    resetAll();
    const f5 = await makeLiveOrderFixture();
    orderGetFixture = orderGetSnap({ status: 'EXPIRED', executedQuantity: 0 });
    await M.openCancelOrderConfirmationModal(f5.order.orderId);
    check('pre-cancel: remote EXPIRED -> local synced to EXPIRED', M.getRealOrderById(f5.order.orderId).status === 'EXPIRED');
    check('pre-cancel: remote EXPIRED -> no DELETE ever sent', !fetchCallLog.some((c) => c.method === 'DELETE'));

    // remote REJECTED -> no DELETE, no modal
    resetAll();
    const f6 = await makeLiveOrderFixture();
    orderGetFixture = orderGetSnap({ status: 'REJECTED', executedQuantity: 0 });
    await M.openCancelOrderConfirmationModal(f6.order.orderId);
    check('pre-cancel: remote REJECTED -> local synced to REJECTED', M.getRealOrderById(f6.order.orderId).status === 'REJECTED');
    check('pre-cancel: remote REJECTED -> no DELETE ever sent', !fetchCallLog.some((c) => c.method === 'DELETE'));
  }
  await testCaseB();

  // =====================================================================
  // PART C/D — Task 31: Partial fill cancellation
  // =====================================================================
  async function testPartialFill() {
    resetAll();
    const f = await makeLiveOrderFixture({ status: 'PARTIALLY_FILLED', filled: { quantity: 0.01, averagePrice: 65010 }, exchangeSnapshot: { status: 'PARTIALLY_FILLED', originalQuantity: 0.02, executedQuantity: 0.01, averagePrice: 65010, price: 65000, updatedAt: '2026-08-10T10:00:00.000Z' } });
    deleteFixture = cancelSnap({ status: 'CANCELED', executedQuantity: 0.01, avgPrice: 65010, origQty: 0.02 });
    accountSnapFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01 })]);
    const result = await M.cancelRealOrderOnTestnet(f.order.orderId);
    check('partial cancel: ok', result.ok === true);
    const reloaded = M.getRealOrderById(f.order.orderId);
    check('partial cancel: Order -> CANCELLED', reloaded.status === 'CANCELLED');
    check('partial cancel: filled quantity preserved (not reset to 0)', reloaded.filled.quantity === 0.01);
    check('partial cancel: average fill price preserved', reloaded.filled.averagePrice === 65010);
    const reloadedTrade = M.getRealTradeById(f.trade.tradeId);
    check('partial cancel: Trade NOT set to CANCELLED (real exposure exists)', reloadedTrade.status !== 'CANCELLED');
    check('partial cancel: Position Sync invoked (account fetched)', fetchCallLog.some((c) => c.url.includes('/account')));
    check('partial cancel: real Position created/linked from the sync', Object.keys(M.loadRealPositions()).length === 1);

    // remaining quantity computed correctly via Trade Detail rendering
    const detailHtml = M.renderRealTradeDetail(reloadedTrade);
    check('partial cancel: remaining quantity shown in Trade Detail (0.02-0.01=0.01)', detailHtml.includes('0.01'));
    check('partial cancel: partial-fill post-cancel message shown', detailHtml.includes('剩余未成交数量已撤销') && detailHtml.includes('已成交部分仍形成真实敞口'));

    // no Position fabricated if exchange returns none
    resetAll();
    const f2 = await makeLiveOrderFixture({ status: 'PARTIALLY_FILLED', filled: { quantity: 0.01, averagePrice: 65010 } });
    deleteFixture = cancelSnap({ status: 'CANCELED', executedQuantity: 0.01, avgPrice: 65010 });
    accountSnapFixture = accountSnap([]); // exchange reports zero exposure
    await M.cancelRealOrderOnTestnet(f2.order.orderId);
    check('partial cancel: no Position fabricated when exchange returns none', Object.keys(M.loadRealPositions()).length === 0);
  }
  await testPartialFill();

  // =====================================================================
  // PART E — Task 32: Zero fill cancellation
  // =====================================================================
  async function testZeroFill() {
    resetAll();
    const f = await makeLiveOrderFixture({ status: 'SUBMITTED', filled: { quantity: 0, averagePrice: null } });
    deleteFixture = cancelSnap({ status: 'CANCELED', executedQuantity: 0 });
    fetchCallLog = []; // isolate: fixture setup's own Risk Guard account-aware check already fetched /account
    const result = await M.cancelRealOrderOnTestnet(f.order.orderId);
    check('zero-fill cancel: ok', result.ok === true);
    const reloaded = M.getRealOrderById(f.order.orderId);
    check('zero-fill cancel: Order -> CANCELLED', reloaded.status === 'CANCELLED');
    const reloadedTrade = M.getRealTradeById(f.trade.tradeId);
    check('zero-fill cancel: Trade -> CANCELLED', reloadedTrade.status === 'CANCELLED');
    check('zero-fill cancel: no Position created', Object.keys(M.loadRealPositions()).length === 0);
    check('zero-fill cancel: no Position Sync call made (never speculative)', !fetchCallLog.some((c) => c.url.includes('/account')));

    const detailHtml = M.renderRealTradeDetail(reloadedTrade);
    check('zero-fill cancel: no fake PnL/position text in Trade Detail', !detailHtml.includes('开仓均价'));
    check('zero-fill cancel: zero-fill post-cancel message shown', detailHtml.includes('本次入场未成交，交易计划已取消'));
  }
  await testZeroFill();

  // =====================================================================
  // PART F — Task 33: Ambiguous cancellation failure
  // =====================================================================
  async function testAmbiguous() {
    resetAll();
    const f = await makeLiveOrderFixture();
    deleteBehavior = 'timeout';
    const result = await M.cancelRealOrderOnTestnet(f.order.orderId);
    check('ambiguous: DELETE timeout -> ambiguous:true', result.ok === false && result.ambiguous === true);
    check('ambiguous: local status unchanged on timeout', M.getRealOrderById(f.order.orderId).status === 'SUBMITTED');
    check('ambiguous: exactly one DELETE attempt (no auto retry)', fetchCallLog.filter((c) => c.method === 'DELETE').length === 1);

    resetAll();
    const f2 = await makeLiveOrderFixture();
    deleteBehavior = 'network';
    const result2 = await M.cancelRealOrderOnTestnet(f2.order.orderId);
    check('ambiguous: generic network error -> ambiguous:true', result2.ok === false && result2.ambiguous === true);
    check('ambiguous: local status unchanged on network error', M.getRealOrderById(f2.order.orderId).status === 'SUBMITTED');
    check('ambiguous: exactly one DELETE attempt on network error (no auto retry)', fetchCallLog.filter((c) => c.method === 'DELETE').length === 1);

    // recovery: existing "同步订单状态" path (syncRealOrderFromExchange) is available to resolve truth
    orderGetFixture = orderGetSnap({ status: 'CANCELED', executedQuantity: 0 });
    const syncResult = await M.syncRealOrderFromExchange(f2.order.orderId);
    check('ambiguous: recovery GET available and resolves truth', syncResult.ok === true && M.getRealOrderById(f2.order.orderId).status === 'CANCELLED');

    // second manual cancel attempt AFTER GET reveals terminal state -> no DELETE sent
    resetAll();
    const f3 = await makeLiveOrderFixture();
    orderGetFixture = orderGetSnap({ status: 'CANCELED', executedQuantity: 0 }); // simulates the ambiguous DELETE having actually succeeded
    await M.openCancelOrderConfirmationModal(f3.order.orderId);
    check('idempotency: second cancel attempt after terminal GET sends no DELETE', !fetchCallLog.some((c) => c.method === 'DELETE'));
    check('idempotency: local order reflects terminal truth', M.getRealOrderById(f3.order.orderId).status === 'CANCELLED');
  }
  await testAmbiguous();

  // =====================================================================
  // PART G — Task 34: UI tests via renderRealTradeDetail()
  // =====================================================================
  async function testUi() {
    // cancellable order shows cancel button
    resetAll();
    const f1 = await makeLiveOrderFixture({ status: 'SUBMITTED' });
    let htmlOut = M.renderRealTradeDetail(f1.trade);
    check('UI: cancellable order shows cancel button', htmlOut.includes('data-action="cancel-real-order"'));

    // terminal order hides cancel button
    resetAll();
    const f2 = await makeLiveOrderFixture({ status: 'FILLED', filled: { quantity: 0.02, averagePrice: 65000 } });
    htmlOut = M.renderRealTradeDetail(f2.trade);
    check('UI: FILLED order hides cancel button', !htmlOut.includes('data-action="cancel-real-order"'));

    resetAll();
    const f3 = await makeLiveOrderFixture({ status: 'DRAFT', exchangeOrderId: null });
    htmlOut = M.renderRealTradeDetail(f3.trade);
    check('UI: DRAFT order hides cancel button', !htmlOut.includes('data-action="cancel-real-order"'));

    // scenario expired warning does not auto-cancel
    resetAll();
    const f4 = await makeLiveOrderFixture({ status: 'SUBMITTED' }, () => ({ reviewHorizon: { description: '已过期', expiresAt: '2020-01-01T00:00:00+08:00' } }));
    htmlOut = M.renderRealTradeDetail(f4.trade);
    check('UI: expired scenario shows warning', htmlOut.includes('策略方案已过期，但交易所订单仍有效'));
    check('UI: expired scenario order status unchanged (no auto-cancel)', M.getRealOrderById(f4.order.orderId).status === 'SUBMITTED');
    check('UI: rendering never sends a DELETE', !fetchCallLog.some((c) => c.method === 'DELETE'));

    // Risk Guard blocked warning does not auto-cancel — riskGuard is just a persisted field, rendering
    // it must never itself trigger any cancel call.
    resetAll();
    const f5 = await makeLiveOrderFixture({ status: 'SUBMITTED', riskGuard: { status: 'BLOCKED', checkedAt: new Date().toISOString(), checks: [] } });
    htmlOut = M.renderRealTradeDetail(f5.trade);
    check('UI: BLOCKED Risk Guard rendered without triggering any cancel', !fetchCallLog.some((c) => c.method === 'DELETE') && M.getRealOrderById(f5.order.orderId).status === 'SUBMITTED');
  }
  await testUi();

  // =====================================================================
  // PART H — Task 35: Truth boundaries
  // =====================================================================
  async function testTruthBoundaries() {
    resetAll();
    const f = await makeLiveOrderFixture({ status: 'PARTIALLY_FILLED', filled: { quantity: 0.01, averagePrice: 65010 } });
    const orderCountBefore = Object.keys(M.loadRealOrders()).length;
    const tradeCountBefore = Object.keys(M.loadRealTrades()).length;
    deleteFixture = cancelSnap({ status: 'CANCELED', executedQuantity: 0.01, avgPrice: 65010 });
    accountSnapFixture = accountSnap([]);
    await M.cancelRealOrderOnTestnet(f.order.orderId);

    check('truth boundary: no new order submitted (no POST /orders call)', !fetchCallLog.some((c) => c.method === 'POST' && c.url.includes('/orders')));
    check('truth boundary: no replacement order created', Object.keys(M.loadRealOrders()).length === orderCountBefore);
    check('truth boundary: no Trade deleted/duplicated', Object.keys(M.loadRealTrades()).length === tradeCountBefore);
    check('truth boundary: RealOrder record still exists (status transition only)', M.getRealOrderById(f.order.orderId) != null);
    check('truth boundary: RealTrade record still exists', M.getRealTradeById(f.trade.tradeId) != null);
    check('truth boundary: no AI endpoint ever called', !fetchCallLog.some((c) => c.url.includes('/api/ai/')));
    check('truth boundary: every fetch call was to an expected exchange/prices/account endpoint (no leverage/margin/transfer/withdraw route)', fetchCallLog.every((c) => c.url.includes('/api/exchange/') || c.url.includes('/api/prices')));
  }
  await testTruthBoundaries();

  // =====================================================================
  // PART I — LIVE connection hard reject (Task 28)
  // =====================================================================
  {
    resetAll();
    const f = await makeLiveOrderFixture();
    connectionsFixture = [{ id: 'conn1', enabled: true, environment: 'LIVE', name: 'live-conn' }];
    const result = await M.cancelRealOrderOnTestnet(f.order.orderId);
    check('LIVE connection: cancellation hard rejected', result.ok === false);
    check('LIVE connection: no DELETE ever sent', !fetchCallLog.some((c) => c.method === 'DELETE'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
}

run().catch((e) => { console.error('TEST RUNNER ERROR:', e); process.exit(1); });
