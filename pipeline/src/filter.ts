import type { RawItem, SourceResult, BudgetedSourceResult } from './types.js';
import { SOURCE_CAPS } from './caps.js';
import { computeTokenBudget } from './weights.js';
import { estimateItemTokens } from './util/tokens.js';

function truncateDetail(item: RawItem, maxChars: number): RawItem {
  if (!item.detail || item.detail.length <= maxChars) return item;
  return { ...item, detail: item.detail.slice(0, maxChars - 1) + '…' };
}

/** Interleaves bullish/bearish/neutral items so a hard item-count cap can't silently erase one
 * side of the evidence just because it happened to sort later. This is the concrete mechanism
 * behind "must retain counter-evidence, not just cherry-pick items supporting one view". */
function orderByPolarityRoundRobin(items: RawItem[]): RawItem[] {
  const buckets: Record<string, RawItem[]> = { bullish: [], bearish: [], neutral: [] };
  for (const it of items) buckets[it.polarity].push(it);
  const order: RawItem[] = [];
  let i = 0;
  while (order.length < items.length) {
    for (const key of ['bullish', 'bearish', 'neutral'] as const) {
      if (buckets[key][i]) order.push(buckets[key][i]);
    }
    i++;
  }
  return order;
}

/** Program-side compute/filter stage: turns a raw, generously-collected SourceResult into the
 * trimmed slice that's actually allowed to reach the model, governed entirely by this source's
 * weight. No LLM involved here — this is deterministic and re-runnable. */
export function applyBudget(result: SourceResult, weight: number, totalWeight: number): BudgetedSourceResult {
  const caps = SOURCE_CAPS[result.key];

  if (weight <= 0) {
    return {
      key: result.key, status: result.status, weight, tokenBudget: 0,
      itemsRawCount: result.itemsRaw.length, itemsIncluded: [], itemsDroppedCount: result.itemsRaw.length,
      tokensEstimated: 0, counterEvidencePreserved: result.itemsRaw.length === 0,
      note: '权重为 0，不进入分析',
    };
  }

  const tokenBudget = computeTokenBudget(weight, totalWeight);
  const hasBull = result.itemsRaw.some((i) => i.polarity === 'bullish');
  const hasBear = result.itemsRaw.some((i) => i.polarity === 'bearish');

  const ordered = orderByPolarityRoundRobin(result.itemsRaw).map((it) => truncateDetail(it, caps.maxDetailChars));

  const included: RawItem[] = [];
  let tokensUsed = 0;
  for (const item of ordered) {
    if (included.length >= caps.maxItems) break;
    const cost = estimateItemTokens(item);
    if (tokensUsed + cost > tokenBudget && included.length > 0) break;
    included.push(item);
    tokensUsed += cost;
  }

  const keptBull = included.some((i) => i.polarity === 'bullish');
  const keptBear = included.some((i) => i.polarity === 'bearish');
  const counterEvidencePreserved = (!hasBull || keptBull) && (!hasBear || keptBear);

  return {
    key: result.key,
    status: result.status,
    weight,
    tokenBudget,
    itemsRawCount: result.itemsRaw.length,
    itemsIncluded: included,
    itemsDroppedCount: result.itemsRaw.length - included.length,
    tokensEstimated: tokensUsed,
    counterEvidencePreserved,
    note: result.note,
  };
}
