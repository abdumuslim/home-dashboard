import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AcCalibrator,
  buildCalibrationSteps,
  calMedian,
  calStddev,
  calSamplesNeeded,
  fitAmpModel,
  CAL_SAMPLES_GRID,
  CAL_SAMPLES_GEN,
  CAL_BASELINE_SAMPLES_GEN,
  CAL_REFERENCE_FAN,
  CAL_OFF_SETTLE_MS,
  CAL_LEVEL_SETTLE_MS,
  CAL_RAMP_MAX_MS,
  CAL_STABLE_READINGS,
} from "./ac-calibration.js";
import { AC_RAMP_MS } from "./ac-leveling.js";

describe("buildCalibrationSteps", () => {
  it("sweeps levels 1..max, then fans 1..7 when included", () => {
    const steps = buildCalibrationSteps(3, true);
    expect(steps).toEqual([
      { kind: "level", value: 1 }, { kind: "level", value: 2 }, { kind: "level", value: 3 },
      { kind: "fan", value: 1 }, { kind: "fan", value: 2 }, { kind: "fan", value: 3 },
      { kind: "fan", value: 4 }, { kind: "fan", value: 5 }, { kind: "fan", value: 6 }, { kind: "fan", value: 7 },
    ]);
  });

  it("omits the fan sweep when not included", () => {
    expect(buildCalibrationSteps(6, false)).toHaveLength(6);
    expect(buildCalibrationSteps(6, false).every((s) => s.kind === "level")).toBe(true);
  });
});

describe("calSamplesNeeded", () => {
  it("collects more samples on the fluctuating generator", () => {
    expect(calSamplesNeeded("grid", false)).toBe(CAL_SAMPLES_GRID);
    expect(calSamplesNeeded("gen", false)).toBe(CAL_SAMPLES_GEN);
    expect(calSamplesNeeded("gen", true)).toBe(CAL_BASELINE_SAMPLES_GEN);
    expect(CAL_SAMPLES_GEN).toBeGreaterThan(CAL_SAMPLES_GRID);
  });
});

describe("calMedian / calStddev", () => {
  it("computes median for odd and even windows", () => {
    expect(calMedian([3, 1, 2])).toBe(2);
    expect(calMedian([4, 1, 3, 2])).toBe(2.5);
  });

  it("computes sample standard deviation", () => {
    expect(calStddev([2, 2, 2])).toBe(0);
    expect(calStddev([1, 3])).toBeCloseTo(Math.SQRT2, 5);
    expect(calStddev([5])).toBe(0);
  });
});

describe("fitAmpModel", () => {
  it("recovers base and step from a clean linear sweep", () => {
    // amps = 4 + 2×(level−1)
    const fit = fitAmpModel([
      { level: 1, amps: 4 }, { level: 2, amps: 6 }, { level: 3, amps: 8 },
    ]);
    expect(fit).toEqual({ baseAmps: 4, stepAmps: 2 });
  });

  it("fits noisy measurements by least squares", () => {
    const fit = fitAmpModel([
      { level: 1, amps: 2.1 }, { level: 2, amps: 2.9 }, { level: 3, amps: 4.1 },
      { level: 4, amps: 4.9 }, { level: 5, amps: 6.1 }, { level: 6, amps: 6.9 },
    ]);
    expect(fit!.baseAmps).toBeCloseTo(2, 1);
    expect(fit!.stepAmps).toBeCloseTo(1, 1);
  });

  it("handles degenerate inputs", () => {
    expect(fitAmpModel([])).toBeNull();
    expect(fitAmpModel([{ level: 2, amps: 5 }])).toEqual({ baseAmps: 5, stepAmps: 0 });
  });
});

// ---------- State machine ----------

interface MockRow { amps: number; samples: number; stddev: number }

function createCalibrator() {
  const rows = new Map<string, MockRow>(); // `${id}:${source}:${kind}:${step}`
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO ac_calibration_results")) {
        rows.set(`${params[0]}:${params[1]}:${params[2]}:${params[3]}`, {
          amps: Number(params[4]),
          stddev: Number(params[6]),
          samples: Number(params[7]),
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM ac_calibration_results")) {
        return {
          rows: Array.from(rows, ([key, r]) => {
            const [device_id, source, kind, step] = key.split(":");
            return { device_id, source, kind, step: Number(step), amps: r.amps, voltage: 200, stddev: r.stddev, samples: r.samples, measured_at: new Date() };
          }),
          rowCount: rows.size,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  const commands: Array<{ deviceId: string; cmd: string; value?: unknown }> = [];
  const devices = [
    { id: "ac1", name: "Abdullah", power: true, generatorMode: 2, fanSpeed: 4, maxGeneratorLevel: 2 },
    { id: "ac2", name: "Najat", power: true, generatorMode: 3, fanSpeed: 0, maxGeneratorLevel: 6 },
    { id: "ac3", name: "Abdu", power: false, generatorMode: 1, fanSpeed: 1, maxGeneratorLevel: 3 },
  ];
  const tcl = {
    isReady: vi.fn(() => true),
    getDevices: vi.fn(() => devices),
    executeAcAction: vi.fn(async (deviceId: string, action: Record<string, unknown>) => {
      commands.push({ deviceId, cmd: "action", value: action });
    }),
    sendControl: vi.fn(async (deviceId: string, cmd: string, value: unknown) => {
      commands.push({ deviceId, cmd, value });
    }),
  };
  const cal = new AcCalibrator(pool as never, {
    getTclCloud: () => tcl as never,
    getLimits: () => ({ gridLimitAmps: 30, genLimitAmps: 15, marginAmps: 1 }),
    broadcast: vi.fn(async () => undefined),
  });
  return { cal, tcl, pool, rows, commands, devices };
}

function feedGen(cal: AcCalibrator, amps: number, count: number) {
  for (let i = 0; i < count; i++) {
    cal.onPowerReading({ current_1: 0, current_2: amps, voltage: 200 });
  }
}

/**
 * Pass one settle step: advance to the settle floor, feed a stable plateau so
 * the calibrator early-releases, collapse the window with a tick, then collect
 * the measurement samples and record with a second tick.
 */
async function settleStep(cal: AcCalibrator, floorMs: number, amps: number, count: number) {
  vi.advanceTimersByTime(floorMs + 1000);
  feedGen(cal, amps, CAL_STABLE_READINGS); // plateau → early release
  await cal.tick(); // collapse the settle window
  feedGen(cal, amps, count); // measurement samples
  await cal.tick(); // record the step
}

describe("AcCalibrator state machine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-07T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a full single-AC sweep: others off, baseline, ramp, per-step sampling, restore", async () => {
    const { cal, tcl, rows, commands } = createCalibrator();
    feedGen(cal, 9, 1);
    const started = await cal.start(["ac1"], false); // maxLevel 2 → 2 level steps
    expect(started).toEqual({ ok: true });
    expect(cal.isActive()).toBe(true);
    expect(cal.getStatus().source).toBe("gen");

    // Prep: every ON AC is turned off (ac1 + ac2; ac3 already off)
    await cal.tick();
    expect(tcl.executeAcAction).toHaveBeenCalledWith("ac1", { power: 0 });
    expect(tcl.executeAcAction).toHaveBeenCalledWith("ac2", { power: 0 });
    expect(cal.getStatus().phase).toBe("baseline");

    // Baseline samples only count after the off-settle window
    feedGen(cal, 2, CAL_BASELINE_SAMPLES_GEN);
    expect(cal.getStatus().samplesCollected).toBe(0);
    vi.advanceTimersByTime(CAL_OFF_SETTLE_MS + 1000);
    feedGen(cal, 2, CAL_BASELINE_SAMPLES_GEN);
    await cal.tick();
    // Target powered on at L1 with the reference fan
    expect(tcl.executeAcAction).toHaveBeenCalledWith("ac1", { power: 1, generator_mode: 1, fan_speed: CAL_REFERENCE_FAN });
    expect(cal.getStatus().phase).toBe("ramp");

    // Compressor ramp: not sampled before the floor, even with a stable draw.
    vi.advanceTimersByTime(AC_RAMP_MS - 5000);
    feedGen(cal, 5, CAL_STABLE_READINGS);
    await cal.tick();
    expect(cal.getStatus().phase).toBe("ramp"); // floor not reached yet

    // Past the floor + stable draw → early release into sampling.
    vi.advanceTimersByTime(6000);
    feedGen(cal, 5, CAL_STABLE_READINGS);
    await cal.tick();
    expect(cal.getStatus().phase).toBe("sample");
    expect(cal.getStatus().step).toEqual({ kind: "level", value: 1 });

    // L1: 12 gen samples at 5A → draw = 5 − baseline 2 = 3
    feedGen(cal, 5, CAL_SAMPLES_GEN);
    await cal.tick();
    expect(rows.get("ac1:gen:level:1")).toMatchObject({ amps: 3, samples: CAL_SAMPLES_GEN });
    expect(tcl.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 2);

    // L2: plateau readings during the settle don't count as samples; once stable
    // past the floor the window collapses and the real samples are collected.
    vi.advanceTimersByTime(CAL_LEVEL_SETTLE_MS + 1000);
    feedGen(cal, 6, CAL_STABLE_READINGS);
    expect(cal.getStatus().samplesCollected).toBe(0);
    await cal.tick(); // early release
    feedGen(cal, 6, CAL_SAMPLES_GEN);
    await cal.tick();
    expect(rows.get("ac1:gen:level:2")).toMatchObject({ amps: 4 });

    // Sweep done → target off → restore phase → previously-ON ACs come back
    expect(tcl.executeAcAction).toHaveBeenCalledWith("ac1", { power: 0 });
    await cal.tick(); // restore
    expect(tcl.executeAcAction).toHaveBeenCalledWith("ac1", { power: 1, generator_mode: 2, fan_speed: 4 });
    expect(tcl.executeAcAction).toHaveBeenCalledWith("ac2", { power: 1, generator_mode: 3, fan_speed: 0 });
    const ac3Restores = commands.filter((c) => c.deviceId === "ac3" && c.cmd === "action" && (c.value as { power?: number }).power === 1);
    expect(ac3Restores).toHaveLength(0); // was off — stays off
    expect(cal.isActive()).toBe(false);
    expect(cal.getStatus().phase).toBe("idle");
    expect(cal.getStatus().abortReason).toBeNull();
  });

  it("tests selected ACs one by one with a fresh baseline in between", async () => {
    const { cal, tcl } = createCalibrator();
    feedGen(cal, 9, 1);
    await cal.start(["ac1", "ac3"], false);
    await cal.tick(); // prep

    // Device 1 (ac1, maxLevel 2)
    vi.advanceTimersByTime(CAL_OFF_SETTLE_MS + 1000);
    feedGen(cal, 2, CAL_BASELINE_SAMPLES_GEN);
    await cal.tick(); // ac1 on → ramp
    await settleStep(cal, AC_RAMP_MS, 5, CAL_SAMPLES_GEN); // ramp → L1 recorded → L2 commanded
    await settleStep(cal, CAL_LEVEL_SETTLE_MS, 6, CAL_SAMPLES_GEN); // L2 recorded → ac1 off, next baseline

    expect(tcl.executeAcAction).toHaveBeenLastCalledWith("ac1", { power: 0 });
    expect(cal.getStatus().phase).toBe("baseline");
    expect(cal.getStatus().currentDevice).toBe("ac3");

    // Device 2 (ac3) gets its own power-on after the new baseline
    vi.advanceTimersByTime(CAL_OFF_SETTLE_MS + 1000);
    feedGen(cal, 2, CAL_BASELINE_SAMPLES_GEN);
    await cal.tick();
    expect(tcl.executeAcAction).toHaveBeenLastCalledWith("ac3", { power: 1, generator_mode: 1, fan_speed: CAL_REFERENCE_FAN });
  });

  it("aborts and restores when the power source changes mid-run", async () => {
    const { cal, tcl } = createCalibrator();
    feedGen(cal, 9, 1);
    await cal.start(["ac2"], true);
    await cal.tick(); // prep

    // Changeover to grid mid-run — gen results would be polluted
    cal.onPowerReading({ current_1: 9, current_2: 0, voltage: 220 });
    await cal.tick();

    expect(cal.isActive()).toBe(false);
    expect(cal.getStatus().abortReason).toBe("source_changed");
    // Previously-ON ACs restored
    expect(tcl.executeAcAction).toHaveBeenCalledWith("ac1", { power: 1, generator_mode: 2, fan_speed: 4 });
    expect(tcl.executeAcAction).toHaveBeenCalledWith("ac2", { power: 1, generator_mode: 3, fan_speed: 0 });
  });

  it("aborts on user AC control (requestAbort) and keeps partial results", async () => {
    const { cal, rows } = createCalibrator();
    feedGen(cal, 9, 1);
    await cal.start(["ac1"], false);
    await cal.tick(); // prep
    vi.advanceTimersByTime(CAL_OFF_SETTLE_MS + 1000);
    feedGen(cal, 2, CAL_BASELINE_SAMPLES_GEN);
    await cal.tick(); // ac1 on → ramp
    await settleStep(cal, AC_RAMP_MS, 5, CAL_SAMPLES_GEN); // ramp → L1 recorded

    cal.requestAbort("user_control");
    await cal.tick();
    expect(cal.isActive()).toBe(false);
    expect(cal.getStatus().abortReason).toBe("user_control");
    expect(rows.get("ac1:gen:level:1")).toBeDefined(); // partial result kept
  });

  it("rejects start when already running, no power, or unknown devices", async () => {
    const { cal } = createCalibrator();
    expect(await cal.start(["ac1"], false)).toMatchObject({ status: 409 }); // no readings yet
    feedGen(cal, 9, 1);
    expect(await cal.start(["nope"], false)).toMatchObject({ status: 400 });
    expect(await cal.start(["ac1"], false)).toEqual({ ok: true });
    expect(await cal.start(["ac2"], false)).toMatchObject({ status: 409 }); // already running
  });

  it("computes per-device suggested fits from stored level sweeps", async () => {
    const { cal, pool } = createCalibrator();
    // Seed rows directly through the upsert path
    await pool.query(
      "INSERT INTO ac_calibration_results (device_id, source, kind, step, amps, voltage, stddev, samples, measured_at) VALUES",
      ["ac1", "gen", "level", 1, 3, 200, 0.2, 12],
    );
    await pool.query(
      "INSERT INTO ac_calibration_results (device_id, source, kind, step, amps, voltage, stddev, samples, measured_at) VALUES",
      ["ac1", "gen", "level", 2, 5, 200, 0.2, 12],
    );
    const { suggestedFit } = await cal.getResults();
    expect(suggestedFit.ac1.gen).toEqual({ baseAmps: 3, stepAmps: 2 });
    expect(suggestedFit.ac1.grid).toBeUndefined();
  });

  it("holds the ramp to the max cap when the draw never stabilizes, then samples", async () => {
    const { cal } = createCalibrator();
    feedGen(cal, 9, 1);
    await cal.start(["ac1"], false);
    await cal.tick(); // prep
    vi.advanceTimersByTime(CAL_OFF_SETTLE_MS + 1000);
    feedGen(cal, 2, CAL_BASELINE_SAMPLES_GEN);
    await cal.tick(); // ac1 on → ramp

    // Past the floor but the draw keeps drifting (spread > band) → no early release.
    vi.advanceTimersByTime(AC_RAMP_MS + 1000);
    for (const a of [4, 5, 6, 7]) feedGen(cal, a, 1);
    await cal.tick();
    expect(cal.getStatus().phase).toBe("ramp"); // not stable → still ramping

    // Reaching the max cap forces the transition regardless of stability.
    vi.advanceTimersByTime(CAL_RAMP_MAX_MS);
    feedGen(cal, 6, 1); // keep-alive so the source stays gen
    await cal.tick();
    expect(cal.getStatus().phase).toBe("sample");
  });
});
