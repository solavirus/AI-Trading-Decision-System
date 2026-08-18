import type { RawItem, SourceResult } from '../types.js';
import { fetchJson } from '../util/http.js';
import { SYMBOLS } from './assets.js';
import { fetchOkxMarket } from './okx.js';
import { binanceMarketConnector } from '../connectors/binanceMarketConnector.js';
import { normalizeMarketSnapshot } from '../normalize/market.js';
import { insertSnapshot } from '../db.js';

/** Binance first; if that fails outright (including geo-block, which looks like any other
 * network error here — a local backend doesn't fix geo-blocking, only CORS), fall back to OKX. */
export async function fetchMarket(): Promise<SourceResult> {
  const binanceResult = await fetchBinanceMarket();
  if (binanceResult.status === 'ok') return binanceResult;
  const okxResult = await fetchOkxMarket();
  if (okxResult.status === 'ok') return okxResult;
  return { ...binanceResult, note: `binance failed (${binanceResult.note}); okx fallback also failed (${okxResult.note})` };
}

/** maximumFractionDigits-only (no minimum) shows the real precision without padding zeros —
 * plain toLocaleString() defaults to 3 max fraction digits, which silently rounds sub-$1 assets
 * like DOGE (0.06999 -> "0.07"). That was harmless as a display string until /api/prices in
 * server.ts started parsing it back into a number the prototype uses for actual P&L math. */
function fmtPricePrecise(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

interface CoinGeckoGlobalResp {
  data: { total_market_cap: { usd: number }; market_cap_change_percentage_24h_usd: number };
}

/** Free, keyless: CoinGecko's global endpoint. Used only for the prototype's header "TOTAL MKT
 * CAP" ticker, not one of the 11 dashboard SourceResult cards — kept separate from
 * fetchMarket()/fetchBinanceMarket() above since it's a different concern (whole-market
 * aggregate, not per-symbol). */
export async function fetchGlobalMarketCap(): Promise<{ totalUsd: number; changePct24h: number }> {
  const res = await fetchJson<CoinGeckoGlobalResp>('https://api.coingecko.com/api/v3/global');
  return { totalUsd: res.data.total_market_cap.usd, changePct24h: res.data.market_cap_change_percentage_24h_usd };
}

/** DATA_SOURCE_SPEC.md's Connector → Normalize → Snapshot pipeline, applied to Market first as
 * the reference implementation other modules will copy. The SourceResult/RawItem contract below
 * is unchanged (server.ts's /api/prices regex-parses item.value) — normalization/persistence is
 * additive, not a replacement for the existing dashboard-card path. */
async function fetchBinanceMarket(): Promise<SourceResult> {
  const fetchedAt = Date.now();
  try {
    const tickers = await binanceMarketConnector.fetchTicker24h([...SYMBOLS]);

    const itemsRaw: RawItem[] = tickers.map((t) => {
      const changePct = t.priceChangePercent;
      const snapshot = normalizeMarketSnapshot(binanceMarketConnector.name, t, fetchedAt);
      insertSnapshot('market', t.symbol, fetchedAt, 'ok', snapshot);
      return {
        id: t.symbol,
        label: t.symbol.replace('USDT', '/USDT'),
        value: `${fmtPricePrecise(t.lastPrice)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`,
        polarity: changePct > 0.05 ? 'bullish' : changePct < -0.05 ? 'bearish' : 'neutral',
        detail: `24h 区间 ${fmtPricePrecise(t.lowPrice)} - ${fmtPricePrecise(t.highPrice)}，成交量 ${t.volume.toFixed(0)}`,
        sourceUrl: `https://www.binance.com/en/trade/${t.symbol}`,
        timestamp: fetchedAt,
      };
    });

    return { key: 'market', status: 'ok', fetchedAt, itemsRaw };
  } catch (err: any) {
    return { key: 'market', status: 'error', fetchedAt, itemsRaw: [], note: `fetch failed: ${err.message}` };
  }
}
