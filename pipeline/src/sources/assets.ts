/** Shared asset list — mirrors prototype/index.html's ASSETS symbols. */
export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT'] as const;
export type Symbol = (typeof SYMBOLS)[number];
