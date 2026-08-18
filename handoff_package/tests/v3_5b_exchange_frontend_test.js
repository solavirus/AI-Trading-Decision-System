// Sprint 3.5B frontend tests — Exchange Connections Settings UI + Account snapshot rendering.
// Same vm-slicing technique as 3.4B/3.4C/3.5A: slice the real shipped script out of
// prototype/index.html up to '/* ---------- Interactions ---------- */', run in a Node vm context
// with a minimal fake DOM/localStorage/fetch (mocking the exchange backend endpoints only), export
// functions under test via globalThis.__exports assigned INSIDE the same vm.runInContext call.
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('c:/Users/surface/Documents/Obsidian Vault/量化/prototype/index.html', 'utf8');
const scriptStart = html.indexOf('<script>') + '<script>'.length;
const marker = '/* ---------- Interactions ---------- */';
const markerIdx = html.indexOf(marker, scriptStart);
if (markerIdx === -1) throw new Error('marker not found');
let slice = html.slice(scriptStart, markerIdx);

const EXPORT_NAMES = [
  'Store', 'renderAiConnectionsSettings', 'renderExchangeConnectionsSection',
  'renderExchangeConnectionRow', 'renderExchangeConnectionForm', 'renderExchangeAccountSnapshotBlock',
  'exchangeConnFormOpenNew', 'exchangeConnFormSave', 'exchangeConnFormCancel', 'exchangeConnTestAction',
  'loadExchangeAccountSnapshot', 'loadExchangeConnectionsFromBackend', 'exchangeConnectionById',
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
const location = { hash: '#/settings/ai-connections' };
const window = { addEventListener() {}, scrollTo() {} };
function requestAnimationFrame(cb) {}
function wireInteractions() {}

// ---- fake exchange backend (in-memory), driving the mocked fetch ----
let fakeConnections = {};
let fakeAccountByConnId = {};
let idSeq = 0;
let fetchCallLog = [];
function maskKey(k) { return k ? '*'.repeat(12) + k.slice(-4) : null; }
async function fetch(url, init) {
  fetchCallLog.push(String(url));
  const u = String(url);
  const method = (init && init.method) || 'GET';
  if (u.endsWith('/api/exchange/connections') && method === 'GET') {
    return { ok: true, json: async () => ({ ok: true, connections: Object.values(fakeConnections) }) };
  }
  if (u.endsWith('/api/exchange/connections') && method === 'POST') {
    const body = JSON.parse(init.body);
    idSeq++;
    const id = 'conn-' + idSeq;
    const rec = { id, name: body.name, exchange: body.exchange, environment: body.environment, enabled: body.enabled, hasApiKey: !!body.apiKey, hasApiSecret: !!body.apiSecret, apiKeyMasked: maskKey(body.apiKey), lastTestAt: null, lastTestStatus: null, lastTestError: null };
    fakeConnections[id] = rec;
    return { ok: true, json: async () => ({ ok: true, connection: rec }) };
  }
  const testMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/test$/);
  if (testMatch && method === 'POST') {
    const id = testMatch[1];
    if (fakeConnections[id]) { fakeConnections[id].lastTestStatus = 'success'; fakeConnections[id].lastTestAt = new Date().toISOString(); }
    return { ok: true, json: async () => ({ ok: true, result: { ok: true, latencyMs: 42 } }) };
  }
  const acctMatch = u.match(/\/api\/exchange\/connections\/([^/]+)\/account$/);
  if (acctMatch && method === 'GET') {
    const id = acctMatch[1];
    const snap = fakeAccountByConnId[id];
    if (!snap) return { ok: true, json: async () => ({ ok: false, error: { code: 'connection_not_found', message: '连接不存在' } }) };
    return { ok: true, json: async () => ({ ok: true, snapshot: snap }) };
  }
  const putMatch = u.match(/\/api\/exchange\/connections\/([^/]+)$/);
  if (putMatch && method === 'PUT') {
    const id = putMatch[1];
    const body = JSON.parse(init.body);
    Object.assign(fakeConnections[id], { name: body.name, environment: body.environment, enabled: body.enabled });
    return { ok: true, json: async () => ({ ok: true, connection: fakeConnections[id] }) };
  }
  throw new Error('UNEXPECTED FETCH in Exchange Settings UI test: ' + u);
}

const sandbox = {
  localStorage, document, location, window, fetch, requestAnimationFrame, wireInteractions,
  console, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
  setTimeout, clearTimeout, setInterval, clearInterval, confirm: () => true,
  AbortSignal, AbortController, // Hotfix (3.5C.2) — loadExchangeAccountSnapshot now uses AbortSignal.timeout()
};
const vmCtx = vm.createContext(sandbox);
vm.runInContext(slice, vmCtx, { filename: 'index-slice.js' });
const M = sandbox.__exports;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond) { if (cond) pass++; else { fail++; failures.push(name); console.log('FAIL:', name); } }

async function main() {
  // Settings renders Exchange Connections section even before data loads (loading state)
  M.Store.exchangeConnections = null;
  const loadingHtml = M.renderAiConnectionsSettings();
  check('Settings renders Exchange Connections section (loading state)', loadingHtml.includes('交易所连接') || loadingHtml.includes('正在加载交易所连接'));

  // load connections (empty at first)
  await M.loadExchangeConnectionsFromBackend();
  const emptyHtml = M.renderAiConnectionsSettings();
  check('Settings renders empty state before any connection exists', emptyHtml.includes('尚未配置任何交易所连接'));
  check('read-only warning visible', emptyHtml.includes('不支持真实下单'));
  check('no submit-order button/action exists anywhere in Settings HTML', !emptyHtml.includes('data-action="exch-submit-order"') && !emptyHtml.includes('提交订单') && !emptyHtml.includes('>下单<'));

  // create a connection (save works)
  M.exchangeConnFormOpenNew();
  M.Store.exchangeConnDraftForm.name = 'My Testnet Futures';
  M.Store.exchangeConnDraftForm.environment = 'TESTNET';
  M.Store.exchangeConnDraftForm.apiKey = 'AK_abcdefgh1234';
  M.Store.exchangeConnDraftForm.apiSecret = 'SECRET_xyz';
  await M.exchangeConnFormSave();
  check('save works: connection now in Store.exchangeConnections', M.Store.exchangeConnections.length === 1 && M.Store.exchangeConnections[0].name === 'My Testnet Futures');
  const connId = M.Store.exchangeConnections[0].id;

  const listHtml = M.renderAiConnectionsSettings();
  check('raw apiKey never rendered anywhere in Settings HTML', !listHtml.includes('AK_abcdefgh1234'));
  check('raw apiSecret never rendered anywhere in Settings HTML', !listHtml.includes('SECRET_xyz'));
  check('TESTNET badge renders', listHtml.includes('TESTNET'));

  // masked credentials render — shown in the edit form (same UX precedent as AI Connections: the
  // masked key is a form hint while editing, not printed in the collapsed row)
  M.Store.exchangeConnEditingId = connId;
  M.Store.exchangeConnDraftForm = { name: M.Store.exchangeConnections[0].name, exchange: 'binance-futures', environment: 'TESTNET', apiKey: '', apiSecret: '' };
  const editFormHtml = M.renderAiConnectionsSettings();
  check('masked credentials render in edit form (apiKeyMasked visible, not raw key)', editFormHtml.includes(M.Store.exchangeConnections[0].apiKeyMasked));
  check('raw apiKey never rendered in edit form either', !editFormHtml.includes('AK_abcdefgh1234'));
  M.Store.exchangeConnEditingId = null; M.Store.exchangeConnDraftForm = null;

  // test status renders
  await M.exchangeConnTestAction(connId);
  const afterTestHtml = M.renderAiConnectionsSettings();
  check('test status renders (success)', afterTestHtml.includes('连接成功'));

  // switch to LIVE via edit+save, confirm LIVE badge
  const editable = M.exchangeConnectionById(connId);
  M.Store.exchangeConnEditingId = connId;
  M.Store.exchangeConnDraftForm = { name: editable.name, exchange: editable.exchange, environment: 'LIVE', apiKey: '', apiSecret: '' };
  await M.exchangeConnFormSave();
  const liveHtml = M.renderAiConnectionsSettings();
  check('LIVE badge renders after switching environment', liveHtml.includes('LIVE'));

  // account snapshot: empty positions state
  // Sprint 3.5C note: accountRisk + per-position protection are now part of the real snapshot shape
  // (see binanceFuturesAdapter.ts's normalizeBinanceFuturesAccount()) — this fixture is updated to
  // match, otherwise renderPositionCard()/renderExchangeAccountSummary() would throw on undefined.
  fakeAccountByConnId[connId] = {
    connectionId: connId, exchange: 'binance-futures', environment: 'LIVE', fetchedAt: new Date().toISOString(),
    account: { canTrade: true },
    accountRisk: { totalWalletBalance: 1000, totalUnrealizedPnl: 0, totalMarginBalance: 1000, totalInitialMargin: 0, totalMaintMargin: 0, availableBalance: 1000 },
    balances: [{ asset: 'USDT', free: 1000, locked: 0, total: 1000 }], positions: [], protectiveOrders: [],
    protectionReadStatus: 'OK', // Hotfix (3.5C.2) — now part of the real snapshot shape
  };
  await M.loadExchangeAccountSnapshot(connId);
  const emptyPosHtml = M.renderAiConnectionsSettings();
  check('account snapshot renders (fetchedAt shown)', emptyPosHtml.includes('账户快照'));
  check('balance rows render', emptyPosHtml.includes('USDT') && emptyPosHtml.includes('1,000'));
  check('empty positions state shown', emptyPosHtml.includes('当前账户没有未平仓持仓'));

  // account snapshot: with positions
  const emptyProtection = { stopLossOrders: [], takeProfitOrders: [], trailingStopOrders: [], otherOrders: [] };
  fakeAccountByConnId[connId].positions = [
    { symbol: 'BTCUSDT', side: 'LONG', quantity: 0.5, entryPrice: 65000, markPrice: 65200, notional: 32600, unrealizedPnl: 100, leverage: 10, marginType: 'CROSSED', isolatedMargin: null, positionInitialMargin: null, maintenanceMargin: null, liquidationPrice: null, breakEvenPrice: null, positionSide: null, distanceToLiquidationPct: null, protection: emptyProtection },
    { symbol: 'ETHUSDT', side: 'SHORT', quantity: 2, entryPrice: 3200, markPrice: 3150, notional: -6300, unrealizedPnl: 100, leverage: 5, marginType: 'ISOLATED', isolatedMargin: 1000, positionInitialMargin: null, maintenanceMargin: null, liquidationPrice: null, breakEvenPrice: null, positionSide: null, distanceToLiquidationPct: null, protection: emptyProtection },
  ];
  await M.loadExchangeAccountSnapshot(connId);
  const posHtml = M.renderAiConnectionsSettings();
  check('position rows render (LONG BTCUSDT)', posHtml.includes('BTCUSDT') && posHtml.includes('LONG'));
  check('position rows render (SHORT ETHUSDT)', posHtml.includes('ETHUSDT') && posHtml.includes('SHORT'));
  check('unrealized PnL from real exchange data rendered', posHtml.includes('未实现盈亏'));
  check('leverage rendered', posHtml.includes('10x') && posHtml.includes('5x'));

  // proof: no submit/cancel/amend-order UI anywhere, even with an active connection + snapshot rendered
  // (excludes the legitimate read-only disclaimer text, which itself contains the substring "下单"
  // as part of "不支持真实下单" — checked for a button/action-shaped occurrence instead)
  const forbiddenUiTerms = ['提交订单', '>下单<', 'Submit Order', 'Place Order', 'Cancel Order', 'data-action="exch-submit"', 'data-action="exch-place-order"'];
  const hasForbidden = forbiddenUiTerms.some((t) => posHtml.includes(t));
  check('no submit-order/cancel-order button exists anywhere in rendered Settings HTML', !hasForbidden);
  check('read-only disclaimer still present alongside real account data', posHtml.includes('不支持真实下单'));

  // static source check across the whole file: no order-related data-action anywhere
  check('no exch-submit-order/exch-place-order/exch-cancel-order data-action anywhere in shipped index.html', !html.includes('exch-submit-order') && !html.includes('exch-place-order') && !html.includes('exch-cancel-order'));

  // fetch log sanity: only exchange endpoints hit, never an /order path
  check('no fetch call in this test ever hit an order endpoint', fetchCallLog.every((u) => !u.includes('/order')));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('Failures:', failures); process.exit(1); }
}
main();
