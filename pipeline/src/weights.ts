import type { SourceKey, WeightConfig } from './types.js';
import { GLOBAL_TOKEN_BUDGET, MIN_TOKENS_IF_NONZERO_WEIGHT } from './caps.js';

/** Mirrors prototype/index.html's WEIGHT_DEFS 1:1 (same keys as Dashboard's 11 source cards,
 * per MVP Handbook Principle 5). Keep these two lists in lockstep by hand until there's a
 * shared config file both projects import. */
export const WEIGHT_DEFS: { key: SourceKey; label: string }[] = [
  { key: 'market', label: '市场行情' },
  { key: 'technical', label: '技术指标' },
  { key: 'macro', label: '宏观经济' },
  { key: 'news', label: '新闻资讯' },
  { key: 'etf', label: 'ETF 资金流' },
  { key: 'onchain', label: '链上数据' },
  { key: 'sentiment', label: '市场情绪' },
  { key: 'derivatives', label: '衍生品数据' },
  { key: 'stablecoin', label: '稳定币数据' },
  { key: 'liquidation', label: '清算数据' },
  { key: 'options', label: '期权数据' },
];

export const DEFAULT_WEIGHTS: WeightConfig[] = [
  { key: 'market', weight: 8 },
  { key: 'technical', weight: 15 },
  { key: 'macro', weight: 8 },
  { key: 'news', weight: 6 },
  { key: 'etf', weight: 6 },
  { key: 'onchain', weight: 8 },
  { key: 'sentiment', weight: 5 },
  { key: 'derivatives', weight: 15 },
  { key: 'stablecoin', weight: 4 },
  { key: 'liquidation', weight: 3 },
  { key: 'options', weight: 2 },
];

/** Weight controls both the Strategy page's contribution score (elsewhere) AND, here, how many
 * tokens of this source's evidence actually reach the model. Zero weight -> zero tokens, handled
 * by the caller (applyBudget) as a hard exclude rather than a rounding-to-zero edge case. */
export function computeTokenBudget(weight: number, totalWeight: number): number {
  if (weight <= 0 || totalWeight <= 0) return 0;
  const share = weight / totalWeight;
  return Math.max(MIN_TOKENS_IF_NONZERO_WEIGHT, Math.round(GLOBAL_TOKEN_BUDGET * share));
}
