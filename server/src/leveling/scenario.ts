// Replay/scenario harness for leveling v2 (test helper — not shipped code).
// Simulates the household physics the controller lives in: per-AC compressor
// demand vs cap, turn-on ramps, shadow confirm lag, breaker trips, blackouts,
// changeovers — and drives the PURE modules (sensing → modes → pipeline)
// exactly the way the controller shell will. Incident regressions encode
// against this.

import type { AcView, Command, MeterEvent, MeterState } from "./types.js";
import type { LevelingConfigV2 } from "./config.js";
import {
  ingestReading,
  initialMeterState,
  meterView,
  noteCommandedCut,
  OVER_LIMIT_BUDGET_AFTER_ACT,
  refillBucket,
  resetCalm,
} from "./sensing.js";
import {
  applyMeterEvent,
  clearFloorsIfDone,
  clearGridFullIfDone,
  deriveMode,
  initialModeState,
  noteBatch,
  type ModeState,
} from "./modes.js";
import { GRADE_TURN_ON_MS, plan, type PlanOutput } from "./pipeline.js";
import {
  attemptedRecently,
  attemptedWithin,
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
import { fanTrimSavings, raiseJumpAmps, restoreCostAmps, turnOnAmps } from "./costs.js";
import { ceilOf, floorOf, SUBFLOOR_PROGRESS_C, worstCaseLevel } from "./needs.js";
import { DEMOTE_HYSTERESIS_C } from "./demote.js";
import {
  EXTERNAL_ON_VOID_MS,
  HOUSE_SAMPLE_COOLDOWN_MS,
  houseLoadAmps,
  initialHouseLoad,
  sampleHouseLoad,
  voidSamples,
  type HouseLoadState,
} from "./house-load.js";

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
  /**
   * How long the compressor keeps drawing after a `power_off` is SENT. The
   * cloud round-trip means an off lands anywhere from ~6 s to minutes later
   * (docs/agent/tcl-ac.md), so a shed's whole draw leaves the meter as one
   * cliff well after the batch — the shape that used to be read as a breaker
   * trip. Defaults to 0 (instant) so existing scenarios are unchanged.
   */
  offLagMs?: number;
  /** Firmware silently ignores these level commands (unreachable). */
  ignoreLevels?: number[];
}

interface SimAc {
  setup: Required<Pick<SimAcSetup, "deviceId" | "capAmps" | "rampSeconds" | "confirmDelayMs">> & SimAcSetup;
  /**
   * What the cloud SHADOW reports — this is the only power state the planner
   * ever sees (`AcView.on`). For every controller-driven path it flips together
   * with `physicalOn`; `externalTurnOn` is what pulls them apart.
   */
  on: boolean;
  /**
   * The real compressor state, which is what the METER sees. A room can be
   * physically drawing while the shadow still says off (Najat's firmware
   * confirms 5.8 s–13 min after the fact) — the window that books the room's
   * whole draw as phantom "house" load.
   */
  physicalOn: boolean;
  /** Shadow catches up with `physicalOn` at this timestamp (null = in sync). */
  pendingShadowOn: number | null;
  shed: boolean;
  /** Firmware-applied level. */
  level: number;
  /** What the cloud shadow reports (lags firmware). */
  shadowLevel: number;
  shadowLevelAt: number;
  /**
   * Levels commanded whose confirm we have not seen — the harness mirror of the
   * reconciler's `sendCounts`, used to price the physics envelope at worst case.
   * Cleared wholesale on any confirm / off / on / source change, exactly like
   * the real reconciler.
   */
  sentLevels: number[];
  /** When the most recent level command was sent (demote resend spacing). */
  lastLevelSentAt: number;
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
  /** Compressor still spinning down after an off was sent (0 = already stopped). */
  drawingUntil: number;
  /** Shell parity: a level RAISE's committed-but-unmetered amps (gen only). */
  jumpDebit: { amps: number; baseline: number | null; absorbed: number; until: number } | null;
  /** Shell parity: the same accounting for a fan RESTORE's un-metered amps. */
  fanDebit: { amps: number; baseline: number | null; absorbed: number; until: number } | null;
  /** User-pinned level (manual wins over every automation ceiling). */
  manualTarget: number | null;
}

const STEP_MS = 5_000;
/** Mirrors the controller shell's grid full-start window (AC_RAMP_MS). */
const GRID_START_MS = 240_000;
/** Mirrors the controller shell's FAN_DEBIT_MS. */
const FAN_DEBIT_MS = 60_000;
/** Mirrors the controller shell's FUNDING_COOLDOWN_MS. */
const FUNDING_COOLDOWN_MS = 120_000;
/** Mirrors the controller shell's VICTIM_COOLDOWN_MS. */
const VICTIM_COOLDOWN_MS = 120_000;

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
  /** Shell parity: when each room's uninterrupted satisfied stretch began. */
  private satisfiedSince = new Map<string, number>();
  private subFloorSince = new Map<string, { at: number; need: number }>();
  /** Shell parity: the MEASURED non-AC split (never the sim's ground truth). */
  private houseLoad: HouseLoadState = initialHouseLoad();
  /** Mirror of the shell's boot quiet (`firstTickAt`). */
  private firstStepAt: number | null = null;
  private nonAcAmps: number;
  private line: "grid" | "gen" | "none";
  private lineDead = false;
  private residualAmps: number;
  private noise = 0;
  private noiseFlip = 1;
  private flicker: { baseAmps: number; spikeAmps: number; spikeEveryN: number } | null = null;
  private flickerTick = 0;
  /**
   * Seeded LCG. Deterministic on purpose — `Math.random()`/`Date.now()` would
   * make a failing scenario unreproducible, and the sim is the only evidence a
   * flicker rule works.
   */
  private rngState: number;
  private espFrozen = false;
  private lastSentReading: { gridAmps: number; genAmps: number } | null = null;
  /** Devices the controller shell would have in `freshlyOn` on the next tick. */
  private freshlyOn: string[] = [];
  /** Shell parity: rooms on whose shadow has not confirmed (house sampling off). */
  private pendingOn = new Map<string, number>();
  /** Shell parity: rooms that funded a peer's raise → when they were demoted. */
  private fundingDemotedAt = new Map<string, number>();
  /** Shell parity: rooms the reducer cut → when (they may not climb straight back). */
  private reducedAt = new Map<string, number>();
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
      /** Seed for the flicker PRNG — same seed ⇒ same meter trace, always. */
      seed?: number;
    } = {},
  ) {
    this.book = opts.book ?? {};
    this.nonAcAmps = opts.nonAcAmps ?? 2;
    this.line = opts.source ?? "gen";
    this.residualAmps = opts.residualAmps ?? 4;
    this.rngState = (opts.seed ?? 0x9e3779b9) >>> 0;
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
      physicalOn: s.shed ? false : (s.on ?? true),
      pendingShadowOn: null,
      shed: s.shed ?? false,
      level: s.level ?? 1,
      shadowLevel: s.level ?? 1,
      shadowLevelAt: 0,
      sentLevels: [],
      lastLevelSentAt: 0,
      fan: s.fan ?? 3,
      turnedOnAt: 0,
      demandAmps: s.demandAmps,
      needDelta: s.needDelta,
      warmStartLevel: null,
      startBaseline: null,
      rampBaseline: null,
      rampAbsorbed: 0,
      drawingUntil: 0,
      jumpDebit: null,
      fanDebit: null,
      manualTarget: null,
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
      for (const key of ["jumpDebit", "fanDebit"] as const) {
        const debit = ac[key];
        if (debit == null) continue;
        if (debit.until <= this.now) ac[key] = null;
        else if (debit.baseline != null) {
          debit.absorbed = Math.max(debit.absorbed, view.smoothedAmps - debit.baseline);
        }
      }
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
    for (const ac of this.acs) {
      ac.startBaseline = null;
      // `sentLevels` deliberately SURVIVES — mirrors clearOnSourceChange, which
      // keeps unconfirmed sends so a level already on its way to the firmware
      // is still clamped and still priced after a changeover.
    }
    if (line === "gen" || line === "grid") {
      // A real changeover restarts every running compressor.
      for (const ac of this.acs) if (ac.physicalOn) this.startRamp(ac);
    }
  }

  /** Breaker trips: the AC circuits go dead, a small residual stays on the line. */
  trip(): void {
    this.lineDead = true;
  }

  /** Power returns after a trip: compressors restart at their firmware levels. */
  recoverLine(): void {
    this.lineDead = false;
    for (const ac of this.acs) if (ac.physicalOn) this.startRamp(ac);
  }

  /** The user pins a level from the dashboard — manual beats every need cap. */
  pinLevel(deviceId: string, level: number | null): void {
    this.sim(deviceId).manualTarget = level;
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
    ac.physicalOn = true;
    ac.pendingShadowOn = null;
    ac.shed = false;
    ac.level = level;
    ac.shadowLevel = level;
    this.startRamp(ac);
    this.freshlyOn.push(deviceId);
    // Mirror the shell: a turn-on opens a start window on EITHER source,
    // anchored on the house load measured just before the compressor started.
    // Grid uses it to lift to the ceiling, gen to clamp down to the floor.
    const view = meterView(this.meterState, this.now);
    if (this.line !== "none" && view.sampleCount >= 2) {
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
    // Mirrors the shell's `creditRoomOff`: an off by any hand but the reducer's
    // is priced off the meter, because the fall it causes is collapse-SHAPED
    // and the relative collapse floor would otherwise read it as a trip.
    if (this.line !== "none" && ac.on && !ac.shed) {
      const draw = this.drawOf(ac);
      if (draw > 0) this.meterState = noteCommandedCut(this.meterState, draw, this.now);
    }
    ac.on = false;
    ac.physicalOn = false;
    ac.pendingShadowOn = null;
    ac.shed = false;
    ac.startBaseline = null;
    ac.rampBaseline = null;
    ac.rampAbsorbed = 0;
    ac.turnedOnAt = 0;
    this.pendingOn.delete(deviceId);
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
   * Generator flicker: the shape `setNoise` cannot make. That one alternates
   * ±amplitude every reading, so a 4-wide median lands exactly on the truth
   * every time — pathologically well-behaved, and useless for testing a rule
   * about spikes. Real gen flicker is asymmetric and bursty: a mostly-quiet
   * line with occasional single readings a full amp high, which is what drains
   * the leaky bucket and breaks calm while the MEAN sits comfortably under the
   * limit (live 2026-08-02).
   */
  setFlicker(opts: { baseAmps: number; spikeAmps: number; spikeEveryN?: number }): void {
    this.flicker = { spikeEveryN: 3, ...opts };
  }

  /** Deterministic LCG in [0, 1). */
  private nextRandom(): number {
    this.rngState = (Math.imul(this.rngState, 1664525) + 1013904223) >>> 0;
    return this.rngState / 4294967296;
  }

  /**
   * A household member turns an AC on at the wall or by remote: the compressor
   * draws IMMEDIATELY while the cloud shadow the controller reads lags behind
   * (5.8 s–13 min observed on Najat's firmware). In between, the shell models a
   * room that is off while the meter carries its draw — the window that books
   * that draw as phantom "house" load. `turnOn()` keeps its zero-lag behaviour.
   */
  externalTurnOn(deviceId: string, shadowLagMs: number, level = 1): void {
    const ac = this.sim(deviceId);
    ac.physicalOn = true;
    ac.shed = false;
    ac.level = level;
    ac.shadowLevel = level;
    ac.shadowLevelAt = 0;
    ac.sentLevels = [];
    ac.drawingUntil = 0;
    this.startRamp(ac);
    ac.pendingShadowOn = this.now + shadowLagMs;
    // The shell only learns of this at the shadow flip, so it has no `since`
    // anchor — mirror that by leaving `pendingOn` unset (the void then uses the
    // whole window). Sampling still stands down because the room is ramping.
  }

  /**
   * Shell parity: the controller only learns of an external turn-on when the
   * shadow flips (its structural off→on scan), and everything it does about it
   * — freshlyOn, the start window — happens on that tick, not when the
   * compressor actually started.
   */
  private applyPendingShadowFlips(): void {
    for (const ac of this.acs) {
      if (ac.pendingShadowOn == null || this.now < ac.pendingShadowOn) continue;
      ac.pendingShadowOn = null;
      ac.on = true;
      this.freshlyOn.push(ac.setup.deviceId);
      const view = meterView(this.meterState, this.now);
      if (this.line !== "none" && view.sampleCount >= 2) {
        ac.startBaseline = { amps: view.smoothedAmps, until: this.now + GRID_START_MS };
      }
      // Shell parity (controller.voidPhantomHouse): everything sampled while
      // this room was drawing-but-modeled-off counted its compressor as house.
      const sentAt = this.pendingOn.get(ac.setup.deviceId);
      this.pendingOn.delete(ac.setup.deviceId);
      if (this.line !== "none") {
        this.houseLoad = voidSamples(this.houseLoad, this.line, {
          excludeDeviceId: ac.setup.deviceId,
          since: sentAt ?? this.now - EXTERNAL_ON_VOID_MS,
        });
      }
    }
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
    if (this.lineDead) return 0;
    // The METER follows the compressor, never the shadow: a physically-on room
    // costs amps while the cloud still reports it off.
    // An off that has been sent but not yet delivered still costs amps — the
    // draw holds at its last steady value until the compressor really stops.
    if (!ac.physicalOn) return this.now < ac.drawingUntil ? this.lastSteadyDraw(ac) : 0;
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

  /** Steady (post-ramp) draw of an AC whose off is still in flight. */
  private lastSteadyDraw(ac: SimAc): number {
    const cap = ac.level <= 0 ? Number.POSITIVE_INFINITY : ac.setup.capAmps[Math.min(ac.level, 3) - 1];
    const fanExtra = ac.fan > 1 ? (ac.fan - 1) * 0.05 : 0;
    return Math.min(ac.demandAmps, cap) + fanExtra;
  }

  /** Shell parity for the demote dwell clock (controller.satisfiedForMs). */
  private trackSatisfied(ac: SimAc): void {
    const satisfied =
      ac.on && !ac.shed && ac.needDelta <= this.cfg.nearTargetBandC - DEMOTE_HYSTERESIS_C;
    if (!satisfied) this.satisfiedSince.delete(ac.setup.deviceId);
    else if (!this.satisfiedSince.has(ac.setup.deviceId)) this.satisfiedSince.set(ac.setup.deviceId, this.now);
  }

  private satisfiedForMs(ac: SimAc): number {
    const since = this.satisfiedSince.get(ac.setup.deviceId);
    return since == null ? 0 : this.now - since;
  }

  /** Shell parity for the sub-floor watch (controller.subFloorStalledMs). */
  private trackSubFloor(ac: SimAc, observedLevel: number): void {
    const floor = ac.setup.minLevel ?? 1;
    const belowFloor = ac.on && !ac.shed && observedLevel >= 1 && observedLevel < floor;
    const seen = this.subFloorSince.get(ac.setup.deviceId);
    if (!belowFloor) this.subFloorSince.delete(ac.setup.deviceId);
    else if (seen == null || ac.needDelta <= seen.need - SUBFLOOR_PROGRESS_C) {
      this.subFloorSince.set(ac.setup.deviceId, { at: this.now, need: ac.needDelta });
    }
  }

  private subFloorStalledMs(ac: SimAc): number {
    const seen = this.subFloorSince.get(ac.setup.deviceId);
    return seen == null ? 0 : this.now - seen.at;
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
      // Any confirm clears every unconfirmed send (reconciler parity).
      if (ac.sentLevels.includes(observedLevel)) ac.sentLevels = [];
      this.trackSatisfied(ac);
      this.trackSubFloor(ac, observedLevel);
      return {
        deviceId: ac.setup.deviceId,
        name: ac.setup.name ?? ac.setup.deviceId,
        on: ac.on,
        managed: true,
        shed: ac.shed,
        maxLevel: 3,
        currentLevel: observedLevel,
        envelopeLevel: worstCaseLevel([observedLevel, ...ac.sentLevels]),
        fanSpeed: ac.fan,
        fanExempt: false,
        needDelta: ac.needDelta,
        satisfiedForMs: this.satisfiedForMs(ac),
        subFloorStalledMs: this.subFloorStalledMs(ac),
        minLevel: ac.setup.minLevel ?? 1,
        manualCap: null,
        manualTarget: ac.manualTarget,
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
        // Additive across both debit kinds — shell parity with unmeteredJumpAmps().
        unmeteredJumpAmps: [ac.jumpDebit, ac.fanDebit].reduce(
          (sum, d) => sum + (d != null && d.until > this.now ? Math.max(0, d.amps - d.absorbed) : 0),
          0,
        ),
        reshedPenalized: reshedPenalized(this.pacing, ac.setup.deviceId, this.now),
      };
    });
  }

  /**
   * Shell parity (controller.ts): the committed-but-unmetered draw of ACs that
   * are inside their start window AND still ramping, ratcheted down as the
   * meter absorbs it. A room WE restored is priced at the floor we commanded
   * (gentle flag included) so the projection matches its admission; a
   * user/automation turn-on is priced at the level the firmware came back at.
   */
  private projectedExtraAmps(views: AcView[]): number | undefined {
    if (this.line === "none") return undefined;
    const source = this.line;
    const view = meterView(this.meterState, this.now);
    const starting = views.filter(
      (v) =>
        v.on &&
        v.managed &&
        !v.shed &&
        v.ramping &&
        (v.startBaselineAmps != null || this.freshlyOn.includes(v.deviceId)),
    );
    if (starting.length === 0) return undefined;
    return starting.reduce((sum, v) => {
      const ours = attemptedWithin(this.pacing, v.deviceId, "restore", GRADE_TURN_ON_MS, this.now);
      const committed = ours
        ? restoreCostAmps(this.book, this.cfg, v.deviceId, source, floorOf(v), v.maxLevel, this.now, {
            gentle: this.fanHolds[v.deviceId]?.gentle === true,
          }).amps
        : turnOnAmps(this.book, this.cfg, v.deviceId, source, v.envelopeLevel, v.maxLevel, this.now).amps;
      const absorbed =
        v.rampBaselineAmps == null
          ? 0
          : Math.max(0, view.smoothedAmps - v.rampBaselineAmps, v.rampAbsorbedAmps ?? 0);
      return sum + Math.max(0, committed - absorbed);
    }, 0);
  }

  private execute(out: PlanOutput): void {
    for (const cmd of out.commands) {
      this.executed.push({ at: this.now, cmd });
      const ac = this.sim(cmd.deviceId);
      switch (cmd.kind) {
        case "set_level":
          // Sent is sent — the envelope must charge for it even when the
          // firmware ignores the level (that is precisely when it is unsafe to
          // assume the device is where the shadow says).
          ac.sentLevels.push(cmd.level);
          ac.lastLevelSentAt = this.now;
          if (this.line === "gen" && cmd.level > ac.shadowLevel && ac.shadowLevel >= 1) {
            const view = meterView(this.meterState, this.now);
            ac.jumpDebit = {
              amps: raiseJumpAmps(this.book, this.cfg, ac.setup.deviceId, "gen", ac.shadowLevel, cmd.level, 3, this.now).amps,
              baseline: view.sampleCount >= 2 && !view.frozen ? view.smoothedAmps : null,
              absorbed: 0,
              until: this.now + 240_000,
            };
          } else {
            ac.jumpDebit = null;
          }
          if (!(ac.setup.ignoreLevels ?? []).includes(cmd.level)) {
            ac.shadowLevel = ac.level; // shadow keeps the OLD level until confirm lag passes
            ac.level = cmd.level;
            ac.shadowLevelAt = this.now;
          }
          break;
        case "power_off":
          ac.on = false;
          ac.physicalOn = false;
          ac.pendingShadowOn = null;
          ac.shed = true;
          ac.sentLevels = [];
          ac.warmStartLevel = null;
          ac.startBaseline = null;
          // The controller's model of the device flips now; the physical
          // compressor keeps drawing until the cloud actually delivers the off.
          ac.drawingUntil = this.now + (ac.setup.offLagMs ?? 0);
          this.pendingOn.delete(cmd.deviceId);
          break;
        case "power_on":
          // Shell parity (executeAndJournal): the compressor starts now and the
          // shadow confirms later, so house sampling stands down until it does.
          // The shell forges its power cache on the same line, which makes its
          // own structural flip fire on the very next tick — so this entry is a
          // ONE-TICK stand-down, exactly as it is in production. (That is a
          // finding, not a design: invariant 28's protection is real for
          // external ONs and near-vestigial for our own restores.)
          this.pendingOn.set(cmd.deviceId, this.now);
          ac.on = true;
          ac.physicalOn = true;
          ac.pendingShadowOn = null;
          ac.shed = false;
          ac.level = cmd.level;
          ac.shadowLevel = cmd.level;
          ac.shadowLevelAt = 0;
          ac.sentLevels = [];
          ac.drawingUntil = 0;
          this.startRamp(ac);
          // Gentle restore pins the fan; the hold itself rides in out.fanHolds
          // (recorded by the pipeline, assigned in step()).
          if (cmd.fan != null) ac.fan = cmd.fan;
          // Shell parity: the controller sees this AC flip off→on on the NEXT
          // tick, adds it to `freshlyOn` and opens its start window — exactly
          // like an automation turn-on. Without this the harness could not
          // reproduce the 2026-07-24/25 restore-bounce storm, where the
          // projection re-priced a just-admitted restore and declared it over.
          // `projectedExtraAmps()` is what decides the price; a restore is
          // recognised there by its pacing attempt and re-priced at exactly
          // what admission charged.
          this.freshlyOn.push(cmd.deviceId);
          if (this.line !== "none") {
            const onView = meterView(this.meterState, this.now);
            if (onView.sampleCount >= 2) {
              ac.startBaseline = { amps: onView.smoothedAmps, until: this.now + GRID_START_MS };
            }
          }
          break;
        case "set_fan": {
          // Shell parity (executeAndJournal): a fan RESTORE spends, so it is
          // charged as committed-but-unmetered and rewinds calm. A fan CUT
          // frees amps and does neither.
          if (cmd.reason === "trim_restore" && this.line === "gen") {
            const view = meterView(this.meterState, this.now);
            const steps = cmd.fan === 0 ? 6 : cmd.fan - ac.fan;
            ac.fanDebit =
              steps > 0
                ? {
                    amps: fanTrimSavings(this.book, ac.setup.deviceId, "gen", steps, this.now),
                    baseline: view.sampleCount >= 2 && !view.frozen ? view.smoothedAmps : null,
                    absorbed: 0,
                    until: this.now + FAN_DEBIT_MS,
                  }
                : null;
          }
          ac.fan = cmd.fan;
          break;
        }
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
    const measured = Math.max(
      0,
      total +
        (this.flicker != null
          ? // Mostly-quiet line, with a periodic reading a full amp high. The
            // spike CADENCE is deterministic and only its amplitude varies:
            // supply ripple recurs, it does not arrive in random bursts — and a
            // random one clusters, where three spikes inside one 4-wide median
            // window genuinely lift the SMOOTHED meter over the limit. That is
            // a real excursion the controller should answer, not the
            // single-reading supply noise this is here to model.
            (this.nextRandom() * 2 - 1) * this.flicker.baseAmps +
            (this.flickerTick++ % Math.max(1, this.flicker.spikeEveryN) === 0
              ? this.flicker.spikeAmps * (0.8 + 0.4 * this.nextRandom())
              : 0) +
            0.005 * this.noiseFlip
          : (this.noise + 0.005) * this.noiseFlip),
    );
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
    // Shell parity: the structural off→on scan runs at tick start, so an
    // external turn-on is discovered when its SHADOW flips, not when the
    // compressor started.
    this.applyPendingShadowFlips();
    // …and our OWN restores clear on the next tick, when the shell's structural
    // scan would see the (forged) off→on flip.
    for (const [deviceId, sentAt] of this.pendingOn) {
      const ac = this.acs.find((a) => a.setup.deviceId === deviceId);
      if (ac != null && ac.on && ac.pendingShadowOn == null && sentAt < this.now) {
        this.pendingOn.delete(deviceId);
      }
    }

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
    const view = meterView(this.meterState, this.now);
    // Shell parity (controller.tick): the planner does NOT get told `nonAcAmps`
    // — it must MEASURE the split off the simulated meter exactly the way the
    // shell does. Handing it the sim's ground truth would be the scenario.ts
    // mirror bug all over again (2026-07-30, bug 14): the harness would price a
    // house the shell cannot see, and no harness test could ever disagree.
    // Mirror of the shell's boot quiet: no sampling for the first cooldown.
    if (this.firstStepAt == null) this.firstStepAt = this.now;
    // Shell parity: no house sampling while any ON is unconfirmed — the room
    // draws before the shadow says so, and the residual would book it as house.
    if (
      view.source !== "none" &&
      view.sampleCount >= 2 &&
      !view.frozen &&
      this.pendingOn.size === 0 &&
      this.now - this.firstStepAt >= HOUSE_SAMPLE_COOLDOWN_MS
    ) {
      this.houseLoad = sampleHouseLoad(this.houseLoad, {
        source: view.source,
        at: this.now,
        smoothedAmps: view.smoothedAmps,
        acs: views,
        config: this.cfg,
      });
    }
    const out = plan({
      now: this.now,
      config: this.cfg,
      mode,
      meter: view,
      acs: views,
      book: this.book,
      pacing: this.pacing,
      fanHolds: this.fanHolds,
      projectedExtraAmps: this.projectedExtraAmps(views),
      nonAcAmps: houseLoadAmps(this.houseLoad, view.source, this.now, views),
      inFlight: (deviceId) => {
        const ac = this.acs.find((a) => a.setup.deviceId === deviceId);
        return ac == null ? [] : ac.sentLevels.map((level) => ({ level, sentAt: ac.lastLevelSentAt }));
      },
      // Shell parity: a room that funded a peer's raise may not take the level
      // back before the saving reaches the meter.
      fundingCooldown: (deviceId) => {
        const at = this.fundingDemotedAt.get(deviceId);
        return at != null && this.now - at < FUNDING_COOLDOWN_MS;
      },
      // …and a room the reducer cut may not climb back into the overload
      // before its own cut has reached the meter.
      victimCooldown: (deviceId) => {
        const at = this.reducedAt.get(deviceId);
        return at != null && this.now - at < VICTIM_COOLDOWN_MS;
      },
    });
    this.freshlyOn = [];
    this.plans.push(out);
    this.fanHolds = out.fanHolds;

    if (out.commands.length > 0) {
      // Shell parity: stamp the funding donors before executing, from the same
      // command list that ships.
      for (const deviceId of out.fundingDonors ?? []) {
        if (out.commands.some((c) => c.deviceId === deviceId && c.kind === "set_level")) {
          this.fundingDemotedAt.set(deviceId, this.now);
        }
      }
      for (const deviceId of out.reductionVictims ?? []) {
        if (out.commands.some((c) => c.deviceId === deviceId && c.kind === "set_level")) {
          this.reducedAt.set(deviceId, this.now);
        }
      }
      this.execute(out);
      this.modeState = noteBatch(this.modeState, { fanOnly: out.fanOnly }, this.now);
      // Shell parity: a fan-only batch that SPENT (restore) still rewinds calm.
      const spentOnFan = out.commands.some((c) => c.kind === "set_fan" && c.reason === "trim_restore");
      if (!out.fanOnly || spentOnFan) this.meterState = resetCalm(this.meterState);
      // Shell parity: credit the meter with what this batch took off the line,
      // so a shed's late arrival is not read as a breaker trip. `commandedCutAmps`
      // is the single credit path (invariant 11) — `expectedDeltaAmps` is only
      // set by reduce batches and silently missed demotes, funding swaps, and
      // the gen start clamp.
      if (out.commandedCutAmps > 0) {
        this.meterState = noteCommandedCut(this.meterState, out.commandedCutAmps, this.now);
      }
      // Shell parity: a turn-on invalidates banked over-limit readings.
      if (out.commands.some((c) => c.kind === "power_on")) {
        this.meterState = refillBucket(this.meterState);
      }
      if (out.reason.startsWith("over")) {
        // Shell parity: PARTIAL after an over-limit act, so an under-sized
        // reduction can escalate in seconds rather than another five readings.
        this.meterState = refillBucket(this.meterState, OVER_LIMIT_BUDGET_AFTER_ACT);
        // The reducer's judgment beats the entry policy — GRID only (shell
        // parity): gen's start policy is a floor clamp, which can only agree
        // with the reducer, and a gen turn-on is over-limit by definition.
        if (this.line === "grid") for (const ac of this.acs) ac.startBaseline = null;
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
      this.pacing = noteAttempt(this.pacing, attempt.deviceId, attempt.kind, this.now, attempt.meterAmps);
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
