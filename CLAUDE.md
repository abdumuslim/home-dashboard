# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Home environmental monitoring dashboard at **https://home.altijwal.com**. Node.js/Express backend with React/TypeScript frontend, collects data from two sensor APIs, stores in PostgreSQL, and serves a dark-themed dashboard with live-updating cards and Chart.js charts. It also automates Xiaomi Mi Air Purifiers based on air quality metrics.

**4 physical sensors, 2 APIs, 2 Purifiers, 3 ACs:**
- **Ambient Weather WS-2000** (1 API device, 3 sensor groups in `lastData`):
  - Outdoor: temp, humidity, wind, rain, pressure, UV, solar (~1 min updates)
  - Indoor console: temp, humidity, feels like, dew point (`tempinf`, `humidityin`, `feelsLikein`, `dewPointin`)
  - Channel 8 "Abdu": temp, humidity, feels like, dew point (`temp8f`, `humidity8`, `feelsLike8`, `dewPoint8`)
- **Qingping Air Monitor CGS2**: CO2, PM2.5, PM10, tVOC, noise, temp, humidity (~30s via MQTT, cloud API fallback ~15 min)
- **Xiaomi Mi Air Purifiers**:
  - "mom": `zhimi.airpurifier.v7` (older MiIO protocol)
  - "Abdu": `zhimi.airpurifier.vb2` (modern MIoT protocol)
- **TCL Split ACs** (3 units, 2 on dashboard via TCL Home cloud API):
  - "Najat" → Mom card, "Abdu AC" → Abdu card, "Abdullah AC" (not displayed)

## Architecture

```
Browser → Cloudflare → Traefik (VPS, existing) → dashboard container (port 8000)
                                                        ↓
                                                  PostgreSQL (VPS, existing, db=home)
```

- **Backend**: Express 5 (Node.js/TypeScript) serves REST API + static frontend + runs collector in background
- **Frontend**: React + TypeScript + Vite + Tailwind CSS v4 + lucide-react icons
- **Xiaomi Cloud**: Integrated via `xmihome` library (custom wrapper in `xiaomi-cloud.ts`).
  - Supports 2FA (credentials/token cached in persistent volume).
  - Handles both **MiIO** (`get_prop`, `set_power`) and **MIoT** (`get_properties`, `set_properties`) protocols.
  - **MIoT Mappings**: Power (2:2), Fan Level (2:4), Mode (2:5), AQI (3:6), Humidity (3:7), Temperature (3:8), Filter Life (4:3), Buzzer (5:1), LED (6:6), Child Lock (7:1).
- **TCL Cloud**: Custom API client in `tcl-cloud.ts` (reverse-engineered TCL Home app).
  - Auth chain: TCL login → token refresh (saasToken + cognitoToken) → AWS Cognito credentials
  - Device state via AWS IoT Shadow (`GetThingShadow`), control via shadow publish
  - Credentials cached in `/app/data/tcl-credentials.json`
- **Automations**: Two types processed in the collector loop, configurable via dashboard:
  - **Metric-based**: AQI threshold triggers (e.g., PM2.5 above 50 → turn on purifier, off when below).
  - **Schedule-based**: Daily time window enforcement (e.g., 22:00–07:00 → keep purifier ON, re-sends turn-on every ~5s if device found off). Uses `getDevicePower()` with 5s cache.
- **Separate docker-compose**: Lives at `/opt/home-dashboard/` on the VPS, joins the existing `rag_default` network.
  - Mounts `dashboard_data` volume to `/app/data` for `xiaomi-credentials.json` and `tcl-credentials.json`.
- **Multi-stage Docker build**: Stage 1 builds client (Vite), Stage 2 builds server (tsc), Stage 3 runs production Node.js
- **Database**: Uses the existing `rag-postgres-1` container (pgvector:pg16). The `home` database is auto-created on first startup

## Project Structure

```
D:\dev\home\
├── server/                 # Node.js backend (Express + TypeScript)
│   ├── src/
│   │   ├── index.ts        # Express app, static serving, collector startup
│   │   ├── routes.ts       # API routes (/api/current, /api/history, /api/status, /api/alerts CRUD, /api/xiaomi/*, /api/ac/*)
│   │   ├── collector.ts    # Collector class (AW polling + Qingping MQTT/cloud + AQI automation loop)
│   │   ├── xiaomi-cloud.ts # Wrapper for xmihome, protocol routing, device discovery, auth
│   │   ├── tcl-cloud.ts    # TCL Home API client (auth chain, AWS IoT shadow, SigV4 signing)
│   │   ├── alert-metrics.ts # Shared metrics catalog, getMetricValue, PRAYER_LABELS
│   │   ├── database.ts     # pg pool, schema init, migrations (added automations table)
│   │   └── config.ts       # Env vars (dotenv)
│   ├── package.json
│   └── tsconfig.json
├── client/                 # React frontend (Vite + Tailwind)
│   ├── src/
│   │   ├── main.tsx        # Entry point, Chart.js registration
│   │   ├── App.tsx         # Root component with tabs
│   │   ├── index.css       # Tailwind theme + custom wind/flash CSS
│   │   ├── hooks/          # useCurrentData, useHistoryData, useClock, useFlash, useAlerts, usePushNotifications, useDevices, useAcDevices, useAutomations
│   │   ├── components/     # Header, sections, cards, charts, AlertsModal
│   │   ├── types/          # API type definitions (api.ts, alerts.ts, automations.ts, ac.ts)
│   │   └── constants/      # Thresholds, directions, helpers, alert-metrics
│   ├── vite.config.ts
│   └── package.json
├── mosquitto/              # MQTT broker config
│   └── config/
│       └── mosquitto.conf  # Broker config (passwd file generated on VPS)
├── Dockerfile              # Multi-stage (node:22-slim)
├── docker-compose.yml      # dashboard + mosquitto services + data volume
└── .env                    # On VPS only (MI_EMAIL, MI_PASSWORD, MI_REGION=sg, TCL_USERNAME, TCL_PASSWORD)
```

## Development

```bash
# Frontend dev (with proxy to live API)
cd client && npm run dev

# Server type-check
cd server && npx tsc --noEmit

# Client type-check
cd client && npx tsc -b

# Client build
cd client && npx vite build
```

The Vite dev server proxies `/api/*` to `https://home.altijwal.com` so no local backend is needed for frontend work.

## Deployment

```bash
# Create tarball excluding node_modules
cd D:/dev/home && tar czf /tmp/home-deploy.tar.gz --exclude='node_modules' --exclude='dist' --exclude='.git' server client mosquitto Dockerfile docker-compose.yml

# Upload and rebuild
scp -i ~/.ssh/vps1_key -o StrictHostKeyChecking=no /tmp/home-deploy.tar.gz root@31.97.76.221:/tmp/
ssh -i ~/.ssh/vps1_key -o StrictHostKeyChecking=no root@31.97.76.221 "cd /opt/home-dashboard && tar xzf /tmp/home-deploy.tar.gz && docker compose up -d --build"

# IMPORTANT: After tar extract, regenerate mosquitto passwd (tar overwrites the config dir):
ssh -i ~/.ssh/vps1_key -o StrictHostKeyChecking=no root@31.97.76.221 "rm -f /opt/home-dashboard/mosquitto/config/passwd && docker run --rm -v /opt/home-dashboard/mosquitto/config:/mosquitto/config eclipse-mosquitto:2 mosquitto_passwd -c -b /mosquitto/config/passwd qingping dratafat && chmod 644 /opt/home-dashboard/mosquitto/config/passwd && docker restart home-dashboard-mosquitto-1"
```

Vite adds content hashes to built assets (e.g., `index-abc123.js`) — no manual cache busting needed.

## SSH to VPS

SSH stdout is not captured by the Bash tool. Always redirect to a file then read it:
```bash
ssh -i ~/.ssh/vps1_key -o StrictHostKeyChecking=no root@31.97.76.221 "command" > D:/dev/home/ssh_out.txt 2>&1
# then Read D:\dev\home\ssh_out.txt
```

## Database Schema

Three main tables in the `home` database:
- `weather_readings` — 32 columns, keyed by `ts TIMESTAMPTZ` with BRIN index (metric units, all conversions done at collection time). Includes outdoor, indoor console, and ch8 "Abdu" sensor data.
- `air_readings` — 9 columns, keyed by `ts TIMESTAMPTZ` with BRIN index
- `alert_rules` — per-subscription alert configurations (FK to `push_subscriptions.endpoint` with CASCADE). Fields: `alert_type` (sensor/prayer), `metric`, `condition` (above/below), `threshold`, `prayer_timing` (at_time/before), `prayer_minutes`, `prayer_names TEXT[]`.
- `automations` — Purifier automation rules. Fields: `id`, `automation_type` (metric/schedule), `device_ids`, `device_names`, `metric`, `condition`, `threshold`, `sustained_minutes` (metric type), `time_start`, `time_end`, `turn_off_at_end` (schedule type), `action_on`, `action_off`, `cooldown_secs`, `enabled`.

New columns/tables added via `MIGRATIONS` list in `database.ts`. Deduplication: `ON CONFLICT (ts) DO NOTHING`. The 30-day history endpoint downsamples to hourly averages.

## Dashboard Layout

4 sections with tabs (Dashboard / Charts):
- **Outdoor** (4-col grid): Temperature, Wind, Rainfall (+ Barometer), Solar
- **Indoor** (3-col grid): Mom, Abdu, Kitchen — each with temp + humidity + inline purifier/AC controls
- **Air Quality** (5-col grid): CO2, PM2.5, PM10, tVOC, Noise — battery in section header
- **Prayer Times**: Daily prayer schedule (Dubai method, calibrated for Baghdad)

Purifier and AC controls are integrated inline within Indoor cards (Mom, Abdu) as vertical capsule widgets.

## Card Design Language

All metric cards follow a consistent design language established in the Temperature and Wind cards:

### Layout Structure
- **Title:** `h3` with `text-[0.95rem] font-medium text-text mb-2`
- **Hero row:** 1-2 primary values side by side, `flex items-baseline gap-8 mb-2`
  - Value: `text-3xl font-semibold leading-none tracking-tight` with a distinct color per metric
  - Unit: `text-xl` inline with value (e.g. `°C`, `%`) or `text-sm text-dim` separated (e.g. `km/h`)
  - Label below: `text-[0.75rem] text-text font-medium mt-1`
- **Secondary row:** compact supporting info, `flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim`
  - Values highlighted with `text-text font-medium`
- **Content spacing:** `mb-[100px]` on content div to reserve space for the chart below
- **Chart:** absolute-positioned at bottom, `h-[100px]`, `z-0 rounded-b-xl overflow-hidden`, `px-2 pb-1`

### Purifier Card
- Displays device name, status (online/offline), power, mode (Auto/Favorite/Sleep), fan level, and auxiliary controls (LED, Buzzer, Child Lock).
- Handles different capabilities based on protocol (e.g., specific MIoT properties).
- Includes status indicators for filter life.

### AC Widget
- Vertical capsule (`ac-widget.tsx`) matching purifier design language.
- Mode-based color theming: Auto=emerald, Cool=sky, Dry=teal, Fan=slate, Heat=orange.
- Main capsule: power button (mode-colored glow), target temp, fan speed indicator.
- Detail overlay (portal): temp +/- controls, mode selector (5 icons), fan speed (6 levels), toggles (ECO, Swing, Turbo, Screen).
- Allowed commands: `set_power`, `set_mode`, `set_temperature`, `set_fan_speed`, `set_eco`, `set_screen`, `set_sleep`, `set_swing`, `set_turbo`.

### Chart Defaults
- Line charts: `borderWidth: 2, pointRadius: 0, tension: 0.4, cubicInterpolationMode: "monotone", fill: true`
- Bar charts: `borderRadius: 2` (or 1 for AQ), colored per severity
- Smoothing: hourly bucketed averages (or 30-min median for wind)
- X-axis: `type: "time", unit: "hour", stepSize: 1, displayFormats: { hour: "h" }`, no rotation
- Y-axis: `position: "left"`, subtle grid `rgba(255,255,255,0.05)`

### Colors
- **Primary metric:** cyan `#00d4ff` (temp uses CSS gradient text via `getTempGradientStyle()` — 14-range scale)
- **Secondary metric:** white `text-white` or a complementary color (e.g. amber `#f59e0b` for wind median)
- **Pressure/Baro:** emerald `#10b981` (value + chart line)
- **Rain drop SVG:** blue `#2196ff` (stroke + fill)
- **Labels:** `text-text` (light gray)
- **Dim text/units:** `text-dim`
- **Chart fill:** primary color at 15% opacity

### Card Container
- Uses `MetricCard` component (glass-card, `min-h-[220px]`, `relative overflow-hidden`)
- Or raw `div.glass-card` for cards not using MetricCard (indoor, AQ)
- `p-4 pb-0 flex flex-col` on MetricCard className

## API Rate Limits

- Ambient Weather: 1 request/sec. Collector polls every 5s (sensors only update every ~5 min, dedup discards repeats). 2-second sleep after backfill prevents 429 on the first collection cycle
- Qingping MQTT (primary): Device pushes to self-hosted Mosquitto broker every ~30s. Collector subscribes to `qingping/{MAC}/up`. Interval configured via downlink to `qingping/{MAC}/down`.
- Qingping Cloud API (fallback): OAuth token expires in ~2 hours, refreshed 5 min before expiry. Automatically resumes when MQTT is silent >2 minutes.
- Xiaomi Cloud: Managed by `xmihome`. Avoid aggressive polling. Commands are sent as needed for automations or UI interactions.
- TCL Cloud: No continuous polling. Device state fetched on-demand via `/api/ac/devices` (frontend polls every 10s). Control commands sent via AWS IoT shadow publish.


## Frontend Update Intervals

- Current readings: fetched every 5 seconds
- Charts: fetched every 60 seconds
- Live clock + "ago" counters: tick every 1 second
- Cards flash cyan glow when values change
