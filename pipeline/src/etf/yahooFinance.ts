import { fetchJson } from '../util/http.js';

interface YahooChartResp {
  chart: {
    result: [{
      meta: { regularMarketPrice: number; regularMarketTime: number };
      timestamp: number[];
      indicators: { quote: [{ close: (number | null)[] }] };
    }] | null;
    error: unknown;
  };
}

/** Latest close price for a ticker, used as a practical NAV proxy for flow calculations — actual
 * fund NAV can differ from market close by a small premium/discount, but ETF creation/redemption
 * arbitrage keeps them close, and this is the same approximation most public flow trackers use.
 * Not the official yfinance Python library — this calls the same underlying Yahoo endpoint
 * directly from Node so the whole pipeline stays one runtime (per project decision 2026-08-05). */
export async function fetchLatestClose(ticker: string): Promise<{ close: number; asOf: number } | null> {
  const res = await fetchJson<YahooChartResp>(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  const result = res.chart.result?.[0];
  if (!result) return null;
  const closes = result.indicators.quote[0].close;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] != null) return { close: closes[i]!, asOf: result.timestamp[i] * 1000 };
  }
  return null;
}
