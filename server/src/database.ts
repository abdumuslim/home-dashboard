import pg from "pg";

const { Pool } = pg;

const SCHEMA_SQL = `
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
`;

const MIGRATIONS: string[] = [
  "ALTER TABLE weather_readings ADD COLUMN IF NOT EXISTS feels_like_indoor_c REAL",
  "ALTER TABLE weather_readings ADD COLUMN IF NOT EXISTS dew_point_indoor_c REAL",
  "ALTER TABLE weather_readings ADD COLUMN IF NOT EXISTS feels_like_ch8_c REAL",
  "ALTER TABLE weather_readings ADD COLUMN IF NOT EXISTS dew_point_ch8_c REAL",
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    id SERIAL PRIMARY KEY,
    endpoint TEXT UNIQUE NOT NULL,
    subscription JSONB NOT NULL,
    breakpoints INTEGER[] DEFAULT '{15,7,4,2,0}',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
];

export async function createPool(dsn: string): Promise<pg.Pool> {
  // Parse the DSN to connect to the default 'postgres' database first
  const baseDsn = dsn.substring(0, dsn.lastIndexOf("/")) + "/postgres";
  const bootstrapClient = new pg.Client({ connectionString: baseDsn });
  await bootstrapClient.connect();
  try {
    const result = await bootstrapClient.query(
      "SELECT 1 FROM pg_database WHERE datname = 'home'"
    );
    if (result.rowCount === 0) {
      await bootstrapClient.query("CREATE DATABASE home");
      console.log("[database] Created database 'home'");
    }
  } finally {
    await bootstrapClient.end();
  }

  const pool = new Pool({ connectionString: dsn, min: 2, max: 5 });
  console.log("[database] Database pool created");
  return pool;
}

export async function initDb(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
    for (const sql of MIGRATIONS) {
      await client.query(sql);
    }
  } finally {
    client.release();
  }
  console.log("[database] Database schema initialized");
}
