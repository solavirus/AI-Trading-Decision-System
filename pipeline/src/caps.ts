import type { SourceKey } from './types.js';

/** Total token budget for the WHOLE assembled context package (all 11 sources combined). */
export const GLOBAL_TOKEN_BUDGET = 6000;

/** Even a low-weight (but nonzero) source still gets a minimal look-in, so "low weight" means
 * "shrunk", not "randomly starved to 0 by rounding". Zero weight is handled separately (hard exclude). */
export const MIN_TOKENS_IF_NONZERO_WEIGHT = 60;

/** Hard per-source ceilings — independent of token budget, so one source can never flood the
 * package with hundreds of tiny items even if it somehow has huge weight. */
export const SOURCE_CAPS: Record<SourceKey, { maxItems: number; maxDetailChars: number }> = {
  market: { maxItems: 6, maxDetailChars: 80 },
  technical: { maxItems: 6, maxDetailChars: 100 },
  macro: { maxItems: 6, maxDetailChars: 140 },
  news: { maxItems: 8, maxDetailChars: 160 },
  etf: { maxItems: 4, maxDetailChars: 100 },
  onchain: { maxItems: 6, maxDetailChars: 120 },
  sentiment: { maxItems: 3, maxDetailChars: 80 },
  derivatives: { maxItems: 6, maxDetailChars: 100 },
  stablecoin: { maxItems: 4, maxDetailChars: 100 },
  liquidation: { maxItems: 4, maxDetailChars: 100 },
  options: { maxItems: 4, maxDetailChars: 100 },
};
