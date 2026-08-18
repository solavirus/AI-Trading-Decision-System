/** DATA_SOURCE_SPEC.md's "Binance First Strategy": Liquidation's primary source is Binance
 * Futures WebSocket (`!forceOrder@arr`, the all-symbol combined liquidation-order stream) — OKX/
 * Bybit/Bitget are listed as "Future", not now. This intentionally scopes down the earlier
 * (deleted 2026-08-05) multi-exchange attempt: one exchange, all symbols (the spec's "Asset
 * Distribution" chart needs more than just BTC/ETH), no reconnect-abstraction file of its own —
 * kept inline since there's only one exchange to manage here.
 *
 * Uses Node's built-in `WebSocket` global (no `ws` package needed, same choice made for the
 * earlier liquidation collector). */

export interface RawBinanceLiquidation {
  exchange: 'binance';
  symbol: string;
  side: 'LONG' | 'SHORT'; // liquidated position's side — the forced order's own side (o.S) is the opposite
  price: number;
  qty: number;
  usd: number;
  timestamp: number;
}

const WS_URL = 'wss://fstream.binance.com/ws/!forceOrder@arr';
const RECONNECT_DELAY_MS = 5000;

interface BinanceForceOrderMsg {
  e: 'forceOrder';
  E: number;
  o: {
    s: string;   // symbol
    S: 'BUY' | 'SELL'; // side of the forced order itself
    ap: string;  // average price
    q: string;   // original quantity
    T: number;   // order trade time
  };
}

export function startBinanceLiquidationStream(onEvent: (e: RawBinanceLiquidation) => void, onStatus?: (msg: string) => void): () => void {
  let stopped = false;
  let ws: WebSocket | null = null;

  function connect() {
    if (stopped) return;
    ws = new WebSocket(WS_URL);
    ws.addEventListener('open', () => onStatus?.('connected'));
    ws.addEventListener('message', (ev: MessageEvent) => {
      try {
        const msg: BinanceForceOrderMsg = JSON.parse(String(ev.data));
        if (msg.e !== 'forceOrder') return;
        const o = msg.o;
        const price = parseFloat(o.ap);
        const qty = parseFloat(o.q);
        onEvent({
          exchange: 'binance',
          symbol: o.s,
          side: o.S === 'SELL' ? 'LONG' : 'SHORT',
          price,
          qty,
          usd: price * qty,
          timestamp: o.T,
        });
      } catch (err: any) {
        onStatus?.(`parse error: ${err.message}`);
      }
    });
    ws.addEventListener('close', () => {
      onStatus?.('disconnected, reconnecting…');
      if (!stopped) setTimeout(connect, RECONNECT_DELAY_MS);
    });
    ws.addEventListener('error', () => {
      // 'close' fires right after 'error' for WebSocket — reconnect is handled there, this is
      // just so an error doesn't go completely silent.
      onStatus?.('websocket error');
    });
  }

  connect();
  return () => { stopped = true; ws?.close(); };
}
