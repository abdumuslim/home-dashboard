// Last-resort fan trim — the ONLY fan involvement leveling v2 has. The cut
// side lives inside the reducer (fan moves attach only at floor level); this
// module owns the hold records and the restore side.
//
// Restore philosophy (evidence: v1's 61s cut→restore median fed two trips):
// generous hysteresis. A held fan climbs back only after a LONG sustained calm,
// to the highest target whose learned cost fits under the resting ceiling
// (sweet spot, no 1↔full bounce), one AC per evaluation.

import type { AcView, Command, PowerSource } from "./types.js";
import type { CostBook } from "./costs.js";
import { fanTrimSavings } from "./costs.js";

/**
 * Sustained calm required before a held fan CUT for an overload starts climbing
 * back — the "may this fan come back at all" minute, and the anti-bounce guard
 * (2026-07-24, user "make the fan restoration faster").
 *
 * Briefly 30s on 2026-08-08; reverted to 60s the same day. The 30s cut re-opened
 * the 2026-07-31 fan cascade (7→5→3→1→7→1→7→4): at 30s calm the fan fully restores
 * inside a ~75s over/under oscillation, and a full restore releases the hold (on
 * SEND, controller.ts) — taking the bounce counter with it, so the compounding
 * below never bites and the fan plays up and down. The 60s first-gear minute is
 * the binding cascade protection (empirically the fix). The user's "fan 1 is
 * emergency-only, should not take too long to come back" is served instead by
 * `FAN_RESTORE_GENTLE_CALM_MS` (30s, for admission pins — never CUT for an
 * overload) and the fast path (a wide budget climbs home in one command), not by
 * shortening this overload-trim gate.
 */
export const FAN_RESTORE_CALM_MS = 60_000;

/**
 * The first-gear calm a GENTLE hold owes instead of `FAN_RESTORE_CALM_MS`. Equal
 * to the default `raiseCalmSeconds` — a fan pinned to 1 on a gen restore was
 * never CUT for an overload, it was held for admission pricing while the room
 * came back, so it does not owe the full "may this fan come back at all" minute.
 * That minute was sized for the fromCut bounce (2026-08-03/06); a gentle pin has
 * no bounce to guard against, and invariant 58 itself flagged that charging it
 * the same slow gates left it "pinned at fan 1 longer than it did" — now
 * user-confirmed (2026-08-08, "fan 1 is emergency-only and should not take too
 * long to come back"). Gentle continuation gears keep `FAN_RESTORE_CONTINUE_CALM_MS`.
 */
export const FAN_RESTORE_GENTLE_CALM_MS = 30_000;

/**
 * Calm required for the SECOND and later gears of a climb that is already
 * under way.
 *
 * The 60 s gate above is the anti-bounce guard: it decides whether a fan that
 * was cut may start coming back at all. Charging it again for every gear made a
 * six-gear recovery cost three separate batches a minute apart, and because a
 * fan restore SPENDS (invariant 18) each one rewinds the shared calm clock —
 * so the raise path, which needs `raiseCalmSeconds`, never got a window for the
 * whole climb. Live 2026-08-03 05:16:29 and 05:17:33 are two steps of exactly
 * that. Once the first gear has proved itself the question is no longer "should
 * this fan come back" but "has the last gear landed", which is a much shorter
 * clock. Each gear is still individually gated on headroom and still arms its
 * own fan debit, and a fresh CUT clears the climb so the full 60 s applies again.
 */
export const FAN_RESTORE_CONTINUE_CALM_MS = 20_000;

/**
 * Gears a single restore step may climb. The old "sweet spot" search took the
 * HIGHEST target whose learned cost fit — and a 6-gear swing is priced at only
 * ~0.15A×6 = 0.9A, which fits almost always. So the anti-bounce design did a
 * full 1→7 jump every time. Live 2026-07-31 Abdu ran 7→5→3→1→7→1→7→4 in nine
 * minutes, and the two amps-hungriest of those restores were immediately
 * followed by the level raises that tripped the gen. Climb in small steps and
 * let the meter agree between them.
 */
export const FAN_RESTORE_MAX_STEP = 2;

/**
 * Quiet time required after the LAST cut of an episode before that fan may
 * climb at all. `FAN_RESTORE_CALM_MS` alone never covered this: a fan-only
 * batch does not rewind the shared calm clock, so a fan cut at 17:30:24 was
 * fully restored 80s later — v1's 61s bounce median, reproduced in v2.
 *
 * 180s → 120s on 2026-08-05 (user request, watching his fans sit at 1 after an
 * episode ended). Briefly 60s on 2026-08-08, reverted the same day: 60s is below
 * the ~75s re-cross period of a genuinely oscillating house and re-opened the
 * 2026-07-31 fan cascade. The user's "fan 1 is emergency-only, should not take
 * too long to come back" is served instead by the FAST PATH (a wide budget climbs
 * home in one command, owing FAN_RESTORE_AFTER_CUT_FAST_MS) and the 30s GENTLE
 * calm for admission pins — speed for a fan that CAN come back, not a shorter wait
 * for an overload-trim that keeps re-crossing. A bouncing fan is slowed further by
 * FAN BOUNCE COMPOUNDING below, not sped up. Still past the calm gate plus the
 * smoothing window, and a fresh cut restarts it.
 */
export const FAN_RESTORE_AFTER_CUT_MS = 120_000;

/**
 * Slack — net of the measured supply flicker, like every other admission here —
 * that a budget must have BEYOND the whole remaining swing before the fast path
 * below applies. The margin is what makes "generous" mean it: not "the swing
 * fits", but "the swing fits and a full amp of the ceiling is still unspent".
 *
 * 2026-08-06, the user watching his fans crawl back after an episode: "there is
 * enough budget but the fan speed is taking too long. btw, if you notice the fan
 * speed is barely taking cost, so putting all at speed 1 is only just a last
 * emergency action, and should not taking too much [time]." The book agrees — a
 * full 1→7 swing graded **+0.64A** that afternoon, under half a compressor
 * level — yet recovery cost ~5 minutes of stacked time gates whether the budget
 * was razor-thin or wide open. Those gates were sized when the fan restore
 * itself was tripping the line; the flicker charge above now guards the thin
 * case with measured physics, so the blanket slowness pays for protection that
 * already exists. On a saturated line `spendable` never reaches swing + this
 * margin, so the fast path is unreachable exactly where the bounce lived.
 *
 * 1.0A → 0.5A on 2026-08-08 (user: "the time to restore fan does not need to be
 * that long"). `spendable` already nets the measured flicker before this margin
 * is applied, so on a flickery generator the full 1.0A double-charged the wobble
 * and the fast path missed the bar by ~0.1-0.5A every time — it only ever fired
 * on the last 0.3A gear. The remaining 0.5A covers model error on the swing
 * pricing; the flicker charge is what keeps the saturated line unreachable.
 */
export const FAN_RESTORE_FAST_MARGIN_AMPS = 0.5;

/**
 * The after-cut wait a GENEROUS hold owes instead of `FAN_RESTORE_AFTER_CUT_MS`.
 * Still past the meter's smoothing window and still restarted by a fresh cut —
 * the anti-bounce argument is unchanged, it is just priced against a budget in
 * which the re-cross is arithmetically impossible. The 60s first-gear calm gate
 * is NOT shortened: "may this fan come back at all" deserves its calm minute
 * however much room there is.
 */
export const FAN_RESTORE_AFTER_CUT_FAST_MS = 60_000;

/**
 * FAN BOUNCE COMPOUNDING (2026-08-08, invariant 67's shape one rung down). A fan
 * we handed back that is RE-CUT within this window bounced — the restore could
 * not survive — and each consecutive bounce DOUBLES the after-cut wait the NEXT
 * restore owes (base 120s → 240 → 480 → 960 cap; the fast path's 60s multiplied
 * the same way), so a fan that keeps re-crossing waits longer each time.
 *
 * It bites on PARTIAL-climb bounces — the fan re-cut before it reaches
 * `originalFan`, so the hold (and this counter) survives. A FULL restore releases
 * the hold on send (controller.ts) and resets the count, which is why the 60s
 * first-gear calm (`FAN_RESTORE_CALM_MS`), not this, is the primary guard against
 * the full-restore cascade. The counter resets when a restored fan survives past
 * this window, on a source change (the hold's timestamps go stale, so the next cut
 * lands outside it and resets), and on a manual/user fan change (the controller
 * releases the hold) — mirroring how the shed-side bounce episode ends on an
 * external ON (`clearBounces`).
 */
export const FAN_BOUNCE_WINDOW_MS = 180_000;
/** Ceiling on the compounded after-cut wait — a bounce ladder must not strand a fan forever. */
export const FAN_BOUNCE_AFTER_CUT_CAP_MS = 960_000;

/**
 * Confirm-or-resend window for a fan RESTORE step (2026-08-09, independent
 * review). A TCL `set_fan` shadow can lag from seconds to minutes before it
 * confirms, and the climb reads the OBSERVED shadow (`ac.fanSpeed`) to decide the
 * next gear — so an unconfirmed step re-proposes the SAME command on every
 * own-gear tick (~20s), each re-arming the fan debit and, via the pure-raise
 * deferral, standing an admissible raise down for the whole confirm lag on a
 * PHANTOM step. Mirror the confirm-or-resend the level/demote paths already use:
 * while our last step is unconfirmed (observed fan still below what we
 * commanded), hold this hold's climb until the window elapses, then resend once.
 * The send-side 30s dedupe (`lastFanSent`) only partially hides this — it is
 * keyed on a `trim`, not a `trim_restore` — and cannot stop the raise deferral,
 * which is decided in the pure planner.
 */
export const FAN_RESTORE_RESEND_MS = 60_000;

export interface FanHold {
  deviceId: string;
  /** Fan to eventually restore (0 = built-in auto). */
  originalFan: number;
  /** What the trim last commanded. */
  lastSetFan: number;
  heldAt: number;
  /**
   * This hold came from an over-limit CUT, so its restore owes the cut
   * cooldown. A gentle-restore hold does not: nothing was taken away, the fan
   * was merely pinned while the room came back, and the calm + ramp gates
   * already decide when it may be handed to the automation. Loaded holds
   * default to true — the persisted row is always a cut.
   */
  fromCut?: boolean;
  /**
   * When the last CUT landed — the anchor for `FAN_RESTORE_AFTER_CUT_MS`.
   * Distinct from `heldAt`, which is pinned to the FIRST cut of the episode and
   * must not move (it is the hold's identity). In-memory only, like `gentle`:
   * the persisted row has no column for it, and after a restart it falls back
   * to `heldAt` — which is always ≤ the real last cut, so a restored hold may
   * climb sooner than it would have, never later.
   */
  lastCutAt?: number;
  /**
   * When this hold's climb back began, or absent while it has not started. The
   * first gear pays the full `FAN_RESTORE_CALM_MS`; the rest of the same climb
   * pay `FAN_RESTORE_CONTINUE_CALM_MS`. Cleared by a fresh cut, so a new
   * episode always re-earns the long gate. In-memory only, like `lastCutAt` —
   * after a restart the climb simply starts over, which is the safe direction.
   */
  climbStartedAt?: number;
  /**
   * This restore was ADMITTED at the gentle PROBE price (steady floor draw),
   * not the learned plain cost — the controller's freshly-on projection must
   * re-price it at the same price admission charged (see restoreCostAmps;
   * disagreeing was the 2026-07-25 storm). Every gen restore pins the fan,
   * but only probe-priced ones set this. In-memory only: after a restart the
   * flag is lost and the projection falls back to the full learned cost,
   * which errs trip-safe.
   */
  gentle?: boolean;
  /**
   * Consecutive fan BOUNCES — a restore step RE-CUT within `FAN_BOUNCE_WINDOW_MS`
   * (the restore could not survive). Each doubles the after-cut wait the next
   * restore owes (capped at `FAN_BOUNCE_AFTER_CUT_CAP_MS`), so an oscillating
   * house stops cascading (2026-07-31). In-memory only, like `lastCutAt`: a
   * restart loses it and the ladder starts fresh (the safe direction). Reset by a
   * cut outside the window (the prior restore survived, or a source change staled
   * the anchor) and by a manual fan change (the controller releases the hold).
   */
  bounces?: number;
  /**
   * When the last restore STEP fired — the anchor a re-cut is judged a bounce
   * against, and the clock the survive-past-window reset reads. In-memory only.
   */
  lastRestoreAt?: number;
}

export type FanHolds = Readonly<Record<string, FanHold>>;

export function recordFanCut(holds: FanHolds, ac: AcView, target: number, now: number): FanHolds {
  const existing = holds[ac.deviceId];
  // A cut within FAN_BOUNCE_WINDOW_MS of the last restore STEP is a bounce: the
  // fan we just handed back re-crossed the limit. Compound the counter; a cut
  // OUTSIDE the window (the prior restore survived, or a source change staled the
  // anchor) or with no restore yet resets it to 0.
  const bounced =
    existing?.lastRestoreAt != null && now - existing.lastRestoreAt < FAN_BOUNCE_WINDOW_MS;
  return {
    ...holds,
    [ac.deviceId]: {
      deviceId: ac.deviceId,
      // The FIRST cut of an episode snapshots the fan to restore; later cuts keep it.
      originalFan: existing?.originalFan ?? ac.fanSpeed ?? 0,
      lastSetFan: target,
      heldAt: existing?.heldAt ?? now,
      fromCut: true,
      lastCutAt: now,
      // A new cut ends any climb in progress: the next one re-earns the full
      // anti-bounce window rather than inheriting a half-finished one.
      climbStartedAt: undefined,
      bounces: bounced ? (existing?.bounces ?? 0) + 1 : 0,
      // Consumed — the next restore step re-stamps it.
      lastRestoreAt: undefined,
    },
  };
}

/**
 * Record a fan hold for a gen restore (fan pinned to 1 on the power_on so the
 * range automation can't slam it to a hot-room smart-auto 3–7 while the
 * compressor is still ramping). The original is 0 (auto): hand the fan back
 * to the automation once a long sustained calm lets `planFanRestore` climb it
 * back in one jump. `probePriced` marks a restore admitted at the gentle
 * steady price instead of the learned cost — the freshly-on projection reads
 * it back as `hold.gentle` so re-pricing matches admission exactly.
 */
export function recordGentleRestoreHold(
  holds: FanHolds,
  deviceId: string,
  now: number,
  probePriced: boolean,
): FanHolds {
  return {
    ...holds,
    [deviceId]: {
      deviceId,
      originalFan: 0,
      lastSetFan: 1,
      heldAt: now,
      // Not a cut — no cooldown owed (see FanHold.fromCut).
      fromCut: false,
      gentle: probePriced,
    },
  };
}

export function releaseFanHold(holds: FanHolds, deviceId: string): FanHolds {
  if (holds[deviceId] == null) return holds;
  const next = { ...holds } as Record<string, FanHold>;
  delete next[deviceId];
  return next;
}

export interface FanRestoreStep {
  command: Command;
  /** True when this step reaches the original fan — the hold releases on confirm. */
  final: boolean;
  holds: FanHolds;
  /**
   * Journal text for this step's `fan_restore` decision. A fast-path step names
   * itself and shows the arithmetic that admitted it, because "the fan came all
   * the way back in one batch" and "the fan bounced" look identical in a command
   * log and are told apart only by what the budget was at the time.
   */
  action: string;
}

/**
 * Propose at most ONE fan-restore step. `headroomAmps` is the room under the
 * resting ceiling, and `flickerMarginAmps` is the supply-flicker MARGIN (the
 * LARGEST reverting excursion — the wobble a spender must survive, not the
 * accurate `flickerAmps` classification figure), which a fromCut admission below
 * is charged BEFORE the cost (a gentle pin is judged on bare headroom — see
 * `spendable`). Auto (0) originals restore in one
 * jump (the gear is indivisible — there is no "half of auto"); numeric originals
 * climb at most `FAN_RESTORE_MAX_STEP` gears, to the highest such target whose
 * learned cost fits, and nothing climbs until the last cut is
 * `FAN_RESTORE_AFTER_CUT_MS` behind us.
 *
 * Why the flicker charge (2026-08-06 13:12–13:34Z, user: "the fan keeps
 * bouncing"): the house sat saturated at the generator limit with a ~5A heater,
 * three rooms at their floors, and a measured flicker of 0.96A. Every level rung
 * was spent, so the reducer's only move was a fan — and the moment the meter
 * dipped, this function handed the gear straight back at `cost <= headroom` into
 * a mean sitting 0.7–1.1A under the ceiling. On a line that wobbles ±1A the
 * re-cross is arithmetic, so the cycle ran every ~5 min: Abdu's fan was
 * commanded 10× in 22 minutes, Abdullah's 5×. Every rule behaved as written;
 * together they were a limit cycle, which is a bug (SETTLE, don't bounce).
 * Charging the flicker is the whole mechanism — the bounded sweet-spot search
 * then parks at the highest gear that TRULY fits. The fromCut side pays it: a
 * reducer's over-limit trim handed straight back re-arms the identical cycle. A
 * gentle pin — admission pricing, never overload relief — is judged on bare
 * headroom instead (see `spendable` below, 2026-08-08). A quiet
 * line estimates 0 flicker (the estimator needs two reverting excursions of at
 * least FLICKER_MIN_AMPS before it reports anything), so this is byte-identical
 * to the old behaviour wherever the supply is stable — including grid, where
 * the flicker is ~0 and the headroom is huge anyway.
 *
 * The fast path (2026-08-06, later the same day) is the other side of that
 * bargain: a hold whose ENTIRE remaining swing fits with
 * `FAN_RESTORE_FAST_MARGIN_AMPS` to spare climbs home in one command and owes
 * `FAN_RESTORE_AFTER_CUT_FAST_MS` instead of the full anti-bounce window. Every
 * other gate is untouched in both paths — the 60s first-gear calm, the self-ramp
 * skip, the fan debit the caller arms at exactly the price admitted here, and
 * the fromCut/gentle distinction. It is judged per hold, on `spendable`, so on a
 * saturated line it simply never fires.
 */
export function planFanRestore(
  holds: FanHolds,
  acs: AcView[],
  opts: {
    calmMs: number;
    headroomAmps: number;
    /**
     * The supply-flicker MARGIN a fromCut restore must survive
     * (`MeterView.flickerMarginAmps`, the LARGEST reverting excursion) — 0 on a
     * quiet or stale line. NOT the accurate `flickerAmps` classification figure:
     * a fan handed back with only the runner-up of margin re-crosses on the
     * biggest spike and bounces (2026-08-06, invariant 58 / hard rule 5c).
     */
    flickerMarginAmps: number;
    book: CostBook;
    source: Exclude<PowerSource, "none">;
    now: number;
  },
): FanRestoreStep | null {
  // The calm gate AND the spendable budget are judged PER HOLD, not once for the
  // batch: a climb already under way asks a shorter question than one deciding
  // whether to start, and only a fromCut hold is charged the supply wobble.
  for (const ac of acs) {
    const hold = holds[ac.deviceId];
    if (hold == null || !ac.on) continue;
    // Never into this room's OWN ramp (2026-08-06 14:03:20Z). The gentle hold's
    // doc comment above already claims the fan is pinned "while the compressor
    // is still ramping" — but the release was only calm- and headroom-gated, so
    // Najat's fan went to auto 134 s into her own 240 s ramp and helped carry
    // the smoothed meter to 15.3 A, which re-shed her (and, fourteen seconds
    // later, a second room). A PEER's ramp is already charged through the
    // pipeline's `rampDebit` subtraction; nothing covered the self case,
    // because a room's own committed-but-unmetered draw is exactly what its fan
    // would be sitting on top of. Both hold kinds pay it: a fromCut hold
    // climbing back mid-ramp after a power event is the same physics.
    if (ac.ramping) continue;
    // First gear decides "may this fan come back at all" — the long anti-bounce
    // minute for a cut, the shorter GENTLE calm for a pin that was never cut.
    // Continuation gears only ask "has the last one landed" and pay the short
    // continue gate regardless of kind. All of it reads the fan path's OWN calm
    // clock (`opts.calmMs` is `fanCalmMs` at the call site), so a fan hold is not
    // queued behind another hold's fan step (2026-08-09, #11098-#11126).
    const firstGearCalm = (hold.fromCut ?? true) ? FAN_RESTORE_CALM_MS : FAN_RESTORE_GENTLE_CALM_MS;
    const gate = hold.climbStartedAt == null ? firstGearCalm : FAN_RESTORE_CONTINUE_CALM_MS;
    if (opts.calmMs < gate) continue;
    // …and a continuation gear also owes its OWN last-gear spacing (2026-08-09).
    // The fan calm clock now SURVIVES a fan-only spend — that is what stops fans
    // queueing behind fans — so `fanCalmMs` no longer rewinds when THIS hold's
    // own last gear landed, which is the "has the last one landed" clock the
    // continue gate used to ride on the shared reset. Without this a climb could
    // take a gear every tick. First gears (no climb yet) are unaffected.
    if (
      hold.climbStartedAt != null &&
      opts.now - (hold.lastRestoreAt ?? hold.climbStartedAt) < FAN_RESTORE_CONTINUE_CALM_MS
    ) {
      continue;
    }
    // Confirm-or-resend (2026-08-09, independent review). `current` below reads
    // the OBSERVED shadow, so while our last step is unconfirmed (the shadow is
    // still below what we commanded), a bare own-gear tick would re-emit the same
    // command every ~20s — re-arming the fan debit and deferring an admissible
    // raise on a phantom step. Hold the climb until the resend window elapses,
    // then let it propose again (the resend). First gears (no `lastRestoreAt`)
    // are unaffected, so a fresh cut still comes back on its own schedule.
    if (
      hold.lastRestoreAt != null &&
      ac.fanSpeed != null &&
      ac.fanSpeed < hold.lastSetFan &&
      opts.now - hold.lastRestoreAt < FAN_RESTORE_RESEND_MS
    ) {
      continue;
    }
    // Propose a step for the budget. Factored into a closure so the gates read
    // as one statement; the room a restore may actually spend is what the meter
    // shows, less the wobble the meter is going to show anyway — charged only to
    // a fromCut hold. The 2026-08-06 13:12Z fan bounce lived entirely on the
    // fromCut side (a reducer's trim handed straight back on a meter dip), which
    // is why the margin stays there; a gentle hold's pin was admission pricing,
    // not overload relief, and charging it the wobble was invariant 58's own
    // admitted regression axis, now user-confirmed (2026-08-08).
    const attempt = (spendable: number): FanRestoreStep | null => {
      const current = ac.fanSpeed ?? hold.lastSetFan;
      // What this hold still OWES, priced exactly as the branches below price
      // their own steps: an auto original is one indivisible 6-gear swing, a
      // numeric one is the gears that are left. When the room covers the whole of
      // it with FAN_RESTORE_FAST_MARGIN_AMPS to spare, the gear bound and the long
      // after-cut wait are guarding against a re-cross that cannot arithmetically
      // happen — so the climb goes home in one step and owes the short wait.
      const remainingGears = hold.originalFan === 0 ? 6 : hold.originalFan - current;
      const swingCost =
        remainingGears > 0 ? fanTrimSavings(opts.book, ac.deviceId, opts.source, remainingGears, opts.now) : 0;
      const fast = remainingGears > 0 && spendable >= swingCost + FAN_RESTORE_FAST_MARGIN_AMPS;
      // A gentle hold never owed the cut wait and its auto original was always one
      // jump, so "fast" changes nothing for it — the label would over-claim in the
      // journal. The GATE stays on `fast` either way; only the claim is scoped.
      const action =
        fast && hold.fromCut !== false
          ? `fan restore step (fast: ${swingCost.toFixed(1)}A swing, ${spendable.toFixed(1)}A spendable)`
          : "fan restore step";
      // Cut→restore hysteresis. A fan-only batch does not rewind the shared calm
      // clock, so without this the calm gate let a fan cut come all the way back
      // ~80s later and the over-limit episode simply repeated. Gentle-restore holds
      // are exempt: nothing was cut (see FanHold.fromCut).
      //
      // COMPOUNDED by consecutive bounces (2026-08-08): each doubles whichever wait
      // applies (fast or base), capped, so a fan that keeps re-crossing waits longer
      // each time instead of cascading (2026-07-31). A prior restore that SURVIVED
      // past FAN_BOUNCE_WINDOW_MS ends the episode — the count resets here, so the
      // fan is not penalised forever once the line settles.
      const survivedPriorRestore =
        hold.lastRestoreAt != null && opts.now - hold.lastRestoreAt >= FAN_BOUNCE_WINDOW_MS;
      const bounces = survivedPriorRestore ? 0 : hold.bounces ?? 0;
      const afterCutWait = Math.min(
        FAN_BOUNCE_AFTER_CUT_CAP_MS,
        (fast ? FAN_RESTORE_AFTER_CUT_FAST_MS : FAN_RESTORE_AFTER_CUT_MS) * 2 ** bounces,
      );
      if ((hold.fromCut ?? true) && opts.now - (hold.lastCutAt ?? hold.heldAt) < afterCutWait) {
        return null;
      }
      if (hold.originalFan === 0) {
        // Built-in auto: single indivisible jump, costed as a full swing — which
        // is `swingCost` above, the same 6 gears.
        if (swingCost <= spendable) {
          const holds2 = {
            ...holds,
            [ac.deviceId]: { ...hold, lastSetFan: 0, climbStartedAt: hold.climbStartedAt ?? opts.now, bounces, lastRestoreAt: opts.now },
          };
          return {
            command: { deviceId: ac.deviceId, kind: "set_fan", fan: 0, reason: "trim_restore" },
            final: true,
            holds: holds2,
            action,
          };
        }
        return null;
      }
      if (current >= hold.originalFan) return null; // already there; reconciler confirms & releases
      // Highest target whose cumulative step cost fits, BOUNDED to a few gears —
      // the bound is what makes this a climb rather than a swing (the unbounded
      // search always reached originalFan, because a 6-gear swing prices at ~0.9A).
      // A generous budget lifts the bound and the search collapses to its first
      // candidate, since `swingCost` is what made it generous in the first place:
      // one command home, not the same walk spread over batches and minutes.
      const reach = fast ? hold.originalFan : Math.min(hold.originalFan, current + FAN_RESTORE_MAX_STEP);
      let target = current;
      for (let candidate = reach; candidate > current; candidate--) {
        const cost = fanTrimSavings(opts.book, ac.deviceId, opts.source, candidate - current, opts.now);
        if (cost <= spendable) {
          target = candidate;
          break;
        }
      }
      if (target === current) return null; // not even one step fits
      const final = target === hold.originalFan;
      const holds2 = {
        ...holds,
        [ac.deviceId]: { ...hold, lastSetFan: target, climbStartedAt: hold.climbStartedAt ?? opts.now, bounces, lastRestoreAt: opts.now },
      };
      return {
        command: { deviceId: ac.deviceId, kind: "set_fan", fan: target, reason: "trim_restore" },
        final,
        holds: holds2,
        action,
      };
    };

    // The caller has ALREADY subtracted any shed-restore reservation from
    // `opts.headroomAmps`, and a fan restore may never spend those amps — not
    // even a single gear (2026-08-09, re-affirmed after independent review: while
    // a restore is in its send→confirm window the commanded compressor has no
    // ramp debit yet, so the reservation is the ONLY protection of the margin it
    // is about to land on). Here we only net the supply wobble on top.
    const step = attempt(opts.headroomAmps - ((hold.fromCut ?? true) ? opts.flickerMarginAmps : 0));
    if (step != null) return step;
  }
  return null;
}
