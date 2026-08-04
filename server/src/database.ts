import pg from "pg";
import { childLogger } from "./logger.js";

const { Pool } = pg;
const log = childLogger("database");

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
  "ALTER TABLE automations ADD COLUMN IF NOT EXISTS turn_off_at_end BOOLEAN NOT NULL DEFAULT false",
  "ALTER TABLE automations ADD COLUMN IF NOT EXISTS sustained_minutes INTEGER NOT NULL DEFAULT 0",
  "UPDATE automations SET action_off = NULL WHERE automation_type = 'metric'",
  // Prayer-relative schedule times
  "ALTER TABLE automations ADD COLUMN IF NOT EXISTS start_mode TEXT NOT NULL DEFAULT 'exact'",
  "ALTER TABLE automations ADD COLUMN IF NOT EXISTS start_prayer TEXT",
  "ALTER TABLE automations ADD COLUMN IF NOT EXISTS start_prayer_offset INTEGER",
  "ALTER TABLE automations ADD COLUMN IF NOT EXISTS end_mode TEXT NOT NULL DEFAULT 'exact'",
  "ALTER TABLE automations ADD COLUMN IF NOT EXISTS end_prayer TEXT",
  "ALTER TABLE automations ADD COLUMN IF NOT EXISTS end_prayer_offset INTEGER",
  `CREATE TABLE IF NOT EXISTS power_readings (
    ts          TIMESTAMPTZ PRIMARY KEY,
    voltage     REAL NOT NULL,
    current_1   REAL NOT NULL,
    current_2   REAL NOT NULL,
    power_1     REAL NOT NULL,
    power_2     REAL NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_power_ts_brin ON power_readings USING BRIN (ts)",
  // AC automation support
  "ALTER TABLE automations ADD COLUMN IF NOT EXISTS device_type TEXT NOT NULL DEFAULT 'purifier'",
  "ALTER TABLE automations ADD COLUMN IF NOT EXISTS threshold_low REAL",
  "ALTER TABLE automations ADD COLUMN IF NOT EXISTS range_slots JSONB",
  // Make metric automations re-check every loop tick instead of every 5 min
  "UPDATE automations SET cooldown_secs = 5 WHERE automation_type = 'metric' AND cooldown_secs > 5",
  // Server-side AC presets
  `CREATE TABLE IF NOT EXISTS ac_presets (
    device_id  TEXT NOT NULL,
    slot       SMALLINT NOT NULL CHECK (slot BETWEEN 1 AND 10),
    data       JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (device_id, slot)
  )`,
  // Widen AC preset slots from 5 to 10 on tables created before the bump
  "ALTER TABLE ac_presets DROP CONSTRAINT IF EXISTS ac_presets_slot_check",
  "ALTER TABLE ac_presets ADD CONSTRAINT ac_presets_slot_check CHECK (slot BETWEEN 1 AND 10)",
  `CREATE TABLE IF NOT EXISTS ac_manual_off_locks (
    device_id TEXT PRIMARY KEY,
    locked_at TIMESTAMPTZ DEFAULT NOW(),
    reason TEXT
  )`,
  // Smart AC leveling
  "ALTER TABLE automations ADD COLUMN IF NOT EXISTS smart_leveling BOOLEAN NOT NULL DEFAULT true",
  `CREATE TABLE IF NOT EXISTS ac_leveling_config (
    id         SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    config     JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS ac_leveling_shed (
    device_id TEXT PRIMARY KEY,
    shed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reason    TEXT
  )`,
  // Leveler fan holds — fans reduced to minimum as the last try before a shed
  `CREATE TABLE IF NOT EXISTS ac_leveling_fan_hold (
    device_id    TEXT PRIMARY KEY,
    original_fan SMALLINT NOT NULL,
    last_set_fan SMALLINT NOT NULL,
    held_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // Remembered stable gen level captured when an AC is auto-turned-off because
  // its temperature left the comfort range — warm-restored fast on the next
  // turn-on instead of re-discovering the level by slow climbing.
  `CREATE TABLE IF NOT EXISTS ac_leveling_remembered_level (
    device_id     TEXT PRIMARY KEY,
    level         SMALLINT NOT NULL,
    remembered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // Persistent per-AC "beep off" preference — row present = collector re-sends
  // set_beep 0 whenever the AC is observed on with the beep back on (firmware
  // resets beepSwitch after a power-loss restart)
  `CREATE TABLE IF NOT EXISTS ac_beep_off (
    device_id TEXT PRIMARY KEY,
    set_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // Per-AC measured draw at each gen level / fan speed, per source (re-runs overwrite)
  `CREATE TABLE IF NOT EXISTS ac_calibration_results (
    device_id   TEXT NOT NULL,
    source      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    step        SMALLINT NOT NULL,
    amps        REAL NOT NULL,
    voltage     REAL,
    stddev      REAL,
    samples     SMALLINT NOT NULL,
    measured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (device_id, source, kind, step)
  )`,
  // Per-device opt-in for Smart AC Leveling push notifications (off by default for everyone)
  "ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS leveling_notifications BOOLEAN NOT NULL DEFAULT false",
  // Leveling v2 config row (id=2) — widen the original CHECK (id = 1) so the v2
  // controller can own its own row (v1's save path would clobber unknown fields
  // in row 1). Paired idempotent entries per the CHECK-constraint change pattern.
  "ALTER TABLE ac_leveling_config DROP CONSTRAINT IF EXISTS ac_leveling_config_id_check",
  "ALTER TABLE ac_leveling_config ADD CONSTRAINT ac_leveling_config_id_check CHECK (id IN (1, 2))",
  // Leveling v2: persistent learned per-transition costs (survive deploys/config
  // saves — the v1 in-memory maps were wiped on both, so the self-correction
  // never accumulated). Keyed per device × source × transition (e.g. "level:1>2",
  // "on@L1", "fan:step").
  `CREATE TABLE IF NOT EXISTS ac_leveling_costs (
    device_id  TEXT NOT NULL,
    source     TEXT NOT NULL,
    transition TEXT NOT NULL,
    ewma_amps  REAL NOT NULL,
    samples    INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (device_id, source, transition)
  )`,
  // Leveling v2: command-outcome journal — every planned batch (shadow rows have
  // executed=false) with its pre-meter, expectation and graded outcome. Docker
  // logs rotate away in ~1.5 days; this is the durable forensics + the input for
  // continuous cost learning. ~250 rows/day.
  `CREATE TABLE IF NOT EXISTS ac_leveling_journal (
    id             BIGSERIAL PRIMARY KEY,
    at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source         TEXT NOT NULL,
    mode           TEXT NOT NULL,
    severity       TEXT,
    reason         TEXT NOT NULL,
    required_amps  REAL,
    pre_amps       REAL,
    commands       JSONB NOT NULL,
    decisions      JSONB,
    expected_delta REAL,
    executed       BOOLEAN NOT NULL DEFAULT true,
    graded_at      TIMESTAMPTZ,
    post_amps      REAL,
    observed_delta REAL
  )`,
  "CREATE INDEX IF NOT EXISTS ac_leveling_journal_at_brin ON ac_leveling_journal USING BRIN (at)",
  // Who commanded each AC control — the 2026-07-24 "Najat keeps turning back on"
  // incident was authenticated set_power=1 calls the server could not attribute
  // (agent and human sessions were indistinguishable, and docker logs rotate in
  // ~1.5 days). Kept 30 days.
  `CREATE TABLE IF NOT EXISTS ac_control_audit (
    id         BIGSERIAL PRIMARY KEY,
    at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    device_id  TEXT NOT NULL,
    command    TEXT NOT NULL,
    value      TEXT,
    auth_kind  TEXT NOT NULL,
    ip         TEXT,
    user_agent TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS ac_control_audit_at_brin ON ac_control_audit USING BRIN (at)",
  // Leveling v2: the LEARNED non-cooling hold (user, 2026-08-04). When the
  // system observes — or the user demonstrates by raising the room by hand —
  // that a level does not cool, it records the outdoor temperature it observed
  // that at, and stops targeting the level until the weather drops back under
  // it or the record ages out. Persisted because a 6-hour hold that a deploy
  // silently erases is a trap: the heat outlives our release cadence.
  `CREATE TABLE IF NOT EXISTS ac_leveling_level_hold (
    device_id   TEXT PRIMARY KEY,
    level       SMALLINT NOT NULL,
    outdoor_c   REAL NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
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
  log.info(`[database] Migrated legacy breakpoints for ${subs.rowCount} subscriptions`);
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
      log.info("[database] Created database 'home'");
    }
  } finally {
    await bootstrapClient.end();
  }

  const pool = new Pool({ connectionString: dsn, min: 2, max: 5 });
  log.info("[database] Database pool created");
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
  log.info("[database] Database schema initialized");
}
