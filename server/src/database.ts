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
  `CREATE TABLE IF NOT EXISTS alert_rules (
    id SERIAL PRIMARY KEY,
    endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
    alert_type TEXT NOT NULL CHECK (alert_type IN ('sensor','prayer')),
    metric TEXT,
    condition TEXT CHECK (condition IN ('above','below')),
    threshold REAL,
    prayer_timing TEXT CHECK (prayer_timing IN ('at_time','before')),
    prayer_minutes INTEGER,
    prayer_names TEXT[],
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS automations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    metric TEXT NOT NULL,
    condition TEXT NOT NULL CHECK (condition IN ('above','below')),
    threshold REAL NOT NULL,
    device_id TEXT NOT NULL,
    device_name TEXT NOT NULL,
    action_on JSONB NOT NULL,
    action_off JSONB,
    cooldown_secs INTEGER NOT NULL DEFAULT 300,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  "ALTER TABLE automations ADD COLUMN IF NOT EXISTS device_ids TEXT[]",
  "ALTER TABLE automations ADD COLUMN IF NOT EXISTS device_names TEXT[]",
  // Time-based automation support
  "ALTER TABLE automations ADD COLUMN IF NOT EXISTS automation_type TEXT NOT NULL DEFAULT 'metric'",
  "ALTER TABLE automations ADD COLUMN IF NOT EXISTS time_start TEXT",
  "ALTER TABLE automations ADD COLUMN IF NOT EXISTS time_end TEXT",
  "ALTER TABLE automations ALTER COLUMN metric DROP NOT NULL",
  "ALTER TABLE automations ALTER COLUMN condition DROP NOT NULL",
  "ALTER TABLE automations ALTER COLUMN threshold DROP NOT NULL",
];

async function migrateLegacyBreakpoints(client: pg.PoolClient): Promise<void> {
  const existing = await client.query("SELECT COUNT(*) FROM alert_rules");
  if (Number(existing.rows[0].count) > 0) return;

  const subs = await client.query(
    "SELECT endpoint, breakpoints FROM push_subscriptions WHERE breakpoints IS NOT NULL"
  );
  if (subs.rowCount === 0) return;

  for (const row of subs.rows) {
    const bps = (row.breakpoints as number[]) ?? [];
    for (const bp of bps) {
      await client.query(
        `INSERT INTO alert_rules (endpoint, alert_type, prayer_timing, prayer_minutes, prayer_names)
         VALUES ($1, 'prayer', $2, $3, $4)`,
        [
          row.endpoint,
          bp === 0 ? "at_time" : "before",
          bp === 0 ? null : bp,
          ["fajr", "dhuhr", "asr", "maghrib", "isha"],
        ]
      );
    }
  }
  console.log(`[database] Migrated legacy breakpoints for ${subs.rowCount} subscriptions`);
}

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
    // One-time migration: convert legacy breakpoints to alert_rules
    await migrateLegacyBreakpoints(client);
  } finally {
    client.release();
  }
  console.log("[database] Database schema initialized");
}
