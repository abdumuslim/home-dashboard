import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Query, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from config import settings
from database import create_pool, init_db
from collector import Collector

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)-12s %(levelname)-8s %(message)s",
)
logger = logging.getLogger("main")

RANGE_MAP = {
    "6h": "6 hours",
    "24h": "24 hours",
    "48h": "48 hours",
    "1w": "7 days",
    "30d": "30 days",
}

# Columns to average for 30d downsampling
WEATHER_AVG_COLS = [
    "temp_c", "humidity", "wind_speed_kmh", "wind_gust_kmh",
    "pressure_rel_hpa", "pressure_abs_hpa", "solar_radiation",
    "uv_index", "temp_indoor_c", "humidity_indoor",
    "feels_like_c", "dew_point_c", "temp_ch8_c", "humidity_ch8",
    "feels_like_indoor_c", "dew_point_indoor_c",
    "feels_like_ch8_c", "dew_point_ch8_c",
    "rain_hourly_mm",
]

AIR_AVG_COLS = [
    "temperature", "humidity", "co2", "pm25", "pm10",
    "tvoc", "noise", "battery",
]


def _row_to_dict(row):
    """Convert asyncpg Record to dict with ISO timestamps."""
    d = dict(row)
    for k, v in d.items():
        if isinstance(v, datetime):
            d[k] = v.isoformat()
    return d


@asynccontextmanager
async def lifespan(app: FastAPI):
    pool = await create_pool(settings.database_url)
    await init_db(pool)
    app.state.pool = pool

    collector = Collector(pool, settings)
    task = asyncio.create_task(collector.run_forever())
    logger.info("Collector started")

    yield

    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    await pool.close()
    logger.info("Shutdown complete")


app = FastAPI(title="Home Dashboard", lifespan=lifespan)


class NoCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/api/") or request.url.path.endswith((".js", ".css", ".html")):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return response


app.add_middleware(NoCacheMiddleware)


@app.get("/api/current")
async def get_current():
    pool = app.state.pool
    async with pool.acquire() as conn:
        weather = await conn.fetchrow(
            "SELECT * FROM weather_readings ORDER BY ts DESC LIMIT 1"
        )
        air = await conn.fetchrow(
            "SELECT * FROM air_readings ORDER BY ts DESC LIMIT 1"
        )
    return {
        "weather": _row_to_dict(weather) if weather else None,
        "air": _row_to_dict(air) if air else None,
    }


@app.get("/api/history")
async def get_history(
    source: str = Query("weather", pattern="^(weather|air)$"),
    range: str = Query("24h", pattern="^(6h|24h|48h|1w|30d)$"),
):
    table = "weather_readings" if source == "weather" else "air_readings"
    interval = RANGE_MAP[range]
    pool = app.state.pool

    async with pool.acquire() as conn:
        if range == "30d":
            cols = WEATHER_AVG_COLS if source == "weather" else AIR_AVG_COLS
            avg_exprs = ", ".join(f"AVG({c})::REAL AS {c}" for c in cols)
            rows = await conn.fetch(f"""
                SELECT date_trunc('hour', ts) AS ts, {avg_exprs}
                FROM {table}
                WHERE ts >= NOW() - INTERVAL '{interval}'
                GROUP BY date_trunc('hour', ts)
                ORDER BY ts ASC
            """)
        else:
            rows = await conn.fetch(f"""
                SELECT * FROM {table}
                WHERE ts >= NOW() - INTERVAL '{interval}'
                ORDER BY ts ASC
            """)

    return {
        "source": source,
        "range": range,
        "count": len(rows),
        "data": [_row_to_dict(r) for r in rows],
    }


@app.get("/api/status")
async def get_status():
    pool = app.state.pool
    async with pool.acquire() as conn:
        weather_last = await conn.fetchval(
            "SELECT ts FROM weather_readings ORDER BY ts DESC LIMIT 1"
        )
        air_last = await conn.fetchval(
            "SELECT ts FROM air_readings ORDER BY ts DESC LIMIT 1"
        )
        weather_count = await conn.fetchval("SELECT COUNT(*) FROM weather_readings")
        air_count = await conn.fetchval("SELECT COUNT(*) FROM air_readings")

    return {
        "weather_last_update": weather_last.isoformat() if weather_last else None,
        "air_last_update": air_last.isoformat() if air_last else None,
        "weather_total_readings": weather_count,
        "air_total_readings": air_count,
        "collector_interval_seconds": 300,
    }


# Serve frontend — must be last (catch-all)
app.mount("/", StaticFiles(directory="static", html=True), name="static")
