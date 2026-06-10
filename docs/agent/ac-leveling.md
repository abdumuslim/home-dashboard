<!-- Tier-3 agent doc. Loaded on demand via CLAUDE.md / AGENTS.md routing table. -->

# Smart AC Leveling & Per-AC Calibration

**TL;DR:** A closed-loop controller (built 2026-06-06) in the collector keeps total household current within the active power source's limit (Grid 30A / Generator 15A, editable) by adjusting TCL AC **generator-mode levels** (per-unit current caps). It can also reduce fans, emergency-shed ACs, and auto-restore them. A pure allocator (`ac-leveling.ts`) decides targets; a stateful layer (`ac-leveler.ts`) handles gating, persistence, manual intents, prediction, and command execution. A separate calibration runner (`ac-calibration.ts`) measures each AC's real draw per level/fan to tune the amp models.

Related docs: [database.md](database.md) (table schemas), [ac-automations.md](ac-automations.md) (range automation / fan enforcement side), [tcl-ac.md](tcl-ac.md) (TCL cloud protocol).

---

## Concept & sources

- **Goal:** keep total household current within the active source's limit by adjusting AC **generator-mode levels** — TCL's per-unit current cap: Najat 0–6, Abdu/Abdullah 0–3; level 0 = unrestricted. **Managed ACs are never left at 0** (user chose "always keep a cap").
- **One active source at a time** (changeover panel): source detection mirrors the power card — a line counts as active when its current > 0.1A; if both lines read, the larger wins. Sources: `grid`, `gen`, `none`.
- **Key files:** `server/src/ac-leveling.ts` (pure allocator, no I/O — originally 31 unit tests, now 84 in `ac-leveling.test.ts`), `server/src/ac-leveler.ts` (stateful `AcLeveler`), `server/src/ac-calibration.ts` (`AcCalibrator`), collector `checkAcLeveling()` runs after `checkAcTimers()` each loop tick. Config UI = "Smart AC Leveling" collapsible section in the bell modal (admin-only).
- **Master switch defaults OFF** — must be enabled in the bell-modal section after deploy (set priority first).
- Power readings arrive from the ESP power monitor every ~5s; the leveler consumes them via `AcLeveler.onPowerReading()` (called from collector `setLatestPower`).

## Pure allocator (`computeAllocation()` in `ac-leveling.ts`)

- **Budget:** `budget = limit − margin − nonAcLoad − opted-out AC draw`. The caller (leveler) derives `nonAcLoad = measured − Σ est(on managed ACs)`, using the **median of the last 4 ESP readings** for measured.
- **Amp model per AC** (editable, **per source** since 2026-06-07): `draw = baseAmps + stepAmps × (level − 1)`. `ampModels` = grid model + fallback; optional `genAmpModels` overrides on generator (lower voltage ~200V → more amps; the leveler picks via `ampModelFor(deviceId, source)`). Defaults: Abdu 4A@L1 + 2A/level; Najat & Abdullah 2A@L1 + 1A/level. Level 0 (unrestricted) is estimated as one step above max level.
- **Priority = protection; needDelta = who gets the next amp** (refined 2026-06-06 PM): minimum levels are granted by priority first; the top-priority AC sheds last; priority breaks delta ties. The user's priority order: Abdullah, Mom (Najat), Abdu.
- **Fill algorithm:** every ON managed AC starts at its floor (L1 or boost min) → raises spread **level-by-level** (everyone reaches L2 before anyone gets L3); within a level the highest `needDelta` (°C past the satisfied point) goes first; ceiling per AC = `min(maxLevel, needCap, manualCap/manualTarget)` (plus `bounceCap`, see Bounce detection).
- **Raises jump straight to the budget-fitted ideal in one batch** ("guess by amp model, adjust by feedback") — the user explicitly rejected one-step-per-tick as too slow.
- **Need tiers** (`computeNeedTier`): an AC with an active range automation uses its automation metric vs the active slot: value ≤ slot low = **satisfied** → cap L1; in the dead zone = **mild** → cap `ceil(max/2)`; value ≥ slot high = **full** → max level. Heat mode inverts the comparison. An AC with no automation uses its internal `currentTemp` vs the comfort target (config `comfortTargetC`, default 26).
- **Soft need caps** (2026-06-06 eve — user picked this over "grid-only" and "keep-as-is" options): a **second fill pass** (`softCeilOf()`) spends surplus budget raising non-satisfied ACs past their need cap toward max (on grid AND generator) — need caps only bite when amps are tight. Satisfied rooms stay at L1 (their automation is about to turn them off); `manualCap`/`manualTarget` remain **hard** ceilings. Trigger for this change: Abdullah was pinned at L2 on grid with 25A free (mild-tier cap `ceil(3/2)=2` + the L2@37° boost floor).
- **Min-level boosts** (config `levelBoosts{deviceId: {minLevel, outdoorAtLeastC}}`): per-AC conditional floor, e.g. Abdullah min L2 when outdoor ≥ 37°C (his AC can't cool at L1 in extreme heat). 1°C hysteresis lives in `AcLeveler.minLevelFor()`: activates at outdoor ≥ threshold, **releases at ≤ threshold − 1** (e.g. exactly 36.0° releases a 37° boost — changed 2026-06-07 from strictly-below, because 36.0° was keeping a 37° boost alive). Holds its last state when outdoor temp is unknown (> 10 min stale). Below-floor ACs are **corrected immediately** (ungated, like the never-level-0 rule, with `forceEvaluate` so others reduce to make room); a **manual reduction below the floor wins**.
- Other exports: `estimateAcDraw`, `determineSource`, `computeNeedTier`.

## Raise hysteresis buffer (2026-06-08, asymmetric deadband — user decision)

Config `raiseBufferAmps` (default **1A**). The two fill passes AND restore-feasibility use `raiseBudgetAmps = budget − max(0, raiseBuffer)`; `overBudget`/shed/reduce/below-floor/level-0 correction keep the FULL `budget` (= limit − margin, the safety side).

**Root cause it fixes — a sustained limit cycle on generator (control-theory problem, not a logic bug):** live `marginAmps` was set tiny (**0.1A**) on the 15A gen because the user rides near the breaker on purpose. The raise ceiling (`limit − margin`) and the over-limit reduce trigger (`limit`) were ~0.1A apart — no hysteresis deadband. Because the caller derives `nonAcLoad = measured − Σ est(on managed)`, `budget − currentOnCost = limit − margin − measured`, so a raise fits iff `measured ≤ limit − margin − step` — landing the resting draw at ≈`limit − margin`, right at the breaker, where ±0.5–1A gen fluctuation repeatedly crossed the limit → reduce → headroom → re-raise forever. Live symptom: Abdu/Abdullah swapping a gen level every 80–250s indefinitely, confirmed in 3h of live gen logs + `/api/ac/leveling` after the user reported "smart ac leveling is not reaching a stable state, it keeps raising and downing the levels." Secondary cause: the bounce window (`lastRaiseBatch.windowUntil = raise + RAISE_HOLD_MS 120s`) was shorter than the ~250s cycle, so most reduces weren't attributed → no bounce cap → re-raise (fixed by decoupling, see Bounce detection).

The buffer rests a raised AC a full buffer below the breaker so noise can't trip the reduce → the cycle collapses to a fixed point.

- **Reduce side unchanged** — stays on `limit − margin` band; reductions fire only at/over the raw limit (user: "if even 0.1A below, no reduction"). Do NOT bump `marginAmps` to compensate.
- **Fan is deliberately NOT buffer-gated** (user follow-up 2026-06-08: "the fan speed should not be like leveling with the raising buffer"). An initial implementation widened the `onPowerReading` headroom band to `limit − margin − raiseBuffer`, which (via `headroomStreak` → `canRaise`) also delayed the staged fan restore (`toFanRaise`). Reverted: the headroom band stays at the un-buffered `measured ≤ limit − margin`, so cheap, comfort-positive fan restores recover on real headroom. The gen-level buffer is enforced ONLY in the allocator fill (`raiseBudgetAmps`) + restore feasibility — `canRaise` itself is un-buffered; the fill is where the buffer bites (a gen raise still can't climb into the deadband because the fill won't add the step). Fan REDUCTION (reduce-before-shed) already used the full `budget`/`overBudget`, never the buffer.
- Negative buffer clamps to 0 (never raises above `limit − margin`). `idealLevels` in status now reflects the raise-budgeted target (the level it will actually drive to). Floors/boosts/below-floor/level-0 correction are unaffected (seeded before the fill, judged on full budget).
- **Implementation details:** `ac-leveler.ts` passes `raiseBufferAmps` into `AllocatorInput`; the bounce retry-clear is tightened to `smoothed + requiredAmps ≤ limit − margin − raiseBuffer` (a cleared bounce can't instantly re-bounce); `updateConfig` merges over `DEFAULT_LEVELING_CONFIG` so an old/partial client payload can't set the field undefined → NaN. Reaches the live config via the load-merge default + `updateConfig` defaults-merge (no migration; the user did NOT edit the live saved config). Client: `raiseBufferAmps` in the leveling type; `seedDraft` prefill `?? 1` (not dirty); "Raise buffer A" `NumberField` in a 5-col limits grid. `routes.ts` validates 0–10 (optional) + `?? 1` fallback.
- **Tests:** the `input()` helper + collector `LEVELING_CONFIG` default the buffer to **0** (keeps all prior assertions). `ac-leveling.test.ts` "raise buffer (hysteresis)" suite (7 cases) + `collector.test.ts` limit-cycle regression (settles + stays quiet under sub-limit noise) and bounce-window test (reduce at 150s > hold still records a bounce). 220 server tests green at ship; deployed; live config picked up `raiseBufferAmps:1` via merge, and Najat's ideal dropped L5→L4 (buffer constraining as designed).

## Gating & streaks (gen current fluctuates)

- **Asymmetric reactive reductions** (2026-06-08, replaced the original flat 4-reading reduce gate that took ~20s):
  - **Mild** over-limit (measured ≤ limit + `OVER_LIMIT_SEVERE_AMPS` 1A over the raw limit): needs `REDUCE_STREAK` **5 consecutive ESP readings** (~25s). Any reading back at/below the limit resets the streak.
  - **Severe** (> limit + 1A): just `REDUCE_STREAK_SEVERE` **2** readings act. A merely-mild reading breaks the severe streak but NOT the over-limit streak.
  - Tracked as separate `overLimitStreak` / `severeOverLimitStreak` counters in `onPowerReading()`; the allocator's `canReduce` ORs both thresholds, the leveler's `reactive` flag (used for bounce attribution) ORs both, and both reset together (source change, source "none", after a reduction).
  - **Streak semantics (confirmed with the user):** `overLimitStreak` counts only `measured > limit`; a single reading at/below the limit resets it (the margin band resets both streaks). Streaks are counted **per ESP reading, not per tick**.
  - Status exposes `severeOverLimitStreak`; UI hint shows "severe over-limit N/2" else "over-limit N/5".
- **Proactive** (`forceEvaluate`): AC power flip, source change, manual gen change, config change, below-floor AC → act **immediately**, no streak required.
- **Raises/restores:** need **6 consecutive headroom readings** (~30s, `headroomStreak`, band = un-buffered `measured ≤ limit − margin`) + must be outside the **30s settle window** (`SETTLE_MS`) after any command (plus the raise hold, see below).
- After reductions **both streaks reset** (code-review fix — a stale pre-shed headroom streak could otherwise restore prematurely).
- `nonAcLoad` uses the median of the last 4 readings. Power considered stale/`none` after 15s without a reading (`STALE_POWER_MS`).

## Turn-on ramp window (`AC_RAMP_MS` 240s)

- `AC_RAMP_MS` = **240s** since 2026-06-09 (history: 30s at build → 90s on 2026-06-07 → 240s). The user measured the compressor needs ~4 min to reach steady-state draw; real compressors take 30–120s+ and a half-ramped AC reading as headroom caused raise → over-limit → reduce flapping.
- While an AC is ramping, its estimated draw is **NOT subtracted from measured** when deriving `nonAcLoad` (the compressor hasn't ramped; subtracting would understate the load / fake headroom and hide an imminent overload). The ramping AC therefore **double-counts conservatively**: its partial draw sits inside measured-derived nonAcLoad AND its full estimate is budgeted — delays raises, which is safe.
- **Near-limit turn-on acts instantly** (user request 2026-06-06 PM): combined with the power-flip `forceEvaluate`, a freshly-ON AC near the limit makes the leveler reduce other ACs immediately, zero over-limit readings needed. The "within ~2A" trigger condition emerges naturally from the budget math (margin + the new AC's floor draw); raising `marginAmps` makes it more aggressive.
- Ramp set on: observed OFF→ON flip, UI power-on, leveler restore, **and a true Gen↔Grid changeover** (2026-06-09 — a source flip restarts every running compressor). Implementation: `armRampOnSourceChange` flag set in `onPowerReading` only when `prevSource !== "none" && source !== "none"` (capture `prevSource` BEFORE reassigning `lastSource`); consumed in `tick()` to re-arm `rampUntil = now + AC_RAMP_MS` for ON managed ACs. **NOT armed coming back from "none"/blackout** (ESP/power resuming — the ACs were already running steadily; arming there inflates nonAcLoad and broke every test's budget math — this was the bug that caused 22 test failures on the first run of the 2026-06-09 change). Cleared on power-off.

## Predictive control (2026-06-07)

Triggered by user notes: Abdullah's boost shed Najat then sat at L3 while she stayed off; the leveler "acted blindly" (no expected-amps concept); command effects lag (compressor ramp, level-change seconds) causing fluctuation. After any command batch the leveler records what it expects:

1. **nonAcLoad freeze** (`NON_AC_FREEZE_MS` 15s): fresh `measured − establishedDraw` derivations right after a command are contaminated — measured still shows pre-command draw while the snapshot levels are already lowered (via `lastSetLevel` during settle) → overstated nonAcLoad → over-reduction spiral. The nonAcLoad value the batch was computed with is reused for 15s. The freeze deliberately **survives `forceEvaluate`** (it's the *less* contaminated input for proactive turn-on reductions); cleared on source change / source "none" / leveler disable. A real non-AC load rise is still caught by the raw over-limit streak with ≤15s extra latency.
2. **Expectation grading:** every batch records `expected = {amps: nonAcLoad + Σ estimates at commanded levels, raisedAmps, compareAfter: max(settle end, rampUntil of every counted AC)}`. Once due (+ ≥4 fresh readings), the median measured is compared vs expected → `lastPrediction` in status; pino warn when |error| > `PREDICTION_WARN_AMPS` (2A) suggesting calibration. **No auto-adaptation of the amp model** — it stays deterministic by design.

(Items 3 and 4 — the raise hold and bounce detection — have their own sections below.)

## Effect-confirmation raise hold (2026-06-07 evening)

Replaced the earlier 60s grading-time miss-hold. User request, refined the same day: "either see the expected effect on the whole amp draw, or wait — 2 min for fan and level change, 3 min for AC turn on — before doing the next raise."

**Why:** a gen level is a **CAP, not a draw command** — a satisfied room's compressor won't draw more when the cap rises, so without confirmation the "headroom" after a raise is phantom and stacked raises overshoot when compressors kick in.

- EVERY raise batch arms a hold at command time in `execute()`: `RAISE_HOLD_MS` **120s** for level/fan raises (a cap raise on an already-running compressor settles fast — deliberately kept at 120s on 2026-06-09), `RESTORE_HOLD_MS` **270s** when the batch turns an AC on (raised 180→270s on 2026-06-09 to cover the measured ~4-min compressor ramp + meter slack; kept ≥ `AC_RAMP_MS` 240s so the hold can't expire mid-ramp).
- The next raise happens only when the batch's expected amps actually arrive on the meter — **early release**: `measured ≥ expectedAmps − max(1A, raisedAmps/2)`, checked per tick but only after `RAISE_HOLD_CHECK_AFTER_MS` **20s** so the 4-reading median window is post-command — or the hold times out.
- `input.raiseHold` gates `canRaise` (blocks raises, restores, AND fan-raises). **Reductions are NEVER blocked.** Pure-reduction batches leave an existing hold untouched (its expectation goes stale → no early release → it expires on time — conservative).
- Fan-raise-only batches arm the hold too, but their `expectedAmps` ≈ current measured (fans are unmodeled) → release at the first check, so staged fan restores keep their ~30s/step pacing.
- Cleared on source change / "none" / disable. Status exposes `raiseHoldRemainingMs`; UI shows an amber "raise hold Xs" hint.
- Net behavior: delivering raises release in ~20–25s (≈ the old settle pacing); only under-delivering ones wait the full 2–3 min.

## Bounce detection (2026-06-07 evening)

Triggered by live flapping ("the Abdu bounce"): leveler raised Abdu on headroom → the real step exceeded the gen amp estimate → over-limit → reduced back → headroom rebuilt in ~30s → raised Abdu again, every ~2 min. The raise hold didn't help — the amps DID arrive (hold released early), they were just too many.

- Every raise/restore batch records `lastRaiseBatch = {windowUntil, preMeasured (smoothed measured at command time), raised{id→level}, restored ids}`. Since 2026-06-08 `windowUntil = now + max(holdMs, BOUNCE_WINDOW_MS 5min)` — decoupled from and ≥ the raise hold, because a slow limit cycle over-limits/reduces minutes after the raise (period > the 120s hold) and that reduce is still the raise's fault.
- A **reactive** (over-limit-streak) reduction that undoes one of those raises inside the window records a **bounce** in the in-memory `bounce` map (in-memory = lost on restart, accepted like manual gen intents):
  - **Level kind** → `bounceCap` at the reduced-to level: an extra `Math.min` term in `ceilOf`/`softCeilOf` — caps `manualTarget` raises too, never lowers hard boost floors, never forces reductions.
  - **Restore kind** → `restoreBlocked`: filtered out of restore selection; the next-most-needy unblocked shed AC goes first. (User decision: restore bounces included — a restore → over-limit → re-shed power-cycles the compressor, which is worse than level flapping.)
- **Explore other options first** (user decision): the bounce cap is per-device, so the fill order naturally gives the budget to the OTHER ACs; only when every candidate is capped/satisfied does the leveler go quiet (ideal == current → zero commands).
- **Retry is evidence-based, NOT timed** (user explicitly rejected fixed-cooldown options; spec: retry when total amps drop below the state it bounced at): `requiredAmps = clamp(peakMeasured − preMeasured, estStep, estStep + BOUNCE_MAX_EXTRA_AMPS 3A)` is the raise's OBSERVED cost. The record clears when `smoothedMeasured + requiredAmps ≤ limit − margin − raiseBuffer` (tightened by the raise buffer 2026-06-08 so a cleared bounce can't immediately re-bounce; checked per tick, skipped during settle).
- **Structural clears:** device power cycle (**level kind only** — the restore kind must survive the power-off cleanup loop that runs every tick on off devices), user power on/off, manual gen change, source change, config save, plus a `BOUNCE_SAFETY_EXPIRY_MS` **60-min** safety net against corrupted baselines. Bounce also clears on ANY source change (per-source physics — independent of the 2026-06-09 cap-release-onto-Grid rule).
- Status: per-AC `bounceCap` / `bounceRetryBelowAmps` / `restoreBlocked`; orange "bounce L{n}" / "restore wait" badges in the leveling UI.

**Same-session Abdu shed diagnosis** (user: "it turned off abdu ac while abdulla's on L2, outdoor 36"): NOT a bug — gen at 15A with ~10A non-AC load fits only one AC; Abdullah is priority #1 (shed-protected) and Abdu had the smallest needDelta → shed per design. User declined a priority reorder and declined boost-softening-before-shed; only asked that the **boost release at exactly threshold−1** (was strictly-below: 36.0° kept a 37° boost alive) — `minLevelFor` now releases at `≤ outdoorAtLeastC − 1`. The gen amp models were off by 2–4A in the logs (prediction warnings) — calibration on generator was recommended to the user.

## Fan reduction before shed & fan holds (2026-06-06 eve, user requested)

When floors exceed budget, the leveler first drops every **reducible** managed ON AC's fan to level 1 (the AC's built-in auto fan 0 **counts as reducible**, but the leveler never *sets* built-in auto; gen levels floor in the same batch), records a **fan hold** (persisted in `ac_leveling_fan_hold` — `original_fan`/`last_set_fan`; survives restarts because a restart mid-hold would otherwise strand automation-less ACs invisibly stuck at silent fan 1), resets both streaks, and only sheds if a **fresh** over-limit window builds with no fans left to reduce. (Originally a 4-reading window; now the asymmetric 5/2 gate.)

- **Restore order on headroom:** shed AC first → held fans **one step per gated action toward the original fan** (highest-priority hold first; an original of 0/auto is restored in one step — stepping through 7 would flash turbo on non-Najat) → gen raises (suppressed while any fan hold is pending; rationale: "a fan step costs fewer amps than a gen step").
- **Manual fan always wins:** a UI fan change (`noteUserAcFanChange` → `acLeveler.onUserFanChange`) or shadow fan drift outside the settle window releases the hold and **exempts** the AC from re-reduction until the episode ends (sustained headroom) or it power-cycles. Shed/power-off/leveler-disable also release (disable restores the original fan best-effort).
- **Enforcement integration with range automations (the tricky part):** without guards, the leveler's fan commands would be misread as manual fan changes by the collector's `updateAcFanTracking` (drift vs `lastCommandedFan` after 15s), and the range automation would fight the hold every 5s tick. Three guards:
  1. `stripLeveledControls(rule, action, deviceId)` (wraps `stripGenIfLeveled`) also strips `fan_speed` + `turbo` at the turn-on site + the 3 `computeAcDiff` re-enforcement sites while `acLeveler.hasFanHold(deviceId)` is active — turbo must go too: non-Najat fan 7 == turbo, so enforcement would re-arm turbo and clobber the held fan.
  2. `updateAcFanTracking` early-returns during a hold.
  3. Every leveler fan command fires the `onLevelerFanCommand` dep → collector `refreshAcFanBaseline()` re-stamps `acFanEnforcement` baselines (`lastCommandedFan`/`lastFanCommandAt`, preserving `manual`/`slotId`) so neither the hold nor its release is misread as a manual change.
  On release, the automation legitimately re-takes fan control as a normal diff. (Automation-side details: [ac-automations.md](ac-automations.md).)
- `overBudget` (NOT `shedWanted.length`) gates restores/fan-raises — closes a forceEvaluate+headroom same-tick collision.
- No UI badge for fan holds yet — server status fields (`heldFan`+`fanOriginal`) + client types only.
- **Follow-up knob (not implemented):** skip the fan attempt when the overshoot dwarfs realistic fan savings (~0.5A × reducible count) — only if breaker trips are ever observed.

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
- **Cleared on:** observed reaching the level (`generatorMode ≥ remembered`), manual gen change (`onUserGenLevel`), manual power-off (`onUserPowerOff`), shed (`recordShed`). It deliberately **survives the per-tick power-off cleanup** so it lasts the whole off period.
- The `currentLevel === 0` "never run unrestricted" branch still caps instantly, ungated; warm-start covers the came-back-at-a-positive-level-below-remembered case.
- **Subtlety:** the leveler must observe the OFF (a tick while the AC is off) to clear `lastSetLevel`, or the firmware's L1-on-return would read as a manual reduction — true in production (5s ticks), and the e2e test inserts an off-period tick.

## Manual gen-level intents & confirmation-gated drift detection

Detected via the UI route hook `onUserGenLevel` + shadow-drift detection in tick:

- **Reduction** → `manualCap` (the leveler never raises above it).
- **Increment within budget** → `manualTarget` (overrides the needCap; still a hard ceiling for the soft-cap pass; bounce caps can defer it).
- **Increment projecting over the limit** → **instantly reverted** (the control route responds `{reverted: true, level}`).
- **Intents cleared:** when the AC powers off, AND on a changeover **onto Grid** (2026-06-09 — Grid's 30A budget makes a gen-fitted cap obsolete; `manualCap`/`manualTarget`/`pendingLevel` cleared in `onPowerReading` when the new `source === "grid"`). Caps are **KEPT on Grid→Gen** (user decision: the tight 15A gen budget may still need them). `confirmedLevel` is intentionally kept on source change — the gen-level shadow value doesn't change with the source.

**Confirmation-gated drift detection** (2026-06-09, fixes spurious `cap L#` badges the user never set — confirmed it was the manual `cap L#` badge, not `bounce L#`):

- **Root cause:** the old in-tick drift detector compared the observed `generatorMode` to `lastSetLevel`, which was set to the commanded level the instant `set_generator_mode` was sent. If the shadow lagged or the firmware ignored a RAISE, the next tick past the 30s settle read `observed < commanded` and stamped a **false `manualCap`** at the old level (sticky — only cleared on power-off or a user raise). The real device needs ~4 min to settle, far longer than 30s, so it misfired routinely.
- **Fix:** two new maps — `confirmedLevel` (the level the shadow has actually been OBSERVED at) + `pendingLevel` (the level last commanded; armed at every command site: execute level cmd/restore, `onUserGenLevel` reduce/revert/target). Drift now compares the observation to `confirmedLevel`, NOT to the command. Flow per ON managed AC: first observation adopts `confirmedLevel` (skipped inside settle); `obs === confirmed` → no change; when `obs` changes: if it matches `pendingLevel` → our command landed → re-confirm with no intent; else → genuine manual change → `manualCap`/`manualTarget`. `confirmedLevel` + `pendingLevel` cleared on power-off (tick block + `onUserPowerOff`).
- **Key design insight:** a command in flight does NOT change the observed level until it lands, so `obs === confirmed` covers the lagging/never-landing case — no false cap, and a never-landing command can't strand detection. This is why the final design compares to the observation rather than "suppress while pending": the first code-review draft suppressed while pending, and a reviewer flagged that a stuck pending would eat a later genuine manual change.

## Per-automation opt-out

`smart_leveling BOOLEAN DEFAULT true` column on `automations` (AC rules only; checkbox in the AC trigger form).

- When **false**: the automation keeps sending `generator_mode` from its preset; the leveler counts the AC's draw (subtracted from budget) but never adjusts or sheds it.
- When **true** + leveler enabled: `stripGenIfLeveled()` removes `generator_mode` from turn-on profiles and all 3 `computeAcDiff` re-enforcement sites.
- **Note:** the opt-out only applies while the rule is **enabled** — a disabled rule means the leveler manages the device.

## Stateful layer & API (`ac-leveler.ts`)

- Config lives in `ac_leveling_config` (single JSONB row; master `enabled` defaults **false**); shed + fan-hold rows are write-through. See [database.md](database.md) for schemas. Behavioral summary of the five tables:
  - `ac_leveling_config` — single row; new fields reach existing rows via the load/save default-merge (no migration needed).
  - `ac_leveling_shed` — leveler-powered-off ACs (NOT manual-off); survives restarts so sheds are restored after a deploy; cleared on restore, user power on/off, automation-driven off, or observed external ON (15s grace).
  - `ac_leveling_fan_hold` — persisted fan holds (`original_fan`/`last_set_fan`) so the staged restore resumes after a deploy; cleared on full restore, user/external fan change, shed, power-off, or leveler disable.
  - `ac_leveling_remembered_level` — warm-restore snapshot (levels ≥ 2 only); written by `rememberStableLevel()`; cleared on reaching the level, manual gen/power change, or shed.
  - `ac_calibration_results` — per-AC measured draw per step (upsert, latest wins); read by `GET /api/ac/calibration` which derives `suggestedFit`.
- The collector builds the tick context in `checkAcLeveling()` (runs after `checkAcTimers()`): device fetch ≤1 per 10s, need tiers, opt-outs → `acLeveler.tick()`.
- **API:** `GET/PUT /api/ac/leveling` (requireAuth) — config + live status: source, measured/limit/budget amps, streaks (incl. `severeOverLimitStreak`), `expectedAmps`, `lastPrediction`, `raiseHoldRemainingMs`, per-AC level / est draw / need tier / caps (`bounceCap`/`bounceRetryBelowAmps`/`restoreBlocked`) / shed / `heldFan`+`fanOriginal`.
- **Tick ordering fixed 2026-06-07:** `execute()` runs BEFORE `buildStatus()`, so the status reflects the same tick's commands (settle window, fresh sheds, expectation). (Previously `buildStatus()` ran first; old tests that ticked twice still pass.)
- Leveler hooks wired from the collector/routes: `onUserGenLevel` (manual intents), `onUserFanChange` (releases fan holds), `onUserPowerOff` (clears warm restore + confirmed/pending levels), `recordShed`, `rememberStableLevel`, `hasFanHold`, plus the `onLevelerFanCommand` dep → `refreshAcFanBaseline`.

## Per-AC calibration (2026-06-07, `ac-calibration.ts` — `AcCalibrator`)

User request: "calibration buttons for grid and gen… choose one or more… test one by one and turn off the others." Same deps/tick pattern as the leveler. Measures each AC's REAL draw at every gen level (fan fixed at 3) and optionally every fan speed 1–7 (measured at max gen level, where the per-level current cap bites least). Takes ~10–18 min per AC.

- Runs on the **currently active source** only (physics — you can't choose; run once on grid and once on gen to fill both columns). Gen steps collect **12 samples vs 6 on grid** (fluctuating voltage).
- Selected ACs (one or more) are tested **one by one with every other AC turned off**; a fresh all-off **baseline** (median, fixed 10s settle) is measured before each AC; step draw = `median(samples) − baseline`.
- **Flow per AC:** prep (all off) → baseline → power-on L1/fan3 + compressor ramp → level sweep (settle + sampling per level) → fan sweep → off → next AC; finally every AC is restored to its snapshotted power/level/fan.
- **Settle timing = floor-then-plateau-with-max-cap** (2026-06-08; user decision, asked: keep the previous settle durations as the FLOOR — never sample sooner — and only extend toward a max when the draw hasn't stabilized): each settle waits at LEAST its floor (ramp `CAL_RAMP_FLOOR_MS` 90s — decoupled from `AC_RAMP_MS` on 2026-06-09 so calibration still samples at the ~90s plateau instead of waiting the live 240s ramp; level `CAL_LEVEL_SETTLE_MS` 20s; fan `CAL_FAN_SETTLE_MS` 15s), then samples as soon as the measured draw **plateaus** (last `CAL_STABLE_READINGS` 4 settle-phase readings within `CAL_STABILITY_BAND_GRID` 0.4A / `CAL_STABILITY_BAND_GEN` 0.8A), or holds out to the **max cap** (`CAL_RAMP_MAX_MS` 300s / `CAL_LEVEL_SETTLE_MAX_MS` 240s / `CAL_FAN_SETTLE_MAX_MS` 30s — ramp/level maxes raised on 2026-06-09 from 180s/120s to let a slow ~4-min ramp fully settle) if it never stabilizes. Implemented via `armSettle(maxMs)` (sets `settleUntil = now + max`, records `settleStartedAt`, clears `settleReadings`), `settleFloorMs()`, `isSettleStable()`, and an early-release collapse at the top of `tick()`; settle-phase readings accumulate in `settleReadings` (separate from measurement `samples`).
- Results upsert into `ac_calibration_results`; least-squares `fitAmpModel()` per device+source is returned as `suggestedFit`. Pure helpers: `buildCalibrationSteps`, `fitAmpModel`, `calMedian`/`calStddev`.
- **Suspension:** while `acCalibrator.isActive()` the collector skips ALL AC automations, AC timers (they stay pending and fire late), and the leveler tick — so calibration turn-offs never record manual-off locks.
- **Aborts** (restore all ACs + keep partial results): source change, power lost, measured > limit − margin (near-limit), TCL failure, user abort endpoint, and ANY user AC control (the routes control endpoint calls `requestAbort("user_control")` — user intent wins).
- **API:** `GET /api/ac/calibration` (status + results + suggestedFit; polled every 3s by `useAcCalibration`), `POST /api/ac/calibration/start` `{deviceIds, includeFan}` (202/409), `POST /api/ac/calibration/abort`. The UI Apply button writes a fit into `ampModels`/`genAmpModels` via the normal leveling config save (no special endpoint).

## UI ("Smart AC Leveling" collapsible section in the bell modal, admin-only)

- Master toggle (auto-saves the full draft).
- Grid/gen/margin/raise-buffer/comfort inputs (5-col limits grid).
- Priority reorder with per-AC amp model inputs — Grid base/step pair in the device row, Gen pair in the sub-row next to the boost inputs — plus min-level boost inputs ("Min L_ when outdoor ≥ _°C") and live badges: shed / opt-out / cap / target / min, need-tier dot, Δ°C readout, orange "bounce L{n}" / "restore wait".
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
| Source detection threshold | 0.1A | Line counts as active above this; larger line wins |
| `AC_RAMP_MS` | **240s** (was 30s → 90s 2026-06-07 → 240s 2026-06-09) | Turn-on/changeover compressor ramp window; ramping AC's estimate not subtracted from measured |
| `SETTLE_MS` | 30s | Post-command settle window; raises blocked inside it (unchanged 2026-06-09 — growing it would freeze the loop) |
| `REDUCE_STREAK` | 5 readings (~25s) | Mild over-limit (≤ limit + 1A) reactive-reduce gate |
| `REDUCE_STREAK_SEVERE` | 2 readings | Severe over-limit (> limit + 1A) reactive-reduce gate |
| `OVER_LIMIT_SEVERE_AMPS` | 1A | Mild/severe boundary above the raw limit |
| Headroom streak | 6 readings (~30s) | Consecutive headroom readings required for raises/restores |
| Headroom band | `measured ≤ limit − margin` | Un-buffered on purpose (fan restores recover on real headroom) |
| nonAcLoad smoothing | median of last 4 readings | Measured-amps input |
| `STALE_POWER_MS` | 15s | No ESP reading for 15s → source "none" |
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
| Gen level ranges | Najat 0–6; Abdu/Abdullah 0–3 | 0 = unrestricted (never left at 0 when managed) |
| Fan-savings heuristic (not implemented) | ~0.5A × reducible count | Threshold for the skip-fan-attempt follow-up knob |
| `CAL_RAMP_FLOOR_MS` | 90s (decoupled from `AC_RAMP_MS` 2026-06-09) | Calibration ramp settle floor |
| `CAL_RAMP_MAX_MS` | **300s** (was 180s before 2026-06-09) | Calibration ramp settle max cap |
| `CAL_LEVEL_SETTLE_MS` | 20s | Calibration level-step settle floor |
| `CAL_LEVEL_SETTLE_MAX_MS` | **240s** (was 120s before 2026-06-09) | Calibration level-step settle max cap |
| `CAL_FAN_SETTLE_MS` | 15s | Calibration fan-step settle floor |
| `CAL_FAN_SETTLE_MAX_MS` | 30s | Calibration fan-step settle max cap |
| `CAL_STABLE_READINGS` | 4 | Settle-phase readings that must plateau for early release |
| `CAL_STABILITY_BAND_GRID` / `_GEN` | 0.4A / 0.8A | Plateau band per source |
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

## Gotchas & test notes

- **`restoreLastState` stale gen level:** TCL last-state restore re-applies a stale `generatorMode` on power-on; the allocator corrects level-0/below-floor immediately (ungated); the leveler's own restore bypasses it via `executeAcAction({power:1, generator_mode:floor})`. Restore is skipped if a manual-off lock exists (lock wins, shed cleared).
- **Streaks are per ESP reading, not per tick.** Both streaks reset after reductions (review fix — stale pre-shed headroom could restore prematurely).
- **Control route ordering:** the manual-off lock is recorded BEFORE clearing a shed so a restore can't slip between.
- **`seedDraft()` not-dirty gotcha** (see UI section). Same applies to gen models copied from grid.
- **Test gotcha (fake timers):** leveler/calibration tests must re-feed a power reading after every `advanceTimersByTime` — the 15s `STALE_POWER_MS` check otherwise reads source "none" (calibration aborts "power_lost"; leveler ticks return early). Predictive tests use the `genReadings()` helper; 2026-06-09 added a `gridReadings()` helper.
- **Test gotcha (gating):** a fresh power reading sets source none→gen → `forceEvaluate = true`, so the FIRST over-limit tick sheds proactively regardless of streak; collector gate tests must prime a tick first (feed 1 headroom reading + tick) to isolate the reactive streak gate.
- **Test gotcha (calibration settle):** settle-phase readings go to `settleReadings` (not `samples`), so a step needs a collapse tick then a sample tick — the test `settleStep()` helper does both; the baseline (off, 10s) is unchanged.
- **Test harness details (`collector.test.ts`):** the `tclCloud` mock includes `getDeviceState` (returns null by default — fan tracking skips the tick); fan tests use fake timers at 07:30 Baghdad + the `acFanRule()` fixture; `createPool()` exposes the `fanHolds` map for pre-seeding `ac_leveling_fan_hold`. Mock devices without `fanSpeed` → snapshot `fanSpeed: null` → not fan-reducible (the `?? null` coercion in the leveler's snapshot builder is load-bearing for legacy leveling tests; same idea as the allocator `ac()` test helper defaulting `fanSpeed: 1`, which keeps legacy shed tests valid).
- **2026-06-09 test re-tiering:** new `collector.test.ts` describe "confirmation-gated drift + source change" (6 cases: lagging-raise-no-cap, confirm-then-user-reduce-caps, stale-high-no-target, cap-release-onto-Grid, cap-kept-onto-Gen, ramp-re-arm-on-changeover). Fake-timer literals re-tiered for the new constants: ramp test 35_000→185_000 (straddle 240s), turn-on hold 65_000→160_000 (straddle 270s), restore-bounce 91_000→241_000. `ac-calibration.test.ts` imports `CAL_RAMP_FLOOR_MS` (replacing `AC_RAMP_MS` ramp-floor refs). No raw constant assertions anywhere — all timing tests use relative `advanceTimersByTime`.
- **Test coverage map:** `ac-leveling.test.ts` (84 tests) — even-spread delta-ordered fill, min-level boosts/floors, need/manual caps, soft need caps, fan-reduce-before-shed + staged fan restore, reduce gates (4-reading legacy + asymmetric severe-before-mild), proactive reduce, shed-by-least-delta with top-priority protection, restore-by-most-delta, restore-with-reduction (floor-based feasibility, reductions under the raise gate, won't-fit leaves everyone untouched, one-per-call, manualTarget reduced too), raise-hold gate (blocks raises/restores, never reductions), bounce caps (ceiling in both fill passes, budget redirected, manualTarget deferred, boost floor wins, restore-blocked filter), warm restore, raise buffer suite, draw model. `collector.test.ts` — leveling integration (shed guards, generator_mode stripping, shed/restore plumbing, outdoor-boost floor correction), leveler fan holds, predictive control (restore-with-reduction e2e with command ordering, nonAcLoad freeze anti-spiral + expiry, expectedAmps/lastPrediction status, 240s ramp exclusion, effect-confirmation hold incl. early release + 270s turn-on hold, source-change invalidation, calibration suspension), bounce detection (cap-and-stay-quiet e2e, redirect, load-drop retry at observed cost, clears, restore-bounce block/retry, boost release at exactly threshold−1), asymmetric gating (mild 16A needs 5 readings, 4 doesn't; severe 18A sheds in 2), warm restore, confirmation-gated drift + source change. `ac-calibration.test.ts` — pure helpers (buildCalibrationSteps, fitAmpModel least-squares, median/stddev, gen-vs-grid sample counts) + state machine (full sweep with others-off/baseline/floor-then-plateau early release/no-sample-before-floor gating, one-by-one multi-device, source-change + user aborts with restore, partial results kept, start validation, ramp holds to the max cap when the draw never stabilizes).
- **Milestone test counts:** 2026-06-08 morning batch: 211 server tests green. Raise-buffer ship: 220 green. 2026-06-09 batch: 226 green, server `tsc` + client `tsc -b` clean (the memory note recorded that batch as not yet deployed at write time).
