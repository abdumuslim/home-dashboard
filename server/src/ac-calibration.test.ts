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
  CAL_RAMP_FLOOR_MS,
  CAL_RAMP_MAX_MS,
  CAL_STABLE_READINGS,
  CAL_POWER_GRACE_MS,
} from "./ac-calibration.js";

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
    { id: "ac1", name: "Abdullah", power: true, generatorMode: 2, fanSpeed: 4, maxGeneratorLevel: 2, levelingEligible: true },
    { id: "ac2", name: "Najat", power: true, generatorMode: 3, fanSpeed: 0, maxGeneratorLevel: 3, levelingEligible: true },
    { id: "ac3", name: "Abdu", power: false, generatorMode: 1, fanSpeed: 1, maxGeneratorLevel: 3, levelingEligible: true },
  ];
  // Firmware quirk simulation (Najat-style): gen levels in `ignoreGenLevels`
  // never apply to the shadow; `genLevelSendsNeeded` applies a level only after
  // the N-th send (lagging firmware). Well-behaved levels apply instantly.
  const firmware = { ignoreGenLevels: new Set<number>(), genLevelSendsNeeded: new Map<number, number>() };
  const genSendCounts = new Map<string, number>();
  const applyGenLevel = (deviceId: string, value: number) => {
    if (firmware.ignoreGenLevels.has(value)) return;
    const key = `${deviceId}:${value}`;
    const sends = (genSendCounts.get(key) ?? 0) + 1;
    genSendCounts.set(key, sends);
    if (sends < (firmware.genLevelSendsNeeded.get(value) ?? 1)) return;
    const dev = devices.find((d) => d.id === deviceId);
    if (dev) dev.generatorMode = value;
  };
  const tcl = {
    isReady: vi.fn(() => true),
    getDevices: vi.fn(() => devices),
    fetchDevicesLive: vi.fn(async () => devices),
    executeAcAction: vi.fn(async (deviceId: string, action: Record<string, unknown>) => {
      commands.push({ deviceId, cmd: "action", value: action });
      const dev = devices.find((d) => d.id === deviceId);
      if (dev) {
        if (action.power != null) dev.power = action.power === 1;
        if (typeof action.fan_speed === "number") dev.fanSpeed = action.fan_speed;
        if (typeof action.generator_mode === "number") applyGenLevel(deviceId, action.generator_mode);
      }
    }),
    sendControl: vi.fn(async (deviceId: string, cmd: string, value: unknown) => {
      commands.push({ deviceId, cmd, value });
      const dev = devices.find((d) => d.id === deviceId);
      if (dev && typeof value === "number") {
        if (cmd === "set_generator_mode") applyGenLevel(deviceId, value);
        if (cmd === "set_fan_speed") dev.fanSpeed = value;
      }
    }),
  };
  const onDevicesRestored = vi.fn();
  const cal = new AcCalibrator(pool as never, {
    getTclCloud: () => tcl as never,
    getLimits: () => ({ gridLimitAmps: 30, genLimitAmps: 15, marginAmps: 1 }),
    broadcast: vi.fn(async () => undefined),
    onDevicesRestored,
  });
  return { cal, tcl, pool, rows, commands, devices, firmware, onDevicesRestored };
}

function feedGen(cal: AcCalibrator, amps: number, count: number) {
  for (let i = 0; i < count; i++) {
    cal.onPowerReading({ current_1: 0, current_2: amps, voltage: 200 });
  }
}

/**
 * Feed readings at the realistic ~5s ESP cadence. The plateau detector needs
 * the window to SPAN ≥ CAL_STABLE_SPAN_MS and the sample phase needs a minimum
 * duration — same-instant batches satisfy neither.
 */
function feedGenSpread(cal: AcCalibrator, amps: number, count: number, gapMs = 5_000) {
  for (let i = 0; i < count; i++) {
    if (i > 0) vi.advanceTimersByTime(gapMs);
    cal.onPowerReading({ current_1: 0, current_2: amps, voltage: 200 });
  }
}

/**
 * Pass one settle step: advance to the settle floor, feed a stable plateau
 * (spread over ≥15s) so the calibrator early-releases, collapse the window
 * with a tick, then collect the measurement samples (spread to satisfy the
 * minimum sampling duration) and record with a second tick.
 */
async function settleStep(cal: AcCalibrator, floorMs: number, amps: number, count: number) {
  vi.advanceTimersByTime(floorMs + 1000);
  feedGenSpread(cal, amps, CAL_STABLE_READINGS); // plateau → early release
  await cal.tick(); // collapse the settle window
  feedGenSpread(cal, amps, count); // measurement samples over count×5s
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
    vi.advanceTimersByTime(CAL_RAMP_FLOOR_MS - 5000);
    feedGen(cal, 5, CAL_STABLE_READINGS);
    await cal.tick();
    expect(cal.getStatus().phase).toBe("ramp"); // floor not reached yet

    // Past the floor + stable draw (spanning ≥15s) → early release into sampling.
    vi.advanceTimersByTime(6000);
    feedGenSpread(cal, 5, CAL_STABLE_READINGS);
    await cal.tick();
    expect(cal.getStatus().phase).toBe("sample");
    expect(cal.getStatus().step).toEqual({ kind: "level", value: 1 });

    // L1: 12 gen samples at 5A over the minimum duration → draw = 5 − baseline 2 = 3
    feedGenSpread(cal, 5, CAL_SAMPLES_GEN);
    await cal.tick();
    expect(rows.get("ac1:gen:level:1")).toMatchObject({ amps: 3, samples: CAL_SAMPLES_GEN });
    expect(tcl.sendControl).toHaveBeenCalledWith("ac1", "set_generator_mode", 2);

    // L2: plateau readings during the settle don't count as samples; once stable
    // past the floor the window collapses and the real samples are collected.
    vi.advanceTimersByTime(CAL_LEVEL_SETTLE_MS + 1000);
    feedGenSpread(cal, 6, CAL_STABLE_READINGS);
    expect(cal.getStatus().samplesCollected).toBe(0);
    await cal.tick(); // early release
    feedGenSpread(cal, 6, CAL_SAMPLES_GEN);
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

  it("rejects Guest before it can enter calibration or saved-state restoration", async () => {
    const { cal, devices, commands } = createCalibrator();
    devices.push({
      id: "DlXqDBFAAAE",
      name: "guest",
      power: true,
      generatorMode: 6,
      fanSpeed: 3,
      maxGeneratorLevel: 6,
      levelingEligible: false,
    } as (typeof devices)[number]);
    feedGen(cal, 9, 1);

    const result = await cal.start(["DlXqDBFAAAE"], false);

    expect(result).toEqual({ error: "Device is not eligible for ESP calibration: guest", status: 400 });
    expect(cal.isActive()).toBe(false);
    expect(commands).toEqual([]);
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
    await settleStep(cal, CAL_RAMP_FLOOR_MS, 5, CAL_SAMPLES_GEN); // ramp → L1 recorded → L2 commanded
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
    await settleStep(cal, CAL_RAMP_FLOOR_MS, 5, CAL_SAMPLES_GEN); // ramp → L1 recorded

    cal.requestAbort("user_control");
    await cal.tick();
    expect(cal.isActive()).toBe(false);
    expect(cal.getStatus().abortReason).toBe("user_control");
    expect(rows.get("ac1:gen:level:1")).toBeDefined(); // partial result kept
  });

  it("fires onDevicesRestored with the powered-back-on ACs after the end-of-run restore", async () => {
    const { cal, onDevicesRestored } = createCalibrator();
    feedGen(cal, 9, 1);
    await cal.start(["ac1"], false);
    await cal.tick(); // prep — ac1 + ac2 turned off (both were ON)

    cal.requestAbort("user_control");
    await cal.tick(); // restoreAll powers ac1 + ac2 back on (ac3 stays off)

    expect(onDevicesRestored).toHaveBeenCalledTimes(1);
    expect(new Set(onDevicesRestored.mock.calls[0][0] as string[])).toEqual(new Set(["ac1", "ac2"]));
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
    vi.advanceTimersByTime(CAL_RAMP_FLOOR_MS + 1000);
    for (const a of [4, 5, 6, 7]) feedGen(cal, a, 1);
    await cal.tick();
    expect(cal.getStatus().phase).toBe("ramp"); // not stable → still ramping

    // Reaching the max cap forces the transition regardless of stability.
    vi.advanceTimersByTime(CAL_RAMP_MAX_MS);
    feedGen(cal, 6, 1); // keep-alive so the source stays gen
    await cal.tick();
    expect(cal.getStatus().phase).toBe("sample");
  });

  // ---------- Methodology guards (2026-06-11 — the Najat gen run) ----------

  it("does not early-release the ramp while the draw sits at baseline (compressor not started)", async () => {
    const { cal } = createCalibrator();
    feedGen(cal, 2, 1);
    await cal.start(["ac1"], false);
    await cal.tick(); // prep
    vi.advanceTimersByTime(CAL_OFF_SETTLE_MS + 1000);
    feedGen(cal, 2, CAL_BASELINE_SAMPLES_GEN); // baseline 2A
    await cal.tick(); // ac1 on → ramp

    // Past the floor, perfectly stable — but stable AT baseline: the
    // compressor hasn't started, so "plateau" means nothing yet. This is
    // exactly how Najat's L1 recorded 0.00A at 94s on the live gen run.
    vi.advanceTimersByTime(CAL_RAMP_FLOOR_MS + 1000);
    feedGenSpread(cal, 2, CAL_STABLE_READINGS);
    await cal.tick();
    expect(cal.getStatus().phase).toBe("ramp");

    // The compressor finally kicks in and the higher draw stabilizes → release.
    vi.advanceTimersByTime(5000);
    feedGenSpread(cal, 5, CAL_STABLE_READINGS + 1);
    await cal.tick();
    expect(cal.getStatus().phase).toBe("sample");
  });

  it("records a never-started L1 at ~0A only at the ramp cap, and the fit excludes it", async () => {
    const { cal, rows } = createCalibrator();
    feedGen(cal, 2, 1);
    await cal.start(["ac1"], false);
    await cal.tick(); // prep
    vi.advanceTimersByTime(CAL_OFF_SETTLE_MS + 1000);
    feedGen(cal, 2, CAL_BASELINE_SAMPLES_GEN);
    await cal.tick(); // ac1 on → ramp
    feedGen(cal, 2, 1);
    await cal.tick(); // consume the power-on confirm during the settle

    // Draw never rises above baseline — the ramp holds to the max cap.
    vi.advanceTimersByTime(CAL_RAMP_MAX_MS + 1000);
    feedGen(cal, 2, 1); // keep-alive
    await cal.tick();
    expect(cal.getStatus().phase).toBe("sample");
    feedGenSpread(cal, 2, CAL_SAMPLES_GEN); // still baseline → 0A draw recorded
    await cal.tick();
    expect(rows.get("ac1:gen:level:1")).toMatchObject({ amps: 0 });

    // L2 behaves (compressor running) and records normally.
    await settleStep(cal, CAL_LEVEL_SETTLE_MS, 6, CAL_SAMPLES_GEN);
    expect(rows.get("ac1:gen:level:2")).toMatchObject({ amps: 4 });

    // The suggested fit learns ONLY from the valid L2 point.
    const { suggestedFit } = await cal.getResults();
    expect(suggestedFit.ac1.gen).toEqual({ baseAmps: 4, stepAmps: 0 });
  });

  it("skips a level the firmware never applies after bounded re-sends (Najat-style)", async () => {
    const { cal, rows, commands, firmware } = createCalibrator();
    firmware.ignoreGenLevels.add(2); // ac1's L2 never reaches the shadow
    feedGen(cal, 2, 1);
    await cal.start(["ac1"], false); // maxLevel 2 → L1, L2
    await cal.tick(); // prep
    vi.advanceTimersByTime(CAL_OFF_SETTLE_MS + 1000);
    feedGen(cal, 2, CAL_BASELINE_SAMPLES_GEN);
    await cal.tick(); // ac1 on → ramp
    await settleStep(cal, CAL_RAMP_FLOOR_MS, 5, CAL_SAMPLES_GEN); // L1 recorded → L2 commanded
    expect(rows.get("ac1:gen:level:1")).toBeDefined();

    // L2 never confirms: re-sent at 15s spacing (×2), then skipped entirely.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(16_000);
      feedGen(cal, 5, 1); // keep-alive
      await cal.tick();
      // No samples ever collect while the command is unconfirmed.
      expect(cal.getStatus().samplesCollected).toBe(0);
    }
    const l2Sends = commands.filter((c) => c.cmd === "set_generator_mode" && c.value === 2);
    expect(l2Sends).toHaveLength(3); // initial + 2 re-sends
    expect(rows.get("ac1:gen:level:2")).toBeUndefined(); // skipped — no bogus row

    // The run moved on and finished cleanly (device off → restore).
    expect(cal.isActive()).toBe(false);
    expect(cal.getStatus().abortReason).toBeNull();
  });

  it("records normally when a lagging command confirms only after a re-send", async () => {
    const { cal, rows, commands, firmware } = createCalibrator();
    firmware.genLevelSendsNeeded.set(2, 2); // L2 applies on the 2nd send
    feedGen(cal, 2, 1);
    await cal.start(["ac1"], false);
    await cal.tick(); // prep
    vi.advanceTimersByTime(CAL_OFF_SETTLE_MS + 1000);
    feedGen(cal, 2, CAL_BASELINE_SAMPLES_GEN);
    await cal.tick(); // ac1 on → ramp
    await settleStep(cal, CAL_RAMP_FLOOR_MS, 5, CAL_SAMPLES_GEN); // L1 recorded → L2 commanded (1st send, ignored)

    vi.advanceTimersByTime(16_000);
    feedGen(cal, 5, 1);
    await cal.tick(); // re-send — firmware applies this one
    vi.advanceTimersByTime(5_000);
    feedGen(cal, 5, 1);
    await cal.tick(); // confirm observed

    // The step then settles and records like any other.
    vi.advanceTimersByTime(5000);
    feedGenSpread(cal, 6, CAL_STABLE_READINGS + 1);
    await cal.tick(); // plateau → early release
    feedGenSpread(cal, 6, CAL_SAMPLES_GEN);
    await cal.tick(); // record
    expect(rows.get("ac1:gen:level:2")).toMatchObject({ amps: 4 });
    const l2Sends = commands.filter((c) => c.cmd === "set_generator_mode" && c.value === 2);
    expect(l2Sends).toHaveLength(2); // initial + 1 re-send
  });

  it("requires the plateau window to span 15s — same-instant readings don't release", async () => {
    const { cal } = createCalibrator();
    feedGen(cal, 2, 1);
    await cal.start(["ac1"], false);
    await cal.tick(); // prep
    vi.advanceTimersByTime(CAL_OFF_SETTLE_MS + 1000);
    feedGen(cal, 2, CAL_BASELINE_SAMPLES_GEN);
    await cal.tick(); // ac1 on → ramp

    // Stable, compressor clearly running — but all readings at one instant
    // (the live ESP reported every ~2.7s, not the assumed ~5s, shrinking
    // count-based windows). Count alone must not satisfy the plateau.
    vi.advanceTimersByTime(CAL_RAMP_FLOOR_MS + 1000);
    feedGen(cal, 5, CAL_STABLE_READINGS);
    await cal.tick();
    expect(cal.getStatus().phase).toBe("ramp");

    // The same readings spread over ≥15s release normally.
    feedGenSpread(cal, 5, CAL_STABLE_READINGS + 1);
    await cal.tick();
    expect(cal.getStatus().phase).toBe("sample");
  });

  it("holds the sample phase to a minimum duration even when counts fill fast", async () => {
    const { cal, rows } = createCalibrator();
    feedGen(cal, 2, 1);
    await cal.start(["ac1"], false);
    await cal.tick(); // prep
    vi.advanceTimersByTime(CAL_OFF_SETTLE_MS + 1000);
    feedGen(cal, 2, CAL_BASELINE_SAMPLES_GEN);
    await cal.tick(); // ac1 on → ramp
    vi.advanceTimersByTime(CAL_RAMP_FLOOR_MS + 1000);
    feedGenSpread(cal, 5, CAL_STABLE_READINGS);
    await cal.tick(); // early release into sampling

    // A fast ESP fills the COUNT instantly — the duration floor still holds.
    feedGen(cal, 5, CAL_SAMPLES_GEN);
    await cal.tick();
    expect(rows.get("ac1:gen:level:1")).toBeUndefined();

    // Once the minimum duration elapses the step records (extra samples kept).
    feedGenSpread(cal, 5, 10);
    await cal.tick();
    expect(rows.get("ac1:gen:level:1")).toMatchObject({ amps: 3 });
  });

  it("excludes near-zero and high-spread rows from the fit (Najat 2026-06-11 gen regression)", async () => {
    const { cal, pool } = createCalibrator();
    // Najat's actual poisoned gen run: L1 sampled before the compressor
    // started (0.00A), L2 mid-transition (±1.68 spread), L3–L6 clean and flat.
    const najatRows: Array<[number, number, number]> = [
      [1, 0, 0.28], [2, 1.07, 1.68], [3, 4.02, 0.09], [4, 4.12, 0.11], [5, 4.21, 0.13], [6, 4.45, 0.12],
    ];
    for (const [step, amps, stddev] of najatRows) {
      await pool.query(
        "INSERT INTO ac_calibration_results (device_id, source, kind, step, amps, voltage, stddev, samples, measured_at) VALUES",
        ["ac2", "gen", "level", step, amps, 0, stddev, 12],
      );
    }
    const { results, suggestedFit } = await cal.getResults();
    // All rows stay visible in the table…
    expect(results.filter((r) => r.deviceId === "ac2" && r.kind === "level")).toHaveLength(6);
    // …but the fit learns only from L3–L6 (flat ~4.0–4.45A → not 0.7+0.9/level).
    expect(suggestedFit.ac2.gen).toEqual({ baseAmps: 3.7, stepAmps: 0.1 });
  });

  // ---------- Power feed gaps (2026-06-12 — grid runs killed by ESP hiccups) ----------

  it("pauses through a short feed gap and re-settles the interrupted step on resume", async () => {
    const { cal, rows } = createCalibrator();
    feedGen(cal, 9, 1);
    await cal.start(["ac1"], false);
    await cal.tick(); // prep
    vi.advanceTimersByTime(CAL_OFF_SETTLE_MS + 1000);
    feedGen(cal, 2, CAL_BASELINE_SAMPLES_GEN);
    await cal.tick(); // ac1 on → ramp
    vi.advanceTimersByTime(CAL_RAMP_FLOOR_MS + 1000);
    feedGenSpread(cal, 5, CAL_STABLE_READINGS);
    await cal.tick(); // early release into sampling
    expect(cal.getStatus().phase).toBe("sample");
    feedGenSpread(cal, 5, 3); // a few pre-gap samples
    expect(cal.getStatus().samplesCollected).toBe(3);

    // ESP goes silent for 60s — well past STALE_POWER_MS, inside the grace.
    vi.advanceTimersByTime(60_000);
    await cal.tick();
    expect(cal.isActive()).toBe(true);
    expect(cal.getStatus().abortReason).toBeNull();
    expect(cal.getStatus().powerGapSeconds).toBeGreaterThanOrEqual(60);

    // Feed returns on the SAME source → resume: pre-gap samples are discarded
    // (compressor state may have shifted while blind) and the step re-settles.
    feedGen(cal, 5, 1);
    await cal.tick();
    expect(cal.isActive()).toBe(true);
    expect(cal.getStatus().powerGapSeconds).toBeNull();
    expect(cal.getStatus().samplesCollected).toBe(0);

    // Fresh settle floor passes, then sampling completes from post-gap draw.
    feedGenSpread(cal, 5, 5); // spans the re-armed 20s floor, keeps the source alive
    await cal.tick();
    feedGenSpread(cal, 5, CAL_SAMPLES_GEN);
    await cal.tick();
    expect(rows.get("ac1:gen:level:1")).toMatchObject({ amps: 3 });
  });

  it("aborts power_lost only once the gap outlasts the grace, restoring ACs and keeping partials", async () => {
    const { cal, tcl, rows } = createCalibrator();
    feedGen(cal, 9, 1);
    await cal.start(["ac1"], false);
    await cal.tick(); // prep
    vi.advanceTimersByTime(CAL_OFF_SETTLE_MS + 1000);
    feedGen(cal, 2, CAL_BASELINE_SAMPLES_GEN);
    await cal.tick(); // ac1 on → ramp
    await settleStep(cal, CAL_RAMP_FLOOR_MS, 5, CAL_SAMPLES_GEN); // L1 recorded
    expect(rows.get("ac1:gen:level:1")).toBeDefined();

    // Inside the grace: paused, still active.
    vi.advanceTimersByTime(CAL_POWER_GRACE_MS - 10_000);
    await cal.tick();
    expect(cal.isActive()).toBe(true);

    // Past the grace: real outage — abort, restore, partial results kept.
    vi.advanceTimersByTime(20_000);
    await cal.tick();
    expect(cal.isActive()).toBe(false);
    expect(cal.getStatus().abortReason).toBe("power_lost");
    expect(tcl.executeAcAction).toHaveBeenCalledWith("ac1", { power: 1, generator_mode: 2, fan_speed: 4 });
    expect(rows.get("ac1:gen:level:1")).toBeDefined();
  });

  it("aborts source_changed when the feed resumes on a different source", async () => {
    const { cal } = createCalibrator();
    feedGen(cal, 9, 1);
    await cal.start(["ac1"], false);
    await cal.tick(); // prep
    vi.advanceTimersByTime(30_000);
    await cal.tick(); // paused — not aborted
    expect(cal.isActive()).toBe(true);

    cal.onPowerReading({ current_1: 9, current_2: 0, voltage: 220 }); // back on GRID
    await cal.tick();
    expect(cal.isActive()).toBe(false);
    expect(cal.getStatus().abortReason).toBe("source_changed");
  });

  it("honors a user abort while paused on a feed gap", async () => {
    const { cal, tcl } = createCalibrator();
    feedGen(cal, 9, 1);
    await cal.start(["ac1"], false);
    await cal.tick(); // prep
    vi.advanceTimersByTime(30_000);
    await cal.tick(); // paused
    expect(cal.isActive()).toBe(true);

    cal.requestAbort("user_control");
    await cal.tick();
    expect(cal.isActive()).toBe(false);
    expect(cal.getStatus().abortReason).toBe("user_control");
    expect(tcl.executeAcAction).toHaveBeenCalledWith("ac2", { power: 1, generator_mode: 3, fan_speed: 0 });
  });
});
