import type { RawTicker24h, RawKline } from '../connectors/types.js';

/** DATA_SOURCE_SPEC.md's normalized "Market Snapshot" — every field named/typed, timestamp+
 * source+symbol+status present on every one. This is what gets persisted to the snapshots table
 * and what any future AI/Research layer should read, never the raw connector response. */
export interface MarketSnapshot {
  source: string;
  symbol: string;
  timestamp: number;
  status: 'ok';
  price: number;
  changePct24h: number;
  volume24h: number;
  quoteVolume24h: number;
  high24h: number;
  low24h: number;
  bestBid: number | null;
  bestAsk: number | null;
}

export function normalizeMarketSnapshot(source: string, t: RawTicker24h, timestamp: number): MarketSnapshot {
  return {
    source,
    symbol: t.symbol,
    timestamp,
    status: 'ok',
    price: t.lastPrice,
    changePct24h: t.priceChangePercent,
    volume24h: t.volume,
    quoteVolume24h: t.quoteVolume,
    high24h: t.highPrice,
    low24h: t.lowPrice,
    bestBid: t.bestBid,
    bestAsk: t.bestAsk,
  };
}

/** Rolling stdev of log returns over `window` candles, as a percentage — computed locally from
 * klines per DATA_SOURCE_SPEC.md's "Technical" rule (never request indicators from an API),
 * applied here to Market's own Volatility chart for the same reason. */
export function computeVolatilitySeries(klines: RawKline[], window = 14): { time: number; value: number }[] {
  if (klines.length <= window) return [];
  const rets: number[] = [];
  for (let i = 1; i < klines.length; i++) rets.push(Math.log(klines[i].close / klines[i - 1].close));
  const series: { time: number; value: number }[] = [];
  for (let i = window; i < klines.length; i++) {
    const windowRets = rets.slice(i - window, i);
    const mean = windowRets.reduce((a, b) => a + b, 0) / windowRets.length;
    const variance = windowRets.reduce((a, b) => a + (b - mean) ** 2, 0) / windowRets.length;
    series.push({ time: klines[i].openTime, value: Math.sqrt(variance) * 100 });
  }
  return series;
}
