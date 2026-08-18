/** Sprint 3.6B.1, Section 2-4 — backend order-fill reconciliation for AUTO-submitted entries. Ported
 * from the frontend's existing `EXCHANGE_ORDER_STATUS_MAP`/`mapExchangeOrderStatusToLocalOrderStatus`
 * (`prototype/index.html`, Sprint 3.5D-A) — identical mapping, so a StrategyOrder's `execution.orderStatus`
 * always agrees with what the eventual local `RealOrder.status` mirror will show. */
import type { StrategyOrder } from './types.js';
import { fetchExchangeOrderSnapshot } from '../exchange/exchangeService.js';

export const EXCHANGE_ORDER_STATUS_MAP: Record<string, StrategyOrder['execution']['orderStatus']> = {
  NEW: 'NEW', PARTIALLY_FILLED: 'PARTIALLY_FILLED', FILLED: 'FILLED', CANCELED: 'CANCELLED', REJECTED: 'REJECTED', EXPIRED: 'EXPIRED',
};
export function mapExchangeOrderStatus(remote: string): StrategyOrder['execution']['orderStatus'] {
  return EXCHANGE_ORDER_STATUS_MAP[remote] ?? null;
}

export interface OrderSyncResult {
  ok: boolean;
  execution?: StrategyOrder['execution'];
  error?: string;
}

/** Read-only — queries the real order and returns the updated `execution` fields; never writes
 * anything to Binance, never mutates `order` in place (caller persists via `transitionStrategyOrder`). */
export async function syncStrategyOrderExecutionState(order: StrategyOrder, connectionId: string): Promise<OrderSyncResult> {
  if (!order.submission.exchangeOrderId) return { ok: false, error: '尚未提交至交易所，无法同步' };
  const result = await fetchExchangeOrderSnapshot(connectionId, order.symbol, { orderId: order.submission.exchangeOrderId });
  if (!result.ok) return { ok: false, error: result.error.message };
  const mapped = mapExchangeOrderStatus(result.snapshot.status);
  return {
    ok: true,
    execution: {
      ...order.execution,
      orderStatus: mapped,
      filledQuantity: result.snapshot.executedQuantity ?? order.execution.filledQuantity,
      averagePrice: result.snapshot.averagePrice ?? order.execution.averagePrice,
      lastOrderSyncAt: new Date().toISOString(),
    },
  };
}
