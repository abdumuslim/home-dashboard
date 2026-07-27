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

**TL;DR:** Three TCL split ACs ("Najat", "Abdu AC", "Abdullah AC") are controlled through a reverse-engineered TCL Home cloud client in `server/src/tcl-cloud.ts`. Auth is a 4-step chain ending in temporary AWS credentials; device state is read from the AWS IoT Shadow (manual SigV4 GET works), but control MUST publish via the `@aws-sdk/client-iot-data-plane` SDK (manual SigV4 publish fails with 403). Two AC hardware models have different shadow property names and two firmware quirks that force split shadow updates. TCL's `isOnline` flag is unreliable — the shadow fetch is the real connectivity test.

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

### Retry-on-403 and the silent-death gotcha
- `sendControl` has retry-on-403 logic: clears creds (`tokenData = null`), re-auths, retries once.
- **Critical gotcha (found 2026-05-01):** the 403 retry sets `tokenData = null` BEFORE calling `ensureValidTokens()`. If the re-auth fails (network blip, TCL server down), `tokenData` stays null → `isReady()` returns false **permanently** → all AC automations silently stop forever with zero log output.
- **Auto-recovery:** the collector attempts `tclCloud.init()` every 60s whenever `isReady()` is false.

### Allowed commands (`ALLOWED_AC_COMMANDS` in `server/src/routes.ts`)
`set_power`, `set_mode`, `set_temperature`, `set_fan_speed`, `set_eco`, `set_screen`, `set_sleep`, `set_vertical_swing`, `set_horizontal_swing`, `set_turbo`, `set_fresh_air`, `set_generator_mode`.

The backend resolves property names per device model (e.g., `set_fan_speed` → `windSpeed7Gear` for Najat, `windSpeed` for Abdu/Abdullah).

### Abdu/Abdullah fan-speed command mapping
- Level 1 sends `{silenceSwitch:1, turbo:0, windSpeed:0}`.
- Level 7 sends `{turbo:1, silenceSwitch:0, windSpeed:0}`.
- Other levels send `{windSpeed:N, silenceSwitch:0, turbo:0}`.
- Shadow read mapping: `silenceSwitch === 1` → fanSpeed=1, `turbo === 1` → fanSpeed=7, else → `windSpeed`.

### Last state restore
- On power-on, the backend restores all saved properties (mode, temp, fan, swing, etc.) from `/app/data/ac-last-state.json`. State is saved on every shadow poll while the device is on (per device ID).
- On a **manual** power-on (`sendControl("set_power", 1)` from the UI), the backend sends `powerSwitch: 1`, waits 1s, then publishes all saved properties from last state.
- `executeAcAction` with power=1 + profile does NOT use `sendControl`/`restoreLastState` — it directly publishes power-on via `publishWithRetry`, waits 3s, then sends the automation's profile. This prevents last-state vs automation-profile conflicts.
- `executeAcAction` with power=1 but NO profile (e.g., a timer without a preset) falls back to `sendControl("set_power", 1)`, which restores last state.
- Saved props per model:
  - Najat: `workMode, targetTemperature, screen, sleep, verticalWind, horizontalWind, verticalDirection, horizontalDirection, generatorMode, windSpeed7Gear, newWindSwitch`
  - Others: `workMode, targetTemperature, screen, sleep, verticalSwitch, horizontalSwitch, verticalDirection, horizontalDirection, generatorMode, windSpeed, ECO, turbo, silenceSwitch`

## AC Models & Shadow Properties

> **⚠ Capacity correction (2026-07-23):** the `model` strings below are PROTOCOL-FAMILY labels inferred from shadow properties — their capacity digits are WRONG for this household. Nameplate reality (user-verified + meter evidence): **Abdu = 2-ton** (advertised 4–8A; calibration fan sweep hit 7.94A; likely a TAC-24-class CHSD unit), **Abdullah & Najat = 1-ton** (2–6A; never observed above ~4.5A). Najat's "TAC-24CHSA" label just means she speaks the CHSA protocol (7-gear fan, `autoGeneratorMode`). All protocol forks stay keyed on the `model` field (correct for BEHAVIOR); never use it to infer capacity/amps — capacity lives in the leveling amp models and `ac_leveling_costs`.

Two AC hardware models with different shadow properties. Detection: presence of `autoGeneratorMode` in the shadow → Najat (TAC-24CHSA); absence → Abdu/Abdullah (TAC-12CHSD). The result is stored as an explicit `model: "TAC-24CHSA" | "TAC-12CHSD"` field on `AcDevice` (server + client) — **all protocol forks (`isNajatModel()`, client fan labels) key on `model`, never on `maxGeneratorLevel`** (they used to check `=== 6`, which broke when TCL changed the level count in 2026-06).

### Common properties (shadow `state.reported`)
| Property | Type | Values |
|----------|------|--------|
| `powerSwitch` | int | 0=off, 1=on |
| `targetTemperature` | int/float | 16–36 (Najat: 0.5 step, others: 1 step) |
| `currentTemperature` | float | Current room temp |
| `workMode` | int | 0=Auto, 1=Cool, 2=Dehumid, 3=Fan, 4=Heat |
| `screen` | int | 0/1 |
| `sleep` | int | 0=off, 1=standard, 2=elderly, 3=child |
| `verticalDirection` | int | 0–13 (swing direction/fixed position) |
| `horizontalDirection` | int | 0–13 (swing direction/fixed position) |
| `generatorMode` | int | 0=off, 1–3=level (ALL models since 2026-06 — TCL removed Najat's 4–6, see Generator mode) |

### Najat-specific (TAC-24CHSA, detected by `autoGeneratorMode` in shadow)
| Property | Type | Values |
|----------|------|--------|
| `windSpeed7Gear` | int | 0=auto, 1–7 fan levels |
| `verticalWind` | int | 0/1 (swing on/off) |
| `horizontalWind` | int | 0/1 (swing on/off) |
| `newWindSwitch` | int | 0/1 (fresh air) |
| `autoGeneratorMode` | int | 0/1 |

### Abdu/Abdullah-specific (TAC-12CHSD)
| Property | Type | Values |
|----------|------|--------|
| `windSpeed` | int | 0=auto, 2–6 fan levels (raw values 1 and 7 act as auto, NOT silent/max — silent/max go through `silenceSwitch`/`turbo`) |
| `verticalSwitch` | int | 0/1 (swing on/off) |
| `horizontalSwitch` | int | 0/1 (swing on/off) |
| `ECO` | int | 0/1 |
| `turbo` | int | 0/1 (used as "max" fan speed level 7) |
| `silenceSwitch` | int | 0/1 (used as "silent" fan speed level 1) |

### Generator mode
- `generatorMode`: 0=off, 1–3=level. Limits the unit's power consumption for generator use (per-unit current cap). TCL's documented mapping: L1=30%, L2=50%, L3=70% of rated current.
- **`maxGeneratorLevel` is 3 for ALL models since 2026-06** (`MAX_GENERATOR_LEVEL` export in tcl-cloud.ts). Najat (TAC-24CHSA) historically had 6 levels; TCL removed 4–6 via firmware/app update — the cloud still ACCEPTS `set_generator_mode` 4–6 but the firmware never applies them (shadow keeps the old value; verified live 2026-06-11: L3 confirms in ~1s, L4–L6 time out every send budget, and the TCL app no longer shows them).
- **Clamp defense (`clampGeneratorMode`)**: every gen-level publish path (sendControl, profile payloads, computeAcDiff desired, restoreLastState) clamps to the device max, preserving 0 — a stored preset/profile with a removed level can never cause the 5s diff re-enforcement to re-send forever. The control route validates 0–3; `onUserGenLevel` clamps the intent too (stale cached clients).
- Generator-mode UI (Zap icon, level buttons) → [frontend.md](frontend.md); the Smart AC Leveling controller that drives these levels → [ac-leveling.md](ac-leveling.md).

## Firmware Quirks (both discovered 2026-05-10)

### Najat (TAC-24CHSA) — power + profile quirk
Discovered 2026-05-10 when debugging "mom AC trigger not updating state."
- **Problem:** When `executeAcAction` sends `{ powerSwitch: 1, workMode: 1, targetTemperature: 26, ... }` as a single shadow update, Najat powers on but physically ignores the profile settings — while the shadow REPORTS them as applied (deceptive).
- **Fix:** Two-step in `executeAcAction`: publish `{ powerSwitch: 1 }` alone → wait 3 seconds for the AC to fully boot → publish the profile as a separate shadow update.
- **Why:** Firmware applies defaults/last-state during boot, ignoring settings received during the boot sequence.
- Verified: the atomic (single-update) approach works for Abdu (TAC-12CHSD) but fails for Najat.

### Abdu/Abdullah (TAC-12CHSD) — mode + fan speed quirk
Discovered 2026-05-10 when debugging "abdu ac not taking fan speed."
- **Problem:** When a profile contains BOTH `workMode` and fan-speed properties (`windSpeed`/`silenceSwitch`/`turbo`) in the same shadow update, the device processes `workMode` first and internally resets the fan speed, ignoring the fan values in the same payload. The shadow reports them as applied (same deceptive pattern as Najat).
- **Fix (profile split):** In `executeAcAction`, when a non-Najat profile contains both `workMode` and fan-speed props, split into two shadow updates: main profile first → wait 500ms → fan speed separately.
- **Why:** Firmware resets fan speed to the mode default when processing a mode change, before reading the fan-speed properties from the same update.

### Common pattern — "shadow says yes but device says no"
Both quirks share the same signature: shadow `state.reported` shows the settings as applied (the device acknowledges), but the physical AC ignores them. `computeAcDiff()` sees no difference because the reported state looks correct. The mitigation in both cases is to split the conflicting properties into separate shadow updates with a delay.

**How to apply:** When adding new AC firmware integrations or changing `executeAcAction`, never assume all properties can be sent in a single shadow update. Test each property group separately and watch for the "shadow says yes but device says no" pattern.

### TCL can REMOVE features via OTA (2026-06)
TCL removed Najat's generator levels 4–6 entirely (firmware + app; see Generator mode above). Pattern: the cloud accepts the command but `state.reported` never moves — same signature as a flaky non-apply, but permanent. There is no bypass: we already publish at the lowest available layer (the same AWS IoT shadow the app uses); the rejection is in the indoor unit's firmware. Treat any "level/value never confirms across days + app UI no longer offers it" as a removal, not a quirk — update `MAX_GENERATOR_LEVEL`/validations and sweep stored presets/profiles for the dead values.

## Key Functions

### `AcAction` interface
`{ power?: 0|1, mode?, temperature?, fan_speed?, eco?, turbo?, screen?, vertical_swing?, horizontal_swing?, fresh_air?, generator_mode? }` — all fields optional. Power is optional: when undefined, `executeAcAction` sends only profile commands (no power toggle, no restore delay). Used for dead-zone profile re-enforcement (see [ac-automations.md](ac-automations.md)).

### `executeAcAction(deviceId, action)`
Automation support added 2026-04-21, model-aware filtering added 2026-04-25, two-step power-on fix 2026-05-10. Used by the automation system and AC timers; profile-only mode enables dead-zone re-enforcement without toggling power.

Three modes:
- `power=0` → off only.
- `power=1` with profile → sends `{powerSwitch:1}` first, waits 3s for AC boot, then sends the profile as a separate shadow update (Najat firmware quirk above; Najat ignores profile in a combined power-on update).
- `power=1` without profile → falls back to `sendControl` with `restoreLastState`.
- `power=undefined` → profile-only (no power command, no restore).

**Model-aware command filtering:**
- Filters out `set_eco`/`set_turbo` for Najat (no such shadow props).
- Filters out `set_fresh_air` for non-Najat (no `newWindSwitch`).
- For non-Najat, **ANY** `set_fan_speed` drops `set_turbo` — the fan block owns `windSpeed`/`silenceSwitch`/`turbo` atomically (7=turbo, 1=silence). Fixed 2026-06-08: a preset's `turbo:0` + resolved fan 7 is self-contradictory on this model (shadow-derived fan 7 *is* `turbo:1`), which alternated `{turbo:0}`/`{fan_speed:7}` re-enforcement diffs every 5s tick, beeping the AC each time. Regression tests in `tcl-cloud.test.ts`. (Earlier behavior dropped `set_turbo` only for fan_speed 1 or 7 — superseded.)

**Profile split (non-Najat):** profiles with both `workMode` and fan speed are sent as two shadow updates (main → 500ms → fan) because the firmware resets fan speed on a mode change.

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
- `server/src/routes.ts` — AC routes + `ALLOWED_AC_COMMANDS`.
- `client/src/types/ac.ts` — `AcDevice` interface.
- `client/src/hooks/use-ac-devices.ts` — polling + optimistic UI (same pattern as `use-devices.ts`).
- `client/src/components/ac-widget.tsx` — vertical capsule widget + detail overlay (mode selector, fan speed, toggles, generator) — design details in [frontend.md](frontend.md).

## Reference Projects (reverse-engineered TCL Home API)
- `nemesa/ha-tcl-home-unofficial-integration` (Python/HA) — most complete; uses the boto3 iot-data client for publish (confirmed working approach).
- `DavidIlie/tcl-home-ac` (TypeScript) — read-only, no control implementation.
- `mitaka621/TCL-Home-API` (C#) — alternative implementation.
