/** Sprint 3.9 — the canonical 11-source list, ported verbatim from `prototype/index.html`'s
 * `WEIGHT_DEFS`. Single source of truth on the backend now (Section 5's "same snapshot builder") —
 * `responseValidator.ts`'s system-source completeness check and `snapshotAcquisition.ts`'s "which
 * sources are required" both read from this one list, never a second hardcoded copy. */
import type { SourceKey } from '../types.js';

export interface WeightDef { key: SourceKey; label: string; def: number }

export const WEIGHT_DEFS: WeightDef[] = [
  { key: 'market', label: '市场行情', def: 8 },
  { key: 'technical', label: '技术指标', def: 15 },
  { key: 'macro', label: '宏观经济', def: 8 },
  { key: 'news', label: '新闻资讯', def: 6 },
  { key: 'etf', label: 'ETF 资金流', def: 6 },
  { key: 'onchain', label: '链上数据', def: 8 },
  { key: 'sentiment', label: '市场情绪', def: 5 },
  { key: 'derivatives', label: '衍生品数据', def: 15 },
  { key: 'stablecoin', label: '稳定币数据', def: 4 },
  { key: 'liquidation', label: '清算数据', def: 3 },
  { key: 'options', label: '期权数据', def: 2 },
];

/** Sprint 3.9.1.1, Section 24 — the ONE shared `sourceKey -> Chinese label` mapping. Every place that
 * needs to show a source's name (AnalysisRun progress, AnalysisPayload snapshots, the frontend
 * progress overlay) reads from this, so a new source added to `WEIGHT_DEFS` above automatically shows
 * up everywhere with a consistent label — never a second hand-maintained copy of this mapping. */
export const SOURCE_LABELS: Record<string, string> = Object.fromEntries(WEIGHT_DEFS.map((w) => [w.key, w.label]));
