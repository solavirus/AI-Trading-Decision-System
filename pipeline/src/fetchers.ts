import type { SourceKey, SourceResult } from './types.js';

import { fetchMarket } from './sources/market.js';
import { fetchTechnical } from './sources/technical.js';
import { fetchMacro } from './sources/macro.js';
import { fetchNews } from './sources/news.js';
import { fetchEtf } from './sources/etf.js';
import { fetchOnchain } from './sources/onchain.js';
import { fetchSentiment } from './sources/sentiment.js';
import { fetchDerivatives } from './sources/derivatives.js';
import { fetchStablecoin } from './sources/stablecoin.js';
import { fetchLiquidation } from './sources/liquidation.js';
import { fetchOptions } from './sources/options.js';

/** Shared by the CLI (run.ts) and the local server (server.ts) so there's one registry, not two. */
export const FETCHERS: Record<SourceKey, () => Promise<SourceResult>> = {
  market: fetchMarket,
  technical: fetchTechnical,
  macro: fetchMacro,
  news: fetchNews,
  etf: fetchEtf,
  onchain: fetchOnchain,
  sentiment: fetchSentiment,
  derivatives: fetchDerivatives,
  stablecoin: fetchStablecoin,
  liquidation: fetchLiquidation,
  options: fetchOptions,
};
