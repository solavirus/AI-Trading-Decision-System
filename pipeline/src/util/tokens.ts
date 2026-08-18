const CJK_RE = /[一-鿿぀-ヿ가-힯]/g;

/**
 * Rough token estimate, not a real tokenizer. CJK runs close to 1 token/char;
 * Latin/numeric text runs closer to 1 token per 4 chars. Good enough for budget
 * enforcement (we're trimming to a ceiling, not billing).
 */
export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  const cjkCount = (text.match(CJK_RE) || []).length;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount + otherCount / 4);
}

export function estimateItemTokens(item: { label: string; value: string; detail?: string }): number {
  return estimateTokens(item.label) + estimateTokens(item.value) + estimateTokens(item.detail);
}
