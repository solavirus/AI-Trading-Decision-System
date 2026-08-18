// Sprint 3.2C.1 — AI Response Parser regression test.
//
// Runs the real Parser (extracted from prototype/index.html — a pure-JS section with no DOM
// dependency other than localStorage, see that file's "Sprint 3.2C: AI Response Parser" comment)
// against first_real_ai_response.json, the project's first real captured AI response.
//
// This fixture is EXPECTED TO FAIL validation — it predates AI_RESPONSE_SPEC.md v1.2.0's
// formalized rules and has 6 `reasoning` items (the cap is 5). It must never be edited to make it
// pass; if the Parser's behavior on this exact fixture ever needs to change, that is itself a
// signal worth noticing, not something to silently paper over.
//
// Run with: node test-fixtures/run_regression.mjs   (from the repo root)
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const FIXTURE_PATH = join(__dirname, 'first_real_ai_response.json');
const INDEX_HTML_PATH = join(REPO_ROOT, 'prototype', 'index.html');

// Pinned at fixture-creation time (2026-08-08). If this ever fails, the fixture file's bytes have
// changed — per Task 2's own rule ("the regression fixture must never be edited to satisfy new
// parser logic"), that must be a deliberate, reviewed decision, never a silent edit.
const EXPECTED_FIXTURE_SHA256 = 'f04d27a053bf2be38d0b1154f861dda8077e02955ae0b38f43f6e8228eb58f1c';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------- Load the fixture unchanged ----------
const rawFixtureText = readFileSync(FIXTURE_PATH, 'utf8');
const actualChecksum = sha256(rawFixtureText);

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('PASS:', name); }
  catch (e) { fail++; console.log('FAIL:', name, '--', e.message); }
}

check('fixture checksum matches pinned value (fixture has not been edited)', () => {
  assert.equal(actualChecksum, EXPECTED_FIXTURE_SHA256,
    `fixture checksum changed — expected ${EXPECTED_FIXTURE_SHA256}, got ${actualChecksum}. ` +
    `If this file was intentionally replaced with a NEW real response, update EXPECTED_FIXTURE_SHA256 ` +
    `above deliberately — never to make a failing case start passing.`);
});

check('fixture is valid JSON with the 3 known real-response defects still present', () => {
  const parsed = JSON.parse(rawFixtureText);
  assert.equal(parsed.reasoning.length, 6, 'expected 6 reasoning items (the known defect)');
  assert.equal(parsed.weightContribution.some(w => w.sourceId === 'liquidation'), false,
    'expected weightContribution to be missing the liquidation entry (the known defect)');
  assert.equal(parsed.decision.action, 'WAIT');
});

// ---------- Extract the real Parser out of prototype/index.html ----------
const html = readFileSync(INDEX_HTML_PATH, 'utf8');
function extract(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  if (start === -1) throw new Error('start marker not found: ' + startMarker);
  const end = html.indexOf(endMarker, start);
  if (end === -1) throw new Error('end marker not found: ' + endMarker);
  return html.slice(start, end);
}
const weightDefsSrc = extract('const WEIGHT_DEFS=[', '\nfunction analysisStepLabels');
const parserSrc = extract('/* ---------- Sprint 3.2C: AI Response Parser', '/** Sprint 3.1B.2 Task 1');

class FakeLocalStorage {
  constructor(){ this.store = new Map(); }
  getItem(k){ return this.store.has(k) ? this.store.get(k) : null; }
  setItem(k,v){ this.store.set(k, String(v)); }
  removeItem(k){ this.store.delete(k); }
  clear(){ this.store.clear(); }
}
const sandbox = { localStorage: new FakeLocalStorage(), console };
vm.createContext(sandbox);
vm.runInContext(weightDefsSrc + '\n' + parserSrc, sandbox, { filename: 'parser-extract.js' });
const { parseAiResponse } = sandbox;

// ---------- Run the fixture through the real Parser ----------
// The AIRawResult wrapper (requestId/provider/model/timestamps) was never captured alongside this
// response — only the response body itself was preserved (see PROJECT.md). provider/model below
// are the one real configured provider in this environment (pipeline/data/ai_provider_config.json:
// openai-compatible / gpt-5.4) used only as plausible context for this harness, not asserted as a
// verified fact about this specific call.
const rawResult = {
  requestId: 'UNKNOWN-NOT-CAPTURED',
  analysisId: 'AMSJ7CNTY45R5',
  provider: 'openai-compatible',
  model: 'gpt-5.4',
  startedAt: '2026-08-07T00:00:00.000Z',
  completedAt: '2026-08-07T00:00:01.000Z',
  latencyMs: 1000,
  rawText: rawFixtureText,
  status: 'success',
};

// No real Analysis Payload for this analysisId exists in this repo (it lives only in the original
// browser session's localStorage, if at all). This placeholder is NEVER read before the Parser
// throws — the fixture's defect (6 reasoning items) is caught by schema validation, which runs
// BEFORE any payload-dependent cross-validation step in the pipeline. See the assertion below that
// pins the failure to schema_validation_failed specifically, proving this determinism.
const placeholderPayload = { analysisId: 'AMSJ7CNTY45R5', sourceWeights: {}, additionalEvidence: [], sourceSnapshots: [], selectedNewsEvents: [] };

const result = parseAiResponse({ rawResult, payload: placeholderPayload, promptVersion: '1.0.0' });

check('parser rejects the fixture (does not silently pass a spec-invalid real response)', () => {
  assert.equal(result.ok, false, 'expected parsing to fail');
});

check('parser fails with schema_validation_failed (the reasoning>5 cap), deterministically', () => {
  assert.equal(result.error.code, 'schema_validation_failed');
  assert.equal(result.error.details && result.error.details.count, 6,
    'expected the error details to pin the exact reasoning count that caused the failure');
});

check('rawResult.rawText is byte-for-byte unchanged after the failed parse (Raw Response Preservation)', () => {
  assert.equal(rawResult.rawText, rawFixtureText);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
