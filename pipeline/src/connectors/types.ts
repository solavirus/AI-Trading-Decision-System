/** DATA_SOURCE_SPEC.md: "All connectors should implement the same interface. Dashboard should
 * never depend on a specific provider." Only a Binance implementation exists so far (see
 * binanceMarketConnector.ts) — this interface is what a future OKX/Bybit market connector would
 * also implement, so sources/market.ts never needs to know which provider it's talking to. */
export interface RawTicker24h {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  quoteVolume: number;
  bestBid: number | null;
  bestAsk: number | null;
}

export interface RawKline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface MarketConnector {
  name: string;
  fetchTicker24h(symbols: string[]): Promise<RawTicker24h[]>;
  fetchKlines(symbol: string, interval: string, limit: number): Promise<RawKline[]>;
}
