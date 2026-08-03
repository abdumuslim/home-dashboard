---
type: Reference
title: 'Smart AC Leveling & Per-AC Calibration'
description: 'A ground-up rewrite lives in server/src/leveling/ (19 small modules, pure decision functions + one stateful shell), built after a week-long forensic review (82 emergencies/32h, fan cascades, 49m–1h18m restore strands,…'
tags: [home, dashboard, claude-code, current]
maintainer: claude-code
timestamp: 2026-07-28
---

<!-- Tier-3 agent doc. Loaded on demand via CLAUDE.md / AGENTS.md routing table. -->

# Smart AC Leveling & Per-AC Calibration

## ⚡ LEVELING v2 (ACTING since 2026-07-24 cutover)

> **Status:** v2 is the **acting controller** (config `controller: "v2"` in `ac_leveling_config` row id=2). v1 (`ac-leveler.ts` + `ac-leveling.ts`) is kept only as the **instant rollback target** — flip the flag back to `"v1"` via `PUT /api/ac/leveling` and `docker compose restart` (v1's boot-once state is stale after v2 acted). After a ≥1-week soak, delete v1 and its tests and fold this section's history into the main doc. **Everything below the "TL;DR (v1)" divider documents v1 — historical, rollback-only.**

A ground-up rewrite lives in **`server/src/leveling/`** (19 small modules, pure decision functions + one stateful shell), built after a week-long forensic review (82 emergencies/32h, fan cascades, 49m–1h18m restore strands, 16.6A post-collapse double-raise; most breaker trips proved EXTERNAL street-gen failures). Selected by **`controller: "v1" | "shadow" | "v2"`** stored in `ac_leveling_config` **row id=2** (v1's save path would clobber unknown fields in row id=1, so v2 owns its own row; merged with id=2 winning; re-read every 30s → **live-flippable via `PUT /api/ac/leveling`, instant rollback**). In `shadow`, v1 acts while v2 journals every decision with `executed=false`.

### 2026-08-03 — the two breaks the flicker rework did not stop (and the ones it caused)

The 2026-08-02 rework shipped into the evening generator peak across five deploys, with hot-fixes
committed minutes apart. It cured what it was aimed at — the Najat shed storm is gone, and the
overnight journal contains **zero sheds** — but the household got **two generator breaks** that
evening, at 17:39–17:40Z and 17:45Z, and the controller reported healthy through both. Invariants
31–35 in the SKILL are the normative list; this is the incident record.

**Break #1 (17:40Z).** A raise landed at 17:37:26, then the user turned Abdullah on at 17:38:18
(audit) and the firmware brought him back at L3. The mean rode 15.0–15.5 A for two minutes. The
reducer commanded ~8.8 A off in three batches inside 12 seconds — all of it level cuts and fan
trims, whose compressors wind down over minutes. The one actuator with instant physics, undoing that
very turn-on, was unreachable twice over: severity cannot leave `mild` on a 0.3–0.5 A overshoot, and
the inrush blanking band had been widened that afternoon to `limit + 0.5`, which covered the whole
ride. The breaker answered first.

**Break #2 (17:45Z).** The 17:40 cliff left **5.88 A** of house load on the line — over the absolute
5 A collapse floor, so nothing latched. With no latch there was no derate, no COLLAPSED freeze, no
FLOORS on recovery and no notification; worse, the ~6 A trough satisfied the new smoothed-calm rule
completely, so the controller **raised into a line that had just cut out**: Abdu L2 at 17:40:56, L3
at 17:41:31, Najat L2 at 17:42:05, all at a `pre_amps` of ~6.3–6.5. Every compressor restarted
together at 17:44:27 (15.28 → 16.76 A) and the line went down again at 17:45:35.

| Live evidence (UTC) | Cause | Fix |
|---|---|---|
| 15.99 A → **5.88 A**, and 16.76 A → **5.76 A**, neither latched | `POWER_COLLAPSE_FLOOR_AMPS` (5) is absolute; the residual is the HOUSE and the house drew 5.76–6.2 A | Floor is `max(5, 0.5 × pre-fall mean)`; `cliffAnchor` holds the pre-fall mean 30 s so the 4-median flip cannot close the window |
| The same floor cannot tell a trip from switching off the 2-ton room | That room IS most of the load — meter shape alone cannot separate them (hard rule 5b) | `creditRoomOff` prices EVERY off we can know about: dashboard tap, automation, remote (observed flip). Only the unexplained remainder latches |
| Three raises into a dead line at `pre ≈ 6.4 A` | A post-trip trough is textbook "calm": mean far under the limit, raw readings quiet | `unexplained_fall` event + `UNEXPLAINED_FALL_CALM_HOLD_MS` (120 s); an empty bucket with no evidence returns `hold`, never `calm` |
| Two minutes at 15.6–16.0 A classified `mild` throughout | Severity was magnitude-only; mild's repertoire winds down over minutes | `smoothedOverMs` clock: 45 s ⇒ severe, 120 s ⇒ extreme (ONE room, `required > 0` after credit) — **user-approved 2026-08-03** |
| The newcomer's own shed blocked for the whole ride | Blanking widened to `limit + 0.5` on 2026-08-02 | Reverted to `smoothed ≤ limit`; noise-driven crossings are stopped upstream by the flicker-aware bucket instead |
| Abdu at L3 on a 15 A gen for 27 min after the 00:13Z changeover, unpriced, with a peer raised on top | `clearOnSourceChange` wiped `sendCounts`/`sentAt`; the FLOORS clamp compared the stale shadow | Sends survive a changeover (the firmware restores its last commanded level); clamp judges `envelopeLevel`; a preserved send landing late is `landed`, not a manual target |
| Abdullah cut L2→L1 at 00:41:10, raised back at 00:42:44 | No cooldown on the involuntary side (funding demotes had one) | `VICTIM_COOLDOWN_MS` (120 s); both cooldowns clear on a changeover |
| Three cut batches in 13 s, 12.9 A commanded for a 0.4 A deficit | `escalationHold` gated only the SHED rung; SETTLING substitutes the pending level, so each pass re-planned from the level it had just sent | Settle hold covers level and fan rungs when `commandedCutTotalAmps ≥ rawRequiredAmps` (RAW, because the credit is spent as the meter absorbs it) |

**Two-event flicker blindness.** The estimator's stated safety argument — a spike is two jumps and
survives, a real step is one jump and is filtered — holds only while the ring contains at most one
event. **Two compressors cycling inside eight readings is this house's ordinary steady state**, and
it pinned the estimate at its 1.5 A cap, loosening severity, calm, the drain rung and the deficit
sizing simultaneously. It also never reset after a trip, so tolerance was at maximum for the ~8
readings after a breaker had just proved it could not hold. Now only *reverting* excursions count,
and the window is forgotten after any discontinuity.

**Why the tests did not catch any of it.** The harness `trip()` modelled a fixed ~4 A residual —
*under* the old absolute floor — so the exact live failure was unreachable in simulation; `pendingOn`
is declared in `scenario.ts` and never written; the send-side dedupe and the grading shell have no
mirror at all. Every new test in this strand was verified to FAIL with its own mechanism disabled.

### 2026-08-03 (midday) — "a level that does not cool is an off"

The deferred design question from the morning (memory item 7) arrived as a live incident: *"Abdullah
ac compressor just stopped"*. State at 11:33 Baghdad: all three rooms at L1 on a 15 A generator,
meter 13.5 A, and **Abdullah at L1 under an ACTIVE L2 heat-boost floor** (outdoor ≥ 39 °C) with his
room at 28 °C against a setpoint of 20 — the level his compressor mostly will not engage at. He had
been there for 20 minutes and every attempt to lift him was refused.

How he got there, and why he stayed:

| Live evidence (Baghdad) | Cause | Fix |
|---|---|---|
| 11:25:32 `over_extreme`, req 3.65 A → shed Najat (need 1.6) **and** cut Abdullah L2→L1 (need 3.0, top priority), when shedding Abdu (4.3 A, need 1.8) covered it alone | The "protect hot rooms" term (`min Σ shedNeed`) counted only power-offs, so stopping the hottest room's compressor with a sub-floor level scored **zero** | `AcMove.subFloorNeed` — a hot room parked below an ACTIVE comfort floor counts `needDelta × SUBFLOOR_NEED_FRACTION` (0.9), added to the protection term **only in plans that already shed** |
| Nothing recorded him as out of service — no shed row, no restore queue, no push | A level is not a shed; the state was invisible to every recovery path | Same invariant, recovery side (next row) |
| 11:28:38 Najat (shed, need 1.6) restored into the 2.3 A that appeared, while Abdullah's floor buy-back sat blocked | A shed restore structurally outranks every raise, including buying back a comfort floor | Restore phase yields (no reservation) to a **needier** room stranded below its active floor, when that floor step passes the same envelope + meter tests the raise phase will apply |
| 11:29:21 `raise L2 blocked: worst case 15.0 A > 14.9 A` — refused by 0.1 A | Abdullah's gen amp model priced L2 at 4.8 A / L3 at 7.3 A for a **1-ton** unit measured at 2.08 / 3.81 / 4.32 A | `genAmpModels` corrected to base 2.3 / step 1.5 (⇒ 2.3 / 3.8 / 5.3, matching the user-verified hardware truth) |
| The config save that fixed it returned `200` and changed nothing | **`collector.leveling()` routes saves to the ACTING controller**, and v2's `updateConfig` persisted only its own five keys — row 1's `updated_at` still read the 2026-07-24 cutover date | v2 now writes v1-shaped fields to row 1, **merged** over the stored row (never replaced, so an unknown field cannot be dropped) |

The last row is the widest of these: since the cutover, **every dashboard leveling save silently
discarded amp models, limits, margins, priority and level boosts.** Anything a session "changed" in
that config between 2026-07-24 and 2026-08-03 did not actually change.

⚠️ **Why the reduction term is conditional on the plan already shedding.** The first version counted
it unconditionally, and the acceptance scenario immediately answered a ~1 A near-limit deficit by
shedding a room instead of taking the cheap level — exactly the cost the user named when he sketched
this fix ("gives up a reduction rung that exists to avoid a shed"). The ladder order is untouched: a
plan that switches nobody off still wins first, every time. What the term now decides is only *who
pays* once something is going off.

**Live outcome.** With the user's call ("turn Abdu's AC off") the generator dropped to 9.5 A and the
leveler lifted Abdullah L1→L2 on its own 80 seconds later; the meter rose 9.5 → 11.3 A as his
compressor came up, confirming from the meter what the room temperature had been saying. The new
`floor recovery` yield was then observed live at 12:37:24 — Abdullah's stranded floor bought back
first, Najat's shed restore 34 s behind it — which is the 11:28 ordering, corrected.

### 2026-08-03 (12:29Z) — the credit that silenced the ladder for 144 seconds

At 46 °C outdoor the user asked for Abdu's room back (it had reached 35 °C while off). Turning him
on put a third compressor start onto a line already at 12.4 A of 15 A, and the breaker went 3 min
later. The controller's response is the record:

```
12:26:40  over_mild    pre 12.41   → Najat L2→L1     (credit armed 2.0A)
12:26:46  SETTLING     "escalation settle — 2.0A already commanded off covers 1.8A owed"
12:27:12  over_severe  pre 15.61   → Abdullah L3→L2  (credit armed 3.1A)
          … 2 min 24 s of NOTHING while the meter climbed 15.6 → 16.6A …
12:29:36  COLLAPSED
```

`requiredAmps` is the credited figure, so 3.1 A of credit against a ≤1.6 A overshoot read as zero
demand: `planReduction` was handed `requiredAmps: 0` and correctly did nothing, and invariant 33's
120 s sustained-extreme rung — added the day before for exactly this shape, and the only rung that
forces a room off — is gated on `required > 0`. The reducer even recorded what it wanted at 12:27:12:
*"Abdu shed preference (its own turn-on caused this — undo it, not a peer)"*. Severe cannot force a
shed; only extreme can. Fix: invariant 38 — the credit is void while the smoothed meter sits above
the cut's own anchor by more than the live flicker.

Two things this exposed beyond the fix:
- **The collapse latch worked.** 16.0 → 4.7 A latched COLLAPSED, derated the limit to 14 A and froze
  spending — the relative floor from invariant 31, proving out against the failure that latched
  nothing twice on 2026-08-02.
- **Three ACs do not fit on this generator at 46 °C.** After recovery the house sat at 15.0 A on a
  derated 14 A limit with all three rooms at L1 and every fan at 1 — the ladder fully exhausted. The
  controller shed one room (Najat, the least needy) at 12:36:22 and has been cycling
  shed → restore → over → shed since, because the restore path admits her at a 9.5 A meter while the
  settled three-room draw is ~14.5 A. **Open:** the restore admission does not charge the settling
  peers' remaining ramp, so it keeps re-restoring into a house that cannot hold her.

### 2026-08-03 (evening) — the user's rule, measured

At 47.3 °C outdoors the user reported Abdullah down at L1 again and switched it off by hand: **the
meter barely moved.** That is the measurement the morning's design question was missing — a level
nothing was drawing, in a room that had climbed 30 → 34 °C against a setpoint of 20. His rule:

> L1 with Abdullah AC and above the specified temp should not happen unless there is a real helpful
> need and within only 2 temp degrees above the specified, otherwise it consider off, and that should
> be considered as it is the higher priority. … at the 2 degrees, the system should watch it if the
> compressor fall.

Shipped as invariants 39–41. `isNonCooling()` in `needs.ts` is now the single definition of "this
level is an off", consulted by the reducer and by the recovery ranking; the 0.5 °C gate invariant 36
shipped with is replaced by his 2 °C; and `subFloorStalledMs` is the watch inside the band — 10 min
below the floor with no cooling progress is an off however close to target the room looks, judged on
the thermometer because the amp residual is circular here.

**What was held back, and why.** "Should not happen" argues for counting a non-cooling sub-floor cut
unconditionally in the protection term. That was built, and the acceptance scenario rejected it: on a
line whose MEAN sits under the limit it produced shed → restore → shed → restore, four power commands
in ten minutes, and parked the room at L1 anyway. The reducer refuses the silent answer, its only
alternative is a shed, and the restore path undoes each one because the post-shed meter looks
affordable. So the rule is applied where it changes an outcome without that cost, and the
unconditional form waits on a **restore-bounce backoff** — the missing piece that would let the house
settle at "one room off, the hot room cooling" instead of oscillating.

**Fan-restore churn (shipped later the same day).** The climb charged the full 60 s anti-bounce
window for EVERY 2-gear step, and because a fan restore spends (invariant 18) each step rewinds the
shared calm clock — so a six-gear recovery took three batches minutes apart and the raise path got no
window for the length of it. Live 05:16:29 and 05:17:33 are two steps of exactly that. The long gate
now decides only whether a cut fan may start coming back; the rest of the same climb runs on
`FAN_RESTORE_CONTINUE_CALM_MS` (20 s), which asks the much smaller question "has the last gear
landed". Each gear is still headroom-gated and still arms its own fan debit, and a fresh cut clears
`FanHold.climbStartedAt` so the next episode re-earns the full window.

### 2026-08-02 (evening) — flicker-aware pressure, the sub-floor rung, one-room-at-a-time

Six changes, one theme: **the generator is not a stable line, and the controller was treating its
noise as load.** Invariants 24–29 in `.claude/skills/ac-leveling/SKILL.md` are the normative list;
this is the incident record.

| Live evidence (Baghdad) | Cause | Fix |
|---|---|---|
| Najat shed ×5 in 15 min at smoothed overshoots of **0.02–0.31 A**; one shed at smoothed **14.215 A against a 14.5 A effective limit** (mean 0.3 A UNDER) | Raw spikes drained the leaky bucket AND broke the calm that refills it → the bucket could only ratchet down | `flickerAmps()` estimator (2nd-largest consecutive jump, ring-based); drain classifies on `max(raw − limit − flicker, smoothedOver)`; **calm judged on the smoothed meter** |
| A lone **16.04 A** raw reading against a **14.92 A** mean classified SEVERE — which skips inrush blanking — and shed the top-priority room | Severity keyed off raw readings with a fixed 1 A rung | `isSevereOverReading(r, limit, flicker)`, shared by sensing + pressure; severity also fires on a severe MEAN |
| Fresh turn-ons shed the instant the smoothed meter crossed the limit by 0.02 A | Inrush blanking ended at exactly `limit` | Blanking now holds to `limit + OVER_LIMIT_MODERATE_AMPS` (mild only; severe/extreme untouched) |
| **Abdullah** (top priority) shed ×3 in 10 min: at his L2 boost floor, peers at L1, fans at 1 → a 1.14 A deficit had only a 0.6 A fan trim or a **4.8 A power_off** | The reducer never enumerated a level BELOW `floorOf` | Sub-floor rung (`w.subFloorStep` 40) — levels to L1, never 0, between the fan rung and the shed rung |
| 16:51 **both** rooms off in one batch for a deficit either covered alone | Nothing capped sheds per plan | Search runs at a one-shed ceiling and escalates only when nothing at that ceiling covers the deficit |
| 16:55:29 fan trim → **16:55:34 and :35** two rooms shed, for a ~0.5 A deficit | `commandedCutAmpsOf` priced `set_fan` at **zero** while the planner claimed 0.5–0.6 A, so no credit armed; and a queued re-run started with zero delay on an un-moved meter | Fan trims credited at what the planner claimed; `escalationHold` on the shed rung; `LEVELING_RERUN_MIN_MS` (2.5 s); send-side dedupe for `set_fan`/`power_off` |
| "worst case 17.6 A (incl. **6.0 A house**)" refusing every raise on an 11–12 A meter (real house ~2.7 A) | `runningSetOf` and `ramping` both key off the cloud SHADOW, so a room drawing with a lagging shadow books its compressor as house — tagged with the set that excludes it, the set that recurs on every re-shed | `pendingOn` stands sampling down until confirm; `voidSamples()` retro-drops without-set samples on discovery |
| Najat's gen `on@L1` drifted 4.0 → 3.3 ("unproven") vs an empirical ~2.6–3.0, refusing restores | Every bounce shed graded a negated `on@L1` from a ramp-contaminated window; a room's own restore stamps the ADD clock, so the shed was "born clean" | No negated grade from a ramping/start-window shed; `bornContaminated` checks both clocks; external ONs stamp `lastLoadAddAt`; `GRADE_TURN_ON_MS` 270 s → 315 s (above the 300 s blame window) |

**⚠️ The one that bit during development:** `invariantCorrections` re-asserted the boost floor
unconditionally. With the sub-floor rung that is a **limit cycle** — cut frees amps, floor jumps
back, meter goes over, cut again (six times in 30 min in the acceptance run). Gating it on calm was
not enough; buying a comfort floor back is *spending* and belongs to the raise path, which checks
calm, headroom, envelope and one-step pacing. `ceilOf` is never below `floorOf`, so the raiser
restores it as soon as it is affordable.

**Harness:** `scenario.ts` gained a seeded LCG, `setFlicker({baseAmps, spikeAmps, spikeEveryN})` with
a **deterministic spike cadence** (a random one clusters — three spikes in one 4-wide window lift the
median over the limit, which is a real excursion, not noise), and `externalTurnOn(id, shadowLagMs)`
which splits physical draw from shadow state. Acceptance test: the live trio {Abdullah L2, Abdu L1,
Najat L1} + ~4 A house on a 14.9 A gen holds **30 sim-minutes of flicker with zero sheds and zero
churn**.

**Observability:** `GET /api/ac/leveling` now reports `flickerAmps` and a real `nonAcLoadAmps` (the
measured house peak — previously hard-null); over-branch journal decisions carry
`smoothed X vs Y, flicker ±Z`.

#### Follow-up the same evening: the funding-donor cycle (invariant 30)

Caught on the live journal minutes after the deploy — and visible in the log from 17:06, *before*
the rebuild, so it predates the work above. Najat was demoted L2→L1 to fund Abdu's raise, re-took
the level ~40 s later, was demoted again, and cycled **L1↔L2 every ~45 s, six times**, while Abdu
never climbed at all.

The funding demote ships alone on purpose (invariant 9: never spend a saving that has not landed).
But the receiver stays blocked — `needs 2.8A, 2.2A available` — for as long as the donor's
compressor takes to throttle down, and in that window the donor's own step costs less (2.0 A), fits
the same 2.2 A, and outranks the receiver in the priority list. The donor is simply first in line
for the amps it just donated. Nobody gains a level; one compressor churns.

`FUNDING_COOLDOWN_MS` (120 s) now bars a donor from re-taking the level it funded — the cut's
landing time plus a calm window. If the receiver still cannot afford it after that, the donor gets
its level back rather than being stranded. `RaisePlan.fundingDonors` reports who was demoted;
the shell stamps only those whose demote was actually **sent**.

**Two invariants added 2026-07-26 after three gen trips in 25 minutes — read the incident section
before touching admission:** (a) the meter is NOT a valid budget anchor while a compressor is
ramping, so every spender (raise, restore, fan restore) is charged the committed-but-unmetered draw
of ramping peers on gen; (b) the CONFIGURED limit is not the limit — a breaker that just tripped is
derated for 20 min, so all limit math goes through `effectiveLimit()`, never `limitFor()`.

**Third invariant added 2026-07-28:** (c) **a drop we commanded is not a breaker trip.** Every
reducing batch credits the meter with its own priced saving (`noteCommandedCut()`), and a collapse
latches only on the part of the fall that credit does NOT explain — otherwise shedding the last ACs
on gen freezes the house for 5 min and derates the limit for a blackout that never happened. See the
2026-07-28 incident section.

**Three more added 2026-07-28 evening (the budget-hog incident — read that section before touching
the envelope, the reducer's costs, or the demote):** (d) **the envelope prices peers at every level
the firmware might be at** (`AcView.envelopeLevel` over the reconciler's unconfirmed `sendCounts`,
NOT the single-slot `pendingLevel`) — a stale shadow admitted the raise that caused the 16:06
over_severe; (e) **a satisfied room does not keep dormant levels** (`demote.ts`, the v1 "loaded
spring", now built and running on BOTH sources), and its levels are cheap for the reducer to take
(the `topPriority` surcharge applies only BELOW `ceilOf`); (f) **never spend a saving that has not
landed** — the funding swap ships same-batch only when the METER already holds the amps, and a level
raise now arms its own unmetered-jump debit (`AcView.unmeteredJumpAmps`) the way a turn-on does.

**Two more added 2026-07-30 (the gen turn-on incident + two gen trips — read that section before
touching the start window, the freshly-on projection, or the derate):** (g) **a gen turn-on is not an
admission.** A TCL restores the generator level it was last left at, and since GRID_FULL shipped that
level is L3 — so a room switched on mid-gen-session arrives at 6.3A on a 15A line with nothing
admitting it. `invariantCorrections` now clamps it to its floor (the per-device form of FLOORS) and
the raise phase stands down for that device while its start window is open. (h) **a derate is handed
back in steps, never in one jump.** The 20-min cliff expiry restored full rating instantly, and the
leveler spent the reclaimed amps on a raise **2 seconds later**; because the first derate had already
retired, the repeat trip re-armed at 1.0A instead of compounding.

**Four more added 2026-07-31 (the gen trip after ten minutes of riding the limit — read that section
before touching the envelope, the reducer's fan gate, the fan restore, or the leaky bucket):**
(i) **the physics envelope must count the HOUSE, not just the ACs.** It summed cap models only, priced
`{Abdullah L3, Najat L1, Abdu L1}` at 13.9A against a 14.9A ceiling and admitted the raise — the
journal measured that exact end-state at **15.93–15.99A**. `house-load.ts` now tracks the peak
`meter − Σ modeled AC draw` per source and `RaiseInput.nonAcAmps` adds it to the raise envelope
(restores stay AC-only on purpose). (j) **levels before fans, judged per PLAN.** The floor gate was
per-AC, so a room already at its floor offered its fan while a peer still held a whole level, and the
comparator took the fan every time (cost 4.6 vs 140). A candidate plan may now cut a fan only if its
own end-state leaves every AC at its floor — *not* a global "no fan while any level exists", which
forces a shed whenever levels alone fall short. (k) **a fan restore SPENDS.** It emitted one
`set_fan`, reported `commandedCutAmps: 0`, armed no debit and was `fanOnly` so it did not even rewind
calm — both fatal raises landed 12s and 17s after one. It now arms `fanDebit` (priced at exactly what
`planFanRestore` admitted) and resets calm; the climb is bounded to `FAN_RESTORE_MAX_STEP` gears and
owes `FAN_RESTORE_AFTER_CUT_MS` since the last cut. (l) **the drain rung was too coarse to catch a
0.9A overload.** 15.93A on a 15A limit drained 1 point per reading → 52s to the first act, and the
post-act refill went back to FULL → another 38s to the second. There is now a moderate rung
(`OVER_LIMIT_DRAIN_MODERATE`) and the post-act refill is partial (`OVER_LIMIT_BUDGET_AFTER_ACT`).

**Key design (vs v1):** ONE graduated reducer at every severity (no separate mild/emergency planners); explicit mode machine NORMAL/SETTLING/FLOORS/COLLAPSED replaces ~15 latches (FLOORS arms on ANY entry into gen incl. cold start); **fans are last-resort trim only** (enumerable only at floor level; restore needs 5-min calm — v1 cut fans with level cuts available 57% of the time and bounced them at 61s median); one-step meter-anchored raises priced by a **persistent learned cost model** (`ac_leveling_costs` — per device × source × transition EWMA, survives deploys, config saves do NOT wipe it; explicit `POST /api/ac/leveling/costs/reset`); restore/raise retries use **evidence + capped backoff** (30s→2m→5m→15m — kills permanent strands); on gen only ONE raise command per batch; every batch is journaled + outcome-graded in **`ac_leveling_journal`** (`GET /api/ac/leveling/journal?hours=24` — durable forensics, docker logs rotate in ~1.5 days); single-actuator graded batches feed the cost model continuously. Hard rules all preserved (never level 0, manual wins, slot caps, boost floors, shed≠manual-off, warm restore, opt-out, collapse latch, leaky bucket, requireShed ≥ max(3A, 20%)).

**Hardware truth (2026-07-23, user-verified + web specs):** Abdu = **2-ton** (caps ≈ 4.1/6.5/~9A at L1/2/3), Abdullah & Najat = **1-ton** (≈ 2.2/3.9/5.3A). The registry `model` field is protocol-inference only — its capacity digits are WRONG (see tcl-ac.md). Observed raise JUMPS (3.6–3.8A, incl. compressor duty change) exceed steady per-level steps — the cost model stores both (`level:1>2` jumps vs steady model ceilings).

**Tests:** `server/src/leveling/*.test.ts` incl. `scenarios.test.ts` — incident regressions replayed against the physics harness (`scenario.ts`) + `controller.test.ts` (flavor re-sync) + `pipeline.test.ts` (emission-layer rules a whole-house sim can't isolate: batch dedupe, inrush blanking). **Cutover history:** shadowed 2026-07-23→24 (journal-compared against v1), then flipped to `"v2"` after the 2026-07-24 restore-vs-raise fix set (below). Rollback = `PUT controller:"v1"` + restart. Everything below the "TL;DR (v1)" divider documents **v1** — historical, rollback-only.

### 2026-07-23 evening gen trip → physics envelope + frozen-meter detection + grid full-start

**The incident (16:24–16:52 UTC, v1 acting, shadow day 1):** grid→gen changeover 16:24; the ESP went
**silent 16:28:45→16:46:08** (17.5-min gap in `power_readings`; the dashboard sat frozen at ~14.8A —
what the user reported as "the ESP froze on 14 A"; both controllers correctly idled on staleness).
After readings resumed, v1 climbed one step at a time on a live but **thermally-lagging** meter
(compressor draw follows a released cap by ~4 min): 16:46:27 Abdu L1→L2 · 16:47:57 Najat L1→L2 **+
Abdu L2→L3 in one batch** · 16:50:37 Najat L2→L3 — every admission passed the meter gate at 5.6→12.9A
while the static model already predicted **16.9A > 15A** (logged only as an "Amp model off" warning).
16:51:45: collapse 13.9→4.9A = **breaker trip**, 68s after the last raise. Root cause: **no veto
existed on a commanded end-state the model knows exceeds the breaker** — meter-anchored admission is
blind to ramp lag and to frozen/false readings.

**Fixes (deployed 2026-07-23 eve; server suite 620 green):**
1. **Physics-envelope veto (v2 `raise.ts` `envelopeTotalAmps`, GEN only):** a raise/restore is
   refused when the worst-case cap-model total of the commanded end-state (Σ `steadyDraw` over ON
   managed ACs; non-AC load deliberately excluded — the models over-state cool draw and the meter
   gate stays primary) exceeds `limit − margin`, no matter what the meter shows. Warm-restore targets
   degrade to the highest envelope-safe level (no stranding); the restore-with-peer-floor-downs batch
   is envelope-checked at floors. Grid is deliberately NOT envelope-guarded (grid starts FULL by
   directive; the reducer is the safety). **v1 got the same guard surgically** (`ac-leveler.ts
   execute()`): on gen, the RAISE side of a batch is stripped when the model-projected steady-state
   total (same recipe as the expectation block) exceeds the raw limit — reductions/sheds/fans/restores
   always pass. Live numbers: Abdu@L3 9.3 + Najat@L3 6.3 = 15.6 > 15 → the 16:50:37 batch is exactly
   what it strips.
2. **Frozen-meter detection (v2 `sensing.ts`):** a live CT always micro-jitters; when NEITHER raw
   channel moves ≥ `FROZEN_EPSILON_AMPS` (0.005) across consecutive readings for
   `METER_FROZEN_AFTER_MS` (60s), the meter is **frozen** — `meter_frozen` event (warn log + critical
   push "check the ESP monitor" + collector power-event guard), `MeterView.frozen`/status
   `meterFrozen`, and **calm is killed** so no raise/restore can spend on repeats of a stale value
   (reduces still act — safe direction). Device-level (survives source changes); an ESP gap >20s
   resets the judgment window; `meter_unfrozen` on the first real change. The scenario harness adds
   ±0.005 jitter (a live CT) + `freezeEsp()` to simulate the hang.
3. **Grid entry starts FULL (v2, user directive "on gen start L1 for all; on grid start all to full
   then drop"):** new mode **GRID_FULL** (priority COLLAPSED > FLOORS > GRID_FULL > SETTLING >
   NORMAL) arms on ANY entry into grid, drives every ON managed AC to its `ceilOf` ceiling in one
   batch and restores sheds at theirs (pacing-gated), then exits on shadow confirmation, its 5-min
   backstop, a manual change, or **any bucket_empty** (the reducer's judgment beats the entry
   policy — no fight). The gen side of the directive was already v2's FLOORS mode (and v1's
   persistent floors). Note: v1 has no grid full-start — that behavior arrives with cutover.
   **GRID_FULL arms on a SOURCE CHANGE only**; an AC turning on while grid is already active got the
   same policy on 2026-07-25 via the per-device start window — see the grid turn-on section below.

New regressions: `scenarios.test.ts` "2026-07-23 double-L3 gen trip" (cool-meter climb → heat surge
stays under the breaker), frozen-ESP suspend/resume, grid-entry full-start ×2; `raise.test.ts`
envelope suite (7); `sensing.test.ts` frozen suite (7); `modes.test.ts` GRID_FULL suite (7);
`collector.test.ts` v1 envelope strip + not-a-blanket-freeze.

### 2026-07-24 restore-vs-raise fix set (the cutover changes)

**The incident (live, 15A gen):** the leveler shed Najat, she restore-bounced (backoff armed), the
user then turned **Abdullah off by hand** to free budget — and 11s later the leveler raised **Abdu
L1→L2→L3** into that freed headroom instead of restoring the shed hot room. The user had to force
Najat back on, causing a 16.2A emergency. Root cause (present in BOTH controllers): a backoff/calm-
gated shed restore didn't hold the headroom it needed, and no signal told the leveler that a manual
peer-off was decaying the meter — so an ordinary raise grabbed the budget first.

**Fixes (all in `server/src/leveling/`):**
1. **Restore reservation + raise parking (`raise.ts` `planRaise`):** a shed restore that is feasible
   (plain, or by pulling raised peers to floors) but merely GATED (pacing backoff or its calm gate)
   now **reserves its amps and parks the ENTIRE raise phase** — warm raises included, because a warm
   raise is calm-exempt and would otherwise rewind the shared calm clock (`resetCalm` fires after
   every non-fan batch). An infeasible-at-floors restore reserves nothing (no permanent strand); the
   backoff ladder (≤15 min) bounds the wait. Restore-blocked-by-envelope is now labeled
   `"physics envelope"` (was mis-labeled `"no headroom"`). `RaisePlan.reservedAmps` also fences the
   fan-restore budget in `pipeline.ts`.
2. **Calm invariant (`config.ts` merge):** `restoreCalmSeconds` is clamped to `raiseCalmSeconds` —
   restore's calm gate can never open later than a raise's, so "restore outranks raises" holds.
3. **Gentle gen restore (`raise.ts` + `fan-trim.ts` `recordGentleRestoreHold` + `controller.ts`):**
   a shed room returns on gen with its **fan pinned to 1** (carried on the `power_on` command:
   `Command` gained an optional `fan`) instead of letting the range automation slam it to a hot-room
   smart-auto 3–7. The fan-slam is the bulk of a restore's un-modeled surge (fans aren't in the amp
   model), so pinning it lets a shed room fit next to a running AC on the tight gen budget. A fan
   hold is recorded (automation enforcement stands down via the collector's existing `hasFanHold`
   guards); the fan climbs back to auto after `FAN_RESTORE_CALM_MS` (**60s** since 2026-07-24 — the
   sweet-spot climb only advances what fits, so a short gate can't bounce). Grid restores stay plain.
   **Restore cost is sized at the calibrated steady floor draw on gen** (`steadyDraw`), NOT the
   fan-slam-inflated learned/seed `on@L1` (Najat's was 3.7A): a gentle restore pins the fan, so the
   fan-slam is gone and a room that really fits on ~2.3A was otherwise stranded behind a 3.7A phantom
   (live 2026-07-24 — a peer was turned off, freeing budget, yet the restore stayed "no headroom").
   The physics-envelope veto still guards the end-state; grid restores stay fan-slam-sized. Warm-start
   level is deliberately NOT used for shed restores (they land at the floor).
4. **Post-peer-off calm reset (`controller.ts`):** an observed managed power-off (in `tick()`'s
   structural-off branch) AND `onUserPowerOff` now `resetCalm()` — a decaying meter is not settled
   evidence, so raises wait out a fresh settle and the freed headroom is available to the pending
   restore. v2 has no freed-headroom projection on an off (unlike a turn-on), so calm reset is the
   mechanism. Also a defensive calm-null at collapse-latch creation in `sensing.ts` (intent clarity).
5. **Acting-flavor re-sync (`controller.ts` `reloadConfig`):** when the flag flips to acting `"v2"`
   without a restart (the cutover path), the persisted shed / fan-hold / remembered-level book and
   learned costs are **re-read from the DB** — v1 may have written those rows while acting and v2 had
   only a boot snapshot. **Flip via the API**, not direct SQL (v2 doesn't tick in `"v1"`/`"shadow"`).
   `controller.test.ts` covers this (the class had no direct tests before).

Tests: `raise.test.ts` reservation/parking/label/gentle suites; `config.test.ts` calm clamp;
`fan-trim.test.ts` gentle hold; `sensing.test.ts` collapse-calm; `controller.test.ts` re-sync;
`scenarios.test.ts` "the 2026-07-24 restore-vs-raise incident" (freed headroom → pending shed room,
not a peer raise; gentle fan climb). **650 server tests green; server + client `tsc` clean.**

### 2026-07-25 grid turn-on full start

**The incident (live, on grid):** the user turned Abdu on at 08:00:45 Baghdad while the house was
already on **grid** with ~5A free. He came up at **L1** and stayed there — L1→L2 landed at 08:04:50
(**4m05s** later), L2→L3 at 08:05:26. Two independent causes:

1. **Why L1:** a TCL restores the state it was last left at on power-on (`[tcl] Restored last state …
   "generatorMode":1`) — i.e. the gen floor from the previous gen episode. Nothing re-applied the
   grid policy, because **GRID_FULL only arms on a source change into grid** (`modes.ts`
   `source_changed`), never on an AC turning on while grid is already the active source.
2. **Why it took 4 minutes:** `rearmRamp()` marks a freshly-on AC `ramping` for `AC_RAMP_MS` (240s)
   and `planRaise` blocks every ordinary (non-warm) raise while `ac.ramping` — so the first step
   could not ship until the ramp expired, then one step per batch behind the 30s settle + calm.

**Fix — the "on grid, start all to full" directive now covers TURN-ONS, not just changeovers.** A
managed AC that comes on while on grid opens a **start window** (`START_WINDOW_MS` = `AC_RAMP_MS`;
named `GRID_START_MS` until 2026-07-30, when gen started opening one too) carrying `startBaselineAmps`: the smoothed house load measured **just before it
started**. Inside that window `raise.ts` `gridStartLevel()` drives it to the highest level that fits
`baseline + steadyDraw(level) ≤ limit − margin − restingBuffer`, in ONE command, exempt from the calm
and ramping gates (still pacing-gated, still clamped by `ceilOf` — near-target/manual/slot/reachable
caps all bind, so a satisfied room is not full-started).

**Why the baseline and not the meter:** during the ramp the meter has not absorbed the new
compressor's own draw, so meter-anchored admission would spend phantom headroom (in the incident the
meter read ~18A for an AC whose L3 steady draw is 8.5A). The pre-start baseline is the rest of the
house, and the AC's WHOLE steady draw at the target is charged on top of it — which is also why a
grid start debits `available` by its whole draw, not the level delta: two simultaneous turn-ons then
cannot spend the same amps. Fan slam is not modeled (grid restores were already fan-slam-sized); the
0.3A margin+buffer and the reducer cover it.

**Window bookkeeping (`controller.ts`):** opened by `onUserPowerOn` (fires before the shadow flips —
the cleanest baseline) or the structural off→on branch in `tick()` for automation turn-ons (first
writer wins); cleared on power-off, on a source change (baseline amps are per-source, and the entry
mode owns the transition), on a manual gen-level change (AGENTS rule 7), after any over-limit batch
**on grid only** (the reducer's judgment beats the entry policy — same rule that ends GRID_FULL on
`bucket_empty`), and on expiry.

> ⚠️ **This section used to end "Gen is deliberately untouched: entering gen means FLOORS, and a gen
> turn-on still starts at L1 and climbs meter-confirmed." That was wrong, and it stayed wrong for
> five days.** It was true only in the era before GRID_FULL — once "on grid, start all to full"
> shipped (2026-07-24) the level a TCL retains is **L3**, and FLOORS arms only on *entry* into gen
> and ends within 5 minutes. See the 2026-07-30 section: the window is now opened on BOTH sources,
> with opposite policies (grid lifts, gen clamps). The gen clear-on-over-limit is deliberately
> skipped because a gen turn-on is over-limit by definition on a 15A line — clearing there would
> retire the clamp on the exact tick it is needed.

Tests: `raise.test.ts` "grid turn-on full start" suite (8 — lift, degrade, baseline-not-meter,
double-spend, cap clamp, near-target, gen policy, post-window); `scenarios.test.ts` "the 2026-07-25
grid turn-on incident" (3 — first-batch ceiling, degrade-instead-of-overshoot, gen unchanged).
**662 server tests green; server `tsc` clean.** Verified failing without the fix (7 of the 11 are
behavioral; the other 4 pin unchanged behavior).

### 2026-07-26 triple gen trip → ramp debit + collapse re-floor + post-trip derate

**The incidents (10:29:41, ~10:40:45, ~10:53:30 Baghdad, 15A gen, ~7–8A of non-AC load).** Three
breaker trips in 25 minutes, each at a LOWER current than the last — **15.65A → 14.48A → 13.99A**.
Two independent controller bugs plus one wrong assumption:

1. **Trip #1 — peer-ramp blindness.** 10:25:14 shed Abdu (18.1A extreme) → 10:25:45 gentle restore
   → **10:26:22 raised NAJAT L1→L2 and 10:26:57 L2→L3**. Journal rows 3201/3202 contain
   `Abdu: raise blockedBy "ramping"` *in the same batch* as the executed Najat raise: `planRaise`
   gates on `ac.ramping` — the AC's OWN flag — while `available` is pure meter headroom, so a peer
   freely spent the 4.3A Abdu's compressor was still ramping into. Two fan restores (Najat 1→7 at
   10:28:00, Abdu →auto at 10:28:12) rode the same phantom budget. The controller's freshly-on
   projection cannot cover this: `freshlyOn` is cleared at the top of every tick, so it lives for
   exactly ONE tick and both raises landed after it. The physics envelope passed too — it excludes
   non-AC load by design (4.3 + 6.3 = 10.6 ≤ 14.9).
2. **Trip #2 — recovery resumed instead of re-levelling.** `modes.ts` `collapse_recovered` only
   cleared the latch. The ACs power-cycle with the line and come back at the levels that tripped it,
   so the house climbed 9.4 → 14.6A in five minutes and went again. v2 did everything right in
   between (rows 3211–3214 are all `blocked`/`no headroom`) — it simply had no way to back OFF.
3. **Trip #3 — the limit itself was wrong.** 10:49:58 raised Abdu L1→L2 at `pre 12.00A`; the house
   settled at 13.99A and the gen tripped **1A under the configured limit**. A thermal breaker that
   just tripped is hot and holds less until it cools; no admission logic survives a limit above what
   the hardware holds. (User kept `genLimitAmps` at 15 — the derate is what tracks reality.)

**Fixes:**
1. **Ramp debit (`raise.ts` `rampDebitAmps`, GEN only).** Per ON managed ramping AC:
   `max(0, steadyDraw(currentLevel) − (smoothed − rampBaseline))` — what it has COMMITTED minus what
   the meter has actually absorbed. Charged against the raise budget, the restore admission
   (`committedAmps`) and the fan-restore headroom in `pipeline.ts`. Conservative by construction: a
   null baseline charges the whole draw, level 0 charges the unrestricted draw, and two simultaneous
   ramps each measure rise from their own baseline (shared rise counted twice). **Spending side
   only** — it must never inflate the reducer's target, or it re-creates the 2026-07-25 storm.
   `AcView.rampBaselineAmps` is armed by `rearmRamp()` at EVERY arming point (user/automation
   turn-on, restore, changeover, collapse recovery) and, unlike `startBaselineAmps`, is never
   cleared by policy events — it is physics, not entry policy. **The absorbed term ratchets since
   2026-07-27** (`rampAbsorbedAmps`) — see the fan-restore stall section below. Grid is deliberately exempt, the same
   split the physics envelope uses (grid starts FULL by directive; the reducer is its safety).
2. **Gen collapse recovery re-arms FLOORS (`modes.ts`).** A recovery into gen is treated exactly
   like an entry into gen. Grid recovers plain (GRID_FULL owns that entry).
3. **Post-collapse limit derate (`sensing.ts` + `config.ts` `effectiveLimit`).** Each collapse takes
   `COLLAPSE_DERATE_AMPS` (1A) off the effective limit for that source for `COLLAPSE_DERATE_MS`
   (20 min, refreshed by each new collapse), stacking to `COLLAPSE_DERATE_MAX_AMPS` (3A). **Since
   2026-07-30 the rating is handed back one `COLLAPSE_DERATE_RECOVERY_STEP` (0.5A) per quiet rung
   rather than cliff-expiring** — the cliff funded the next trip 2 seconds after it lifted, and left
   `standing` at 0 so repeat trips could not compound (section B below). `derateFor()` is a pure
   function of time, so a line carrying nothing still cools. Stored on
   `MeterState.derate` with its own source tag so it RIDES THROUGH the per-source episodic reset (a
   gen→grid→gen bounce must not launder a hot gen breaker back to full rating). Exposed as
   `MeterView.derateAmps`; **every** limit consumer goes through `effectiveLimit()` — sensing's leaky
   bucket, `pressure.ts`, the pipeline's ceilings, the manual-increment guard, and the status card —
   or they disagree about what "over" means. A collapse also pushes a critical notification naming
   the new ceiling.

Tests: `raise.test.ts` ramp-debit suite (7); `pipeline.test.ts` fencing suite (3 — fan restore,
grid exemption, derated ceilings); `modes.test.ts` recovery suite (3); `sensing.test.ts` derate suite
(4); `scenarios.test.ts` "the 2026-07-26 triple gen trip" (6). The harness gained ramp-baseline
parity (`scenario.ts` `startRamp()`). **709 server tests green; server + client `tsc` clean.** One
behavioral regression per fix was verified failing first (peer raise during a ramp, floors on
recovery, trip #3's raise); the rest pin bookkeeping.

### 2026-07-27 fan-restore stall → the ramp debit's absorption ratchets

**The incident (16:49–16:53 Baghdad, 15A gen, user: "isn't it taking too much to restore fan
speed?").** The reducer trimmed **Abdu 7→3 and Abdullah →1** at 16:49:41 clearing a severe 15.6A
overshoot. The fans did not come back until **16:52:55 / 16:53:06 — 3m14s and 3m25s later**, on a
meter that had been calm and 1.5A under the ceiling since 16:50:03. Breakdown: ~20s for the meter to
fall back under the limit + 60s `FAN_RESTORE_CALM_MS` (both by design) + **~2 min of phantom ramp
debit** (a bug).

**Root cause — the ramp debit's absorption term is a whole-house delta, so a peer's departure erases
it.** `rampDebitAmps` credits a ramping AC with `max(0, smoothed − rampBaseline)`, and `rampBaseline`
is snapshotted at turn-on and never adjusted (`controller.ts` `rearmRamp`). Najat had turned on at
~16:47 against a **14.3A** house; the meter had risen ~1.0A into her ramp by 16:49:21 — then the
reducer's own cuts took ~2.5A off two peers and the house landed **1.5A below her baseline**. The
rise term went negative, `absorbed` clamped to 0, and she was re-charged her **entire** modeled draw
(journal 16:50:31: `0.1A available (+1.7A ramping in)`) for the rest of her 240s window. That fenced
the fan restore — and every raise — until the ramp clock simply expired. Nothing was wrong with the
fan-restore path itself; it was priced out by imaginary load.

**Fix — absorption RATCHETS (`raise.ts` + `controller.ts` `noteRampAbsorption`).** The credit is now
`max(live rise, peak rise seen since this ramp armed)`: absorption is a one-way fact, and a peer
leaving cannot un-prove amps the meter saw arrive. `AcView.rampAbsorbedAmps` carries the peak,
refreshed on the **ESP cadence** (~5s, not the tick — a rise between ticks is still evidence),
skipped while the meter is stale/frozen/collapsed, and cleared exactly where `rampBaseline` is
(re-arm, power-off, source change) since the two are only meaningful together. Every other
conservatism is untouched: no baseline → no credit ratchet or not, level 0 still charges the
unrestricted draw, two simultaneous ramps still each measure from their own baseline, and it stays
**spending-side only**.

Tests: `raise.test.ts` ratchet suite (3 — masked absorption, live rise still winning while it
climbs, no credit without a baseline); `controller.test.ts` shell ratchet (the peak survives a peer
drop, so the parked raise ships); `scenarios.test.ts` "the 2026-07-27 fan-restore stall" (2 — the
held fan returns before the ramp window expires, and still does NOT return while the ramping room's
draw genuinely has not landed). **715 server tests green; server `tsc` clean.** Both behavioral tests
verified failing first.

### 2026-07-25 restore-bounce storm (first night of v2 acting)

**The incident (20:22–21:03 Baghdad, 15A gen, v2 acting since 18:47):** the controller restored the
shed room six times and undid every one of them with a shed 8–65s later. **Every one of those sheds
fired while the SMOOTHED meter read 11.9–12.6A — 2.4–3.1A UNDER the limit** (journal ids
2644/2645, 2646/2647, 2649/2651, 2654/2655, 2656/2658, 2661/2662; `required_amps` only 0.43–1.40A).
The sixth shed **Abdu**, and that is the AC the user found off and switched on by hand. Everyone was
pinned at their floor (Abdullah at his 39°C boost floor L2, Abdu and Najat at L1, fans already
trimmed to 1), so the reducer's only feasible cover was a shed.

**Root cause — admission and projection priced the same restore differently.** `raise.ts` admitted a
gen restore at the gentle `steadyDraw` (Najat L1 ≈ 2.3A, the 2026-07-24 change) while
`controller.ts`'s freshly-on projection re-charged it at the fan-slam learned `on@L1` (3.7A) on the
very next tick. `assessPressure`'s projection branch then declared `over/mild` from
`smoothed + 3.7 > limit` — a **deterministic** self-inflicted overload after every gen restore.
Contributing: `pressure.kind === "over"` outranks `SETTLING` in `pipeline.ts`, so the settle window
never protected the restore that had just shipped; and the bucket was refilled only after `over_*`
batches, so over-limit readings banked *before* a restore carried into its inrush.

**Fixes (all in `server/src/leveling/`):**
1. **One restore cost (`costs.ts` `restoreCostAmps`)** — a single definition used by BOTH the restore
   admission (`raise.ts`) and the freshly-on projection (`controller.ts`). `gentle: true` (fan pinned
   → gen shed restore) prices the calibrated steady floor draw; `gentle: false` (automation/user
   turn-on, fan slams to a hot-room 3–7) keeps the full `turnOnAmps`. The gentle flag rides on the
   fan hold (`FanHold.gentle`, set by `recordGentleRestoreHold`) — **in-memory only**, so after a
   restart the projection falls back to the full cost, which errs trip-safe.
2. **Turn-on inrush blanking (`pipeline.ts` → `reduce.ts` `allowShed`)** — while any managed AC is
   ramping **and** `meter.smoothedAmps <= limit`, a **mild** overshoot may cut levels and trim fans
   but may **not** shed. Severe/extreme are untouched (`requireShed` also overrides the blanking), so
   a real breach still sheds immediately. Journals `blockedBy: "turn-on inrush"`.
3. **Bucket refill on a turn-on batch (`controller.ts`)** — a `power_on` changes the load picture, so
   readings banked before it stop counting. A genuine post-restore overload still empties the bucket
   from full in ~10s (2 severe) or ~25s (5 mild).
4. **`preferShed` (`reduce.ts`)** — when a shed IS unavoidable and exactly one room is ramping, that
   room is undone rather than a bystander, and it is exempt from its own `reshedPenalty`. Ranked via
   `ComboScore.exportsShed`, immediately after feasibility. (Note: `shedNeed` is compared before
   cost, so `reshedPenalized` only redirects a shed on an equal-need tie — this guard closes that tie
   case, it was not the proven cause of the Abdu shed.)
5. **Grade queue (`controller.ts` `pendingGrades`)** — was a single slot overwritten by every batch,
   so on a busy episode nothing was ever graded: `ac_leveling_costs` still held its 2026-07-23 seeds
   after ~10 live restores, and surviving attempts never reached `noteSuccess` (which pins the
   backoff ladder at its 15-min rung). Now a list; an overlapping batch marks entries `contaminated`
   → still journal-graded and still resolves attempts, but never used to LEARN a cost (an
   un-attributable delta is worse than no learning). Capped at 20, abandoned 10 min past due.
   **Consequence that bites:** a grade window now OUTLIVES the batch that failed its attempt, so
   `noteFailure` must also strip that attempt from every open window — otherwise the stale grade
   resolves it as a success and silently erases the backoff it just grew (`scenario.ts` always had
   this guard; the shell did not need it while the slot was overwritten). Pinned by
   `controller.test.ts` "a bounced attempt keeps its ladder position", which fails (cooldown 0) with
   the strip removed.
6. **Batch dedupe (`pipeline.ts` `dedupeCommands`)** — corrections and the reducer/raise blocks could
   both target one device; live row 2701 shipped `set_level 3` twice, which silently disabled
   single-actuator cost grading. One command per device+kind, last writer wins (reducer beats a
   correction in an over batch; a raise beats a floor lift in a calm one).
7. **Durable blocked rows (`controller.ts` `journalBlocked`)** — a tick that commanded nothing wrote
   no journal row at all, so "why was that room never restored?" was unanswerable after a restart
   (`getStatus().decisions` keeps only 20 in memory; docker logs rotate in ~1.5 days). Now writes a
   `reason: "blocked"` row with `commands: []`, throttled to one per `(deviceId, blockedBy)` per
   5 min.

**Not bugs (verified, unchanged):** the other overnight Abdu offs were his own range hysteresis —
minute-level `feels_like_ch8_c` matches the slot band (25.2/25.8) exactly (off 22:35 → on 22:47; off
01:06 → on 01:19; off 02:12 → on 02:25), each followed 0–60s later by a `re-cap L1 "never level 0"`
row (ids 2678, 2684, 2685) because a TCL power-cycle comes back unrestricted. Abdu sitting at gen L1
from 22:00 is his night slot's `gen_level: 1` hard cap (user-confirmed intentional).

Tests: `scenarios.test.ts` "the 2026-07-25 restore-bounce storm" (3); new `pipeline.test.ts` (8 —
dedupe ×3, blanking ×5); `reduce.test.ts` blanking + preferShed suites (8); `costs.test.ts`
`restoreCostAmps` (4); `controller.test.ts` grade queue + blocked rows (2). The harness gained shell
parity for the projection (a pipeline `power_on` now arms `pendingProjection`) — **without that the
storm was not reproducible in simulation at all**. **686 server tests green; server + client `tsc`
clean.** Both the storm regression and the ladder-position test were verified failing first.

**Security (shipped alongside, `auth.ts`):** `clientIp()` trusted `cf-connecting-ip` unconditionally
(spoofable off-Cloudflare → login rate-limiter bypass + forged `ac_control_audit` IP). Now it is
trusted only when the rightmost `x-forwarded-for` hop (Traefik-appended) is a published Cloudflare
address; otherwise the real socket peer is used and a client-supplied XFF is never adopted. See the
auth tests + `ac-control-audit.test.ts` (updated to the production forwarding shape).

### 2026-07-27 evening bounce loop + bogus manual-off lock ("why does Najat never turn on?")

**The incident (16:43–17:15 UTC, 15A gen):** Najat was restored at L1 (gentle, fan pinned to 1)
three times, and each time the gen total hit 15.3–15.7A ~3 min later — the reducer shed her back
("its own turn-on caused this") every time. The shed off-drops measured her REAL hot-evening ON draw
at **3.5–3.8A** (obs −3.8 / −3.52 / −5.13) while admission had priced her at the steady-model
**2.3A** — the 07-25 fix's "fan-slam theory" (gentle restore ⇒ steady price) is disproven: the
excess is compressor duty on a hot room, not fan (fan steps ≈ 0.1A/gear). The bounces wound the
backoff ladder to 5–15 min, so the room read as "never turns on". Then at 17:15:44 a restore finally
fired into real headroom — and 5.8s later the collector saw her TCL shadow still reporting OFF,
**after** the controller had already cleared the shed flag at command SEND. Un-shed + observed off +
`beep:false` (never lost power) → classified **manual** → a bogus `observed_off` lock stranded the
room until it was cleared by hand. The `on@L1` learned cost had ALSO been stuck at its 07-23 seed:
turn-on grades need the full ramp window (`GRADE_TURN_ON_MS` 270s) and every window was either
contaminated or cut short by the bounce itself — the wrong-low admission price could never
self-correct.

**Fixes (verified failing-first where testable):**
1. **Plain learned pricing + bounded probe (`raise.ts`, `costs.ts`)** — gen restores still SHIP
   gentle (fan pinned) but are ADMITTED at the plain `turnOnAmps` = max(model, learned on@L).
   Because a learned cost can also be stale-HIGH (the 07-24 phantom strand), a restore blocked at
   the learned price may ship ONE **probe** at the gentle steady price — only while
   `restoreFailures === 0` (zero bounce evidence this source-session; resets on source change or a
   graded success). A probe that bounces feeds the ladder and disables further probes; one that
   sticks re-grades the cost cheap. `RaisePlan.probeRestoreIds` → the fan hold's `gentle` flag now
   means "probe-priced", and the freshly-on projection re-prices EXACTLY what admission charged
   (the 07-25 one-definition rule is preserved).
2. **Shed clears on confirmed ON, not at command send (`controller.ts`)** — the `power_on` executor
   no longer clears the shed; the structural OFF→ON flip in `tick()` does
   (`clearShed("restore_confirmed")`). While the shadow lags (5.8s–13 min observed live), the
   device stays shed, so every observed-off lock recorder and auto-on path keeps skipping it. An
   in-flight restore is a shed candidate again, so a new **"awaiting confirm"** gate
   (`RESTORE_CONFIRM_WAIT_MS` 60s in `pacing.ts`, via `attemptedWithin`) reserves its amps, parks
   raises, and blocks re-sends; past the window the loop re-sends — which doubles as
   confirm-or-resend for Najat's command-dropping firmware. Same guard on the GRID_FULL path.
3. **Off-drop cost learning (`controller.ts`)** — a lone `power_off` shed now arms a grade for
   `on@L{confirmedLevel}` with `negate: true`: the instantaneous drop is the cleanest on-cost
   sample there is, so a wrong-low learned cost corrects after ONE bounce instead of storming.
   (EWMA α=0.35 absorbs fan-state noise; over-estimation errs trip-safe.)
4. **Commanded-ON shadow-lag grace (collector side)** — `handleObservedAcOff` never locks within
   120s of a server-commanded power ON (`lastServerAcOnAt`, stamped by the leveler dep, automation
   turn-ons, timer ONs, and the UI clear path). Beats every fingerprint — see
   [ac-automations.md](ac-automations.md) → Manual-off locks.

Tests: `scenarios.test.ts` "the 2026-07-27 evening bounce loop" (2 — capAmps above the model =
the physics vs the belief); `raise.test.ts` probe/bounced-re-admission/awaiting-confirm (3);
`controller.test.ts` shed-until-confirm + off-drop learning (2); `collector.test.ts` observed-off
grace ×2. **739 server tests green, `tsc` clean.**

### 2026-07-28 self-inflicted "power collapse" ("why are Najat and Abdu still shed?")

**The incident (04:14–04:29 UTC / 07:14–07:29 Baghdad, gen):** Abdullah was turned off from the UI
at 07:14, leaving only Najat and Abdu on the 15 A gen. 07:18:49 `over_extreme` shed **Najat**;
07:18:54 `over_severe` shed **Abdu**; Najat was restored at 07:19:40 and re-shed at 07:22:29. Both
offs were still travelling through the TCL cloud, so the meter kept carrying their draw — then at
**07:23:33 the compressors actually stopped together and gen fell 11.5 A → 4.5 A in one step.** That
is drop ≥ `POWER_COLLAPSE_DROP_AMPS` (6 A) landing ≤ `POWER_COLLAPSE_FLOOR_AMPS` (5 A), i.e. exactly
a breaker trip, so **COLLAPSED latched**: every evaluation journaled
`blockedBy: "power collapse latched"` for the full 5-minute `POWER_COLLAPSE_MAX_MS`, with ~9 A of
headroom sitting unused, **and the gen limit derated 15 A → 14 A for 20 min** on top. The generator
was never in trouble — we had turned the load off ourselves. (It had also fired at 05:37 the same
morning, so this was the recurring failure, not a one-off.)

**Root cause:** `sensing.ts` judged a collapse on **meter shape alone**. It had no idea the
controller had just commanded that load off, and once the house is down to its base load (~4.3–4.9 A
here) any shed of a 2-ton room clears both thresholds at once. The house's whole AC fleet going off
under leveling is therefore *always* indistinguishable from a trip — the shape is the same; only
provenance differs.

**Fix — commanded-cut credit (`MeterState.pendingCut`, `noteCommandedCut()`, `pendingCutCredit()`):**
the mirror of `rampAbsorbedAmps` for the falling direction. After any batch with a negative
`expectedDeltaAmps` the shell credits the meter with that batch's **own priced saving** (so the
credit can never exceed what the reducer believed it was cutting); stacked sheds accumulate while
unabsorbed. A collapse candidate then latches only when the fall the credit does **not** explain is
still ≥ 6 A — a real breaker going while a small cut is in flight still latches (2026-07-26 replay:
11.7 A unexplained), and with no cut pending behaviour is byte-identical to before.

Two details that are load-bearing:
- **Anchor-relative, not step-relative.** With a cut live, the fall is measured from the meter as it
  stood when cutting began, not from this reading's step. Median smoothing spreads one cliff over
  several readings (16 → 13 → 9 while the raw value is already at 4.3), and judging each step alone
  let the *tail* latch what the *head* had already explained.
- **Absorption ratchets on the SMOOTHED meter**, the same yardstick every other limit decision uses,
  so a credit retires only once the smoothing window has digested the cut — not on the first raw
  reading of it. One-way (deepest fall wins): a peer turning back on cannot un-prove that the cut
  arrived. Credit expires after `PENDING_CUT_MS` (180 s — covers the observed 64 s send→stop lag with
  margin; a trip later than that is still a trip) and is dropped outright on a source change.

Observability: a withheld latch emits `collapse_suppressed` and logs
`… explained by our own cut (N.NA commanded off, not yet metered) — no collapse latched`.

Harness: `scenario.ts` gained `SimAcSetup.offLagMs` — how long a compressor keeps drawing after a
`power_off` is SENT (default 0, so existing scenarios are unchanged). Without it the sim turned ACs
off instantly and could not express the incident at all.

Tests: `sensing.test.ts` "commanded-cut credit" (7 — the live 11.5→4.5 numbers, a real trip with a
small cut in flight, expiry, spend-once-shown, ratchet, stacking, changeover); `scenarios.test.ts`
2 more under "power collapse" (boost floors pin both rooms at L3 so shedding is the only cover, both
offs land late → suppressed, no derate; and a real trip mid-shed still latches). **748 server tests
green, `tsc` clean.**

### 2026-07-28 ramp-honest cost learning (the raise→overload→shed loop)

**The pattern (24h to 2026-07-28, gen):** **42 over-limit episodes in one day.** The shape repeats —
gen sits at ~12.0–12.2A, a raise is admitted, and the meter is over within 0.5–4 min (17:33, 18:35,
18:38, 18:46, 18:52 …). **18 of 56 gen raises/restores were followed by an over-limit inside 5 min.**

**Root cause — the grading window is shorter than the compressor:** `GRADE_LEVEL_MS` was **45 s**
while `AC_RAMP_MS` is **240 s**, so every level-raise cost sample measured roughly the first fifth of
the ramp. Live evidence: **32 of 33 graded gen raises came in BELOW what admission charged**
(median **−1.12A**, mean −1.37A). Najat's 04:14:41 L1→L2 graded **+0.23A**; 3.6 min later the gen was
at 16.18A and shedding her.

Those samples feed the EWMA, so the book drifted down with use — and its own history proves it:

| device | transition | learned | samples | true step |
|---|---|---|---|---|
| Abdullah | `level:1>2` | 2.98 | 2 | 1.7 |
| Najat | `level:1>2` | 3.60 | 2 | 1.7 |
| Najat | `level:2>3` | 1.08 | 9 | 1.4 |
| Abdu | `level:2>3` | 1.65 | 20 | 2.5 |
| Abdullah | `level:2>3` | 0.74 | 16 | 1.4 |

**More samples ⇒ lower cost** — a biased estimator, not a converging one. The only two transitions
still priced above their model are the two that stopped being sampled on 07-23/07-25.

`raiseCostAmps()` takes `max(model, learned)`, so this was **masked, not dangerous**: learned costs
simply never rose above the config model and **the learning loop was inert for raises** — the static
`stepAmps` did all the work. That is why the bounce persisted: Abdu's real L1→L2 jump is ~2.9–3.0A
(compressor duty change on top of the 2.4A cap step) against a 2.5A model, so a raise admitted at
pre ≈ 12.1A with 2.78A of headroom lands at ~15.1A. The learning that should have pushed his price
to 3.0A and refused the raise was exactly what was broken. (The `on@L*` costs — Abdu 5.05, Najat
3.64 — were always honest, because the 07-27 off-drop learning measures an *instantaneous* drop.)

**Fix — grade in two stages (`PendingGrade`):**
1. **`compareAfter` (unchanged, 45 s) journals the row**; a new **`learnAfter`** gates the cost
   sample at `max(compareAfter, now + AC_RAMP_MS)`. Forensics stay fast, learning waits out the
   compressor. A shed's off-drop is instantaneous and keeps learning on the journal's schedule
   (`learnAfter = compareAfter` when `single.negate`).
2. **The sample is a ratcheted peak** (`peakDeltaAmps`), one-way in the window's own direction —
   highest rise for a raise/turn-on, deepest drop for a shed. Mirrors `rampAbsorbedAmps`: once the
   meter has proven a compressor's amps arrived, a peer's later reduction cannot un-prove it, so a
   4-min window no longer under-reads.
3. **Contamination is direction-aware** (`batchLoadDirections()`), because a 4-min window would
   otherwise never survive — on a busy gen evening batches land every 30–60 s. A batch that only
   REMOVES load cannot inflate a raise's peak; one that only ADDS load cannot deepen a shed's
   trough. A `set_level` with no confirmed level counts both ways (trip-safe); `set_fan` counts in
   its own direction (~0.1A/gear, below the 0.2A learn gate either way).

Note `ATTEMPT_BLAME_WINDOW_MS` (300 s) exceeds the learn window, so a raise that bounces still
contaminates its own sample — correct, and why the off-drop path remains the fast corrector.

Tests (each verified failing-first): `controller.test.ts` "a raise is learned over the whole
compressor ramp" (2 — with the old 45 s window the sample was **0.30A**; without the ratchet, 0.5A)
+ `batchLoadDirections` unit coverage (4). **754 server tests green, `tsc` clean.**

> **Cost-book note:** the poisoned `level:*` rows are all BELOW their model step, so
> `max(model, learned)` already ignores them — pricing is unaffected today and the EWMA climbs back
> over ~4 honest samples. `POST /api/ac/leveling/costs/reset` only if faster convergence is wanted,
> at the cost of the honest `on@L*` rows.

### 2026-07-28 evening — the budget hog ("why is Najat on L3 while Abdu's room is hotter?")

**The complaint (live, 15A gen):** Najat's AC sat at **L3** holding 6.3A with her room 0.5°C from
target, while Abdu's room ran **1.9°C hot** and was pinned at **L1**. The user also asked why shed
rooms "took too long" to come back that morning — that part proved to be physics, not a bug (see the
note at the end).

**Four causes, all confirmed from the journal:**

1. **Nothing ever walked a satisfied room's level DOWN.** `ceilOf()` caps a room inside
   `nearTargetBandC` at L1, but only the RAISE path and GRID_FULL ever consulted it; the reducer runs
   solely when the meter is over the limit. This is v1's deferred **"loaded spring"** (see the v1
   section below) — *not* a v2 regression: v2's `needs.ts` is a straight port of the same raise-only
   ceiling.
2. **The reducer taxed the hot room.** Cut cost is `steps × levelStep × (1 + needK·needDelta)` plus a
   flat **+25 `topPriority`** for the first ON AC in priority order. With Abdullah's AC off, Najat
   inherited that slot. 16:06:07, needing 1.1A: cutting Najat cost 17.5 + 25 = 42.5 vs 38.5 to cut
   Abdu → **Abdu paid**, twice more at 16:38 and 16:40. That re-created, one tier down, the "priority
   protects a cool room over a hot one" complaint the 2026-06-13 decision fixed for sheds.
3. **The physics envelope priced peers at a STALE shadow.** `AcView.currentLevel` is the confirmed TCL
   shadow (the `pendingLevel` substitution happens only in SETTLING, and `planRaise` never runs in
   SETTLING). Najat's L3 was sent 15:39:49 and had not confirmed at 15:55:36, so the envelope summed
   9.3 + **4.3** = 13.6 ≤ 14.9 and **admitted** Abdu's L2→L3; by 16:06:45 her shadow flipped and the
   identical end-state was vetoed at 15.6. That blind raise is what produced the 16:06 over_severe.
   Her firmware's documented confirm lag is 5.8s–13min; **≥15.8 min was observed here**.
4. **The over-limit DEMAND side ignored in-flight cuts.** `requiredSavingsAmps` never subtracted the
   live `pendingCut` credit, so while a laggy room's commanded cut was still landing the bucket
   drained again and the second pass took the amps from the hot room.

**Fixes (2026-07-28 evening; 811 server tests green, `tsc` clean):**

1. **Envelope honesty — `AcView.envelopeLevel`.** Peers are priced at
   `worstCaseLevel([confirmed, ...unconfirmedLevels(recon, id, now)])` (`needs.ts` `worstCaseLevel`
   ranks level 0 = unrestricted as the HIGHEST draw). Deliberately **not** `pendingLevel`: that is a
   single slot overwritten by every send, so a demote to a satisfied room would erase the memory of
   the raise still in flight and re-open this exact hole. `sendCounts` keeps every unconfirmed level
   and is cleared wholesale on any confirm / power-off / source change / manual probe. New per-level
   `sentAt` timestamps drive `UNCONFIRMED_SEND_TTL_MS` (**25 min**, chosen to exceed the ≥15.8-min
   observed lag), and unreachable-marked levels are excluded so 4 sends of "the firmware refuses this"
   cannot veto peers forever. `currentLevel` semantics are untouched — a command in flight is still
   not an observation, which is what stops a lagging write minting a false manual intent.
2. **The loaded spring — `demote.ts` (`planIdleDemotes`).** A room that is `on && managed && !shed`,
   not ramping, above `ceilOf`, and **continuously satisfied for `DEMOTE_DWELL_MS` (120s)** at
   `needDelta ≤ nearTargetBandC − DEMOTE_HYSTERESIS_C (0.2)` is walked straight to its ceiling in ONE
   command. Runs on **both sources** (user decision; the v1 sketch was gen-only) — on gen it frees
   budget, on grid it stops paying for cooling nobody asked for. Never amps-triggered, so the reduce
   trigger's "even 0.1A below → no reduction" rule is untouched. `ceilOf` honours `manualTarget`, so a
   pinned room never demotes. Confirm-or-resend uses **`DEMOTE_RESEND_MS` (60s)**, deliberately slower
   than `LEVEL_RESEND_SPACING_MS` (30s): every non-fan batch rewinds the SHARED calm clock, and these
   are precisely the lag-prone rooms — a tight resend loop would starve the peer raise the demote
   exists to fund.
   **Pipeline precedence (calm branch):** raise-phase commands → *(restore reservation ⇒ nothing)* →
   idle demotes → fan restore → idle. Idle demotes **park under a restore reservation** even though
   they free amps: the reservation is waiting on the shared calm clock, and the restore's own
   feasibility already prices peer floor-downs (floors ≤ ceilings).
   *Stale-sensor note:* no explicit guard is needed. `needDelta` comes from `computeAcNeed`, which
   maps a missing/zero `currentTemp` to delta 1 — above the demote threshold — so a dead room sensor
   can never read as satisfied. A stale-but-plausible cloud reading is self-correcting and low-harm
   (the outcome is an L1 cap, never an off).
3. **Funding swap, SPLIT BY BLOCKER (`raise.ts`).** When the most-needy raise is blocked and a peer
   sits above its own ceiling (no dwell needed — a hot peer is evidence enough):
   - *envelope-blocked but the meter already holds the amps* → **same batch**: demotes first, then the
     one raise, with the swapped end-state re-checked against the envelope;
   - *the meter itself is short* → **demote ALONE**; the raise follows a later calm window against a
     meter that has actually fallen.
   The split is the safety property: a demote credit is a *prediction*, and a satisfied compressor can
   take minutes to throttle down — shipping both together would commit ~16A on a breaker that tripped
   at **15.65A** on 2026-07-26. Peers are never cut BELOW their own ceiling to fund a raise (only
   restores may pull peers to floors).
4. **Ceiling-aware reduction cost (`reduce.ts`).** The +25 `topPriority` surcharge now applies only
   when the move ends **below** that AC's `ceilOf` — levels above it are dormant capacity the
   near-target decision already says buy nothing. `needK` weighting is unchanged, so it still breaks
   ties between two above-ceiling rooms. Nothing else in the cost model moved.
5. **One honest commanded-cut credit — `Plan.commandedCutAmps`.** Populated by EVERY batch shape that
   lowers load (reducer, demote, funding swap, and the peer floor-downs bundled into a restore) and
   priced at the **MODEL steady delta** (`costs.ts` `modelCutAmps`), never `max(model, learned)`. It
   replaced the controller's `expectedDeltaAmps < 0` test, which missed every batch whose cuts and
   turn-on cancelled to a net 0 — the restore-with-floor-downs shape. Model pricing is load-bearing:
   the rooms this credits are satisfied (drawing below their caps), and Najat's L3→L1 prices at 7.2A
   learned vs 4.0A model; with the learned figure a genuine 11A cliff computes as 3.8A unexplained and
   **silently fails to latch** a real collapse.
6. **Demand-side credit (`pressure.ts`).** `requiredAmps = max(0, raw − commandedCutCreditAmps)`
   (`MeterView.commandedCutCreditAmps`, from the live `pendingCut` remainder). The EXTREME tier keys
   off the credited figure too — escalating to a forced shed for amps already on their way out is the
   double-cut being fixed; SEVERE still keys off the raw readings, and the credit expires
   (`PENDING_CUT_MS`) and is spent as the meter absorbs it.
7. **Post-raise jump debit (`AcView.unmeteredJumpAmps`, gen only).** A level raise never arms
   `ramping` (that flag is for compressor starts), so nothing charged a raise's committed-but-unmetered
   jump and the raise gate reopened ~35s later against a meter still catching up — the 2026-07-26 trip
   shape, which the envelope cannot cover because it excludes non-AC load by design. The controller now
   arms `{amps: priced jump, baseline, absorbed, until: +AC_RAMP_MS}` on each gen `set_level` UP,
   ratchets absorption on the ESP cadence beside the ramp ratchet, and `rampDebitAmps` charges the
   residual — but only for a NON-ramping AC, since a ramping one is already charged its whole steady
   draw at the raised level.

**Interaction worth knowing:** a fan restore now waits behind a fresh raise's jump debit (pinned by the
fan-trim scenario, which moved from ~100s to ~275s). That is deliberate — fan restores riding phantom
budget behind raises is exactly the 2026-07-26 trip.

**On "the shed rooms took too long" (07:18–07:29 that morning):** not a bug. With both ACs off the
meter still read ~12.3A of NON-AC house load on a 15A generator, so Abdu's 4.3A floor draw could not
fit (12.3 + 4.3 = 16.6 > 14.9) while Najat's 2.3A probe could — she was restored in 60s, correctly.
The 07:23:35 COLLAPSED latch was substantially legitimate (the meter fell a further ~7A with every AC
already off — a real load cliff before the 07:29 grid changeover), and it predates that morning's
phantom-collapse fix. Post-fix evidence the fix works: 16:31:44 shed Abdu = a −11.4A commanded cliff
with **no latch**, restored 39s later.

**Tests (each mutation-verified failing-first):** `reconciler.test.ts` unconfirmed-levels suite (8,
incl. "a LATER demote send does not erase the earlier unconfirmed raise") · `raise.test.ts` "2026-07-28
15:55 blind raise" + funding-swap suite (5) + jump-debit suite (5) · `reduce.test.ts` "2026-07-28 16:06
replay" (3) · `demote.test.ts` (12) · `pipeline.test.ts` commandedCutAmps (4) + demote precedence (4) ·
`pressure.test.ts` demand-side credit (4) · `sensing.test.ts` "a MODEL-priced demote credit cannot
launder a real trip" · `scenarios.test.ts` "2026-07-28 evening budget hog" (5).

**User decisions this session (don't re-litigate):**
- **Demote runs on BOTH sources** — supersedes the v1 sketch's gen-only scoping. Grid demote is
  consistent with GRID_FULL, which already clamps satisfied rooms to L1 at grid entry.
- **Funding swap splits by blocker** — same-batch only when the meter already holds the amps. The user
  chose this over unconditional same-batch after seeing the 15.65A trip math.

### 2026-07-30 gen turn-on at L3 + two gen trips (the derate cliff)

Two independent defects, both found from the journal + `ac_control_audit` + `power_readings`.

#### A. "I turned Najat on and she started at L3, and it never lowered Abdullah"

**The incident (05:51:07 Baghdad, 15A gen).** The house had been on generator for 33 minutes — long
past FLOORS — with Abdullah at L3, Abdu at L1, ~13.2A total. The user switched Najat on. She came
back at **L3**: the grid full start had driven her there at 04:29, she was switched off at 04:42, and
the TCL `restoreLastState` re-applied `generatorMode: 3` on power-on. 6.3A of modeled draw landed on
a 15A line with nothing admitting it. The house rode **16.77A** for two minutes; at 05:53:07/05:53:15
the user hand-set Abdullah → L1 and Najat → L1. Same shape at 07:04 (gen).

Two causes, and the second is why a peer was never touched:

1. **No gen turn-on policy existed.** `noteTurnOn()` returned early unless the source was grid, and
   `gridStartLevel()` only runs on grid. FLOORS arms on *entry* into gen and ends within
   `FLOORS_MAX_MS` (5 min), so it does not cover a room switched on later. The doc asserted the
   opposite (see the warning in the 2026-07-25 section) — true before GRID_FULL, false after it.
2. **The freshly-on projection priced her at `floorOf()`, not the level she was at.** Arithmetic
   against the journal: `13.205 + 2.86 (her on@L1 EWMA) − 15 + 0.1 = 1.165` → the row's
   `reduce 1.2A (mild)`, exact. Priced at her real L3 (6.3A) the honest deficit is **4.6A** — more
   than `Najat L3→L1` (4.0A) can cover, so the reducer would have had to move a peer. At 1.2A it
   could pay out of the newcomer alone, and did. The projection was assuming the floor policy that
   cause 1 shows did not exist.

**Why no test caught it:** `scenario.ts` `turnOn()` priced `pendingProjection` at the **actual**
level while the shell priced it at the floor. The harness could not disagree with the shell, so both
sides now carry their own regression (`controller.test.ts` "a gen turn-on enters at its floor" is
deliberately a SHELL test).

**The fix.**
- The start window opens on **both** sources (`START_WINDOW_MS`, was `GRID_START_MS`), carrying the
  same pre-start `startBaselineAmps`. Grid LIFTS to the ceiling; gen CLAMPS to the floor.
- `invariantCorrections(acs, now, source)` emits `set_level = floorOf(ac)` for an AC inside its gen
  start window that is above its floor, journaled as `gen start L{n}`. It lives there rather than in
  the raise planner because it must ship in every non-COLLAPSED mode (a gen turn-on is over-limit by
  definition, so the raise phase never runs), it is a reduction so it cannot fight the reducer, and
  `dedupeCommands` still gives a deeper reducer cut the last word. Re-emitted while unconfirmed —
  same contract as FLOORS, and it doubles as Najat's confirm-or-resend.
- `planRaise` **stands down for a device inside its gen start window** (`blockedBy: "gen start floor"`).
  Without this the clamp and the raise fight inside one batch and the raise wins the dedupe; a warm
  restore would win it even mid-ramp, since `warmStartLevel` is exempt from the ramping gate.
- The over-limit batch clears start windows on **grid only**. On gen, clearing would retire the clamp
  on the exact tick it is needed.
- The projection prices a user/automation turn-on at **`envelopeLevel`** (worst case of shadow and
  anything in flight, so our own clamp does not shrink it before it confirms) and holds it across the
  whole ramp with absorption ratcheting, instead of one tick. A room WE restored still prices at
  `restoreCostAmps(floor, {gentle})` — re-pricing a gentle restore at its plain cost is the
  2026-07-24/25 bug where every gen restore declared itself over-limit and got shed ~10s later.
  Both conditions on the filter are load-bearing: `ramping` is what makes the draw unmetered (past
  the ramp the meter has it, and charging on top is a permanent phantom overload — this cost a test
  cycle), and the start window is what keeps it scoped to turn-ons (`ramping` alone is re-armed for
  every running AC on a changeover).

Deliberately NOT done (user decision): no forced peer floor-downs on a turn-on. Honest sizing is the
fix — the reducer decides who pays.

#### B. Two gen trips 26 minutes apart — the derate cliff funded the second

```
09:20:29  raise Abdu L1→L2 "2.6A learned"   pre 10.23
09:25:06  COLLAPSE 14.2 → 3.2A              derate → 14.0A for 20 min
09:45:06  derate expires — full 15A rating restored in one jump
09:45:08  raise Abdu L1→L2 "3.2A learned"   pre 10.695      <-- 2 seconds later
09:51:40  COLLAPSE 14.7 → 3.4A              derate → 14.0A again (not 15.0 − 2)
```

**Neither trip produced a single `over_*` row.** The leveler was inside its own limit both times
(ceiling 14.9A, resting point 14.7A); the gen simply cannot hold ~14.2–14.5A sustained, with ~3.5A of
non-AC baseline. The user's 2026-07-26 decision stands — `genLimitAmps` stays 15 and the derate
tracks reality — but the derate as built could not: it **cliff-expired**, so the line went straight
back to full rating and the leveler re-spent it immediately. Worse, `standing` was 0 by then, so the
repeat trip re-armed at 1.0A instead of compounding: the "walk the limit down on every collapse"
design defeated by its own expiry.

**The fix — a recovery ladder.** `derateFor()` is now a pure function of time: `until` ends the
CURRENT rung, and every further elapsed rung hands back one `COLLAPSE_DERATE_RECOVERY_STEP` (0.5A).
`15.0 → trip → 14.0 (20 min) → 14.5 (20 min) → 15.0`. Recovery deliberately does NOT require readings
(a line carrying nothing cools fastest) but is still per-source, so a gen→grid→gen bounce cannot
launder a breaker that only just tripped. Because the ladder is still standing when the next trip
lands, the existing `min(MAX, standing + COLLAPSE_DERATE_AMPS)` escalation finally works: today's
second trip would have landed at 2.0A (limit 13.0) instead of 1.0A.

Also fixed in passing: the collapse credit in `scenario.ts` keyed off `expectedDeltaAmps`, which only
reduce batches set — it silently missed demotes, funding swaps, and now the gen clamp. It uses
`commandedCutAmps` (invariant 11, the single credit path) like the shell, and the SETTLING/hold
branches of `pipeline.ts` populate it since corrections can carry real down-moves.

#### C. A third trip the same day (12:46) — same family, different half

12:42:32 the user turned Najat on again; the gen went at 12:46:01 (**14.9A → 3.4A**). She came on at
**L1** this time (the leveler's 11:44 restore had left her there), so the L3 clamp was irrelevant —
what was wrong was the PRICE. Two under-estimates compounded on a meter that went 13.0 → 12.3 → 15.25:

- The projection charged her **2.3A** (the bare model draw) while her learned `on@L1` was 2.86A and
  the meter delivered ~2.9A → it asked for 0.5A instead of 1.0A. The bare model draw is the *probe*
  price and belongs only to a restore we admitted at that price; a turn-on nobody admitted gets
  `turnOnAmps` — the trip-safe `max(model, learned)`. **This was a regression introduced by the fix in
  A**, which corrected the LEVEL but silently downgraded the blend to model-only. Fixed the same day,
  pinned by `controller.test.ts` "prices a user turn-on at the LEARNED on-cost".
- The reducer credited `Abdu L3→L2` with **2.5A** of savings and the meter fell ~0.7A net. A gen level
  is a CAP: cutting it frees nothing when the compressor was already drawing under it. Not fixed —
  Najat's ramp was rising through the same window, so the two cannot be cleanly separated from the
  minute medians. **Candidate, not a proven defect.**

**Honest scorecard:** neither fix in A would have prevented this trip. Sized honestly the ask goes
0.5A → 1.0A, and the reducer's chosen action (`Abdu L3→L2`) covers both. What actually killed it is
the standing gen ceiling: three trips on 2026-07-30 at **14.2 / 14.5 / 14.9A**, none preceded by a
single `over_*` row, against a resting point of 14.7A and a reduce trigger at 14.9A. The ladder in B
walks the limit down *after* a trip; it does not stop the first one. If trips keep landing near 14A,
lowering `genLimitAmps` is the remaining lever (user decision — see the decisions log).

**Tests:** `raise.test.ts` "gen turn-on floor clamp" (7) + warm-restore guard; `pipeline.test.ts`
"gen start clamp reaches the batch" (6 — over/calm/settling/hold/collapsed/dedupe);
`controller.test.ts` "a gen turn-on enters at its floor" (4, shell-level); `scenarios.test.ts` "the
2026-07-30 gen turn-on at L3" (6) and the derate ladder pair. **836 server tests green, `tsc` clean.**
Each fix was verified failing first: 11 tests fail without the clamp, 2 shell + 2 harness tests fail
with floor pricing, 2 fail on the old cliff expiry.

### 2026-07-31 gen trip — a raise on a trough, a fan bounce, and a 90-second escalation

**The incident (Baghdad time; gen entry 17:19:29, trip 17:33:31).** The house settled with every room
at its floor — Abdullah L2 (boost floor), Najat L1, Abdu L1 — and the gen riding **12.4–15.4A on a
15A line**. In the ten minutes before the trip: five over-limit episodes, four fan trims on Abdu, and
a whole-AC shed (Najat, 17:26:48, restored 36s later). There was never any budget. The controller
nonetheless found room for a level, twice:

```
17:29:32  Abdu fan 1→7          fan restore — spends, and nothing charged it
17:29:44  Abdullah L2→L3        12s later, admitted against a 9.91A trough
17:30:24  Abdu fan 7→1          17:30:30  Abdullah L3→L2      (both undone)
17:31:44  Abdu fan 1→7          17:32:01  Abdullah L2→L3      (both redone) → 15.93A
17:32:53  Abdu fan 7→4          52s of overload later — and it picked a FAN
17:33:31  Abdullah L3→L2        90s in; observed −10.9A → 5.04  → COLLAPSED
```

**Four defects, each provable from the journal:**

1. **The physics envelope had no house in it.** `envelopeTotalAmps` summed cap models only —
   documented as deliberate ("v2 has no trustworthy non-AC split"). For the admitted end-state it
   said **13.9A** (Abdullah L3 7.3 + Najat L1 2.3 + Abdu L1 4.3); the journal's own 17:30:18 row
   confirms the arithmetic by pricing Abdu's L2 in that same state at 16.4 = 13.9 − 4.3 + 6.8. The
   meter read **15.93–15.99A** for that configuration minutes later. The designated
   catastrophic-end-state backstop under-predicted by ~2.0A and passed a state 1A over the breaker.
   **Fix:** `house-load.ts` — a rolling per-source PEAK of `smoothed − Σ modeled draw of running
   managed ACs`, skipped while anything is ramping, tagged with the running-AC set (a residual
   sampled while a room was off silently counts that room as house, and would double-count it the
   moment it returned). `RaiseInput.nonAcAmps` adds it to the raise envelope. Restores keep the
   AC-only figure on purpose: refusing one strands a room off entirely, which the user ranks worse
   than a tight ride, and the restore path already has a meter-anchored gate.
2. **The meter gate was reading a trough, not a state.** Admission happened at 9.91A — Najat had been
   shed three minutes earlier and her restart had not ramped. The steady state of that exact
   configuration, watched for the previous ten minutes, was 12.4–13.3A. The house-load peak is what
   now carries that memory across the dip.
3. **A fan restore spent amps nothing charged.** One `set_fan`, `commandedCutAmps: 0`, no debit armed
   (a fan is not a compressor, so `rearmRamp` never fires), and `fanOnly` so `resetCalm` was skipped.
   Both fatal raises landed **12s and 17s** after a fan restore, on headroom the fan had already
   taken. And the restore itself was a full swing: `planFanRestore` took the highest target whose
   cost fits, and a 6-gear swing prices at ~0.15 × 6 = 0.9A, so 1→7 fitted essentially always. Abdu
   ran **7→5→3→1→7→1→7→4 in nine minutes**; the cut→full-restore gap was 80s, because a fan-only
   batch never rewinds the shared calm clock the 60s gate reads. **Fix:** `fanDebit` in the shell
   (priced at exactly what `planFanRestore` admitted, absorbed-ratcheted, `FAN_DEBIT_MS` 60s), calm
   reset on a fan RESTORE but never on a fan CUT (a cut frees amps — stalling the reducer behind its
   own cut is how episodes drag), `FAN_RESTORE_MAX_STEP` 2 gears per step, and
   `FAN_RESTORE_AFTER_CUT_MS` 180s measured from `FanHold.lastCutAt`. Gentle-restore holds are exempt
   from the cut cooldown (`FanHold.fromCut: false`) — nothing was taken away there.
4. **The reducer answered a real overload with a token fan, then waited out a full bucket.** 15.93A
   is 0.93A over and `OVER_LIMIT_SEVERE_AMPS` is 1.0, so it classified mild and drained 1 point per
   reading: **52s to the first act**. That act was a 0.4A fan trim on Abdu while Abdullah sat at L3
   with a 2.5A cut available — the fan gate was per-AC (Abdu was at *his* floor), and the comparator
   then priced the fan at 4.6 against 140 for the level. `noteActed` refilled the bucket to FULL, so
   the level cut waited another five readings (**38s**). **Fix:** the fan gate is per-PLAN (a
   candidate may cut a fan only if its own end-state leaves every AC at its floor), plus
   `OVER_LIMIT_DRAIN_MODERATE` (2 points above `OVER_LIMIT_MODERATE_AMPS` 0.5A) and
   `OVER_LIMIT_BUDGET_AFTER_ACT` (2, not 5) after an over-limit act — the anti-double-cut protection
   the full refill existed for now lives in the demand-side credit of invariant 11.

> ⚠️ **The fan gate is per-PLAN, never global.** The first attempt gated fans on "no level cut exists
> anywhere in the candidate set". That reads like the user's directive and is wrong: when levels alone
> fall short of the deficit and fans are off the table, the only feasible plan is a **power_off**. The
> harness caught it immediately (a 1.7A deficit shed Najat where a level + a fan trim covered it).
> "Fans are the last try BEFORE turning off" means levels+fans must always be reachable first.
> Pinned by `reduce.test.ts` "combines a level cut WITH a fan trim rather than shedding a room".

**Reading the residual correctly.** `houseLoadResidual` is **house minus model error**, not the
physical non-AC load. With all three rooms at their floors it reads ~1.3–1.8A while the true house is
several amps — because the cap models over-state what the compressors actually draw, and the
difference is netted out of the residual. That is deliberate and self-consistent: the envelope adds
the residual back to *the same over-stating models*, so the sum tracks reality. Do **not** "correct"
it against a wattmeter reading, and do not be alarmed by a large figure on a small running set (with
one AC on, the residual carries the whole rest of the house — 5–7A is normal there).

**Known limitation at ship time — residual contamination after a turn-off.** Flagged here on
2026-07-31 ("left for a session with soak time"), it produced the predicted incident the very next
evening and was **fixed 2026-08-01** — see that section. The sampling now pauses for
`HOUSE_SAMPLE_COOLDOWN_MS` after any modeled-total drop, and a set change carries the previous
superset peak instead of trusting its own first (contaminated) sample.

**Not changed (deliberate).** Abdullah's configured gen model is `base 2.3 / step 2.5` → L3 = 7.3A,
but he is a 1-ton unit (hardware truth ≈ 2.2/3.9/5.3) and the learned book agrees: `level:2>3` = 1.44A
over 24 samples. Correcting it would make raise pricing honest **and** the envelope more permissive at
the same moment, so it waits for one clean gen session on the house-load term. See the decisions log.

**Post-deploy regression, same evening (fixed within 20 min).** `OVER_LIMIT_BUDGET_AFTER_ACT` shipped
at **2**, which is below `OVER_LIMIT_DRAIN_SEVERE` (3) — so one severe reading could empty the bucket
by itself. Live 18:21:10 the reducer shed Najat at 15.32A; **16 seconds later** a single ~16.5A
reading, still inside the 4-wide smoothing window from *before* that shed landed, acted again and shed
Abdu at a **smoothed 12.555A**. `commandedCutCreditAmps` could not stop it: the meter's fall from
15.32 to 12.5 had already absorbed Najat's whole 2.3A credit, so the stale reading was priced as a
fresh breach. (v2 self-corrected — Abdu was restored 38 s later at 18:22:04 — but the shed was wrong.)
**The post-act bucket must always exceed the severe drain**, so it is now
`OVER_LIMIT_DRAIN_SEVERE + 1` = 4: a severe reading still needs a partner exactly as it did at 5,
while a moderate pair or four mild readings act sooner — which is where the latency actually was.
Pinned by `sensing.test.ts` "a SINGLE severe reading can never empty the post-act bucket".

**Tests:** `house-load.test.ts` (11); `raise.test.ts` "house load in the raise envelope" (5, incl. a
test that reproduces the bug with `nonAcAmps: 0`); `reduce.test.ts` levels-before-fans (3 new, incl.
the forced-shed guard); `fan-trim.test.ts` (rewritten for the bounded climb + cut cooldown);
`sensing.test.ts` drain rungs + partial refill (3); `scenarios.test.ts` "the 2026-07-31 gen trip" (5).
**866 server tests green, `tsc` clean.** Every fix verified failing first — the trough regression
admits the raise with the house term at 0 and refuses it at 1.6A.

### 2026-08-01 — the phantom house after a turn-off + comparative-need rebalance

Two changes, separate commits. The first is the predicted incident from the 07-31 "known
limitation"; the second is a user feature request from the same evening.

**1. A turn-off booked its own decay as house and froze the raise path for 14 minutes.**
Journal, Baghdad time: at 17:25:52 the envelope was honest (`incl. 2.6A house`); at ~17:27 Abdullah's
AC went off (meter 13.9 → 11.1A); at 17:27:57 the first sample tagged with the new running set read
the smoothed meter — still carrying his dying compressor — against a modeled side he had already
left: **7.1A of "house"** (true residual ≈ 4.1A). Being the only same-set sample, it WAS the 15-min
peak: every raise refused at `worst case 16.2A > 14.9A` while the meter sat at 11–12A, until the user
raised Abdu to L2 by hand at ~17:44 (the post-raise meter, 13.23A, proves the refusals were wrong).

**Fix (`house-load.ts`):**
- **One drop detector for turn-off, shed, and level cut** — they share the physics (the model falls
  instantly, the meter follows over the compressor wind-down plus the smoothing window). Any drop of
  the modeled running total > `MODELED_DROP_EPSILON_AMPS` (0.05) pauses sampling for
  `HOUSE_SAMPLE_COOLDOWN_MS` (2 min); a second drop re-arms it. Raises need no cooldown: the model
  RISES ahead of the meter, the residual dips, and a dip never wins a max.
- **Superset carry:** while the current set has no samples of its own (its first minutes fall inside
  the cooldown), `houseLoadAmps` stands in the peak among samples whose set MODELED every room now
  running — a superset sample cannot double-count anyone, keeps the envelope honest across the gap,
  and preserves the 07-31 trough memory (pre-shed full-set samples cover the restore). A sample
  missing a currently-running room is still never reused (the double-count guard).
- `HouseLoadState` is now per-source `{ samples, lastModeledAmps, cooldownUntil }`. A ramping tick
  still returns the state untouched (and deliberately does not advance the drop detector — the
  modeled side already carries draw the meter has not seen).
- The fix is why the funding swap works at all: a funding demote's wind-down would otherwise book
  phantom house and block the very raise it funded.

**2. Comparative-need rebalance — "the extra level should switch to the hotter room" (user).**
The 07-28 funding swap harvested only SATISFIED peers (`currentLevel > ceilOf`), so a warm-but-not-
satisfied room (needDelta above the band ⇒ ceilOf = max) held its extra level while a much hotter
room sat at its floor. Now `planRaise` has a second donor pool, `rebalanceDonorsFor` (raise.ts):

- **Receiver must sit AT ITS FLOOR** (the user's literal "the other on the base level"). Load-bearing:
  letting an above-floor receiver trade re-broke the resting-point quiet acceptance (a warm L2 room
  endlessly milked a milder L2 peer for an L3 it could never fund).
- **Donor:** on, managed, not shed/ramping, `manualTarget == null` (a pin is user intent, not spare
  capacity), `currentLevel > floorOf` (boost floors sacred), and `donor.needDelta +
  REBALANCE_NEED_GAP_C (0.7°C) ≤ raiser.needDelta`. One step per trade, coolest room first, only as
  many donors as the deficit needs. The gap doubles as anti-bounce hysteresis (7 sensor LSBs; a
  reverse trade needs the rooms to genuinely cross by the same margin), and an unconfirmed donor
  demote cannot ratchet — `currentLevel` moves only on confirm, so a re-plan re-emits the same target.
- **Noise-proof funding check** (`REBALANCE_FUND_MARGIN_AMPS` 0.5): donors join only when the
  receiver's raise fits AFTER the cuts land with margin to spare — `jump ≤ max(0, available) + freed
  − 0.5` — in BOTH blocked branches. Without it, the ±0.5A resting-point noise armed a trade on every
  dip, the freed amps fit the DONOR's cheaper re-raise but not the receiver's step, and the level
  bounced donor↔receiver on a 35s period (caught by the quiet acceptance test; the debug dump showed
  52 commands in 30 min). Satisfied-only funding keeps its old unconditional behavior — dormant
  levels are not comfort.
- Invariant 9 unchanged: envelope-blocked + meter already holds the amps → same batch;
  meter-blocked → demote ALONE, raise next calm window. `emitDemotes` now takes explicit
  `{ac, target}` (satisfied → ceilOf, donor → one step).

**Post-deploy find, same evening (the 20-min watch again).** The very first gen tick after the
deploy's boot sampled while device views/amp models were still half-loaded and booked **11.1A of
"house"** (real ~4.1A) — safe direction, and it self-corrected once honest same-set samples outranked
the carried peak (the 18:25:15 raise shipped on the honest figure), but that is up to 15 min of
refused raises after every restart. Hardening: the SHELL holds off sampling until
`HOUSE_SAMPLE_COOLDOWN_MS` after its first tick (`firstTickAt`; `scenario.ts` mirrors it as
`firstStepAt`). The carry pool is empty at boot anyway, so the cost is 2 min of the pre-07-31
AC-only envelope, once per boot. Kept at the CALL SITE, not inside `sampleHouseLoad` — the pure
layer stays boot-agnostic and its unit tests keep first-sample semantics.

**Tests:** `house-load.test.ts` "turn-off decay contamination" (3) + the superset/partial-overlap
guards; `controller.test.ts` "a turn-off's decay is not house" (SHELL guard — scenario.ts mirrors the
sampling call, both sides need their own, per the 07-30 lesson); `scenarios.test.ts` "the 2026-08-01
phantom house" + "the 2026-08-01 level rebalance" (incl. the near-equal no-trade guard);
`raise.test.ts` "need rebalance" (9). **884 server tests green, `tsc` clean.** Every fix verified
failing-first; the house unit test reproduces the literal live 7.1A.

### 2026-08-02 — the 17-minute strand: probe re-arm on evidence + off-drop grade hygiene

**Incident (journal, Baghdad time).** Heavy-house gen morning — the non-AC load alone ran ~8A of the
15A generator (with Najat L1 + Abdu L1 modeled at 6.6A the meter read 14.66A). At 11:20:36 a severe
episode (17.4A peak) cut Abdu L2→L1 and shed Najat 5s later. The one allowed probe restore shipped at
11:27:19 (`probe at 2.3A, learned 5.2A unproven`, committed 11.9A) and bounced at 11:28:02 (15.29A —
"its own turn-on caused this"). From then on `restoreFailures = 1` disabled further probes for the
source-session, and every restore was priced at the plain learned `on@L1` = **4.12A** against a meter
floating 10.8–11.2A — refused by 0.2–0.4A each attempt (`no headroom: floors 15.1–15.3A vs 14.9A`)
for 17 minutes until the user turned her on by hand at ~11:44. The manual turn-on measured **+3.5A**
(11.1 → 14.66A): the learned price was ~0.6A above reality, in a regime where that was the whole
margin.

**Root causes, two, both fixed test-first:**

**1. The probe was once-per-session, but a bounce is evidence about the house it bounced IN.**
At 11:31 the committed meter sat a full amp below the failed attempt's own admission point — the
physics that bounced the probe no longer held, and even the honest cost fit — but nothing could ever
re-try cheap. Fix (`pacing.ts` + `raise.ts`): restore attempts now record the committed meter
admission saw (`AcPacing.attemptMeterAmps`, kept by `noteFailure`, cleared by `noteSuccess`);
`probeRearmed()` re-arms the probe when the current committed meter is ≥ `PROBE_REARM_DROP_AMPS`
(1.0) below that anchor. Each re-armed probe re-anchors LOWER, so a bounce loop needs the meter to
keep falling an amp per retry — bounded by physics — and every retry still rides the backoff ladder.
Would have fired at 11:31:17 live (anchor 11.865, committed 10.835).

**2. The off-drop grade that inflated `on@L1` was sampled while a peer's cut was still landing.**
The 11:20:41 shed graded **−4.03A** (expected −2.3) into Najat's `on@L1`: Abdu's cut 5s earlier was
still winding down through the median (his own grade caught −1.33 of an expected −2.5 — the missing
amps landed in her window). Same "residual while model and meter are out of step" class as
invariants 5b/20, in the grading path. The existing `contaminated` sweep only covered a LATER batch
moving into an open window — the mirror case was open. Fix (`controller.ts`): the shell stamps
`lastLoadAddAt`/`lastLoadDropAt` from each executed batch's meter commands (fan steps excluded — a
~0.1A trim must not suppress learning), and a single-command window is **born contaminated** when an
earlier batch is still settling in its own direction: `LEARN_SETTLE_DOWN_MS` (120s, the wind-down +
median, same physics as house-load's modeled-drop cooldown) for negate/off-drop windows,
`LEARN_SETTLE_UP_MS` (= `AC_RAMP_MS`) for raise/turn-on windows. Born-contaminated windows journal
and resolve attempts normally — they just never learn. Side effect, deliberate: in a raise TRAIN only
genuinely isolated batches learn now (previously the LAST window of a train learned all its
predecessors' tails — how Abdu's gen `level:1>2` climbed to 3.97A over 50 samples).

**Interplay:** fewer (but honest) cost samples means stale-high learned prices linger longer — which
is exactly what the evidence re-arm now covers from the other side.

**Not changed, deliberately:** the shed itself was correct (real 17.4A over-limit), plain-priced
admission after a bounce stays (invariant 3), and the ~8A house was real — the refusals' arithmetic
was right, only the price was stale. `scenario.ts` needed no mirror beyond passing `attempt.meterAmps`
through its `noteAttempt` call (it does not grade costs).

**Tests:** `raise.test.ts` "a bounced probe re-arms once the meter sits a full amp below the failed
attempt" + "a bounced attempt with no meter anchor never re-arms"; `controller.test.ts` "off-drop
grade voided while a peer's drop still settles" (asserts the isolated first shed STILL learns — the
over-suppression guard). **887 server tests green, `tsc` clean**, both fixes verified failing-first.

---

---

# v1 (historical — rollback target until deletion)

> Everything from here down documents the **v1** controller (`ac-leveler.ts` + `ac-leveling.ts`). v2 is acting (see the top of this file); v1 stays only as the rollback target and will be deleted after the soak. Kept verbatim so a rollback is well-understood.

**TL;DR (v1):** A closed-loop controller (built 2026-06-06) in the collector keeps total household current within the active power source's limit (Grid 30A / Generator 15A, editable) by adjusting TCL AC **generator-mode levels** (per-unit current caps). It can also reduce fans, emergency-shed ACs, and auto-restore them. A pure allocator (`ac-leveling.ts`) decides targets; a stateful layer (`ac-leveler.ts`) handles gating, persistence, manual intents, prediction, and command execution; a severe over-limit (≥ limit+1A ×2 readings, or the grid oscillation pattern) bypasses the budget fit entirely via the **emergency reduction fast-path** (meter-sized cut, urgent tick — own section below). A separate calibration runner (`ac-calibration.ts`) measures each AC's real draw per level/fan to tune the amp models.

Related docs: [database.md](database.md) (table schemas), [ac-automations.md](ac-automations.md) (range automation / fan enforcement side), [tcl-ac.md](tcl-ac.md) (TCL cloud protocol).

---

## Concept & sources

- **Goal:** keep total household current within the active source's limit by adjusting AC **generator-mode levels** — TCL's per-unit current cap: **0–3 on all three ACs** (level 0 = unrestricted). Najat had 0–6 until TCL removed levels 4–6 via firmware/app update in 2026-06 (see [tcl-ac.md](tcl-ac.md) "Generator mode" + the OTA-removal quirk). **Managed ACs are never left at 0** (user chose "always keep a cap").
- **One active source at a time** (changeover panel): source detection mirrors the power card — a line counts as active when its current > 0.1A; if both lines read, the larger wins. Sources: `grid`, `gen`, `none`.
- **Key files:** `server/src/ac-leveling.ts` (pure allocator, no I/O — originally 31 unit tests, now 84 in `ac-leveling.test.ts`), `server/src/ac-leveler.ts` (stateful `AcLeveler`), `server/src/ac-calibration.ts` (`AcCalibrator`), collector `checkAcLeveling()` runs after `checkAcTimers()` each loop tick. Config UI = "Smart AC Leveling" collapsible section in the bell modal (admin-only).
- **Master switch defaults OFF** — must be enabled in the bell-modal section after deploy (set priority first).
- Power readings arrive from the ESP power monitor every ~5s; the leveler consumes them via `AcLeveler.onPowerReading()` (called from collector `setLatestPower`).

## Pure allocator (`computeAllocation()` in `ac-leveling.ts`)

- **Budget:** `budget = limit − margin − nonAcLoad − opted-out AC draw`. The caller (leveler) derives `nonAcLoad = measured − Σ est(on managed ACs)`, using the **median of the last 4 ESP readings** for measured.
- **Amp model per AC** (editable, **per source** since 2026-06-07): `draw = baseAmps + stepAmps × (level − 1)`. `ampModels` = grid model + fallback; optional `genAmpModels` overrides on generator (lower voltage ~200V → more amps; the leveler picks via `ampModelFor(deviceId, source)`). Defaults: Abdu 4A@L1 + 2A/level; Najat & Abdullah 2A@L1 + 1A/level. Level 0 (unrestricted) is estimated as one step above max level.
- **Priority = protection; needDelta = who gets the next amp** (refined 2026-06-06 PM): minimum levels are granted by priority first; priority breaks delta ties. The user's priority order: Abdullah, Mom (Najat), Abdu. **⚠ For SHEDDING, superseded 2026-06-13:** shed protection is now need-based (the most *satisfied* room sheds first, a hot room is kept regardless of priority); priority only orders raises and breaks equal-need ties — see "Cost-aware reduction optimizer".
- **Fill algorithm:** every ON managed AC starts at its floor (L1 or boost min) → raises spread **level-by-level** (everyone reaches L2 before anyone gets L3); within a level the highest `needDelta` (°C past the satisfied point) goes first; ceiling per AC = `min(maxLevel, needCap, manualCap/manualTarget, slotCap, reachableCap)` (plus `bounceCap`, see Bounce detection).
- **Cap precedence (2026-06-10):** `slotCap` (per-range-slot gen level, see ac-automations.md) is a HARD cap that also clamps boost floors (explicit per-window user intent, mirroring "manual reduction below the floor wins") — but a live `manualTarget` beats it (manual beats automation, AGENTS.md rule 7). `reachableCap` (firmware-unreachable levels, below) clamps EVERYTHING including `manualTarget`, `bounceCap`, and floors — physics beats every intent. Both clamp to ≥ L1 (never level 0).
- **Raises jump straight to the budget-fitted ideal in one batch** ("guess by amp model, adjust by feedback") — the user explicitly rejected one-step-per-tick as too slow.
- **Need caps are delta-based since 2026-06-11 (near-target band):** `nearTargetNeedCap(needDelta, nearTargetBandC, maxLevel)` — an AC whose `needDelta` is within config `nearTargetBandC` (default **0.5°C**, validated 0–5, "Near target °C" field in the UI limits grid) of its target is **hard-capped at L1 in BOTH fill passes** (the room is about to be satisfied; satisfied delta ≤ 0 is inside the band by definition); above the band the cap is `maxLevel` — **the old mild-tier `ceil(max/2)` first-pass cap is gone**, the budget + fill order decide. The target is the active slot's low limit (range kind) or `comfortTargetC` (comfort kind) — both arrive as `needDelta`. Boost floors still beat the L1 cap (floors win over need caps); `manualTarget` still overrides it; slot/manual/bounce/reachable caps unchanged. `computeNeedTier` (satisfied/mild/full) still exists for the status/UI tier dot, and the old `needCap()` export remains for reference, but the allocator AND `buildStatus()`'s reported `needCap` use the delta-based cap.
- **Soft need caps** (2026-06-06 eve; reshaped 2026-06-11): the **second fill pass** (`softCeilOf()`) spends surplus budget raising rooms toward max — near-target rooms (delta ≤ band) stay hard at L1 (their automation is about to turn them off); `manualCap`/`manualTarget` remain **hard** ceilings. (Historical trigger: Abdullah pinned at L2 on grid with 25A free under the old mild cap.)
- **Min-level boosts** (config `levelBoosts{deviceId: {minLevel, outdoorAtLeastC}}`): per-AC conditional floor, e.g. Abdullah min L2 when outdoor ≥ 37°C (his AC can't cool at L1 in extreme heat). 1°C hysteresis lives in `AcLeveler.minLevelFor()`: activates at outdoor ≥ threshold, **releases at ≤ threshold − 1** (e.g. exactly 36.0° releases a 37° boost — changed 2026-06-07 from strictly-below, because 36.0° was keeping a 37° boost alive). Holds its last state when outdoor temp is unknown (> 10 min stale). Below-floor ACs are **corrected immediately** (ungated, like the never-level-0 rule, with `forceEvaluate` so others reduce to make room); a **manual reduction below the floor wins**.
- Other exports: `estimateAcDraw`, `determineSource`, `computeNeedTier`.

## Raise hysteresis buffer (2026-06-08, asymmetric deadband — user decision)

Config `raiseBufferAmps` (**default 0.2A since 2026-06-25** — was 1A 2026-06-08…06-25). The two fill passes AND restore-feasibility use `raiseBudgetAmps = budget − max(0, raiseBuffer)`; `overBudget`/shed/reduce/below-floor/level-0 correction keep the FULL `budget` (= limit − margin, the safety side).

> **Default lowered 1 → 0 → 0.2 (2026-06-25 — "there's headroom, raise it"):** the user observed the gen leveler sitting at L1/L1 with ~4A of raw headroom and no raise for ~13 min. Diagnosed (live `/api/ac/leveling`): all gates green (`headroomStreak` 295, no hold/settle, leaky bucket full, no caps) — the surge-gated admission was ~0.4A short. A gen level-up surges ~3.5A (the `stepAmps`), so from a steady 10.8A draw it lands at 14.3A, over the raise ceiling `limit − margin − raiseBuffer = 15 − 0.1 − 1 = 13.9A`. The moment draw fell to ~10A it raised Abdu L1→L2 and the meter landed at 13.7A vs an expected 13.885A (model spot-on). **The static deadband is no longer load-bearing:** the 2026-06-21 meter-anchored overhaul + the leaky-bucket trigger + the emergency fast-path + gen one-step pacing are the trip guards now. First set to **0** (use all the headroom), but at 0 the home rode right at the breaker (live ~14.7A on the 15A gen, raise ceiling 14.9A); settled on **0.2** — a thin cushion that pulls the resting draw a sliver off the breaker (ceiling `15 − 0.1 − 0.2 = 14.7A`) while still admitting raises at nearly the same draw as 0. Set live via `PUT /api/ac/leveling`, then codified the default. Raise it further (≈0.5–1A) only if a source visibly limit-cycles near its breaker.

**Root cause it fixes — a sustained limit cycle on generator (control-theory problem, not a logic bug):** live `marginAmps` was set tiny (**0.1A**) on the 15A gen because the user rides near the breaker on purpose. The raise ceiling (`limit − margin`) and the over-limit reduce trigger (`limit`) were ~0.1A apart — no hysteresis deadband. Because the caller derives `nonAcLoad = measured − Σ est(on managed)`, `budget − currentOnCost = limit − margin − measured`, so a raise fits iff `measured ≤ limit − margin − step` — landing the resting draw at ≈`limit − margin`, right at the breaker, where ±0.5–1A gen fluctuation repeatedly crossed the limit → reduce → headroom → re-raise forever. Live symptom: Abdu/Abdullah swapping a gen level every 80–250s indefinitely, confirmed in 3h of live gen logs + `/api/ac/leveling` after the user reported "smart ac leveling is not reaching a stable state, it keeps raising and downing the levels." Secondary cause: the bounce window (`lastRaiseBatch.windowUntil = raise + RAISE_HOLD_MS 120s`) was shorter than the ~250s cycle, so most reduces weren't attributed → no bounce cap → re-raise (fixed by decoupling, see Bounce detection).

The buffer rests a raised AC a full buffer below the breaker so noise can't trip the reduce → the cycle collapses to a fixed point.

- **Reduce side unchanged** — stays on `limit − margin` band; reductions fire only at/over the raw limit (user: "if even 0.1A below, no reduction"). Do NOT bump `marginAmps` to compensate.
- **Fan is deliberately NOT buffer-gated** (user follow-up 2026-06-08: "the fan speed should not be like leveling with the raising buffer"). An initial implementation widened the `onPowerReading` headroom band to `limit − margin − raiseBuffer`, which (via `headroomStreak` → `canRaise`) also delayed the staged fan restore (`toFanRaise`). Reverted: the headroom band stays at the un-buffered `measured ≤ limit − margin`, so cheap, comfort-positive fan restores recover on real headroom. The gen-level buffer is enforced ONLY in the allocator fill (`raiseBudgetAmps`) + restore feasibility — `canRaise` itself is un-buffered; the fill is where the buffer bites (a gen raise still can't climb into the deadband because the fill won't add the step). Fan REDUCTION (reduce-before-shed) already used the full `budget`/`overBudget`, never the buffer.
- Negative buffer clamps to 0 (never raises above `limit − margin`). `idealLevels` in status now reflects the raise-budgeted target (the level it will actually drive to). Floors/boosts/below-floor/level-0 correction are unaffected (seeded before the fill, judged on full budget).
- **Implementation details:** `ac-leveler.ts` passes `raiseBufferAmps` into `AllocatorInput`; the bounce retry-clear is tightened to `smoothed + requiredAmps ≤ limit − margin − raiseBuffer` (a cleared bounce can't instantly re-bounce); `updateConfig` merges over `DEFAULT_LEVELING_CONFIG` so an old/partial client payload can't set the field undefined → NaN. Reaches the live config via the load-merge default + `updateConfig` defaults-merge (no migration; the user did NOT edit the live saved config). Client: `raiseBufferAmps` in the leveling type; `seedDraft` prefill `?? 0.2` (not dirty; was `?? 1` before 2026-06-25); "Raise buffer A" `NumberField` in a 5-col limits grid. `routes.ts` validates 0–10 (optional) + `?? 0.2` fallback (was `?? 1`).
- **Tests:** the `input()` helper + collector `LEVELING_CONFIG` default the buffer to **0** (keeps all prior assertions). `ac-leveling.test.ts` "raise buffer (hysteresis)" suite (7 cases) + `collector.test.ts` limit-cycle regression (settles + stays quiet under sub-limit noise) and bounce-window test (reduce at 150s > hold still records a bounce). 220 server tests green at ship; deployed; live config picked up `raiseBufferAmps:1` via merge, and Najat's ideal dropped L5→L4 (buffer constraining as designed).

## Gating & streaks (gen current fluctuates)

> **SUPERSEDED 2026-06-17 by the over-limit leaky bucket** (see "Leaky-bucket over-limit trigger" under the 2026-06-17 section). The consecutive mild/severe streaks and the grid-only oscillation gate described below were replaced by one accumulator that tolerates fluctuation but accumulates a sustained/oscillating overload on BOTH sources. The action sizing (mild → allocator reduce; severe → meter-sized emergency) is preserved — only the trigger changed. The detail below is kept for history.

- **Asymmetric reactive reductions** (2026-06-08, replaced the original flat 4-reading reduce gate that took ~20s):
  - **Mild** over-limit (measured < limit + `OVER_LIMIT_SEVERE_AMPS` 1A over the raw limit): needs `REDUCE_STREAK` **5 consecutive ESP readings** (~25s). Any reading back at/below the limit resets the streak.
  - **Severe** (**≥ limit + 1A since 2026-06-12**, was strictly >; exactly +1.0A — the live 31A incident's readings — used to count as mild): just `REDUCE_STREAK_SEVERE` **2** readings act, and since 2026-06-12 they route to the **emergency reduction fast-path** (own section below), not the budget-fitted allocator. A merely-mild reading breaks the severe streak but NOT the over-limit streak.
  - Tracked as separate `overLimitStreak` / `severeOverLimitStreak` counters in `onPowerReading()`; the allocator's `canReduce` ORs both thresholds, the leveler's `reactive` flag (used for bounce attribution) ORs both, and both reset together (source change, source "none", after a reduction).
  - **Streak semantics (confirmed with the user):** `overLimitStreak` counts only `measured > limit`; a single reading at/below the limit resets it (the margin band resets both streaks). Streaks are counted **per ESP reading, not per tick**.
  - Status exposes `severeOverLimitStreak`; UI hint shows "severe over-limit N/2" else "over-limit N/5".
- **Proactive** (`forceEvaluate`): AC power flip, source change, manual gen change, config change, below-floor AC → act **immediately**, no streak required.
- **Raises/restores:** need **6 consecutive headroom readings** (~30s, `headroomStreak`, band = un-buffered `measured ≤ limit − margin`) + must be outside the **30s settle window** (`SETTLE_MS`) after any command (plus the raise hold, see below).
- After reductions **both streaks reset** (code-review fix — a stale pre-shed headroom streak could otherwise restore prematurely).
- `nonAcLoad` uses the median of the last 4 readings. Power considered stale/`none` after 15s without a reading (`STALE_POWER_MS`).

## Emergency reduction fast-path (2026-06-12 — "we have seconds before the breaker trips")

User request: when the current exceeds the limit by ≥1A for 2 consecutive readings, act fast AND smart — sized by data, no uncalculated over-reduction that lands far under the limit and re-raises until stable.

**Why the normal path wasn't enough** (all three seen live): the action waited up to 5s for the next collector tick; `computeAllocation` sizes reductions from the model (`budget = limit − margin − nonAcLoad`, with `nonAcLoad = measured − Σ estimates`), so a contaminated input — frozen nonAcLoad, phantom credit from a shadow stuck at 0 — can conclude ideal == current and ship NOTHING while the meter reads 1A+ over (the 31A grid incident: breaker tripped); and the fan-first → fresh-streak → shed staging burned 10–30+ extra seconds on big overshoots.

- **Triggers** (evaluated per ESP reading in `onPowerReading`, acted on in `tick()`):
  1. `severeOverLimitStreak ≥ REDUCE_STREAK_SEVERE` (2 readings ≥ limit + 1A), or
  2. **grid-only oscillation gate** (`oscillationOvershoot()`): ≥3 of the last 6 readings over the limit AND ≥1 of them severe AND the current reading over — catches the live 31A pattern (29↔31 alternating around a 30A limit) where every under-limit reading resets the consecutive streaks so NO streak gate can ever fire. Generator excluded (user decision — they deliberately ride 14.3–14.8A on the 15A gen, where the pattern is ordinary noise).
- **Urgent tick:** the qualifying reading fires the `onUrgentLevelingNeeded` dep → collector runs the leveling check immediately instead of waiting ≤5s for the loop tick. Loop ticks and urgent ticks share one serialized entry point (`runLevelingCheck()` — in-flight promise + coalescing queued flag) so two passes can never interleave awaits and double-send; all callers await the full chain.
- **Meter-sized target, not model-sized:** `required = overshoot + marginAmps`, where overshoot = `min(severe-streak readings) − limit` (every reading in the streak supports it; min can't be inflated by a one-reading spike, and the median-of-4 smoothing would dilute a fresh spike) or, for the oscillation gate, `median(over-limit readings in the window) − limit`. Landing point is ≈ `limit − margin` — just under the limit, not deep below.
- **`computeEmergencyReduction()` (pure, ac-leveling.ts):** builds the SMALLEST sufficient action set in one batch, sheds included (revised 2026-06-12 PM — see the incident note below):
  1. *Never-level-0 pre-pass:* an unrestricted AC is capped regardless of the target — at its **top commandable level** (min of maxLevel/reachableCap/slotCap/manualCap, ≥ floor), not the floor, so the invariant alone can't over-reduce. The per-AC credit is remembered: if the AC is later shed instead, its savings count ONCE at the full observed draw, never stacked.
  2. *Total-capacity check → same-batch sheds* (user decision 2026-06-12 PM: "make the calculations first — if it can be fixed with just level/fan cuts, do that; otherwise go directly for turning off the correct AC(s)"): when every level-to-floor + every reducible fan together still can't cover `required`, **shed(s) ride in the SAME batch** — the **least-needy SUFFICIENT** AC first (the first non-top AC whose observed-level draw + the cuts still available on the others covers the target; a knowably-insufficient least-needy AC is *skipped* — cycling its compressor fixes nothing). No single non-top AC sufficient → accumulate least-needy first; the **top-priority AC joins only as true last resort** and is never picked by the single-sufficient scan even when it alone would cover. No shortfall threshold (user's literal rule): even a sub-fan-sized shortfall sheds the sufficient AC instead of shipping knowably-insufficient cuts. *This REVERSED the same morning's "a power-off never rides in a cut batch" staging.*
  3. *Level cuts toward floors* (shed ACs excluded — a shed AC ships no level/fan commands), least-needy AC fully first, top-priority AC dead last (the allocator's shed-order semantics); stops the instant savings ≥ required. **Best-fit final step:** a remainder ≤ one fan drop (0.5A) is handed to the fan phase instead of burning a 1–2A level step — bounds the typical over-cut to ~0.5A.
  4. *Fan cuts in the SAME batch* — no separate staged attempt. Since 2026-07-16, a numeric fan with a learned per-step cost can land directly at the smallest intermediate target that covers the remaining overload (for example 7→4), rather than treating the whole 7→1 drop as one binary 0.5A move. Built-in auto is indivisible; without a learned step cost the conservative historical 0.5A full-drop fallback remains. This subsumes the old "skip the fan attempt when the overshoot dwarfs fan savings" follow-up knob.
- **The 18A gen incident that forced the revision (2026-06-12 morning, fast-path already live):** required 4.4A with everything at floors and only 1.5A of fan cuts available — the staged design shipped the knowably-insufficient fans anyway ("not fully covered, escalating on the next streak"), a fresh streak shed least-needy Najat (est 2.3A — couldn't cover it, and her real draw was lower still: ±3–6A amp-model warnings in the same logs), and a third streak finally shed Abdu. Three batches + two streak waits where one sufficed; user: "it should be smart enough to understand that none of those will fix it [and] directly go to turn off abdu." Under the revised rule the same readings produce ONE batch ≈ 6s after the spike — shed Abdu (4A, sufficient) + one fan drop for the 0.4A remainder — and Najat stays on and cooling.
- **Anti-stacking discount (`EMERGENCY_PENDING_MS` 15s = NON_AC_FREEZE_MS):** a new severe streak within 15s of an emergency batch is discounted by that batch's estimated savings — compressors take seconds to respond, and cutting again before the meter reflects batch 1 is the over-reduction → bounce cycle the user explicitly rejected. While deferred, the allocator input gets `severeOverLimitStreak: 0` so its own severe gate can't double-reduce on the same readings. Escalation is feedback-driven: each new streak re-measures from fresh readings that already include landed savings.
- **Everything else rides the existing `execute()`:** shed persistence + push, fan holds, unreachable send counting, bounce attribution (the batch passes `reactive=true` — an emergency cut undoing a recent raise still records its bounce), settle, nonAcLoad freeze, expectation/prediction grading, streak resets. Floors stay HARD, never level 0, manual-off locks win, reachable/slot/manual caps honored. Recovery keeps all raise-side hysteresis (raise buffer, 6-reading headroom streak, raise holds, bounce caps) so a small over-cut self-corrects once and settles.
- Status exposes `lastEmergency {at, requiredAmps, savedAmps}`; the UI shows a red "emergency cut X.X A · HH:MM" hint (30-min recency) next to the streak hints. Pino warn `EMERGENCY: ~XA over the …` logs every batch.
- Escalation timeline at live cadence: spike → ONE sized batch (levels + fans + sheds as needed) ≈ 6s. Follow-up batches exist only for model error — the meter still over after the discount window → a fresh 2-reading streak re-measures and cuts/sheds the remainder (~16–21s), feedback-driven.

## Cost-aware reduction optimizer (2026-06-13 — "smartly assess; lower fans / level down / turn off the right one(s); fewest steps; rebalance ASAP")

The greedy "shed the least-needy SUFFICIENT single AC" selection (both the normal over-budget path and `computeEmergencyReduction`) was replaced by one pure optimizer, **`selectReduction()` in `ac-leveling.ts`**, that BOTH paths delegate the WHICH-to-cut decision to. It enumerates every feasible end-state for the (3) managed ACs — keep / level-down to any floor-respecting level / power OFF, each optionally with a fan-to-1 drop — and returns the lexicographic-minimum plan that covers the savings target. Trigger driving it: the user's live complaint that leveling **turned off his own (hot) AC** when leveling down or shedding a different (cool) room would have sufficed.

- **Objective (minimize, in order):** (0) feasible beats infeasible; (1) **`shedNeed`** = Σ need of the rooms turned OFF — *this is need-based, NOT priority-based:* a cool high-priority room is shed before a hot low-priority one (the live config protected the parents' AC and sacrificed the user's hot room — that is the bug); (2) need-weighted disruption (`shed ≫ level ≫ fan`, each × `1 + needK·max(0,needDelta)`; the top-priority AC's level carries a small surcharge so it is cut LAST among levels, well below a shed; a `restoreBlocked` AC costs `bounceShed` extra to re-shed); (3) over-cut (land just under the limit — bucketed so it can't outweigh (2); deliberately NOT primary, or it chases the knife-edge at `limit−margin` and re-triggers every tick); (4) fewer commands, then fewer ACs disturbed. Weights live in `DEFAULT_REDUCTION_WEIGHTS` (tunable).
- **What it produces:** a hot room is kept running — leveling it down, or shedding cool rooms (even two of them), always beats shedding the hot room. Prefer level-downs over turning a room off (the search only sheds when level+fan cuts can't cover). When a shed IS forced, the most *satisfied* rooms go first. Reduce-only: raises/restores stay in `computeAllocation`'s fill so the raise-buffer hysteresis is never bypassed.
- **Level-down savings sized by the LEARNED cost (2026-06-18):** `selectReduction`/`computeEmergencyReduction` take an optional `raiseSurge` map (the same `observedRaiseCost` the raise gate uses) and, on gen, size each level-down at `max(modelStep, learnedCost)`. The static gen model **under-states** the per-level step, so a level-down's estimated savings looked too small to cover the overshoot and the optimizer **shed (turned the AC OFF)** when a single correctly-credited level-down would have sufficed (live logs: a 4.3A shed to cover a 0.3A overshoot). With the real cost a level-down beats a shed whenever it actually covers `required`; an AC genuinely at floor still sheds (no level-down to credit). The meter-sized `required` stays authoritative — only the *which-move-saves-how-much* estimate gains the correction.
- **Invariants preserved inside the search:** never level 0 (an observed-0 AC has no "keep" candidate — it is re-capped to its top commandable level or shed), boost floors (`floorOf`), reachable/slot/manual caps (`ceilCapOf`), shed≠manual-off (locks pre-filtered in `tick()`), meter-sized `required` stays authoritative for the emergency path (its caller still sizes from the meter; the optimizer only chooses the set).
- **Priority is now a tiebreak, not a shed shield** — supersedes the 2026-06-06 "priority = protection; top sheds last" rule for SHEDDING (it still orders raises and breaks equal-need ties). The "same-session Abdu shed diagnosis" note below (priority #1 protected → Abdu shed) is the behavior this change fixes.

## Generator over-raise trip & gen-step retune (2026-06-13 afternoon — "the last update messed it up; check why the power broke")

Live 15A-gen breaker trip ~14:21 UTC. The home rode the generator at 14.4–15.0A for >1h (user margin 0.2A) and the leveler **raised Abdu L1→L2 (14:17:55, the moment his 60-min bounce-cap safety-expired) then L2→L3 (14:19:46)**; real-time current crossed the breaker and tripped (`power_readings` collapsed 15.9A→3.7A for ~4 min, recovered 14:26). Diagnosed from leveler logs + `power_readings` + a deployed-code check.

- **NOT caused by the 2026-06-13 cost-aware optimizer.** `selectReduction` / `RESTORE_SHED_STREAK` / `BOUNCE_MODEL_TOLERANCE_AMPS` touch only the REDUCE/shed/bounce-cap paths; level RAISES come from `computeAllocation`'s fill, unchanged. This trip would have happened identically pre-update.
- **Root cause — the gen amp model under-states the per-level STEP under binding (hot) demand.** A gen level is a CAP, not a setpoint: when cool, compressors draw under the cap (prediction grading logged `off by −4.2A on gen`, model over-predicts); when hot, *releasing* a cap lets the compressor surge. Logged bounce "observed cost" = the real marginal raise: **Abdu L1→L2 = 2.8A & 2.9A** (two clean samples), **Najat L1→L2 = 2.9A** — vs models of 1.1A / 1.8A. The marginal raise-fit reduces to `step ≤ limit − margin − raiseBuffer − measured` (base/nonAcLoad cancel), so with step 1.1 the leveler raised whenever measured ≤ 12.7A → a 2.9A surge → 15.6A → trip.
- **Fix applied (live config save; user chose "fix the model"):** gen **step** bumped to the observed surge — Abdu 1.1→**2.9**, Najat 1.8→**2.9**, Abdullah 1.1→**2.0** (no bounce data; conservative, small unit). **Bases kept** (floors/shed sizing stay accurate; only the raise gate tightens). A gen raise now needs measured ≤ ~10.9A, so the surge lands ≈13.8A < 15A. Safe direction: it over-states absolute draw when cool (more conservative raising; nonAcLoad can read slightly negative — cosmetic, since emergencies are meter-based and floors use the base). The linear model can't fully capture the demand-dependent surge — a proper binding-demand calibration run would refine it.
- **Power-collapse (trip) guard — FIXED 2026-06-13 (guard B, user-approved).** The leveler used to raise INTO a collapsed line: at 14:22:00, with current already 3.7A (breaker tripped), it raised Najat L1→L2 reading 3.7A as ~11A of free budget, setting up the recovery surge at 14:26 (3.7A is above the 0.1A source-"none"/STALE floor, so it still saw "gen active"). Now `onPowerReading` **latches a power collapse** when the smoothed measured drops by ≥ `POWER_COLLAPSE_DROP_AMPS` (6A) **outside the settle window** AND lands ≤ `POWER_COLLAPSE_FLOOR_AMPS` (5A) — the AC load vanished, not a mere demand drop. The absolute floor is what keeps the bounce retry-clear's *deliberate* load-drop (lands at the still-running ACs' draw, well above 5A) from reading as a false trip. While latched, `headroomStreak` is forced to 0 so no raise/restore can fire into the dead line; the latch clears when measured recovers to within `POWER_COLLAPSE_RECOVER_GAP` (3A) of the pre-collapse median (→ re-arms the compressor ramp for ON ACs, like a source change) or after the `POWER_COLLAPSE_MAX_MS` (5 min) safety cap. Tests: `collector.test.ts` "power-collapse (trip) guard" ×2 (freeze-no-restore-during-collapse + resume-on-recovery). **Known limit:** detection is gated on `outside settle`, so a trip within 30s of a leveler command is missed (the emergency path still catches the recovery surge); and a user turning off the single biggest AC (>6A drop to ≤5A) briefly freezes raises — harmless/conservative.
- **Latent defects — both addressed 2026-06-17 (see that section):**
  1. ~~Fan restore is not raise-buffer-gated~~ → **FIXED:** fan restore now requires the restored fan to fit `raiseBudgetAmps`.
  2. ~~60-min bounce safety-expiry re-raises straight back into the same overshoot~~ → **mitigated:** the post-expiry re-raise now climbs ONE step (gen one-step), confirms on the meter, and re-caps if it bounces — a re-probe, not a jump back. Plus the bounce cap is now sticky (clears only on sustained headroom).
- **Forensics gotcha:** `power_readings` stores only ~1 row/MINUTE (verified: 10 rows over 10 min), so the dashboard chart smooths away the sub-minute spikes that actually trip the breaker. Use the leveler logs (reading-cadence) for incident forensics, not the chart.

## One-step + learned-surge gen raises (2026-06-17 — "the gen tripped again; misbehaviour + slow response")

A fresh 15A-gen breaker trip (2026-06-17 03:14–03:18, confirmed in `power_readings` collapse 15.4A→3.4A for ~3 min) plus a day of thrash (≈23h of logs: **41 raise batches, 15 emergencies, 6 shed/restore pairs, 40 push notifications**, prediction error spanning **−9.4A…+6.2A**). Root cause confirmed = **over-aggressive raising**, not slow reduction:
- The 2026-06-13 gen-step retune was **reverted** — the live `ac_leveling_config` (re-saved 2026-06-14) had **step 2.0 for all three** ACs while logged observed raise cost was **3.5–3.7A**. A gen level is a CAP, not a setpoint: releasing it surges a hot/pinned compressor by far more than the static linear `base+step` predicts (errors ±5–9A on a 15A budget, both directions). Model-based raises overshoot the breaker; the controller then sits in a raise→overshoot→emergency/bounce→load-drops→re-raise limit cycle.

**Fix (user chose "one step, meter-confirmed" raises + "ride near the limit, the bucket guards" — see the leaky-bucket section):**
- **One step per raise batch on generator.** `computeAllocation` still computes the full budget-fitted `idealLevels` (so REDUCTIONS reach the equilibrium at once — safety — and the status shows the true target), but the **commanded** raise in `desiredLevels` is clamped to `currentLevel + maxRaiseStep` (1 on gen). The leveler passes `maxRaiseStep: source === "gen" ? 1 : undefined` (grid keeps straight-to-ideal batch raises — the 28A budget doesn't bind). The existing raise-hold early-release paces the next step (~confirm on the meter). **Warm restore is exempt** (it returns to a recently-confirmed-stable level, gated by ramp + restore-hold).
- **Surge-gated raise admission.** The fill charges each ABOVE-current step a per-AC `raiseSurge` (real cost of releasing the cap) instead of the model step — `max(modelStep, learnedSurge)`. Re-filling up to the current level (a no-op command) still uses the model. So a raise is admitted only if `measured + realSurge ≤ limit − margin − raiseBuffer`, regardless of a wrong static model. Grid passes no `raiseSurge` (unchanged).
- **Learned surge (`observedRaiseCost` map in `ac-leveler.ts`).** Per-AC, per-source EWMA of the real raise cost. Originally learned only from single-AC level **bounce** observations. **Two-way learning from every confirmed raise (2026-06-18):** at the expectation-grading site, a CLEAN single-AC level raise (no restore/turn-on, not bounced — `lastRaiseBatch` still present) also EWMAs its real cost (`measured − preMeasured`) into the map — crucially in BOTH directions, so a raise that drew LESS than the static model feared lowers the gate (the bounce path only ever ratcheted it up, leaving the gate over-conservative). Cleared on source change and config save. Fed in as `raiseSurge` on gen — so the gate **self-corrects from reality** even if the config model is wrong again (the user reverted it once already).
- **Net:** near the limit (where trips happen) the surge gate already limits a raise to ~one level; the one-step cap is the hard guarantee. Overshoot is bounded to a single step's surge, which the leaky-bucket trigger then catches if it still crosses.
- **Tests:** `ac-leveling.test.ts` "one-step + surge-gated raises (gen)" suite (6 cases: one-step paces the command while ideal stays the full target, grid unchanged, no spurious reduction at top, reductions not staged, surge blocks an unfit raise, surge charges only above-current steps). `collector.test.ts`: one-step gen raise + grid straight-to-ideal integration tests; the predictive-hold / drift / bounce / raise-buffer / warm-restore suites were retuned to the one-step reality (held raises use Abdu's 2A step so a flat meter can't auto-release a +1A step; buffer test climbs across confirm ticks).

### Leaky-bucket over-limit trigger (the user's "points" idea, generalized)

Replaces the consecutive mild/severe **streaks** AND the grid-only `oscillationOvershoot` gate with one **over-limit accumulator** per source in `onPowerReading` — an integral / I²t-style trip that tolerates fluctuation around the limit but accumulates a sustained or oscillating overload (the streaks reset on any single sub-limit dip, which is exactly why the gen ride and the 31A grid oscillation evaded them). Constants in `ac-leveling.ts`: `OVER_LIMIT_BUDGET` 5, `OVER_LIMIT_DRAIN_SEVERE` 3, `OVER_LIMIT_DRAIN_MILD` 1 (capacity bumped 4→5 on 2026-06-17; severe drain bumped 2→3 in the same change so the 2-severe-reading fast trip is preserved — see below).
- **Drain (user's rule):** a reading > limit + `OVER_LIMIT_SEVERE_AMPS` (1A) drains 3 points, within 1A over drains 1. Acts when the bucket empties (≤ 0). With capacity 5: a sustained **mild** overload trips after **5** readings; a **severe** one after **2** (3+3 = 6 ≥ 5); a mixed 1-severe-plus-2-mild also reaches 5.
- **Severe drain sized to keep the 2-reading fast trip:** the user raised the bucket to 5 points for more mild tolerance; severe drain went 2→3 in the same change so two severe readings (6 ≥ 5) still empty the bucket fast (the breaker trips in seconds on a genuine severe overload — slowing that to 3 readings was rejected).
- **Refill is EPISODE-based, not per-reading:** the bucket refills to full only after a sustained-calm `RAISE_STREAK` of genuine-headroom readings (≤ limit − margin). A per-dip refill was rejected — it would let a balanced oscillation refill as fast as it drains and never act (the 31A failure). Margin-band readings (limit − margin, limit] hold the bucket (no drain, no refill — the deliberate near-limit ride). Refilled to full after acting and on source change / "none".
- **No instant-act tier (user follow-up on inrush):** a single turn-on inrush spike drains ≤ 3 of 5 points and refills on sustained calm, so it can't false-trigger; acting needs a *sustained* overshoot (≥ 2 readings).
- **Action picked by MAGNITUDE, not a separate gate:** when the bucket empties, a SEVERE reading (> limit + 1A) in the recent window routes to the meter-sized `computeEmergencyReduction` (overshoot = `median(over-limit readings) − limit`); an ALL-MILD empty drives the gentler allocator fitted-reduce + fan-before-shed via its `REDUCE_STREAK` gate. The whole action/sizing machinery (selectReduction, sheds, anti-stacking discount, urgent tick) is unchanged — only the *trigger* moved to the bucket.
- **Status:** `overLimitBudget` / `overLimitBudgetMax` (replaced `overLimitStreak`/`severeOverLimitStreak`); UI hint shows "over-limit N/5 points" (text is derived from `overLimitBudgetMax`, so it tracks the constant automatically). The bucket params are constants (tunable via redeploy) — promoting them to config is a small follow-up.

### Anti-cycle + trip-guard hardening
- **Sticky bounce caps:** the retry-clear now also requires a sustained `headroomStreak ≥ RAISE_STREAK`, so a bounced AC doesn't re-raise on the *momentary* load drop from shedding a DIFFERENT AC (the live cycle: Najat shed → Abdu's bounce cleared → Abdu re-raised → re-bounced). A shed AC restores (3 readings) before a bounced AC retries (6). Still evidence-based, not a timer.
- **Trip detection works during commands:** the power-collapse latch no longer requires `now ≥ settleUntil` — the leveler commands almost every tick during an episode, which kept the settle window fresh and made guard B miss the 03:14 trip. The ≤ `POWER_COLLAPSE_FLOOR_AMPS` (5A) floor is the real discriminator (a normal reduction leaves ACs drawing well above it); a deliberate big shed landing ≤ floor latching is benign (raises *should* be frozen right after a big shed).
- **Fan restore is now buffer-gated** (was latent defect #1): the restored fan must fit `raiseBudgetAmps` so jumping it back can't re-push the meter over near the limit. With a 0 buffer this is the old behavior.

### Notification throttle
`pushLevelingNotice(body, critical)` rate-limits non-critical leveling pushes to ≤ 1 per `LEVELING_PUSH_THROTTLE_MS` (5 min); a **shed** (an AC turned OFF — actionable) is `critical` and always notifies. Cuts the ~40 pushes/day that trained the user to ignore them.

### Per-device opt-in (default OFF)
Leveling pushes are no longer broadcast to every subscribed device. `collector.broadcastPush()` sends only to rows where `push_subscriptions.leveling_notifications = true` (default `false` for all devices, including the admin's). The same flag gates **both** shed/restore notices and the "AC Calibration finished" broadcast (both flow through `broadcastPush` as `type: "leveling"`). Each device opts in via the "Smart AC Leveling alerts" toggle in the Alerts modal → `POST /api/push/leveling { endpoint, enabled }` (read with `GET /api/push/leveling?endpoint=…`). Even a `critical` shed respects the toggle — the opt-in is the master gate. Round-trip covered by `server/src/push-routes.test.ts`.

**Verification:** **344 server tests green, server + client `tsc` clean.** New/updated tests: the one-step suite, leaky-bucket gating (mild 4-drain, severe 2-drain, 29↔31 grid accumulation, gen-fluctuation tolerance, single-blip-then-refill), sticky-bounce momentary-drop, and the push throttle.

**Live config gen step (operational):** re-seeded to **3.5A for all three ACs** on 2026-06-18 via `PUT /api/ac/leveling` (matches observed raise cost; the learned-surge EWMA + one-step also self-correct a wrong model, so it's a seed, not load-bearing). The static gen **bases** are per-AC (`CA5IMhFAAAE`/Abdu 4.3, `Cy3aihFAAAE`/Abdullah 2.3, `DHihohFAAAE`/Najat 2.3). (Investigated the client `seedDraft` "clobber" — it only fills gaps and refreshes on non-dirty polls, so it is NOT the 06-14 revert vector; no client change made.)

### Raise-responsiveness retune (2026-06-18 — "raising too conservative since the one-step update; pushed toward turn-off over level-down")
Diagnosed from 60h of gen logs: the one-step rewrite traded raise snappiness for trip-safety it did NOT deliver (~20 emergencies + 2 trips in the window) — slow raises AND still tripping. Three code fixes (one-step pacing KEPT as the hard trip guarantee):
- **Provable-headroom hold release** (see "Effect-confirmation raise hold") — fixes the under-delivery trap.
- **Two-way learned surge** (see "Learned surge") — the gate now self-corrects DOWN from clean raises, not just up from bounces.
- **Reduction sizing by learned cost** (see "Cost-aware reduction optimizer") — a correctly-credited level-down beats a premature shed.
- **Restores exempt from the raise buffer** (see "Faster shed restore" bullet) — a shed room auto-restores as soon as it fits under `limit − margin`, fixing "there was headroom and it didn't use it" (user had to turn the room back on by hand).
- **Sweet-spot fan restore** (see "Sweet-spot fan restore" bullet under "Fan reduction before shed") — fans climb to the highest level that fits (learned per-step cost) instead of bouncing 1↔full.
- **DEFERRED — scoping the 270s turn-on hold off plain post-source-flip level raises.** After a gen↔grid changeover all ON ACs get a re-armed `AC_RAMP_MS` window, so any level raise inside it inherits `RESTORE_HOLD_MS` (270s) not `RAISE_HOLD_MS` (120s). Shortening it is only safe if a changeover does NOT physically cold-restart compressors — but this doc (Turn-on ramp window) states it DOES (user-measured ~4-min ramp), which justifies the 270s. The provable-headroom release already lets these holds release early when there's room, so the benefit is captured safely; revisit shortening the duration only after live confirmation of the restart behaviour.
- **Common thread (all five):** prefer USING available headroom over static deadbands, and SELF-CORRECT unmodeled/wrong costs by learning from the meter (`observedRaiseCost` per gen-level, `observedFanStepCost` per fan-step) — fans are NOT in the amp model (their amps land in `nonAcLoad`), which is why a flat fan-cost guess limit-cycled. Settle, never oscillate.
- Tests: `ac-leveling.test.ts` Fix-D level-down-vs-shed, un-buffered restore, fan sweet-spot/auto-hold; `collector.test.ts` provable-headroom early release + two-way surge learning. **362 server tests green; server `tsc` clean.**

## Grid raise discipline (2026-06-19 — "I had to manually turn off two ACs at 32A; leveling took no action")

Live grid incident (~02:32 UTC): the leveler raised **all three ACs straight to L3 in one batch** ("grid budget 27.8A") believing total draw ≈14.8A; real draw climbed to **~32A** (`Amp model off by +8.8A — expected 17.2A, measured 25.9A on grid`). The over-limit emergency then only shaved one AC's level + 2 fans (model said ~5A "covers" the 4.7A needed) — useless against a 3-AC overshoot — so the user shed two ACs by hand before the *second* emergency shed a third. **Root cause: every generator trip-protection was gen-only; grid was exempt under the retired assumption "the 28A budget doesn't bind."** It does bind with 3 ACs on a hot night, and the static grid model under-predicted draw by ~17A, so uncapped batch raises overshot with no self-correction.

**Fix — the gen recipe now applies on BOTH sources** (the pure allocator was already source-blind; the gating lived in `ac-leveler.ts`'s `AllocatorInput` wiring):
- **One step per raise batch on grid too.** `maxRaiseStep` is now per-source config `maxRaiseStepGrid` / `maxRaiseStepGen` (both default **1**). **Production ACs are 3-level, so the max raise is L1→L3 = 2 levels — anything ≥ 2 is NO pacing.** Default 1 makes all ACs climb L1→L2, confirm on the meter, then L2→L3 (where the surge gate can block it). The "grid jumps straight to ideal" behaviour is gone; `idealLevels` still shows the full target.
- **Surge-gated admission + learned `observedRaiseCost`/`observedFanStepCost` on grid.** Dropped the `source === "gen"` guards on `raiseSurge`/`fanStepCost` (both the fill input and the emergency `computeEmergencyReduction` call) and on the two learning sites (clean-raise two-way + fan-step). A grid raise is admitted only if `measured + realSurge ≤ limit − margin − raiseBuffer`, and a correctly-credited grid **level-down beats a premature shed** in the emergency path. The maps stay single (cleared on changeover / config save) — one source is active at a time, so no grid/gen clobber.
- **Operational re-seed (2026-06-19):** grid `ampModels` re-seeded to gen-equivalent (Abdu `CA5IMhFAAAE` 4.3/3.5, Abdullah `Cy3aihFAAAE` 2.3/3.5, Najat `DHihohFAAAE` 2.3/3.5 → 3×L3 ≈ 30A, matching reality) via `PUT /api/ac/leveling`. A seed, not load-bearing — the learned surge self-corrects; the one-step cap is the hard guarantee.
- **Config:** `maxRaiseStepGrid`/`maxRaiseStepGen` (integer 1–3, default 1) in `DEFAULT_LEVELING_CONFIG`, validated in `routes.ts`, surfaced as "Grid step"/"Gen step" in the bell-modal limits grid (now `grid-cols-4`). Loosen grid to 3 for the old straight-to-ideal behaviour.
- **Tests:** `collector.test.ts` — grid one-step pacing (L1→L2 not L3), the loosened-cap straight raise, "both ACs don't jump to L3 in one batch" (incident regression), grid surge-learning gates the next step. The 6-level firmware regression sets `maxRaiseStepGrid: 6` to keep its straight-raise setup. **369 server tests green; server + client `tsc` clean.**

## Meter-anchored overhaul (2026-06-21 — "this is the worst version; it won't use grid headroom, it blocks my raises, and the gen keeps tripping")

Root cause across every symptom: the controller was **meter-blind** — it made raise/reduce/revert decisions from the static per-AC amp model, which is chronically wrong (live: grid over-predicts settled draw by **+8…12A**; gen under-states the changeover surge). From ~23h of logs that day: **6 gen power-collapses, 9 changeovers (each wiping the learned self-correction), 8 emergencies, 3 manual-raise reverts, a visible L3→L2 "fight loop"** where the user could not keep his own AC at L3. The fix anchors the decisions to the **real smoothed meter**; the model becomes only a per-AC ratio guess. User decisions: full overhaul, **aggressive grid raises** (meter is the safety, not a step cap), **manual level = hard pin** (revert/reduce only when the real current is near/over the breaker). All trip guards kept (leaky bucket, emergency path, power-collapse latch, gen one-step pacing).

- **Meter-anchored raise fill (the core, `computeAllocation`).** New `AllocatorInput.measuredAmps` + `meterTrusted`. When the meter is trustworthy (≥4 readings, no AC ramping, no collapse latch) and the real total is `≤ limit − margin` (`meterRoom`), the fill is anchored to the meter: **re-filling an AC back up to its CURRENT level is FREE** (its draw is already in `measured`), and a genuine raise ABOVE current must fit `measured + Σ surge ≤ bufferedLimit` (`limit − margin − raiseBuffer`; compares against the LIMIT, not `raiseBudgetAmps`, because the meter already includes non-AC load). Effect: on a cool grid night the fill seats all ACs where they actually fit (no more model-sum refusal of 3×L3 at a true 18.8A), and — because re-fill is free — it **never proactively reduces below current** when the meter has room (the fight loop is gone). When measured is over the limit, OR not trusted (mid-ramp → proactive turn-on reductions preserved), it falls back to the model fill so reductions still SIZE correctly. **Disabled during a restore** (restore feasibility is floor-based; meter re-fill would take back the room it needs).
- **Aggressive grid raises.** Grid passes `maxRaiseStep: undefined` (straight to the meter-anchored ideal in ONE batch) — the 06-19 one-step grid cap existed only because the model under-predicted with no meter anchor; the meter-anchored admission + leaky bucket are the 32A guard now. `maxRaiseStepGrid` config is no longer wired (vestigial; gen keeps `maxRaiseStepGen` 1).
- **Meter-based raise-hold release.** The provable-headroom early release also fires when `headroomStreak ≥ RAISE_STREAK && measured + nextStepSurge ≤ bufferedLimit` (real meter), not only the model `expectedAmps` term — which never fired when the model inflated `expectedAmps` above the buffer (the 3-AC late-night case). Trip-safe: on a hot night `measured > expectedAmps`, so it releases LESS often.
- **Manual level = hard pin (`onUserGenLevel`).** The increment-revert projection is now `smoothedMeasured() + marginal model step of THIS device` (the meter already reflects every other AC), not the model sum of all ACs. Reverts ONLY when the real current would breach `limit − margin`. Falls back to the model sum when `recentMeasured.length < 4` (untrusted meter — keeps the tight gen budget safe). The reduce side is hard-pinned by the meter-anchored fill itself (re-fill free ⇒ a manualTarget AC is never model-reduced while the meter has room).
- **Floors-first on a gen changeover (`startAtFloors`, fixes the trips).** First tick after a changeover **TO GEN** holds everyone at FLOORS (skips the raise fill AND warm restore); the reduce path drops L3→L1 in one batch and the meter-confirmed gate climbs back — instead of landing on the model-fitted gen ideal (L2) and surging a hot compressor into a trip. Gen-only: a gen→grid flip uses the new headroom aggressively. Wired from the one-shot `armRampOnSourceChange` (NOT `forceEvaluate`, too broad). **⚠ The one-shot trigger was insufficient — superseded 2026-06-23 by persistent enforcement, see "Persistent floor enforcement on a gen changeover" below.**
- **Learned costs persist per-source (D).** `observedRaiseCost`/`observedFanStepCost` are now `Map<PowerSource, Map<id, number>>` (`learnedCostFor(map, source)`), **no longer cleared on a changeover** (only on a config save) — with ~9 flips/day the old per-changeover clear meant the self-correction never accumulated. One source is active at a time; grid and gen stay separate so a grid surge never applies on the tighter gen budget.
- **Manual gen change wins over range re-enforcement when unmanaged (collector `stripLeveledControls`, F).** See [ac-automations.md](ac-automations.md) — the "leveling off but Abdu still dropping to L1" case.
- **Diagnostic removed:** the temporary `CO-CAPTURE` changeover-forensic logging (2026-06-19) was deleted — it confirmed the gen level-down DOES apply on the device; the problem was the TARGET (L2 not floors), now fixed by `startAtFloors`.
- **Tests:** rewrote the 3 grid one-step-pacing tests to the aggressive reality (jumps straight to ideal; meter-anchored fill self-limits near the limit instead of a step cap; learned surge caps the meter ideal) + new regressions: grid→gen drops to floors, manual grid raise not reverted with meter headroom, manual gen raise reverted when the meter would breach, learned gen surge persists across a gen→grid→gen round-trip, opted-out re-enforcement dropped after a manual gen change. **390 server tests green; server + client `tsc` clean.**

## Persistent floor enforcement on a gen changeover (2026-06-23 — "it should drop ALL ACs to min on gen, but it's not — I changed them manually")

The 2026-06-21 `startAtFloors` floored everyone on a gen changeover, but only for the **single** changeover tick (via `wasChangeover`/`forceEvaluate`). Live 7-day logs showed the floor-down **fired but didn't stick**: a gen changeover restarts the compressors and the TCL firmware comes back ABOVE the commanded floor (the documented "firmware can come back at a different level" quirk). The leveler clears its `confirmedLevel` baseline on the changeover, adopts the **stale/reset** shadow level, and then goes quiet — an above-floor reduction is gated behind `canReduce` (`forceEvaluate` only on the one changeover tick; otherwise an over-limit streak), so on calm ticks the floor is **never re-asserted**. The unit kept running high until it surged past 15A and emergency-thrashed (sheds + fan-drops). Smoking gun: a real changeover floored `Abdu 3→L1`, then ~4 min later the **user** manually set `Abdu→L1` again (the same level) — i.e. the device never actually dropped, so he forced it by hand. (Changeovers are **direct** grid↔gen flips, 0 through `none` in 7 days — the earlier "through-`none`" hypothesis was wrong.)

**Fix — re-assert + hold floors until the shadow confirms (gen-only):**
- **Persistent state** (`enforceGenFloors` + `enforceGenFloorsUntil` in `ac-leveler.ts`): armed when transitioning INTO gen (replaces the one-shot `startAtFloors` input). Stays on across ticks; `startAtFloors` is now `this.enforceGenFloors`. **⚠ Arming broadened 2026-07-10** — originally `wasChangeover && source === "gen"` (a changeover from another live source), which MISSED a `none→gen` cold start (deploy/blackout mid-gen); see "Cold-start-into-gen floors + extreme-overshoot shed" below.
- **Ungated floor-down** (`ac-leveling.ts` allocator): the above-floor reduction gate gained `|| input.startAtFloors`. When enforcing, the fill is skipped so `target` IS the floor, and the floor-down **re-sends every post-settle tick the real shadow still reads above floor** (`execute()` doesn't dedupe). `currentLevel` is the real shadow only OUTSIDE settle (in-settle it reads `lastSetLevel` and would confirm prematurely).
- **Clear condition:** every managed ON AC's real shadow is at/below `floorOf` (now exported) **AND** the compressor ramp has passed (`!anyRamping`) → "hold through the ~240s ramp, then climb when there's metered room." Also cleared by `source !== "gen"`, no managed ON ACs, the `ENFORCE_GEN_FLOORS_MAX_MS` (300s) backstop (truly-stuck device → resume normal over-limit handling), a manual gen change (`onUserGenLevel` — manual wins, AGENTS rule 7), a source change (`onPowerReading`, re-armed by tick for the gen leg), and leveler disable.
- **Grid unchanged** — `startAtFloors` is gen-only; gen→grid keeps the aggressive meter-anchored "all up, then down if needed."
- **Tests:** `ac-leveling.test.ts` "startAtFloors re-asserts floor (ungated)" (4 cases: drops without `canReduce`, no-op without the flag = today's bug, stops at floor, respects a boost floor); `collector.test.ts` "gen changeover enforces floors until confirmed" (fake-timer: re-asserts each post-settle tick while the shadow stays L3, stops once it confirms + ramp passes; manual gen change clears enforcement). **396 server tests green; server `tsc` clean.**

## Situation-awareness fixes (2026-07-06 — "understand the situations better, act faster")

Shipped together with the observed-off power-event classifier (automation side — see [ac-automations.md](ac-automations.md) Manual-off locks) and the loop watchdog (architecture.md Known Bugs, stall #2). Leveler-side changes:

- **`onPowerEvent` dep:** `AcLeveler` now notifies the collector on every source change, power-collapse latch, and ESP reading-stream gap > 20s (`ESP_GAP_EVENT_MS` — the monitor lost power = blackout). Drives the observed-off classification window + a forced live device fetch on the next leveling tick.
- **Ramp clamp (`rampMeterFits`, P4 — "Abdullah bounced L3↔L2 on every Najat cycle"):** a peer's power flip forces evaluation mid-ramp, where `meterTrusted` is false (any-AC-ramping) so the MODEL fill computes targets — its chronic error then "reduced" ACs the meter had room for, on *every* automation on/off cycle. The leveler now projects the settled total (`measured + Σ ramping ACs' remaining growth`, growth = full estimate at current level − floor draw, the same convention as the nonAcLoad ramp credit); when the projection fits `limit − margin`, the allocator skips PURE budget-driven reductions below current (`rampMeterFits` input). Cap-driven reductions (slot/manual/reachable/max), floors, never-level-0, restores-with-reduction, `startAtFloors`, and every over-limit path (bucket → synthetic streak, emergency) are unaffected — projection over the band falls back to the old model fill, preserving the near-limit turn-on instant reduce. Tests: "ramp clamp (rampMeterFits)" suite in `ac-leveling.test.ts`.
- **Shadow sanity gate (P5 — the leveler raised a physically-OFF AC after a blackout, model −9.9A):** when the meter can't carry even the FLOOR draw of the *demanding* (needDelta > 0.5) shadow-ON managed ACs (`measured + 0.5 < Σ floors`), the shadows are stale/lying (post-blackout shadows reported ON for 13 min) → the allocator input's `headroomStreak` is zeroed, freezing raises AND restores until meter and shadows converge; reductions never blocked. Satisfied rooms are excluded — an idle compressor legitimately draws below its model floor (a cap above demand is invisible). One warn per episode. Test: "shadow sanity gate" in `collector.test.ts`.
- **Meter-anchored raise-hold release (P6 — "raiseHold armed until ~29.9A is seen on a 28A limit"):** the two existing early releases both anchor on `expectedAmps`, the MODEL SUM, which the grid model inflates by +8…12A — so holds could only die by their 120/270s timeout, pacing raises far below what the meter allowed (live: 134s hold pending with 11A of real headroom; ~14 holds/12h). New release (3): `measured + pendingRemaining + nextStepSurge ≤ bufferedLimit` after a sustained headroom streak, where `pendingRemaining = max(0, pendingAmps − (measured − preMeasured))` is the part of THIS batch's raise that hasn't landed yet — `pendingAmps` is **learned-cost-sized** (max of model delta and `observedRaiseCost × steps` per raised AC), so an under-stated gen model can't release early into a still-coming surge. The hold now stores `pendingAmps` + `preMeasured`; the arm log states the real release conditions instead of an impossible model target. Test: "raise-hold meter-anchored release (P6)" in `collector.test.ts`.

## Cold-start-into-gen floors + extreme-overshoot shed (2026-07-10 — "it just reached 20A on gen and the power broke without any useful action")

Live 15A-gen breaker trip 03:54 UTC. Root cause chain, diagnosed from container logs + `power_readings`: a **deploy recreated the dashboard container while the house was on generator** (~11.8A steady). The fresh `AcLeveler` started with `lastSource = "none"`, so the first ESP reading was a **`none → gen` transition** — which the 2026-06-23 floors-first enforcement did NOT cover (it armed only on `wasChangeover`, i.e. a changeover from another LIVE source; `prevSource !== "none"`). So **Abdullah's AC was adopted at its old gen level L3 (a ~9A cap) with no floor-down**. A minute later the leveler raised Abdu L1→L2 (surge gate passed on a meter that didn't yet include Abdu's still-ramping compressor nor Abdullah's dormant L3 cap — amp-model warnings logged 19.4A of settled cap exposure on a 14.9A limit). Both compressors then pulled toward their caps: 13→~21A in <30s. The leaky bucket emptied correctly and the emergency shipped **2 level cuts (est 7.0A), 0 sheds** — but at ~40% overload the breaker's thermal curve beat the cloud→firmware→compressor-throttle latency and it tripped 24s later. A bonus bug: during the collapse the drift detector read Abdullah's stuck (dead-line) L3 shadow as a false "external gen increment → target L3".

Three fixes (the "loaded spring" fix — a gen-only dormant-cap step-down for a *satisfied* room holding a confirmed-high cap — was **deferred**, see below):

- **Fix 1 — arm gen floors-first on ANY transition into gen (`ac-leveler.ts`).** A new one-shot `armGenFloorsOnSourceChange` flag is set in `onPowerReading`'s source-change block whenever `source === "gen"` (covers `none→gen` cold start / blackout→gen, plus the existing grid→gen). It is **decoupled from `armRampOnSourceChange`**, which deliberately still excludes `"none"` (arming the compressor ramp from "none" inflates `nonAcLoad` — the 2026-06-09 decision stands; only the FLOOR arming is broadened). Consumed at the floor-arming site in `tick()` (not at the `wasChangeover` capture near the ramp re-arm, which was removed) so it **survives an emergency/stale-reading early return** and arms on the next tick. Cleared on leveler disable and on a manual gen change (`onUserGenLevel`, manual wins). Behavior on a restart mid-gen: first tick floors every above-floor AC (ungated, re-asserted until the shadow confirms); with no ramp armed the floors clear on shadow confirm (~30–60s) and the normal meter-confirmed one-step climb resumes. An AC already at floor arms + self-clears the same tick with zero commands (why most gen tests are unaffected once they model "already on gen").
- **Fix 3 — force a shed at extreme overshoot (`ac-leveling.ts`, user-approved).** New `EMERGENCY_SHED_OVERSHOOT_AMPS` (3) / `EMERGENCY_SHED_OVERSHOOT_FRACTION` (0.2). `computeEmergencyReduction` sets `requireShed = required ≥ max(3, 0.2×limit)` (**3A/~20% on the 15A gen, 6A/20% on the 30A grid** — a flat 3A would force sheds at 10% overload on grid, contradicting the 2026-06-18 "a level-down beats a premature shed" rule). `selectReduction` gains a `requireShed` option: a covering plan that sheds NOTHING is treated as INFEASIBLE, so the lexicographic search escalates to the least-disruptive plan with ≥1 AC OFF (most-*satisfied* room first via the existing `shedNeed` ordering). Rationale: a compressor OFF removes its draw with certainty and near-instantly; a level cut only lowers a firmware cap the compressor throttles down to over seconds — too slow at 40% overload. The normal over-budget path (`fromFloor`) never passes `requireShed`; every invariant (never-level-0, manual-off pre-filter, anti-stacking discount) is preserved.
- **Fix 4 — no manual-intent minting while a power collapse is latched (`ac-leveler.ts`).** In the shadow-drift loop, when `this.powerCollapse != null` the observation is re-adopted as `confirmedLevel` and the loop `continue`s — NO `manualCap`/`manualTarget` stamping (mirrors the obs-0 branch). `pendingLevel` is **kept** so a command that lands after recovery still confirms with no intent. Fixes the false "target L3" minted from a dead device's stuck shadow mid-trip. The real trigger is a **post-restart shadow jump**: the emergency confirmed low levels (so `pendingLevel` was already cleared), the breaker tripped, and the compressors restarted at their higher firmware defaults → `obs > confirmedLevel` → a bogus "external increment". Because the false mint happens *after* `pendingLevel` is gone, a `pendingLevel`-gated narrowing would miss it — the suppression must be broad (all managed devices while latched).
  - **Known limit (accepted tradeoff, flagged in review):** the collapse latch also fires on a **leveler-induced** big shed that lands the meter ≤ `POWER_COLLAPSE_FLOOR_AMPS` (5A) — documented as benign under "Anti-cycle + trip-guard hardening". In that sub-case the *surviving* AC(s) are still live, so a genuine **manual** gen-level change on a survivor during the ≤5-min latch is silently dropped (re-adopted as the new baseline, so it isn't re-detected after the latch clears) — a narrow violation of "manual wins" (AGENTS rule 7). It is NOT a breaker-safety issue (the allocator keeps pursuing the budget-fit target). A precise fix needs a dead-vs-alive-AC discriminator that isn't derivable from the single total-current meter, so it's left as-is; revisit if the leveler ever gains per-AC current sensing.
- **DEFERRED — gen dormant-cap step-down ("loaded spring").** The meter-anchored fill (2026-06-21) makes "keep at current level" FREE while the meter has room, so a *satisfied* (cooled) room can hold a high unexercised gen cap (e.g. L3 ≈ 9A) whose compressor may exercise it the moment demand returns, surging past the limit before anything reacts. Sketch (gen-only): a one-term change in the reduce-ship gate (`ac-leveling.ts` `desiredLevels` loop) — a satisfied room (`needDelta ≤ nearTargetBandC`, no manual pin) steps its unexercised cap down to its need cap even without an over-limit streak (like `startAtFloors`); grid untouched; demanding rooms keep the free re-fill. **Not built in v1** (user chose "ship the rest first"); revisit after observing the shipped fixes live. → **BUILT IN v2 on 2026-07-28** as `server/src/leveling/demote.ts` (`planIdleDemotes`), with a dwell + hysteresis dead zone and on BOTH sources — see "2026-07-28 evening — the budget hog" in the v2 section. Note: in THIS incident Abdullah was demanding, so Fix 1 (not this) is the incident fix — the spring fix closes the adjacent class.
- **Tests:** `collector.test.ts` "cold start into gen enforces floors" (fake-timer: floors an L3 AC on the first none→gen tick, re-asserts until confirm, resumes the climb; arms+self-clears at floor) + emergency-describe "cold start … does not lose the floor arming" (emergency early-return keeps the arm); `ac-leveling.test.ts` `computeEmergencyReduction` extreme-overshoot forces a shed / stays cuts-only below threshold / threshold scales 20% on grid; `collector.test.ts` power-collapse "does not mint a manual intent from a stuck shadow while latched, resumes after recovery". Existing steady-state gen tests were pre-seated onto gen (`primeGenSource` pokes `lastSource`, so their first reading isn't a cold start) and the two emergency meter-sizing tests were moved to grid (same amp model, +15A into `nonAcLoad`) to stay below the 6A grid shed threshold. **464 server tests green; server `tsc` clean.**

## Turn-on ramp window (`AC_RAMP_MS` 240s)

- `AC_RAMP_MS` = **240s** since 2026-06-09 (history: 30s at build → 90s on 2026-06-07 → 240s). The user measured the compressor needs ~4 min to reach steady-state draw; real compressors take 30–120s+ and a half-ramped AC reading as headroom caused raise → over-limit → reduce flapping.
- **Ramping ACs get FLOOR credit in `nonAcLoad` (2026-06-11):** while an AC is ramping, `establishedDraw` counts it at its **floor draw** (`min(floor, currentLevel)` when currentLevel ≥ 1, the floor for level 0) instead of its full estimate — and instead of the pre-2026-06-11 ZERO credit, which inflated `nonAcLoad` by each ramping AC's whole real draw for 240s after every turn-on/changeover (live: phantom 4.4A budgets froze Abdu's shed restore for ~20 min and triggered spurious all-fans-to-1 drops right after power-on flips). A freshly started compressor pulls roughly its floor draw within seconds, so the credit is still conservative (the gap between floor and full estimate keeps double-counting in the safe direction); the full estimate counts once the ramp expires.
- **Near-limit turn-on acts instantly** (user request 2026-06-06 PM): combined with the power-flip `forceEvaluate`, a freshly-ON AC near the limit makes the leveler reduce other ACs immediately, zero over-limit readings needed. The "within ~2A" trigger condition emerges naturally from the budget math (margin + the new AC's floor draw); raising `marginAmps` makes it more aggressive.
- Ramp set on: observed OFF→ON flip, UI power-on, leveler restore, **and a true Gen↔Grid changeover** (2026-06-09 — a source flip restarts every running compressor). Implementation: `armRampOnSourceChange` flag set in `onPowerReading` only when `prevSource !== "none" && source !== "none"` (capture `prevSource` BEFORE reassigning `lastSource`); consumed in `tick()` to re-arm `rampUntil = now + AC_RAMP_MS` for ON managed ACs. **NOT armed coming back from "none"/blackout** (ESP/power resuming — the ACs were already running steadily; arming there inflates nonAcLoad and broke every test's budget math — this was the bug that caused 22 test failures on the first run of the 2026-06-09 change). Cleared on power-off.

## Predictive control (2026-06-07)

Triggered by user notes: Abdullah's boost shed Najat then sat at L3 while she stayed off; the leveler "acted blindly" (no expected-amps concept); command effects lag (compressor ramp, level-change seconds) causing fluctuation. After any command batch the leveler records what it expects:

1. **nonAcLoad freeze** (`NON_AC_FREEZE_MS` 15s): fresh `measured − establishedDraw` derivations right after a command are contaminated — measured still shows pre-command draw while the snapshot levels are already lowered (via `lastSetLevel` during settle) → overstated nonAcLoad → over-reduction spiral. The nonAcLoad value the batch was computed with is reused for 15s. The freeze deliberately **survives `forceEvaluate`** (it's the *less* contaminated input for proactive turn-on reductions); cleared on source change / source "none" / leveler disable. A real non-AC load rise is still caught by the raw over-limit streak with ≤15s extra latency.
2. **Expectation grading:** every batch records `expected = {amps: nonAcLoad + Σ estimates at commanded levels, raisedAmps, compareAfter: max(settle end, rampUntil of every counted AC)}`. Once due (+ ≥4 fresh readings), the median measured is compared vs expected → `lastPrediction` in status; pino warn when |error| > `PREDICTION_WARN_AMPS` (2A) suggesting calibration. **No auto-adaptation of the amp model** — it stays deterministic by design.

(Items 3 and 4 — the raise hold and bounce detection — have their own sections below.)

## Effect-confirmation raise hold (2026-06-07 evening; fan part superseded 2026-06-10)

Replaced the earlier 60s grading-time miss-hold. User request, refined the same day: "either see the expected effect on the whole amp draw, or wait — 2 min for fan and level change, 3 min for AC turn on — before doing the next raise." **The fan part was superseded 2026-06-10**: fan-only batches no longer arm the hold at all (fans are ~0.5A and settle in seconds — the user re-decided after watching fan restores crawl).

**Why:** a gen level is a **CAP, not a draw command** — a satisfied room's compressor won't draw more when the cap rises, so without confirmation the "headroom" after a raise is phantom and stacked raises overshoot when compressors kick in.

- Every LEVEL raise batch arms a hold at command time in `execute()`: `RAISE_HOLD_MS` **120s** for level raises (a cap raise on an already-running compressor settles fast — deliberately kept at 120s on 2026-06-09), `RESTORE_HOLD_MS` **270s** when the batch turns an AC on (raised 180→270s on 2026-06-09 to cover the measured ~4-min compressor ramp + meter slack; kept ≥ `AC_RAMP_MS` 240s so the hold can't expire mid-ramp).
- The next raise happens only when the batch's expected amps actually arrive on the meter — **early release**: `measured ≥ expectedAmps − max(1A, raisedAmps/2)`, checked per tick but only after `RAISE_HOLD_CHECK_AFTER_MS` **20s** so the 4-reading median window is post-command — or the hold times out.
- **Provable-headroom early release (2026-06-18 — "raising too conservative since the one-step update"):** the hold ALSO releases when `headroomStreak ≥ RAISE_STREAK` AND `expectedAmps + nextStepSurge ≤ limit − margin − raiseBuffer` (`nextStepSurge` = the largest learned/model step among ON managed ACs). Trip-safe regardless of ramp timing — even if the pending raise FULLY delivers its expected draw, one more one-step surge still fits the buffered limit. Fixes the **under-delivery trap**: an over-predicted raise (the common case with a wrong gen model) used to sit the entire 2–3 min hold although the meter showed ample room. Emits a distinct `Provable headroom (…) — raises unlocked` log line. The tight case (expected near the budget) still waits for the meter, as before.
- `input.raiseHold` gates `canRaise` (blocks raises AND fan-raises). **Reductions are NEVER blocked.** Pure-reduction batches leave an existing hold untouched (its expectation goes stale → no early release → it expires on time — conservative).
- **Restores are NOT blindly hold-blocked (2026-06-11):** during a hold, a shed restore may still fire when `raiseHoldExpectedAmps − holdReductionSavings + floorDraw ≤ limit − margin − raiseBuffer` — the hold's own expectation is the conservative budget, and `holdReductionSavings` (Σ over ON managed ACs of `draw(current) − draw(floor)`) credits the pull-to-floor reductions the restore batch ships anyway. The fill is **skipped** for a restore-under-hold batch (everyone rides at floors that tick) so the optimistic nonAcLoad-based budget can't take those savings back. Restores still need settle. Live trigger: Abdu shed for ~20 min on 2026-06-11 — Najat's restore hold, then Abdullah's L3 raise hold, kept `canRaise` false while Abdu's floor-feasible restore waited.
- **Faster shed restore (`RESTORE_SHED_STREAK` 3, 2026-06-13):** restoring a fully-OFF shed AC uses a SHORTER sustained-headroom streak (3 readings ≈15s) than a level raise (`RAISE_STREAK` 6 ≈30s) — turning a room the leveler shed back on is the single highest-value raise and the user complained it lagged while budget was free. Level raises keep the full 6-reading streak.
- **Restores are exempt from the raise buffer (2026-06-18 — "there was headroom and it didn't use it"):** a restore now fits the **un-buffered** budget (`limit − margin`), not `limit − margin − raiseBuffer`. The leveler sheds at the limit but used to only restore a full buffer below it, so a shed room sat OFF in a ~1.2A deadband even though it fit and ran fine (live: Abdu shed at 15A, stable at 14.5A once the user manually turned him back on, but the auto-restore wouldn't fire — `raiseBuffer 1` + `margin 0.2` blocked it by ~0.7A). A whole room being off is worse than riding near the limit; the **restore-bounce guard** (`restoreBlocked` after a restore → over-limit → re-shed) is the oscillation safety net, not a static deadband. **Level raises still honor the buffer** (their limit cycle is what it was built for), and the restore-DURING-a-hold feasibility check stays buffer-conservative (a pending raise's effect is still uncertain).
- **Restore-priority (2026-06-11):** while a floor-feasible restore is merely *gated* (settle/streak/hold-expectation), ordinary raises AND warm-start raises are parked (`restoreWaiting` guard) — they would consume the restore's headroom and arm fresh holds ("all ACs on beats higher levels"). A floor-INFEASIBLE restore parks nothing (raises don't change floors-based feasibility — other ACs must not starve at their floors).
- **Fan-only batches arm NO hold and use the short `FAN_SETTLE_MS` 10s settle** (2026-06-10 — they used to arm the hold and the full 30s settle, pacing fan restores at ~35s/step and blocking level raises meanwhile).
- Cleared on source change / "none" / disable. Status exposes `raiseHoldRemainingMs`; UI shows an amber "raise hold Xs" hint.
- Net behavior: delivering raises release in ~20–25s (≈ the old settle pacing); under-delivering ones with provable headroom now also release in ~20–30s (2026-06-18, above) — only a raise whose expectation sits *near* the budget waits the full hold.

## Bounce detection (2026-06-07 evening)

Triggered by live flapping ("the Abdu bounce"): leveler raised Abdu on headroom → the real step exceeded the gen amp estimate → over-limit → reduced back → headroom rebuilt in ~30s → raised Abdu again, every ~2 min. The raise hold didn't help — the amps DID arrive (hold released early), they were just too many.

- Every raise/restore batch records `lastRaiseBatch = {windowUntil, preMeasured (smoothed measured at command time), raised{id→level}, restored ids}`. Since 2026-06-08 `windowUntil = now + max(holdMs, BOUNCE_WINDOW_MS 5min)` — decoupled from and ≥ the raise hold, because a slow limit cycle over-limits/reduces minutes after the raise (period > the 120s hold) and that reduce is still the raise's fault.
- A **reactive** (over-limit-streak) reduction that undoes one of those raises inside the window records a **bounce** in the in-memory `bounce` map (in-memory = lost on restart, accepted like manual gen intents):
  - **Level kind** → `bounceCap` at the reduced-to level: an extra `Math.min` term in `ceilOf`/`softCeilOf` — caps `manualTarget` raises too, never lowers hard boost floors, never forces reductions. **Model-tolerance gate (`BOUNCE_MODEL_TOLERANCE_AMPS` 1A, 2026-06-13):** the sticky cap is recorded ONLY when the raise's observed cost (`smoothedMeasured − preMeasured`) overshot the amp-model anchor by more than 1A — a wrong model. An *accurate* model that still tipped over (`observed ≈ anchor`) was raised into a thin budget (a transient nonAcLoad misread), not a bad model; the reduction still ships (safety) but no cap is set, and the normal raise gate re-times the raise — fixing the live 7–61 min L1 strands where the logged `observed cost` equalled the model prediction exactly.
  - **Restore kind** → `restoreBlocked`: filtered out of restore selection; the next-most-needy unblocked shed AC goes first. (User decision: restore bounces included — a restore → over-limit → re-shed power-cycles the compressor, which is worse than level flapping.)
- **Explore other options first** (user decision): the bounce cap is per-device, so the fill order naturally gives the budget to the OTHER ACs; only when every candidate is capped/satisfied does the leveler go quiet (ideal == current → zero commands).
- **Retry is evidence-based, NOT timed** (user explicitly rejected fixed-cooldown options; spec: retry when total amps drop below the state it bounced at): `requiredAmps = clamp(peakMeasured − preMeasured, estStep, estStep + BOUNCE_MAX_EXTRA_AMPS 3A)` is the raise's OBSERVED cost. The record clears when `smoothedMeasured + requiredAmps ≤ limit − margin − raiseBuffer` (tightened by the raise buffer 2026-06-08 so a cleared bounce can't immediately re-bounce; checked per tick, skipped during settle).
- **Structural clears:** device power cycle (**level kind only** — the restore kind must survive the power-off cleanup loop that runs every tick on off devices), user power on/off, manual gen change, source change, config save, plus a `BOUNCE_SAFETY_EXPIRY_MS` **60-min** safety net against corrupted baselines. Bounce also clears on ANY source change (per-source physics — independent of the 2026-06-09 cap-release-onto-Grid rule).
- Status: per-AC `bounceCap` / `bounceRetryBelowAmps` / `restoreBlocked`; orange "bounce L{n}" / "restore wait" badges in the leveling UI.

### Restore-bounce surge allowance (2026-07-24 — "the fresh air keeps opening and closing on its own")

Live gen symptom: **Najat power-cycled** on the 15A gen — the leveler restored her, she surged back over the limit within a few minutes, it re-shed her, and repeated 2–3 times before the sticky restore block finally engaged. What the owner *saw* was the unit's flap opening and closing "on its own" (mom's "fresh air") — the server issued **zero** `set_fresh_air` commands in 8h; it was the compressor/louver cycling with the shed/restore power-cycle. Diagnosed from the live logs (`restore bounced — re-shed (observed cost 3.1A …)` then `bounce restore block cleared` ~23 min later) + `/api/ac/leveling`.

Root cause: a **restore** bounce was sized like a level bounce, and both under-state a restore's real cost. A restore re-admits a fully-OFF room, so its true landed draw is the whole compressor ramp from a dead stop **plus** the range automation's smart-auto fan spin-up (a hot room jumps the fan to 3–7 the instant it returns — fans are NOT in the amp model). Meanwhile `peakMeasured = smoothedMeasured()` medians away the very surge peak that tripped the shed, and the pre-restore baseline already carries the other rooms — so the raw incremental `observed` read far too small (3.1A live), the retry-clear threshold (`smoothed + requiredAmps ≤ limit − margin − raiseBuffer`) sat too high, and the momentary post-shed load drop re-admitted her → re-surge → re-shed.

Fix (`recordBounce`, **restore kind only** — level bounces byte-identical): take `observed` from the **PEAK of `recentMeasured`** (not the smoothed median), reserve at least `anchorAmps + BOUNCE_RESTORE_SURGE_ALLOWANCE` (**4A**, the un-modeled fan/ramp surge), and cap wider at `anchorAmps + BOUNCE_RESTORE_MAX_EXTRA_AMPS` (**7A** vs the level path's 3A). So a restore-bounced room now stays shed until the load has **genuinely** dropped enough to fit its full restore draw — no rapid restore→surge→shed. Self-clears as before (sustained headroom, source change/grid return, `BOUNCE_SAFETY_EXPIRY_MS` 60-min). **The 4A allowance is a tuning knob** — raise it if a room still bounces once, lower it if a room strands off too long; erring toward "stays shed" was the owner's explicit ask. Tests: `collector.test.ts` "bounce detection" restore-bounce (expected `bounceRetryBelowAmps` 7→6) + new "keeps a restore-bounced AC shed on a load the raw incremental cost would re-admit (fan/ramp surge allowance)". **634 server tests green; server `tsc` clean.** Deployed 2026-07-24; dormant until the next gen session (grid has no capacity pressure). Note: v2 (in shadow) addresses the same class with evidence-based restore backoff + 5-min restore calm.

**Same-session Abdu shed diagnosis** (user: "it turned off abdu ac while abdulla's on L2, outdoor 36"): was diagnosed NOT-a-bug at the time — gen at 15A with ~10A non-AC load fits only one AC; Abdullah is priority #1 (shed-protected) and Abdu had the smallest needDelta → shed per design. **This priority-protects-a-cool-room-over-a-hot-one behavior was later (2026-06-13) judged the actual complaint and fixed** by the need-based `shedNeed` term in the cost-aware optimizer (see "Cost-aware reduction optimizer"): a shed now sacrifices the most *satisfied* rooms, so a hot Abdu is kept while cooler rooms (even the top-priority one) shed. The same session also asked that the **boost release at exactly threshold−1** (was strictly-below: 36.0° kept a 37° boost alive) — `minLevelFor` now releases at `≤ outdoorAtLeastC − 1`. The gen amp models were off by 2–4A in the logs (prediction warnings) — calibration on generator was recommended to the user.

## Fan reduction before shed & fan holds (2026-06-06 eve; restore re-decided 2026-06-10)

When floors exceed budget, the leveler first drops every **reducible** managed ON AC's fan to level 1 (the AC's built-in auto fan 0 **counts as reducible**, but the leveler never *sets* built-in auto; gen levels floor in the same batch), records a **fan hold** (persisted in `ac_leveling_fan_hold` — `original_fan`/`last_set_fan`; survives restarts because a restart mid-hold would otherwise strand automation-less ACs invisibly stuck at silent fan 1), resets both streaks, and only sheds if a **fresh** over-limit window builds with no fans left to reduce. (Originally a 4-reading window; now the asymmetric 5/2 gate.)

- **Restore order on headroom:** shed AC first → held fans **back toward the original fan, one AC per gated action** (highest-priority hold first) → gen raises (suppressed while any fan hold is pending; rationale: "a fan step costs fewer amps than a gen step"). The one-step-per-~35s staging (2026-06-06) was superseded 2026-06-10 (jump straight to original) after live logs showed Najat's fan taking 3.5 min and Abdu waiting 8.5 min at silent fan 1.
- **Sweet-spot fan control (restore 2026-06-18; reduction 2026-07-16 — "it keeps bouncing 1↔full, can't find the sweet spot"):** the jump-straight-to-original restore **bounced** when there wasn't room for the FULL fan — fans aren't in the amp model, so the restore was sized by a flat `FAN_REDUCE_SAVINGS_AMPS` (0.5A) guess; the real fan swing is different, so the full jump re-pushed the meter over → drop to 1 → the freed amps looked like headroom again → full jump → repeat. The 2026-06-18 restore side learned a **per-AC per-step cost** (`observedFanStepCost`, per-source EWMA from clean fan-only restore batches) and climbs only to the highest level that fits. The remaining live mismatch surfaced 2026-07-16: the emergency reduction optimizer ignored that learned cost and still modeled each whole fan as one binary 0.5A cut, so a 0.7–0.9A overload dropped two fans 7→1 before the restore side returned them to full. Emergency reduction now enumerates numeric fan targets and uses the same learned step cost to choose the smallest covering cut (for example 7→4); the hold persists with that intermediate `last_set_fan`, and later headroom can restore it normally. **Built-in `auto` can't be subdivided**; no learned cost keeps the historical full-drop fallback. Allocator input `fanStepCost`; tests cover pure target selection and stateful command/hold wiring.
- **Confirmation-gated release + confirm-or-resend (2026-06-10, mirrors the gen-level drift design):** the in-memory hold now tracks `confirmedFan` — the fan the shadow has actually been OBSERVED at. A shadow still showing the PRE-command fan is a lagging/firmware-ignored command (Najat routinely needs commands re-done — live 2026-06-09 the old detector misread it as "external fan change", released the hold and exempted her every episode); the leveler re-sends the fan command up to `FAN_RESEND_MAX` 2 times, `FAN_RESEND_SPACING_MS` 15s apart, then leaves the hold in place. Only an observed move to a fan we never commanded releases the hold. After a restart `confirmedFan` is null and the first observation re-adopts the baseline (a release then needs a subsequent change — DB table unchanged). Accepted miss: a remote change back to exactly the pre-command fan is invisible; UI changes still release instantly via `onUserFanChange`.
- **Manual fan always wins:** a UI fan change (`noteUserAcFanChange` → `acLeveler.onUserFanChange`) or a confirmed external fan observation releases the hold and **exempts** the AC from re-reduction until the episode ends (sustained headroom) or it power-cycles. Shed/power-off/leveler-disable also release (disable restores the original fan best-effort).
- **Enforcement integration with range automations (the tricky part):** without guards, the leveler's fan commands would be misread as manual fan changes by the collector's `updateAcFanTracking` (drift vs `lastCommandedFan` after 15s), and the range automation would fight the hold every 5s tick. Three guards:
  1. `stripLeveledControls(rule, action, deviceId)` (wraps `stripGenIfLeveled`) also strips `fan_speed` + `turbo` at the turn-on site + the 3 `computeAcDiff` re-enforcement sites while `acLeveler.hasFanHold(deviceId)` is active — turbo must go too: non-Najat fan 7 == turbo, so enforcement would re-arm turbo and clobber the held fan.
  2. `updateAcFanTracking` early-returns during a hold.
  3. Every leveler fan command fires the `onLevelerFanCommand` dep → collector `refreshAcFanBaseline()` re-stamps `acFanEnforcement` baselines (`lastCommandedFan`/`lastFanCommandAt`, preserving `manual`/`slotId`) so neither the hold nor its release is misread as a manual change.
  On release, the automation legitimately re-takes fan control as a normal diff. (Automation-side details: [ac-automations.md](ac-automations.md).)
- `overBudget` (NOT `shedWanted.length`) gates restores/fan-raises — closes a forceEvaluate+headroom same-tick collision.
- No UI badge for fan holds yet — server status fields (`heldFan`+`fanOriginal`) + client types only.
- **Follow-up knob — SUBSUMED 2026-06-12:** "skip the fan attempt when the overshoot dwarfs realistic fan savings" is covered by the emergency fast-path, which combines level cuts + fan drops in one meter-sized batch (see Emergency reduction fast-path). The mild path keeps the fan-first staging above.

## Emergency shed & restore

- **Shed** (user explicitly wanted it): when floors exceed budget AND no reducible fans are left → power OFF the **least-needy AC first** (smallest needDelta; the top-priority AC is protected and sheds only as last resort). Persisted in `ac_leveling_shed` (survives restarts so a shed AC is still auto-restored after a deploy), broadcast push notification.
- **Shed ≠ manual-off.** A shed must NEVER create a manual-off lock, and no automation/timer path may auto-on a shed device — guards exist at all observed-off lock recorders + all 4 auto-on paths (metric/range/schedule/timers). Automation-driven turn-offs (range off, outside-range, turn_off_at_end, timer off) clear the shed flag; UI power-off converts shed → manual-off lock (the control route records the manual-off lock BEFORE clearing the shed, so a restore can't slip between); observed external ON clears shed after a 15s grace.
- **Restore-with-reduction** (2026-06-07, user decision: "all ACs on beats higher levels"): restore feasibility is judged at **floors**, not current levels (the old `currentOnCost` check let Abdullah sit at L3 forever while Najat stayed off). The most-needy shed AC is inserted into the ideal at its floor BEFORE the fill passes, and raised ACs are pulled down to the new fitted ideal **in the same batch** as the power-on (these reductions ride the `canRaise` gate since they only make room; level changes are sent before the power-on). Feasibility uses the buffered `raiseBudgetAmps` since 2026-06-08.
- **Boost floors stay HARD** (user choice, asked explicitly): if ON floors alone exceed budget, no restore — and a boost can still shed a least-needy AC. (User chose "keep today's behavior" for the edge where gen budget can't fit Abdullah L2 + others at L1; the restore-with-reduction fix is restore-side only.)
- Manual-off-locked shed candidates are **pre-filtered in `tick()`** (shed cleared, no pointless reductions ship for an aborted restore; the lock wins). Restores happen **one AC per tick** when headroom returns, most-needy first, at its floor level. `restoreBlocked` (bounce) entries are filtered out of selection.
- **Gotcha:** `restoreLastState` would re-apply a stale `generatorMode` on power-on — the allocator corrects level-0/below-floor immediately (ungated); the leveler's restore avoids this entirely by using `executeAcAction({power:1, generator_mode:floor})`.
- Turn-on timer presets get `generator_mode` stripped when the leveler manages the device; turn-on timers cannot override a leveler shed.

## Warm restore after a temperature cycle (2026-06-08)

User request: when an AC auto-offs below range temp, remember its stable state and bring it back fast on return, respecting compressor + leveling timing. **Scope decision (asked): temperature cycling only** — NOT time-window/schedule ends, NOT manual-off, NOT leveler sheds.

- When the range automation auto-turns-off an AC because its temperature left the comfort range (the two `shouldTurnOff` branches in `checkAcRangeAutomation`), the collector calls `acLeveler.rememberStableLevel(did)` BEFORE the off command. That snapshots the leveler's `lastSetLevel` into a `rememberedLevel` map + the `ac_leveling_remembered_level` table (persists across restarts so a deploy mid-cycle doesn't force a slow re-climb; **only levels ≥ 2 are stored** — L1 is the default restore anyway).
- On the next turn-on, the snapshot sets `warmStartLevel` and the allocator's raise branch jumps **straight to `min(target, warmStartLevel)` in one batch, skipping the 6-reading headroom streak** — gated only by `!inSettle && !raiseHold`, still budget-clamped via the fitted `target`, and still **capped AT the remembered level** (going higher needs a normal confirmed raise).
- A warm-restore raise targets a still-ramping AC → it counts as `isTurnOn` → arms the longer `RESTORE_HOLD_MS` (270s, early-released on amp arrival) — respecting compressor ramp + leveling.
- **Cleared on:** observed reaching the level — which since 2026-06-10 requires a **confirmed level ≥ 1** (`currentLevel >= 1 && min(currentLevel, maxLevel) >= remembered`; an observed `generatorMode 0` ranks as maxLevel+1 in the warm-start math and used to erase the memory ~300ms after every remember whenever the shadow lagged or never applied the level — Najat, live 2026-06-09) — manual gen change (`onUserGenLevel`), manual power-off (`onUserPowerOff`), shed (`recordShed`). It deliberately **survives the per-tick power-off cleanup** so it lasts the whole off period.
- The `currentLevel === 0` "never run unrestricted" branch still caps instantly, ungated; warm-start covers the came-back-at-a-positive-level-below-remembered case.
- **Subtlety:** the leveler must observe the OFF (a tick while the AC is off) to clear `lastSetLevel`, or the firmware's L1-on-return would read as a manual reduction — true in production (5s ticks), and the e2e test inserts an off-period tick.

## Manual gen-level intents & confirmation-gated drift detection

Detected via the UI route hook `onUserGenLevel` + shadow-drift detection in tick:

- **Reduction** → `manualCap` (the leveler never raises above it).
- **Increment within budget** → `manualTarget` (overrides the needCap; still a hard ceiling for the soft-cap pass; bounce caps can defer it).
- **Increment projecting over the limit** → **instantly reverted** (the control route responds `{reverted: true, level}`).
- **Intents cleared:** when the AC powers off, AND on a changeover **onto Grid** (2026-06-09 — Grid's 30A budget makes a gen-fitted cap obsolete; `manualCap`/`manualTarget` cleared in `onPowerReading` when the new `source === "grid"`). Caps are **KEPT on Grid→Gen** (user decision: the tight 15A gen budget may still need them).
- **Drift baselines clear on ANY source change** (2026-06-10, reversing the 2026-06-09 "keep `confirmedLevel`" call): `confirmedLevel`, `pendingLevel`, and the unreachable send counts are all cleared on every source change — a changeover restarts the compressors and the firmware can come back at a different level, so a stale cross-source baseline (or a command left in flight) let the drift detector stamp a false `manualCap`/`manualTarget`. The first post-change observation simply re-adopts the baseline.

**Confirmation-gated drift detection** (2026-06-09, fixes spurious `cap L#` badges the user never set — confirmed it was the manual `cap L#` badge, not `bounce L#`):

- **Root cause:** the old in-tick drift detector compared the observed `generatorMode` to `lastSetLevel`, which was set to the commanded level the instant `set_generator_mode` was sent. If the shadow lagged or the firmware ignored a RAISE, the next tick past the 30s settle read `observed < commanded` and stamped a **false `manualCap`** at the old level (sticky — only cleared on power-off or a user raise). The real device needs ~4 min to settle, far longer than 30s, so it misfired routinely.
- **Fix:** two new maps — `confirmedLevel` (the level the shadow has actually been OBSERVED at) + `pendingLevel` (the level last commanded; armed at every command site: execute level cmd/restore, `onUserGenLevel` reduce/revert/target). Drift now compares the observation to `confirmedLevel`, NOT to the command. Flow per ON managed AC: first observation adopts `confirmedLevel` (skipped inside settle); `obs === confirmed` → no change; when `obs` changes: if it matches `pendingLevel` → our command landed → re-confirm with no intent; else → genuine manual change → `manualCap`/`manualTarget`. `confirmedLevel` + `pendingLevel` cleared on power-off (tick block + `onUserPowerOff`).
- **Key design insight:** a command in flight does NOT change the observed level until it lands, so `obs === confirmed` covers the lagging/never-landing case — no false cap, and a never-landing command can't strand detection. This is why the final design compares to the observation rather than "suppress while pending": the first code-review draft suppressed while pending, and a reviewer flagged that a stuck pending would eat a later genuine manual change.

## Unreachable levels (2026-06-10 — "Najat never applies L6")

> **RESOLVED 2026-06-11 evening:** the root cause of every "Najat never applies L4/L5/L6" observation was **TCL removing levels 4–6 from her model** (firmware/app update; the TCL app stopped offering them too). `maxGeneratorLevel` is now **3 for all models** and a `clampGeneratorMode()` layer in tcl-cloud clamps every gen-level publish/diff to the device max — so the leveler never requests >3 and stored stale 4–6 values can't loop. The machinery below is **kept as general defense** (slow-applying levels, future removals); in production it now only ever deals with L2–L3 marks. The incident history below predates the discovery.

Live 2026-06-09 root cause of "the leveler doesn't specify a level on grid": Najat's firmware accepts `set_generator_mode=6` (cloud returns OK) but her shadow **never leaves 0** — the grid budget made her ideal L6, the ungated never-level-0 correction re-sent it every ~35s for the whole 2h grid window, and her level effectively stayed unset. L1–L3 confirm fine, so on the tight gen budget the problem never showed. The user also confirmed Najat generally "needs the action re-done more than once" — so the re-send count doubles as her needed command retry.

- In `execute()`, unconfirmed sends are counted **PER LEVEL** (`pendingSendCounts: Map<device, Map<level, count>>` — per-level so a budget/slot flutter alternating two targets can't reset the counter and evade detection; any shadow confirm clears the device's whole map); at `UNREACHABLE_LEVEL_SENDS` **3** (and level ≥ 2) the level is added to the in-memory `unreachableLevels` set, a warn is logged, and `forceEvaluate` ships the fallback on the next tick. **L1 is never marked** (a managed AC must always get SOME cap — hard rule 5).
- **Observed level 0 is NEVER a manual intent** (2026-06-10, from the live 31A grid incident): a shadow snapping to 0 is a firmware reset/non-apply — the old drift branch ranked it maxLevel+1 and stamped a manual "target L7" while Najat actually ran unrestricted at 31A (breaker tripped; the leveler stayed silent because her phantom draw inflated nonAcLoad and the mild 5-consecutive-readings gate never completed during the 29↔31A bursts). The drift loop now re-adopts the 0 baseline silently; the never-level-0 rule re-caps and the kept `pendingLevel` keeps the unreachable counting alive.
- The snapshot's `reachableCap` = highest level not marked, walking down from `maxLevel` (marks accumulate top-down via the fallback). It clamps ceilings AND floors AND `manualTarget`/`bounceCap`/warm-start in the allocator — physics beats every intent. The shed-restore level is clamped too.
- **Un-marked** when the shadow later confirms the level: `obs === pending` in the drift loop, **or (2026-06-11) `obs` equals ANY currently-marked level even after the fallback moved `pending` lower** — Najat's confirm lag outlasts the 3-send window (live: her L4 landed 6s AFTER the 3rd send marked it, and the old drift branch then stamped a false manual "target L4"). The observation is proof of reachability: the mark is deleted, the level re-adopts as `confirmedLevel` with **no manual intent**, the device's `pendingSendCounts` clear, and `forceEvaluate` lets the allocator climb back. **Cleared** by an explicit manual gen change (`onUserGenLevel` — a user probe, mirrors bounce clearing) and on restart (in-memory, accepted). **Survives** power cycles and source changes — it's a firmware property, not a budget artifact.
- **Per-mark safety expiry (2026-06-11 PM):** each mark stores `markedAt` (`Map<level, ms>`); a tick sweep drops marks older than `UNREACHABLE_SAFETY_EXPIRY_MS` **60 min** (+ `forceEvaluate`) so the level is re-probed; a genuinely dead level just re-marks after the send budget (~2 min of churn per hour). **Live trigger:** a morning shadow-stuck-at-0 episode (08:29 UTC, her firmware-reset state) minted marks L4–L6 and `reachableCap` pinned her at L3 on grid ALL DAY with ~19A of budget free ("why najat ac currently on l3 only while its on grid and there is a budget"). Marks minted while the shadow sits at 0 are unreliable, but obs-0 is also exactly the state the original L6 detection was built for — so the fix is decay, not suppression.
- **What the L3-on-grid investigation established (2026-06-11 PM, raw-shadow read via `docker exec` + a clean post-restart probe):** her `autoGeneratorMode` is **0** (the auto-gen switch is NOT hijacking manual levels); **L3 confirms in ~1s** while L6/L5/L4 each timed out a full send budget — reproduced 3× that day. But her L4 HAS confirmed before (~111s after the first send), so L4+ are **slow-applying, not strictly dead** — and the fallback's desired-shadow overwrite ships seconds after a mark, which can cancel a slow apply that was about to land. Hence `UNREACHABLE_LEVEL_SENDS` 3→4 (~140s window). Her flat calibration draw at "L4–L6" (4.0–4.45A) is NOT proof the levels are dead — a cap above current demand is invisible.
- Status exposes per-AC `unreachableLevels`; the UI shows an amber `L{n} n/a` badge.
- **Caveat (unmanaged path):** if an automation opts out of leveling (or the leveler is off) and its preset/slot sends Najat `generator_mode 6` directly, `computeAcDiff` re-sends it every 5s forever (the shadow never reports 6) — the unreachable detection only guards the leveler's own commands. The slot editor caps the picker at the device max but cannot know about firmware quirks below it.

## Per-automation opt-out

`smart_leveling BOOLEAN DEFAULT true` column on `automations` (AC rules only; checkbox in the AC trigger form).

- When **false**: the automation keeps sending `generator_mode` from its preset (or the active slot's `gen_level`, which overrides the preset — see ac-automations.md); the leveler counts the AC's draw (subtracted from budget) but never adjusts or sheds it.
- When **true** + leveler enabled: `stripGenIfLeveled()` removes `generator_mode` from turn-on profiles and all 3 `computeAcDiff` re-enforcement sites; the active slot's `gen_level` instead reaches the leveler as `slotCap` via the tick context (`LevelerDeviceContext.slotGenCap`), and a slot flip that changes the cap sets `forceEvaluate` (an over-cap AC reduces immediately).
- **Note:** the opt-out only applies while the rule is **enabled** — a disabled rule means the leveler manages the device.

## Stateful layer & API (`ac-leveler.ts`)

- Config lives in `ac_leveling_config` (single JSONB row; master `enabled` defaults **false**); shed + fan-hold rows are write-through. See [database.md](database.md) for schemas. Behavioral summary of the five tables:
  - `ac_leveling_config` — single row; new fields reach existing rows via the load/save default-merge (no migration needed).
  - `ac_leveling_shed` — leveler-powered-off ACs (NOT manual-off); survives restarts so sheds are restored after a deploy; cleared on restore, user power on/off, automation-driven off, or observed external ON (15s grace).
  - `ac_leveling_fan_hold` — persisted fan holds (`original_fan`/`last_set_fan`) so the staged restore resumes after a deploy; cleared on full restore, user/external fan change, shed, power-off, or leveler disable.
  - `ac_leveling_remembered_level` — warm-restore snapshot (levels ≥ 2 only); written by `rememberStableLevel()`; cleared on reaching the level, manual gen/power change, or shed.
  - `ac_calibration_results` — per-AC measured draw per step (upsert, latest wins); read by `GET /api/ac/calibration` which derives `suggestedFit`.
- The collector builds the tick context in `checkAcLeveling()` (runs after `checkAcTimers()`): device fetch ≤1 per 10s, need tiers, opt-outs → `acLeveler.tick()`.
- **API:** `GET/PUT /api/ac/leveling` (requireAuth) — config + live status: source, measured/limit/budget amps, streaks (incl. `severeOverLimitStreak`), `expectedAmps`, `lastPrediction`, `raiseHoldRemainingMs`, per-AC level / est draw / need tier / caps (`bounceCap`/`bounceRetryBelowAmps`/`restoreBlocked`/`slotCap`/`unreachableLevels`) / shed / `heldFan`+`fanOriginal`.
- **Tick ordering fixed 2026-06-07:** `execute()` runs BEFORE `buildStatus()`, so the status reflects the same tick's commands (settle window, fresh sheds, expectation). (Previously `buildStatus()` ran first; old tests that ticked twice still pass.)
- Leveler hooks wired from the collector/routes: `onUserGenLevel` (manual intents), `onUserFanChange` (releases fan holds), `onUserPowerOff` (clears warm restore + confirmed/pending levels), `recordShed`, `rememberStableLevel`, `hasFanHold`, plus the `onLevelerFanCommand` dep → `refreshAcFanBaseline`.

## Per-AC calibration (2026-06-07, `ac-calibration.ts` — `AcCalibrator`)

User request: "calibration buttons for grid and gen… choose one or more… test one by one and turn off the others." Same deps/tick pattern as the leveler. Measures each AC's REAL draw at every gen level (fan fixed at 3) and optionally every fan speed 1–7 (measured at max gen level, where the per-level current cap bites least). Takes ~10–18 min per AC.

- Runs on the **currently active source** only (physics — you can't choose; run once on grid and once on gen to fill both columns). Gen steps collect **12 samples vs 6 on grid** (fluctuating voltage).
- Selected ACs (one or more) are tested **one by one with every other AC turned off**; a fresh all-off **baseline** (median, fixed 10s settle) is measured before each AC; step draw = `median(samples) − baseline`.
- **Flow per AC:** prep (all off) → baseline → power-on L1/fan3 + compressor ramp → level sweep (settle + sampling per level) → fan sweep → off → next AC; finally every AC is restored to its snapshotted power/level/fan.
- **Settle timing = floor-then-plateau-with-max-cap** (2026-06-08; user decision, asked: keep the previous settle durations as the FLOOR — never sample sooner — and only extend toward a max when the draw hasn't stabilized): each settle waits at LEAST its floor (ramp `CAL_RAMP_FLOOR_MS` 90s — decoupled from `AC_RAMP_MS` on 2026-06-09 so calibration still samples at the ~90s plateau instead of waiting the live 240s ramp; level `CAL_LEVEL_SETTLE_MS` 20s; fan `CAL_FAN_SETTLE_MS` 15s), then samples as soon as the measured draw **plateaus** (last `CAL_STABLE_READINGS` 4 settle-phase readings within `CAL_STABILITY_BAND_GRID` 0.4A / `CAL_STABILITY_BAND_GEN` 0.8A), or holds out to the **max cap** (`CAL_RAMP_MAX_MS` 360s / `CAL_LEVEL_SETTLE_MAX_MS` 240s / `CAL_FAN_SETTLE_MAX_MS` 30s) if it never stabilizes. Since 2026-06-11 the plateau additionally requires the readings to **span ≥ `CAL_STABLE_SPAN_MS` 15s** (the live ESP reports every ~2.7s, not the assumed ~5s — a count-only window shrank to ~8–11s). Implemented via `armSettle(maxMs)` (sets `settleUntil = now + max`, records `settleStartedAt`, clears `settleReadings`), `settleFloorMs()`, `isSettleStable()`, and an early-release collapse at the top of `tick()`; settle-phase readings accumulate in `settleReadings` (`{amps, at}` pairs, separate from measurement `samples`).
- **Methodology guards (2026-06-11, from the poisoned Najat gen run — see the incident below):**
  - **Compressor-started gate:** ramp early-release additionally requires `median(plateau window) ≥ baseline + CAL_MIN_COMPRESSOR_AMPS` (1A) — "stable at baseline" is indistinguishable from "compressor never started" (Najat's takes ~4 min; the old release fired at 94s and recorded L1 = 0.00A). `CAL_RAMP_MAX_MS` raised 300→360s so a ~4-min starter fits under the cap; if the draw never rises by the cap, a warn logs and the ~0A row still records (the fit guard excludes it).
  - **Confirm-or-resend before sampling:** every step command (the L1 power-on, each `set_generator_mode`, each `set_fan_speed`) records a `pendingConfirm`; **samples never collect while unconfirmed** (the meter would re-measure the previous step). The observed shadow is read via `tcl.fetchDevicesLive()` throttled to `CAL_CONFIRM_FETCH_SPACING_MS` 10s (nothing else refreshes the cache during a run — leveler + automations stand down); unconfirmed after `CAL_CONFIRM_RESEND_SPACING_MS` 15s → re-send up to `CAL_CONFIRM_RESEND_MAX` 2×; still unconfirmed 15s after the last re-send → the step is **SKIPPED** (no DB row, warn) and the sweep moves on — covers Najat's never-applies levels (her L6) without recording bogus rows. A late confirm after the settle expired re-arms a fresh settle floor. The tcl-cloud `sendControlVerified` layer deliberately excludes `set_generator_mode`, so the calibrator owns these retries (same rationale as the leveler's `pendingSendCounts`).
  - **Sampling minimum duration:** the sample phase must last ≥ `CAL_SAMPLE_MIN_MS_GEN` 45s / `_GRID` 30s regardless of sample counts (same ~2.7s-cadence reason — 12 gen "samples" used to span only ~32s).
  - **Accepted risks (not guarded):** the all-off prep/baseline power-offs are not confirm-checked (a stuck-on AC would show as an anomalously high baseline in the log); the pre-fan-sweep max-level re-command is best-effort.
- Results upsert into `ac_calibration_results`; least-squares `fitAmpModel()` per device+source is returned as `suggestedFit` — **excluding** level rows with `amps < CAL_FIT_MIN_AMPS` (1A: compressor never ran / command never applied) or `stddev > CAL_FIT_MAX_STDDEV` (1A: compressor transition mid-sampling); raw rows stay visible in the table. Pure helpers: `buildCalibrationSteps`, `fitAmpModel`, `calMedian`/`calStddev`.
- **Known limits:** fan-sweep numbers are total-unit draw confounded by compressor modulation (live: Abdu fan 4 read 7.62A > his L3 6.21A measured minutes earlier) — informational only, never fed to fits. The `voltage` column records 0 on gen (the ESP has no gen-line voltage sensor). A gen level is a CAP, not a setpoint — steps where room demand < cap measure the demand at that moment (time-of-day dependent), which is why Najat's L4–L6 read a flat ~4.1–4.45A.

### Calibration incident 2026-06-11 (Najat gen fit poisoned → live flapping)

First full gen run (06:42–07:16 UTC, 33/33 steps): Abdullah (2.08/3.81/4.32A) and Abdu (4.08/5.66/6.21A) measured cleanly → gen fits 2.3+1.1 / 4.3+1.1 applied and kept. **Najat recorded L1 = 0.00A (compressor not started at the 94s release) and L2 = 1.07A ±1.68 (compressor kicked in mid-sampling)**; the fit ingested them → 0.7+0.9/level, applied 07:18 → the leveler under-credited her by 2–3A whenever ON → phantom budget → raise→bounce→reduce cycle every ~2 min riding 14.3–14.8A on the 15A gen (bounces 07:33/07:35, "observed cost 1.3–1.6A"). **Resolution:** mined 4 days of leveler logs + `power_readings` transition steps (isolated Najat-only events, medians before/after) — her real gen draw: L1 ≈ 1.2–3A, L2 ≈ 2.5–4A, L3 ≈ 2.4–5.5A demand-dependent, L4–L6 flat ~4.1–4.45A (caps above ~L3 don't bind), fresh turn-on surge 4–5.6A at any level (handled by ramp credit + restore hold, not the model). Verdict: **her old default 2A + 1A/level was right — reverted via config save**; the methodology guards above prevent a recurrence; a re-run with the fixed calibrator can recover true L1/L2 (her partial 2026-06-08 grid rows have the same disease — redo on grid someday). The suggestedFit from her existing rows now reads ~3.7+0.1 (L3–L6 only) — do NOT apply it over the mined 2+1 model.

> **Addendum 2026-06-11 evening:** her flat "L4–L6" rows were junk for a deeper reason — TCL had REMOVED those levels (the calibrator's pre-guard sends never applied; the meter re-measured the L3 state each time). The rows were deleted from `ac_calibration_results` during the 3-level migration so they can't skew a future `suggestedFit`. A re-run under binding demand (hot afternoon) is the way to learn where the NEW L1–L3 caps sit — TCL's documented mapping (30/50/70% of rated current) suggests the new L3 cap is higher than the old L3's.

> **Resolution 2026-06-12 (the re-run the addendum called for):** a methodology-guarded gen run (started 04:17 UTC, aborted "source_changed" after capturing only Najat's 3 gen levels — the user had no time to finish, so the values were mined from the partial run's DB rows + logs instead) recorded Najat's clean L1/L2/L3 = **2.13 / 4.36 / 5.66A** ("Draw stabilized after 110s" → compressor confirmed running, stddev 0.34/0.44/0.18 — all under the fit-exclusion thresholds). `fitAmpModel` → **gen 2.3 + 1.8/level**, applied live via `PUT /api/ac/leveling` (config save), superseding the conservative `2+1` mined fallback. This is the NEW binding-demand model the addendum wanted; it credits her ~1.4A more @ L2 and ~1.7A more @ L3 (safe direction on the 15A gen, the opposite of the under-credit that caused the 06-11 flapping). **Not** the `~3.7+0.1` fit the 06-11 verdict forbade — that came from the deleted poisoned rows. Grid: Najat's measured grid run (06-11: 2.25/2.43/2.80) applied as **grid 2.2 + 0.3** (matches her flat, demand-limited grid draw better than `2+1`). **Abdu & Abdullah grid stay 4+2 / 2+1 — never grid-calibrated, and grid draw is demand-driven not cap-driven** (28A budget, caps don't bind; live model error swings ±5A both ways), so no accurate linear grid model is derivable without a fresh grid run when their caps bind.
- **Suspension:** while `acCalibrator.isActive()` the collector skips ALL AC automations, AC timers (they stay pending and fire late), and the leveler tick — so calibration turn-offs never record manual-off locks.
- **Leveler handoff (2026-06-10):** the end-of-run restore (finish AND abort) fires the `onDevicesRestored(deviceIds)` dep with the ACs powered back ON → collector wires it to `AcLeveler.rearmRamp()` (rampUntil + forceEvaluate only — deliberately NOT `onUserPowerOn`, which would clear sheds/bounce). Without this the first post-calibration tick treated the freshly-restarted compressors as established draw and chased phantom headroom.
- **Aborts** (restore all ACs + keep partial results): source change, power lost, measured > limit − margin (near-limit), TCL failure, user abort endpoint, and ANY user AC control (the routes control endpoint calls `requestAbort("user_control")` — user intent wins).
- **Feed-gap pause, NOT abort (2026-06-12):** "power lost" no longer fires at 15s of ESP silence — the ESP feed routinely drops for 1.5–3 min several times a day (live 2026-06-12: two grid runs died `power_lost` at 0 steps to 50–170s hiccups while the grid was fine, looking like "nothing happened"; the stale abort note then sits on the panel until the next run). The run now **pauses** (no commands, no phase progress, no samples) while readings are stale, and aborts `power_lost` only past `CAL_POWER_GRACE_MS` **180s** (a real blackout silences the ESP far longer). On resume: same source → discard the interrupted step's samples + re-arm a fresh settle floor (pre/post-gap draw never mix; `pendingConfirm.sentAt` refreshed so the confirm flow can't instantly give up off a timer that aged while blind); different source → `source_changed` (or `power_lost` when both lines read ≤0.1A). User aborts still work mid-pause (`abortRequested` is checked first). Status exposes `powerGapSeconds`; the panel shows an amber "Power feed lost Xs ago — run paused" line.
- **API:** `GET /api/ac/calibration` (status + results + suggestedFit; polled every 3s by `useAcCalibration`), `POST /api/ac/calibration/start` `{deviceIds, includeFan}` (202/409), `POST /api/ac/calibration/abort`. The UI Apply button writes a fit into `ampModels`/`genAmpModels` via the normal leveling config save (no special endpoint).

## UI ("Smart AC Leveling" collapsible section in the bell modal, admin-only)

- Master toggle (auto-saves the full draft).
- Grid/gen/margin/raise-buffer/comfort inputs (5-col limits grid).
- Priority reorder with per-AC amp model inputs — Grid base/step pair in the device row, Gen pair in the sub-row next to the boost inputs — plus min-level boost inputs ("Min L_ when outdoor ≥ _°C") and live badges: shed / opt-out / cap / target / min, sky "slot L{n}" (range-slot cap), amber "L{n} n/a" (firmware-unreachable), need-tier dot, Δ°C readout, orange "bounce L{n}" / "restore wait".
- Source pill with measured vs limit; gating-hint microtext ("severe over-limit N/2" / "over-limit N/5", settling, amber "raise hold Xs", "expecting X.X A") and a "model check: expected → measured (Δ)" line (amber when |Δ| > 2A).
- Calibration panel at the bottom (`ac-calibration-panel.tsx` + `useAcCalibration(active)` polling 3s): AC checkboxes, fan-sweep toggle, "Calibrate on Grid/Generator" button (disabled when no source), progress (device/phase/step/samples/progress bar) with Abort, per-device results table (Grid/Gen columns, ±stddev on gen) and per-source fit with Apply.
- `useAcLeveling(active)` polls `/api/ac/leveling` every 5s only while the section is expanded.
- **Gotcha:** `seedDraft()` prefills missing config client-side (amp models by device name, gen models copied from grid, Abdullah's L2@37° boost, `raiseBufferAmps ?? 1`) but seeding does NOT mark the draft dirty — prefilled values persist only after the user saves (any edit or a master-toggle flip, which saves the whole draft).
- Component files: `client/src/components/ui/ac-leveling-section.tsx`, `client/src/components/ui/ac-calibration-panel.tsx`; types in `client/src/types/leveling.ts`.

## Constants table

| Constant / value | Value | Meaning |
|---|---|---|
| Grid limit (config `gridLimitAmps`) | 30A default | Total budget ceiling on grid |
| Gen limit (config `genLimitAmps`) | 15A default | Total budget ceiling on generator |
| `marginAmps` (config) | user-set (live ≈ 0.1A) | Safety margin under the limit; reduce side fires at the raw limit |
| `raiseBufferAmps` (config) | 1A default (0–10 validated) | Raise-side hysteresis deadband; fills/restores use `budget − buffer`; clamps negative to 0 |
| `comfortTargetC` (config) | 26°C default | Need target for ACs without an automation |
| `nearTargetBandC` (config) | 0.5°C default (0–5 validated) | Near-target band: needDelta ≤ band → hard L1 cap; above → budget decides (no mild cap) |
| `DEMOTE_HYSTERESIS_C` (v2 `demote.ts`) | 0.2°C | Demote fires at `needDelta ≤ nearTargetBandC − this`; the gap to the band is the anti-bounce dead zone (2 sensor LSBs) |
| `DEMOTE_DWELL_MS` (v2 `demote.ts`) | 120 s | How long satisfaction must hold CONTINUOUSLY before a level is reclaimed |
| `DEMOTE_RESEND_MS` (v2 `demote.ts`) | 60 s | Demote confirm-or-resend spacing — slower than `LEVEL_RESEND_SPACING_MS` so a lagging room can't rewind the shared calm clock |
| `START_WINDOW_MS` (v2 `controller.ts`) | `AC_RAMP_MS` (240 s) | Turn-on policy window, opened on BOTH sources since 2026-07-30 (was `GRID_START_MS`, grid only). Grid LIFTS to the affordable ceiling; gen CLAMPS to the floor and stands the raise phase down for that device |
| `COLLAPSE_DERATE_RECOVERY_STEP` (v2 `sensing.ts`) | 0.5A (2026-07-30) | Amps handed back per quiet `COLLAPSE_DERATE_MS` rung. Replaces a cliff expiry that restored full rating in one jump and funded the next trip 2 s later |
| `UNCONFIRMED_SEND_TTL_MS` (v2 `reconciler.ts`) | 25 min | How long an unconfirmed send keeps inflating the physics envelope (> the ≥15.8-min observed confirm lag) |
| `HOUSE_LOAD_WINDOW_MS` (v2 `house-load.ts`) | 15 min (2026-07-31) | How far back the non-AC PEAK looks. Long enough to span a compressor duty cycle, so a satisfied trough can't make the raise envelope permissive. Samples are per-source and tagged with the running-AC set |
| `FAN_DEBIT_MS` (v2 `controller.ts`) | 60 s (2026-07-31) | How long a fan RESTORE's amps stay charged as committed-but-unmetered. A gear changes almost instantly, unlike a compressor, so this only has to outlive the ESP cadence plus a tick; the absorption ratchet retires it sooner |
| `FAN_RESTORE_MAX_STEP` (v2 `fan-trim.ts`) | 2 gears (2026-07-31) | Ceiling on ONE restore step. The unbounded "sweet spot" search always reached the original — a 6-gear swing prices at only ~0.9A — which is how Abdu ran 7→5→3→1→7→1→7→4 in nine minutes |
| `FAN_RESTORE_AFTER_CUT_MS` (v2 `fan-trim.ts`) | 180 s (2026-07-31) | Quiet time owed after the last CUT before that fan may climb. `FAN_RESTORE_CALM_MS` alone never covered it: a fan-only batch does not rewind the shared calm clock, so a cut came all the way back 80 s later. Gentle-restore holds are exempt (`FanHold.fromCut`) |
| `OVER_LIMIT_MODERATE_AMPS` / `OVER_LIMIT_DRAIN_MODERATE` (v2 `sensing.ts`) | 0.5A / 2 points (2026-07-31) | Middle drain rung. The binary 3-or-1 drain stepped at a full amp over, so 15.93A on a 15A gen took five readings (**52 s**) to reach the first act |
| `OVER_LIMIT_BUDGET_AFTER_ACT` (v2 `sensing.ts`) | `OVER_LIMIT_DRAIN_SEVERE + 1` = **4** of 5 (2026-07-31) | Bucket level after an over-limit act. A FULL refill made an under-sized reduction wait out another five readings (**38 s** live). **Must stay above `OVER_LIMIT_DRAIN_SEVERE`** — shipped at 2 and double-shed within 20 minutes (see the incident section) |
| Source detection threshold | 0.1A | Line counts as active above this; larger line wins |
| `AC_RAMP_MS` | **240s** (was 30s → 90s 2026-06-07 → 240s 2026-06-09) | Turn-on/changeover compressor ramp window; ramping AC's estimate not subtracted from measured |
| `SETTLE_MS` | 30s | Post-command settle window for level/power batches; raises blocked inside it (unchanged 2026-06-09 — growing it would freeze the loop) |
| `FAN_SETTLE_MS` | **10s** (2026-06-10) | Settle window for FAN-ONLY command batches (fans stabilize in seconds) |
| `UNREACHABLE_LEVEL_SENDS` | **4** (was 3 before 2026-06-11 PM) | Unconfirmed re-sends of the same gen level before it's marked firmware-unreachable (L1 exempt) — ~140s window. Historically driven by Najat's L4–L6, which TCL turned out to have REMOVED (resolved; kept as general defense) |
| `FAN_RESEND_MAX` / `FAN_RESEND_SPACING_MS` | 2 / 15s | Bounded re-sends of an unconfirmed fan command (Najat needs commands re-done) |
| Slot gen level (`range_slots[].gen_level`) | 1–3, absent = Auto (1–6 before 2026-06-11) | Per-range-slot hard cap when leveler-managed; sent directly when unmanaged |
| `REDUCE_STREAK` | 5 readings (~25s) | Mild over-limit (< limit + 1A) reactive-reduce gate |
| `REDUCE_STREAK_SEVERE` | 2 readings | Severe over-limit (**≥ limit + 1A since 2026-06-12**, was >) → emergency fast-path |
| `OVER_LIMIT_SEVERE_AMPS` | 1A | Mild/severe boundary above the raw limit (severe at ≥) |
| `FAN_REDUCE_SAVINGS_AMPS` | 0.5A (2026-06-12) | Fallback savings per full fan-to-1 emergency cut when no learned per-step cost exists |
| `RESTORE_SHED_STREAK` | 3 readings (~15s, 2026-06-13) | Sustained-headroom streak to RESTORE a shed AC (vs `RAISE_STREAK` 6 for a level raise) |
| `DEFAULT_REDUCTION_WEIGHTS` | shed 100 / level 10 / fan 1 / needK 1.5 / topPriority 25 / bounceShed 400 | Cost-aware optimizer (`selectReduction`) objective weights (2026-06-13) |
| `BOUNCE_MODEL_TOLERANCE_AMPS` | 1A (2026-06-13) | A bounced raise caps only when observed cost overshot the model by more than this |
| `EMERGENCY_PENDING_MS` | 15s (= NON_AC_FREEZE_MS) | New severe streak within this of an emergency batch is discounted by its in-flight savings |
| Oscillation gate (grid only) | ≥3 of last 6 over limit + ≥1 severe + current over | Windowed emergency trigger for the 31A alternating pattern; overshoot = median(over readings) − limit |
| Headroom streak | 6 readings (~30s) | Consecutive headroom readings required for raises/restores |
| Headroom band | `measured ≤ limit − margin` | Un-buffered on purpose (fan restores recover on real headroom) |
| nonAcLoad smoothing | median of last 4 readings | Measured-amps input |
| `STALE_POWER_MS` | 15s | No ESP reading for 15s → source "none" |
| `POWER_COLLAPSE_DROP_AMPS` | 6A (2026-06-13) | Smoothed-measured drop (outside settle) that, landing low, latches a trip/blackout collapse → raises frozen (guard B) |
| `POWER_COLLAPSE_FLOOR_AMPS` | 5A (2026-06-13) | Collapse also requires landing ≤ this (AC load gone, not a demand drop — keeps the bounce retry-clear from false-tripping) |
| `POWER_COLLAPSE_RECOVER_GAP` | 3A (2026-06-13) | Collapse clears (+ re-arms ramp) once measured recovers to within this of the pre-collapse median |
| `POWER_COLLAPSE_MAX_MS` | 5 min (2026-06-13) | Safety cap: a collapse that never recovers stops freezing raises after this |
| `NON_AC_FREEZE_MS` | 15s | Post-command nonAcLoad freeze (anti over-reduction spiral; unchanged 2026-06-09 — reduce-path protection) |
| `PREDICTION_WARN_AMPS` | 2A | \|expected − measured\| warn threshold (suggests calibration); UI line amber |
| Expectation grading minimum | ≥4 fresh readings | Required before grading a batch |
| `RAISE_HOLD_MS` | 120s | Hold after a level/fan raise batch (kept 120s on 2026-06-09 — warm level raise settles fast) |
| `RESTORE_HOLD_MS` | **270s** (was 180s before 2026-06-09) | Hold after a batch that turns an AC on; ≥ `AC_RAMP_MS` so it can't expire mid-ramp |
| `RAISE_HOLD_CHECK_AFTER_MS` | 20s | Earliest early-release check (median window must be post-command; unchanged 2026-06-09 — fast-path floor) |
| Early-release formula | `measured ≥ expectedAmps − max(1A, raisedAmps/2)` | Releases a raise hold when the amps arrive |
| `BOUNCE_WINDOW_MS` | 5 min | Bounce attribution window: `windowUntil = now + max(holdMs, 5min)` (decoupled 2026-06-08) |
| `BOUNCE_MAX_EXTRA_AMPS` | 3A | Clamp ceiling above estStep for the observed raise cost |
| Bounce retry-clear | `smoothed + requiredAmps ≤ limit − margin − raiseBuffer` | Evidence-based retry condition (buffer-tightened 2026-06-08) |
| `BOUNCE_SAFETY_EXPIRY_MS` | 60 min | Safety net against corrupted bounce baselines |
| Boost hysteresis | 1°C | `minLevelFor()`: on at ≥ threshold, off at ≤ threshold − 1 |
| Outdoor staleness for boosts | >10 min | Boost holds last state when outdoor temp is stale |
| Device fetch cadence in `checkAcLeveling()` | ≤1 per 10s | TCL device fetch throttle for tick context |
| Shed external-ON clear grace | 15s | Observed external ON clears a shed after this grace |
| Default amp models | Abdu 4A + 2A/level; Najat & Abdullah 2A + 1A/level | Level 0 estimated as one step above max |
| Gen level ranges | 0–3 all ACs (`MAX_GENERATOR_LEVEL`; Najat was 0–6 until TCL removed 4–6 in 2026-06) | 0 = unrestricted (never left at 0 when managed) |
| Fan-savings heuristic (not implemented) | ~0.5A × reducible count | Threshold for the skip-fan-attempt follow-up knob |
| `UNREACHABLE_SAFETY_EXPIRY_MS` | **60 min** (2026-06-11 PM) | Per-mark expiry → re-probe; junk marks from a shadow-stuck-at-0 episode otherwise cap the AC until restart |
| `CAL_RAMP_FLOOR_MS` | 90s (decoupled from `AC_RAMP_MS` 2026-06-09) | Calibration ramp settle floor |
| `CAL_RAMP_MAX_MS` | **360s** (300s before 2026-06-11; 180s before 2026-06-09) | Calibration ramp settle max cap — fits a ~4-min compressor start |
| `CAL_LEVEL_SETTLE_MS` | 20s | Calibration level-step settle floor |
| `CAL_LEVEL_SETTLE_MAX_MS` | **240s** (was 120s before 2026-06-09) | Calibration level-step settle max cap |
| `CAL_FAN_SETTLE_MS` | 15s | Calibration fan-step settle floor |
| `CAL_FAN_SETTLE_MAX_MS` | 30s | Calibration fan-step settle max cap |
| `CAL_STABLE_READINGS` / `CAL_STABLE_SPAN_MS` | 4 readings / **15s span** (2026-06-11) | Plateau window for early release — span guards against the real ~2.7s ESP cadence |
| `CAL_STABILITY_BAND_GRID` / `_GEN` | 0.4A / 0.8A | Plateau band per source |
| `CAL_MIN_COMPRESSOR_AMPS` | 1A (2026-06-11) | Ramp early-release also needs draw ≥ baseline + this (compressor evidence) |
| `CAL_SAMPLE_MIN_MS_GRID` / `_GEN` | 30s / 45s (2026-06-11) | Minimum sampling duration per step regardless of counts |
| `CAL_CONFIRM_RESEND_SPACING_MS` / `_MAX` | 15s / 2 (2026-06-11) | Calibration confirm-or-resend; still unconfirmed 15s after the last re-send → step SKIPPED |
| `CAL_CONFIRM_FETCH_SPACING_MS` | 10s (2026-06-11) | Shadow refresh throttle while a calibration command is unconfirmed |
| `CAL_POWER_GRACE_MS` | **180s** (2026-06-12) | Calibration pauses through ESP feed gaps up to this long (15s–180s stale = pause); only longer gaps abort `power_lost` |
| `CAL_FIT_MIN_AMPS` / `CAL_FIT_MAX_STDDEV` | 1A / 1A (2026-06-11) | Level rows below/above these are excluded from `suggestedFit` |
| Calibration baseline settle | 10s, fixed | All-off baseline before each AC (unchanged by plateau logic) |
| Calibration samples per step | 6 grid / 12 gen | Gen needs more due to fluctuating voltage |
| Calibration fan sweep | fan 1–7 at max gen level | Cap bites least at max level; level sweep uses fan 3 |
| Calibration duration | ~10–18 min per AC | Approximate |
| UI polling | leveling 5s / calibration 3s | Only while the section is expanded |

## User decisions log (don't re-litigate)

- **2026-06-06 (build):** managed ACs always keep a cap (never level 0). One source at a time. Emergency shed explicitly allowed. Master switch defaults OFF. Manual gen change semantics (cap / target / instant revert). Per-automation `smart_leveling` opt-out default ON. Priority order: Abdullah, Mom (Najat), Abdu.
- **2026-06-06 PM:** priority = protection, delta = who gets the next amp (refinement). Multi-step raises jump straight to the fitted ideal — user rejected one-step-per-tick as too slow. Near-limit turn-on acts instantly.
- **2026-06-06 eve:** **soft need caps** (picked over grid-only / keep-as-is). **Fan reduction before shed** (user requested), with staged one-step fan restore and manual-fan-always-wins.
- **2026-06-07:** **boost floors stay HARD** (user chose "keep today's behavior"). **Restore-with-reduction = YES** — "all ACs on beats higher levels". Boost release boundary at exactly threshold − 1 (Abdu shed session). User declined priority reorder and boost-softening-before-shed.
- **2026-06-07 evening:** effect-confirmation raise hold — "either see the expected effect on the whole amp draw, or wait — 2 min for fan and level change, 3 min for AC turn on — before doing the next raise." Bounce retry is **evidence-based, NOT a timer** (user rejected fixed cooldowns; retry when total amps drop below the bounce state). Restore bounces included. Explore other ACs first when one is bounce-capped.
- **2026-06-08:** warm restore scoped to **temperature cycling only**. Calibration settle: keep existing settle durations as the floor, extend only to a max cap when unstable.
- **2026-06-08 evening (raise buffer):** "even 1 amp can help — don't make any level raise within 1A below the limit, but if it's even 0.1A below, don't make a reduction" → asymmetric hysteresis: raise buffer ~1A, reduce margin stays tiny. Do NOT bump `marginAmps`; do not edit the live saved config (default-merge delivers the field). Follow-up: "the fan speed should not be like leveling with the raising buffer" → fan restore NOT buffer-gated.
- **2026-06-09:** cap release on source change **only when moving onto Grid** (Grid→Gen keeps caps — tight 15A budget may still need them). The ~4-min compressor settle applies to **start/restart** (turn-on + Gen↔Grid changeover), NOT to warm level raises → `RAISE_HOLD_MS` stays 120s.
- **2026-06-10 (this batch):** per-range-slot gen level = **HARD CAP** (leveler never raises above, reduce/shed below allowed; slot cap beats boost floors like a manual reduction; a live `manualTarget` beats the slot cap per "manual always wins"). Fan restore = **ONE JUMP** + 10s fan-only settle + no fan raise-hold (supersedes the 2026-06-06 staged restore AND the 2026-06-07 "2 min for fan" hold — live: Najat's fan took 3.5 min, Abdu waited 8.5 min at silent fan 1). Najat L6 → **auto-detect unreachable levels + step down** (user picked over "set max 5 in config"). `confirmedLevel`/`pendingLevel` now clear on ANY source change (reverses the 2026-06-09 "keep" call — stale cross-source baselines minted false caps). Najat "needs the action re-done more than once" → confirm-or-resend for fan commands; the 3 level re-sends double as her retry.
- **2026-06-11 PM (calibration review):** user asked to review the gen calibration run + methodology/timings. Najat's fit was poisoned (compressor-not-started L1/L2) — user decision: **derive her numbers from past-days logs, not a heuristic** → log/`power_readings` mining proved the old default 2A+1A/level right; reverted via config. Full methodology fix approved (compressor gate, confirm-or-resend with step-skip, time-based windows, fit exclusion). Same session: "why najat ac currently on l3 only while its on grid and there is a budget" → unreachable marks L4–L6 from the morning shadow-stuck episode → per-mark 60-min safety expiry (decay over suppression — obs-0 is also the legit L6-detection state) + `UNREACHABLE_LEVEL_SENDS` 3→4 (her L4 applies slowly when it applies at all; the 3-send window was a coin flip against her ~111s latency).
- **2026-06-11 evening (TCL removed Najat's L4–L6):** user spotted the TCL app no longer offers levels above 3; live verification (raw shadow desired==reported==3, L4–L6 publishes accepted-but-never-applied 3×, post-guard grid calibration skipped L4–L6) confirmed a firmware-side removal, not app hiding — no bypass exists (we already publish at the IoT-shadow layer the app uses). Migration: `maxGeneratorLevel` 3 for all models + explicit `model` field (protocol forks no longer key on `=== 6`), `clampGeneratorMode()` on every publish/diff path, validations tightened to 1–3 (slot gen_level, boost minLevel, control route 0–3), `onUserGenLevel` clamps stale-client levels, stale DB data swept (presets 8/9/10 + automation 7 carried `generatorMode: 6`; junk L4–L6 calibration rows deleted). Najat's gen amp model stays the mined 2+1 (caps weren't binding at observed demand, so the removal changes no observed-draw estimates).
- **2026-06-12 (calibration feed-gap pause):** "Last run aborted (power lost)" on grid with 0 steps — root cause was NOT a power loss but chronic ESP feed dropouts (1–9 gaps >90s every day that week; the 05:57→05:59 UTC 168s gap exactly covered the second abort; grid current healthy on both sides). User decision: **pause through gaps up to 180s instead of aborting**; real blackouts still abort. Side observation: ESP `voltage` has read 0 on every reading for 7+ days (sensor likely dead — unused by `determineSource`, no action).
- **2026-06-12 (emergency reduction fast-path):** "when home current exceeds the limit (especially by >1A) act fast and smart — we have seconds before the breaker trips… and no bouncing: no extreme uncalculated reductions, smart actions based on accurate assumptions." Decisions asked and answered: **severe boundary ≥ limit+1A** (was strictly >; exactly-+1A readings — the 31A incident — were mild); **sheds stay OUT of the emergency cut batch** (levels+fans only; a power-off needs its own fresh severe streak and fires only when nothing else is reducible); **oscillation windowed gate on GRID only** (gen noise near the deliberately-ridden 15A limit would false-trigger). Sizing is meter-derived (min of severe readings + margin), smallest-sufficient-cut greedy with best-fit final step, 15s in-flight discount against stacked cuts.
- **2026-06-11 (5-issue batch, root-caused from live gen→grid logs):** **Near-target band** — "if it is near [the target] by 0.5, it should not use more than L1, above that it is ok to use any level based on budget" → configurable `nearTargetBandC` (default 0.5), replaces the mild-tier `ceil(max/2)` cap. **Fan curve stays 0.3°C/step** (user keep). **Range fan is ALWAYS smart auto unless the slot fixes 1–7** — "it should always be on A unless the user specify"; the preset fan no longer drives range enforcement (automation side: ac-automations.md). **Shed restore made fast**: floor credit for ramping ACs in nonAcLoad, restores exempt from blind raise-hold blocking (expectation + batch-savings math), restore-priority over raises/warm-starts (Abdu's 20-min shed: Najat's 270s hold + Abdullah's preempting L3 raise + ramp-inflated budgets). **Unreachable un-mark on ANY late confirm** (Najat's L4/L5/L6 false marks). **UI command verify-resend 5s × 3** — user: "find the root cause and fix, and if not able, make 5 sec for retry for 3 times"; the root cause is her firmware, so the retry layer is the fix (tcl-ac.md).
- **2026-06-13 (gen over-raise trip):** live 15A-gen breaker trip from the leveler raising Abdu L1→L2→L3 into a demand-driven compressor surge the gen amp model under-stated (logged observed L1→L2 step ~2.9A vs model 1.1A). Verified NOT caused by the same-day cost-aware optimizer (reduce-only). User chose to **fix the gen model**: gen STEP retuned to the observed surge (Abdu/Najat 2.9, Abdullah 2.0), bases kept — raises now need measured ≤ ~10.9A. Also implemented **guard B** (power-collapse raise-freeze + ramp re-arm, user-approved) so the leveler can't raise into a tripped/collapsed line. Still open: fan-restore buffer-gating, bounce-expiry re-raise. (See "Generator over-raise trip & gen-step retune".)
- **2026-07-24 (v2 cutover + restore-vs-raise fix):** live incident — after the user turned a peer AC off to free budget, the leveler raised a running AC (Abdu→L3) instead of restoring the shed hot room (Najat). User decisions: **flip the controller to v2 this session** (live, rollback = flip to v1 + restart); **restore outranks raises** — a feasible-but-gated shed restore reserves its amps and parks raises (both controllers had the bug; v2 got the durable fix, v1 left as rollback-only); **gentle gen restores** — a shed room returns with its fan pinned to 1 so its surge fits (the fan-slam was the un-modeled cost); a managed peer-off resets calm so the freed headroom is the pending restore's, not a raise's. Also: this cutover delivers the standing **"grid entry → all ACs to max, then drop"** directive (v2's GRID_FULL, absent from v1). Hygiene: debug captures (`ssh_*.txt`, `*_out.json`) are gitignored and must be cleared at session end (see CLAUDE.md). (See "2026-07-24 restore-vs-raise fix set".)
- **2026-07-30 (gen turn-on at L3 + two gen trips):** live — the user turned Najat on mid-gen-session and she came up at **L3** (the level the grid full start left her at, restored by the TCL firmware); the leveler trimmed only her and never touched Abdullah, and the house rode 16.77A until the user hand-set both rooms to L1. Decisions asked and answered: **`genLimitAmps` stays 15** — the derate tracks reality, but it now **recovers in steps** instead of cliff-expiring (the cliff handed back full rating and was re-spent 2 seconds later, and left `standing` at 0 so repeat trips could not compound); **a gen turn-on enters at its FLOOR** (the per-device form of FLOORS — picked over a gen mirror of the grid "highest level that fits"); **no forced peer floor-downs** — the reducer decides who pays, once the deficit is sized honestly (it asked for 1.2A because the projection priced the newcomer at her floor; the honest figure was 4.6A, which no single-room cut covers). (See "2026-07-30 gen turn-on at L3 + two gen trips".)
- **2026-07-31 (the trip after ten minutes of riding the limit):** user — *"it should not raise
  Abdullah AC to L3 as it is clear we don't have enough budget as we kept hitting the limit, or it
  should reduce it earlier"*, and *"when hitting a limit, we should reduce the levels, then we can
  reduce the fan speed as the last try before turning off"*. Decisions asked and answered:
  **the non-AC house term is MEASURED, not configured** — a rolling peak of `meter − Σ modeled AC
  draw`, ratcheted and per-source, chosen over a hand-tuned `nonAcReserveAmps` knob (self-calibrating,
  nothing to maintain, and it can only ever make the guard stricter); **it applies to RAISES only** —
  a shed restore stays on the AC-only envelope, because refusing one strands a room off entirely and
  the restore path already has a meter-anchored gate that includes the house by definition;
  **the fan gate is per-PLAN, not global** — "no fan while any level exists anywhere" forces a shed
  whenever levels alone fall short, which inverts the user's own ordering; **Abdullah's amp model is
  NOT corrected this session** — his configured `base 2.3 / step 2.5` says L3 = 7.3A while the
  hardware is 1-ton (≈5.3A) and the learned `level:2>3` is 1.44A over 24 samples, but fixing it makes
  the envelope more permissive at the same moment the house term makes it stricter, and two errors
  moving at once cannot be attributed. Revisit after one clean gen session.
  (See "2026-07-31 gen trip — a raise on a trough, a fan bounce, and a 90-second escalation".)

## Gotchas & test notes

- **`restoreLastState` stale gen level:** TCL last-state restore re-applies a stale `generatorMode` on power-on; the allocator corrects level-0/below-floor immediately (ungated); the leveler's own restore bypasses it via `executeAcAction({power:1, generator_mode:floor})`. Restore is skipped if a manual-off lock exists (lock wins, shed cleared).
- **Streaks are per ESP reading, not per tick.** Both streaks reset after reductions (review fix — stale pre-shed headroom could restore prematurely).
- **Control route ordering:** the manual-off lock is recorded BEFORE clearing a shed so a restore can't slip between.
- **`seedDraft()` not-dirty gotcha** (see UI section). Same applies to gen models copied from grid.
- **Test gotcha (fake timers):** leveler/calibration tests must re-feed a power reading after every `advanceTimersByTime` — the 15s `STALE_POWER_MS` check otherwise reads source "none" (calibration PAUSES on the feed gap since 2026-06-12 — it only aborts "power_lost" past the 180s `CAL_POWER_GRACE_MS`, and the resume discards the step's samples and re-arms a settle floor, so an accidental gap silently slows the step; leveler ticks return early). Predictive tests use the `genReadings()` helper; 2026-06-09 added a `gridReadings()` helper.
- **Test gotcha (gating):** a fresh power reading sets source none→gen → `forceEvaluate = true`, so the FIRST over-limit tick sheds proactively regardless of streak; collector gate tests must prime a tick first (feed 1 headroom reading + tick) to isolate the reactive streak gate.
- **Test gotcha (calibration settle):** settle-phase readings go to `settleReadings` (not `samples`), so a step needs a collapse tick then a sample tick — the test `settleStep()` helper does both; the baseline (off, 10s) is unchanged. **Since 2026-06-11 readings must be SPREAD over fake time** (`feedGenSpread()`, ~5s gaps): the plateau needs a 15s span and the sample phase a minimum duration — same-instant batches satisfy neither. The mock TCL now **applies commands to the device array** (so confirms resolve) and exposes a `firmware` quirk knob (`ignoreGenLevels` / `genLevelSendsNeeded`) for Najat-style never-applies/lagging cases; it also needs `fetchDevicesLive` (the confirm loop calls it).
- **Test harness details (`collector.test.ts`):** the `tclCloud` mock includes `getDeviceState` (returns null by default — fan tracking skips the tick); fan tests use fake timers at 07:30 Baghdad + the `acFanRule()` fixture; `createPool()` exposes the `fanHolds` map for pre-seeding `ac_leveling_fan_hold`. Mock devices without `fanSpeed` → snapshot `fanSpeed: null` → not fan-reducible (the `?? null` coercion in the leveler's snapshot builder is load-bearing for legacy leveling tests; same idea as the allocator `ac()` test helper defaulting `fanSpeed: 1`, which keeps legacy shed tests valid).
- **2026-06-09 test re-tiering:** new `collector.test.ts` describe "confirmation-gated drift + source change" (6 cases: lagging-raise-no-cap, confirm-then-user-reduce-caps, stale-high-no-target, cap-release-onto-Grid, cap-kept-onto-Gen, ramp-re-arm-on-changeover). Fake-timer literals re-tiered for the new constants: ramp test 35_000→185_000 (straddle 240s), turn-on hold 65_000→160_000 (straddle 270s), restore-bounce 91_000→241_000. `ac-calibration.test.ts` imports `CAL_RAMP_FLOOR_MS` (replacing `AC_RAMP_MS` ramp-floor refs). No raw constant assertions anywhere — all timing tests use relative `advanceTimersByTime`.
- **Test coverage map:** `ac-leveling.test.ts` (104 tests) — even-spread delta-ordered fill, min-level boosts/floors, need/manual caps, soft need caps, fan-reduce-before-shed + ONE-JUMP fan restore, reduce gates (4-reading legacy + asymmetric severe-before-mild), proactive reduce, shed-by-least-delta with top-priority protection, restore-by-most-delta, restore-with-reduction (floor-based feasibility, reductions under the raise gate, won't-fit leaves everyone untouched, one-per-call, manualTarget reduced too), raise-hold gate (blocks raises/restores, never reductions), bounce caps (ceiling in both fill passes, budget redirected, manualTarget deferred, boost floor wins, restore-blocked filter), **slot gen caps** (fill capped, beats boost floor, shed/reduce below allowed, vs bounceCap min, ≥L1, soft pass, manualTarget wins) + **reachable caps** (ceiling/manualTarget/boost-floor/warm-start clamps, ≥L1), warm restore, raise buffer suite, draw model. `collector.test.ts` — leveling integration (shed guards, generator_mode stripping, shed/restore plumbing, outdoor-boost floor correction), leveler fan holds (incl. restart-adopt-then-release), predictive control (restore-with-reduction e2e with command ordering, nonAcLoad freeze anti-spiral + expiry, expectedAmps/lastPrediction status, 240s ramp exclusion, effect-confirmation hold incl. early release + 270s turn-on hold, source-change invalidation, calibration suspension), bounce detection (cap-and-stay-quiet e2e, redirect, load-drop retry at observed cost, clears, restore-bounce block/retry, boost release at exactly threshold−1), asymmetric gating, warm restore (incl. level-0 not-"reached" regression), confirmation-gated drift + source change (incl. changeover baseline re-adopt), **unreachable levels** (Najat L6 named regression: 3 sends → mark → L5 fallback → quiet on confirm; late-confirm un-mark; survives power cycle / cleared by manual gen change), **fan confirm-or-resend** (lagging shadow kept + bounded re-sends, release only via confirm-then-diverge), **fan one-jump pacing** (10s settle, no raise hold), **calibration handoff** (rearmRamp keeps restored draw out of nonAcLoad), **per-slot gen level** (leveler hard cap, slot-flip immediate reduce, direct-send when opted out, stripped when managed), dead-zone adoption + double-off regressions. `ac-calibration.test.ts` — pure helpers + state machine (full sweep, one-by-one multi-device, aborts with restore + `onDevicesRestored` callback, partial results kept, start validation, plateau/settle gating).
- **Milestone test counts:** 2026-06-08 morning batch: 211 server tests green. Raise-buffer ship: 220. 2026-06-09 batch: 226. 2026-06-10 batch (slot gen caps + unreachable levels + fan pacing + review fixes): 258 green. 2026-06-11 batch (near-target band + restore-under-hold + floor credit + fan-0/smart-auto-default + unreachable un-mark + verify-resend): 286 green. 2026-06-11 PM batch (calibration methodology guards ×7 + unreachable safety expiry): 294 green. 2026-06-11 evening (3-level migration: clamp regressions ×4, stale-client clamp, slot boundary): 299 green, server `tsc` clean. 2026-06-12 (emergency fast-path: `computeEmergencyReduction` suite ×14 + collector "emergency reduction fast path" describe ×5 incl. the 31A oscillation regression and the urgent-tick no-explicit-call test): **317 green**, server + client `tsc` clean. 2026-06-12 PM (calibration feed-gap pause ×4: pause+resume re-settle, grace-expiry abort, source flip across a gap, user abort while paused): full suite 638 green, both `tsc` clean. 2026-06-13 (cost-aware reduction optimizer `selectReduction` + need-based shed protection + `RESTORE_SHED_STREAK` faster shed restore + bounce model-tolerance gate; new "selectReduction — the live complaint" suite ×5, two equal-need shed tests updated to the fewer-rooms-off outcome, bounce + restore-gate tests retuned to need-based semantics): **331 green** (`ac-leveling.test.ts` 135), server `tsc` clean. 2026-06-13 PM (guard B — power-collapse trip raise-freeze): +2 `collector.test.ts` cases → **333 green**, `tsc` clean.
- **Test gotcha (emergency fast-path, 2026-06-12):** collector tests MUST drive leveling through the serialized `runLevelingCheck` (the `checkAcLeveling()` test helper does) — calling the private `checkAcLeveling` directly interleaves with the urgent pass that severe readings fire via `setLatestPower`, double-shedding nondeterministically. `overLimitReadings()` feeds **15.5A** (mild) — 16A on the 15A gen limit is exactly +1A = SEVERE since the ≥ boundary change; tests that want the mild staged path must stay under +1A. The urgent pass means severe readings can act **before** any explicit check call — tests asserting "no action yet" must keep their readings mild or sub-streak.
- **Test gotcha (near-target band):** the `ac-leveling.test.ts` `input()` helper sets `nearTargetBandC: 0` so the band is a no-op for legacy tests (only delta ≤ 0 caps at L1); the dedicated "near-target band" suite passes 0.5 explicitly. `collector.test.ts`'s `LEVELING_CONFIG` omits the field → the default-merge delivers 0.5 (prod behavior).
