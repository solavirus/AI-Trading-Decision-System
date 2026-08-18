import { fetchJson } from '../util/http.js';
import type { MarketConnector, RawTicker24h, RawKline } from './types.js';

interface BinanceTicker24hrRaw {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
}
interface BinanceBookTickerRaw {
  symbol: string;
  bidPrice: string;
  askPrice: string;
}

export const binanceMarketConnector: MarketConnector = {
  name: 'binance',

  async fetchTicker24h(symbols: string[]): Promise<RawTicker24h[]> {
    const symbolsParam = encodeURIComponent(JSON.stringify(symbols));
    const [tickers, bookTickers] = await Promise.all([
      fetchJson<BinanceTicker24hrRaw[]>(`https://api.binance.com/api/v3/ticker/24hr?symbols=${symbolsParam}`),
      fetchJson<BinanceBookTickerRaw[]>(`https://api.binance.com/api/v3/ticker/bookTicker?symbols=${symbolsParam}`),
    ]);
    const bookBySymbol = new Map(bookTickers.map((b) => [b.symbol, b]));
    return tickers.map((t) => {
      const book = bookBySymbol.get(t.symbol);
      return {
        symbol: t.symbol,
        lastPrice: parseFloat(t.lastPrice),
        priceChangePercent: parseFloat(t.priceChangePercent),
        highPrice: parseFloat(t.highPrice),
        lowPrice: parseFloat(t.lowPrice),
        volume: parseFloat(t.volume),
        quoteVolume: parseFloat(t.quoteVolume),
        bestBid: book ? parseFloat(book.bidPrice) : null,
        bestAsk: book ? parseFloat(book.askPrice) : null,
      };
    });
  },

  async fetchKlines(symbol: string, interval: string, limit: number): Promise<RawKline[]> {
    const raw = await fetchJson<any[][]>(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
    );
    return raw.map((k) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
    }));
  },
};
