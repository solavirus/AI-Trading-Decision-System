import type { RawItem, SourceResult } from '../types.js';
import { fetchJson } from '../util/http.js';
import { fetchXoomar } from '../util/xoomar.js';
import { translateToZh } from '../util/translate.js';

interface FredObservation { date: string; value: string }
interface FredResp { observations: FredObservation[] }

const SERIES: { id: string; label: string }[] = [
  { id: 'CPIAUCSL', label: '美国 CPI（季调）' },
  { id: 'FEDFUNDS', label: '联邦基金利率' },
];

async function fetchSeries(seriesId: string, apiKey: string): Promise<FredObservation[]> {
  const res = await fetchJson<FredResp>(
    `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=2`
  );
  return res.observations;
}

interface CalendarEvent {
  source: string;
  eventName: string;
  importance: 'high' | 'med' | 'low';
  scheduledAt: string;
  periodLabel: string | null;
}
interface CalendarResp { data: CalendarEvent[] }

const IMPORTANCE_CN: Record<string, string> = { high: '高影响', med: '中影响', low: '低影响' };

/** A fixed, small vocabulary of recurring US macro calendar events — instant and reliable,
 * checked before falling back to the translate API for anything not in this list (new/unusual
 * event names still get a best-effort translation rather than staying in English). */
const EVENT_NAME_CN: Record<string, string> = {
  'FOMC Rate Decision': '联邦公开市场委员会（FOMC）利率决议',
  'Nonfarm Payrolls (Employment Situation)': '非农就业报告',
  'CPI (Consumer Price Index)': 'CPI（消费者物价指数）',
  'PPI (Producer Price Index)': 'PPI（生产者物价指数）',
  'GDP (Second Estimate) and Corporate Profits': 'GDP（第二次估算）及企业利润',
  'GDP (Advance Estimate)': 'GDP（初步估算）',
  'Retail Sales': '零售销售',
  'Initial Jobless Claims': '初请失业金人数',
  'PCE (Personal Consumption Expenditures)': 'PCE（个人消费支出物价指数）',
  'ISM Manufacturing PMI': 'ISM 制造业 PMI',
  'ISM Services PMI': 'ISM 服务业 PMI',
  'Fed Chair Speech': '美联储主席讲话',
};

function translateEventName(eventName: string): Promise<string> {
  const staticHit = Object.keys(EVENT_NAME_CN).find((k) => eventName.startsWith(k));
  if (staticHit) return Promise.resolve(EVENT_NAME_CN[staticHit] + eventName.slice(staticHit.length));
  return translateToZh(eventName);
}

/** Economic calendar via Xoomar (xoomar.com/developers) — verified 2026-08-05 against known
 * real-world FOMC/CPI/NFP dates, looked plausible. This is a DIFFERENT endpoint from Xoomar's
 * liquidations one (deliberately not used elsewhere, see util/xoomar.ts) — don't assume this
 * validates their whole API, just this specific endpoint. */
async function fetchCalendarItems(fetchedAt: number): Promise<{ items: RawItem[]; error?: string }> {
  try {
    const res = await fetchXoomar<CalendarResp>('/calendar');
    const events = res.data.slice(0, 6);
    const namesZh = await Promise.all(events.map((e) => translateEventName(e.eventName)));
    const items: RawItem[] = events.map((e, i) => ({
      id: `cal-${i}`,
      label: namesZh[i],
      value: `${new Date(e.scheduledAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}（${IMPORTANCE_CN[e.importance] || e.importance}）`,
      polarity: 'neutral',
      detail: e.periodLabel ? `统计周期：${e.periodLabel}` : undefined,
      timestamp: fetchedAt,
    }));
    return { items };
  } catch (err: any) {
    return { items: [], error: err.message };
  }
}

/** CPI/Fed funds rate needs a free self-serve FRED_API_KEY; the economic calendar (event
 * dates/importance) comes from Xoomar instead — FRED doesn't offer that, and no other free
 * source was found (see pipeline/README.md). The two are independent: either can be missing
 * without blocking the other. */
export async function fetchMacro(): Promise<SourceResult> {
  const fetchedAt = Date.now();
  const fredKey = process.env.FRED_API_KEY;
  const itemsRaw: RawItem[] = [];
  const notes: string[] = [];

  if (fredKey) {
    try {
      for (const s of SERIES) {
        const obs = await fetchSeries(s.id, fredKey);
        const [latest, prev] = obs;
        if (!latest) continue;
        const latestVal = parseFloat(latest.value);
        const prevVal = prev ? parseFloat(prev.value) : null;
        const changed = prevVal !== null ? latestVal - prevVal : null;
        itemsRaw.push({
          id: s.id,
          label: s.label,
          value: `${latestVal}（${latest.date}）`,
          polarity: 'neutral',
          detail: changed !== null ? `较上期 ${changed >= 0 ? '+' : ''}${changed.toFixed(2)}` : undefined,
          sourceUrl: `https://fred.stlouisfed.org/series/${s.id}`,
          timestamp: fetchedAt,
        });
      }
    } catch (err: any) {
      notes.push(`FRED fetch failed: ${err.message}`);
    }
  } else {
    notes.push('CPI/利率数据需要免费 FRED_API_KEY（https://fred.stlouisfed.org/docs/api/api_key.html）');
  }

  const cal = await fetchCalendarItems(fetchedAt);
  if (cal.error) notes.push(`经济日历（Xoomar）获取失败: ${cal.error}`);
  else itemsRaw.push(...cal.items);

  if (itemsRaw.length === 0) {
    return { key: 'macro', status: 'stub', fetchedAt, itemsRaw: [], note: notes.join('; ') };
  }
  return { key: 'macro', status: 'ok', fetchedAt, itemsRaw, note: notes.length ? notes.join('; ') : undefined };
}
