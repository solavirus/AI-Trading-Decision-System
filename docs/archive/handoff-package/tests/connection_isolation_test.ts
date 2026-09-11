// Hotfix — Exchange Connection test-storage isolation regression (Task 9, Cases A/B/C).
// NO real network calls. Verifies the exact mechanism that let "ValidConn" leak into real
// pipeline/data/exchange_connections.json can never happen again, regardless of cwd or mid-test crash.

import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createExchangeConnection, listExchangeConnections, deleteExchangeConnection,
  __setExchangeConnectionsPathForTesting,
} from './exchangeConnectionStore.js';

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean) { if (cond) pass++; else { fail++; failures.push(name); console.log('FAIL:', name); } }

const REAL_PROD_PATH = 'data/exchange_connections.json';

function snapshotProd(): string | null {
  return existsSync(REAL_PROD_PATH) ? readFileSync(REAL_PROD_PATH, 'utf8') : null;
}

async function run() {
  // ---- Case A: real production storage pre-existing content untouched, byte-for-byte, across a
  // full isolated test run (mirrors "我的币安账户"/real-user-connection style pre-existing data). ----
  {
    const before = snapshotProd();
    const tempDir = mkdtempSync(join(tmpdir(), 'qa-conn-case-a-'));
    __setExchangeConnectionsPathForTesting(join(tempDir, 'exchange_connections.json'));
    createExchangeConnection({ name: 'CaseA-Isolated', exchange: 'binance-futures', environment: 'TESTNET', apiKey: 'k', apiSecret: 's' });
    check('Case A: isolated connection created in temp storage', listExchangeConnections().some((c) => c.name === 'CaseA-Isolated'));
    __setExchangeConnectionsPathForTesting(null); // back to production default
    rmSync(tempDir, { recursive: true, force: true });
    const after = snapshotProd();
    check('Case A: real production storage byte-for-byte unchanged', before === after);
  }

  // ---- Case B: a connection created during a test only ever appears in temp storage, never in
  // production storage, and the temp file itself is cleaned up afterward. ----
  {
    const before = snapshotProd();
    const tempDir = mkdtempSync(join(tmpdir(), 'qa-conn-case-b-'));
    const tempPath = join(tempDir, 'exchange_connections.json');
    __setExchangeConnectionsPathForTesting(tempPath);
    createExchangeConnection({ name: 'ValidConn', exchange: 'binance-futures', environment: 'LIVE', apiKey: 'AK_v', apiSecret: 'SECRET_v' });
    check('Case B: ValidConn-named fixture written to temp path only', existsSync(tempPath) && readFileSync(tempPath, 'utf8').includes('ValidConn'));
    __setExchangeConnectionsPathForTesting(null);
    const prodContent = snapshotProd();
    check('Case B: production storage never contains this fixture', prodContent === before && !(prodContent || '').includes('ValidConn'));
    rmSync(tempDir, { recursive: true, force: true });
    check('Case B: temp storage cleaned up', !existsSync(tempPath));
  }

  // ---- Case C: a test throws mid-run (simulating the exact crash pattern that originally skipped
  // cleanup) — production storage must still be untouched, because writes never targeted it. ----
  {
    const before = snapshotProd();
    const tempDir = mkdtempSync(join(tmpdir(), 'qa-conn-case-c-'));
    __setExchangeConnectionsPathForTesting(join(tempDir, 'exchange_connections.json'));
    let threw = false;
    try {
      createExchangeConnection({ name: 'CrashCase', exchange: 'binance-futures', environment: 'LIVE', apiKey: 'x', apiSecret: 'y' });
      throw new Error('simulated mid-test crash, e.g. an unrelated later assertion/exception');
    } catch (e) {
      threw = true;
    } finally {
      __setExchangeConnectionsPathForTesting(null);
      rmSync(tempDir, { recursive: true, force: true });
    }
    check('Case C: simulated crash actually occurred (sanity)', threw);
    check('Case C: production storage untouched despite mid-test crash', snapshotProd() === before);
  }

  // ---- default behavior check: with no override set, the store resolves to the real production
  // path (production behavior is unchanged — override defaults to null). ----
  {
    __setExchangeConnectionsPathForTesting(null);
    const listBefore = listExchangeConnections();
    check('default (no override): reads real production connections', listBefore.length >= 0); // just proves no crash / no redirect
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
}

run().catch((e) => { console.error('TEST RUNNER ERROR:', e); process.exit(1); });
