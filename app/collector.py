import asyncio
import base64
import logging
import time
from datetime import datetime, timezone

import httpx

logger = logging.getLogger("collector")


class Collector:
    def __init__(self, pool, config):
        self.pool = pool
        self.config = config
        self._qp_token = None
        self._qp_token_expires = 0

    async def run_forever(self):
        """Main loop: backfill, then collect every 60 seconds."""
        await self._backfill_ambient_history()
        # Wait 2s after backfill to respect AW rate limit before first poll
        await asyncio.sleep(2)
        while True:
            try:
                await self._collect_all()
            except Exception:
                logger.exception("Collection cycle failed")
            await asyncio.sleep(5)

    async def _collect_all(self):
        results = await asyncio.gather(
            self._collect_ambient_weather(),
            self._collect_qingping(),
            return_exceptions=True,
        )
        for r in results:
            if isinstance(r, Exception):
                logger.error("Collection error: %s", r)

    # ── Ambient Weather ──────────────────────────────────────────

    async def _collect_ambient_weather(self):
        url = "https://rt.ambientweather.net/v1/devices"
        params = {
            "apiKey": self.config.aw_api_key,
            "applicationKey": self.config.aw_app_key,
        }
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            devices = resp.json()

        if not devices:
            logger.warning("No devices from Ambient Weather")
            return

        data = devices[0]["lastData"]
        row = self._convert_aw(data)
        await self._store_weather(row)
        logger.info("Stored weather reading at %s", row["ts"])

    def _convert_aw(self, d: dict) -> dict:
        def f2c(f):
            return round((f - 32) * 5 / 9, 1) if f is not None else None

        def mph2kmh(v):
            return round(v * 1.60934, 1) if v is not None else None

        def in2mm(v):
            return round(v * 25.4, 2) if v is not None else None

        def inhg2hpa(v):
            return round(v * 33.8639, 1) if v is not None else None

        ts = datetime.fromtimestamp(d["dateutc"] / 1000, tz=timezone.utc)

        last_rain = None
        if d.get("lastRain"):
            try:
                last_rain = datetime.fromisoformat(
                    d["lastRain"].replace("Z", "+00:00")
                )
            except (ValueError, TypeError):
                pass

        return {
            "ts": ts,
            "temp_c": f2c(d.get("tempf")),
            "humidity": d.get("humidity"),
            "wind_speed_kmh": mph2kmh(d.get("windspeedmph")),
            "wind_gust_kmh": mph2kmh(d.get("windgustmph")),
            "max_daily_gust_kmh": mph2kmh(d.get("maxdailygust")),
            "wind_dir": d.get("winddir"),
            "wind_dir_avg10m": d.get("winddir_avg10m"),
            "pressure_rel_hpa": inhg2hpa(d.get("baromrelin")),
            "pressure_abs_hpa": inhg2hpa(d.get("baromabsin")),
            "rain_hourly_mm": in2mm(d.get("hourlyrainin")),
            "rain_event_mm": in2mm(d.get("eventrainin")),
            "rain_daily_mm": in2mm(d.get("dailyrainin")),
            "rain_weekly_mm": in2mm(d.get("weeklyrainin")),
            "rain_monthly_mm": in2mm(d.get("monthlyrainin")),
            "rain_yearly_mm": in2mm(d.get("yearlyrainin")),
            "solar_radiation": d.get("solarradiation"),
            "uv_index": d.get("uv"),
            "temp_indoor_c": f2c(d.get("tempinf")),
            "humidity_indoor": d.get("humidityin"),
            "feels_like_c": f2c(d.get("feelsLike")),
            "dew_point_c": f2c(d.get("dewPoint")),
            "temp_ch8_c": f2c(d.get("temp8f")),
            "humidity_ch8": d.get("humidity8"),
            "feels_like_indoor_c": f2c(d.get("feelsLikein")),
            "dew_point_indoor_c": f2c(d.get("dewPointin")),
            "feels_like_ch8_c": f2c(d.get("feelsLike8")),
            "dew_point_ch8_c": f2c(d.get("dewPoint8")),
            "batt_outdoor": d.get("battout"),
            "batt_indoor": d.get("battin"),
            "batt_ch8": d.get("batt8"),
            "last_rain": last_rain,
        }

    async def _store_weather(self, row: dict):
        async with self.pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO weather_readings (
                    ts, temp_c, humidity, wind_speed_kmh, wind_gust_kmh,
                    max_daily_gust_kmh, wind_dir, wind_dir_avg10m,
                    pressure_rel_hpa, pressure_abs_hpa,
                    rain_hourly_mm, rain_event_mm, rain_daily_mm,
                    rain_weekly_mm, rain_monthly_mm, rain_yearly_mm,
                    solar_radiation, uv_index, temp_indoor_c, humidity_indoor,
                    feels_like_c, dew_point_c, temp_ch8_c, humidity_ch8,
                    feels_like_indoor_c, dew_point_indoor_c,
                    feels_like_ch8_c, dew_point_ch8_c,
                    batt_outdoor, batt_indoor, batt_ch8, last_rain
                ) VALUES (
                    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                    $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
                    $25,$26,$27,$28,$29,$30,$31,$32
                ) ON CONFLICT (ts) DO NOTHING""",
                row["ts"],
                row["temp_c"],
                row["humidity"],
                row["wind_speed_kmh"],
                row["wind_gust_kmh"],
                row["max_daily_gust_kmh"],
                row["wind_dir"],
                row["wind_dir_avg10m"],
                row["pressure_rel_hpa"],
                row["pressure_abs_hpa"],
                row["rain_hourly_mm"],
                row["rain_event_mm"],
                row["rain_daily_mm"],
                row["rain_weekly_mm"],
                row["rain_monthly_mm"],
                row["rain_yearly_mm"],
                row["solar_radiation"],
                row["uv_index"],
                row["temp_indoor_c"],
                row["humidity_indoor"],
                row["feels_like_c"],
                row["dew_point_c"],
                row["temp_ch8_c"],
                row["humidity_ch8"],
                row["feels_like_indoor_c"],
                row["dew_point_indoor_c"],
                row["feels_like_ch8_c"],
                row["dew_point_ch8_c"],
                row["batt_outdoor"],
                row["batt_indoor"],
                row["batt_ch8"],
                row["last_rain"],
            )

    async def _backfill_ambient_history(self):
        """On startup, fetch last 24h of AW data to fill gaps."""
        mac = "C8:C9:A3:0E:CB:CB"
        url = f"https://rt.ambientweather.net/v1/devices/{mac}"
        params = {
            "apiKey": self.config.aw_api_key,
            "applicationKey": self.config.aw_app_key,
            "limit": 288,
        }
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.get(url, params=params)
                resp.raise_for_status()
                records = resp.json()

            count = 0
            for record in records:
                row = self._convert_aw(record)
                await self._store_weather(row)
                count += 1
            logger.info("Backfilled %d weather records", count)
        except Exception:
            logger.exception("Backfill failed, will retry on next restart")

    # ── Qingping ─────────────────────────────────────────────────

    async def _ensure_qp_token(self):
        if self._qp_token and time.time() < self._qp_token_expires - 300:
            return

        auth = base64.b64encode(
            f"{self.config.qp_app_key}:{self.config.qp_app_secret}".encode()
        ).decode()

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                "https://oauth.cleargrass.com/oauth2/token",
                headers={
                    "Authorization": f"Basic {auth}",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data="grant_type=client_credentials&scope=device_full_access",
            )
            resp.raise_for_status()
            body = resp.json()

        self._qp_token = body["access_token"]
        self._qp_token_expires = time.time() + body.get("expires_in", 7200)
        logger.info("Qingping token refreshed, expires in %ds", body.get("expires_in", 7200))

    async def _collect_qingping(self):
        await self._ensure_qp_token()
        ts_now = int(time.time())
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"https://apis.cleargrass.com/v1/apis/devices?timestamp={ts_now}",
                headers={"Authorization": f"Bearer {self._qp_token}"},
            )
            resp.raise_for_status()
            body = resp.json()

        if not body.get("devices"):
            logger.warning("No devices from Qingping")
            return

        data = body["devices"][0]["data"]
        ts = datetime.fromtimestamp(data["timestamp"]["value"], tz=timezone.utc)

        row = {
            "ts": ts,
            "temperature": data.get("temperature", {}).get("value"),
            "humidity": data.get("humidity", {}).get("value"),
            "co2": data.get("co2", {}).get("value"),
            "pm25": data.get("pm25", {}).get("value"),
            "pm10": data.get("pm10", {}).get("value"),
            "tvoc": data.get("tvoc_index", {}).get("value"),
            "noise": data.get("noise", {}).get("value"),
            "battery": data.get("battery", {}).get("value"),
        }
        await self._store_air(row)
        logger.info("Stored air reading at %s", row["ts"])

    async def _store_air(self, row: dict):
        async with self.pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO air_readings (
                    ts, temperature, humidity, co2, pm25, pm10,
                    tvoc, noise, battery
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                ON CONFLICT (ts) DO NOTHING""",
                row["ts"],
                row["temperature"],
                row["humidity"],
                row["co2"],
                row["pm25"],
                row["pm10"],
                row["tvoc"],
                row["noise"],
                row["battery"],
            )
