// Per-AC draw calibration: measures how many amps each AC actually pulls at
// every generator level (and fan speed) on the active source. Gen voltage is
// lower and fluctuates, so steps on gen collect more samples and report the
// spread. ACs are tested ONE BY ONE with every other AC turned off; a fresh
// all-off baseline is measured before each AC so household drift is absorbed.
// While a run is active the collector suspends the leveler, all AC
// automations, AC timers, and fan enforcement — and restores every AC to its
// pre-run state on completion or abort.
import pg from "pg";
import { determineSource, AC_RAMP_MS, type PowerSource } from "./ac-leveling.js";
import type { TclCloud } from "./tcl-cloud.js";
import { childLogger } from "./logger.js";

const log = childLogger("ac-calibration");

/**
 * Settle floors and ceilings. The change must be given AT LEAST the floor to
 * take effect (never sample sooner than the proven settle), then sampling
 * starts as soon as the measured draw plateaus — or at the max cap if it never
 * stabilizes. Compressors are slow (level/ramp), fans respond fast.
 */
export const CAL_LEVEL_SETTLE_MS = 20_000;
export const CAL_LEVEL_SETTLE_MAX_MS = 120_000;
export const CAL_FAN_SETTLE_MS = 15_000;
export const CAL_FAN_SETTLE_MAX_MS = 30_000;
/** Compressor ramp after a turn-on: AC_RAMP_MS floor, this the max cap. */
export const CAL_RAMP_MAX_MS = 180_000;
/** Settle after powering ACs off before the all-off baseline is sampled (fixed — quick). */
export const CAL_OFF_SETTLE_MS = 10_000;
/** Consecutive settle-phase readings within the band that define a plateau (early release). */
export const CAL_STABLE_READINGS = 4;
/** Max−min spread across the plateau window; generator voltage fluctuates more. */
export const CAL_STABILITY_BAND_GRID = 0.4;
export const CAL_STABILITY_BAND_GEN = 0.8;
/** Samples per step on grid (ESP reads every ~5s). */
export const CAL_SAMPLES_GRID = 6;
/** Samples per step on generator — fluctuating voltage needs more averaging. */
export const CAL_SAMPLES_GEN = 12;
/** Baseline samples (all ACs off). */
export const CAL_BASELINE_SAMPLES_GRID = 4;
export const CAL_BASELINE_SAMPLES_GEN = 8;
/** Fixed reference fan during the level sweep. */
export const CAL_REFERENCE_FAN = 3;
/** Fan speeds swept (at max generator level, where capping bites least). */
export const CAL_FAN_STEPS = [1, 2, 3, 4, 5, 6, 7];

export type CalibrationPhase =
  | "idle" | "prep" | "baseline" | "ramp" | "sample" | "restore";

export interface CalibrationStep {
  kind: "level" | "fan";
  value: number;
}

export interface CalibrationResultRow {
  deviceId: string;
  source: "grid" | "gen";
  kind: "level" | "fan";
  step: number;
  amps: number;
  voltage: number | null;
  stddev: number | null;
  samples: number;
  measuredAt: string;
}

export interface CalibrationFit {
  baseAmps: number;
  stepAmps: number;
}

export interface AcCalibrationStatus {
  active: boolean;
  source: "grid" | "gen" | null;
  queue: string[];
  currentDevice: string | null;
  currentDeviceName: string | null;
  phase: CalibrationPhase;
  /** Current step within the device sweep, e.g. "level 3". */
  step: CalibrationStep | null;
  stepsDone: number;
  totalSteps: number;
  samplesCollected: number;
  samplesNeeded: number;
  startedAt: number | null;
  finishedAt: number | null;
  abortReason: string | null;
}

export interface AcCalibratorDeps {
  getTclCloud: () => TclCloud | null;
  getLimits: () => { gridLimitAmps: number; genLimitAmps: number; marginAmps: number };
  broadcast: (payload: Record<string, unknown>) => Promise<void>;
}

interface SavedAcState {
  power: boolean;
  generatorMode: number;
  fanSpeed: number;
}

interface Sample {
  amps: number;
  voltage: number;
}

// ---------- Pure helpers (unit-tested) ----------

export function calSamplesNeeded(source: PowerSource, baseline: boolean): number {
  if (baseline) return source === "gen" ? CAL_BASELINE_SAMPLES_GEN : CAL_BASELINE_SAMPLES_GRID;
  return source === "gen" ? CAL_SAMPLES_GEN : CAL_SAMPLES_GRID;
}

/** Level sweep at a fixed fan, then (optionally) a fan sweep at max level. */
export function buildCalibrationSteps(maxLevel: number, includeFan: boolean): CalibrationStep[] {
  const steps: CalibrationStep[] = [];
  for (let level = 1; level <= Math.max(1, maxLevel); level++) steps.push({ kind: "level", value: level });
  if (includeFan) for (const fan of CAL_FAN_STEPS) steps.push({ kind: "fan", value: fan });
  return steps;
}

export function calMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function calStddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Least-squares fit of the level sweep to the leveler's draw model
 * (amps = baseAmps + stepAmps × (level − 1)). Rounded to 0.1A.
 */
export function fitAmpModel(points: Array<{ level: number; amps: number }>): CalibrationFit | null {
  if (points.length === 0) return null;
  if (points.length === 1) {
    return { baseAmps: round1(points[0].amps), stepAmps: 0 };
  }
  const xs = points.map((p) => p.level - 1);
  const ys = points.map((p) => p.amps);
  const n = points.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i] - meanX) * (ys[i] - meanY);
    varX += (xs[i] - meanX) ** 2;
  }
  if (varX === 0) return { baseAmps: round1(meanY), stepAmps: 0 };
  const slope = cov / varX;
  const intercept = meanY - slope * meanX;
  return { baseAmps: round1(Math.max(0, intercept)), stepAmps: round1(Math.max(0, slope)) };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

// ---------- Stateful runner ----------

export class AcCalibrator {
  private pool: pg.Pool;
  private deps: AcCalibratorDeps;

  private active = false;
  private source: "grid" | "gen" | null = null;
  private includeFan = true;
  private queue: string[] = [];
  private queueIndex = 0;
  private savedStates = new Map<string, SavedAcState>();
  private deviceNames = new Map<string, string>();
  private maxLevels = new Map<string, number>();
  private phase: CalibrationPhase = "idle";
  private steps: CalibrationStep[] = [];
  private stepIndex = 0;
  private stepsDone = 0;
  private totalSteps = 0;
  private baselineAmps = 0;
  private samples: Sample[] = [];
  private settleUntil = 0;
  // Early-release plateau detection: when the settle was armed and the readings
  // observed during it (before sampling). Sampling starts once the draw is
  // stable past the floor, or at settleUntil (the max cap).
  private settleStartedAt = 0;
  private settleReadings: number[] = [];
  private startedAt: number | null = null;
  private finishedAt: number | null = null;
  private abortReason: string | null = null;
  private abortRequested: string | null = null;
  // Power reading state (fed from the collector, like the leveler)
  private lastReading: { current_1: number; current_2: number; voltage: number } | null = null;
  private lastReadingAt = 0;

  constructor(pool: pg.Pool, deps: AcCalibratorDeps) {
    this.pool = pool;
    this.deps = deps;
  }

  isActive(): boolean {
    return this.active;
  }

  /** Any user AC control during a run aborts it — user intent always wins. */
  requestAbort(reason: string): void {
    if (!this.active) return;
    if (!this.abortRequested) this.abortRequested = reason;
  }

  onPowerReading(data: { current_1: number; current_2: number; voltage: number }): void {
    this.lastReading = { current_1: data.current_1, current_2: data.current_2, voltage: data.voltage };
    this.lastReadingAt = Date.now();
    if (!this.active || !this.source) return;
    const measured = this.source === "grid" ? data.current_1 : data.current_2;
    // Belt-and-braces: with a single AC running we should never get near the
    // limit — if we do, something else big turned on; stop interfering.
    const limits = this.deps.getLimits();
    const limit = this.source === "grid" ? limits.gridLimitAmps : limits.genLimitAmps;
    if (measured > limit - limits.marginAmps) {
      this.requestAbort("over_limit");
      return;
    }
    const now = Date.now();
    const collecting = this.phase === "baseline" || this.phase === "sample";
    if (collecting && now >= this.settleUntil) {
      this.samples.push({ amps: measured, voltage: data.voltage });
    } else if ((this.phase === "ramp" || this.phase === "sample") && now < this.settleUntil) {
      // Settle-phase reading — feeds plateau detection for early release.
      this.settleReadings.push(measured);
      if (this.settleReadings.length > 6) this.settleReadings.shift();
    }
  }

  async start(deviceIds: string[], includeFan: boolean): Promise<{ ok: true } | { error: string; status: number }> {
    if (this.active) return { error: "Calibration already running", status: 409 };
    const tcl = this.deps.getTclCloud();
    if (!tcl || !tcl.isReady()) return { error: "TCL Cloud not available", status: 409 };
    const source = determineSource(this.lastReading, this.lastReadingAt > 0 ? Date.now() - this.lastReadingAt : Infinity);
    if (source === "none") return { error: "No electricity / no power readings", status: 409 };

    const devices = tcl.getDevices();
    if (devices.length === 0) return { error: "No AC devices known yet", status: 409 };
    const known = new Map(devices.map((d) => [d.id, d]));
    const queue = [...new Set(deviceIds)].filter((id) => known.has(id));
    if (queue.length === 0) return { error: "No valid deviceIds", status: 400 };

    // Snapshot every AC's state for the end-of-run restore
    this.savedStates.clear();
    this.deviceNames.clear();
    this.maxLevels.clear();
    for (const d of devices) {
      this.savedStates.set(d.id, { power: d.power, generatorMode: d.generatorMode, fanSpeed: d.fanSpeed });
      this.deviceNames.set(d.id, d.name);
      this.maxLevels.set(d.id, d.maxGeneratorLevel || 3);
    }

    this.active = true;
    this.source = source;
    this.includeFan = includeFan;
    this.queue = queue;
    this.queueIndex = 0;
    this.phase = "prep";
    this.steps = [];
    this.stepIndex = 0;
    this.stepsDone = 0;
    this.totalSteps = queue.reduce(
      (sum, id) => sum + buildCalibrationSteps(this.maxLevels.get(id) ?? 3, includeFan).length,
      0,
    );
    this.samples = [];
    this.settleUntil = 0;
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.abortReason = null;
    this.abortRequested = null;
    log.info(`[calibration] Started on ${source} for [${queue.map((id) => this.deviceNames.get(id) ?? id).join(", ")}] (fan sweep: ${includeFan})`);
    return { ok: true };
  }

  /** Driven from the collector loop (~5s cadence), like the leveler tick. */
  async tick(): Promise<void> {
    if (!this.active || !this.source) return;
    if (this.abortRequested) {
      await this.abort(this.abortRequested);
      return;
    }
    const tcl = this.deps.getTclCloud();
    if (!tcl || !tcl.isReady()) {
      await this.abort("tcl_unavailable");
      return;
    }
    const liveSource = determineSource(this.lastReading, Date.now() - this.lastReadingAt);
    if (liveSource !== this.source) {
      await this.abort(liveSource === "none" ? "power_lost" : "source_changed");
      return;
    }

    // Early release: once the change has had at least its floor to take effect
    // and the measured draw has plateaued, collapse the remaining wait so
    // sampling starts now instead of holding out to the max cap.
    const now = Date.now();
    if (
      (this.phase === "ramp" || this.phase === "sample") &&
      now < this.settleUntil &&
      now - this.settleStartedAt >= this.settleFloorMs() &&
      this.isSettleStable()
    ) {
      log.info(`[calibration] Draw stabilized after ${Math.round((now - this.settleStartedAt) / 1000)}s — sampling early`);
      this.settleUntil = now;
    }

    try {
      switch (this.phase) {
        case "prep": {
          // Turn OFF every AC that is on — the baseline needs an all-off house.
          for (const [id, saved] of this.savedStates) {
            if (saved.power) await tcl.executeAcAction(id, { power: 0 });
          }
          this.enterBaseline();
          break;
        }
        case "baseline": {
          if (this.samples.length < calSamplesNeeded(this.source, true)) break;
          this.baselineAmps = calMedian(this.samples.map((s) => s.amps));
          const target = this.queue[this.queueIndex];
          const maxLevel = this.maxLevels.get(target) ?? 3;
          this.steps = buildCalibrationSteps(maxLevel, this.includeFan);
          this.stepIndex = 0;
          log.info(`[calibration] Baseline ${this.baselineAmps.toFixed(2)}A — starting ${this.deviceNames.get(target) ?? target} at L1 fan ${CAL_REFERENCE_FAN}`);
          // Power on at L1 with the reference fan, then wait out the compressor ramp.
          await tcl.executeAcAction(target, { power: 1, generator_mode: 1, fan_speed: CAL_REFERENCE_FAN });
          this.phase = "ramp";
          this.armSettle(CAL_RAMP_MAX_MS);
          break;
        }
        case "ramp": {
          if (Date.now() < this.settleUntil) break;
          // First step is L1 — already set at power-on, sample right away.
          this.samples = [];
          this.settleUntil = Date.now();
          this.phase = "sample";
          break;
        }
        case "sample": {
          if (this.samples.length < calSamplesNeeded(this.source, false)) break;
          await this.recordStep();
          await this.advanceStep(tcl);
          break;
        }
        case "restore": {
          await this.restoreAll(tcl);
          this.finish(null);
          break;
        }
        case "idle":
          break;
      }
    } catch (err) {
      log.error(`[calibration] Step failed:`, (err as Error).message);
      await this.abort("command_failed");
    }
  }

  private enterBaseline(): void {
    this.phase = "baseline";
    this.samples = [];
    this.settleUntil = Date.now() + CAL_OFF_SETTLE_MS;
  }

  /** Arm a settle with a hard max cap; early release collapses it once stable. */
  private armSettle(maxMs: number): void {
    const now = Date.now();
    this.settleUntil = now + maxMs;
    this.settleStartedAt = now;
    this.settleReadings = [];
  }

  /** Minimum settle before early release — never sample sooner than the proven floor. */
  private settleFloorMs(): number {
    if (this.phase === "ramp") return AC_RAMP_MS;
    return this.steps[this.stepIndex]?.kind === "fan" ? CAL_FAN_SETTLE_MS : CAL_LEVEL_SETTLE_MS;
  }

  /** Plateau detection: the last few settle readings sit within the source band. */
  private isSettleStable(): boolean {
    if (this.settleReadings.length < CAL_STABLE_READINGS) return false;
    const w = this.settleReadings.slice(-CAL_STABLE_READINGS);
    const band = this.source === "gen" ? CAL_STABILITY_BAND_GEN : CAL_STABILITY_BAND_GRID;
    return Math.max(...w) - Math.min(...w) <= band;
  }

  private async recordStep(): Promise<void> {
    const target = this.queue[this.queueIndex];
    const step = this.steps[this.stepIndex];
    const ampsValues = this.samples.map((s) => s.amps);
    const amps = Math.max(0, round2(calMedian(ampsValues) - this.baselineAmps));
    const voltage = round1(this.samples.reduce((sum, s) => sum + s.voltage, 0) / this.samples.length);
    const stddev = round2(calStddev(ampsValues));
    await this.pool.query(
      `INSERT INTO ac_calibration_results (device_id, source, kind, step, amps, voltage, stddev, samples, measured_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (device_id, source, kind, step)
       DO UPDATE SET amps = EXCLUDED.amps, voltage = EXCLUDED.voltage, stddev = EXCLUDED.stddev,
                     samples = EXCLUDED.samples, measured_at = NOW()`,
      [target, this.source, step.kind, step.value, amps, voltage, stddev, this.samples.length],
    );
    this.stepsDone++;
    log.info(
      `[calibration] ${this.deviceNames.get(target) ?? target} ${step.kind} ${step.value} on ${this.source}: ` +
      `${amps.toFixed(2)}A (±${stddev.toFixed(2)}, ${this.samples.length} samples, ${voltage.toFixed(0)}V)`,
    );
  }

  private async advanceStep(tcl: TclCloud): Promise<void> {
    const target = this.queue[this.queueIndex];
    this.stepIndex++;
    if (this.stepIndex < this.steps.length) {
      const next = this.steps[this.stepIndex];
      const prev = this.steps[this.stepIndex - 1];
      if (next.kind === "level") {
        await tcl.sendControl(target, "set_generator_mode", next.value);
        this.armSettle(CAL_LEVEL_SETTLE_MAX_MS);
      } else {
        if (prev.kind === "level") {
          // Fan sweep runs at max level — the per-level current cap bites least there.
          const maxLevel = this.maxLevels.get(target) ?? 3;
          if (prev.value !== maxLevel) await tcl.sendControl(target, "set_generator_mode", maxLevel);
        }
        await tcl.sendControl(target, "set_fan_speed", next.value);
        this.armSettle(CAL_FAN_SETTLE_MAX_MS);
      }
      this.samples = [];
      return;
    }
    // Device sweep done — turn it off and move on
    await tcl.executeAcAction(target, { power: 0 });
    this.queueIndex++;
    if (this.queueIndex < this.queue.length) {
      this.enterBaseline();
    } else {
      this.phase = "restore";
    }
  }

  private async restoreAll(tcl: TclCloud): Promise<void> {
    for (const [id, saved] of this.savedStates) {
      try {
        if (saved.power) {
          await tcl.executeAcAction(id, {
            power: 1,
            ...(saved.generatorMode > 0 ? { generator_mode: saved.generatorMode } : {}),
            fan_speed: saved.fanSpeed,
          });
        }
        // ACs that were off are already off (prep turned everything off).
      } catch (err) {
        log.error(`[calibration] Restore failed for ${this.deviceNames.get(id) ?? id}:`, (err as Error).message);
      }
    }
  }

  private finish(reason: string | null): void {
    this.active = false;
    this.phase = "idle";
    this.finishedAt = Date.now();
    this.abortReason = reason;
    this.abortRequested = null;
    if (reason) {
      log.warn(`[calibration] Aborted (${reason}) after ${this.stepsDone}/${this.totalSteps} steps — partial results kept`);
    } else {
      log.info(`[calibration] Completed ${this.stepsDone}/${this.totalSteps} steps on ${this.source}`);
      void this.deps.broadcast({
        title: "AC Calibration",
        body: `Calibration on ${this.source === "grid" ? "Grid" : "Generator"} finished — ${this.stepsDone} measurements saved.`,
        type: "leveling",
      });
    }
  }

  async abort(reason: string): Promise<void> {
    if (!this.active) return;
    const tcl = this.deps.getTclCloud();
    if (tcl && tcl.isReady()) {
      try {
        await this.restoreAll(tcl);
      } catch (err) {
        log.error(`[calibration] Restore on abort failed:`, (err as Error).message);
      }
    }
    this.finish(reason);
  }

  getStatus(): AcCalibrationStatus {
    const currentDevice = this.active ? this.queue[this.queueIndex] ?? null : null;
    return {
      active: this.active,
      source: this.active ? this.source : null,
      queue: this.queue,
      currentDevice,
      currentDeviceName: currentDevice ? this.deviceNames.get(currentDevice) ?? currentDevice : null,
      phase: this.phase,
      step: this.active && this.phase === "sample" ? this.steps[this.stepIndex] ?? null : null,
      stepsDone: this.stepsDone,
      totalSteps: this.totalSteps,
      samplesCollected: this.samples.length,
      samplesNeeded: this.active && this.source
        ? calSamplesNeeded(this.source, this.phase === "baseline")
        : 0,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      abortReason: this.abortReason,
    };
  }

  /** Full result table + per-device/source fitted amp models (level sweep). */
  async getResults(): Promise<{ results: CalibrationResultRow[]; suggestedFit: Record<string, { grid?: CalibrationFit; gen?: CalibrationFit }> }> {
    const res = await this.pool.query(
      "SELECT device_id, source, kind, step, amps, voltage, stddev, samples, measured_at FROM ac_calibration_results ORDER BY device_id, source, kind, step",
    );
    const results: CalibrationResultRow[] = res.rows.map((row) => ({
      deviceId: String(row.device_id),
      source: row.source as "grid" | "gen",
      kind: row.kind as "level" | "fan",
      step: Number(row.step),
      amps: Number(row.amps),
      voltage: row.voltage != null ? Number(row.voltage) : null,
      stddev: row.stddev != null ? Number(row.stddev) : null,
      samples: Number(row.samples),
      measuredAt: row.measured_at instanceof Date ? row.measured_at.toISOString() : String(row.measured_at),
    }));
    const suggestedFit: Record<string, { grid?: CalibrationFit; gen?: CalibrationFit }> = {};
    for (const deviceId of new Set(results.map((r) => r.deviceId))) {
      for (const source of ["grid", "gen"] as const) {
        const points = results
          .filter((r) => r.deviceId === deviceId && r.source === source && r.kind === "level")
          .map((r) => ({ level: r.step, amps: r.amps }));
        const fit = fitAmpModel(points);
        if (fit) {
          suggestedFit[deviceId] = { ...suggestedFit[deviceId], [source]: fit };
        }
      }
    }
    return { results, suggestedFit };
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
