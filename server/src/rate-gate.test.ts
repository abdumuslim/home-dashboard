import { describe, it, expect } from "vitest";
import { RateGate } from "./rate-gate.js";

/**
 * A virtual clock: `sleep` advances time instantly, so spacing assertions are
 * exact and the suite stays fast. Real timers are never involved.
 */
function virtualClock(): { now: () => number; sleep: (ms: number) => Promise<void>; time: () => number } {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    time: () => t,
  };
}

describe("RateGate", () => {
  it("spaces consecutive calls by at least the minimum gap", async () => {
    const clock = virtualClock();
    const gate = new RateGate(1100, clock.now, clock.sleep);
    const startedAt: number[] = [];
    const task = async () => { startedAt.push(clock.now()); };

    await Promise.all([gate.run(task), gate.run(task), gate.run(task)]);

    expect(startedAt).toHaveLength(3);
    expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(1100);
    expect(startedAt[2] - startedAt[1]).toBeGreaterThanOrEqual(1100);
  });

  it("runs the very first call without waiting", async () => {
    const clock = virtualClock();
    const gate = new RateGate(1100, clock.now, clock.sleep);
    const before = clock.time();
    await gate.run(async () => undefined);
    expect(clock.time()).toBe(before);
  });

  it("serializes concurrent callers in submission order", async () => {
    const clock = virtualClock();
    const gate = new RateGate(1100, clock.now, clock.sleep);
    const order: string[] = [];
    await Promise.all([
      gate.run(async () => { order.push("poll"); }),
      gate.run(async () => { order.push("backfill"); }),
    ]);
    expect(order).toEqual(["poll", "backfill"]);
  });

  it("does not wait when the gap has already elapsed on its own", async () => {
    const clock = virtualClock();
    const gate = new RateGate(1100, clock.now, clock.sleep);
    await gate.run(async () => undefined);
    await clock.sleep(5000); // caller idled longer than the gap
    const before = clock.time();
    await gate.run(async () => undefined);
    expect(clock.time()).toBe(before);
  });

  it("propagates a task rejection to its own caller only", async () => {
    const clock = virtualClock();
    const gate = new RateGate(1100, clock.now, clock.sleep);
    const boom = gate.run(async () => { throw new Error("AW API 429"); });
    await expect(boom).rejects.toThrow("AW API 429");
  });

  it("keeps gating after a rejected task (a 429 must not wedge the chain)", async () => {
    const clock = virtualClock();
    const gate = new RateGate(1100, clock.now, clock.sleep);
    const startedAt: number[] = [];

    await gate.run(async () => { startedAt.push(clock.now()); throw new Error("429"); }).catch(() => undefined);
    await gate.run(async () => { startedAt.push(clock.now()); });

    expect(startedAt).toHaveLength(2);
    expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(1100);
  });

  it("returns the task's value to its caller", async () => {
    const clock = virtualClock();
    const gate = new RateGate(1100, clock.now, clock.sleep);
    await expect(gate.run(async () => 42)).resolves.toBe(42);
  });
});
