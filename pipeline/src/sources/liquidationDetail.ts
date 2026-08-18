import {
  getLiquidationSummary,
  getLiquidationBuckets,
  getLiquidationAssetDistribution,
  getLiquidationExchangeDistribution,
  getLiquidationEvents,
  type LiquidationEventRow,
} from '../db.js';
import { getCollectorStartedAt } from '../collectors/liquidationCollector.js';

export interface LiquidationDetail {
  status: 'ok' | 'stub';
  collectorStartedAt: number | null;
  coverageHours: number;
  overview: {
    window1hUsd: number;
    window24hUsd: number;
    longUsd24h: number;
    shortUsd24h: number;
    largest: LiquidationEventRow | null;
  };
  history1h: { bucketStart: number; usd: number; count: number }[];
  history4h: { bucketStart: number; usd: number; count: number }[];
  history24h: { bucketStart: number; usd: number; count: number }[];
  assetDistribution: { symbol: string; usd: number; count: number }[];
  exchangeDistribution: { exchange: string; usd: number; count: number }[];
  latestEvents: LiquidationEventRow[];
}

/** Pure DB reads, no network call — the WebSocket collector (collectors/liquidationCollector.ts)
 * is what actually talks to Binance, running continuously in the background since server boot. */
export function getLiquidationDetail(): LiquidationDetail {
  const now = Date.now();
  const startedAt = getCollectorStartedAt();
  const coverageMs = startedAt ? Math.min(24 * 3600 * 1000, now - startedAt) : 0;
  const coverageHours = coverageMs / 3600000;

  const win1hMs = Math.min(3600 * 1000, coverageMs);
  const win4hMs = Math.min(4 * 3600 * 1000, coverageMs);
  const win24hMs = coverageMs;

  const summary1h = getLiquidationSummary(now - win1hMs);
  const summary24h = getLiquidationSummary(now - win24hMs);

  return {
    // 'stub' means "no events captured yet" (matches sources/liquidation.ts's fetchLiquidation()
    // semantics), not just "collector not started" — a running collector with zero events so far
    // is a normal early state, not something to hide behind a misleadingly all-zero 'ok' view.
    status: startedAt && summary24h.count > 0 ? 'ok' : 'stub',
    collectorStartedAt: startedAt,
    coverageHours,
    overview: {
      window1hUsd: summary1h.totalUsd,
      window24hUsd: summary24h.totalUsd,
      longUsd24h: summary24h.longUsd,
      shortUsd24h: summary24h.shortUsd,
      largest: summary24h.largest,
    },
    history1h: getLiquidationBuckets(now - win1hMs, 5 * 60 * 1000),
    history4h: getLiquidationBuckets(now - win4hMs, 15 * 60 * 1000),
    history24h: getLiquidationBuckets(now - win24hMs, 60 * 60 * 1000),
    assetDistribution: getLiquidationAssetDistribution(now - win24hMs),
    exchangeDistribution: getLiquidationExchangeDistribution(now - win24hMs),
    latestEvents: getLiquidationEvents(now - win24hMs, 30),
  };
}
