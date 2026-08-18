import type { RawItem, SourceResult } from '../types.js';
import { fetchJson } from '../util/http.js';

interface MempoolFees { fastestFee: number; halfHourFee: number; hourFee: number; economyFee: number }
interface MempoolStats { count: number; vsize: number; total_fee: number }

/** BTC half is free & keyless (mempool.space). ETH half needs a free Etherscan key (ETHERSCAN_API_KEY)
 * — until set, that half is reported as a stub so the gap is visible instead of silently missing. */
export async function fetchOnchain(): Promise<SourceResult> {
  const fetchedAt = Date.now();
  const itemsRaw: RawItem[] = [];
  const notes: string[] = [];

  try {
    const [fees, mempool] = await Promise.all([
      fetchJson<MempoolFees>('https://mempool.space/api/v1/fees/recommended'),
      fetchJson<MempoolStats>('https://mempool.space/api/mempool'),
    ]);
    const congested = fees.fastestFee >= 30;
    itemsRaw.push({
      id: 'btc-mempool',
      label: 'BTC 链上拥堵度',
      value: `快速确认费率 ${fees.fastestFee} sat/vB`,
      polarity: congested ? 'bullish' : 'neutral',
      detail: `待确认交易 ${mempool.count.toLocaleString('en-US')} 笔（拥堵上升常伴随链上活跃度提高，需结合方向判断，不单独构成多空信号）`,
      sourceUrl: 'https://mempool.space',
      timestamp: fetchedAt,
    });
  } catch (err: any) {
    notes.push(`btc mempool.space failed: ${err.message}`);
  }

  const ethKey = process.env.ETHERSCAN_API_KEY;
  if (ethKey) {
    try {
      const supply = await fetchJson<{ result: string }>(
        `https://api.etherscan.io/v2/api?chainid=1&module=stats&action=ethsupply&apikey=${ethKey}`
      );
      itemsRaw.push({
        id: 'eth-supply',
        label: 'ETH 流通供应量',
        value: `${(parseFloat(supply.result) / 1e18 / 1e6).toFixed(2)}M ETH`,
        polarity: 'neutral',
        timestamp: fetchedAt,
      });
    } catch (err: any) {
      notes.push(`etherscan failed: ${err.message}`);
    }
  } else {
    notes.push('ETH 链上数据（大额转账/活跃地址等）需要免费 ETHERSCAN_API_KEY，见 .env.example');
  }

  const status = itemsRaw.length > 0 ? 'ok' : 'error';
  return { key: 'onchain', status, fetchedAt, itemsRaw, note: notes.length ? notes.join('; ') : undefined };
}
