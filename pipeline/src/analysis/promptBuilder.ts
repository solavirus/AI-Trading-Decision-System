/** Sprint 3.9 — faithful backend port of `prototype/index.html`'s Prompt Builder (Sprint 3.1A,
 * `buildSystemPromptSection`/`buildTradingRulesSection`/`buildPayloadSection`/`buildOutputContractSection`/
 * `buildPromptText`), implementing `PROMPT_BUILDER_SPEC.md`. Text is copied verbatim — Section 1
 * forbids changing Prompt semantics except for the structural wiring needed to share this builder
 * between Manual and Scheduled. The ONE new addition is `buildPositionManagementSection()` (Section
 * 18), appended ONLY when the payload carries a real `positionContext` — every payload without a
 * position produces the exact same prompt text as before this sprint. */
import type { AnalysisPayload } from './types.js';

export const PROMPT_VERSION = '2.3.0'; // Sprint 3.9: +Position Management section (additive, only emitted when positionContext is present)

function buildSystemPromptSection(): string {
  return [
    '# System Prompt', '',
    'You are an evidence-based crypto trading strategy analyst.', '',
    'You only use the supplied Analysis Payload as input.',
    'You never invent prices, indicators, events, or facts not present in the Payload.',
    'You do not browse external information.',
    'You do not modify Research weights.',
    'You do not create or execute Trades.',
    'You return exactly one Strategy object, matching AI_RESPONSE_SPEC.md.',
    'You return JSON only.',
  ].join('\n');
}

function buildTradingRulesSection(): string {
  return [
    '# Trading Rules', '',
    '- Prioritize risk management over predicted upside.',
    '- Direction and action are separate questions: direction (LONG/SHORT) is which way the evidence points; action (ENTER/WAIT) is whether to act now. WAIT never means "no direction" — the direction is still fixed, only the timing is not yet right.',
    '- Respect sources marked unavailable, partial, or stale in dataQuality — do not treat them as if they were fully available.',
    '- Sources with zero configured weight in sourceWeights must not influence the recommendation.',
    '- Every important conclusion must reference evidence from the Analysis Payload.',
    '- You create a Strategy only. Execution creates the Trade, only after user confirmation.',
    '',
    'CONFIDENCE:',
    'Confidence expresses how strongly the total weighted evidence supports the selected final direction. It is NEVER a probability of profit, a predicted win rate, a certainty of future price movement, or permission to override user-configured weights.',
    '',
    'DIRECTION RESOLUTION POLICY:',
    '1. User-configured weights (sourceWeights) control how important each source is — never change, rebalance, or reinterpret them.',
    '2. Assess each source independently for direction and evidence strength.',
    '3. Conflicting evidence across sources is expected and normal in a multi-source system.',
    '4. Conflict alone must NEVER cause WAIT, and must never be used to avoid choosing a direction.',
    '5. Resolve the final direction from the overall weighted evidence balance — sources with more configured weight and stronger evidence count for more.',
    '6. Even when the balance is close, still choose LONG or SHORT — express a close balance with a lower confidence, never with an avoided choice.',
    '7. Decide ENTER vs WAIT only AFTER direction is determined, based only on whether a real executable setup currently exists — not on how contested the direction was.',
    '',
    'EVIDENCE CONFLICT:',
    'Opposing evidence must remain visible (reasoning stance=OPPOSE, per-source direction) and must be considered, but its existence is never itself a reason to return WAIT.',
    'Expected example: Direction=LONG, Technical=HIGH and ETF=HIGH support, Macro=MEDIUM and News=LOW oppose — still resolves to LONG.',
  ].join('\n');
}

function buildPayloadSection(p: AnalysisPayload): string {
  const ordered = {
    analysisId: p.analysisId, payloadVersion: p.payloadVersion, createdAt: p.createdAt,
    symbol: p.symbol, timeframe: p.timeframe, dateRange: p.dateRange,
    sourceWeights: p.sourceWeights, additionalEvidence: p.additionalEvidence,
    sourceSnapshots: p.sourceSnapshots, selectedNewsEvents: p.selectedNewsEvents,
    dataQuality: p.dataQuality,
  };
  return ['# Analysis Payload', '', JSON.stringify(ordered, null, 2)].join('\n');
}

function buildOutputContractSection(): string {
  return [
    '# Output Contract', '',
    'Return exactly one JSON object matching this structure (AI_RESPONSE_SPEC.md v2.2.0):', '',
    JSON.stringify({
      responseVersion: 'string', analysisId: 'string',
      summary: { title: 'string', content: 'string' },
      decision: { direction: 'LONG|SHORT', action: 'ENTER|WAIT', confidence: '0-100' },
      scenarioPlans: [{
        id: 'string', priority: 'PRIMARY|ALTERNATIVE|INVALIDATION', direction: 'LONG|SHORT', action: 'ENTER',
        title: 'string', trigger: 'string',
        'triggerStructured (REQUIRED non-null+numeric for a WAIT-decision PRIMARY, see STRUCTURED TRIGGER below)': { description: 'string', logic: 'ALL|ANY', conditions: [{ metric: 'price|candle_close', operator: 'GT|GTE|LT|LTE|BETWEEN|CROSSES_ABOVE|CROSSES_BELOW|EQUALS', value: 'number?', min: 'number?', max: 'number?', timeframe: 'string?' }] },
        'invalidation (nullable, see INVALIDATION below)': 'same shape as triggerStructured above, or null',
        'reviewHorizon (REQUIRED for PRIMARY, expiresAt REQUIRED+absolute+timezone-qualified for PRIMARY, see REVIEW HORIZON below)': { description: 'string', expiresAt: 'string (ISO-8601 with timezone/offset, e.g. 2026-08-10T17:00:00+08:00)' },
        holdingPeriod: 'string?',
        'entry (see ENTRY RULES below — CONDITIONAL is never a valid FINAL entry for any plan)': { type: 'MARKET|LIMIT|ZONE', value: 'number? (LIMIT only)', from: 'number? (ZONE only)', to: 'number? (ZONE only)', description: 'string?' },
        'stopLoss (PRIMARY requires a real numeric value, not description-only)': { value: 'number', description: 'string?' },
        'takeProfit (PRIMARY requires at least one real numeric value, not description-only)': [{ value: 'number', description: 'string?' }],
        rationale: 'string', evidenceReferences: ['string'],
      }],
      sourceAssessments: [{ sourceId: 'string', configuredWeight: 'number', direction: 'LONG|SHORT|NEUTRAL', evidenceStrength: 'LOW|MEDIUM|HIGH', explanation: 'string', evidenceReferences: ['string'] }],
      reasoning: [{ title: 'string', description: 'string', importance: '0-100', stance: 'SUPPORT|OPPOSE|NEUTRAL', evidenceReferences: ['string'] }],
      risks: [{ title: 'string', description: 'string', impact: 'LOW|MEDIUM|HIGH' }],
      evidence: [{ reason: 'string', references: ['string'] }],
    }, null, 2),
    '',
    'Rules:',
    "- No Markdown. No code fences. No text before or after the JSON object.",
    "- analysisId must match the Analysis Payload's analysisId exactly.",
    '- decision.direction is LONG or SHORT only — never NEUTRAL. decision.action is ENTER or WAIT only — never EXIT/REDUCE.',
    '- scenarioPlans[].action is always "ENTER" — it means "what to do once this scenario\'s trigger becomes true," NOT the current recommended action (that is decision.action, which may still be WAIT).',
    '- Every sourceAssessments.configuredWeight must exactly match the corresponding sourceWeights value in the Analysis Payload. Sources with zero configured weight must not influence the result.',
    '- Every reasoning / sourceAssessments / scenarioPlans item must reference evidence via evidenceReferences.',
    '- You must not create a Trade.',
    '',
    'REASONING ARRAY HARD LIMIT:',
    '- reasoning MUST contain between 1 and 5 items. 5 is the absolute maximum. NEVER return 6 or more — keep only the 5 most decision-relevant items. Returning 6+ makes the entire response invalid.',
    '',
    'SOURCE ASSESSMENT COMPLETENESS:',
    '- Count the positive-weight system sources first: the sourceWeights entries in the Analysis Payload greater than 0.',
    '- The number of system-source sourceAssessments entries MUST exactly equal that count. Do not omit a source merely because its evidence is unclear — use direction="NEUTRAL" and evidenceStrength="LOW" when appropriate.',
    '',
    'SCENARIO PLAN CARDINALITY:',
    '- Every response contains 1-3 scenarioPlans. Exactly ONE must have priority="PRIMARY". ALTERNATIVE and INVALIDATION are optional — a single PRIMARY plan is a valid, minimal response.',
    '',
    'CORE RULE — Strategy explains. Scenario quantifies. Execution executes.:',
    '- Natural-language reasoning (why this trade, why these levels) belongs ONLY in summary / reasoning / risks / rationale / explanation fields.',
    "- The PRIMARY scenario's execution parameters (entry / stopLoss / takeProfit / expiresAt, and triggerStructured when WAIT) must be strict, machine-usable NUMBERS — never prose standing in for a number. There is no more prose-only execution plan for PRIMARY, whether the current action is ENTER or WAIT.",
    '',
    'SCENARIO PLAN — PRIMARY NUMERIC COMPLETENESS (Task 2 — applies regardless of decision.action; a WAIT PRIMARY must be JUST AS numerically complete as an ENTER PRIMARY, it only additionally needs a numeric trigger):',
    '- entry: see ENTRY RULES below — must resolve to a real numeric MARKET/LIMIT/ZONE, never CONDITIONAL, never description-only.',
    '- stopLoss.value: a real, finite, positive number. A description like "跌破结构失效位置" is never sufficient by itself for PRIMARY.',
    '- takeProfit: at least one item with a real, finite, positive value. Multiple numeric targets are welcome and encouraged; a description-only item does not count.',
    '- reviewHorizon.expiresAt: a real absolute ISO-8601 timestamp WITH timezone/offset — see REVIEW HORIZON below. Never omit it for PRIMARY, never fabricate a timestamp you cannot justify (see TIME RESOLUTION below for how to derive a real one).',
    '- ALTERNATIVE/INVALIDATION plans SHOULD also be fully numeric by the same standard whenever they represent a real future-actionable plan (not just illustrative color) — do not leave an ALTERNATIVE as prose while PRIMARY is strict.',
    '- Never fabricate a numeric price, stop, target, or expiresAt merely to satisfy this schema — if you cannot justify real numbers, that is itself a reason to reconsider ENTER vs WAIT, or to omit that optional plan entirely rather than inventing numbers for it.',
    '',
    'ENTRY RULES (PRIMARY — CONDITIONAL is never a valid final entry for ANY plan, PRIMARY or otherwise):',
    '- MARKET: entry={type:"MARKET"} only, no value field. Allowed ONLY when decision.action="ENTER" for the PRIMARY plan — a WAIT PRIMARY has no current market price to act on and must NEVER use MARKET.',
    '- LIMIT: entry={type:"LIMIT", value:number}. value must be finite and > 0.',
    '- ZONE: entry={type:"ZONE", from:number, to:number}. Both finite and > 0, and from <= to.',
    "- CONDITIONAL is REMOVED as a final execution parameter. If a WAIT plan's entry genuinely depends on a future condition, express that condition numerically in triggerStructured (see STRUCTURED TRIGGER below) and still give entry as a numeric LIMIT (a specific price you would enter at once triggered) or ZONE (a specific range) — never fall back to a text-only entry.description as the execution parameter.",
    '',
    'STOP LOSS / TAKE PROFIT NUMERIC REQUIREMENT (PRIMARY):',
    '- stopLoss.value and at least one takeProfit[].value are REQUIRED real numbers for the PRIMARY plan — description is supplementary color, never a substitute.',
    '',
    'DIRECTIONAL PRICE SANITY (conservative structural check — your numbers will be rejected if violated):',
    '- LONG: stopLoss must be BELOW the entry reference price; every numeric takeProfit must be ABOVE it.',
    '- SHORT: stopLoss must be ABOVE the entry reference price; every numeric takeProfit must be BELOW it.',
    '- Entry reference price: LIMIT uses its value; ZONE uses the midpoint of from/to (for this sanity check only — never use the midpoint as an actual order price). MARKET has no reference price at generation time, so this check does not apply to a MARKET-entry PRIMARY.',
    '- Do not submit a plan that violates this — reconsider your numbers rather than relying on the system to silently fix them (it will not; it rejects the whole response instead).',
    '',
    'REVIEW HORIZON — ABSOLUTE EXPIRY (REQUIRED for PRIMARY):',
    '- Every PRIMARY plan must include reviewHorizon: {description, expiresAt}. description explains, in words, how long the SCENARIO ITSELF stays relevant before execution — distinct from holdingPeriod, which is the expected duration AFTER entry.',
    '- expiresAt is now REQUIRED for PRIMARY (not optional) and MUST be a real absolute timestamp with an explicit timezone/offset (e.g. "2026-08-10T17:00:00+08:00" or a trailing "Z" for UTC) — a bare "2026-08-10 17:00" with no zone, or a natural-language-only horizon like "未来 3 根 4H K线"/"未来 12 小时"/"CPI 前"/"未来 1-3 天" with NO resolved timestamp, is no longer sufficient by itself.',
    '- expiresAt must be strictly AFTER the moment this analysis was generated — never in the past, never equal to "now."',
    '- ALTERNATIVE/INVALIDATION plans may leave reviewHorizon null.',
    '',
    'TIME RESOLUTION — HOW TO DERIVE expiresAt (Task 11/12 — macro-event precedence):',
    "1. Evaluate the current analysis timestamp (the Analysis Payload's own createdAt).",
    '2. Evaluate your intended review horizon in relative terms (e.g. "3 more 4H candles," "until tomorrow\'s close") and convert it to one absolute timestamp.',
    "3. Evaluate the Analysis Payload's selectedNewsEvents for any known HIGH-impact macro event (e.g. CPI, FOMC) that would fall before your relative horizon completes.",
    '4. The final expiresAt = the EARLIEST of: your relative-horizon timestamp, and the next relevant HIGH-impact macro event\'s timestamp (if one exists and falls earlier). If no relevant macro event exists, use the relative-horizon timestamp alone. If multiple HIGH-impact events qualify, use the earliest one.',
    '5. Output exactly ONE resolved expiresAt — never two competing deadlines. You may explain your reasoning (including why a macro event took precedence, if it did) in rationale/reasoning, but Execution only ever receives the one final timestamp.',
    '- Example: a 3×4H horizon computes to 2026-08-10T10:00:00+08:00; the next HIGH-impact macro event is 2026-08-12T20:30:00+08:00 (later) — use the horizon: expiresAt="2026-08-10T10:00:00+08:00". If instead the macro event were 2026-08-09T18:00:00+08:00 (earlier than the horizon), use the macro cutoff instead.',
    '',
    'INVALIDATION (optional, distinct from stopLoss):',
    '- invalidation describes conditions that cancel THIS SCENARIO before entry ever happens (e.g. "4H closes below 63,000 before the breakout — cancel this plan"). stopLoss only matters after a position is opened.',
    '- Provide invalidation only when a real condition can be identified; otherwise invalidation=null. Same shape as triggerStructured.',
    '',
    'STRUCTURED TRIGGER — REQUIRED for a WAIT-decision PRIMARY (Task 8/9):',
    '- If decision.action="WAIT", the PRIMARY plan MUST include a non-null, numerically machine-evaluable triggerStructured — a natural-language-only trigger is no longer sufficient by itself for the PRIMARY plan under WAIT. (If decision.action="ENTER", triggerStructured on the PRIMARY is optional, since the setup is already actionable now.)',
    '- The ONLY allowed metric values are "price" and "candle_close" — nothing else. Concepts like support_holds / market_stabilizes / sentiment_improves / breakout_confirmed must stay in the human-readable trigger text, never as a metric. Do NOT invent a new metric merely to satisfy this requirement — if the real condition truly cannot be expressed with price/candle_close, that is itself a reason to reconsider whether this PRIMARY plan is well-formed.',
    '- operator is one of GT/GTE/LT/LTE/BETWEEN/CROSSES_ABOVE/CROSSES_BELOW/EQUALS. BETWEEN requires numeric min and max with min<=max; every other operator requires a numeric value.',
    '- metric="candle_close" requires a non-empty timeframe (e.g. "4H"); metric="price" requires timeframe to be null or omitted.',
    '- For ALTERNATIVE/INVALIDATION plans, triggerStructured remains optional — return null when a trigger cannot be truthfully expressed with price/candle_close.',
    '',
    'EVIDENCE REFERENCE RULES:',
    '- Every evidenceReferences / references value MUST be an exact id copied from the Analysis Payload, in the form "namespace:id" — exactly one of: sourceSnapshots:<id>, selectedNewsEvents:<id>, additionalEvidence:<id>. No other namespace, no bare id, no free text, no URL.',
    '- Valid: "sourceSnapshots:technical", "selectedNewsEvents:news-event-43", "additionalEvidence:e1754643258123". Invalid: "technical: RSI is bullish", "snapshot:technical", "news-event-43", "ETF inflow evidence".',
    '- Copy ids exactly, character-for-character — never interpret, rewrite, translate, or decorate them. Explanations belong only in explanation / description / rationale / reason fields, never inside a reference field.',
    '- sourceAssessments should normally include its own "sourceSnapshots:<sourceId>" reference when that snapshot exists; include selectedNewsEvents/additionalEvidence references only when they materially contributed. Never fabricate a reference when no real supporting evidence exists.',
    '',
    'PRE-OUTPUT SELF-CHECK (response format only — do not reveal this check or any chain-of-thought):',
    'Before returning the final JSON, internally verify:',
    '1. responseVersion and analysisId are correct.',
    '2. decision.direction is LONG or SHORT; decision.action is ENTER or WAIT; confidence is 0-100.',
    '3. every required positive-weight system source appears exactly once in sourceAssessments, with configuredWeight copied exactly; direction/evidenceStrength use only the allowed enums.',
    '4. scenarioPlans has 1-3 items with exactly one PRIMARY; every scenarioPlans.action is "ENTER".',
    '5. the PRIMARY plan\'s entry is a real numeric MARKET (ENTER only)/LIMIT/ZONE — never CONDITIONAL; stopLoss.value and at least one takeProfit[].value are real numbers; if ENTER, holdingPeriod is non-empty.',
    '6. if decision.action="WAIT", the PRIMARY plan has a non-null, numerically machine-evaluable triggerStructured.',
    '7. the PRIMARY plan\'s numeric stopLoss/takeProfit are on the correct side of the entry reference price for its direction (LONG: stop below/TP above; SHORT: stop above/TP below) — skip this check only for a MARKET entry.',
    "8. the PRIMARY plan has reviewHorizon with a non-empty description AND a real, timezone-qualified, future expiresAt — resolved per TIME RESOLUTION above (earliest of horizon vs. relevant macro event).",
    '9. every triggerStructured/invalidation present uses only metric="price"|"candle_close" and an allowed operator.',
    '10. reasoning contains 1-5 items.',
    '11. every evidence reference uses an allowed namespace and an ID that exists in the Analysis Payload, contains no explanation text, and was not invented.',
    '12. output is pure JSON.',
    'If any condition is violated, fix the JSON before returning it.',
    '',
    'FINAL OUTPUT RULE:',
    'Return exactly ONE JSON object. Do not return Markdown, code fences, comments, analysis text, or explanations before/after the JSON.',
    'The first character of the response must be {',
    'The last character of the response must be }',
  ].join('\n');
}

/** Sprint 3.9, Section 18 — additive only, emitted ONLY when `payload.positionContext` is a real
 * position (not `undefined`/`null`). Asks for ONE extra top-level field, `positionManagement`, in
 * the SAME response — the "priority option" Section 18 itself asks for (avoid a second AI call).
 * Deliberately does not touch any existing section above — a payload with no position produces
 * byte-identical prompt text to the pre-3.9 builder. */
function buildPositionManagementSection(payload: AnalysisPayload): string | null {
  const pos = payload.positionContext;
  if (!pos) return null;
  return [
    '# Existing Position — Position Management', '',
    `You are also being shown the account's CURRENT REAL position on ${payload.symbol}, already open before this analysis:`,
    '',
    JSON.stringify({
      side: pos.side, quantity: pos.quantity, entryPrice: pos.entryPrice, markPrice: pos.markPrice,
      leverage: pos.leverage, unrealizedPnl: pos.unrealizedPnl, currentStopLoss: pos.currentStopLoss,
      currentTakeProfit: pos.currentTakeProfit, protectionStatus: pos.protectionStatus, fetchedAt: pos.fetchedAt,
    }, null, 2),
    '',
    'Because a real position already exists, your `scenarioPlans`/`decision` above describe a HYPOTHETICAL new entry only for reference — they are NOT executed automatically while a position is open. In addition to everything above, you MUST also return one extra top-level field, `positionManagement`, evaluating what to do with THIS EXISTING position:',
    '',
    JSON.stringify({
      positionManagement: {
        action: 'HOLD|ADJUST_SL|ADJUST_TP|REDUCE|CLOSE',
        rationale: 'string (concise — no hidden chain-of-thought)',
        confidence: '0-100',
        'newStopLoss (REQUIRED only if action=ADJUST_SL)': 'number',
        'newTakeProfit (REQUIRED only if action=ADJUST_TP)': 'number',
        'reducePercent (REQUIRED only if action=REDUCE, 0 < x <= 100)': 'number',
      },
    }, null, 2),
    '',
    'Position Management rules:',
    '- action=HOLD: keep the position exactly as-is, no other fields required.',
    '- action=ADJUST_SL: propose a new stop-loss price; requires numeric newStopLoss on the correct side of markPrice for the position\'s side.',
    '- action=ADJUST_TP: propose a new take-profit price; requires numeric newTakeProfit on the correct side of markPrice for the position\'s side.',
    '- action=REDUCE: propose partially closing the position; requires numeric reducePercent, 0 < reducePercent <= 100.',
    '- action=CLOSE: propose fully closing the position now; no other fields required.',
    '- Do NOT propose adding to the position (increasing quantity) — that action does not exist in this contract.',
    '- This is a RECOMMENDATION ONLY — nothing you return here is executed automatically. Never assume it will be.',
  ].join('\n');
}

/** Orchestrates the (now up-to-5, when a position exists) fixed-order sections into one deterministic
 * prompt string. Never embeds `Date.now()`/`new Date()` of its own — the only timestamp inside is the
 * Payload's own `createdAt` (PROMPT_BUILDER_SPEC.md's determinism principle, unchanged). */
export function buildPromptText(payload: AnalysisPayload): string {
  const sections = [
    buildSystemPromptSection(),
    buildTradingRulesSection(),
    buildPayloadSection(payload),
    buildOutputContractSection(),
  ];
  const positionSection = buildPositionManagementSection(payload);
  if (positionSection) sections.push(positionSection);
  return sections.join('\n\n---\n\n');
}

export interface PromptRecord { analysisId: string; promptVersion: string; payloadVersion: string; generatedAt: string; promptText: string }

export function buildPromptRecord(payload: AnalysisPayload): PromptRecord {
  return {
    analysisId: payload.analysisId, promptVersion: PROMPT_VERSION, payloadVersion: payload.payloadVersion,
    generatedAt: new Date().toISOString(), promptText: buildPromptText(payload),
  };
}
