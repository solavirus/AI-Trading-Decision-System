import type { RawItem, SourceResult } from '../types.js';
import { fetchJson } from '../util/http.js';

interface PeggedAsset {
  name: string;
  symbol: string;
  circulating?: { peggedUSD?: number };
  circulatingPrevDay?: { peggedUSD?: number };
}
interface StablecoinsResp { peggedAssets: PeggedAsset[] }

/** Free, keyless: DefiLlama stablecoins API. */
export async function fetchStablecoin(): Promise<SourceResult> {
  const fetchedAt = Date.now();
  try {
    const res = await fetchJson<StablecoinsResp>('https://stablecoins.llama.fi/stablecoins?includePrices=false');
    const assets = res.peggedAssets.filter((a) => a.circulating?.peggedUSD);

    const totalNow = assets.reduce((s, a) => s + (a.circulating!.peggedUSD || 0), 0);
    const totalPrev = assets.reduce((s, a) => s + (a.circulatingPrevDay?.peggedUSD || 0), 0);
    const totalChangePct = totalPrev > 0 ? ((totalNow - totalPrev) / totalPrev) * 100 : 0;

    const itemsRaw: RawItem[] = [
      {
        id: 'stablecoin-total',
        label: '稳定币总市值',
        value: `${(totalNow / 1e9).toFixed(2)}B USD（24h ${totalChangePct >= 0 ? '+' : ''}${totalChangePct.toFixed(2)}%）`,
        polarity: totalChangePct > 0.1 ? 'bullish' : totalChangePct < -0.1 ? 'bearish' : 'neutral',
        detail: '总市值扩张常被解读为场外资金流入待入场；收缩则相反',
        timestamp: fetchedAt,
      },
    ];

    const top = [...assets].sort((a, b) => (b.circulating!.peggedUSD || 0) - (a.circulating!.peggedUSD || 0)).slice(0, 3);
    for (const a of top) {
      const now = a.circulating!.peggedUSD || 0;
      const prev = a.circulatingPrevDay?.peggedUSD || 0;
      const changePct = prev > 0 ? ((now - prev) / prev) * 100 : 0;
      itemsRaw.push({
        id: `stablecoin-${a.symbol}`,
        label: `${a.symbol} 流通量`,
        value: `${(now / 1e9).toFixed(2)}B USD（24h ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%）`,
        polarity: changePct > 0.1 ? 'bullish' : changePct < -0.1 ? 'bearish' : 'neutral',
        timestamp: fetchedAt,
      });
    }

    return { key: 'stablecoin', status: 'ok', fetchedAt, itemsRaw };
  } catch (err: any) {
    return { key: 'stablecoin', status: 'error', fetchedAt, itemsRaw: [], note: `fetch failed: ${err.message}` };
  }
}
