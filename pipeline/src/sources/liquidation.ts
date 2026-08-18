import type { RawItem, SourceResult } from '../types.js';
import { getLiquidationSummary } from '../db.js';
import { getCollectorStartedAt, getCollectorStatus, getActiveLiquidationSource } from '../collectors/liquidationCollector.js';

/** DATA_SOURCE_SPEC.md rebuild (2026-08-05): Binance Futures WebSocket by default ("Binance First
 * Strategy"), CoinGlass REST as an opt-in upgrade once COINGLASS_API_KEY is set (2026-08-06) — see
 * liquidationCollector.ts. Coverage is honestly time-bounded from whenever the collector booted
 * (Binance) or from CoinGlass's own real 24h backfill; never faked as more than it is. */
export async function fetchLiquidation(): Promise<SourceResult> {
  const fetchedAt = Date.now();
  const startedAt = getCollectorStartedAt();
  const source = getActiveLiquidationSource();
  const sourceLabel = source === 'coinglass' ? 'CoinGlass' : 'Binance';
  if (!startedAt) {
    return { key: 'liquidation', status: 'stub', fetchedAt, itemsRaw: [], note: '本地采集服务未启动' };
  }

  const coverageMs = Math.min(24 * 60 * 60 * 1000, fetchedAt - startedAt);
  const coverageHrs = coverageMs / 3600000;
  const summary = getLiquidationSummary(fetchedAt - coverageMs);

  if (summary.count === 0) {
    return {
      key: 'liquidation',
      status: 'stub',
      fetchedAt,
      itemsRaw: [],
      note: `${sourceLabel} 清算流已运行 ${coverageHrs.toFixed(1)} 小时（${getCollectorStatus()}），尚未捕获到清算事件`,
    };
  }

  const windowLabel = coverageHrs < 24 ? `近${coverageHrs.toFixed(1)}h` : '24h';
  const itemsRaw: RawItem[] = [
    {
      id: 'total',
      label: `${windowLabel} 全网爆仓（${sourceLabel}）`,
      value: `${(summary.totalUsd / 1e6).toFixed(2)}M USD（${summary.count} 笔）`,
      polarity: summary.longUsd > summary.shortUsd * 1.2 ? 'bearish' : summary.shortUsd > summary.longUsd * 1.2 ? 'bullish' : 'neutral',
      detail: `多单清算 ${(summary.longUsd / 1e6).toFixed(2)}M，空单清算 ${(summary.shortUsd / 1e6).toFixed(2)}M USD（来源：${source === 'coinglass' ? 'CoinGlass（聚合多交易所）' : 'Binance Futures WebSocket'}）`,
      timestamp: fetchedAt,
    },
  ];
  if (summary.largest) {
    itemsRaw.push({
      id: 'largest',
      label: '最大单笔清算',
      value: `${(summary.largest.usd / 1e3).toFixed(1)}K USD`,
      polarity: 'neutral',
      detail: `${summary.largest.symbol} · ${summary.largest.side === 'LONG' ? '多单' : '空单'}被清算 · ${new Date(summary.largest.timestamp).toLocaleTimeString('zh-CN')}`,
      timestamp: summary.largest.timestamp,
    });
  }

  return {
    key: 'liquidation',
    status: 'ok',
    fetchedAt,
    itemsRaw,
    note: coverageHrs < 24 ? `本地采集覆盖 ${coverageHrs.toFixed(1)} 小时（服务刚启动不久，还没到完整 24h）` : undefined,
  };
}
