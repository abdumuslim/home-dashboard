---
name: ac-leveling
description: Use when working on Smart AC Leveling — the power budget, raises/reductions, shed and restore, breaker limits, gen/grid changeover, per-AC calibration or the cost model. Read this BEFORE opening docs/agent/ac-leveling.md; that doc is ~49k tokens and most of it is superseded v1 history you almost certainly do not need.
type: Skill
title: Smart AC Leveling — navigation + invariants
tags: [home, leveling, power, claude-code, current]
maintainer: claude-code
timestamp: 2026-07-31
---

# Smart AC Leveling

⚠ **`docs/agent/ac-leveling.md` is ~176 KB / ~49k tokens — do NOT read it whole.** The doc states
plainly: *"Everything below the 'TL;DR (v1)' divider documents v1 — historical, rollback-only."*
Read the v2 section plus the one or two `##` sections your task actually needs (grep the heading, then
read that slice).

## Current state

**v2 is the ACTING controller** since the 2026-07-24 cutover — config `controller: "v2"` in
`ac_leveling_config` **row id=2** (v1's save path would clobber unknown fields in row id=1, so v2 owns
its own row; merged with id=2 winning; re-read every 30 s ⇒ **live-flippable**).

Implementation: **`server/src/leveling/`** — 19 small modules, pure decision functions + one stateful
shell. `controller: "v1" | "shadow" | "v2"`; in `shadow`, v1 acts while v2 journals every decision
with `executed=false`.

**Rollback** = `PUT /api/ac/leveling` with `controller:"v1"` + `docker compose restart` (v1's
boot-once state is stale after v2 acted). v1 (`ac-leveler.ts` + `ac-leveling.ts`) is kept ONLY as the
rollback target.

## Invariants — do not break these

**Added 2026-07-26 after three gen trips in 25 minutes:**
1. **The meter is not a valid budget anchor while a compressor is ramping.** Every spender (raise,
   restore, fan restore) is charged the committed-but-unmetered draw of ramping peers on gen.
2. **The CONFIGURED limit is not the limit.** A breaker that just tripped is derated for 20 min — all
   limit math goes through **`effectiveLimit()`, never `limitFor()`**.

**Physics-envelope veto (GEN only, `raise.ts` `envelopeTotalAmps`):** refuse a raise/restore when the
worst-case cap-model total of the commanded end-state exceeds `limit − margin`, regardless of the
meter. Meter-anchored admission is blind to ramp lag and to frozen readings. Grid is deliberately NOT
envelope-guarded (grid starts FULL by directive; the reducer is the safety). Since 2026-07-31 a RAISE
is additionally charged the measured non-AC house load (`RaiseInput.nonAcAmps`, invariant 16);
restores stay on the AC-only figure.

**Frozen-meter detection (`sensing.ts`):** a live CT always micro-jitters. If neither raw channel
moves ≥ `FROZEN_EPSILON_AMPS` (0.005) for `METER_FROZEN_AFTER_MS` (60 s), the meter is frozen — calm
is killed so nothing can spend on a stale value. Reductions still act (safe direction).

**Added 2026-07-27 evening after a restore→shed bounce loop + a bogus manual-off lock:**
3. **Gen restores are admitted at the PLAIN learned on-cost** (max of model and `on@L` EWMA) — the
   fan-pin does NOT shrink compressor draw. One gentle-priced **probe** is allowed only while
   `restoreFailures === 0`; the fan hold's `gentle` flag = "probe-priced" and the projection must
   re-price exactly what admission charged. A lone shed's off-drop grades `on@L{level}` (negated).
4. **Shed clears on the CONFIRMED shadow ON, never at power_on send** — the send-to-confirm lag
   (5.8s–13 min) is when the collector's observed-off classifier minted a bogus manual-off lock.
   In-flight restores are parked by the `awaiting confirm` gate (60s, then confirm-or-resend).

**Added 2026-07-28 after both remaining ACs sat shed through a blackout that never happened:**
5. **A drop we commanded is not a breaker trip.** Every reducing batch credits the meter with its own
   priced saving (`noteCommandedCut()` → `MeterState.pendingCut`); a collapse latches only on the
   part of the fall that credit does NOT explain. With a cut live the fall is judged from the
   **anchor** (the meter when cutting began), because median smoothing spreads one cliff over several
   readings; absorption ratchets on the **smoothed** meter and the credit expires after
   `PENDING_CUT_MS` (180 s).

6. **A cost sample must outlive the compressor.** `GRADE_LEVEL_MS` (45 s) < `AC_RAMP_MS` (240 s) meant
   every level-raise sample measured a fifth of the ramp (32/33 graded gen raises came in below their
   price; the book showed MORE samples ⇒ LOWER cost). `PendingGrade` now has a separate **`learnAfter`**
   (full ramp) beside `compareAfter` (journal only), the sample is a **ratcheted peak**, and
   contamination is **direction-aware** (`batchLoadDirections()`) so a 4-min window is affordable.

**Added 2026-07-28 evening after a satisfied room held 6.3 A of a 15 A gen while a hotter room sat at L1:**
7. **The envelope prices peers at every level the firmware MIGHT be at**, not the confirmed shadow —
   `AcView.envelopeLevel = worstCaseLevel([confirmed, ...unconfirmedLevels()])` (level 0 outranks L3).
   Use `sendCounts`, **never `pendingLevel`** (one slot; a demote overwrites the raise still in flight
   and re-opens the hole). TTL `UNCONFIRMED_SEND_TTL_MS` 25 min > the ≥15.8-min observed confirm lag.
   `currentLevel` stays observation-only — that is what stops a lagging write minting a manual intent.
8. **A satisfied room does not keep dormant levels** (the v1 "loaded spring", built in v2 as
   `demote.ts`). Above `ceilOf` + satisfied for `DEMOTE_DWELL_MS` (120 s) at `needDelta ≤ band − 0.2`
   → one `set_level` straight to the ceiling. BOTH sources. Need-triggered, never amps-triggered, so
   the reduce trigger is untouched. Parks under a restore reservation; `DEMOTE_RESEND_MS` 60 s.
9. **Never spend a saving that has not landed.** The funding swap is **split by blocker**:
   envelope-blocked + meter already holds the amps → same batch; **meter-blocked → demote ALONE**,
   raise next calm window. A satisfied compressor throttles down over minutes; the breaker tripped at
   15.65 A on 2026-07-26.
10. **Dormant levels are not comfort.** The +25 `topPriority` surcharge applies only to cuts ending
    BELOW that AC's `ceilOf` (else it protects a cool room over a hot one — the tier-down version of
    the complaint 2026-06-13 fixed for sheds).
11. **One credit path, model-priced.** `Plan.commandedCutAmps` (every load-lowering batch shape) is
    the sole input to `noteCommandedCut()`, priced at the MODEL steady delta — `max(model, learned)`
    over-credits ~2× for satisfied rooms and can mask a real collapse. Demand side: `pressure.ts`
    subtracts the live credit from `requiredAmps` (and from the EXTREME tier).
12. **A level raise commits unmetered amps too.** Raises never arm `ramping`, so gen raises now arm
    `AcView.unmeteredJumpAmps` (priced jump, absorbed-ratcheted, `AC_RAMP_MS`) which `rampDebitAmps`
    charges to the next spender — the 2026-07-26 back-to-back-raise trip shape. Not double-charged
    for a ramping AC. Consequence: a fan restore waits behind a fresh raise (deliberate).

**Added 2026-07-30 after a room turned on at L3 on a 15 A gen, and two gen trips 26 min apart:**
13. **A gen turn-on is not an admission.** The TCL restores the level it was last left at, and since
    GRID_FULL that is **L3** (6.3 A). FLOORS only arms on *entry* into gen and ends in ≤5 min, so it
    does not cover a room switched on later. `START_WINDOW_MS` now opens on BOTH sources — grid LIFTS
    to the affordable ceiling, gen CLAMPS to `floorOf` via `invariantCorrections` (ships in every
    non-COLLAPSED mode; a reduction, so it can never fight the reducer) — and `planRaise` stands down
    for that device (`blockedBy: "gen start floor"`), or the raise wins the dedupe and hands the room
    straight back. The over-limit start-window clear is **grid only**: on gen a turn-on is over-limit
    by definition, so clearing retires the clamp on the tick it is needed.
14. **Price a turn-on at the level it is REALLY at.** The freshly-on projection charged `floorOf` —
    assuming the policy in 13 that did not exist — and sized the cut at 1.2 A when the honest deficit
    was 4.6 A, small enough for the reducer to pay out of the newcomer and never touch a peer. Now
    `envelopeLevel` (our own clamp does not shrink it before it confirms), held across the ramp with
    absorption instead of one tick. Scope needs BOTH `ramping` (past the ramp the meter has it —
    charging on top is a permanent phantom overload) and the start window (`ramping` alone is re-armed
    for every AC on a changeover). A leveler restore still prices `restoreCostAmps(floor, {gentle})`.
15. **A derate is handed back in steps, never in one jump.** The 20-min cliff restored full rating and
    the leveler re-spent it **2 seconds later**; `standing` was 0 by then, so the repeat trip re-armed
    at 1.0 A instead of compounding. `derateFor()` is a pure function of time, decaying one
    `COLLAPSE_DERATE_RECOVERY_STEP` (0.5 A) per quiet rung. Recovery does not need readings (an idle
    line cools fastest) but is still per-source.

**Added 2026-07-31 after a gen trip that followed ten minutes of riding the limit:**
16. **The physics envelope must count the HOUSE.** `envelopeTotalAmps` is AC-caps-only and priced
    `{Abdullah L3, Najat L1, Abdu L1}` at 13.9 A against a 14.9 A ceiling; the journal measured that
    exact end-state at **15.93–15.99 A**. `house-load.ts` keeps a rolling per-source **PEAK** of
    `smoothed − Σ modeled draw of running ACs`, skipped while anything ramps and **tagged with the
    running-AC set** (a residual sampled while a room was off counts that room as house, and would
    double-count it on its return). `RaiseInput.nonAcAmps` adds it to RAISES only — a shed restore
    stays AC-only, because refusing one strands a room off and its meter gate already sees the house.
    This is also what carries memory across a **trough**: the fatal raise was admitted at 9.91 A when
    that configuration's steady state had been 12.4–13.3 A for ten minutes.
17. **Levels before fans, judged per PLAN — never globally.** The floor gate was per-AC, so a room at
    its own floor offered its fan while a peer still held a level, and the comparator took the fan
    every time (`w.fan` 1 vs `w.levelStep` 10 ⇒ cost 4.6 vs 140 live). A candidate plan may now cut a
    fan only if **its own end-state** leaves every AC at its floor. ⚠️ Do NOT "simplify" this to *no
    fan while any level exists anywhere* — that forces a **power_off** whenever levels alone fall
    short of the deficit, which inverts the user's own "fans are the last try BEFORE turning off"
    (guard: `reduce.test.ts` "combines a level cut WITH a fan trim rather than shedding a room").
18. **A fan restore SPENDS; a fan cut does not.** A restore emitted one `set_fan`, reported
    `commandedCutAmps: 0`, armed no debit and was `fanOnly` so it skipped `resetCalm` — both fatal
    raises landed 12 s and 17 s after one. Restores now arm `fanDebit` (priced at exactly what
    `planFanRestore` admitted, absorbed-ratcheted, `FAN_DEBIT_MS` 60 s) **and** reset calm; cuts still
    do neither (a cut frees amps — stalling the reducer behind its own cut is how episodes drag).
    The climb is bounded to `FAN_RESTORE_MAX_STEP` (2 gears) and owes `FAN_RESTORE_AFTER_CUT_MS`
    (180 s) since the last cut; gentle-restore holds are exempt via `FanHold.fromCut: false`.
    The old "sweet spot" search always reached the original — a 6-gear swing prices at ~0.9 A.
19. **The drain rung was too coarse to catch a 0.9 A overload.** 15.93 A on a 15 A limit is under
    `OVER_LIMIT_SEVERE_AMPS` (1.0), so it drained 1 point per reading — **52 s** to the first act —
    and `noteActed` then refilled the bucket to FULL, costing another **38 s**. Now
    `OVER_LIMIT_DRAIN_MODERATE` (2 points above `OVER_LIMIT_MODERATE_AMPS` 0.5 A) and
    `OVER_LIMIT_BUDGET_AFTER_ACT` = `OVER_LIMIT_DRAIN_SEVERE + 1` (**4**, not 5).
    ⚠️ **The post-act bucket must stay ABOVE the severe drain.** Shipped at 2 and double-shed within
    20 minutes: one lingering severe reading — still inside the 4-wide smoothing window from before
    the FIRST shed landed — emptied it alone and shed a second room at a smoothed 12.555 A. The
    `commandedCutCreditAmps` credit cannot cover this case; the fall that reading preceded had already
    absorbed the credit in full.

⚠️ **`scenario.ts` mirrors the shell's projection and start-window bookkeeping** — and since
2026-07-31 also the **house-load sampling, the fan debit, calm-on-fan-restore, and the partial bucket
refill**. The harness must MEASURE the non-AC split off the simulated meter, never be handed the sim's
ground-truth `nonAcAmps`. That mirror is what
hid bug 14 for five days: the harness priced a turn-on at its real level while the shell priced the
floor, so no harness test could disagree with the shell. Anything you change in one, change in the
other — and put the guard in `controller.test.ts`, not only `scenarios.test.ts`.

**Hard rules preserved from v1:** never level 0 · manual wins · slot caps · boost floors ·
shed ≠ manual-off · warm restore · opt-out · collapse latch · leaky bucket ·
requireShed ≥ max(3 A, 20%).

**Mode machine:** COLLAPSED > FLOORS > GRID_FULL > SETTLING > NORMAL. FLOORS arms on ANY entry into
gen (incl. cold start); GRID_FULL on any entry into grid.

**Fans are last-resort trim only** — a plan may cut a fan only if its end-state leaves EVERY AC at its
floor (invariant 17); restores are bounded and cooldown-gated (invariant 18). (v1 cut fans while level
cuts were available 57% of the time and bounced them at 61 s median; v2 reproduced the bounce at 80 s
until 2026-07-31.)

## Hardware truth (2026-07-23, user-verified)

Abdu = **2-ton** (≈ 4.1 / 6.5 / ~9 A at L1/2/3). Abdullah & Najat = **1-ton** (≈ 2.2 / 3.9 / 5.3 A).
⚠ The registry `model` field is protocol-inference only — **its capacity digits are WRONG** (see
`docs/agent/tcl-ac.md`).

## Navigating the doc

Grep the heading, read only that section. Ordered roughly by how often it is needed:

| Need | `##` section |
|---|---|
| what's acting now, v2 design, cutover | `⚡ LEVELING v2 (ACTING since 2026-07-24 cutover)` |
| thresholds and tunables | `Constants table` |
| **why a thing is the way it is — read before changing behaviour** | `User decisions log (don't re-litigate)` |
| test harness, known traps | `Gotchas & test notes` |
| per-AC amp learning | `Per-AC calibration` |
| the allocator itself | `Pure allocator (computeAllocation())` |
| stateful shell + REST surface | `Stateful layer & API (ac-leveler.ts)` |

Everything else (`Raise hysteresis buffer`, `Bounce detection`, `Emergency reduction fast-path`,
`Meter-anchored overhaul`, `One-step + learned-surge gen raises`, and the other dated sections) is
**v1 lineage** — read only for a rollback or to understand why v2 rejected an approach.

## Forensics & tests

- **Journal:** `GET /api/ac/leveling/journal?hours=24` — every batch journaled + outcome-graded in
  `ac_leveling_journal`. Durable; docker logs rotate in ~1.5 days, so prefer the journal.
- **Cost model:** `ac_leveling_costs`, per device × source × transition EWMA. Survives deploys; config
  saves do NOT wipe it. Explicit reset: `POST /api/ac/leveling/costs/reset`.
- **Tests:** `server/src/leveling/*.test.ts` — `scenarios.test.ts` replays incident regressions against
  the physics harness (`scenario.ts`), plus `controller.test.ts` and `pipeline.test.ts`.

Related: `docs/agent/ac-automations.md` (rules, hysteresis, manual-off locks) ·
`docs/agent/tcl-ac.md` (cloud protocol, model quirks).
