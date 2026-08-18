import { fetchJson } from '../util/http.js';
import { SYMBOLS } from '../sources/assets.js';

/** CoinGlass liquidation source — reserved, inactive until COINGLASS_API_KEY is set (2026-08-06,
 * per user request: "改成接 CoinGlass，不过暂时还不付费，预留在那里"). No free tier exists (verified
 * live: an unauthenticated request returns {"code":"401","msg":"API key missing."} over HTTP 200
 * — CoinGlass puts the real status in the JSON body, not the HTTP status code, so isOk() below
 * checks `code`, not `res.ok`). Until a key is added, isCoinglassConfigured() is false and
 * liquidationCollector.ts falls back to the existing Binance WebSocket connector unchanged —
 * nothing about current behavior changes by this file merely existing.
 *
 * Real endpoint verified via unauthenticated + garbage-key curl requests (docs.coinglass.com/
 * reference/liquidation-order): GET /api/futures/liquidation/order, requires exchange/symbol/
 * min_liquidation_amount, auth via CG-API-KEY header, response {code,msg,data:[...]}.
 *
 * UNVERIFIED — confirm once a real key is available: the docs describe `side` as
 * "Order direction (1: Buy, 2: Sell)" without stating whether that's the liquidated position's
 * side or the forced closing order's side. This connector assumes the same convention already
 * verified for Binance's own forceOrder stream (binanceLiquidationConnector.ts): the forced order
 * is the *closing* trade, so a Sell-side forced order closed a LONG, a Buy-side forced order
 * closed a SHORT — i.e. side 2 (Sell) → LONG liquidated, side 1 (Buy) → SHORT liquidated. If this
 * guess is wrong once tested for real, only the SIDE_MAP below needs to flip. */
const SIDE_MAP: Record<number, 'LONG' | 'SHORT'> = { 1: 'SHORT', 2: 'LONG' };

const API_BASE = 'https://open-api-v4.coinglass.com';
/** Hobbyist tier (cheapest paid plan, $29/mo) caps at 30 req/min. Polling 6 symbols every 20s is
 * 18 req/min — safe headroom even if the polling interval drifts. */
const POLL_INTERVAL_MS = 20_000;
const BACKFILL_WINDOW_MS = 24 * 60 * 60 * 1000;
const COIN_SYMBOLS = SYMBOLS.map((s) => s.replace(/USDT$/, ''));

export interface RawCoinglassLiquidation {
  exchange: string; // CoinGlass aggregates across exchanges (exchange_name), not Binance-only
  symbol: string;
  side: 'LONG' | 'SHORT';
  price: number;
  qty: number;
  usd: number;
  timestamp: number;
}

interface CoinglassLiquidationOrderRow {
  exchange_name: string;
  symbol: string;
  base_asset: string;
  price: number;
  usd_value: number;
  side: number;
  time: number;
}
interface CoinglassResponse<T> {
  code: string;
  msg: string;
  data: T;
}

export function isCoinglassConfigured(): boolean {
  return !!process.env.COINGLASS_API_KEY;
}

async function fetchLiquidationOrders(coin: string, startTimeMs: number, endTimeMs: number): Promise<CoinglassLiquidationOrderRow[]> {
  const apiKey = process.env.COINGLASS_API_KEY;
  if (!apiKey) throw new Error('COINGLASS_API_KEY not set');
  const url = `${API_BASE}/api/futures/liquidation/order?exchange=Binance&symbol=${coin}&min_liquidation_amount=1000&start_time=${startTimeMs}&end_time=${endTimeMs}`;
  const res = await fetchJson<CoinglassResponse<CoinglassLiquidationOrderRow[]>>(url, {
    timeoutMs: 10000,
    headers: { 'CG-API-KEY': apiKey },
  });
  if (res.code !== '0') throw new Error(`CoinGlass API error ${res.code}: ${res.msg}`);
  return res.data ?? [];
}

function toRawEvent(row: CoinglassLiquidationOrderRow): RawCoinglassLiquidation {
  return {
    exchange: row.exchange_name,
    symbol: row.symbol,
    side: SIDE_MAP[row.side] ?? 'LONG',
    price: row.price,
    qty: row.usd_value / row.price,
    usd: row.usd_value,
    timestamp: row.time,
  };
}

/** Same (onEvent, onStatus) => stop-fn shape as startBinanceLiquidationStream, so
 * liquidationCollector.ts can swap between the two without caring which is active. Polling, not a
 * push stream — CoinGlass's liquidation endpoint is REST with a per-symbol query, not a
 * multi-symbol WebSocket like Binance's !forceOrder@arr. */
export function startCoinglassLiquidationPolling(
  onEvent: (e: RawCoinglassLiquidation) => void,
  onStatus?: (msg: string) => void
): () => void {
  let stopped = false;
  const cursor = new Map<string, number>(); // coin -> ms timestamp of last event already emitted

  async function pollOnce(coin: string) {
    const now = Date.now();
    const since = cursor.get(coin) ?? now - BACKFILL_WINDOW_MS;
    try {
      const rows = await fetchLiquidationOrders(coin, since, now);
      for (const row of rows) onEvent(toRawEvent(row));
      cursor.set(coin, now);
      onStatus?.(`ok (${coin}, ${rows.length} events)`);
    } catch (err: any) {
      onStatus?.(`error (${coin}): ${err.message}`);
    }
  }

  async function loop() {
    for (const coin of COIN_SYMBOLS) {
      if (stopped) return;
      await pollOnce(coin);
    }
    if (!stopped) setTimeout(loop, POLL_INTERVAL_MS);
  }

  loop();
  return () => { stopped = true; };
}
