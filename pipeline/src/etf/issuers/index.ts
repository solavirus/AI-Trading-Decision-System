import type { Issuer } from '../tickers.js';
import { fetchIsharesSharesOutstanding } from './ishares.js';

export type SharesOutstandingFetcher = (ticker: string) => Promise<number | null>;

/** Only 'ishares' is implemented (see ishares.ts) — confirmed 2026-08-05 that Fidelity and
 * Grayscale's fund pages don't expose "Shares Outstanding" as plain matchable text the way
 * iShares does (likely client-side rendered); each remaining issuer needs its own investigation
 * before it can return real data. Until then they report null, which etf/snapshot.ts turns into
 * an honest per-ticker gap rather than a guess. */
export const ISSUER_ADAPTERS: Record<Issuer, SharesOutstandingFetcher> = {
  ishares: fetchIsharesSharesOutstanding,
  fidelity: async () => null,
  grayscale: async () => null,
  ark: async () => null,
  bitwise: async () => null,
  vaneck: async () => null,
};
