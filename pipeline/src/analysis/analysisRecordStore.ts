/** Sprint 3.9, Section 10/28 — the ONE unified, backend-owned Analysis History store. Manual and
 * Scheduled both write here (never a second store) — this is what makes "Scheduled analysis truth
 * survives the browser being closed" true (Section 28), and what lets Homepage/Analysis History show
 * both sources from one list (Section 11). Uses the Sprint 3.8C.2 Safe JSON Persistence Primitive
 * (fail-closed load, atomic write, cross-process lock) — Section 28 explicitly forbids inventing a
 * new `catch{}→default`/direct-`writeFileSync` store for this. */
import type { AnalysisRecord } from './types.js';
import { readJsonStoreOrDefault, withStoreWriteLock } from '../util/safeJsonStore.js';

const CONFIG_DIR = 'data';
const RECORDS_PATH = CONFIG_DIR + '/analysis_records.json';
const STORE_NAME = 'AnalysisRecord';

let __testStoragePathOverride: string | null = null;
export function __setAnalysisRecordsPathForTesting(path: string | null): void {
  __testStoragePathOverride = path;
}
function resolvePath(): string {
  return __testStoragePathOverride ?? RECORDS_PATH;
}

type StoreFile = Record<string, AnalysisRecord>;

function loadFile(): StoreFile {
  return readJsonStoreOrDefault<StoreFile>(resolvePath(), STORE_NAME, {});
}

export function saveAnalysisRecord(record: AnalysisRecord): AnalysisRecord {
  withStoreWriteLock<StoreFile>(resolvePath(), STORE_NAME, {}, (file) => {
    file[record.analysisId] = record;
    return file;
  });
  return record;
}

export function getAnalysisRecord(analysisId: string): AnalysisRecord | undefined {
  return loadFile()[analysisId];
}

/** Sorted newest-first by `createdAt` — Section 11's "Homepage recent analysis" / "Analysis history"
 * both read this one list, filtering by `source` client-side (or via the `source` query param below)
 * rather than maintaining two separate lists. */
export function listAnalysisRecords(opts?: { source?: 'MANUAL' | 'SCHEDULED'; limit?: number }): AnalysisRecord[] {
  let records = Object.values(loadFile());
  if (opts?.source) records = records.filter((r) => r.source === opts.source);
  records.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  if (opts?.limit) records = records.slice(0, opts.limit);
  return records;
}

export function getMostRecentAnalysisRecord(): AnalysisRecord | null {
  const records = listAnalysisRecords({ limit: 1 });
  return records[0] || null;
}
