// Sprint 3.5D-A frontend tests — Real Order Lifecycle Foundation (status mapping, sync flow, Trade
// lifecycle propagation, Trade Detail UI). Same vm-slicing technique as prior sprints. global.fetch
// mocked (backend endpoints only) — no real network calls anywhere in this file.
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('c:/Users/surface/Documents/Obsidian Vault/量化/prototype/index.html', 'utf8');
const scriptStart = html.indexOf('<script>') + '<script>'.length;
const marker = '/* ---------- Interactions ---------- */';
const markerIdx = html.indexOf(marker, scriptStart);
let slice = html.slice(scriptStart, markerIdx);

const EXPORT_NAMES = [
  'mapExchangeOrderStatusToLocalOrderStatus', 'syncRealOrderFromExchange', 'propagateEntryOrderStatusToTrade',
  'resolveRiskExchangeConnectionId', 'getRealOrderById', 'saveRealOrder', 'getRealTradeById', 'saveRealTrade',
  'loadRiskSettings', 'saveRiskSettings', 'renderRealTradeDetail', 'REAL_ORDER_STATUS_LABEL', 'REAL_TRADE_STATUS_LABEL',
  'loadRealOrders', 'loadRealTrades',
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

// ---- mock fetch: /api/exchange/connections + /api/exchange/connections/:id/order only ----
let fetchCallLog = [];
let connectionsFixture = [{ id: 'conn1', enabled: true, environment: 'TESTNET', name: 'test' }];
let orderQueryBehavior = 'ok'; // 'ok' | 'error' | 'network-error' | 'connections-error'
let orderSnapshotFixture = null;
let orderErrorFixture = { code: 'unknown_error', message: '未知错误' };
async function fetch(url) {
  fetchCallLog.push(String(url));
  const u = String(url);
  if (u.endsWith('/api/exchange/connections')) {
    if (orderQueryBehavior === 'connections-error') return { ok: true, json: async () => ({ ok: false }) };
    return { ok: true, json: async () => ({ ok: true, connections: connectionsFixture }) };
  }
  if (/\/api\/exchange\/connections\/[^/]+\/order\?/.test(u)) {
    if (orderQueryBehavior === 'network-error') throw new Error('network fail');
    if (orderQueryBehavior === 'error') return { ok: true, json: async () => ({ ok: false, error: orderErrorFixture }) };
    return { ok: true, json: async () => ({ ok: true, snapshot: orderSnapshotFixture }) };
  }
  throw new Error('UNEXPECTED FETCH in 3.5D-A test: ' + u);
}

const sandbox = {
  localStorage, document, location, window, fetch, requestAnimationFrame, wireInteractions,
  console, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
  setTimeout, clearTimeout, setInterval, clearInterval, confirm: () => true, encodeURIComponent,
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
  orderQueryBehavior = 'ok'; orderSnapshotFixture = null; orderErrorFixture = { code: 'unknown_error', message: '未知错误' };
}

let seq = 0;
function makeOrderFixture(overrides) {
  seq++;
  return Object.assign({
    schemaVersion: 'real-v1', orderId: 'OR' + seq, tradeId: 'TR1', executionId: 'EX1', analysisId: 'A1', scenarioPlanId: 'S1',
    symbol: 'BTCUSDT', side: 'BUY', intent: 'OPEN', role: 'ENTRY', orderType: 'LIMIT', quantity: null, limitPrice: 65000, stopPrice: null,
    status: 'DRAFT', filled: { quantity: 0, averagePrice: null }, createdAt: new Date().toISOString(), submittedAt: null, updatedAt: new Date().toISOString(),
    exchangeOrderId: null, sync: { lastSyncedAt: null, lastSyncStatus: null, lastSyncError: null }, exchangeSnapshot: null,
  }, overrides);
}
function makeTradeFixture(overrides) {
  return Object.assign({
    schemaVersion: 'real-v1', tradeId: 'TR1', analysisId: 'A1', executionIds: ['EX1'], scenarioPlanId: 'S1', symbol: 'BTCUSDT',
    thesisDirection: 'LONG', status: 'PLANNED', openedAt: null, closedAt: null, orderIds: ['OR1'], positionId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }, overrides);
}
function orderSnap(overrides) {
  return Object.assign({
    exchangeOrderId: '9999', clientOrderId: null, symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', status: 'NEW',
    originalQuantity: 0.5, executedQuantity: 0, averagePrice: null, price: 65000, stopPrice: null,
    reduceOnly: false, closePosition: false, createdAt: '2026-08-09T10:00:00.000Z', updatedAt: '2026-08-09T10:00:00.000Z',
  }, overrides);
}

// =====================================================================
// PART A — status mapping (pure)
// =====================================================================
(function testStatusMapping() {
  check('NEW -> SUBMITTED', M.mapExchangeOrderStatusToLocalOrderStatus('NEW') === 'SUBMITTED');
  check('PARTIALLY_FILLED -> PARTIALLY_FILLED', M.mapExchangeOrderStatusToLocalOrderStatus('PARTIALLY_FILLED') === 'PARTIALLY_FILLED');
  check('FILLED -> FILLED', M.mapExchangeOrderStatusToLocalOrderStatus('FILLED') === 'FILLED');
  check('CANCELED -> CANCELLED', M.mapExchangeOrderStatusToLocalOrderStatus('CANCELED') === 'CANCELLED');
  check('REJECTED -> REJECTED', M.mapExchangeOrderStatusToLocalOrderStatus('REJECTED') === 'REJECTED');
  check('EXPIRED -> EXPIRED', M.mapExchangeOrderStatusToLocalOrderStatus('EXPIRED') === 'EXPIRED');
  check('unknown status -> null (never guessed)', M.mapExchangeOrderStatusToLocalOrderStatus('SOME_NEW_STATUS') === null);
})();

// =====================================================================
// PART B — sync failure handling (Task 26)
// =====================================================================
async function testSyncFailures() {
  resetAll();
  // 1. missing local Order
  {
    const result = await M.syncRealOrderFromExchange('does-not-exist');
    check('missing local Order: ok=false', result.ok === false);
    check('missing local Order: no fetch attempted', fetchCallLog.length === 0);
  }

  // 2. DRAFT with no exchangeOrderId -> no exchange lookup attempted at all
  resetAll();
  {
    const order = makeOrderFixture({ exchangeOrderId: null });
    M.saveRealOrder(order);
    const result = await M.syncRealOrderFromExchange(order.orderId);
    check('DRAFT no exchangeOrderId: ok=false with readable reason', result.ok === false && /尚未提交/.test(result.error));
    check('DRAFT no exchangeOrderId: zero fetch calls (no exchange lookup attempted)', fetchCallLog.length === 0);
  }

  // 3. missing connection (empty list)
  resetAll();
  connectionsFixture = [];
  {
    const order = makeOrderFixture({ exchangeOrderId: '111' });
    M.saveRealOrder(order);
    const result = await M.syncRealOrderFromExchange(order.orderId);
    check('missing connection: ok=false', result.ok === false);
    const stored = M.getRealOrderById(order.orderId);
    check('missing connection: sync metadata recorded as ERROR', stored.sync.lastSyncStatus === 'ERROR' && !!stored.sync.lastSyncError);
    check('missing connection: order.status left unchanged (still DRAFT)', stored.status === 'DRAFT');
  }

  // 4. disabled connection explicitly selected
  resetAll();
  connectionsFixture = [{ id: 'conn1', enabled: false, environment: 'TESTNET', name: 'test' }];
  M.saveRiskSettings(Object.assign(M.loadRiskSettings(), { exchangeConnectionId: 'conn1' }));
  {
    const order = makeOrderFixture({ exchangeOrderId: '111' });
    M.saveRealOrder(order);
    const result = await M.syncRealOrderFromExchange(order.orderId);
    check('disabled connection: ok=false', result.ok === false);
    check('disabled connection: reason mentions disabled', /禁用/.test(result.error));
  }

  // 5. exchange order not found / backend error
  resetAll();
  orderQueryBehavior = 'error';
  orderErrorFixture = { code: 'order_not_found', message: '交易所未找到该订单' };
  {
    const order = makeOrderFixture({ exchangeOrderId: '999', status: 'SUBMITTED' });
    M.saveRealOrder(order);
    const result = await M.syncRealOrderFromExchange(order.orderId);
    check('order not found: ok=false', result.ok === false);
    const stored = M.getRealOrderById(order.orderId);
    check('order not found: previous status (SUBMITTED) left unchanged', stored.status === 'SUBMITTED');
    check('order not found: sync ERROR recorded', stored.sync.lastSyncStatus === 'ERROR');
  }

  // 6. network timeout/error
  resetAll();
  orderQueryBehavior = 'network-error';
  {
    const order = makeOrderFixture({ exchangeOrderId: '999' });
    M.saveRealOrder(order);
    const result = await M.syncRealOrderFromExchange(order.orderId);
    check('network error: ok=false', result.ok === false);
    const stored = M.getRealOrderById(order.orderId);
    check('network error: order.status left unchanged', stored.status === 'DRAFT');
  }

  // 7. unknown/unresolved remote status -> safe rejection, local lifecycle untouched
  resetAll();
  orderQueryBehavior = 'ok';
  orderSnapshotFixture = orderSnap({ status: 'SOME_FUTURE_STATUS' });
  {
    const order = makeOrderFixture({ exchangeOrderId: '999', status: 'SUBMITTED', filled: { quantity: 0.1, averagePrice: 65000 } });
    M.saveRealOrder(order);
    const result = await M.syncRealOrderFromExchange(order.orderId);
    check('unknown remote status: ok=false', result.ok === false);
    check('unknown remote status: error mentions unsupported_exchange_order_status', /unsupported_exchange_order_status/.test(result.error));
    const stored = M.getRealOrderById(order.orderId);
    check('unknown remote status: local status untouched', stored.status === 'SUBMITTED');
    check('unknown remote status: local filled untouched', stored.filled.quantity === 0.1);
  }

  // 8. success path updates status/filled/exchangeSnapshot/sync
  resetAll();
  orderQueryBehavior = 'ok';
  orderSnapshotFixture = orderSnap({ status: 'PARTIALLY_FILLED', executedQuantity: 0.2, averagePrice: 65010, originalQuantity: 0.5 });
  {
    const order = makeOrderFixture({ exchangeOrderId: '999' });
    M.saveRealOrder(order);
    const result = await M.syncRealOrderFromExchange(order.orderId);
    check('success: ok=true', result.ok === true);
    const stored = M.getRealOrderById(order.orderId);
    check('success: local status mapped to PARTIALLY_FILLED', stored.status === 'PARTIALLY_FILLED');
    check('success: filled.quantity updated', stored.filled.quantity === 0.2);
    check('success: filled.averagePrice updated', stored.filled.averagePrice === 65010);
    check('success: exchangeSnapshot diagnostic mirror set', stored.exchangeSnapshot && stored.exchangeSnapshot.originalQuantity === 0.5);
    check('success: sync metadata SUCCESS', stored.sync.lastSyncStatus === 'SUCCESS' && !!stored.sync.lastSyncedAt && stored.sync.lastSyncError === null);
  }

  console.log('sync-failure tests done');
}

// =====================================================================
// PART C — Trade lifecycle propagation (Task 25)
// =====================================================================
async function testTradeTransitions() {
  // 1. PLANNED + ENTRY SUBMITTED (NEW) -> Trade OPENING
  resetAll();
  orderSnapshotFixture = orderSnap({ status: 'NEW' });
  {
    const order = makeOrderFixture({ exchangeOrderId: '1', tradeId: 'T1' });
    const trade = makeTradeFixture({ tradeId: 'T1', status: 'PLANNED' });
    M.saveRealOrder(order); M.saveRealTrade(trade);
    await M.syncRealOrderFromExchange(order.orderId);
    check('PLANNED + SUBMITTED -> Trade OPENING', M.getRealTradeById('T1').status === 'OPENING');
  }

  // 2. OPENING + PARTIAL -> Trade OPENING (stays), fill quantity preserved
  resetAll();
  orderSnapshotFixture = orderSnap({ status: 'PARTIALLY_FILLED', executedQuantity: 0.3, averagePrice: 65020 });
  {
    const order = makeOrderFixture({ exchangeOrderId: '1', tradeId: 'T2', status: 'SUBMITTED' });
    const trade = makeTradeFixture({ tradeId: 'T2', status: 'OPENING' });
    M.saveRealOrder(order); M.saveRealTrade(trade);
    await M.syncRealOrderFromExchange(order.orderId);
    check('OPENING + PARTIAL -> Trade stays OPENING', M.getRealTradeById('T2').status === 'OPENING');
    check('PARTIAL filledQuantity > 0 preserved', M.getRealOrderById(order.orderId).filled.quantity === 0.3);
  }

  // 3. ENTRY FILLED -> Trade OPEN, openedAt set from exchange updateTime
  resetAll();
  orderSnapshotFixture = orderSnap({ status: 'FILLED', executedQuantity: 0.5, averagePrice: 65005, updatedAt: '2026-08-09T11:22:33.000Z' });
  {
    const order = makeOrderFixture({ exchangeOrderId: '1', tradeId: 'T3', status: 'PARTIALLY_FILLED' });
    const trade = makeTradeFixture({ tradeId: 'T3', status: 'OPENING' });
    M.saveRealOrder(order); M.saveRealTrade(trade);
    await M.syncRealOrderFromExchange(order.orderId);
    const t = M.getRealTradeById('T3');
    check('ENTRY FILLED -> Trade OPEN', t.status === 'OPEN');
    check('openedAt set from real exchange updateTime, not local now()', t.openedAt === '2026-08-09T11:22:33.000Z');
  }

  // 4/5/6. CANCELLED/REJECTED/EXPIRED with zero fill -> Trade CANCELLED
  for (const remoteStatus of ['CANCELED', 'REJECTED', 'EXPIRED']) {
    resetAll();
    orderSnapshotFixture = orderSnap({ status: remoteStatus, executedQuantity: 0, averagePrice: null });
    const order = makeOrderFixture({ exchangeOrderId: '1', tradeId: 'T4', status: 'SUBMITTED', filled: { quantity: 0, averagePrice: null } });
    const trade = makeTradeFixture({ tradeId: 'T4', status: 'OPENING' });
    M.saveRealOrder(order); M.saveRealTrade(trade);
    await M.syncRealOrderFromExchange(order.orderId);
    check(`ENTRY ${remoteStatus} with zero fill -> Trade CANCELLED`, M.getRealTradeById('T4').status === 'CANCELLED');
  }

  // 7. CANCELLED after partial fill does NOT cancel Trade
  resetAll();
  orderSnapshotFixture = orderSnap({ status: 'CANCELED', executedQuantity: 0.15, averagePrice: 65030 });
  {
    const order = makeOrderFixture({ exchangeOrderId: '1', tradeId: 'T5', status: 'PARTIALLY_FILLED', filled: { quantity: 0.15, averagePrice: 65030 } });
    const trade = makeTradeFixture({ tradeId: 'T5', status: 'OPENING' });
    M.saveRealOrder(order); M.saveRealTrade(trade);
    await M.syncRealOrderFromExchange(order.orderId);
    check('CANCELLED after partial fill: Trade NOT cancelled', M.getRealTradeById('T5').status === 'OPENING');
    check('CANCELLED after partial fill: local order status still reflects CANCELLED', M.getRealOrderById(order.orderId).status === 'CANCELLED');
  }

  // 8. repeated sync does not duplicate/regress — sync FILLED twice, openedAt unchanged, status stays OPEN
  resetAll();
  orderSnapshotFixture = orderSnap({ status: 'FILLED', executedQuantity: 0.5, averagePrice: 65005, updatedAt: '2026-08-09T11:22:33.000Z' });
  {
    const order = makeOrderFixture({ exchangeOrderId: '1', tradeId: 'T6', status: 'PARTIALLY_FILLED' });
    const trade = makeTradeFixture({ tradeId: 'T6', status: 'OPENING' });
    M.saveRealOrder(order); M.saveRealTrade(trade);
    await M.syncRealOrderFromExchange(order.orderId);
    const firstOpenedAt = M.getRealTradeById('T6').openedAt;
    // second sync, slightly later "now", same remote FILLED state
    orderSnapshotFixture = orderSnap({ status: 'FILLED', executedQuantity: 0.5, averagePrice: 65005, updatedAt: '2026-08-09T11:22:33.000Z' });
    await M.syncRealOrderFromExchange(order.orderId);
    const t2 = M.getRealTradeById('T6');
    check('repeated sync: Trade stays OPEN (idempotent)', t2.status === 'OPEN');
    check('repeated sync: openedAt not overwritten on second sync', t2.openedAt === firstOpenedAt);
  }

  console.log('trade-transition tests done');
}

// =====================================================================
// PART D — Trade Detail UI (Task 27)
// =====================================================================
function testUi() {
  resetAll();
  // DRAFT, no exchangeOrderId
  {
    const order = makeOrderFixture({ exchangeOrderId: null, status: 'DRAFT' });
    const trade = makeTradeFixture({ status: 'PLANNED', orderIds: [order.orderId], tradeId: 'TU1' });
    order.tradeId = 'TU1';
    M.saveRealOrder(order); M.saveRealTrade(trade);
    const htmlOut = M.renderRealTradeDetail(trade);
    check('DRAFT: shows not-yet-submitted text', /尚未提交至交易所，无法同步订单状态/.test(htmlOut));
    check('DRAFT: no sync action rendered', !/data-action="sync-real-order"/.test(htmlOut));
    // Sprint 3.5D-B, Task 23 intentionally reworded these two fixed strings to be fill-state-aware
    // ("尚未建立仓位（订单尚无真实成交）" / still "暂无真实成交，暂无盈亏" for the true no-fill case)
    // — updated here to match the new, still-honest text rather than the old fixed wording.
    check('no fake Position shown (DRAFT)', /尚未建立仓位（订单尚无真实成交）/.test(htmlOut));
    check('no fake PnL introduced (DRAFT)', /暂无真实成交，暂无盈亏/.test(htmlOut));
  }

  // exchange-linked order, one per status
  const STATUS_LABEL_CHECK = [
    ['SUBMITTED', '已提交'], ['PARTIALLY_FILLED', '部分成交'], ['FILLED', '已成交'],
    ['CANCELLED', '已取消'], ['REJECTED', '被拒绝'], ['EXPIRED', '已过期'],
  ];
  STATUS_LABEL_CHECK.forEach(([status, label], i) => {
    const order = makeOrderFixture({ exchangeOrderId: 'EXO' + i, status, tradeId: 'TU2_' + i, filled: { quantity: status === 'FILLED' ? 0.5 : status === 'PARTIALLY_FILLED' ? 0.2 : 0, averagePrice: null } });
    const trade = makeTradeFixture({ status: 'OPENING', orderIds: [order.orderId], tradeId: 'TU2_' + i });
    M.saveRealOrder(order); M.saveRealTrade(trade);
    const htmlOut = M.renderRealTradeDetail(trade);
    check(`exchange-linked shows sync action (${status})`, new RegExp(`data-action="sync-real-order"[^>]*data-order-id="${order.orderId}"`).test(htmlOut));
    check(`${status} renders local label "${label}"`, htmlOut.includes(label));
    // Sprint 3.5D-B, Task 23 — a real fill can now genuinely happen, so these two lines became
    // fill-state-aware: SUBMITTED/CANCELLED/REJECTED/EXPIRED here all have filled.quantity=0 (per
    // this fixture), so they still get the no-fill wording; FILLED/PARTIALLY_FILLED (real quantity>0
    // in this fixture) must NOT claim "尚无真实成交". Sprint 3.5D-C, disclosed intentional reword:
    // Position Sync now genuinely exists, so the honest wording for "real fill, no linked local
    // Position yet" changed from "本地 Position Sync 尚未实现" to "等待交易所持仓同步" (this fixture
    // never calls syncPositionsFromExchange, so no Position is ever linked here — still proves: no
    // fabricated Position, no fabricated PnL, just truthfully updated wording).
    const hasFill = status === 'FILLED' || status === 'PARTIALLY_FILLED';
    if (!hasFill) {
      check(`no fake Position shown (${status})`, /尚未建立仓位（订单尚无真实成交）/.test(htmlOut));
      check(`no fake PnL introduced (${status})`, /暂无真实成交，暂无盈亏/.test(htmlOut));
    } else {
      check(`truthful real-fill Position text, not fabricated (${status})`, /等待交易所持仓同步/.test(htmlOut));
      check(`truthful real-fill PnL text, no fabricated number (${status})`, /等待持仓同步以显示真实盈亏/.test(htmlOut));
    }
  });

  // partial-fill quantities render when both known
  {
    const order = makeOrderFixture({
      exchangeOrderId: 'EXO_PARTIAL', status: 'PARTIALLY_FILLED', tradeId: 'TU3',
      filled: { quantity: 0.2, averagePrice: 65010 },
      exchangeSnapshot: { status: 'PARTIALLY_FILLED', originalQuantity: 0.5, executedQuantity: 0.2, averagePrice: 65010, price: 65000, updatedAt: '2026-08-09T10:00:00.000Z' },
    });
    const trade = makeTradeFixture({ status: 'OPENING', orderIds: [order.orderId], tradeId: 'TU3' });
    M.saveRealOrder(order); M.saveRealTrade(trade);
    const htmlOut = M.renderRealTradeDetail(trade);
    check('partial-fill: shows 已部分成交 badge', /已部分成交/.test(htmlOut));
    check('partial-fill: shows both executed and original quantity', /0\.200000\s*\/\s*0\.500000/.test(htmlOut));
  }

  // sync error renders safely
  {
    const order = makeOrderFixture({
      exchangeOrderId: 'EXO_ERR', status: 'SUBMITTED', tradeId: 'TU4',
      sync: { lastSyncedAt: new Date().toISOString(), lastSyncStatus: 'ERROR', lastSyncError: '网络请求失败，无法同步订单状态' },
    });
    const trade = makeTradeFixture({ status: 'OPENING', orderIds: [order.orderId], tradeId: 'TU4' });
    M.saveRealOrder(order); M.saveRealTrade(trade);
    const htmlOut = M.renderRealTradeDetail(trade);
    check('sync error renders inline without crashing', /同步失败/.test(htmlOut) && /网络请求失败，无法同步订单状态/.test(htmlOut));
  }

  console.log('ui tests done');
}

(async function main() {
  await testSyncFailures();
  await testTradeTransitions();
  testUi();
  console.log(`\n3.5D-A frontend tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
})();
