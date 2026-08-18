import type { RawItem, SourceResult } from '../types.js';
import { fetchJson } from '../util/http.js';

interface DeribitInstrument {
  instrument_name: string; // e.g. BTC-28AUG26-110000-P
  mark_iv?: number;
  open_interest: number;
}
interface DeribitResp { result: DeribitInstrument[] }

function parseStrikeAndSide(instrumentName: string): { strike: number; side: 'C' | 'P' } | null {
  const parts = instrumentName.split('-');
  if (parts.length !== 4) return null;
  const strike = parseFloat(parts[2]);
  const side = parts[3] as 'C' | 'P';
  if (isNaN(strike) || (side !== 'C' && side !== 'P')) return null;
  return { strike, side };
}

async function fetchForCurrency(currency: 'BTC' | 'ETH', fetchedAt: number): Promise<RawItem[]> {
  const res = await fetchJson<DeribitResp>(
    `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`
  );
  const instruments = res.result;

  const ivs = instruments.map((i) => i.mark_iv).filter((v): v is number => typeof v === 'number' && v > 0);
  const avgIv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;

  const oiByStrike = new Map<number, { put: number; call: number }>();
  let putOI = 0, callOI = 0;
  for (const inst of instruments) {
    const parsed = parseStrikeAndSide(inst.instrument_name);
    if (!parsed) continue;
    const bucket = oiByStrike.get(parsed.strike) || { put: 0, call: 0 };
    if (parsed.side === 'P') { bucket.put += inst.open_interest; putOI += inst.open_interest; }
    else { bucket.call += inst.open_interest; callOI += inst.open_interest; }
    oiByStrike.set(parsed.strike, bucket);
  }
  const putCallRatio = callOI > 0 ? putOI / callOI : null;

  let maxPainStrike: number | null = null, maxPainOI = -1;
  for (const [strike, oi] of oiByStrike) {
    const total = oi.put + oi.call;
    if (total > maxPainOI) { maxPainOI = total; maxPainStrike = strike; }
  }

  const items: RawItem[] = [];
  if (avgIv !== null) {
    items.push({
      id: `${currency}-iv`,
      label: `${currency} 期权隐含波动率`,
      value: `${avgIv.toFixed(1)}%`,
      polarity: 'neutral',
      detail: '全期限期权 mark IV 简单平均，未按到期日/行权价加权',
      timestamp: fetchedAt,
    });
  }
  if (putCallRatio !== null) {
    items.push({
      id: `${currency}-putcall`,
      label: `${currency} Put/Call 持仓比`,
      value: putCallRatio.toFixed(2),
      polarity: putCallRatio > 1.1 ? 'bearish' : putCallRatio < 0.8 ? 'bullish' : 'neutral',
      detail: `Put OI ${putOI.toFixed(0)} / Call OI ${callOI.toFixed(0)}`,
      timestamp: fetchedAt,
    });
  }
  if (maxPainStrike !== null) {
    items.push({
      id: `${currency}-maxpain`,
      label: `${currency} 最大痛点（近似）`,
      value: `${maxPainStrike.toLocaleString('en-US')} USD`,
      polarity: 'neutral',
      detail: '按全部到期日汇总持仓量的粗略近似，非单一到期日精确最大痛点',
      timestamp: fetchedAt,
    });
  }
  return items;
}

/** Free, keyless: Deribit public options book summary. */
export async function fetchOptions(): Promise<SourceResult> {
  const fetchedAt = Date.now();
  try {
    const [btc, eth] = await Promise.all([fetchForCurrency('BTC', fetchedAt), fetchForCurrency('ETH', fetchedAt)]);
    return { key: 'options', status: 'ok', fetchedAt, itemsRaw: [...btc, ...eth] };
  } catch (err: any) {
    return { key: 'options', status: 'error', fetchedAt, itemsRaw: [], note: `fetch failed: ${err.message}` };
  }
}
