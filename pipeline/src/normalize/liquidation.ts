import type { RawBinanceLiquidation } from '../connectors/binanceLiquidationConnector.js';
import type { RawCoinglassLiquidation } from '../connectors/coinglassLiquidationConnector.js';
import type { LiquidationEventInput } from '../db.js';

/** Thin (both connectors' raw shapes already match the canonical LiquidationEvent almost
 * exactly — each connector does its own provider-specific mapping) but kept as its own step per
 * DATA_SOURCE_SPEC.md's Normalize layer, so the collector/DB layer never needs to know which
 * provider an event came from. */
export function normalizeLiquidationEvent(raw: RawBinanceLiquidation | RawCoinglassLiquidation): LiquidationEventInput {
  return {
    exchange: raw.exchange,
    symbol: raw.symbol,
    side: raw.side,
    price: raw.price,
    qty: raw.qty,
    usd: raw.usd,
    timestamp: raw.timestamp,
  };
}
