/** Sprint 3.6B.1, Section 7 — deterministic AUTO Risk Policy evaluation. Same "BLOCK rather than
 * silently pass when unverifiable" discipline as every other Risk Guard in this app — never fail-open,
 * never AI-adjudicated. */
import type { AutoRiskPolicy } from './autoRiskPolicyStore.js';
import { toBinanceFuturesSymbol } from '../exchange/binanceFuturesAdapter.js';

export interface AutoPolicyCheck {
  ruleId: string;
  status: 'PASS' | 'BLOCKED';
  message: string;
}
export interface AutoPolicyResult {
  status: 'PASS' | 'BLOCKED';
  checkedAt: string;
  checks: AutoPolicyCheck[];
}

export interface AutoPolicyInput {
  connectionEnvironment: 'TESTNET' | 'LIVE';
  symbol: string;
  positionSizeUsdt: number;
  leverage: number;
  entryPrice: number | null;
  stopLoss: number | null;
  activeTradesCount: number;
}

/** `entryPrice`/`stopLoss` are both required for a deterministic risk-per-trade figure — a MARKET
 * entry (no fixed reference price) or a missing stop simply skips this one check (never guessed). */
export function calculateMaxRiskPerTrade(entryPrice: number | null, stopLoss: number | null, positionSizeUsdt: number): number | null {
  if (entryPrice == null || stopLoss == null || !Number.isFinite(entryPrice) || !Number.isFinite(stopLoss) || entryPrice <= 0) return null;
  if (!Number.isFinite(positionSizeUsdt) || positionSizeUsdt <= 0) return null;
  return Math.abs(entryPrice - stopLoss) / entryPrice * positionSizeUsdt;
}

export function evaluateAutoRiskPolicy(policy: AutoRiskPolicy | null, input: AutoPolicyInput): AutoPolicyResult {
  const checks: AutoPolicyCheck[] = [];
  const now = new Date().toISOString();

  if (!policy) {
    checks.push({ ruleId: 'policy_exists', status: 'BLOCKED', message: '未配置 AUTO Risk Policy' });
    return { status: 'BLOCKED', checkedAt: now, checks };
  }
  checks.push({ ruleId: 'policy_exists', status: 'PASS', message: 'AUTO Risk Policy 已配置' });

  checks.push(policy.enabled
    ? { ruleId: 'policy_enabled', status: 'PASS', message: 'AUTO Risk Policy 已启用' }
    : { ruleId: 'policy_enabled', status: 'BLOCKED', message: 'AUTO Risk Policy 未启用' });

  checks.push(policy.autoEntryEnabled
    ? { ruleId: 'auto_entry_enabled', status: 'PASS', message: '自动开仓已启用' }
    : { ruleId: 'auto_entry_enabled', status: 'BLOCKED', message: '自动开仓未启用（autoEntryEnabled=false）' });

  checks.push(input.connectionEnvironment === 'TESTNET'
    ? { ruleId: 'environment_testnet', status: 'PASS', message: '目标连接为 TESTNET' }
    : { ruleId: 'environment_testnet', status: 'BLOCKED', message: 'AUTO 仅支持 TESTNET，目标连接为 ' + input.connectionEnvironment });

  // Sprint 3.6B.2, Section 16 — compare canonical exchange symbols (BTCUSDT), never the UI-display
  // form (BTC/USDT) verbatim: a real verification run showed this rule correctly fail-closed on a
  // format-only mismatch between `StrategyOrder.symbol` and an operator-typed `allowedSymbols` entry.
  // Reuses the ONE existing normalization helper — never a second implementation, never fuzzy matching.
  const canonicalSymbol = toBinanceFuturesSymbol(input.symbol);
  const canonicalAllowed = policy.allowedSymbols.map(toBinanceFuturesSymbol);
  checks.push(canonicalAllowed.includes(canonicalSymbol)
    ? { ruleId: 'symbol_allowed', status: 'PASS', message: `${input.symbol} 在允许交易对列表中` }
    : { ruleId: 'symbol_allowed', status: 'BLOCKED', message: `${input.symbol} 不在允许交易对列表中` });

  if (policy.maxNotionalPerTrade == null) {
    checks.push({ ruleId: 'max_notional', status: 'PASS', message: '未配置单笔名义金额上限（不限制）' });
  } else {
    checks.push(input.positionSizeUsdt <= policy.maxNotionalPerTrade
      ? { ruleId: 'max_notional', status: 'PASS', message: `名义金额 ${input.positionSizeUsdt} USDT 未超过上限 ${policy.maxNotionalPerTrade} USDT` }
      : { ruleId: 'max_notional', status: 'BLOCKED', message: `名义金额 ${input.positionSizeUsdt} USDT 超过上限 ${policy.maxNotionalPerTrade} USDT` });
  }

  if (policy.maxLeverage == null) {
    checks.push({ ruleId: 'max_leverage', status: 'PASS', message: '未配置最大杠杆（不限制）' });
  } else {
    checks.push(input.leverage <= policy.maxLeverage
      ? { ruleId: 'max_leverage', status: 'PASS', message: `杠杆 ${input.leverage}x 未超过上限 ${policy.maxLeverage}x` }
      : { ruleId: 'max_leverage', status: 'BLOCKED', message: `杠杆 ${input.leverage}x 超过上限 ${policy.maxLeverage}x` });
  }

  if (policy.maxActiveTrades == null) {
    checks.push({ ruleId: 'max_active_trades', status: 'PASS', message: '未配置最大活跃自动交易数量（不限制）' });
  } else {
    checks.push(input.activeTradesCount < policy.maxActiveTrades
      ? { ruleId: 'max_active_trades', status: 'PASS', message: `当前活跃自动交易 ${input.activeTradesCount} 笔，未达上限 ${policy.maxActiveTrades} 笔` }
      : { ruleId: 'max_active_trades', status: 'BLOCKED', message: `当前活跃自动交易 ${input.activeTradesCount} 笔，已达上限 ${policy.maxActiveTrades} 笔` });
  }

  if (policy.maxRiskPerTrade != null) {
    const calculated = calculateMaxRiskPerTrade(input.entryPrice, input.stopLoss, input.positionSizeUsdt);
    if (calculated == null) {
      checks.push({ ruleId: 'max_risk_per_trade', status: 'BLOCKED', message: '无法确定性计算单笔风险金额（缺少入场价或止损），无法验证是否超限' });
    } else {
      checks.push(calculated <= policy.maxRiskPerTrade
        ? { ruleId: 'max_risk_per_trade', status: 'PASS', message: `预估单笔风险 ${calculated.toFixed(2)} USDT 未超过上限 ${policy.maxRiskPerTrade} USDT` }
        : { ruleId: 'max_risk_per_trade', status: 'BLOCKED', message: `预估单笔风险 ${calculated.toFixed(2)} USDT 超过上限 ${policy.maxRiskPerTrade} USDT` });
    }
  }

  const status = checks.some((c) => c.status === 'BLOCKED') ? 'BLOCKED' : 'PASS';
  return { status, checkedAt: now, checks };
}
