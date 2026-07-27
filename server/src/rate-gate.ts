/**
 * Serializes calls and spaces their START times at least `minGapMs` apart.
 *
 * Vendor APIs meter per user, not per caller. Ambient Weather allows 1 request
 * per second, but we hit it from two places that have no reason to know about
 * each other — the 5s collection poll and the startup backfill. At boot they
 * fired in the same second and one came back `429 above-user-rate-limit`,
 * silently dropping the backfill's gap-fill batch (2026-07-27).
 *
 * A local `sleep()` at one call site cannot fix that: it paces that caller
 * against itself, not against the other one. Routing every request through a
 * single gate makes the spacing a property of the API client instead.
 *
 * Start times are what's spaced, not end times — the limit is counted when a
 * request ARRIVES at the vendor, so a slow response must not earn extra budget.
 */
export class RateGate {
  private chain: Promise<unknown> = Promise.resolve();
  private lastStartedAt = 0;

  constructor(
    private readonly minGapMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Queue `task`; it starts once the previous one finished AND the gap elapsed. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      const wait = this.lastStartedAt + this.minGapMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStartedAt = this.now();
      return task();
    });
    // The chain must survive a failed task — swallow here, not for the caller,
    // who still gets the rejection from `result`.
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }
}
