// Replay/scenario harness for leveling v2 (test helper — not shipped code).
// Simulates the household physics the controller lives in: per-AC compressor
// demand vs cap, turn-on ramps, shadow confirm lag, breaker trips, blackouts,
// changeovers — and drives the PURE modules (sensing → modes → pipeline)
// exactly the way the controller shell will. Incident regressions encode
// against this.

import type { AcView, Command, MeterEvent, MeterState } from "./types.js";
import type { LevelingConfigV2 } from "./config.js";
import { ingestReading, initialMeterState, meterView, refillBucket, resetCalm } from "./sensing.js";
import {
  applyMeterEvent,
  clearFloorsIfDone,
  clearGridFullIfDone,
  deriveMode,
  initialModeState,
  noteBatch,
  type ModeState,
} from "./modes.js";
import { plan, type PlanOutput } from "./pipeline.js";
import {
  attemptedRecently,
  initialPacingState,
  noteAttempt,
  noteFailure,
  noteSuccess,
  reshedPenalized,
  resetPacing,
  type AttemptKind,
  type PacingState,
} from "./pacing.js";
import type { FanHolds } from "./fan-trim.js";
import type { CostBook } from "./costs.js";
import { restoreCostAmps, turnOnAmps } from "./costs.js";
import { ceilOf, floorOf } from "./needs.js";

export interface SimAcSetup {
  deviceId: string;
  name?: string;
  /** Steady draw when the cap binds, per level 1..max (hot-case ceilings). */
  capAmps: [number, number, number];
  /** Unconstrained compressor demand right now (cool room → below cap1). */
  demandAmps: number;
  needDelta: number;
  on?: boolean;
  /** Start already leveler-shed (off). */
  shed?: boolean;
  level?: number;
  fan?: number;
  minLevel?: number;
  rampSeconds?: number;
  /**
   * Startup transient: during the ramp the draw may exceed the cap by this
   * factor (Najat's measured 4–5.6A turn-on surge vs her 2.2A L1 cap).
   */
  surgeFactor?: number;
  /** Shadow confirm lag for level commands. */
  confirmDelayMs?: number;
  /** Firmware silently ignores these level commands (unreachable). */
  ignoreLevels?: number[];
}

interface SimAc {
  setup: Required<Pick<SimAcSetup, "deviceId" | "capAmps" | "rampSeconds" | "confirmDelayMs">> & SimAcSetup;
  on: boolean;
  shed: boolean;
  /** Firmware-applied level. */
  level: number;
  /** What the cloud shadow reports (lags firmware). */
  shadowLevel: number;
  shadowLevelAt: number;
  fan: number;
  turnedOnAt: number;
  demandAmps: number;
  needDelta: number;
  warmStartLevel: number | null;
  /** Open grid full-start window (pre-start house amps + expiry). */
  startBaseline: { amps: number; until: number } | null;
  /** House amps just before this compressor last started (ramp-debit anchor). */
  rampBaseline: number | null;
  /** Peak rise above `rampBaseline` seen since it armed (shell: rampAbsorbed). */
  rampAbsorbed: number;
}

const STEP_MS = 5_000;
/** Mirrors the controller shell's grid full-start window (AC_RAMP_MS). */
const GRID_START_MS = 240_000;

export class Scenario {
  now = 1_000_000_000;
  meterState: MeterState = initialMeterState();
  modeState: ModeState = initialModeState();
  pacing: PacingState = initialPacingState("none");
  fanHolds: FanHolds = {};
  book: CostBook;
  readonly plans: PlanOutput[] = [];
  readonly executed: Array<{ at: number; cmd: Command }> = [];
  readonly events: Array<{ at: number; event: MeterEvent }> = [];

  private acs: SimAc[];
  private nonAcAmps: number;
  private line: "grid" | "gen" | "none";
  private lineDead = false;
  private residualAmps: number;
  private noise = 0;
  private noiseFlip = 1;
  private espFrozen = false;
  private lastSentReading: { gridAmps: number; genAmps: number } | null = null;
  private pendingProjection: number | null = null;
  private attempts: Array<{ deviceId: string; kind: AttemptKind; at: number }> = [];

  constructor(
    public cfg: LevelingConfigV2,
    setups: SimAcSetup[],
    opts: {
      nonAcAmps?: number;
      source?: "grid" | "gen";
      book?: CostBook;
      residualAmps?: number;
      /** Keep the initial none→source transition (deploy/blackout cold start). */
      coldStart?: boolean;
    } = {},
  ) {
    this.book = opts.book ?? {};
    this.nonAcAmps = opts.nonAcAmps ?? 2;
    this.line = opts.source ?? "gen";
    this.residualAmps = opts.residualAmps ?? 4;
    if (!opts.coldStart) {
      // Prime the controller as already-settled on this source (most tests) —
      // otherwise the first reading is a none→gen cold start and FLOORS
      // re-levels everything before the test's premise.
      this.meterState = { ...this.meterState, source: this.line };
      this.pacing = initialPacingState(this.line);
    }
    this.acs = setups.map((s) => ({
      setup: { rampSeconds: 120, confirmDelayMs: 10_000, name: s.deviceId, ...s },
      on: s.shed ? false : (s.on ?? true),
      shed: s.shed ?? false,
      level: s.level ?? 1,
      shadowLevel: s.level ?? 1,
      shadowLevelAt: 0,
      fan: s.fan ?? 3,
      turnedOnAt: 0,
      demandAmps: s.demandAmps,
      needDelta: s.needDelta,
      warmStartLevel: null,
      startBaseline: null,
      rampBaseline: null,
      rampAbsorbed: 0,
    }));
  }

  /**
   * Shell parity for `rearmRamp`: every arming point snapshots the house load
   * measured BEFORE this compressor contributes, which is what the ramp debit
   * measures absorption against.
   */
  private startRamp(ac: SimAc): void {
    ac.turnedOnAt = this.now;
    const view = meterView(this.meterState, this.now);
    ac.rampBaseline = view.source !== "none" && view.sampleCount >= 2 ? view.smoothedAmps : null;
    ac.rampAbsorbed = 0;
  }

  /** Shell parity for `noteRampAbsorption` — ratchet each live ramp's peak rise. */
  private noteRampAbsorption(): void {
    const view = meterView(this.meterState, this.now);
    if (view.source === "none" || view.frozen || view.collapsed || view.sampleCount < 2) return;
    for (const ac of this.acs) {
      if (ac.rampBaseline == null || !this.isRamping(ac)) continue;
      ac.rampAbsorbed = Math.max(ac.rampAbsorbed, view.smoothedAmps - ac.rampBaseline);
    }
  }

  private isRamping(ac: SimAc): boolean {
    return ac.on && ac.turnedOnAt > 0 && this.now - ac.turnedOnAt < ac.setup.rampSeconds * 1000;
  }

  setNonAc(amps: number): void {
    this.nonAcAmps = amps;
  }

  // ---- environment / user actions ----

  setSource(line: "grid" | "gen" | "none"): void {
    this.line = line;
    this.lineDead = false;
    // Baselines are amps on the old source; the entry mode owns the transition.
    for (const ac of this.acs) ac.startBaseline = null;
    if (line === "gen" || line === "grid") {
      // A real changeover restarts every running compressor.
      for (const ac of this.acs) if (ac.on) this.startRamp(ac);
    }
  }

  /** Breaker trips: the AC circuits go dead, a small residual stays on the line. */
  trip(): void {
    this.lineDead = true;
  }

  /** Power returns after a trip: compressors restart at their firmware levels. */
  recoverLine(): void {
    this.lineDead = false;
    for (const ac of this.acs) if (ac.on) this.startRamp(ac);
  }

  setDemand(deviceId: string, demandAmps: number, needDelta?: number): void {
    const ac = this.sim(deviceId);
    ac.demandAmps = demandAmps;
    if (needDelta != null) ac.needDelta = needDelta;
  }

  /** Automation/user turn-on (arms the proactive projection like the shell will). */
  turnOn(deviceId: string, level = 1): void {
    const ac = this.sim(deviceId);
    ac.on = true;
    ac.shed = false;
    ac.level = level;
    ac.shadowLevel = level;
    this.startRamp(ac);
    const source = this.line === "none" ? "gen" : this.line;
    this.pendingProjection = turnOnAmps(this.book, this.cfg, deviceId, source, level, 3, this.now).amps;
    // Mirror the shell: on grid a turn-on opens a full-start window anchored on
    // the house load measured just before the compressor started.
    const view = meterView(this.meterState, this.now);
    if (this.line === "grid" && view.sampleCount >= 2) {
      ac.startBaseline = { amps: view.smoothedAmps, until: this.now + GRID_START_MS };
    }
  }

  /**
   * User/automation turns an AC OFF (frees budget) — a plain off, NOT a leveler
   * shed. Mirrors the shell: a managed off resets calm so the falling meter
   * settles before any raise spends the freed headroom.
   */
  turnOff(deviceId: string): void {
    const ac = this.sim(deviceId);
    ac.on = false;
    ac.shed = false;
    ac.startBaseline = null;
    ac.rampBaseline = null;
    ac.rampAbsorbed = 0;
    ac.turnedOnAt = 0;
    this.meterState = resetCalm(this.meterState);
  }

  /** Skip readings entirely (ESP offline / blackout) — devices keep their state. */
  blackout(seconds: number): void {
    this.now += seconds * 1000;
  }

  setNoise(amplitude: number): void {
    this.noise = amplitude;
  }

  /**
   * Hang the ESP: readings keep ARRIVING but repeat the last payload exactly
   * (the 2026-07-23 failure mode — the meter showed ~14.8A while reality moved).
   */
  freezeEsp(frozen: boolean): void {
    this.espFrozen = frozen;
    if (!frozen) this.lastSentReading = null;
  }

  // ---- introspection ----

  sim(deviceId: string): SimAc {
    const ac = this.acs.find((a) => a.setup.deviceId === deviceId);
    if (ac == null) throw new Error(`no sim AC ${deviceId}`);
    return ac;
  }

  commandsSince(at: number, kind?: Command["kind"]): Array<{ at: number; cmd: Command }> {
    return this.executed.filter((e) => e.at >= at && (kind == null || e.cmd.kind === kind));
  }

  /** Device IDs currently powered on, sorted (order-independent assertions). */
  acsOn(): string[] {
    return this.acs.filter((a) => a.on).map((a) => a.setup.deviceId).sort();
  }

  totalAmps(): number {
    return this.nonAcAmps + this.acs.reduce((sum, ac) => sum + this.drawOf(ac), 0);
  }

  // ---- simulation core ----

  private drawOf(ac: SimAc): number {
    if (!ac.on || this.lineDead) return 0;
    const cap = ac.level <= 0 ? Number.POSITIVE_INFINITY : ac.setup.capAmps[Math.min(ac.level, 3) - 1];
    const rampMs = ac.setup.rampSeconds * 1000;
    const sinceOn = this.now - ac.turnedOnAt;
    const ramping = ac.turnedOnAt > 0 && sinceOn < rampMs;
    // Startup transient may exceed the cap (surgeFactor > 1); steady state is capped.
    const effectiveCap = ramping ? cap * (ac.setup.surgeFactor ?? 1) : cap;
    const steady = Math.min(ac.demandAmps, effectiveCap);
    const rampFactor = ramping ? Math.max(0.2, sinceOn / rampMs) : 1;
    const fanExtra = ac.fan > 1 ? (ac.fan - 1) * 0.05 : 0;
    return steady * rampFactor + fanExtra;
  }

  private buildViews(): AcView[] {
    // Priority-sorted, like the controller shell will pass them (priority list
    // first, unknowns after in setup order).
    const rank = (id: string): number => {
      const i = this.cfg.priority.indexOf(id);
      return i === -1 ? this.cfg.priority.length : i;
    };
    const sorted = [...this.acs].sort(
      (a, b) => rank(a.setup.deviceId) - rank(b.setup.deviceId),
    );
    return sorted.map((ac) => {
      // Shadow lags firmware by confirmDelayMs.
      const observedLevel = this.now - ac.shadowLevelAt >= ac.setup.confirmDelayMs ? ac.level : ac.shadowLevel;
      return {
        deviceId: ac.setup.deviceId,
        name: ac.setup.name ?? ac.setup.deviceId,
        on: ac.on,
        managed: true,
        shed: ac.shed,
        maxLevel: 3,
        currentLevel: observedLevel,
        fanSpeed: ac.fan,
        fanExempt: false,
        needDelta: ac.needDelta,
        minLevel: ac.setup.minLevel ?? 1,
        manualCap: null,
        manualTarget: null,
        slotCap: null,
        reachableCap: null,
        warmStartLevel: ac.warmStartLevel,
        ramping: this.isRamping(ac),
        rampBaselineAmps: this.isRamping(ac) ? ac.rampBaseline : null,
        rampAbsorbedAmps: this.isRamping(ac) ? ac.rampAbsorbed : null,
        startBaselineAmps:
          ac.on && ac.startBaseline != null && ac.startBaseline.until > this.now
            ? ac.startBaseline.amps
            : null,
        reshedPenalized: reshedPenalized(this.pacing, ac.setup.deviceId, this.now),
      };
    });
  }

  private execute(out: PlanOutput): void {
    for (const cmd of out.commands) {
      this.executed.push({ at: this.now, cmd });
      const ac = this.sim(cmd.deviceId);
      switch (cmd.kind) {
        case "set_level":
          if (!(ac.setup.ignoreLevels ?? []).includes(cmd.level)) {
            ac.shadowLevel = ac.level; // shadow keeps the OLD level until confirm lag passes
            ac.level = cmd.level;
            ac.shadowLevelAt = this.now;
          }
          break;
        case "power_off":
          ac.on = false;
          ac.shed = true;
          ac.warmStartLevel = null;
          ac.startBaseline = null;
          break;
        case "power_on":
          ac.on = true;
          ac.shed = false;
          ac.level = cmd.level;
          ac.shadowLevel = cmd.level;
          ac.shadowLevelAt = 0;
          this.startRamp(ac);
          // Gentle restore pins the fan; the hold itself rides in out.fanHolds
          // (recorded by the pipeline, assigned in step()).
          if (cmd.fan != null) ac.fan = cmd.fan;
          // Shell parity: the controller sees this AC flip off→on on the NEXT
          // tick, adds it to `freshlyOn` and arms the proactive projection —
          // exactly like an automation turn-on. Without this the harness could
          // not reproduce the 2026-07-24/25 restore-bounce storm, where the
          // projection re-priced a just-admitted restore and declared it over.
          // A restore that pinned the fan is projected at the same gentle cost
          // it was admitted at (shell: fanHolds[id].gentle).
          this.pendingProjection = restoreCostAmps(
            this.book,
            this.cfg,
            cmd.deviceId,
            this.line === "none" ? "gen" : this.line,
            cmd.level,
            3,
            this.now,
            { gentle: cmd.fan != null },
          ).amps;
          break;
        case "set_fan":
          ac.fan = cmd.fan;
          break;
      }
    }
  }

  /** One 5s step: reading → sensing → modes → plan → execute → bookkeeping. */
  step(): PlanOutput {
    this.now += STEP_MS;
    const total = this.lineDead ? Math.min(this.nonAcAmps, this.residualAmps) : this.totalAmps();
    this.noiseFlip = -this.noiseFlip;
    // A live CT always micro-jitters (±0.005 here) — without it every steady
    // sim would read as a frozen sensor to the sensing reducer.
    const measured = Math.max(0, total + (this.noise + 0.005) * this.noiseFlip);
    const live =
      this.line === "grid"
        ? { gridAmps: measured, genAmps: 0 }
        : this.line === "gen"
          ? { gridAmps: 0, genAmps: measured }
          : { gridAmps: 0, genAmps: 0 };
    // A hung ESP repeats its last payload exactly, whatever reality does.
    const reading = this.espFrozen && this.lastSentReading != null ? this.lastSentReading : live;
    this.lastSentReading = reading;

    const { state, events } = ingestReading(this.meterState, reading, this.cfg, this.now);
    this.meterState = state;
    for (const event of events) {
      this.events.push({ at: this.now, event });
      this.modeState = applyMeterEvent(this.modeState, event, this.now);
      if (event.kind === "source_changed") this.pacing = resetPacing(this.pacing, event.to);
    }
    this.noteRampAbsorption();

    // FLOORS / GRID_FULL exit checks against confirmed shadows + ramps.
    const views = this.buildViews();
    const onManaged = views.filter((v) => v.on && v.managed && !v.shed);
    this.modeState = clearFloorsIfDone(this.modeState, {
      allConfirmedAtFloor: onManaged.every((v) => v.currentLevel > 0 && v.currentLevel <= floorOf(v)),
      anyRamping: onManaged.some((v) => v.ramping),
    });
    this.modeState = clearGridFullIfDone(this.modeState, {
      allConfirmedAtCeil: onManaged.every(
        (v) => v.currentLevel > 0 && v.currentLevel >= ceilOf(v, this.cfg.nearTargetBandC),
      ),
      anyShedPending: views.some((v) => v.managed && v.shed && !v.on),
    });
    this.modeState = { ...this.modeState, collapsed: this.meterState.collapse != null };

    const mode = deriveMode(this.modeState, this.now);
    const out = plan({
      now: this.now,
      config: this.cfg,
      mode,
      meter: meterView(this.meterState, this.now),
      acs: views,
      book: this.book,
      pacing: this.pacing,
      fanHolds: this.fanHolds,
      projectedExtraAmps: this.pendingProjection ?? undefined,
    });
    this.pendingProjection = null;
    this.plans.push(out);
    this.fanHolds = out.fanHolds;

    if (out.commands.length > 0) {
      this.execute(out);
      this.modeState = noteBatch(this.modeState, { fanOnly: out.fanOnly }, this.now);
      if (!out.fanOnly) this.meterState = resetCalm(this.meterState);
      // Shell parity: a turn-on invalidates banked over-limit readings.
      if (out.commands.some((c) => c.kind === "power_on")) {
        this.meterState = refillBucket(this.meterState);
      }
      if (out.reason.startsWith("over")) {
        this.meterState = refillBucket(this.meterState);
        // The reducer's judgment beats the entry policy (shell parity).
        for (const ac of this.acs) ac.startBaseline = null;
      }
      // Failure attribution: a reduction that undoes a recent raise/restore is
      // that attempt's failure (the bounce, hybrid-backoff side).
      for (const cmd of out.commands) {
        if (cmd.kind === "set_level" || cmd.kind === "power_off") {
          for (const kind of ["raise", "restore"] as const) {
            if (out.reason.startsWith("over") && attemptedRecently(this.pacing, cmd.deviceId, kind, this.now)) {
              this.pacing = noteFailure(this.pacing, cmd.deviceId, kind, this.now);
              // A failed attempt must not be graded a success later.
              this.attempts = this.attempts.filter(
                (a) => !(a.deviceId === cmd.deviceId && a.kind === kind),
              );
            }
          }
        }
      }
    }
    for (const attempt of out.attempts) {
      this.pacing = noteAttempt(this.pacing, attempt.deviceId, attempt.kind, this.now);
      this.attempts.push({ ...attempt, at: this.now });
    }
    // Grade quiet attempts as successes once their blame window passes.
    this.attempts = this.attempts.filter((attempt) => {
      if (this.now - attempt.at > 300_000) {
        this.pacing = noteSuccess(this.pacing, attempt.deviceId, attempt.kind);
        return false;
      }
      return true;
    });
    return out;
  }

  advance(seconds: number): void {
    const steps = Math.round((seconds * 1000) / STEP_MS);
    for (let i = 0; i < steps; i++) this.step();
  }
}
