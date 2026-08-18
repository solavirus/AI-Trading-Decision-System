import type { RawItem, SourceResult } from '../types.js';
import { fetchJson } from '../util/http.js';

interface FngResponse {
  data: { value: string; value_classification: string; timestamp: string }[];
}

const FNG_LABEL_CN: Record<string, string> = {
  'Extreme Fear': '极度恐惧', 'Fear': '恐惧', 'Neutral': '中性', 'Greed': '贪婪', 'Extreme Greed': '极度贪婪',
};

/** Free, keyless: alternative.me Fear & Greed Index (market-wide, not per-asset). */
export async function fetchSentiment(): Promise<SourceResult> {
  const fetchedAt = Date.now();
  try {
    const res = await fetchJson<FngResponse>('https://api.alternative.me/fng/?limit=2');
    const [today, yesterday] = res.data;
    const value = parseInt(today.value, 10);
    const polarity: RawItem['polarity'] = value >= 55 ? 'bullish' : value <= 45 ? 'bearish' : 'neutral';
    const label = (v: string) => FNG_LABEL_CN[v] || v;

    const itemsRaw: RawItem[] = [
      {
        id: 'fng-today',
        label: '恐惧与贪婪指数',
        value: `${value}（${label(today.value_classification)}）`,
        polarity,
        detail: yesterday ? `昨日 ${yesterday.value}（${label(yesterday.value_classification)}）` : undefined,
        sourceUrl: 'https://alternative.me/crypto/fear-and-greed-index/',
        timestamp: fetchedAt,
      },
    ];
    return { key: 'sentiment', status: 'ok', fetchedAt, itemsRaw };
  } catch (err: any) {
    return { key: 'sentiment', status: 'error', fetchedAt, itemsRaw: [], note: `fetch failed: ${err.message}` };
  }
}
