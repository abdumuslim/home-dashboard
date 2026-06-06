// Stateful Smart AC Leveling controller. Owns config/shed persistence, power
// reading streaks, manual gen-level intents, and command execution. The pure
// allocation math lives in ac-leveling.ts; the Collector builds the per-tick
// device context (need tiers, opt-outs) and drives tick().
import pg from "pg";
import {
  computeAllocation,
  determineSource,
  estimateAcDraw,
  needCap,
  AC_RAMP_MS,
  RAISE_STREAK,
  SETTLE_MS,
  SHED_CLEAR_GRACE_MS,
  STALE_POWER_MS,
  DEFAULT_LEVELING_CONFIG,
  type AcAmpModel,
  type AcLevelingConfig,
  type AllocationResult,
  type AllocatorInput,
  type LevelerAcSnapshot,
  type NeedTier,
  type PowerSource,
} from "./ac-leveling.js";
import type { TclCloud, AcDevice } from "./tcl-cloud.js";
import { childLogger } from "./logger.js";

const log = childLogger("ac-leveler");

export interface AcLevelerDeps {
  getTclCloud: () => TclCloud | null;
  broadcast: (payload: Record<string, unknown>) => Promise<void>;
  setDevicePowerCache: (deviceId: string, power: "on" | "off") => void;
  isManualOffLocked: (deviceId: string) => Promise<boolean>;
  /** Fired on every leveler fan command so range-automation fan enforcement re-baselines. */
  onLevelerFanCommand: (deviceId: string, fan: number) => void;
}

export interface LevelerDeviceContext {
  device: AcDevice;
  /** False when an enabled AC automation covering this device has smart_leveling=false. */
  managed: boolean;
  needTier: NeedTier;
  /** °C above the target/satisfied point (≤0 = satisfied). */
  needDelta: number;
}

export interface AcLevelingAcStatus {
  deviceId: string;
  name: string;
  on: boolean;
  managed: boolean;
  shed: boolean;
  level: number;
  maxLevel: number;
  minLevel: number;
  estAmps: number;
  needTier: NeedTier;
  needCap: number;
  needDelta: number;
  manualCap: number | null;
  manualTarget: number | null;
  idealLevel: number | null;
  /** Fan the leveler is currently holding the AC at (null = no hold). */
  heldFan: number | null;
  /** Original fan the hold will restore to (0 = built-in auto). */
  fanOriginal: number | null;
}

export interface AcLevelingStatus {
  enabled: boolean;
  source: PowerSource;
  measuredAmps: number | null;
  limitAmps: number | null;
  budgetAmps: number | null;
  nonAcLoadAmps: number | null;
  overLimitStreak: number;
  headroomStreak: number;
  settleRemainingMs: number;
  acs: AcLevelingAcStatus[];
}

interface PowerReading {
  current_1: number;
  current_2: number;
}

export class AcLeveler {
  private pool: pg.Pool;
  private deps: AcLevelerDeps;
  // Persistent state
  private config: AcLevelingConfig = { ...DEFAULT_LEVELING_CONFIG };
  private shedIds = new Set<string>();
  private shedTimes = new Map<string, number>();
  private loaded = false;
  // Power reading state (updated per ESP reading, not per tick)
  private lastReading: PowerReading | null = null;
  private lastReadingAt = 0;
  private lastSource: PowerSource = "none";
  private recentMeasured: number[] = [];
  private overLimitStreak = 0;
  private headroomStreak = 0;
  // Runtime control state
  private lastSetLevel = new Map<string, number>();
  private manualCap = new Map<string, number>();
  private manualTarget = new Map<string, number>();
  // Fan holds: fans reduced to minimum as the last try before a shed (persisted)
  private fanHold = new Map<string, { originalFan: number; lastSetFan: number }>();
  private fanExempt = new Set<string>();
  private prevPowerStates = new Map<string, boolean>();
  private rampUntil = new Map<string, number>();
  private boostActive = new Map<string, boolean>();
  private deviceNames = new Map<string, string>();
  private settleUntil = 0;
  private forceEvaluate = false;
  private lastNonAcLoad = 0;
  private lastStatus: AcLevelingStatus | null = null;

  constructor(pool: pg.Pool, deps: AcLevelerDeps) {
    this.pool = pool;
    this.deps = deps;
  }

  // ---------- Persistence ----------

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const cfgRes = await this.pool.query("SELECT config FROM ac_leveling_config WHERE id = 1");
    if (cfgRes.rows[0]?.config) {
      this.config = { ...DEFAULT_LEVELING_CONFIG, ...(cfgRes.rows[0].config as Partial<AcLevelingConfig>) };
    }
    const shedRes = await this.pool.query("SELECT device_id, shed_at FROM ac_leveling_shed");
    for (const row of shedRes.rows) {
      const deviceId = String(row.device_id);
      this.shedIds.add(deviceId);
      this.shedTimes.set(deviceId, row.shed_at instanceof Date ? row.shed_at.getTime() : Date.now());
    }
    const holdRes = await this.pool.query(
      "SELECT device_id, original_fan, last_set_fan FROM ac_leveling_fan_hold",
    );
    for (const row of holdRes.rows) {
      this.fanHold.set(String(row.device_id), {
        originalFan: Number(row.original_fan),
        lastSetFan: Number(row.last_set_fan),
      });
    }
    this.loaded = true;
    if (this.shedIds.size > 0) {
      log.info(`[leveler] Loaded ${this.shedIds.size} shed device(s) from DB`);
    }
    if (this.fanHold.size > 0) {
      log.info(`[leveler] Loaded ${this.fanHold.size} fan hold(s) from DB`);
    }
  }

  async getConfig(): Promise<AcLevelingConfig> {
    await this.ensureLoaded();
    return this.config;
  }

  async updateConfig(cfg: AcLevelingConfig): Promise<AcLevelingConfig> {
    await this.ensureLoaded();
    await this.pool.query(
      `INSERT INTO ac_leveling_config (id, config, updated_at) VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()`,
      [JSON.stringify(cfg)],
    );
    this.config = cfg;
    this.forceEvaluate = true;
    if (!cfg.enabled && this.fanHold.size > 0) {
      // Leveler switched off mid-hold — leave the house physically right.
      const tcl = this.deps.getTclCloud();
      for (const [deviceId, hold] of [...this.fanHold]) {
        try {
          await tcl?.sendControl(deviceId, "set_fan_speed", hold.originalFan);
          this.deps.onLevelerFanCommand(deviceId, hold.originalFan);
        } catch (err) {
          log.error(`[leveler] Fan restore on disable failed for ${deviceId}:`, (err as Error).message);
        }
        await this.clearFanHold(deviceId, "leveler_disabled");
      }
      this.fanExempt.clear();
    }
    log.info(`[leveler] Config updated (enabled=${cfg.enabled}, grid=${cfg.gridLimitAmps}A, gen=${cfg.genLimitAmps}A)`);
    return cfg;
  }

  isEnabled(): boolean {
    return this.loaded && this.config.enabled;
  }

  getComfortTarget(): number {
    return this.config.comfortTargetC;
  }

  isShed(deviceId: string): boolean {
    return this.shedIds.has(deviceId);
  }

  private async recordShed(deviceId: string, reason: string): Promise<void> {
    this.shedIds.add(deviceId);
    this.shedTimes.set(deviceId, Date.now());
    await this.pool.query(
      `INSERT INTO ac_leveling_shed (device_id, shed_at, reason) VALUES ($1, NOW(), $2)
       ON CONFLICT (device_id) DO UPDATE SET shed_at = NOW(), reason = EXCLUDED.reason`,
      [deviceId, reason],
    );
    this.deps.setDevicePowerCache(deviceId, "off");
    log.info(`[leveler] Shed AC ${deviceId} (${reason})`);
  }

  async clearShed(deviceId: string, reason: string): Promise<void> {
    if (!this.shedIds.delete(deviceId)) return;
    this.shedTimes.delete(deviceId);
    await this.pool.query("DELETE FROM ac_leveling_shed WHERE device_id = $1", [deviceId]);
    log.info(`[leveler] Cleared shed for AC ${deviceId} (${reason})`);
  }

  hasFanHold(deviceId: string): boolean {
    return this.fanHold.has(deviceId);
  }

  private async recordFanHold(deviceId: string, originalFan: number): Promise<void> {
    this.fanHold.set(deviceId, { originalFan, lastSetFan: originalFan });
    await this.pool.query(
      `INSERT INTO ac_leveling_fan_hold (device_id, original_fan, last_set_fan, held_at)
       VALUES ($1, $2, $2, NOW())
       ON CONFLICT (device_id) DO NOTHING`,
      [deviceId, originalFan],
    );
  }

  private async setFanHoldLastSet(deviceId: string, fan: number): Promise<void> {
    const hold = this.fanHold.get(deviceId);
    if (!hold) return;
    this.fanHold.set(deviceId, { ...hold, lastSetFan: fan });
    await this.pool.query(
      "UPDATE ac_leveling_fan_hold SET last_set_fan = $2 WHERE device_id = $1",
      [deviceId, fan],
    );
  }

  private async clearFanHold(deviceId: string, reason: string): Promise<void> {
    if (!this.fanHold.delete(deviceId)) return;
    await this.pool.query("DELETE FROM ac_leveling_fan_hold WHERE device_id = $1", [deviceId]);
    log.info(`[leveler] Released fan hold for AC ${deviceId} (${reason})`);
  }

  /** Observed ON out-of-band — clear shed after the shadow-lag grace period. */
  async reconcileObservedOn(deviceId: string): Promise<void> {
    if (!this.shedIds.has(deviceId)) return;
    const shedAt = this.shedTimes.get(deviceId);
    if (shedAt != null && Date.now() - shedAt < SHED_CLEAR_GRACE_MS) return;
    await this.clearShed(deviceId, "observed_on");
    this.forceEvaluate = true;
  }

  // ---------- Power readings (called per ESP ingest) ----------

  onPowerReading(data: { current_1: number; current_2: number }): void {
    this.lastReading = { current_1: data.current_1, current_2: data.current_2 };
    this.lastReadingAt = Date.now();
    const source = determineSource(this.lastReading, 0);
    if (source !== this.lastSource) {
      this.lastSource = source;
      this.overLimitStreak = 0;
      this.headroomStreak = 0;
      this.recentMeasured = [];
      this.forceEvaluate = true;
      log.info(`[leveler] Power source changed → ${source}`);
    }
    if (source === "none") return;

    const limit = source === "grid" ? this.config.gridLimitAmps : this.config.genLimitAmps;
    const measured = source === "grid" ? data.current_1 : data.current_2;
    this.recentMeasured.push(measured);
    if (this.recentMeasured.length > 8) this.recentMeasured.shift();

    if (measured > limit) {
      this.overLimitStreak++;
      this.headroomStreak = 0;
    } else if (measured <= limit - this.config.marginAmps) {
      this.headroomStreak++;
      this.overLimitStreak = 0;
    } else {
      // Inside the margin band — neither raise nor reduce.
      this.overLimitStreak = 0;
      this.headroomStreak = 0;
    }
  }

  /** Median of the last 4 readings — smooths generator fluctuation for budget math. */
  private smoothedMeasured(): number {
    const window = this.recentMeasured.slice(-4);
    if (window.length === 0) return 0;
    const sorted = [...window].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  private ampModel(deviceId: string): AcAmpModel {
    return this.config.ampModels[deviceId] ?? { baseAmps: 2, stepAmps: 1 };
  }

  // ---------- User intents (called from routes via collector handlers) ----------

  async onUserPowerOff(deviceId: string): Promise<void> {
    await this.ensureLoaded();
    // User confirmed OFF — the shed no longer drives this device (manual-off lock takes over).
    await this.clearShed(deviceId, "user_power_off");
    this.manualCap.delete(deviceId);
    this.manualTarget.delete(deviceId);
    this.lastSetLevel.delete(deviceId);
    await this.clearFanHold(deviceId, "user_power_off");
    this.fanExempt.delete(deviceId);
    this.forceEvaluate = true;
  }

  /** User changed the fan (UI or detected) — their fan is the new truth; never re-reduce this episode. */
  async onUserFanChange(deviceId: string): Promise<void> {
    await this.ensureLoaded();
    await this.clearFanHold(deviceId, "user_fan_change");
    this.fanExempt.add(deviceId);
  }

  async onUserPowerOn(deviceId: string): Promise<void> {
    await this.ensureLoaded();
    await this.clearShed(deviceId, "user_power_on");
    // Compressor ramp window — see the nonAcLoad derivation in tick()
    this.rampUntil.set(deviceId, Date.now() + AC_RAMP_MS);
    this.forceEvaluate = true;
  }

  /**
   * User changed the generator level (UI route or agent). Reduction → manual cap.
   * Increment within budget → manual target. Increment over budget → instant revert.
   */
  async onUserGenLevel(deviceId: string, level: number): Promise<{ reverted: boolean; level: number }> {
    await this.ensureLoaded();
    if (!this.config.enabled) return { reverted: false, level };
    const tcl = this.deps.getTclCloud();
    const device = tcl?.getDevices().find((d) => d.id === deviceId);
    if (!device || !this.lastStatus?.acs.find((a) => a.deviceId === deviceId)?.managed) {
      return { reverted: false, level };
    }
    const maxLevel = device.maxGeneratorLevel || 3;
    const previous = this.lastSetLevel.get(deviceId) ?? device.generatorMode;
    const rank = (l: number): number => (l <= 0 ? maxLevel + 1 : Math.min(l, maxLevel));

    if (rank(level) < rank(previous)) {
      // Manual reduction — user override; never raise above it again.
      this.manualCap.set(deviceId, Math.max(1, rank(level)));
      this.manualTarget.delete(deviceId);
      this.lastSetLevel.set(deviceId, level);
      this.forceEvaluate = true;
      log.info(`[leveler] Manual gen reduction on ${deviceId} → cap L${rank(level)}`);
      return { reverted: false, level };
    }

    // Manual increment — validate projection against the active source limit.
    const source = determineSource(this.lastReading, Date.now() - this.lastReadingAt);
    if (source !== "none" && tcl) {
      const limit = source === "grid" ? this.config.gridLimitAmps : this.config.genLimitAmps;
      let projected = this.lastNonAcLoad;
      for (const d of tcl.getDevices()) {
        if (!d.power && d.id !== deviceId) continue;
        const lvl = d.id === deviceId ? level : (this.lastSetLevel.get(d.id) ?? d.generatorMode);
        projected += estimateAcDraw(lvl, d.maxGeneratorLevel || 3, this.ampModel(d.id));
      }
      if (projected > limit - this.config.marginAmps) {
        const revertTo = Math.max(1, rank(previous) > maxLevel ? maxLevel : Math.max(1, previous));
        try {
          await tcl.sendControl(deviceId, "set_generator_mode", revertTo);
          this.lastSetLevel.set(deviceId, revertTo);
          log.warn(
            `[leveler] Manual gen increment on ${deviceId} to L${level} projects ${projected.toFixed(1)}A > ` +
            `${limit}A limit on ${source} — reverted to L${revertTo}`,
          );
          return { reverted: true, level: revertTo };
        } catch (err) {
          log.error(`[leveler] Revert of manual gen increment failed for ${deviceId}:`, (err as Error).message);
          return { reverted: false, level };
        }
      }
    }

    this.manualTarget.set(deviceId, rank(level));
    this.manualCap.delete(deviceId);
    this.lastSetLevel.set(deviceId, level);
    log.info(`[leveler] Manual gen target on ${deviceId} → L${rank(level)}`);
    return { reverted: false, level };
  }

  // ---------- Main tick (called from the collector loop) ----------

  /**
   * Conditional minimum level (e.g. Abdullah L2 when outdoor ≥ 37°C) with 1°C
   * hysteresis so it doesn't flap at the boundary; holds state when outdoor
   * temp is unknown.
   */
  private minLevelFor(deviceId: string, maxLevel: number, outdoorTempC: number | null): number {
    const boost = this.config.levelBoosts[deviceId];
    if (!boost || boost.minLevel <= 1) return 1;
    let active = this.boostActive.get(deviceId) ?? false;
    if (outdoorTempC != null) {
      if (outdoorTempC >= boost.outdoorAtLeastC) active = true;
      else if (outdoorTempC < boost.outdoorAtLeastC - 1) active = false;
    }
    if (active !== (this.boostActive.get(deviceId) ?? false)) {
      log.info(`[leveler] ${this.deviceNames.get(deviceId) ?? deviceId}: outdoor ${outdoorTempC}°C → min level boost ${active ? "ON" : "OFF"} (min L${boost.minLevel})`);
    }
    this.boostActive.set(deviceId, active);
    return active ? Math.min(boost.minLevel, maxLevel) : 1;
  }

  async tick(ctx: LevelerDeviceContext[], outdoorTempC: number | null): Promise<void> {
    await this.ensureLoaded();
    if (!this.config.enabled) {
      this.lastStatus = null;
      return;
    }
    const tcl = this.deps.getTclCloud();
    if (!tcl || !tcl.isReady()) return;

    for (const { device } of ctx) {
      this.deviceNames.set(device.id, device.name);
    }

    // Structural change detection: AC power flips since the last tick.
    for (const { device } of ctx) {
      const prev = this.prevPowerStates.get(device.id);
      if (prev != null && prev !== device.power) {
        this.forceEvaluate = true;
        if (device.power) {
          // Fresh turn-on: compressor hasn't ramped — keep its estimated draw
          // out of the non-AC load math so a near-limit turn-on reduces instantly.
          this.rampUntil.set(device.id, Date.now() + AC_RAMP_MS);
        }
        log.info(`[leveler] ${device.name}: power ${prev ? "ON" : "OFF"} → ${device.power ? "ON" : "OFF"} (re-evaluating)`);
      }
      this.prevPowerStates.set(device.id, device.power);
      if (device.power && this.shedIds.has(device.id)) {
        await this.reconcileObservedOn(device.id);
      }
      if (!device.power) {
        // Power-off clears manual gen intents, drift tracking, and fan holds.
        this.manualCap.delete(device.id);
        this.manualTarget.delete(device.id);
        this.lastSetLevel.delete(device.id);
        this.rampUntil.delete(device.id);
        await this.clearFanHold(device.id, "power_off");
        this.fanExempt.delete(device.id);
      }
    }

    const inSettle = Date.now() < this.settleUntil;

    // Fan-drift detection: a fan we did not set while holding means a remote/
    // manual change — the user's fan wins; never re-reduce this episode.
    for (const { device } of ctx) {
      const hold = this.fanHold.get(device.id);
      if (!hold || !device.power || inSettle || typeof device.fanSpeed !== "number") continue;
      if (device.fanSpeed !== hold.lastSetFan) {
        log.info(`[leveler] ${device.name}: external fan change observed (fan=${device.fanSpeed}) — releasing hold`);
        await this.clearFanHold(device.id, "external_fan_change");
        this.fanExempt.add(device.id);
      }
    }

    // Sustained headroom ends the over-limit episode — user fan exemptions reset.
    if (this.headroomStreak >= RAISE_STREAK && this.fanExempt.size > 0) {
      this.fanExempt.clear();
    }

    // Shadow-drift detection: a gen level we did not set means a manual/remote change.
    for (const { device, managed } of ctx) {
      if (!device.power || !managed) continue;
      const expected = this.lastSetLevel.get(device.id);
      if (expected == null) {
        this.lastSetLevel.set(device.id, device.generatorMode);
        continue;
      }
      if (device.generatorMode === expected || inSettle) continue;
      const maxLevel = device.maxGeneratorLevel || 3;
      const rank = (l: number): number => (l <= 0 ? maxLevel + 1 : Math.min(l, maxLevel));
      if (rank(device.generatorMode) < rank(expected)) {
        this.manualCap.set(device.id, rank(device.generatorMode));
        this.manualTarget.delete(device.id);
        log.info(`[leveler] ${device.name}: external gen reduction observed → cap L${rank(device.generatorMode)}`);
      } else {
        this.manualTarget.set(device.id, rank(device.generatorMode));
        this.manualCap.delete(device.id);
        log.info(`[leveler] ${device.name}: external gen increment observed → target L${rank(device.generatorMode)}`);
      }
      this.lastSetLevel.set(device.id, device.generatorMode);
      this.forceEvaluate = true;
    }

    const source = determineSource(this.lastReading, Date.now() - this.lastReadingAt);
    if (source === "none") {
      // No electricity / no ESP signal — pause decisions, reset gating.
      this.overLimitStreak = 0;
      this.headroomStreak = 0;
      this.lastStatus = this.buildStatus(ctx, source, null, null, null);
      return;
    }
    const limit = source === "grid" ? this.config.gridLimitAmps : this.config.genLimitAmps;

    // Snapshots sorted by configured priority (unknown devices go last).
    const order = new Map(this.config.priority.map((id, i) => [id, i]));
    const sorted = [...ctx].sort(
      (a, b) => (order.get(a.device.id) ?? 999) - (order.get(b.device.id) ?? 999),
    );
    const snapshots: LevelerAcSnapshot[] = sorted.map(({ device, managed, needTier, needDelta }) => {
      const maxLevel = device.maxGeneratorLevel || 3;
      return {
        deviceId: device.id,
        on: device.power,
        managed,
        shed: this.shedIds.has(device.id),
        maxLevel,
        currentLevel: inSettle ? (this.lastSetLevel.get(device.id) ?? device.generatorMode) : device.generatorMode,
        minLevel: this.minLevelFor(device.id, maxLevel, outdoorTempC),
        needTier,
        needDelta,
        manualCap: this.manualCap.get(device.id) ?? null,
        manualTarget: this.manualTarget.get(device.id) ?? null,
        fanSpeed: (inSettle
          ? this.fanHold.get(device.id)?.lastSetFan ?? device.fanSpeed
          : device.fanSpeed) ?? null,
        fanRestoreTarget: this.fanHold.get(device.id)?.originalFan ?? null,
        fanExempt: this.fanExempt.has(device.id),
      };
    });

    // A managed AC stuck below its boost floor "can't work" — allow same-tick
    // reductions elsewhere to make room for the correction.
    for (const s of snapshots) {
      if (s.on && s.managed && s.currentLevel >= 1 && s.currentLevel < s.minLevel && s.manualCap == null) {
        this.forceEvaluate = true;
      }
    }

    const measured = this.smoothedMeasured();
    const ampModels = Object.fromEntries(snapshots.map((s) => [s.deviceId, this.ampModel(s.deviceId)]));
    // Non-AC load = measured minus the draw of ESTABLISHED ACs only. A freshly
    // turned-on AC isn't pulling its estimated amps yet (measured is still
    // pre-turn-on), so subtracting it would understate the household load and
    // hide an imminent overload when running close to the limit.
    const now = Date.now();
    const establishedDraw = snapshots
      .filter((s) => s.on && (this.rampUntil.get(s.deviceId) ?? 0) <= now)
      .reduce((sum, s) => sum + estimateAcDraw(s.currentLevel, s.maxLevel, this.ampModel(s.deviceId)), 0);
    const nonAcLoad = Math.max(0, measured - establishedDraw);
    this.lastNonAcLoad = nonAcLoad;

    const input: AllocatorInput = {
      limitAmps: limit,
      marginAmps: this.config.marginAmps,
      nonAcLoadAmps: nonAcLoad,
      overLimitStreak: this.overLimitStreak,
      headroomStreak: this.headroomStreak,
      inSettle,
      forceEvaluate: this.forceEvaluate,
      acs: snapshots,
      ampModels,
    };
    const result = computeAllocation(input);
    this.forceEvaluate = false;
    this.lastStatus = this.buildStatus(ctx, source, measured, limit, result);

    await this.execute(tcl, snapshots, result, source, limit);
  }

  private async execute(
    tcl: TclCloud,
    snapshots: LevelerAcSnapshot[],
    result: AllocationResult,
    source: PowerSource,
    limit: number,
  ): Promise<void> {
    let sentAny = false;
    let didReduce = false;
    const name = (id: string): string => this.deviceNames.get(id) ?? id;

    for (const [deviceId, level] of Object.entries(result.desiredLevels)) {
      const snap = snapshots.find((s) => s.deviceId === deviceId);
      try {
        await tcl.sendControl(deviceId, "set_generator_mode", level);
        this.lastSetLevel.set(deviceId, level);
        sentAny = true;
        if (snap && (snap.currentLevel === 0 || level < snap.currentLevel)) didReduce = true;
        log.info(
          `[leveler] ${name(deviceId)}: gen level ${snap?.currentLevel ?? "?"} → L${level} ` +
          `(${source} budget ${result.budgetAmps.toFixed(1)}A)`,
        );
      } catch (err) {
        log.error(`[leveler] Failed to set gen level for ${name(deviceId)}:`, (err as Error).message);
      }
    }

    // Last try before shedding: drop every reducible fan to minimum in one
    // batch. didReduce resets the streaks, so the shed only fires if a fresh
    // 4-reading over-limit window builds with fans already at minimum.
    if (result.toFanReduce.length > 0) {
      let fanReduced = false;
      for (const deviceId of result.toFanReduce) {
        const snap = snapshots.find((s) => s.deviceId === deviceId);
        if (snap?.fanSpeed == null) continue;
        try {
          if (!this.fanHold.has(deviceId)) {
            await this.recordFanHold(deviceId, snap.fanSpeed);
          }
          await tcl.sendControl(deviceId, "set_fan_speed", 1);
          await this.setFanHoldLastSet(deviceId, 1);
          this.deps.onLevelerFanCommand(deviceId, 1);
          sentAny = true;
          didReduce = true;
          fanReduced = true;
          log.info(`[leveler] ${name(deviceId)}: fan ${snap.fanSpeed === 0 ? "auto" : snap.fanSpeed} → 1 (last try before shed)`);
        } catch (err) {
          log.error(`[leveler] Fan reduce failed for ${name(deviceId)}:`, (err as Error).message);
        }
      }
      if (fanReduced) {
        void this.deps.broadcast({
          title: "Smart AC Leveling",
          body: `Fan speeds reduced to minimum to stay under the ${limit}A ${source === "grid" ? "Grid" : "Generator"} limit — they'll be restored when there is room.`,
          type: "leveling",
        });
      }
    }

    for (const deviceId of result.toShed) {
      try {
        await tcl.executeAcAction(deviceId, { power: 0 });
        await this.recordShed(deviceId, `over ${limit}A on ${source}`);
        await this.clearFanHold(deviceId, "shed");
        this.fanExempt.delete(deviceId);
        sentAny = true;
        didReduce = true;
        // Fire-and-forget — push HTTP calls must not block the collector loop
        void this.deps.broadcast({
          title: "Smart AC Leveling",
          body: `${name(deviceId)} turned off — total current over the ${limit}A ${source === "grid" ? "Grid" : "Generator"} limit. It will be restored when there is room.`,
          type: "leveling",
        });
      } catch (err) {
        log.error(`[leveler] Shed failed for ${name(deviceId)}:`, (err as Error).message);
      }
    }

    for (const deviceId of result.toRestore) {
      try {
        if (await this.deps.isManualOffLocked(deviceId)) {
          // The user turned it off while shed — their intent wins over the restore
          await this.clearShed(deviceId, "manual_off_lock");
          continue;
        }
        // Restore at the floor level (boost minimum when active, else L1)
        const snap = snapshots.find((s) => s.deviceId === deviceId);
        const restoreLevel = Math.max(1, Math.min(snap?.minLevel ?? 1, snap?.maxLevel ?? 1));
        await tcl.executeAcAction(deviceId, { power: 1, generator_mode: restoreLevel });
        await this.clearShed(deviceId, "restored");
        this.lastSetLevel.set(deviceId, restoreLevel);
        this.prevPowerStates.set(deviceId, true);
        this.rampUntil.set(deviceId, Date.now() + AC_RAMP_MS);
        this.deps.setDevicePowerCache(deviceId, "on");
        sentAny = true;
        void this.deps.broadcast({
          title: "Smart AC Leveling",
          body: `${name(deviceId)} restored at L${restoreLevel} — current headroom is available again.`,
          type: "leveling",
        });
      } catch (err) {
        log.error(`[leveler] Restore failed for ${name(deviceId)}:`, (err as Error).message);
      }
    }

    if (result.toFanRaise) {
      const { deviceId, fan } = result.toFanRaise;
      const hold = this.fanHold.get(deviceId);
      if (hold) {
        try {
          await tcl.sendControl(deviceId, "set_fan_speed", fan);
          this.deps.onLevelerFanCommand(deviceId, fan);
          if (fan === hold.originalFan) {
            await this.clearFanHold(deviceId, "restored");
          } else {
            await this.setFanHoldLastSet(deviceId, fan);
          }
          // Raises must not reset streaks — the settle window paces the steps.
          sentAny = true;
          log.info(`[leveler] ${name(deviceId)}: fan restore step → ${fan === 0 ? "auto" : fan}` +
            (this.fanHold.has(deviceId) ? ` (target ${hold.originalFan === 0 ? "auto" : hold.originalFan})` : " (hold released)"));
        } catch (err) {
          log.error(`[leveler] Fan raise failed for ${name(deviceId)}:`, (err as Error).message);
        }
      }
    }

    if (sentAny) this.settleUntil = Date.now() + SETTLE_MS;
    if (didReduce) {
      // Fresh readings required before the next decision in either direction.
      this.overLimitStreak = 0;
      this.headroomStreak = 0;
    }
  }

  // ---------- Status (for GET /api/ac/leveling) ----------

  private buildStatus(
    ctx: LevelerDeviceContext[],
    source: PowerSource,
    measured: number | null,
    limit: number | null,
    result: AllocationResult | null,
  ): AcLevelingStatus {
    return {
      enabled: this.config.enabled,
      source,
      measuredAmps: measured,
      limitAmps: limit,
      budgetAmps: result?.budgetAmps ?? null,
      nonAcLoadAmps: result?.nonAcLoadAmps ?? null,
      overLimitStreak: this.overLimitStreak,
      headroomStreak: this.headroomStreak,
      settleRemainingMs: Math.max(0, this.settleUntil - Date.now()),
      acs: ctx.map(({ device, managed, needTier, needDelta }) => {
        const maxLevel = device.maxGeneratorLevel || 3;
        const boost = this.config.levelBoosts[device.id];
        const minLevel = boost && (this.boostActive.get(device.id) ?? false)
          ? Math.min(boost.minLevel, maxLevel)
          : 1;
        return {
          deviceId: device.id,
          name: device.name,
          on: device.power,
          managed,
          shed: this.shedIds.has(device.id),
          level: device.generatorMode,
          maxLevel,
          minLevel,
          estAmps: device.power
            ? estimateAcDraw(device.generatorMode, maxLevel, this.ampModel(device.id))
            : 0,
          needTier,
          needCap: needCap(needTier, maxLevel),
          needDelta,
          manualCap: this.manualCap.get(device.id) ?? null,
          manualTarget: this.manualTarget.get(device.id) ?? null,
          idealLevel: result?.idealLevels[device.id] ?? null,
          heldFan: this.fanHold.get(device.id)?.lastSetFan ?? null,
          fanOriginal: this.fanHold.get(device.id)?.originalFan ?? null,
        };
      }),
    };
  }

  getStatus(): AcLevelingStatus {
    if (this.lastStatus) return this.lastStatus;
    const staleMs = this.lastReadingAt > 0 ? Date.now() - this.lastReadingAt : STALE_POWER_MS + 1;
    return {
      enabled: this.loaded && this.config.enabled,
      source: determineSource(this.lastReading, staleMs),
      measuredAmps: null,
      limitAmps: null,
      budgetAmps: null,
      nonAcLoadAmps: null,
      overLimitStreak: this.overLimitStreak,
      headroomStreak: this.headroomStreak,
      settleRemainingMs: Math.max(0, this.settleUntil - Date.now()),
      acs: [],
    };
  }
}
