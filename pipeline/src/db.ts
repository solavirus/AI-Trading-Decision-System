import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// node:sqlite is experimental as of Node 22-24 but ships with the runtime — no native
// dependency, no node-gyp/build-tools headache on Windows (that's why it was picked over
// better-sqlite3). Emits an ExperimentalWarning on startup; that's expected, not an error.

const DB_DIR = 'data';
const DB_PATH = path.join(DB_DIR, 'etf_flows.sqlite');

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(DB_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS etf_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,              -- YYYY-MM-DD, trading date the snapshot represents
      shares_outstanding REAL,
      nav_close REAL,                  -- market close price used as NAV proxy (see etf/snapshot.ts)
      fund_flow_usd REAL,              -- NULL on a ticker's first-ever snapshot (no prior day to diff against)
      fetched_at INTEGER NOT NULL,
      UNIQUE(ticker, date)
    );
    CREATE INDEX IF NOT EXISTS idx_etf_snapshots_ticker_date ON etf_snapshots(ticker, date DESC);

    -- Generic normalized-snapshot store (DATA_SOURCE_SPEC.md's "Golden Rule": every API endpoint
    -- becomes a reusable data object before anything downstream — Dashboard/Research/AI — reads
    -- it). One row per source+symbol+poll. 'data' is the normalized snapshot object as JSON;
    -- shape is source-specific (see src/normalize/*.ts), this table doesn't need to know it.
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      symbol TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      status TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_source_symbol_ts ON snapshots(source, symbol, timestamp DESC);

    -- DATA_SOURCE_SPEC.md's Liquidation module: "Store Liquidation Event instead of raw
    -- websocket messages" — a dedicated event table (not the generic snapshots table above,
    -- which is one-row-per-poll; liquidations are one-row-per-event, pushed, not polled).
    CREATE TABLE IF NOT EXISTS liquidation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,      -- LONG | SHORT — the LIQUIDATED position's side, not the forced order's own side (opposite)
      price REAL NOT NULL,
      qty REAL NOT NULL,
      usd REAL NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_liquidation_events_ts ON liquidation_events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_liquidation_events_symbol_ts ON liquidation_events(symbol, timestamp DESC);

    -- 新闻源管理 (2026-08-06): real persistence for configured news sources, replacing the
    -- frontend's old localStorage-only config. 'origin' is purely an informational badge (was
    -- this seeded from sources/news.ts on first run, or added later by a user?) — it does NOT
    -- restrict edit/delete; user explicitly asked for real deletion of builtin sources too.
    -- type 'rss' and 'official' are actually fetched (see sources/news.ts); 'api'/'scrape' persist
    -- for real but have no fetcher implementation yet — never fake their status.
    CREATE TABLE IF NOT EXISTS news_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT,
      type TEXT NOT NULL,
      category TEXT,
      origin TEXT NOT NULL DEFAULT 'custom',
      enabled INTEGER NOT NULL DEFAULT 1,
      fetch_interval_minutes INTEGER NOT NULL DEFAULT 15,
      lookback_hours INTEGER NOT NULL DEFAULT 24,
      retain_days INTEGER NOT NULL DEFAULT 30,
      created_at INTEGER NOT NULL,
      last_fetched_at INTEGER,
      last_status TEXT,
      last_item_count INTEGER,
      last_error TEXT
    );
  `);
  // Additive migration for DBs created before lookback_hours existed — SQLite has no
  // "ADD COLUMN IF NOT EXISTS", so just swallow the "duplicate column" error on repeat runs.
  try { db.exec(`ALTER TABLE news_sources ADD COLUMN lookback_hours INTEGER NOT NULL DEFAULT 24`); } catch {}
  return db;
}

export interface NewsSourceRow {
  id: string;
  name: string;
  url: string | null;
  type: 'rss' | 'official' | 'api' | 'scrape';
  category: string | null;
  origin: 'builtin' | 'custom';
  enabled: number; // sqlite has no boolean; 0/1
  fetch_interval_minutes: number;
  lookback_hours: number;
  retain_days: number; // legacy column, no longer settable — see NewsSourceInput's comment
  created_at: number;
  last_fetched_at: number | null;
  last_status: 'ok' | 'error' | null;
  last_item_count: number | null;
  last_error: string | null;
}

/** retain_days deliberately isn't here: it would need a persisted news-article table to actually
 * retain/prune (articles are currently recomputed fresh from live feeds on every fetch, never
 * stored row-by-row) — exposing a "保留历史" control with no real backing would recreate the
 * exact hollow-UI problem 新闻源管理 was built to fix. Dropped from the UI until that lands. */
export interface NewsSourceInput {
  name: string;
  url: string | null;
  type: 'rss' | 'official' | 'api' | 'scrape';
  category: string | null;
  origin?: 'builtin' | 'custom';
  enabled?: boolean;
  fetch_interval_minutes?: number;
  lookback_hours?: number;
}

/** Seeds the real feeds sources/news.ts used to hardcode, but only on a genuinely empty table —
 * never overwrites user edits/deletions on subsequent server restarts. */
export function seedNewsSourcesIfEmpty(seed: { name: string; url: string; type: 'rss'; category: string }[]): void {
  const database = getDb();
  const { count } = database.prepare(`SELECT COUNT(*) as count FROM news_sources`).get() as { count: number };
  if (count > 0) return;
  const insert = database.prepare(
    `INSERT INTO news_sources (id, name, url, type, category, origin, enabled, fetch_interval_minutes, lookback_hours, created_at)
     VALUES (?, ?, ?, ?, ?, 'builtin', 1, 15, 24, ?)`
  );
  const now = Date.now();
  for (const s of seed) {
    insert.run(`builtin-${s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, s.name, s.url, s.type, s.category, now);
  }
}

export function listNewsSources(): NewsSourceRow[] {
  const database = getDb();
  return database.prepare(`SELECT * FROM news_sources ORDER BY created_at ASC`).all() as unknown as NewsSourceRow[];
}

export function getNewsSource(id: string): NewsSourceRow | undefined {
  const database = getDb();
  return database.prepare(`SELECT * FROM news_sources WHERE id = ?`).get(id) as NewsSourceRow | undefined;
}

export function insertNewsSource(input: NewsSourceInput): NewsSourceRow {
  const database = getDb();
  const id = 'ns-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  database.prepare(
    `INSERT INTO news_sources (id, name, url, type, category, origin, enabled, fetch_interval_minutes, lookback_hours, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, input.name, input.url, input.type, input.category, input.origin ?? 'custom',
    input.enabled === false ? 0 : 1, input.fetch_interval_minutes ?? 15, input.lookback_hours ?? 24, Date.now()
  );
  return getNewsSource(id)!;
}

export function updateNewsSource(id: string, patch: Partial<NewsSourceInput>): NewsSourceRow | undefined {
  const database = getDb();
  const existing = getNewsSource(id);
  if (!existing) return undefined;
  database.prepare(
    `UPDATE news_sources SET name=?, url=?, type=?, category=?, enabled=?, fetch_interval_minutes=?, lookback_hours=? WHERE id=?`
  ).run(
    patch.name ?? existing.name,
    patch.url !== undefined ? patch.url : existing.url,
    patch.type ?? existing.type,
    patch.category !== undefined ? patch.category : existing.category,
    patch.enabled === undefined ? existing.enabled : (patch.enabled ? 1 : 0),
    patch.fetch_interval_minutes ?? existing.fetch_interval_minutes,
    patch.lookback_hours ?? existing.lookback_hours,
    id
  );
  return getNewsSource(id);
}

export function deleteNewsSource(id: string): boolean {
  const database = getDb();
  const res = database.prepare(`DELETE FROM news_sources WHERE id = ?`).run(id);
  return res.changes > 0;
}

export function updateNewsSourceFetchStatus(id: string, status: { fetchedAt: number; status: 'ok' | 'error'; itemCount?: number; error?: string }): void {
  const database = getDb();
  database.prepare(
    `UPDATE news_sources SET last_fetched_at=?, last_status=?, last_item_count=?, last_error=? WHERE id=?`
  ).run(status.fetchedAt, status.status, status.itemCount ?? null, status.error ?? null, id);
}

export interface SnapshotRow {
  id: number;
  source: string;
  symbol: string;
  timestamp: number;
  status: string;
  data: string;
}

export function insertSnapshot(source: string, symbol: string, timestamp: number, status: string, data: unknown): void {
  const database = getDb();
  database.prepare(`INSERT INTO snapshots (source, symbol, timestamp, status, data) VALUES (?, ?, ?, ?, ?)`)
    .run(source, symbol, timestamp, status, JSON.stringify(data));
}

export function getSnapshotHistory(source: string, symbol: string, limit = 200): SnapshotRow[] {
  const database = getDb();
  return database.prepare(
    `SELECT * FROM snapshots WHERE source = ? AND symbol = ? ORDER BY timestamp DESC LIMIT ?`
  ).all(source, symbol, limit) as unknown as SnapshotRow[];
}

export interface LiquidationEventInput {
  exchange: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  price: number;
  qty: number;
  usd: number;
  timestamp: number;
}
export interface LiquidationEventRow extends LiquidationEventInput {
  id: number;
}

export function insertLiquidationEvent(e: LiquidationEventInput): void {
  const database = getDb();
  database.prepare(
    `INSERT INTO liquidation_events (exchange, symbol, side, price, qty, usd, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(e.exchange, e.symbol, e.side, e.price, e.qty, e.usd, e.timestamp);
}

export function getLiquidationEvents(sinceTs: number, limit = 200): LiquidationEventRow[] {
  const database = getDb();
  return database.prepare(
    `SELECT * FROM liquidation_events WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?`
  ).all(sinceTs, limit) as unknown as LiquidationEventRow[];
}

export interface LiquidationSummary {
  totalUsd: number;
  longUsd: number;
  shortUsd: number;
  count: number;
  largest: LiquidationEventRow | null;
}
export function getLiquidationSummary(sinceTs: number): LiquidationSummary {
  const database = getDb();
  const rows = database.prepare(
    `SELECT * FROM liquidation_events WHERE timestamp >= ?`
  ).all(sinceTs) as unknown as LiquidationEventRow[];
  let totalUsd = 0, longUsd = 0, shortUsd = 0;
  let largest: LiquidationEventRow | null = null;
  for (const r of rows) {
    totalUsd += r.usd;
    if (r.side === 'LONG') longUsd += r.usd; else shortUsd += r.usd;
    if (!largest || r.usd > largest.usd) largest = r;
  }
  return { totalUsd, longUsd, shortUsd, count: rows.length, largest };
}

export function getLiquidationAssetDistribution(sinceTs: number): { symbol: string; usd: number; count: number }[] {
  const database = getDb();
  const rows = database.prepare(
    `SELECT symbol, SUM(usd) as usd, COUNT(*) as count FROM liquidation_events WHERE timestamp >= ? GROUP BY symbol ORDER BY usd DESC`
  ).all(sinceTs) as unknown as { symbol: string; usd: number; count: number }[];
  return rows;
}

export function getLiquidationExchangeDistribution(sinceTs: number): { exchange: string; usd: number; count: number }[] {
  const database = getDb();
  const rows = database.prepare(
    `SELECT exchange, SUM(usd) as usd, COUNT(*) as count FROM liquidation_events WHERE timestamp >= ? GROUP BY exchange ORDER BY usd DESC`
  ).all(sinceTs) as unknown as { exchange: string; usd: number; count: number }[];
  return rows;
}

/** Bucketed totals for the 1H/4H/24H history charts — bucketMs-wide windows ending now. */
export function getLiquidationBuckets(sinceTs: number, bucketMs: number): { bucketStart: number; usd: number; count: number }[] {
  const database = getDb();
  const rows = database.prepare(
    `SELECT timestamp, usd FROM liquidation_events WHERE timestamp >= ? ORDER BY timestamp ASC`
  ).all(sinceTs) as unknown as { timestamp: number; usd: number }[];
  const buckets = new Map<number, { usd: number; count: number }>();
  for (const r of rows) {
    const bucketStart = Math.floor(r.timestamp / bucketMs) * bucketMs;
    const b = buckets.get(bucketStart) || { usd: 0, count: 0 };
    b.usd += r.usd; b.count += 1;
    buckets.set(bucketStart, b);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([bucketStart, v]) => ({ bucketStart, ...v }));
}
