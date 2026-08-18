import { startBinanceLiquidationStream } from '../connectors/binanceLiquidationConnector.js';
import { startCoinglassLiquidationPolling, isCoinglassConfigured } from '../connectors/coinglassLiquidationConnector.js';
import { normalizeLiquidationEvent } from '../normalize/liquidation.js';
import { insertLiquidationEvent } from '../db.js';

let startedAt: number | null = null;
let lastStatus = 'not started';
let activeSource: 'binance' | 'coinglass' = 'binance';

/** Idempotent — server.ts calls this once on boot; guarding here means an accidental second
 * call (e.g. during a future hot-reload) doesn't open a second WebSocket/poller.
 *
 * CoinGlass is reserved but inactive until COINGLASS_API_KEY is set (2026-08-06) — with no key,
 * this is byte-for-byte the same Binance-only behavior as before. Once a key is added, CoinGlass
 * takes over (multi-exchange coverage + real 24h backfill instead of "however long this process
 * has been running"); flip COINGLASS_API_KEY blank again to fall back to Binance. */
export function startLiquidationCollector(): void {
  if (startedAt) return;
  startedAt = Date.now();
  const onEvent = (raw: Parameters<typeof normalizeLiquidationEvent>[0]) => insertLiquidationEvent(normalizeLiquidationEvent(raw));
  const onStatus = (status: string) => { lastStatus = status; };
  if (isCoinglassConfigured()) {
    activeSource = 'coinglass';
    startCoinglassLiquidationPolling(onEvent, onStatus);
  } else {
    activeSource = 'binance';
    startBinanceLiquidationStream(onEvent, onStatus);
  }
}

export function getCollectorStartedAt(): number | null {
  return startedAt;
}

export function getCollectorStatus(): string {
  return lastStatus;
}

export function getActiveLiquidationSource(): 'binance' | 'coinglass' {
  return activeSource;
}
