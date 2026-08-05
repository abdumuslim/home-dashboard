import { describe, expect, it } from "vitest";
import type { PowerSource } from "./ac-leveling.js";
import {
  classifyRow,
  toMinuteSources,
  smoothFlickers,
  buildSessions,
  resolveCurrentSession,
  gridMinutesInWindow,
  baghdadDateKey,
  averageSessionHours,
  weightedMedian,
  dayBreakdownForWindow,
  MINUTE_MS,
  type Session,
  type PowerMinuteRow,
} from "./power-stats.js";

const GRID = { current_1: 5, current_2: 0 };
const GEN = { current_1: 0, current_2: 3 };

/** Build 1-minute rows from `sources`; "none" entries are omitted (a data gap). */
function mkRows(startMs: number, sources: PowerSource[]): PowerMinuteRow[] {
  const rows: PowerMinuteRow[] = [];
  sources.forEach((s, i) => {
    if (s === "none") return;
    const c = s === "grid" ? GRID : GEN;
    rows.push({ ts: new Date(startMs + i * MINUTE_MS), current_1: c.current_1, current_2: c.current_2 });
  });
  return rows;
}

function sess(source: PowerSource, startMs: number, endMs: number): Session {
  return { source, startMs, endMs, minutes: (endMs - startMs) / MINUTE_MS };
}

describe("classifyRow", () => {
  it("grid-only, gen-only, tie, and blackout", () => {
    expect(classifyRow({ current_1: 5, current_2: 0 })).toBe("grid");
    expect(classifyRow({ current_1: 0, current_2: 3 })).toBe("gen");
    expect(classifyRow({ current_1: 4, current_2: 2 })).toBe("grid"); // larger wins
    expect(classifyRow({ current_1: 2, current_2: 4 })).toBe("gen");
    expect(classifyRow({ current_1: 3, current_2: 3 })).toBe("grid"); // exact tie -> grid (>=)
    expect(classifyRow({ current_1: 0.05, current_2: 0.05 })).toBe("none"); // both below floor
    expect(classifyRow({ current_1: 0.1, current_2: 0 })).toBe("none"); // strict >
  });
});

describe("toMinuteSources", () => {
  const start = Date.UTC(2026, 6, 1, 0, 0, 0);

  it("dense run maps 1:1", () => {
    const rows = mkRows(start, ["grid", "grid", "gen"]);
    expect(toMinuteSources(rows, start, start + 3 * MINUTE_MS)).toEqual(["grid", "grid", "gen"]);
  });

  it("missing minutes become none", () => {
    const rows = mkRows(start, ["grid", "none", "grid"]);
    expect(toMinuteSources(rows, start, start + 3 * MINUTE_MS)).toEqual(["grid", "none", "grid"]);
  });

  it("off-second timestamps floor into the right slot", () => {
    const rows: PowerMinuteRow[] = [
      { ts: new Date(start + 37_000), current_1: 5, current_2: 0 }, // 00:00:37 -> slot 0
      { ts: new Date(start + MINUTE_MS + 59_000), current_1: 0, current_2: 3 }, // 00:01:59 -> slot 1
    ];
    expect(toMinuteSources(rows, start, start + 3 * MINUTE_MS)).toEqual(["grid", "gen", "none"]);
  });

  it("two rows in one minute: last wins", () => {
    const rows: PowerMinuteRow[] = [
      { ts: new Date(start + 5_000), current_1: 5, current_2: 0 },
      { ts: new Date(start + 40_000), current_1: 0, current_2: 3 },
    ];
    expect(toMinuteSources(rows, start, start + MINUTE_MS)).toEqual(["gen"]);
  });

  it("empty input -> all none", () => {
    expect(toMinuteSources([], start, start + 3 * MINUTE_MS)).toEqual(["none", "none", "none"]);
  });
});

describe("smoothFlickers", () => {
  it("heals 1-min and 2-min dropouts inside a run", () => {
    expect(smoothFlickers(["grid", "none", "grid"])).toEqual(["grid", "grid", "grid"]);
    expect(smoothFlickers(["grid", "none", "none", "grid"])).toEqual(["grid", "grid", "grid", "grid"]);
  });

  it("keeps a 3-min gap", () => {
    expect(smoothFlickers(["grid", "none", "none", "none", "grid"]))
      .toEqual(["grid", "none", "none", "none", "grid"]);
  });

  it("keeps a gap between different neighbors (real changeover)", () => {
    expect(smoothFlickers(["grid", "none", "gen"])).toEqual(["grid", "none", "gen"]);
  });

  it("keeps flickers at the array edges", () => {
    expect(smoothFlickers(["none", "none", "grid", "grid"])).toEqual(["none", "none", "grid", "grid"]);
    expect(smoothFlickers(["grid", "grid", "none"])).toEqual(["grid", "grid", "none"]);
  });

  it("heals a single opposite-source blip between equal neighbors", () => {
    expect(smoothFlickers(["grid", "gen", "grid"])).toEqual(["grid", "grid", "grid"]);
  });

  it("does not mutate the input", () => {
    const input: PowerSource[] = ["grid", "none", "grid"];
    smoothFlickers(input);
    expect(input).toEqual(["grid", "none", "grid"]);
  });
});

describe("buildSessions", () => {
  it("collapses runs including none, with minutes", () => {
    const sessions = buildSessions(["grid", "grid", "gen", "none"], 0);
    expect(sessions).toEqual([
      sess("grid", 0, 2 * MINUTE_MS),
      sess("gen", 2 * MINUTE_MS, 3 * MINUTE_MS),
      sess("none", 3 * MINUTE_MS, 4 * MINUTE_MS),
    ]);
  });

  it("single run", () => {
    expect(buildSessions(["grid", "grid", "grid"], 0)).toEqual([sess("grid", 0, 3 * MINUTE_MS)]);
  });
});

describe("resolveCurrentSession", () => {
  const now = Date.UTC(2026, 6, 1, 12, 0, 0);

  it("tail matches live -> duration from tail start", () => {
    const sessions = [sess("gen", now - 100 * MINUTE_MS, now - 30 * MINUTE_MS), sess("grid", now - 30 * MINUTE_MS, now)];
    expect(resolveCurrentSession(sessions, "grid", now)).toEqual({ source: "grid", startMs: now - 30 * MINUTE_MS, minutes: 30 });
  });

  it("fresh grid<->gen switch not yet persisted -> starts at now, 0 min", () => {
    const sessions = [sess("gen", now - 60 * MINUTE_MS, now)];
    expect(resolveCurrentSession(sessions, "grid", now)).toEqual({ source: "grid", startMs: now, minutes: 0 });
  });

  it("live none with a grid tail -> blackout began at the data edge", () => {
    const sessions = [sess("grid", now - 60 * MINUTE_MS, now - 5 * MINUTE_MS)];
    expect(resolveCurrentSession(sessions, "none", now)).toEqual({ source: "none", startMs: now - 5 * MINUTE_MS, minutes: 5 });
  });

  it("empty sessions -> live source at now", () => {
    expect(resolveCurrentSession([], "gen", now)).toEqual({ source: "gen", startMs: now, minutes: 0 });
  });
});

describe("baghdadDateKey", () => {
  it("20:30Z is the same Baghdad day", () => {
    expect(baghdadDateKey(Date.UTC(2026, 6, 1, 20, 30))).toBe("2026-07-01");
  });

  it("21:30Z rolls into the next Baghdad day", () => {
    expect(baghdadDateKey(Date.UTC(2026, 6, 1, 21, 30))).toBe("2026-07-02");
  });
});

describe("gridMinutesInWindow", () => {
  const start = Date.UTC(2026, 6, 1, 0, 0);

  it("counts grid minutes inside an aligned window", () => {
    const series: PowerSource[] = ["grid", "gen", "grid", "grid", "none"];
    expect(gridMinutesInWindow(series, start, start, start + 5 * MINUTE_MS)).toBe(3);
  });

  it("clamps a window starting before the series", () => {
    const series: PowerSource[] = ["grid", "grid"];
    expect(gridMinutesInWindow(series, start, start - 100 * MINUTE_MS, start + 2 * MINUTE_MS)).toBe(2);
  });
});

describe("averageSessionHours", () => {
  const t0 = Date.UTC(2026, 6, 1, 0, 0);
  const H = 60 * MINUTE_MS;

  it("averages the duration of complete grid/gen stretches", () => {
    // grid 2h, gen 4h, grid 4h, gen 6h, then a running grid tail (excluded).
    const sessions: Session[] = [
      sess("grid", t0, t0 + 2 * H),
      sess("gen", t0 + 2 * H, t0 + 6 * H),
      sess("grid", t0 + 6 * H, t0 + 10 * H),
      sess("gen", t0 + 10 * H, t0 + 16 * H),
      sess("grid", t0 + 16 * H, t0 + 17 * H), // running tail — excluded
    ];
    expect(averageSessionHours(sessions, t0)).toEqual({ avgGridSessionHours: 3, avgGenSessionHours: 5 });
  });

  it("ignores none/blackout stretches and the running tail", () => {
    const sessions: Session[] = [
      sess("grid", t0, t0 + 3 * H),
      sess("none", t0 + 3 * H, t0 + 4 * H), // blackout ignored
      sess("gen", t0 + 4 * H, t0 + 9 * H),
      sess("grid", t0 + 9 * H, t0 + 10 * H), // running tail — excluded
    ];
    expect(averageSessionHours(sessions, t0)).toEqual({ avgGridSessionHours: 3, avgGenSessionHours: 5 });
  });

  it("excludes stretches that switched before the window", () => {
    const sessions: Session[] = [
      sess("grid", t0, t0 + 2 * H), // ends at t0+2h — before window start t0+3h
      sess("gen", t0 + 2 * H, t0 + 8 * H), // ends in window
      sess("grid", t0 + 8 * H, t0 + 9 * H), // running tail — excluded
    ];
    expect(averageSessionHours(sessions, t0 + 3 * H)).toEqual({ avgGridSessionHours: null, avgGenSessionHours: 6 });
  });

  it("returns nulls when only a running session exists", () => {
    expect(averageSessionHours([sess("grid", t0, t0 + H)], t0))
      .toEqual({ avgGridSessionHours: null, avgGenSessionHours: null });
  });
});

describe("weightedMedian", () => {
  it("odd and even counts", () => {
    expect(weightedMedian([{ value: 10, weight: 1 }, { value: 20, weight: 1 }, { value: 30, weight: 1 }])).toBe(20);
    expect(weightedMedian([{ value: 10, weight: 1 }, { value: 20, weight: 1 }])).toBe(10);
  });

  it("heavy weight pulls the median", () => {
    expect(weightedMedian([{ value: 10, weight: 1 }, { value: 20, weight: 5 }])).toBe(20);
  });

  it("single sample", () => {
    expect(weightedMedian([{ value: 42, weight: 1 }])).toBe(42);
  });
});

describe("dayBreakdownForWindow", () => {
  it("single partial Baghdad day: off = covered - grid - gen", () => {
    const start = Date.UTC(2026, 6, 1, 6, 0); // 09:00 Baghdad Jul 1
    const series: PowerSource[] = [...Array(60).fill("grid"), ...Array(60).fill("gen"), ...Array(60).fill("none")];
    const r = dayBreakdownForWindow(series, start, start, start + 180 * MINUTE_MS);
    expect(r.days).toEqual([{ date: "2026-07-01", gridHours: 1, genHours: 1, offHours: 1, partial: true }]);
    expect(r.totals).toEqual({ gridHours: 1, genHours: 1, offHours: 1 });
  });

  it("splits across Baghdad midnight into two partial days with summed totals", () => {
    const start = Date.UTC(2026, 6, 1, 20, 0); // 23:00 Baghdad Jul 1
    const series: PowerSource[] = Array(180).fill("grid"); // 23:00 -> 02:00 Baghdad
    const r = dayBreakdownForWindow(series, start, start, start + 180 * MINUTE_MS);
    expect(r.days.map((d) => d.date)).toEqual(["2026-07-01", "2026-07-02"]);
    expect(r.days.every((d) => d.partial)).toBe(true);
    expect(r.totals.gridHours).toBe(3);
  });

  it("marks a full 1440-minute day as complete", () => {
    const start = Date.UTC(2026, 6, 1, 21, 0); // Baghdad midnight Jul 2
    const series: PowerSource[] = Array(1440).fill("grid");
    const r = dayBreakdownForWindow(series, start, start, start + 1440 * MINUTE_MS);
    expect(r.days).toEqual([{ date: "2026-07-02", gridHours: 24, genHours: 0, offHours: 0, partial: false }]);
  });
});
