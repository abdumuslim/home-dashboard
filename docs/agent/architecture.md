---
type: Reference
title: 'Architecture'
description: 'TL;DR: Home environmental monitoring dashboard at https://home.altijwal.com — Express 5 (Node.js/TypeScript) backend + React/Vite frontend, PostgreSQL storage, MQTT + cloud-API collectors, Web Push alerts, cookie-JWT…'
tags: [home, dashboard, claude-code, current]
maintainer: claude-code
timestamp: 2026-07-27
---

<!-- Tier-3 agent doc. Loaded on demand via CLAUDE.md / AGENTS.md routing table. -->

# Architecture

TL;DR: Home environmental monitoring dashboard at **https://home.altijwal.com** — Express 5 (Node.js/TypeScript) backend + React/Vite frontend, PostgreSQL storage, MQTT + cloud-API collectors, Web Push alerts, cookie-JWT auth, and Xiaomi/TCL device control. This doc covers hardware, system architecture, project layout, data flow, rate limits, logging, performance patterns, and known gotchas. Sibling docs: [tcl-ac.md](tcl-ac.md) (TCL cloud client + AC automations details), [ac-automations.md](ac-automations.md), [ac-leveling.md](ac-leveling.md) (Smart AC Leveling), [frontend.md](frontend.md) (dashboard layout, card design, widgets), [operations.md](operations.md) (deployment, SSH, VPS), [database.md](database.md) (full schema), [testing.md](testing.md).

## What This Is

Home environmental monitoring dashboard at **https://home.altijwal.com**. Node.js/Express backend with React/TypeScript frontend, collects data from two sensor APIs, stores in PostgreSQL, and serves a dark-themed dashboard with live-updating cards and Chart.js charts. It also automates Xiaomi Mi Air Purifiers based on air quality metrics.

**4 physical sensors, 2 APIs, 2 Purifiers, 4 ACs:**
- **Ambient Weather WS-2000** (station MAC C8:C9:A3:0E:CB:CB; 1 API device, 3 sensor groups in `lastData`):
  - Outdoor: temp, humidity, wind, rain, pressure, UV, solar (~1 min updates)
  - Indoor console: temp, humidity, feels like, dew point (`tempinf`, `humidityin`, `feelsLikein`, `dewPointin`)
  - Channel 8 "Abdu": temp, humidity, feels like, dew point (`temp8f`, `humidity8`, `feelsLike8`, `dewPoint8`)
- **Qingping Air Monitor CGS2** (MAC 582D3470F981): CO2, PM2.5, PM10, tVOC, noise, temp, humidity, battery (~15s via MQTT, cloud API fallback ~15 min). MQTT payload includes `battery: { value: number, status: number }` — `status: 1` = charging (USB plugged), `status: 0` = discharging. `batteryCharging` flag is added to the in-memory live air object (not stored in DB). Full payload structure below in "Qingping MQTT Payload Structure".
- **Xiaomi Mi Air Purifiers**:
  - "mom": `zhimi.airpurifier.v7` (older MiIO protocol)
  - "Abdu": `zhimi.airpurifier.vb2` (modern MIoT protocol)
- **TCL Split ACs** (4 units, all on dashboard via TCL Home cloud API):
  - Stable ID policy maps `DHihohFAAAE` → Mom, `CA5IMhFAAAE` → Abdu, `Cy3aihFAAAE` → Abdullah, and `DlXqDBFAAAE` → guest. Guest is on a separate grid-only electrical line: it supports direct controls and ordinary AC automations, but is filtered out before every ESP-based leveling/calibration context. Cloud client details in [tcl-ac.md](tcl-ac.md).
- **Power Monitor (CT02 on the mains since 2026-08-29; ESP retired)**: the CT02 (OpenBeken HLW8112) publishes voltage + current on two lines (Grid=I1, Generator=I2) over MQTT; `server/src/ct02-feed.ts` feeds it into the former ESP `POST /api/power/ingest` pipeline behind `CT02_POWER_METER`. The device streams at ~1 s; the leveler and alert path are forwarded readings at 4s (see below). Server computes power (W = V × A), buffers in memory, and writes a 1-minute median to `power_readings` table. Live endpoint (`GET /api/current/power`) returns `null` if last reading is >15s stale (the CT02 raw stream updates `latestPower` every ~1s, so >15s = ~15 missed = no electricity). Frontend power card shows `0.00 kW / 0 V / 0.0 A` in white when no data (instead of `--`). Until 2026-08-29 the retired ESP fed the same route over HTTP every 5s. Full details below in "ESP Power Monitor".

## System Architecture

```
Browser → Cloudflare → Traefik (VPS, existing) → dashboard container (port 8000)
                                                        ↓
                                                  PostgreSQL (VPS, existing, db=home)
```

- **Backend**: Express 5 (Node.js/TypeScript) serves REST API + static frontend + runs collector in background. Uses `pg` (node-postgres), native `fetch`, dotenv.
- **Frontend**: React 19 + TypeScript + Vite 7 + Tailwind CSS v4 + lucide-react icons; charts via Chart.js + react-chartjs-2
- **Xiaomi Cloud**: Integrated via `xmihome` library (custom wrapper in `xiaomi-cloud.ts`).
  - Supports 2FA (credentials/token cached in persistent volume).
  - Handles both **MiIO** (`get_prop`, `set_power`) and **MIoT** (`get_properties`, `set_properties`) protocols.
  - **MIoT Mappings**: Power (2:2), Fan Level (2:4), Mode (2:5), AQI (3:6), Humidity (3:7), Temperature (3:8), Filter Life (4:3), Buzzer (5:1), LED (6:6), Child Lock (7:1).
  - Auth lifecycle (token reuse across restarts, the 401 detection points, self-healing re-auth, device-list cadence, the `/api/devices` contract): see "Xiaomi Cloud Auth & Device List" below.
- **TCL Cloud**: see [tcl-ac.md](tcl-ac.md) for the full client (auth chain, AWS IoT shadow, per-unit capability registry, `executeAcAction`, `computeAcDiff`, protocol-aware encoding, firmware quirks).
- **Automations** (purifier metric rules, AC thermostat hysteresis + range slots, schedules, timers, manual-off locks): see [ac-automations.md](ac-automations.md).
- **Smart AC Leveling** (current-budget controller, shed/restore, calibration): see [ac-leveling.md](ac-leveling.md).
- **Separate docker-compose**: Lives at `/opt/home-dashboard/` on the VPS, joins the existing `rag_default` network.
  - Mounts `dashboard_data` volume to `/app/data` for `xiaomi-credentials.json` and `tcl-credentials.json`.
- **Multi-stage Docker build**: Stage 1 builds client (Vite), Stage 2 builds server (tsc), Stage 3 runs production Node.js
- **Database**: Uses the existing `rag-postgres-1` container (pgvector:pg16). The `home` database is auto-created on first startup. Full schema in [database.md](database.md).
- **Push Notifications**: Web Push via VAPID keys (in VPS `.env`). Service worker at `client/public/sw.js` handles push display + click-to-focus. Subscriptions synced to `push_subscriptions` table on page load. **Smart AC Leveling notifications (shed/restore + "AC Calibration finished") are per-device opt-in, OFF by default** — `broadcastPush` only sends to subscriptions with `leveling_notifications = true`; each device toggles it via `GET`/`POST /api/push/leveling` (the "Smart AC Leveling alerts" switch in the Alerts modal). A leveling config **enable-flip** (controller turned OFF/back ON via `PUT /api/ac/leveling`) also pushes to this same audience, sent from the route via `broadcastLevelingPush` — a routes-local mirror of `broadcastPush`, which is private to the Collector and not injected into routes (added 2026-08-07 for the 2026-08-06 silent-disable gap). Sensor/prayer alerts remain per-endpoint via `alert_rules`. Alert metrics span 4 groups: Outdoor (weather), Indoor (weather), Air Quality (Qingping), Power (CT02 meter since 2026-08-29, formerly ESP). Power metrics use 60s staleness threshold (vs 300s for weather/air). Power data flows routes→collector via `onPowerIngest` callback (opposite direction from air data). **Power alerts require 4 consecutive forwarded meter readings** (~16s at the 4s leveler-forward cadence; ~20s on the retired ESP's 5s) meeting the condition before firing (`powerConditionSustained()` in `alert-metrics.ts`, pure + unit-tested; gap >15s between readings breaks the streak; collector buffers last 8 readings in `recentPowerReadings`) — single-spike immunity for fluctuating power. Weather/air alerts still fire on a single reading.
- **Authentication**: Cookie-based JWT auth using HMAC-SHA256 (zero npm deps — uses Node.js `crypto`).
  - `server/src/auth.ts`: `signToken`/`verifyToken`, cookie parsing, `authMiddleware` (sets `req.authenticated` on every request), `requireAuth` guard, login/logout/status handlers, `clientIp()` (Cloudflare `cf-connecting-ip`, else the socket peer; `x-forwarded-for` is deliberately not trusted — client-supplied — and `clientIp` also backs the login rate limiter, which previously bucketed every attempt into Traefik's single peer address).
  - **Caller identity.** Human logins (`user`) and Hermes bearer or cookie sessions (`agent`) have full access. Sessions minted by `POST /api/agent/session` carry an `agent: true` JWT claim. The scoped watch bearer has its own `watch` identity. **Rotating `AUTH_SECRET` retires old untagged 30-day cookies**. Until rotation or expiry, an old agent cookie reads as `user`. See the control attribution incident in [ac-automations.md](ac-automations.md).
  - Credential compare uses `crypto.timingSafeEqual`. JWT stored in `auth` httpOnly cookie (30-day expiry, `Secure` in production, `SameSite=Strict`).
  - **Guest (unauthenticated):** Sees Outdoor, Air Quality, Prayer sections. Cannot access device/AC/automation/xiaomi-auth APIs (12 routes return 401).
  - **Admin (authenticated):** Sees everything including Indoor section, full device control, automations panel in alerts modal.
  - Frontend: `AuthProvider` context in `use-auth.ts`, `LoginModal` glass-card component, Header shows "Login" pill button (guest) or LogOut icon (admin).
  - Hooks `useDevices(enabled)` and `useAcDevices(enabled)` accept an `enabled` param — skip all fetches when `!isAdmin`.
  - **Hermes agent access** (bearer token): `HERMES_API_TOKEN` env var (`hermesApiToken` in config.ts; bearer auth disabled when empty). `POST /api/agent/session` exchanges a valid bearer token for an admin auth cookie; `GET /api/agent/snapshot` returns a consolidated dashboard payload (weather, air, devices, forecast, automations, prayer times). Integration-tested in `agent-routes.test.ts`.
  - **HUAWEI WATCH 5.** Supply a separate 32-byte random base64url key via `WATCH_API_TOKEN`. Empty disables watch access. The app checks its bearer before public endpoints, cookie auth and static files. A matching bearer plus any cookie has only watch access. The watch router returns JSON 401 outside its five strict routes, sets `Cache-Control: no-store`, and issues no session. If the two keys coincide, the shared bearer is refused, including at session exchange. Rotate or revoke the watch key by replacing or removing it in the dashboard environment file, then running `docker compose up -d --force-recreate dashboard`. A plain restart reuses the container's old environment. Leave `HERMES_API_TOKEN` in place when rotating the watch.
  - **Watch endpoints** (`server/src/watch-api.ts`). `GET /api/watch` returns the compact v1 power, weather, air, AC and purifier snapshot. Nested timestamps are epoch milliseconds for the underlying observations. A cold cache returns 503. Valid requests renew two minutes of collector demand for device refreshes at 15-second intervals. `POST /api/watch/ac/:id/power` accepts a boolean `on`. `GET /api/watch/ac/:id/presets` lists saved slots and `POST /api/watch/ac/:id/preset` accepts only a slot number in `{"slot": n}`. `POST /api/watch/purifier/:id` accepts a model-supported `command` and `value`. All three callers' purifier commands write `purifier:`-prefixed entries in `ac_control_audit`. A watch-initiated AC lock release names the watch in its push.
  - **Watch reading limits.** A cached TCL target of 24°C gives `setC: null` because TCL's cache also substitutes 24 for a missing target. The controller's smoothed amps keep the timestamp of the meter sample behind the completed tick. When a tick spans multiple readings, the watch keeps the previous verified sample for up to 15 seconds.

## Project Structure

```
D:\dev\home\
├── server/                 # Node.js backend (Express + TypeScript)
│   ├── src/
│   │   ├── index.ts        # Express app, static serving, collector startup, wires getters (xiaomi, tcl, latestAir, forecast) and power ingest callback to routes
│   │   ├── routes.ts       # API routes (/api/current, /api/history?source=weather|air&range=6h|24h|48h|1w|30d, /api/status, /api/solar-reference, /api/alerts CRUD, /api/xiaomi/*, /api/ac/*, /api/ac/timer*, /api/ac/presets/* CRUD, /api/ac/preset-apply, /api/automations CRUD+test, /api/auth/*, /api/forecast, /api/agent/* — see Hermes agent access). Power ingest + buffer here; air served via getLatestAir getter from collector. AC timers stored in-memory (acTimers Map). AC presets stored in `ac_presets` table (server-side). Power ingest calls onPowerIngest callback to sync data to collector for alerts. Automation rule invalidation via onAutomationRulesChanged callback.
│   │   ├── auth.ts         # JWT auth (HMAC-SHA256), cookie middleware (sets req.authenticated + req.authKind user|agent), clientIp(), login/logout/status handlers, rate limiting (5/15min per IP)
│   │   ├── collector.ts    # Collector class (AW polling + Qingping MQTT/cloud + automation loop). Air buffer + storeAirMedian() for 1-min median writes. Public getLatestAir() getter, setLatestPower() setter (receives power data from routes via callback), invalidateAutomationRules() (resets 30s rule cache for immediate reload). Backfill runs in background (non-blocking). Batch inserts for backfill. Prayer time helpers: ensurePrayerTimesForToday(), resolvePrayerMinutes(). Automation methods: checkMetricAutomation (purifier single-threshold), checkAcRangeAutomation (AC hysteresis), checkScheduleAutomation, checkAcTimers. executeAutomationAction routes to xiaomi or tcl based on device_type. Also owns persistent AC manual-off lock state (`ac_manual_off_locks`) and in-memory per-rule+device fan enforcement (`acFanEnforcement` — resolveRangeFan/effectiveAcRangeProfile/updateAcFanTracking/noteUserAcFanChange, plus stripLeveledControls/refreshAcFanBaseline for leveler fan-hold deference; a post-power-cycle fan entry carries an `initializationPending` marker so an echoed startup/remote fan is never adopted as a new manual choice). A parallel per-rule+device `acProfileEnforcement` map extends the same precedence to mode/temperature/eco/screen/vertical+horizontal swing/fresh-air (updateAcProfileTracking/noteAcProfileCommanded/noteUserAcProfileChange) — each field independently surrenders to a detected physical-remote change and stays out of the enforced diff until that field's slot/profile value changes or a power/source boundary re-initializes it.
│   │   ├── xiaomi-cloud.ts # Wrapper for xmihome, protocol routing, device discovery, auth lifecycle (isAuthError + invalidateAuth on every 401 path, last-known device cache, throttled refreshDevices)
│   │   ├── tcl-cloud.ts    # TCL Home API client (auth chain, AWS IoT shadow, SigV4 signing)
│   │   ├── ac-capabilities.ts # Stable AC policy + per-live-shadow feature/value/availability validation
│   │   ├── alert-metrics.ts # Shared metrics catalog (weather/air/power sources + feels-like indoor metrics), getMetricValue (accepts weather, air, power rows), PRAYER_LABELS. Power metrics: voltage, power_grid, power_gen, power_total (computed), current_grid, current_gen.
│   │   ├── prayer.ts        # Dashboard wrapper around prayer-engine: BAGHDAD_COORDS + "BaghdadYMA" profile, getBaghdadPrayerTimes(), baghdadMinuteOfDay(), baghdadDateKey(), prayerInstant(). Single place the household location/profile live.
│   │   ├── prayer-engine/   # Standalone, GPS-portable prayer-time engine on astronomy-engine (MIT). index/astro/asr/high-latitude/rounding/methods/sunnah/timezone/types. Own package.json+README (lift-and-publish ready). calibrate.ts (one-off, build-excluded) fits the BaghdadYMA offsets; prayer-engine.test.ts is the ≤1-min regression vs the printed calendar.
│   │   ├── forecast.ts     # ForecastService — Open-Meteo hourly forecast with bias correction (bias table loaded by index.ts from `<server root>/bias-data/bias-table.json`)
│   │   ├── calibrate.ts    # Standalone bias-table generator (`npx tsx src/calibrate.ts` on dev PC) — parses docs/Backup-A.CSV + Open-Meteo archive → server/data/bias-table.json. Gotcha: runtime reads `bias-data/`, not `data/` — the Dockerfile COPY (`server/data/bias-table.json → ./bias-data/`) bridges the two paths
│   │   ├── ac-leveling.ts  # Smart AC Leveling pure allocator (computeAllocation incl. restore-with-reduction, estimateAcDraw, determineSource, computeNeedTier) — no I/O
│   │   ├── ac-leveler.ts   # Stateful AcLeveler (config/shed/fan-hold persistence, streaks, manual gen intents + fan exemptions, per-source ampModelFor, nonAcLoad freeze + expectation grading, command execution)
│   │   ├── ac-calibration.ts # AcCalibrator state machine (one-by-one sweeps, baselines, sampling) + pure helpers (buildCalibrationSteps, fitAmpModel, calMedian/calStddev)
│   │   ├── automation-slots.ts # AutomationRangeSlot type, normalizeRangeSlots (field whitelist!), validateRangeSlots, findActiveRangeSlot, Baghdad time/prayer window resolution (createBaghdadPrayerResolver now backed by prayer.ts/prayer-engine)
│   │   ├── ac-auto-fan.ts  # computeAutoFanLevel — delta-based smart auto fan mapping (pure, no I/O)
│   │   ├── database.ts     # pg pool, schema init, migrations (automations, power, AC presets, AC manual-off locks, AC leveling config/shed/fan-hold, AC calibration results, AC control audit)
│   │   ├── logger.ts       # Structured logging via pino (childLogger factory, console-compatible API)
│   │   ├── rate-gate.ts    # RateGate — serializes calls to a per-user-metered vendor API, spacing START times (collector's awGate; see API Rate Limits)
│   │   ├── config.ts       # Env vars (dotenv)
│   │   ├── auth.test.ts    # JWT sign/verify/tamper/expiry tests (vitest)
│   │   ├── ac-leveling.test.ts # Pure allocator tests (priority fill, gating, shed/restore, restore-with-reduction, caps)
│   │   ├── ac-calibration.test.ts # Calibration helpers + state machine tests (sweeps, aborts, restore)
│   │   ├── ac-auto-fan.test.ts # Smart auto fan mapping + hysteresis tests
│   │   ├── automation-slots.test.ts # Range slot selection + validation tests (incl. per-slot fan_speed)
│   │   ├── tcl-cloud.test.ts # Non-Najat fan/turbo coupling regression tests
│   │   ├── alert-metrics.test.ts # powerConditionSustained() streak tests
│   │   ├── agent-routes.test.ts # Hermes bearer auth + /api/agent/* integration tests
│   │   ├── ac-control-audit.test.ts # AC control attribution: agent JWT claim, ac_control_audit rows (user vs agent, IP), lock-clear push
│   │   └── routes.test.ts  # median() utility tests (vitest)
│   ├── package.json
│   └── tsconfig.json
├── client/                 # React frontend (Vite + Tailwind)
│   ├── src/
│   │   ├── main.tsx        # Entry point, Chart.js registration
│   │   ├── App.tsx         # Root component with tabs
│   │   ├── index.css       # Tailwind theme + custom wind/flash CSS
│   │   ├── hooks/          # useCurrentData, useHistoryData, useClock, useFlash, useAlerts, usePushNotifications, useDevices, useAcDevices, useAutomations, useAuth, useForecast, useModalSections (bell-modal collapse state, localStorage), useAcLeveling (polls /api/ac/leveling 5s while expanded), useAcCalibration (polls /api/ac/calibration 3s while expanded), useUnits (unit-preference context + converters, localStorage), usePrayerTimes (fetches /api/prayer-times once per Baghdad day, ticks countdown locally from timestamps; Hijri date/events computed locally via Intl — no client-side prayer math), useSectionLayout (section order/collapse state, localStorage), useChartsVisible (global charts show/hide toggle, localStorage)
│   │   ├── components/     # Header, sections, cards (devices-card, indoor-card, power-card), purifier-widget, ac-widget, charts, AlertsModal, ui/battery-indicator, ui/collapsible-modal-section (chevron + 0fr/1fr grid collapse), ui/ac-leveling-section (leveling config + live status), ui/ac-calibration-panel (calibration selection/progress/results/apply)
│   │   ├── types/          # API type definitions (api.ts, alerts.ts, automations.ts, ac.ts, forecast.ts, leveling.ts)
│   │   └── constants/      # Thresholds, directions, helpers, alert-metrics, solar-model, sky-condition, chart-utils, forecast-utils
│   ├── vite.config.ts
│   └── package.json
├── mosquitto/              # MQTT broker config
│   └── config/
│       └── mosquitto.conf  # Broker config (passwd file generated on VPS)
├── docs/                   # Reference material: agent/ (tiered AI-agent docs), weather-station CSV exports (calibrate.ts input), design mockups/screenshots
├── Dockerfile              # Multi-stage (node:22-slim)
├── docker-compose.yml      # dashboard + mosquitto services + 3 volumes (dashboard_data, mosquitto_data, mosquitto_log)
└── .env                    # On VPS only (MI_EMAIL, MI_PASSWORD, MI_REGION=sg, TCL_USERNAME, TCL_PASSWORD, AUTH_SECRET, ADMIN_USER, ADMIN_PASSWORD)
```

## Data Flow & In-Memory Buffering

Both air and power readings are buffered in memory and written as 1-minute medians to their respective tables (~1 row/min each). The `median()` helper for power is in `routes.ts`; for air, `storeAirMedian()` is a method on the Collector class with its own null-aware median closure. Live endpoints (`/api/current`, `/api/current/power`) serve the latest raw in-memory reading for real-time display.

## Qingping MQTT Payload Structure

Qingping CGS2 MQTT messages (topic `qingping/582D3470F981/up`) have richer structure than initially parsed.

**Sensor data fields** each have `{ value, status }` — not just `{ value }`:
```json
"battery": { "status": 1, "value": 61 }
```
- `battery.status`: `1` = charging (USB plugged in), `0` = discharging
- Other sensor statuses (co2, humidity, etc.) are `0` = normal

**Top-level message fields** (beyond `sensorData`):
- `mac`: device MAC address
- `type`: message type (`"12"` = single reading, `"17"` = batch with history, `"28"` = settings ack, `"40"` = alarm sync)
- `version`: firmware version (e.g., `"4.5.6_0167"`)
- `third_state`: always `1` in observed data
- `timestamp`: Unix epoch seconds

Discovered 2026-03-14 by logging the raw MQTT payload to check for charging status. The `battery.status` field was being ignored — now captured as `batteryCharging` on the live air object. When adding new Qingping features, check the raw MQTT payload structure first — there may be more useful fields beyond what `QpSensorFields` currently extracts.

## Xiaomi Cloud Auth & Device List

The `xmihome` session is a `serviceToken` persisted to `/app/data/xiaomi-credentials.json` on the `dashboard_data` volume, so **it outlives the container**: on boot `login()` short-circuits with xmihome's `Credentials (tokens) already available, skipping login` and reuses whatever token the file holds, at an age uptime cannot tell you. Our own `[xiaomi] Cloud login successful` prints on that reuse path too, so it is **not** evidence that a login happened; xmihome's `Attempting login for user` is the only line that proves one.

**Two invariants, both bought by the 2026-08-31 wedge below:**

1. **An empty device list may only ever mean the cloud answered and had nothing to report**, never that we failed to ask. `fetchPurifiersForRegion()` is the single throwing primitive: every failure (401, timeout, DNS, 5xx) rethrows, and no caller may convert one into `[]`. Callers keep their last-known cache and say so.
2. **Every path that can observe a 401 must be able to invalidate auth.** A detector that sits *behind* the thing that breaks is not a detector: when the list call is what 401s, a detector living in the per-device props loop never runs, because the loop has no devices left to iterate.

**401 detection points.** All of them key on the exported `isAuthError()` (`Unauthorized`, or `401` on a **word boundary**: a bare substring also matches a did, a byte count or a port, and a false positive drops a healthy session and deletes the credentials file). A 429, a 403 or a timeout is never an auth failure:
- `sendCommand()`, i.e. every RPC (props, control, automation actions): invalidate, then rethrow.
- `fetchPurifiersForRegion()`, i.e. every `/home/device_list` call: invalidate, then rethrow.
- `discoverRegionAndDevices()`: aborts the region scan on the first auth error instead of burning one 401 per region, and empties the cache only when **every** region answered and none held a purifier (`everyRegionAnswered`); a region that merely failed to answer keeps the last-known purifiers.

**Self-healing sequence.** `invalidateAuth()` sets `authStatus = "error"`, strips the in-memory token and unlinks the credentials file (mandatory, not hygiene: `login()` short-circuits while that file still holds `userId` + `ssecurity` + `serviceToken`, so a surviving file turns every re-login into a no-op) → the collector's `maybeReauthXiaomiCloud()` sees `!isReady()` and launches `init()` **fire-and-forget**, never awaited (see the 2026-07-02 loop freeze under Known Bugs) → a successful `init()` restores `authStatus` and clears the stale `authError` → `needs_2fa` / `needs_captcha` deliberately stops the retries and parks on a human answering `POST /api/xiaomi/verify`.

**Who polls the device list, and how often.** A dedicated `xiaomi-devices` step in the ~5s collector loop (deadlined by `runStep` like every other step) calls `refreshDevices()`; its own 5-minute freshness throttle paces that to ~12 `/home/device_list` calls per hour, and a failure arms a 60s retry gate (a failed call does not advance the cache stamp, so without the gate an outage is answered once per tick). The same step drives re-auth when the session is already down, on a **60s → 5min → 15min** backoff ladder: a login retried every minute forever is exactly what Xiaomi answers with a captcha, and a captcha needs a human. Until 2026-08-31 `refreshDevices()` had **zero callers repo-wide**, so the only thing that ever hit the device list was a browser on `/api/devices` (the `useDevices` hook polls every 10s) or Hermes on `/api/agent/snapshot`: with no admin tab open, a dead token could sit unnoticed for hours.

**Response contract, `GET /api/devices` and `GET /api/agent/snapshot`.** `available` is now the live verdict (`isReady()` plus the outcome of the fetch), not the hardcoded `true` it used to be, and both payloads carry `authStatus` (`authenticated` | `needs_2fa` | `needs_captcha` | `not_configured` | `error`). A failed fetch answers **200 with the last-known `devices`, `available: false` and `error`**, so the client keeps its tiles and marks them `Stale` (or `Unavailable` when it has nothing cached) instead of blanking them. `XiaomiVerifyPrompt` (mounted in `dashboard-tab.tsx`, fed by `useDevices`) renders the code input, the captcha image and a "Retry Sign-In" button for `POST /api/xiaomi/relogin`, which is held to one accepted call per 60s **globally**, because the resource it protects is the single Xiaomi account rather than the caller. Before this the client consumed neither `authState` nor `submitVerification`, so `POST /api/xiaomi/verify` was unreachable from the browser and a challenge could only be answered by curl.

**The 2026-08-31 wedge (both purifiers absent from the dashboard for 1h25m).** Container start 09:54:11Z reused the volume's token (the "skipping login" path), then ran healthy for five hours: 873 successful `/home/device_list` polls and 2713 successful RPCs, the last at 15:04:25Z. At 15:05:03Z, 38 seconds later (the VPS is NTP-synced, so clock skew is excluded; the token's true age is unknown because it predated the container), the list call began returning `Unauthorized`. `fetchDevicesLive()` fetches the device LIST and only then loops the results calling `getDeviceProps()` → `sendCommand()`, which was the only place that detected a 401 and called `invalidateAuth()`. The list 401'd first, its catch swallowed the error into a `log.warn` and returned `[]`, the empty list left the props loop nothing to iterate, and so the only detector never ran: `authStatus` stayed `authenticated`, `isReady()` stayed true, and nothing re-logged in. **The failure erased its own repair trigger.** Live signature: `GET /api/devices` returning `{"devices":[],"available":true,"region":"sg"}` while `GET /api/xiaomi/auth-status` returned `{"status":"authenticated"}`, both wrong. Recovery (including the manual fallback that got us out that day): [operations.md](operations.md) → "Recovering a wedged Xiaomi session". Regression suite: `xiaomi-cloud.test.ts` ([testing.md](testing.md)).

## ESP Power Monitor

**2026-08-29: the CT02 IS the meter now; the ESP is retired.** The household power feed is the CT02
(OpenBeken HLW8112) MQTT stream, not the ESP. `server/src/ct02-feed.ts` emits
`{v, i1: current_a, i2: current_b}` into the former ESP pipeline through `createRouter(...).ingestPower`
(the extracted `ingestPowerReading(v, i1, i2)`), behind env flag `CT02_POWER_METER=true` (which only
arms when `CT02_MQTT_TOPIC` is set). The ESP's `POST /api/power/ingest` route now returns **409 while
the flag is on** (single-source invariant: two interleaved meters corrupt the flicker/median
statistics); flag off = the old ESP behaviour. Cadence is split: `latestPower`, the buffer push and
the 60 s median DB write run on every accepted reading (~1 s), but the fan-out to `onPowerIngest`
(leveler + calibrator) is throttled to one per `LEVELER_FORWARD_MIN_GAP_MS` (4000 ms) because the
leveler's statistics are tuned in reading counts at the ESP's ~5 s cadence. **Voltage is real now**,
so `power_1`/`power_2` (= v×i1, v×i2) are real apparent power from 2026-08-29; the ESP era always
sent voltage 0, so those columns in `power_readings` were always 0 until this date (history charts
show the discontinuity). Clamp mapping on the mains: port A `current_a` = grid (`current_1`), port B
`current_b` = gen (`current_2`). Full record: `docs/CT02_FLASH_PLAN.md` (ESP-SWITCH RECORD 2026-08-29);
leveling-semantics note in `docs/agent/ac-leveling.md`.

**Reading the CT02 against other instruments (2026-09-27).** The HLW8112 is true-RMS; a panel
ammeter is usually average-responding and reads several percent low on the inverter ACs' distorted
current, so "the CT02 shows ~1 A more than the panel" is expected, not a fault. Never "fix" it with a
server-side offset: the only valid arbiter is a handheld true-RMS clamp read against `GET /api/diag`
at a marked moment, and a confirmed gain error goes into the chip's persisted resistor-gain trim.
**Clamp A polarity:** on 2026-09-27 `power_a` read negative under grid load in every sample (the
2026-08-29 flip did not hold), pending a physical recheck. Amps are unaffected: the pipeline uses
unsigned current and computes `power_1 = v × i1` itself. Detail: [ac-leveling.md](ac-leveling.md) →
"2026-09-27: bug hunt", item 6.

**Device & API contract (ESP era, and the shape the CT02 feed reuses):**
- ESP sends `POST /api/power/ingest` with `{ v, i1, i2 }` every 5s.
- I1 = Grid (indigo `#818cf8`), I2 = Generator (rose `#fb7185`).
- Backend computes `power_1 = v*i1`, `power_2 = v*i2`; timestamps are assigned server-side.
- Live endpoint `GET /api/current/power` serves the latest raw in-memory reading (no DB query); returns `null` if the last reading is >15s stale (3 missed readings = no electricity).

**Storage:**
- Table `power_readings` (ts, voltage, current_1, current_2, power_1, power_2) — see [database.md](database.md).
- Writes 1-minute medians (not raw values) — `powerBuffer` accumulates ingest readings, `median()` in `routes.ts` computes a per-field median every 60s.

**Tuya SHADOW feed (P2 of the ESP-replacement, added 2026-08-18):**
- A second, fully ISOLATED power feed from a ZheerHome/Tuya QS-WIFI-S04-CT02 2-clamp meter:
  compose service `tuya-bridge` (`tuya-bridge/`, Python) subscribes to Tuya Sharing-SDK cloud-MQTT
  pushes (~2.6 s fixed cadence per clamp), decodes the binary phase DPs, and POSTs ESP-shaped
  `{v, i1, i2}` to `POST /api/power/tuya-ingest` over the compose network.
- The route (`server/src/tuya-power.ts`) requires `Authorization: Bearer $TUYA_INGEST_TOKEN`
  (fail-closed 503 when the env var is unset), keeps its own in-memory latest + 60 s median
  buffer, and writes ONLY `tuya_power_readings` (same shape as `power_readings`).
- **Isolation is a hard invariant:** the shadow feed never calls `onPowerIngest`, never touches
  `latestPower`/`powerBuffer`/`power_readings` — the leveling controller's ESP-gap strain
  detection (invariant 47) and flicker statistics key off the single ESP stream. Pinned by the
  "SHADOW feed isolation" regression in `tuya-power.test.ts`.
- Observability: `GET /api/power/tuya` (auth) → `{ latest, staleSeconds, ingestCount }`.
- The ESP stays authoritative for everything; the shadow feed exists for the P3 side-by-side
  comparison and the future P4 promotion decision (design in the project memory / ops doc).
  **(OBSOLETE 2026-08-29: the ESP is retired and the CT02 is the meter, so P3/P4 are dropped; this
  Tuya cloud-shadow bridge stays deployed but idles because the device is flashed away from the
  Tuya cloud. See the banner at the top of this section.)**

**CT02 open-firmware feed + sensor diagnostics page (2026-08-23):**
- The same CT02, now reflashed with OpenBeken + our custom HLW8112 UART driver
  (`docs/CT02_FLASH_PLAN.md`), publishes directly to our Mosquitto broker — the Tuya cloud path
  above is superseded by it. `server/src/ct02-feed.ts` holds a SECOND MQTT client (client id
  `home-dashboard-ct02-*`, distinct from the collector's Qingping client or the broker would kick
  one of the two into a reconnect loop), decodes `ln882hC25E1088/<channelIndex>/get` raw integers
  into SI units, and keeps a 30-minute in-memory ring buffer.
- **Same isolation invariant as the shadow feed, and stricter:** it writes NO table at all, never
  calls `onPowerIngest`, and never touches `latestPower`. It is observability only.
  **(SUPERSEDED 2026-08-29: `ct02-feed.ts` is now THE meter. It emits into the ESP pipeline via an
  `onReading` callback to `createRouter().ingestPower` behind `CT02_POWER_METER=true`, so it drives
  `latestPower`, the median write and `onPowerIngest`; see the banner at the top of this section. The
  isolation described here was the 2026-08-23 diagnostics-only phase.)**
- **The device publishes on change only.** A channel pinned at an exact zero — which is precisely
  the port-B fault being chased — therefore goes permanently silent and looks identical to a dead
  feed. The device flag `OBK_FLAG_MQTT_BROADCASTSELFSTATEPERMINUTE` (flag 2) is enabled so every
  channel is rebroadcast each minute; the diagnostics verdict treats a port that has missed three
  of those heartbeats as *stale* and refuses to judge, rather than reporting its last value as
  current (AGENTS.md hard rule 5b — never conclude from readings older than the event).
  **(CORRECTED 2026-08-29: flag 2's self-state broadcast republishes only the self items and SKIPS
  unchanged channels, so it did NOT keep the meter channels fresh. Firmware `hlwfix3` instead
  heartbeats all six instantaneous channels every 1 Hz tick with `FORCE | SILENT`; see
  `docs/CT02_FLASH_PLAN.md` ESP-SWITCH RECORD 2026-08-29.)**
- `GET /api/diag` (auth-gated, `server/src/diagnostics.ts`) aggregates every feed: CT02 snapshot,
  the live meter reading (`latestPower`, CT02-fed since 2026-08-29), live Qingping air, newest stored
  weather/air/power/tuya rows, and 60-s-cached table counts. `GET /diag` serves a self-contained page (`server/src/diag-page.ts`, shipped as a
  string because the Dockerfile copies only `dist/`). Both are registered on a separate router
  mounted in `index.ts` AFTER the API router (so the auth middleware has run) and BEFORE
  `express.static` (or the SPA catch-all would answer `/diag` with the React app).

**Alert integration (added 2026-04-24):**
- 6 power metrics in `alert-metrics.ts` with `source: "power"`, `group: "Power"`: `voltage` (V), `power_grid`/`power_gen` (W, via dbColumn power_1/power_2), `power_total` (W, computed sum), `current_grid`/`current_gen` (A, via dbColumn current_1/current_2).
- Data plumbing: routes→collector via `onPowerIngest` callback (opposite of the air getter direction). `createRouter()` accepts the callback and calls it on each ingest. Collector stores the data as `latestPowerRow`/`latestPowerTs` via `setLatestPower()`.
- Staleness: 60s (vs 300s for weather/air): the CT02 meter forwards readings at 4s, so 60s = 15 missed readings (the retired ESP sent every 5s = 12 missed).
- **Sustained gate (added 2026-06-07)**: power alerts fire only after **4 consecutive forwarded meter readings** (~16s at the 4s forward cadence; ~20s on the retired ESP) meet the condition — `powerConditionSustained()` in `alert-metrics.ts` (pure, unit-tested in `alert-metrics.test.ts`). A gap >15s between readings breaks the streak (matches the live endpoint's ">15s stale = no electricity" rule). Collector buffers the last 8 readings (`recentPowerReadings`, appended in `setLatestPower()`). Resolution stays single-reading (any one in-range reading → idle + 10-min quiet period). Weather/air alerts unchanged (single reading).
- `power_total` is the only computed metric — handled as a special case in `getMetricValue()` before the generic lookup path.
- UI: the alerts modal auto-groups by the `group` field, so a "Power" section appears automatically with no UI code changes.
- Frontend power card layout details live in [frontend.md](frontend.md). Source detection: a line is active when its current > 0.1A; the card flashes only on a source switch.

**Power source stats (added 2026-07-09):**
- Two endpoints back the card's single-line stat row + history breakdown: `GET /api/power/stats` (session duration, rolling-24h grid hours, avg grid/gen stretch length = "time between switches" over the last 7 days via `averageSessionHours`, time-to-next-switch prediction) and `GET /api/power/day-breakdown?range=` (per-Baghdad-day grid/gen/off hours + range totals). Both are public and served by `PowerStatsService` (`server/src/power-stats-service.ts`), constructed inside `createRouter` because it needs the closure-local `latestPower`. 60s in-memory cache each; the stats cache also invalidates early when the live source flips.
- **There is no stored source/session/event table.** Everything is DERIVED on read from the `power_readings` minute stream by pure functions in `server/src/power-stats.ts` (fully unit-tested, no I/O, no `Date.now()`): classify each minute grid/gen/none via the shared `determineSource` (>0.1A rule) → `smoothFlickers` heals ≤2-min dropouts/blips → `buildSessions` collapses runs (missing minutes = blackout "none"). Daily/24h totals and the day breakdown are counted off the same minute series; day boundaries are **Baghdad-local** (permanent UTC+3, applied in JS off the epoch ms — the service issues exactly one query, the minute stream). The predictor is a separate pure module (`power-predict.ts`) fed the same sessions — see the Prediction bullet below.
- **Prediction** (`predictNextSwitch` in `server/src/power-predict.ts` — pure, no I/O, no `Date.now()`): a **slot-cycle model**. From the grid↔gen switch events in the 15-day window (transient blackouts first healed into "ration intervals") it learns the utility's ration slot grid — period chosen from a 60–240 min candidate set by recency-weighted circular concentration × boundary-use (the product is what kills harmonics: a P-periodic process also concentrates mod P/2, and concentration alone picked 60 over 120 and then predicted an hourly switch), phase = weighted circular mean — and predicts **minutes to the next slot boundary + one period per likely hold**. Holds come from a per-source, per-slot-position empirical-Bayes model (day-decayed counts, adjacent-slot kernel, pooled prior), plus a boundary-miss grace (a boundary that just passed without a switch is imminent, not a whole period away) and a learned signed end-offset. Falls back to an age-conditioned recency-weighted **survival median** when cycle confidence is low, when the state is outside anything observed (more holds than that source has ever managed), or during a blackout — which is also where blackout-recovery estimates come from. Under ~4 informative events → null (card hides the estimate). Clamped to 24h. Temperature weighting is **removed** — measured correlation ~0.11, i.e. noise.
- **Why it replaced the 2026-07-09 predictor (2026-08-05):** the old wall-clock/temp lookback backtested over 60 days at **MAE 36 min** with 27% of predictions ≥60 min off — the bimodal-median failure (a "same wall-clock time" sample straddles two different slot occupancies, and the median lands between them). The slot model holds out at **MAE ~23 min** overall / **~30 min on gen**, against a 22.7-min oracle floor.

## Forecast (Open-Meteo + CSI)

Research conducted 2026-03-15 on adding weather forecasts to the dashboard; Open-Meteo integration was subsequently built (`server/src/forecast.ts`, `server/src/calibrate.ts`, `client/src/components/sections/forecast-section.tsx`, `client/src/hooks/use-forecast.ts`, `client/src/types/forecast.ts`, `client/src/constants/forecast-utils.ts`). Zero new npm packages — just `fetch()`. `ForecastService` fetches Open-Meteo hourly forecasts and applies bias correction from a locally generated bias table (see `calibrate.ts` annotation in the Project Structure above for the `bias-data/` vs `data/` path gotcha). Served via `GET /api/forecast`.

**Clear-Sky Index (implemented first, client-side):**
- Theoretical clear-sky model (Haurwitz) in `client/src/constants/solar-model.ts` — computes GHI from solar geometry, no API needed. Full sky-condition classification details in [frontend.md](frontend.md).
- **Calibrated 2026-03-16**: Standard Haurwitz coefficients (1098, 0.057) overestimated Baghdad's clear-sky radiation by 40% at noon and up to 180% at low sun angles, causing false "Mostly Cloudy" on clear afternoons. Fixed by fitting to empirical clear-sky data: A=1250, k=0.43 (accounts for Baghdad's chronic atmospheric dust, Linke turbidity ~4–5). Verified against `/api/solar-reference` empirical data at 9 AM, noon, 3 PM, 4:30 PM — all within 3%.
- 8 sky states in `client/src/constants/sky-condition.ts` — Sunny, Partly/Mostly Cloudy, Cloudy, Light/Heavy Rain, Clear/Cloudy Night.
- Replaced the old empirical solar reference (7-day top-3-days average), which was fragile during prolonged dusty/cloudy periods.
- `/api/solar-reference` endpoint still exists on the server but is no longer fetched by the Solar card frontend. Still useful for calibration validation — returns quarter-hourly max from the top 3 clearest days in a 7-day window; times are in **local Baghdad time** (not UTC).

**Open-Meteo API facts:**
- Free, no API key, no registration — 10,000 calls/day.
- Professional NWP models (ECMWF IFS 9km, NOAA GFS 25km).
- Hourly forecasts up to 16 days: temp, humidity, cloud cover, precipitation probability, wind, UV, solar. Daily forecasts: high/low temp, sunrise/sunset, precip sum.
- **Air Quality API** with dust forecasts — particularly valuable for Baghdad dust storms.
- **Historical ERA5 API** — reanalysis data back to 1940, hourly, 10km resolution (useful for ML training).
- Example URL: `https://api.open-meteo.com/v1/forecast?latitude=33.3215&longitude=44.3583&hourly=temperature_2m,cloud_cover,precipitation&timezone=Asia/Baghdad&forecast_days=7`

**Accuracy benchmarks:**

| Method | Hourly MAE | Daily MAE |
|--------|-----------|-----------|
| Open-Meteo NWP (24h) | 1-2°C | 2-3°C |
| Local SARIMA | 1-2°C | 1-2.5°C |
| Local XGBoost/RF | 0.5-1.5°C | 1-2°C |
| Zambretti (pressure, 6-12h qualitative) | N/A | ~70-90% text accuracy |

Baghdad's arid climate is favorable — a very predictable summer diurnal cycle (MAE likely <1°C for summer next-day).

**Local ML model assessment (2026-03-15):**
- Dev PC specs: i9-13900K, 96GB RAM, RTX 4090 24GB — hardware is NOT the bottleneck.
- DB data at the time: only ~45 days in PostgreSQL (Jan 29 – Mar 15, 2026), 32,692 weather rows.
- Ambient Weather API retains 1 year max (free tier), but downsamples to 30-min after the first month. Could backfill ~11 months at 30-min resolution.
- Verdict: 45 days is far too little to train a local model — it would overfit to winter patterns and fail in summer (40-50°C). Even with API backfill (~1 year), only one annual cycle = marginal. Revisit training in early 2027 when 1+ year of continuous 5-min data is accumulated (~1 row/min growth).
- The user considered training a local model because "online forecasts don't match real numbers" — bias correction of Open-Meteo using local station data is the practical solution (this is what `calibrate.ts` + `forecast.ts` implement).

## API Rate Limits

- Ambient Weather: **1 request/sec, metered per USER** (429 body `{"error":"above-user-rate-limit"}`) — so the budget is shared across every caller, not per call site. Collector polls every 5s (sensors only update every ~5 min, dedup discards repeats). **Every AW request goes through `awGate` (a `RateGate`, `server/src/rate-gate.ts`) which serializes them 1.1s apart** — do not add raw `fetch` calls to `rt.ambientweather.net`, and do not "fix" AW pacing with a local `sleep()`; it paces a caller against itself, not against the other caller.
  - **Why the gate exists (2026-07-27):** `runForever()` fires `runBackfills()` without awaiting and then immediately enters the collection loop, so at every container restart the backfill's request and the first poll landed in the same second. The backfill lost, and its gap-fill batch (the only thing that repairs history for the minutes the container was down) was silently dropped. Cost was small — the batch covers 24h, so a later restart usually re-fills it — but it recurred on every deploy. The pre-gate `sleep(2000)` in `runBackfills()` sits BETWEEN the AW and Qingping backfills (different vendors, separate limits) and never guarded this race, despite what this line used to claim.
- Qingping MQTT (primary): Device pushes to self-hosted Mosquitto broker every ~15s. Collector subscribes to `qingping/{MAC}/up`. Interval configured via downlink to `qingping/{MAC}/down`. Readings buffered in memory; 1-minute median written to DB. `/api/current` serves in-memory latest via `collector.getLatestAir()` getter (passed to routes from index.ts). Each sensor field in the MQTT payload has `{ value, status }` — battery `status` (1=charging, 0=discharging) is extracted as `batteryCharging` on the live object.
  - **The interval setting is re-sent after a slow report (2026-11-23).** It used to go out only when the server's own MQTT client connected. The monitor ran its battery flat, rebooted on its **factory 15-minute report interval**, and the dashboard showed ~15-min-old air for 3 h (container up 32 days, so nothing re-sent it). Now any sensor reading that arrives more than `QP_SLOW_REPORT_GAP_MS` (60 s) after the previous one re-sends the setting, at most once per `QP_INTERVAL_RESEND_MIN_MS` (5 min); log line `air monitor silent Ns before this reading; re-sending its 15s interval setting`. The device acks with a type `28` message echoing `report_interval: 15` and resumes 15 s readings at once. Manual re-send (needs VPN off, broker on public port 1883): publish the same type `17` JSON from `sendIntervalConfig()` to `qingping/<MAC>/down` with the `qingping` broker user and a unique client id. Signature of the slow mode in `air_readings`: two rows per 15 min, one at :00/:15/:30/:45 sharp (cloud, device time) and one with arbitrary seconds (MQTT, arrival time).
- Qingping Cloud API (fallback): OAuth token expires in ~2 hours, refreshed 5 min before expiry. Automatically resumes when MQTT is silent >2 minutes. Its row carries the device's own sample time, which can be older than the last MQTT reading; it is still stored but **never replaces a newer live reading** (2026-11-23: a 04:15 cloud sample had overwritten a 04:21 MQTT one). Rules: **only uplink type `12` (one real-time reading) drives the live row**, and it always wins (no device-clock ordering on the MQTT side, so a clock jump after a deep reboot cannot freeze or rewind it). Uplink type `17` is a rolling **history window** (50 samples newest first, `need_ack: 1`, re-sent with every report; captured 2026-11-23); it feeds only the history buffer and the report-cadence clock, never the live row nor `lastMqttMessage` (the cloud-fallback gate). The cloud fallback follows **one rule on the server clock: the live reading's time only moves forward.** Because live MQTT is type `12` only (real-time), its arrival stamp is its sample time and compares directly with the cloud sample's time; a cloud sample replaces live only if it is newer than `latestAirTs`, no type-12 reading landed while that poll was in flight (a clock-free arrival counter `qpRealtimeSeq`, read before ANY await, token refresh included), and it is not dated after the server clock (a fast or wrong device clock: stored, and not live until it is in the past, so every later MQTT arrival is later than it and `latestAirTs` never decreases). The MQTT path also writes `latestAirTs` as never-decreasing (a server clock stepping back cannot rewind it). A cloud sample with no valid positive numeric timestamp inside the Date range (null would coerce to 1970, 1e20 is an Invalid Date) is ignored outright, not stored. No device-clock ordering state exists, by design: three review rounds of device-clock heuristics (backlog distance bounds, seen-once dedupe, capped comparisons) each left another edge where an old reading came back as live.
- Xiaomi Cloud: Managed by `xmihome`. Avoid aggressive polling: the server's own device-list step and its re-auth attempts are both throttled (cadences in "Xiaomi Cloud Auth & Device List"). Commands are sent as needed for automations or UI interactions.
- TCL Cloud: No continuous polling. Device state fetched on-demand via `/api/ac/devices` (frontend polls every 10s). Control commands sent via AWS IoT shadow publish.

## Logging

All server logging uses **pino** structured JSON logging via `logger.ts`. Import with:
```ts
import { childLogger } from "./logger.js";
const log = childLogger("component-name");
log.info("message");
log.error({ err: error }, "context message");
```
The `AppLogger` wrapper accepts console-like args (`log.error("msg", err)`) and maps them to proper pino calls. Set `LOG_LEVEL` env var to control verbosity (default: `info`).

## Health Check & Rate Limiting

- **`GET /api/health`** — Returns `{ status: "ok", uptime: N }` or 503 if DB unreachable. Placed before auth middleware. Docker HEALTHCHECK configured (30s interval, 3 retries, 15s start period).
- **Login rate limiting** — In-memory, 5 attempts per IP per 15 minutes. Returns 429 when exceeded. Cleanup interval runs every 15 min.

## Frontend Performance Patterns

- **React.memo**: All 8 card components (Temperature, Wind, Rainfall, Solar, AirQuality, Indoor, Power, Devices) are wrapped in `memo()` to prevent cascade re-renders from parent state changes.
- **Chart memoization**: All inline chart `data` and `options` objects wrapped in `useMemo()` to prevent Chart.js canvas destruction/recreation on every render. SolarCard already had this pattern.
- **History caching**: `useHistoryData` caches fetched data per range in a `useRef(Map)`. Switching chart ranges shows cached data immediately while fetching fresh data. ExpandedPowerChart has a module-level cache.
- **Code splitting**: ChartOverlay, SettingsModal, AlertsModal, LoginModal are lazy-loaded via `React.lazy()` + `Suspense`. Saves ~32KB from initial bundle.
- **`useHistoryData(range, active)`**: Respects the `active` param — skips fetch and interval when `false`.
- **`useClock`**: Already scoped to Header component only — does NOT cascade re-renders to the full app.

## Backend Performance Patterns

- **`/api/current` parallel queries**: Weather, air, power DB fallback queries run via `Promise.all()` (not sequential). In-memory caches skip the query entirely.
- **Background backfill**: `runBackfills()` fires AW + QP backfill asynchronously — doesn't block the main collection/automation loop. AW backfill covers 24h of history (288 records) on startup.
- **Batch inserts**: `storeAirBatch()` and `storeWeatherBatch()` do multi-row INSERT for backfill (was one row at a time).
- **`median()` in routes.ts**: Exported and tested. Used for power 1-min median writes.

### Performance Audit Background (2026-03-14)

A full tech-stack audit on 2026-03-14 produced 14 optimizations across 3 tiers (all implemented and deployed). The stack scored 7.5/10 overall — the architecture was solid but the frontend had React re-render waste and the backend had sequential query patterns. Key findings:
- Backend (Node.js + Express + PostgreSQL) is appropriate — I/O-bound, not CPU-bound. Switching to Go/Rust/Fastify would yield <5ms improvement per request.
- Frontend (React) had the most waste: no React.memo on any card, chart options recreated every render, useHistoryData fetched even when inactive.
- useClock was already scoped to Header only — it does NOT cascade re-renders app-wide (contrary to the initial assessment).
- SolarCard already had proper useMemo on chartData/chartOptions — a good pattern to follow.

What was implemented:
- Tier 1: useHistoryData active guard, parallel `/api/current` queries, React.memo on all cards (7 at the time of the audit; now 8 — Devices was added later), useMemo on all chart data/options.
- Tier 2: Batch backfill inserts (storeAirBatch/storeWeatherBatch), background backfill (runBackfills), `/api/health` endpoint + Docker HEALTHCHECK, login rate limiting (5/15min/IP), history data caching between range switches.
- Tier 3: Pino structured logging (all 5 server files at the time), Docker resource limits (2GB/2CPU dashboard, 64MB mosquitto), code splitting (4 lazy-loaded modals), vitest + 11 initial tests (the suite has grown since — see [testing.md](testing.md)).

How to apply: for frontend changes, always use React.memo for new card/section components and useMemo for chart data/options objects. For new server modules, use `childLogger("name")` from logger.ts instead of console.log. Run `cd server && npm test` after auth or utility changes.

## Docker Resource Limits

- Dashboard container: 2GB RAM, 2 CPUs
- Mosquitto container: 64MB RAM, 0.25 CPU

## Timezone Gotcha: VPS is UTC, App Targets Baghdad (UTC+3)

Discovered 2026-03-29 while debugging prayer alerts that never fired.

**The problem:** The VPS runs in **UTC**; the app targets **Baghdad (UTC+3)**. Between 21:00 UTC and 00:00 UTC (midnight–3am Baghdad), the UTC calendar date is one day behind Baghdad's. A library that extracts year/month/day from a Date using **local timezone methods** (`getFullYear()`, `getMonth()`, `getDate()`) — as the old `adhan` library did — gets the wrong day's prayer times when passed `new Date()` on a UTC server at midnight Baghdad. The cache gets poisoned at midnight Baghdad and stays wrong for 24 hours.

**Prayer times no longer hit this trap.** Since 2026-06-19 prayer calculation goes through the in-repo **`prayer-engine`** (`server/src/prayer-engine/`), pinned via `server/src/prayer.ts` with `{ method: "BaghdadYMA", timezone: "Asia/Baghdad" }`. The engine anchors "which civil day" itself (`zonedMidnightUtc` in `timezone.ts`), so the old noon-construction hack is gone from prayer code. Baghdad minute-of-day / date-key helpers (`baghdadMinuteOfDay`, `baghdadDateKey` in `prayer.ts`) use `Intl.DateTimeFormat(..., { timeZone })`, replacing the fragile `toLocaleString` re-parse for prayer paths.

**The toLocaleString re-parse pattern** still appears elsewhere in `collector.ts` (e.g. `checkScheduleAutomation`, `getBaghdadMinutes` in `automation-slots.ts`) to get Baghdad hours/minutes:
```typescript
const bStr = date.toLocaleString("en-US", { timeZone: "Asia/Baghdad" });
const bd = new Date(bStr); // re-parsed as local (UTC) Date
bd.getHours(); // returns Baghdad hours (works because string was Baghdad-formatted)
```
This is fragile but works. Do NOT "fix" it unless it breaks.

**Rule:** any time a library extracts local date components, give it a Date that represents the right Baghdad day — pass an explicit IANA timezone (as the prayer-engine does), or use the noon-construction pattern (`new Date(y, m-1, d, 12, 0, 0)` from the Baghdad date string). Never pass raw `new Date()`.

## Known Bugs

### Air median SMALLINT overflow (`storeAirMedian`)

Observed 2026-05-01 in production logs: `invalid input syntax for type smallint: "692.5"` from `storeAirMedian()` in `collector.ts`. The 1-minute median calculation can produce fractional values (e.g., median of [690, 695] = 692.5) but the `air_readings` table uses SMALLINT columns (co2, pm25, pm10, tvoc, noise, battery). The median helper needs to round to an integer before insert.

- **Why it surfaced:** tVOC values recently spiked to the ~700 ppb range, making fractional medians more likely to be non-integer.
- **Fix:** round SMALLINT fields to the nearest integer in `storeAirMedian()` (collector.ts) before inserting. The `median()` helper in `routes.ts` (used for power readings) does NOT have this issue because power columns are REAL, not SMALLINT.

### Collection loop froze on Xiaomi 2FA re-auth — FIXED 2026-07-02

Observed in production: the weather card (and all loop-driven work) stopped updating for ~4h with **no error logs**. Root cause: the Xiaomi Cloud session expired (401); the in-loop re-auth `await this.xiaomiCloud.init()` in `checkAutomations()` blocked forever, because `init()`'s `on2fa`/`onCaptcha` callbacks (`xiaomi-cloud.ts`) return promises that only resolve when a code is submitted via `POST /api/xiaomi/verify`. Since `collectAll()` (`runForever`) awaits `checkAutomations()`, the whole loop parked on the un-answered 2FA prompt. Weather is the first task each cycle, so it froze at the last completed iteration; **alerts/push, AC schedule/metric automations, timers, beep enforcement, and calibration were all frozen too.** Air/power/AC-leveling kept working only because they run independently of the loop (air via MQTT push, power via ESP `POST`, urgent leveling re-triggered from the power-ingest path) — which masked the freeze.

- **Principle:** nothing awaited inside the `collectAll` loop may block on human input or an unbounded wait. Cloud re-auth (which can demand 2FA/captcha) must be **fire-and-forget**, mirroring the non-blocking startup init (`this.initXiaomiCloud().catch(...)` in `runForever`).
- **Fix:** `checkAutomations()` now launches `void this.xiaomiCloud.init().catch(...)` and sets `xiaomiRetryAt` before the launch (both moved into `maybeReauthXiaomiCloud()` on 2026-08-31, which the periodic `xiaomi-devices` step calls too); the existing `status !== "needs_2fa"/"needs_captcha"` guard prevents relaunching while a prompt is pending. Regression test in `collector.test.ts` ("in-loop Xiaomi re-auth does not block the collection loop"). Recovery when it happens live: `POST /api/xiaomi/relogin`, then answer the challenge in the dashboard's Xiaomi banner (or via `/api/xiaomi/verify`); a container restart is the last resort and only works if `/app/data/xiaomi-credentials.json` is deleted first, because `login()` short-circuits on the stale token. Full runbook in [operations.md](operations.md) → "Recovering a wedged Xiaomi session". The in-loop **TCL** re-auth (`this.tclCloud.init()`) was hardened the same way (fire-and-forget) as defense-in-depth: TCL auto-refreshes with no human 2FA today, but no in-loop cloud re-auth may block.

### Collection loop stalled ~3h on an un-deadlined TCL publish — FIXED 2026-07-06 (stall #2, now structurally prevented)

Second silent loop freeze in 4 days (2026-07-06 ~00:00–03:03 UTC): zero log lines for ~3h — no weather stores, no automations, no beep enforcement, no leveler loop ticks — while HTTP routes and ESP ingest stayed alive (masking it again) and the container stayed "healthy". During the stall the household ran a heater on the 15A gen with NO trip protection (urgent leveling ticks coalesce into the wedged in-flight loop pass). Prime suspect confirmed by audit: `publishShadowUpdate` (`tcl-cloud.ts`) used the AWS SDK `IoTDataPlaneClient.send()` **with no timeout** — the SDK ships without one, so a half-open HTTPS connection hangs the await forever, and the sequential loop dies with it (routes kept working because each call builds a fresh client).

**The loop-never-blocks principle is now enforced by construction, not by auditing each await:**
- **Per-step deadline:** every `collectAll()` step runs through `runStep(name, fn)` (90s, `STEP_TIMEOUT_MS`); a step that exceeds it is abandoned (logged with its name) and the loop continues — steps are per-tick idempotent. The Xiaomi/TCL init retries are wrapped too.
- **Leveling pass deadline:** `runLevelingCheck()` races each `checkAcLeveling()` pass against 60s and clears the in-flight promise on timeout, so urgent (emergency) ticks can never queue forever behind a wedged pass.
- **AWS IoT publish deadline:** `client.send(..., { abortSignal: AbortSignal.timeout(15_000) })` + `destroy()` in `finally`. All other fetches in tcl-cloud/collector/forecast have `AbortSignal.timeout` too.
- **Watchdog (independent `setInterval`, 30s):** heartbeat (`lastLoopTickAt`) advances per cycle AND per finished/abandoned step. Stale > 60s → warn naming the in-flight step (self-diagnosing); stale > 3 min → `process.exit(1)` and Docker's `restart: unless-stopped` revives the container (locks/sheds/fan-holds/config are DB-persisted). `/api/health` exposes `loopAgeMs` and reports 503 `loop-stalled` past 3 min.
- Regression tests: "abandons a hung step at its deadline" + "watchdog warns below 3 min and exits past it" (`collector.test.ts`).
