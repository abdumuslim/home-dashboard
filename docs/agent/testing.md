---
type: Guide
title: 'Testing'
description: 'Pure logic (allocator, auto-fan, slots, calibration helpers, alert sustain) is fully unit-tested with no I/O. Stateful integration (collector loop, leveler, calibrator) is tested against mocked TCL/DB/timers in…'
tags: [home, dashboard, claude-code, current]
maintainer: claude-code
timestamp: 2026-08-01
---

<!-- Tier-3 agent doc. Loaded on demand via CLAUDE.md / AGENTS.md routing table. -->

# Testing

**TL;DR:** Server tests use **vitest** (`server/vitest.config.ts` pins `include` to `src/**/*.test.ts`). Run with `cd server && npm test`. There is no client test suite — client is verified by type-check (`cd client && npx tsc -b`) and build. The collector and calibration suites rely on fake timers plus mock-feeding patterns that are easy to get wrong — read the harness notes below before editing those test files.

> **Why the config exists (2026-06-12 incident):** vitest's default include glob also matches the compiled `dist/*.test.js` left behind by a local `npm run build` — every suite then runs TWICE and the dist copy is frozen at build-time code. Live symptom: 20 files / 643 tests reported (real: 10 / 326), with stale logs "passing" behavior the src had already changed. If test counts ever look doubled, check for a stray `dist/` being picked up.

## Test file inventory

- `auth.test.ts` — JWT sign, verify, expiry, tamper detection (6 tests)
- `routes.test.ts` — median() utility function (5 tests)
- `agent-routes.test.ts` — Hermes bearer-token auth integration tests against a live `createRouter` (valid token accepted, missing/wrong → 401, disabled when `hermesApiToken` empty, `/api/agent/session` cookie issuance, `/api/agent/snapshot` payload, cookie login unaffected)
- `alert-metrics.test.ts` — `powerConditionSustained()`: 4-reading streak, >15s gap breaks the streak, null readings, computed `power_total`, unknown metrics
- `ac-control-audit.test.ts` — AC control attribution (2026-07-24 Najat incident): `ac_control_audit` rows carry user-vs-agent + IP, the lock-clear push fires exactly once for a burst of turn-ons, no push when the AC wasn't locked, and the 2026-08-05 race regression: the `set_power=1` handler claims the lock release BEFORE `sendControlVerified` — the test wraps the send to run the observed-ON clear mid-flight (the shadow echo of our own ON) and asserts the actor-carrying notify still fires from the route. Also the **v2 leveling config route** (same fake-pool + live `createRouter` harness): the freed-budget pricing of an off only after the cloud accepts it, the non-boolean `fundedSpend` rejection, and `describe("PUT /api/ac/leveling: the configurable over-limit budget")` (2026-09-05) asserting that an out-of-range, non-integer or explicitly null v2 field 400s **before either row is written** and that a valid save is forwarded and echoed back
- `ac-capabilities.test.ts` — per-device AC policy (guest keeps 6 levels + leveling-ineligible, the three ESP ACs ordered + eligible, fail-closed unknown ids, lowest-max across mixed automation targets, guest rejected from every leveling-owned config map, positive `powerCycleRestoreEligible` granted to guest alone — the ESP units and unknown ids are false) + shadow-derived capabilities from the sanitized live fixtures in `server/src/fixtures/ac-capability-shadows.ts`: ghost-placeholder rejection (Abdu's `softWind` is not exposed as Gentle Breeze while guest's verified unit is), same-family units keeping different feature sets, validation statuses (400 unsupported / 409 mode-unavailable), and advanced multi-property payload encoding (`buildAdvancedControlPayload`)
- `tcl-cloud.test.ts` — regression tests for the non-Najat fan_speed↔turbo coupling in `computeAcDiff`/profile payloads (the 2026-06-08 beep-loop fix), plus Guest freezing/restoring its pre-event state across a source transition (`preparePowerCycleRestore` arms the frozen snapshot; a same-event stale ON shadow does not consume it), `preparePowerCycleRestore` arming only a positively `powerCycleRestoreEligible` id (guest) while refusing the leveling line and unknown ids, `maybeRestorePowerCycleState` NOT publishing a restore a user command cancelled between the pending capture and the send (the mid-tick re-check), a pending restore being cancelled by a direct user command (`sendControlVerified`) or a verified preset (`executeAcActionVerified`) but SURVIVING background enforcement (`executeAcAction` default options), and `validateControlLive` re-auth-retrying the live shadow read once and validating against the FRESH shadow, degrading to the device's cached capabilities only when both reads throw (the stale-credential 403 that otherwise 500s every control), and failing closed with 503 for `set_self_clean=1` on that degraded path while still allowing `set_self_clean=0` (stopping a cycle) from cache
- `xiaomi-cloud.test.ts`: the purifier cloud session, born from the **2026-08-31 auth wedge** (both purifiers absent from the dashboard for 1h25m). Guards `isAuthError` matching only a dead serviceToken (`Unauthorized`, word-boundary `401`) and never a 429/403/timeout, nor a `401` sitting inside a did or a byte count (a false positive drops a healthy session and deletes the credentials file); the named wedge regression "keeps the cached purifiers and flips the status when the list 401s (2026-08-31 purifier wedge)", i.e. a 401 on `/home/device_list` must REACH the caller, flip `authStatus` to `error` and leave the cached purifiers intact, because swallowing it as `[]` is what emptied the props loop owning the only other 401 detector and erased the repair trigger; a network blip keeping BOTH the cache and the session (an empty list may only mean the cloud answered and had nothing to report, so the old "a blip resolves with []" contract was rewritten, not kept); `refreshDevices` keeping its cache on any failure, holding its 60s post-failure retry gate, and throttling even when the cache is EMPTY (the old `&& cachedDevices.length > 0` hammered hardest in exactly the wedged state); the region scan falling through to the all-region pass on a blip but aborting on the first 401, and never blanking the cache when no region answered; `init()` clearing a stale `authError` once healthy; and `ensureDeviceCachePopulated` populating before the model lookup (else a MIoT `vb2` silently receives legacy miIO commands) while refusing the command outright when that list call fails. **Harness:** the constructor does no network, so the whole seam is a plain `new XiaomiCloud(...)` whose private `client` (`miot.request` / `miot.login`), `cachedDevices`, `deviceCacheTime` and `authStatus` are overwritten through an `as unknown as CloudSeam` cast, the same private-field pattern `tcl-cloud.test.ts` uses; `invalidateAuth()`'s unlink of `/app/data/xiaomi-credentials.json` needs no stubbing (the file is absent and ENOENT is already swallowed). Mechanism and invariants: [architecture.md](architecture.md) → "Xiaomi Cloud Auth & Device List".
- `collector.test.ts` — AC manual-off lock behavior for range, stale TCL reads, schedules, and timers + dead-zone adoption/double-off regressions (adoption persists triggered status, manual fan override survives adoption, turn-off doesn't double-fire on shadow lag — the 15s `AC_OFF_REFIRE_GRACE_MS`) + Smart AC Leveling integration (shed guards, generator_mode stripping, shed/restore plumbing, outdoor-boost floor correction) + AC range fan enforcement (slot fan on turn-on/re-enforce, smart-auto resolution, manual-change detection/settle window, slot-change + power-cycle resets, UI hook) + leveler fan holds (reduce-before-shed, fresh-window shed, ONE-JUMP restore + baseline refresh, user fan change release, restart-adopt-then-release, fan_speed/turbo stripping during holds) + fan confirm-or-resend (lagging shadow kept + bounded re-sends, release only on confirm-then-diverge) + fan pacing (10s fan-only settle, no raise hold) + predictive control (restore-with-reduction e2e with command ordering, nonAcLoad freeze anti-spiral + expiry, expectedAmps/lastPrediction status, 240s ramp exclusion, effect-confirmation hold (2-min level-raise block with expiry, early release on arrival, 270s turn-on hold), source-change invalidation, calibration suspension of automations/timers/leveler) + bounce detection (cap-and-stay-quiet e2e, redirect to the other AC, load-drop retry at observed cost, power-cycle + source-change clears, restore-bounce block/retry, boost release at exactly threshold−1) + asymmetric over-limit gating (mild 16A needs 5 readings, 4 doesn't; severe 18A sheds in 2; priming a tick to consume the source-change forceEvaluate isolates the streak gate) + warm restore (temperature-cycle off records the stable level → warm-restore jumps to it skipping the headroom streak; manual off clears it; L1 not remembered; observed level 0 is NOT "reached") + confirmation-gated drift + source change (lagging raise never caps, confirmed-then-user-reduce caps, stale-high after a reduce sets no target, manual cap released onto Grid / kept onto Gen (**v1's** contract, and what this file exercises, because the acting controller in this harness is v1, see the harness note below; v2's own contract since 2026-09-05 is a release in BOTH directions, pinned in `controller.test.ts` and inventoried in the leveling bullet below), ramp re-armed on a Gen↔Grid changeover, changeover baseline re-adopt — uses the `gridReadings()` helper) + unreachable levels (Najat-L6 named regression: 3 unconfirmed sends → mark → L5 fallback → quiet on confirm; late-confirm un-mark; survives power cycle / cleared by manual gen change) + calibration handoff (rearmRamp keeps restored draw out of nonAcLoad) + per-slot gen level (leveler hard cap, slot-flip immediate reduce, direct-send when opted out, stripped when managed) + emergency fast path (urgent tick on the 2nd severe reading with no loop wait, grid-only oscillation gate, meter-sized cut despite a frozen budget that "fits", anti-stacking discount then feedback escalation to a same-batch sufficient shed, one-batch shed+fan 18A incident regression) + observed-ON lock-release push (2026-08-05: announces a remote/app/panel release; stays silent when the dashboard turn-on already claimed it) + **AC fan/swing enforcement sweep** (2026-08-06 — `checkAcRangeEnforcement`/`enforceAcFanSwing`, the tick-independent "does the shadow still carry what the active slot resolves to" pass, born from Najat sitting on device-auto 'A' after a leveler shed + restore across a grid→gen changeover): the Najat self-heal end to end, `notePowerCycle`'s release-don't-delete on the clear sites no rule owns (leveler shed edge, leveler restore, mains power event) and the baseline surviving it, a manual change AFTER the cycle still winning, the un-shed edge NOT counting as the cycle, drift re-assert + the 30 s per-device cooldown, the stand-downs (shed, fan hold, calibration, live manual override, AC off, an OFF the rule owes, stale metric), the stale-override heal through both the sweep and the ordinary diff, swing re-asserted only inside the post-power-cycle window and never over a hand aim — plus two review regressions (2026-08-06): the heal **releases** the entry rather than deleting it, so `driftedRangeFan`'s `AC_FAN_SETTLE_MS` guard still sees it (a delete re-asserted on top of our own in-flight send), and the sweep waits out the rule's own `cooldown_secs` so manual detection gets a tick — the turn-on / locked-adopt / power-event re-turn-on paths all stamp `lastToggle` and return before `updateAcFanTracking`, so without it a remote fan change inside that window was reverted within 30 s and never recorded + **per-field remote ownership after initialization** (2026-08-17): a pre-changeover manual fan cannot re-arm itself from the reboot shadow, post-initialization physical-remote mode/temperature changes win per field, a source change reclaims those fields for the system profile, `notePowerEvent` arms the previous-state restore only for a restore-eligible AC that is outside every enabled profile AND positively `powerCycleRestoreEligible` (guest yes; a rule-less leveling-eligible Abdullah no; an unknown-wiring id no; never on the boot `source none` event nor an ESP gap), and a direct app profile control claims ownership before waiting for shadow drift, and the **power-cycle stand-down** (2026-08-18 changeover regression): a swing reset arriving through the lagging shadow past the 15 s settle window but inside the 15-min `AC_POWER_CYCLE_RESET_MS` window is NOT read as a manual change — the field stays system-owned and the next diff re-asserts the slot swing (both ESP-line ACs were flagged "manual" swing within 5 s of a grid→gen changeover, twice) — while a genuine remote swing change with no recent power cycle is still marked manual (contract preserved) + **the fresh-observation `initializationPending` clear** (2026-08-18): a FRESH post-cycle shadow reporting the system fan (`lastSeenAt` strictly newer than `acPowerCycleAt`) clears the marker so a LATER remote fan change is caught as manual, while a stale cached match (or absent `lastSeenAt`) keeps the flag + **the leveler's two collector-side inputs** (2026-09-05): `describe("computeAcNeed: the range-slot key a manual pin lives under")` (rule + active slot, the first out-of-window rule owning the inactive key, an active slot with no metric value reading unknown even beside an inactive rule, null when no rule targets the device) and `describe("power events: one clock, and the per-device fingerprint the leveler needs")` (the cycle maps stamped from the timestamp the leveler passed, the beep-reset fingerprint calling `acLeveler2.onDevicePowerCycle` once per fingerprint, a house-wide power event never calling it because the controller releases its own intents there, and a v1-ACTING smoke over the new ctx field and the fingerprint hook)
- `ac-leveling.test.ts` — pure allocator: even-spread delta-ordered fill, min-level boosts/floors, need/manual caps, soft need caps (surplus budget fills mild rooms past needCap; manual intents stay hard), fan-reduce-before-shed + one-jump fan restore (priority order, straight-to-original, auto-in-one-step, gen-raise suppression), 4-reading reduce gate, proactive reduce, shed-by-least-delta with top-priority protection, restore-by-most-delta, restore-with-reduction (floor-based feasibility, reductions under the raise gate, won't-fit leaves everyone untouched, one-per-call, manualTarget reduced too), raise-hold gate (blocks raises/restores, never reductions), bounce caps (ceiling in both fill passes, budget redirected to other ACs, manualTarget deferred, boost floor wins, restore-blocked filter), slot gen caps (fill capped, beats boost floor, shed/reduce below allowed, vs bounceCap min, ≥L1, soft pass, manualTarget wins), reachable caps (ceiling/manualTarget/boost-floor/warm-start clamps, ≥L1), warm restore (jumps to remembered level skipping the headroom streak, capped at remembered, budget-clamped, deferred during settle/raise-hold, raises past it once headroom sustained), asymmetric reduce gate (severe streak triggers before the mild streak; single severe waits), draw model, emergency reduction (`computeEmergencyReduction`: smallest sufficient cut set, best-fit fan final step, never-level-0 pre-pass with single-counted credit, same-batch sufficient sheds — insufficient least-needy AC skipped, top-priority never single-picked / last resort, 18A-gen-incident regression) (130 tests)
- `ac-calibration.test.ts` — pure helpers (buildCalibrationSteps, fitAmpModel least-squares, median/stddev, gen-vs-grid sample counts) + state machine with mocked TCL and fake timers (full sweep with others-off/baseline/floor-then-plateau early release/no-sample-before-floor gating, one-by-one multi-device, source-change + user aborts with restore + `onDevicesRestored` fired with the powered-back-on ACs, partial results kept, start validation, ramp holds to the max cap when the draw never stabilizes)
- `ac-auto-fan.test.ts` — smart auto fan: delta→level boundaries (uses 1e-9 epsilon in the mapping — FP error like `1.2 − 1.0 = 0.19999…` would otherwise push exact boundaries up a level), down-hysteresis hold/drop, out-of-range previousLevel
- `automation-slots.test.ts` — slot selection (timed > all-day, overnight), overlap/threshold/fan_speed validation, gen_level validation against the per-call device maximum (0 and above-max rejected; a guest-only rule accepts L6; a mixed-model rule validates at the least-capable target's max) + the normalizeRangeSlots whitelist regression + slot-id stability (2026-09-05: provided ids are preserved, positional `slot-N` is synthesized only when one is absent, whitespace is not an id, and a second pass over its own output is a no-op, because the leveler keys a manual pin's lifetime on `<ruleId>:<slotId>`)
- `power-stats.test.ts` — pure power-source logic (`power-stats.ts`): minute classification, flicker smoothing (heal ≤2-min, keep 3-min/edge/changeover gaps), session reconstruction, current-session resolution (tail-match / fresh switch / blackout edge), Baghdad date/hour keys, 24h grid minutes, avg session length (`averageSessionHours`: complete grid/gen stretches only, ignore none + running tail + pre-window switches), weighted median, and `dayBreakdownForWindow` (partial day, midnight split, complete day). **No longer covers time-remaining prediction** — `predictRemainingMinutes` and its temp machinery were removed on 2026-08-05; see `power-predict.test.ts`
- `power-predict.test.ts` — the slot-cycle next-switch predictor (`power-predict.ts`, pure): cycle fit incl. harmonic rejection (the half-grid must not win on concentration alone), the per-slot empirical-Bayes hold model, boundary-miss grace, survival fallback (low confidence / unobserved state / blackout recovery), null under scarce data, and 3 regression cases taken from the 2026-08-05 backtest worked examples (34 tests)
- `leveling/*.test.ts` — **Leveling v2** (the acting controller). Pure modules each have their own file (`sensing`, `modes`, `raise`, `reduce`, `pacing`, `needs`, `pressure`, `fan-trim`, `costs`, `config`, `reconciler`, `house-load`, `dead-window`, `demote`, `level-hold`). Three carry the integration weight: `scenarios.test.ts` replays live incidents against the physics harness (`scenario.ts`), `controller.test.ts` covers the stateful shell (grade queue, shed-until-confirm, off-drop and ramp-honest cost learning, `batchLoadDirections`), `pipeline.test.ts` the emission-layer rules a whole-house sim can't isolate (batch dedupe, inrush blanking). Incident provenance for each block lives in [ac-leveling.md](ac-leveling.md) — the test comment names the incident, the doc explains it.
  - **R6b, the lone-raise compressor REPORT** (2026-08-06) — `controller.test.ts` only, because the whole mechanism lives in the grading shell (`pendingGrades`, the arm-time exclusions, `learnAfter`, `bornContaminated`) which `scenario.ts` does not model. Every test asserts the *report* (`reason: "compressor_report"` in the journal) and that **no** hold and no `compressorOffLikely` follow it, including the review regression *"a heater step inside the grading window must not mint a hold"* — a correctly-priced 1.5 A step plus a 3.4 A household load 90 s in. Asserting "no hold" alone would pass trivially now that nothing arms; the report is what keeps the detector guarded. Predicate, exclusions and constant relations are in `dead-window.test.ts`.
  - **Manual intent lifetime + the configurable over-limit budget** (2026-09-05): the first half is
    almost entirely `controller.test.ts`, because pin lifetime, the fingerprint flip and slot keys are
    **shell-side** and `scenario.ts` mirrors none of them (SKILL harness-debt list).
    `describe("LevelingControllerV2: manual intent lifetime")` holds: the **emitter table**
    (`describe("the emitter table")` → *"classifies every kind this controller actually emits"*, every
    real `notePowerEvent` spelling checked against `powerEventRestartsAcs` instead of importing the
    predicate twice); *"a hand-set CAP lives exactly as long as a target"* (the changeover row, the
    slot boundary, the fingerprint, the observed off); `describe("power-cycle edge")` (a release on a
    gen entry AND a grid entry journalled on the changeover's own row, the same in the other
    direction, which is the v2 contract superseding the v1 "released onto Grid, kept onto Gen"
    behaviour still exercised in `collector.test.ts` above,
    *"a boot (source none → X) and a bare meter gap release nothing"*, a pin made before
    the first reading surviving the boot event, *"stamps its own clock and releases BEFORE it calls
    out, on the timestamp it passes"*, and *"a collector that re-enters us from that callback still
    releases exactly once"*); `describe("the beep-reset fingerprint is a physical restart")` (it does
    everything the OFF→ON flip does, the first shadow after it is ADOPTED even mid-settle, the fan-0
    hold release plus its three negatives, the dashboard change landing as a CAP while the re-baseline
    is pending, and *"refactor parity: the ordinary OFF→ON flip still arms a TIMED ramp and still
    withholds the shield"*); `describe("entry policy after a release")`;
    `describe("the restart window gates the SPEND side of an observed off")` (inside, past, after a
    bare ESP gap, and *"one room's fingerprint gates that room's off only, never its neighbour's"*);
    `describe("the range-slot boundary")` (A→B, A→unknown→A, A→inactive→A once, A→inactive→B,
    boot→unknown→A, and a pin set after the boundary); and `describe("power-off paths")` (the
    observed off through the helper, the dashboard off still level-pins-only).
    Unit halves: `reconciler.test.ts` `describe("power-cycle rebase marker")` (adopt during SETTLE,
    drop only that level's send bookkeeping, one-shot, and `baselineStale` reporting the marker);
    `collector.test.ts` `describe("computeAcNeed: the range-slot key a manual pin lives under")` and
    `describe("power events: one clock, and the per-device fingerprint the leveler needs")`;
    `automation-slots.test.ts` *"preserves provided slot ids and synthesizes positional ones only when
    absent"*.
    The bucket half: `controller.test.ts`
    `describe("LevelingControllerV2: configurable over-limit budget")` (row-2 routing,
    `status.overLimitBudgetMax`, *"a PUT-driven capacity change migrates the LIVE bucket before it
    resolves"*); `sensing.test.ts` `describe("configurable bucket capacity")` (capacity 8 and 4, the
    calm refill and source-change reset to the CONFIGURED value, *"the post-act refill is 4 whatever
    the capacity: partial at 8, FULL at 4"*, `describe("applyBucketCapacity")`, and the relational
    guard *"the capacity bounds keep the post-act bucket above a single severe drain"*, which is hard
    rule 5c applied to a knob an operator can move); `config.test.ts`
    (*"overLimitBudgetPoints defaults to 5 and is clamped to whole points in 4–20"* plus
    `describe("LEVELING_V2_CONFIG_KEYS")`, whose second test asserts the key set covers every field of
    the merged config between the two rows); `pipeline.test.ts` *"reads the CONFIGURED bucket
    capacity, not a hardcoded 5"*; `ac-control-audit.test.ts`
    `describe("PUT /api/ac/leveling: the configurable over-limit budget")` (3 / 21 / 4.5 / explicit
    null rejected before EITHER write, a null `restingBufferAmps` and a non-boolean `fanTrimEnabled`
    likewise, a valid capacity forwarded with the response carrying what row 2 now holds, and a stale
    client omitting the key keeping the stored value).
  - **The 2026-09-27 bug hunt** (SKILL 77 to 82; incident detail in [ac-leveling.md](ac-leveling.md)
    → "2026-09-27: bug hunt"). **Double-shed hold (77):** `pipeline.test.ts` describe *"…and the
    holds track the CUT's landing grace, not the 30s settle mode (2026-09-26)"* (mild held at 31 s
    and 59 s, released at 61 s and at 45 s of mean-over; severe released in NORMAL but still held in
    SETTLING; *"a stale shed plus a fresh FAN TRIM that reads arriving does not hold a SEVERE
    shed"*; extreme and a runaway never held; levels and fans keep their pace; no room shed means no
    extension; FLOORS/GRID_FULL unchanged) and `scenarios.test.ts` *"ACCEPTANCE: a shed still
    landing past 30 s does not shed a second room (2026-09-26)"* (the live lagging-anchor geometry
    with a 35 s off lag). **Grid start and roomy lane (78, 79):** `grid-start.test.ts` (including a
    parity check against a verbatim copy of the pre-2026-09-27 GRID_FULL loop: when everything fits,
    commands and journal are byte-identical), `grid-lane.test.ts` (both-tests spare, every other gate
    stays, the settle-window lane flag, the candidate priced at its worst unconfirmed level),
    `pipeline.test.ts` *"G2 grid roomy lane: the situational gate (pipeline)"* and *"G1 budget-aware
    grid full start (pipeline wiring)"*. **Grid session memory (80):** `house-load.test.ts` describe
    *"houseLoadAmps — the grid session memory (2026-09-27, Stream G)"*. **Whole-house acceptance:**
    `scenarios.test.ts` describe *"ACCEPTANCE: grid entry and the grid roomy lane (2026-09-27)"*,
    incl. *"the COMMON entry: after a long generator session the first grid batch still fits"*,
    *"a remembered grid house that has since shrunk only delays the lift until fresh grid evidence
    exists"* and the noise gate *"NOISE: ±0.5A and 60 s confirm lag near the 3A bar: no overload, no
    cut/raise churn"* (no over-limit batch, no shed, the line under 30 A, every room's commanded
    level monotonic, and the lane took part). **Remote off (81, 82):** `remote-off.test.ts`
    (collector side: R2 the server-ON fast path yields to a causal report, R4 classify before the
    fan intent is cleared, R5 and item 6 the honest fan-Auto log, items 1 to 4 the publish-time ON
    reference, the persistent `restore_declined` lock, an isolated OFF without our ON's dump, and the
    restart voids), `controller.test.ts` describes *"a restore declined by hand is not re-sent
    (2026-09-27)"* and *"a human ON revokes the room's own unlanded cut credit"* (shell-only:
    `scenario.ts` does not model the device poll), `tcl-cloud.test.ts` describes *"shadow
    power-report metadata (causal: ON dump, then isolated OFF)"*, *"dashboard power command: every
    publish guarded, outcome reflects the final generation"* (RULE A: initial send, 403 retry,
    saved-state restore incl. both CHSD halves, verifier resends; RULE B: `"superseded"` vs
    `"superseded_by_user"`), *"the dashboard power command is checked AT the publish boundary"*, *"a raw power command during the dashboard command's INITIAL
    shadow read"*, *"a raw power command supersedes a pending set_power verifier"* and
    *"executeAcAction: power accepted, profile failed"*, and the route-level
    `control-superseded.test.ts` (409 for both superseded outcomes, no post-send hooks, the message
    naming Smart AC Leveling only for an ON lost to a raw OFF, and *"the caller-side handoff (round
    6)"*: a leveler OFF in the microtask gap after the send never has its shed cleared by the older
    ON's bookkeeping, which runs through `onSent`), plus `controller.test.ts` *"onUserPowerOn claims
    its state synchronously (round 6)"* (only the synchronous prefix is run, not awaited). Same day, other streams:
    `leveling/status-derate.test.ts` and `leveling/resting-buffer-config.test.ts` (the derate made
    visible), `leveling/meter-event-derate.test.ts` (meter-event handlers read the derate of the
    event's OWN source; it scripts `ingestReading` to stage a mixed-source batch),
    `automation-audit.test.ts` and `automation-rule-cache.test.ts` (automation audit and rule-cache
    invalidation, [ac-automations.md](ac-automations.md)).
  - **The gated proactive shed (the swap)** (2026-08-06) — spread over four files by what each can see. `raise.test.ts`: `swapDonorFor` gate by gate, the ALONE emission, the loud journal line, the cross-tick reservation, and the donation cooldown in **both** tiers (live-trade donor reserves; a level-funding donor is barred without reserving). `pipeline.test.ts`: the donor's `power_off` may not share a batch with an invariant correction — the scene is built so the correction's own floor-down does *not* rescue the restore, or the swap never reaches its branch. `scenarios.test.ts`: the *"2026-08-06 heater episode"* whole-house replay, **plus the same replay under ±0.5 A noise** (see the churn gate below), plus the two negatives. `controller.test.ts`: the shell-only halves — the shed row, the push, a `power_off` stamping the funding cooldown, and the **source-change clear read off `controller.swap` directly**, because every outward effect of a stale trade is masked on the far side of a changeover (a decisions-level assertion passes with the clear deleted).
- `power-stats-routes.test.ts` — HTTP shape for `GET /api/power/stats` (full payload, source "none" when latestPower null) and `GET /api/power/day-breakdown` (days+totals, all RANGE_MAP keys accepted, bogus range → 400), via the `push-routes.test.ts` fake-pool + live `createRouter` harness

## Harness notes (read before editing collector/calibration tests)

**collector.test.ts:**
- The `tclCloud` mock includes `getDeviceState` (returns null by default — fan tracking skips the tick); fan tests use fake timers at 07:30 Baghdad and the `acFanRule()` fixture.
- Predictive tests use fake timers + `genReadings()` helper — readings must be re-fed after each `advanceTimersByTime` or the 15s stale-power check reads "none". There is a `gridReadings()` helper for grid-source tests.
- `createPool()` exposes the `fanHolds` map for pre-seeding `ac_leveling_fan_hold`.
- Mock devices without `fanSpeed` → snapshot `fanSpeed: null` → not fan-reducible (the `?? null` coercion in the leveler's snapshot builder is load-bearing for legacy leveling tests; same idea as the allocator `ac()` helper defaulting `fanSpeed: 1`).
- **The ACTING leveling controller here is v1, not v2 (2026-08-05).** `createPool()` serves the config row as `{ config }` with **no `id` column**, and v2's `reloadConfig()` keys on it (`SELECT id, config … WHERE id IN (1, 2)` → `rows.find(r => Number(r.id) === 1)`), so both rows miss, `rawConfig` is `{}`, the flavor falls back to the `"v1"` default and `collector.leveling()` returns `acLeveler`. Consequence: collector-level tests of leveling integration points (e.g. `computeAcNeed`'s `getNeedOverride` read, added 2026-08-05) assert **v1's** implementation of whatever facade method they touch — where v1 and v2 diverge, the shipped path is the one NOT under test. `tsc` does catch a method missing from one side (`leveling()` returns the `AcLeveler | LevelingControllerV2` union, so a call must type-check against both); it cannot catch differing semantics, so keep the two implementations in step. This is also what the 2026-09-05 smoke test (*"smoke with v1 ACTING: the new ctx field and the fingerprint hook change nothing here"*) exists to pin: the required `slotKey` on the tick context and the `acLeveler2.onDevicePowerCycle()` call from the beep-reset site must both be harmless while v1 acts, since v1 declares its own `LevelerDeviceContext` and accepts the superset structurally.
- **Boot hold-off tests (2026-08-18)** ("AC range enforcement boot hold-off after a changeover") drive `checkAcRangeAutomation` with `computeAcDiff` mocked non-null so the send actually attempts, and set the device's `lastSeenAt` on the `getDevices` mock as the freshness proxy the hold reads (`<= cycleAt` = "not fresh yet"). Pattern: trigger a rule → `notePowerEvent("source grid → gen")` (stamps `acSourceCycleAt`) with a PRE-event `lastSeenAt` → assert `actions` is empty (held) → advance + set a post-event `lastSeenAt` (or pass the 4-min cap) → assert the diff sends. The scope test proves `"source none → grid"` and an ESP-gap event do NOT engage the hold. The sweep's swing re-assert test ("re-asserts a drifted slot swing … once the unit reports fresh") now also waits for a fresh `lastSeenAt` after the changeover before the re-assert lands.

**ac-calibration.test.ts:**
- After every `advanceTimersByTime` feed a keep-alive reading or the stale-power check aborts the run with "power_lost".
- A settle step needs the `settleStep()` helper (plateau readings collapse the window, then the measurement samples are collected).

**leveling v2 — `scenario.ts` (the physics harness behind `scenarios.test.ts`):**
- Every reading must micro-jitter (the harness adds ±0.005) — a bit-identical stream trips the
  frozen-meter detector and suspends raises, so a "steady" sim silently tests the wrong path.
- `SimAcSetup.offLagMs` (added 2026-07-28, **default 0**) models how long a compressor keeps drawing
  after a `power_off` is SENT. The sim used to switch ACs off instantly, which made the whole class
  of send-to-stop-lag incidents inexpressible — a shed's draw leaving the meter as one late cliff is
  what the collapse detector mistook for a breaker trip. Reach for it whenever the bug involves the
  gap between "we commanded it" and "the meter shows it".
- The physics constrain what you can stage. With real 2-ton/1-ton caps, *floors always fit* under the
  15A gen, so an organic double-shed cannot be produced by load alone — use `minLevel` (the real
  outdoor-heat boost floor) to make level cuts unavailable and force shedding as the only cover.
- `ATTEMPT_BLAME_WINDOW_MS` (300s) is longer than a raise's learn window, so a raise that bounces is
  always cut on its own device ("its own turn-on caused this"). Don't try to stage a *peer* being
  reduced inside a raise's grade window — test that logic through the pure
  `batchLoadDirections()` unit instead.
- **The harness must MEASURE what the shell measures — never be handed the sim's ground truth.**
  `Scenario.nonAcAmps` is the simulated *physical* house load; the planner gets
  `houseLoadAmps(this.houseLoad, …)`, sampled off the simulated meter exactly the way
  `controller.tick()` samples off the real one. Passing `this.nonAcAmps` straight through would be the
  2026-07-30 mirror bug again in a new place: the harness would price a house the shell cannot see, so
  no harness test could ever disagree with the shell. Same rule for the fan debit, calm-on-fan-restore
  and the partial bucket refill — all four were mirrored on 2026-07-31.
- **`scenarios.test.ts`'s `cfg` is NOT the live config** (its models are gentler and its limit is
  14.9). A scenario written by copying live *levels* can therefore leave real headroom the live house
  did not have, and the test then passes for the wrong reason. Check the arithmetic: sum
  `nonAcAmps` + the sim `capAmps` at the levels you set, and confirm it actually reproduces the
  pressure the incident had. The first draft of the 2026-07-31 regression sat at 11.8A on a 14.9A
  limit — comfortably affordable — and "proved" a raise was refused when nothing was refusing it.

- **The noise acceptance test is the churn gate for every new spend/trade path (2026-08-01).**
  "quiet at the resting point (±0.5A noise → ZERO commands for 30 minutes)" caught both load-bearing
  guards of the comparative-need rebalance before shipping: a deficit judged on a single noisy
  reading armed a trade on every dip, and the freed amps then fit the DONOR's cheaper re-raise but
  not the receiver's step — a 35s donor↔receiver limit cycle, 52 commands in 30 sim-minutes, while
  every targeted rebalance test stayed green. Any new path that spends or trades amps must be run
  under that noise scene before it ships; a margin sized to the noise band
  (`REBALANCE_FUND_MARGIN_AMPS`) is what makes a threshold noise-proof.
  The gated proactive shed (2026-08-06) paid this gate as a **noise clone of its own acceptance
  scenario** rather than through the resting-point scene — a trade needs a specific two-room
  temperature spread to fire at all, so "zero commands" is not the assertion it owes. The clone
  replays the identical incident with `setNoise(0.5)` and asserts the identical end-state plus **no
  room switched off twice** in either direction. Either form satisfies the gate; what matters is that
  the new path is exercised under the noise band, not that it reuses one particular scene.
- **Seeing WHAT a failing scenario did:** vitest swallows `console.log` from scenario runs. The
  fast pattern is a throwaway `src/leveling/_debug.test.ts` that replays the scene and writes
  `s.commandsSince(t0)` + the non-empty `s.plans` decisions to a file via `node:fs`, then Read it —
  the 35s cycle above was invisible in the assertion output ("expected 52 to be 0") and obvious in
  the dump. Delete the file before committing.
- **The harness boot mirrors the shell's boot quiet (2026-08-01):** both hold house sampling for
  `HOUSE_SAMPLE_COOLDOWN_MS` after their first tick (`firstTickAt` / `firstStepAt`), so no scenario
  can rely on house samples from its first 2 sim-minutes — settle scenes that need an honest house
  peak must `advance()` past the quiet before staging the incident.
- **Grid scenes must let the harness MEASURE the grid house (2026-09-27).** The budget-aware grid
  start (SKILL 78) and the grid session memory (80) read `houseLoadAmps`, which the harness samples
  off the simulated meter. So a grid-entry scene first runs grid long enough for the sampler to see
  the grid-only load (the acceptance uses 8 min at a 12 A house), then a generator interlude at a
  smaller house, then back to grid with the guest load present. Handing the planner a house figure
  directly would test a house the shell cannot see. The memory lives in `house-load.ts`, which the
  harness imports, so it is exercised rather than mirrored; the harness has no restart, so the
  memory's in-process loss on a server restart is not modeled.
- **The roomy lane's SETTLING half rarely opens in the harness.** Right after a batch the harness's
  calm clock is 0, so pressure is not `calm`; the calm-gate half carries the measured speed-up
  (second step at +15 s instead of +40 s). Live readings arrive every 1 to 4 s, so both halves apply
  in production. Its noise gate is a ±0.5 A, 60 s confirm-lag replay near the 3 A bar, the form the
  churn gate above allows for a new spend path.

**Verifying a fix is real (used for both 2026-07-28 fixes):** after the test passes, re-break the
single line the fix hinges on and confirm the test fails with the *expected number*, then restore.
That caught what a green suite could not — the old 45s grading window learns exactly **0.30A** for a
3.0A raise, which is the live poisoning reproduced in-harness. Two separate breaks proved the two
halves (window vs ratchet) each guard something.

**A green suite is not a shipped-safe suite (2026-07-31).** 866 tests passed and `tsc` was clean, and
the deploy still double-shed a room within 20 minutes: `OVER_LIMIT_BUDGET_AFTER_ACT` was set to 2
while `OVER_LIMIT_DRAIN_SEVERE` is 3, and *no test compared the two constants* — every test asserted
against literal readings, so the relationship nobody wrote down was the one that broke. When a change
introduces a threshold, add an assertion **relating it to the other constants it must outrank**
(`expect(OVER_LIMIT_BUDGET_AFTER_ACT).toBeGreaterThan(OVER_LIMIT_DRAIN_SEVERE)`), not just a scenario
that happens to exercise the current value. See hard rule 5c in AGENTS.md.

## Coverage philosophy

Pure logic (allocator, auto-fan, slots, calibration helpers, alert sustain) is fully unit-tested with no I/O. Stateful integration (collector loop, leveler, calibrator) is tested against mocked TCL/DB/timers in `collector.test.ts` / `ac-calibration.test.ts`. Regressions discovered live (beep loop, limit cycle, false caps) always get a named regression test — keep this pattern.
