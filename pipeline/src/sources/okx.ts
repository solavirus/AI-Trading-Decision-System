import type { RawItem, SourceResult } from '../types.js';
import { fetchJson } from '../util/http.js';
import { rsi, sma, macdHistogram } from '../util/indicators.js';

/** OKX public market data — fully keyless, used as a fallback when Binance is unreachable
 * (e.g. geo-blocked for the caller's network/region, which a local backend does NOT fix by
 * itself since the outbound request still originates from the same network). */

const OKX_SYMBOLS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'XRP-USDT', 'DOGE-USDT', 'BNB-USDT'] as const;
function toDisplaySymbol(okxSym: string) { return okxSym.replace('-', '/'); }
function toSwapId(okxSym: string) { return okxSym + '-SWAP'; }

interface OkxTicker { instId: string; last: string; open24h: string; high24h: string; low24h: string; vol24h: string }
interface OkxResp<T> { code: string; msg: string; data: T[] }

/** See market.ts's fmtPricePrecise — same fix, sub-$1 assets need more than the default 3
 * max fraction digits or this string (which /api/prices parses back into a number) loses precision. */
function fmtPricePrecise(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

export async function fetchOkxMarket(): Promise<SourceResult> {
  const fetchedAt = Date.now();
  const itemsRaw: RawItem[] = [];
  const errors: string[] = [];

  await Promise.all(
    OKX_SYMBOLS.map(async (sym) => {
      try {
        const res = await fetchJson<OkxResp<OkxTicker>>(`https://www.okx.com/api/v5/market/ticker?instId=${sym}`);
        const t = res.data[0];
        if (!t) throw new Error('empty data');
        const last = parseFloat(t.last), open = parseFloat(t.open24h);
        const changePct = open > 0 ? ((last - open) / open) * 100 : 0;
        itemsRaw.push({
          id: sym,
          label: toDisplaySymbol(sym),
          value: `${fmtPricePrecise(last)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`,
          polarity: changePct > 0.05 ? 'bullish' : changePct < -0.05 ? 'bearish' : 'neutral',
          detail: `24h 区间 ${fmtPricePrecise(parseFloat(t.low24h))} - ${fmtPricePrecise(parseFloat(t.high24h))}，成交量 ${parseFloat(t.vol24h).toFixed(0)}（来源：OKX）`,
          timestamp: fetchedAt,
        });
      } catch (err: any) {
        errors.push(`${sym}: ${err.message}`);
      }
    })
  );

  if (itemsRaw.length === 0) return { key: 'market', status: 'error', fetchedAt, itemsRaw: [], note: `okx failed too: ${errors.join('; ')}` };
  return { key: 'market', status: 'ok', fetchedAt, itemsRaw, note: `provider: OKX (fallback)${errors.length ? `; partial: ${errors.join('; ')}` : ''}` };
}

export async function fetchOkxTechnical(): Promise<SourceResult> {
  const fetchedAt = Date.now();
  const itemsRaw: RawItem[] = [];
  const errors: string[] = [];

  await Promise.all(
    OKX_SYMBOLS.map(async (sym) => {
      try {
        const res = await fetchJson<OkxResp<string[]>>(`https://www.okx.com/api/v5/market/candles?instId=${sym}&bar=1H&limit=100`);
        // OKX returns newest-first; closes need oldest-first for the indicator math.
        const closes = res.data.map((k) => parseFloat(k[4])).reverse();
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
          id: `${sym}-technical`,
          label: `${toDisplaySymbol(sym)} 技术面`,
          value: `${trendUp ? '价格高于' : '价格低于'} SMA50，RSI ${r?.toFixed(1) ?? 'N/A'}`,
          polarity,
          detail: `MACD 柱${macdUp ? '为正' : '为负'}${rsiOverbought ? '，RSI 显示超买' : rsiOversold ? '，RSI 显示超卖' : ''}（来源：OKX K线，程序本地计算）`,
          timestamp: fetchedAt,
        });
      } catch (err: any) {
        errors.push(`${sym}: ${err.message}`);
      }
    })
  );

  if (itemsRaw.length === 0) return { key: 'technical', status: 'error', fetchedAt, itemsRaw: [], note: `okx failed too: ${errors.join('; ')}` };
  return { key: 'technical', status: 'ok', fetchedAt, itemsRaw, note: `provider: OKX (fallback)${errors.length ? `; partial: ${errors.join('; ')}` : ''}` };
}

interface OkxFundingRate { instId: string; fundingRate: string }
interface OkxOpenInterest { instId: string; oiUsd: string }

export async function fetchOkxDerivatives(): Promise<SourceResult> {
  const fetchedAt = Date.now();
  const itemsRaw: RawItem[] = [];
  const errors: string[] = [];

  await Promise.all(
    OKX_SYMBOLS.map(async (sym) => {
      const swapId = toSwapId(sym);
      try {
        const [fundingRes, oiRes, lsRes] = await Promise.all([
          fetchJson<OkxResp<OkxFundingRate>>(`https://www.okx.com/api/v5/public/funding-rate?instId=${swapId}`),
          fetchJson<OkxResp<OkxOpenInterest>>(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${swapId}`),
          fetchJson<OkxResp<[string, string]>>(`https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio-contract?instId=${swapId}&period=1H`),
        ]);
        const rate = fundingRes.data[0] ? parseFloat(fundingRes.data[0].fundingRate) * 100 : null;
        const oiUsd = oiRes.data[0] ? parseFloat(oiRes.data[0].oiUsd) : null;
        const ratio = lsRes.data[0] ? parseFloat(lsRes.data[0][1]) : null;
        const polarity: RawItem['polarity'] = rate === null ? 'neutral' : rate > 0.005 ? 'bullish' : rate < -0.005 ? 'bearish' : 'neutral';

        itemsRaw.push({
          id: `${sym}-derivatives`,
          label: `${toDisplaySymbol(sym)} 资金费率/持仓量`,
          value: `资金费率 ${rate !== null ? rate.toFixed(4) + '%' : 'N/A'}，多空账户比 ${ratio?.toFixed(2) ?? 'N/A'}`,
          polarity,
          detail: `未平仓合约 ${oiUsd !== null ? oiUsd.toLocaleString('en-US') + ' USD' : 'N/A'}（来源：OKX）`,
          timestamp: fetchedAt,
        });
      } catch (err: any) {
        errors.push(`${sym}: ${err.message}`);
      }
    })
  );

  if (itemsRaw.length === 0) return { key: 'derivatives', status: 'error', fetchedAt, itemsRaw: [], note: `okx failed too: ${errors.join('; ')}` };
  return { key: 'derivatives', status: 'ok', fetchedAt, itemsRaw, note: `provider: OKX (fallback)${errors.length ? `; partial: ${errors.join('; ')}` : ''}` };
}
