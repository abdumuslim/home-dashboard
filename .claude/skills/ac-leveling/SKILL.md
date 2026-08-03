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
    median's 2-reading lag cannot refill the bucket it just drained.
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
    window used to be two readings wide and did not know it (the 4-median flips
    on the third post-cliff reading) — `cliffAnchor` holds the pre-fall mean for
    `CLIFF_ANCHOR_MS` (30 s).
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

**Known harness debt (2026-08-03) — the reason none of 31–35 was caught in test:**
`scenario.ts` declares `pendingOn` but never WRITES it (invariant 28 is
structurally unexercisable), mirrors none of the send-side dedupe, has no
grading shell (`pendingGrades`/`bornContaminated`), and its `trip()` modelled a
4 A residual — under the old absolute floor, so the live failure could not be
simulated at all. `residualAmps` is now settable per scenario; the rest stands.

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

**Reduction ladder:** levels → floor → fans → **sub-floor levels** → ONE room off → (re-evaluate) →
next room off (invariants 17, 18, 25, 26).

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
