import { getExchangeConnection, recordExchangeConnectionTestResult } from './exchangeConnectionStore.js';
import {
  testBinanceFuturesConnection, getBinanceFuturesAccountSnapshot, getBinanceFuturesOrder,
  resolveAndSubmitEntryOrder, cancelBinanceFuturesTestnetOrder, type OrderLookupId, type CancelOrderAdapterParams,
  resolveAndSubmitProtectionOrder, cancelBinanceFuturesProtectionOrder, getBinanceFuturesAlgoOrder, type AlgoOrderLookupId,
  getBinanceFuturesOpenOrders, changeBinanceFuturesLeverage, getProtectiveOrdersForSymbol,
} from './binanceFuturesAdapter.js';
import { subscribeUserDataStream } from './userDataStreamManager.js';
import type {
  ExchangeAccountSnapshot, ExchangeErrorInfo, ExchangeOrderSnapshot, EntryOrderSubmissionRequest,
  ExchangeAlgoOrderSnapshot, ProtectionOrderSubmissionRequest, CancelProtectionOrderRequest, ExchangeAlgoCancelResult,
  LeverageChangeResult, NormalizedStreamEvent, ExchangeProtectiveOrder,
} from './types.js';

/** Sprint 3.5B — the connection-id-resolving layer sitting between server.ts's routes and the
 * exchange adapter, mirroring ai/connectionTest.ts's shape: resolve the connection record first
 * (not-found / disabled / missing credentials are all local checks that never touch the network),
 * only then delegate to the adapter. */

export function resolveCredentialsOrError(connectionId: string):
  | { ok: true; creds: { apiKey: string; apiSecret: string; environment: 'LIVE' | 'TESTNET' } }
  | { ok: false; error: ExchangeErrorInfo } {
  const connection = getExchangeConnection(connectionId);
  if (!connection) return { ok: false, error: { code: 'connection_not_found', message: '交易所连接不存在' } };
  if (!connection.enabled) return { ok: false, error: { code: 'connection_disabled', message: '该交易所连接已被禁用' } };
  if (!connection.apiKey) return { ok: false, error: { code: 'missing_api_key', message: '未配置 API Key' } };
  if (!connection.apiSecret) return { ok: false, error: { code: 'missing_api_secret', message: '未配置 API Secret' } };
  return { ok: true, creds: { apiKey: connection.apiKey, apiSecret: connection.apiSecret, environment: connection.environment } };
}

export async function testExchangeConnection(connectionId: string): Promise<{ ok: true; latencyMs: number } | { ok: false; error: ExchangeErrorInfo }> {
  const resolved = resolveCredentialsOrError(connectionId);
  if (!resolved.ok) {
    // Only record a test result for a real, existing connection — never fabricate a history entry
    // for an id that was never valid to begin with.
    if (resolved.error.code !== 'connection_not_found') recordExchangeConnectionTestResult(connectionId, { status: 'error', error: resolved.error });
    return resolved;
  }
  const result = await testBinanceFuturesConnection(resolved.creds);
  recordExchangeConnectionTestResult(connectionId, result.ok ? { status: 'success' } : { status: 'error', error: result.error });
  return result;
}

export async function fetchExchangeAccountSnapshot(connectionId: string): Promise<{ ok: true; snapshot: ExchangeAccountSnapshot } | { ok: false; error: ExchangeErrorInfo }> {
  const resolved = resolveCredentialsOrError(connectionId);
  if (!resolved.ok) return resolved;
  return getBinanceFuturesAccountSnapshot(connectionId, resolved.creds);
}

/** Sprint 3.6B.2 — see `getProtectiveOrdersForSymbol()`'s own comment: the account snapshot above
 * cannot see a symbol's protective orders once its position quantity is zero (by design, for its own
 * use case). This is the explicit, symbol-scoped alternative for exactly the one case that matters
 * here: "the position on this symbol just went to zero — is a protection order still live?" */
export async function fetchProtectiveOrdersForSymbol(connectionId: string, symbol: string): Promise<{ ok: true; orders: ExchangeProtectiveOrder[] } | { ok: false; error: ExchangeErrorInfo }> {
  const resolved = resolveCredentialsOrError(connectionId);
  if (!resolved.ok) return resolved;
  return getProtectiveOrdersForSymbol(resolved.creds, symbol);
}

/** Sprint 3.5D-A — read-only query for one already-known exchange order, used by the local
 * RealOrder sync flow. Same resolve-credentials-first shape as the two functions above. Sprint
 * 3.5D-B, Task 27: `lookup` accepts EITHER `orderId` or `origClientOrderId`, so an ambiguous
 * submission (no exchangeOrderId yet, only the locally-known clientOrderId) can still be resolved. */
export async function fetchExchangeOrderSnapshot(connectionId: string, symbol: string, lookup: OrderLookupId): Promise<{ ok: true; snapshot: ExchangeOrderSnapshot } | { ok: false; error: ExchangeErrorInfo }> {
  const resolved = resolveCredentialsOrError(connectionId);
  if (!resolved.ok) return resolved;
  return getBinanceFuturesOrder(resolved.creds, symbol, lookup);
}

/** Sprint 3.5D-B — the entry point for the one real write capability this app has. TESTNET is
 * enforced here (this layer) AND again inside resolveAndSubmitEntryOrder()/
 * submitBinanceFuturesEntryOrder() — three independent checks, none trusting the others alone
 * (Task 2's "must be enforced BACKEND-side... do not add a hidden developer bypass"). */
export async function submitEntryOrderToBinanceTestnet(connectionId: string, request: EntryOrderSubmissionRequest): Promise<{ ok: true; snapshot: ExchangeOrderSnapshot } | { ok: false; error: ExchangeErrorInfo; ambiguous?: boolean; leverageMismatch?: { symbol: string; current: number; required: number } }> {
  const resolved = resolveCredentialsOrError(connectionId);
  if (!resolved.ok) return resolved;
  if (resolved.creds.environment !== 'TESTNET') {
    return { ok: false, error: { code: 'live_order_submission_not_supported', message: '当前版本不支持 LIVE 环境下单，仅支持 TESTNET' } };
  }
  return resolveAndSubmitEntryOrder(resolved.creds, request);
}

/** Sprint 3.5D-D — the entry point for the app's second (and, as of this sprint, last planned) real
 * write capability: order cancellation. Same shape/discipline as submitEntryOrderToBinanceTestnet()
 * above — TESTNET enforced here AND again inside cancelBinanceFuturesTestnetOrder() (two independent
 * checks, neither trusting the other alone; the frontend adds a third, same as submission). Task 24 —
 * this layer (like every layer below it) has no concept of a local RealOrder and cannot verify that
 * `params.exchangeOrderId` actually "belongs" to whoever is calling; it only verifies TESTNET, a
 * resolvable/enabled connection with credentials, a normalizable symbol, and a numeric-looking order
 * id shape. Documented honestly as a boundary, not pretended away. */
export async function cancelEntryOrderOnBinanceTestnet(connectionId: string, params: CancelOrderAdapterParams): Promise<{ ok: true; snapshot: ExchangeOrderSnapshot } | { ok: false; error: ExchangeErrorInfo; ambiguous?: boolean }> {
  const resolved = resolveCredentialsOrError(connectionId);
  if (!resolved.ok) return resolved;
  if (resolved.creds.environment !== 'TESTNET') {
    return { ok: false, error: { code: 'live_order_cancellation_not_supported', message: '当前版本不支持 LIVE 环境撤单，仅支持 TESTNET' } };
  }
  return cancelBinanceFuturesTestnetOrder(resolved.creds, params);
}

/** Sprint 3.5D-E — the entry point for real protective (STOP_LOSS/TAKE_PROFIT) order submission.
 * Same shape/discipline as submitEntryOrderToBinanceTestnet(): TESTNET enforced here AND again inside
 * resolveAndSubmitProtectionOrder()/submitBinanceFuturesProtectionOrder() (two independent layers;
 * the frontend adds a third). */
export async function submitProtectionOrderToBinanceTestnet(connectionId: string, request: ProtectionOrderSubmissionRequest): Promise<{ ok: true; snapshot: ExchangeAlgoOrderSnapshot } | { ok: false; error: ExchangeErrorInfo; ambiguous?: boolean }> {
  const resolved = resolveCredentialsOrError(connectionId);
  if (!resolved.ok) return resolved;
  if (resolved.creds.environment !== 'TESTNET') {
    return { ok: false, error: { code: 'live_order_submission_not_supported', message: '当前版本不支持 LIVE 环境下单，仅支持 TESTNET' } };
  }
  return resolveAndSubmitProtectionOrder(resolved.creds, request);
}

/** Sprint 3.5D-E — cancels an existing protective order (used by the "cancel-then-recreate"
 * reconciliation fallback, Task N — never a blind amend). Same TESTNET discipline as every other
 * write in this app. */
export async function cancelProtectionOrderOnBinanceTestnet(connectionId: string, params: CancelProtectionOrderRequest): Promise<{ ok: true; result: ExchangeAlgoCancelResult } | { ok: false; error: ExchangeErrorInfo; ambiguous?: boolean }> {
  const resolved = resolveCredentialsOrError(connectionId);
  if (!resolved.ok) return resolved;
  if (resolved.creds.environment !== 'TESTNET') {
    return { ok: false, error: { code: 'live_order_cancellation_not_supported', message: '当前版本不支持 LIVE 环境撤单，仅支持 TESTNET' } };
  }
  return cancelBinanceFuturesProtectionOrder(resolved.creds, params);
}

/** Sprint 3.5D-E — read-only recovery lookup for an ambiguous protection submission/cancellation, by
 * algoId or clientAlgoId. Mirrors fetchExchangeOrderSnapshot()'s origClientOrderId recovery pattern. */
export async function fetchProtectionOrderSnapshot(connectionId: string, lookup: AlgoOrderLookupId): Promise<{ ok: true; snapshot: ExchangeAlgoOrderSnapshot } | { ok: false; error: ExchangeErrorInfo }> {
  const resolved = resolveCredentialsOrError(connectionId);
  if (!resolved.ok) return resolved;
  return getBinanceFuturesAlgoOrder(resolved.creds, lookup);
}

/** Sprint 3.6A — read-only, all currently-open plain orders for the Account/Portfolio page (App vs
 * External ownership is decided entirely by the FRONTEND, comparing against locally-known
 * `RealOrder.exchangeOrderId`s — this backend has no concept of a local Order at all, same honesty
 * boundary as every other route). */
export async function fetchOpenOrders(connectionId: string, symbol?: string): Promise<{ ok: true; snapshots: ExchangeOrderSnapshot[] } | { ok: false; error: ExchangeErrorInfo }> {
  const resolved = resolveCredentialsOrError(connectionId);
  if (!resolved.ok) return resolved;
  return getBinanceFuturesOpenOrders(resolved.creds, symbol);
}

/** Sprint 3.6A — the entry point for the app's fifth real write capability: leverage change. Same
 * TESTNET-enforcement discipline as every other write entry point in this file (enforced here AND
 * again inside changeBinanceFuturesLeverage() — two independent layers; the frontend's confirm flow
 * is the third). Never called except from an explicit user confirmation that has already shown
 * current vs. requested leverage. */
export async function changeLeverageOnBinanceTestnet(connectionId: string, symbol: string, leverage: number): Promise<{ ok: true; result: LeverageChangeResult } | { ok: false; error: ExchangeErrorInfo; ambiguous?: boolean }> {
  const resolved = resolveCredentialsOrError(connectionId);
  if (!resolved.ok) return resolved;
  if (resolved.creds.environment !== 'TESTNET') {
    return { ok: false, error: { code: 'live_leverage_change_not_supported', message: '当前版本不支持 LIVE 环境调整杠杆，仅支持 TESTNET' } };
  }
  return changeBinanceFuturesLeverage(resolved.creds, symbol, leverage);
}

/** Sprint 3.6A — resolves credentials only (no subscription), so server.ts's SSE route can decide
 * whether to even write SSE response headers before touching the stream manager at all — an
 * unresolvable connection should get a normal `{ok:false}` JSON error, not a half-open event stream. */
export function resolveAccountStreamCredentials(connectionId: string) {
  return resolveCredentialsOrError(connectionId);
}

/** Sprint 3.6A — thin passthrough to the stream manager, kept in this file so server.ts never
 * imports userDataStreamManager.ts directly (same layering as every other exchange capability: routes
 * -> exchangeService -> adapter/manager). Real-time streaming is allowed for LIVE connections too
 * (it is read-only, exactly like the existing account-snapshot route) — only the actual trading
 * writes (entry/cancel/protection/leverage) are TESTNET-gated in this app. */
export function subscribeAccountEventStream(connectionId: string, creds: { apiKey: string; apiSecret: string; environment: 'LIVE' | 'TESTNET' }, onEvent: (e: NormalizedStreamEvent) => void): () => void {
  return subscribeUserDataStream(connectionId, creds, onEvent);
}
