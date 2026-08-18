import { fetchJson } from './http.js';

const BASE = 'https://xoomar.com/api/markets';

/** Free API (xoomar.com/developers), keyless at 30 req/min/IP or 120 req/min with a key.
 * Verified 2026-08-05: funding-rates cross-checked against our own Binance data and matched;
 * etf-flows and calendar look structurally sound. The liquidations endpoint returned an
 * implausible 24h total (~$48B, vs a realistic $100M-$2B range) that didn't change with a
 * `period` param — deliberately NOT wired in anywhere pending further validation. Don't add new
 * Xoomar endpoints without the same real-data sanity check; this API is undocumented beyond its
 * marketing page and hasn't earned blanket trust. */
export async function fetchXoomar<T>(path: string): Promise<T> {
  const apiKey = process.env.XOOMAR_API_KEY;
  return fetchJson<T>(`${BASE}${path}`, {
    headers: apiKey ? { 'X-API-Key': apiKey } : undefined,
  });
}
