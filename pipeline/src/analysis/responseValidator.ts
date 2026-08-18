/** Sprint 3.9 — faithful backend port of `prototype/index.html`'s AI Response Parser/Validator
 * (`parseAiResponse` and its full dependency chain, implementing `AI_RESPONSE_SPEC.md`). Copied
 * verbatim, not redesigned (Section 1). The one addition is `validatePositionManagementDecision`
 * (Section 16), invoked only when the originating payload carried a `positionContext`. */
import type { AiResponseBody, AnalysisPayload, PositionManagementAction, PositionManagementDecision, ScenarioPlan } from './types.js';
import { WEIGHT_DEFS } from './weightDefs.js';

export class ParserError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = 'ParserError';
  }
}
function err(code: string, message: string, details?: unknown): ParserError { return new ParserError(code, message, details); }

function isFiniteNumber(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }
function isNonEmptyString(v: unknown): v is string { return typeof v === 'string' && v.trim().length > 0; }
function isPlainObject(v: unknown): v is Record<string, any> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function inRange0to100(v: unknown): boolean { return isFiniteNumber(v) && v >= 0 && v <= 100; }
function isNonEmptyStringArray(v: unknown): v is string[] { return Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString); }

/* ---- Step 1: reject if the raw AI request itself was not successful ---- */
export function assertRawResultSucceeded(rawResult: { status: string; rawText?: string; error?: unknown } | null | undefined): void {
  if (!rawResult || rawResult.status !== 'success') {
    throw err('raw_request_failed', 'AIRawResult 未成功，无法解析', { status: rawResult && rawResult.status, error: rawResult && rawResult.error });
  }
  if (!isNonEmptyString(rawResult.rawText)) {
    throw err('empty_response', 'AIRawResult.rawText 为空');
  }
}

/* ---- Step 2: strict JSON parse — no repair, no fence stripping. ---- */
export function strictParseJson(rawText: string): Record<string, any> {
  let parsed: unknown;
  try { parsed = JSON.parse(rawText); }
  catch (e: any) { throw err('invalid_json', '原始响应不是合法 JSON：' + e.message, { rawTextLength: rawText.length }); }
  if (!isPlainObject(parsed)) throw err('invalid_json', '原始响应必须是一个 JSON 对象（不能是数组/字符串/数字等）');
  return parsed;
}

const AI_RESPONSE_SUPPORTED_MAJOR = 2;
const AI_RESPONSE_SUPPORTED_MAX_MINOR = 2;
const AI_RESPONSE_SYSTEM_SOURCE_KEYS = WEIGHT_DEFS.map((w) => w.key);

/* ---- Step 3: response version. ---- */
export function validateResponseVersion(responseVersion: unknown): void {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(responseVersion));
  if (!m) throw err('unsupported_response_version', 'responseVersion 格式不正确（需要 semver 字符串）：' + responseVersion, { responseVersion });
  const major = Number(m[1]), minor = Number(m[2]);
  if (major !== AI_RESPONSE_SUPPORTED_MAJOR || minor > AI_RESPONSE_SUPPORTED_MAX_MINOR) {
    throw err('unsupported_response_version', '不受支持的 responseVersion：' + responseVersion, { responseVersion, supportedMajor: AI_RESPONSE_SUPPORTED_MAJOR, supportedMaxMinor: AI_RESPONSE_SUPPORTED_MAX_MINOR });
  }
}

/* ---- Step 4: schema validation. ---- */
export function validateRootFieldsPresent(r: Record<string, any>): void {
  const required = ['responseVersion', 'analysisId', 'summary', 'decision', 'scenarioPlans', 'sourceAssessments', 'reasoning', 'risks', 'evidence'];
  for (const f of required) if (!(f in r)) throw err('schema_validation_failed', '缺少必填字段：' + f, { field: f });
  if (!isNonEmptyString(r.responseVersion)) throw err('schema_validation_failed', 'responseVersion 必须是非空字符串');
  if (!isNonEmptyString(r.analysisId)) throw err('schema_validation_failed', 'analysisId 必须是非空字符串');
}

function validateScenarioEntryShape(entry: any, i: number): void {
  if (!isPlainObject(entry)) throw err('schema_validation_failed', `scenarioPlans[${i}].entry 必须是对象（v2.1 起不允许 null）`, { index: i });
  if (!['MARKET', 'LIMIT', 'ZONE', 'CONDITIONAL'].includes(entry.type)) throw err('schema_validation_failed', `scenarioPlans[${i}].entry.type 非法枚举值`, { index: i, value: entry.type });
  for (const f of ['value', 'from', 'to']) {
    const v = entry[f];
    if (v !== undefined && v !== null && !isFiniteNumber(v)) throw err('schema_validation_failed', `scenarioPlans[${i}].entry.${f} 必须是数字、null 或省略`, { index: i, field: f, value: v });
  }
  if (entry.description !== undefined && entry.description !== null && !isNonEmptyString(entry.description)) throw err('schema_validation_failed', `scenarioPlans[${i}].entry.description 如提供必须是非空字符串`, { index: i });
  if (entry.type === 'CONDITIONAL' && !isNonEmptyString(entry.description)) throw err('schema_validation_failed', `scenarioPlans[${i}].entry.type=CONDITIONAL 时必须提供非空的 description`, { index: i });
}
function validateScenarioStopLossShape(sl: any, i: number): void {
  if (!isPlainObject(sl)) throw err('schema_validation_failed', `scenarioPlans[${i}].stopLoss 必须是对象（v2.1 起不允许 null）`, { index: i });
  if (sl.value !== undefined && sl.value !== null && !isFiniteNumber(sl.value)) throw err('schema_validation_failed', `scenarioPlans[${i}].stopLoss.value 必须是数字、null 或省略`, { index: i });
  if (sl.description !== undefined && sl.description !== null && !isNonEmptyString(sl.description)) throw err('schema_validation_failed', `scenarioPlans[${i}].stopLoss.description 如提供必须是非空字符串`, { index: i });
  if (sl.value == null && !isNonEmptyString(sl.description)) throw err('schema_validation_failed', `scenarioPlans[${i}].stopLoss 必须提供 value 或 description 中至少一项有意义的内容`, { index: i });
}
function validateScenarioTakeProfitItemShape(tp: any, i: number, j: number): void {
  if (!isPlainObject(tp)) throw err('schema_validation_failed', `scenarioPlans[${i}].takeProfit[${j}] 必须是对象`, { index: i, j });
  if (tp.value !== undefined && tp.value !== null && !isFiniteNumber(tp.value)) throw err('schema_validation_failed', `scenarioPlans[${i}].takeProfit[${j}].value 必须是数字、null 或省略`, { index: i, j });
  if (tp.description !== undefined && tp.description !== null && !isNonEmptyString(tp.description)) throw err('schema_validation_failed', `scenarioPlans[${i}].takeProfit[${j}].description 如提供必须是非空字符串`, { index: i, j });
  if (tp.value == null && !isNonEmptyString(tp.description)) throw err('schema_validation_failed', `scenarioPlans[${i}].takeProfit[${j}] 必须提供 value 或 description 中至少一项有意义的内容`, { index: i, j });
}

const TRIGGER_ALLOWED_METRICS = ['price', 'candle_close'];
const TRIGGER_ALLOWED_OPERATORS = ['GT', 'GTE', 'LT', 'LTE', 'BETWEEN', 'CROSSES_ABOVE', 'CROSSES_BELOW', 'EQUALS'];
function validateTriggerCondition(cond: any, i: number, context: string): void {
  if (!isPlainObject(cond)) throw err('schema_validation_failed', context + ' 必须是对象', { index: i });
  if (!TRIGGER_ALLOWED_METRICS.includes(cond.metric)) throw err('schema_validation_failed', context + ' 使用了不受支持的 metric（仅支持 price / candle_close）：' + cond.metric, { index: i, metric: cond.metric });
  if (!TRIGGER_ALLOWED_OPERATORS.includes(cond.operator)) throw err('schema_validation_failed', context + ' 使用了不受支持的 operator', { index: i, operator: cond.operator });
  const op = cond.operator;
  if (op === 'BETWEEN') {
    if (!isFiniteNumber(cond.min) || !isFiniteNumber(cond.max)) throw err('schema_validation_failed', context + ' 的 BETWEEN 需要有效数字 min 与 max', { index: i });
    if (cond.min > cond.max) throw err('schema_validation_failed', context + ' 的 BETWEEN min 不能大于 max', { index: i, min: cond.min, max: cond.max });
  } else {
    if (!isFiniteNumber(cond.value)) throw err('schema_validation_failed', context + ' 的 ' + op + ' 需要一个有效数字 value（不接受字符串强转）', { index: i, operator: op, value: cond.value });
  }
  if (cond.metric === 'candle_close') {
    if (!isNonEmptyString(cond.timeframe)) throw err('schema_validation_failed', context + ' 的 candle_close 条件必须提供非空 timeframe', { index: i });
  } else if (cond.metric === 'price') {
    if (cond.timeframe != null && cond.timeframe !== '') throw err('schema_validation_failed', context + ' 的 price 条件的 timeframe 应为 null 或省略', { index: i, timeframe: cond.timeframe });
  }
}
function validateStructuredTrigger(st: any, i: number, fieldLabel: string): void {
  if (st === null || st === undefined) return;
  if (!isPlainObject(st)) throw err('schema_validation_failed', `scenarioPlans[${i}].${fieldLabel} 必须是对象或 null`, { index: i });
  if (!isNonEmptyString(st.description)) throw err('schema_validation_failed', `scenarioPlans[${i}].${fieldLabel}.description 必须是非空字符串`, { index: i });
  if (!['ALL', 'ANY'].includes(st.logic)) throw err('schema_validation_failed', `scenarioPlans[${i}].${fieldLabel}.logic 非法枚举值`, { index: i, value: st.logic });
  if (!Array.isArray(st.conditions) || st.conditions.length < 1) throw err('schema_validation_failed', `scenarioPlans[${i}].${fieldLabel}.conditions 必须至少包含一项`, { index: i });
  st.conditions.forEach((c: any, j: number) => validateTriggerCondition(c, i, `scenarioPlans[${i}].${fieldLabel}.conditions[${j}]`));
}
function isValidAbsoluteTimestamp(s: unknown): boolean {
  if (!isNonEmptyString(s)) return false;
  const d = new Date(s);
  if (isNaN(d.getTime())) return false;
  return /Z$|[+-]\d{2}:?\d{2}$/.test(s.trim());
}
function validateReviewHorizonShape(rh: any, i: number): void {
  if (rh === null || rh === undefined) return;
  if (!isPlainObject(rh)) throw err('schema_validation_failed', `scenarioPlans[${i}].reviewHorizon 必须是对象或 null`, { index: i });
  if (!isNonEmptyString(rh.description)) throw err('schema_validation_failed', `scenarioPlans[${i}].reviewHorizon.description 必须是非空字符串`, { index: i });
  if (rh.expiresAt !== undefined && rh.expiresAt !== null && !isValidAbsoluteTimestamp(rh.expiresAt)) {
    throw err('schema_validation_failed', `scenarioPlans[${i}].reviewHorizon.expiresAt 如提供必须是带时区/偏移的有效 ISO-8601 绝对时间戳`, { index: i, value: rh.expiresAt });
  }
}
function isMachineEvaluableTrigger(triggerStructured: any): boolean {
  if (!triggerStructured || !Array.isArray(triggerStructured.conditions) || triggerStructured.conditions.length < 1) return false;
  return triggerStructured.conditions.every((c: any) => c && TRIGGER_ALLOWED_METRICS.includes(c.metric) && TRIGGER_ALLOWED_OPERATORS.includes(c.operator));
}
function getScenarioEntryReferencePrice(entry: any): number | null {
  if (!entry) return null;
  if (entry.type === 'LIMIT') return isFiniteNumber(entry.value) ? entry.value : null;
  if (entry.type === 'ZONE') return (isFiniteNumber(entry.from) && isFiniteNumber(entry.to)) ? (entry.from + entry.to) / 2 : null;
  return null;
}

export function evaluateScenarioExecutionReadiness(scenario: any, decision: any, referenceTime: Date | string | null): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!scenario) return { ready: false, reasons: ['方案不存在'] };
  const isPrimary = scenario.priority === 'PRIMARY';
  const isPrimaryEnterNow = isPrimary && decision && decision.action === 'ENTER';
  const isPrimaryWait = isPrimary && decision && decision.action === 'WAIT';

  const entry = scenario.entry;
  if (!entry || !['MARKET', 'LIMIT', 'ZONE', 'CONDITIONAL'].includes(entry.type)) {
    reasons.push('缺少有效的入场类型');
  } else if (entry.type === 'CONDITIONAL') {
    reasons.push('入场类型为 CONDITIONAL（纯文字描述），不满足可执行数值要求，应改用带数值的 LIMIT/ZONE，条件逻辑放入 triggerStructured');
  } else if (entry.type === 'MARKET') {
    if (!isPrimaryEnterNow) reasons.push('MARKET 入场仅允许用于当前可立即执行的 PRIMARY 方案（decision.action=ENTER）');
  } else if (entry.type === 'LIMIT') {
    if (!isFiniteNumber(entry.value) || entry.value <= 0) reasons.push('LIMIT 入场缺少有效的数值价格（entry.value）');
  } else if (entry.type === 'ZONE') {
    if (!isFiniteNumber(entry.from) || !isFiniteNumber(entry.to) || entry.from <= 0 || entry.to <= 0) reasons.push('ZONE 入场缺少有效的数值区间（entry.from/entry.to）');
    else if (entry.from > entry.to) reasons.push('ZONE 入场的 from 不能大于 to');
  }

  if (!scenario.stopLoss || !isFiniteNumber(scenario.stopLoss.value) || scenario.stopLoss.value <= 0) {
    reasons.push('缺少有效的数值止损（stopLoss.value）——文字描述不满足可执行要求');
  }

  const tp = Array.isArray(scenario.takeProfit) ? scenario.takeProfit : [];
  const numericTp = tp.filter((t: any) => t && isFiniteNumber(t.value) && t.value > 0);
  if (numericTp.length === 0) reasons.push('缺少至少一个有效的数值止盈目标（takeProfit[].value）——文字描述不满足可执行要求');

  const rh = scenario.reviewHorizon;
  let expiresAtTime: number | null = null;
  if (!rh || !isValidAbsoluteTimestamp(rh.expiresAt)) {
    reasons.push('缺少有效的带时区绝对到期时间（reviewHorizon.expiresAt）');
  } else {
    expiresAtTime = new Date(rh.expiresAt).getTime();
  }

  if (isPrimaryWait && !isMachineEvaluableTrigger(scenario.triggerStructured)) {
    reasons.push('WAIT 方案的 PRIMARY 缺少可机器判定的数值触发条件（triggerStructured）');
  }

  const refPrice = getScenarioEntryReferencePrice(entry);
  if (refPrice != null && scenario.stopLoss && isFiniteNumber(scenario.stopLoss.value)) {
    const slVal = scenario.stopLoss.value;
    if (scenario.direction === 'LONG' && slVal >= refPrice) reasons.push(`LONG 方案的止损（${slVal}）不应高于或等于入场参考价（${refPrice}）`);
    if (scenario.direction === 'SHORT' && slVal <= refPrice) reasons.push(`SHORT 方案的止损（${slVal}）不应低于或等于入场参考价（${refPrice}）`);
  }
  if (refPrice != null) {
    numericTp.forEach((t: any) => {
      if (scenario.direction === 'LONG' && t.value <= refPrice) reasons.push(`LONG 方案存在止盈目标（${t.value}）不高于入场参考价（${refPrice}）`);
      if (scenario.direction === 'SHORT' && t.value >= refPrice) reasons.push(`SHORT 方案存在止盈目标（${t.value}）不低于入场参考价（${refPrice}）`);
    });
  }

  if (expiresAtTime != null && referenceTime) {
    const refTime = referenceTime instanceof Date ? referenceTime.getTime() : new Date(referenceTime).getTime();
    if (expiresAtTime <= refTime) reasons.push('该方案的有效期（expiresAt）已过');
  }

  return { ready: reasons.length === 0, reasons };
}

function validateScenarioPlanItemShape(sp: any, i: number): void {
  if (!isPlainObject(sp)) throw err('schema_validation_failed', `scenarioPlans[${i}] 必须是对象`, { index: i });
  if (!isNonEmptyString(sp.id)) throw err('schema_validation_failed', `scenarioPlans[${i}].id 必须是非空字符串`, { index: i });
  if (!['PRIMARY', 'ALTERNATIVE', 'INVALIDATION'].includes(sp.priority)) throw err('schema_validation_failed', `scenarioPlans[${i}].priority 非法枚举值`, { index: i, value: sp.priority });
  if (!['LONG', 'SHORT'].includes(sp.direction)) throw err('schema_validation_failed', `scenarioPlans[${i}].direction 非法枚举值`, { index: i, value: sp.direction });
  if (sp.action !== 'ENTER') throw err('schema_validation_failed', `scenarioPlans[${i}].action 必须是 "ENTER"`, { index: i, value: sp.action });
  if (!isNonEmptyString(sp.title)) throw err('schema_validation_failed', `scenarioPlans[${i}].title 必须是非空字符串`, { index: i });
  if (!isNonEmptyString(sp.trigger)) throw err('schema_validation_failed', `scenarioPlans[${i}].trigger 必须是非空字符串`, { index: i });
  if (sp.holdingPeriod !== undefined && !isNonEmptyString(sp.holdingPeriod)) throw err('schema_validation_failed', `scenarioPlans[${i}].holdingPeriod 如提供必须是非空字符串`, { index: i });
  validateScenarioEntryShape(sp.entry, i);
  validateScenarioStopLossShape(sp.stopLoss, i);
  if (!Array.isArray(sp.takeProfit) || sp.takeProfit.length < 1) throw err('schema_validation_failed', `scenarioPlans[${i}].takeProfit 至少需要一项（v2.1 起不允许空数组）`, { index: i });
  sp.takeProfit.forEach((tp: any, j: number) => validateScenarioTakeProfitItemShape(tp, i, j));
  if (!isNonEmptyString(sp.rationale)) throw err('schema_validation_failed', `scenarioPlans[${i}].rationale 必须是非空字符串`, { index: i });
  if (!isNonEmptyStringArray(sp.evidenceReferences)) throw err('schema_validation_failed', `scenarioPlans[${i}].evidenceReferences 必须是至少含一项的字符串数组`, { index: i });
  validateStructuredTrigger(sp.triggerStructured, i, 'triggerStructured');
  validateStructuredTrigger(sp.invalidation, i, 'invalidation');
  validateReviewHorizonShape(sp.reviewHorizon, i);
  if (sp.priority === 'PRIMARY' && (!sp.reviewHorizon || !isNonEmptyString(sp.reviewHorizon.description))) {
    throw err('schema_validation_failed', `scenarioPlans[${i}]：PRIMARY 方案必须提供 reviewHorizon 且 description 非空`, { index: i });
  }
}
function validateSourceAssessmentItemShape(sa: any, i: number): void {
  if (!isPlainObject(sa)) throw err('schema_validation_failed', `sourceAssessments[${i}] 必须是对象`, { index: i });
  if (!isNonEmptyString(sa.sourceId)) throw err('schema_validation_failed', `sourceAssessments[${i}].sourceId 必须是非空字符串`, { index: i });
  if (!isFiniteNumber(sa.configuredWeight)) throw err('schema_validation_failed', `sourceAssessments[${i}].configuredWeight 必须是数字`, { index: i });
  if (!['LONG', 'SHORT', 'NEUTRAL'].includes(sa.direction)) throw err('schema_validation_failed', `sourceAssessments[${i}].direction 非法枚举值`, { index: i, value: sa.direction });
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(sa.evidenceStrength)) throw err('schema_validation_failed', `sourceAssessments[${i}].evidenceStrength 非法枚举值`, { index: i, value: sa.evidenceStrength });
  if (!isNonEmptyString(sa.explanation)) throw err('schema_validation_failed', `sourceAssessments[${i}].explanation 必须是非空字符串`, { index: i });
  if (!isNonEmptyStringArray(sa.evidenceReferences)) throw err('schema_validation_failed', `sourceAssessments[${i}].evidenceReferences 必须是至少含一项的字符串数组`, { index: i });
}
function validateReasoningItemShape(it: any, i: number): void {
  if (!isPlainObject(it)) throw err('schema_validation_failed', `reasoning[${i}] 必须是对象`, { index: i });
  if (!isNonEmptyString(it.title)) throw err('schema_validation_failed', `reasoning[${i}].title 必须是非空字符串`, { index: i });
  if (!isNonEmptyString(it.description)) throw err('schema_validation_failed', `reasoning[${i}].description 必须是非空字符串`, { index: i });
  if (!inRange0to100(it.importance)) throw err('schema_validation_failed', `reasoning[${i}].importance 必须是 0-100 之间的数字`, { index: i });
  if (!['SUPPORT', 'OPPOSE', 'NEUTRAL'].includes(it.stance)) throw err('schema_validation_failed', `reasoning[${i}].stance 非法枚举值`, { index: i, value: it.stance });
  if (!isNonEmptyStringArray(it.evidenceReferences)) throw err('schema_validation_failed', `reasoning[${i}].evidenceReferences 必须是至少含一项的字符串数组`, { index: i });
}
function validateRiskItemShape(it: any, i: number): void {
  if (!isPlainObject(it)) throw err('schema_validation_failed', `risks[${i}] 必须是对象`, { index: i });
  if (!isNonEmptyString(it.title)) throw err('schema_validation_failed', `risks[${i}].title 必须是非空字符串`, { index: i });
  if (!isNonEmptyString(it.description)) throw err('schema_validation_failed', `risks[${i}].description 必须是非空字符串`, { index: i });
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(it.impact)) throw err('schema_validation_failed', `risks[${i}].impact 非法枚举值`, { index: i, value: it.impact });
}
function validateEvidenceReferenceItemShape(it: any, i: number): void {
  if (!isPlainObject(it)) throw err('schema_validation_failed', `evidence[${i}] 必须是对象`, { index: i });
  if (!isNonEmptyString(it.reason)) throw err('schema_validation_failed', `evidence[${i}].reason 必须是非空字符串`, { index: i });
  if (!isNonEmptyStringArray(it.references)) throw err('schema_validation_failed', `evidence[${i}].references 必须是至少含一项的字符串数组`, { index: i });
}

export function validateAiResponseSchema(r: Record<string, any>): void {
  if (!isPlainObject(r.summary)) throw err('schema_validation_failed', 'summary 必须是对象');
  if (!isNonEmptyString(r.summary.title)) throw err('schema_validation_failed', 'summary.title 必须是非空字符串');
  if (!isNonEmptyString(r.summary.content)) throw err('schema_validation_failed', 'summary.content 必须是非空字符串');
  const summaryWordCount = r.summary.content.trim().split(/\s+/).length;
  if (summaryWordCount > 150) throw err('schema_validation_failed', 'summary.content 超过 150 词上限', { wordCount: summaryWordCount });

  if (!isPlainObject(r.decision)) throw err('schema_validation_failed', 'decision 必须是对象');
  if (!['LONG', 'SHORT'].includes(r.decision.direction)) throw err('schema_validation_failed', 'decision.direction 非法枚举值（v2 不再允许 NEUTRAL）', { value: r.decision.direction });
  if (!['ENTER', 'WAIT'].includes(r.decision.action)) throw err('schema_validation_failed', 'decision.action 非法枚举值（v2 不再允许 EXIT/REDUCE）', { value: r.decision.action });
  if (!inRange0to100(r.decision.confidence)) throw err('schema_validation_failed', 'decision.confidence 必须是 0-100 之间的数字', { value: r.decision.confidence });

  if (!Array.isArray(r.scenarioPlans)) throw err('schema_validation_failed', 'scenarioPlans 必须是数组');
  r.scenarioPlans.forEach(validateScenarioPlanItemShape);

  if (!Array.isArray(r.sourceAssessments)) throw err('schema_validation_failed', 'sourceAssessments 必须是数组');
  r.sourceAssessments.forEach(validateSourceAssessmentItemShape);

  if (!Array.isArray(r.reasoning)) throw err('schema_validation_failed', 'reasoning 必须是数组');
  if (r.reasoning.length > 5) throw err('schema_validation_failed', 'reasoning 最多 5 项，实际 ' + r.reasoning.length + ' 项', { count: r.reasoning.length });
  r.reasoning.forEach(validateReasoningItemShape);

  if (!Array.isArray(r.risks)) throw err('schema_validation_failed', 'risks 必须是数组');
  if (r.risks.length > 5) throw err('schema_validation_failed', 'risks 最多 5 项，实际 ' + r.risks.length + ' 项', { count: r.risks.length });
  r.risks.forEach(validateRiskItemShape);

  if (!Array.isArray(r.evidence)) throw err('schema_validation_failed', 'evidence 必须是数组');
  r.evidence.forEach(validateEvidenceReferenceItemShape);
}

export function validateScenarioPlansCrossRules(r: Record<string, any>, analysisTime: Date): void {
  const plans = r.scenarioPlans;
  if (plans.length < 1 || plans.length > 3) throw err('schema_validation_failed', 'scenarioPlans 数量必须在 1-3 之间，实际 ' + plans.length, { count: plans.length });
  const primaries = plans.filter((p: any) => p.priority === 'PRIMARY');
  if (primaries.length !== 1) throw err('schema_validation_failed', 'scenarioPlans 必须恰好包含 1 个 PRIMARY，实际 ' + primaries.length, { count: primaries.length });
  const primary = primaries[0];

  const readiness = evaluateScenarioExecutionReadiness(primary, r.decision, analysisTime);
  if (!readiness.ready) throw err('schema_validation_failed', 'PRIMARY 方案未满足数值执行就绪要求：' + readiness.reasons.join('；'), { reasons: readiness.reasons });
  if (r.decision.action === 'ENTER' && !isNonEmptyString(primary.holdingPeriod)) {
    throw err('schema_validation_failed', 'ENTER 决策的 PRIMARY 方案必须提供非空的 holdingPeriod');
  }
}

export function validateAnalysisIdMatch(r: Record<string, any>, payload: AnalysisPayload): void {
  if (r.analysisId !== payload.analysisId) {
    throw err('analysis_id_mismatch', 'AIResponse.analysisId 与 Analysis Payload 不匹配', { responseAnalysisId: r.analysisId, payloadAnalysisId: payload.analysisId });
  }
}

export function validateSourceAssessmentCrossRules(r: Record<string, any>, payload: AnalysisPayload): void {
  const seen = new Set<string>();
  const evidenceById = new Map((payload.additionalEvidence || []).map((e) => [e.id, e]));
  r.sourceAssessments.forEach((sa: any, i: number) => {
    if (seen.has(sa.sourceId)) throw err('weight_validation_failed', 'sourceAssessments 存在重复 sourceId：' + sa.sourceId, { sourceId: sa.sourceId, index: i });
    seen.add(sa.sourceId);

    const isSystemSource = AI_RESPONSE_SYSTEM_SOURCE_KEYS.includes(sa.sourceId);
    const evidenceMatch = evidenceById.get(sa.sourceId);
    if (!isSystemSource && !evidenceMatch) throw err('weight_validation_failed', 'sourceAssessments 引用了未知 sourceId：' + sa.sourceId, { sourceId: sa.sourceId, index: i });

    const expectedWeight = isSystemSource ? Number(payload.sourceWeights[sa.sourceId]) : Number((evidenceMatch as any).weight);
    if (sa.configuredWeight !== expectedWeight) throw err('weight_validation_failed', 'sourceAssessments.configuredWeight 与 Analysis Payload 不一致：' + sa.sourceId, { sourceId: sa.sourceId, expected: expectedWeight, actual: sa.configuredWeight });
  });

  const missing = AI_RESPONSE_SYSTEM_SOURCE_KEYS.filter((id) => Number(payload.sourceWeights[id]) > 0 && !seen.has(id));
  if (missing.length > 0) throw err('weight_validation_failed', '缺少权重 > 0 的系统来源对应的 sourceAssessments：' + missing.join(', '), { missing });
}

function collectValidEvidenceReferenceIds(payload: AnalysisPayload) {
  return {
    sourceSnapshots: new Set((payload.sourceSnapshots || []).map((s) => s.id)),
    selectedNewsEvents: new Set((payload.selectedNewsEvents || []).map((e) => e.id)),
    additionalEvidence: new Set((payload.additionalEvidence || []).map((e) => e.id)),
  };
}
function assertValidEvidenceReference(ref: string, validSets: ReturnType<typeof collectValidEvidenceReferenceIds>, context: string): void {
  const m = /^(sourceSnapshots|selectedNewsEvents|additionalEvidence):(.+)$/.exec(ref);
  if (!m) throw err('evidence_reference_invalid', '证据引用格式不受支持：' + ref, { ref, context });
  const [, namespace, id] = m;
  if (!(validSets as any)[namespace].has(id)) throw err('evidence_reference_invalid', '证据引用在 Analysis Payload 中不存在：' + ref, { ref, namespace, id, context });
}
export function validateEvidenceReferences(r: Record<string, any>, payload: AnalysisPayload): void {
  const validSets = collectValidEvidenceReferenceIds(payload);
  r.reasoning.forEach((it: any, i: number) => it.evidenceReferences.forEach((ref: string) => assertValidEvidenceReference(ref, validSets, `reasoning[${i}]`)));
  r.sourceAssessments.forEach((sa: any, i: number) => sa.evidenceReferences.forEach((ref: string) => assertValidEvidenceReference(ref, validSets, `sourceAssessments[${i}]`)));
  r.scenarioPlans.forEach((sp: any, i: number) => sp.evidenceReferences.forEach((ref: string) => assertValidEvidenceReference(ref, validSets, `scenarioPlans[${i}]`)));
  r.evidence.forEach((it: any, i: number) => it.references.forEach((ref: string) => assertValidEvidenceReference(ref, validSets, `evidence[${i}]`)));
}

/** Sprint 3.9, Section 16 — validates the ONE additive field, `positionManagement`, ONLY when the
 * originating payload carried a real position. Structurally narrow, matching Section 16's contract
 * exactly: HOLD/CLOSE need no extra fields; ADJUST_SL/ADJUST_TP/REDUCE each require exactly the one
 * field they need. `ADD_POSITION` is not in the allowed-action list at all (Section 16/32.I —
 * "ADD_POSITION rejected"), so an AI attempting to return it fails schema validation the same as any
 * other invalid enum value. */
const POSITION_MANAGEMENT_ACTIONS: PositionManagementAction[] = ['HOLD', 'ADJUST_SL', 'ADJUST_TP', 'REDUCE', 'CLOSE'];
export function validatePositionManagementDecision(pm: unknown): PositionManagementDecision {
  if (!isPlainObject(pm)) throw err('schema_validation_failed', 'positionManagement 必须是对象（已存在真实持仓，AI 响应中必须包含该字段）');
  if (!POSITION_MANAGEMENT_ACTIONS.includes(pm.action)) throw err('schema_validation_failed', 'positionManagement.action 非法枚举值（仅支持 HOLD/ADJUST_SL/ADJUST_TP/REDUCE/CLOSE，不支持 ADD_POSITION）', { value: pm.action });
  if (!isNonEmptyString(pm.rationale)) throw err('schema_validation_failed', 'positionManagement.rationale 必须是非空字符串');
  if (!inRange0to100(pm.confidence)) throw err('schema_validation_failed', 'positionManagement.confidence 必须是 0-100 之间的数字', { value: pm.confidence });

  const decision: PositionManagementDecision = { action: pm.action, rationale: pm.rationale, confidence: pm.confidence };
  if (pm.action === 'ADJUST_SL') {
    if (!isFiniteNumber(pm.newStopLoss) || pm.newStopLoss <= 0) throw err('schema_validation_failed', 'positionManagement.action=ADJUST_SL 时 newStopLoss 必须是有效正数');
    decision.newStopLoss = pm.newStopLoss;
  }
  if (pm.action === 'ADJUST_TP') {
    if (!isFiniteNumber(pm.newTakeProfit) || pm.newTakeProfit <= 0) throw err('schema_validation_failed', 'positionManagement.action=ADJUST_TP 时 newTakeProfit 必须是有效正数');
    decision.newTakeProfit = pm.newTakeProfit;
  }
  if (pm.action === 'REDUCE') {
    if (!isFiniteNumber(pm.reducePercent) || pm.reducePercent <= 0 || pm.reducePercent > 100) throw err('schema_validation_failed', 'positionManagement.action=REDUCE 时 reducePercent 必须满足 0 < x <= 100');
    decision.reducePercent = pm.reducePercent;
  }
  return decision;
}

/** Main entry point — mirrors `parseAiResponse()`'s contract exactly: never throws, always returns
 * `{ok:true,response,...}` or `{ok:false,error}`. `expectPositionManagement` is Sprint 3.9's one new
 * parameter — set to `true` whenever the originating payload had a real `positionContext`, requiring
 * (and validating) the additive `positionManagement` field; `false` reproduces the exact pre-3.9
 * behavior (field ignored even if present, never required). */
export function parseAiResponse(input: {
  rawResult: { status: string; rawText?: string; error?: unknown } | null | undefined;
  payload: AnalysisPayload;
  promptVersion: string;
  expectPositionManagement: boolean;
}): { ok: true; response: AiResponseBody; responseVersion: string; generatedAt: string; parsedRaw: Record<string, any> } | { ok: false; error: { code: string; message: string; details?: unknown }; parsedRaw: Record<string, any> | null } {
  const { rawResult, payload, promptVersion, expectPositionManagement } = input;
  const analysisTime = new Date();
  // Sprint 3.8E.1, Section 5/10/6 — captured the instant JSON.parse() succeeds, BEFORE any of the
  // schema/cross-rule validation calls below get a chance to throw. This is what lets a
  // SCHEMA_VALIDATION failure still return the AI's real (structurally valid, semantically rejected)
  // JSON output instead of losing it the moment validation throws — no validation RULE below is
  // touched or loosened by this capture, it's a pure observability side-channel.
  let parsedRaw: Record<string, any> | null = null;
  try {
    assertRawResultSucceeded(rawResult);
    const parsed = strictParseJson(rawResult!.rawText!);
    parsedRaw = parsed;
    validateRootFieldsPresent(parsed);
    validateResponseVersion(parsed.responseVersion);
    validateAiResponseSchema(parsed);
    validateScenarioPlansCrossRules(parsed, analysisTime);
    validateAnalysisIdMatch(parsed, payload);
    validateSourceAssessmentCrossRules(parsed, payload);
    validateEvidenceReferences(parsed, payload);

    let positionManagement: PositionManagementDecision | undefined;
    if (expectPositionManagement) {
      positionManagement = validatePositionManagementDecision(parsed.positionManagement);
    }

    const response: AiResponseBody = {
      responseVersion: parsed.responseVersion, analysisId: parsed.analysisId,
      summary: parsed.summary, decision: parsed.decision, scenarioPlans: parsed.scenarioPlans as ScenarioPlan[],
      sourceAssessments: parsed.sourceAssessments, reasoning: parsed.reasoning, risks: parsed.risks, evidence: parsed.evidence,
      positionManagement,
    };
    return { ok: true, response, responseVersion: parsed.responseVersion, generatedAt: analysisTime.toISOString(), parsedRaw: parsed };
  } catch (e: any) {
    if (e instanceof ParserError) return { ok: false, error: { code: e.code, message: e.message, details: e.details }, parsedRaw };
    return { ok: false, error: { code: 'schema_validation_failed', message: '解析过程中发生未预期的错误：' + e.message }, parsedRaw };
  }
}
