export type Issuer = 'ishares' | 'fidelity' | 'grayscale' | 'ark' | 'bitwise' | 'vaneck';

export interface EtfTicker {
  ticker: string;
  name: string;
  asset: 'BTC' | 'ETH';
  issuer: Issuer;
}

/** US spot BTC/ETH ETFs (2026-08-05 scope decision: crypto ETFs only, not "all US ETFs").
 * `issuer` selects which adapter in etf/issuers/ supplies shares-outstanding — only 'ishares' is
 * implemented so far (IBIT confirmed working). The rest are registered so adding their adapter
 * later is a one-file change, but they'll report as unavailable until then — see
 * etf/issuers/index.ts. Ticker/issuer pairings are current as of 2026-08-05; re-verify before
 * relying on this list long-term, since funds do launch/rename/close. */
export const ETF_TICKERS: EtfTicker[] = [
  { ticker: 'IBIT', name: 'iShares Bitcoin Trust', asset: 'BTC', issuer: 'ishares' },
  { ticker: 'FBTC', name: 'Fidelity Wise Origin Bitcoin Fund', asset: 'BTC', issuer: 'fidelity' },
  { ticker: 'GBTC', name: 'Grayscale Bitcoin Trust', asset: 'BTC', issuer: 'grayscale' },
  { ticker: 'ARKB', name: 'ARK 21Shares Bitcoin ETF', asset: 'BTC', issuer: 'ark' },
  { ticker: 'BITB', name: 'Bitwise Bitcoin ETF', asset: 'BTC', issuer: 'bitwise' },
  { ticker: 'HODL', name: 'VanEck Bitcoin Trust', asset: 'BTC', issuer: 'vaneck' },
  { ticker: 'ETHA', name: 'iShares Ethereum Trust', asset: 'ETH', issuer: 'ishares' },
  { ticker: 'FETH', name: 'Fidelity Ethereum Fund', asset: 'ETH', issuer: 'fidelity' },
  { ticker: 'ETHE', name: 'Grayscale Ethereum Trust', asset: 'ETH', issuer: 'grayscale' },
];
