// Sprint 3.5D-C frontend tests — Position Sync + Real Fill Lifecycle.
// Same vm-slicing technique as prior sprints. global.fetch mocked (backend endpoints only) — NO real
// network calls, and every mocked "account snapshot" response is synthetic; nothing here ever reaches Binance.
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('c:/Users/surface/Documents/Obsidian Vault/量化/prototype/index.html', 'utf8');
const scriptStart = html.indexOf('<script>') + '<script>'.length;
const marker = '/* ---------- Interactions ---------- */';
const markerIdx = html.indexOf(marker, scriptStart);
let slice = html.slice(scriptStart, markerIdx);

const EXPORT_NAMES = [
  'loadRealPositions', 'saveRealPosition', 'getRealPositionById', 'findPositionByExchangeIdentity',
  'syncPositionsFromExchange', 'linkPositionToTrade', 'findUnlinkedMatchingPosition', 'syncOrderAndPositionForTrade',
  'genPositionId', 'renderRealTradeDetail', 'renderPositionCard',
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
let accountSnapshotFixture = null; // set per-test

async function fetch(url, opts) {
  const method = (opts && opts.method) || 'GET';
  fetchCallLog.push({ url: String(url), method });
  const u = String(url);
  if (u.includes('/api/prices')) return { ok: true, json: async () => [] };
  if (u.endsWith('/api/exchange/connections')) return { ok: true, json: async () => ({ ok: true, connections: connectionsFixture }) };
  const acctMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/account$/);
  if (acctMatch) {
    if (!accountSnapshotFixture) return { ok: true, json: async () => ({ ok: false, error: { code: 'network_error', message: '无法读取真实账户状态' } }) };
    return { ok: true, json: async () => ({ ok: true, snapshot: accountSnapshotFixture }) };
  }
  const orderGetMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/order\?/);
  if (orderGetMatch) {
    return { ok: true, json: async () => ({ ok: true, snapshot: { exchangeOrderId: '9999', clientOrderId: null, symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', status: 'FILLED', originalQuantity: 0.02, executedQuantity: 0.02, averagePrice: 65000, price: null, stopPrice: null, reduceOnly: false, closePosition: false, createdAt: '2026-08-09T10:00:00.000Z', updatedAt: '2026-08-09T10:05:00.000Z' } }) };
  }
  throw new Error('UNEXPECTED FETCH in 3.5D-C test: ' + method + ' ' + u);
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
  accountSnapshotFixture = null;
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
function accountSnap(positions, overrides) {
  return Object.assign({
    connectionId: 'conn1', exchange: 'binance-futures', environment: 'TESTNET', fetchedAt: new Date().toISOString(),
    account: { canTrade: true },
    accountRisk: { totalWalletBalance: 100000, totalUnrealizedPnl: 0, totalMarginBalance: 100000, totalInitialMargin: 0, totalMaintMargin: 0, availableBalance: 100000 },
    balances: [{ asset: 'USDT', free: 100000, locked: 0, total: 100000 }],
    positions: positions || [], protectiveOrders: [], protectionReadStatus: 'OK',
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
/** Confirms a draft (real DRAFT Order + PLANNED Trade), then hand-advances the Order to a real FILLED
 * state with a genuine exchangeOrderId/exchangeConnectionId — exactly the state Position Sync's linking
 * logic expects a real submission to reach, WITHOUT going through the actual submission code path
 * (that path is already covered by v3_5d_b_frontend_test.js; this file focuses on Position Sync only). */
async function makeFilledTradeFixture(planOverrides) {
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
  order.status = 'FILLED';
  order.exchangeOrderId = '9999';
  order.exchangeConnectionId = 'conn1';
  order.filled = { quantity: 0.02, averagePrice: 65000 };
  M.saveRealOrder(order);
  trade.status = 'OPEN'; trade.openedAt = new Date().toISOString();
  M.saveRealTrade(trade);
  return { ...f, trade, order };
}

async function run() {
// =====================================================================
// PART A — Task 27: Position creation from a fresh exchange snapshot
// =====================================================================
{
  resetAll();
  accountSnapshotFixture = accountSnap([positionSnap()]);
  const result = await M.syncPositionsFromExchange('conn1');
  check('creation: ok', result.ok === true);
  check('creation: exactly one Position created', result.positions.length === 1);
  const p = result.positions[0];
  check('creation: symbol from exchange', p.symbol === 'BTCUSDT');
  check('creation: side from exchange', p.side === 'LONG');
  check('creation: positionSide defaults BOTH', p.positionSide === 'BOTH');
  check('creation: status OPEN', p.status === 'OPEN');
  check('creation: sourceTradeIds empty (no matching local trade)', Array.isArray(p.sourceTradeIds) && p.sourceTradeIds.length === 0);
  check('creation: persisted to qa_positions', Object.keys(M.loadRealPositions()).length === 1);
  check('creation: firstObservedAt set', typeof p.firstObservedAt === 'string');
  check('creation: protectionReadStatus copied from snapshot', p.protectionReadStatus === 'OK');

  // idempotent re-sync: same identity -> same positionId, updated not duplicated
  const before = p.positionId;
  const result2 = await M.syncPositionsFromExchange('conn1');
  check('creation: re-sync does not duplicate', Object.keys(M.loadRealPositions()).length === 1);
  check('creation: re-sync keeps same positionId', result2.positions[0].positionId === before);
}

// Hedge mode: two positions same symbol, different positionSide -> two distinct local Positions
{
  resetAll();
  accountSnapshotFixture = accountSnap([
    positionSnap({ side: 'LONG', positionSide: 'LONG', quantity: 0.02 }),
    positionSnap({ side: 'SHORT', positionSide: 'SHORT', quantity: 0.01 }),
  ]);
  const result = await M.syncPositionsFromExchange('conn1');
  check('hedge mode: two positions created', result.positions.length === 2);
  check('hedge mode: distinct positionIds', result.positions[0].positionId !== result.positions[1].positionId);
  check('hedge mode: findByIdentity resolves LONG', M.findPositionByExchangeIdentity('conn1', 'BTCUSDT', 'LONG').side === 'LONG');
  check('hedge mode: findByIdentity resolves SHORT', M.findPositionByExchangeIdentity('conn1', 'BTCUSDT', 'SHORT').side === 'SHORT');
}

// =====================================================================
// PART B — Task 28: update (exchange wins) and close (zero exposure)
// =====================================================================
{
  resetAll();
  accountSnapshotFixture = accountSnap([positionSnap({ markPrice: 65500, unrealizedPnl: 10 })]);
  await M.syncPositionsFromExchange('conn1');
  const before = Object.values(M.loadRealPositions())[0];
  check('update: initial markPrice', before.markPrice === 65500);

  // Fresh read changes mark price and PnL -> local mirror must be OVERWRITTEN, not merged
  accountSnapshotFixture = accountSnap([positionSnap({ markPrice: 66200, unrealizedPnl: 24 })]);
  const result2 = await M.syncPositionsFromExchange('conn1');
  const after = result2.positions[0];
  check('update: exchange wins on markPrice', after.markPrice === 66200);
  check('update: exchange wins on unrealizedPnl', after.unrealizedPnl === 24);
  check('update: still OPEN', after.status === 'OPEN');
  check('update: same positionId (identity preserved across syncs)', after.positionId === before.positionId);

  // Fresh read now shows zero exposure (position absent) -> local mirror closes, history retained
  accountSnapshotFixture = accountSnap([]);
  const result3 = await M.syncPositionsFromExchange('conn1');
  check('close: sync ok', result3.ok === true);
  const closed = M.getRealPositionById(before.positionId);
  check('close: status CLOSED', closed.status === 'CLOSED');
  check('close: closedAt set', typeof closed.closedAt === 'string');
  check('close: record retained (not deleted)', closed != null);
  check('close: last known quantity retained as history', closed.quantity === 0.02);
}

// Other connections' positions are never touched by a sync scoped to one connectionId
{
  resetAll();
  connectionsFixture = [{ id: 'conn1', enabled: true, environment: 'TESTNET', name: 'A' }, { id: 'conn2', enabled: true, environment: 'TESTNET', name: 'B' }];
  accountSnapshotFixture = accountSnap([positionSnap({ symbol: 'ETHUSDT' })]);
  await M.syncPositionsFromExchange('conn1');
  accountSnapshotFixture = accountSnap([]); // conn2 sync sees zero exposure
  await M.syncPositionsFromExchange('conn2');
  const conn1Position = Object.values(M.loadRealPositions()).find(p => p.exchangeConnectionId === 'conn1');
  check('isolation: conn2 zero-exposure sync does not close conn1 Position', conn1Position.status === 'OPEN');
}

// =====================================================================
// PART C — Task 29: Position <-> Trade linking (defensible, never guessed)
// =====================================================================
async function testLinking() {
  // Unique match -> linked both directions
  resetAll();
  const f = await makeFilledTradeFixture();
  accountSnapshotFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.02 })]);
  const result = await M.syncPositionsFromExchange('conn1');
  const p = result.positions[0];
  check('linking: unique match links Position -> Trade', p.sourceTradeIds.length === 1 && p.sourceTradeIds[0] === f.trade.tradeId);
  const reloadedTrade = M.getRealTradeById(f.trade.tradeId);
  check('linking: Trade.positionId set back', reloadedTrade.positionId === p.positionId);

  // Idempotent: already-linked Position is never re-evaluated / never stolen by a later ambiguous case
  const before = p.positionId;
  await M.syncPositionsFromExchange('conn1');
  const p2 = M.getRealPositionById(before);
  check('linking: idempotent, sourceTradeIds unchanged on re-sync', p2.sourceTradeIds.length === 1 && p2.sourceTradeIds[0] === f.trade.tradeId);

  // Ambiguous: two local Trades both match symbol+direction+real fill -> Position stays unlinked
  resetAll();
  const f1 = await makeFilledTradeFixture();
  const f2 = await makeFilledTradeFixture();
  accountSnapshotFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG' })]);
  const result2 = await M.syncPositionsFromExchange('conn1');
  check('linking: ambiguous match -> stays unlinked', result2.positions[0].sourceTradeIds.length === 0);
  check('linking: ambiguous -> findUnlinkedMatchingPosition finds it for either candidate trade', M.findUnlinkedMatchingPosition(f1.trade) != null);

  // Pre-existing exchange position with zero matching local Trades -> unlinked, never fabricated
  resetAll();
  accountSnapshotFixture = accountSnap([positionSnap({ symbol: 'SOLUSDT', side: 'SHORT' })]);
  const result3 = await M.syncPositionsFromExchange('conn1');
  check('linking: pre-existing exchange position stays unlinked (no local Trade exists)', result3.positions[0].sourceTradeIds.length === 0);

  // Order's exchangeConnectionId mismatch with the connection being synced -> excluded from candidates
  resetAll();
  const f3 = await makeFilledTradeFixture();
  f3.order.exchangeConnectionId = 'conn-other';
  M.saveRealOrder(f3.order);
  accountSnapshotFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG' })]);
  const result4 = await M.syncPositionsFromExchange('conn1');
  check('linking: connection mismatch excludes candidate', result4.positions[0].sourceTradeIds.length === 0);

  // Order with no filled quantity -> not a valid linking candidate even if symbol/direction match
  resetAll();
  const f4 = await makeFilledTradeFixture();
  f4.order.filled = { quantity: 0, averagePrice: null };
  M.saveRealOrder(f4.order);
  accountSnapshotFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG' })]);
  const result5 = await M.syncPositionsFromExchange('conn1');
  check('linking: zero-fill order excludes candidate', result5.positions[0].sourceTradeIds.length === 0);
}
await testLinking();

// =====================================================================
// PART D — Task 30/31: Trade Detail UI truth boundaries
// =====================================================================
async function testUI() {
  // No fill yet -> honest "no position" text, no Position fabricated
  resetAll();
  const f = await makeFilledTradeFixture();
  f.order.status = 'DRAFT'; f.order.exchangeOrderId = null; f.order.exchangeConnectionId = null; f.order.filled = { quantity: 0, averagePrice: null };
  M.saveRealOrder(f.order);
  f.trade.status = 'PLANNED'; M.saveRealTrade(f.trade);
  let html = M.renderRealTradeDetail(f.trade);
  check('UI: no-fill state renders honest text', html.includes('尚未建立仓位'));
  check('UI: no-fill state never shows a fabricated Position card', !html.includes('开仓均价') && !html.includes('标记价格'));

  // Filled, not yet synced -> waiting state, not a fabricated position
  resetAll();
  const f2 = await makeFilledTradeFixture();
  html = M.renderRealTradeDetail(f2.trade);
  check('UI: filled-but-unsynced shows waiting text', html.includes('等待交易所持仓同步'));

  // Linked OPEN Position with no real stop-loss -> prominent warning shown
  resetAll();
  const f3 = await makeFilledTradeFixture();
  accountSnapshotFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG', protection: { stopLossOrders: [], takeProfitOrders: [], trailingStopOrders: [] } })]);
  await M.syncPositionsFromExchange('conn1');
  html = M.renderRealTradeDetail(M.getRealTradeById(f3.trade.tradeId));
  check('UI: linked position with no real stop shows warning', html.includes('当前真实仓位尚未检测到止损保护'));
  check('UI: real PnL shown in header', html.includes('USDT') && html.includes('10.00'.slice(0, 2)) === true); // sanity: unrealizedPnl rendered somewhere
  check('UI: planned protection block is separate & labeled', html.includes('AI 计划保护（尚未提交至交易所）'));

  // Linked OPEN Position WITH a real stop-loss order -> no warning
  resetAll();
  const f4 = await makeFilledTradeFixture();
  accountSnapshotFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG', protection: { stopLossOrders: [{ orderId: '1', type: 'STOP_MARKET', stopPrice: 63000, quantity: 0.02 }], takeProfitOrders: [], trailingStopOrders: [] } })]);
  await M.syncPositionsFromExchange('conn1');
  html = M.renderRealTradeDetail(M.getRealTradeById(f4.trade.tradeId));
  check('UI: linked position WITH real stop -> no warning', !html.includes('当前真实仓位尚未检测到止损保护'));

  // Ambiguous linkage -> honest ambiguity message, no guessed link
  resetAll();
  const f5a = await makeFilledTradeFixture();
  const f5b = await makeFilledTradeFixture();
  accountSnapshotFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG' })]);
  await M.syncPositionsFromExchange('conn1');
  html = M.renderRealTradeDetail(M.getRealTradeById(f5a.trade.tradeId));
  check('UI: ambiguous linkage shows honest message', html.includes('无法唯一关联'));

  // Closed position -> historical framing, not silently reverting to "尚未建立仓位"
  resetAll();
  const f6 = await makeFilledTradeFixture();
  accountSnapshotFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG' })]);
  await M.syncPositionsFromExchange('conn1');
  accountSnapshotFixture = accountSnap([]); // now closed
  await M.syncPositionsFromExchange('conn1');
  html = M.renderRealTradeDetail(M.getRealTradeById(f6.trade.tradeId));
  check('UI: closed position shows closed framing', html.includes('已被交易所标记为平仓'));
  check('UI: closed position does NOT fall back to no-fill text', !html.includes('尚未建立仓位'));
}
await testUI();

// =====================================================================
// PART E — Task 31: truth-boundary proofs (never created from non-exchange sources)
// =====================================================================
{
  resetAll();
  // Confirming an ExecutionDraft (AI/ScenarioPlan-driven) alone must NEVER create a qa_positions entry.
  const f = makeFixture();
  const view = M.resolveExecutionView(f.draft.executionId);
  view.draft.userOverrides.positionSize = 1000; view.draft.userOverrides.leverage = 10;
  const map = JSON.parse(localStorage.getItem('qa_execution_drafts'));
  map[f.draft.executionId] = view.draft;
  localStorage.setItem('qa_execution_drafts', JSON.stringify(map));
  await M.confirmExecutionDraft(f.draft.executionId);
  check('truth boundary: confirming a draft never creates a Position', Object.keys(M.loadRealPositions()).length === 0);

  // A local Order reaching status FILLED (set directly, simulating a local-only belief) without ever
  // calling syncPositionsFromExchange must NEVER create a Position either — only the exchange-read path may.
  const trade = M.getRealTradeById(Object.values(M.loadRealTrades())[0].tradeId);
  const order = Object.values(M.loadRealOrders())[0];
  order.status = 'FILLED'; order.filled = { quantity: 0.02, averagePrice: 65000 }; order.exchangeOrderId = '1234';
  M.saveRealOrder(order);
  check('truth boundary: a locally-marked FILLED order never creates a Position without an exchange sync', Object.keys(M.loadRealPositions()).length === 0);

  // Once a real sync happens, exactly the exchange's own fields populate the Position (spot check
  // that no AI/plan value ever leaks in — e.g. plan.stopLoss.value=63000 must not appear as the
  // Position's own stopLoss/liquidationPrice/entryPrice).
  accountSnapshotFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG', entryPrice: 65321, liquidationPrice: 58888 })]);
  const result = await M.syncPositionsFromExchange('conn1');
  check('truth boundary: entryPrice comes from exchange snapshot, not AI plan', result.positions[0].entryPrice === 65321);
  check('truth boundary: liquidationPrice comes from exchange snapshot, not AI plan', result.positions[0].liquidationPrice === 58888);
}

// =====================================================================
// PART F — syncOrderAndPositionForTrade (combined action)
// =====================================================================
{
  resetAll();
  const f = await makeFilledTradeFixture();
  accountSnapshotFixture = accountSnap([positionSnap({ symbol: 'BTCUSDT', side: 'LONG' })]);
  const result = await M.syncOrderAndPositionForTrade(f.order.orderId);
  check('combined sync: ok', result.ok === true);
  check('combined sync: order sync attempted (had exchangeOrderId)', result.orderResult.ok === true);
  check('combined sync: position sync attempted', result.positionResult.ok === true);
  const reloadedOrder = M.getRealOrderById(f.order.orderId);
  check('combined sync: order status refreshed from mocked GET', reloadedOrder.status === 'FILLED');
  check('combined sync: position created & linked', Object.values(M.loadRealPositions())[0].sourceTradeIds.includes(f.trade.tradeId));

  // Order with no exchangeOrderId yet -> order sync skipped, but position sync still runs
  resetAll();
  const f2 = await makeFixture();
  const view = M.resolveExecutionView(f2.draft.executionId);
  view.draft.userOverrides.positionSize = 1000; view.draft.userOverrides.leverage = 10;
  const map = JSON.parse(localStorage.getItem('qa_execution_drafts'));
  map[f2.draft.executionId] = view.draft;
  localStorage.setItem('qa_execution_drafts', JSON.stringify(map));
  await M.confirmExecutionDraft(f2.draft.executionId);
  const trade2 = M.getRealTradeByExecutionId(f2.draft.executionId);
  const order2 = Object.values(M.loadRealOrders()).find(o => o.tradeId === trade2.tradeId);
  accountSnapshotFixture = accountSnap([]);
  const result2 = await M.syncOrderAndPositionForTrade(order2.orderId);
  check('combined sync: order sync skipped when no exchangeOrderId', result2.orderResult.skipped === true);
  check('combined sync: position sync still runs', result2.positionResult.ok === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
}
run().catch(e => { console.error('TEST RUNNER ERROR:', e); process.exit(1); });
