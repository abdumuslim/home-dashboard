# Dashboard Frontend Handoff

## Goal
Redesign the frontend to match the Ambient Weather app style (see reference screenshots). The backend API is unchanged — only frontend files need editing.

## Files to edit (frontend only)
- `D:\dev\home\app\static\index.html`
- `D:\dev\home\app\static\style.css`
- `D:\dev\home\app\static\app.js`

## Deploy command
```bash
scp -i ~/.ssh/vps1_key -o StrictHostKeyChecking=no -r D:/dev/home/app/static/* root@31.97.76.221:/opt/home-dashboard/app/static/
ssh -i ~/.ssh/vps1_key -o StrictHostKeyChecking=no root@31.97.76.221 "cd /opt/home-dashboard && docker compose up -d --build"
```
Bump `?v=N` in index.html on each deploy for cache busting.

## API: `GET /api/current` returns:
```json
{
  "weather": {
    "ts": "2026-02-25T14:11:00+00:00",
    "temp_c": 21.1, "humidity": 59, "feels_like_c": 20.5, "dew_point_c": 12.6,
    "wind_speed_kmh": 6.5, "wind_gust_kmh": 14.8, "wind_dir": 280,
    "pressure_rel_hpa": 1016.2, "pressure_abs_hpa": 1016.2,
    "rain_hourly_mm": 0.0, "rain_daily_mm": 0.0, "rain_monthly_mm": 5.08,
    "solar_radiation": 46.4, "uv_index": 0,
    "temp_indoor_c": 25.4, "humidity_indoor": 55,
    "feels_like_indoor_c": 25.4, "dew_point_indoor_c": 15.7,
    "temp_ch8_c": 25.0, "humidity_ch8": 34,
    "feels_like_ch8_c": 24.4, "dew_point_ch8_c": 8.0
  },
  "air": {
    "ts": "2026-02-25T14:00:00+00:00",
    "co2": 518, "pm25": 7, "pm10": 7, "tvoc": 88, "noise": 36,
    "temperature": 23.5, "humidity": 42.1, "battery": 54
  }
}
```

## API: `GET /api/history?source=weather|air&range=6h|24h|48h|1w|30d`
Returns `{ source, range, count, data: [array of rows with same fields + ts] }`

## Dashboard layout (4 sensor groups, 16 cards)

**Outdoor (WS-2000):** Temperature, Wind, Humidity, Rainfall, Solar Radiation, UV Index, Pressure

**Air Quality (Qingping CGS1):** CO2, PM2.5, PM10, tVOC, Noise, Battery

**Indoor (WS Console):** Temperature + Humidity (with feels like, dew point)

**Abdu (WS Ch8):** Temperature + Humidity (with feels like, dew point)

**Air Monitor temp/humidity** from the Qingping sensor

## Reference app design (Ambient Weather)
- 4-column grid of equal dark cards
- Each card: colored icon (top-left) + title (top-right) + large value centered + secondary info below
- Wind card: clean yellow/golden circle (NO tick marks, NO gauge), speed as text inside circle, simple white line+arrow from center showing direction, "From W" and "Gusts X" next to the circle
- Rainfall: 3 columns (Rate mm/hr, Day mm, Event mm)
- UV: large number + "LOW RISK" / "MODERATE" / "HIGH" text
- Pressure: value + trend arrow (rising/falling/stable)
- Indoor cards: Temperature and Humidity side by side with Dew Point + Feels Like below
- Dark background, colored icons per card type (cyan, blue, yellow, green, etc.)

## Constraints
- Plain HTML/CSS/JS, no build tools, no frameworks
- Chart.js v4 from CDN for charts
- Dark theme, responsive
- Timezone: Asia/Baghdad
- Poll `/api/current` every 5s, `/api/history` every 60s, clock tick every 1s
- Charts should be in a separate "Charts" tab (lazy-init on first visit)
