---
name: ac-leveling
description: Use when working on Smart AC Leveling — the power budget, raises/reductions, shed and restore, breaker limits, gen/grid changeover, per-AC calibration or the cost model. Read this BEFORE opening docs/agent/ac-leveling.md; that doc is ~49k tokens and most of it is superseded v1 history you almost certainly do not need.
type: Skill
title: Smart AC Leveling — navigation + invariants
tags: [home, leveling, power, claude-code, current]
maintainer: claude-code
timestamp: 2026-08-04
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

Implementation: **`server/src/leveling/`** — 21 small modules, pure decision functions + one stateful
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
   15.65 A on 2026-07-26. Since 2026-08-08 the meter-blocked demote MAY ship
   same-batch with its raise when the freed amps close the gap with
   `REBALANCE_FUND_MARGIN_AMPS` to spare (69); the deferred demote-alone path
   remains the fallback.
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
    **The absorption that retires these debits is ONE SHARED POOL (2026-08-05,
    `absorbedSharesAmps`), never the whole rise per room.** A compressor's arrival
    is a whole-house delta; reading it per AC and summing the leftovers spends the
    same amps against every debit at once — live, a 5.82 A rise cancelled 4.1 A of
    one room AND 4.5 A of another, reporting 8.6 A of committed compressor as fully
    absorbed, and a restore went into that hole. ⚠️ The old comment called this
    "counted twice … errs toward not spending" and **had the sign backwards for
    months**: crediting one rise to every ramp does not raise the debit, it SINKS
    it — the trip direction, and this invariant's own premise inverted. The house
    rose once, so it can only pay once. Per-AC cap = its own ratcheted rise; total
    ≤ the max of those (the whole episode's rise, monotone so a dip cannot
    un-absorb); apportioned proportional to each ramp's priced commitment (`AcView`
    has baselines but not arm times, so "oldest first" would have to infer order
    from a baseline VALUE — true only while the meter rises); leftover NOT
    redistributed, because under-crediting only makes a spender wait.
    ⚠️ STILL OPEN: `unmeteredJumpAmps` and the fan debit reach the pure layer
    PRE-NETTED by the shell, so two settled rooms with live jump debits still each
    credit the same rise. Needs the gross debit + baseline on `AcView`.

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
    (**120 s** since 2026-08-05, user request; was 180 s) since the last cut; gentle-restore holds
    are exempt via `FanHold.fromCut: false`.
    The old "sweet spot" search always reached the original — a 6-gear swing prices at ~0.9 A.
    Since 2026-08-03 only the FIRST gear pays the 60 s anti-bounce window; the rest of the same climb
    pays `FAN_RESTORE_CONTINUE_CALM_MS` (20 s), tracked by `FanHold.climbStartedAt` and cleared by any
    fresh cut. Charging the long gate per gear made a six-gear recovery three batches minutes apart,
    and since each step rewinds calm the RAISE path was starved for the whole climb (live 05:16:29 /
    05:17:33). The long gate answers "may this fan come back at all"; a climb in progress only needs
    to know the last gear has landed.
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

**Added 2026-08-01 after a turn-off froze the raise path for 14 min (the predicted 07-31 limitation):**
20. **A modeled DROP pauses house sampling.** Turn-off, shed, and level cut share one physics — the
    model falls instantly, the meter follows over the wind-down plus the smoothing window — and every
    tick in between reads the dying draw as house. Live 17:27: Abdullah's off booked **7.1 A of
    "house"** (real ~4.1 A), the only sample tagged with the new set, hence the 15-min peak; every
    raise refused at "worst case 16.2 A > 14.9 A" on an 11–12 A meter until the user acted by hand.
    Now any drop of the modeled total (> 0.05 A) pauses sampling `HOUSE_SAMPLE_COOLDOWN_MS` (2 min,
    re-armed by a second drop), and while the new set has no samples `houseLoadAmps` carries the peak
    among **superset-tagged** samples (a set that modeled every room now running cannot double-count
    anyone; a sample missing a running room is still never reused). Raises need no cooldown — the
    model rises ahead of the meter and a dipped residual never wins a max. This fix is also what lets
    invariant 21's funding demote work: its wind-down would otherwise book phantom house and block
    the raise it funded. The SHELL additionally holds off sampling for one cooldown after BOOT
    (`firstTickAt`, mirrored as `scenario.ts` `firstStepAt`) — the first post-deploy tick sampled
    half-loaded views and booked 11.1 A of "house"; the guard lives at the call site so the pure
    layer keeps first-sample semantics.
21. **The extra level follows the hotter room — floor receivers only, noise-proof funding.** The
    07-28 funding swap only harvested SATISFIED donors, so a warm room (above the band ⇒ ceilOf =
    max) held its spare level while a hotter room sat at its floor (user ask, 2026-08-01).
    `rebalanceDonorsFor` (raise.ts): donor is unpinned, unramping, above ITS floor, and
    `REBALANCE_NEED_GAP_C` (0.7 °C) cooler than the raiser; ONE step per trade, coolest first.
    ⚠️ Two guards are load-bearing, both caught by the acceptance suite before shipping: the
    **receiver must sit at its floor** (an above-floor receiver endlessly milked a milder peer for a
    step it could never fund), and donors join only when the raise fits AFTER the cuts land with
    `REBALANCE_FUND_MARGIN_AMPS` (0.5 A) to spare — a deficit read off a ±0.5 A-noisy meter armed a
    trade on every dip and bounced the level donor↔receiver at a 35 s period. Invariant 9's split by
    blocker is unchanged; satisfied harvest keeps its old unconditional behavior.

**Added 2026-08-02 after Najat sat shed 17 min with room on the meter (user rescue):**
22. **A bounce is evidence about the house it bounced IN, not the house forever.** The probe was
    once-per-source-session; after it bounced at a committed 11.9 A, the meter spent 17 min at
    10.8–11.2 A — under what even the REAL cost needed — while the plain learned price (4.12 A,
    itself stale-high) refused every restore by 0.2–0.4 A. Restore attempts now record the committed
    meter admission saw (`AcPacing.attemptMeterAmps`); `probeRearmed()` re-arms one probe when the
    committed meter sits ≥ `PROBE_REARM_DROP_AMPS` (1.0) below that anchor. Each retry re-anchors
    LOWER (bounded by physics) and still rides the backoff ladder. `noteFailure` must keep the
    anchor — the failure is what makes it matter; `noteSuccess` clears it.
23. **A cost sample must be attributable to its own batch — at BIRTH, not just later.** The
    `contaminated` sweep only caught a LATER batch moving into an open window; the 11:20:41 shed was
    born 5 s after a peer's cut and graded the peer's still-landing fall into `on@L1` (−4.03 vs
    −2.3 true) — the inflated price is what invariant 22 then hit. The shell stamps
    `lastLoadAddAt`/`lastLoadDropAt` per executed batch (fan steps excluded) and a single-command
    window born inside `LEARN_SETTLE_DOWN_MS` (120 s) of a drop — or `LEARN_SETTLE_UP_MS`
    (= `AC_RAMP_MS`) of an add — is born contaminated: journals, resolves attempts, never learns.
    Consequence, deliberate: in a batch train only isolated events learn (the last window of a train
    used to absorb every predecessor's tail — Abdu's gen `level:1>2` at 3.97 A over 50 samples).
    Same "residual while model and meter are out of step" class as invariants 5b and 20.

**Added 2026-08-02 (evening) after a room was shed five times in 15 min, then the TOP-priority room three times in 10:**
24. **A generator is not a stable line, so the meter's MEAN is the truth about
    load and a raw spike is not.** `flickerAmps()` (sensing.ts) estimates supply
    flicker as the **second-largest REVERTING excursion** in the ring: a jump
    counts only if the signal comes back within `FLICKER_REVERT_WINDOW` (2)
    readings to within `FLICKER_REVERT_FRACTION` (0.5) of its origin, and a
    qualifying excursion contributes both its legs. ⚠️ It shipped 2026-08-02 as
    "second-largest jump", whose safety argument (a spike is two jumps and
    survives; a real step is one jump and is filtered) holds only while the ring
    contains at most ONE event — **two compressors cycling inside eight readings
    is the ordinary steady state of this house**, and it pinned the estimate at
    its cap, loosening severity, calm, the drain rung and the deficit sizing at
    once. A monotonic ramp (or a shed's own wind-down) read as its per-reading
    step for the same reason. The ring is also forgotten after a discontinuity
    (`flickerSamples`: ESP gap, collapse latch, recovery) — tolerance was at its
    maximum for the ~8 readings after a breaker proved it could not hold. Both
    legs are counted because dropping the return leg made the estimate collapse
    to the baseline wobble whenever the newest reading WAS the spike. Rounds to 0
    below `FLICKER_MIN_AMPS` (0.2) and caps at `FLICKER_MAX_AMPS` (1.5); needs
    `FLICKER_MIN_SAMPLES` (6) ring readings, so a fresh boot or source change is
    never more permissive than before it existed. Three consumers: the bucket
    drain classifies on `max(raw − limit − flicker, smoothedOver)`, **calm is
    judged on the SMOOTHED meter** (raw spikes no longer break it — that was the
    one-way ratchet: every spike drained the bucket and killed the calm that
    refills it, so a house whose mean sat 0.3 A UNDER the limit still lost a
    room), and `isSevereOverReading()` is the single severe definition shared
    with `pressure.ts`. ⚠️ The smoothed overshoot is NEVER discounted — that is
    what keeps a real overload's latency unchanged. A load step-up still breaks
    calm immediately via `rawIsSupplyNoise` (it reads as low flicker), so the
    median's lag — 2 readings then, 4 since `SMOOTH_WINDOW` widened to 8 on
    2026-08-05 — cannot refill the bucket it just drained.
25. **A comfort floor is a preference; being switched off is worse than any
    level.** The ladder gained a rung: levels → floor → fans → **sub-floor
    levels (to L1, never 0)** → off, priced by `w.subFloorStep` (40, between fan
    1 and shed 100). Live: the top-priority room sat at its L2 boost floor with
    both peers at L1 and fans at 1, so a 1.14 A deficit had only a 0.6 A fan
    trim or a 4.8 A power_off — and took the power_off, three times.
    ⚠️ **`invariantCorrections` must NOT re-assert the boost floor.** Buying a
    comfort floor back is SPENDING and belongs to the raise path (`ceilOf` is
    never below `floorOf`, so it targets the floor once affordable). Re-asserting
    it there — even gated on calm — is a limit cycle: cut frees amps, floor jumps
    back, meter goes over, cut again (six times in 30 min in the acceptance run).
26. **One room at a time, unless the arithmetic says one cannot do it.** The
    reducer searches with a one-shed ceiling and raises it only when nothing at
    that ceiling covers the deficit (user: "turn off one by one … unless the pump
    is big that already need more than one"). Live 16:51 both rooms went off in
    ONE batch for a deficit either covered alone; bringing them back one by one
    then leaves each room heating with its compressor off.
27. **A cut that has not reached the meter is late, not absent — and a fan trim
    is a cut.** `commandedCutAmpsOf` priced `set_fan` at **zero** while the
    planner claimed 0.5–0.6 A, so no credit armed, `requiredAmps` never shrank,
    and the next evaluation escalated. Fan trims are now credited at exactly what
    the planner claimed. Plus `escalationHold` (mild + SETTLING + live credit)
    holds the SHED rung only, and the collector drops a queued re-run inside
    `LEVELING_RERUN_MIN_MS` (2.5 s) so a follow-up always sees a fresh reading.
    Send-side dedupe now covers `set_fan`/`power_off` (30 s), which only
    `set_level` had. Live: trim at 16:55:29 → two rooms shed at :34 and :35.
28. **An unconfirmed ON — ours or external — poisons the house residual.**
    `runningSetOf` keys off the cloud shadow, so a room physically drawing with a
    lagging shadow books its whole compressor as "house", tagged with the set
    that EXCLUDES it (the set that recurs on every re-shed) — 6.0 A observed vs
    ~2.7 A real, refusing every raise for 15 min. `AcView.ramping` is
    shadow-gated too, so the existing ramp guard never covered send→confirm.
    Now: `pendingOn` stands house sampling down until the shadow confirms, and
    `voidSamples()` retro-drops without-set samples on discovery
    (`EXTERNAL_ON_VOID_MS` = the full 15-min window when there is no anchor).
    Rise-side twin of invariants 20 and 23.
29. **A negated `on@L` grade needs a SETTLED compressor.** A lone shed of a room
    still inside its own ramp/start window learns peak-minus-trough, not the
    room's cost — and `turnOnAmps` takes `max(model, learned)`, so the inflation
    is one-way and sticky for 30 days. `bornContaminated` now checks BOTH
    settle clocks for BOTH window directions (a room's own restore stamps the ADD
    clock, which used to leave its bounce shed "born clean"), external turn-ons
    stamp `lastLoadAddAt` (`batchLoadDirections` only sees our own commands), and
    `GRADE_TURN_ON_MS` moved 270 s → **315 s** so a success can never reset the
    ladder (and clear invariant 22's probe anchor) before the 300 s blame window
    closes.

30. **A funding donor may not take its donation back.** The demote that funds a
    peer's raise ships ALONE by design (invariant 9) — but a compressor takes
    seconds to minutes to throttle down, and for that whole window the RECEIVER
    still reads "not enough headroom" while the DONOR's own step is cheaper and
    higher in priority. So the donor is first in line for the amps it just gave.
    Live 2026-08-02 17:06–17:33: Najat cycled L1↔L2 every ~45 s, six times,
    while Abdu — the room the demote was paying for — never climbed at all.
    `FUNDING_COOLDOWN_MS` (120 s) bars the donor from re-taking that level:
    long enough for the cut to land plus a calm window, short enough that a
    receiver who still cannot afford it simply hands the level back.
    ⚠️ Stamp only donors whose demote was actually **sent** (the filtered
    command list), not the plan's wish list.

**Added 2026-08-03 after TWO generator breaks the evening the flicker rework shipped, neither latched:**
31. **The residual is the HOUSE, and the house is not a constant.** The collapse
    latch required `measured ≤ POWER_COLLAPSE_FLOOR_AMPS` (5) — an absolute
    floor that silently assumed everything but the ACs draws under 5 A. Live
    17:39 and 17:45 the AC circuit died on a 15.6–16.0 A gen and the house kept
    drawing **5.76–6.2 A**, so neither break latched: no derate, no COLLAPSED
    freeze, no FLOORS on recovery, no push. The floor is now the higher of the
    absolute value and `POWER_COLLAPSE_FLOOR_FRACTION` (0.5) of the pre-fall
    mean — both breaks left ~0.36–0.40 of theirs. Third instance of hard rule 5c
    (a guard sized against only part of what it guards).
    ⚠️ **This cannot tell a trip from someone switching off the biggest room**,
    because that room IS most of the load. What separates them is the
    commanded-cut credit, so EVERY off we can know about must be priced:
    `creditRoomOff` on the dashboard tap AND on the observed shadow flip
    (automation, remote, schedule). Ours are already credited via
    `Plan.commandedCutAmps` and must not be credited twice. Also: the latch
    window used to be two readings wide and did not know it (at the then 4-wide
    `SMOOTH_WINDOW` the median flipped on the third post-cliff reading) —
    `cliffAnchor` holds the pre-fall mean for `CLIFF_ANCHOR_MS` (30 s). At
    `SMOOTH_WINDOW` 8 (2026-08-05) the same arithmetic runs slower and in the SAFE
    direction: fully pre-fall for three post-cliff readings, halfway on the fourth,
    flipped on the fifth — 12–20 s, inside the 30 s hold with room to spare. A
    wider window makes the anchor needed LESS often, never later.
32. **A trough you cannot explain is not headroom.** A ≥ `POWER_COLLAPSE_DROP_AMPS`
    fall that is neither credit-explained nor floor-deep emits `unexplained_fall`
    and stands calm down for `UNEXPLAINED_FALL_CALM_HOLD_MS` (120 s). This is the
    belt to 31's braces: after the first break the post-trip meter read as
    PERFECT calm and the leveler raised Abdu L2→L3 and Najat to L2 at a "pre" of
    ~6.4 A — every compressor restarted together and the line went down again
    four minutes later. Related: a bucket that is empty with no banked evidence
    now returns **hold**, never `calm` (one in-band spike could drain the last
    point and clear the readings in the same ingest, and the urgent evaluation it
    triggered ran the RAISE path).
33. **Severity escalates on TIME, not only magnitude.** 15.6–16.0 A on a 15 A gen
    is 0.6–1.0 A over: "mild" forever, and mild's only tools are level cuts whose
    compressors wind down over minutes the breaker does not have. The SMOOTHED
    mean over the limit for `SUSTAINED_OVER_SEVERE_MS` (45 s) is **severe**
    regardless of overshoot; for `SUSTAINED_OVER_EXTREME_MS` (120 s) it is
    **extreme** — exactly ONE room off (invariant 26's ceiling is unchanged),
    the user's own trade on 2026-08-03 against losing the whole house. ⚠️ The
    extreme rung additionally requires `required > 0` AFTER credit, or the clock
    would shed a second room while the first cut was still landing (invariant
    19's double-shed, re-created from a timer). The clock stops while frozen or
    collapsed. And **inrush blanking is back to `smoothed ≤ limit`** — the
    +0.5 A slack it carried for one day covered the entire 17:38–17:40 ride and
    blocked the one actuator with instant physics, undoing that very turn-on.
34. **A changeover must not erase what is already in flight.** `clearOnSourceChange`
    wiped `sendCounts`/`sentAt`, so an L3 sent on grid two minutes before the
    00:13Z changeover was invisible: the gen-entry clamp compared the stale
    shadow and skipped it, the envelope priced the room ~4 A light and admitted a
    peer raise on top, and the late confirm 27 min later cost five cut batches.
    Sends now SURVIVE (the firmware restores its last commanded level after a
    power cycle, so they are exactly the right worst case; the TTL still bounds
    them), the FLOORS clamp judges `envelopeLevel`, and an observation matching a
    preserved send is a **landed** confirm — not a manual target, which would win
    over every automatic decision until a human cleared it.
35. **A room the reducer just cut may not climb straight back** (`VICTIM_COOLDOWN_MS`
    120 s — the involuntary twin of 30). Abdullah was cut L2→L1 at 00:41:10Z and
    raised back at 00:42:44, before the cut reached the meter. Both cooldowns
    clear on a changeover (per-line physics; `fundingDemotedAt` never did).
    The escalation settle now also covers the LEVEL and FAN rungs, not just the
    shed, whenever `commandedCutTotalAmps ≥ rawRequiredAmps` — compare against
    the RAW requirement, because the credit is spent as the meter absorbs it and
    reads zero exactly when the cut is arriving (3 batches / 13 s, 12.9 A
    commanded for a 0.4 A deficit).

**Known harness debt (2026-08-03; still current) — the reason none of 31–35 was caught in test:**
its `trip()` modelled a fixed ~4 A residual, *under* the old absolute collapse
floor, so the live failure was unreachable in simulation (now settable via
`residualAmps`); `pendingOn` was declared and never written (now wired: set on
`power_on`, cleared on the next tick / any off — which is how the one-tick
stand-down for our OWN restores became visible at all). **Still unmirrored:**
the send-side dedupe (`shouldSendLevel`/`lastFanSent`/`lastOffSentAt` and the
all-filtered early return), the collector's `LEVELING_RERUN_MIN_MS`
re-entrancy, and the whole grading shell (`pendingGrades`, `bornContaminated`,
`lastLoadAddAt`/`lastLoadDropAt`) — changes there need `controller.test.ts`
guards, because `scenarios.test.ts` cannot see them. Added to that list
2026-08-04: **device LIVENESS** (invariant 45 reads `isOnline`/`lastSeenAt` off
the TCL shadow, which the harness can only mirror), the **outdoor feed** and the
**learned hold's persistence** (invariant 52), and the **graded off-drop**
(invariant 55, which lives in the grading shell). Added 2026-08-06: the
**graded lone-raise rise, its arm-time exclusions and its report** (invariant
56 — same grading shell, so it lives entirely on `controller.test.ts` guards),
and note that a scenario can no longer stage a non-cooling room by starving it
of temperature progress (40 is report-only) — state `compressorOffLikely`
instead. Also unmirrored: the shell's **`swap` record itself** — `scenario.ts`
keeps its own copy, so a divergence between the two (the source-change clear was
one, fixed 2026-08-06) is invisible to `scenarios.test.ts` by construction and
needs a `controller.test.ts` guard reading the record directly. Every OUTWARD
effect of a stale swap is masked on the far side of a changeover, so a decisions
assertion is not enough.
Mirrored the same day: the
dead-window hold, the entry-collapse state machine, the recovery admission, the
per-room shed bar, and `compressorOffLikely`.

**2026-08-05 — one mirror repaid, two debts still open.** Mirrored: `isRamping`
now expires at a mirrored **`AC_RAMP_MS`** (240 s), not at the sim's physical
`rampSeconds` (60 s). The two are different things — the shell's window is an
UPPER BOUND that *absorption* retires — and the harness conflated them. It was
invisible until `SMOOTH_WINDOW` widened: production's window is 6–10× its
smoothing settle time, the harness's was **1.5×**, so a wider median pushed the
settle past the window and manufactured a **phantom regression** (a restore into
a 2.3 A median lag) that the shell cannot exhibit. A harness constant that merely
RESEMBLES a shell constant is worse than no mirror at all. `absorbedSharesAmps`
was mirrored the same day (`projectedExtraAmps`). Still open:
- **The dead-window fixture family is still scaled to `rampSeconds`**
  (`holdPowerEventRamps`). Not a clock change: those fixtures express restart
  protection as a MULTIPLE of that boundary (`DEAD_MS` 150 s against a 60 s
  window, inside the 3-window cap), so moving it to 240 s makes the dead window
  unreachable in simulation — the very debt `restartDelayMs` was added to repay.
  Five scenarios go red and three assert what happens BEFORE the compressors
  engage, i.e. a *different window* after a rescale, not a later clock. Needs the
  family rescaled together with each assertion re-derived.
- **Shell-side, not harness:** `unmeteredJumpAmps` and the fan debit are netted in
  `controller.ts` before the view is built, so the shared absorption pool cannot
  reach them (invariant 12's open ⚠). Fixing it moves the netting into the pure
  layer, which is where the harness can finally see it.

**2026-08-06 — the fan physics constant, and why invariants 58–60 have no
scenario for their own incident.** `scenario.ts` prices a fan gear at
**0.05 A** (`(fan − 1) × 0.05`, two call sites); the live book prices the same
gear at **0.11–0.15 A** — the sweet-spot arithmetic in `FAN_RESTORE_MAX_STEP`
uses ~0.15 (a 6-gear swing ≈ 0.9 A), and the 2026-08-06 graded 1→7 swing came in
at **+0.64 A** (≈ 0.11/gear). Two to three times too cheap, in the permissive
direction for the *cut* side and the restrictive direction for the *restore*
side: **no scenario can stage a fan-driven limit crossing at all**, which is
precisely the 13:12–13:34Z bounce house (58). The fast path (60) is likewise
unfalsifiable in simulation — with gears that cheap, `spendable ≥ swing + 1.0`
is nearly always true, so the sim cannot exhibit the saturated case where the
fast path must NOT fire; that arm is pinned in `fan-trim`'s own unit tests and
by the zero-churn acceptance scenario instead. Reconciling the constant is not a
one-line edit: every fan-bearing fixture's amp budget was tuned against 0.05, so
the family has to move together with each assertion re-derived — the same shape
as the dead-window debt above. Until then, treat a green `scenarios.test.ts` as
saying nothing whatsoever about fan-driven overloads. Also still unmirrored from
2026-08-06: `scenario.ts` does not clear `fundingDemotedAt`/`reducedAt` on a
source change while the shell does (pre-existing, same class as the swap-record
clear fixed the same day).

**2026-08-07 — one more device-poll debt.** `shedOffObservedAt` and the
`reconcileObservedOn` three-way (invariant 66) live entirely shell-side; the
harness does not mirror the device-poll path, so `controller.test.ts` is the only
net for them.

**2026-08-08 — the swap batch and the ramp release mirror; the anchor lifecycle
does not.** `scenario.ts` now mirrors the ONE-BATCH swap shape (donor off +
receiver on together, 69), the ramp early release (via the imported
`rampProvenDone` — "Shell parity (`maybeReleaseRampEarly`)", 70), and
`clearSettleIfDone` ("Shell parity (`clearSettleIfDone`)", 70). Still shell-side,
so `controller.test.ts` is their only net: the flicker-patience anchor lifecycle
(`flickerRefusedSince` — the stamp, the drop-on-unrefused, the non-raise-tick
guard, the source-change clear; invariant 68) and `maybeReleaseRampEarly` itself.
**2026-08-09:** `scenario.ts` also mirrors the split `resetCalm` (the `fanSpend`
option — a fan-only spend rewinds only the MAIN clock, 71), while the
`fanCalmSince` lifecycle guard (the fan clock survives a fan spend) stays
`controller.test.ts`-only.

**Added 2026-08-03 (midday) after the top-priority room sat 20 min at a level its compressor will not run at:**
36. **A level that does not cool is an off — in BOTH directions.** A comfort
    floor means "below this, this room does not cool in this weather", so a HOT
    room parked under an active one is out of service while looking perfectly
    healthy: a level carries no shed row, no restore queue, no push. Reduction
    side: `AcMove.subFloorNeed` = `needDelta × SUBFLOOR_NEED_FRACTION` (0.9)
    joins the protection term, but **only in plans that already shed** — live
    11:25:32 `{shed Najat 1.6 + Abdullah L2→L1}` scored 1.6 and beat
    `{shed Abdu}` at 1.8, so the hottest top-priority room stopped cooling to
    keep a milder one running, for a deficit the bigger room covered alone.
    ⚠️ Counting it unconditionally inverts the ladder — the acceptance scenario
    answered a 1 A near-limit deficit with a SHED instead of the cheap level,
    which is the cost the user named when he deferred this ("gives up a
    reduction rung that exists to avoid a shed"). A plan that switches nobody
    off still wins first; the term only decides who pays once something is
    going off. The 0.9 is load-bearing too: at 1.0, `{shed cool + sub-floor
    hot}` scores worse than `{shed hot}` and the reducer kills the room the term
    protects. Recovery side: the restore phase **yields** (reserving nothing) to
    a needier room stranded below its active floor — but only when that floor
    step passes the same envelope + meter tests the raise phase is about to
    apply, or the yield is a livelock. Live: Najat's restore (need 1.6) took the
    2.3 A that appeared while Abdullah (3.0, 8 °C above setpoint) waited.
37. **A config save goes to the ACTING controller — so v2 must write row 1 too.**
    `collector.leveling()` routes `PUT /api/ac/leveling` to whichever controller
    is acting; since the cutover that is v2, whose `updateConfig` persisted only
    its own five keys. Amp models, limits, margins, priority and level boosts
    went in and vanished behind a `200` — row 1's `updated_at` still read
    2026-07-24. Row 1 is now written **merged** over its stored value, never
    replaced (v1 replaces wholesale from its own defaults, which drops any field
    the running build does not know). Corollary for forensics: **do not trust a
    config value because a session said it set it** — re-read it.

**Added 2026-08-03 (afternoon) after the 12:29Z generator break:**
38. **A credit is "late amps", not a licence — it dies when the house OUTRUNS the
    cut.** `requiredAmps` is the credited figure, and the 120 s sustained-extreme
    rung (invariant 33) is gated on `required > 0`, so a large credit silences
    the last rung on the ladder. Live 2026-08-03 12:26–12:29, 46 °C outdoor: a
    room was switched back on, two level cuts armed 2.0 A then 3.1 A of credit
    against a ~0.3–1.6 A overshoot, and the reducer then planned **nothing for
    2 min 24 s** while the meter climbed 15.6 → 16.6 A. The breaker went. The
    credit's premise — these amps are not gone, they are late — holds only while
    the net load is FALLING; a compressor ramping up outruns it. `pendingCutCredit`
    now returns 0 when the smoothed meter sits above the cut's own anchor by more
    than the live flicker. ⚠️ The flicker margin is load-bearing in the other
    direction: revoking a credit on supply wobble re-opens the 2026-07-31
    double-shed, which is why two of the three guard tests pin the credit
    SURVIVING (falling meter, flickering meter).
    ⚠️ **Not reproducible in `scenario.ts` today** — the live shape needs cut
    savings SMALLER than their price (Abdullah's `level:2>3` learned 3.08 A
    against a real ~1.5 A) plus a turn-on those cuts cannot cover, and the
    harness prices cuts from the same models the controller uses, so the sim
    always settles under the limit. Pinned at the `pendingCutCredit` unit level
    instead. Closing this needs the harness debt below.

**Added 2026-08-03 (evening), the user's own rule and his measurement:**
39. **"L1 above the boost temperature should not happen unless the room is
    within 2°C — otherwise consider it off."** `isNonCooling(ac, level)` in
    needs.ts is the single definition, consulted by BOTH directions: below an
    active comfort floor, a room more than `NON_COOLING_NEED_C` (2°C) from
    target is OFF. His evidence: held at L1 through 47.3°C outdoors, the room
    went 30 → 34°C against a setpoint of 20, and switching the AC off moved the
    meter barely at all — a level nothing was drawing, in a room nothing was
    cooling. Replaces the `nearTargetBandC` (0.5) gate invariant 36 shipped with.
    ⚠️ **The reduction term is still conditional on the plan already shedding.**
    Counting it unconditionally — which is what "should not happen" literally
    asks for — was built and rejected on evidence: on a line whose MEAN sits
    under the limit it turns the stable answer into a shed CYCLE (acceptance
    scenario: shed → restore → shed → restore, 4 power commands in 10 min, room
    at L1 in the end anyway). The reducer refuses the silent answer, its only
    alternative is a shed, and the restore path undoes each one because the
    post-shed meter looks affordable. **Prerequisite for the unconditional form:
    a restore-bounce backoff** (a restore re-shed within N minutes must slow the
    ladder), without which there is nowhere stable to land.
40. ⚠️ **SUPERSEDED 2026-08-06 by 56 — REPORT-ONLY.** *Was:* "Inside the band,
    WATCH it" (user: "at the 2 degrees the system should watch it if the
    compressor fall"). `AcView.subFloorStalledMs` counts how long a room has sat
    below its floor **without getting cooler** — any progress of
    `SUBFLOOR_PROGRESS_C` (0.2°C, two sensor LSBs) re-bases the clock — and
    `SUBFLOOR_WATCH_MS` (**3 min** since 2026-08-04, not the 10 min this shipped
    with) of no progress made it non-cooling whatever its need. It no longer
    does: the clock still runs and is still reported (`coolingState: "stalled"`,
    the pinned-below-floor report) but nothing enforces or spends on it. Its
    ⚠️ still stands and is now the whole rule — never the amp RESIDUAL
    (`smoothed − modelled` moves when a room under-draws its model, so reading
    it to decide whether a room is under-drawing is circular); only
    ATTRIBUTABLE amps (55, 56). Still computed in `scenario.ts`
    (`trackSubFloor`) for parity with the status surface only.
41. **A restore is judged on where the meter is HEADING, not where it sits.**
    Live: Najat shed and restored FOUR times in 23 min, every restore admitted
    at a 9.5–12.5A meter while the settled three-room draw was ~15A — her draw
    gone, the survivors mid-cycle. `committedAmps` is now floored at
    `cutAnchorAmps − commandedCutAmps` (the meter before the in-flight cut, less
    what that cut was priced to save), expiring with `PENDING_CUT_MS`.
    ⚠️ **Not `Σ modelled draw + house`** — that looks like the same number and
    is not: a meter below it also describes rooms genuinely drawing under their
    models, and treating that as lag invents load and strands a room off. That
    version was written first and broke invariant 16's own test, which is what
    caught it.

42. **A manual level is a PIN, even under a boost floor** (user, 2026-08-03
    evening: "manual wins"). `floorOf` clamps to `manualTarget` as it always did
    to `manualCap`. Before this, `ceilOf`'s `max(floorOf, manualTarget)` meant a
    user pinning L1 under an active L2 boost got `max(2,1) = 2` and the leveler
    raised the room back — live 19:32:13 and 19:38:33, ~20 s after each pin,
    with the status reporting `manualTarget 1` throughout. The dashboard said
    pinned; the room said otherwise.
    ⚠️ Deliberate consequence: a pin below the boost floor also makes
    `isNonCooling` false for that room, so no peer is ever shed to fund a level
    the user declined. The WATCH is unaffected — it keys off the boost minimum
    (`minLevel`), not `floorOf` — so `subFloorStalledMs` keeps accruing and can
    still report "pinned below the comfort floor and not cooling". Reported,
    never enforced; that is what makes "manual wins" mean anything.

43. **"Undo the turn-on" outranks "protect the hotter room" — but only for a
    close call** (user, 2026-08-03 evening: "why it turned off mine not
    najat?"). `exportsShed` ranks immediately after feasibility, so the room
    whose turn-on caused an overload was shed absolutely, whatever the
    alternative. Live 20:24:50: a **0.3 A** overshoot shed the user's own 33 °C
    room (need 4.2) while a 28.2 °C room (need 2.5) kept running — and shedding
    the milder one covered that deficit many times over. A plan that sheds ONLY
    rooms at least `SHED_NEED_GAP_C` (**1.0 °C** — cut from 1.5 by the user on
    2026-08-04, *"1 c is enough to switch between acs"*; `reduce.ts`, and the
    same constant invariant 57's swap gap is defined as) milder than the causer
    no longer counts as exporting; it competes normally on `shedNeed`. Inside
    the gap the original rule stands, and it should: flipping your AC on must
    not switch off a comparably warm room instead.

**Added 2026-08-04 after TWO real breaker trips before lunch, neither of which the controller saw:**
44. **A timer is not a compressor.** A grid→gen changeover power-cycles every AC
    and TCL restart protection then holds the compressors off for ~6 minutes the
    model knows nothing about. The three 240 s ramp windows EXPIRED ON THE CLOCK
    at 11:20:10 with nothing running, FLOORS cleared four seconds later (it
    waits for "nothing ramping"), and the raise path opened onto a 6.1 A meter
    that was pure house — two raises admitted at "worst case 11.9 A **incl. 0.0 A
    house**". The sampler had booked that 0.0 itself: `max(0, smoothed −
    modeled)` assumes a residual can only be wrong-HIGH (invariant 20's dying
    compressor), and with the compressors dead it is wrong-LOW, which is the
    permissive direction. A ramp opened by a POWER EVENT now extends past
    `AC_RAMP_MS` while BOTH hold — that room has absorbed less than
    `min(RAMP_RELEASE_MAX_AMPS 1.0, RAMP_RELEASE_FRACTION 40 % of its modeled
    steady draw)`, and the modeled running total sits ≥ `DEAD_WINDOW_GAP_AMPS`
    (2.0) above the smoothed meter with no commanded cut to explain it — capped
    at 3 × `AC_RAMP_MS`, because a room switched off at the wall looks identical
    forever and nothing may block unbounded (invariant 22's spirit). ⚠️ 40 %,
    not 100 %: a compressor drawing under its model (Abdullah, 1.8 A against a
    2.3 A model) must release normally or every healthy house freezes its own
    raise path. Sampling side: never record a residual while the model sits >
    `RESIDUAL_TRUST_GAP_AMPS` (1.0) above the meter, and when EVERY power-cycled
    room is still dead the meter IS the house — recorded directly, guarded by
    `DIRECT_SAMPLE_DRIFT_AMPS` (1.6) so the tick a compressor finally engages
    cannot book a half-risen median as house. A source change carries the OTHER
    line's peak rather than 0: the non-AC house does not care which line feeds
    it, and 0 is the one answer known to be wrong.
45. **A session that BEGINS dead has no cliff to latch on.** User-confirmed: the
    breaker physically tripped that morning and he reset it by hand. 11:16–11:21
    was an OPEN BREAKER, the four FLOORS resends went to devices that could not
    hear them, and the reset brought all three rooms back at once with restart
    protection already served — 6.4 → 16.6 A in ninety seconds. The third missed
    trip in ten days, and a new hole class: invariant 31 fixed the collapse
    FLOOR and invariant 5 the CREDIT, but both still describe a fall inside one
    session. `entryCollapseEvidence` latches on four things together — the
    dead-window gap (44), EVERY managed running room dark, at least one send of
    ours unanswered for `ENTRY_COLLAPSE_UNCONFIRMED_MS` (120 s), and
    `ENTRY_COLLAPSE_DWELL_MS` (60 s) of it holding — arming the SAME machinery a
    fall-latched collapse arms (stacked derate, COLLAPSED, critical push, FLOORS
    on the way back), released on evidence and never on a clock. ⚠️ "Dark" is
    anchored to the CHANGEOVER and to sends WE made, never to a freshness bar:
    measured twice a minute apart, healthy last-seen ages ran 248/157/269 s then
    305/214/326 s with two of those rooms actively cooling — TCL shadows report
    on STATE CHANGE, not on a keepalive, so any passive bar under ~5.5 min calls
    a working house dead, and the amp gap cannot save it because restart
    protection satisfies the gap on EVERY ordinary changeover. Silence we
    provoked is evidence; silence we merely observed is not.
46. **A changeover is a collapse recovery without the collapse.** The floor set
    is admitted against the ENVELOPE on every gen ENTRY, hottest room first,
    while `Σ floor models + carried house ≤ limit − margin`; the rest are shed
    through ordinary shed rows and come back on the ordinary restore queue. The
    morning's arithmetic was lost before the first reading existed — floors
    10.4 A modeled + ~6 A house on a 15 A generator — and the same shape
    recurred at 17:22:57 with every one of the day's admission-side protections
    holding (R11b): nothing was wrong with the response, the entry was already
    over. A normal changeover power-cycles every compressor exactly as a reset
    breaker does. Free when the arithmetic fits: an entry with room to spare
    journals `floors` and commands what it always did. Manual pins are admitted
    before the budget is spent at all — this phase never sheds a room the user
    asked for.
47. **A brownout is the only voltmeter this house has.** After the 11:22 surge
    the ESP logged power gaps of 28/34/41/47 s between 11:31 and 11:36 while the
    controller rode 14.3–14.8 A on a 15 A generator calling itself healthy. At
    46 °C a genset delivers under its plate rating, and with no voltage channel
    a gap in the reading stream while we sit within `STRAIN_NEAR_LIMIT_AMPS`
    (1.5) of the ceiling is the only evidence it can produce. Two such events
    inside ten minutes take 0.5 A off the gen ceiling, stacking to 1.5 A,
    recovered one rung per quiet 20 min exactly like the collapse derate
    (invariant 15 — a cliff hand-back is spent by the raise path in seconds).
    ONE event does nothing: a generator has moments. ⚠️ It is NOT a collapse —
    nothing latches, nothing freezes, no push, no restore waits. It only shrinks
    the ceiling the ordinary ladder already respects, which is the whole
    difference between "the breaker opened" and "the generator is working too
    hard". Kept in its own record beside `derate` so the two decay independently.

**Added 2026-08-04 (midday) after the SECOND trip, this one on the ladder:**
48. **A credit is late amps only while the lateness is SHRINKING — and while it
    IS shrinking, nothing may escalate past it.** 12:38:23 fan trims, 12:38:26 a
    level cut, ~3.0 A commanded; the meter fell 0.49 A in 91 s and the breaker
    went at 12:39:57. Fan trims land in seconds; a level cut's compressor winds
    down over minutes the breaker's thermal curve at 46 °C does not have — and
    because `requiredAmps` is the CREDITED figure and invariant 33's extreme
    rung is gated on `required > 0`, three amps of credit silenced the last rung
    while the mean sat 0.6–1.1 A over for two and a half minutes. Invariant 38
    could not help: it revokes when the meter RISES above the anchor, and this
    one sat pinned at it. The other face arrived thirteen minutes later — at
    12:56:39 a SECOND room was shed 13 s after a cut whose 2.3 of 2.9 commanded
    amps had already left the house, because the sustained-over clock does not
    pause for a cut that is landing and the escalation settle covered MILD only.
    One predicate now answers both, `cutTrendOf` over the four numbers the meter
    already publishes: `settling` inside `CREDIT_LANDING_GRACE_MS` (60 s),
    `arriving` once `CREDIT_LANDING_FRACTION` (35 %) of the commanded amps have
    demonstrably left, `stalled` past the grace with the fall still short. The
    extreme rung fires on `stalled`; the sustained clock REBASES and the settle
    hold extends to severe on `arriving`. ⚠️ A fired shed re-arms both credit
    and anchor, so the tick after an escalation looks like a fresh cut — that is
    what keeps the 2026-07-31 and 08-03 double-shed shapes covered.
49. **The last rung sheds ONE room, and its bill must be real.** 15:53:45,
    `over_extreme required 4.57 A` at a smoothed 15.0 against a limit of 15.0 —
    and it shed BOTH remaining rooms. Two guards sized against part of what they
    guard, lining up: `requiredSavingsAmps` sized from `min(severe readings)`,
    whose safety argument holds only when there ARE several, and the banked ring
    held exactly one 19.5 A compressor-inrush sample (a flicker pinned at its
    1.5 A cap had raised the severe bar to 17.5 A, disqualifying every other
    reading) — min over a set of one is the spike. The newest
    `SEVERE_STREAK_READINGS` (2) banked readings must now ALL be severe before
    their min may speak; newest, not merely two anywhere, because two spikes
    minutes apart are still two spikes. It costs no reaction time: a severe
    reading drains 3 of the bucket's 5 points, so a genuine step-up has always
    banked its second before this is consulted. And the extreme tier's deficit
    no longer sizes the general reducer's shed ceiling — that rung exists to
    relieve a sustained strain, not to clear an arithmetic bill.
50. **Which room is cooler is not that room's own business.** `computeAcNeed`
    returns a FEELS-LIKE delta for a room whose range rule uses it and a
    real-temperature delta for every other room, so every cross-room comparison
    was asking two different questions and comparing the answers — humidity
    alone could make a milder room outrank a hotter one and take its amps.
    `AcView.rankNeedDelta` asks ONE question of every room (its own thermometer
    against the shared comfort target, inverted in heat mode exactly as
    `computeAcNeed` does it; a configured per-AC `tempOffsetC` calibrates that
    thermometer here too — a biased instrument is not a different question),
    and every room-vs-room use moves onto it: shed selection and
    `SHED_NEED_GAP_C`, the reduction cost weights, the sub-floor protection
    term, restore/yield precedence, the rebalance donor gap, the recovery
    admission. Per-room ABSOLUTE logic keeps `needDelta` and its
    configured metric — whether a room is comfortable is that room's own
    business. A dead thermometer falls back to `needDelta`, which is precisely
    the old ordering, so the change can never be worse than what it replaces;
    both figures are journaled on every shed. On top of it, the user's full
    shed-choice policy (2026-08-04): **shed the COOLEST room whose single off
    covers the deficit; if none does, the coolest TWO in one batch** — which is
    what the existing search expresses once the deficit is honest (49) and the
    ranking is real, with `SHED_BATCH_MAX` (2) making "the hottest room always
    survives" true for three rooms and no cap at all for two.

**Added 2026-08-04 (evening), the user watching his own room at L1 in 47 °C heat:**
51. **Above the band, L1 is not a level — it is the room off.** Invariant 39
    already PRICES that cut as an off, and the 17:27:18 batch executed it anyway:
    the reducer will pay any price when the alternative is infeasible. A target
    the search cannot ENUMERATE is the only form of "never" that holds, so
    `hardFloorOf` now bounds the move enumeration itself. One function,
    `boostZoneOf`, owns the whole gradient rather than four conditionals in four
    files — Abdullah's configured 39 °C: **< 36** nothing special · **36–39
    `watch`** L1 is still his legitimate floor and he is WATCHED there
    (`subFloorStalledMs` measures against the boost minimum, `BOOST_WATCH_BELOW_C`
    = 3 °C early — ⚠️ **the ARMING half is superseded 2026-08-06 by 56:** that
    watch is report-only now, so the zone gathers no evidence and lifts nobody;
    the zone BOUNDARIES and the floor behaviour below are unchanged) ·
    **39–41 `flex`** the floor binds raises and entry clamps as always
    and the sub-floor rung may STILL use L1, because at ~39 °C on 2026-08-03 he
    was genuinely cooling there (`BOOST_FLOOR_FLEX_C` = 2) · **> 41 `hard`** not
    a legal automatic target, no evidence needed. Every boundary carries the
    boost floor's own 1 °C release hysteresis, and a stale outdoor reading holds
    the LAST zone rather than falling back to permissive — the weather does not
    become mild because the station went quiet. ⚠️ This NARROWS invariant 25's
    sub-floor rung; it does not delete it. Its birth incident still binds for
    every room below its band and every non-boost floor. Manual wins in both
    directions: `floorOf` clamps to the pin, so a user who pins L1 gets the rung
    back (invariant 42).
52. **What the configuration estimates, the house can measure.** 39 °C is the
    user's estimate of where the compressor starts to fail, and the real number
    moves with humidity, condenser fouling and the generator's voltage — so the
    system records its own bar (user: "when the system observe that abdullah is
    not working on l1, by own observation or manual raise, it should state the
    outside temp, so it will never reduce the level to l1 untill it drop below
    that temp or after 6 h"). Armed by exactly THREE attributable things: R6's
    fan-sized off-drop (55), the dead window (44), or a hand raise OFF L1
    — ⚠️ **two candidate armers were removed on 2026-08-06.** The sub-floor
    watch stalling at L1 (56: it fired on a room demoted for being *satisfied*,
    which cannot show progress, and the hold's raise then cost the hottest room
    its restore for 17 min), and the graded lone-raise RISE built to replace it
    (56 again, on review: its rise is a whole-house delta, so a household step
    inside the window mints the same false hold from the amps side) — recorded
    BEFORE
    the breaker check that may revert it, because whether we can AFFORD the
    level he asked for says nothing about whether the level he is leaving cools
    his room. Keyed on the outdoor temperature of the observation, so the LOWER
    observation always wins (L1 failing at 39° implies it fails at 44°) and it
    releases when the weather really goes back under it, `LEVEL_HOLD_RELEASE_C`
    (0.5) of hysteresis so a reading on the bar cannot flap a room's whole
    ladder. `LEVEL_HOLD_TTL_MS` (6 h) is the backstop for what the bar cannot
    see — the hardware itself changing. A stale outdoor feed HOLDS, for the same
    reason 51 holds its zone. It composes into `minLevel` by `max` with the
    configured boost and sets `boostFloorHard`, extending 51's hardness BELOW
    the configured threshold on evidence. ⚠️ It **persists**
    (`ac_leveling_level_hold`): a six-hour hold a deploy erases is not a hold,
    and eleven deploys landed inside those six hours. ⚠️ `hardFloorOf` is
    clamped to the room's current level in the reducer — a hold can arm while a
    room is ALREADY at L1, and an unclamped hard floor leaves that room no level
    move at all, so the search would answer "L1 is not a target" with a
    power_off.
53. **A level still in flight is recoverable, and a refusal has to cost
    something.** The restore refusal is `committedAmps − savingsAtFloors + cost`,
    and the two terms described different houses: `committedAmps` charges a
    raise's committed-but-unmetered jump the instant it is SENT (invariant 12)
    while `savingsAtFloors` read `currentLevel`, which does not move until the
    firmware confirms — seconds to fifteen minutes (invariant 7). Live
    2026-08-03 17:13:36 / 17:19:03 / 17:25:31, the same shape three times in
    twelve minutes: a shed room refused at "floors 16.5 A vs 14.9 A" with
    `savingsAtFloors` reading ZERO and a peer raise in the same batch. Both
    sides now price peers at `chargedLevelOf`, and the EMISSION moved with it —
    crediting an in-flight level while still emitting floor-downs off
    `currentLevel` admits a restore and sends nothing to pay for it. The second
    half is raise-vs-raise: at 17:13:36 the mildest room (need 1.9) took 2.0 A
    while the hottest (need 8.0) was refused its step by 0.2 A. Sorted
    hottest-first is not the same as ranked, so a room refused for AMPS now
    records its need and a milder one may take those amps only if it is at least
    `SHED_NEED_GAP_C` (1.0 °C) milder — the same constant and the same question
    the recovery admission asks in the other direction. ⚠️ Only AMPS refusals
    arm it: a room waiting out its own calm, backoff, victim or funding cooldown
    is serving a sentence that expires on its own, and fencing its peers behind
    it would turn every cooldown into a house-wide freeze.
    ⚠️ OPEN QUESTION (2026-08-06, user observation — **not decided, do not
    implement either way**): should a MANUAL level pin jump this fence? He
    watched his own L2 pin wait ~4 minutes behind a needier room's reservation
    before the funding demote (21/9) freed the amps and it landed. "Manual wins"
    (42) is about a pin the automation may not overrule, and it is silent on
    whether a pin may overtake a hotter room's queue position; letting it jump
    would also hand a user the one lever that outranks the thermometer while a
    peer is stranded. It resolved itself here, which is the argument for leaving
    it alone. Ask before changing it.
54. **The trough a shed digs outlives the credit that explains it.** Invariant
    41 floors the committed meter at `cutAnchorAmps − commandedCutAmps` while a
    cut is in flight, and that claim dies twice over — with `PENDING_CUT_MS`
    (180 s) and with the absorption that spends it. Live 07:19→07:20 a restore
    was admitted THIRTY-ONE SECONDS after the shed that caused it. The bar is
    therefore also kept per ROOM for one `ATTEMPT_BLAME_WINDOW_MS` — deliberately
    the same window as the bounce blame, since a shed inside it is already that
    restore's failure and this is the identical judgment read from the other
    end. ⚠️ A room blocked ONLY by its own bar RESERVES its amps instead of
    being skipped: the skip exists for rooms physics cannot carry, and this is
    the opposite case — the bar is a claim about the HOUSE, so if the shed room
    cannot be afforded at that figure then nobody can, and a peer's raise taking
    them spends the very trough the bar exists to disbelieve. ⚠️ Invariant 39's
    unconditional form was re-tested on top of this and **rejected a second
    time**: 41 commands in 40 minutes against the conditional form's 4, in two
    shed→raise→restore rounds. The backoff was never what was missing — the shed
    frees real headroom, the raise path is entitled to it, and the line goes
    over again. Closing it needs a shed that does not hand its amps straight
    back (the user's parked "gated proactive shed").
55. **Ask the METER whether the compressor ran.** The sub-floor watch answered it
    from the thermometer and needed three minutes (⚠️ and answered it WRONG —
    see 56, which made this the only automatic answer); a lone shed's off-drop
    answers it in one grading window, and the shed was going to happen anyway
    (user's own experiment: "an off with 1 amp or less of drop means the
    compressor was not running"). `AcView.compressorOffLikely` carries the
    verdict from ATTRIBUTABLE sources — a graded LONE off whose drop was ≤
    `COMPRESSOR_OFF_DROP_AMPS` (1.2) while the model claimed ≥
    `COMPRESSOR_OFF_MODEL_AMPS` (2.0), retained per device+LEVEL and per source
    until `COMPRESSOR_ON_DROP_AMPS` of graded fall or an amp of ramp absorption
    retires it; and the dead window of 44. (The lone-raise RISE of 56 was going
    to be the third and is not — it is report-only; see 56.) It feeds
    `isNonCooling` (so both
    ladder directions treat it exactly as they treat a stalled room), arms 52's
    learned hold, and surfaces as `coolingState` per AC. ⚠️ Never from the
    standing residual — `smoothed − modelled` moves when a room under-draws its
    model, so reading it to decide whether the room is under-drawing is circular
    (invariant 40, and that reasoning already produced one wrong diagnosis). A
    graded lone off is not circular: one actuator, over a window the pipeline
    has already certified uncontaminated (23) and settled (29). Read BEFORE the
    0.2 A learn threshold, because a room that dropped almost nothing is exactly
    the case this is about and exactly the case that gate discards.

**Added 2026-08-06 after a bogus "L1 not cooling" verdict cost the hottest room 17 minutes:**
56. **A stalled thermometer is not evidence; only ATTRIBUTABLE amps are.** User,
    verbatim: *"it is so normal that we see no cooling progress in all rooms for
    a long time, even with L3, so this should not be considered. However, we
    have to depend on Amps — if it draws only about 1 amp, only the fan is
    working, no compressor."* The 02:15:29 misfire is the proof it could not be
    otherwise: Abdullah was demoted to L1 at 02:12:20 **for being satisfied 20
    min**, and a room at target can never show the `SUBFLOOR_PROGRESS_C` that
    re-bases the watch — the verdict was true by construction of the state that
    armed it (invariant 40's own circularity ⚠️, arriving from the thermometer
    side). The 6 h hold raised him L1→L2 at 02:36:42 on a 15 A gen, and those
    1.5–1.9 A are why the hotter 4.3 A room stayed shed until 02:49. So:
    `isNonCooling` keeps only the >`NON_COOLING_NEED_C` ground and
    `compressorOffLikely`; `subFloorStalledMs` is report-only everywhere (40,
    51's watch zone, 52's armer). **Rise-side observation, REPORT-ONLY:** a LONE
    `set_level` raise off L1, graded over the full ramp, whose ratcheted rise is
    ≥ its priced step (`raiseJumpAmps`) +
    `COMPRESSOR_START_RISE_MARGIN_AMPS` (2.0 — deliberately the same "smallest
    whole compressor" quantity as
    `COMPRESSOR_ON_DROP_AMPS`/`DEAD_WINDOW_GAP_AMPS`) is journalled
    (`reason: "compressor_report"`) and logged, and **arms nothing**.
    ⚠️ It was built to set `compressorOffLikely` and arm 52's hold, and was
    demoted on review the same day, before it ever ran on the house: the rise it
    measures is `PendingGrade.peakDeltaAmps`, a ratcheted **whole-house**
    smoothed delta over the 240 s window with **no non-AC load subtracted**.
    This house's own water heater is a 3.4 A step — switch it on ninety seconds
    into the window and an ordinary 1.5 A level step measures 4.9 A against a
    3.5 A bar, minting a 6 h L1 hold that spends the hottest room's amps on a
    kettle. That is this very invariant's failure class arriving from the amps
    side instead of the thermometer side, and 5c again: a bar sized against the
    step price alone while the quantity it is compared to contains the whole
    house. The off-drop (55) does not share it — a coincident household step
    DOWN is rarer, and its bar is a ceiling on a fall rather than a floor under
    a rise. Closing it for real needs the rise taken net of `houseLoadAmps` at
    both ends of the window; that is its own piece of work, not a threshold
    tweak. **So the armers of 52's hold are three, all attributable: the graded
    off-drop (55), the dead window (44), and the user's own hand raise off L1.**
    The detection, its arm-time exclusions (`loneRaiseIsAttributable`: start
    window, power-event ramp, FLOORS, `fromLevel === 1`) and
    `raiseRiseSaysCompressorWasOff` all remain — as observability, and as the
    scaffolding a net-of-house version would reuse.
    ⚠️ **And the third armer's OBSERVED half is power-event-guarded** (07:01:52Z
    the same morning): a TCL that power-blinks RESTORES its last level, which in
    the shadow is character-for-character a hand raise off L1 — so the device-poll
    armer stands down inside `POWER_EVENT_LEVEL_JUMP_GRACE_MS` (15 min, the
    collector's own `AC_POWER_EVENT_GRACE_MS`, sized to outlast the ~13-min TCL
    confirm lag) of any power event, `controller.notePowerEvent` stamping
    `lastPowerEventAt` on the same five events it forwards so the two windows are
    one clock. The DASHBOARD armer is deliberately unguarded — an authenticated
    REST command is attributable whatever the line is doing. Cost of the hole: a
    6 h hold that floored Abdu at L2 (6.5 A vs 4.3 A) and stranded the hottest room
    off at 43 °C. Hard rule 5b's spirit, on the rise side: never infer a HUMAN
    event from device shape near a power event.

**Added 2026-08-06, the user's own approval of the parked proposal, from the same morning:**
57. **A shed room may be bought back by switching a CLEARLY COOLER one off —
    the gated proactive shed.** User: *"after Najat on and be stable, there was
    enough budget to turn off Najat and bring Abdu back on."* Live: after the
    02:32 storm, Najat's cheaper 3.35 A restore fitted first and took the
    headroom; Abdu — 1.5 °C hotter, 4.3 A — stayed shed until 02:49, when the
    heater cycled off on its own. `swapDonorFor` (raise.ts) picks the COOLEST
    donor that is `SWAP_NEED_GAP_C` milder (= `SHED_NEED_GAP_C` 1.0, the
    shed-side gap the user calibrated — a whole room costs at least what a level
    costs, so never `REBALANCE_NEED_GAP_C` 0.7), unpinned, unramping, not in a
    funding/victim cooldown, and never the last room running. Any AC may donate,
    top-priority included (2026-08-04: the thermometer decides). The trade must
    CLOSE the gap — the receiver fits after the donor's off at the PLAIN learned
    price (never the probe, invariant 3) with `REBALANCE_FUND_MARGIN_AMPS` to
    spare, on the meter AND on the envelope.
    ⚠️ **Execution SUPERSEDED 2026-08-08 by 69 — ONE batch now.** *Was* invariant
    9 verbatim: the donor's `power_off` shipped **ALONE** and the receiver restored
    on a LATER tick against the committed meter (41/54). Since 2026-08-08 the
    donor's off and the receiver's gentle `power_on` ship TOGETHER (the off still
    credited via `commandedCutAmps`, so its cliff cannot latch a phantom
    collapse — 11/31), which FORFEITS grading (a 2-meter-command batch is never
    learned) but spares the receiver the 36 s wait. The receiver's amps are still
    **RESERVED across ticks** (`controller.swap`, mirrored in `scenario.ts` —
    **including the source-change clear**, added on review 2026-08-06: a trade
    reserved amps on a budget the changeover deleted, and the entry mode re-decides
    who runs from scratch), and that reservation now covers the FAILED-SEND case —
    the old "swap landing" deferral is the retry path — released when the receiver
    returns or at `SWAP_RESERVATION_MS` = `ATTEMPT_BLAME_WINDOW_MS`.
    ONE swap in flight house-wide, only the HOTTEST shed room may arm one.
    ⚠️ **"ALONE" is enforced at the ARM, not hoped for:** `plan()` merges
    `invariantCorrections` into the same batch, and the grading shell only
    grades `meterCmds.length === 1` — so a tick carrying a correction would ship
    the trade in a 2-command batch and silently forfeit BOTH the free `on@L`
    sample and the off-drop compressor evidence (55) it was designed to harvest.
    `swapAllowed` therefore requires `corrections.commands.length === 0`
    (review, 2026-08-06; the trade stands down and re-arms next tick). ⚠️ This
    gate REMAINS after 69 made the trade a deliberate two-command batch: grading is
    now forfeited by design (69, an accepted cost), and the gate keeps a THIRD
    (correction) command off the batch rather than protecting a grade that no
    longer happens.
    ⚠️ The donor gets an ordinary shed row (so it auto-restores when budget
    genuinely allows) but is barred from restoring for `FUNDING_COOLDOWN_MS` —
    invariant 30 one rung down, and a `power_off` now stamps that cooldown, not
    only a `set_level`. **The bar and the RESERVATION are separate rungs**
    (review, 2026-08-06): every funding-cooldown donor is barred, but only the
    LIVE trade's donor reserves its restore cost, because a reservation parks
    the raise phase *and* the fan restore house-wide and only a named receiver
    can claim that. Keyed on `fundingCooldown` alone, a room that gave up one
    LEVEL and was then shed for an unrelated overload froze the whole house for
    two minutes. The need gap IS the anti-oscillation hysteresis: the
    reverse trade needs the rooms to CROSS by the same margin (~2 × gap).
    ⚠️ It is a COMFORT optimisation, never an emergency tool: NORMAL + gen +
    calm only, and it stands down on any derate/collapse/frozen meter, a mean
    over the limit, a drained bucket, a live cut credit, a bar-blocked receiver
    (54) — and for `SWAP_QUIET_AFTER_OVER_MS` (= `PENDING_CUT_MS`) after ANY
    over-limit batch. That last one is not redundant: every other gate reads the
    CURRENT tick, and the acceptance replay traded a room away **50 s** after a
    level cut with all of them satisfied. Journalled as `proactive_shed`, with a
    push naming donor → receiver (a shed must be LOUD).

**Added 2026-08-06 (evening) after a fan commanded 10× in 22 minutes and two double sheds:**
58. **The supply's wobble is a MARGIN every spender pays — and it may only ever
    turn an admission into a SKIP.** Invariant 24 taught the REDUCER that the
    mean is the truth about load; the spenders were still admitting against a
    bare ceiling on a line the same estimator was measuring at ±0.4–1.0 A. Two
    incidents, one arithmetic. 13:12–13:34Z: a saturated gen house, ~5 A heater,
    every level at its floor, flicker 0.96 A — the reducer's only rung was a
    fan, and `planFanRestore` handed the gear back at `cost ≤ headroom` the
    moment the meter dipped, so the re-cross was arithmetic and the cycle ran
    every ~5 min (Abdu's fan 10 commands in 22 min, Abdullah's 5). Every rule
    behaved as written; together they were a limit cycle, which is a bug.
    14:00:32→14:04:24Z: Najat shed, the house settled at 11.6 A, and this phase
    bought her back **34 seconds later** — committed 12.12 A + a 2.3 A probe =
    14.42 A against a 14.9 A ceiling, 0.48 A of margin on a line wobbling
    ±0.4–0.8 A. She crossed 15.3 A, was re-shed at 14:04:10, and because her own
    cut had not yet crossed the 8-wide median Abdullah was shed 14 s after her
    (invariant 19's shape); the same double ran again 14:38:05→14:38:11Z. So the
    fan restore spends `headroom − flicker` and the shed-restore admission judges
    against `restoreCeiling − flicker`, journalled as `(−0.4A flicker)`. A quiet
    line estimates 0 (the estimator needs two reverting excursions ≥
    `FLICKER_MIN_AMPS`), so grid and every steady generator hour are
    byte-identical to what this replaces.
    ⚠️ **MARGIN, never a price.** `restoreCostAmps` and the probe pricing are
    untouched: admission and the controller's freshly-on projection must re-price
    each other exactly (invariant 3, the 2026-07-25 storm). Level RAISES are
    uncharged too — they answer to the physics envelope plus the measured house
    (16), and the failure being fixed here is restore-shaped.
    ⚠️ **The charge may never change WHICH refusal branch a room takes** (review,
    2026-08-06 — a MAJOR, caught before it had run a full day). Every branch that
    SPENDS is classified at the BARE ceiling, whole resolution included (price as
    well as fit), and both halves ran the *aggressive* way — the margin made the
    controller LESS conservative in the corner it exists to make more
    conservative: a room blocked by its own shed bar (54) judged on the charged
    figure stops looking bar-blocked, silently dropping the R9 reservation AND
    falling through to the swap, which switches a cooler room off to fund a
    restore the bare ceiling had already admitted; and a room whose PROBE fits
    bare is a room a quiet line RESTORES, so refusing it for the wobble and then
    buying it a donor spends a room's comfort on a margin.
    ⚠️ The gated proactive shed (57) is flicker-exempt **END TO END** — it may
    neither be ARMED by a flicker refusal nor REFUSED by one once armed. A live
    trade's receiver is admitted at the bare ceiling and `swapDonorFor` predicts
    against the same one (a prediction and the admission it predicts must ask the
    same question, or the donor loses its compressor for a fit the receiver is
    then refused); `REBALANCE_FUND_MARGIN_AMPS` is that path's margin, sized
    against exactly this noise band. Charging it stranded the trade in the
    ±0.5 A-noise acceptance replay: donor off, receiver refused for the whole
    reservation, DONOR brought back — a room cycled for nothing, the one outcome
    `swapDonorFor`'s contract rules out.
    Written as a `> 0` test, never `Math.max`: an absent or NaN estimate degrades
    to "quiet line", i.e. to the behaviour this replaces. A NaN reaching the
    ceiling makes every comparison false and strands every shed room off in
    silence — the worse failure by the user's own ranking.
    ✅ RESOLVED 2026-08-08 by 68 (user-confirmed). *Was OPEN:* a restore the
    flicker ALONE refused reserved **nothing**, so a peer raise could take those
    amps. Now such a refusal journals `blockedBy: "flicker margin"`, RESERVES its
    bare cost once its anchor stands, and ages into a bare-ceiling admission after
    `FLICKER_PATIENCE_MS` (120 s). The first refusal tick still reserves nothing
    (no anchor yet), the safe residue of the old default. 58's OTHER descendant —
    the gentle-hold-charged-the-flicker regression axis flagged in 60 — is likewise
    closed 2026-08-08 (60's amendment below).
59. **A fan hold never restores into its OWN compressor's ramp.** 14:03:20Z
    Najat's gentle hold went to auto **134 s into her own 240 s ramp** and helped
    carry the smoothed meter to 15.3 A — the re-shed of 58's first double, and a
    second room fourteen seconds behind it. A PEER's ramp has been charged
    through the pipeline's `rampDebit` subtraction since invariant 12; nothing
    covered the self case, because a room's own committed-but-unmetered draw is
    exactly what its fan would be sitting on top of — and
    `recordGentleRestoreHold`'s own contract already claimed the fan was pinned
    "while the compressor is still ramping" while the release was only calm- and
    headroom-gated. `ac.ramping` now skips the hold outright. Both hold kinds pay
    it: a fromCut hold climbing back mid-ramp after a power event is the same
    physics.
60. **Fans are cheap, so their restore may not be slow.** User, 2026-08-06
    evening, verbatim: *"the fan speed is barely taking cost, so putting all at
    speed 1 is only just a last emergency action, and should not taking too much
    [time]."* The book agrees — a full 1→7 swing graded **+0.64 A** that
    afternoon, under half a compressor level — yet recovery cost ~5 minutes of
    stacked time gates whether the budget was razor-thin or wide open, because
    those gates were sized when the fan restore itself was tripping the line
    (18). So a hold whose ENTIRE remaining swing fits with
    `FAN_RESTORE_FAST_MARGIN_AMPS` (1.0) of `spendable` to spare climbs home in
    ONE command and owes `FAN_RESTORE_AFTER_CUT_FAST_MS` (60 s) instead of the
    full 120 s window.
    ⚠️ The fast path is judged on **`spendable`** — headroom net of 58's flicker
    charge — which is what makes it arithmetically unreachable exactly where the
    bounce lives: on the saturated line of 58's first incident `spendable` never
    reaches swing + 1.0 (the zero-churn ACCEPTANCE scenario is the proof). Every
    other gate is untouched in both paths: the 60 s first-gear calm gate ("may
    this fan come back at all" deserves its calm minute however much room there
    is), the self-ramp skip (59), the fan debit armed at exactly the price
    admitted (18), and the fromCut/gentle distinction. Journalled as
    `fan restore step (fast: …A swing, …A spendable)` — a fan that comes all the
    way back in one batch and a fan that BOUNCED are the same line in a command
    log, told apart only by what the budget was at the time. The label is scoped
    to `fromCut` holds: a gentle hold never owed the cut wait and its auto
    original was always one jump, so the claim would over-state (the GATE still
    applies to both).
    ✅ RESOLVED 2026-08-08 (user-confirmed, *"fan 1 is emergency-only and should
    not take too long to come back"*). *Was OPEN:* on a flickery line `spendable`
    was permanently smaller, so a GENTLE hold sat pinned at fan 1 longer than
    before 58. Now `spendable` charges the flicker PER HOLD — only the `fromCut`
    side pays the margin (the 13:12Z bounce lived entirely there); a gentle pin is
    admission pricing, not overload relief, so it is judged on bare headroom. A
    gentle hold also owes `FAN_RESTORE_GENTLE_CALM_MS` (30 s) first-gear calm
    instead of the full `FAN_RESTORE_CALM_MS` minute (it was never CUT, so there is
    no bounce to guard). And with 70's early ramp release the fan clears its own
    self-skip (59) once the compressor plateaus, so it now returns ~60–95 s after a
    landed restore instead of 240 s-plus. See 71 for the 2026-08-09 restore-side
    inversion (fans no longer queue behind fans or lose their tick to a pure raise).
61. **Inside the gap the configured priority breaks a shed tie — anchored on the
    thermometer's own pick, NEVER pairwise.** 14:38:11Z the reducer shed
    Abdullah — priority #1, real need 4.0 °C — because Abdu ranked **0.05 °C**
    hotter and the shedNeed rung rounds to a tenth. Two rooms far inside
    `SHED_NEED_GAP_C` (1.0), the band the user himself calibrated as "equally hot
    — 1 c is enough to switch between acs". His rule: inside the gap the
    configured priority list decides and the top room survives; outside it the
    thermometer rules absolutely (2026-08-04 policy, unchanged). Built as a
    lexicographic refinement of the shedNeed rung and nothing else — feasibility
    and `exportsShed` above it (43), and the cost/overcut/commands/disturbed tail
    below it, are untouched — and only a plan the need rung ranks STRICTLY worse
    than the anchor is promotable (equal-need pairs keep the v1 tail that has
    always decided them).
    ⚠️ **The gap is measured against ONE anchor — `bestRaw`, the winner of the
    same search scored without the tie-break — and never pairwise between the two
    plans in hand.** A pairwise gap test is not a transitive relation and `best`
    is a streaming best-so-far scan, so the winner of a chain would depend on the
    order the search happens to enumerate leaves in. Staircase three rooms 0.6 °C
    apart (4.0 / 4.6 / 5.4): every adjacent pair is inside the gap and the ends
    are not, so shed-mid loses to shed-low on priority and then shed-TOP takes the
    incumbent on raw need — **the room the rule exists to protect goes off,
    silently, with the journal reporting a plain thermometer choice.** Both
    reviewers proved this independently with executed repros before it ever ran
    live. Anchoring makes the rule a property of the FIELD of candidates (what the
    user actually stated) and a total order (what the scan needs); it costs one
    extra pass of a few hundred leaves, run only when there IS a shed to
    re-decide. Protection is `protectedIndex` — the best-protected room a plan
    takes OUT OF SERVICE, keyed on `outOfService` and not `level == null`, so the
    rule cannot save a room from the off and then hand it a silent one (36); a
    plan that takes nobody out is never promotable. Journal: `— priority decided`
    appended to the `shed choice` detail, and only when the pick and `bestRaw`
    genuinely disagree about WHO goes off. A silent tie-break is the next
    forensic mystery.
62. **The TOP-priority room's own turn-on exports to any room that is genuinely
    cooler** — the user amending his own 2026-08-03 rule, 2026-08-06 evening
    ("can turn Najat off instead"). 15:48:47Z Abdullah, priority #1, need 4.0,
    was shed by his OWN click while Najat sat 0.6 °C cooler and running, because
    0.6 is inside `SHED_NEED_GAP_C` and invariant 43's bar protects the
    comparably-warm bystander; then at 15:52:46Z the swap (57) traded Abdu off to
    bring Abdullah back. Three rules composing correctly into a bad outcome — the
    third such cycle that day on the room the priority list exists to keep
    cooling, and a room cycled to reach a state one step would have. Told the
    cost, the user took the trade: for that ONE room the export bar drops from
    `+SHED_NEED_GAP_C` to **strictly cooler at the shedNeed rung's own tenth
    rounding**, so a room the thermometer cannot distinguish from the causer is
    not cooler and the causer still undoes its own turn-on. Every other causer
    keeps the full degree, unchanged: flipping your AC on must not switch off a
    comparably warm bystander (43, bought after a 0.3 A overshoot shed the user's
    own 33 °C room at 20:24:50 on 2026-08-03). Both decisions stand; neither is
    re-litigable.
    ⚠️ "Top" is `config.priority[0] ?? topId` — the head of the CONFIGURED list,
    **never `acs[0]`**, which is merely the first room that happens to be ON. The
    two differ exactly when the #1 room is off, and this file has already paid for
    that conflation once (invariant 10, live 2026-07-28 16:06, where Najat
    inherited the top slot and a surcharge meant for #1 began shielding a
    satisfied room — the same fixture the literal form breaks today). Here it
    would let a #2 room export the overload of its own leveler RESTORE onto a peer
    a tenth of a degree cooler, the opposite of the 2026-07-27 bounce loop's
    ruling that her ramp must undo HER turn-on. With no configured list the order
    handed to the reducer IS the priority, so `acs[0]` is the top room by
    definition.

**Added 2026-08-07 after the post-deploy forensics (premature sheds, double sheds, the swap-vs-manual fight, a silent disable):**
63. **A lone banked raw reading may never SIZE a shed — the MEDIAN branch needs a
    quorum too.** `requiredSavingsAmps`'s flicker-discounted median term speaks
    only once `OVER_MEDIAN_MIN_READINGS` (3) have banked; below that count the
    smoothed-overshoot floor stands ALONE. `median([x]) === x`, so a median of one
    or two readings is a single transient VERBATIM. Live 2026-08-07 05:40Z
    (journal #9343): one ~17.84 A compressor-inrush sample banked while the
    SMOOTHED mean sat 12.675 A against a 14 A limit and flicker read 0 (a lone
    non-reverting spike is no excursion the estimator sees) — `median([17.84]) −
    14 − 0` sized a **3.94 A** deficit that classified "extreme" purely because it
    cleared the threshold, and a 2-ton room went off with 1.3 A of real headroom.
    Not isolated: in 24 h, **10 of 16 severe/extreme rows fired with the MEAN
    already under the limit and 6 shed a room** (#9308 sized 1.49 A off a lone
    16.39 A at 13.215 A; #9175 sized 6.32 A off ~21.7 A at 14.245 A). The streak
    branch (invariant 49) already carried this guard (`SEVERE_STREAK_READINGS`);
    its argument bounded only the fallback's LOWER end — the smoothed overshoot is
    a floor, so it never sizes too SMALL — and never the upper, where one raw
    reading times the median at whatever it likes. **Hard rule 5c a second time**:
    a guard sized against only part of what it guards. No reaction time lost — a
    genuine fast overload banks its two severe readings within ~10 s and the
    streak branch sizes it undiscounted before this branch is ever reached.
64. **The outrun void is read-side and stays; the escalation and settle HOLDS get
    their own landing grace.** Invariant 38's `pendingCutCredit` zeroes the credit
    the instant the smoothed meter rises past the cut's send-time anchor by more
    than the flicker, with NO minimum age — correct and load-bearing (a house
    genuinely outrunning its cut must reach the last rung; it cost a breaker on
    2026-08-03). But a SECOND compressor ramping independently at the moment of a
    shed — a restore, or a power-blink restart — ticks the smoothed meter past the
    anchor within a reading or two, zeroes the credit, and dropped BOTH holds while
    the first shed's own off was still minutes from the meter. Live: four
    double-sheds in 24 h, the second room 2.5–5.5 s behind the first (#8929→#8930,
    **#9180→#9181 2.5 s apart with the meter RISING**, #9213→#9214, #9369→#9370) —
    physically before the first off could reach the 8-wide smoothed median (median
    lag alone ~12–20 s; a compressor wind-down is minutes). So both holds also fire
    while the newest cut is `settling` per `cutTrendOf` (a cut exists, is younger
    than `CREDIT_LANDING_GRACE_MS` (60 s), its fall still short), whether or not
    the void has zeroed the credit: `cutLanding = commandedCutCreditAmps > 0 ||
    cutTrend === "settling"`. `escalationHold` holds SEVERE while `arriving` OR
    `settling`; `settleHold` still covers mild when `commandedCutTotalAmps ≥
    rawRequiredAmps`. ⚠️ EXTREME is NEVER held — its sustained clock and
    required-sizing are the emergency escape, and invariant 48's "fires on
    `stalled`" contract stays intact: a genuine runaway inside the 60 s still
    reaches the last rung.
65. **"Manual wins" covers the POWER BUTTON for the comfort tool.**
    `AcView.recentlyExternalOn` — stamped on a REST manual-ON (`onUserPowerOn`) and
    on every observed external ON (a bare OFF→ON flip of an un-shed room, and a
    shed room's shadow reading ON), live for `EXTERNAL_ON_DONOR_SHIELD_MS`
    (15 min) — bars a room from `swapDonorFor` selection: the gated proactive shed
    (57) is a comfort optimisation and may not un-do a human's explicit ON. Fifteen
    minutes is deliberately `AC_POWER_EVENT_GRACE_MS` /
    `POWER_EVENT_LEVEL_JUMP_GRACE_MS`, because a TCL power-blink RESTORES its last
    level, which in the shadow is character-for-character an external ON (invariant
    56) — the two edges judge on one clock or they drift. ⚠️ Deliberately NOT
    cleared on a source change: a person's choice survives a changeover, unlike the
    victim/funding cooldowns, which are per-LINE physics. Ordinary overload sheds
    are unaffected — invariant 43's causer logic is untouched; only the comfort
    TRADE is barred. Live 2026-08-06 18:35–19:14Z: the leveler shed the
    priority-#1 room FOUR times (two reduces plus the swaps #9224/#9228,
    audit-proven) while a household member re-enabled it THREE times, and the
    occupant then disabled the whole controller for **7 h 12 m**. Cross-reference
    57.
66. **A widened shed grace must tell a stale echo from a human's hand.**
    `SHED_CLEAR_GRACE_MS` 15 s → **60 s** — invariant 4's send-to-confirm lag runs
    5.8 s to 13 min, and #9268/#9270 (2026-08-07 04:15Z) is why: at gen entry the
    leveler shed Najat and 17.4 s later sent a GENUINE DUPLICATE `power_off`, but a
    stale still-ON shadow at 17.4 s straddled the old 15 s grace, cleared the shed
    mid-flight, the recovery-admission recompute saw "on, not shed" and re-shed
    her, and the `power_off` dedupe (`SHED_RESEND_SPACING_MS`) was blind because it
    keys on `shedIds` membership that had just been wrongly cleared. ⚠️ **Widening
    ALONE would violate "manual wins" (42):** a remote re-enable 20 s post-shed
    would read as a stale echo and the 30 s off-resend would fight the human — the
    exact #9224/#9228 class. So `shedOffObservedAt` (stamped in the tick device
    loop the moment a shed room's shadow reads OFF; cleared with the shed record in
    `clearShed`/`recordShed`; reset on load) three-ways `reconcileObservedOn`: off
    observed before the ON → external hand, clear IMMEDIATELY + shield stamp (65);
    off never observed and inside the grace → stale echo, shed kept intact so
    confirm-or-resend re-sends it; past the grace with no off ever seen → clear +
    shield stamp. Harness note for the known-debt list: this state is shell-side —
    `scenario.ts` does not mirror the device-poll path — so `controller.test.ts`
    is the only net.

**Added 2026-08-07 (afternoon) after Najat was shed five times in 23 minutes on a derated ceiling:**
67. **A bounce compounds the shed-trough BAR's persistence, not the admission
    ladder.** The strain derates (13:41/13:56Z, ESP power-feed gaps near a 14.4 A
    mean — invariant 47) pulled the gen ceiling to 14.0–14.5 A under a settled
    three-room ~14.8–15.6 A house, so that configuration was un-affordable by
    arithmetic and the restore path retried the WHOLE three-room end-state every
    ~5–6 min. Each round the own-shed-trough bar (54) refused CORRECTLY for exactly
    its 300 s window — committed 12.4–12.6 A, needing 2.3 A against a 13.9–14.4 A
    ceiling — then EXPIRED ON THE CLOCK, and the next admission spent the very
    trough the bar exists to disbelieve. Restore→re-shed gaps were 52–69 s, and the
    admission ladder's early rungs (`BACKOFF_LADDER_MS` 30/120/300 s for failures
    1–3) are ALL ≤ the 300 s bar, so `canAttempt` was already satisfied when the bar
    expired: the BAR, not the ladder, was the binding shed→restore clock and its
    300 s plateau WAS the cycle period. The probe re-arm (22) was price-side and
    orthogonal — every trough sat ≥ `PROBE_REARM_DROP_AMPS` (1.0) below the failed
    attempt's anchor, re-enabling the gentle price each round, which governs WHICH
    price admits, not WHEN. So a genuine `power_off` re-shed inside the blame window
    — a BOUNCE (`AcPacing.bounces`, booked only through the `isShed` gate in
    `noteFailure`; a `set_level` cut of a recently restored room is a ladder
    failure, not a bounce) — doubles `barPersistMs` per consecutive bounce:
    1→600 s, 2→1200 s, hard-capped at 1800 s (30 min). Invariants 39 and 54 both
    named this ("a restore re-shed within N minutes must slow the ladder") as their
    missing prerequisite; this is it, finally built.
    ⚠️ **The ladder is left alone deliberately, and the fix is
    restore-admission-side ONLY.** Compounding `canAttempt` broke invariant 22's
    contract — its no-bar tests rely on the ladder EXPIRING so a genuine
    (bar-released) drop re-admits — and the bar is precisely the gate that
    discriminates a genuine-headroom drop (22 → re-admit) from a
    survivors-mid-cycle trough (hold). Leaving the ladder untouched also keeps the
    reducer's re-shed penalty (`reshedPenalized`) unmoved, so invariant 39's
    unconditional non-cooling form stays rejected: this compounds only the
    persistence of a refusal, it does not add one.
    ⚠️ **Nothing may block unbounded (22's spirit) — four release valves.** The bar
    is ABSOLUTE amps, so a RISING ceiling (derate recovery, 47) admits
    arithmetically with no clock at all; a peer LOAD REMOVAL credits the bar down
    (`creditPeerShedBars`, deduped per device by `OFF_CREDIT_DEDUP_MS` (60 s)
    because `creditRoomOff` can observe one physical off twice — the REST tap, then
    the device poll, which `onUserPowerOff` never suppresses); a restore that STICKS
    (`noteSuccess` past the whole blame window) resets the count; a source change
    wipes everything (per-line physics).
    ⚠️ **The episode ends on an EXTERNAL ON.** `noteExternalOn` — the same sites
    that stamp `externalOnAt` for the swap-donor shield (65) — clears the count: a
    human/blink ON means the leveler's restore episode is OVER, and a stale count
    would hand a FUTURE unrelated shed a 30-min bar (reviewer-caught). ⚠️
    Deliberately NOT cleared on our own `restore_confirmed`: the shadow confirms
    seconds after the send while the bounce books ~60 s LATER at the re-shed, so
    clearing there would cap the counter at 1 forever and kill the compounding
    (pinned by a `controller.test.ts` guard, "⚠ would cap it at 1"). LOUD: the
    refusal journals `bounce backoff (Nth bounce — …s wait, …)`.
    Harness note for the known-debt list: the off-credit dedup and the whole bounce
    lifecycle are shell-side (`controller.test.ts` guards); `scenario.ts` mirrors
    the bar arithmetic and `clearBounces` but collapses the two `creditRoomOff` call
    sites into one, so `scenarios.test.ts` structurally cannot see the
    double-credit path.

**Added 2026-08-08 after the 02:44Z gen entry (slow restores behind a working controller):**
68. **A restore refused ONLY by the flicker margin is patient, not stranded.** A
    restore that fits the BARE ceiling and fails only on 58's flicker charge
    (`chargedRestoreCeiling`) is a room waiting for a steadier line, not a room
    physics cannot carry — so it is no longer an ordinary skip. It journals
    `blockedBy: "flicker margin"`, RESERVES its bare cost once its anchor stands
    (closing 58's open ⚠️ — a peer raise can no longer spend the amps it is waiting
    on), and after `FLICKER_PATIENCE_MS` (120 s) of UNBROKEN flicker-only refusal
    admits at the bare ceiling with a `flicker patience: …` note. 02:44Z gen entry:
    Abdu shed at entry, then sat refused behind the margin while the rest of the
    afternoon proved the line carried him fine.
    ⚠️ The streak anchor is SHELL-owned (`controller.flickerRefusedSince`, stamped
    from the plan's `flickerRefused` list) and a tick that never RAN the raise phase
    — SETTLING after any batch, an over-limit episode, FLOORS — reports nothing and
    must NOT break the streak: SETTLING follows every batch, so wiping the anchor on
    it would restart patience forever on a busy line (caught in review). ⚠️ The
    120 s sits far outside the 34 s double-shed shape 58 was written against, so a
    patience window this long can never re-create it — and a patience admission that
    is WRONG is not silent: it re-sheds and winds invariant 67's bounce backoff, the
    net under it. Swap receivers never qualify (they are already judged at the bare
    ceiling — `ceilingFor`), and a refusal that ALSO fails bare stays a plain
    no-headroom skip that reserves nothing (the first refusal tick, before its
    anchor exists, likewise reserves nothing).
69. **A funded trade ships in ONE batch** (user, 2026-08-08: *"switching acs …
    make that instantly, no need to wait — the AC won't run full at the first
    moment"*). The gated proactive shed (57) now emits the donor's `power_off` and
    the receiver's gentle `power_on` TOGETHER, and an ordinary funding demote ships
    with the raise it funds when `jump ≤ available + freed − REBALANCE_FUND_MARGIN_AMPS`
    (the meter-blocked branch re-asserts the envelope with the demote overrides as a
    belt — demoting a peer only LOWERS the end-state). Physics licenses the instant
    sequencing: the donor's cliff reaches the meter in ~10–40 s while the receiver's
    compressor engages MINUTES later (TCL restart protection + soft-start), so the
    two never overlap on the line — and the committed-meter machinery already prices
    the gap (the off credited via `commandedCutAmps` so its cliff cannot latch a
    phantom collapse, 11/31; the on arms `pendingOn` + a ramp debit, 12/28; the
    receiver's `candidateCommitted` already reflects the saving, 41). It spares the
    receiver the 36 s-plus wait it used to sit out for a LATER tick's committed
    meter (02:44Z).
    ⚠️ The receiver is admitted at the PLAIN learned price, never the probe (3): it
    is NOT in `probeRestoreIds` and its recorded fan hold is `gentle=false`.
    `controller.swap`'s reservation still arms and now exists for the FAILED-SEND
    case ONLY — the old "swap landing" deferral branch is the retry path for a
    receiver that never confirmed ON. ⚠️ ACCEPTED COST: a batch with TWO meter
    commands is never graded (`meterCmds.length === 1`), so the trade forfeits the
    donor's off-drop evidence (55) and the receiver's free `on@L` sample — inherent
    to instant sequencing, since a window born beside another command is born
    contaminated anyway (23). The demote-ALONE fallback (invariant 9's deferred
    path) stands whenever the freed amps do not close the gap with margin.
70. **Amp evidence releases the actuation timers, not only the clock** (user,
    2026-08-08: *"we can watch the amps to know if it worked and stable without the
    need to wait the end of time"*). `AcView.ramping`'s 240 s window (`rampUntil`)
    used to expire only on that clock; `maybeReleaseRampEarly` (controller.ts) now
    closes it the moment `rampProvenDone` fires — which gates the raise phase, house
    sampling, swap-donor eligibility, the fan restore's self-skip (59) and the FLOORS
    "nothing ramping" clear, all of which waited out the full four minutes even after
    the meter had shown the compressor land and settle. "PROVEN done" has TWO halves,
    both required: the ratchet crossed the "a compressor started" bar
    (`rampReleaseBarAmps`) AND has PLATEAUED — grown less than
    `RAMP_SETTLED_EPSILON_AMPS` (0.15) for `RAMP_SETTLED_STALL_MS` (45 s, ≳2× the
    8-wide median's ~12–20 s lag).
    ⚠️ The plateau is required EVEN at full absorption, and it is load-bearing: the
    committed figure is the MODEL draw, and an UNDER-MODELLED compressor crosses its
    model while STILL CLIMBING. Releasing there is mid-ramp, not stable — an executed
    repro re-opened the 2026-07-27 shed-the-bystander shape (Najat's real 3.7 A L1
    against a 2.7 A model dropped `ramping` ~15 s before her transient tipped the
    breaker, and the reducer shed the innocent hotter room), which is why "worked AND
    stable" needs both halves. ⚠️ NEVER on flatness alone: a ratchet UNDER the bar is
    the restart-protection dead window (44) and keeps its full clock plus the
    extension machinery. The committed price is ONE helper (`rampCommittedAmps`)
    shared with `rampDebitAmps` — the 2026-08-05 lesson that two sites pricing one
    quantity eventually disagree.
    And the SETTLE window: `clearSettleIfDone` (modes.ts) ends SETTLING early
    (≥ `FAN_SETTLE_MS` 10 s floor) only when NOTHING is owed in either direction
    (`commandedCutTotalAmps ≤ 0` AND `rampDebitAmps === 0`, wired as
    `unabsorbedSpendAmps`). ⚠️ Deliberately the FULL-landing condition, NOT "the cut
    is arriving" (35 % landed): `escalationHold`/`settleHold` (pipeline.ts) key on
    `mode === "SETTLING"`, so exiting mid-landing would drop the invariant-64
    double-shed holds — but at full landing those holds are vacuous by construction
    (credit and total are 0), so no protection is lost; it may only ever make the
    window SHORTER. Learning windows, calm durations, pacing, and the shed-trough
    bars are untouched.

**Added 2026-08-09 after Abdu's fan sat at speed 1 for ~10 minutes with ~2A idle (the 16:22Z gen cycle, journal #11098–#11126):**
71. **The restore side is the reduction ladder's INVERSE: shed restores ≫ fan
    restores ≫ level raises — and fans do not queue behind fans.** The ladder cuts
    levels → fans → sub-floor → a room off (24–29); coming back it must climb
    those rungs top-down — off is worse than any level, a fan is cheaper per
    comfort than a compressor level — and a fan hold must never wait behind
    ANOTHER hold's fan step. Abdu's fan was cut 7→5→4→2→1, a room shed freed
    ~2.3 A, and his fan then did not START climbing for ~9.8 min while the meter
    idled ~2 A under the limit: parked behind Abdullah's fan restore and an L2→L3
    raise that kept resetting the shared calm clock, and behind a flicker-patience
    reservation (68) that zeroed the fan budget.
    (a) **The fan path keeps its OWN calm clock.** `MeterState.fanCalmSince` /
    `MeterView.fanCalmMs` run EXACTLY parallel to `calmSince`/`calmMs` — the same
    reading breaks and stamps both — and diverge only through
    `resetCalm({ fanSpend: true })`: a fan-only restore SPEND rewinds the MAIN
    clock (invariant 18's protection is untouched — two fatal raises 12 s/17 s
    after a fan restore still cannot land on the amps the fan just took) but SPARES
    the fan clock, so a fan hold's 60 s first gear no longer counts down behind
    every other hold's fan step. Live cost of the shared clock: Abdullah's fan
    restore (16:31:33) and his L2→L3 raise (16:32:08) kept rewinding the clock
    Abdu's first gear was on, and the raise took the freed amps. A CONTINUATION
    gear now also owes its OWN last-gear spacing via `hold.lastRestoreAt` (the
    shared reset used to supply "has the last gear landed" implicitly; without it a
    climb would take a gear every tick). A fan CUT rewinds NEITHER clock — it frees
    amps.
    (b) **A PURE level-raise batch stands down ONE tick for an admissible fan
    step** — journalled LOUD as `raise deferred to fan restore`, naming the raise
    that yielded and the fan that displaced it (a silent preemption is the next
    forensic mystery). "Pure" = a raise with NO restore, swap, funding donor or
    correction: those are off-relief or safety and are NEVER preempted. The fan
    step is evaluated UP FRONT (before the raise batch ships) so the raise can see
    it. Starvation is bounded — a climb ends, and (c) stops the raise being
    deferred to a phantom step forever.
    (c) **`FAN_RESTORE_RESEND_MS` (60 s) confirm-or-resend.** A TCL `set_fan`
    shadow can lag seconds to minutes, and the climb reads the OBSERVED shadow
    (`ac.fanSpeed`) to pick the next gear — so an unconfirmed step used to
    re-propose the SAME command every own-gear tick (~20 s), each re-arming the fan
    debit and, via (b), standing an admissible raise down on a step that had not
    moved. While our last step is unconfirmed (observed fan below what we
    commanded) the climb holds until this window elapses, then resends once.
    Mirrors the level/demote confirm-or-resend; the send-side 30 s `lastFanSent`
    dedupe cannot cover it (keyed on `trim`, not `trim_restore`, and it cannot stop
    the pure-planner raise deferral).
    (d) ⚠️ **A live shed-restore reservation parks even a ONE-GEAR fan step** —
    re-affirmed 2026-08-09, now as an explicit rule. A bounded carve-out (a single
    gear under the reservation) was BUILT and REMOVED the same day on independent
    review (Codex, FIX-FIRST): during a restore's send→confirm window
    (5.8 s–13 min observed) the commanded compressor has NO ramp debit yet, so the
    reservation is the ONLY protection of those amps — a carved gear could push the
    reserved room's BARE fit into failure, silently deleting its flicker-patience
    anchor (68), and a fan resetting a shed room's 120 s patience clock inverts
    THIS invariant's own ordering. It was near-worthless in the birth incident
    anyway: flicker + ramp debits had already consumed the carved budget in every
    window.
    (e) **Harness/tests.** `scenario.ts` mirrors the split `resetCalm` (the
    `fanSpend` option); the `fanCalmSince` lifecycle guard lives in
    `controller.test.ts` (shell-side, the only net for `meterState`). The
    2026-07-31 anti-cascade scenario DROPPED its "a single full swing must STICK"
    clause — a deliberate consequence of (a): with the fan no longer queued behind
    peers' restores, one boundary-timed full-swing bounce can now occur in a
    pathological 75 s over/75 s under storm and converges via the (untouched)
    bounce-compounding ladder (67, one rung down) — and GAINED a `trim_restore ≤ 4`
    count cap, because a bounded-step limit cycle (7→5→3→1→3→1→3: zero full swings,
    exactly 3 reversals) was invisible to the fullSwings/reversals guards. A new
    acceptance scenario pins a cut fan fully home within 150 s of a shed (live it
    took ~9.8 min).

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

**Reduction ladder:** levels → floor → fans → **sub-floor levels** → the COOLEST room whose single
off covers the deficit → (only if none does) the coolest TWO in one batch (invariants 17, 18, 25, 26,
50). Once a rung reaches an off, a hot room's sub-floor cut is priced as an off too (invariant 36),
and past a room's boost band its sub-floor levels are not enumerable at all (51/52).

**Fans are last-resort trim only** — a plan may cut a fan only if its end-state leaves EVERY AC at its
floor (invariant 17); restores are bounded and cooldown-gated (invariant 18). (v1 cut fans while level
cuts were available 57% of the time and bounced them at 61 s median; v2 reproduced the bounce at 80 s
until 2026-07-31.)

## Hardware truth (2026-07-23, user-verified)

**Meter (2026-08-29): the CT02 clamped on the mains is THE household meter now; the ESP is retired.**
It feeds the same ingest path (`ct02-feed.ts` → `createRouter().ingestPower`, flag `CT02_POWER_METER`),
so on GRID the measured total now includes the grid-only guest AC (the ESP never saw it); GEN is
unchanged. The ~1 s stream reaches the controller at **≥ 4 s** (`LEVELER_FORWARD_MIN_GAP_MS`) so the
reading-count-tuned statistics still hold; a 1 s retune is an open user wish. Changeover-gap
semantics carry over unchanged (the CT02 power-cycles ~15 s at a changeover and reads like the
ESP-era blackout gap), and the first real changeover on the new meter is the live watch item. Full
detail: `docs/CT02_FLASH_PLAN.md` (ESP-SWITCH RECORD 2026-08-29).

Abdu = **2-ton** (≈ 4.1 / 6.5 / ~9 A at L1/2/3). Abdullah & Najat = **1-ton** (≈ 2.2 / 3.9 / 5.3 A).
⚠ The registry `model` field is protocol-inference only — **its capacity digits are WRONG** (see
`docs/agent/tcl-ac.md`).

**Abdullah at L1 in high outdoor heat may not cool at all** (user, 2026-08-03): above his configured
boost threshold the compressor often will not engage at L1, so the room draws roughly its fan and
becomes *effectively off* while the model still prices it at ~2.3 A. It is a "most of the time"
behaviour, not a certainty — on 2026-08-03 at ~39 °C he was still running at L1. This is what
`levelBoosts` (minLevel 2 above N °C) exists to prevent; the **sub-floor rung (invariant 25) may
still cut below an active boost floor**, and `invariantCorrections` deliberately will not lift him
back (that re-assertion was the 08-02 limit cycle), so only the raise path can — which is why
**invariant 36** prices that cut as an off on the reduction side and gives the stranded room
precedence over a less-needy shed restore on the recovery side.

**Abdullah's thermometer reads ~1 °C high, and his comfort target is his own setpoint** (user,
2026-08-05: "consider the room temp is what we get from the AC − 1 °C, and the target is what is
set, currently 27"). Expressed as config, never code: `needOverrides` in the leveling config —
`{ Cy3aihFAAAE: { tempOffsetC: -1, targetFromSetpoint: true } }`. The offset is a sensor calibration
and applies everywhere leveling reads his thermometer, **including `rankNeedDelta`**; the setpoint
target moves only his OWN `needDelta`/tier — never the rank, which keeps asking every room the one
shared question (invariant 50). Setpoint missing or ≤ 0 → falls back to `comfortTargetC`; a matching
metric range rule bypasses the override entirely (none active on deploy). Set via
`PUT /api/ac/leveling`; a dashboard save that omits the key preserves it.

**Measured gen draw** (`GET /api/ac/calibration`, 2026-06-11, 12–14 samples each): Abdullah
2.08 / 3.81 / 4.32 · Abdu 4.08 / 5.66 / 6.21 · Najat's gen run failed (0 A). ⚠️ Each step was sampled
~50 s after the command against a 240 s ramp, so **L2/L3 read low** — invariant 6's bug, in the
calibrator. Treat them as lower bounds and cross-check against the user's hardware truth above.
Abdullah's gen model was corrected to base 2.3 / step 1.5 on 2026-08-03 (was 2.3 / 2.5, pricing his
L3 at 7.3 A — above the 2-ton's measured L3). **Abdu's 2026-06-11 numbers are now SUPERSEDED by a
2026-08-19 CT02 clamp measurement** — the Tuya CT02 clamped directly on his AC circuit fed ~29 h of
60 s medians, dominant-cluster per (source, level, fan), n=38–332 per level. His gen AND grid models
are now both `{4.2, 1.9}` ⇒ **4.2 / 6.1 / 8.0 A** at L1/2/3 (delta-from-standby, matching measured
p90-minus-baseline 4.17 / 6.13 / 8.03), and `ac_calibration_results` now carries his mined per-state
rows. **Najat (2.3/2.0 ⇒ 6.3 A at L3) is still over-priced against the same evidence — not yet
corrected.** Two fan findings from the same clamp: a gear costs ≈ **+0.03 A** with the compressor
pegged (the book `fan:step` 0.15 A/gear is high), and the indoor fan STOPS when the compressor idles,
so the unit reads its 0.26 A standby ("fan-only" ≈ off).
⚠ Do NOT diagnose this from the house-load figure: the residual is `smoothed − modeled draw`, so a
room drawing less than its model inflates "house" by construction and the reasoning is circular. The
honest signal is the ATTRIBUTABLE one — a graded lone off's DROP against what the model priced (55).
A graded lone raise's RISE reads well but is not attributable (56): the rise is a whole-house delta
with no non-AC load subtracted, so it is journalled and never acted on. ⚠️ The room TEMPERATURE
failing to fall is NOT one of them
(superseded 2026-08-06, invariant 56): a working compressor routinely shows no progress for a long
time on a Baghdad afternoon, and a room parked at a level *because it is satisfied* cannot show
progress at all.

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
- **Config audit:** `ac_leveling_config_audit` records every `PUT /api/ac/leveling` (`auth_kind`,
  `ip`, `user_agent`, `changed_keys`, and the `enabled` flip); an enabled flip also PUSHES to the
  leveling-alerts audience (OFF critical, ON an all-clear) — the 2026-08-06 silent-disable gap.
- **Tests:** `server/src/leveling/*.test.ts` — `scenarios.test.ts` replays incident regressions against
  the physics harness (`scenario.ts`), plus `controller.test.ts` and `pipeline.test.ts`.

Related: `docs/agent/ac-automations.md` (rules, hysteresis, manual-off locks) ·
`docs/agent/tcl-ac.md` (cloud protocol, model quirks).
