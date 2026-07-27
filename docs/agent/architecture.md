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

**4 physical sensors, 2 APIs, 2 Purifiers, 3 ACs:**
- **Ambient Weather WS-2000** (station MAC C8:C9:A3:0E:CB:CB; 1 API device, 3 sensor groups in `lastData`):
  - Outdoor: temp, humidity, wind, rain, pressure, UV, solar (~1 min updates)
  - Indoor console: temp, humidity, feels like, dew point (`tempinf`, `humidityin`, `feelsLikein`, `dewPointin`)
  - Channel 8 "Abdu": temp, humidity, feels like, dew point (`temp8f`, `humidity8`, `feelsLike8`, `dewPoint8`)
- **Qingping Air Monitor CGS2** (MAC 582D3470F981): CO2, PM2.5, PM10, tVOC, noise, temp, humidity, battery (~15s via MQTT, cloud API fallback ~15 min). MQTT payload includes `battery: { value: number, status: number }` — `status: 1` = charging (USB plugged), `status: 0` = discharging. `batteryCharging` flag is added to the in-memory live air object (not stored in DB). Full payload structure below in "Qingping MQTT Payload Structure".
- **Xiaomi Mi Air Purifiers**:
  - "mom": `zhimi.airpurifier.v7` (older MiIO protocol)
  - "Abdu": `zhimi.airpurifier.vb2` (modern MIoT protocol)
- **TCL Split ACs** (3 units, all on dashboard via TCL Home cloud API):
  - "Najat" → Mom label, "Abdu AC" → Abdu label, "Abdullah AC" → Abdullah label — all in the Devices card. Cloud client details in [tcl-ac.md](tcl-ac.md).
- **ESP Power Monitor**: Custom ESP device on home mains, sends voltage + current on two lines (Grid=I1, Generator=I2) via `POST /api/power/ingest` every 5s. Server computes power (W = V × A), buffers in memory, and writes 1-minute median to `power_readings` table. Live endpoint (`GET /api/current/power`) returns `null` if last reading is >15s stale (ESP sends every 5s, so 3 missed = no electricity). Frontend power card shows `0.00 kW / 0 V / 0.0 A` in white when no data (instead of `--`). Full details below in "ESP Power Monitor".

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
- **TCL Cloud**: see [tcl-ac.md](tcl-ac.md) for the full client (auth chain, AWS IoT shadow, `executeAcAction`, `computeAcDiff`, model-aware filtering, firmware quirks).
- **Automations** (purifier metric rules, AC thermostat hysteresis + range slots, schedules, timers, manual-off locks): see [ac-automations.md](ac-automations.md).
- **Smart AC Leveling** (current-budget controller, shed/restore, calibration): see [ac-leveling.md](ac-leveling.md).
- **Separate docker-compose**: Lives at `/opt/home-dashboard/` on the VPS, joins the existing `rag_default` network.
  - Mounts `dashboard_data` volume to `/app/data` for `xiaomi-credentials.json` and `tcl-credentials.json`.
- **Multi-stage Docker build**: Stage 1 builds client (Vite), Stage 2 builds server (tsc), Stage 3 runs production Node.js
- **Database**: Uses the existing `rag-postgres-1` container (pgvector:pg16). The `home` database is auto-created on first startup. Full schema in [database.md](database.md).
- **Push Notifications**: Web Push via VAPID keys (in VPS `.env`). Service worker at `client/public/sw.js` handles push display + click-to-focus. Subscriptions synced to `push_subscriptions` table on page load. **Smart AC Leveling notifications (shed/restore + "AC Calibration finished") are per-device opt-in, OFF by default** — `broadcastPush` only sends to subscriptions with `leveling_notifications = true`; each device toggles it via `GET`/`POST /api/push/leveling` (the "Smart AC Leveling alerts" switch in the Alerts modal). Sensor/prayer alerts remain per-endpoint via `alert_rules`. Alert metrics span 4 groups: Outdoor (weather), Indoor (weather), Air Quality (Qingping), Power (ESP). Power metrics use 60s staleness threshold (vs 300s for weather/air). Power data flows routes→collector via `onPowerIngest` callback (opposite direction from air data). **Power alerts require 4 consecutive ESP readings** (~20s) meeting the condition before firing (`powerConditionSustained()` in `alert-metrics.ts`, pure + unit-tested; gap >15s between readings breaks the streak; collector buffers last 8 readings in `recentPowerReadings`) — single-spike immunity for fluctuating power. Weather/air alerts still fire on a single reading.
- **Authentication**: Cookie-based JWT auth using HMAC-SHA256 (zero npm deps — uses Node.js `crypto`).
  - `server/src/auth.ts`: `signToken`/`verifyToken`, cookie parsing, `authMiddleware` (sets `req.authenticated` on every request), `requireAuth` guard, login/logout/status handlers, `clientIp()` (Cloudflare `cf-connecting-ip`, else the socket peer; `x-forwarded-for` is deliberately not trusted — client-supplied — and `clientIp` also backs the login rate limiter, which previously bucketed every attempt into Traefik's single peer address).
  - **Caller identity — `req.authKind` (`"user" | "agent"`, added 2026-07-24):** sessions minted by `POST /api/agent/session` carry an `agent: true` JWT claim; a human login does not, and a raw Hermes bearer counts as `agent` too. Before this, an agent session was byte-identical to a human one, so an AC turned on "by the dashboard" could not be attributed (see the 2026-07-24 incident in [ac-automations.md](ac-automations.md)). **Rotating `AUTH_SECRET` is what retires the old untagged 30-day cookies** — without a rotation an existing agent cookie keeps reading as `user` until it expires.
  - Credential compare uses `crypto.timingSafeEqual`. JWT stored in `auth` httpOnly cookie (30-day expiry, `Secure` in production, `SameSite=Strict`).
  - **Guest (unauthenticated):** Sees Outdoor, Air Quality, Prayer sections. Cannot access device/AC/automation/xiaomi-auth APIs (12 routes return 401).
  - **Admin (authenticated):** Sees everything including Indoor section, full device control, automations panel in alerts modal.
  - Frontend: `AuthProvider` context in `use-auth.ts`, `LoginModal` glass-card component, Header shows "Login" pill button (guest) or LogOut icon (admin).
  - Hooks `useDevices(enabled)` and `useAcDevices(enabled)` accept an `enabled` param — skip all fetches when `!isAdmin`.
  - **Hermes agent access** (bearer token): `HERMES_API_TOKEN` env var (`hermesApiToken` in config.ts; bearer auth disabled when empty). `POST /api/agent/session` exchanges a valid bearer token for an admin auth cookie; `GET /api/agent/snapshot` returns a consolidated dashboard payload (weather, air, devices, forecast, automations, prayer times). Integration-tested in `agent-routes.test.ts`.

## Project Structure

```
D:\dev\home\
├── server/                 # Node.js backend (Express + TypeScript)
│   ├── src/
│   │   ├── index.ts        # Express app, static serving, collector startup, wires getters (xiaomi, tcl, latestAir, forecast) and power ingest callback to routes
│   │   ├── routes.ts       # API routes (/api/current, /api/history?source=weather|air&range=6h|24h|48h|1w|30d, /api/status, /api/solar-reference, /api/alerts CRUD, /api/xiaomi/*, /api/ac/*, /api/ac/timer*, /api/ac/presets/* CRUD, /api/ac/preset-apply, /api/automations CRUD+test, /api/auth/*, /api/forecast, /api/agent/* — see Hermes agent access). Power ingest + buffer here; air served via getLatestAir getter from collector. AC timers stored in-memory (acTimers Map). AC presets stored in `ac_presets` table (server-side). Power ingest calls onPowerIngest callback to sync data to collector for alerts. Automation rule invalidation via onAutomationRulesChanged callback.
│   │   ├── auth.ts         # JWT auth (HMAC-SHA256), cookie middleware (sets req.authenticated + req.authKind user|agent), clientIp(), login/logout/status handlers, rate limiting (5/15min per IP)
│   │   ├── collector.ts    # Collector class (AW polling + Qingping MQTT/cloud + automation loop). Air buffer + storeAirMedian() for 1-min median writes. Public getLatestAir() getter, setLatestPower() setter (receives power data from routes via callback), invalidateAutomationRules() (resets 30s rule cache for immediate reload). Backfill runs in background (non-blocking). Batch inserts for backfill. Prayer time helpers: ensurePrayerTimesForToday(), resolvePrayerMinutes(). Automation methods: checkMetricAutomation (purifier single-threshold), checkAcRangeAutomation (AC hysteresis), checkScheduleAutomation, checkAcTimers. executeAutomationAction routes to xiaomi or tcl based on device_type. Also owns persistent AC manual-off lock state (`ac_manual_off_locks`) and in-memory per-rule+device fan enforcement (`acFanEnforcement` — resolveRangeFan/effectiveAcRangeProfile/updateAcFanTracking/noteUserAcFanChange, plus stripLeveledControls/refreshAcFanBaseline for leveler fan-hold deference).
│   │   ├── xiaomi-cloud.ts # Wrapper for xmihome, protocol routing, device discovery, auth
│   │   ├── tcl-cloud.ts    # TCL Home API client (auth chain, AWS IoT shadow, SigV4 signing)
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

## ESP Power Monitor

**Device & API contract:**
- ESP sends `POST /api/power/ingest` with `{ v, i1, i2 }` every 5s.
- I1 = Grid (indigo `#818cf8`), I2 = Generator (rose `#fb7185`).
- Backend computes `power_1 = v*i1`, `power_2 = v*i2`; timestamps are assigned server-side.
- Live endpoint `GET /api/current/power` serves the latest raw in-memory reading (no DB query); returns `null` if the last reading is >15s stale (3 missed readings = no electricity).

**Storage:**
- Table `power_readings` (ts, voltage, current_1, current_2, power_1, power_2) — see [database.md](database.md).
- Writes 1-minute medians (not raw values) — `powerBuffer` accumulates ingest readings, `median()` in `routes.ts` computes a per-field median every 60s.

**Alert integration (added 2026-04-24):**
- 6 power metrics in `alert-metrics.ts` with `source: "power"`, `group: "Power"`: `voltage` (V), `power_grid`/`power_gen` (W, via dbColumn power_1/power_2), `power_total` (W, computed sum), `current_grid`/`current_gen` (A, via dbColumn current_1/current_2).
- Data plumbing: routes→collector via `onPowerIngest` callback (opposite of the air getter direction). `createRouter()` accepts the callback and calls it on each ingest. Collector stores the data as `latestPowerRow`/`latestPowerTs` via `setLatestPower()`.
- Staleness: 60s (vs 300s for weather/air) — ESP sends every 5s, so 60s = 12 missed readings.
- **Sustained gate (added 2026-06-07)**: power alerts fire only after **4 consecutive ESP readings** (~20s) meet the condition — `powerConditionSustained()` in `alert-metrics.ts` (pure, unit-tested in `alert-metrics.test.ts`). A gap >15s between readings breaks the streak (matches the live endpoint's "3 missed = no electricity" rule). Collector buffers the last 8 readings (`recentPowerReadings`, appended in `setLatestPower()`). Resolution stays single-reading (any one in-range reading → idle + 10-min quiet period). Weather/air alerts unchanged (single reading).
- `power_total` is the only computed metric — handled as a special case in `getMetricValue()` before the generic lookup path.
- UI: the alerts modal auto-groups by the `group` field, so a "Power" section appears automatically with no UI code changes.
- Frontend power card layout details live in [frontend.md](frontend.md). Source detection: a line is active when its current > 0.1A; the card flashes only on a source switch.

**Power source stats (added 2026-07-09):**
- Two endpoints back the card's single-line stat row + history breakdown: `GET /api/power/stats` (session duration, rolling-24h grid hours, avg grid/gen stretch length = "time between switches" over the last 7 days via `averageSessionHours`, temp-weighted time-remaining prediction) and `GET /api/power/day-breakdown?range=` (per-Baghdad-day grid/gen/off hours + range totals). Both are public and served by `PowerStatsService` (`server/src/power-stats-service.ts`), constructed inside `createRouter` because it needs the closure-local `latestPower`. 60s in-memory cache each; the stats cache also invalidates early when the live source flips.
- **There is no stored source/session/event table.** Everything is DERIVED on read from the `power_readings` minute stream by pure functions in `server/src/power-stats.ts` (fully unit-tested, no I/O, no `Date.now()`): classify each minute grid/gen/none via the shared `determineSource` (>0.1A rule) → `smoothFlickers` heals ≤2-min dropouts/blips → `buildSessions` collapses runs (missing minutes = blackout "none"). Daily/24h totals and the day breakdown are counted off the same minute series; day boundaries are **Baghdad-local** (permanent UTC+3; the hourly-temp query uses a `to_char(... AT TIME ZONE 'Asia/Baghdad')` TEXT key to dodge node-pg's local-time parsing of tz-less timestamps).
- **Prediction** (`predictRemainingMinutes`): samples the previous 14 days at the same Baghdad wall-clock instant (exact 24h back-steps), keeps days whose session then had the same source, weights each by outdoor-temp similarity to now (Gaussian kernel σ=4 °C; missing hist temp → 0.25), and takes the weighted median of "minutes until that session ended". The current (right-censored) session is excluded; <2 usable days → null (card hides the estimate). Clamped to 24h. Pattern mirrors `forecast.ts` (same-time-of-day bucketing).

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

- Ambient Weather: 1 request/sec. Collector polls every 5s (sensors only update every ~5 min, dedup discards repeats). 2-second sleep after backfill prevents 429 on the first collection cycle
- Qingping MQTT (primary): Device pushes to self-hosted Mosquitto broker every ~15s. Collector subscribes to `qingping/{MAC}/up`. Interval configured via downlink to `qingping/{MAC}/down`. Readings buffered in memory; 1-minute median written to DB. `/api/current` serves in-memory latest via `collector.getLatestAir()` getter (passed to routes from index.ts). Each sensor field in the MQTT payload has `{ value, status }` — battery `status` (1=charging, 0=discharging) is extracted as `batteryCharging` on the live object.
- Qingping Cloud API (fallback): OAuth token expires in ~2 hours, refreshed 5 min before expiry. Automatically resumes when MQTT is silent >2 minutes.
- Xiaomi Cloud: Managed by `xmihome`. Avoid aggressive polling. Commands are sent as needed for automations or UI interactions.
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
- **Fix:** `checkAutomations()` now launches `void this.xiaomiCloud.init().catch(...)` and sets `xiaomiRetryAt` before the launch; the existing `status !== "needs_2fa"/"needs_captcha"` guard prevents relaunching while a prompt is pending. Regression test in `collector.test.ts` ("in-loop Xiaomi re-auth does not block the collection loop"). Recovery when it happens live: restart the dashboard container (startup init is non-blocking) then submit a fresh 2FA code via `/api/xiaomi/verify`. The in-loop **TCL** re-auth (`this.tclCloud.init()`) was hardened the same way (fire-and-forget) as defense-in-depth — TCL auto-refreshes with no human 2FA today, but no in-loop cloud re-auth may block.

### Collection loop stalled ~3h on an un-deadlined TCL publish — FIXED 2026-07-06 (stall #2, now structurally prevented)

Second silent loop freeze in 4 days (2026-07-06 ~00:00–03:03 UTC): zero log lines for ~3h — no weather stores, no automations, no beep enforcement, no leveler loop ticks — while HTTP routes and ESP ingest stayed alive (masking it again) and the container stayed "healthy". During the stall the household ran a heater on the 15A gen with NO trip protection (urgent leveling ticks coalesce into the wedged in-flight loop pass). Prime suspect confirmed by audit: `publishShadowUpdate` (`tcl-cloud.ts`) used the AWS SDK `IoTDataPlaneClient.send()` **with no timeout** — the SDK ships without one, so a half-open HTTPS connection hangs the await forever, and the sequential loop dies with it (routes kept working because each call builds a fresh client).

**The loop-never-blocks principle is now enforced by construction, not by auditing each await:**
- **Per-step deadline:** every `collectAll()` step runs through `runStep(name, fn)` (90s, `STEP_TIMEOUT_MS`); a step that exceeds it is abandoned (logged with its name) and the loop continues — steps are per-tick idempotent. The Xiaomi/TCL init retries are wrapped too.
- **Leveling pass deadline:** `runLevelingCheck()` races each `checkAcLeveling()` pass against 60s and clears the in-flight promise on timeout, so urgent (emergency) ticks can never queue forever behind a wedged pass.
- **AWS IoT publish deadline:** `client.send(..., { abortSignal: AbortSignal.timeout(15_000) })` + `destroy()` in `finally`. All other fetches in tcl-cloud/collector/forecast have `AbortSignal.timeout` too.
- **Watchdog (independent `setInterval`, 30s):** heartbeat (`lastLoopTickAt`) advances per cycle AND per finished/abandoned step. Stale > 60s → warn naming the in-flight step (self-diagnosing); stale > 3 min → `process.exit(1)` and Docker's `restart: unless-stopped` revives the container (locks/sheds/fan-holds/config are DB-persisted). `/api/health` exposes `loopAgeMs` and reports 503 `loop-stalled` past 3 min.
- Regression tests: "abandons a hung step at its deadline" + "watchdog warns below 3 min and exits past it" (`collector.test.ts`).
