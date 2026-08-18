// Sprint 3.5C frontend/Risk Guard tests — Account-Aware Risk Guard + Full Futures Position Detail.
// Same vm-slicing technique as prior sprints. global.fetch mocked (backend endpoints only — this
// suite never talks to Binance). No real network calls anywhere in this file.
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('c:/Users/surface/Documents/Obsidian Vault/量化/prototype/index.html', 'utf8');
const scriptStart = html.indexOf('<script>') + '<script>'.length;
const marker = '/* ---------- Interactions ---------- */';
const markerIdx = html.indexOf(marker, scriptStart);
let slice = html.slice(scriptStart, markerIdx);

const EXPORT_NAMES = [
  'Store', 'evaluateAccountBalance', 'evaluateExchangePositionConflict', 'evaluateExistingPositionProtection',
  'evaluateRiskGuard', 'buildRiskContext', 'buildAccountRiskContext', 'runRiskGuardForOrder',
  'defaultRiskSettings', 'saveRiskSettings', 'loadRiskSettings',
  'confirmExecutionDraft', 'createOrReuseExecutionDraft', 'resolveExecutionView', 'effectiveExecutionPlan',
  'loadRealOrders', 'loadRealTrades', 'getRealTradeByExecutionId', 'getRealOrderById',
  'renderExecutionReal', 'renderRealTradeDetail', 'renderAiConnectionsSettings', 'renderRiskGuardCard',
  'renderExchangeAccountSnapshotBlock', 'loadExchangeAccountSnapshot',
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

// ---- mock fetch: /api/prices, /api/exchange/connections[, /:id/account] ----
let fetchCallLog = [];
let mockPriceRows = [{ symbol: 'BTC/USDT', price: 65000, changePct: 1 }];
let mockExchangeConnections = [];
let mockAccountSnapshots = {}; // connectionId -> snapshot | 'ERROR'
async function fetch(url) {
  fetchCallLog.push(String(url));
  const u = String(url);
  if (u.includes('/api/prices')) return { ok: true, json: async () => mockPriceRows };
  if (u.endsWith('/api/exchange/connections')) return { ok: true, json: async () => ({ ok: true, connections: mockExchangeConnections }) };
  const acctMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/account$/);
  if (acctMatch) {
    const snap = mockAccountSnapshots[acctMatch[1]];
    if (!snap || snap === 'ERROR') return { ok: true, json: async () => ({ ok: false, error: { code: 'network_error', message: '无法读取真实账户状态' } }) };
    return { ok: true, json: async () => ({ ok: true, snapshot: snap }) };
  }
  throw new Error('UNEXPECTED FETCH in 3.5C test: ' + u);
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
function resetStore() { store = {}; fetchCallLog = []; mockPriceRows = [{ symbol: 'BTC/USDT', price: 65000, changePct: 1 }]; mockExchangeConnections = []; mockAccountSnapshots = {}; }

function makeAccountSnapshot(connectionId, overrides) {
  return Object.assign({
    connectionId, exchange: 'binance-futures', environment: 'TESTNET', fetchedAt: new Date().toISOString(),
    account: { canTrade: true },
    accountRisk: { totalWalletBalance: 10000, totalUnrealizedPnl: 0, totalMarginBalance: 10000, totalInitialMargin: 0, totalMaintMargin: 0, availableBalance: 10000 },
    balances: [{ asset: 'USDT', free: 10000, locked: 0, total: 10000 }],
    positions: [],
    protectiveOrders: [],
  }, overrides);
}
function makePosition(overrides) {
  return Object.assign({
    symbol: 'BTC/USDT', side: 'LONG', quantity: 0.5, entryPrice: 65000, markPrice: 65200, notional: 32600,
    unrealizedPnl: 100, leverage: 10, marginType: 'ISOLATED', isolatedMargin: 3250, positionInitialMargin: 3260,
    maintenanceMargin: 163, liquidationPrice: 58000, breakEvenPrice: 65010, positionSide: 'BOTH',
    distanceToLiquidationPct: 11.04,
    protection: { stopLossOrders: [], takeProfitOrders: [], trailingStopOrders: [], otherOrders: [] },
  }, overrides);
}

// =====================================================================
// PART 1 — pure account_balance rule (Task 35)
// =====================================================================
(function testAccountBalanceRule() {
  const ok = { ok: true, availableBalance: 10000 };
  check('sufficient balance -> PASS', M.evaluateAccountBalance(ok, 1000, 2).status === 'PASS'); // required = 500
  check('exactly sufficient -> PASS', M.evaluateAccountBalance({ ok: true, availableBalance: 500 }, 1000, 2).status === 'PASS');
  check('insufficient balance -> BLOCK', M.evaluateAccountBalance({ ok: true, availableBalance: 100 }, 1000, 2).status === 'BLOCKED');
  check('missing availableBalance -> BLOCK', M.evaluateAccountBalance({ ok: true, availableBalance: null }, 1000, 2).status === 'BLOCKED');
  check('missing positionSize -> BLOCK', M.evaluateAccountBalance(ok, null, 2).status === 'BLOCKED');
  check('missing leverage -> BLOCK', M.evaluateAccountBalance(ok, 1000, null).status === 'BLOCKED');
  check('account context not ok -> BLOCK', M.evaluateAccountBalance({ ok: false }, 1000, 2).status === 'BLOCKED');
})();

// =====================================================================
// PART 2 — exchange_position_conflict rule (Task 35)
// =====================================================================
(function testConflictRule() {
  const noPos = { ok: true, positions: [] };
  check('no same-symbol position -> PASS', M.evaluateExchangePositionConflict(noPos, 'BTC/USDT', 'LONG').status === 'PASS');
  const longPos = { ok: true, positions: [makePosition({ symbol: 'BTC/USDT', side: 'LONG' })] };
  check('same-symbol LONG vs proposed LONG -> BLOCK', M.evaluateExchangePositionConflict(longPos, 'BTC/USDT', 'LONG').status === 'BLOCKED');
  check('same-symbol LONG vs proposed SHORT -> BLOCK', M.evaluateExchangePositionConflict(longPos, 'BTC/USDT', 'SHORT').status === 'BLOCKED');
  const shortPos = { ok: true, positions: [makePosition({ symbol: 'BTC/USDT', side: 'SHORT' })] };
  check('same-symbol SHORT vs proposed SHORT -> BLOCK', M.evaluateExchangePositionConflict(shortPos, 'BTC/USDT', 'SHORT').status === 'BLOCKED');
  check('account context not ok -> BLOCK', M.evaluateExchangePositionConflict({ ok: false }, 'BTC/USDT', 'LONG').status === 'BLOCKED');
  check('same-direction message mentions ADD boundary', M.evaluateExchangePositionConflict(longPos, 'BTC/USDT', 'LONG').message.includes('ADD'));
  check('opposite-direction message mentions CLOSE/REVERSE boundary', M.evaluateExchangePositionConflict(longPos, 'BTC/USDT', 'SHORT').message.includes('REVERSE'));
})();

// =====================================================================
// PART 3 — existing_position_protection rule (Task 35)
// =====================================================================
(function testProtectionRule() {
  const noPos = { ok: true, positions: [] };
  check('no same-symbol position -> SKIPPED (not PASS)', M.evaluateExistingPositionProtection(noPos, 'BTC/USDT').status === 'SKIPPED');
  const withStop = { ok: true, positions: [makePosition({ symbol: 'BTC/USDT', protection: { stopLossOrders: [{ exchangeOrderId: '1', symbol: 'BTC/USDT', side: 'SELL', orderType: 'STOP_MARKET', status: 'NEW', triggerPrice: 63000, price: null, quantity: 0.5, closePosition: true, reduceOnly: true, createdAt: null, positionSide: null }], takeProfitOrders: [], trailingStopOrders: [], otherOrders: [] } })] };
  check('existing position + detected stop -> PASS', M.evaluateExistingPositionProtection(withStop, 'BTC/USDT').status === 'PASS');
  const noStop = { ok: true, positions: [makePosition({ symbol: 'BTC/USDT' })] }; // makePosition default has empty protection
  check('existing position + no detected stop -> BLOCK', M.evaluateExistingPositionProtection(noStop, 'BTC/USDT').status === 'BLOCKED');
  const tpOnly = { ok: true, positions: [makePosition({ symbol: 'BTC/USDT', protection: { stopLossOrders: [], takeProfitOrders: [{ exchangeOrderId: '2', symbol: 'BTC/USDT', side: 'SELL', orderType: 'TAKE_PROFIT_MARKET', status: 'NEW', triggerPrice: 68000, price: null, quantity: 0.5, closePosition: true, reduceOnly: true, createdAt: null, positionSide: null }], trailingStopOrders: [], otherOrders: [] } })] };
  check('take-profit present but no stop-loss -> still BLOCK (TP absence alone never blocks, but this tests TP presence does not substitute for SL)', M.evaluateExistingPositionProtection(tpOnly, 'BTC/USDT').status === 'BLOCKED');
  check('account context not ok -> BLOCK', M.evaluateExistingPositionProtection({ ok: false }, 'BTC/USDT').status === 'BLOCKED');
})();

// =====================================================================
// PART 4 — aggregation with account rules; local six rules unchanged (Task 35)
// =====================================================================
(function testAggregation() {
  const localOnlySettings = { maxNotionalPerTrade: null, maxLeverage: null, requireStopLoss: false, maxActiveTrades: null, blockSameSymbolConflict: false, requireFreshMarketData: false, exchangeConnectionId: null };
  const okAccount = { ok: true, availableBalance: 10000, positions: [] };
  const context = {
    effectivePlan: { positionSize: 1000, leverage: 2, stopLoss: { value: 63000 } },
    trade: { tradeId: 'T1', symbol: 'BTC/USDT', thesisDirection: 'LONG' },
    riskSettings: localOnlySettings, activeTrades: [], market: null, accountContext: okAccount,
  };
  const result = M.evaluateRiskGuard(context);
  check('local six rules unaffected: all SKIPPED/PASS when disabled+no account conflict', result.checks.filter(c => ['max_notional', 'max_leverage', 'stop_loss_required', 'max_active_trades', 'same_symbol_conflict', 'market_freshness'].includes(c.ruleId)).every(c => c.status === 'SKIPPED'));
  check('9 total checks present (6 local + 3 account)', result.checks.length === 9);
  check('overall PASS when account checks pass and local rules are all disabled', result.status === 'PASS');

  const conflictAccount = { ok: true, availableBalance: 10000, positions: [makePosition({ symbol: 'BTC/USDT', side: 'SHORT' })] };
  const context2 = Object.assign({}, context, { accountContext: conflictAccount });
  const result2 = M.evaluateRiskGuard(context2);
  const blockedIds = result2.checks.filter(c => c.status === 'BLOCKED').map(c => c.ruleId);
  check('multiple account reasons preserved (conflict + protection both BLOCKED)', blockedIds.includes('exchange_position_conflict') && blockedIds.includes('existing_position_protection'));
  check('overall BLOCKED when account rules block', result2.status === 'BLOCKED');

  const failedAccount = { ok: false, reason: 'x' };
  const context3 = Object.assign({}, context, { accountContext: failedAccount });
  const result3 = M.evaluateRiskGuard(context3);
  check('account fetch failure -> overall BLOCKED', result3.status === 'BLOCKED');
  check('all three account rules BLOCKED on fetch failure', ['account_balance', 'exchange_position_conflict', 'existing_position_protection'].every(id => result3.checks.find(c => c.ruleId === id).status === 'BLOCKED'));
})();

// =====================================================================
// PART 5 — integration through confirmExecutionDraft() + real UI rendering (async)
// =====================================================================
let seq = 0;
function makePlan(overrides) {
  seq++;
  return Object.assign({
    id: 'plan' + seq, priority: 'PRIMARY', direction: 'LONG', action: 'ENTER',
    title: 'Test Plan ' + seq, trigger: '突破 65000', triggerStructured: null, invalidation: null,
    reviewHorizon: { description: '有效期 3 天', expiresAt: null }, holdingPeriod: '1-3 天',
    entry: { type: 'MARKET', value: null, from: null, to: null, description: null },
    stopLoss: { value: 63000, description: null },
    takeProfit: [{ value: 68000, description: null }],
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
    response: { responseVersion: '2.1.0', decision: { direction: plan.direction, action: 'ENTER', confidence: 70 }, scenarioPlans: [plan], sourceAssessments: [], reasoning: { main: [], support: [], against: [] }, risks: [], evidenceReferences: ['ref1'] },
  };
  const payloads = JSON.parse(localStorage.getItem('qa_analysis_payloads') || '{}');
  payloads[analysisId] = payload; localStorage.setItem('qa_analysis_payloads', JSON.stringify(payloads));
  const records = JSON.parse(localStorage.getItem('qa_ai_response_records') || '{}');
  records[analysisId] = record; localStorage.setItem('qa_ai_response_records', JSON.stringify(records));
  const draft = M.createOrReuseExecutionDraft(analysisId, plan.id, 'MANUAL');
  return { analysisId, plan, payload, record, draft };
}
function setOverrides(executionId, fields) {
  const view = M.resolveExecutionView(executionId);
  Object.assign(view.draft.userOverrides, fields);
  const map = JSON.parse(localStorage.getItem('qa_execution_drafts'));
  map[executionId] = view.draft; localStorage.setItem('qa_execution_drafts', JSON.stringify(map));
}

(async function main() {
  // ---- Case: single enabled connection, sufficient balance, no conflict -> PASS, Order stays DRAFT ----
  resetStore();
  mockExchangeConnections = [{ id: 'conn-1', name: 'My Testnet', exchange: 'binance-futures', environment: 'TESTNET', enabled: true }];
  mockAccountSnapshots['conn-1'] = makeAccountSnapshot('conn-1', { positions: [] });
  M.saveRiskSettings(Object.assign(M.defaultRiskSettings(), { requireFreshMarketData: false }));
  {
    const f = makeFixture({ direction: 'LONG', entry: { type: 'MARKET', value: null, from: null, to: null, description: null }, stopLoss: { value: 63000, description: null } });
    setOverrides(f.draft.executionId, { positionSize: 1000, leverage: 2 });
    await M.confirmExecutionDraft(f.draft.executionId);
    const trade = M.getRealTradeByExecutionId(f.draft.executionId);
    const order = Object.values(M.loadRealOrders()).find(o => o.tradeId === trade.tradeId);
    check('Risk PASS with real account, no conflict', order.riskGuard.status === 'PASS');
    check('Risk PASS leaves Order DRAFT', order.status === 'DRAFT');
    check('riskGuard carries exchangeConnectionId trace metadata', order.riskGuard.exchangeConnectionId === 'conn-1');
    check('riskGuard carries accountFetchedAt trace metadata', !!order.riskGuard.accountFetchedAt);

    const execHtml = M.renderExecutionReal(f.draft.executionId);
    check('Execution page shows account_balance rule label', execHtml.includes('账户可用余额'));
    check('Execution page shows account data read time', execHtml.includes('账户数据读取时间'));
  }

  // ---- Case: same-symbol conflicting position -> account-aware BLOCK reasons render ----
  resetStore();
  mockExchangeConnections = [{ id: 'conn-1', name: 'My Testnet', exchange: 'binance-futures', environment: 'TESTNET', enabled: true }];
  mockAccountSnapshots['conn-1'] = makeAccountSnapshot('conn-1', {
    positions: [makePosition({ symbol: 'BTC/USDT', side: 'SHORT', protection: { stopLossOrders: [], takeProfitOrders: [], trailingStopOrders: [], otherOrders: [] } })],
  });
  M.saveRiskSettings(Object.assign(M.defaultRiskSettings(), { requireFreshMarketData: false }));
  {
    const f = makeFixture({ direction: 'LONG', entry: { type: 'MARKET', value: null, from: null, to: null, description: null }, stopLoss: { value: 63000, description: null } });
    setOverrides(f.draft.executionId, { positionSize: 1000, leverage: 2 });
    await M.confirmExecutionDraft(f.draft.executionId);
    const trade = M.getRealTradeByExecutionId(f.draft.executionId);
    const order = Object.values(M.loadRealOrders()).find(o => o.tradeId === trade.tradeId);
    check('BLOCKED due to real exchange position conflict', order.riskGuard.status === 'BLOCKED');
    const execHtml = M.renderExecutionReal(f.draft.executionId);
    check('account-aware BLOCK reasons render on Execution page', execHtml.includes('交易所已有持仓冲突'));
    // proposed LONG vs existing SHORT = opposite direction -> CLOSE/REVERSE wording, not ADD
    check('BLOCK reason text visible (opposite-direction wording)', execHtml.includes('CLOSE / REVERSE'));
  }

  // ---- Case: no exchange connection configured at all -> BLOCK (never silent local-only PASS) ----
  resetStore();
  mockExchangeConnections = [];
  M.saveRiskSettings(Object.assign(M.defaultRiskSettings(), { requireFreshMarketData: false }));
  {
    const f = makeFixture({ direction: 'LONG', entry: { type: 'MARKET', value: null, from: null, to: null, description: null }, stopLoss: { value: 63000, description: null } });
    setOverrides(f.draft.executionId, { positionSize: 1000, leverage: 2 });
    await M.confirmExecutionDraft(f.draft.executionId);
    const trade = M.getRealTradeByExecutionId(f.draft.executionId);
    const order = Object.values(M.loadRealOrders()).find(o => o.tradeId === trade.tradeId);
    check('no exchange connection -> overall BLOCKED, never silent local-only PASS', order.riskGuard.status === 'BLOCKED');
  }

  // =====================================================================
  // PART 6 — Account UI rendering (Task 36)
  // =====================================================================
  resetStore();
  M.Store.exchangeAccountSnapshots = {
    'conn-1': {
      loading: false, error: null,
      snapshot: makeAccountSnapshot('conn-1', {
        positions: [
          makePosition({
            symbol: 'BTCUSDT', side: 'LONG', leverage: 10, marginType: 'ISOLATED', liquidationPrice: 58000, distanceToLiquidationPct: 11.04,
            protection: {
              stopLossOrders: [{ exchangeOrderId: '1', symbol: 'BTCUSDT', side: 'SELL', orderType: 'STOP_MARKET', status: 'NEW', triggerPrice: 63200, price: null, quantity: 0.5, closePosition: true, reduceOnly: true, createdAt: null, positionSide: null }],
              takeProfitOrders: [
                { exchangeOrderId: '2', symbol: 'BTCUSDT', side: 'SELL', orderType: 'TAKE_PROFIT_MARKET', status: 'NEW', triggerPrice: 67000, price: null, quantity: 0.25, closePosition: false, reduceOnly: true, createdAt: null, positionSide: null },
                { exchangeOrderId: '3', symbol: 'BTCUSDT', side: 'SELL', orderType: 'TAKE_PROFIT_MARKET', status: 'NEW', triggerPrice: 69000, price: null, quantity: 0.25, closePosition: false, reduceOnly: true, createdAt: null, positionSide: null },
              ],
              trailingStopOrders: [{ exchangeOrderId: '4', symbol: 'BTCUSDT', side: 'SELL', orderType: 'TRAILING_STOP_MARKET', status: 'NEW', triggerPrice: null, price: null, quantity: 0.5, closePosition: false, reduceOnly: true, createdAt: null, positionSide: null }],
              otherOrders: [],
            },
          }),
          makePosition({ symbol: 'ETHUSDT', side: 'SHORT', leverage: 5, marginType: 'CROSS', liquidationPrice: null, distanceToLiquidationPct: null, markPrice: 3150, entryPrice: 3200, unrealizedPnl: 100, protection: { stopLossOrders: [], takeProfitOrders: [], trailingStopOrders: [], otherOrders: [] } }),
        ],
      }),
    },
  };
  const settingsHtml = M.renderAiConnectionsSettings.length >= 0 ? null : null; // placeholder, real check below uses direct block render
  const blockHtml = M.renderExchangeAccountSnapshotBlock('conn-1');
  check('account summary renders', blockHtml.includes('账户风险摘要') && blockHtml.includes('可用余额'));
  check('leverage renders', blockHtml.includes('10x') && blockHtml.includes('5x'));
  check('margin type renders', blockHtml.includes('ISOLATED') && blockHtml.includes('CROSS'));
  check('liquidation price renders for BTCUSDT', blockHtml.includes('58,000.00') || blockHtml.includes('58000'));
  check('liquidation price shows 不可用 when null (ETHUSDT)', (blockHtml.match(/不可用/g) || []).length >= 1);
  check('real unrealized PnL renders (not legacy mock)', blockHtml.includes('+100.00 USDT') || blockHtml.includes('100.00'));
  check('stop-loss protection renders', blockHtml.includes('止损保护') && blockHtml.includes('STOP_MARKET'));
  check('multiple take profits render (TP1/TP2)', blockHtml.includes('TP1') && blockHtml.includes('TP2'));
  check('trailing stop renders', blockHtml.includes('移动止损') && blockHtml.includes('TRAILING_STOP_MARKET'));
  check('no-stop warning renders for ETHUSDT position with empty protection', blockHtml.includes('当前读取范围内未检测到有效止损保护'));
  check('distanceToLiquidationPct label renders', blockHtml.includes('距离预估强平价'));

  // =====================================================================
  // PART 7 — Security / safety static checks (Task 37)
  // =====================================================================
  // Sprint 3.5D-C, disclosed intentional change: qa_positions is now a real, intentionally-shipped
  // RealPosition mirror persistence key (synced only from real exchange data — see
  // v3_5d_c_position_sync_test.js for full truth-boundary coverage). The original rule this asserted
  // ("Position sync doesn't exist yet") is no longer the product's rule; superseded, not removed
  // silently.
  // Scope the "no AI call" proof to just the Risk Guard section (the whole `slice` legitimately
  // contains /api/ai/ elsewhere — AI Connections, Analysis Runner, etc.) — same scoping technique
  // used in the 3.4B/3.5A Final Reports.
  const riskGuardStart = html.indexOf('Sprint 3.5A: Risk Guard');
  const riskGuardEnd = html.indexOf('Confirmation (Task 7/15/16');
  const riskGuardRegion = html.slice(riskGuardStart, riskGuardEnd);
  check('no AI endpoint referenced in Risk Guard code region', !riskGuardRegion.includes('/api/ai/'));
  check('no AUTO execution mode string introduced in Risk Guard region', !riskGuardRegion.includes("'AUTO'") && !riskGuardRegion.includes('"AUTO"'));
  check('no submit-order UI action introduced', !html.includes('exch-submit-order') && !html.includes('exch-place-order'));
  check('only backend endpoints hit in this whole suite (never Binance directly)', fetchCallLog.every((u) => u.includes('/api/prices') || u.includes('/api/exchange/connections')));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('Failures:', failures); process.exit(1); }
})();
