import { binanceMarketConnector } from '../connectors/binanceMarketConnector.js';
import { computeVolatilitySeries } from '../normalize/market.js';
import { getSnapshotHistory } from '../db.js';

export interface MarketDetail {
  symbol: string;
  overview: {
    symbol: string;
    price: number;
    changePct24h: number;
    volume24h: number;
    quoteVolume24h: number;
    high24h: number;
    low24h: number;
    bestBid: number | null;
    bestAsk: number | null;
    timestamp: number;
  };
  klines: { openTime: number; open: number; high: number; low: number; close: number; volume: number }[];
  volatility: { time: number; value: number }[];
  snapshotHistory: { timestamp: number; status: string; data: unknown }[];
}

/** DATA_SOURCE_SPEC.md's per-module "Detail Page": Overview → Historical Charts → Statistics →
 * Latest Updates → Raw Values. Candlestick/Volume come straight from Binance klines (real
 * historical OHLCV is already there, no need to wait for our own polling to accumulate it);
 * Volatility is computed locally from those same klines; snapshotHistory is our own
 * self-collected series (grows from whenever this server started persisting snapshots, same
 * "honest, not backfilled" pattern as the ETF snapshot DB). */
export async function getMarketDetail(symbol: string, interval = '1h', limit = 100): Promise<MarketDetail> {
  const [tickers, klines] = await Promise.all([
    binanceMarketConnector.fetchTicker24h([symbol]),
    binanceMarketConnector.fetchKlines(symbol, interval, limit),
  ]);
  const t = tickers[0];
  if (!t) throw new Error(`no ticker data for symbol ${symbol}`);

  const snapshotRows = getSnapshotHistory('market', symbol, 200);

  return {
    symbol,
    overview: {
      symbol: t.symbol,
      price: t.lastPrice,
      changePct24h: t.priceChangePercent,
      volume24h: t.volume,
      quoteVolume24h: t.quoteVolume,
      high24h: t.highPrice,
      low24h: t.lowPrice,
      bestBid: t.bestBid,
      bestAsk: t.bestAsk,
      timestamp: Date.now(),
    },
    klines: klines.map((k) => ({ openTime: k.openTime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })),
    volatility: computeVolatilitySeries(klines),
    snapshotHistory: snapshotRows.map((r) => ({ timestamp: r.timestamp, status: r.status, data: JSON.parse(r.data) })),
  };
}
