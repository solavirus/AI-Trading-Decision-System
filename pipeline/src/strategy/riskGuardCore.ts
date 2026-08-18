/** Sprint 3.6B — backend Risk Guard for the MONITORED_AUTO path. Ported from the frontend's existing
 * Risk Guard (`prototype/index.html`, Sprint 3.5A/3.5C — `evaluateMaxNotional/MaxLeverage/StopLoss/
 * AccountBalance/ExchangePositionConflict/MarketFreshness` etc.), which cannot run here because it is
 * browser JS with no backend runtime access. Same rule semantics and same "BLOCK rather than silently
 * pass when unverifiable" discipline — never fail-open. Scope deliberately narrower than the frontend
 * version: `maxNotionalPerTrade`/`maxLeverage`/`maxActiveTrades` ceilings are user-configurable
 * settings that live in browser localStorage today and have no backend-accessible equivalent yet —
 * rather than inventing a second settings store this sprint, those three checks are SKIPPED (same
 * semantics as the frontend's own "not configured" SKIPPED state — never silently treated as PASS
 * against an invented limit). `requireStopLoss`/`blockSameSymbolConflict`/`requireFreshMarketData`
 * are hardcoded ON — the same defaults the frontend ships with, and strictly safer to keep on than to
 * make configurable without a UI this sprint. */

export interface AutoRiskCheck {
  ruleId: string;
  status: 'PASS' | 'BLOCKED' | 'SKIPPED';
  message: string;
}
export interface AutoRiskResult {
  status: 'PASS' | 'BLOCKED';
  checkedAt: string;
  checks: AutoRiskCheck[];
}

export interface AutoAccountContext {
  ok: boolean;
  availableBalance: number | null;
  positions: { symbol: string; side: 'LONG' | 'SHORT' }[];
}

const MARKET_FRESHNESS_MS = 60_000;

export function evaluateAutoStopLoss(stopLoss: number | null): AutoRiskCheck {
  if (stopLoss != null && Number.isFinite(stopLoss)) return { ruleId: 'stop_loss_required', status: 'PASS', message: `已设置可执行止损价格 ${stopLoss}` };
  return { ruleId: 'stop_loss_required', status: 'BLOCKED', message: '当前执行计划未设置止损' };
}

export function evaluateAutoSameSymbolConflict(symbol: string, otherActiveSymbols: string[]): AutoRiskCheck {
  if (otherActiveSymbols.includes(symbol)) {
    return { ruleId: 'same_symbol_conflict', status: 'BLOCKED', message: `已存在同交易对 ${symbol} 的活跃 StrategyOrder，暂不允许自动提交` };
  }
  return { ruleId: 'same_symbol_conflict', status: 'PASS', message: `交易对 ${symbol} 当前没有冲突的活跃 StrategyOrder` };
}

export function evaluateAutoMarketFreshness(observedAt: string | null, now: Date = new Date()): AutoRiskCheck {
  if (!observedAt) return { ruleId: 'market_freshness', status: 'BLOCKED', message: '无法获取当前行情价格，自动提交暂不可继续' };
  const age = now.getTime() - new Date(observedAt).getTime();
  if (!(age >= 0) || age > MARKET_FRESHNESS_MS) return { ruleId: 'market_freshness', status: 'BLOCKED', message: '无法确认当前行情新鲜度，自动提交暂不可继续' };
  return { ruleId: 'market_freshness', status: 'PASS', message: `行情观测于 ${Math.round(age / 1000)} 秒前，新鲜度达标` };
}

export function evaluateAutoAccountBalance(account: AutoAccountContext | null, positionSizeUsdt: number, leverage: number): AutoRiskCheck {
  if (!account || !account.ok) return { ruleId: 'account_balance', status: 'BLOCKED', message: '无法读取真实账户状态，自动提交暂不可继续' };
  if (!Number.isFinite(positionSizeUsdt) || !Number.isFinite(leverage) || leverage <= 0) return { ruleId: 'account_balance', status: 'BLOCKED', message: '仓位大小或杠杆缺失/无效' };
  if (account.availableBalance == null || !Number.isFinite(account.availableBalance)) return { ruleId: 'account_balance', status: 'BLOCKED', message: '无法获取账户可用余额' };
  const estimatedRequiredMargin = positionSizeUsdt / leverage;
  if (estimatedRequiredMargin > account.availableBalance) return { ruleId: 'account_balance', status: 'BLOCKED', message: `预估所需保证金 ${estimatedRequiredMargin.toFixed(2)} USDT（估算值）超过账户可用余额 ${account.availableBalance.toFixed(2)} USDT` };
  return { ruleId: 'account_balance', status: 'PASS', message: `预估所需保证金 ${estimatedRequiredMargin.toFixed(2)} USDT（估算值），账户可用余额 ${account.availableBalance.toFixed(2)} USDT` };
}

export function evaluateAutoExchangePositionConflict(account: AutoAccountContext | null, symbol: string): AutoRiskCheck {
  if (!account || !account.ok) return { ruleId: 'exchange_position_conflict', status: 'BLOCKED', message: '无法读取真实账户状态，自动提交暂不可继续' };
  const pos = account.positions.find((p) => p.symbol === symbol);
  if (!pos) return { ruleId: 'exchange_position_conflict', status: 'PASS', message: `交易对 ${symbol} 当前没有已存在的真实持仓` };
  return { ruleId: 'exchange_position_conflict', status: 'BLOCKED', message: `账户已经存在 ${symbol} ${pos.side} 持仓，当前流程是新开仓，不支持自动 ADD/CLOSE/REVERSE` };
}

export function evaluateAutoRiskGuard(input: {
  symbol: string; stopLoss: number | null; positionSizeUsdt: number; leverage: number;
  otherActiveSymbols: string[]; marketObservedAt: string | null; account: AutoAccountContext | null;
}): AutoRiskResult {
  const checks = [
    evaluateAutoStopLoss(input.stopLoss),
    evaluateAutoSameSymbolConflict(input.symbol, input.otherActiveSymbols),
    evaluateAutoMarketFreshness(input.marketObservedAt),
    evaluateAutoAccountBalance(input.account, input.positionSizeUsdt, input.leverage),
    evaluateAutoExchangePositionConflict(input.account, input.symbol),
  ];
  const status = checks.some((c) => c.status === 'BLOCKED') ? 'BLOCKED' : 'PASS';
  return { status, checkedAt: new Date().toISOString(), checks };
}
