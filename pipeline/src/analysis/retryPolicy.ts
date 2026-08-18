/** Sprint 3.9, Section 7 — the ONE centralized Snapshot Retry Policy. Fixes the real, historically-
 * observed bug: a Scheduled cycle whose account-snapshot read failed once was permanently SKIPPED for
 * that slot with zero retry (see `AC_BTCUSDT_20260813132140710`, skipReason
 * `ACCOUNT_SNAPSHOT_UNAVAILABLE`, in `data/strategy_autonomous_cycles.json`). Both Manual and
 * Scheduled route every required-snapshot fetch through this one function — no per-call-site
 * `setTimeout` magic numbers (Section 7's own explicit instruction). */

const RETRY_DELAYS_MS = [3000, 10000]; // wait before attempt 2, wait before attempt 3 — 3 attempts total
/** Sprint 3.8E.2, Section 4/12 — how often a cancellable sleep wakes up to re-check
 * `opts.isCancelled()`. Small enough that a cancel request is honored promptly (never the full
 * remaining retry-wait duration), large enough to never busy-loop. Only used when the caller
 * actually passes `isCancelled` — every existing caller that doesn't (e.g. the Automation Preflight
 * snapshot check in `autonomousScheduler.ts`) gets the exact original plain `setTimeout` sleep,
 * byte-identical behavior to before this sprint. */
const CANCEL_POLL_MS = 200;

export interface RetryResult<T> {
  ok: boolean;
  value?: T;
  attempts: number;
  lastError?: string;
  /** Sprint 3.8E.2 — true only when `opts.isCancelled` was provided AND became true before this
   * attempt sequence naturally finished (whether during a retry wait or right before the next
   * attempt would have started). `ok` stays `false` in this case too — cancellation is a distinct
   * outcome from a real fetch failure, and the caller (`snapshotAcquisition.ts`) is the one that
   * knows how to represent that distinction; this module just reports the fact. */
  cancelled?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Sprint 3.8E.2, Section 4/12 — the ONLY way a retry wait can end early: real elapsed time still
 * governs the normal case (byte-identical timing to the original `sleep()` when never cancelled),
 * but `isCancelled()` is polled every `CANCEL_POLL_MS` so a mid-wait cancel doesn't sit through the
 * rest of a 3s/10s delay before being noticed. Never a busy loop — every check is behind its own
 * `setTimeout`. */
function cancellableSleep(ms: number, isCancelled?: () => boolean): Promise<void> {
  if (!isCancelled) return sleep(ms);
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      if (isCancelled()) return resolve();
      const remaining = deadline - Date.now();
      if (remaining <= 0) return resolve();
      setTimeout(tick, Math.min(CANCEL_POLL_MS, remaining));
    };
    tick();
  });
}

/** `fn` returns `{ok:true,value}` on success or `{ok:false,error}` on a retryable failure — never
 * throws (a thrown exception from `fn` is treated as attempt failure too, so callers don't need
 * their own try/catch around every attempt). Attempt 1 → fail → wait 3s → Attempt 2 → fail → wait
 * 10s → Attempt 3 → fail → returns `ok:false` with `attempts:3`, `lastError` set. `onAttempt` is an
 * optional hook for the caller to record retry progress (e.g. into an AnalysisRecord/AutonomousCycle
 * status) without this module knowing about either.
 *
 * Sprint 3.8E.2, Section 4/12 — `opts.isCancelled` is optional and additive: omitted (every
 * pre-existing caller), this function's behavior is byte-identical to before. When provided, it's
 * checked before each attempt starts and polled during any retry wait, so a Manual cancel can stop a
 * source's retry sequence promptly instead of only being noticed after it naturally exhausts all 3
 * attempts — this is what makes parallel cancellation (Section 12) actually responsive instead of
 * just "the next source never starts". */
export async function withRetry<T>(
  fn: () => Promise<{ ok: true; value: T } | { ok: false; error: string }>,
  opts?: { onAttempt?: (attempt: number, total: number) => void; isCancelled?: () => boolean },
): Promise<RetryResult<T>> {
  let lastError = '未知错误';
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (opts?.isCancelled?.()) return { ok: false, attempts: attempt - 1, lastError, cancelled: true };
    opts?.onAttempt?.(attempt, 3);
    let result: { ok: true; value: T } | { ok: false; error: string };
    try {
      result = await fn();
    } catch (err: any) {
      result = { ok: false, error: err?.message || String(err) };
    }
    if (result.ok) return { ok: true, value: result.value, attempts: attempt };
    lastError = result.error;
    if (attempt < 3) {
      await cancellableSleep(RETRY_DELAYS_MS[attempt - 1], opts?.isCancelled);
      if (opts?.isCancelled?.()) return { ok: false, attempts: attempt, lastError, cancelled: true };
    }
  }
  return { ok: false, attempts: 3, lastError };
}
