// Sprint 3.5C backend functional tests — Account-Aware Risk Guard + Full Futures Position Detail.
// TEMPORARY test file, deleted after the test run — not part of the shipped product.
import {
  normalizeBinanceFuturesAccount, normalizePositionRisk, normalizeProtectiveOrders,
  classifyPositionProtection,
} from './binanceFuturesAdapter.js';

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean) { if (cond) pass++; else { fail++; failures.push(name); console.log('FAIL:', name); } }

// =====================================================================
// Account summary normalization (Task 34)
// =====================================================================
(function testAccountSummary() {
  const accountRaw: any = {
    canTrade: true,
    totalWalletBalance: '10000.50', totalUnrealizedProfit: '123.45', totalMarginBalance: '10123.95',
    totalInitialMargin: '500.00', totalMaintMargin: '100.00', availableBalance: '9500.00',
    assets: [], positions: [],
  };
  const snap = normalizeBinanceFuturesAccount('conn-1', 'TESTNET', accountRaw, [], []);
  check('totalWalletBalance normalized', snap.accountRisk.totalWalletBalance === 10000.50);
  check('totalUnrealizedPnl normalized', snap.accountRisk.totalUnrealizedPnl === 123.45);
  check('totalMarginBalance normalized', snap.accountRisk.totalMarginBalance === 10123.95);
  check('totalInitialMargin normalized', snap.accountRisk.totalInitialMargin === 500);
  check('totalMaintMargin normalized', snap.accountRisk.totalMaintMargin === 100);
  check('availableBalance normalized', snap.accountRisk.availableBalance === 9500);
  check('canTrade normalized', snap.account.canTrade === true);

  const malformedRaw: any = { assets: [], positions: [], totalWalletBalance: 'not-a-number', availableBalance: undefined };
  const snap2 = normalizeBinanceFuturesAccount('conn-1', 'TESTNET', malformedRaw, [], []);
  check('malformed account risk field -> null, never guessed', snap2.accountRisk.totalWalletBalance === null);
  check('missing account risk field -> null', snap2.accountRisk.availableBalance === null);
})();

// =====================================================================
// Position normalization: LONG / SHORT / liquidation / isolated margin / leverage / mark price / PnL
// =====================================================================
(function testPositionNormalization() {
  const positionRiskRaw: any[] = [
    { symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0.500', entryPrice: '65000.0', markPrice: '65200.0', unRealizedProfit: '100.0', liquidationPrice: '58000.0', leverage: '10', marginType: 'isolated', isolatedMargin: '3250.0', notional: '32600.0', breakEvenPrice: '65010.0' },
    { symbol: 'ETHUSDT', positionSide: 'BOTH', positionAmt: '-2.000', entryPrice: '3200.0', markPrice: '3150.0', unRealizedProfit: '100.0', liquidationPrice: '3800.0', leverage: '5', marginType: 'cross', isolatedMargin: '0', notional: '-6300.0', breakEvenPrice: '3195.0' },
    { symbol: 'SOLUSDT', positionAmt: '0.000', entryPrice: '0', markPrice: '0' }, // zero -> excluded
  ];
  const accountPositions: any[] = [
    { symbol: 'BTCUSDT', initialMargin: '3260.0', maintMargin: '163.0' },
    { symbol: 'ETHUSDT', initialMargin: '1260.0', maintMargin: '63.0' },
  ];
  const positions = normalizePositionRisk(positionRiskRaw, accountPositions);
  check('zero position excluded (SOLUSDT)', !positions.some((p) => p.symbol === 'SOLUSDT'));
  check('exactly 2 positions survive', positions.length === 2);

  const long = positions.find((p) => p.symbol === 'BTCUSDT')!;
  check('LONG side derived from positive positionAmt', long.side === 'LONG');
  check('LONG quantity absolute value', long.quantity === 0.5);
  check('entryPrice normalized', long.entryPrice === 65000);
  check('markPrice normalized', long.markPrice === 65200);
  check('unrealizedPnl normalized', long.unrealizedPnl === 100);
  check('leverage normalized', long.leverage === 10);
  check('liquidationPrice from exchange, never calculated', long.liquidationPrice === 58000);
  check('isolatedMargin normalized (ISOLATED position)', long.isolatedMargin === 3250);
  check('marginType uppercased', long.marginType === 'ISOLATED');
  check('breakEvenPrice normalized', long.breakEvenPrice === 65010);
  check('positionInitialMargin merged from account endpoint by symbol', long.positionInitialMargin === 3260);
  check('maintenanceMargin merged from account endpoint by symbol', long.maintenanceMargin === 163);
  check('distanceToLiquidationPct computed for LONG (mark above liq)', long.distanceToLiquidationPct !== null && long.distanceToLiquidationPct! > 0);

  const short = positions.find((p) => p.symbol === 'ETHUSDT')!;
  check('SHORT side derived from negative positionAmt', short.side === 'SHORT');
  check('SHORT quantity absolute value', short.quantity === 2);
  check('marginType CROSS uppercased', short.marginType === 'CROSS');
  check('distanceToLiquidationPct computed for SHORT (mark below liq)', short.distanceToLiquidationPct !== null && short.distanceToLiquidationPct! > 0);
})();

// =====================================================================
// Malformed risk fields
// =====================================================================
(function testMalformedRiskFields() {
  const positionRiskRaw: any[] = [
    { symbol: 'ADAUSDT', positionAmt: '10', entryPrice: 'garbage', markPrice: 'garbage', liquidationPrice: '0', leverage: 'garbage', marginType: '', isolatedMargin: 'garbage' },
  ];
  const positions = normalizePositionRisk(positionRiskRaw, []);
  const p = positions[0];
  check('malformed entryPrice -> null, not NaN/0', p.entryPrice === null);
  check('malformed markPrice -> null', p.markPrice === null);
  check('liquidationPrice=0 treated as unavailable (Task 4), not a real value', p.liquidationPrice === null);
  check('malformed leverage -> null', p.leverage === null);
  check('empty marginType -> null, not empty string', p.marginType === null);
  check('malformed isolatedMargin -> null', p.isolatedMargin === null);
  check('distanceToLiquidationPct null when liquidationPrice unavailable', p.distanceToLiquidationPct === null);
  check('unmerged symbol -> positionInitialMargin/maintenanceMargin null, never guessed', p.positionInitialMargin === null && p.maintenanceMargin === null);
})();

// =====================================================================
// Protective order normalization + classification: STOP / STOP_MARKET / TAKE_PROFIT / TAKE_PROFIT_MARKET / TRAILING_STOP_MARKET / wrong side / empty
// =====================================================================
(function testProtectiveOrders() {
  const algoOrdersRaw: any[] = [
    { algoId: 1001, symbol: 'BTCUSDT', side: 'SELL', orderType: 'STOP_MARKET', algoStatus: 'NEW', triggerPrice: '63000', quantity: '0.5', closePosition: true, reduceOnly: true, createTime: 1750000000000 },
    { algoId: 1002, symbol: 'BTCUSDT', side: 'SELL', orderType: 'STOP', algoStatus: 'NEW', triggerPrice: '62500', price: '62400', quantity: '0.5' },
    { algoId: 1003, symbol: 'BTCUSDT', side: 'SELL', orderType: 'TAKE_PROFIT_MARKET', algoStatus: 'NEW', triggerPrice: '68000', quantity: '0.25' },
    { algoId: 1004, symbol: 'BTCUSDT', side: 'SELL', orderType: 'TAKE_PROFIT', algoStatus: 'NEW', triggerPrice: '69000', price: '69100', quantity: '0.25' },
    { algoId: 1005, symbol: 'BTCUSDT', side: 'SELL', orderType: 'TRAILING_STOP_MARKET', algoStatus: 'NEW', quantity: '0.5' },
    { algoId: 1006, symbol: 'BTCUSDT', side: 'BUY', orderType: 'STOP_MARKET', algoStatus: 'NEW', triggerPrice: '70000', quantity: '0.1' }, // wrong side for a LONG position's protective order
  ];
  const normalized = normalizeProtectiveOrders(algoOrdersRaw);
  check('normalizeProtectiveOrders produces 6 entries', normalized.length === 6);
  check('exchangeOrderId is stringified algoId', normalized[0].exchangeOrderId === '1001');
  check('triggerPrice normalized', normalized[0].triggerPrice === 63000);
  check('closePosition/reduceOnly normalized', normalized[0].closePosition === true && normalized[0].reduceOnly === true);
  check('createdAt normalized to ISO string', normalized[0].createdAt === new Date(1750000000000).toISOString());

  const longSide = 'LONG' as const;
  check('STOP_MARKET + correct side (SELL for LONG) -> STOP_LOSS', classifyPositionProtection(normalized[0], longSide) === 'STOP_LOSS');
  check('STOP + correct side -> STOP_LOSS', classifyPositionProtection(normalized[1], longSide) === 'STOP_LOSS');
  check('TAKE_PROFIT_MARKET + correct side -> TAKE_PROFIT', classifyPositionProtection(normalized[2], longSide) === 'TAKE_PROFIT');
  check('TAKE_PROFIT + correct side -> TAKE_PROFIT', classifyPositionProtection(normalized[3], longSide) === 'TAKE_PROFIT');
  check('TRAILING_STOP_MARKET + correct side -> TRAILING_STOP', classifyPositionProtection(normalized[4], longSide) === 'TRAILING_STOP');
  check('STOP_MARKET but WRONG side (BUY on a LONG) -> OTHER, never guessed', classifyPositionProtection(normalized[5], longSide) === 'OTHER');

  // full attach-to-position pipeline via normalizeBinanceFuturesAccount
  const positionRiskRaw: any[] = [{ symbol: 'BTCUSDT', positionAmt: '0.5', entryPrice: '65000', markPrice: '65200' }];
  const snap = normalizeBinanceFuturesAccount('conn-1', 'TESTNET', { assets: [], positions: [] } as any, positionRiskRaw, algoOrdersRaw);
  const pos = snap.positions[0];
  check('attached stopLossOrders count (STOP_MARKET + STOP)', pos.protection.stopLossOrders.length === 2);
  check('attached takeProfitOrders count (TAKE_PROFIT_MARKET + TAKE_PROFIT)', pos.protection.takeProfitOrders.length === 2);
  check('attached trailingStopOrders count', pos.protection.trailingStopOrders.length === 1);
  check('attached otherOrders count (wrong-side order)', pos.protection.otherOrders.length === 1);
  check('snapshot-level protectiveOrders includes all 6 regardless of attachment', snap.protectiveOrders.length === 6);

  // empty protection case
  const snapEmpty = normalizeBinanceFuturesAccount('conn-1', 'TESTNET', { assets: [], positions: [] } as any, positionRiskRaw, []);
  const posEmpty = snapEmpty.positions[0];
  check('empty protection: all four arrays empty', posEmpty.protection.stopLossOrders.length === 0 && posEmpty.protection.takeProfitOrders.length === 0 && posEmpty.protection.trailingStopOrders.length === 0 && posEmpty.protection.otherOrders.length === 0);
})();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('Failures:', failures); process.exit(1); }
