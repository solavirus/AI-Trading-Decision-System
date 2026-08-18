/** Sprint 3.8E.2, Section 5/17 — the ONE "necessary concurrency helper" this sprint's file scope
 * allows. Deliberately generic and domain-free (no knowledge of sources/retries/cancellation —
 * that all lives in `snapshotAcquisition.ts`, which is the only caller): a small, dependency-free
 * bounded-concurrency runner using a rolling window (`limit` lanes, each pulling the next item the
 * instant it frees up), not fixed batches — a fast item's slot is reused immediately rather than
 * waiting for the slowest item in an artificial "batch" to finish first. Results are returned in
 * the SAME order as `items`, regardless of completion order (Section 11's determinism requirement —
 * callers that need index-stable output never have to re-sort). */
export async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function lane(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const laneCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: laneCount }, lane));
  return results;
}
