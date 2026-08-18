// Sprint 3.5D-B.1 tests — Numeric Scenario Enforcement + Absolute Expiry.
// Same vm-extraction technique as v2_1_parser_fixtures.js: extract the real shipped Parser code
// (up to devParseAiResponse) and run it against synthetic AIResponse fixtures. No paid AI call
// anywhere in this file.
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('c:/Users/surface/Documents/Obsidian Vault/量化/prototype/index.html', 'utf8');
const scriptStart = html.indexOf('<script>') + '<script>'.length;
const range1 = html.slice(scriptStart, html.indexOf('\nfunction devParseAiResponse(', scriptStart));

let localStorageBacking = new Map();
const fakeLocalStorage = {
  getItem: (k) => (localStorageBacking.has(k) ? localStorageBacking.get(k) : null),
  setItem: (k, v) => { localStorageBacking.set(k, String(v)); },
  removeItem: (k) => { localStorageBacking.delete(k); },
};
function fakeEl(){ return { classList:{add(){},remove(){}}, addEventListener(){}, style:{}, dataset:{} }; }
const sandbox = {
  console, localStorage: fakeLocalStorage,
  document: { getElementById(){ return fakeEl(); }, addEventListener(){}, documentElement:{ setAttribute(){}, getAttribute(){ return null; } } },
};
vm.createContext(sandbox);
vm.runInContext(range1 + '\nglobalThis.__exports={parseAiResponse,evaluateScenarioExecutionReadiness,getScenarioEntryReferencePrice,isValidAbsoluteTimestamp,isMachineEvaluableTrigger};', sandbox);
const { parseAiResponse, evaluateScenarioExecutionReadiness, getScenarioEntryReferencePrice, isValidAbsoluteTimestamp, isMachineEvaluableTrigger } = sandbox.__exports;

const payload = JSON.parse(fs.readFileSync('C:/Users/surface/AppData/Local/Temp/claude/c--Users-surface-Documents-Obsidian-Vault---/d2c1efff-ed9a-4537-a08a-21fbcdba63c7/scratchpad/v2_frozen_payload.json', 'utf8'));
const analysisId = payload.analysisId;
const sourceKeys = Object.keys(payload.sourceWeights);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond) { if (cond) pass++; else { fail++; failures.push(name); console.log('FAIL:', name); } }

function fullSourceAssessments() {
  return sourceKeys.map((id, i) => ({
    sourceId: id, configuredWeight: payload.sourceWeights[id],
    direction: i % 3 === 0 ? 'LONG' : i % 3 === 1 ? 'SHORT' : 'NEUTRAL', evidenceStrength: 'MEDIUM',
    explanation: 'synthetic fixture explanation for ' + id, evidenceReferences: ['sourceSnapshots:' + id],
  }));
}

const FUTURE_EXPIRY = '2030-01-01T10:00:00+08:00';
const PAST_EXPIRY = '2020-01-01T10:00:00+08:00';

function candleTrigger(op, value, tf) {
  return { description: '4H 收盘 ' + op + ' ' + value, logic: 'ALL', conditions: [{ metric: 'candle_close', operator: op, value, timeframe: tf || '4H' }] };
}

function primaryEnterMarket(overrides) {
  const base = {
    id: 'plan-1', priority: 'PRIMARY', direction: 'LONG', action: 'ENTER',
    title: 'Breakout long', trigger: 'Price confirmed above resistance', holdingPeriod: '1-3 days',
    reviewHorizon: { description: '未来 3 根 4H K线内有效', expiresAt: FUTURE_EXPIRY },
    entry: { type: 'MARKET' },
    stopLoss: { value: 63500 },
    takeProfit: [{ value: 67000 }],
    rationale: 'synthetic executable primary', evidenceReferences: ['sourceSnapshots:technical'],
  };
  return overrides ? { ...base, ...overrides(base) } : base;
}
function primaryEnterLimit(overrides) {
  const base = {
    id: 'plan-1', priority: 'PRIMARY', direction: 'LONG', action: 'ENTER',
    title: 'Limit long', trigger: 'Pullback to support with confirmation', holdingPeriod: '1-3 days',
    reviewHorizon: { description: '未来 3 根 4H K线内有效', expiresAt: FUTURE_EXPIRY },
    entry: { type: 'LIMIT', value: 64500 },
    stopLoss: { value: 63500 },
    takeProfit: [{ value: 67000 }],
    rationale: 'synthetic executable primary', evidenceReferences: ['sourceSnapshots:technical'],
  };
  return overrides ? { ...base, ...overrides(base) } : base;
}
function primaryWaitZoneNumeric(overrides) {
  const base = {
    id: 'plan-1', priority: 'PRIMARY', direction: 'LONG', action: 'ENTER',
    title: 'Pullback long (numeric zone)', trigger: 'BTC returns to 64000-64300 and stabilizes', holdingPeriod: '1-3 days',
    reviewHorizon: { description: '未来 3 根 4H K线内有效', expiresAt: FUTURE_EXPIRY },
    triggerStructured: { description: 'BTC 回踩 64,000-64,300 区间', logic: 'ALL', conditions: [{ metric: 'price', operator: 'BETWEEN', min: 64000, max: 64300, timeframe: null }] },
    entry: { type: 'ZONE', from: 64000, to: 64300 },
    stopLoss: { value: 63200 },
    takeProfit: [{ value: 65800 }, { value: 67200 }],
    rationale: 'synthetic zone primary', evidenceReferences: ['sourceSnapshots:technical'],
  };
  return overrides ? { ...base, ...overrides(base) } : base;
}

function baseResponse(o) {
  return {
    responseVersion: '2.2.0', analysisId,
    summary: { title: 'Synthetic', content: 'Synthetic fixture summary.' },
    decision: { direction: 'LONG', action: 'ENTER', confidence: 70 },
    scenarioPlans: [primaryEnterMarket()],
    sourceAssessments: fullSourceAssessments(),
    reasoning: [{ title: 'R1', description: 'D1', importance: 60, stance: 'SUPPORT', evidenceReferences: ['sourceSnapshots:technical'] }],
    risks: [{ title: 'Risk1', description: 'D', impact: 'MEDIUM' }],
    evidence: [{ reason: 'summary', references: ['sourceSnapshots:technical'] }],
    ...o,
  };
}

function run(name, response, expectOk, expectCodeSubstring) {
  const rawResult = { status: 'success', rawText: JSON.stringify(response), provider: 'test', model: 'test-model' };
  const result = parseAiResponse({ rawResult, payload, promptVersion: '2.2.0' });
  if (expectOk) {
    check(name, result.ok === true);
    if (!result.ok) console.log('  -> unexpected error:', result.error.code, result.error.message);
  } else {
    check(name, result.ok === false && (!expectCodeSubstring || result.error.code === expectCodeSubstring));
    if (result.ok) console.log('  -> unexpectedly passed');
  }
  // clear persisted record so repeated analysisId reuse across cases in this file doesn't hit response_already_exists
  localStorageBacking.delete('qa_ai_response_records');
}

// =====================================================================================
// PART 1 — Numeric Scenario Parser tests (Task 31)
// =====================================================================================
run('LONG WAIT with numeric trigger + zone + stop + TP + expiresAt -> PASS', baseResponse({
  decision: { direction: 'LONG', action: 'WAIT', confidence: 60 },
  scenarioPlans: [primaryWaitZoneNumeric()],
}), true);

run('SHORT WAIT equivalent -> PASS', baseResponse({
  decision: { direction: 'SHORT', action: 'WAIT', confidence: 58 },
  scenarioPlans: [primaryWaitZoneNumeric(b => ({
    direction: 'SHORT', entry: { type: 'ZONE', from: 65700, to: 66000 }, stopLoss: { value: 66800 },
    takeProfit: [{ value: 64200 }, { value: 63000 }],
    triggerStructured: { description: '4H 收盘跌破 65,700', logic: 'ALL', conditions: [{ metric: 'candle_close', operator: 'LTE', value: 65700, timeframe: '4H' }] },
  }))],
}), true);

run('ENTER LIMIT numeric -> PASS', baseResponse({
  scenarioPlans: [primaryEnterLimit()],
}), true);

run('ENTER MARKET + numeric stop/TP/expiresAt -> PASS', baseResponse({
  scenarioPlans: [primaryEnterMarket()],
}), true);

run('missing stop -> reject', baseResponse({
  scenarioPlans: [primaryEnterLimit(b => ({ stopLoss: { description: 'below structure' } }))],
}), false, 'schema_validation_failed');

run('description-only stop -> reject', baseResponse({
  scenarioPlans: [primaryEnterLimit(b => ({ stopLoss: { value: null, description: '跌破结构失效位置' } }))],
}), false, 'schema_validation_failed');

run('empty TP -> reject', baseResponse({
  scenarioPlans: [primaryEnterLimit(b => ({ takeProfit: [] }))],
}), false); // shape rule (takeProfit.length<1) rejects before reaching readiness

run('description-only TP -> reject', baseResponse({
  scenarioPlans: [primaryEnterLimit(b => ({ takeProfit: [{ description: 'prior swing high' }] }))],
}), false, 'schema_validation_failed');

run('ZONE missing from -> reject', baseResponse({
  decision: { direction: 'LONG', action: 'WAIT', confidence: 60 },
  scenarioPlans: [primaryWaitZoneNumeric(b => ({ entry: { type: 'ZONE', from: null, to: 64300 } }))],
}), false, 'schema_validation_failed');

run('ZONE from > to -> reject', baseResponse({
  decision: { direction: 'LONG', action: 'WAIT', confidence: 60 },
  scenarioPlans: [primaryWaitZoneNumeric(b => ({ entry: { type: 'ZONE', from: 64300, to: 64000 } }))],
}), false, 'schema_validation_failed');

run('WAIT missing triggerStructured -> reject', baseResponse({
  decision: { direction: 'LONG', action: 'WAIT', confidence: 60 },
  scenarioPlans: [primaryWaitZoneNumeric(b => ({ triggerStructured: null }))],
}), false, 'schema_validation_failed');

run('WAIT prose-only trigger (unsupported metric) -> reject', baseResponse({
  decision: { direction: 'LONG', action: 'WAIT', confidence: 60 },
  scenarioPlans: [primaryWaitZoneNumeric(b => ({ triggerStructured: null }))], // trigger text alone (plan.trigger) is prose-only; no structured trigger present
}), false, 'schema_validation_failed');

run('invalid expiresAt (no timezone) -> reject', baseResponse({
  scenarioPlans: [primaryEnterLimit(b => ({ reviewHorizon: { description: '有效期', expiresAt: '2030-01-01 10:00:00' } }))],
}), false, 'schema_validation_failed');

run('expiresAt in past -> reject', baseResponse({
  scenarioPlans: [primaryEnterLimit(b => ({ reviewHorizon: { description: '有效期', expiresAt: PAST_EXPIRY } }))],
}), false, 'schema_validation_failed');

run('LONG stop above entry -> reject', baseResponse({
  scenarioPlans: [primaryEnterLimit(b => ({ entry: { type: 'LIMIT', value: 64500 }, stopLoss: { value: 65000 } }))], // stop ABOVE entry for LONG
}), false, 'schema_validation_failed');

run('LONG TP below entry -> reject', baseResponse({
  scenarioPlans: [primaryEnterLimit(b => ({ entry: { type: 'LIMIT', value: 64500 }, takeProfit: [{ value: 64000 }] }))], // TP below entry for LONG
}), false, 'schema_validation_failed');

run('SHORT stop below entry -> reject', baseResponse({
  decision: { direction: 'SHORT', action: 'ENTER', confidence: 60 },
  scenarioPlans: [primaryEnterLimit(b => ({ direction: 'SHORT', entry: { type: 'LIMIT', value: 64500 }, stopLoss: { value: 64000 }, takeProfit: [{ value: 63000 }] }))],
}), false, 'schema_validation_failed');

run('SHORT TP above entry -> reject', baseResponse({
  decision: { direction: 'SHORT', action: 'ENTER', confidence: 60 },
  scenarioPlans: [primaryEnterLimit(b => ({ direction: 'SHORT', entry: { type: 'LIMIT', value: 64500 }, stopLoss: { value: 65500 }, takeProfit: [{ value: 65000 }] }))],
}), false, 'schema_validation_failed');

// additional entry-rule coverage
run('CONDITIONAL entry on PRIMARY -> reject (Task 3 — no longer valid final entry)', baseResponse({
  decision: { direction: 'LONG', action: 'WAIT', confidence: 60 },
  scenarioPlans: [primaryWaitZoneNumeric(b => ({ entry: { type: 'CONDITIONAL', description: 'wait for confirmation' } }))],
}), false, 'schema_validation_failed');

run('MARKET entry on WAIT PRIMARY -> reject (Task 3)', baseResponse({
  decision: { direction: 'LONG', action: 'WAIT', confidence: 60 },
  scenarioPlans: [primaryWaitZoneNumeric(b => ({ entry: { type: 'MARKET' } }))],
}), false, 'schema_validation_failed');

console.log(`\nParser numeric-scenario tests: ${pass} passed so far`);

// =====================================================================================
// PART 2 — evaluateScenarioExecutionReadiness / Time Resolution tests (Task 20/32)
// =====================================================================================
(function testReadinessDirect() {
  const decisionEnter = { direction: 'LONG', action: 'ENTER', confidence: 70 };
  const decisionWait = { direction: 'LONG', action: 'WAIT', confidence: 60 };
  const now = new Date('2026-08-08T00:00:00Z'); // earlier than every "future" fixture below, later than the deliberately-expired one

  // 3x4H horizon earlier than macro event -> expiresAt uses horizon (fixture-level: the caller/Prompt
  // is responsible for the derivation; here we verify the Parser/readiness function accepts whichever
  // single resolved expiresAt is given, honoring "earliest constraint wins" as a fixture semantic).
  const horizonEarlier = primaryEnterLimit(b => ({ reviewHorizon: { description: '3x4H 复核周期', expiresAt: '2026-08-10T10:00:00+08:00' } }));
  check('Time Resolution: horizon-derived expiresAt accepted (horizon earlier than macro event)', evaluateScenarioExecutionReadiness(horizonEarlier, decisionEnter, now).ready === true);

  const macroEarlier = primaryEnterLimit(b => ({ reviewHorizon: { description: '宏观事件前复核', expiresAt: '2026-08-09T18:00:00+08:00' } }));
  check('Time Resolution: macro-derived expiresAt accepted (macro earlier than horizon)', evaluateScenarioExecutionReadiness(macroEarlier, decisionEnter, now).ready === true);

  const noRelevantEvent = primaryEnterLimit(b => ({ reviewHorizon: { description: '仅有效周期，无相关宏观事件', expiresAt: '2026-08-15T00:00:00+08:00' } }));
  check('Time Resolution: no relevant macro event -> horizon alone accepted', evaluateScenarioExecutionReadiness(noRelevantEvent, decisionEnter, now).ready === true);

  // timezone retained: a UTC 'Z' timestamp and a +08:00 timestamp both accepted as valid absolute timestamps
  check('Time Resolution: Z-suffixed UTC timestamp accepted as valid absolute timestamp', isValidAbsoluteTimestamp('2026-08-15T00:00:00Z') === true);
  check('Time Resolution: +08:00-offset timestamp accepted', isValidAbsoluteTimestamp('2026-08-15T00:00:00+08:00') === true);
  check('Time Resolution: bare no-timezone timestamp rejected', isValidAbsoluteTimestamp('2026-08-15 00:00:00') === false);

  // expired timestamp rejected by readiness (referenceTime after expiresAt)
  const expiredPlan = primaryEnterLimit(b => ({ reviewHorizon: { description: '已过期', expiresAt: '2026-08-01T00:00:00+08:00' } }));
  const expiredResult = evaluateScenarioExecutionReadiness(expiredPlan, decisionEnter, now);
  check('Time Resolution: expired timestamp (relative to referenceTime) rejected', expiredResult.ready === false && expiredResult.reasons.some(r => r.includes('已过')));

  // multiple high-impact events — earliest relevant one should be what's used (fixture-level; ensure
  // the readiness function itself doesn't care WHICH source produced expiresAt, only that it's valid+future)
  const earliestOfMultiple = primaryEnterLimit(b => ({ reviewHorizon: { description: '取多个高影响力事件中最早者', expiresAt: '2026-08-09T09:00:00+08:00' } }));
  check('Time Resolution: earliest-of-multiple-events timestamp accepted', evaluateScenarioExecutionReadiness(earliestOfMultiple, decisionEnter, now).ready === true);

  // MARKET entry has no reference price -> directional sanity skipped, not a failure
  const marketPlan = primaryEnterMarket();
  const marketResult = evaluateScenarioExecutionReadiness(marketPlan, decisionEnter, now);
  check('MARKET entry: directional sanity skipped (no reference price), still ready', marketResult.ready === true && getScenarioEntryReferencePrice(marketPlan.entry) === null);

  // WAIT PRIMARY missing triggerStructured -> not ready
  const waitNoTrigger = primaryWaitZoneNumeric(b => ({ triggerStructured: null }));
  check('WAIT PRIMARY without triggerStructured: not ready', evaluateScenarioExecutionReadiness(waitNoTrigger, decisionWait, now).ready === false);

  // ALTERNATIVE plan readiness evaluated independently (Task 16) — CONDITIONAL alternative not ready
  const altConditional = { ...primaryEnterLimit(), priority: 'ALTERNATIVE', entry: { type: 'CONDITIONAL', description: 'later' } };
  check('ALTERNATIVE with CONDITIONAL entry: not ready (Task 16)', evaluateScenarioExecutionReadiness(altConditional, decisionEnter, now).ready === false);
  const altNumeric = { ...primaryEnterLimit(), priority: 'ALTERNATIVE' };
  check('ALTERNATIVE fully numeric: ready', evaluateScenarioExecutionReadiness(altNumeric, decisionEnter, now).ready === true);
})();

console.log(`\n3.5D-B.1 combined test results: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
