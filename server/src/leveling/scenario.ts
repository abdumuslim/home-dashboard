// Replay/scenario harness for leveling v2 (test helper — not shipped code).
// Simulates the household physics the controller lives in: per-AC compressor
// demand vs cap, turn-on ramps, shadow confirm lag, breaker trips, blackouts,
// changeovers — and drives the PURE modules (sensing → modes → pipeline)
// exactly the way the controller shell will. Incident regressions encode
// against this.

import type { AcView, Command, MeterEvent, MeterState } from "./types.js";
import type { LevelingConfigV2 } from "./config.js";
import {
  clearCollapse,
  ingestReading,
  initialMeterState,
  latchCollapse,
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
  clearSettleIfDone,
  deriveMode,
  FLOORS_MAX_MS,
  initialModeState,
  noteBatch,
  type ModeState,
} from "./modes.js";
import { GRADE_TURN_ON_MS, plan, type PlanOutput } from "./pipeline.js";
import {
  ATTEMPT_BLAME_WINDOW_MS,
  attemptedRecently,
  attemptedWithin,
  barPersistMs,
  clearBounces,
  initialPacingState,
  noteAttempt,
  noteFailure,
  noteSuccess,
  reshedPenalized,
  resetPacing,
  restoreBounces,
  type AttemptKind,
  type PacingState,
} from "./pacing.js";
import type { FanHolds } from "./fan-trim.js";
import type { CostBook } from "./costs.js";
import { fanTrimSavings, raiseJumpAmps, restoreCostAmps, turnOnAmps } from "./costs.js";
import { ceilOf, floorOf, nextSubFloorWatch, type SubFloorWatch, worstCaseLevel } from "./needs.js";
import { DEMOTE_HYSTERESIS_C } from "./demote.js";
import { absorbedSharesAmps, EXTERNAL_ON_DONOR_SHIELD_MS, rampDebitAmps, SWAP_QUIET_AFTER_OVER_MS } from "./raise.js";
import {
  armDropCooldown,
  EXTERNAL_ON_VOID_MS,
  HOUSE_SAMPLE_COOLDOWN_MS,
  houseLoadAmps,
  initialHouseLoad,
  sampleHouseLoad,
  voidSamples,
  type HouseLoadState,
} from "./house-load.js";
import {
  ENTRY_COLLAPSE_DWELL_MS,
  entryCollapseEvidence,
  houseIsDead,
  meterIsSteady,
  modeledGapAmps,
  rampAbsorptionLanded,
  rampCommittedAmps,
  rampProvenDone,
  RAMP_SETTLED_EPSILON_AMPS,
} from "./dead-window.js";

export interface SimAcSetup {
  deviceId: string;
  name?: string;
  /** Steady draw when the cap binds, per level 1..max (hot-case ceilings). */
  capAmps: [number, number, number];
  /** Unconstrained compressor demand right now (cool room → below cap1). */
  demandAmps: number;
  needDelta: number;
  /**
   * The room's own thermometer in °C. Absent = no live reading, which is the
   * shell's dead-sensor case and makes `rankNeedDelta` fall back to `needDelta`
   * — so every scenario written before R13 keeps exactly its old ordering.
   *
   * Set it when a scenario needs the two to DISAGREE, which is the whole point
   * of R13: a room whose automation runs on feels-like carries a `needDelta`
   * that humidity has inflated, and room-vs-room ranking must not see it.
   */
  roomTempC?: number;
  on?: boolean;
  /** Start already leveler-shed (off). */
  shed?: boolean;
  level?: number;
  fan?: number;
  minLevel?: number;
  /**
   * The outdoor temperature is past this room's boost band, so levels below
   * `minLevel` are not legal automatic targets (needs.ts `hardFloorOf`).
   */
  boostFloorHard?: boolean;
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
  /**
   * TCL compressor restart protection: how long after a POWER EVENT (changeover,
   * post-trip recovery) this compressor refuses to start, drawing about its fan.
   * The ramp itself then begins when the compressor actually engages.
   *
   * Precedent: `residualAmps` was added for exactly this reason — the harness
   * modelled a physics the live failure needed and did not have, so the failure
   * was unreachable in simulation. Live 2026-08-04 measured ~6–7 min after the
   * 11:16 changeover, against a 240 s ramp window. Defaults to 0 (compressors
   * restart instantly) so existing scenarios are unchanged.
   */
  restartDelayMs?: number;
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
  /**
   * Amp evidence retired this ramp WINDOW before its clock (shell: a deleted
   * `rampUntil`). Consumed by `isRamping`; set by the harness `noteRampAbsorption`
   * when `rampProvenDone` fires.
   */
  rampReleased: boolean;
  /** Stall-clock anchor for the plateau test (shell: rampGrowth.{at,absorbed}). */
  rampGrowthAt: number;
  rampGrowthAbsorbed: number;
  /** When the current ramp window armed (shell: powerEventRamp.armedAt). */
  rampArmedAt: number;
  /** This ramp was opened by a power event, so it may be held (shell: powerEventRamp). */
  powerEventRamp: boolean;
  /** Dead-window extension of the ramp window (shell: an extended rampUntil). */
  rampHeldUntil: number;
  /** Compressor restart protection: no draw at all until this moment. */
  compressorIdleUntil: number;
  /** Shell parity: when this room's run of unanswered sends began (0 = none). */
  unansweredSince: number;
  /**
   * When this module's shadow last reported. The Wi-Fi module is fed by the AC
   * circuit, so it goes dark exactly when the breaker opens and keeps reporting
   * through restart protection — which is the whole signal that separates the
   * two (dead-window.ts, entry collapse).
   */
  lastSeenAt: number;
  /** Compressor still spinning down after an off was sent (0 = already stopped). */
  drawingUntil: number;
  /** Shell parity: a level RAISE's committed-but-unmetered amps (gen only). */
  jumpDebit: { amps: number; baseline: number | null; absorbed: number; until: number } | null;
  /** Shell parity: the same accounting for a fan RESTORE's un-metered amps. */
  fanDebit: { amps: number; baseline: number | null; absorbed: number; until: number } | null;
  /** User-pinned level (manual wins over every automation ceiling). */
  manualTarget: number | null;
  /**
   * Shell parity (`controller.externalOnAt`): when a human/automation last
   * turned this room on — the swap donor shield (invariant 42/57). 0 = never.
   */
  externalOnAt: number;
}

const STEP_MS = 5_000;
/**
 * Mirrors the controller shell's `AC_RAMP_MS` — the ramp WINDOW, which is a
 * different thing from how long a simulated compressor takes to reach its
 * steady draw (`SimAcSetup.rampSeconds`, the physical curve).
 *
 * The harness used to conflate them: `isRamping` expired at `rampSeconds`, so
 * the window closed the instant the sim's compressor finished. That is not what
 * the shell does — there the window is an UPPER BOUND and *absorption* is what
 * actually retires the charge (`rampDebitAmps`), so a compressor that lands
 * early stops being charged the moment the meter shows it, and a slow one stays
 * charged for the full four minutes.
 *
 * The difference was invisible until 2026-08-05, when `SMOOTH_WINDOW` widened
 * 4 → 8. Production's ramp window is 6–10× its smoothing settle time (240 s
 * against 25–40 s at the ESP cadence); the harness's was **1.5×** (60 s against
 * 40 s at this 5 s step). Widening the median pushed the settle time past the
 * harness's own window, so for the ~15 s in between the view reported "settled"
 * while the meter was still 2.3 A behind a load that had fully arrived — and a
 * shed room was restored into that gap. The shell cannot exhibit that shape at
 * all; it was a phantom regression manufactured by the scaling.
 *
 * ⚠ This is the SKILL's mirror rule — *"`scenario.ts` mirrors the shell …
 * anything you change in one, change in the other"*. A harness constant that
 * merely resembles a shell constant is worse than no mirror at all, because
 * every scenario then quietly tests a guard production does not have.
 */
const AC_RAMP_MS = 240_000;
/** Mirrors the controller shell's grid full-start window (`START_WINDOW_MS`). */
const GRID_START_MS = AC_RAMP_MS;
/** Mirrors the controller shell's FAN_DEBIT_MS. */
const FAN_DEBIT_MS = 60_000;
/** Mirrors the controller shell's FUNDING_COOLDOWN_MS. */
const FUNDING_COOLDOWN_MS = 120_000;
/** Mirrors the controller shell's VICTIM_COOLDOWN_MS. */
const VICTIM_COOLDOWN_MS = 120_000;
/**
 * Mirrors the controller shell's SWAP_RESERVATION_MS by its DERIVATION, not by
 * its value: the shell defines it AS the blame window, so the mirror does too.
 * A harness constant that merely resembles a shell constant is worse than no
 * mirror at all (2026-08-05, the phantom `rampSeconds` regression).
 */
const SWAP_RESERVATION_MS = ATTEMPT_BLAME_WINDOW_MS;

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
  private subFloorSince = new Map<string, SubFloorWatch>();
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
  /** Shell parity: re-arm every running compressor's ramp a tick after a changeover. */
  private armRampOnSourceChange = false;
  /** Shell parity: when the current source session began (the entry anchor). */
  private sourceSince = 0;
  /** Shell parity: when we last saw a send confirm on each room's shadow. */
  private lastConfirmAt = new Map<string, number>();
  /** Shell parity: entry-collapse dwell / ownership / the recovery window. */
  private entryCollapseSince: number | null = null;
  private entryCollapseLatched = false;
  private recoveryAdmissionUntil = 0;
  /** Shell parity: rooms on whose shadow has not confirmed (house sampling off). */
  private pendingOn = new Map<string, number>();
  /** Shell parity: rooms that funded a peer's raise → when they were demoted. */
  private fundingDemotedAt = new Map<string, number>();
  /** Shell parity: rooms the reducer cut → when (they may not climb straight back). */
  private reducedAt = new Map<string, number>();
  /**
   * Shell parity (R9): the meter bar a room's OWN shed left — the smoothed
   * meter when the shedding batch went out, less what it was priced to save.
   * A restore is judged against that, not against the trough its shed dug.
   * `credited` mirrors the shell's bounce-bar peer-credit release valve
   * (2026-08-07).
   */
  private shedBar = new Map<string, { amps: number; at: number; credited: number }>();
  /**
   * Shell parity (`controller.swap`): the ONE gated proactive shed in flight
   * house-wide. Mirrored because the receiver's reservation must survive across
   * ticks — a harness that forgot the trade every step could never show the
   * donor's amps actually reaching the room they were taken for.
   */
  private swap: { donorId: string; receiverId: string; at: number } | null = null;
  /** Shell parity (`controller.lastOverLimitActAt`): when the ladder last acted. */
  private lastOverLimitActAt: number | null = null;
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
      rampReleased: false,
      rampGrowthAt: 0,
      rampGrowthAbsorbed: 0,
      rampArmedAt: 0,
      powerEventRamp: false,
      rampHeldUntil: 0,
      compressorIdleUntil: 0,
      unansweredSince: 0,
      lastSeenAt: 0,
      drawingUntil: 0,
      jumpDebit: null,
      fanDebit: null,
      manualTarget: null,
      externalOnAt: 0,
    }));
  }

  /**
   * Shell parity for `rearmRamp`: every arming point snapshots the house load
   * measured BEFORE this compressor contributes, which is what the ramp debit
   * measures absorption against. `powerEvent` marks the two causes that
   * power-cycle a running compressor — those windows close on evidence rather
   * than on the clock (shell: `powerEventRamp` / `holdPowerEventRamps`).
   */
  private startRamp(ac: SimAc, opts: { powerEvent?: boolean } = {}): void {
    ac.turnedOnAt = this.now;
    ac.rampArmedAt = this.now;
    ac.powerEventRamp = opts.powerEvent === true;
    ac.rampHeldUntil = 0;
    // Restart protection is a POWER-EVENT physics: an ordinary turn-on starts
    // its compressor immediately.
    ac.compressorIdleUntil =
      opts.powerEvent === true ? this.now + (ac.setup.restartDelayMs ?? 0) : 0;
    const view = meterView(this.meterState, this.now);
    ac.rampBaseline = view.source !== "none" && view.sampleCount >= 2 ? view.smoothedAmps : null;
    ac.rampAbsorbed = 0;
    // Shell parity (`rearmRamp`): a fresh ramp is not yet released, and its
    // plateau stall clock starts here anchored at zero absorption.
    ac.rampReleased = false;
    ac.rampGrowthAt = this.now;
    ac.rampGrowthAbsorbed = 0;
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
      // Shell parity: a power-event ramp under review keeps ratcheting past its
      // nominal window — its absorption is the evidence that closes it.
      if (ac.rampBaseline == null || !(this.isRamping(ac) || ac.powerEventRamp)) continue;
      const risen = view.smoothedAmps - ac.rampBaseline;
      if (risen > ac.rampAbsorbed) {
        ac.rampAbsorbed = risen;
        // Shell parity (`rampGrowth`): re-stamp only on a meaningful step, so a
        // noise creep still reads as plateaued.
        if (risen - ac.rampGrowthAbsorbed >= RAMP_SETTLED_EPSILON_AMPS) {
          ac.rampGrowthAt = this.now;
          ac.rampGrowthAbsorbed = risen;
        }
      }
      // Shell parity (`maybeReleaseRampEarly`): amp evidence retires the window
      // before the clock — fully absorbed, or plateaued above the started bar.
      const line = this.line;
      if (line !== "none" && (this.isRamping(ac) || ac.powerEventRamp) && !ac.rampReleased) {
        const proof = rampProvenDone({
          absorbedAmps: ac.rampAbsorbed,
          committedAmps: rampCommittedAmps(
            { deviceId: ac.setup.deviceId, currentLevel: this.observedLevelOf(ac), maxLevel: 3 },
            this.cfg,
            line,
          ),
          lastGrowthAt: ac.rampGrowthAt,
          now: this.now,
        });
        if (proof != null) ac.rampReleased = true;
      }
    }
  }

  private isRamping(ac: SimAc): boolean {
    if (!ac.on) return false;
    // Amp evidence retired the window early (shell: a deleted `rampUntil`).
    if (ac.rampReleased) return false;
    // The WINDOW, not the sim's physical ramp — see AC_RAMP_MS. Absorption is
    // what retires the debit inside it, exactly as in the shell.
    if (ac.turnedOnAt > 0 && this.now - ac.turnedOnAt < AC_RAMP_MS) return true;
    return ac.rampHeldUntil > this.now;
  }

  /**
   * Shell parity for `holdPowerEventRamps` — hold a power-event ramp open while
   * this compressor has absorbed nothing AND the whole-house model sits above
   * the meter, capped at three ramp windows. Returns whether EVERY running room
   * is inside such a hold, which is what makes the meter a direct measurement of
   * the house.
   *
   * The windows are scaled to the harness's own `rampSeconds` rather than the
   * shell's 240 s: `rampSeconds` IS this harness's ramp window, so the mirror is
   * structural (nominal → extend by one window → cap at three), not numeric.
   */
  private holdPowerEventRamps(): boolean {
    if (this.line === "none") return false;
    const view = meterView(this.meterState, this.now);
    if (view.source === "none" || view.frozen || view.collapsed || view.sampleCount < 2) return false;
    const running = this.acs
      .filter((a) => a.on && !a.shed)
      .map((a) => ({
        deviceId: a.setup.deviceId,
        on: true,
        managed: true,
        shed: false,
        currentLevel: this.observedLevelOf(a),
        maxLevel: 3,
      }));
    const dead = houseIsDead(
      modeledGapAmps({
        smoothedAmps: view.smoothedAmps,
        acs: running,
        config: this.cfg,
        source: this.line,
        commandedCutCreditAmps: view.commandedCutCreditAmps,
      }),
    );
    for (const ac of this.acs) {
      if (!ac.powerEventRamp) continue;
      // ⚠ DELIBERATELY still scaled to the sim's `rampSeconds`, and NOT to
      // `AC_RAMP_MS` the way `isRamping` now is (2026-08-05). Do not "finish the
      // job" here without reading this: aligning it was tried, and it does not
      // translate as a clock.
      //
      // The dead-window fixtures express restart protection as a MULTIPLE of
      // this boundary — `DEAD_MS = 150_000` against a 60s window, "the same
      // shape at test speed … still inside the 3-window cap". Move the boundary
      // to 240s and 150s of restart protection is shorter than a single window,
      // so the hold can never arm at all and the dead window becomes unreachable
      // in simulation — exactly the harness debt `restartDelayMs` was added to
      // repay. Five scenarios go red, and three of them (R11b's entry admission,
      // the direct house sample of invariant 44) assert what happens BEFORE the
      // compressors engage, which is a different window after the rescale, not
      // merely a later clock.
      //
      // Closing it properly means rescaling the whole dead-window fixture family
      // together — restart protection, the dwell, the 3-window cap — and
      // re-deriving each assertion's window. Worth doing; too big to smuggle in.
      // The shell's own boundary is `ramp.armedAt + AC_RAMP_MS` with a
      // `3 * AC_RAMP_MS` cap (controller.ts).
      const rampMs = ac.setup.rampSeconds * 1000;
      // Shell parity: judge only at the boundary. Inside the ordinary window the
      // timer is in charge and the smoothed meter is still draining the other
      // line's load, which reads as "not dead" and would retire the window
      // before it was ever needed.
      if (this.now < ac.rampArmedAt + rampMs) continue;
      const modeled = running.find((r) => r.deviceId === ac.setup.deviceId);
      const landed =
        modeled != null && rampAbsorptionLanded(ac.rampAbsorbed, modeled, this.cfg, this.line);
      if (modeled == null || landed || !dead || this.now >= ac.rampArmedAt + 3 * rampMs) {
        ac.powerEventRamp = false;
        continue;
      }
      ac.rampHeldUntil = Math.max(
        ac.rampHeldUntil,
        Math.min(ac.rampArmedAt + 3 * rampMs, this.now + rampMs),
      );
    }
    // Shell parity: a window that has outlived its own timer, not merely one
    // that was armed — for the first window after a changeover the ordinary ramp
    // guard already covers sampling, and the smoothed meter is still draining
    // the OLD line's readings through the median.
    return (
      dead &&
      meterIsSteady(view) &&
      running.length > 0 &&
      running.every((r) => {
        const ac = this.sim(r.deviceId);
        return ac.powerEventRamp && ac.rampHeldUntil > this.now;
      })
    );
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
    // A real changeover restarts every running compressor — and restart
    // protection may hold them off for minutes (see `restartDelayMs`). Armed
    // for the NEXT step, exactly like the shell: `source_changed` clears the
    // ramp baselines and `armRampOnSourceChange` re-arms them a tick later,
    // against the new line's first readings. Anchoring here instead would
    // snapshot the OLD line's meter as the baseline, and absorption measured
    // from that can never ratchet.
    if (line === "gen" || line === "grid") this.armRampOnSourceChange = true;
    // Shell parity: the anchor every "since entry" liveness test measures from.
    // Stamped for the tick that will ingest the first reading on the new line.
    this.sourceSince = this.now + STEP_MS;
    this.lastConfirmAt.clear();
    for (const ac of this.acs) ac.unansweredSince = 0;
    this.entryCollapseSince = null;
    this.entryCollapseLatched = false;
    // Shell parity (`clearOnSourceChange`): a trade in flight reserved amps on a
    // budget that no longer exists, and the entry mode (FLOORS / GRID_FULL)
    // re-decides who runs from scratch. The donor keeps its ordinary shed row.
    // Missing here, the harness would carry a receiver's reservation across a
    // changeover and park the new line's raise phase for `SWAP_RESERVATION_MS`
    // — a divergence the shell cannot exhibit, i.e. exactly the mirror class the
    // SKILL warns about ("a harness constant that merely RESEMBLES a shell
    // constant is worse than no mirror at all").
    this.swap = null;
    // Shell parity (R11b): a changeover power-cycles every compressor exactly
    // as a collapse recovery does, so the gen-entry floor set is admitted
    // against the envelope on EVERY gen entry — not only after a latched
    // collapse. Free when the arithmetic fits.
    this.recoveryAdmissionUntil = line === "gen" ? this.now + FLOORS_MAX_MS : 0;
  }

  /** Breaker trips: the AC circuits go dead, a small residual stays on the line. */
  trip(): void {
    this.lineDead = true;
  }

  /** Power returns after a trip: compressors restart at their firmware levels. */
  recoverLine(): void {
    this.lineDead = false;
    for (const ac of this.acs) if (ac.physicalOn) this.startRamp(ac, { powerEvent: true });
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
    // Shell parity (controller.noteExternalOn): an automation/user ON the leveler
    // did not command — the swap donor shield (invariant 42/57) AND the end of any
    // restore bounce episode for this room (`clearBounces`, 2026-08-07).
    ac.externalOnAt = this.now;
    this.pacing = clearBounces(this.pacing, deviceId);
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
      if (draw > 0) {
        // Shell parity (2026-08-31): an off by another hand frees budget the
        // limit never asked for, so its credit is SPENDABLE: a waiting room may
        // be admitted against it before the meter shows the fall.
        this.meterState = noteCommandedCut(this.meterState, draw, this.now, { spendable: true });
        // Shell parity: an observed off is a peer removal for any bounce-extended
        // shed bar (invariant 54's release valve, 2026-08-07).
        this.creditPeerShedBars(draw, new Set([deviceId]));
      }
    }
    ac.on = false;
    ac.physicalOn = false;
    ac.pendingShadowOn = null;
    ac.shed = false;
    ac.startBaseline = null;
    ac.rampBaseline = null;
    ac.rampAbsorbed = 0;
    ac.rampReleased = false;
    ac.rampGrowthAt = 0;
    ac.rampGrowthAbsorbed = 0;
    ac.turnedOnAt = 0;
    ac.powerEventRamp = false;
    ac.rampHeldUntil = 0;
    ac.compressorIdleUntil = 0;
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
   * ±amplitude every reading, so an EVEN median window lands exactly on the
   * truth every time (half the samples high, half low, averaged) — true at the
   * old 4-wide window and equally true at today's 8. Pathologically
   * well-behaved, and useless for testing a rule about spikes. Real gen flicker
   * is asymmetric and bursty: a mostly-quiet
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
      // Shell parity: the controller learns of an external ON at THIS flip (its
      // structural off→on scan), which is where it stamps the donor shield
      // (invariant 42/57), not when the compressor physically started — and the
      // end of any restore bounce episode for it (`clearBounces`, 2026-08-07).
      ac.externalOnAt = this.now;
      this.pacing = clearBounces(this.pacing, ac.setup.deviceId);
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

  /**
   * The non-AC house load the controller has MEASURED — what the raise envelope
   * is charged, never the sim's ground-truth `nonAcAmps`. Introspection only.
   */
  measuredHouseAmps(): number {
    return houseLoadAmps(this.houseLoad, this.line, this.now, this.buildViews());
  }

  /** The effective shed bar for this room right now (introspection). */
  effectiveShedBar(deviceId: string): number {
    return this.shedBarValue(deviceId);
  }

  /**
   * Shell parity for `controller.shedBarFor`: the bar a room's own shed left,
   * expiring at `barPersistMs` (a blame window, or the compounded backoff while
   * it bounces) and reduced by any peer removal since it was stamped.
   */
  private shedBarValue(deviceId: string): number {
    const bar = this.shedBar.get(deviceId);
    if (bar == null) return 0;
    if (this.now - bar.at > barPersistMs(this.pacing, deviceId)) {
      this.shedBar.delete(deviceId);
      return 0;
    }
    return Math.max(0, bar.amps - bar.credited);
  }

  /**
   * Shell parity for `controller.creditPeerShedBars`: a peer's removal shrinks
   * the house every OTHER bounce-extended bar describes, priced by the same
   * figure fed to `noteCommandedCut`. Scoped to bounce-persisting bars.
   */
  private creditPeerShedBars(amps: number, except: ReadonlySet<string>): void {
    if (!(amps > 0)) return;
    for (const [id, bar] of this.shedBar) {
      if (except.has(id)) continue;
      if (restoreBounces(this.pacing, id) < 1) continue;
      if (this.now - bar.at > barPersistMs(this.pacing, id)) continue;
      bar.credited += amps;
    }
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
    const fanOnly = ac.fan > 1 ? (ac.fan - 1) * 0.05 : 0;
    // Compressor restart protection after a power event: the room is ON, the
    // model prices its whole cap, and it is drawing about its fan.
    if (this.now < ac.compressorIdleUntil) return fanOnly;
    const rampMs = ac.setup.rampSeconds * 1000;
    // The ramp starts when the compressor engages, not when the line came back.
    const engagedAt = Math.max(ac.turnedOnAt, ac.compressorIdleUntil);
    const sinceOn = this.now - engagedAt;
    const ramping = ac.turnedOnAt > 0 && sinceOn < rampMs;
    // Startup transient may exceed the cap (surgeFactor > 1); steady state is capped.
    const effectiveCap = ramping ? cap * (ac.setup.surgeFactor ?? 1) : cap;
    const steady = Math.min(ac.demandAmps, effectiveCap);
    const rampFactor = ramping ? Math.max(0.2, sinceOn / rampMs) : 1;
    return steady * rampFactor + fanOnly;
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

  /**
   * Shell parity for the sub-floor watch — SAME implementation, not a mirror.
   *
   * ⚠ REPORT-ONLY on both sides since 2026-08-06: `isNonCooling` no longer reads
   * this clock and no hold is armed from it, so a scenario cannot stage a
   * non-cooling room by starving it of progress. State
   * `SimAcSetup.compressorOffLikely`'s physical cause instead (a held
   * power-event ramp), which is the amp evidence the ladder now runs on.
   * Kept computed because the shell still computes it for the status card, and
   * a harness that stopped would be free to drift from a live surface.
   */
  private subFloorStalledMs(ac: SimAc, observedLevel: number): number {
    const floor = ac.setup.minLevel ?? 1;
    const r = nextSubFloorWatch(this.subFloorSince.get(ac.setup.deviceId) ?? null, {
      active: ac.on && !ac.shed,
      belowFloor: observedLevel >= 1 && observedLevel < floor,
      needDelta: ac.needDelta,
      tempKnown: true, // the sim's thermometer is always live
      now: this.now,
    });
    if (r.watch != null) this.subFloorSince.set(ac.setup.deviceId, r.watch);
    else this.subFloorSince.delete(ac.setup.deviceId);
    return r.stalledMs;
  }

  /** The level the cloud SHADOW reports right now (it lags the firmware). */
  private observedLevelOf(ac: SimAc): number {
    return this.now - ac.shadowLevelAt >= ac.setup.confirmDelayMs ? ac.level : ac.shadowLevel;
  }

  /**
   * Shell parity for `assessEntryCollapse` — latch the collapse the readings
   * cannot see (a session that BEGINS with the AC circuit dead has no cliff),
   * and release it on evidence, arming the envelope-judged recovery admission.
   */
  /** Shell parity for `armRecoveryAdmission`. */
  private armRecoveryAdmission(): void {
    this.recoveryAdmissionUntil = this.now + FLOORS_MAX_MS;
    for (const ac of this.acs) if (ac.physicalOn) this.startRamp(ac, { powerEvent: true });
  }

  private assessEntryCollapse(): void {
    if (this.line === "none") return;
    const view = meterView(this.meterState, this.now);
    // Shell parity: our latch going away for ANY reason — the meter coming back
    // past its reference, or the sensing safety cap — is the circuit returning.
    if (this.entryCollapseLatched && this.meterState.collapse == null) {
      this.entryCollapseLatched = false;
      this.armRecoveryAdmission();
    }
    if (view.source === "none" || view.frozen || view.sampleCount < 2) {
      this.entryCollapseSince = null;
      return;
    }
    const running = this.acs.filter((a) => a.on && !a.shed);
    const gapAmps = modeledGapAmps({
      smoothedAmps: view.smoothedAmps,
      acs: running.map((a) => ({
        deviceId: a.setup.deviceId,
        on: true,
        managed: true,
        shed: false,
        currentLevel: this.observedLevelOf(a),
        maxLevel: 3,
      })),
      config: this.cfg,
      source: this.line,
      commandedCutCreditAmps: view.commandedCutCreditAmps,
    });
    const evidence = entryCollapseEvidence({
      gapAmps,
      rooms: running.map((a) => ({
        lastSeenAt: a.lastSeenAt,
        lastConfirmAt: this.lastConfirmAt.get(a.setup.deviceId) ?? null,
        unconfirmedSendAgeMs: a.unansweredSince > 0 ? this.now - a.unansweredSince : 0,
      })),
      sinceEntry: this.sourceSince,
      now: this.now,
    });
    if (!evidence) {
      this.entryCollapseSince = null;
      if (this.entryCollapseLatched) {
        this.entryCollapseLatched = false;
        this.meterState = clearCollapse(this.meterState);
        this.modeState = applyMeterEvent(
          this.modeState,
          { kind: "collapse_recovered", source: this.line },
          this.now,
        );
        this.armRecoveryAdmission();
      }
      return;
    }
    this.entryCollapseSince ??= this.now;
    if (this.entryCollapseLatched || this.now - this.entryCollapseSince < ENTRY_COLLAPSE_DWELL_MS) return;
    const preMedianAmps = view.smoothedAmps + gapAmps;
    this.meterState = latchCollapse(this.meterState, {
      source: this.line,
      now: this.now,
      preMedianAmps,
    });
    this.modeState = applyMeterEvent(
      this.modeState,
      { kind: "collapse", fromAmps: preMedianAmps, toAmps: view.smoothedAmps, source: this.line },
      this.now,
    );
    this.entryCollapseLatched = true;
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
      const observedLevel = this.observedLevelOf(ac);
      // Any confirm clears every unconfirmed send (reconciler parity) — and a
      // shadow that MOVED is a device that is listening (shell parity: the
      // active half of the entry-collapse liveness test).
      if (ac.sentLevels.includes(observedLevel)) {
        ac.sentLevels = [];
        ac.unansweredSince = 0;
        this.lastConfirmAt.set(ac.setup.deviceId, this.now);
      }
      this.trackSatisfied(ac);
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
        // Mirrors buildViews: the shared-unit ranking figure, or the room's own
        // metric when its thermometer is dead.
        roomTempC: ac.setup.roomTempC ?? null,
        rankNeedDelta:
          ac.setup.roomTempC != null ? ac.setup.roomTempC - this.cfg.comfortTargetC : ac.needDelta,
        satisfiedForMs: this.satisfiedForMs(ac),
        subFloorStalledMs: this.subFloorStalledMs(ac, observedLevel),
        // Shell parity (R6): the METER's own answer to "is this compressor
        // running". The harness has a physical compressor, so it reports the
        // dead-window half directly — a power-event ramp held open past its
        // timer — and a scenario can state the graded-off-drop half.
        compressorOffLikely:
          ac.on && !ac.shed && ac.powerEventRamp && ac.rampHeldUntil > this.now,
        minLevel: ac.setup.minLevel ?? 1,
        // Shell parity (R14-hard): above the room's boost band the reducer may
        // not enumerate a level below its floor at all. The harness has no
        // weather, so a scenario states the zone directly.
        boostFloorHard: ac.setup.boostFloorHard ?? false,
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
        // Shell parity (controller.externalOnAt): a room a human just switched
        // on is shielded from the proactive swap (invariant 42/57).
        recentlyExternalOn: this.now < ac.externalOnAt + EXTERNAL_ON_DONOR_SHIELD_MS && ac.externalOnAt > 0,
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
    const committed = starting.map((v) => {
      const ours = attemptedWithin(this.pacing, v.deviceId, "restore", GRADE_TURN_ON_MS, this.now);
      return ours
        ? restoreCostAmps(this.book, this.cfg, v.deviceId, source, floorOf(v), v.maxLevel, this.now, {
            gentle: this.fanHolds[v.deviceId]?.gentle === true,
          }).amps
        : turnOnAmps(this.book, this.cfg, v.deviceId, source, v.envelopeLevel, v.maxLevel, this.now).amps;
    });
    // Shell parity (controller.projectedExtraAmps): ONE shared absorption pool
    // across everything that is starting, never the whole rise per room.
    const absorbed = absorbedSharesAmps(
      starting.map((v, i) => ({
        committedAmps: committed[i],
        baselineAmps: v.rampBaselineAmps,
        ratchetAmps: v.rampAbsorbedAmps,
      })),
      view.smoothedAmps,
    );
    return committed.reduce((sum, c, i) => sum + Math.max(0, c - absorbed[i]), 0);
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
          if (ac.unansweredSince === 0) ac.unansweredSince = this.now;
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
          // A dead circuit hears nothing. The send still happened — the
          // envelope must charge for it, and the unanswered clock must run —
          // but the firmware is not there to apply it. This morning's four
          // FLOORS resends were exactly this.
          if (!this.lineDead && !(ac.setup.ignoreLevels ?? []).includes(cmd.level)) {
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
            // random one clusters, where enough spikes inside one median window
            // (more than half of it) genuinely lift the SMOOTHED meter over the
            // limit. That is a real excursion the controller should answer, not
            // the single-reading supply noise this is here to model. The 8-wide
            // window makes the deterministic cadence MORE forgiving, not less:
            // a 1-in-4 duty puts two spikes in eight readings, and the median
            // needs five to move.
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
    // Shell parity (`armRampOnSourceChange`): the changeover re-arms every
    // running compressor's ramp on a LATER tick, against the new line's own
    // readings. Held until the ring has two of them, which is the ordinary
    // production sequence — the ESP delivers readings faster than the collector
    // ticks — and it is what makes the ramp baseline (and therefore absorption)
    // measurable at all: `rearmRamp` takes no baseline below `sampleCount` 2,
    // and no baseline means no absorption evidence for the whole window.
    if (this.armRampOnSourceChange && meterView(this.meterState, this.now).sampleCount >= 2) {
      this.armRampOnSourceChange = false;
      for (const ac of this.acs) if (ac.physicalOn) this.startRamp(ac, { powerEvent: true });
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

    // The Wi-Fi modules ride the AC circuit: while the breaker holds they keep
    // reporting, and the moment it opens they go dark. That is the signal the
    // entry-collapse latch reads (dead-window.ts) — restart protection leaves
    // them powered, a dead circuit does not.
    if (!this.lineDead) for (const ac of this.acs) ac.lastSeenAt = this.now;

    // Shell parity: a ramp opened by a power event closes on evidence, not on
    // its timer — decided BEFORE the views, because the views are where the
    // window becomes `AcView.ramping`.
    const houseIsDirect = this.holdPowerEventRamps();
    this.assessEntryCollapse();

    // FLOORS / GRID_FULL exit checks against confirmed shadows + ramps.
    const views = this.buildViews();
    const view = meterView(this.meterState, this.now);
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
    // Shell parity (`clearSettleIfDone`, 2026-08-08): end the settle window early
    // once the meter has digested the batch — no commanded fall still landing and
    // nothing owed on the spend side (`rampDebitAmps`). Only ever shortens it.
    const settleLine = this.line;
    if (settleLine !== "none") {
      this.modeState = clearSettleIfDone(
        this.modeState,
        {
          commandedCutTotalAmps: view.commandedCutTotalAmps,
          unabsorbedSpendAmps: rampDebitAmps(views, view.smoothedAmps, this.cfg, settleLine),
        },
        this.now,
      );
    }
    this.modeState = { ...this.modeState, collapsed: this.meterState.collapse != null };

    const mode = deriveMode(this.modeState, this.now);
    // Shell parity (controller.tick): the planner does NOT get told `nonAcAmps`
    // — it must MEASURE the split off the simulated meter exactly the way the
    // shell does. Handing it the sim's ground truth would be the scenario.ts
    // mirror bug all over again (2026-07-30, bug 14): the harness would price a
    // house the shell cannot see, and no harness test could ever disagree.
    // Mirror of the shell's boot quiet: no sampling for the first cooldown.
    if (this.firstStepAt == null) this.firstStepAt = this.now;
    // Shell parity (controller.tick, 2026-08-08): call EVERY step with a live
    // source so the drop detector's memory advances even when the SAMPLE is
    // suppressed. `sampleSuppressed` carries the shell's own stand-downs — an
    // unconfirmed ON (the room draws before the shadow says so), the boot quiet
    // window, a frozen meter — while memory and cooldown advance regardless.
    if (view.source !== "none") {
      this.houseLoad = sampleHouseLoad(this.houseLoad, {
        source: view.source,
        at: this.now,
        smoothedAmps: view.smoothedAmps,
        acs: views,
        config: this.cfg,
        // Shell parity: with every room power-cycled and no compressor drawing,
        // the meter IS the house — a residual would floor at a fictitious zero.
        deadWindow: houseIsDirect,
        sampleSuppressed:
          view.sampleCount < 2 ||
          view.frozen ||
          this.pendingOn.size > 0 ||
          this.now - this.firstStepAt < HOUSE_SAMPLE_COOLDOWN_MS,
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
      // Shell parity: rooms coming back from a dead circuit arrive together, so
      // the floor set is admitted on the envelope rather than on a meter that
      // has seen none of it yet.
      recoveryAdmission: this.now < this.recoveryAdmissionUntil,
      // Shell parity: a room's own shed leaves a hole its restore must not read
      // as headroom, for a full blame window — or the compounded backoff while
      // it bounces (R9, invariant 54, 2026-08-07), less any peer removal since.
      shedBarAmps: (deviceId) => this.shedBarValue(deviceId),
      // Shell parity (`controller.swapInFlightFor`): the trade ends when the
      // receiver is back, or at SWAP_RESERVATION_MS — never on a bare clock
      // while the room it is holding amps for is still off.
      swapInFlight: (() => {
        if (this.swap == null) return null;
        const receiver = views.find((a) => a.deviceId === this.swap?.receiverId);
        if (receiver != null && receiver.on && !receiver.shed) {
          this.swap = null;
          return null;
        }
        if (this.now - this.swap.at > SWAP_RESERVATION_MS) {
          this.swap = null;
          return null;
        }
        return { donorId: this.swap.donorId, receiverId: this.swap.receiverId };
      })(),
      // Shell parity: the comfort trade owes the ladder a quiet window that
      // outlives every meter-level signal of the episode.
      overLimitActedRecently:
        this.lastOverLimitActAt != null &&
        this.now - this.lastOverLimitActAt < SWAP_QUIET_AFTER_OVER_MS,
    });
    this.freshlyOn = [];
    this.plans.push(out);
    this.fanHolds = out.fanHolds;

    if (out.commands.length > 0) {
      // Shell parity: stamp the funding donors before executing, from the same
      // command list that ships.
      // Shell parity: a proactive-shed donor gave up its whole ROOM, so a
      // `power_off` stamps the same cooldown a `set_level` demote does.
      for (const deviceId of out.fundingDonors ?? []) {
        if (
          out.commands.some(
            (c) => c.deviceId === deviceId && (c.kind === "set_level" || c.kind === "power_off"),
          )
        ) {
          this.fundingDemotedAt.set(deviceId, this.now);
        }
      }
      // Shell parity: record the trade once its donor's off has shipped.
      if (
        out.swap != null &&
        out.commands.some((c) => c.deviceId === out.swap?.donorId && c.kind === "power_off")
      ) {
        this.swap = { donorId: out.swap.donorId, receiverId: out.swap.receiverId, at: this.now };
      }
      for (const deviceId of out.reductionVictims ?? []) {
        if (out.commands.some((c) => c.deviceId === deviceId && c.kind === "set_level")) {
          this.reducedAt.set(deviceId, this.now);
        }
      }
      this.execute(out);
      this.modeState = noteBatch(this.modeState, { fanOnly: out.fanOnly }, this.now);
      // Shell parity (2026-08-09): a non-fan batch rewinds BOTH calm anchors; a
      // fan-only SPEND (restore) rewinds only the MAIN clock and spares the fan
      // path's own, so a fan hold's first gear is not queued behind another
      // hold's fan step. A fan CUT rewinds neither (invariant 18 vs #11098-#11126).
      const spentOnFan = out.commands.some((c) => c.kind === "set_fan" && c.reason === "trim_restore");
      if (!out.fanOnly) this.meterState = resetCalm(this.meterState);
      else if (spentOnFan) this.meterState = resetCalm(this.meterState, { fanSpend: true });
      // Shell parity: credit the meter with what this batch took off the line,
      // so a shed's late arrival is not read as a breaker trip. `commandedCutAmps`
      // is the single credit path (invariant 11) — `expectedDeltaAmps` is only
      // set by reduce batches and silently missed demotes, funding swaps, and
      // the gen start clamp.
      if (out.commandedCutAmps > 0) {
        // Shell parity (2026-08-31): only the IDLE DEMOTE's freed amps are a
        // spender's to take. An over-limit reduction's belong to the breaker, a
        // FLOORS clamp's to the entry policy, and a restore's floor-downs are
        // paying for the turn-on in their own batch.
        this.meterState = noteCommandedCut(this.meterState, out.commandedCutAmps, this.now, {
          spendable: out.reason === "demote",
        });
      }
      // Shell parity (belt, 2026-08-08): a commanded OFF arms the house sampler's
      // drop cooldown directly, so a commanded off cannot be booked as house even
      // if the tick-by-tick detector's memory is ever starved. Scoped to
      // `power_off` — a fan trim lowers load but never drops the model.
      if (view.source !== "none" && out.commands.some((c) => c.kind === "power_off")) {
        this.houseLoad = armDropCooldown(this.houseLoad, view.source, this.now);
      }
      // Shell parity: a turn-on invalidates banked over-limit readings.
      if (out.commands.some((c) => c.kind === "power_on")) {
        this.meterState = refillBucket(this.meterState, this.cfg.overLimitBudgetPoints);
      }
      if (out.reason.startsWith("over")) {
        // Shell parity: the ladder acted — the comfort trade stands down.
        this.lastOverLimitActAt = this.now;
        // Shell parity: PARTIAL after an over-limit act, so an under-sized
        // reduction can escalate in seconds rather than another five readings.
        this.meterState = refillBucket(this.meterState, OVER_LIMIT_BUDGET_AFTER_ACT);
        // The reducer's judgment beats the entry policy — GRID only (shell
        // parity): gen's start policy is a floor clamp, which can only agree
        // with the reducer, and a gen turn-on is over-limit by definition.
        if (this.line === "grid") for (const ac of this.acs) ac.startBaseline = null;
      }
      // Shell parity (R9): stamp the bar each shed leaves behind, from the
      // PRE-batch meter less what the batch was priced to save.
      const shedThisBatch = new Set<string>();
      for (const cmd of out.commands) {
        if (cmd.kind !== "power_off") continue;
        this.shedBar.set(cmd.deviceId, { amps: view.smoothedAmps - out.commandedCutAmps, at: this.now, credited: 0 });
        shedThisBatch.add(cmd.deviceId);
      }
      // …and credit that removal to every OTHER bounce-extended peer bar.
      this.creditPeerShedBars(out.commandedCutAmps, shedThisBatch);
      // Failure attribution: a reduction that undoes a recent raise/restore is
      // that attempt's failure (the bounce, hybrid-backoff side).
      for (const cmd of out.commands) {
        if (cmd.kind === "set_level" || cmd.kind === "power_off") {
          for (const kind of ["raise", "restore"] as const) {
            if (out.reason.startsWith("over") && attemptedRecently(this.pacing, cmd.deviceId, kind, this.now)) {
              // Shell parity: only a genuine `power_off` re-shed books a bounce.
              this.pacing = noteFailure(this.pacing, cmd.deviceId, kind, this.now, cmd.kind === "power_off");
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
