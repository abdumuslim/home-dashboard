import asyncpg
import logging

logger = logging.getLogger("database")

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS weather_readings (
    ts                  TIMESTAMPTZ PRIMARY KEY,
    temp_c              REAL,
    humidity            REAL,
    wind_speed_kmh      REAL,
    wind_gust_kmh       REAL,
    max_daily_gust_kmh  REAL,
    wind_dir            SMALLINT,
    wind_dir_avg10m     SMALLINT,
    pressure_rel_hpa    REAL,
    pressure_abs_hpa    REAL,
    rain_hourly_mm      REAL,
    rain_event_mm       REAL,
    rain_daily_mm       REAL,
    rain_weekly_mm      REAL,
    rain_monthly_mm     REAL,
    rain_yearly_mm      REAL,
    solar_radiation     REAL,
    uv_index            SMALLINT,
    temp_indoor_c       REAL,
    humidity_indoor     REAL,
    feels_like_c        REAL,
    dew_point_c         REAL,
    temp_ch8_c          REAL,
    humidity_ch8        REAL,
    batt_outdoor        SMALLINT,
    batt_indoor         SMALLINT,
    batt_ch8            SMALLINT,
    last_rain           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS air_readings (
    ts          TIMESTAMPTZ PRIMARY KEY,
    temperature REAL,
    humidity    REAL,
    co2         SMALLINT,
    pm25        SMALLINT,
    pm10        SMALLINT,
    tvoc        SMALLINT,
    noise       SMALLINT,
    battery     SMALLINT
);

CREATE INDEX IF NOT EXISTS idx_weather_ts_brin ON weather_readings USING BRIN (ts);
CREATE INDEX IF NOT EXISTS idx_air_ts_brin ON air_readings USING BRIN (ts);
"""


async def create_pool(dsn: str) -> asyncpg.Pool:
    # Ensure the 'home' database exists
    base_dsn = dsn.rsplit("/", 1)[0] + "/postgres"
    conn = await asyncpg.connect(base_dsn)
    try:
        exists = await conn.fetchval(
            "SELECT 1 FROM pg_database WHERE datname = 'home'"
        )
        if not exists:
            await conn.execute("CREATE DATABASE home")
            logger.info("Created database 'home'")
    finally:
        await conn.close()

    pool = await asyncpg.create_pool(dsn, min_size=2, max_size=5)
    logger.info("Database pool created")
    return pool


MIGRATIONS = [
    "ALTER TABLE weather_readings ADD COLUMN IF NOT EXISTS feels_like_indoor_c REAL",
    "ALTER TABLE weather_readings ADD COLUMN IF NOT EXISTS dew_point_indoor_c REAL",
    "ALTER TABLE weather_readings ADD COLUMN IF NOT EXISTS feels_like_ch8_c REAL",
    "ALTER TABLE weather_readings ADD COLUMN IF NOT EXISTS dew_point_ch8_c REAL",
]


async def init_db(pool: asyncpg.Pool):
    async with pool.acquire() as conn:
        await conn.execute(SCHEMA_SQL)
        for sql in MIGRATIONS:
            await conn.execute(sql)
    logger.info("Database schema initialized")
