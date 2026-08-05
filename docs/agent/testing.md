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
- `ac-control-audit.test.ts` — AC control attribution (2026-07-24 Najat incident): `ac_control_audit` rows carry user-vs-agent + IP, the lock-clear push fires exactly once for a burst of turn-ons, no push when the AC wasn't locked, and the 2026-08-05 race regression: the `set_power=1` handler claims the lock release BEFORE `sendControlVerified` — the test wraps the send to run the observed-ON clear mid-flight (the shadow echo of our own ON) and asserts the actor-carrying notify still fires from the route
- `tcl-cloud.test.ts` — regression tests for the non-Najat fan_speed↔turbo coupling in `computeAcDiff`/profile payloads (the 2026-06-08 beep-loop fix)
- `collector.test.ts` — AC manual-off lock behavior for range, stale TCL reads, schedules, and timers + dead-zone adoption/double-off regressions (adoption persists triggered status, manual fan override survives adoption, turn-off doesn't double-fire on shadow lag — the 15s `AC_OFF_REFIRE_GRACE_MS`) + Smart AC Leveling integration (shed guards, generator_mode stripping, shed/restore plumbing, outdoor-boost floor correction) + AC range fan enforcement (slot fan on turn-on/re-enforce, smart-auto resolution, manual-change detection/settle window, slot-change + power-cycle resets, UI hook) + leveler fan holds (reduce-before-shed, fresh-window shed, ONE-JUMP restore + baseline refresh, user fan change release, restart-adopt-then-release, fan_speed/turbo stripping during holds) + fan confirm-or-resend (lagging shadow kept + bounded re-sends, release only on confirm-then-diverge) + fan pacing (10s fan-only settle, no raise hold) + predictive control (restore-with-reduction e2e with command ordering, nonAcLoad freeze anti-spiral + expiry, expectedAmps/lastPrediction status, 240s ramp exclusion, effect-confirmation hold (2-min level-raise block with expiry, early release on arrival, 270s turn-on hold), source-change invalidation, calibration suspension of automations/timers/leveler) + bounce detection (cap-and-stay-quiet e2e, redirect to the other AC, load-drop retry at observed cost, power-cycle + source-change clears, restore-bounce block/retry, boost release at exactly threshold−1) + asymmetric over-limit gating (mild 16A needs 5 readings, 4 doesn't; severe 18A sheds in 2; priming a tick to consume the source-change forceEvaluate isolates the streak gate) + warm restore (temperature-cycle off records the stable level → warm-restore jumps to it skipping the headroom streak; manual off clears it; L1 not remembered; observed level 0 is NOT "reached") + confirmation-gated drift + source change (lagging raise never caps, confirmed-then-user-reduce caps, stale-high after a reduce sets no target, manual cap released onto Grid / kept onto Gen, ramp re-armed on a Gen↔Grid changeover, changeover baseline re-adopt — uses the `gridReadings()` helper) + unreachable levels (Najat-L6 named regression: 3 unconfirmed sends → mark → L5 fallback → quiet on confirm; late-confirm un-mark; survives power cycle / cleared by manual gen change) + calibration handoff (rearmRamp keeps restored draw out of nonAcLoad) + per-slot gen level (leveler hard cap, slot-flip immediate reduce, direct-send when opted out, stripped when managed) + emergency fast path (urgent tick on the 2nd severe reading with no loop wait, grid-only oscillation gate, meter-sized cut despite a frozen budget that "fits", anti-stacking discount then feedback escalation to a same-batch sufficient shed, one-batch shed+fan 18A incident regression) + observed-ON lock-release push (2026-08-05: announces a remote/app/panel release; stays silent when the dashboard turn-on already claimed it)
- `ac-leveling.test.ts` — pure allocator: even-spread delta-ordered fill, min-level boosts/floors, need/manual caps, soft need caps (surplus budget fills mild rooms past needCap; manual intents stay hard), fan-reduce-before-shed + one-jump fan restore (priority order, straight-to-original, auto-in-one-step, gen-raise suppression), 4-reading reduce gate, proactive reduce, shed-by-least-delta with top-priority protection, restore-by-most-delta, restore-with-reduction (floor-based feasibility, reductions under the raise gate, won't-fit leaves everyone untouched, one-per-call, manualTarget reduced too), raise-hold gate (blocks raises/restores, never reductions), bounce caps (ceiling in both fill passes, budget redirected to other ACs, manualTarget deferred, boost floor wins, restore-blocked filter), slot gen caps (fill capped, beats boost floor, shed/reduce below allowed, vs bounceCap min, ≥L1, soft pass, manualTarget wins), reachable caps (ceiling/manualTarget/boost-floor/warm-start clamps, ≥L1), warm restore (jumps to remembered level skipping the headroom streak, capped at remembered, budget-clamped, deferred during settle/raise-hold, raises past it once headroom sustained), asymmetric reduce gate (severe streak triggers before the mild streak; single severe waits), draw model, emergency reduction (`computeEmergencyReduction`: smallest sufficient cut set, best-fit fan final step, never-level-0 pre-pass with single-counted credit, same-batch sufficient sheds — insufficient least-needy AC skipped, top-priority never single-picked / last resort, 18A-gen-incident regression) (130 tests)
- `ac-calibration.test.ts` — pure helpers (buildCalibrationSteps, fitAmpModel least-squares, median/stddev, gen-vs-grid sample counts) + state machine with mocked TCL and fake timers (full sweep with others-off/baseline/floor-then-plateau early release/no-sample-before-floor gating, one-by-one multi-device, source-change + user aborts with restore + `onDevicesRestored` fired with the powered-back-on ACs, partial results kept, start validation, ramp holds to the max cap when the draw never stabilizes)
- `ac-auto-fan.test.ts` — smart auto fan: delta→level boundaries (uses 1e-9 epsilon in the mapping — FP error like `1.2 − 1.0 = 0.19999…` would otherwise push exact boundaries up a level), down-hysteresis hold/drop, out-of-range previousLevel
- `automation-slots.test.ts` — slot selection (timed > all-day, overnight), overlap/threshold/fan_speed validation, gen_level validation (1–3 since 2026-06, 0 and 4+ rejected) + the normalizeRangeSlots whitelist regression
- `power-stats.test.ts` — pure power-source logic (`power-stats.ts`): minute classification, flicker smoothing (heal ≤2-min, keep 3-min/edge/changeover gaps), session reconstruction, current-session resolution (tail-match / fresh switch / blackout edge), Baghdad date/hour keys, 24h grid minutes, avg session length (`averageSessionHours`: complete grid/gen stretches only, ignore none + running tail + pre-window switches), weighted median, and `dayBreakdownForWindow` (partial day, midnight split, complete day). **No longer covers time-remaining prediction** — `predictRemainingMinutes` and its temp machinery were removed on 2026-08-05; see `power-predict.test.ts`
- `power-predict.test.ts` — the slot-cycle next-switch predictor (`power-predict.ts`, pure): cycle fit incl. harmonic rejection (the half-grid must not win on concentration alone), the per-slot empirical-Bayes hold model, boundary-miss grace, survival fallback (low confidence / unobserved state / blackout recovery), null under scarce data, and 3 regression cases taken from the 2026-08-05 backtest worked examples (34 tests)
- `leveling/*.test.ts` — **Leveling v2** (the acting controller). Pure modules each have their own file (`sensing`, `modes`, `raise`, `reduce`, `pacing`, `needs`, `pressure`, `fan-trim`, `costs`, `config`, `reconciler`, `house-load`). Three carry the integration weight: `scenarios.test.ts` replays live incidents against the physics harness (`scenario.ts`), `controller.test.ts` covers the stateful shell (grade queue, shed-until-confirm, off-drop and ramp-honest cost learning, `batchLoadDirections`), `pipeline.test.ts` the emission-layer rules a whole-house sim can't isolate (batch dedupe, inrush blanking). Incident provenance for each block lives in [ac-leveling.md](ac-leveling.md) — the test comment names the incident, the doc explains it.
- `power-stats-routes.test.ts` — HTTP shape for `GET /api/power/stats` (full payload, source "none" when latestPower null) and `GET /api/power/day-breakdown` (days+totals, all RANGE_MAP keys accepted, bogus range → 400), via the `push-routes.test.ts` fake-pool + live `createRouter` harness

## Harness notes (read before editing collector/calibration tests)

**collector.test.ts:**
- The `tclCloud` mock includes `getDeviceState` (returns null by default — fan tracking skips the tick); fan tests use fake timers at 07:30 Baghdad and the `acFanRule()` fixture.
- Predictive tests use fake timers + `genReadings()` helper — readings must be re-fed after each `advanceTimersByTime` or the 15s stale-power check reads "none". There is a `gridReadings()` helper for grid-source tests.
- `createPool()` exposes the `fanHolds` map for pre-seeding `ac_leveling_fan_hold`.
- Mock devices without `fanSpeed` → snapshot `fanSpeed: null` → not fan-reducible (the `?? null` coercion in the leveler's snapshot builder is load-bearing for legacy leveling tests; same idea as the allocator `ac()` helper defaulting `fanSpeed: 1`).
- **The ACTING leveling controller here is v1, not v2 (2026-08-05).** `createPool()` serves the config row as `{ config }` with **no `id` column**, and v2's `reloadConfig()` keys on it (`SELECT id, config … WHERE id IN (1, 2)` → `rows.find(r => Number(r.id) === 1)`), so both rows miss, `rawConfig` is `{}`, the flavor falls back to the `"v1"` default and `collector.leveling()` returns `acLeveler`. Consequence: collector-level tests of leveling integration points (e.g. `computeAcNeed`'s `getNeedOverride` read, added 2026-08-05) assert **v1's** implementation of whatever facade method they touch — where v1 and v2 diverge, the shipped path is the one NOT under test. `tsc` does catch a method missing from one side (`leveling()` returns the `AcLeveler | LevelingControllerV2` union, so a call must type-check against both); it cannot catch differing semantics, so keep the two implementations in step.

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
- **Seeing WHAT a failing scenario did:** vitest swallows `console.log` from scenario runs. The
  fast pattern is a throwaway `src/leveling/_debug.test.ts` that replays the scene and writes
  `s.commandsSince(t0)` + the non-empty `s.plans` decisions to a file via `node:fs`, then Read it —
  the 35s cycle above was invisible in the assertion output ("expected 52 to be 0") and obvious in
  the dump. Delete the file before committing.
- **The harness boot mirrors the shell's boot quiet (2026-08-01):** both hold house sampling for
  `HOUSE_SAMPLE_COOLDOWN_MS` after their first tick (`firstTickAt` / `firstStepAt`), so no scenario
  can rely on house samples from its first 2 sim-minutes — settle scenes that need an honest house
  peak must `advance()` past the quiet before staging the incident.

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
