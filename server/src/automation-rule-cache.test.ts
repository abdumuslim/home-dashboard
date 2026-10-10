import { describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import { Collector } from "./collector.js";

// Review finding (2026-09-27): a rule fetch that STARTED before an automation
// mutation and FINISHED after invalidateAutomationRules() used to stamp a fresh
// fetch time over the invalidation, so the pre-mutation rows stood for another
// 30 s: exactly the delay the invalidation exists to remove.

type Rows = Array<{ id: number; enabled: boolean }>;

function createCollector() {
  const pending: Array<(rows: Rows) => void> = [];
  let immediateRows: Rows | null = null;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM automations")) {
      if (immediateRows) return { rows: immediateRows, rowCount: immediateRows.length };
      const rows = await new Promise<Rows>((resolve) => pending.push(resolve));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
  const collector = new Collector({ query } as never, {} as Config);
  const internals = collector as unknown as {
    refreshAutomationRules(): Promise<void>;
    automationRules: Rows;
  };
  const ruleFetches = () => query.mock.calls.filter(([sql]) => String(sql).includes("FROM automations")).length;
  return {
    collector,
    refresh: () => internals.refreshAutomationRules(),
    rules: () => internals.automationRules,
    ruleFetches,
    /** Resolve the i-th still-pending rule SELECT (0 = oldest). */
    release: (rows: Rows, i = 0) => pending.splice(i, 1)[0](rows),
    answerImmediately: (rows: Rows) => { immediateRows = rows; },
  };
}

describe("automation rule cache: invalidation vs an in-flight fetch", () => {
  it("a fetch that straddles an invalidation does not suppress the next fetch", async () => {
    const c = createCollector();
    const inFlight = c.refresh();
    await vi.waitFor(() => expect(c.ruleFetches()).toBe(1));

    // The toggle commits and invalidates while the old SELECT is still out.
    c.collector.invalidateAutomationRules();
    c.release([{ id: 1, enabled: true }]);
    await inFlight;

    // Next tick: must refetch rather than trust the pre-mutation rows for 30 s.
    c.answerImmediately([{ id: 1, enabled: false }]);
    await c.refresh();
    expect(c.ruleFetches()).toBe(2);
    expect(c.rules()).toEqual([{ id: 1, enabled: false }]);
  });

  it("still installs the straddling fetch's rows (never older than the cache it replaces)", async () => {
    const c = createCollector();
    const inFlight = c.refresh();
    await vi.waitFor(() => expect(c.ruleFetches()).toBe(1));
    c.collector.invalidateAutomationRules();
    c.release([{ id: 3, enabled: true }]);
    await inFlight;
    expect(c.rules()).toEqual([{ id: 3, enabled: true }]);
  });

  it("an undisturbed fetch keeps the 30 s throttle", async () => {
    const c = createCollector();
    c.answerImmediately([{ id: 1, enabled: true }]);
    await c.refresh();
    await c.refresh();
    expect(c.ruleFetches()).toBe(1);
  });

  it("an invalidation after a completed fetch forces the next one", async () => {
    const c = createCollector();
    c.answerImmediately([{ id: 1, enabled: true }]);
    await c.refresh();
    c.collector.invalidateAutomationRules();
    await c.refresh();
    expect(c.ruleFetches()).toBe(2);
  });

  // Recheck finding: the collector's 90 s step timeout can abandon a tick while
  // its fetch A is still out; the next tick's fetch B then installs the changed
  // rules and stamps the cache. A finishing late must not overwrite B's rows.
  it("an older fetch finishing after a newer one does not overwrite the newer rows", async () => {
    const c = createCollector();
    const a = c.refresh();
    await vi.waitFor(() => expect(c.ruleFetches()).toBe(1));
    c.collector.invalidateAutomationRules();

    const b = c.refresh();
    await vi.waitFor(() => expect(c.ruleFetches()).toBe(2));
    c.release([{ id: 1, enabled: false }], 1); // B: post-change rows
    await b;
    expect(c.rules()).toEqual([{ id: 1, enabled: false }]);

    c.release([{ id: 1, enabled: true }]); // A: pre-change rows, late
    await a;
    expect(c.rules()).toEqual([{ id: 1, enabled: false }]);

    // B's stamp stands (its rows are current), so the throttle holds...
    c.answerImmediately([{ id: 1, enabled: false }]);
    await c.refresh();
    expect(c.ruleFetches()).toBe(2);
    // ...and a later invalidation still forces a refetch.
    c.collector.invalidateAutomationRules();
    await c.refresh();
    expect(c.ruleFetches()).toBe(3);
  });
});
