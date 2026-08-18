import { getDb } from '../db.js';
import { ETF_TICKERS } from './tickers.js';
import { ISSUER_ADAPTERS } from './issuers/index.js';
import { fetchLatestClose } from './yahooFinance.js';

function todayDate(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC — fine for a once-daily job
}

interface SnapshotOutcome {
  ticker: string;
  ok: boolean;
  flowUsd: number | null;
  note: string;
}

/** Run once per ticker: fetch today's shares outstanding + NAV, diff against the most recent
 * prior row we ourselves stored, and upsert. First-ever snapshot for a ticker has no prior row
 * to diff against, so fund_flow_usd is NULL that day — this is a real limitation of "we just
 * started collecting," not a bug, and should be surfaced as such rather than showing a fake 0. */
export async function runDailySnapshot(): Promise<SnapshotOutcome[]> {
  const db = getDb();
  const date = todayDate();
  const outcomes: SnapshotOutcome[] = [];

  const selectPrev = db.prepare(
    `SELECT shares_outstanding FROM etf_snapshots WHERE ticker = ? AND date < ? ORDER BY date DESC LIMIT 1`
  );
  const upsert = db.prepare(`
    INSERT INTO etf_snapshots (ticker, date, shares_outstanding, nav_close, fund_flow_usd, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, date) DO UPDATE SET
      shares_outstanding = excluded.shares_outstanding,
      nav_close = excluded.nav_close,
      fund_flow_usd = excluded.fund_flow_usd,
      fetched_at = excluded.fetched_at
  `);

  for (const t of ETF_TICKERS) {
    try {
      const adapter = ISSUER_ADAPTERS[t.issuer];
      const [shares, navResult] = await Promise.all([adapter(t.ticker), fetchLatestClose(t.ticker)]);

      if (shares == null) {
        outcomes.push({ ticker: t.ticker, ok: false, flowUsd: null, note: `${t.issuer} adapter not implemented / couldn't find shares outstanding` });
        continue;
      }
      if (navResult == null) {
        outcomes.push({ ticker: t.ticker, ok: false, flowUsd: null, note: 'Yahoo Finance had no close price' });
        continue;
      }

      const prevRow = selectPrev.get(t.ticker, date) as { shares_outstanding: number } | undefined;
      const flowUsd = prevRow ? (shares - prevRow.shares_outstanding) * navResult.close : null;

      upsert.run(t.ticker, date, shares, navResult.close, flowUsd, Date.now());
      outcomes.push({
        ticker: t.ticker,
        ok: true,
        flowUsd,
        note: prevRow ? 'ok' : 'first snapshot for this ticker — no prior day to diff against yet',
      });
    } catch (err: any) {
      outcomes.push({ ticker: t.ticker, ok: false, flowUsd: null, note: `error: ${err.message}` });
    }
  }

  return outcomes;
}

/** Latest stored flow per ticker, for etf.ts (the SourceResult consumer) — does not fetch
 * anything, just reads whatever runDailySnapshot() last wrote. */
export function getLatestFlows(): { ticker: string; date: string; flowUsd: number | null; navClose: number }[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ticker, date, fund_flow_usd as flowUsd, nav_close as navClose
    FROM etf_snapshots s
    WHERE date = (SELECT MAX(date) FROM etf_snapshots WHERE ticker = s.ticker)
  `).all() as { ticker: string; date: string; flowUsd: number | null; navClose: number }[];
  return rows;
}
