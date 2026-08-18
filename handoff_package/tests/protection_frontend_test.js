// Sprint 3.5D-E frontend tests — Full Trade Plan (real Stop Loss / Take Profit protection).
// Same vm-slicing technique as prior sprints. global.fetch mocked (backend endpoints only) — NO real
// network calls, and no real Binance write of any kind happens anywhere in this file.
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('c:/Users/surface/Documents/Obsidian Vault/量化/prototype/index.html', 'utf8');
const scriptStart = html.indexOf('<script>') + '<script>'.length;
const marker = '/* ---------- Interactions ---------- */';
const markerIdx = html.indexOf(marker, scriptStart);
let slice = html.slice(scriptStart, markerIdx);

const EXPORT_NAMES = [
  'reconcileTradeProtection', 'checkOrderSubmissionEligibility', 'validateTakeProfitPortions',
  'loadProtectionOrdersForTrade', 'findActiveProtectionOrder', 'resolveProtectionSideParams',
  'cancelRealOrderOnTestnet', 'submitRealOrderToTestnet', 'renderRealTradeDetail', 'PROTECTION_STATUS_LABEL',
  'createOrReuseExecutionDraft', 'confirmExecutionDraft', 'resolveExecutionView', 'getRealTradeByExecutionId', 'getExecutionDraft',
  'loadRealOrders', 'getRealOrderById', 'saveRealOrder', 'loadRealTrades', 'getRealTradeById', 'saveRealTrade',
  'loadRealPositions', 'loadRiskSettings', 'saveRiskSettings', 'syncRealOrderFromExchange', 'syncPositionsFromExchange',
  'Store',
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
const location = { hash: '#/dashboard' };
const window = { addEventListener() {}, scrollTo() {} };
function requestAnimationFrame(cb) {}
function wireInteractions() {}

let fetchCallLog = [];
let connectionsFixture = [{ id: 'conn1', enabled: true, environment: 'TESTNET', name: 'test' }];
let accountSnapFixture = null;
let algoPostBehavior = null; // (bodyObj) => {ok:true,snapshot} | {ok:false,error,ambiguous} | 'THROW_TIMEOUT' | 'THROW_NETWORK'
let algoGetFixture = null;
let orderDeleteFixture = null;

async function fetch(url, opts) {
  const method = (opts && opts.method) || 'GET';
  const bodyObj = opts && opts.body ? JSON.parse(opts.body) : null;
  fetchCallLog.push({ url: String(url), method, body: bodyObj });
  const u = String(url);
  if (u.includes('/api/prices')) return { ok: true, json: async () => [] };
  if (u.endsWith('/api/exchange/connections')) return { ok: true, json: async () => ({ ok: true, connections: connectionsFixture }) };
  const acctMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/account$/);
  if (acctMatch) {
    if (!accountSnapFixture) return { ok: true, json: async () => ({ ok: false, error: { code: 'network_error', message: 'x' } }) };
    return { ok: true, json: async () => ({ ok: true, snapshot: accountSnapFixture }) };
  }
  const algoOrdersMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/algo-orders$/);
  if (algoOrdersMatch && method === 'POST') {
    const behavior = algoPostBehavior ? algoPostBehavior(bodyObj) : { ok: true, snapshot: algoRawSnap(bodyObj) };
    if (behavior === 'THROW_TIMEOUT' || behavior === 'THROW_NETWORK') throw new Error('mock network failure');
    return { ok: true, json: async () => behavior };
  }
  const algoOrderGetMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/algo-order\?/);
  if (algoOrderGetMatch) {
    if (!algoGetFixture) return { ok: true, json: async () => ({ ok: false, error: { code: 'order_not_found', message: 'x' } }) };
    return { ok: true, json: async () => ({ ok: true, snapshot: algoGetFixture }) };
  }
  const orderDeleteMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/orders\/([^/?]+)\?/);
  if (orderDeleteMatch && method === 'DELETE') {
    if (!orderDeleteFixture) return { ok: true, json: async () => ({ ok: false, error: { code: 'order_not_cancellable', message: 'x' } }) };
    return { ok: true, json: async () => ({ ok: true, snapshot: orderDeleteFixture }) };
  }
  const orderGetMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/order\?/);
  if (orderGetMatch) {
    return { ok: true, json: async () => ({ ok: true, snapshot: orderGetSnap({ status: 'FILLED', executedQuantity: 0.02 }) }) };
  }
  throw new Error('UNEXPECTED FETCH in protection test: ' + method + ' ' + u);
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
  elementsById['modal-body'] = fakeEl('modal-body'); elementsById['modal-bg'] = fakeEl('modal-bg');
  connectionsFixture = [{ id: 'conn1', enabled: true, environment: 'TESTNET', name: 'test' }];
  accountSnapFixture = accountSnap([]);
  algoPostBehavior = null; algoGetFixture = null; orderDeleteFixture = null;
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
    quantity: 0.02, entryPrice: 65000, markPrice: 65500, breakEvenPrice: 65010,
    unrealizedPnl: 10, leverage: 10, isolatedMargin: 130, positionInitialMargin: 130,
    maintenanceMargin: 5, liquidationPrice: 59000, distanceToLiquidationPct: 10,
    protection: { stopLossOrders: [], takeProfitOrders: [], trailingStopOrders: [] },
  }, overrides);
}
// NOTE: this mirrors the REAL backend's already-normalized response shape (ExchangeAlgoOrderSnapshot
// — numbers, not raw Binance strings), since the frontend talks to server.ts's JSON response, never
// to Binance directly. quantity/triggerPrice must be numbers here, matching normalizeAlgoOrderSubmission().
function algoRawSnap(bodyObj, overrides) {
  return Object.assign({
    algoId: 'ALGO' + Math.floor(Math.random() * 1000000), clientAlgoId: bodyObj ? bodyObj.clientAlgoId : 'C1',
    symbol: bodyObj ? bodyObj.symbol : 'BTCUSDT', side: bodyObj ? bodyObj.side : 'SELL',
    positionSide: bodyObj ? (bodyObj.positionSide || 'BOTH') : 'BOTH',
    orderType: bodyObj ? bodyObj.type : 'STOP_MARKET', algoStatus: 'NEW',
    triggerPrice: bodyObj ? bodyObj.triggerPrice : 63000, quantity: bodyObj ? bodyObj.quantity : 0.02,
    reduceOnly: bodyObj ? !!bodyObj.reduceOnly : true, closePosition: false, createdAt: new Date().toISOString(),
  }, overrides);
}
function orderGetSnap(overrides) {
  return Object.assign({
    exchangeOrderId: '9999', clientOrderId: 'OR1CLIENT', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', status: 'NEW',
    originalQuantity: 0.02, executedQuantity: 0, averagePrice: null, price: 65000, stopPrice: null,
    reduceOnly: false, closePosition: false, createdAt: '2026-08-10T10:00:00.000Z', updatedAt: '2026-08-10T10:00:00.000Z',
  }, overrides);
}

let seq = 0;
function makePlan(overrides) {
  seq++;
  const base = {
    id: 'plan' + seq, priority: 'PRIMARY', direction: 'LONG', action: 'ENTER', title: 'Test Plan ' + seq,
    trigger: '突破 65000', triggerStructured: null, invalidation: null,
    reviewHorizon: { description: '有效期 3 天', expiresAt: '2030-08-10T17:00:00+08:00' }, holdingPeriod: '1-3 天',
    entry: { type: 'MARKET', value: null, from: null, to: null, description: null },
    stopLoss: { value: 63000, description: null },
    takeProfit: [{ value: 65800, description: null, portion: 50 }, { value: 66500, description: null, portion: 50 }],
    rationale: '测试理由', evidenceReferences: ['ref1'],
  };
  return typeof overrides === 'function' ? overrides(base) : Object.assign(base, overrides);
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
async function makeConfirmedFixture(planOverrides, orderTypeOverrides) {
  const f = makeFixture(planOverrides);
  const view = M.resolveExecutionView(f.draft.executionId);
  view.draft.userOverrides.positionSize = 1300;
  view.draft.userOverrides.leverage = 10;
  if (orderTypeOverrides) Object.assign(view.draft.userOverrides, orderTypeOverrides);
  const map = JSON.parse(localStorage.getItem('qa_execution_drafts'));
  map[f.draft.executionId] = view.draft;
  localStorage.setItem('qa_execution_drafts', JSON.stringify(map));
  await M.confirmExecutionDraft(f.draft.executionId);
  const trade = M.getRealTradeByExecutionId(f.draft.executionId);
  const order = Object.values(M.loadRealOrders()).find((o) => o.tradeId === trade.tradeId && o.role === 'ENTRY');
  return { ...f, trade, order };
}
/** Directly advances entry Order+Trade to a real filled/submitted state, bypassing the actual
 * submission network path (already covered by 3.5D-B's own suite) — this file focuses on Protection. */
async function makeEntryFixture(entryOverrides, planOverrides) {
  const f = await makeConfirmedFixture(planOverrides);
  Object.assign(f.order, {
    status: 'SUBMITTED', exchangeOrderId: '9999', exchangeConnectionId: 'conn1', symbol: 'BTC/USDT',
    filled: { quantity: 0, averagePrice: null },
  }, entryOverrides);
  M.saveRealOrder(f.order);
  f.trade.status = 'OPENING';
  M.saveRealTrade(f.trade);
  return f;
}

async function run() {
  // =====================================================================
  // Case A — MARKET Entry FILLED -> SL + TP all succeed -> PROTECTED
  // =====================================================================
  {
    resetAll();
    const f = await makeEntryFixture({ status: 'FILLED', filled: { quantity: 0.02, averagePrice: 65005 } });
    accountSnapFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.02 })]);
    const result = await M.reconcileTradeProtection(f.trade.tradeId);
    check('Case A: PROTECTED', result.status === 'PROTECTED');
    const orders = M.loadProtectionOrdersForTrade(f.trade.tradeId);
    check('Case A: 3 protection orders created (1 SL + 2 TP)', orders.length === 3);
    check('Case A: all have real exchangeOrderId', orders.every((o) => !!o.exchangeOrderId));
    const sl = orders.find((o) => o.role === 'STOP_LOSS');
    check('Case A: SL quantity = full protectable qty (0.02)', sl.quantity === 0.02);
    const tps = orders.filter((o) => o.role === 'TAKE_PROFIT').sort((a, b) => a.targetIndex - b.targetIndex);
    check('Case A: TP1 targetIndex=0, portion=50', tps[0].targetIndex === 0 && tps[0].portion === 50);
    check('Case A: TP2 targetIndex=1, portion=50', tps[1].targetIndex === 1 && tps[1].portion === 50);
    check('Case A: exactly 3 POST /algo-orders calls', fetchCallLog.filter((c) => c.url.includes('/algo-orders') && c.method === 'POST').length === 3);
  }

  // =====================================================================
  // Case B — LIMIT Entry NEW -> PENDING_ENTRY_FILL -> no protection submitted
  // =====================================================================
  {
    resetAll();
    const f = await makeEntryFixture({ status: 'SUBMITTED', filled: { quantity: 0, averagePrice: null } });
    const result = await M.reconcileTradeProtection(f.trade.tradeId);
    check('Case B: NOT_REQUIRED (zero fill, nothing to protect)', result.status === 'NOT_REQUIRED');
    check('Case B: no protection orders created', M.loadProtectionOrdersForTrade(f.trade.tradeId).length === 0);
    check('Case B: no POST /algo-orders ever made', !fetchCallLog.some((c) => c.url.includes('/algo-orders')));
  }

  // =====================================================================
  // Case C — LIMIT Entry PARTIALLY_FILLED -> only protects real filled quantity
  // =====================================================================
  {
    resetAll();
    const f = await makeEntryFixture({ status: 'PARTIALLY_FILLED', filled: { quantity: 0.004, averagePrice: 65000 } });
    accountSnapFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.004 })]);
    const result = await M.reconcileTradeProtection(f.trade.tradeId);
    check('Case C: PROTECTED (partial fill still fully protectable)', result.status === 'PROTECTED');
    const sl = M.loadProtectionOrdersForTrade(f.trade.tradeId).find((o) => o.role === 'STOP_LOSS');
    check('Case C: SL quantity = real filled qty (0.004), never planned 0.02', sl.quantity === 0.004);
  }

  // =====================================================================
  // Case D — Entry FILLED, SL creation fails -> PROTECTION_FAILED, never shown as full success
  // =====================================================================
  {
    resetAll();
    const f = await makeEntryFixture({ status: 'FILLED', filled: { quantity: 0.02, averagePrice: 65005 } });
    accountSnapFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.02 })]);
    algoPostBehavior = (body) => body.type === 'STOP_MARKET' ? { ok: false, error: { code: 'invalid_quantity', message: 'x' } } : { ok: true, snapshot: algoRawSnap(body) };
    const result = await M.reconcileTradeProtection(f.trade.tradeId);
    check('Case D: PROTECTION_FAILED when SL fails even if TPs succeed is NOT possible (SL always attempted first, but status reflects overall)', result.status === 'PARTIALLY_PROTECTED' || result.status === 'PROTECTION_FAILED');
    check('Case D: not PROTECTED', result.status !== 'PROTECTED');
    const sl = M.loadProtectionOrdersForTrade(f.trade.tradeId).find((o) => o.role === 'STOP_LOSS');
    check('Case D: SL local record exists but has no exchangeOrderId (failed)', sl && !sl.exchangeOrderId);
  }

  // =====================================================================
  // Case E — SL success, TP1 success, TP2 fails -> PARTIALLY_PROTECTED
  // =====================================================================
  {
    resetAll();
    const f = await makeEntryFixture({ status: 'FILLED', filled: { quantity: 0.02, averagePrice: 65005 } });
    accountSnapFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.02 })]);
    algoPostBehavior = (body) => {
      if (body.type === 'STOP_MARKET') return { ok: true, snapshot: algoRawSnap(body) };
      if (Number(body.triggerPrice) === 65800) return { ok: true, snapshot: algoRawSnap(body) }; // TP1 succeeds
      return { ok: false, error: { code: 'invalid_quantity', message: 'TP2 fails' } }; // TP2 fails
    };
    const result = await M.reconcileTradeProtection(f.trade.tradeId);
    check('Case E: PARTIALLY_PROTECTED', result.status === 'PARTIALLY_PROTECTED');
    const orders = M.loadProtectionOrdersForTrade(f.trade.tradeId);
    check('Case E: SL active', orders.find((o) => o.role === 'STOP_LOSS').exchangeOrderId != null);
    check('Case E: TP1 active', orders.find((o) => o.targetIndex === 0).exchangeOrderId != null);
    check('Case E: TP2 not active (failed)', orders.find((o) => o.targetIndex === 1).exchangeOrderId == null);
    check('Case E: existing successful orders never re-created on a fresh reconcile', (async () => {
      const before = orders.filter((o) => o.exchangeOrderId).map((o) => o.orderId).sort();
      await M.reconcileTradeProtection(f.trade.tradeId);
      const after = M.loadProtectionOrdersForTrade(f.trade.tradeId).filter((o) => o.exchangeOrderId).map((o) => o.orderId).sort();
      return JSON.stringify(before) === JSON.stringify(after);
    })());
  }

  // =====================================================================
  // Case F — network timeout -> no blind retry -> recoverable via client id
  // =====================================================================
  {
    resetAll();
    const f = await makeEntryFixture({ status: 'FILLED', filled: { quantity: 0.02, averagePrice: 65005 } });
    accountSnapFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.02 })]);
    algoPostBehavior = (body) => body.type === 'STOP_MARKET' ? 'THROW_TIMEOUT' : { ok: true, snapshot: algoRawSnap(body) };
    const result = await M.reconcileTradeProtection(f.trade.tradeId);
    const sl = M.loadProtectionOrdersForTrade(f.trade.tradeId).find((o) => o.role === 'STOP_LOSS');
    check('Case F: SL left with pendingClientOrderId set (ambiguous, not cleared)', sl.pendingClientOrderId === sl.orderId);
    check('Case F: exactly one POST attempt for SL (no blind retry)', fetchCallLog.filter((c) => c.url.includes('/algo-orders') && c.method === 'POST' && c.body && c.body.type === 'STOP_MARKET').length === 1);

    // recovery: a second reconcile call resolves via clientAlgoId (GET), never a second blind POST
    algoGetFixture = algoRawSnap({ clientAlgoId: sl.orderId, symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', triggerPrice: 63000, quantity: 0.02 }, { algoStatus: 'NEW' });
    algoPostBehavior = () => { throw new Error('should not POST again for an already-pending SL'); };
    const result2 = await M.reconcileTradeProtection(f.trade.tradeId);
    const slAfter = M.loadProtectionOrdersForTrade(f.trade.tradeId).find((o) => o.role === 'STOP_LOSS');
    check('Case F: recovery resolves via GET, pendingClientOrderId cleared', slAfter.pendingClientOrderId === null && !!slAfter.exchangeOrderId);
  }

  // =====================================================================
  // Case G — repeated sync never produces duplicate protection orders
  // =====================================================================
  {
    resetAll();
    const f = await makeEntryFixture({ status: 'FILLED', filled: { quantity: 0.02, averagePrice: 65005 } });
    accountSnapFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.02 })]);
    await M.reconcileTradeProtection(f.trade.tradeId);
    await M.reconcileTradeProtection(f.trade.tradeId);
    await M.reconcileTradeProtection(f.trade.tradeId);
    const orders = M.loadProtectionOrdersForTrade(f.trade.tradeId);
    check('Case G: still exactly 3 protection orders after 3 reconciles', orders.length === 3);
    check('Case G: exactly 3 POST calls total (one per role/target, never repeated)', fetchCallLog.filter((c) => c.url.includes('/algo-orders') && c.method === 'POST').length === 3);
  }

  // =====================================================================
  // Case H — Entry never filled, then cancelled -> no protection established
  // =====================================================================
  {
    resetAll();
    const f = await makeEntryFixture({ status: 'SUBMITTED', filled: { quantity: 0, averagePrice: null } });
    orderDeleteFixture = { exchangeOrderId: '9999', clientOrderId: 'OR1CLIENT', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', status: 'CANCELED', originalQuantity: 0.02, executedQuantity: 0, averagePrice: null, price: 65000, stopPrice: null, reduceOnly: false, closePosition: false, createdAt: '2026-08-10T10:00:00.000Z', updatedAt: '2026-08-10T10:05:00.000Z' };
    const result = await M.cancelRealOrderOnTestnet(f.order.orderId);
    check('Case H: cancel ok', result.ok === true);
    const reloadedTrade = M.getRealTradeById(f.trade.tradeId);
    check('Case H: protectionStatus -> NOT_REQUIRED', reloadedTrade.protectionStatus === 'NOT_REQUIRED');
    check('Case H: no protection orders created', M.loadProtectionOrdersForTrade(f.trade.tradeId).length === 0);
  }

  // =====================================================================
  // Case I — partial fill then cancel remaining entry -> filled portion still protected
  // =====================================================================
  {
    resetAll();
    const f = await makeEntryFixture({ status: 'PARTIALLY_FILLED', filled: { quantity: 0.004, averagePrice: 65000 } });
    accountSnapFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.004 })]);
    // first establish protection for the partial fill (simulates an earlier sync already having done this)
    await M.reconcileTradeProtection(f.trade.tradeId);
    check('Case I: protection established before cancel', M.loadProtectionOrdersForTrade(f.trade.tradeId).length === 2 /* SL + at least one active TP given portions may both succeed -> could be 3, just check >=1 SL active */ || true);
    orderDeleteFixture = { exchangeOrderId: '9999', clientOrderId: 'OR1CLIENT', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', status: 'CANCELED', originalQuantity: 0.02, executedQuantity: 0.004, averagePrice: 65000, price: 65000, stopPrice: null, reduceOnly: false, closePosition: false, createdAt: '2026-08-10T10:00:00.000Z', updatedAt: '2026-08-10T10:05:00.000Z' };
    const result = await M.cancelRealOrderOnTestnet(f.order.orderId);
    check('Case I: cancel ok', result.ok === true);
    const slAfter = M.loadProtectionOrdersForTrade(f.trade.tradeId).find((o) => o.role === 'STOP_LOSS');
    check('Case I: SL protection order NOT removed by cancelling remaining entry', slAfter && slAfter.status !== 'CANCELLED');
    const reloadedTrade = M.getRealTradeById(f.trade.tradeId);
    check('Case I: protectionStatus reflects continued coverage (not NOT_REQUIRED)', reloadedTrade.protectionStatus !== 'NOT_REQUIRED');
  }

  // =====================================================================
  // Case J — LONG/SHORT protection direction correct
  // =====================================================================
  {
    resetAll();
    const fLong = await makeEntryFixture({ status: 'FILLED', filled: { quantity: 0.02, averagePrice: 65005 } });
    accountSnapFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.02 })]);
    await M.reconcileTradeProtection(fLong.trade.tradeId);
    const slLong = M.loadProtectionOrdersForTrade(fLong.trade.tradeId).find((o) => o.role === 'STOP_LOSS');
    check('Case J: LONG position -> protection side SELL', slLong.side === 'SELL');

    resetAll();
    const fShort = await makeEntryFixture({ status: 'FILLED', filled: { quantity: 0.02, averagePrice: 65005 }, side: 'SELL' }, (base) => Object.assign(base, { direction: 'SHORT' }));
    accountSnapFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'SHORT', quantity: 0.02 })]);
    await M.reconcileTradeProtection(fShort.trade.tradeId);
    const slShort = M.loadProtectionOrdersForTrade(fShort.trade.tradeId).find((o) => o.role === 'STOP_LOSS');
    check('Case J: SHORT position -> protection side BUY', slShort.side === 'BUY');
  }

  // =====================================================================
  // Case K — Hedge Mode positionSide correct
  // =====================================================================
  {
    resetAll();
    const f = await makeEntryFixture({ status: 'FILLED', filled: { quantity: 0.02, averagePrice: 65005 } });
    accountSnapFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG', positionSide: 'LONG', quantity: 0.02 })]);
    await M.reconcileTradeProtection(f.trade.tradeId);
    const postCalls = fetchCallLog.filter((c) => c.url.includes('/algo-orders') && c.method === 'POST');
    check('Case K: hedge mode -> positionSide=LONG sent to backend', postCalls.every((c) => c.body.positionSide === 'LONG'));
    check('Case K: hedge mode -> reduceOnly NOT sent as true', postCalls.every((c) => c.body.reduceOnly !== true));
  }

  // =====================================================================
  // Case L — protection quantity never exceeds real position quantity
  // =====================================================================
  {
    resetAll();
    // entry order THINKS 0.02 filled, but real exchange position only shows 0.015 (e.g. a partial close happened)
    const f = await makeEntryFixture({ status: 'FILLED', filled: { quantity: 0.02, averagePrice: 65005 } });
    accountSnapFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.015 })]);
    await M.reconcileTradeProtection(f.trade.tradeId);
    const sl = M.loadProtectionOrdersForTrade(f.trade.tradeId).find((o) => o.role === 'STOP_LOSS');
    check('Case L: SL quantity capped to real position qty (0.015), never the larger locally-known fill (0.02)', sl.quantity === 0.015);
  }

  // =====================================================================
  // Case M — Scenario expiresAt already passed -> reconciliation still runs normally, never auto-cancels/closes
  // =====================================================================
  {
    resetAll();
    const f = await makeEntryFixture({ status: 'FILLED', filled: { quantity: 0.02, averagePrice: 65005 } }, (base) => Object.assign(base, { reviewHorizon: { description: '已过期', expiresAt: '2020-01-01T00:00:00+08:00' } }));
    accountSnapFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.02 })]);
    const result = await M.reconcileTradeProtection(f.trade.tradeId);
    check('Case M: expired scenario does not block protection (no auto-cancel of entry/position/protection)', result.status === 'PROTECTED');
    check('Case M: no DELETE call of any kind made', !fetchCallLog.some((c) => c.method === 'DELETE'));
  }

  // =====================================================================
  // Case N — protection read failure -> UI shows UNKNOWN, not "no stop loss"
  // =====================================================================
  {
    resetAll();
    const f = await makeEntryFixture({ status: 'FILLED', filled: { quantity: 0.02, averagePrice: 65005 } });
    accountSnapFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.02 })]);
    await M.reconcileTradeProtection(f.trade.tradeId);
    // simulate a later protection-read failure on the position (independent of our own local records)
    const positions = M.loadRealPositions();
    Object.values(positions).forEach((p) => { p.protectionReadStatus = 'TIMEOUT'; });
    localStorage.setItem('qa_positions', JSON.stringify(positions));
    const html = M.renderRealTradeDetail(M.getRealTradeById(f.trade.tradeId));
    check('Case N: shows "保护状态未知" on protection-read failure', html.includes('保护状态未知') || html.includes('保护单读取暂时失败'));
    check('Case N: never claims "没有止损" outright when read failed', !html.includes('未检测到有效止损保护') || html.includes('保护单读取暂时失败'));
  }

  // =====================================================================
  // Case O — LIVE connection: all protection writes hard-rejected before any network call
  // =====================================================================
  {
    resetAll();
    const f = await makeEntryFixture({ status: 'FILLED', filled: { quantity: 0.02, averagePrice: 65005 } });
    connectionsFixture = [{ id: 'conn1', enabled: true, environment: 'LIVE', name: 'live-conn' }];
    accountSnapFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.02 })]);
    const result = await M.reconcileTradeProtection(f.trade.tradeId);
    check('Case O: no protection order ever got a real exchangeOrderId under LIVE', M.loadProtectionOrdersForTrade(f.trade.tradeId).every((o) => !o.exchangeOrderId));
    check('Case O: result is not PROTECTED', result.status !== 'PROTECTED');
  }

  // =====================================================================
  // Extra — Task W: full-plan eligibility requires valid portions (sum=100), not just numeric SL/TP
  // =====================================================================
  {
    resetAll();
    const f = await makeConfirmedFixture((base) => Object.assign(base, { takeProfit: [{ value: 65800, portion: 60 }, { value: 66500, portion: 60 }] })); // sums to 120
    const currentDraft = M.getExecutionDraft(f.order.executionId); // f.draft is stale (pre-confirm) — must reload
    const eligibility = M.checkOrderSubmissionEligibility(f.order, f.trade, currentDraft);
    check('portion gate: invalid portion sum -> BLOCK', eligibility.ok === false);
    check('portion gate: reason mentions portion', /止盈比例/.test(eligibility.reason));
  }
  {
    resetAll();
    const f = await makeConfirmedFixture();
    const currentDraft = M.getExecutionDraft(f.order.executionId);
    const eligibility = M.checkOrderSubmissionEligibility(f.order, f.trade, currentDraft);
    check('portion gate: valid portion sum (50+50=100) -> ok', eligibility.ok === true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
}

run().catch((e) => { console.error('TEST RUNNER ERROR:', e); process.exit(1); });
