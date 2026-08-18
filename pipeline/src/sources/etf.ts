import type { RawItem, SourceResult } from '../types.js';
import { getLatestFlows } from '../etf/snapshot.js';
import { ETF_TICKERS } from '../etf/tickers.js';
import { fetchXoomar } from '../util/xoomar.js';

/** Farside Investors is behind a Cloudflare bot challenge (confirmed 2026-08-05, ruled out
 * deliberately rather than attempting to defeat it). Two sources instead, merged by ticker:
 * 1. Our own SQLite DB (src/db.ts) — daily {shares outstanding, NAV} snapshots via
 *    `npm run etf:snapshot` (Windows Task Scheduler), flow = Δshares × NAV. Currently only
 *    iShares' adapter works (IBIT).
 * 2. Xoomar's /etf-flows endpoint (free, keyless) — covers different tickers (BITB, ETHW as of
 *    2026-08-05) than our own DB currently does, so it's additive, not a replacement. Its
 *    flowUsd has been null for every ticker so far; when present we show it, when null we say so
 *    honestly rather than showing 0. */
interface XoomarEtfFlow {
  date: string; ticker: string; issuer: string; asset: string;
  holdings: string; flowUsd: number | null; aumUsd: string;
}
interface XoomarEtfResp { data: XoomarEtfFlow[] }

async function fetchXoomarEtfItems(fetchedAt: number, excludeTickers: Set<string>): Promise<{ items: RawItem[]; error?: string }> {
  try {
    const res = await fetchXoomar<XoomarEtfResp>('/etf-flows');
    const items: RawItem[] = res.data
      .filter((row) => !excludeTickers.has(row.ticker))
      .map((row) => {
        const aum = parseFloat(row.aumUsd);
        if (row.flowUsd == null) {
          return {
            id: row.ticker,
            label: row.ticker,
            value: '暂无流量数据',
            polarity: 'neutral' as const,
            detail: `${row.issuer} · ${row.date} · AUM ${(aum / 1e6).toFixed(1)}M USD · 来源：Xoomar`,
            timestamp: fetchedAt,
          };
        }
        const flowM = row.flowUsd / 1e6;
        return {
          id: row.ticker,
          label: `${row.ticker} 资金流`,
          value: `${flowM >= 0 ? '+' : ''}${flowM.toFixed(2)}M USD`,
          polarity: flowM > 0 ? ('bullish' as const) : flowM < 0 ? ('bearish' as const) : ('neutral' as const),
          detail: `${row.issuer} · ${row.date} · 来源：Xoomar`,
          timestamp: fetchedAt,
        };
      });
    return { items };
  } catch (err: any) {
    return { items: [], error: err.message };
  }
}

export async function fetchEtf(): Promise<SourceResult> {
  const fetchedAt = Date.now();
  const rows = getLatestFlows();
  const itemsRaw: RawItem[] = [];
  const notes: string[] = [];

  for (const row of rows) {
    const meta = ETF_TICKERS.find((t) => t.ticker === row.ticker);
    if (row.flowUsd == null) {
      itemsRaw.push({
        id: row.ticker,
        label: row.ticker,
        value: '暂无流量数据（首次快照）',
        polarity: 'neutral',
        detail: `${meta ? meta.name + ' · ' : ''}${row.date} · NAV(收盘价代理) ${row.navClose.toLocaleString('en-US')}`,
        timestamp: fetchedAt,
      });
      continue;
    }
    const flowM = row.flowUsd / 1e6;
    itemsRaw.push({
      id: row.ticker,
      label: `${row.ticker} 资金流`,
      value: `${flowM >= 0 ? '+' : ''}${flowM.toFixed(2)}M USD`,
      polarity: flowM > 0 ? 'bullish' : flowM < 0 ? 'bearish' : 'neutral',
      detail: `${meta ? meta.name + ' · ' : ''}${row.date} · 按 Δ持仓份额 × 收盘价(NAV代理) 计算`,
      timestamp: fetchedAt,
    });
  }
  if (rows.length === 0) {
    notes.push('本地数据库还没有快照——先跑一次 npm run etf:snapshot');
  }

  const xoomar = await fetchXoomarEtfItems(fetchedAt, new Set(rows.map((r) => r.ticker)));
  if (xoomar.error) notes.push(`Xoomar etf-flows 获取失败: ${xoomar.error}`);
  else itemsRaw.push(...xoomar.items);

  const coveredTickers = new Set(itemsRaw.map((i) => i.id));
  const missingTickers = ETF_TICKERS.filter((t) => !coveredTickers.has(t.ticker));
  if (missingTickers.length) {
    notes.push(`${missingTickers.map((t) => t.ticker).join('/')} 还没有份额数据源（见 src/etf/issuers/）`);
  }

  if (itemsRaw.length === 0) {
    return { key: 'etf', status: 'stub', fetchedAt, itemsRaw: [], note: notes.join('; ') };
  }
  return { key: 'etf', status: 'ok', fetchedAt, itemsRaw, note: notes.length ? notes.join('; ') : undefined };
}
