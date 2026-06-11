<!-- Tier-3 agent doc. Loaded on demand via CLAUDE.md / AGENTS.md routing table. -->

# Database Schema

TL;DR: The app uses a PostgreSQL database named `home` running on the shared, pre-existing `rag-postgres-1` container (pgvector:pg16) on the VPS; the database is auto-created on first startup. Schema init and migrations live in `server/src/database.ts`. Time-series tables are keyed by `ts TIMESTAMPTZ` with BRIN indexes. For the in-memory 1-minute median buffering that feeds these tables, see [architecture.md](architecture.md); for behavior built on these tables see [ac-automations.md](ac-automations.md) and [ac-leveling.md](ac-leveling.md).

## Tables

Main tables in the `home` database:

- `weather_readings` — 32 columns, keyed by `ts TIMESTAMPTZ` with BRIN index (metric units, all conversions done at collection time). Includes outdoor, indoor console, and ch8 "Abdu" sensor data.
- `air_readings` — 9 columns, keyed by `ts TIMESTAMPTZ` with BRIN index
- `alert_rules` — per-subscription alert configurations (FK to `push_subscriptions.endpoint` with CASCADE). Fields: `alert_type` (sensor/prayer), `metric`, `condition` (above/below), `threshold`, `prayer_timing` (at_time/before), `prayer_minutes`, `prayer_names TEXT[]`.
- `automations` — Device automation rules (purifiers + ACs). Fields: `id`, `automation_type` (metric/schedule), `device_type` (purifier/ac), `device_ids`, `device_names`, `metric`, `condition`, `threshold`, `threshold_low` (AC range hysteresis), `sustained_minutes` (metric type), `time_start`, `time_end`, `turn_off_at_end` (both types), `start_mode`, `start_prayer`, `start_prayer_offset`, `end_mode`, `end_prayer`, `end_prayer_offset` (schedule type), `action_on` (JSONB — purifier: `{power:"on"}`, AC: full preset profile `{power:1, mode, temperature, fan_speed, eco, turbo, screen, vertical_swing, horizontal_swing, fresh_air, generator_mode}`), `action_off`, `cooldown_secs`, `enabled`.
- `power_readings` — 6 columns (ts, voltage, current_1, current_2, power_1, power_2), keyed by `ts TIMESTAMPTZ` with BRIN index
- `ac_presets` — Server-side AC preset storage. Composite PK `(device_id, slot)`. Fields: `device_id TEXT`, `slot SMALLINT` (1-10), `data JSONB` (PresetData shape), `updated_at TIMESTAMPTZ`. Max 30 rows (3 devices × 10 slots). Slot range widened 5→10 (2026-06-06) via idempotent `ALTER TABLE ... DROP CONSTRAINT IF EXISTS ac_presets_slot_check` + `ADD CONSTRAINT` migration entries — this DROP/ADD pair is the pattern for changing CHECK constraints on existing tables (CREATE TABLE IF NOT EXISTS won't update them).
- `ac_manual_off_locks` — Persistent AC manual-off intent. Fields: `device_id TEXT PRIMARY KEY`, `locked_at TIMESTAMPTZ`, `reason TEXT`. This table prevents deploys/restarts from clearing a user's manual-off choice. Never auto-clear from temperature thresholds; clear only on explicit/observed manual-on.
- `ac_beep_off` — Persistent per-AC beep-off preference. Fields: `device_id TEXT PRIMARY KEY`, `set_at TIMESTAMPTZ`. Row present = collector re-sends `set_beep 0` whenever the AC is observed ON with shadow `beep: true` (TCL firmware resets `beepSwitch` to ON after a power-loss restart). Written via UI Beep toggle (`set_beep 0` records, `set_beep 1` deletes — `onUserBeep` hook → `collector.noteUserAcBeep()`). Enforced by `checkAcBeepEnforcement()` each tick: 30s per-device resend cooldown, own 30s-gated `fetchDevicesLive` when the shared cache is cold, skipped while calibration is active. Deliberately NOT part of presets/`AcAction`/last-state restore — single source of truth.
- `ac_leveling_config` — Smart AC Leveling config. Single row (`id SMALLINT PRIMARY KEY CHECK (id = 1)`), `config JSONB` (enabled, gridLimitAmps, genLimitAmps, marginAmps, raiseBufferAmps (raise-side hysteresis deadband, default 1A — see the "Raise hysteresis buffer" section in [ac-leveling.md](ac-leveling.md)), comfortTargetC, priority[], ampModels{} (grid + fallback), genAmpModels{} (optional, used on generator), levelBoosts{deviceId: {minLevel, outdoorAtLeastC}}), `updated_at`. New fields reach existing rows via the load/save default-merge (no migration).
- `ac_leveling_shed` — ACs powered off by the leveler (NOT manual-off). Fields: `device_id TEXT PRIMARY KEY`, `shed_at TIMESTAMPTZ`, `reason TEXT`. Survives restarts so a shed AC is still auto-restored after a deploy. Cleared on restore, user power on/off, automation-driven off, or observed external ON (15s grace).
- `ac_leveling_fan_hold` — Leveler fan holds (fans reduced to minimum as the last try before a shed). Fields: `device_id TEXT PRIMARY KEY`, `original_fan SMALLINT`, `last_set_fan SMALLINT`, `held_at TIMESTAMPTZ`. Survives restarts so the staged fan restore resumes after a deploy (otherwise automation-less ACs would stay stuck at fan 1 invisibly). Cleared on full restore, user/external fan change, shed, power-off, or leveler disable.
- `ac_leveling_remembered_level` — Stable gen level captured on a temperature-cycling auto-off for fast warm-restore on return. Fields: `device_id TEXT PRIMARY KEY`, `level SMALLINT`, `remembered_at TIMESTAMPTZ`. Survives restarts so a deploy mid-cycle doesn't force a slow re-climb. Written by `rememberStableLevel()` (only for levels ≥ 2); cleared on reaching the level, manual gen/power change, or shed.
- `ac_calibration_results` — Per-AC measured draw per step. Composite PK `(device_id, source, kind, step)`; `source` 'grid'|'gen', `kind` 'level'|'fan', `step` (level 1–3 since the 2026-06 TCL level removal / fan 1–7), `amps REAL` (median(samples) − all-off baseline), `voltage REAL`, `stddev REAL`, `samples SMALLINT`, `measured_at`. Upsert on re-run (latest measurement wins). Read by `GET /api/ac/calibration` which also derives `suggestedFit` (least-squares base/step per device+source).
- `automations.smart_leveling BOOLEAN DEFAULT true` — per-automation opt-out from leveling (AC rules only).

Other tables referenced elsewhere: `push_subscriptions` (Web Push subscriptions, synced on page load; `alert_rules` FKs to its `endpoint` — see the Push Notifications bullet in [architecture.md](architecture.md)).

## Migrations & Conventions

- New columns/tables are added via the `MIGRATIONS` list in `database.ts`.
- **CHECK-constraint change pattern**: `CREATE TABLE IF NOT EXISTS` will NOT update an existing table's CHECK constraint. Use idempotent paired migration entries: `ALTER TABLE ... DROP CONSTRAINT IF EXISTS <name>` followed by `ALTER TABLE ... ADD CONSTRAINT <name> CHECK (...)` (this is how `ac_presets_slot_check` was widened from slots 1–5 to 1–10 on 2026-06-06).
- Deduplication on time-series inserts: `ON CONFLICT (ts) DO NOTHING`.
- The 30-day history endpoint downsamples to hourly averages.

## Known Schema Gotchas

- `air_readings` uses SMALLINT columns (co2, pm25, pm10, tvoc, noise, battery) — the 1-minute median writer can produce fractional values like `692.5` and fail the insert; see "Known Bugs" in [architecture.md](architecture.md).
- `power_readings` numeric columns are REAL, so fractional medians are fine there.
