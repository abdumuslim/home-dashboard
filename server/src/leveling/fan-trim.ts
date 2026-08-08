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
 * Sustained calm required before a held fan starts climbing back. Kept short
 * (2026-07-24, user "make the fan restoration faster") — the bounded climb
 * below is what stops a 1↔full swing, so a fast gate just returns comfort
 * sooner once the meter is calm.
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
 * episode ended). Still comfortably past the 60s first-gear calm gate plus the
 * meter's smoothing window, and a fresh cut restarts it — the anti-bounce
 * argument is unchanged, the episode tail is a minute shorter.
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
 */
export const FAN_RESTORE_FAST_MARGIN_AMPS = 1.0;

/**
 * The after-cut wait a GENEROUS hold owes instead of `FAN_RESTORE_AFTER_CUT_MS`.
 * Still past the meter's smoothing window and still restarted by a fresh cut —
 * the anti-bounce argument is unchanged, it is just priced against a budget in
 * which the re-cross is arithmetically impossible. The 60s first-gear calm gate
 * is NOT shortened: "may this fan come back at all" deserves its calm minute
 * however much room there is.
 */
export const FAN_RESTORE_AFTER_CUT_FAST_MS = 60_000;

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
}

export type FanHolds = Readonly<Record<string, FanHold>>;

export function recordFanCut(holds: FanHolds, ac: AcView, target: number, now: number): FanHolds {
  const existing = holds[ac.deviceId];
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
 * resting ceiling, and `flickerAmps` is the live supply flicker, which a fromCut
 * admission below is charged BEFORE the cost (a gentle pin is judged on bare
 * headroom — see `spendable`). Auto (0) originals restore in one
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
    /** Live supply flicker (`MeterView.flickerAmps`) — 0 on a quiet or stale line. */
    flickerAmps: number;
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
    // The room a restore may actually spend: what the meter shows, less the
    // wobble the meter is going to show anyway — but the wobble is charged only
    // to a fromCut hold. The 2026-08-06 13:12Z fan bounce lived entirely on the
    // fromCut side (a reducer's trim handed straight back on a meter dip), which
    // is why the margin stays there; a gentle hold's pin was admission pricing,
    // not overload relief, and charging it the wobble was invariant 58's own
    // admitted regression axis, now user-confirmed (2026-08-08).
    const spendable = opts.headroomAmps - ((hold.fromCut ?? true) ? opts.flickerAmps : 0);
    // First gear decides "may this fan come back at all" — the long anti-bounce
    // minute for a cut, the shorter GENTLE calm for a pin that was never cut.
    // Continuation gears only ask "has the last one landed" and pay the short
    // continue gate regardless of kind.
    const firstGearCalm = (hold.fromCut ?? true) ? FAN_RESTORE_CALM_MS : FAN_RESTORE_GENTLE_CALM_MS;
    const gate = hold.climbStartedAt == null ? firstGearCalm : FAN_RESTORE_CONTINUE_CALM_MS;
    if (opts.calmMs < gate) continue;
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
    // clock, so without this the 60s calm gate let a fan cut come all the way
    // back 80s later and the over-limit episode simply repeated. Gentle-restore
    // holds are exempt: nothing was cut (see FanHold.fromCut).
    if (
      (hold.fromCut ?? true) &&
      opts.now - (hold.lastCutAt ?? hold.heldAt) <
        (fast ? FAN_RESTORE_AFTER_CUT_FAST_MS : FAN_RESTORE_AFTER_CUT_MS)
    ) {
      continue;
    }
    if (hold.originalFan === 0) {
      // Built-in auto: single indivisible jump, costed as a full swing — which
      // is `swingCost` above, the same 6 gears.
      if (swingCost <= spendable) {
        const holds2 = { ...holds, [ac.deviceId]: { ...hold, lastSetFan: 0, climbStartedAt: hold.climbStartedAt ?? opts.now } };
        return {
          command: { deviceId: ac.deviceId, kind: "set_fan", fan: 0, reason: "trim_restore" },
          final: true,
          holds: holds2,
          action,
        };
      }
      continue;
    }
    if (current >= hold.originalFan) continue; // already there; reconciler confirms & releases
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
    if (target === current) continue; // not even one step fits
    const final = target === hold.originalFan;
    const holds2 = {
      ...holds,
      [ac.deviceId]: { ...hold, lastSetFan: target, climbStartedAt: hold.climbStartedAt ?? opts.now },
    };
    return {
      command: { deviceId: ac.deviceId, kind: "set_fan", fan: target, reason: "trim_restore" },
      final,
      holds: holds2,
      action,
    };
  }
  return null;
}
