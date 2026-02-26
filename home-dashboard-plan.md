# Unified Environmental Monitoring Dashboard — Claude Code Build Plan

## Project Overview

Build a **Dockerized, self-hosted** web dashboard on an Ubuntu VPS (Hostinger KVM2) that unifies data from two devices:

1. **Ambient Weather WS-2000** — outdoor weather station (temp, humidity, wind, rain, pressure, UV, solar radiation)
2. **Qingping Air Monitor 2 (CGS1)** — indoor air quality monitor (CO2, PM2.5, PM10, tVOC, noise, temp, humidity)

The dashboard must be accessible at **https://home.altijwal.com** (DNS already points to server IP).

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Docker Compose Stack on Ubuntu VPS                          │
│                                                              │
│  ┌──────────────────────┐     ┌────────────────────────┐     │
│  │  collector (Python)  │     │  nginx (reverse proxy)  │    │
│  │  - Polls both APIs   │     │  - SSL via Let's Encrypt│    │
│  │  - Writes to SQLite  │     │  - Serves frontend      │    │
│  │  - Runs every 5 min  │     │  - Proxies /api → app   │    │
│  └──────────┬───────────┘     └────────────┬───────────┘     │
│             │                              │                  │
│  ┌──────────▼──────────────────────────────▼───────────┐     │
│  │  app (Python FastAPI or Flask)                      │     │
│  │  - REST API: /api/current, /api/history             │     │
│  │  - Serves the frontend (HTML/JS/CSS)                │     │
│  │  - Reads from SQLite                                │     │
│  └──────────┬─────────────────────────────────────────┘     │
│             │                                                │
│  ┌──────────▼───────────┐                                    │
│  │  SQLite volume        │                                   │
│  │  /data/dashboard.db   │                                   │
│  └───────────────────────┘                                   │
└──────────────────────────────────────────────────────────────┘
```

---

## API Credentials

### Qingping Air Monitor — Cloud REST API

- **OAuth Token URL:** `https://oauth.cleargrass.com/oauth2/token`
- **Devices URL:** `https://apis.cleargrass.com/v1/apis/devices`
- **App Key (client_id):** `uDspaIODR`
- **App Secret (client_secret):** `e8e4e13d109411f18e1f52540055385a`
- **Auth method:** HTTP Basic with Base64 of `AppKey:AppSecret`
- **Grant type:** `client_credentials`
- **Scope:** `device_full_access`
- **Token lifetime:** ~7200 seconds (2 hours), cache and refresh

**Step 1 — Get token:**
```bash
AUTH=$(echo -n "$APP_KEY:$APP_SECRET" | base64)
curl -X POST "https://oauth.cleargrass.com/oauth2/token" \
  -H "Authorization: Basic $AUTH" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&scope=device_full_access"
```

**Step 2 — Get device data:**
```bash
curl "https://apis.cleargrass.com/v1/apis/devices?timestamp=$(date +%s)" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

**Response structure:**
```json
{
  "total": 1,
  "devices": [{
    "info": {
      "mac": "582D3470F981",
      "product": { "en_name": "Qingping Air Monitor", "code": "CGS1" },
      "name": "Air Monitor",
      "status": { "offline": false },
      "setting": { "report_interval": 60, "collect_interval": 900 }
    },
    "data": {
      "timestamp": { "value": 1772008972 },
      "battery": { "value": 100 },
      "temperature": { "value": 23.3 },
      "humidity": { "value": 45.2 },
      "co2": { "value": 514 },
      "pm25": { "value": 19 },
      "pm10": { "value": 20 },
      "noise": { "value": 48 },
      "tvoc_index": { "value": 131 }
    }
  }]
}
```

**Fields to store:** timestamp, battery, temperature, humidity, co2, pm25, pm10, noise, tvoc_index

---

### Ambient Weather WS-2000 — REST API

- **Base URL:** `https://rt.ambientweather.net/v1`
- **Application Key:** `10918d906b034caebd25c6c4073396caf7ed71a607c544da93d7685a46ddae65`
- **API Key:** `e44de4ca39c04506b73dae9f6ca8f20039955a8b2061418ca523ec065c53d123`
- **Rate limit:** 1 request/sec per apiKey, 3 requests/sec per applicationKey

**Get devices + latest data:**
```bash
curl "https://rt.ambientweather.net/v1/devices?apiKey=$API_KEY&applicationKey=$APP_KEY"
```

**Get historical data for a device:**
```bash
curl "https://rt.ambientweather.net/v1/devices/$MAC_ADDRESS?apiKey=$API_KEY&applicationKey=$APP_KEY&limit=288"
```

**Typical response fields (WS-2000):**
```json
{
  "macAddress": "XX:XX:XX:XX:XX:XX",
  "lastData": {
    "dateutc": 1772008000000,
    "tempf": 75.2,
    "humidity": 45,
    "windspeedmph": 5.4,
    "windgustmph": 8.1,
    "winddir": 180,
    "baromrelin": 29.92,
    "baromabsin": 29.85,
    "hourlyrainin": 0,
    "dailyrainin": 0,
    "monthlyrainin": 0.5,
    "yearlyrainin": 3.2,
    "solarradiation": 120.5,
    "uv": 3,
    "tempinf": 72.1,
    "humidityin": 40,
    "feelsLike": 75.2,
    "dewPoint": 52.1
  }
}
```

**Fields to store:** dateutc, tempf, humidity, windspeedmph, windgustmph, winddir, baromrelin, baromabsin, hourlyrainin, dailyrainin, monthlyrainin, yearlyrainin, solarradiation, uv, tempinf, humidityin, feelsLike, dewPoint

**Note:** Temperature from AW is in Fahrenheit — convert to Celsius for display (user is in Baghdad, Iraq).

---

## Database Schema (SQLite)

```sql
CREATE TABLE IF NOT EXISTS weather_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'ambient_weather',
    temp_c REAL,
    humidity REAL,
    wind_speed_kmh REAL,
    wind_gust_kmh REAL,
    wind_dir INTEGER,
    pressure_hpa REAL,
    rain_hourly_mm REAL,
    rain_daily_mm REAL,
    rain_monthly_mm REAL,
    rain_yearly_mm REAL,
    solar_radiation REAL,
    uv_index REAL,
    temp_indoor_c REAL,
    humidity_indoor REAL,
    feels_like_c REAL,
    dew_point_c REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS air_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'qingping',
    temperature REAL,
    humidity REAL,
    co2 INTEGER,
    pm25 INTEGER,
    pm10 INTEGER,
    tvoc INTEGER,
    noise INTEGER,
    battery INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_weather_ts ON weather_readings(timestamp);
CREATE INDEX idx_air_ts ON air_readings(timestamp);
```

---

## Docker Compose Structure

```
home-dashboard/
├── docker-compose.yml
├── .env                        # API keys (not committed)
├── collector/
│   ├── Dockerfile
│   ├── requirements.txt        # requests, schedule, python-dotenv
│   └── collector.py            # Polls both APIs, writes to SQLite
├── app/
│   ├── Dockerfile
│   ├── requirements.txt        # fastapi, uvicorn, aiosqlite
│   ├── main.py                 # FastAPI app
│   ├── static/
│   │   ├── index.html          # Dashboard SPA
│   │   ├── style.css
│   │   └── app.js              # Chart.js or Lightweight charts
│   └── templates/              # (optional if using Jinja)
├── nginx/
│   ├── nginx.conf
│   └── Dockerfile (or use image directly)
└── data/                       # Docker volume mount for SQLite
    └── dashboard.db
```

### .env file format:
```env
# Qingping
QINGPING_APP_KEY=uDspaIODR
QINGPING_APP_SECRET=e8e4e13d109411f18e1f52540055385a

# Ambient Weather
AW_APPLICATION_KEY=10918d906b034caebd25c6c4073396caf7ed71a607c544da93d7685a46ddae65
AW_API_KEY=e44de4ca39c04506b73dae9f6ca8f20039955a8b2061418ca523ec065c53d123

# Domain
DOMAIN=home.altijwal.com
```

### docker-compose.yml outline:
```yaml
version: "3.8"
services:
  collector:
    build: ./collector
    env_file: .env
    volumes:
      - ./data:/data
    restart: unless-stopped

  app:
    build: ./app
    env_file: .env
    volumes:
      - ./data:/data
    ports:
      - "8000:8000"
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/conf.d/default.conf
      - certbot-data:/etc/letsencrypt
      - certbot-www:/var/www/certbot
    depends_on:
      - app
    restart: unless-stopped

  certbot:
    image: certbot/certbot
    volumes:
      - certbot-data:/etc/letsencrypt
      - certbot-www:/var/www/certbot
    entrypoint: "/bin/sh -c 'trap exit TERM; while :; do sleep 12h & wait $${!}; certbot renew; done'"

volumes:
  certbot-data:
  certbot-www:
```

---

## Collector Service — Behavior

- Runs as a **long-running daemon** (not cron)
- Uses Python `schedule` or `asyncio` loop
- **Every 5 minutes:** poll both APIs and insert into SQLite
- **Qingping token caching:** store token in memory, refresh when expired (check `expires_in`)
- **Error handling:** log errors, retry with exponential backoff, never crash
- **Deduplication:** check if `timestamp` already exists before inserting
- **Unit conversion:** convert AW Fahrenheit → Celsius, mph → km/h, inches → mm/hPa

### Conversion formulas:
- `°C = (°F - 32) × 5/9`
- `km/h = mph × 1.60934`
- `mm = inches × 25.4`
- `hPa = inHg × 33.8639`

---

## App Service — API Endpoints

### `GET /api/current`
Returns the latest reading from both sources:
```json
{
  "weather": { "temp_c": 23.5, "humidity": 45, "wind_speed_kmh": 8.7, ... },
  "air": { "co2": 514, "pm25": 19, "pm10": 20, "tvoc": 131, "noise": 48, ... },
  "updated_at": { "weather": "2025-02-25T12:00:00Z", "air": "2025-02-25T12:00:00Z" }
}
```

### `GET /api/history?source=air&hours=24`
Returns historical data for charting. Parameters:
- `source`: `weather` or `air`
- `hours`: 1, 6, 12, 24, 48, 168 (1 week), 720 (30 days)

### `GET /api/status`
Health check — returns device online status, last update times, collector status.

---

## Frontend Dashboard — Design Requirements

A single-page responsive dashboard with:

### Top section — Current Readings Cards
Two groups side by side (stacked on mobile):

**Outdoor Weather (WS-2000):**
- Temperature (°C) with feels-like
- Humidity (%)
- Wind speed + direction (km/h + compass)
- Barometric pressure (hPa)
- Rain today (mm)
- UV Index
- Solar radiation (W/m²)

**Indoor Air Quality (Qingping):**
- CO2 (ppm) — with color coding: green <800, yellow 800-1200, red >1200
- PM2.5 (µg/m³) — color: green <35, yellow 35-75, red >75
- PM10 (µg/m³) — color: green <50, yellow 50-150, red >150
- tVOC index — color: green <100, yellow 100-250, red >250
- Temperature (°C)
- Humidity (%)
- Noise (dB)
- Battery (%)

### Bottom section — Historical Charts
- Time-series line charts using Chart.js or similar lightweight library
- Selectable time range: 6h, 24h, 48h, 1 week, 30 days
- Separate tabs/sections for Weather and Air Quality
- Key metrics charted: temp, humidity, CO2, PM2.5, wind, pressure

### Design style:
- Dark theme (easy on the eyes for monitoring)
- Responsive / mobile-friendly
- Auto-refresh every 5 minutes
- Show "last updated" timestamp for each data source
- Show device online/offline status
- Baghdad timezone (Asia/Baghdad, UTC+3)

---

## Nginx Configuration

- Reverse proxy to FastAPI app on port 8000
- SSL via Let's Encrypt / Certbot
- Domain: `home.altijwal.com`
- Redirect HTTP → HTTPS
- Serve static files directly for performance

### SSL setup steps (run once before docker-compose up):
```bash
# Initial cert generation
docker run -it --rm \
  -v certbot-data:/etc/letsencrypt \
  -v certbot-www:/var/www/certbot \
  -p 80:80 \
  certbot/certbot certonly --standalone \
  -d home.altijwal.com \
  --email your@email.com \
  --agree-tos --no-eff-email
```

---

## Deployment Steps

1. SSH into VPS: `ssh ubuntu@server20`
2. Install Docker + Docker Compose if not already installed
3. Clone/create the project directory at `/opt/home-dashboard/`
4. Create `.env` file with all 4 API keys
5. Run initial certbot for SSL
6. `docker-compose up -d --build`
7. Verify at `https://home.altijwal.com`

---

## Important Notes

- The Qingping cloud API updates roughly every **15 minutes** (device `collect_interval: 900` seconds). Polling more frequently won't yield new data but is harmless.
- Ambient Weather data updates every **5 minutes**. Rate limit: 1 req/sec.
- SQLite is fine for this workload (one write every 5 min, reads on demand). No need for Postgres/InfluxDB.
- All times should be stored as **UTC epoch** and converted to **Asia/Baghdad (UTC+3)** on the frontend.
- The Qingping token expires in ~2 hours. Cache it and refresh before expiry.
- Keep the `.env` file secure. Do not commit it to any repo.
