/** Sprint 3.8C.3, Section 19 — Backend is the source of truth for "is automation ready to create a
 * new entry StrategyOrder right now." Frontend never re-derives this itself (Section 19: "Frontend
 * 不应该自己判断...Backend提供一个automation readiness/preflight结果...Frontend只展示"). Deliberately
 * a cheap, purely static computation (no Binance call) — Section 18's Monitoring card polls this
 * freely without hammering the exchange; the real, position-aware preflight (which DOES need a live
 * read) lives in `autonomousScheduler.ts`'s own preflight step, run only at actual cycle time. */
import type { AutonomousPolicy } from './autonomousPolicyStore.js';
import type { StrategyMaterializationReasonCode } from './types.js';
import { isExchangeAccountStructurallyUsable } from '../exchange/exchangeAccountStore.js';

export interface AutomationReadiness {
  analysisEnabled: boolean;
  newEntryReady: boolean;
  positionManagementReady: boolean;
  reasons: string[];
}

export function computeAutomationReadiness(policy: AutonomousPolicy): AutomationReadiness {
  const reasons: string[] = [];
  const analysisEnabled = policy.autonomousEnabled;

  const usableAccount = !!policy.exchangeAccountId && isExchangeAccountStructurallyUsable(policy.exchangeAccountId);
  if (!usableAccount) reasons.push('ACCOUNT_UNAVAILABLE：未绑定可执行的交易账户');

  const sizeReady = policy.defaultPositionSizeUsdt != null;
  const leverageReady = policy.defaultLeverage != null;
  if (!sizeReady) reasons.push('POSITION_SIZE_NOT_CONFIGURED：未配置默认仓位大小');
  if (!leverageReady) reasons.push('LEVERAGE_NOT_CONFIGURED：未配置默认杠杆');
  if (!policy.allowOpen) reasons.push('AUTOMATION_PERMISSION_DISABLED：未允许自动创建新仓位（allowOpen=false）—— 仍可用于管理已有仓位');

  const newEntryReady = analysisEnabled && usableAccount && policy.allowOpen && sizeReady && leverageReady;
  // Section 6 — Position Management never needs size/leverage/allowOpen at all.
  const positionManagementReady = analysisEnabled && usableAccount;

  return { analysisEnabled, newEntryReady, positionManagementReady, reasons };
}

export type PreflightDecision = { block: false } | { block: true; reasonCode: StrategyMaterializationReasonCode };

/** Sprint 3.8C.3, Section 5/6/7/8/25 — the pure decision at the heart of the scheduler's pre-AI
 * preflight, extracted so it's directly unit-testable without needing a real (or mocked) Binance
 * call: given the policy and whether a real position was already confirmed to exist, decide whether
 * this cycle should be blocked BEFORE calling the AI at all. Never blocks when a position exists
 * (Section 6 — Position Management needs neither field) or when `allowOpen` is false (Section 7 —
 * analysis-only, no entry ever attempted). `autonomousScheduler.ts` is the only caller that also
 * needs a REAL account/position read first — that live I/O stays there; this function only makes the
 * decision once `hasExistingPosition` is already known. */
export function decidePreflightBlock(policy: AutonomousPolicy, hasExistingPosition: boolean): PreflightDecision {
  const configMissing = policy.defaultPositionSizeUsdt == null || policy.defaultLeverage == null;
  if (!policy.allowOpen || !configMissing) return { block: false };
  if (hasExistingPosition) return { block: false };
  const reasonCode: StrategyMaterializationReasonCode = policy.defaultPositionSizeUsdt == null ? 'POSITION_SIZE_NOT_CONFIGURED' : 'LEVERAGE_NOT_CONFIGURED';
  return { block: true, reasonCode };
}
