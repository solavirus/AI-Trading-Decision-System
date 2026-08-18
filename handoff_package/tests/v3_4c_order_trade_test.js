// Sprint 3.4C functional tests — Order/Trade domain implementation.
// Technique: slice the real shipped script out of prototype/index.html (from <script> start up to
// the '/* ---------- Interactions ---------- */' marker, BEFORE wireInteractions()/the top-level
// click listener/init() IIFE), run it in a Node vm context with a minimal fake DOM/localStorage/
// fetch, then export the functions under test via globalThis.__exports assigned INSIDE the same
// vm.runInContext call (top-level function/const declarations do not attach to the sandbox object
// otherwise). No real network calls, no real AI calls anywhere in this script.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const htmlPath = path.join(__dirname, '..', '..', '..', '..', '..', 'Documents', 'Obsidian Vault', '量化', 'prototype', 'index.html');
const html = fs.readFileSync('c:/Users/surface/Documents/Obsidian Vault/量化/prototype/index.html', 'utf8');
const scriptStart = html.indexOf('<script>') + '<script>'.length;
const marker = '/* ---------- Interactions ---------- */';
const markerIdx = html.indexOf(marker, scriptStart);
if (markerIdx === -1) throw new Error('marker not found');
let slice = html.slice(scriptStart, markerIdx);

const EXPORT_NAMES = [
  'resolveEntryOrderSpec','resolveOrderQuantity','createOrReuseRealTradeAndOrder',
  'confirmExecutionDraft','cancelExecutionDraft','createOrReuseExecutionDraft','resolveExecutionView',
  'effectiveExecutionPlan','loadRealOrders','loadRealTrades','getRealTradeByExecutionId',
  'getRealOrderById','getRealTradeById','REAL_ORDER_STATUS_LABEL','REAL_TRADE_STATUS_LABEL',
  'renderTradeList','renderRealTradeDetail','renderExecutionReal','resolveScenarioPlan',
  'getExecutionDraft','isFiniteNumber','loadExecutionDrafts',
];
slice += `\nObject.assign((globalThis.__exports = globalThis.__exports || {}), {${EXPORT_NAMES.join(',')}});\n`;

// ---- fake localStorage ----
let store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

// ---- fake DOM ----
function fakeEl() {
  return {
    _innerHTML: '',
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) { this._innerHTML = v; },
    classList: { add() {}, remove() {} },
    appendChild() {},
    remove() {},
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    dataset: {},
  };
}
const document = {
  getElementById() { return fakeEl(); },
  createElement() { return { innerHTML: '', content: { firstElementChild: fakeEl() } }; },
  addEventListener() {},
  querySelector() { return null; },
  querySelectorAll() { return []; },
};
const location = { hash: '#/dashboard' };
const window = { addEventListener() {}, scrollTo() {} };
let fetchCallLog = [];
// Sprint 3.5A note: confirmExecutionDraft() now runs Risk Guard as part of confirmation, and its
// default-on market_freshness rule legitimately fetches /api/prices — that call is expected and
// allowed here. Anything OTHER than /api/prices (an AI/exchange endpoint, etc.) still throws, which
// is what this suite actually cares about proving for the Order/Trade creation code path itself.
async function fetch(url) {
  fetchCallLog.push(url);
  if (String(url).includes('/api/prices')) return { ok: true, json: async () => [{ symbol: 'BTC/USDT', price: 65000, changePct: 1 }] };
  throw new Error('fetch to an unexpected endpoint (should never happen in Order/Trade creation): ' + url);
}
function requestAnimationFrame(cb) {}
function wireInteractions() {}

const sandbox = {
  localStorage, document, location, window, fetch, requestAnimationFrame, wireInteractions,
  console, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
  setTimeout, clearTimeout, setInterval, clearInterval,
};
const vmCtx = vm.createContext(sandbox);
vm.runInContext(slice, vmCtx, { filename: 'index-slice.js' });
const M = sandbox.__exports;

// ---- test harness ----
let pass = 0, fail = 0;
const failures = [];
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); console.log('FAIL:', name); }
}
function resetStore() { store = {}; }

// ---- fixture builders ----
let seq = 0;
function makePlan(overrides) {
  seq++;
  return Object.assign({
    id: 'plan' + seq,
    priority: 'PRIMARY',
    direction: 'LONG',
    action: 'ENTER',
    title: 'Test Plan ' + seq,
    trigger: '突破 65000',
    triggerStructured: null,
    invalidation: null,
    reviewHorizon: { description: '有效期 3 天', expiresAt: '2030-08-10T17:00:00+08:00' }, // Sprint 3.5D-B.1: now required for PRIMARY
    holdingPeriod: '1-3 天',
    entry: { type: 'MARKET', value: null, from: null, to: null, description: null },
    stopLoss: { value: 63000, description: null },
    takeProfit: [{ value: 68000, description: null }],
    rationale: '测试理由',
    evidenceReferences: ['ref1'],
  }, overrides);
}
function makeFixture(planOverrides, decisionAction) {
  seq++;
  const analysisId = 'A' + seq;
  const plan = makePlan(planOverrides);
  const payload = { analysisId, symbol: 'BTC/USDT', collectedAt: new Date().toISOString() };
  const record = {
    analysisId, responseVersion: '2.1.0', promptVersion: '1.0.0', payloadVersion: '1.1.0',
    provider: 'test', model: 'test-model', generatedAt: new Date().toISOString(),
    response: {
      responseVersion: '2.1.0',
      decision: { direction: plan.direction, action: decisionAction || 'ENTER', confidence: 70 },
      scenarioPlans: [plan],
      sourceAssessments: [],
      reasoning: { main: [], support: [], against: [] },
      risks: [],
      evidenceReferences: ['ref1'],
    },
  };
  const payloads = JSON.parse(localStorage.getItem('qa_analysis_payloads') || '{}');
  payloads[analysisId] = payload;
  localStorage.setItem('qa_analysis_payloads', JSON.stringify(payloads));
  const records = JSON.parse(localStorage.getItem('qa_ai_response_records') || '{}');
  records[analysisId] = record;
  localStorage.setItem('qa_ai_response_records', JSON.stringify(records));
  const draft = M.createOrReuseExecutionDraft(analysisId, plan.id, 'MANUAL');
  return { analysisId, plan, payload, record, draft };
}
function setOrderResolution(executionId, resolution) {
  const view = M.resolveExecutionView(executionId);
  view.draft.userOverrides.orderResolution = resolution;
  const map = JSON.parse(localStorage.getItem('qa_execution_drafts'));
  map[executionId] = view.draft;
  localStorage.setItem('qa_execution_drafts', JSON.stringify(map));
}

// =====================================================================
// PART 1 — Testing Creation (Task 34)
// =====================================================================
resetStore();
(function testCreationMappings() {
  // LONG MARKET
  {
    const f = makeFixture({ direction: 'LONG', entry: { type: 'MARKET', value: null, from: null, to: null, description: null } });
    M.confirmExecutionDraft(f.draft.executionId);
    const trade = M.getRealTradeByExecutionId(f.draft.executionId);
    const order = trade ? Object.values(M.loadRealOrders()).find(o => o.tradeId === trade.tradeId) : null;
    check('LONG MARKET -> Trade PLANNED', trade && trade.status === 'PLANNED');
    check('LONG MARKET -> BUY OPEN ENTRY MARKET DRAFT Order', order && order.side === 'BUY' && order.intent === 'OPEN' && order.role === 'ENTRY' && order.orderType === 'MARKET' && order.status === 'DRAFT');
  }
  // SHORT MARKET
  {
    const f = makeFixture({ direction: 'SHORT', entry: { type: 'MARKET', value: null, from: null, to: null, description: null } });
    M.confirmExecutionDraft(f.draft.executionId);
    const trade = M.getRealTradeByExecutionId(f.draft.executionId);
    const order = trade ? Object.values(M.loadRealOrders()).find(o => o.tradeId === trade.tradeId) : null;
    check('SHORT MARKET -> SELL OPEN', order && order.side === 'SELL' && order.intent === 'OPEN');
  }
  // LONG LIMIT
  {
    const f = makeFixture({ direction: 'LONG', entry: { type: 'LIMIT', value: 64500, from: null, to: null, description: null } });
    M.confirmExecutionDraft(f.draft.executionId);
    const trade = M.getRealTradeByExecutionId(f.draft.executionId);
    const order = Object.values(M.loadRealOrders()).find(o => o.tradeId === trade.tradeId);
    check('LONG LIMIT -> BUY LIMIT correct price', order.side === 'BUY' && order.orderType === 'LIMIT' && order.limitPrice === 64500);
  }
  // SHORT LIMIT
  {
    const f = makeFixture({ direction: 'SHORT', entry: { type: 'LIMIT', value: 64500, from: null, to: null, description: null } });
    M.confirmExecutionDraft(f.draft.executionId);
    const trade = M.getRealTradeByExecutionId(f.draft.executionId);
    const order = Object.values(M.loadRealOrders()).find(o => o.tradeId === trade.tradeId);
    check('SHORT LIMIT -> SELL LIMIT correct price', order.side === 'SELL' && order.orderType === 'LIMIT' && order.limitPrice === 64500);
  }
  // ZONE unresolved
  {
    const f = makeFixture({ direction: 'LONG', entry: { type: 'ZONE', value: null, from: 64000, to: 64300, description: null } });
    M.confirmExecutionDraft(f.draft.executionId);
    const view = M.resolveExecutionView(f.draft.executionId);
    check('ZONE unresolved -> confirmation blocked, draft stays DRAFT', view.draft.status === 'DRAFT');
    check('ZONE unresolved -> no Trade created', M.getRealTradeByExecutionId(f.draft.executionId) === null);
  }
  // ZONE resolved
  {
    const f = makeFixture({ direction: 'LONG', entry: { type: 'ZONE', value: null, from: 64000, to: 64300, description: null } });
    setOrderResolution(f.draft.executionId, { type: null, price: 64150 });
    M.confirmExecutionDraft(f.draft.executionId);
    const trade = M.getRealTradeByExecutionId(f.draft.executionId);
    const order = trade ? Object.values(M.loadRealOrders()).find(o => o.tradeId === trade.tradeId) : null;
    check('ZONE resolved -> LIMIT Order created with user price', order && order.orderType === 'LIMIT' && order.limitPrice === 64150);
  }
  // CONDITIONAL unresolved
  {
    const f = makeFixture({ direction: 'LONG', entry: { type: 'CONDITIONAL', value: null, from: null, to: null, description: '突破确认后入场' } });
    M.confirmExecutionDraft(f.draft.executionId);
    check('CONDITIONAL unresolved -> no real Order', M.getRealTradeByExecutionId(f.draft.executionId) === null);
    const view = M.resolveExecutionView(f.draft.executionId);
    check('CONDITIONAL unresolved -> draft stays DRAFT', view.draft.status === 'DRAFT');
  }
  // CONDITIONAL -> MARKET
  {
    const f = makeFixture({ direction: 'LONG', entry: { type: 'CONDITIONAL', value: null, from: null, to: null, description: '突破确认后入场' } });
    setOrderResolution(f.draft.executionId, { type: 'MARKET', price: null });
    M.confirmExecutionDraft(f.draft.executionId);
    const trade = M.getRealTradeByExecutionId(f.draft.executionId);
    const order = trade ? Object.values(M.loadRealOrders()).find(o => o.tradeId === trade.tradeId) : null;
    check('CONDITIONAL -> user resolves MARKET -> MARKET Order', order && order.orderType === 'MARKET' && order.limitPrice === null);
  }
  // CONDITIONAL -> LIMIT
  {
    const f = makeFixture({ direction: 'LONG', entry: { type: 'CONDITIONAL', value: null, from: null, to: null, description: '突破确认后入场' } });
    setOrderResolution(f.draft.executionId, { type: 'LIMIT', price: 64500 });
    M.confirmExecutionDraft(f.draft.executionId);
    const trade = M.getRealTradeByExecutionId(f.draft.executionId);
    const order = trade ? Object.values(M.loadRealOrders()).find(o => o.tradeId === trade.tradeId) : null;
    check('CONDITIONAL -> user resolves LIMIT -> LIMIT Order', order && order.orderType === 'LIMIT' && order.limitPrice === 64500);
  }
  // orderType is never 'CONDITIONAL'
  {
    const cases = [
      makePlan({ entry: { type: 'MARKET', value: null, from: null, to: null, description: null } }),
      makePlan({ entry: { type: 'LIMIT', value: 100, from: null, to: null, description: null } }),
    ];
    let allOk = true;
    cases.forEach(p => {
      const spec = M.resolveEntryOrderSpec(p, M.effectiveExecutionPlan(p, {}), {});
      if (spec.ok && spec.orderType === 'CONDITIONAL') allOk = false;
    });
    check('orderType is never CONDITIONAL', allOk);
  }
})();

// =====================================================================
// PART 2 — Truth Boundaries (Task 35)
// =====================================================================
(function testTruthBoundaries() {
  const f = makeFixture({ direction: 'LONG', entry: { type: 'MARKET', value: null, from: null, to: null, description: null } });
  const view0 = M.resolveExecutionView(f.draft.executionId);
  view0.draft.userOverrides.positionSize = 5000; // user provides a nominal USDT amount
  const map = JSON.parse(localStorage.getItem('qa_execution_drafts'));
  map[f.draft.executionId] = view0.draft;
  localStorage.setItem('qa_execution_drafts', JSON.stringify(map));

  M.confirmExecutionDraft(f.draft.executionId);
  const trade = M.getRealTradeByExecutionId(f.draft.executionId);
  const order = Object.values(M.loadRealOrders()).find(o => o.tradeId === trade.tradeId);

  check('Trade starts PLANNED', trade.status === 'PLANNED');
  check('Trade status is never OPEN at creation', trade.status !== 'OPEN' && trade.status !== 'OPENING' && trade.status !== 'running');
  check('Trade.openedAt is null', trade.openedAt === null);
  check('Trade.positionId is null (no Position implemented)', trade.positionId === null);
  check('Order starts DRAFT', order.status === 'DRAFT');
  check('Order.status never SUBMITTED at creation', order.status !== 'SUBMITTED');
  check('Order.filled.quantity === 0', order.filled.quantity === 0);
  check('Order.filled.averagePrice === null', order.filled.averagePrice === null);
  check('Order.exchangeOrderId === null (no fake exchange id)', order.exchangeOrderId === null);
  check('Order.submittedAt === null', order.submittedAt === null);
  check('Order.quantity is null despite positionSize being set (no false-precision conversion)', order.quantity === null);
  check('No qa_positions key ever written', !('qa_positions' in store));
  check('No pnl/exitPrice field on real Trade', trade.pnl === undefined && trade.exitPrice === undefined);
  check('No pnl field on real Order', order.pnl === undefined);
})();

// =====================================================================
// PART 3 — Idempotency (Task 36)
// =====================================================================
(function testIdempotency() {
  const f = makeFixture({ direction: 'LONG', entry: { type: 'MARKET', value: null, from: null, to: null, description: null } });
  M.confirmExecutionDraft(f.draft.executionId);
  const tradesAfterFirst = Object.keys(M.loadRealTrades()).length;
  const ordersAfterFirst = Object.keys(M.loadRealOrders()).length;

  // second confirm (UI-level guard: draft.status is already CONFIRMED)
  M.confirmExecutionDraft(f.draft.executionId);
  check('second confirm() creates no duplicate Trade', Object.keys(M.loadRealTrades()).length === tradesAfterFirst);
  check('second confirm() creates no duplicate Order', Object.keys(M.loadRealOrders()).length === ordersAfterFirst);

  // "reload" simulation: call the creation function itself directly a second time (bypassing the
  // status guard) to verify createOrReuseRealTradeAndOrder() is idempotent on its own merits, not
  // merely because confirmExecutionDraft() happens to short-circuit first.
  const view = M.resolveExecutionView(f.draft.executionId);
  const effective = M.effectiveExecutionPlan(view.plan, view.draft.userOverrides);
  const spec = M.resolveEntryOrderSpec(view.plan, effective, view.draft.userOverrides);
  const { trade: tradeA, order: orderA } = M.createOrReuseRealTradeAndOrder(view, spec);
  const { trade: tradeB, order: orderB } = M.createOrReuseRealTradeAndOrder(view, spec);
  check('createOrReuseRealTradeAndOrder is itself idempotent (same tradeId)', tradeA.tradeId === tradeB.tradeId);
  check('createOrReuseRealTradeAndOrder is itself idempotent (same orderId)', orderA.orderId === orderB.orderId);
  check('reload-style double creation still totals exactly 1 Trade for this draft', Object.values(M.loadRealTrades()).filter(t => t.executionIds.includes(f.draft.executionId)).length === 1);
  check('confirmed Execution links back to same Trade', M.getRealTradeByExecutionId(f.draft.executionId).tradeId === tradeA.tradeId);

  // cancelled execution creates nothing
  const f2 = makeFixture({ direction: 'LONG', entry: { type: 'MARKET', value: null, from: null, to: null, description: null } });
  M.cancelExecutionDraft(f2.draft.executionId);
  check('cancelled ExecutionDraft creates no RealTrade', M.getRealTradeByExecutionId(f2.draft.executionId) === null);
})();

// =====================================================================
// PART 4 — Traceability (Task 37)
// =====================================================================
(function testTraceability() {
  const f = makeFixture({ direction: 'SHORT', entry: { type: 'MARKET', value: null, from: null, to: null, description: null } });
  const recordBefore = JSON.parse(JSON.stringify(M.resolveExecutionView(f.draft.executionId).record));

  M.confirmExecutionDraft(f.draft.executionId);
  const trade = M.getRealTradeByExecutionId(f.draft.executionId);
  const order = Object.values(M.loadRealOrders()).find(o => o.tradeId === trade.tradeId);

  check('Trade.executionIds includes executionId', trade.executionIds.includes(f.draft.executionId));
  check('Trade.orderIds includes order.orderId', trade.orderIds.includes(order.orderId));
  check('Order.tradeId === trade.tradeId', order.tradeId === trade.tradeId);
  check('Order.executionId === executionId', order.executionId === f.draft.executionId);
  check('Order.analysisId === analysisId', order.analysisId === f.analysisId);
  check('Order.scenarioPlanId === scenarioPlanId', order.scenarioPlanId === f.plan.id);

  const resolved = M.resolveScenarioPlan(trade.analysisId, trade.scenarioPlanId);
  check('Trade Detail can resolve AI Scenario via IDs', resolved && resolved.plan.id === f.plan.id);
  const draft2 = M.getExecutionDraft(f.draft.executionId);
  check('Trade Detail can resolve ExecutionDraft via IDs', draft2 && draft2.executionId === f.draft.executionId);

  const recordAfter = M.resolveExecutionView(f.draft.executionId).record;
  check('AIResponseRecord content unchanged after confirmation', JSON.stringify(recordBefore.response) === JSON.stringify(recordAfter.response));
})();

// =====================================================================
// PART 5 — UI (Task 38)
// =====================================================================
(function testUI() {
  const f = makeFixture({ direction: 'LONG', entry: { type: 'MARKET', value: null, from: null, to: null, description: null } });
  M.confirmExecutionDraft(f.draft.executionId);
  const trade = M.getRealTradeByExecutionId(f.draft.executionId);

  const listHtml = M.renderTradeList();
  check('Trade List shows real Trade section', listHtml.includes('真实交易'));
  check('Trade List real row shows no position established', listHtml.includes('尚未建立仓位'));
  check('Trade List real row shows no real fill PnL', listHtml.includes('暂无真实成交'));

  const detailHtml = M.renderRealTradeDetail(trade);
  check('Real Trade Detail opens without throwing and includes tradeId', detailHtml.includes(trade.tradeId));
  check('Real Trade Detail Position section says no position', detailHtml.includes('尚未建立仓位'));
  check('Real Trade Detail PnL section says no real fill', detailHtml.includes('暂无真实成交，暂无盈亏'));
  check('Real Trade Detail shows planned stop/TP labels, not submitted-order framing', detailHtml.includes('计划止损') && detailHtml.includes('计划止盈'));
  check('Real Trade Detail shows Order DRAFT status', detailHtml.includes('草稿'));

  const execHtml = M.renderExecutionReal(f.draft.executionId);
  check('Execution success message mentions order not submitted', execHtml.includes('订单尚未提交至交易所'));
  check('Execution success message links to Trade Detail', execHtml.includes('#/trades/' + trade.tradeId));
  check('Execution success message never claims 开仓成功', !execHtml.includes('开仓成功'));
  check('Execution success message never claims 下单成功', !execHtml.includes('下单成功'));
  check('Execution success message never claims 交易已运行', !execHtml.includes('交易已运行'));
  check('No fake order-submission button label present', !execHtml.includes('提交订单') && !execHtml.includes('发送至交易所') && !execHtml.includes('下单'));

  // ZONE/CONDITIONAL UI fields present before resolution
  const fz = makeFixture({ direction: 'LONG', entry: { type: 'ZONE', value: null, from: 64000, to: 64300, description: null } });
  const zoneHtml = M.renderExecutionReal(fz.draft.executionId);
  check('ZONE entry shows 实际订单 price input', zoneHtml.includes('data-action="exec2-order-price"'));

  // Sprint 3.5D-B.1, Task 3/19/24: entry.type=CONDITIONAL is no longer a valid final execution
  // parameter for ANY plan — Execution now BLOCKS it outright (not-ready) instead of offering an
  // order-type-resolution UI for it. Flipped from "shows order-type select" to "blocked".
  const fc = makeFixture({ direction: 'LONG', entry: { type: 'CONDITIONAL', value: null, from: null, to: null, description: 'x' }, stopLoss: { description: 'below structure', value: null }, takeProfit: [{ description: 'prior high', value: null }] });
  const condHtml = M.renderExecutionReal(fc.draft.executionId);
  check('CONDITIONAL entry: Execution blocks it (not-ready), no order-type select offered', condHtml.includes('该方案不满足执行就绪要求') && !condHtml.includes('data-action="exec2-order-type"'));
})();

// =====================================================================
// PART 6 — No network calls to anything other than /api/prices (Sprint 3.5A's Risk Guard
// market_freshness rule legitimately calls it during confirmation; nothing else should ever be hit
// by the Order/Trade creation code path itself).
// =====================================================================
check('no fetch call in this suite ever hit anything other than /api/prices', fetchCallLog.every(u => String(u).includes('/api/prices')));

// =====================================================================
// PART 7 — static source check: qa_positions never referenced in shipped code
// Sprint 3.5D-C, disclosed intentional change: qa_positions is now a real, intentionally-shipped
// persistence key (the RealPosition mirror, synced only from real exchange data — see
// v3_5d_c_position_sync_test.js for its full truth-boundary test coverage). This suite's own
// PART 5's "No qa_positions key ever written" (line 272) still enforces the part of the original
// rule that remains true: DRAFT-stage Order/Trade creation alone must never write qa_positions.
// =====================================================================
check('READY order status never introduced', !/status:\s*['"]READY['"]/.test(slice));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('Failures:', failures); process.exit(1); }
