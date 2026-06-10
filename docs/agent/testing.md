<!-- Tier-3 agent doc. Loaded on demand via CLAUDE.md / AGENTS.md routing table. -->

# Testing

**TL;DR:** Server tests use **vitest** (config-free, ESM-native). Run with `cd server && npm test`. There is no client test suite — client is verified by type-check (`cd client && npx tsc -b`) and build. The collector and calibration suites rely on fake timers plus mock-feeding patterns that are easy to get wrong — read the harness notes below before editing those test files.

## Test file inventory

- `auth.test.ts` — JWT sign, verify, expiry, tamper detection (6 tests)
- `routes.test.ts` — median() utility function (5 tests)
- `agent-routes.test.ts` — Hermes bearer-token auth integration tests against a live `createRouter` (valid token accepted, missing/wrong → 401, disabled when `hermesApiToken` empty, `/api/agent/session` cookie issuance, `/api/agent/snapshot` payload, cookie login unaffected)
- `alert-metrics.test.ts` — `powerConditionSustained()`: 4-reading streak, >15s gap breaks the streak, null readings, computed `power_total`, unknown metrics
- `tcl-cloud.test.ts` — regression tests for the non-Najat fan_speed↔turbo coupling in `computeAcDiff`/profile payloads (the 2026-06-08 beep-loop fix)
- `collector.test.ts` — AC manual-off lock behavior for range, stale TCL reads, schedules, and timers + Smart AC Leveling integration (shed guards, generator_mode stripping, shed/restore plumbing, outdoor-boost floor correction) + AC range fan enforcement (slot fan on turn-on/re-enforce, smart-auto resolution, manual-change detection/settle window, slot-change + power-cycle resets, UI hook) + leveler fan holds (reduce-before-shed, fresh-window shed, staged restore + baseline refresh, user/external fan change release, fan_speed/turbo stripping during holds) + predictive control (restore-with-reduction e2e with command ordering, nonAcLoad freeze anti-spiral + expiry, expectedAmps/lastPrediction status, 240s ramp exclusion, effect-confirmation hold (2-min level-raise block with expiry, early release on arrival, 270s turn-on hold), source-change invalidation, calibration suspension of automations/timers/leveler) + bounce detection (cap-and-stay-quiet e2e, redirect to the other AC, load-drop retry at observed cost, power-cycle + source-change clears, restore-bounce block/retry, boost release at exactly threshold−1) + asymmetric over-limit gating (mild 16A needs 5 readings, 4 doesn't; severe 18A sheds in 2; priming a tick to consume the source-change forceEvaluate isolates the streak gate) + warm restore (temperature-cycle off records the stable level → warm-restore jumps to it skipping the headroom streak; manual off clears it; L1 not remembered) + confirmation-gated drift + source change (lagging raise never caps, confirmed-then-user-reduce caps, stale-high after a reduce sets no target, manual cap released onto Grid / kept onto Gen, ramp re-armed on a Gen↔Grid changeover — uses the `gridReadings()` helper)
- `ac-leveling.test.ts` — pure allocator: even-spread delta-ordered fill, min-level boosts/floors, need/manual caps, soft need caps (surplus budget fills mild rooms past needCap; manual intents stay hard), fan-reduce-before-shed + staged fan restore (priority order, one step, auto-in-one-step, gen-raise suppression), 4-reading reduce gate, proactive reduce, shed-by-least-delta with top-priority protection, restore-by-most-delta, restore-with-reduction (floor-based feasibility, reductions under the raise gate, won't-fit leaves everyone untouched, one-per-call, manualTarget reduced too), raise-hold gate (blocks raises/restores, never reductions), bounce caps (ceiling in both fill passes, budget redirected to other ACs, manualTarget deferred, boost floor wins, restore-blocked filter), warm restore (jumps to remembered level skipping the headroom streak, capped at remembered, budget-clamped, deferred during settle/raise-hold, raises past it once headroom sustained), asymmetric reduce gate (severe streak triggers before the mild streak; single severe waits), draw model (84 tests)
- `ac-calibration.test.ts` — pure helpers (buildCalibrationSteps, fitAmpModel least-squares, median/stddev, gen-vs-grid sample counts) + state machine with mocked TCL and fake timers (full sweep with others-off/baseline/floor-then-plateau early release/no-sample-before-floor gating, one-by-one multi-device, source-change + user aborts with restore, partial results kept, start validation, ramp holds to the max cap when the draw never stabilizes)
- `ac-auto-fan.test.ts` — smart auto fan: delta→level boundaries (uses 1e-9 epsilon in the mapping — FP error like `1.2 − 1.0 = 0.19999…` would otherwise push exact boundaries up a level), down-hysteresis hold/drop, out-of-range previousLevel
- `automation-slots.test.ts` — slot selection (timed > all-day, overnight), overlap/threshold/fan_speed validation

## Harness notes (read before editing collector/calibration tests)

**collector.test.ts:**
- The `tclCloud` mock includes `getDeviceState` (returns null by default — fan tracking skips the tick); fan tests use fake timers at 07:30 Baghdad and the `acFanRule()` fixture.
- Predictive tests use fake timers + `genReadings()` helper — readings must be re-fed after each `advanceTimersByTime` or the 15s stale-power check reads "none". There is a `gridReadings()` helper for grid-source tests.
- `createPool()` exposes the `fanHolds` map for pre-seeding `ac_leveling_fan_hold`.
- Mock devices without `fanSpeed` → snapshot `fanSpeed: null` → not fan-reducible (the `?? null` coercion in the leveler's snapshot builder is load-bearing for legacy leveling tests; same idea as the allocator `ac()` helper defaulting `fanSpeed: 1`).

**ac-calibration.test.ts:**
- After every `advanceTimersByTime` feed a keep-alive reading or the stale-power check aborts the run with "power_lost".
- A settle step needs the `settleStep()` helper (plateau readings collapse the window, then the measurement samples are collected).

## Coverage philosophy

Pure logic (allocator, auto-fan, slots, calibration helpers, alert sustain) is fully unit-tested with no I/O. Stateful integration (collector loop, leveler, calibrator) is tested against mocked TCL/DB/timers in `collector.test.ts` / `ac-calibration.test.ts`. Regressions discovered live (beep loop, limit cycle, false caps) always get a named regression test — keep this pattern.
