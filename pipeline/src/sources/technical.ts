import type { RawItem, SourceResult } from '../types.js';
import { fetchJson } from '../util/http.js';
import { SYMBOLS } from './assets.js';
import { rsi, sma, macdHistogram } from '../util/indicators.js';
import { fetchOkxTechnical } from './okx.js';

type Kline = [number, string, string, string, string, string, ...unknown[]];

/** Binance first, OKX fallback if Binance is unreachable (see market.ts for why). */
export async function fetchTechnical(): Promise<SourceResult> {
  const binanceResult = await fetchBinanceTechnical();
  if (binanceResult.status === 'ok') return binanceResult;
  const okxResult = await fetchOkxTechnical();
  if (okxResult.status === 'ok') return okxResult;
  return { ...binanceResult, note: `binance failed (${binanceResult.note}); okx fallback also failed (${okxResult.note})` };
}

async function fetchBinanceTechnical(): Promise<SourceResult> {
  const fetchedAt = Date.now();
  const itemsRaw: RawItem[] = [];
  const errors: string[] = [];

  await Promise.all(
    SYMBOLS.map(async (symbol) => {
      try {
        const klines = await fetchJson<Kline[]>(
          `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=100`
        );
        const closes = klines.map((k) => parseFloat(k[4]));
        const lastClose = closes[closes.length - 1];
        const sma50 = sma(closes, 50);
        const r = rsi(closes, 14);
        const macdHist = macdHistogram(closes);

        const trendUp = sma50 !== null && lastClose > sma50;
        const macdUp = macdHist !== null && macdHist > 0;
        const rsiOverbought = r !== null && r >= 70;
        const rsiOversold = r !== null && r <= 30;

        let polarity: RawItem['polarity'] = 'neutral';
        if (trendUp && macdUp && !rsiOverbought) polarity = 'bullish';
        else if (!trendUp && !macdUp && !rsiOversold) polarity = 'bearish';

        itemsRaw.push({
          id: `${symbol}-technical`,
          label: `${symbol.replace('USDT', '/USDT')} 技术面`,
          value: `${trendUp ? '价格高于' : '价格低于'} SMA50，RSI ${r?.toFixed(1) ?? 'N/A'}`,
          polarity,
          detail: `MACD 柱${macdUp ? '为正' : '为负'}${rsiOverbought ? '，RSI 显示超买' : rsiOversold ? '，RSI 显示超卖' : ''}（100根1H K线计算，程序本地计算，未调用第三方指标API）`,
          timestamp: fetchedAt,
        });
      } catch (err: any) {
        errors.push(`${symbol}: ${err.message}`);
      }
    })
  );

  if (itemsRaw.length === 0) {
    return { key: 'technical', status: 'error', fetchedAt, itemsRaw: [], note: errors.join('; ') };
  }
  return { key: 'technical', status: 'ok', fetchedAt, itemsRaw, note: errors.length ? `partial: ${errors.join('; ')}` : undefined };
}
