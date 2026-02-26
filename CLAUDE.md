# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Home environmental monitoring dashboard at **https://home.altijwal.com**. Node.js/Express backend with React/TypeScript frontend, collects data from two sensor APIs, stores in PostgreSQL, and serves a dark-themed dashboard with live-updating cards and Chart.js charts.

**4 physical sensors, 2 APIs:**
- **Ambient Weather WS-2000** (1 API device, 3 sensor groups in `lastData`):
  - Outdoor: temp, humidity, wind, rain, pressure, UV, solar (~5 min updates)
  - Indoor console: temp, humidity, feels like, dew point (`tempinf`, `humidityin`, `feelsLikein`, `dewPointin`)
  - Channel 8 "Abdu": temp, humidity, feels like, dew point (`temp8f`, `humidity8`, `feelsLike8`, `dewPoint8`)
- **Qingping Air Monitor CGS1**: CO2, PM2.5, PM10, tVOC, noise, temp, humidity (~15 min updates)

## Architecture

```
Browser → Cloudflare → Traefik (VPS, existing) → dashboard container (port 8000)
                                                        ↓
                                                  PostgreSQL (VPS, existing, db=home)
```

- **Backend**: Express 5 (Node.js/TypeScript) serves REST API + static frontend + runs collector in background
- **Frontend**: React + TypeScript + Vite + Tailwind CSS v4 + lucide-react icons
- **Separate docker-compose**: Lives at `/opt/home-dashboard/` on the VPS, joins the existing `rag_default` network
- **Multi-stage Docker build**: Stage 1 builds client (Vite), Stage 2 builds server (tsc), Stage 3 runs production Node.js
- **Database**: Uses the existing `rag-postgres-1` container (pgvector:pg16). The `home` database is auto-created on first startup

## Project Structure

```
D:\dev\home\
├── server/                 # Node.js backend (Express + TypeScript)
│   ├── src/
│   │   ├── index.ts        # Express app, static serving, collector startup
│   │   ├── routes.ts       # API routes (/api/current, /api/history, /api/status)
│   │   ├── collector.ts    # Collector class (AW + Qingping polling)
│   │   ├── database.ts     # pg pool, schema init, migrations
│   │   └── config.ts       # Env vars (dotenv)
│   ├── package.json
│   └── tsconfig.json
├── client/                 # React frontend (Vite + Tailwind)
│   ├── src/
│   │   ├── main.tsx        # Entry point, Chart.js registration
│   │   ├── App.tsx         # Root component with tabs
│   │   ├── index.css       # Tailwind theme + custom wind/flash CSS
│   │   ├── hooks/          # useCurrentData, useHistoryData, useClock, useFlash
│   │   ├── components/     # Header, sections, cards, charts
│   │   ├── charts/         # Chart.js wrappers
│   │   ├── types/          # API type definitions
│   │   └── constants/      # Thresholds, directions, helpers
│   ├── vite.config.ts
│   └── package.json
├── Dockerfile              # Multi-stage (node:22-slim)
├── docker-compose.yml
└── .env                    # On VPS only
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
cd D:/dev/home && tar czf /tmp/home-deploy.tar.gz --exclude='node_modules' --exclude='dist' --exclude='.git' server client Dockerfile docker-compose.yml

# Upload and rebuild
scp -i ~/.ssh/vps1_key -o StrictHostKeyChecking=no /tmp/home-deploy.tar.gz root@31.97.76.221:/tmp/
ssh -i ~/.ssh/vps1_key -o StrictHostKeyChecking=no root@31.97.76.221 "cd /opt/home-dashboard && tar xzf /tmp/home-deploy.tar.gz && docker compose up -d --build"
```

Vite adds content hashes to built assets (e.g., `index-abc123.js`) — no manual cache busting needed.

## SSH to VPS

SSH stdout is not captured by the Bash tool. Always redirect to a file then read it:
```bash
ssh -i ~/.ssh/vps1_key -o StrictHostKeyChecking=no root@31.97.76.221 "command" > D:/dev/home/ssh_out.txt 2>&1
# then Read D:\dev\home\ssh_out.txt
```

## Database Schema

Two tables in the `home` database, both keyed by `ts TIMESTAMPTZ` with BRIN indexes:
- `weather_readings` — 32 columns (metric units, all conversions done at collection time). Includes outdoor, indoor console, and ch8 "Abdu" sensor data. New columns added via `MIGRATIONS` list in `database.ts`.
- `air_readings` — 9 columns

Deduplication: `ON CONFLICT (ts) DO NOTHING`. The 30-day history endpoint downsamples to hourly averages.

## Dashboard Layout

3 sections with tabs (Dashboard / Charts):
- **Outdoor** (4-col grid): Temperature, Wind (golden circle), Humidity, Rainfall, Solar, UV, Pressure
- **Indoor** (3-col grid): Mom, Abdu, Kitchen — each with temp + humidity
- **Air Quality** (5-col grid): CO2, PM2.5, PM10, tVOC, Noise — battery in section header

## API Rate Limits

- **Ambient Weather**: 1 request/sec. Collector polls every 5s (sensors only update every ~5 min, dedup discards repeats). 2-second sleep after backfill prevents 429 on the first collection cycle
- **Qingping**: OAuth token expires in ~2 hours, refreshed 5 min before expiry. Device updates every ~15 min

## Frontend Update Intervals

- Current readings: fetched every 5 seconds
- Charts: fetched every 60 seconds
- Live clock + "ago" counters: tick every 1 second
- Cards flash cyan glow when values change
