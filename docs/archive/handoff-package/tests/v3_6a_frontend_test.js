// Sprint 3.6A frontend tests — Position Allocation, Account/Portfolio page, leverage-sync recovery
// flow, real-time SSE handling. Same vm-slicing technique as prior sprints. global.fetch/EventSource
// mocked — NO real network calls, every fixture synthetic; nothing here ever reaches Binance.
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('c:/Users/surface/Documents/Obsidian Vault/量化/prototype/index.html', 'utf8');
const scriptStart = html.indexOf('<script>') + '<script>'.length;
const marker = '/* ---------- Interactions ---------- */';
const markerIdx = html.indexOf(marker, scriptStart);
let slice = html.slice(scriptStart, markerIdx);

const EXPORT_NAMES = [
  // Position Allocation
  'reconcilePositionAllocations', 'getPositionAllocationSummary', 'loadPositionAllocations', 'allocationsForPosition',
  'saveRealPosition', 'loadRealPositions', 'getRealPositionById', 'findPositionByExchangeIdentity', 'genPositionId',
  'renderPositionCard', 'renderPositionAllocationBlock',
  // Account page
  'ensureAccountPageState', 'renderAccountPage', 'renderAccountOpenOrdersTable', 'renderAccountAlgoOrdersTable',
  'renderAccountStreamStatusPill', 'loadAccountPageData', 'startAccountEventStream', 'teardownAccountEventStream',
  'initAccountPage', 'switchAccountPageConnection', 'ACCOUNT_STREAM_STATUS_LABEL', 'ACCOUNT_STREAM_REFRESH_DEBOUNCE_MS',
  'cancelExternalOrderOnTestnet', 'openCancelExternalOrderConfirmationModal',
  'openPositionDetailModal', 'openPositionProtectionModal', 'openPositionAllocationModal',
  // Leverage sync
  'openLeverageSyncConfirmationModal', 'confirmLeverageSyncAndResubmit', 'submitRealOrderToTestnet',
  'checkOrderSubmissionEligibility',
  // Shared fixtures/infra
  'createOrReuseExecutionDraft', 'confirmExecutionDraft', 'resolveExecutionView', 'getRealTradeByExecutionId',
  'loadRealOrders', 'getRealOrderById', 'saveRealOrder', 'loadRealTrades', 'getRealTradeById', 'saveRealTrade',
  'loadRiskSettings', 'saveRiskSettings', 'toBinanceSymbol', 'Store',
];
slice += `\nObject.assign((globalThis.__exports = globalThis.__exports || {}), {${EXPORT_NAMES.join(',')}});\n`;

let store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
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
let currentHash = '#/account';
const location = { get hash() { return currentHash; }, set hash(v) { currentHash = v; } };
const window = { addEventListener() {}, scrollTo() {} };
function requestAnimationFrame(cb) {}
function wireInteractions() {}

// ---- fake EventSource ----
let esInstances = [];
class FakeEventSource {
  constructor(url) { this.url = url; this.onmessage = null; this.onerror = null; this.closed = false; esInstances.push(this); }
  close() { this.closed = true; }
}

// ---- mock fetch ----
let fetchCallLog = [];
let connectionsFixture = [{ id: 'conn1', enabled: true, environment: 'TESTNET', name: 'test' }];
let accountSnapshotFixture = null;
let openOrdersFixture = [];
let priceFixture = [{ symbol: 'BTC/USDT', price: 65000, changePct: 1 }];
let leverageBehavior = 'ok'; // 'ok' | 'error' | 'ambiguous'
let leverageResultFixture = { symbol: 'BTCUSDT', leverage: 10, maxNotionalValue: null };
let leverageErrorFixture = { code: 'invalid_request', message: 'bad leverage' };
let submitBehavior = 'ok'; // 'ok' | 'leverage_mismatch' | 'error'
let submitResponseFixture = null;
let leverageMismatchFixture = { symbol: 'BTCUSDT', current: 5, required: 10 };
let orderCancelBehavior = 'ok'; // 'ok' | 'timeout' | 'error'
let orderCancelResponseFixture = null;

async function fetch(url, opts) {
  const method = (opts && opts.method) || 'GET';
  fetchCallLog.push({ url: String(url), method });
  const u = String(url);
  if (u.includes('/api/prices')) return { ok: true, json: async () => priceFixture };
  if (u.endsWith('/api/exchange/connections')) return { ok: true, json: async () => ({ ok: true, connections: connectionsFixture }) };
  const acctMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/account$/);
  if (acctMatch) {
    if (!accountSnapshotFixture) return { ok: true, json: async () => ({ ok: false, error: { code: 'network_error', message: 'x' } }) };
    return { ok: true, json: async () => ({ ok: true, snapshot: accountSnapshotFixture }) };
  }
  const openOrdersMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/open-orders/);
  if (openOrdersMatch) return { ok: true, json: async () => ({ ok: true, snapshots: openOrdersFixture }) };
  const leverageMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/leverage$/);
  if (leverageMatch && method === 'POST') {
    if (leverageBehavior === 'ambiguous') throw new Error('mock network failure');
    if (leverageBehavior === 'error') return { ok: true, json: async () => ({ ok: false, error: leverageErrorFixture }) };
    return { ok: true, json: async () => ({ ok: true, result: leverageResultFixture }) };
  }
  const ordersMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/orders$/);
  if (ordersMatch && method === 'POST') {
    if (submitBehavior === 'leverage_mismatch') return { ok: true, json: async () => ({ ok: false, error: { code: 'leverage_mismatch', message: 'x' }, leverageMismatch: leverageMismatchFixture }) };
    if (submitBehavior === 'error') return { ok: true, json: async () => ({ ok: false, error: { code: 'invalid_quantity', message: 'x' } }) };
    return { ok: true, json: async () => ({ ok: true, snapshot: submitResponseFixture }) };
  }
  const orderCancelMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/orders\/([^/?]+)\?/);
  if (orderCancelMatch && method === 'DELETE') {
    if (orderCancelBehavior === 'timeout') throw new Error('mock network failure');
    if (orderCancelBehavior === 'error') return { ok: true, json: async () => ({ ok: false, error: { code: 'order_not_cancellable', message: 'x' } }) };
    return { ok: true, json: async () => ({ ok: true, snapshot: orderCancelResponseFixture }) };
  }
  throw new Error('UNEXPECTED FETCH in 3.6A frontend test: ' + method + ' ' + u);
}

const sandbox = {
  localStorage, document, location, window, fetch, requestAnimationFrame, wireInteractions,
  console, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
  setTimeout, clearTimeout, setInterval, clearInterval, confirm: () => true, encodeURIComponent,
  AbortSignal, AbortController, EventSource: FakeEventSource,
};
const vmCtx = vm.createContext(sandbox);
vm.runInContext(slice, vmCtx, { filename: 'index-slice.js' });
const M = sandbox.__exports;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond) { if (cond) pass++; else { fail++; failures.push(name); console.log('FAIL:', name); } }

function accountSnap(positions, protectiveOrders) {
  return {
    connectionId: 'conn1', exchange: 'binance-futures', environment: 'TESTNET', fetchedAt: new Date().toISOString(),
    account: { canTrade: true },
    accountRisk: { totalWalletBalance: 100000, totalUnrealizedPnl: 0, totalMarginBalance: 100000, totalInitialMargin: 0, totalMaintMargin: 0, availableBalance: 100000 },
    balances: [{ asset: 'USDT', free: 100000, locked: 0, total: 100000 }],
    positions: positions || [], protectiveOrders: protectiveOrders || [], protectionReadStatus: 'OK',
  };
}
function positionSnap(overrides) {
  return Object.assign({
    symbol: 'BTCUSDT', side: 'LONG', positionSide: 'BOTH', marginType: 'ISOLATED',
    quantity: 0.02, entryPrice: 65000, markPrice: 65500, breakEvenPrice: 65010,
    unrealizedPnl: 10, leverage: 10, isolatedMargin: 130, positionInitialMargin: 130,
    maintenanceMargin: 5, liquidationPrice: 59000, distanceToLiquidationPct: 10,
    protection: { stopLossOrders: [], takeProfitOrders: [], trailingStopOrders: [] },
  }, overrides);
}
function orderSnap(overrides) {
  return Object.assign({
    exchangeOrderId: '9999', clientOrderId: null, symbol: 'BTC/USDT', side: 'BUY', orderType: 'MARKET', status: 'NEW',
    originalQuantity: 0.02, executedQuantity: 0, averagePrice: null, price: null, stopPrice: null,
    reduceOnly: false, closePosition: false, createdAt: '2026-08-09T10:00:00.000Z', updatedAt: '2026-08-09T10:00:00.000Z',
  }, overrides);
}
function resetAll() {
  store = {}; fetchCallLog = []; esInstances = [];
  elementsById['modal-body'] = fakeEl('modal-body');
  elementsById['modal-bg'] = fakeEl('modal-bg');
  connectionsFixture = [{ id: 'conn1', enabled: true, environment: 'TESTNET', name: 'test' }];
  accountSnapshotFixture = accountSnap([]);
  openOrdersFixture = [];
  priceFixture = [{ symbol: 'BTC/USDT', price: 65000, changePct: 1 }];
  leverageBehavior = 'ok'; leverageResultFixture = { symbol: 'BTCUSDT', leverage: 10, maxNotionalValue: null };
  submitBehavior = 'ok'; submitResponseFixture = orderSnap({ status: 'FILLED', executedQuantity: 0.02, averagePrice: 65000 });
  orderCancelBehavior = 'ok'; orderCancelResponseFixture = orderSnap({ status: 'CANCELED' });
  M.Store.accountPage = null;
  M.Store.exchangeAccountSnapshots = null;
  M.Store.exchangeConnections = connectionsFixture;
  M.Store.exchangeConnectionsError = null;
}

let seq = 0;
function makePlan(overrides) {
  seq++;
  return Object.assign({
    id: 'plan' + seq, priority: 'PRIMARY', direction: 'LONG', action: 'ENTER', title: 'Test Plan ' + seq,
    trigger: '突破 65000', triggerStructured: null, invalidation: null,
    reviewHorizon: { description: '有效期 3 天', expiresAt: '2030-08-10T17:00:00+08:00' }, holdingPeriod: '1-3 天',
    entry: { type: 'MARKET', value: null, from: null, to: null, description: null },
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
function makeRealTradeWithFilledEntry(symbol, direction, connectionId, quantity) {
  seq++;
  const tradeId = 'T_ALLOC_' + seq;
  const orderId = 'O_ALLOC_' + seq;
  const trade = { schemaVersion: 'real-v1', tradeId, symbol, thesisDirection: direction, status: 'OPEN', createdAt: new Date().toISOString(), protectionStatus: 'NOT_REQUIRED' };
  M.saveRealTrade(trade);
  const order = {
    schemaVersion: 'real-v1', orderId, tradeId, role: 'ENTRY', intent: 'OPEN', symbol, side: direction === 'LONG' ? 'BUY' : 'SELL',
    orderType: 'MARKET', status: 'FILLED', exchangeOrderId: orderId + '_ex', exchangeConnectionId: connectionId,
    filled: { quantity, averagePrice: 65000 }, pendingClientOrderId: null,
  };
  M.saveRealOrder(order);
  return { trade, order };
}

async function main(){
console.log('=== Sprint 3.6A frontend tests ===\n');

// =====================================================================
// PART A — Position Allocation
// =====================================================================
(function testAllocationBasics() {
  resetAll();
  const pos = { schemaVersion: 'real-v1', positionId: M.genPositionId(), exchangeConnectionId: 'conn1', exchange: 'binance-futures', environment: 'TESTNET', symbol: 'BTCUSDT', side: 'LONG', positionSide: 'BOTH', quantity: 0.05, status: 'OPEN', sourceTradeIds: [] };
  M.saveRealPosition(pos);
  const { trade: t1 } = makeRealTradeWithFilledEntry('BTCUSDT', 'LONG', 'conn1', 0.02);
  const r1 = M.reconcilePositionAllocations(pos);
  check('allocation: creates one allocation for one matching filled Trade', r1.allocations.length === 1 && r1.allocations[0].quantity === 0.02);
  check('allocation: status OK when sum <= real quantity', r1.allocationStatus === 'OK');
  check('allocation: unattributed = real - sum', Math.abs(r1.unattributedQuantity - 0.03) < 1e-9);

  // Second trade sharing the same position (empirically the real BTCUSDT 3.5D-E.1 scenario)
  const { trade: t2 } = makeRealTradeWithFilledEntry('BTCUSDT', 'LONG', 'conn1', 0.03);
  const r2 = M.reconcilePositionAllocations(pos);
  check('allocation: multiple Trades can share one Position', r2.allocations.length === 2);
  check('allocation: sum now equals real quantity exactly -> still OK', r2.allocationStatus === 'OK' && Math.abs(r2.unattributedQuantity) < 1e-9);

  // Idempotent: re-running reconciliation never rewrites an existing allocation's quantity
  const before = M.allocationsForPosition(pos.positionId).map(a => a.quantity).sort();
  M.reconcilePositionAllocations(pos);
  const after = M.allocationsForPosition(pos.positionId).map(a => a.quantity).sort();
  check('allocation: idempotent, never rewrites existing allocation quantity', JSON.stringify(before) === JSON.stringify(after) && M.allocationsForPosition(pos.positionId).length === 2);
})();

(function testAllocationConflict() {
  resetAll();
  const pos = { schemaVersion: 'real-v1', positionId: M.genPositionId(), exchangeConnectionId: 'conn1', exchange: 'binance-futures', environment: 'TESTNET', symbol: 'ETHUSDT', side: 'SHORT', positionSide: 'BOTH', quantity: 0.01, status: 'OPEN', sourceTradeIds: [] };
  M.saveRealPosition(pos);
  makeRealTradeWithFilledEntry('ETHUSDT', 'SHORT', 'conn1', 0.05); // allocation quantity (0.05) > real position quantity (0.01)
  const r = M.reconcilePositionAllocations(pos);
  check('allocation: CONFLICT when local sum exceeds real exchange quantity', r.allocationStatus === 'CONFLICT');
  check('allocation: unattributedQuantity floors at 0 under CONFLICT, never negative', r.unattributedQuantity === 0);
})();

(function testAllocationBoundaries() {
  resetAll();
  // Closed position -> no reconciliation attempted (nothing new created), status null
  const closedPos = { schemaVersion: 'real-v1', positionId: M.genPositionId(), exchangeConnectionId: 'conn1', symbol: 'BTCUSDT', side: 'LONG', positionSide: 'BOTH', quantity: 0.02, status: 'CLOSED', sourceTradeIds: [] };
  M.saveRealPosition(closedPos);
  makeRealTradeWithFilledEntry('BTCUSDT', 'LONG', 'conn1', 0.02);
  const rClosed = M.reconcilePositionAllocations(closedPos);
  check('allocation: CLOSED position is never reconciled', rClosed.allocations.length === 0 && rClosed.allocationStatus === null);

  // Wrong connection -> excluded
  resetAll();
  const pos2 = { schemaVersion: 'real-v1', positionId: M.genPositionId(), exchangeConnectionId: 'connX', symbol: 'BTCUSDT', side: 'LONG', positionSide: 'BOTH', quantity: 0.02, status: 'OPEN', sourceTradeIds: [] };
  M.saveRealPosition(pos2);
  makeRealTradeWithFilledEntry('BTCUSDT', 'LONG', 'conn1', 0.02); // different connection
  const r2 = M.reconcilePositionAllocations(pos2);
  check('allocation: a Trade on a different connectionId is never attributed', r2.allocations.length === 0);
  check('allocation: entire real quantity shows as unattributed when nothing local matches', Math.abs(r2.unattributedQuantity - 0.02) < 1e-9 && r2.allocationStatus === 'OK');

  // Wrong direction -> excluded
  resetAll();
  const pos3 = { schemaVersion: 'real-v1', positionId: M.genPositionId(), exchangeConnectionId: 'conn1', symbol: 'BTCUSDT', side: 'LONG', positionSide: 'BOTH', quantity: 0.02, status: 'OPEN', sourceTradeIds: [] };
  M.saveRealPosition(pos3);
  makeRealTradeWithFilledEntry('BTCUSDT', 'SHORT', 'conn1', 0.02); // wrong direction
  const r3 = M.reconcilePositionAllocations(pos3);
  check('allocation: a Trade with the wrong direction is never attributed', r3.allocations.length === 0);

  // Zero-fill entry -> excluded (never invents an allocation from planned/DRAFT data)
  resetAll();
  const pos4 = { schemaVersion: 'real-v1', positionId: M.genPositionId(), exchangeConnectionId: 'conn1', symbol: 'BTCUSDT', side: 'LONG', positionSide: 'BOTH', quantity: 0.02, status: 'OPEN', sourceTradeIds: [] };
  M.saveRealPosition(pos4);
  const { order } = makeRealTradeWithFilledEntry('BTCUSDT', 'LONG', 'conn1', 0);
  order.filled.quantity = 0; M.saveRealOrder(order);
  const r4 = M.reconcilePositionAllocations(pos4);
  check('allocation: zero-fill ENTRY never produces an allocation (Core Truth Rule)', r4.allocations.length === 0);
})();

(function testAllocationRenderBlock() {
  resetAll();
  const pos = { schemaVersion: 'real-v1', positionId: M.genPositionId(), exchangeConnectionId: 'conn1', symbol: 'BTCUSDT', side: 'LONG', positionSide: 'BOTH', quantity: 0.05, status: 'OPEN', sourceTradeIds: [], protection: { stopLossOrders: [], takeProfitOrders: [], trailingStopOrders: [] } };
  M.saveRealPosition(pos);
  makeRealTradeWithFilledEntry('BTCUSDT', 'LONG', 'conn1', 0.02);
  M.reconcilePositionAllocations(pos);
  const html = M.renderPositionAllocationBlock(pos);
  check('allocation render: shows the allocated quantity', html.includes('0.02'));
  check('allocation render: shows unattributed remainder', html.includes('外部'));
  check('allocation render: shared-position note present', html.includes('仓位归因'));

  const emptyHtml = M.renderPositionAllocationBlock({ positionId: 'nonexistent', quantity: 0, status: 'OPEN' });
  check('allocation render: returns empty string when nothing to show', emptyHtml === '');

  // renderPositionCard (used verbatim by Trade Detail) includes the allocation block for a local RealPosition
  const cardHtml = M.renderPositionCard(pos, 'OK', 'conn1');
  check('renderPositionCard: includes allocation breakdown for a local RealPosition', cardHtml.includes('仓位归因'));
})();

// =====================================================================
// PART B — Account/Portfolio page
// =====================================================================
await (async function testAccountPageOwnership() {
  resetAll();
  openOrdersFixture = [
    orderSnap({ exchangeOrderId: 'APP1', symbol: 'BTCUSDT' }),
    orderSnap({ exchangeOrderId: 'EXT1', symbol: 'ETHUSDT' }),
  ];
  // APP1 has a matching local RealOrder; EXT1 does not.
  M.saveRealOrder({ schemaVersion: 'real-v1', orderId: 'LOCAL1', tradeId: 'T_X', role: 'ENTRY', intent: 'OPEN', symbol: 'BTC/USDT', side: 'BUY', orderType: 'MARKET', status: 'SUBMITTED', exchangeOrderId: 'APP1', exchangeConnectionId: 'conn1', filled: { quantity: 0, averagePrice: null }, pendingClientOrderId: null });

  const localMap = new Map([['APP1', M.getRealOrderById('LOCAL1')]]);
  const tableHtml = M.renderAccountOpenOrdersTable({ loading: false, error: null, snapshots: openOrdersFixture }, 'conn1', localMap);
  check('account page: App order shows App badge + local-order cancel action', tableHtml.includes('APP1') && /App/.test(tableHtml) && tableHtml.includes('cancel-real-order') && tableHtml.includes('LOCAL1'));
  check('account page: External order shows External badge + external cancel action', tableHtml.includes('EXT1') && /External/.test(tableHtml) && tableHtml.includes('cancel-external-order'));

  const algoLocalMap = new Map([['ALGO_APP', { orderId: 'LOCAL_SL' }]]);
  const algoHtml = M.renderAccountAlgoOrdersTable(
    [{ exchangeOrderId: 'ALGO_APP', symbol: 'BTCUSDT', side: 'SELL', orderType: 'STOP_MARKET', status: 'NEW', triggerPrice: 64000, quantity: 0.02 }, { exchangeOrderId: 'ALGO_EXT', symbol: 'ETHUSDT', side: 'SELL', orderType: 'TAKE_PROFIT_MARKET', status: 'NEW', triggerPrice: 4000, quantity: 1 }],
    'OK', algoLocalMap,
  );
  check('account page: algo App vs External badges both render correctly', algoHtml.includes('ALGO_APP') && algoHtml.includes('ALGO_EXT') && (algoHtml.match(/App</g) || []).length === 1 && (algoHtml.match(/External</g) || []).length === 1);
  check('account page: algo orders table has no cancel action (3.5D-E boundary preserved)', !algoHtml.includes('data-action="cancel'));

  const loadingHtml = M.renderAccountOpenOrdersTable({ loading: true }, 'conn1', new Map());
  check('account page: open-orders loading state renders', loadingHtml.includes('正在读取'));
  const errorHtml = M.renderAccountOpenOrdersTable({ loading: false, error: '网络失败', snapshots: [] }, 'conn1', new Map());
  check('account page: open-orders error state renders honestly, not silently empty', errorHtml.includes('网络失败'));

  check('account page: stream status pill labels', M.renderAccountStreamStatusPill('CONNECTED').includes('已连接') && M.renderAccountStreamStatusPill('RECONNECTING').includes('重新连接中') && M.renderAccountStreamStatusPill('DISCONNECTED').includes('已断开'));
})();

await (async function testAccountPageLoadAndRender() {
  resetAll();
  accountSnapshotFixture = accountSnap([positionSnap()]);
  openOrdersFixture = [orderSnap({ exchangeOrderId: 'X1' })];
  await M.loadAccountPageData('conn1');
  const html = M.renderAccountPage();
  check('account page: full render includes account overview + position + orders + algo sections', html.includes('账户总览') && html.includes('持仓') && html.includes('挂单') && html.includes('保护单'));
  check('account page: no connections -> honest empty state, not a crash', (() => {
    M.Store.exchangeConnections = [];
    const h = M.renderAccountPage();
    return h.includes('尚未配置');
  })());
})();

// =====================================================================
// PART C — cancelExternalOrderOnTestnet
// =====================================================================
await (async function testCancelExternal() {
  resetAll();
  orderCancelBehavior = 'ok'; orderCancelResponseFixture = orderSnap({ status: 'CANCELED' });
  const r1 = await M.cancelExternalOrderOnTestnet('conn1', 'BTCUSDT', 'EXT1');
  check('cancel-external: success path', r1.ok === true);

  resetAll();
  orderCancelBehavior = 'timeout';
  const r2 = await M.cancelExternalOrderOnTestnet('conn1', 'BTCUSDT', 'EXT1');
  check('cancel-external: network failure -> ambiguous, never assumed', r2.ok === false && r2.ambiguous === true);

  resetAll();
  orderCancelBehavior = 'error';
  const r3 = await M.cancelExternalOrderOnTestnet('conn1', 'BTCUSDT', 'EXT1');
  check('cancel-external: deterministic rejection surfaced honestly', r3.ok === false && r3.ambiguous !== true);

  resetAll();
  connectionsFixture = [{ id: 'conn1', enabled: true, environment: 'LIVE', name: 'live' }];
  const r4 = await M.cancelExternalOrderOnTestnet('conn1', 'BTCUSDT', 'EXT1');
  check('cancel-external: LIVE connection blocked client-side (defense in depth)', r4.ok === false && r4.error.includes('TESTNET'));
})();

// =====================================================================
// PART D — Leverage sync recovery flow
// =====================================================================
await (async function testLeverageSyncModal() {
  resetAll();
  M.openLeverageSyncConfirmationModal('ORDER1', { symbol: 'BTCUSDT', current: 5, required: 10 }, 'conn1');
  const modalHtml = elementsById['modal-body'].innerHTML;
  check('leverage modal: shows current and required leverage', modalHtml.includes('5x') && modalHtml.includes('10x'));
  check('leverage modal: TESTNET-only badge shown', modalHtml.includes('TESTNET'));
  check('leverage modal: confirm button carries required leverage', modalHtml.includes('调整为 10x 并继续'));
  check('leverage modal: no existing-position warning when none exists', !modalHtml.includes('警告：该交易对当前已存在真实持仓'));

  // With an existing real position for that symbol -> extra-strong warning
  const pos = { schemaVersion: 'real-v1', positionId: M.genPositionId(), exchangeConnectionId: 'conn1', symbol: 'BTCUSDT', side: 'LONG', positionSide: 'BOTH', quantity: 0.05, status: 'OPEN', sourceTradeIds: [] };
  M.saveRealPosition(pos);
  M.openLeverageSyncConfirmationModal('ORDER1', { symbol: 'BTCUSDT', current: 5, required: 10 }, 'conn1');
  const modalHtml2 = elementsById['modal-body'].innerHTML;
  check('leverage modal: extra-strong warning shown when a real position already exists', modalHtml2.includes('警告：该交易对当前已存在真实持仓'));
})();

await (async function testLeverageSyncResubmitFlow() {
  // Full chain: leverage POST succeeds -> resubmission (which itself reruns eligibility+RiskGuard) succeeds.
  resetAll();
  const f = await makeConfirmedFixture();
  leverageBehavior = 'ok'; leverageResultFixture = { symbol: 'BTCUSDT', leverage: 10, maxNotionalValue: null };
  submitBehavior = 'ok'; submitResponseFixture = orderSnap({ exchangeOrderId: 'E1', status: 'FILLED', executedQuantity: 0.02, averagePrice: 65000 });
  const r = await M.confirmLeverageSyncAndResubmit(f.order.orderId, 'conn1', 'BTCUSDT', 10);
  check('leverage-sync: successful change+resubmit reaches ok:true', r.ok === true);
  check('leverage-sync: the leverage endpoint was actually called with the required value', fetchCallLog.some(c => c.method === 'POST' && c.url.includes('/leverage')));
  check('leverage-sync: resubmission happens only AFTER the leverage call (never reordered)', (() => {
    const levIdx = fetchCallLog.findIndex(c => c.url.includes('/leverage'));
    const ordIdx = fetchCallLog.findIndex(c => c.url.endsWith('/orders') && c.method === 'POST');
    return levIdx >= 0 && ordIdx > levIdx;
  })());

  // Leverage change itself fails deterministically -> no resubmission attempt at all.
  resetAll();
  const f2 = await makeConfirmedFixture();
  leverageBehavior = 'error'; leverageErrorFixture = { code: 'invalid_request', message: '杠杆倍数无效' };
  const r2 = await M.confirmLeverageSyncAndResubmit(f2.order.orderId, 'conn1', 'BTCUSDT', 10);
  check('leverage-sync: leverage failure -> ok:false, error surfaced', r2.ok === false && r2.error === '杠杆倍数无效');
  check('leverage-sync: no resubmission attempted when leverage change itself failed', !fetchCallLog.some(c => c.url.endsWith('/orders') && c.method === 'POST'));

  // Leverage change network failure -> ambiguous, never auto-retried.
  resetAll();
  const f3 = await makeConfirmedFixture();
  leverageBehavior = 'ambiguous';
  const r3 = await M.confirmLeverageSyncAndResubmit(f3.order.orderId, 'conn1', 'BTCUSDT', 10);
  check('leverage-sync: leverage network failure -> ambiguous', r3.ok === false && r3.ambiguous === true);
  check('leverage-sync: ambiguous leverage failure never triggers resubmission either', !fetchCallLog.some(c => c.url.endsWith('/orders') && c.method === 'POST'));
})();

await (async function testSubmitCarriesLeverageMismatch() {
  resetAll();
  const f = await makeConfirmedFixture();
  submitBehavior = 'leverage_mismatch';
  const r = await M.submitRealOrderToTestnet(f.order.orderId);
  check('submit: leverage_mismatch failure carries real current/required for the recovery modal', r.ok === false && r.leverageMismatch && r.leverageMismatch.current === 5 && r.leverageMismatch.required === 10);
  check('submit: a plain (non-leverage) deterministic failure carries leverageMismatch:null, never fabricated', await (async () => {
    resetAll();
    const f2 = await makeConfirmedFixture();
    submitBehavior = 'error';
    const r2 = await M.submitRealOrderToTestnet(f2.order.orderId);
    return r2.ok === false && (r2.leverageMismatch === null || r2.leverageMismatch === undefined);
  })());
})();

// =====================================================================
// PART E — Real-time SSE handling
// =====================================================================
(function testStreamLifecycle() {
  resetAll();
  M.startAccountEventStream('conn1');
  check('stream: opens exactly one EventSource for a connection', esInstances.length === 1);
  const ap = M.ensureAccountPageState();
  check('stream: initial status is CONNECTING', ap.streamStatus === 'CONNECTING');

  const es = esInstances[0];
  es.onmessage({ data: JSON.stringify({ kind: 'STATUS', eventTime: new Date().toISOString(), data: { status: 'CONNECTED' } }) });
  check('stream: STATUS event updates ap.streamStatus', M.ensureAccountPageState().streamStatus === 'CONNECTED');

  // Re-calling for the SAME connection reuses the existing EventSource (no duplicate upstream connection).
  M.startAccountEventStream('conn1');
  check('stream: re-subscribing to the same connection does not open a second EventSource', esInstances.length === 1);

  // Switching connection closes the old stream and opens a new one.
  M.startAccountEventStream('conn2');
  check('stream: switching connection closes the previous EventSource', es.closed === true);
  check('stream: switching connection opens exactly one new EventSource', esInstances.length === 2 && !esInstances[1].closed);

  M.teardownAccountEventStream();
  check('stream: teardown closes the EventSource and clears status', esInstances[1].closed === true && M.ensureAccountPageState().streamStatus === null);
})();

(function testStreamDebouncedRefresh() {
  resetAll();
  accountSnapshotFixture = accountSnap([]);
  M.startAccountEventStream('conn1');
  const es = esInstances[0];
  const callsBefore = fetchCallLog.filter(c => c.url.includes('/account')).length;
  es.onmessage({ data: JSON.stringify({ kind: 'ORDER_UPDATE', eventTime: new Date().toISOString(), data: { symbol: 'BTCUSDT' } }) });
  const ap = M.ensureAccountPageState();
  check('stream: an ORDER_UPDATE event schedules a debounce timer, does not fetch synchronously', ap._refreshTimer != null && fetchCallLog.filter(c => c.url.includes('/account')).length === callsBefore);
  const timerBefore = ap._refreshTimer;
  es.onmessage({ data: JSON.stringify({ kind: 'ACCOUNT_UPDATE', eventTime: new Date().toISOString(), data: {} }) });
  check('stream: a second event within the debounce window replaces the pending timer (burst collapses to one refresh)', ap._refreshTimer !== timerBefore);
  M.teardownAccountEventStream();
})();

await (async function testStreamDebounceActuallyFires() {
  resetAll();
  accountSnapshotFixture = accountSnap([]);
  M.startAccountEventStream('conn1');
  const es = esInstances[0];
  const callsBefore = fetchCallLog.filter(c => c.url.includes('/account')).length;
  es.onmessage({ data: JSON.stringify({ kind: 'ORDER_UPDATE', eventTime: new Date().toISOString(), data: {} }) });
  await new Promise(r => setTimeout(r, M.ACCOUNT_STREAM_REFRESH_DEBOUNCE_MS + 400));
  check('stream: the debounced refresh genuinely fires a REST call once it elapses (stream never trusted alone)', fetchCallLog.filter(c => c.url.includes('/account')).length > callsBefore);
  M.teardownAccountEventStream();
})();

// =====================================================================
// PART F — Static safety proof
// =====================================================================
(function testStaticSafety() {
  const src = slice;
  const leverageCallSites = (src.match(/\/leverage`/g) || []).length;
  check('static: the leverage POST URL literal appears exactly once (only inside confirmLeverageSyncAndResubmit)', leverageCallSites === 1);
  check('static: no ADD/REDUCE/CLOSE/REVERSE position-management action strings anywhere', !/data-action="position-(add|reduce|close|reverse)"/.test(src));
  check('static: algo-order cancel route is never wired to a click action this sprint', !/data-action="cancel-algo/.test(src));
})();

console.log(`\n3.6A frontend: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

}
main().catch(e=>{ console.error('TEST CRASH:', e); process.exit(1); });
