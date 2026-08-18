import type { RawItem, SourceResult } from '../types.js';
import { fetchJson } from '../util/http.js';
import { SYMBOLS } from './assets.js';
import { fetchOkxDerivatives } from './okx.js';

interface FundingRateEntry { symbol: string; fundingRate: string; fundingTime: number }
interface OpenInterestResp { symbol: string; openInterest: string }
interface LongShortRatioEntry { longAccount: string; shortAccount: string; longShortRatio: string; timestamp: number }

/** Binance first, OKX fallback if Binance is unreachable (see market.ts for why). */
export async function fetchDerivatives(): Promise<SourceResult> {
  const binanceResult = await fetchBinanceDerivatives();
  if (binanceResult.status === 'ok') return binanceResult;
  const okxResult = await fetchOkxDerivatives();
  if (okxResult.status === 'ok') return okxResult;
  return { ...binanceResult, note: `binance failed (${binanceResult.note}); okx fallback also failed (${okxResult.note})` };
}

async function fetchBinanceDerivatives(): Promise<SourceResult> {
  const fetchedAt = Date.now();
  const itemsRaw: RawItem[] = [];
  const errors: string[] = [];

  await Promise.all(
    SYMBOLS.map(async (symbol) => {
      try {
        const [funding, oi, lsRatio] = await Promise.all([
          fetchJson<FundingRateEntry[]>(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`),
          fetchJson<OpenInterestResp>(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`),
          fetchJson<LongShortRatioEntry[]>(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`),
        ]);

        const rate = funding[0] ? parseFloat(funding[0].fundingRate) * 100 : null;
        const ratio = lsRatio[0] ? parseFloat(lsRatio[0].longShortRatio) : null;
        const polarity: RawItem['polarity'] = rate === null ? 'neutral' : rate > 0.005 ? 'bullish' : rate < -0.005 ? 'bearish' : 'neutral';

        itemsRaw.push({
          id: `${symbol}-derivatives`,
          label: `${symbol.replace('USDT', '/USDT')} 资金费率/持仓量`,
          value: `资金费率 ${rate !== null ? rate.toFixed(4) + '%' : 'N/A'}，多空账户比 ${ratio?.toFixed(2) ?? 'N/A'}`,
          polarity,
          detail: `未平仓合约 ${parseFloat(oi.openInterest).toLocaleString('en-US')}（正费率=多头占优但存在拥挤风险，负费率=空头占优）`,
          timestamp: fetchedAt,
        });
      } catch (err: any) {
        errors.push(`${symbol}: ${err.message}`);
      }
    })
  );

  if (itemsRaw.length === 0) {
    return { key: 'derivatives', status: 'error', fetchedAt, itemsRaw: [], note: errors.join('; ') };
  }
  return { key: 'derivatives', status: 'ok', fetchedAt, itemsRaw, note: errors.length ? `partial: ${errors.join('; ')}` : undefined };
}
