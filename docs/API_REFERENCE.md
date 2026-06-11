# Home Dashboard API Reference

Complete API reference for `https://home.altijwal.com` — a home environmental monitoring and device control dashboard in Baghdad, Iraq (lat 33.3215, lon 44.3583, timezone Asia/Baghdad UTC+3).

All endpoints return JSON. All request bodies are JSON (`Content-Type: application/json`).

---

## Table of Contents

1. [Authentication](#1-authentication)
2. [Read Endpoints](#2-read-endpoints)
3. [Data Types](#3-data-types)
4. [Device Discovery](#4-device-discovery)
5. [Purifier Control](#5-purifier-control)
6. [AC Control](#6-ac-control)
7. [AC Timers](#7-ac-timers)
8. [Automations](#8-automations)
9. [Alerts & Push Notifications](#9-alerts--push-notifications)
10. [Metrics Reference](#10-metrics-reference)
11. [Enum Values](#11-enum-values)

---

## 1. Authentication

Cookie-based JWT (HMAC-SHA256). Protected endpoints return `401` without a valid auth cookie.

### Public Endpoints (no auth required)

`GET /api/health`, `GET /api/current`, `GET /api/current/power`, `GET /api/history`, `GET /api/status`, `GET /api/solar-reference`, `GET /api/forecast`, `GET /api/prayer-times`, `GET /api/push/vapid-key`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe`, `GET /api/alerts`, `POST /api/alerts`, `PUT /api/alerts/:id`, `DELETE /api/alerts/:id`, `POST /api/power/ingest`

### Protected Endpoints (auth required)

All `/api/devices/*`, `/api/ac/*`, `/api/automations/*`, `/api/xiaomi/*`

### Login

```
POST /api/auth/login
```

**Body:**
```json
{
  "username": "string",
  "password": "string"
}
```

**Response:** `{ "ok": true }`

Sets an `auth` HttpOnly cookie (JWT, 30-day expiry, `SameSite=Strict`, `Secure` in production).

**Rate limit:** 5 attempts per IP per 15 minutes. Returns `429` when exceeded.

### Logout

```
POST /api/auth/logout
```

**Response:** `{ "ok": true }` — clears the auth cookie.

### Check Auth Status

```
GET /api/auth/me
```

**Response:** `{ "authenticated": true }` or `{ "authenticated": false }`

### Curl Example: Login Flow

```bash
# Login and save cookie
curl -X POST https://home.altijwal.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"YOUR_PASSWORD"}' \
  -c cookies.txt

# Use cookie for protected endpoints
curl https://home.altijwal.com/api/ac/devices -b cookies.txt

# Logout
curl -X POST https://home.altijwal.com/api/auth/logout -b cookies.txt -c cookies.txt
```

---

## 2. Read Endpoints

### GET /api/current

Latest readings from all three sources.

**Response:**
```json
{
  "weather": WeatherReading | null,
  "air": AirReading | null,
  "power": PowerReading | null
}
```

The `weather` object includes a computed field `max_daily_gust_kmh` (today's max gust).

### GET /api/current/power

Lightweight power-only endpoint for high-frequency polling.

**Response:** `PowerReading | null`

Returns `null` if the last ESP reading is older than 15 seconds (3 missed sends = no electricity).

### GET /api/history

Historical data with range selection.

**Query params:**
| Param | Type | Default | Values |
|-------|------|---------|--------|
| `source` | string | `"weather"` | `weather`, `air`, `power` |
| `range` | string | `"24h"` | `6h`, `24h`, `25h`, `48h`, `1w`, `30d` |

**Response:**
```json
{
  "source": "weather",
  "range": "24h",
  "count": 1440,
  "data": [Reading, ...]
}
```

For `30d` range, data is downsampled to hourly averages. All other ranges return raw readings ordered by `ts ASC`.

### GET /api/status

System status and reading counts.

**Response:**
```json
{
  "weather_last_update": "2026-04-25T12:00:00.000Z",
  "air_last_update": "2026-04-25T12:00:00.000Z",
  "power_last_update": "2026-04-25T12:00:00.000Z",
  "weather_total_readings": 500000,
  "air_total_readings": 100000,
  "power_total_readings": 200000,
  "collector_interval_seconds": 300
}
```

### GET /api/health

**Response:** `{ "status": "ok", "uptime": 86400 }` or `503 { "status": "unhealthy", "error": "..." }`

### GET /api/forecast

7-day weather forecast (Open-Meteo, bias-corrected).

**Response:** `ForecastResponse` (see [Data Types](#forecastresponse)).

Returns `503` if forecast data is not yet available.

### GET /api/prayer-times

Today's prayer times, countdown to next prayer, Hijri date, and next Islamic event. Computed server-side using the `adhan` library (Dubai method, calibrated for Baghdad).

**Response:**
```json
{
  "prayers": [
    {
      "name": "fajr",
      "label": "Fajr",
      "time": "3:48 AM",
      "isPassed": true,
      "isNext": false,
      "countdown": null
    },
    {
      "name": "sunrise",
      "label": "Sunrise",
      "time": "5:22 AM",
      "isPassed": true,
      "isNext": false,
      "countdown": null
    },
    {
      "name": "dhuhr",
      "label": "Dhuhr",
      "time": "11:58 AM",
      "isPassed": false,
      "isNext": true,
      "countdown": "2h 31m"
    },
    { "name": "asr", "label": "Asr", "time": "3:28 PM", "isPassed": false, "isNext": false, "countdown": "6h 1m" },
    { "name": "maghrib", "label": "Maghrib", "time": "6:43 PM", "isPassed": false, "isNext": false, "countdown": "9h 16m" },
    { "name": "isha", "label": "Isha", "time": "8:07 PM", "isPassed": false, "isNext": false, "countdown": "10h 40m" }
  ],
  "nextPrayer": {
    "name": "dhuhr",
    "label": "Dhuhr",
    "time": "11:58 AM",
    "countdown": "2h 31m"
  },
  "hijriDate": "Shawwal 28, 1447 AH",
  "nextEvent": {
    "name": "Day of Arafah",
    "isToday": false,
    "daysLeft": 41
  }
}
```

When all today's prayers have passed, `nextPrayer` returns tomorrow's Fajr with label `"Fajr (tomorrow)"`.

### GET /api/solar-reference

Empirical solar radiation baseline (top 3 clearest days in past 7 days).

**Response:**
```json
{
  "quarter_hourly_max": {
    "6:0": 42.5,
    "6:1": 85.3,
    "...": "..."
  }
}
```

Keys are `"hour:slot"` where slot is the 5-minute index within the hour (0-11).

---

## 3. Data Types

### WeatherReading

| Field | Type | Description |
|-------|------|-------------|
| `ts` | string | ISO timestamp |
| `temp_c` | number\|null | Outdoor temperature (°C) |
| `humidity` | number\|null | Outdoor humidity (%) |
| `wind_speed_kmh` | number\|null | Wind speed (km/h) |
| `wind_gust_kmh` | number\|null | Wind gust (km/h) |
| `max_daily_gust_kmh` | number\|null | Today's max gust (computed, only in `/api/current`) |
| `wind_dir` | number\|null | Wind direction (degrees) |
| `wind_dir_avg10m` | number\|null | 10-min avg wind direction |
| `pressure_rel_hpa` | number\|null | Relative barometric pressure (hPa) |
| `pressure_abs_hpa` | number\|null | Absolute barometric pressure (hPa) |
| `rain_hourly_mm` | number\|null | Rain last hour (mm) |
| `rain_event_mm` | number\|null | Current rain event (mm) |
| `rain_daily_mm` | number\|null | Rain today (mm) |
| `rain_weekly_mm` | number\|null | Rain this week (mm) |
| `rain_monthly_mm` | number\|null | Rain this month (mm) |
| `rain_yearly_mm` | number\|null | Rain this year (mm) |
| `solar_radiation` | number\|null | Solar radiation (W/m²) |
| `uv_index` | number\|null | UV index |
| `temp_indoor_c` | number\|null | Mom's indoor temp (°C) |
| `humidity_indoor` | number\|null | Mom's indoor humidity (%) |
| `feels_like_c` | number\|null | Outdoor feels-like (°C) |
| `dew_point_c` | number\|null | Outdoor dew point (°C) |
| `temp_ch8_c` | number\|null | Abdu's indoor temp (°C) |
| `humidity_ch8` | number\|null | Abdu's indoor humidity (%) |
| `feels_like_indoor_c` | number\|null | Mom's feels-like (°C) |
| `dew_point_indoor_c` | number\|null | Mom's dew point (°C) |
| `feels_like_ch8_c` | number\|null | Abdu's feels-like (°C) |
| `dew_point_ch8_c` | number\|null | Abdu's dew point (°C) |
| `last_rain` | string\|null | Timestamp of last rain event |

### AirReading

| Field | Type | Description |
|-------|------|-------------|
| `ts` | string | ISO timestamp |
| `temperature` | number\|null | Kitchen temperature (°C) |
| `humidity` | number\|null | Kitchen humidity (%) |
| `co2` | number\|null | CO2 (ppm) |
| `pm25` | number\|null | PM2.5 (µg/m³) |
| `pm10` | number\|null | PM10 (µg/m³) |
| `tvoc` | number\|null | tVOC (ppb) |
| `noise` | number\|null | Noise level (dB) |
| `battery` | number\|null | Battery (%) |
| `batteryCharging` | boolean | Optional, true when USB is plugged in |

### PowerReading

| Field | Type | Description |
|-------|------|-------------|
| `ts` | string | ISO timestamp |
| `voltage` | number\|null | Voltage (V) |
| `current_1` | number\|null | Grid current (A) |
| `current_2` | number\|null | Generator current (A) |
| `power_1` | number\|null | Grid power (W) |
| `power_2` | number\|null | Generator power (W) |

### PurifierDevice

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Device ID |
| `name` | string | Device name |
| `model` | string | Model string (e.g. `zhimi.airpurifier.vb2`) |
| `isOnline` | boolean | Online status |
| `power` | "on"\|"off" | Power state |
| `mode` | string | Current mode (auto/silent/favorite/fan) |
| `fan_level` | number | Fan level 1-3 (MIoT only) |
| `favorite_level` | number | Favorite speed 0-14 (MIoT) or 0-16 (MiIO) |
| `aqi` | number | Air quality index |
| `temperature` | number | Temperature (°C) |
| `humidity` | number | Humidity (%) |
| `filter_life` | number | Filter life remaining (%) |
| `led` | boolean | LED on/off |
| `buzzer` | boolean | Buzzer on/off |
| `child_lock` | boolean | Child lock on/off |

### AcDevice

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Device ID |
| `name` | string | Device name |
| `isOnline` | boolean | Online status |
| `power` | boolean | Power state |
| `mode` | number | Mode (0=Auto, 1=Cool, 2=Dry, 3=Fan, 4=Heat) |
| `targetTemp` | number | Target temperature (°C) |
| `currentTemp` | number | Current room temperature (°C) |
| `fanSpeed` | number | Fan speed (0=Auto, 1-7) |
| `eco` | boolean | ECO mode |
| `sleep` | number | Sleep mode (-1=off, 0+=on) |
| `screen` | boolean | Display on/off |
| `verticalSwing` | number | Vertical swing position (see [Enum Values](#vertical-swing)) |
| `horizontalSwing` | number | Horizontal swing position (see [Enum Values](#horizontal-swing)) |
| `turbo` | boolean | Turbo mode |
| `freshAir` | boolean | Fresh air on/off |
| `hasFreshAir` | boolean | Device supports fresh air |
| `generatorMode` | number | Generator mode level |
| `model` | string | Hardware model family (`"TAC-24CHSA"` or `"TAC-12CHSD"`) — protocol/UI forks key on this |
| `maxGeneratorLevel` | number | Max generator level (3 for all models since 2026-06 — TCL removed Najat's 4–6) |
| `tempStep` | number | Temperature step (0.5 or 1) |
| `minFanSpeed` | number | Minimum fan speed |
| `maxFanSpeed` | number | Maximum fan speed |
| `beep` | boolean | Beep feedback |

### ForecastResponse

```json
{
  "generated_at": "ISO timestamp",
  "hourly": {
    "time": ["ISO timestamp", ...],
    "temperature": [number|null, ...],
    "humidity": [number|null, ...],
    "dew_point": [number|null, ...],
    "feels_like": [number|null, ...],
    "pressure": [number|null, ...],
    "wind_speed": [number|null, ...],
    "wind_direction": [number|null, ...],
    "wind_gusts": [number|null, ...],
    "solar_radiation": [number|null, ...],
    "uv_index": [number|null, ...],
    "cloud_cover": [number|null, ...],
    "precip_probability": [number|null, ...],
    "precipitation": [number|null, ...],
    "weather_code": [number|null, ...]
  },
  "daily": {
    "date": ["YYYY-MM-DD", ...],
    "temp_max": [number|null, ...],
    "temp_min": [number|null, ...],
    "sunrise": ["ISO time", ...],
    "sunset": ["ISO time", ...],
    "precip_sum": [number|null, ...],
    "precip_probability_max": [number|null, ...],
    "uv_index_max": [number|null, ...],
    "wind_speed_max": [number|null, ...],
    "weather_code": [number|null, ...]
  }
}
```

All hourly arrays are parallel (same length as `time`). All daily arrays are parallel (same length as `date`).

---

## 4. Device Discovery

Device IDs are **dynamic** — they must be discovered at runtime before sending control commands.

### GET /api/devices (Purifiers)

**Auth required.** Returns Xiaomi air purifiers.

**Response:**
```json
{
  "devices": [PurifierDevice, ...],
  "available": true,
  "region": "sg"
}
```

**Known devices:**
| Name | Model | Protocol | Notes |
|------|-------|----------|-------|
| mom | `zhimi.airpurifier.v7` | MiIO (older) | Favorite level 0-16 |
| Abdu | `zhimi.airpurifier.vb2` | MIoT (modern) | Fan level 1-3, favorite level 0-14 |

Protocol differences are handled transparently by the server.

### GET /api/ac/devices (ACs)

**Auth required.** Returns TCL split AC units.

**Response:**
```json
{
  "devices": [AcDevice, ...],
  "available": true
}
```

**Known devices:**
| Name | Model | maxGeneratorLevel | tempStep | ECO | Turbo | Fresh Air |
|------|-------|:-:|:-:|:-:|:-:|:-:|
| Najat | TAC-24CHSA | 3 (was 6 until TCL removed 4–6 in 2026-06) | 0.5 | No | No | Yes |
| Abdu AC | TAC-12CHSD | 3 | 1 | Yes | Yes | No |
| Abdullah AC | TAC-12CHSD | 3 | 1 | Yes | Yes | No |

**How to detect model:** use the `model` field (`"TAC-24CHSA"` = Najat, `"TAC-12CHSD"` = Abdu/Abdullah). Never infer the model from `maxGeneratorLevel` — TCL changes level counts via firmware updates.

### Xiaomi Auth Status

```
GET /api/xiaomi/auth-status    (auth required)
```

**Response:**
```json
{
  "status": "authenticated" | "needs_2fa" | "needs_captcha" | "not_configured" | "error",
  "error": "string (optional)",
  "captchaImage": "base64 string (optional)"
}
```

If 2FA or captcha is needed:

```
POST /api/xiaomi/verify    (auth required)
Body: { "code": "123456" }
Response: { "ok": true }
```

---

## 5. Purifier Control

```
POST /api/devices/:id/control    (auth required)
```

**Body format:** `{ "command": string, "params": unknown[] }`

Note: Purifiers use `params` (array), not `value`.

### Commands

| Command | Params | Description |
|---------|--------|-------------|
| `set_power` | `["on"]` or `["off"]` | Turn on/off |
| `set_mode` | `["auto"]`, `["silent"]`, or `["favorite"]` | Set mode |
| `set_level_favorite` | `[0]` to `[14]` (MIoT) or `[16]` (MiIO) | Set favorite speed level |
| `set_fan_level` | `[1]`, `[2]`, or `[3]` | Set fan level (MIoT only) |
| `set_led` | `["on"]` or `["off"]` | LED indicator |
| `set_buzzer` | `["on"]` or `["off"]` | Buzzer sounds |
| `set_child_lock` | `["on"]` or `["off"]` | Child lock |

### Curl Examples

```bash
# Turn on purifier
curl -X POST https://home.altijwal.com/api/devices/DEVICE_ID/control \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"command":"set_power","params":["on"]}'

# Set to silent mode
curl -X POST https://home.altijwal.com/api/devices/DEVICE_ID/control \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"command":"set_mode","params":["silent"]}'

# Set favorite level to 10
curl -X POST https://home.altijwal.com/api/devices/DEVICE_ID/control \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"command":"set_level_favorite","params":[10]}'
```

---

## 6. AC Control

```
POST /api/ac/devices/:id/control    (auth required)
```

**Body format:** `{ "command": string, "value": unknown }`

Note: ACs use `value` (single value), not `params`.

### Commands

| Command | Value | Description |
|---------|-------|-------------|
| `set_power` | `1` (on) or `0` (off) | Power toggle. On power-on, backend auto-restores last saved profile. |
| `set_mode` | `0`-`4` | Mode: 0=Auto, 1=Cool, 2=Dry, 3=Fan, 4=Heat |
| `set_temperature` | `16`-`36` | Target temp (°C). Najat supports 0.5 steps (e.g. `24.5`), others integer only. |
| `set_fan_speed` | `0`-`7` | 0=Auto. See [Fan Speed](#fan-speed) for model differences. |
| `set_eco` | `1` or `0` | ECO mode. **Abdu/Abdullah only** (Najat ignores). |
| `set_turbo` | `1` or `0` | Turbo mode. **Abdu/Abdullah only** (Najat ignores). |
| `set_screen` | `1` or `0` | Display on/off |
| `set_sleep` | `1` (on) or `0` (off) | Sleep mode |
| `set_vertical_swing` | `0`-`13` | See [Vertical Swing](#vertical-swing) |
| `set_horizontal_swing` | `0`-`13` | See [Horizontal Swing](#horizontal-swing) |
| `set_fresh_air` | `1` or `0` | Fresh air. **Najat only** (others ignore). |
| `set_generator_mode` | `0`-`3` | Generator level, all models (route rejects 4+; Najat had 0-6 until TCL removed 4-6 in 2026-06). |
| `set_beep` | `1` or `0` | Beep feedback |

### Model Differences

| Feature | Najat (TAC-24CHSA) | Abdu/Abdullah (TAC-12CHSD) |
|---------|:--:|:--:|
| ECO mode | Not supported | Supported |
| Turbo mode | Not supported | Supported |
| Fresh air | Supported | Not supported |
| Temperature step | 0.5°C | 1°C |
| Generator levels | 0-3 (was 0-6 until 2026-06) | 0-3 |
| Fan speed 1 | Normal level 1 | Silent mode |
| Fan speed 7 | Normal level 7 | Turbo mode |

### Curl Examples

```bash
# Turn on AC
curl -X POST https://home.altijwal.com/api/ac/devices/DEVICE_ID/control \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"command":"set_power","value":1}'

# Set to Cool mode, 24°C
curl -X POST https://home.altijwal.com/api/ac/devices/DEVICE_ID/control \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"command":"set_mode","value":1}'

curl -X POST https://home.altijwal.com/api/ac/devices/DEVICE_ID/control \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"command":"set_temperature","value":24}'

# Set fan to speed 3
curl -X POST https://home.altijwal.com/api/ac/devices/DEVICE_ID/control \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"command":"set_fan_speed","value":3}'

# Enable vertical full swing
curl -X POST https://home.altijwal.com/api/ac/devices/DEVICE_ID/control \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"command":"set_vertical_swing","value":1}'
```

---

## 7. AC Timers

Server-side countdown timers (in-memory, lost on server restart).

### GET /api/ac/timers (auth required)

**Response:**
```json
{
  "timers": [
    {
      "deviceId": "string",
      "action": "on" | "off",
      "preset": { ... },
      "fireAt": 1714060800000
    }
  ]
}
```

`fireAt` is a Unix timestamp in milliseconds.

### POST /api/ac/timer (auth required)

Set a timer.

**Body:**
```json
{
  "deviceId": "string",
  "action": "on" | "off",
  "minutes": 1-480,
  "preset": {
    "mode": 1,
    "temperature": 24,
    "fan_speed": 3,
    "eco": false,
    "turbo": false,
    "screen": true,
    "verticalSwing": 1,
    "horizontalSwing": 0,
    "freshAir": false,
    "generatorMode": 0
  }
}
```

- `minutes`: 1 to 480 (8 hours), integer
- `preset`: optional, only saved for `"on"` action. Applied when the timer fires.

**Response:** `{ "ok": true, "fireAt": 1714060800000 }`

### DELETE /api/ac/timer/:deviceId (auth required)

Cancel a timer.

**Response:** `{ "ok": true }`

### Curl Example

```bash
# Set a 2-hour turn-off timer
curl -X POST https://home.altijwal.com/api/ac/timer \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"deviceId":"DEVICE_ID","action":"off","minutes":120}'

# Cancel timer
curl -X DELETE https://home.altijwal.com/api/ac/timer/DEVICE_ID -b cookies.txt
```

---

## 8. Automations

CRUD for device automation rules. Two types: **metric-based** (sensor thresholds) and **schedule-based** (time windows). Supports both purifiers and ACs.

### GET /api/automations (auth required)

**Response:** `{ "automations": [AutomationRule, ...] }`

### AutomationRule

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Auto-increment ID |
| `name` | string | Auto-generated description |
| `enabled` | boolean | Whether active |
| `automation_type` | `"metric"` \| `"schedule"` | Type |
| `device_type` | `"purifier"` \| `"ac"` | Device class |
| `metric` | string\|null | Metric key (metric type only) |
| `condition` | `"above"` \| `"below"` \| null | Trigger condition |
| `threshold` | number\|null | High threshold |
| `threshold_low` | number\|null | Low threshold (AC range only) |
| `sustained_minutes` | number | Minutes condition must hold (0=immediate) |
| `time_start` | string\|null | Start time HH:MM (schedule exact) |
| `time_end` | string\|null | End time HH:MM (schedule exact) |
| `start_mode` | `"exact"` \| `"prayer"` | Start time type |
| `start_prayer` | string\|null | Prayer name for start |
| `start_prayer_offset` | number\|null | Minutes offset (-120 to +120) |
| `end_mode` | `"exact"` \| `"prayer"` | End time type |
| `end_prayer` | string\|null | Prayer name for end |
| `end_prayer_offset` | number\|null | Minutes offset (-120 to +120) |
| `device_ids` | string[] | Target device IDs |
| `device_names` | string[] | Target device names |
| `device_id` | string | Primary device ID |
| `device_name` | string | Primary device name |
| `turn_off_at_end` | boolean | Turn off device when condition clears / schedule ends |
| `action_on` | object | Action payload when triggered |
| `action_off` | object\|null | Action payload when resolved |
| `cooldown_secs` | number | Seconds between re-checks (5 for metric, 60 for schedule) |
| `created_at` | string | ISO timestamp |

### POST /api/automations (auth required) — Metric-Based

**Body:**
```json
{
  "automation_type": "metric",
  "device_type": "purifier" | "ac",
  "metric": "metric_key",
  "condition": "above" | "below",
  "threshold": 30,
  "threshold_low": 24,
  "sustained_minutes": 0,
  "turn_off_at_end": true,
  "device_ids": ["device_id_1"],
  "device_names": ["Device Name"],
  "enabled": true,
  "ac_profile": {
    "mode": 1,
    "temperature": 24,
    "fan_speed": 3
  }
}
```

**Validation:**
- `metric` must be a valid metric key (see [Metrics Reference](#10-metrics-reference))
- For purifiers: only air quality metrics are allowed
- For ACs: any metric is allowed
- `threshold` must be within the metric's min/max range
- **AC requires:** `threshold_low` (must be < `threshold`), `ac_profile` (mode 0-4, temperature 16-36, fan_speed 0-7)
- **Purifier requires:** `condition` (`"above"` or `"below"`)
- `sustained_minutes`: 0-60 (optional, default 0)
- `device_ids`: at least 1 device

**AC Thermostat Hysteresis Behavior:**

When both `threshold` and `threshold_low` are set (AC range automation):

- **Cool mode (mode=1):** Turns ON when temp >= `threshold` (high), turns OFF when temp <= `threshold_low` (low)
- **Heat mode (mode=4):** Turns ON when temp <= `threshold_low` (low), turns OFF when temp >= `threshold` (high)
- **Dead zone (between limits):** If AC is already ON, re-enforces the profile (diff-based, only sends changed properties). If user manually turned AC off, blocks auto-turn-on until temperature reaches the turn-off limit.

**Response:** `{ "automation": AutomationRule }`

### POST /api/automations (auth required) — Schedule-Based

**Body:**
```json
{
  "automation_type": "schedule",
  "device_type": "purifier" | "ac",
  "time_start": "22:00",
  "time_end": "07:00",
  "start_mode": "exact",
  "end_mode": "exact",
  "turn_off_at_end": true,
  "device_ids": ["device_id_1"],
  "device_names": ["Device Name"],
  "enabled": true,
  "ac_profile": {
    "mode": 1,
    "temperature": 24,
    "fan_speed": 3
  }
}
```

**Prayer-relative time example:**
```json
{
  "automation_type": "schedule",
  "device_type": "ac",
  "start_mode": "prayer",
  "start_prayer": "isha",
  "start_prayer_offset": -30,
  "end_mode": "prayer",
  "end_prayer": "fajr",
  "end_prayer_offset": 0,
  "turn_off_at_end": true,
  "device_ids": ["device_id_1"],
  "device_names": ["Device Name"],
  "enabled": true,
  "ac_profile": { "mode": 1, "temperature": 24, "fan_speed": 3 }
}
```

This runs from 30 minutes before Isha until Fajr.

**Validation:**
- If `start_mode="exact"`: `time_start` required in `HH:MM` format
- If `start_mode="prayer"`: `start_prayer` (valid prayer name) and `start_prayer_offset` (-120 to 120) required
- Same rules for end
- Start and end cannot be identical (if both exact)
- For ACs: `ac_profile` required (mode 0-4, temperature 16-36, fan_speed 0-7)
- `device_ids`: at least 1 device

**Response:** `{ "automation": AutomationRule }`

### PUT /api/automations/:id (auth required)

Full update. Same body as POST (metric or schedule variant).

**Response:** `{ "automation": AutomationRule }`

### PATCH /api/automations/:id (auth required)

Toggle enable/disable only.

**Body:** `{ "enabled": true | false }`

**Response:** `{ "automation": AutomationRule }`

### DELETE /api/automations/:id (auth required)

**Response:** `{ "ok": true }`

### POST /api/automations/:id/test (auth required)

Fire the automation's `action_on` on all its devices immediately (for testing).

**Response:** `{ "ok": true }`

### POST /api/ac/preset-sync (auth required)

Syncs an updated AC preset to all automations using that preset slot.

**Body:**
```json
{
  "deviceId": "string",
  "slot": 1,
  "presetData": {
    "mode": 1,
    "targetTemp": 24,
    "fanSpeed": 3,
    "eco": false,
    "turbo": false,
    "screen": true,
    "verticalSwing": 1,
    "horizontalSwing": 0,
    "freshAir": false,
    "generatorMode": 0
  }
}
```

**Response:** `{ "ok": true, "updated": 2 }`

### Curl Examples

```bash
# Create AC thermostat automation: Cool to 24°C when Abdu's room hits 30°C, off at 26°C
curl -X POST https://home.altijwal.com/api/automations \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "automation_type": "metric",
    "device_type": "ac",
    "metric": "temp_ch8_c",
    "condition": "above",
    "threshold": 30,
    "threshold_low": 26,
    "device_ids": ["DEVICE_ID"],
    "device_names": ["Abdu AC"],
    "ac_profile": { "mode": 1, "temperature": 24, "fan_speed": 3 }
  }'

# Create purifier automation: Turn on when PM2.5 > 50 for 5 minutes
curl -X POST https://home.altijwal.com/api/automations \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "automation_type": "metric",
    "device_type": "purifier",
    "metric": "pm25",
    "condition": "above",
    "threshold": 50,
    "sustained_minutes": 5,
    "turn_off_at_end": true,
    "device_ids": ["DEVICE_ID"],
    "device_names": ["Abdu"]
  }'

# Toggle automation on/off
curl -X PATCH https://home.altijwal.com/api/automations/1 \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"enabled":false}'

# Test-fire an automation
curl -X POST https://home.altijwal.com/api/automations/1/test -b cookies.txt

# Delete automation
curl -X DELETE https://home.altijwal.com/api/automations/1 -b cookies.txt
```

---

## 9. Alerts & Push Notifications

### Push Subscription Management

#### GET /api/push/vapid-key

**Response:** `{ "publicKey": "string" }`

#### POST /api/push/subscribe

**Body:**
```json
{
  "subscription": {
    "endpoint": "https://fcm.googleapis.com/...",
    "keys": {
      "p256dh": "...",
      "auth": "..."
    }
  },
  "breakpoints": [15, 7, 4, 2, 0]
}
```

`breakpoints` is optional (defaults to `[15, 7, 4, 2, 0]`).

**Response:** `{ "ok": true }`

#### POST /api/push/unsubscribe

**Body:** `{ "endpoint": "https://..." }`

**Response:** `{ "ok": true }`

### Alert Rules

#### GET /api/alerts

**Query params:** `endpoint` (required) — the push subscription endpoint URL.

**Response:**
```json
{
  "alerts": [
    {
      "id": 1,
      "endpoint": "https://...",
      "alert_type": "sensor",
      "metric": "temp_c",
      "condition": "above",
      "threshold": 45,
      "prayer_timing": null,
      "prayer_minutes": null,
      "prayer_names": null,
      "created_at": "2026-04-25T10:00:00.000Z"
    }
  ]
}
```

#### POST /api/alerts

**Sensor alert body:**
```json
{
  "endpoint": "https://...",
  "alert_type": "sensor",
  "metric": "temp_c",
  "condition": "above",
  "threshold": 45
}
```

**Prayer alert body:**
```json
{
  "endpoint": "https://...",
  "alert_type": "prayer",
  "prayer_timing": "before",
  "prayer_minutes": 15,
  "prayer_names": ["fajr", "dhuhr", "asr", "maghrib", "isha"]
}
```

**Validation:**
- Subscription must exist (by endpoint)
- For `"sensor"`: metric must be in ALERT_METRICS, threshold within [min, max]
- For `"prayer"`: `prayer_names` required (array of valid names), `prayer_minutes` 1-120 (if timing is `"before"`)

**Response:** `{ "alert": AlertRule }`

#### PUT /api/alerts/:id

Same body as POST. Alert must belong to the provided `endpoint`.

**Response:** `{ "alert": AlertRule }`

#### DELETE /api/alerts/:id

**Query params:** `endpoint` (required)

**Response:** `{ "ok": true }`

---

## 10. Metrics Reference

All metrics available for alerts and automations.

### Outdoor (source: weather)

| Key | Label | Unit | Min | Max |
|-----|-------|------|:---:|:---:|
| `temp_c` | Outdoor Temperature | °C | -50 | 70 |
| `humidity` | Outdoor Humidity | % | 0 | 100 |
| `wind_speed_kmh` | Wind Speed | km/h | 0 | 200 |
| `wind_gust_kmh` | Wind Gust | km/h | 0 | 300 |
| `pressure_rel_hpa` | Barometric Pressure | hPa | 870 | 1084 |
| `rain_hourly_mm` | Rain (Hourly) | mm | 0 | 300 |
| `rain_daily_mm` | Rain (Daily) | mm | 0 | 500 |
| `solar_radiation` | Solar Radiation | W/m² | 0 | 1400 |
| `uv_index` | UV Index | — | 0 | 16 |

### Indoor (source: weather)

| Key | Label | Unit | Min | Max |
|-----|-------|------|:---:|:---:|
| `temp_indoor_c` | Indoor Temperature (Mom) | °C | -10 | 60 |
| `humidity_indoor` | Indoor Humidity (Mom) | % | 0 | 100 |
| `temp_ch8_c` | Indoor Temperature (Abdu) | °C | -10 | 60 |
| `humidity_ch8` | Indoor Humidity (Abdu) | % | 0 | 100 |
| `feels_like_indoor_c` | Feels Like (Mom) | °C | -10 | 60 |
| `feels_like_ch8_c` | Feels Like (Abdu) | °C | -10 | 60 |

### Air Quality (source: air)

| Key | Label | Unit | Min | Max | DB Column |
|-----|-------|------|:---:|:---:|-----------|
| `temperature_air` | Kitchen Temperature | °C | -10 | 60 | `temperature` |
| `humidity_air` | Kitchen Humidity | % | 0 | 100 | `humidity` |
| `co2` | CO2 | ppm | 0 | 5000 | `co2` |
| `pm25` | PM2.5 | µg/m³ | 0 | 500 | `pm25` |
| `pm10` | PM10 | µg/m³ | 0 | 600 | `pm10` |
| `tvoc` | tVOC | ppb | 0 | 1000 | `tvoc` |
| `noise` | Noise | dB | 0 | 130 | `noise` |

Note: Purifier automations only accept air quality metrics.

### Power (source: power)

| Key | Label | Unit | Min | Max | DB Column |
|-----|-------|------|:---:|:---:|-----------|
| `voltage` | Voltage | V | 0 | 300 | `voltage` |
| `power_grid` | Grid Power | W | 0 | 25000 | `power_1` |
| `power_gen` | Generator Power | W | 0 | 25000 | `power_2` |
| `power_total` | Total Power | W | 0 | 50000 | computed (`power_1 + power_2`) |
| `current_grid` | Grid Current | A | 0 | 100 | `current_1` |
| `current_gen` | Generator Current | A | 0 | 100 | `current_2` |

---

## 11. Enum Values

### AC Modes

| Value | Mode |
|:-----:|------|
| 0 | Auto |
| 1 | Cool |
| 2 | Dry |
| 3 | Fan |
| 4 | Heat |

### Fan Speed

| Value | Meaning | Abdu/Abdullah Behavior | Najat Behavior |
|:-----:|---------|----------------------|----------------|
| 0 | Auto | Auto | Auto |
| 1 | Level 1 | Silent mode (silenceSwitch=1) | Normal level 1 |
| 2 | Level 2 | Normal speed 2 | Normal level 2 |
| 3 | Level 3 | Normal speed 3 | Normal level 3 |
| 4 | Level 4 | Normal speed 4 | Normal level 4 |
| 5 | Level 5 | Normal speed 5 | Normal level 5 |
| 6 | Level 6 | Normal speed 6 | Normal level 6 |
| 7 | Level 7 | Turbo mode (turbo=1) | Normal level 7 |

### Vertical Swing

| Value | Position |
|:-----:|----------|
| 0 | Off (fixed, current position) |
| 1 | Full swing |
| 2 | Upper zone swing |
| 3 | Lower zone swing |
| 9 | Fixed: Top |
| 10 | Fixed: Upper |
| 11 | Fixed: Middle |
| 12 | Fixed: Lower |
| 13 | Fixed: Bottom |

### Horizontal Swing

| Value | Position |
|:-----:|----------|
| 0 | Off (fixed, current position) |
| 1 | Full swing |
| 2 | Left zone swing |
| 3 | Middle zone swing |
| 4 | Right zone swing |
| 9 | Fixed: Far Left |
| 10 | Fixed: Center-Left |
| 11 | Fixed: Center |
| 12 | Fixed: Center-Right |
| 13 | Fixed: Far Right |

### Generator Mode

| Value | Najat | Abdu/Abdullah |
|:-----:|-------|---------------|
| 0 | Off | Off |
| 1 | Level 1 | Level 1 |
| 2 | Level 2 | Level 2 |
| 3 | Level 3 | Level 3 |
| 4 | Level 4 | N/A |
| 5 | Level 5 | N/A |
| 6 | Level 6 | N/A |

### Purifier Modes

| Command Value | Mode |
|---------------|------|
| `"auto"` | Auto |
| `"silent"` | Silent / Night |
| `"favorite"` | Favorite (custom speed) |

### Prayer Names

| Key | Label |
|-----|-------|
| `fajr` | Fajr |
| `dhuhr` | Dhuhr |
| `asr` | Asr |
| `maghrib` | Maghrib |
| `isha` | Isha |

---

## Quick Reference: All Endpoints

| Method | Path | Auth | Description |
|--------|------|:----:|-------------|
| GET | `/api/health` | No | Health check |
| GET | `/api/current` | No | Latest weather + air + power |
| GET | `/api/current/power` | No | Latest power only |
| GET | `/api/history` | No | Historical data |
| GET | `/api/status` | No | System status |
| GET | `/api/solar-reference` | No | Solar radiation baseline |
| GET | `/api/forecast` | No | 7-day weather forecast |
| GET | `/api/prayer-times` | No | Prayer times, Hijri date, next event |
| POST | `/api/auth/login` | No | Login (returns cookie) |
| POST | `/api/auth/logout` | No | Logout (clears cookie) |
| GET | `/api/auth/me` | No | Check auth status |
| POST | `/api/power/ingest` | No | ESP power data ingest |
| GET | `/api/push/vapid-key` | No | VAPID public key |
| POST | `/api/push/subscribe` | No | Register push subscription |
| POST | `/api/push/unsubscribe` | No | Remove push subscription |
| GET | `/api/alerts` | No | List alert rules |
| POST | `/api/alerts` | No | Create alert rule |
| PUT | `/api/alerts/:id` | No | Update alert rule |
| DELETE | `/api/alerts/:id` | No | Delete alert rule |
| GET | `/api/xiaomi/auth-status` | Yes | Xiaomi cloud auth status |
| POST | `/api/xiaomi/verify` | Yes | Xiaomi 2FA/captcha verify |
| GET | `/api/devices` | Yes | List purifiers |
| POST | `/api/devices/:id/control` | Yes | Control purifier |
| GET | `/api/ac/devices` | Yes | List AC units |
| POST | `/api/ac/devices/:id/control` | Yes | Control AC |
| GET | `/api/ac/timers` | Yes | List AC timers |
| POST | `/api/ac/timer` | Yes | Set AC timer |
| DELETE | `/api/ac/timer/:deviceId` | Yes | Cancel AC timer |
| POST | `/api/ac/preset-sync` | Yes | Sync preset to automations |
| GET | `/api/automations` | Yes | List automations |
| POST | `/api/automations` | Yes | Create automation |
| PUT | `/api/automations/:id` | Yes | Update automation |
| PATCH | `/api/automations/:id` | Yes | Toggle automation |
| DELETE | `/api/automations/:id` | Yes | Delete automation |
| POST | `/api/automations/:id/test` | Yes | Test-fire automation |
