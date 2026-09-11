import { createHmac } from 'node:crypto';
import { fetchJson } from '../util/http.js';

/** Sprint 3.5B — centralized Binance HMAC signing (Task 30: "never scatter signature generation").
 * Pure function: same params + secret always produce the same query string, deterministically
 * testable with known synthetic inputs. The secret is used only as the HMAC key — it never appears
 * in the output string itself. */
export function buildSignedQuery(params: Record<string, string | number>, apiSecret: string): string {
  const query = Object.keys(params)
    .map((k) => `${k}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
  const signature = createHmac('sha256', apiSecret).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

/** Hotfix (Sprint 3.5C.1) — Binance's signed-request timestamp validation is ASYMMETRIC, confirmed
 * against live Binance docs/community reports: `if (timestamp < serverTime + 1000 && serverTime -
 * timestamp <= recvWindow) accept; else reject -1021`. A timestamp BEHIND server time is tolerated
 * generously, up to the full `recvWindow` (5000ms here). A timestamp AHEAD of server time is
 * tolerated only by a hard, non-configurable 1000ms — regardless of how large recvWindow is set
 * (this is exactly why "just raise recvWindow" is not a real fix — confirmed as the wrong move by
 * this hotfix's own diagnosis, not merely by instruction). The plain midpoint offset estimate can
 * legitimately overshoot into the future by more than 1000ms under real-world network latency (a
 * live diagnostic on this machine measured a ~2.2s round trip to Binance TESTNET), so the computed
 * offset is deliberately biased BACKWARD by a fixed safety margin — trading a small amount of
 * (harmless, recvWindow-tolerated) staleness for elimination of the much stricter forward-facing
 * failure mode. */
const TIMESTAMP_SAFETY_MARGIN_MS = 1500;

/** Task 10 (3.5B) — signed Binance endpoints require a timestamp within `recvWindow` of the
 * exchange's own clock; the local machine's clock is never assumed accurate. Uses Binance's own
 * public (unauthenticated) server-time endpoint and the request midpoint technique to estimate the
 * local-vs-server clock offset, applied as `Date.now() + offset` by the caller. The result is always
 * biased toward "behind" via TIMESTAMP_SAFETY_MARGIN_MS (see above) — never toward "ahead". */
export async function fetchBinanceServerTimeOffset(baseUrl: string): Promise<number> {
  const localBefore = Date.now();
  const data = await fetchJson<{ serverTime: number }>(`${baseUrl}/fapi/v1/time`, { timeoutMs: 5000 });
  const localAfter = Date.now();
  const localMid = Math.round((localBefore + localAfter) / 2);
  const rawOffset = data.serverTime - localMid;
  return rawOffset - TIMESTAMP_SAFETY_MARGIN_MS;
}
