---
type: Reference
title: 'TCL AC Cloud Integration (tcl-cloud.ts)'
description: 'Related docs: automation/range/hysteresis logic → ac-automations.md(ac-automations.md); Smart AC Leveling (generator-mode budget controller) → ac-leveling.md(ac-leveling.md); AC widget UI, presets UI, visual design →…'
tags: [home, dashboard, claude-code, current]
maintainer: claude-code
timestamp: 2026-07-27
---

<!-- Tier-3 agent doc. Loaded on demand via CLAUDE.md / AGENTS.md routing table. -->
# TCL AC Cloud Integration (tcl-cloud.ts)

**TL;DR:** Four TCL split ACs (Mom, Abdu, Abdullah, guest) are controlled through a reverse-engineered TCL Home cloud client in `server/src/tcl-cloud.ts`. Auth is a 4-step chain ending in temporary AWS credentials; device state is read from the AWS IoT Shadow (manual SigV4 GET works), but control MUST publish via the `@aws-sdk/client-iot-data-plane` SDK (manual SigV4 publish fails with 403). `ac-capabilities.ts` derives each physical unit's UI/validation contract from its own live shadow and TCL capability list. Protocol families still select wire encodings, never visible features. TCL's `isOnline` flag is unreliable — the shadow fetch is the real connectivity test.

Related docs: automation/range/hysteresis logic → [ac-automations.md](ac-automations.md); Smart AC Leveling (generator-mode budget controller) → [ac-leveling.md](ac-leveling.md); AC widget UI, presets UI, visual design → [frontend.md](frontend.md).

## Auth Chain (4 steps)

Auth chain summary: TCL login → token refresh (saasToken + cognitoToken) → AWS Cognito credentials. Env vars on the server: `TCL_USERNAME`, `TCL_PASSWORD` (names only; values live in the VPS `.env`).

### 1. Login
- `POST https://pa.account.tcl.com/account/login?clientId=54148614`
<!-- okf-allow: describes the protocol's password handling; no value here (values live in the VPS .env) -->
- Password: MD5-hashed before sending.
- **Critical:** Field name is `username` (NOT `account`).
- **Critical:** Requires Android emulation fields in the body: `equipment`, `osType: "Android"`, `clientVersion`, `deviceModel`, etc.
- **Critical:** Requires headers: `th_platform: android`, `th_version`, `th_appbuild`, `User-Agent: Android`.
- Returns: `token`, `refreshtoken`, `user.countryAbbr`, `user.username`.
- Login rejects without the Android app emulation (headers + body fields).

### 2. Get Cloud URLs (optional, can hardcode)
- `POST https://prod-center.aws.tcljd.com/v3/global/cloud_url_get`
- Body: `{ ssoId: username, ssoToken: token }`
- Returns: `cloud_url`, `device_url`, `cloud_region`, `identity_pool_id`.
- For Iraq/ME accounts, the regional base API URL is `https://prod-eu.aws.tcljd.com`.

### 3. Refresh Tokens
- `POST {baseApiUrl}/v3/auth/refresh_tokens`
- Body: `{ userId: username, ssoToken: token, appId: "wx6e1af3fa84fbe523" }`
- Returns: `saasToken`, `cognitoToken`, `cognitoId`, `mqttEndpoint`.

### 4. AWS Credentials
- `POST https://cognito-identity.{region}.amazonaws.com/`
- Uses `cognitoId` directly as `IdentityId` (no `GetId` call needed).
- Region extracted from `mqttEndpoint` (e.g., `eu-central-1`).
- Returns: `accessKeyId`, `secretKey`, `sessionToken` (temporary AWS creds).

### Credential persistence & recovery
- Credentials cached/persisted to `/app/data/tcl-credentials.json` (same Docker volume as the Xiaomi credentials). Last AC state cached in `/app/data/ac-last-state.json`.
- Token auto-refresh: the `saasToken` JWT expiry is checked; re-login happens if the auth token expired.
- **Remedy of last resort:** if all AC controls fail with 403 even after the retry, delete `/app/data/tcl-credentials.json` and restart the container to force a completely fresh login chain.

## Device State via IoT Shadow

### List Devices
- `POST {baseApiUrl}/v3/central/control/user_groups/get`
- Signed headers: MD5 of `timestamp + nonce + saasToken`.
- Returns groups containing devices.
- **Gotcha:** Devices appear across multiple groups = duplicates. Use a `Set<string>` to dedup.
- **Gotcha:** The `identifiers` array only contains `powerSwitch`, NOT the full state — full state requires the shadow read.

### Read Full State
- AWS IoT `GetThingShadow` via REST: `GET https://data-ats.iot.{region}.amazonaws.com/things/{deviceId}/shadow`
- Requires AWS SigV4 request signing — **manual SigV4 works fine for this GET** (only publish needs the SDK; see Control below).
- Full state is in `state.reported`.

### `isOnline` flag is UNRELIABLE (fixed 2026-05-13)
- TCL Cloud's device list API (`user_groups/get`) can return `isOnline: false`/`0`/absent even when devices are fully reachable via AWS IoT shadow and responding to commands. Historically the field returned the string `"1"` (not boolean, not number, not `"online"`), but now sometimes returns other falsy values.
- **Old bug:** code guarded the shadow fetch with `if (online && this.awsCreds)`, so when `isOnline` was false no shadow was fetched → all properties defaulted → dashboard showed all 3 ACs as "offline" with no real state.
- **Fix:** `fetchDevices()` always attempts the shadow fetch (only requires `this.awsCreds`). If the shadow returns FRESH data, the device is treated as online regardless of TCL's flag.
- **Why:** TCL's `isOnline` reflects their cloud's perception, not actual IoT reachability. The AWS IoT shadow is the authoritative source for device state.
- **Rule:** Never gate device functionality solely on TCL's `isOnline` flag. The shadow fetch is the real connectivity test.
- **Shadow-freshness refinement (2026-06-10):** the AWS IoT shadow document PERSISTS the last-reported state forever — it never clears when the AC loses power. So "any shadow data → online" reported a blacked-out AC as online + power=on (frozen pre-outage state) indefinitely. `getThingShadow` now also returns `reportedAt` = newest `metadata.reported.<field>.timestamp` (epoch **seconds** → ms via `latestReportedAtMs()`), and `deviceOnline()` requires the shadow to be fresh within `SHADOW_STALE_MS` (**10 min**, generous so a quietly-reporting AC doesn't flap). `online = tclOnline || (hasShadow && fresh)`; missing metadata falls back to the legacy has-shadow behavior. `AcDevice.lastSeenAt` carries the timestamp; the AC widget shows "last seen HH:MM" when offline. **Display-only** — no server path (leveler/automations/commands) gates on `isOnline`, so this changed nothing functional. `SHADOW_STALE_MS` may need tuning to the real report cadence. Pure helpers `latestReportedAtMs`/`deviceOnline` unit-tested in `tcl-cloud.test.ts`.

### Shadow metadata: isolated vs full-state reports (probe 2026-09-27)

A read-only probe of the four raw shadows (two snapshots 331 s apart, 15:28Z and 15:33Z) established how the TCL firmware reports:

- **Every reported field has its own `metadata.reported.<field>.timestamp`** (epoch SECONDS, assigned when the update REACHES AWS; arrays such as `capabilities` carry one stamp per element; `errorCode: []` carries none).
- **A power OFF is an ISOLATED report**: only `powerSwitch` is re-stamped (Najat's shed at 15:26:11Z: 1 field in that second). The largest incremental cluster seen anywhere was 3 fields.
- **A power ON is a FULL-STATE report**: ~45-55 fields share one timestamp, spread over 1-2 s (Najat 15:21:59-15:22:00, 54 fields; 15:33:29, 53 fields). A reconnect / power-loss restart looks the same (Abdullah 14:22:14, 46 fields after a changeover restart; Abdu 14:22:20-22, 46; guest 13:44:23-25, 50).
- Live incremental changes stamp only the changed fields; there is **no periodic heartbeat** that re-stamps `powerSwitch`. A desired `powerSwitch` publish to a unit already in that state re-stamps it alone (Abdullah 15:26:11, value unchanged 1).
- `desired` mirrors `reported` within ~1 s and **no standing `state.delta` was ever seen**, so "AWS re-delivers a stale desired power" is ruled out as a cause of self-ON.

Server side (`tcl-cloud.ts`): `getThingShadow` also returns, and `fetchDevices` puts on every `AcDevice`, three fields from the pure `powerReportInfo()`:
- `powerReportedAt`: ms of the second `powerSwitch` was last reported in (null without metadata);
- `powerReportCohort`: how many fields carry a stamp within `POWER_REPORT_COHORT_WINDOW_S` = 2 s of it, itself included;
- `fullStateReportAt`: the earliest second (ms) of the NEWEST full-state cluster among the other fields (>= `FULL_STATE_MIN_FIELDS` = 20 fields within ±2 s of each other), null if none.

The pure predicate `isolatedPowerOffAfter(dev, sinceMs)` (`sinceMs` = when our power ON was PUBLISHED) is true only when power=false AND `fullStateReportAt >= floor(sinceMs to the second)` (our ON's own dump, in the send's second or later) AND `powerReportedAt > fullStateReportAt` (the OFF came after that dump) AND `powerReportCohort <= ISOLATED_POWER_REPORT_MAX_COHORT` (10; not itself part of a dump). **Why ORDER and not "stamped after the send":** AWS stamps on arrival, so a late-delivered off can carry a stamp after a send it physically preceded, but one unit's reports arrive in order over its single MQTT connection, so "our ON's dump, then a lone OFF" is causal. Thresholds: isolated reports were 1-3 fields and every dump 45-55, so 10 and 20 sit far from both populations; 20 is under half the smallest dump, leaving room for fields that re-stamp while the unit runs (Najat's 15:21:59 dump still held all 55 fields six minutes later). Consumers: the collector's observed-off fast path and its `recordDeclinedRestore` ([ac-automations.md](ac-automations.md) → Manual-off locks), and the leveler's `restore_declined` (ac-leveling SKILL invariant 81), each with the restart voids on top. Unit tests: `tcl-cloud.test.ts` "shadow power-report metadata (causal: ON dump, then isolated OFF)".

Known limits: a human off within ~2 s of the ON dump is counted inside it and reads as not isolated (old behaviour: reversed/resent); a reconnect dump that happens in the same second as our send and is followed by a lone OFF would pass (needs a coincident reconnect); clock skew between the server and AWS of about a second can move the "send's second" boundary either way (a real dump within a second of the send may read as pre-send, which is the conservative side).

### Polling policy
- No continuous polling of TCL Cloud. Device state is fetched on-demand via `/api/ac/devices` (the frontend polls that endpoint every 10s). Control commands go via AWS IoT shadow publish.

## Control & Publish

### Set State (Control)
- AWS IoT publish to topic `$aws/things/{deviceId}/shadow/update` (qos=1).
- Body: `{ state: { desired: { propertyName: value } } }`
- **Must use `@aws-sdk/client-iot-data-plane` `PublishCommand`** — manual SigV4 signing for the `/topics/...` REST endpoint (POST) fails with 403, likely a URL-encoding issue with the `$` in the topic path. This was debugged extensively — even fresh credentials get 403 with manual signing. The SDK handles the `$` in topic paths correctly. (Shadow read via manual SigV4 is fine; only publish needs the SDK.)
- Dependency: `@aws-sdk/client-iot-data-plane` is required for IoT publish (AC control).

### UI command verify-resend (2026-06-11, 5s × 3)

Najat's firmware routinely ACCEPTS a command (IoT publish OK) and never applies it — the shadow keeps reporting the pre-command value. The root cause is the firmware itself, so the fix is a bounded confirm-or-resend layer for **UI commands** (`routes.ts` control endpoint calls `sendControlVerified` instead of `sendControl`):

- Captures the pre-command shadow (`getThingShadow`), sends normally, then re-checks the reported shadow every `CONTROL_VERIFY_DELAY_MS` **5s**; while it still shows the PRE-command value the desired payload is re-published, up to `CONTROL_VERIFY_MAX_RESENDS` **3** times (then a warn).
- An observed move to a **third value** (neither pre nor commanded) stops the loop — a genuine remote/manual change wins.
- Re-sends publish the raw desired payload via `publishWithRetry` — they bypass `sendControl` (a power-on retry must not re-run `restoreLastState`) and the route hooks (no duplicate manual-intent recording). Fan re-sends at 5/10/15s sit inside the automation's 15s `AC_FAN_SETTLE_MS` drift guard.
- `controlShadowPayload()` maps command → exact desired props per model (non-Najat `set_fan_speed` verifies the `windSpeed`/`silenceSwitch`/`turbo` triple; swing verifies switch + direction).
- **Excluded** (each already has its own retry/owner): `set_generator_mode` (leveler `pendingSendCounts`/unreachable machinery — a second retry path would corrupt the counts), `set_beep` (sticky beep-off enforcement), `set_fan_speed 0` (hands fan control back to the range automation, which re-enforces itself).
- Other paths keep their existing coverage: automation profiles → 5s diff re-enforcement; leveler gen levels/fan holds → their own confirm-or-resend. Tests: `tcl-cloud.test.ts` "sendControlVerified" suite (the `controlVerifyDelay` protected method is the no-real-waits test seam; `lastControlVerify` holds the in-flight loop for awaiting).

### Last-write-wins verifiers (2026-08-08 — a binary `set_power` double-tap cycled Najat)

**Power is BINARY**, so when an OFF and an ON verify loop overlapped (user off, second tap on 3 s later — the flaky-firmware double-tap), each verifier read the other's landed value as "my command not applied" and re-sent: off→on→off→on, 3 re-sends each over ~24 s, physically cycling the compressor while the dashboard showed nothing. The "third value — external change wins" escape can never fire for a binary field (the only other value IS the pre-command value). Now `sendControlVerified` keys a `controlGenerations` generation per `(deviceId, command)`, bumped on every call (even a no-verify command like fan Auto); a verify loop captures its generation at send time and the moment a newer verified send of the SAME field bumps it, the older verifier stops with `superseded by a newer command — verify stopped`. An EXTERNAL opposing change during a binary verify remains indistinguishable from "not applied" (still bounded by the 3 re-sends) — the fix removes only the ours-vs-ours fight, not the general binary-verify ambiguity. The observed-off half of the same incident (the shadow-lag grace re-arming forever on a remote off) is in [ac-automations.md](ac-automations.md) → Manual-off locks.

**A protective OFF supersedes a pending dashboard power command: every publish guarded, the outcome reflects the final generation (2026-09-27).** Live 2026-09-26 14:26Z: the user's dashboard ON started a verifier, the leveler shed the room at ~14:26:41, and the verifier re-sent ON at 14:26:43.8 (the off confirmed 14:26:48.9). Two rules now hold for every dashboard command sent through `sendControlVerified`:
- **Who supersedes.** `sendControlVerified` claims a `(deviceId, command)` generation (`controlClaimedBy` = "user"); `executeAcAction` with `power: 0` (leveler shed, automation off, timer off, calibration) claims it too ("system"). **Only an OFF does**: a raw ON (a leveler restore, an automation turn-on) never silences the user's own OFF, whose lock is already recorded and whose verifier must keep re-sending it (manual wins).
- **RULE A, every publish is guarded.** Every publish a dashboard command can make goes through `publishControl`, a non-async wrapper that evaluates `stillCurrent()` and starts the publish in the same tick, after every token/re-auth await: the initial send (all `sendControl` branches, including the 403 re-auth retry), the saved-state restore that follows a power ON (`restoreLastState` → `publishRestorableState`, both halves of a CHSD fan split), and every verifier resend (`publishWithRetry`, including its re-auth retry). A losing publish throws `ControlSupersededError` and nothing goes out; a superseded restore stops silently (logged); a superseded resend ends the verify loop. The loop still stops early after its delay and after its shadow read.
- **RULE B, the outcome is the final generation.** Before `sendControlVerified` returns it re-checks the generation: if a newer command claimed the field at ANY point, before or after this command's own publish (e.g. a leveler OFF while the ON's saved-state restore waited), it returns **`"superseded"`** (the newer claim was a raw OFF) or **`"superseded_by_user"`** (a newer dashboard tap), and starts no verify loop. Otherwise `"sent"`.
- **The caller's bookkeeping runs in the final-check tick.** `sendControlVerified(deviceId, command, value, onSent?)` invokes the caller's SYNCHRONOUS `onSent` callback immediately after the final "still current" check passes, with no await in between, and never for a superseded outcome. The control route passes its post-send hooks as that callback (`onUserPowerOffSent`, and for a power ON the leveler's `onUserPowerOn`), because acting after awaiting the result left a microtask gap in which a newer leveler OFF could claim the field and the older ON's `onUserPowerOn` would clear its fresh shed. The v2 controller's `onUserPowerOn` now does ALL its in-memory work synchronously, before its first await (shed bar, cut-share revoke, ramp, start baseline, pending ON, load-add clock, external-ON shield, and `clearShed`'s in-memory half), and awaits only the shed-row DELETE, as its last statement; the route awaits that promise afterwards. So in that gap case the ON answers 200: it was sent and booked first, and the leveler OFF is a later re-shed on top of it. A cloud double that never calls `onSent` falls back to the old after-await order (the real `TclCloud` always calls it on "sent"). v1's `onUserPowerOn` was not reordered (rollback-only).
- **The control route** treats both superseded outcomes as NOT SENT: none of the post-send hooks run (no `onUserPowerOn`, so the leveler's newer shed and its persistent row and the collector's shed guard stay intact; no off-credit promotion; no fan/swing/beep/gen hooks), it logs a warning, and answers **409** `{ error: "superseded", message }`. The message names Smart AC Leveling only for a dashboard ON lost to a raw OFF ("Not sent: Smart AC Leveling switched this AC off at the same moment (overload). It will be restored automatically when there is room."); every other case is neutral ("Not sent: a newer command for this AC was sent at the same moment."). The claim-before-send lock release of a superseded ON deliberately STAYS released (the user's intent is ON; the leveler restores a shed room with no lock when the budget allows). A superseded OFF keeps its manual-off lock.
- **The dashboard's AC card** shows a refused power command's reason as a red line under the power button for 10 s (it used to revert silently); see [frontend.md](frontend.md).
- **Await audit** (every await on the dashboard path and how it is covered). Caller side (the control route): `validateControlLive`, the lock claim/record and `onUserPowerOff` all precede the send (intent before publish, unchanged); `await cloud.sendControlVerified(...)` is covered by `onSent` (the ON/OFF bookkeeping runs in the check's tick, so nothing after the await acts on a stale "sent"); `await powerOnBookkeeping` only awaits the shed-row DELETE of state already claimed; the remaining post-send hooks (gen level, fan, swing, beep) are not contested by any system claim (only a raw OFF claims, and only `set_power`). Cloud side: `sendControlVerified`: the pre-state `getThingShadow` (guard at the later publish) and `sendControl` (RULE B re-check after it). `sendControl`, every branch: `ensureValidTokens` and the 403 re-auth `ensureValidTokens` (guard evaluated after them, inside `publishControl`), the publish itself, and `restoreLastState` (its 1 s wait, its main publish, `profileSplitDelay`, its fan publish: each publish guarded). Verify loop: `controlVerifyDelay` and `getThingShadow` (early-stop checks after each) and `publishWithRetry` (its `ensureValidTokens` and re-auth `ensureValidTokens`, both before a guarded publish).
- **Residuals:** (1) two publishes that both START in the same tick go through the AWS SDK's own async pipeline (credential resolution, signing) before reaching the network, so their wire order is not guaranteed by the guard; sub-millisecond, and the verify loops still resolve it last-write-wins. (2) "Sent then superseded" (RULE B after this command's own publish went out) still answers "Not sent", although the `powerSwitch` publish did reach the cloud for that moment; the newer OFF follows it. (3) The system message names Smart AC Leveling, though a raw OFF can also come from an automation or a timer. (4) Persistence order: the shed-row DELETE issued by a user ON and a leveler re-shed's INSERT moments later travel on possibly different pool connections, so their order in the table is not guaranteed; the in-memory shed set (what every runtime guard reads) is always right, and the row only matters across a restart. This is the pre-existing `clearShed`/`recordShed` pattern, not new here.

Whether the reducer may re-shed a room a human switched on seconds earlier is unchanged policy (ac-leveling invariants 43/65). Tests: `tcl-cloud.test.ts` "dashboard power command: every publish guarded, outcome reflects the final generation", "the dashboard power command is checked AT the publish boundary", "a raw power command during the dashboard command's INITIAL shadow read", "a raw power command supersedes a pending set_power verifier"; route: `control-superseded.test.ts` (incl. "the caller-side handoff (round 6)"); `leveling/controller.test.ts` "onUserPowerOn claims its state synchronously (round 6)".

### Retry-on-403 and the silent-death gotcha
- `sendControl` has retry-on-403 logic: clears creds (`tokenData = null`), re-auths, retries once.
- **Critical gotcha (found 2026-05-01):** the 403 retry sets `tokenData = null` BEFORE calling `ensureValidTokens()`. If the re-auth fails (network blip, TCL server down), `tokenData` stays null → `isReady()` returns false **permanently** → all AC automations silently stop forever with zero log output.
- **Auto-recovery:** the collector attempts `tclCloud.init()` every 60s whenever `isReady()` is false.

### Per-unit capability registry and control validation

`ac-capabilities.ts` is the authority for the controls exposed by `/api/ac/devices` and accepted by `POST /api/ac/devices/:id/control`. TCL reuses shadow schemas and can publish writable-looking placeholders for hardware the physical unit does not have, so property presence alone does **not** prove support. The four household IDs have an explicit verified-feature allowlist; a control is exposed only when the physical-ID policy allows it and its live property/capability is present. Exact model documentation, TCL Home controls, and confirmed command behavior are discovery evidence. Unsupported/unverified controls are omitted. Known but temporarily mode-incompatible controls remain present with `available:false` and a reason.

The route populates the device cache before validation and returns 404 for an unknown device, 400 for an unknown/unsupported command or invalid value, and 409 for a supported feature that is currently unavailable. Accepted families include the legacy commands plus AI Eco, Gentle Breeze/Soft Wind, Healthy/Ion, Fresh Air strength, Drying/Anti-mildew, Self Clean, light sensing, and 8°C heating. The backend then resolves the verified command to the exact per-protocol payload. `validateControlLive` re-reads the live shadow before validating; if that read fails it resets the AWS credential state, re-auths, and retries once, then degrades to the device's cached capabilities — **except `set_self_clean=1`, which fails closed with 503** rather than authorize Self Clean's `powerSwitch:0` shutdown (and the manual-off lock the route records before the send) from a possibly-stale cache. Stopping a clean cycle (`value 0`) is state-independent and still uses the cached path.

Starting Self Clean first records the same persistent manual-off protection as an explicit user OFF, then sends `{powerSwitch:0,selfClean:1}`. This prevents normal automations or leveling from powering the room back on during maintenance. Self Clean is intentionally absent from saved state and presets.

Stable policy is keyed by TCL ID: Mom `DHihohFAAAE` order 1, Abdu `CA5IMhFAAAE` order 2, Abdullah `Cy3aihFAAAE` order 3, guest `DlXqDBFAAAE` order 4. Guest allows generator values 0–6; the other three allow 0–3.

Known negative evidence is recorded in the same physical-ID registry. In particular, Abdu's shadow contains `softWind` and `newWindSwitch` placeholders, but his unit has neither Gentle Breeze nor Fresh Air, so neither control is exposed or accepted. Guest's exact TAC-24CHSD/MAV specification verifies Gentle Breeze, ionic/UVC air treatment, Self Clean, and six ampere-control steps; those still require their live cloud properties before they appear.

**Adding a new TCL id — the extension contract.** A new physical unit needs BOTH:
1. A `DEVICE_POLICIES` row (`displayName`/`displayOrder`/`maxGeneratorLevel`/`levelingEligible`/`powerCycleRestoreEligible`). **`levelingEligible` is a physical-wiring fact — only an AC on the ESP-measured line may be `true`.** **`powerCycleRestoreEligible` is likewise a positive physical-wiring fact — only a verified grid-only line (currently `DlXqDBFAAAE`/guest alone) may be `true`; it is never inferred from the absence of leveling.** An unknown id falls back to `DEFAULT_POLICY` (`levelingEligible: false`, `powerCycleRestoreEligible: false`, `maxGeneratorLevel: 3`), so a future cloud device stays off the leveling line, is refused a last-state restore, and is clamped to L3 until its line is explicitly qualified.
2. A `VERIFIED_CONTROL_FEATURES` set naming the advanced features that unit actually has.

An id WITHOUT a `VERIFIED_CONTROL_FEATURES` entry keeps plain property-presence discovery — `verifiedForDevice` returns `true` for every feature, so advanced controls are fail-OPEN. That is deliberate for protocol probes and test fixtures (a device we don't yet know can still be evaluated), and it is exactly why the four real household units must be listed: only the allowlist stops a shared-schema placeholder from being exposed as a physical control.

### TAC-12CHSD fan-speed command mapping (Abdu/Abdullah)
- Level 1 sends `{silenceSwitch:1, turbo:0, windSpeed:0}`.
- Level 7 sends `{turbo:1, silenceSwitch:0, windSpeed:0}`.
- Other levels send `{windSpeed:N, silenceSwitch:0, turbo:0}`.
- Shadow read mapping: `silenceSwitch === 1` → fanSpeed=1, `turbo === 1` → fanSpeed=7, else → `windSpeed`.

### Last state restore
- On power-on, the backend restores all saved properties (mode, temp, fan, swing, etc.) from `/app/data/ac-last-state.json`. State is saved on every shadow poll while the device is on (per device ID).
- On a **manual** power-on (`sendControl("set_power", 1)` from the UI), the backend sends `powerSwitch: 1`, waits 1s, then publishes all saved properties from last state — **fan block split off into its own update on TAC-12CHSD** (see the fan-block quirk below; the saved set always contains `workMode`, so before 2026-07-27 this path lost the fan on every manual power-on).
- `executeAcAction` with power=1 + profile does NOT use `sendControl`/`restoreLastState` — it directly publishes power-on via `publishWithRetry`, waits 3s, then sends the automation's profile. This prevents last-state vs automation-profile conflicts.
- `executeAcAction` with power=1 but NO profile (e.g., a timer without a preset) falls back to `sendControl("set_power", 1)`, which restores last state.
- On an actual source transition, the collector arms a last-state restore **only for a device that is BOTH outside every enabled automation profile AND positively `powerCycleRestoreEligible`** — currently **guest alone**. The gate is a positive per-device wiring fact, never inferred from "not leveling-eligible": Abdullah is on the ESP line, so Smart AC Leveling owns his `generatorMode`/fan and clamps them to floors across a changeover; a frozen republish would fight that clamp, so he is excluded even without a rule. An unknown future id (`DEFAULT_POLICY.powerCycleRestoreEligible: false`) is refused too, so an AC whose line the leveler may yet own can't be armed by default. `preparePowerCycleRestore()` freezes the pre-event snapshot and, as defense in depth, itself refuses any non-restore-eligible id. The boot/cold-start `source none → X` event **never** arms — it would freeze a stale disk snapshot and revert a running unit after every deploy. Normal ON-shadow saving is suspended so firmware reboot defaults cannot overwrite it. The first strictly post-event ON report re-publishes the frozen state and keeps it frozen until the shadow confirms it (up to three re-sends). Waiting for grid power has no short timeout: a grid-only AC may remain off for hours. **Any direct user command (`sendControlVerified`) or verified preset (`executeAcActionVerified`) cancels a pending restore** before its first publish — the user's new state is now the one to remember, so the cancellation also un-freezes state-save and is logged LOUDLY. `maybeRestorePowerCycleState` re-checks that the pending entry still matches the object it captured immediately before each publish, so a cancellation that lands mid-poll cannot revert the user's value; the residual mid-network-call window is healed by the confirm-or-resend loops (~5s). Background automation enforcement (`executeAcAction` default options) is not user intent and leaves a pending restore alone. An active automation instead re-applies its own profile and does not arm this restore. ESP gaps/leveler-only events do not arm a restore for a separate line.
- **Accepted residual (reboot-echo freshness):** the fan-enforcement `initializationPending` freshness guard keys on the device's *global* `lastSeenAt` (per-property report timestamps are not threaded), so in a rare partial-report window a pre-cycle fan value can coincidentally clear the marker — accepted because the worst case equals the documented reboot-echo trade-off (one reverted remote fan change).
- Saved props per model:
  - CHSA-family: `workMode, targetTemperature, screen, sleep, verticalWind, horizontalWind, verticalDirection, horizontalDirection, generatorMode, windSpeed7Gear, newWindSwitch, newWindAutoSwitch, newWindStrength, ECO, AIECOSwitch, turbo, softWind, healthy, antiMoldew, lightSense, beepSwitch, eightAddHot`
  - CHSD-family: `workMode, targetTemperature, screen, sleep, verticalSwitch, horizontalSwitch, verticalDirection, horizontalDirection, generatorMode, windSpeed, ECO, turbo, silenceSwitch, AIECOSwitch, softWind, healthy, newWindSwitch, newWindAutoSwitch, newWindStrength, antiMoldew, lightSense, beepSwitch, eightAddHot`
- One-shot maintenance actions such as Self Clean are never saved or restored automatically.

## AC Models & Shadow Properties

> **⚠ Capacity correction (2026-07-23):** the `model` strings below are PROTOCOL-FAMILY labels inferred from shadow properties — their capacity digits are WRONG for this household. Nameplate reality (user-verified + meter evidence): **Abdu = 2-ton** (advertised 4–8A; calibration fan sweep hit 7.94A; likely a TAC-24-class CHSD unit), **Abdullah & Najat = 1-ton** (2–6A; never observed above ~4.5A). Najat's "TAC-24CHSA" label just means she speaks the CHSA protocol (7-gear fan, `autoGeneratorMode`). All protocol forks stay keyed on the `model` field (correct for BEHAVIOR); never use it to infer capacity/amps — capacity lives in the leveling amp models and `ac_leveling_costs`.

Two broad protocol families have different wire property names. Detection: presence of `autoGeneratorMode` in the shadow → TAC-24CHSA encoding; absence → TAC-12CHSD encoding. The `model` field remains on `AcDevice` for compatibility and protocol forks only. **Never use it to decide UI features or physical capacity.** The client renders only `AcDevice.capabilities`, derived from that individual live shadow.

### Common properties (shadow `state.reported`)
| Property | Type | Values |
|----------|------|--------|
| `powerSwitch` | int | 0=off, 1=on |
| `targetTemperature` | int/float | 16–36 (CHSA: 0.5 step, CHSD: 1 step) |
| `currentTemperature` | float | Current room temp |
| `workMode` | int | 0=Auto, 1=Cool, 2=Dehumid, 3=Fan, 4=Heat |
| `screen` | int | 0/1 |
| `sleep` | int | 0=off, 1=standard, 2=elderly, 3=child |
| `verticalDirection` | int | 0–13 (swing direction/fixed position) |
| `horizontalDirection` | int | 0–13 (swing direction/fixed position) |
| `generatorMode` | int | 0=off; Mom/Abdu/Abdullah allow 1–3; guest allows 1–6 |

### TAC-24CHSA-specific (Mom/guest, detected by `autoGeneratorMode` in shadow)
| Property | Type | Values |
|----------|------|--------|
| `windSpeed7Gear` | int | 0=auto, 1–7 fan levels |
| `verticalWind` | int | 0/1 (swing on/off) |
| `horizontalWind` | int | 0/1 (swing on/off) |
| `newWindSwitch` | int | 0/1 (fresh air) |
| `autoGeneratorMode` | int | 0/1 |

### TAC-12CHSD-specific (Abdu/Abdullah)
| Property | Type | Values |
|----------|------|--------|
| `windSpeed` | int | 0=auto, 2–6 fan levels (raw values 1 and 7 act as auto, NOT silent/max — silent/max go through `silenceSwitch`/`turbo`) |
| `verticalSwitch` | int | 0/1 (swing on/off) |
| `horizontalSwitch` | int | 0/1 (swing on/off) |
| `ECO` | int | 0/1 |
| `turbo` | int | 0/1 (used as "max" fan speed level 7) |
| `silenceSwitch` | int | 0/1 (used as "silent" fan speed level 1) |

### Generator mode
- `generatorMode` limits that physical unit's power consumption. Mom/Abdu/Abdullah expose Off + L1–L3. Guest exposes Off + L1–L6 from its device policy and verified shadow support.
- **Clamp defense (`clampGeneratorMode`)**: every gen-level publish path (sendControl, profile payloads, computeAcDiff desired, restoreLastState) clamps to the selected device's policy maximum, preserving 0. Direct controls are validated against the exact per-device option list before publish. Mixed-device range automations validate against the lowest maximum among their targets.
- **Guest electrical isolation:** `levelingEligible:false` is applied before building the controller device context. Guest is excluded from priority/config maps, amp models, calibration, learned costs, ESP residual/running sets, observed-state callbacks, and every leveling command callback. Leveling/configuration and calibration APIs reject explicit Guest references. Direct control and non-leveling automation remain available. No UI badge is shown.
- Generator-mode UI (Zap icon, level buttons) → [frontend.md](frontend.md); the Smart AC Leveling controller that drives these levels → [ac-leveling.md](ac-leveling.md).

## Firmware Quirks (both discovered 2026-05-10)

### TAC-24CHSA (Mom/guest) — power + profile quirk
Discovered 2026-05-10 when debugging "mom AC trigger not updating state."
- **Problem:** When `executeAcAction` sends `{ powerSwitch: 1, workMode: 1, targetTemperature: 26, ... }` as a single shadow update, Najat powers on but physically ignores the profile settings — while the shadow REPORTS them as applied (deceptive).
- **Fix:** Two-step in `executeAcAction`: publish `{ powerSwitch: 1 }` alone → wait 3 seconds for the AC to fully boot → publish the profile as a separate shadow update.
- **Why:** Firmware applies defaults/last-state during boot, ignoring settings received during the boot sequence.
- Verified: the atomic (single-update) approach works for Abdu (TAC-12CHSD) but fails for Najat.

### TAC-12CHSD (Abdu/Abdullah) — the fan block must travel ALONE
Discovered 2026-05-10 when debugging "abdu ac not taking fan speed"; **widened 2026-07-27** — the conflict is not `workMode`-specific.
- **Problem:** when fan-speed properties (`windSpeed`/`silenceSwitch`/`turbo`) share a shadow update with **any** other property, the device applies the other property, internally resets the blower, and ignores the fan values in that payload. The shadow reports them as applied (same deceptive pattern as Najat), so `computeAcDiff()` sees no diff and **never retries** — the unit stays at the wrong fan indefinitely while the dashboard reads the commanded value.
- **Fix (payload split):** `splitFanPayload()` in `tcl-cloud.ts` peels the fan block (`TCL_12CHSD_FAN_KEYS`) off whenever the payload carries anything else, on non-Najat models. Both publish paths use it — `executeAcAction` (profiles + automation diff re-enforcement) and `restoreLastState` (every manual power-on, whose saved set always carries `workMode` next to the fan). Main payload first → `profileSplitDelay()` (500 ms) → fan alone.
- **Why:** the firmware resets fan speed to the mode/reconfigure default while processing the companion property, before reading the fan props from the same update.
- **2026-07-27 incident (why the guard was widened):** a gen→grid changeover at 17:29:52 rebooted all three ACs (beep back on, swings and fan reverted). The range automation's diff re-enforcement re-sent Abdu AC's `{fan_speed:7, vertical_swing:10, horizontal_swing:11}` as ONE update — no `workMode`, so the old `hasFan && hasMode` guard did not split it. The swings applied, the blower did not, and `turbo:1` was reported back, so nothing ever retried. It sat low for 13 minutes until the user set fan to `A` (forcing the reported value to actually change), which produced a fan-only diff that applied on the first try. Regression tests: `tcl-cloud.test.ts` → "executeAcAction fan isolation" + "restoreLastState fan isolation".
- **No detection is possible after the fact** — the shadow is the only fan sensor, and the CT is whole-house (a fan step is ~0.1–0.3 A, buried under the compressor). Prevention via the split is the only defense; do not add a shadow-based verifier for this, it will always agree with the lie.

### Common pattern — "shadow says yes but device says no"
Both quirks share the same signature: shadow `state.reported` shows the settings as applied (the device acknowledges), but the physical AC ignores them. `computeAcDiff()` sees no difference because the reported state looks correct. The mitigation in both cases is to split the conflicting properties into separate shadow updates with a delay.

A **third face** of the same lie: a command sent while the unit is still booting after a power cycle can be echoed into `reported` without ever being physically applied (2026-08-18 — a range re-enforcement's `fan_speed:7` landed 25 s into a post-changeover reboot, reported `turbo=1`, and ran quiet for ~29 min). No split helps here — the unit simply isn't listening yet — so the collector holds background range enforcement for that device until its first fresh post-event shadow report ([ac-automations.md](ac-automations.md) → "Boot hold-off after a changeover").

**How to apply:** When adding new AC firmware integrations or changing `executeAcAction`, never assume all properties can be sent in a single shadow update. Test each property group separately and watch for the "shadow says yes but device says no" pattern.

### TCL can REMOVE features via OTA (2026-06)
TCL removed Mom's former generator levels 4–6 entirely (firmware + app), while the newer Guest unit—despite sharing the CHSA wire encoding—currently verifies all six. Generator limits are therefore per physical device, never per protocol family. A removed value has this pattern: the cloud accepts the command but `state.reported` never moves. There is no bypass at the cloud layer; update the per-device policy/validations and clamp stored presets when a level disappears.

## Key Functions

### `AcAction` interface
`{ power?: 0|1, mode?, temperature?, fan_speed?, eco?, turbo?, screen?, vertical_swing?, horizontal_swing?, fresh_air?, generator_mode? }` — all fields optional. Power is optional: when undefined, `executeAcAction` sends only profile commands (no power toggle, no restore delay). Used for dead-zone profile re-enforcement (see [ac-automations.md](ac-automations.md)).

### `executeAcAction(deviceId, action)`
Automation support added 2026-04-21, model-aware filtering added 2026-04-25, two-step power-on fix 2026-05-10. Used by the automation system and AC timers; profile-only mode enables dead-zone re-enforcement without toggling power.

Manual preset application uses `executeAcActionVerified`: it keeps the same capability filtering and CHSD main/fan split, then confirms the whole desired shadow every 5s. An ignored publish re-sends the identical split profile up to three times. While confirmation is pending, explicitly marked automation profile/drift re-enforcement for that device is suppressed so the collector's cached old profile cannot overwrite or cancel the newer manual one before the route persists and reloads it. Safety leveling, timers, calibration, automation state transitions, and other authoritative actions are never suppressed: they bump the shared generation and cancel the preset verifier. Raw leveler fan/level controls also invalidate a pending verifier before sending, preventing a whole-profile retry from undoing a protective cut. A newer direct UI control or verified preset likewise supersedes the older verifier and prevents its request from updating automation state; an external third-value change also wins. Superseded/final failures are returned to the card UI.

Three modes:
- `power=0` → off only.
- `power=1` with profile → sends `{powerSwitch:1}` first, waits 3s for AC boot, then sends the profile as a separate shadow update (Najat firmware quirk above; Najat ignores profile in a combined power-on update).
- `power=1` without profile → falls back to `sendControl` with `restoreLastState`.
- `power=undefined` → profile-only (no power command, no restore).

**Power accepted, profile failed (2026-09-27): `AcProfileNotAppliedError`.** With `power: 1` and a profile, if the `powerSwitch: 1` publish was accepted and only the profile publish throws, `executeAcAction` rejects with `AcProfileNotAppliedError` (`powerAccepted: true`; test with `isPowerAcceptedError(err)`), because the unit is already coming ON. A refused power publish is still an ordinary error. How each caller treats it:
- **Booked as SENT:** the v2 leveler's restore (`restoreSentAt`, pacing attempt, shed kept until confirm, collector ON stamp; the missing level is re-emitted by the reconciler's unconfirmed-level resend; ac-leveling SKILL invariant 81), and the collector's `executeAutomationAction` and turn-on timer (server-ON stamp, warning logged, rule `triggered`, profile re-asserted by diff enforcement; [ac-automations.md](ac-automations.md) → Manual-off locks).
- **Still an Error, behaviour unchanged:** v1 `ac-leveler.ts`, `ac-calibration.ts`, the `/api/automations/:id/test` route, and `executeAcActionVerified`.
Test: `tcl-cloud.test.ts` "executeAcAction: power accepted, profile failed".

**Capability-aware command filtering:**
- Filters every stored preset/timer field through the selected device's current capability set. Two ACs sharing a protocol family may therefore accept different profile fields.
- Existing stored presets stay backward compatible; unsupported fields are omitted and stale generator levels are clamped to the physical unit's current maximum. Advanced maintenance actions are never added to presets.
- For CHSD, **ANY** `set_fan_speed` drops `set_turbo` — the fan block owns `windSpeed`/`silenceSwitch`/`turbo` atomically (7=turbo, 1=silence). Fixed 2026-06-08: a preset's `turbo:0` + resolved fan 7 is self-contradictory on this model (shadow-derived fan 7 *is* `turbo:1`), which alternated `{turbo:0}`/`{fan_speed:7}` re-enforcement diffs every 5s tick, beeping the AC each time. Regression tests in `tcl-cloud.test.ts`.

**Profile split (CHSD):** profiles with both `workMode` and fan speed are sent as two shadow updates (main → 500ms → fan) because the firmware resets fan speed on a mode change.

### `publishWithRetry(deviceId, payload)`
Extracted helper with the retry-on-403 logic (clear creds, re-auth, retry once). Used by `executeAcAction` for both the power-on publish and the profile publish.

### `ensureDeviceCachePopulated()`
Guarantees `cachedDevices` is non-empty before model-dependent commands (populates it if empty). Called inside `executeAutomationAction()` for AC devices (before the initial automation turn-on), and in the test endpoint.

### `computeAcDiff(deviceId, desired)` — diff-based re-enforcement (added 2026-04-25)
- Compares current device state (from `cachedDevices`) with a desired `AcAction`; returns only the properties that differ.
- Returns `null` when everything matches → the caller skips the send entirely.
- Non-Najat: skips the `turbo` key when the desired `fan_speed` is present (fan subsumes turbo — see model-aware filtering above).
- Falls back to the full profile with a warning log when the device is not in the cache.
- The collector's `checkAcRangeAutomation()` uses `computeAcDiff()` in both the triggered-state and dead-zone paths — skips the send when nothing differs (see [ac-automations.md](ac-automations.md)).

### `getDeviceState(deviceId)`
Converts an `AcDevice` (booleans, different field names) into the `AcAction` shape (numbers) for diff comparison.

## Implementation Files
- `server/src/tcl-cloud.ts` — full API client (auth chain, device listing, shadow read via manual SigV4, control via AWS SDK publish).
- `server/src/ac-capabilities.ts` — stable per-device policy (`DEVICE_POLICIES`), the `VERIFIED_CONTROL_FEATURES` allowlist, and the pure capability logic (`deriveAcCapabilities`, `validateAcControl`, `supportsAcCommand`, `buildAdvancedControlPayload`) that decides which controls each physical unit exposes and accepts.
- `server/src/fixtures/ac-capability-shadows.ts` — sanitized live shadows of all four units (`LIVE_AC_CAPABILITY_SHADOWS`), the fixture behind the capability tests.
- `server/src/routes.ts` — AC routes. `ALLOWED_AC_COMMANDS` is gone: the control route now calls `cloud.validateControlLive()` (404 unknown device / 400 unknown-or-unsupported command / invalid value / 409 supported-but-currently-unavailable) before publishing.
- `client/src/types/ac.ts` — `AcDevice` interface.
- `client/src/hooks/use-ac-devices.ts` — polling + optimistic UI (same pattern as `use-devices.ts`).
- `client/src/components/ac-widget.tsx` — vertical capsule widget + detail overlay (mode selector, fan speed, toggles, generator) — design details in [frontend.md](frontend.md).

## Reference Projects (reverse-engineered TCL Home API)
- `nemesa/ha-tcl-home-unofficial-integration` (Python/HA) — most complete; uses the boto3 iot-data client for publish (confirmed working approach).
- `DavidIlie/tcl-home-ac` (TypeScript) — read-only, no control implementation.
- `mitaka621/TCL-Home-API` (C#) — alternative implementation.
