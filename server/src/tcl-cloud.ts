import { createHash, createHmac } from "crypto";
import { readFile, rename, writeFile } from "fs/promises";
import { IoTDataPlaneClient, PublishCommand } from "@aws-sdk/client-iot-data-plane";
import { childLogger } from "./logger.js";
import {
  buildAdvancedControlPayload,
  deriveAcCapabilities,
  getAcDevicePolicy,
  isAcLevelingEligible,
  isPowerCycleRestoreEligible,
  supportsAcCommand,
  validateAcControl,
  type AcCapabilities,
  type AcControlValidation,
  type AcModel as CapabilityAcModel,
} from "./ac-capabilities.js";

const log = childLogger("tcl");

/**
 * An AC counts as online only if its TCL/AWS-IoT shadow was reported within
 * this window. The persisted shadow never disappears when the AC loses power,
 * so without a freshness check a blacked-out AC reads "online" forever. Kept
 * generous because a quietly-running AC reports infrequently — better a late
 * offline than a flapping one. This only drives the UI indicator; nothing
 * server-side (leveler, automations, commands) gates on isOnline.
 */
export const SHADOW_STALE_MS = 10 * 60_000;

/** UI command verify-resend: re-check the shadow this often… */
export const CONTROL_VERIFY_DELAY_MS = 5_000;
/** …and re-send an unapplied command at most this many times (user decision 2026-06-11). */
export const CONTROL_VERIFY_MAX_RESENDS = 3;

/**
 * The TAC-12CHSD fan block. Fan speed on this model is not a single field:
 * 1 is `silenceSwitch`, 7 is `turbo`, 2–6 are `windSpeed` — so "the fan" is
 * always these three together, and they must reach the device ALONE (see the
 * split in executeAcAction).
 */
export const TCL_12CHSD_FAN_KEYS = ["windSpeed", "silenceSwitch", "turbo"];
/** Settle gap between the main and fan halves of a split profile. */
export const PROFILE_SPLIT_DELAY_MS = 500;

/** Newest per-field reported timestamp from an AWS IoT shadow `metadata.reported`, in ms (null if none). */
export function latestReportedAtMs(
  metadataReported: Record<string, { timestamp?: number }> | undefined,
): number | null {
  if (!metadataReported) return null;
  let maxSec = 0;
  for (const meta of Object.values(metadataReported)) {
    if (typeof meta?.timestamp === "number" && meta.timestamp > maxSec) maxSec = meta.timestamp;
  }
  return maxSec > 0 ? maxSec * 1000 : null; // AWS IoT timestamps are epoch seconds
}

/**
 * Fields whose metadata timestamp sits within this many SECONDS of the
 * `powerSwitch` timestamp count as one device report (the "cohort"). The TCL
 * firmware spreads a full-state dump over 1-2 s (probe 2026-09-27: Najat
 * 15:21:59-15:22:00, guest 13:44:23-13:44:25).
 */
export const POWER_REPORT_COHORT_WINDOW_S = 2;

/**
 * A power report whose cohort is at most this many fields is an ISOLATED
 * change: a button press, a remote, the TCL app. A power ON, and every
 * reconnect or power-loss restart, makes the unit dump its whole state
 * instead. Probe 2026-09-27 (raw shadows of all four units): an isolated
 * power OFF stamped 1 field (Najat shed, 15:26:11Z); the largest incremental
 * cluster seen anywhere was 3 fields; every full-state report stamped 45-55
 * fields (Najat 54 and 53, Abdullah 46 after a changeover restart, guest 50).
 * 10 sits far from both populations, so a remote off that also moves a few
 * fan/compressor fields in the same second still reads isolated, while a
 * reconnect dump can never pass.
 */
export const ISOLATED_POWER_REPORT_MAX_COHORT = 10;

/**
 * A cluster of at least this many fields stamped within
 * +-POWER_REPORT_COHORT_WINDOW_S of each other is a FULL-STATE report: the dump
 * a unit sends when it powers ON (or reconnects / restarts). Probe 2026-09-27:
 * every full-state report stamped 45-55 fields (Najat 54 and 53, Abdullah 46,
 * Abdu 46, guest 50) and no incremental cluster exceeded 3. 20 is under half
 * the smallest dump, which leaves room for fields that re-stamp while the unit
 * runs (temperatures, compressor figures: Najat's 15:21:59 dump still held all
 * 55 of its fields six minutes later) and stays far above any incremental burst.
 */
export const FULL_STATE_MIN_FIELDS = 20;

/** Newest epoch-seconds timestamp inside one field's metadata (arrays and
 * nested objects carry per-element stamps), or null. */
function metadataTimestampSec(meta: unknown, depth = 0): number | null {
  if (meta == null || typeof meta !== "object" || depth > 4) return null;
  const own = (meta as { timestamp?: unknown }).timestamp;
  if (typeof own === "number" && Number.isFinite(own)) return own;
  let newest: number | null = null;
  for (const child of Array.isArray(meta) ? meta : Object.values(meta)) {
    const t = metadataTimestampSec(child, depth + 1);
    if (t != null && (newest == null || t > newest)) newest = t;
  }
  return newest;
}

export interface PowerReportInfo {
  /** Epoch ms of the second `powerSwitch` was last reported in (null if unknown). */
  powerReportedAt: number | null;
  /** How many reported fields share that report (+-POWER_REPORT_COHORT_WINDOW_S), itself included. */
  powerReportCohort: number | null;
  /**
   * Epoch ms of the EARLIEST second of the newest full-state report (a cluster
   * of >= FULL_STATE_MIN_FIELDS fields other than `powerSwitch`), or null.
   */
  fullStateReportAt: number | null;
}

/** The newest full-state cluster among the non-power fields: its earliest second, or null. */
function newestFullStateSec(stampsSec: readonly number[]): number | null {
  const candidates = [...new Set(stampsSec)].sort((a, b) => b - a);
  for (const t of candidates) {
    const members = stampsSec.filter((s) => Math.abs(s - t) <= POWER_REPORT_COHORT_WINDOW_S);
    if (members.length >= FULL_STATE_MIN_FIELDS) return Math.min(...members);
  }
  return null;
}

/** When `powerSwitch` was last reported, whether it came alone or inside a full-state dump, and when the newest dump was. */
export function powerReportInfo(metadataReported: Record<string, unknown> | undefined): PowerReportInfo {
  const unknown: PowerReportInfo = { powerReportedAt: null, powerReportCohort: null, fullStateReportAt: null };
  const powerSec = metadataReported ? metadataTimestampSec(metadataReported.powerSwitch) : null;
  if (powerSec == null || powerSec <= 0) return unknown;
  let cohort = 0;
  const otherStamps: number[] = [];
  for (const [field, meta] of Object.entries(metadataReported ?? {})) {
    const t = metadataTimestampSec(meta);
    if (t == null) continue;
    if (Math.abs(t - powerSec) <= POWER_REPORT_COHORT_WINDOW_S) cohort++;
    if (field !== "powerSwitch") otherStamps.push(t);
  }
  const fullSec = newestFullStateSec(otherStamps);
  return {
    powerReportedAt: powerSec * 1000,
    powerReportCohort: cohort,
    fullStateReportAt: fullSec != null ? fullSec * 1000 : null,
  };
}

/**
 * Did the unit ITSELF go off AFTER our power ON landed? `sinceMs` is when our
 * power ON was published. AWS stamps a field when the update REACHES AWS, so an
 * isolated OFF stamp after our send alone does not prove order (a late-delivered
 * off can carry a stamp after a send it physically preceded). What does prove
 * it: a unit's own reports travel in order over its single MQTT connection, so
 * the full-state dump its ON produced, followed by a LONE powerSwitch report, is
 * "our ON landed, then someone switched it off". So all of:
 *  - power is false;
 *  - the newest full-state report (>= FULL_STATE_MIN_FIELDS fields) started in
 *    the send's second or later: our ON's dump, not an older one;
 *  - the powerSwitch report came after that dump started;
 *  - and it came ALONE (cohort <= ISOLATED_POWER_REPORT_MAX_COHORT), so it is
 *    not itself part of a dump (a reconnect).
 * Anything else is ambiguous and answers false, which keeps today's lag
 * reading: no metadata, no post-send dump (the unit never applied our ON:
 * Najat drops commands), a dump after the off, or an off inside a dump.
 */
export function isolatedPowerOffAfter(
  dev: Pick<AcDevice, "power" | "powerReportedAt" | "powerReportCohort" | "fullStateReportAt">,
  sinceMs: number,
): boolean {
  if (dev.power || !(sinceMs > 0)) return false;
  const reportedAt = dev.powerReportedAt ?? null;
  const cohort = dev.powerReportCohort ?? null;
  const dumpAt = dev.fullStateReportAt ?? null;
  if (reportedAt == null || cohort == null || dumpAt == null) return false;
  if (dumpAt < Math.floor(sinceMs / 1000) * 1000) return false;
  if (reportedAt <= dumpAt) return false;
  return cohort <= ISOLATED_POWER_REPORT_MAX_COHORT;
}

/**
 * Online decision: trust TCL's flag when it says online (it only ever gives
 * false negatives), otherwise require a FRESH shadow. A shadow with no
 * freshness metadata falls back to the legacy "has shadow = online" behavior.
 */
export function deviceOnline(
  tclOnline: boolean,
  hasShadow: boolean,
  reportedAtMs: number | null,
  nowMs: number,
  staleMs: number,
): boolean {
  if (tclOnline) return true;
  if (!hasShadow) return false;
  if (reportedAtMs == null) return true;
  return nowMs - reportedAtMs <= staleMs;
}

export interface AcAction {
  power?: 0 | 1;
  mode?: number;
  temperature?: number;
  fan_speed?: number;
  eco?: number;
  turbo?: number;
  screen?: number;
  vertical_swing?: number;
  horizontal_swing?: number;
  fresh_air?: number;
  generator_mode?: number;
}

export type AcVerifiedProfileResult = "applied" | "superseded";

/**
 * `sendControlVerified`: "sent" when the cloud accepted the publish AND no newer
 * command of the same field had claimed it by the time the call returns.
 * Otherwise "superseded" (the newer command was a raw OFF: leveler, automation,
 * timer) or "superseded_by_user" (a newer dashboard tap), whether the loss
 * happened before this command's publish (nothing sent) or after it (sent, then
 * overridden while its saved-state restore ran). Either way the caller must run
 * none of its post-send bookkeeping: the newer command's state is the truth
 * (2026-09-27, rounds 4 and 5).
 */
export type VerifiedControlOutcome = "sent" | "superseded" | "superseded_by_user";

/** Thrown by the publish-boundary guard; `sendControlVerified` turns it into "superseded". */
export class ControlSupersededError extends Error {
  constructor(readonly deviceId: string) {
    super(`control for ${deviceId} superseded by a newer command before it was published`);
    this.name = "ControlSupersededError";
  }
}

/**
 * `executeAcAction` with power 1: the powerSwitch publish was ACCEPTED, then
 * the profile publish failed. The unit is (or is about to be) ON, so a caller
 * that books ONs must treat it as sent, not refused (2026-09-27: a leveler
 * restore whose profile failed was booked as failed, never tracked, and the
 * shed stayed eligible for another restore that could reverse a human's OFF).
 * Callers that only care about success keep treating it as an error.
 */
export class AcProfileNotAppliedError extends Error {
  readonly powerAccepted = true;
  constructor(readonly deviceId: string, cause: unknown) {
    super(`power ON accepted for ${deviceId} but the profile publish failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "AcProfileNotAppliedError";
  }
}

export function isPowerAcceptedError(err: unknown): err is AcProfileNotAppliedError {
  return err instanceof AcProfileNotAppliedError;
}
export type AcActionExecutionResult = "applied" | "suppressed";

export interface AcActionExecutionOptions {
  /** Internal: keep the generation owned by executeAcActionVerified. */
  preserveProfileIntent?: boolean;
  /** Only stale automation enforcement may opt into this suppression. */
  suppressWhileManualPresetPending?: boolean;
  /**
   * Caller's publish-boundary guard (see sendControl), honoured by a power OFF
   * (the armed off-when-online send): read before the call claims anything and
   * again right before the publish. False → `ControlSupersededError`, nothing
   * claimed or sent, so a stale caller never silences a newer user command.
   */
  stillCurrent?: () => boolean;
  /**
   * Called synchronously at a power OFF's publish boundary: right after
   * `stillCurrent` passed, in the same tick as the publish start (each publish,
   * a re-auth retry included). The armed off-when-online send books its OFF here.
   */
  onPublish?: () => void;
}

/**
 * AC hardware model family — drives protocol differences (fan encoding,
 * swing property names, eco/turbo support, save-props list, temp step).
 * Detected from the shadow: presence of `autoGeneratorMode` → TAC-24CHSA;
 * absence → TAC-12CHSD. Never infer the model from
 * maxGeneratorLevel — TCL changes level counts via firmware updates.
 */
export type AcModel = CapabilityAcModel;

export interface AcDevice {
  id: string;
  name: string;
  displayName: string;
  displayOrder: number;
  model: AcModel;
  levelingEligible: boolean;
  capabilities: AcCapabilities;
  isOnline: boolean;
  /** Epoch ms of the device's last shadow report (null if unknown) — drives "last seen" + the offline check. */
  lastSeenAt: number | null;
  /**
   * Epoch ms of the second the shadow's `powerSwitch` was last reported in, and
   * how many reported fields share that report (see `powerReportInfo`). Lets an
   * observed OFF after our ON be told apart: a lone report after the send is a
   * human, a stale report or a full-state dump is not (`isolatedPowerOffAfter`).
   * Optional: null/absent when the shadow carried no metadata.
   */
  powerReportedAt?: number | null;
  powerReportCohort?: number | null;
  /** Earliest second (ms) of the newest full-state report: the dump a power ON makes. */
  fullStateReportAt?: number | null;
  power: boolean;
  mode: number;
  targetTemp: number;
  currentTemp: number;
  /** False when the shadow carried no targetTemperature / currentTemperature and the value above is a default. */
  targetTempKnown?: boolean;
  currentTempKnown?: boolean;
  fanSpeed: number;
  eco: boolean;
  sleep: number;
  screen: boolean;
  verticalSwing: number;
  horizontalSwing: number;
  turbo: boolean;
  freshAir: boolean;
  hasFreshAir: boolean;
  generatorMode: number;
  maxGeneratorLevel: number;
  tempStep: number;
  minFanSpeed: number;
  maxFanSpeed: number;
  beep: boolean;
  /** Armed "turn off once back online" signal (owner request 2026-10-09, grid-only Guest). */
  offWhenOnline?: boolean;
}

interface AuthData {
  token: string;
  refreshToken: string;
  username: string;
  countryAbbr: string;
}

interface TokenData {
  saasToken: string;
  cognitoToken: string;
  cognitoId: string;
  mqttEndpoint: string;
}

interface AwsCredentials {
  accessKeyId: string;
  secretKey: string;
  sessionToken: string;
  expiration: number;
  region: string;
}

interface PersistedState {
  authData?: AuthData;
  tokenData?: TokenData;
  awsCreds?: AwsCredentials;
  tokenExpiry?: number;
  baseApiUrl?: string;
}

/**
 * One armed "turn off once back online" (see `setOffWhenOnline`). TclCloud owns
 * the arm store, the per-device operation claim and the OFF send; the
 * collector's off-when-online step drives them. The entry's identity IS the
 * arm: a cancel, a disarm or a re-arm removes or replaces it, so an operation
 * holding an older entry knows it went stale (`isOffWhenOnlineCurrent`).
 */
export interface OffWhenOnlineArm {
  readonly deviceId: string;
  readonly armedAt: number;
  /**
   * The last real source transition since the arm (a power epoch, see
   * `noteOffWhenOnlinePowerEpoch`), 0 when none. Only a report newer than both
   * this and `armedAt` proves the unit is back. Persisted.
   */
  epochAt: number;
  /** Completed OFF sends in this epoch, and when the last one COMPLETED (the resend spacing counts from it). */
  attempts: number;
  lastSentAt: number;
}

/** The persisted subset: attempt counts and times restart from zero after a restart. */
type PersistedOffWhenOnline = Pick<OffWhenOnlineArm, "armedAt" | "epochAt">;

/** One queued write of the arm file (`saveOffWhenOnline`). */
interface OffWhenOnlineWrite {
  /** The device ids it writes: null until it runs, since it snapshots the arms then. */
  ids: ReadonlySet<string> | null;
  /** Set once it completed or failed. */
  settled: boolean;
  /** Settles with the write; rejects when it failed. */
  done: Promise<void>;
}

/**
 * `persisted` may be an older file's entry: `{armedAt, attempts, lastSentAt}`
 * (first release) or one from the manual-off lock rounds (`lockRecorded`,
 * `offConfirmedAt`, `lockFailedAt`; the lock was dropped 2026-10-10). The extra
 * fields are ignored and a missing `epochAt` reads as none.
 */
function newOffWhenOnline(
  deviceId: string,
  armedAt: number,
  persisted: Partial<Record<keyof PersistedOffWhenOnline, unknown>> = {},
): OffWhenOnlineArm {
  return {
    deviceId,
    armedAt,
    epochAt: typeof persisted.epochAt === "number" ? persisted.epochAt : 0,
    attempts: 0,
    lastSentAt: 0,
  };
}

/** OFF sends per arm and power epoch, each 15 s apart; then the arm gives up. */
export const OFF_WHEN_ONLINE_MAX_ATTEMPTS = 4;
export const OFF_WHEN_ONLINE_RESEND_MS = 15_000;
/**
 * How long one step operation holds its device's claim (`claimOffWhenOnline`)
 * before a newer step may take it over. Correctness does not hang on it: the
 * claim token is checked at the OFF's publish boundary and before any change
 * to the arm, so an operation that lost its claim can neither publish nor
 * touch the arm. It only bounds how long a hung or abandoned operation blocks
 * the next one. Two minutes outlasts one send short of a full TCL re-login
 * (every TCL/AWS call has a 15 s deadline) and runStep's 90 s step deadline,
 * so a step that finishes inside its deadline is never overtaken.
 */
export const OFF_WHEN_ONLINE_LEASE_MS = 2 * 60_000;
/**
 * How many arm-file writes one cancel acknowledgement waits through
 * (`offWhenOnlineDurablyAbsent`) before it gives up and rejects. It waits
 * again only when the device is still neither armed nor out of the file after
 * a write settled: re-armed and removed again meanwhile, or a failed write with
 * a newer one queued. Reached only by a device that keeps changing without
 * end, so the acknowledgement can never wait forever.
 */
export const OFF_WHEN_ONLINE_DURABLE_MAX_WRITES = 32;

interface PendingPowerCycleRestore {
  state: Record<string, unknown>;
  armedAt: number;
  attempts: number;
  lastSentAt: number;
}

/**
 * Backward-compatible/default maximum for the three ESP-managed ACs. Per-unit
 * policy is authoritative: Guest is a separate-line TAC-24CHSA unit with six
 * verified levels, while Mom/Abdu/Abdullah stop at three.
 */
export const MAX_GENERATOR_LEVEL = 3;

const CREDENTIALS_FILE = "/app/data/tcl-credentials.json";
const TCL_CLIENT_ID = "54148614";
const TCL_APP_ID = "wx6e1af3fa84fbe523";
const LOGIN_URL = `https://pa.account.tcl.com/account/login?clientId=${TCL_CLIENT_ID}`;
const DEFAULT_BASE_API = "https://prod-eu.aws.tcljd.com";

function md5hex(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

/** Extract AWS region from mqttEndpoint like "data.iot.eu-central-1.amazonaws.com" */
function extractRegion(endpoint: string): string {
  const parts = endpoint.split(".");
  if (parts.length >= 3 && parts[1] === "iot") return parts[2];
  return "eu-central-1";
}

export class TclCloud {
  private username: string;
  private passwordMd5: string;
  private authData: AuthData | null = null;
  private tokenData: TokenData | null = null;
  private awsCreds: AwsCredentials | null = null;
  private tokenExpiry = 0;
  private baseApiUrl = DEFAULT_BASE_API;
  private cachedDevices: AcDevice[] = [];
  private deviceCacheTime = 0;
  private lastState: Record<string, Record<string, unknown>> = {};
  private pendingPowerCycleRestores = new Map<string, PendingPowerCycleRestore>();
  /** deviceId -> arm state of the "turn off once back online" signal. Persisted. */
  private pendingOffWhenOnline = new Map<string, OffWhenOnlineArm>();
  /** deviceId -> the step operation holding it: its token and when its lease ends. */
  private offWhenOnlineClaims = new Map<string, { token: number; expiresAt: number }>();
  private offWhenOnlineClaimSeq = 0;
  /**
   * deviceId -> power report time of the OFF a device fetch ended its arm on
   * (`observeOffWhenOnline`), until the collector's step takes it
   * (`takeOffWhenOnlineSeenOffs`) to pin its own OFF's booking. Memory only.
   */
  private offWhenOnlineSeenOffs = new Map<string, number>();
  /**
   * Devices armed or disarmed since construction. The startup file read can land
   * after such a change and must never override it (resurrect a cancelled arm,
   * or replace a newer arm time).
   */
  private offWhenOnlineTouched = new Set<string>();
  /** The startup read of the arm file; never rejects. init() waits for it. */
  private offWhenOnlineLoaded: Promise<void>;
  /** Tail of the serialized arm-file writes; starts after the startup read, never rejects. */
  private offWhenOnlineSaved: Promise<void>;
  /**
   * The device ids the arm file may hold: as the startup read found it, then
   * as each write that succeeded left it (a failed write adds its own ids: the
   * file is in doubt for them). Null while unknown: before the startup read
   * settles, or when the file could not be read. Read by
   * `offWhenOnlineAbsentOnDisk`.
   */
  private offWhenOnlineDurableIds: Set<string> | null = null;
  /** The newest arm-file write queued, settled or not. */
  private offWhenOnlineLastWrite: OffWhenOnlineWrite | null = null;
  /** The arm-file write running now, if any (writes are serialized: at most one). */
  private offWhenOnlineRunningWrite: OffWhenOnlineWrite | null = null;

  private static readonly STATE_FILE = "/app/data/ac-last-state.json";
  private static readonly OFF_WHEN_ONLINE_FILE = "/app/data/ac-off-when-online.json";

  // Properties to save/restore per model type
  private static readonly SAVE_PROPS_CHSA = [
    "workMode", "targetTemperature", "screen", "sleep",
    "verticalWind", "horizontalWind", "verticalDirection", "horizontalDirection",
    "generatorMode", "windSpeed7Gear", "newWindSwitch", "newWindAutoSwitch", "newWindStrength",
    "ECO", "AIECOSwitch", "turbo", "softWind", "healthy", "antiMoldew",
    "lightSense", "beepSwitch", "eightAddHot",
  ];
  private static readonly SAVE_PROPS_OTHER = [
    "workMode", "targetTemperature", "screen", "sleep",
    "verticalSwitch", "horizontalSwitch", "verticalDirection", "horizontalDirection",
    "generatorMode", "windSpeed", "ECO", "turbo", "silenceSwitch",
    "AIECOSwitch", "softWind", "healthy", "newWindSwitch", "newWindAutoSwitch", "newWindStrength",
    "antiMoldew", "lightSense", "beepSwitch", "eightAddHot",
  ];

  constructor(username: string, password: string) {
    this.username = username;
    this.passwordMd5 = md5hex(password);
    this.loadLastState();
    this.offWhenOnlineLoaded = this.loadOffWhenOnline();
    // Writes queue behind the read, so none can persist a snapshot that is
    // missing the arms the file still holds.
    this.offWhenOnlineSaved = this.offWhenOnlineLoaded;
  }

  async init(): Promise<void> {
    // A persisted arm must be in memory before the first device fetch: that
    // fetch must already report it and keep the unit's reboot-default ON state
    // out of the saved last state (`saveStateProps`).
    await this.offWhenOnlineLoaded;
    await this.loadCredentials();

    await this.ensureValidTokens();
    log.info("[tcl] Cloud initialized successfully");

    try {
      const devices = await this.fetchDevices();
      this.cachedDevices = devices;
      this.deviceCacheTime = Date.now();

      log.info(`[tcl] Found ${devices.length} AC device(s)`);
      for (const d of devices) {
        log.info(`[tcl]   - ${d.name} (${d.id}, ${d.isOnline ? "online" : "offline"}, power=${d.power ? "on" : "off"})`);
      }
    } catch (err) {
      log.warn("[tcl] Device fetch during init failed (will retry on first API call):", (err as Error).message);
    }
  }

  isReady(): boolean {
    return this.authData != null && this.tokenData != null;
  }

  getDevices(): AcDevice[] {
    return this.cachedDevices;
  }

  async fetchDevicesLive(): Promise<AcDevice[]> {
    await this.ensureValidTokens();
    const devices = await this.fetchDevices();
    this.cachedDevices = devices;
    this.deviceCacheTime = Date.now();
    return devices.sort((a, b) => a.displayOrder - b.displayOrder);
  }

  async ensureDeviceCachePopulated(): Promise<void> {
    if (this.cachedDevices.length === 0) {
      await this.fetchDevicesLive();
    }
  }

  /** The cached device snapshot while it is at most `maxAgeMs` old, else a live fetch. */
  async getDevicesNoOlderThan(maxAgeMs: number): Promise<AcDevice[]> {
    if (this.cachedDevices.length > 0 && Date.now() - this.deviceCacheTime <= maxAgeMs) {
      return this.cachedDevices;
    }
    return this.fetchDevicesLive();
  }

  getDeviceState(deviceId: string): Partial<AcAction> | null {
    const dev = this.cachedDevices.find(d => d.id === deviceId);
    if (!dev) return null;
    return {
      mode: dev.mode,
      temperature: dev.targetTemp,
      fan_speed: dev.fanSpeed,
      eco: dev.eco ? 1 : 0,
      turbo: dev.turbo ? 1 : 0,
      screen: dev.screen ? 1 : 0,
      vertical_swing: dev.verticalSwing,
      horizontal_swing: dev.horizontalSwing,
      fresh_air: dev.freshAir ? 1 : 0,
      generator_mode: dev.generatorMode,
    };
  }

  computeAcDiff(deviceId: string, desired: AcAction): AcAction | null {
    const current = this.getDeviceState(deviceId);
    if (!current) {
      log.warn(`[tcl] computeAcDiff: device ${deviceId} not in cache, sending full profile`);
      return desired;
    }
    // Non-Najat: fan_speed already encodes turbo (1=silence, 7=turbo) — the
    // derived fan_speed comparison subsumes the turbo flag. Comparing both
    // alternated {turbo:0}/{fan_speed:7} commands forever (beep loop).
    const skipTurbo = desired.fan_speed != null && !this.isChsaModel(deviceId);
    // Clamp the desired gen level to the device max BEFORE diffing — a stored
    // profile with a no-longer-supported level (e.g. Najat 6 after TCL removed
    // 4–6) would otherwise diff against the reported level every 5s forever.
    const desiredEffective: AcAction = desired.generator_mode != null
      ? { ...desired, generator_mode: this.clampGeneratorMode(deviceId, desired.generator_mode) }
      : desired;
    const diff: Partial<AcAction> = {};
    for (const key of ["mode", "temperature", "fan_speed", "eco", "turbo", "screen", "vertical_swing", "horizontal_swing", "fresh_air", "generator_mode"] as const) {
      if (key === "turbo" && skipTurbo) continue;
      if (desiredEffective[key] != null && desiredEffective[key] !== current[key]) {
        (diff as Record<string, unknown>)[key] = desiredEffective[key];
      }
    }
    return Object.keys(diff).length > 0 ? (diff as AcAction) : null;
  }

  private isChsaModel(deviceId: string): boolean {
    const dev = this.cachedDevices.find(d => d.id === deviceId);
    return dev ? dev.model === "TAC-24CHSA" : false;
  }

  validateControl(deviceId: string, command: string, value: unknown): AcControlValidation | { ok: false; status: 404; error: string } {
    const device = this.cachedDevices.find((candidate) => candidate.id === deviceId);
    if (!device) return { ok: false, status: 404, error: `Unknown AC device: ${deviceId}` };
    return validateAcControl(device.capabilities, command, value);
  }

  /**
   * Capability-filter a stored profile without considering current-mode
   * availability. A profile may intentionally change Fan→Cool and enable Eco
   * in the same update; both are supported even though Eco is unavailable in
   * the pre-command Fan shadow. Unknown devices fail closed.
   */
  sanitizeAcAction(deviceId: string, action: AcAction): AcAction | null {
    const device = this.cachedDevices.find((candidate) => candidate.id === deviceId);
    if (!device) return null;
    const safe: AcAction = {};
    const copy = (key: keyof AcAction, command: string): void => {
      const value = action[key];
      if (value != null && supportsAcCommand(device.capabilities, command, value)) {
        (safe as Record<string, unknown>)[key] = value;
      }
    };
    copy("power", "set_power");
    copy("mode", "set_mode");
    copy("temperature", "set_temperature");
    copy("fan_speed", "set_fan_speed");
    copy("eco", "set_eco");
    copy("turbo", "set_turbo");
    copy("screen", "set_screen");
    copy("vertical_swing", "set_vertical_swing");
    copy("horizontal_swing", "set_horizontal_swing");
    copy("fresh_air", "set_fresh_air");
    if (action.generator_mode != null && supportsAcCommand(device.capabilities, "set_generator_mode", action.generator_mode)) {
      safe.generator_mode = this.clampGeneratorMode(deviceId, action.generator_mode);
    }
    return safe;
  }

  /**
   * Re-read the selected unit before evaluating mode/power availability.
   * Commands and presets are sequential, so cached capabilities from the
   * dashboard's 10s poll can otherwise reject Eco immediately after Fan→Cool
   * or accept a control the physical unit has since made unavailable.
   */
  async validateControlLive(
    deviceId: string,
    command: string,
    value: unknown,
  ): Promise<AcControlValidation | { ok: false; status: 404 | 503; error: string }> {
    await this.ensureDeviceCachePopulated();
    const device = this.cachedDevices.find((candidate) => candidate.id === deviceId);
    if (!device) return { ok: false, status: 404, error: `Unknown AC device: ${deviceId}` };
    // A stale-AWS-credential 403 on this pre-read is the exact event five write
    // paths self-heal from; awaiting it bare made EVERY control 500 until token
    // expiry. Try the same self-heal once — reset the credential state, re-auth,
    // and re-read — before degrading to the device's cached capabilities.
    let degraded = false;
    try {
      await this.ensureValidTokens();
      const { reported } = await this.getThingShadow(deviceId);
      device.capabilities = deriveAcCapabilities(deviceId, device.model, reported);
    } catch {
      try {
        this.awsCreds = null;
        this.tokenExpiry = 0;
        this.tokenData = null;
        await this.ensureValidTokens();
        const { reported } = await this.getThingShadow(deviceId);
        device.capabilities = deriveAcCapabilities(deviceId, device.model, reported);
      } catch (retryErr) {
        degraded = true;
        log.warn(`[tcl] Live re-read for ${deviceId} failed after re-auth retry (${(retryErr as Error).message}) — validating against cached capabilities`);
      }
    }
    // Self Clean is the one command the cached fallback must NOT authorize: its
    // advanced payload sets powerSwitch:0 (it shuts the unit down) and the route
    // records a persistent manual-off lock BEFORE the send, so approving it from
    // a stale cache can power off a RUNNING AC and lock it off. Fail closed when
    // we could not verify live state. Stopping a clean cycle (value 0) is safe.
    if (degraded && command === "set_self_clean" && value === 1) {
      return {
        ok: false,
        status: 503,
        error: "Cannot verify the AC's live state for Self Clean right now — try again shortly",
      };
    }
    return validateAcControl(device.capabilities, command, value);
  }

  /**
   * Clamp a generator-mode level to the device's max. 0 (auto/unrestricted)
   * passes through. Firmware silently ignores levels above the max (accepts
   * the command, never applies it), which would otherwise leave diff-based
   * re-enforcement re-sending the same value every 5s forever.
   */
  private clampGeneratorMode(deviceId: string, level: number): number {
    if (level <= 0) return level;
    const dev = this.cachedDevices.find(d => d.id === deviceId);
    const max = dev?.maxGeneratorLevel || MAX_GENERATOR_LEVEL;
    return Math.min(level, max);
  }

  async sendControl(
    deviceId: string,
    command: string,
    value: unknown,
    skipRestore = false,
    preserveProfileIntent = false,
    /**
     * Publish-boundary guard (2026-09-27): evaluated immediately before each
     * publish starts, with no await in between, so a newer command that claimed
     * this field while this one waited (tokens, re-auth) is never overwritten by
     * it. False → `ControlSupersededError`, nothing published.
     */
    stillCurrent?: () => boolean,
    /** Runs at each publish boundary, right after `stillCurrent` passed (see `publishControl`). */
    onPublish?: () => void,
  ): Promise<void> {
    // Raw leveler/calibration controls do not pass through the verified UI
    // wrapper. If one lands while a manual preset verifier is pending, make it
    // authoritative: cancel that verifier so it cannot resend the old whole
    // profile over a protective level/fan cut. Internal sends belonging to the
    // verified profile opt out explicitly.
    if (!preserveProfileIntent && this.pendingManualProfiles.has(deviceId)) {
      this.bumpProfileGeneration(deviceId);
    }
    await this.ensureValidTokens();

    // Handle power-on: restore last saved state
    if (command === "set_power" && value === 1) {
      const desired: Record<string, unknown> = { powerSwitch: 1 };
      try {
        await this.publishControl(deviceId, desired, stillCurrent, onPublish);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        const name = (err as { name?: string }).name ?? "";
        if (msg.includes("403") || msg.includes("Forbidden") || name.includes("Credential") || name.includes("ExpiredToken")) {
          log.warn(`[tcl] Control publish failed (${name}), forcing re-auth and retrying`);
          this.awsCreds = null;
          this.tokenExpiry = 0;
          this.tokenData = null;
          await this.ensureValidTokens();
          await this.publishControl(deviceId, desired, stillCurrent, onPublish);
        } else {
          throw err;
        }
      }
      log.info(`[tcl] Control ${command}=${value} → device ${deviceId}: OK`);
      if (!skipRestore) {
        await this.restoreLastState(deviceId, stillCurrent);
      }
      return;
    }

    // Handle swing commands specially (sets both switch + direction)
    if (command === "set_vertical_swing" || command === "set_horizontal_swing") {
      const v = value as number;
      const prefix = command === "set_vertical_swing" ? "vertical" : "horizontal";
      const switchProp = this.isChsaModel(deviceId) ? `${prefix}Wind` : `${prefix}Switch`;
      let desired: Record<string, unknown>;
      if (v === 0) {
        desired = { [switchProp]: 0, [`${prefix}Direction`]: 8 };
      } else if (v >= 1 && v <= 4) {
        desired = { [switchProp]: 1, [`${prefix}Direction`]: v };
      } else if (v >= 9 && v <= 13) {
        desired = { [switchProp]: 0, [`${prefix}Direction`]: v };
      } else {
        throw new Error(`Invalid swing value: ${v}`);
      }
      try {
        await this.publishControl(deviceId, desired, stillCurrent, onPublish);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        const name = (err as { name?: string }).name ?? "";
        if (msg.includes("403") || msg.includes("Forbidden") || name.includes("Credential") || name.includes("ExpiredToken")) {
          log.warn(`[tcl] Control publish failed (${name}), forcing re-auth and retrying`);
          this.awsCreds = null;
          this.tokenExpiry = 0;
          this.tokenData = null;
          await this.ensureValidTokens();
          await this.publishControl(deviceId, desired, stillCurrent, onPublish);
        } else {
          throw err;
        }
      }
      log.info(`[tcl] Control ${command}=${value} → device ${deviceId}: OK`);
      return;
    }

    const chsa = this.isChsaModel(deviceId);

    // Handle fan speed specially for TAC-12CHSD: 1=silent, 7=turbo/max
    if (command === "set_fan_speed" && !chsa) {
      const v = value as number;
      let desired: Record<string, unknown>;
      if (v === 1) {
        desired = { windSpeed: 0, silenceSwitch: 1, turbo: 0 };
      } else if (v === 7) {
        desired = { windSpeed: 0, silenceSwitch: 0, turbo: 1 };
      } else {
        desired = { windSpeed: v, silenceSwitch: 0, turbo: 0 };
      }
      try {
        await this.publishControl(deviceId, desired, stillCurrent, onPublish);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        const name = (err as { name?: string }).name ?? "";
        if (msg.includes("403") || msg.includes("Forbidden") || name.includes("Credential") || name.includes("ExpiredToken")) {
          log.warn(`[tcl] Control publish failed (${name}), forcing re-auth and retrying`);
          this.awsCreds = null;
          this.tokenExpiry = 0;
          this.tokenData = null;
          await this.ensureValidTokens();
          await this.publishControl(deviceId, desired, stillCurrent, onPublish);
        } else {
          throw err;
        }
      }
      log.info(`[tcl] Control ${command}=${value} → device ${deviceId}: OK`);
      return;
    }

    const propMap: Record<string, string> = {
      set_power: "powerSwitch",
      set_mode: "workMode",
      set_temperature: "targetTemperature",
      set_fan_speed: "windSpeed7Gear",
      set_eco: "ECO",
      set_screen: "screen",
      set_sleep: "sleep",
      set_turbo: "turbo",
      set_fresh_air: "newWindSwitch",
      set_generator_mode: "generatorMode",
      set_beep: "beepSwitch",
    };

    const prop = propMap[command];
    const advancedPayload = buildAdvancedControlPayload(command, value);
    if (!prop && !advancedPayload) throw new Error(`Unknown command: ${command}`);

    // Firmware ignores gen levels above the device max — send the clamped value
    if (command === "set_generator_mode" && typeof value === "number") {
      value = this.clampGeneratorMode(deviceId, value);
    }
    const desired: Record<string, unknown> = advancedPayload ?? { [prop]: value };
    try {
      await this.publishControl(deviceId, desired, stillCurrent, onPublish);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      const name = (err as { name?: string }).name ?? "";
      if (msg.includes("403") || msg.includes("Forbidden") || name.includes("Credential") || name.includes("ExpiredToken")) {
        log.warn(`[tcl] Control publish failed (${name}), forcing re-auth and retrying`);
        this.awsCreds = null;
        this.tokenExpiry = 0;
        this.tokenData = null;
        await this.ensureValidTokens();
        await this.publishControl(deviceId, desired, stillCurrent, onPublish);
      } else {
        throw err;
      }
    }
    log.info(`[tcl] Control ${command}=${value} → device ${deviceId}: OK`);
  }

  // ---------- Auth Chain ----------

  private async login(): Promise<AuthData> {
    const resp = await fetch(LOGIN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "User-Agent": "Android",
        "th_platform": "android",
        "th_version": "4.8.1",
        "th_appbuild": "830",
      },
      body: JSON.stringify({
        equipment: 2,
        password: this.passwordMd5,
        osType: 1,
        username: this.username,
        clientVersion: "4.8.1",
        osVersion: "6.0",
        deviceModel: "AndroidAndroid SDK built for x86",
        captchaRule: 2,
        channel: "app",
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      throw new Error(`TCL login HTTP ${resp.status}: ${await resp.text()}`);
    }

    const data = await resp.json() as {
      status?: number;
      token?: string;
      refreshtoken?: string;
      user?: { username?: string; countryAbbr?: string };
      msg?: string;
    };

    if (!data.token || !data.user?.username) {
      throw new Error(`TCL login failed: ${data.msg || JSON.stringify(data)}`);
    }

    log.info(`[tcl] Login OK — user=${data.user.username}, country=${data.user.countryAbbr}`);
    return {
      token: data.token,
      refreshToken: data.refreshtoken ?? "",
      username: data.user.username,
      countryAbbr: data.user.countryAbbr ?? "IQ",
    };
  }

  private async refreshTokens(): Promise<TokenData> {
    if (!this.authData) throw new Error("Not logged in");

    const resp = await fetch(`${this.baseApiUrl}/v3/auth/refresh_tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "User-Agent": "Android",
        "Accept-Encoding": "gzip, deflate, br",
      },
      body: JSON.stringify({
        userId: this.authData.username,
        ssoToken: this.authData.token,
        appId: TCL_APP_ID,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      throw new Error(`TCL refresh_tokens HTTP ${resp.status}: ${await resp.text()}`);
    }

    const data = await resp.json() as {
      code?: number;
      message?: string;
      data?: {
        saasToken?: string;
        cognitoToken?: string;
        cognitoId?: string;
        mqttEndpoint?: string;
      };
    };

    const d = data.data;
    if (!d?.saasToken || !d?.cognitoToken) {
      throw new Error(`TCL refresh_tokens failed: ${data.message || JSON.stringify(data)}`);
    }

    log.info(`[tcl] Tokens refreshed — mqtt=${d.mqttEndpoint}, cognitoId=${d.cognitoId}`);
    return {
      saasToken: d.saasToken,
      cognitoToken: d.cognitoToken,
      cognitoId: d.cognitoId ?? "",
      mqttEndpoint: d.mqttEndpoint ?? "",
    };
  }

  private async getAwsCredentials(): Promise<AwsCredentials> {
    if (!this.tokenData) throw new Error("Missing token data");

    const region = extractRegion(this.tokenData.mqttEndpoint);
    const identityId = this.tokenData.cognitoId;

    if (!identityId) {
      throw new Error("Missing cognitoId for AWS credential exchange");
    }

    const getCredsResp = await fetch(`https://cognito-identity.${region}.amazonaws.com/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityService.GetCredentialsForIdentity",
      },
      body: JSON.stringify({
        IdentityId: identityId,
        Logins: { "cognito-identity.amazonaws.com": this.tokenData.cognitoToken },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!getCredsResp.ok) {
      throw new Error(`Cognito GetCredentials HTTP ${getCredsResp.status}: ${await getCredsResp.text()}`);
    }

    const credsData = await getCredsResp.json() as {
      Credentials?: {
        AccessKeyId?: string;
        SecretKey?: string;
        SessionToken?: string;
        Expiration?: number;
      };
    };

    const c = credsData.Credentials;
    if (!c?.AccessKeyId || !c?.SecretKey) {
      throw new Error("Cognito: missing credentials in response");
    }

    log.info(`[tcl] AWS credentials obtained for region ${region}`);
    return {
      accessKeyId: c.AccessKeyId,
      secretKey: c.SecretKey,
      sessionToken: c.SessionToken ?? "",
      expiration: c.Expiration ?? (Date.now() / 1000 + 3600),
      region,
    };
  }

  private async ensureValidTokens(): Promise<void> {
    // If we have valid AWS creds (with 5 min buffer), we're good
    if (this.awsCreds && Date.now() / 1000 < this.awsCreds.expiration - 300) {
      return;
    }

    // If we have saas token, try refreshing AWS creds
    if (this.tokenData && this.tokenExpiry > Date.now()) {
      try {
        this.awsCreds = await this.getAwsCredentials();
        await this.saveCredentials();
        return;
      } catch {
        // Token may be expired, fall through to full re-auth
      }
    }

    // If we have auth token, try getting saas token
    if (this.authData) {
      try {
        this.tokenData = await this.refreshTokens();
        this.tokenExpiry = Date.now() + 3600_000;
        this.awsCreds = await this.getAwsCredentials();
        await this.saveCredentials();
        return;
      } catch {
        // Auth token may be expired, do full login
      }
    }

    // Full login chain
    this.authData = await this.login();
    this.tokenData = await this.refreshTokens();
    this.tokenExpiry = Date.now() + 3600_000;
    this.awsCreds = await this.getAwsCredentials();
    await this.saveCredentials();
  }

  // ---------- Device Operations ----------

  private async fetchDevices(isRetry = false): Promise<AcDevice[]> {
    if (!this.tokenData || !this.authData) {
      throw new Error("Not authenticated");
    }

    const timestamp = String(Date.now());
    const nonce = Math.random().toString(36).substring(2);
    const sign = md5hex(timestamp + nonce + this.tokenData.saasToken);

    const resp = await fetch(`${this.baseApiUrl}/v3/central/control/user_groups/get`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "User-Agent": "Android",
        "platform": "android",
        "appversion": "7.3.0",
        "thomeversion": "5.1.8",
        "accesstoken": this.tokenData.saasToken,
        "ssotoken": this.authData.token,
        "appid": TCL_APP_ID,
        "countrycode": this.authData.countryAbbr,
        "timezone": "Asia/Baghdad",
        "accept-language": "en",
        "timestamp": timestamp,
        "nonce": nonce,
        "sign": sign,
        "Accept-Encoding": "gzip, deflate, br",
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15_000),
    });

    interface Identifier {
      identifier?: string;
      value?: number;
    }
    interface DeviceRaw {
      deviceId?: string;
      nickName?: string;
      deviceName?: string;
      isOnline?: string | boolean | number;
      identifiers?: Identifier[];
    }
    interface GroupRaw {
      devices?: DeviceRaw[];
    }

    // Handle expired token: force re-auth and retry once
    if (!resp.ok) {
      const body = await resp.text();
      if (!isRetry && (resp.status === 403 || body.includes("10022"))) {
        log.warn(`[tcl] fetchDevices got ${resp.status} (expired token), forcing re-auth and retrying`);
        this.awsCreds = null;
        this.tokenExpiry = 0;
        this.tokenData = null;
        await this.ensureValidTokens();
        return this.fetchDevices(true);
      }
      throw new Error(`user_groups/get HTTP ${resp.status}: ${body}`);
    }

    const data = await resp.json() as {
      code?: number;
      message?: string;
      data?: GroupRaw[];
    };

    // Also check for error code in JSON response body
    if (data.code != null && data.code !== 0 && !isRetry) {
      if (data.code === 10022 || data.message?.toLowerCase().includes("expired")) {
        log.warn(`[tcl] fetchDevices got code ${data.code} (${data.message}), forcing re-auth and retrying`);
        this.awsCreds = null;
        this.tokenExpiry = 0;
        this.tokenData = null;
        await this.ensureValidTokens();
        return this.fetchDevices(true);
      }
    }

    const groups = data.data ?? [];
    const devices: AcDevice[] = [];
    const seen = new Set<string>();

    for (const group of groups) {
      for (const dev of group.devices ?? []) {
        if (!dev.deviceId || seen.has(dev.deviceId)) continue;
        seen.add(dev.deviceId);

        const tclOnline = dev.isOnline === "online" || dev.isOnline === "1" || dev.isOnline === true || dev.isOnline === 1;

        // Always attempt shadow fetch — TCL's isOnline flag is unreliable
        let shadow: Record<string, number> = {};
        let reportedAt: number | null = null;
        let powerReport: PowerReportInfo = { powerReportedAt: null, powerReportCohort: null, fullStateReportAt: null };
        if (this.awsCreds) {
          try {
            const result = await this.getThingShadow(dev.deviceId);
            shadow = result.reported;
            reportedAt = result.reportedAt;
            powerReport = {
              powerReportedAt: result.powerReportedAt ?? null,
              powerReportCohort: result.powerReportCohort ?? null,
              fullStateReportAt: result.fullStateReportAt ?? null,
            };
          } catch (err) {
            log.warn(`[tcl] Shadow read failed for ${dev.deviceId}:`, (err as Error).message);
          }
        }
        // A persisted shadow alone no longer means "online" — it never clears
        // when the AC loses power, so a blacked-out AC read online forever.
        // Require the shadow to be fresh (last report within SHADOW_STALE_MS).
        const online = deviceOnline(tclOnline, Object.keys(shadow).length > 0, reportedAt, Date.now(), SHADOW_STALE_MS);

        const powerFromId = (dev.identifiers ?? []).find(i => i.identifier === "powerSwitch");

        // TAC-24CHSA uses different property names than TAC-12CHSD.
        const isChsaModel = 'autoGeneratorMode' in shadow;
        const vSwitch = isChsaModel ? shadow.verticalWind : shadow.verticalSwitch;
        const hSwitch = isChsaModel ? shadow.horizontalWind : shadow.horizontalSwitch;

        const power = shadow.powerSwitch != null ? shadow.powerSwitch === 1 : powerFromId?.value === 1;
        this.observeOffWhenOnline(dev.deviceId, power, powerReport.powerReportedAt ?? reportedAt);

        const policy = getAcDevicePolicy(dev.deviceId);
        const model: AcModel = isChsaModel ? "TAC-24CHSA" : "TAC-12CHSD";
        const capabilities = deriveAcCapabilities(dev.deviceId, model, shadow);
        const positiveFanSpeeds = capabilities.fanSpeeds
          .map((option) => option.value)
          .filter((value) => value > 0);
        devices.push({
          id: dev.deviceId,
          name: dev.nickName || dev.deviceName || dev.deviceId,
          displayName: policy.displayName === "AC" ? (dev.nickName || dev.deviceName || dev.deviceId) : policy.displayName,
          displayOrder: policy.displayOrder,
          model,
          levelingEligible: policy.levelingEligible,
          capabilities,
          isOnline: online,
          lastSeenAt: reportedAt,
          powerReportedAt: powerReport.powerReportedAt,
          powerReportCohort: powerReport.powerReportCohort,
          fullStateReportAt: powerReport.fullStateReportAt,
          power,
          mode: shadow.workMode ?? 0,
          targetTemp: shadow.targetTemperature ?? 24,
          currentTemp: shadow.currentTemperature ?? 0,
          targetTempKnown: shadow.targetTemperature != null,
          currentTempKnown: shadow.currentTemperature != null,
          fanSpeed: isChsaModel
            ? (shadow.windSpeed7Gear ?? 0)
            : (shadow.silenceSwitch === 1 ? 1 : shadow.turbo === 1 ? 7 : (shadow.windSpeed ?? 0)),
          eco: shadow.ECO === 1,
          sleep: shadow.sleep ?? 0,
          screen: shadow.screen === 1,
          verticalSwing: vSwitch === 1
            ? (shadow.verticalDirection ?? 1)
            : (shadow.verticalDirection >= 9 ? shadow.verticalDirection : 0),
          horizontalSwing: hSwitch === 1
            ? (shadow.horizontalDirection ?? 1)
            : (shadow.horizontalDirection >= 9 ? shadow.horizontalDirection : 0),
          turbo: shadow.turbo === 1,
          freshAir: shadow.newWindSwitch === 1,
          hasFreshAir: 'newWindSwitch' in shadow,
          generatorMode: shadow.generatorMode ?? 0,
          maxGeneratorLevel: policy.maxGeneratorLevel,
          tempStep: capabilities.temperature.step,
          minFanSpeed: positiveFanSpeeds.length > 0 ? Math.min(...positiveFanSpeeds) : 0,
          maxFanSpeed: Math.max(...capabilities.fanSpeeds.map((option) => option.value), 0),
          beep: shadow.beepSwitch === 1,
          // The arm as of this snapshot. A fetch never sends for an armed "off
          // when back online"; the one thing it does (above) is end the arm on
          // an OFF the unit reported. The collector's off-when-online step sends.
          offWhenOnline: this.isOffWhenOnlineArmed(dev.deviceId),
        });

        // The restore publish is awaited un-caught inside this loop, so one
        // failed publish would reject fetchDevices for ALL devices. Isolate it:
        // on error, freeze the save (stateSaveSuppressed=true) — the safe
        // direction while the restore is in doubt.
        let stateSaveSuppressed = true;
        try {
          stateSaveSuppressed = await this.maybeRestorePowerCycleState(
            dev.deviceId,
            shadow,
            reportedAt,
            isChsaModel,
          );
        } catch (err) {
          log.warn(`[tcl] Last-state restore for ${dev.deviceId} failed: ${(err as Error).message}`);
        }
        // Save state when device is on (for restore on next power-on). A
        // pending power-cycle restore freezes the pre-event snapshot so reboot
        // defaults cannot replace the user's last state before it is restored.
        if (shadow.powerSwitch === 1 && !stateSaveSuppressed) {
          this.saveStateProps(dev.deviceId, shadow, isChsaModel);
        }
      }
    }

    return devices.sort((a, b) => a.displayOrder - b.displayOrder);
  }

  private async getThingShadow(
    deviceId: string,
  ): Promise<{ reported: Record<string, number>; reportedAt: number | null } & Partial<PowerReportInfo>> {
    if (!this.awsCreds) throw new Error("No AWS credentials");

    const region = this.awsCreds.region;
    const host = `data-ats.iot.${region}.amazonaws.com`;
    const path = `/things/${encodeURIComponent(deviceId)}/shadow`;

    const headers = this.signAwsRequest("GET", host, path, "", region, "iotdata");

    const resp = await fetch(`https://${host}${path}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      throw new Error(`GetThingShadow HTTP ${resp.status}: ${await resp.text()}`);
    }

    const shadow = await resp.json() as {
      state?: { reported?: Record<string, number> };
      metadata?: { reported?: Record<string, { timestamp?: number }> };
    };

    return {
      reported: shadow.state?.reported ?? {},
      reportedAt: latestReportedAtMs(shadow.metadata?.reported),
      ...powerReportInfo(shadow.metadata?.reported),
    };
  }

  /** Not async on purpose: the guard runs synchronously and the publish starts in the same tick. */
  private publishControl(
    deviceId: string,
    desired: Record<string, unknown>,
    stillCurrent?: () => boolean,
    onPublish?: () => void,
  ): Promise<void> {
    if (stillCurrent && !stillCurrent()) throw new ControlSupersededError(deviceId);
    onPublish?.();
    return this.publishShadowUpdate(deviceId, desired);
  }

  private async publishShadowUpdate(deviceId: string, desired: Record<string, unknown>): Promise<void> {
    if (!this.awsCreds) throw new Error("No AWS credentials");

    const region = this.awsCreds.region;
    const client = new IoTDataPlaneClient({
      region,
      endpoint: `https://data-ats.iot.${region}.amazonaws.com`,
      credentials: {
        accessKeyId: this.awsCreds.accessKeyId,
        secretAccessKey: this.awsCreds.secretKey,
        sessionToken: this.awsCreds.sessionToken,
      },
    });

    const topic = `$aws/things/${deviceId}/shadow/update`;
    const payload = JSON.stringify({
      state: { desired },
      clientToken: `mobile_${Date.now()}`,
    });

    // Hard deadline: the SDK ships with NO request timeout, so a half-open
    // connection hangs this await forever — and because the collector loop is
    // sequential, ONE hung publish silently freezes every automation and all
    // leveling trip-protection (the 2026-07-06 ~3h stall). Never block.
    try {
      await client.send(new PublishCommand({
        topic,
        qos: 1,
        payload: new TextEncoder().encode(payload),
      }), { abortSignal: AbortSignal.timeout(15_000) });
    } finally {
      client.destroy();
    }
  }

  // ---------- AWS SigV4 Signing ----------

  private signAwsRequest(
    method: string,
    host: string,
    path: string,
    body: string,
    region: string,
    service: string,
  ): Record<string, string> {
    if (!this.awsCreds) throw new Error("No AWS credentials");

    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const dateOnly = dateStamp.substring(0, 8);

    const payloadHash = createHash("sha256").update(body).digest("hex");

    const [pathPart, queryString] = path.split("?");
    const canonicalQueryString = queryString
      ? queryString.split("&").sort().join("&")
      : "";

    const signedHeaders = "host;x-amz-date;x-amz-security-token";
    const canonicalHeaders =
      `host:${host}\n` +
      `x-amz-date:${dateStamp}\n` +
      `x-amz-security-token:${this.awsCreds.sessionToken}\n`;

    const canonicalRequest = [
      method,
      pathPart,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const credentialScope = `${dateOnly}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      dateStamp,
      credentialScope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");

    const signingKey = this.getSignatureKey(dateOnly, region, service);
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${this.awsCreds.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, ` +
      `Signature=${signature}`;

    return {
      "Host": host,
      "X-Amz-Date": dateStamp,
      "X-Amz-Security-Token": this.awsCreds.sessionToken,
      "Authorization": authorization,
    };
  }

  private getSignatureKey(dateStamp: string, region: string, service: string): Buffer {
    const kDate = createHmac("sha256", `AWS4${this.awsCreds!.secretKey}`).update(dateStamp).digest();
    const kRegion = createHmac("sha256", kDate).update(region).digest();
    const kService = createHmac("sha256", kRegion).update(service).digest();
    return createHmac("sha256", kService).update("aws4_request").digest();
  }

  // ---------- Off When Back Online ----------

  /**
   * Arm (or disarm) a one-shot OFF for an AC that dropped offline while ON,
   * e.g. the grid-only Guest unit losing its line on generator. TclCloud only
   * stores the arm: a device fetch never sends for it (it only ends the arm on
   * an OFF the unit reported, `observeOffWhenOnline`). The collector's dedicated
   * off-when-online step sends a plain server OFF (`sendOffWhenOnline`) on the
   * first report that is strictly newer than the arm time and the last power
   * epoch AND current (the device loop's own online rule). No manual-off lock
   * is involved (owner decision 2026-10-10). Any later user power command
   * disarms it.
   *
   * Arming is newer user power intent than any `set_power` still in flight: it
   * supersedes an older dashboard command still waiting to publish and stops
   * an older verifier's resends. It also cancels a pending last-state restore
   * (LOUD): the owner asked for this unit to come back OFF, and the restore
   * would republish its pre-event ON state. While armed, a new restore is
   * refused and state saving pauses.
   *
   * Only for ACs outside Smart AC Leveling (leader decision 2026-10-10): a
   * deferred OFF on a leveled room would bypass the leveler's user-OFF
   * bookkeeping (the control route's onUserPowerOff/onUserPowerOffSent) and
   * read as an unexplained draw change (hard rule 5b). The route already
   * answers 409; refusing here too is defense in depth, like
   * preparePowerCycleRestore. A disarm is accepted for any id.
   *
   * An arm resolves once the arm-file write holding it has completed, and
   * rejects when it failed (the in-memory change stands): see
   * `saveOffWhenOnline`. A disarm resolves once the arm file durably excludes
   * the device, whichever path removed the arm from memory, and rejects when
   * the write that was to exclude it failed: see `offWhenOnlineDurablyAbsent`.
   */
  setOffWhenOnline(deviceId: string, enabled: boolean): Promise<void> {
    if (!enabled) return this.disarmOffWhenOnline(deviceId, "cancelled from the dashboard");
    if (isAcLevelingEligible(deviceId)) {
      log.warn(`[tcl] Refusing off-when-back-online for ${deviceId}: a Smart AC Leveling AC (its deferred OFF would bypass the leveler's user-OFF bookkeeping)`);
      return Promise.resolve();
    }
    this.offWhenOnlineTouched.add(deviceId);
    this.pendingOffWhenOnline.set(deviceId, newOffWhenOnline(deviceId, Date.now()));
    log.info(`[tcl] Armed off-when-back-online for ${deviceId}`);
    if (this.pendingPowerCycleRestores.delete(deviceId)) {
      log.info(`[tcl] Pending last-state restore for ${deviceId} cancelled by off-when-back-online (armed)`);
    }
    this.supersedeControlVerify(deviceId, "set_power", "user");
    return this.saveOffWhenOnline();
  }

  isOffWhenOnlineArmed(deviceId: string): boolean {
    return this.pendingOffWhenOnline.has(deviceId);
  }

  /** The current arms, for the collector's off-when-online step. */
  getOffWhenOnlineArms(): OffWhenOnlineArm[] {
    return [...this.pendingOffWhenOnline.values()];
  }

  /** True while `arm` is still its device's arm: no cancel, disarm or re-arm since. */
  isOffWhenOnlineCurrent(arm: OffWhenOnlineArm): boolean {
    return this.pendingOffWhenOnline.get(arm.deviceId) === arm;
  }

  /**
   * One off-when-online operation per device at a time. Returns the claim's
   * token, or null while another operation holds an unexpired claim. A claim
   * older than OFF_WHEN_ONLINE_LEASE_MS (a step that runStep abandoned, or one
   * hung on the cloud) is taken over, LOUDLY; the token is how the old
   * operation learns it lost (`isOffWhenOnlineOperationCurrent`). Pair every
   * token with `releaseOffWhenOnline`.
   */
  claimOffWhenOnline(deviceId: string): number | null {
    const now = Date.now();
    const held = this.offWhenOnlineClaims.get(deviceId);
    if (held && now < held.expiresAt) return null;
    if (held) {
      log.warn(`[tcl] Off-when-back-online for ${deviceId}: the previous operation held its claim past the ${OFF_WHEN_ONLINE_LEASE_MS / 1000}s lease; a new one takes over (the old one can no longer publish or change the arm)`);
    }
    const token = ++this.offWhenOnlineClaimSeq;
    this.offWhenOnlineClaims.set(deviceId, { token, expiresAt: now + OFF_WHEN_ONLINE_LEASE_MS });
    return token;
  }

  /** Release the claim `token` holds; a claim taken over since is left alone. */
  releaseOffWhenOnline(deviceId: string, token: number): void {
    if (this.offWhenOnlineClaims.get(deviceId)?.token === token) this.offWhenOnlineClaims.delete(deviceId);
  }

  /** True while `arm` is current AND the operation holding `token` still holds its device's claim. */
  isOffWhenOnlineOperationCurrent(arm: OffWhenOnlineArm, token: number): boolean {
    return this.isOffWhenOnlineCurrent(arm) && this.offWhenOnlineClaims.get(arm.deviceId)?.token === token;
  }

  /**
   * The collector's step resolved `arm` (done, or gave up): drop it, LOUDLY.
   * Only the operation holding the current arm's claim can: a stale arm or an
   * overtaken operation leaves it alone, so a newer arm survives.
   */
  finishOffWhenOnline(arm: OffWhenOnlineArm, token: number, outcome: string, level: "info" | "warn" = "info"): void {
    if (!this.isOffWhenOnlineOperationCurrent(arm, token)) return;
    this.pendingOffWhenOnline.delete(arm.deviceId);
    void this.saveOffWhenOnline();
    log[level](`[tcl] Off-when-back-online for ${arm.deviceId} ${outcome}`);
  }

  /**
   * Send the armed OFF for the operation holding `token`, whose snapshot gate
   * read the arm's power epoch `gatedEpochAt` (the caller gates and calls in
   * one tick, so the default is that epoch). The publish-boundary guard
   * (`executeAcAction` option `stillCurrent`, read before it claims the
   * `set_power` generation and again right before each publish, after the
   * token and re-auth waits) is all three: the arm is still current (no
   * cancel, disarm, re-arm or finish since, and no OFF a device fetch saw: that
   * ends the arm, see `observeOffWhenOnline`), this operation still holds the
   * claim, and no power epoch came after the gate (the report that gate
   * accepted says nothing about the unit after it). Any of them failing
   * publishes nothing and answers "superseded". `onPublish` runs at that
   * boundary, in the same tick as the publish start. A completed send is
   * counted (a failed publish too, so a cloud outage cannot resend forever),
   * but only while the same guard still holds.
   */
  async sendOffWhenOnline(
    arm: OffWhenOnlineArm,
    token: number,
    onPublish?: () => void,
    gatedEpochAt: number = arm.epochAt,
  ): Promise<"sent" | "superseded"> {
    const { deviceId } = arm;
    const current = () => this.isOffWhenOnlineOperationCurrent(arm, token) && arm.epochAt === gatedEpochAt;
    log.info(`[tcl] ${deviceId} back online and ON: sending armed OFF (attempt ${arm.attempts + 1})`);
    let superseded = false;
    try {
      await this.executeAcAction(deviceId, { power: 0 }, { stillCurrent: current, onPublish });
    } catch (err) {
      if (!(err instanceof ControlSupersededError)) throw err;
      superseded = true;
      log.info(`[tcl] Armed OFF for ${deviceId} not sent: the arm ended or was cancelled, a newer operation took it over, or a power event came, while the send waited`);
    } finally {
      if (!superseded && current()) {
        arm.attempts += 1;
        arm.lastSentAt = Date.now();
      }
    }
    return superseded ? "superseded" : "sent";
  }

  /**
   * A real source transition (the collector's `notePowerEvent` for the kinds
   * that restart the units; never "source none" or a meter-only gap): a new
   * power epoch for every arm. A report from before it says nothing about the
   * unit after it (a grid-only unit's last report stays "fresh" for minutes
   * after its line died), so each arm now waits for a report newer than `at`,
   * and its attempts start over; an OFF still waiting to publish under the
   * older epoch publishes nothing (`sendOffWhenOnline`). Persisted, LOUD.
   */
  noteOffWhenOnlinePowerEpoch(at: number): void {
    if (this.pendingOffWhenOnline.size === 0) return;
    for (const arm of this.pendingOffWhenOnline.values()) {
      arm.epochAt = Math.max(arm.epochAt, at);
      arm.attempts = 0;
      arm.lastSentAt = 0;
    }
    log.info(`[tcl] Power event: off-when-back-online for ${[...this.pendingOffWhenOnline.keys()].join(", ")} now waits for a report newer than it (attempts start over)`);
    void this.saveOffWhenOnline();
  }

  /**
   * Drop the arm for newer user power intent, synchronously at the entry of
   * the request that carries it: the control route for any set_power, the
   * preset route for a verified preset. Only an arm made before the request
   * can be cancelled this way; an arm accepted while the request then waits is
   * newer and survives it (`sendControlVerified` and `executeAcActionVerified`
   * do not disarm). LOUD, see `disarmOffWhenOnline`. The cancel is in memory
   * and synchronous; the request's success answer waits for it to be durable
   * through `offWhenOnlineDurablyAbsent`, asked right before that answer.
   */
  cancelOffWhenOnline(deviceId: string, reason: string): void {
    // A failed write is logged LOUDLY by the save chain; the acknowledgement
    // that reports it is the caller's own `offWhenOnlineDurablyAbsent`.
    this.disarmOffWhenOnline(deviceId, reason).catch(() => undefined);
  }

  /**
   * Drop the arm, LOUDLY. The step re-checks its arm at the OFF's publish
   * boundary, so a cancelled arm publishes nothing more. Marks the device
   * touched, so a startup file read still in flight cannot revive it. A
   * removal is written as every change is; with nothing armed in memory the
   * file may still hold the arm (another path's removal write pending or
   * failed, or the startup read pending), so a write is ensured whenever the
   * device is not durably absent. Resolves as `offWhenOnlineDurablyAbsent`.
   */
  private disarmOffWhenOnline(deviceId: string, reason: string): Promise<void> {
    this.offWhenOnlineTouched.add(deviceId);
    if (this.pendingOffWhenOnline.delete(deviceId)) {
      log.info(`[tcl] Off-when-back-online for ${deviceId} disarmed: ${reason}`);
      void this.saveOffWhenOnline();
    }
    return this.offWhenOnlineDurablyAbsent(deviceId);
  }

  /**
   * The durable acknowledgement of a cancel, whichever path removed the arm
   * from memory (a cancel, a disarm, the fetch's terminal OFF, the step's
   * finish) and whatever became of that path's own write. It decides only on
   * state, re-read at the call and again after every write it waited for
   * settles (a write it waited for proves nothing by itself: the device can be
   * re-armed before that write runs and removed again while it is held).
   * Resolves at a moment when the device is armed in memory (newer intent than
   * the cancel being acknowledged: no cancel is left to make durable) or
   * durably absent (`offWhenOnlineAbsentOnDisk`). Rejects at a moment when it
   * is neither and the write it waited for, which was to exclude the device,
   * failed with no newer write queued behind it. Otherwise it waits for the
   * LAST write in the queue, which completes after every earlier one: joined
   * when it has not run yet (it snapshots when it runs) or already excludes the
   * device, else a new one is queued (so a failed removal is written again).
   * Bounded: after OFF_WHEN_ONLINE_DURABLE_MAX_WRITES writes it rejects.
   */
  async offWhenOnlineDurablyAbsent(deviceId: string): Promise<void> {
    let failed: { write: OffWhenOnlineWrite; err: unknown } | null = null;
    for (let waited = 0; ; waited++) {
      if (this.pendingOffWhenOnline.has(deviceId) || this.offWhenOnlineAbsentOnDisk(deviceId)) return;
      if (failed && failed.write.ids != null && !failed.write.ids.has(deviceId) && this.offWhenOnlineLastWrite === failed.write) {
        throw failed.err;
      }
      if (waited >= OFF_WHEN_ONLINE_DURABLE_MAX_WRITES) {
        throw new Error(`the arm file may still hold ${deviceId} after ${waited} writes (it kept being armed and removed while the cancel waited)`);
      }
      const last = this.offWhenOnlineLastWrite;
      const write = last && !last.settled && !last.ids?.has(deviceId) ? last : this.queueOffWhenOnlineWrite();
      failed = null;
      try {
        await write.done;
      } catch (err) {
        failed = { write, err };
      }
    }
  }

  /**
   * Out of the arm file: absent from the file as last written (or as the
   * startup read found it) and from the write running now. A write still
   * queued has not snapshotted the arms yet; it does when it runs, from memory.
   */
  private offWhenOnlineAbsentOnDisk(deviceId: string): boolean {
    const durable = this.offWhenOnlineDurableIds;
    const runningHolds = this.offWhenOnlineRunningWrite?.ids?.has(deviceId) ?? false;
    return durable != null && !durable.has(deviceId) && !runningHolds;
  }

  /**
   * The device fetch's only part in "off when back online". An OFF report from
   * an armed unit that is newer than the arm and its last power epoch ENDS the
   * arm, at once: after any of our sends it is our OFF landing (or a hand's),
   * before them the unit came back OFF. Not only after the LAST send: the OFF
   * one send caused can be reported after the next send started. Ending it
   * here, in the fetch that saw the OFF, is what makes it terminal everywhere:
   * an OFF still waiting to publish fails its guard on the arm's identity (a
   * later ON is someone switching the unit back on, and they win), and the
   * removal is persisted through the serialized save, so a restart cannot
   * bring the arm back. Arm state only: nothing is sent or locked here. The
   * OFF's report time is kept for the collector's step to pin its booking
   * (`takeOffWhenOnlineSeenOffs`). LOUD.
   */
  private observeOffWhenOnline(deviceId: string, power: boolean, powerReportedAt: number | null): void {
    const arm = this.pendingOffWhenOnline.get(deviceId);
    if (!arm || power || powerReportedAt == null) return;
    if (powerReportedAt <= Math.max(arm.armedAt, arm.epochAt)) return;
    this.pendingOffWhenOnline.delete(deviceId);
    this.offWhenOnlineSeenOffs.set(deviceId, powerReportedAt);
    void this.saveOffWhenOnline();
    log.info(`[tcl] Off-when-back-online for ${deviceId} done: unit reported OFF (${arm.attempts} OFF send(s) completed in this power epoch)`);
  }

  /** The OFFs device fetches ended arms on since the last call, as [deviceId, power report time]; each is handed out once. */
  takeOffWhenOnlineSeenOffs(): Array<[string, number]> {
    const seen = [...this.offWhenOnlineSeenOffs];
    this.offWhenOnlineSeenOffs.clear();
    return seen;
  }

  /**
   * Queue a write of the arms. Serialized, and each write snapshots the map
   * when it RUNS (not when it was queued), so the file always ends with the
   * latest in-memory state however close together arms and disarms come. The
   * chain starts after the startup read, so no write can drop an arm the file
   * still holds. Atomic: a temp file in the same directory, renamed over the
   * target, so a crash mid-write leaves the previous file whole.
   *
   * The returned promise settles with THIS write: the durable acknowledgement
   * an arm's route waits for. A failure is also logged LOUDLY here and the
   * chain goes on, so callers that do not wait need no handler.
   */
  private saveOffWhenOnline(): Promise<void> {
    return this.queueOffWhenOnlineWrite().done;
  }

  /** `saveOffWhenOnline`, returning the write itself (its ids and state feed `offWhenOnlineDurablyAbsent`). */
  private queueOffWhenOnlineWrite(): OffWhenOnlineWrite {
    const write: OffWhenOnlineWrite = {
      ids: null,
      settled: false,
      done: this.offWhenOnlineSaved.then(() => this.runOffWhenOnlineWrite(write)),
    };
    this.offWhenOnlineSaved = write.done.catch((err: unknown) => {
      log.error(`[tcl] Could not save the off-when-back-online arms: ${(err as Error).message}`);
    });
    this.offWhenOnlineLastWrite = write;
    return write;
  }

  private async runOffWhenOnlineWrite(write: OffWhenOnlineWrite): Promise<void> {
    const snapshot = this.offWhenOnlineSnapshot();
    const ids = new Set(Object.keys(snapshot));
    write.ids = ids;
    this.offWhenOnlineRunningWrite = write;
    try {
      await this.writeOffWhenOnlineFile(snapshot);
      this.offWhenOnlineDurableIds = new Set(ids);
    } catch (err) {
      // The temp file and the rename should leave the previous file whole, but
      // a failed write is not trusted: the file is in doubt for its ids too.
      for (const id of ids) this.offWhenOnlineDurableIds?.add(id);
      throw err;
    } finally {
      write.settled = true;
      if (this.offWhenOnlineRunningWrite === write) this.offWhenOnlineRunningWrite = null;
    }
  }

  private async writeOffWhenOnlineFile(snapshot: Record<string, PersistedOffWhenOnline>): Promise<void> {
    const target = TclCloud.OFF_WHEN_ONLINE_FILE;
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(snapshot));
    await rename(temp, target);
  }

  private offWhenOnlineSnapshot(): Record<string, PersistedOffWhenOnline> {
    const data: Record<string, PersistedOffWhenOnline> = {};
    for (const [id, { armedAt, epochAt }] of this.pendingOffWhenOnline) {
      data[id] = { armedAt, epochAt };
    }
    return data;
  }

  /** The startup read. Never rejects: see `readOffWhenOnlineFile`. */
  private async loadOffWhenOnline(): Promise<void> {
    await this.readOffWhenOnlineFile();
  }

  /**
   * No file (first run) means nothing is armed. A file that cannot be read is
   * logged LOUDLY (what it holds stays unknown: `offWhenOnlineDurableIds`
   * null). A file that is not a JSON object of arms is CORRUPT: logged LOUDLY
   * and moved aside (`.corrupt-<time>`) for a human to inspect, never silently
   * taken for "nothing armed"; a restart revives no arm from it either, so it
   * counts as holding none. Malformed single entries are skipped.
   */
  private async readOffWhenOnlineFile(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(TclCloud.OFF_WHEN_ONLINE_FILE, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.offWhenOnlineDurableIds = new Set();
        return;
      }
      log.error(`[tcl] Could not read the off-when-back-online arms (${(err as Error).message}): starting with none armed`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      await this.setAsideCorruptOffWhenOnlineFile();
      this.offWhenOnlineDurableIds = new Set();
      return;
    }
    this.offWhenOnlineDurableIds = new Set(Object.keys(parsed));
    let superseded = false;
    type Entry = Partial<Record<keyof PersistedOffWhenOnline, unknown>> | null;
    for (const [id, entry] of Object.entries(parsed as Record<string, Entry>)) {
      if (entry == null || typeof entry.armedAt !== "number") continue;
      // An arm or disarm made since construction is newer than this file.
      if (this.offWhenOnlineTouched.has(id)) {
        superseded = true;
        continue;
      }
      // Out of scope (see setOffWhenOnline): never revive a leveled room's arm.
      if (isAcLevelingEligible(id)) {
        log.warn(`[tcl] Ignoring the persisted off-when-back-online arm for ${id}: a Smart AC Leveling AC`);
        superseded = true;
        continue;
      }
      this.pendingOffWhenOnline.set(id, newOffWhenOnline(id, entry.armedAt, entry));
    }
    // The file still holds what a newer change replaced or the scope rule
    // dropped: rewrite it.
    if (superseded) void this.saveOffWhenOnline();
  }

  private async setAsideCorruptOffWhenOnlineFile(): Promise<void> {
    const file = TclCloud.OFF_WHEN_ONLINE_FILE;
    const aside = `${file}.corrupt-${Date.now()}`;
    try {
      await rename(file, aside);
      log.error(`[tcl] The off-when-back-online arm file is CORRUPT (not a JSON object of arms): moved aside to ${aside}; starting with none armed`);
    } catch (err) {
      log.error(`[tcl] The off-when-back-online arm file is CORRUPT (not a JSON object of arms) and could not be moved aside (${(err as Error).message}); starting with none armed`);
    }
  }

  // ---------- Last State Persistence ----------

  /** Freeze the last known manual state across an attributed mains event. */
  preparePowerCycleRestore(deviceId: string): boolean {
    // Defense in depth for the collector-side gate: last-state restore is
    // granted per VERIFIED physical wiring (currently guest alone), never
    // inferred from the absence of other flags. Refusing every non-restore-
    // eligible id subsumes the leveling case — Smart AC Leveling owns a
    // leveling-eligible AC's generatorMode/fan and clamps it to floors across a
    // changeover, so a frozen republish would fight that clamp — and it also
    // fails closed for unknown future ACs whose line may yet be leveler-owned.
    if (!isPowerCycleRestoreEligible(deviceId)) {
      log.warn(`[tcl] Refusing last-state restore for ${deviceId} — not verified restore-eligible physical wiring`);
      return false;
    }
    // The owner asked for this unit to come back OFF: a restore would republish
    // its pre-event ON state over that intent.
    if (this.pendingOffWhenOnline.has(deviceId)) {
      log.warn(`[tcl] Refusing last-state restore for ${deviceId}: off-when-back-online is armed`);
      return false;
    }
    const saved = this.lastState[deviceId];
    if (!saved || Object.keys(saved).length === 0) return false;
    this.pendingPowerCycleRestores.set(deviceId, {
      state: { ...saved },
      armedAt: Date.now(),
      attempts: 0,
      lastSentAt: 0,
    });
    log.info(`[tcl] Armed last-state restore for ${deviceId} after power event`);
    return true;
  }

  /**
   * Returns true while normal state persistence must remain frozen. Restoration
   * starts only from a post-event ON report, then stays frozen until the
   * reported shadow confirms the saved values. A bounded resend handles TCL's
   * occasional accepted-but-ignored publish.
   */
  private async maybeRestorePowerCycleState(
    deviceId: string,
    shadow: Record<string, number>,
    reportedAt: number | null,
    isChsa: boolean,
  ): Promise<boolean> {
    const pending = this.pendingPowerCycleRestores.get(deviceId);
    if (!pending) return false;
    const now = Date.now();
    // Waiting for the first post-event ON may legitimately take hours while a
    // grid-only unit is unpowered on generator. Only bound the confirmation
    // phase after at least one restore was actually published.
    if (pending.attempts > 0 && now - pending.lastSentAt > 2 * 60_000) {
      this.pendingPowerCycleRestores.delete(deviceId);
      log.warn(`[tcl] Last-state restore for ${deviceId} expired without confirmation`);
      return false;
    }
    if (shadow.powerSwitch !== 1) return true;
    // AWS metadata is second-resolution. Require a strictly post-event report;
    // a same-second persisted ON shadow can otherwise consume the restore just
    // before a grid-only unit actually loses power.
    if (reportedAt == null || reportedAt <= pending.armedAt) return true;

    const payload = this.restorableState(deviceId, pending.state);
    const confirmed = Object.entries(payload).every(([key, value]) => shadow[key] === value);
    if (confirmed) {
      this.pendingPowerCycleRestores.delete(deviceId);
      log.info(`[tcl] Last-state restore for ${deviceId} confirmed`);
      return false;
    }

    if (pending.attempts <= CONTROL_VERIFY_MAX_RESENDS && now - pending.lastSentAt >= CONTROL_VERIFY_DELAY_MS) {
      // A user command (control or verified preset) can delete this pending entry
      // between the early capture above and here. Re-check identity immediately
      // before the publish so a cancelled restore cannot revert the user's value.
      // The residual window — a cancellation landing mid-network-call — is healed
      // by sendControlVerified/executeAcActionVerified's confirm-or-resend loops,
      // which re-assert the user's value within ~5 s.
      if (this.pendingPowerCycleRestores.get(deviceId) !== pending) return false;
      await this.publishRestorableState(deviceId, payload, isChsa);
      pending.attempts += 1;
      pending.lastSentAt = now;
      log.info(`[tcl] Restoring frozen pre-event state for ${deviceId} (attempt ${pending.attempts})`);
    }
    return true;
  }

  private saveStateProps(deviceId: string, shadow: Record<string, number>, isChsa: boolean): void {
    if (this.pendingPowerCycleRestores.has(deviceId)) return;
    // Armed off-when-back-online: the unit returns in its reboot-default ON
    // state, which must not overwrite the frozen pre-outage settings. Saving
    // resumes once the arm resolves.
    if (this.pendingOffWhenOnline.has(deviceId)) return;
    const props = isChsa ? TclCloud.SAVE_PROPS_CHSA : TclCloud.SAVE_PROPS_OTHER;
    const state: Record<string, unknown> = {};
    for (const p of props) {
      if (p in shadow) state[p] = shadow[p];
    }
    if (Object.keys(state).length > 0) {
      this.lastState[deviceId] = state;
      this.saveLastState();
    }
  }

  async executeAcAction(
    deviceId: string,
    action: AcAction,
    options: AcActionExecutionOptions = {},
  ): Promise<AcActionExecutionResult> {
    const { preserveProfileIntent = false, suppressWhileManualPresetPending = false, stillCurrent, onPublish } = options;
    if (stillCurrent && !stillCurrent()) throw new ControlSupersededError(deviceId);
    if (!preserveProfileIntent) {
      // A verified preset is explicit, newer user intent. Until its shadow is
      // confirmed and the route reloads the matching automation profile, the
      // collector can still hold the previous rule for one tick. Suppress that
      // stale background enforcement instead of letting it cancel or overwrite
      // the pending manual profile. Direct UI controls use sendControlVerified,
      // which still bump the generation and intentionally supersede the preset.
      if (suppressWhileManualPresetPending && this.pendingManualProfiles.has(deviceId)) {
        log.info(`[tcl] Background AC action on ${deviceId} suppressed while a manual preset is pending`);
        return "suppressed";
      }
      this.bumpProfileGeneration(deviceId);
    }
    await this.ensureDeviceCachePopulated();
    const safeAction = this.sanitizeAcAction(deviceId, action);
    if (!safeAction) throw new Error(`Unknown AC device: ${deviceId}`);

    // A raw OFF sent here (leveler shed, automation off, timer, calibration) is
    // newer, protective intent than a pending dashboard set_power command: claim
    // the generation so that command's verify loop stops instead of reading this
    // landed OFF as "my ON not applied" and re-sending it (2026-09-26 14:26Z: a
    // user-ON verifier re-sent ON 2.8 s after the leveler's power_off), and so an
    // initial dashboard ON still waiting to publish is never sent at all (the
    // publish-boundary guard in sendControl). Only an OFF supersedes: a raw ON (a
    // leveler restore, an automation) must never silence the user's own OFF
    // (manual wins; that off is already locked and its verifier keeps re-sending).
    // A guarded caller is re-checked in the same tick as the claim: one that went
    // stale during the await above must not stop a newer user command.
    if (safeAction.power === 0) {
      if (stillCurrent && !stillCurrent()) throw new ControlSupersededError(deviceId);
      this.supersedeControlVerify(deviceId, "set_power");
    }

    if (safeAction.power === 0) {
      await this.sendControl(deviceId, "set_power", 0, false, true, stillCurrent, onPublish);
      return "applied";
    }

    const desired = this.buildProfileShadowPayload(deviceId, safeAction);
    const hasProfile = Object.keys(desired).length > 0;

    if (safeAction.power === 1) {
      if (!hasProfile) {
        await this.sendControl(deviceId, "set_power", 1, false, true);
        return "applied";
      }
      await this.publishWithRetry(deviceId, { powerSwitch: 1 });
      log.info(`[tcl] Power ON sent to device ${deviceId}, waiting for boot`);
      await new Promise(r => setTimeout(r, 3000));
      // The ON is on its way to the unit from here: a profile failure must not
      // read as "nothing was sent" to a caller that books ONs (the leveler's
      // restore, the collector's server-ON stamp). See AcProfileNotAppliedError.
      try {
        await this.publishAcProfile(deviceId, desired);
      } catch (err) {
        throw new AcProfileNotAppliedError(deviceId, err);
      }
      return "applied";
    }

    if (hasProfile) await this.publishAcProfile(deviceId, desired);
    return "applied";
  }

  /**
   * Manual preset delivery with bounded shadow confirmation. Unlike a series
   * of direct controls, the profile is validated against physical support and
   * published atomically (with the CHSD fan split), so a Fan→Cool+Eco preset
   * cannot race current-mode availability. Ignored firmware publishes are
   * re-sent as the exact same split profile and a final failure is surfaced to
   * the caller instead of silently reporting success.
   */
  async executeAcActionVerified(deviceId: string, action: AcAction): Promise<AcVerifiedProfileResult> {
    // An armed "off when back online" is cancelled by the preset route at its
    // entry, not here: an arm accepted while this request waited is newer than
    // the preset and must survive it (2026-10-10).
    await this.ensureDeviceCachePopulated();
    // A verified preset is newer user intent than any frozen last-state
    // snapshot: cancel a pending restore (un-freezing state-save) before the
    // first publish so it cannot revert the preset. LOUD by design.
    if (this.pendingPowerCycleRestores.has(deviceId)) {
      this.pendingPowerCycleRestores.delete(deviceId);
      log.info(`[tcl] Pending last-state restore for ${deviceId} cancelled by verified preset`);
    }
    const safeAction = this.sanitizeAcAction(deviceId, action);
    if (!safeAction) throw new Error(`Unknown AC device: ${deviceId}`);
    const desired = this.buildProfileShadowPayload(deviceId, safeAction);
    const generation = this.bumpProfileGeneration(deviceId);
    this.pendingManualProfiles.set(deviceId, generation);
    try {
      if (Object.keys(desired).length === 0) {
        await this.executeAcAction(deviceId, safeAction, { preserveProfileIntent: true });
        return "applied";
      }

      let pre: Record<string, number> | null = null;
      try {
        pre = (await this.getThingShadow(deviceId)).reported;
      } catch {
        // Retry confirmation still works; only third-value detection degrades.
      }

      if (this.profileGenerations.get(deviceId) !== generation) return "superseded";
      await this.executeAcAction(deviceId, safeAction, { preserveProfileIntent: true });
      for (let attempt = 1; attempt <= CONTROL_VERIFY_MAX_RESENDS + 1; attempt++) {
        await this.controlVerifyDelay();
        if (this.profileGenerations.get(deviceId) !== generation) {
          log.info(`[tcl] Preset profile on ${deviceId} superseded by a newer profile — verify stopped`);
          return "superseded";
        }
        const reported = (await this.getThingShadow(deviceId)).reported;
        const mismatched = Object.keys(desired).filter((key) => reported[key] !== desired[key]);
        if (mismatched.length === 0) {
          if (attempt > 1) log.info(`[tcl] Preset profile on ${deviceId} confirmed after ${attempt - 1} re-send(s)`);
          return "applied";
        }
        const external = mismatched.some(
          (key) => pre != null && key in pre && reported[key] !== pre[key],
        );
        if (external) {
          throw new Error(`Preset interrupted by another change (${mismatched.map((key) => `${key}=${reported[key]}`).join(", ")})`);
        }
        if (attempt > CONTROL_VERIFY_MAX_RESENDS) {
          throw new Error(`Preset was not applied after ${CONTROL_VERIFY_MAX_RESENDS} re-sends`);
        }
        log.info(`[tcl] Preset profile on ${deviceId} not applied — re-sending (${attempt}/${CONTROL_VERIFY_MAX_RESENDS})`);
        await this.publishAcProfile(deviceId, desired);
      }
      throw new Error("Preset verification ended unexpectedly");
    } finally {
      if (this.pendingManualProfiles.get(deviceId) === generation) {
        this.pendingManualProfiles.delete(deviceId);
      }
    }
  }

  private profileGenerations = new Map<string, number>();
  private pendingManualProfiles = new Map<string, number>();

  private bumpProfileGeneration(deviceId: string): number {
    const generation = (this.profileGenerations.get(deviceId) ?? 0) + 1;
    this.profileGenerations.set(deviceId, generation);
    return generation;
  }

  private async publishAcProfile(deviceId: string, desired: Record<string, unknown>): Promise<void> {
    const { main, fan } = this.splitFanPayload(deviceId, desired);
    if (fan) {
      await this.publishWithRetry(deviceId, main);
      log.info(`[tcl] Profile (main) applied to ${deviceId}: ${JSON.stringify(main)}`);
      await this.profileSplitDelay();
      await this.publishWithRetry(deviceId, fan);
      log.info(`[tcl] Profile (fan) applied to ${deviceId}: ${JSON.stringify(fan)}`);
    } else {
      await this.publishWithRetry(deviceId, main);
      log.info(`[tcl] Profile applied to device ${deviceId}: ${JSON.stringify(main)}`);
    }
  }

  /**
   * Peel the fan block off a shadow payload so it can travel alone.
   *
   * A TAC-12CHSD silently drops the fan whenever it shares an update with ANY
   * other property: it applies the other property, internally resets the
   * blower, and still REPORTS the fan as applied — so `computeAcDiff` sees no
   * diff and never retries, leaving the unit blowing low while the dashboard
   * reads max. Found with `workMode` (2026-05-10); widened to every companion
   * property on 2026-07-27, when a fan + swing re-enforcement after a
   * changeover reboot pinned Abdu AC low for 13 minutes.
   *
   * `fan` is null when no split is needed — the payload has no fan block, has
   * nothing else to conflict with, or the device is a Najat (unaffected).
   */
  private splitFanPayload(
    deviceId: string,
    desired: Record<string, unknown>,
  ): { main: Record<string, unknown>; fan: Record<string, unknown> | null } {
    if (this.isChsaModel(deviceId)) return { main: desired, fan: null };
    const main: Record<string, unknown> = {};
    const fan: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(desired)) {
      if (TCL_12CHSD_FAN_KEYS.includes(key)) fan[key] = value;
      else main[key] = value;
    }
    const splittable = Object.keys(fan).length > 0 && Object.keys(main).length > 0;
    return splittable ? { main, fan } : { main: desired, fan: null };
  }

  /** Test seam for the settle gap between the main and fan halves of a split payload. */
  protected profileSplitDelay(): Promise<void> {
    return new Promise((r) => setTimeout(r, PROFILE_SPLIT_DELAY_MS));
  }

  /**
   * The exact desired-shadow payload sendControl publishes for a UI command,
   * or null for commands the verify-resend layer must not touch:
   * set_generator_mode (the leveler's pendingSendCounts/unreachable machinery
   * owns its retries — a second retry path would corrupt the counts),
   * set_beep (sticky beep-off enforcement already re-sends), and
   * set_fan_speed 0 (hands control back to the range automation, which
   * re-enforces on its own).
   */
  private controlShadowPayload(deviceId: string, command: string, value: unknown): Record<string, number> | null {
    if (typeof value !== "number") return null;
    if (command === "set_generator_mode" || command === "set_beep") return null;
    if (command === "set_fan_speed" && value === 0) return null;
    if (command === "set_vertical_swing" || command === "set_horizontal_swing") {
      const prefix = command === "set_vertical_swing" ? "vertical" : "horizontal";
      const switchProp = this.isChsaModel(deviceId) ? `${prefix}Wind` : `${prefix}Switch`;
      if (value === 0) return { [switchProp]: 0, [`${prefix}Direction`]: 8 };
      if (value >= 1 && value <= 4) return { [switchProp]: 1, [`${prefix}Direction`]: value };
      if (value >= 9 && value <= 13) return { [switchProp]: 0, [`${prefix}Direction`]: value };
      return null;
    }
    if (command === "set_fan_speed" && !this.isChsaModel(deviceId)) {
      if (value === 1) return { windSpeed: 0, silenceSwitch: 1, turbo: 0 };
      if (value === 7) return { windSpeed: 0, silenceSwitch: 0, turbo: 1 };
      return { windSpeed: value, silenceSwitch: 0, turbo: 0 };
    }
    const propMap: Record<string, string> = {
      set_power: "powerSwitch",
      set_mode: "workMode",
      set_temperature: "targetTemperature",
      set_fan_speed: "windSpeed7Gear",
      set_eco: "ECO",
      set_screen: "screen",
      set_sleep: "sleep",
      set_turbo: "turbo",
      set_fresh_air: "newWindSwitch",
    };
    const prop = propMap[command];
    return prop ? { [prop]: value } : buildAdvancedControlPayload(command, value);
  }

  /** Test seam for the verify-resend pacing. */
  protected controlVerifyDelay(): Promise<void> {
    return new Promise((r) => setTimeout(r, CONTROL_VERIFY_DELAY_MS));
  }

  /**
   * UI command with confirm-or-resend (user decision 2026-06-11, "5 sec for
   * retry for 3 times"): Najat's firmware routinely accepts a command and
   * never applies it — the shadow keeps reporting the pre-command value. After
   * the normal send, the reported shadow is re-checked every 5s; while it
   * still shows the PRE-command value the command is re-published, up to 3
   * times. An observed move to a THIRD value stops the loop (a genuine
   * remote/manual change wins). Re-sends publish the raw desired payload —
   * they bypass sendControl so a power-on retry can't re-trigger
   * restoreLastState, and they bypass the route hooks so no duplicate
   * manual-intent recording happens.
   */
  async sendControlVerified(
    deviceId: string,
    command: string,
    value: unknown,
    /**
     * The caller's post-send bookkeeping, SYNCHRONOUS, invoked in the same tick
     * as the final "still current" check and only when it passes (2026-09-27,
     * Sol round 6). The caller cannot do this after awaiting the result: a newer
     * command can claim the field in the microtask gap between this function's
     * return and the caller's continuation, and ON bookkeeping would then land
     * on top of it. Never invoked for a superseded outcome.
     */
    onSent?: () => void,
  ): Promise<VerifiedControlOutcome> {
    // A newer direct user command makes any pending frozen last-state snapshot
    // stale: cancel it (which also un-freezes state-save, since the user's new
    // state is now the one to remember) so the restore cannot revert this write
    // five seconds later. LOUD by design — a silent cancellation is the next
    // forensic mystery.
    if (this.pendingPowerCycleRestores.has(deviceId)) {
      this.pendingPowerCycleRestores.delete(deviceId);
      log.info(`[tcl] Pending last-state restore for ${deviceId} cancelled by direct user command`);
    }
    // An armed "off when back online" is cancelled by the control route, its
    // only caller, synchronously at the request's entry (`cancelOffWhenOnline`),
    // not here: an arm accepted while this command waited on validation is
    // newer and must survive it (2026-10-10).
    // Any newer direct user intent cancels an older whole-profile verifier so
    // that its retry cannot overwrite this command five seconds later.
    this.bumpProfileGeneration(deviceId);
    // Claim a generation for this device+command BEFORE the first send — any
    // older verify loop for the same field now sees a newer generation and
    // stops (last-write-wins). Bumped for every call, so even a no-verify
    // command (e.g. fan Auto) supersedes an in-flight verify of the same field.
    const genKey = `${deviceId}:${command}`;
    const generation = (this.controlGenerations.get(genKey) ?? 0) + 1;
    this.controlGenerations.set(genKey, generation);
    this.controlClaimedBy.set(genKey, "user");
    const stillCurrent = () => this.controlGenerations.get(genKey) === generation;
    const lostTo = (): VerifiedControlOutcome =>
      this.controlClaimedBy.get(genKey) === "user" ? "superseded_by_user" : "superseded";

    const payload = this.controlShadowPayload(deviceId, command, value);
    let pre: Record<string, number> | null = null;
    if (payload) {
      try {
        pre = (await this.getThingShadow(deviceId)).reported;
      } catch {
        // No pre-state — verification still runs, external-change detection degrades gracefully.
      }
    }
    // RULE A (2026-09-27, Sol rechecks 3-5): every publish this command can make
    // is guarded at its publish boundary (`publishControl`: the check and the
    // publish start in the same tick, after every token/re-auth await): the
    // initial send, the saved-state restore that follows a power ON inside
    // sendControl, and every verifier resend. A newer command of the same field
    // (a protective OFF through executeAcAction, another dashboard tap) that
    // claimed the generation during ANY wait wins; per-await checks kept missing
    // the next await.
    try {
      await this.sendControl(deviceId, command, value, false, true, stillCurrent);
    } catch (err) {
      if (!(err instanceof ControlSupersededError)) throw err;
      log.warn(`[tcl] ${command}=${String(value)} on ${deviceId} superseded by a newer command before it was sent; not sent`);
      return lostTo();
    }
    // RULE B: the outcome reflects the FINAL generation. A newer command that
    // arrived after our publish (e.g. a leveler OFF while the power ON's
    // saved-state restore waited) owns the field now; reporting "sent" would let
    // the caller run ON bookkeeping over it (the route's onUserPowerOn clearing
    // the newer shed). No verify loop either: it would only stop at once.
    if (!stillCurrent()) {
      log.warn(`[tcl] ${command}=${String(value)} on ${deviceId} was sent, then superseded by a newer command; reporting superseded`);
      return lostTo();
    }
    // Same tick as the check above: nothing can claim the field in between.
    onSent?.();
    if (!payload) return "sent";
    // Fire-and-forget — the route responds immediately; kept on a field so
    // tests can await the loop.
    this.lastControlVerify = this.verifyControlApplied(deviceId, command, payload, pre, generation, stillCurrent).catch((err) => {
      log.warn(`[tcl] Verify-resend loop failed for ${command} on ${deviceId}: ${(err as Error).message}`);
    });
    return "sent";
  }

  private lastControlVerify: Promise<void> | null = null;

  /**
   * Last-write-wins generation per `(deviceId, command)` — bumped by every
   * sendControlVerified call, keyed by command KIND so a `set_power` never
   * cancels an unrelated field's verify. A verify loop captures the generation
   * at send time and stops the moment a newer verified send of the SAME field
   * has bumped it. Power is a BINARY field, so the pre-existing third-value
   * escape below can never fire for it (the only "other" value IS the
   * pre-command value); two overlapping set_power loops therefore each read the
   * other's landed value as "my command not applied" and re-sent — off→on→off→on
   * over 24s, physically cycling Najat's compressor (2026-08-08 05:55). This
   * makes the older loop yield to the newer one.
   */
  private controlGenerations = new Map<string, number>();

  /**
   * Bump a verify generation without starting a loop: any pending verifier of
   * that field stops, and a command of it still waiting to publish is never
   * sent. `by` words the loser's outcome: a raw OFF is "system", an
   * off-when-online arm is the user's.
   */
  private supersedeControlVerify(deviceId: string, command: string, by: "user" | "system" = "system"): void {
    const genKey = `${deviceId}:${command}`;
    this.controlGenerations.set(genKey, (this.controlGenerations.get(genKey) ?? 0) + 1);
    this.controlClaimedBy.set(genKey, by);
  }

  /** Who made the latest generation claim per `(deviceId, command)`: a dashboard
   * command or an off-when-online arm ("user"), or a raw OFF through
   * executeAcAction ("system"). Only read to word a superseded outcome honestly. */
  private controlClaimedBy = new Map<string, "user" | "system">();

  private async verifyControlApplied(
    deviceId: string,
    command: string,
    payload: Record<string, number>,
    pre: Record<string, number> | null,
    generation: number,
    stillCurrent: () => boolean,
  ): Promise<void> {
    const genKey = `${deviceId}:${command}`;
    for (let attempt = 1; attempt <= CONTROL_VERIFY_MAX_RESENDS + 1; attempt++) {
      await this.controlVerifyDelay();
      // A newer verified send of the SAME field started while we were waiting —
      // yield to it (last-write-wins). Without this, two overlapping binary
      // set_power loops re-send against each other, cycling the compressor
      // (2026-08-08). An EXTERNAL opposing change during a binary verify stays
      // indistinguishable from "not applied" and is still bounded by the 3
      // re-sends; this only removes the OUR-vs-OURS fight the log showed.
      if (this.controlGenerations.get(genKey) !== generation) {
        log.info(`[tcl] ${command} on ${deviceId} superseded by a newer command — verify stopped`);
        return;
      }
      const reported = (await this.getThingShadow(deviceId)).reported;
      // …and again after every await: a newer command can arrive while the
      // shadow read is in flight, and this loop must not republish over it
      // (2026-09-27: the check above alone let a leveler OFF that landed during
      // the read be answered with the user's stale ON).
      if (this.controlGenerations.get(genKey) !== generation) {
        log.info(`[tcl] ${command} on ${deviceId} superseded by a newer command during the shadow read; verify stopped`);
        return;
      }
      const mismatched = Object.keys(payload).filter((k) => reported[k] !== payload[k]);
      if (mismatched.length === 0) {
        if (attempt > 1) log.info(`[tcl] ${command} on ${deviceId} confirmed after ${attempt - 1} re-send(s)`);
        return;
      }
      const external = mismatched.some(
        (k) => pre != null && k in pre && reported[k] !== pre[k],
      );
      if (external) {
        log.info(`[tcl] ${command} on ${deviceId}: shadow moved to a third value (${mismatched.map((k) => `${k}=${reported[k]}`).join(", ")}) — external change wins, verify stopped`);
        return;
      }
      if (attempt > CONTROL_VERIFY_MAX_RESENDS) {
        log.warn(`[tcl] ${command} on ${deviceId} still not applied after ${CONTROL_VERIFY_MAX_RESENDS} re-sends (shadow still ${mismatched.map((k) => `${k}=${reported[k]}`).join(", ")}) — giving up`);
        return;
      }
      log.info(`[tcl] ${command} on ${deviceId} not applied (shadow still ${mismatched.map((k) => `${k}=${reported[k]}`).join(", ")}) — re-sending (${attempt}/${CONTROL_VERIFY_MAX_RESENDS})`);
      // RULE A: the resend is guarded at its publish boundary, after the token
      // wait and any re-auth inside publishWithRetry (the checks above cannot
      // see a newer command that arrives during those awaits).
      try {
        await this.publishWithRetry(deviceId, payload, stillCurrent);
      } catch (err) {
        if (!(err instanceof ControlSupersededError)) throw err;
        log.info(`[tcl] ${command} on ${deviceId} superseded by a newer command before its resend; verify stopped`);
        return;
      }
    }
  }

  private async publishWithRetry(
    deviceId: string,
    payload: Record<string, unknown>,
    /** Publish-boundary guard, see sendControl. */
    stillCurrent?: () => boolean,
  ): Promise<void> {
    await this.ensureValidTokens();
    try {
      await this.publishControl(deviceId, payload, stillCurrent);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      const name = (err as { name?: string }).name ?? "";
      if (msg.includes("403") || msg.includes("Forbidden") || name.includes("Credential") || name.includes("ExpiredToken")) {
        log.warn(`[tcl] Shadow publish failed (${name}), forcing re-auth and retrying`);
        this.awsCreds = null;
        this.tokenExpiry = 0;
        this.tokenData = null;
        await this.ensureValidTokens();
        await this.publishControl(deviceId, payload, stillCurrent);
      } else {
        throw err;
      }
    }
  }

  private buildProfileShadowPayload(deviceId: string, action: AcAction): Record<string, unknown> {
    const chsa = this.isChsaModel(deviceId);
    const capabilities = this.cachedDevices.find((device) => device.id === deviceId)?.capabilities;
    const supports = (command: string, value: unknown) => capabilities != null && supportsAcCommand(capabilities, command, value);
    const desired: Record<string, unknown> = {};

    if (action.mode != null && supports("set_mode", action.mode)) {
      desired.workMode = action.mode;
    }

    if (action.temperature != null && supports("set_temperature", action.temperature)) {
      desired.targetTemperature = action.temperature;
    }

    if (action.fan_speed != null && supports("set_fan_speed", action.fan_speed)) {
      if (chsa) {
        desired.windSpeed7Gear = action.fan_speed;
      } else {
        const v = action.fan_speed;
        if (v === 1) {
          desired.windSpeed = 0;
          desired.silenceSwitch = 1;
          desired.turbo = 0;
        } else if (v === 7) {
          desired.windSpeed = 0;
          desired.silenceSwitch = 0;
          desired.turbo = 1;
        } else {
          desired.windSpeed = v;
          desired.silenceSwitch = 0;
          desired.turbo = 0;
        }
      }
    }

    if (action.eco != null && supports("set_eco", action.eco)) {
      desired.ECO = action.eco;
    }

    // Turbo: any fan_speed owns windSpeed/silenceSwitch/turbo atomically —
    // an explicit turbo must never override the fan block (1=silent, 7=turbo)
    if (action.turbo != null && action.fan_speed == null && supports("set_turbo", action.turbo)) {
      desired.turbo = action.turbo;
    }

    if (action.screen != null && supports("set_screen", action.screen)) {
      desired.screen = action.screen;
    }

    if (action.vertical_swing != null && supports("set_vertical_swing", action.vertical_swing)) {
      const v = action.vertical_swing;
      const switchProp = chsa ? "verticalWind" : "verticalSwitch";
      if (v === 0) {
        desired[switchProp] = 0;
        desired.verticalDirection = 8;
      } else if (v >= 1 && v <= 4) {
        desired[switchProp] = 1;
        desired.verticalDirection = v;
      } else if (v >= 9 && v <= 13) {
        desired[switchProp] = 0;
        desired.verticalDirection = v;
      }
    }

    if (action.horizontal_swing != null && supports("set_horizontal_swing", action.horizontal_swing)) {
      const v = action.horizontal_swing;
      const switchProp = chsa ? "horizontalWind" : "horizontalSwitch";
      if (v === 0) {
        desired[switchProp] = 0;
        desired.horizontalDirection = 8;
      } else if (v >= 1 && v <= 4) {
        desired[switchProp] = 1;
        desired.horizontalDirection = v;
      } else if (v >= 9 && v <= 13) {
        desired[switchProp] = 0;
        desired.horizontalDirection = v;
      }
    }

    if (action.fresh_air != null && supports("set_fresh_air", action.fresh_air)) {
      desired.newWindSwitch = action.fresh_air;
    }

    if (action.generator_mode != null && supports("set_generator_mode", action.generator_mode)) {
      // Stored profiles/presets may predate a firmware level-count reduction
      desired.generatorMode = this.clampGeneratorMode(deviceId, action.generator_mode);
    }

    return desired;
  }

  private async restoreLastState(deviceId: string, stillCurrent?: () => boolean): Promise<void> {
    const saved = this.lastState[deviceId];
    if (!saved || Object.keys(saved).length === 0) return;
    try {
      await new Promise(r => setTimeout(r, 1000));
      const payload = this.restorableState(deviceId, saved);
      await this.publishRestorableState(deviceId, payload, this.isChsaModel(deviceId), stillCurrent);
      log.info(`[tcl] Restored last state for device ${deviceId}:`, JSON.stringify(payload));
    } catch (err) {
      if (err instanceof ControlSupersededError) {
        // The ON this restore belonged to was overridden while it waited: its
        // saved profile must not land on top of the newer command (RULE A).
        log.info(`[tcl] Last-state restore for ${deviceId} stopped: its power ON was superseded by a newer command`);
        return;
      }
      log.warn(`[tcl] Failed to restore last state for ${deviceId}:`, (err as Error).message);
    }
  }

  private restorableState(deviceId: string, saved: Record<string, unknown>): Record<string, unknown> {
    // Defensive migration: one-shot maintenance actions must never restart.
    const { selfClean: _selfClean, ...restorable } = saved;
    return typeof restorable.generatorMode === "number"
      ? { ...restorable, generatorMode: this.clampGeneratorMode(deviceId, restorable.generatorMode) }
      : restorable;
  }

  private async publishRestorableState(
    deviceId: string,
    payload: Record<string, unknown>,
    isChsa: boolean,
    stillCurrent?: () => boolean,
  ): Promise<void> {
    // The CHSD fan block must travel alone. Use the explicit current-shadow
    // family during power-cycle recovery because the cached device can still
    // describe the pre-event report.
    const split = isChsa ? { main: payload, fan: null } : this.splitFanPayload(deviceId, payload);
    await this.publishControl(deviceId, split.main, stillCurrent);
    if (split.fan) {
      await this.profileSplitDelay();
      await this.publishControl(deviceId, split.fan, stillCurrent);
    }
  }

  private saveLastState(): void {
    writeFile(TclCloud.STATE_FILE, JSON.stringify(this.lastState)).catch(() => {});
  }

  private loadLastState(): void {
    readFile(TclCloud.STATE_FILE, "utf-8")
      .then(raw => { this.lastState = JSON.parse(raw); })
      .catch(() => {});
  }

  // ---------- Credential Persistence ----------

  private async saveCredentials(): Promise<void> {
    try {
      const state: PersistedState = {
        authData: this.authData ?? undefined,
        tokenData: this.tokenData ?? undefined,
        awsCreds: this.awsCreds ?? undefined,
        tokenExpiry: this.tokenExpiry,
        baseApiUrl: this.baseApiUrl,
      };
      await writeFile(CREDENTIALS_FILE, JSON.stringify(state));
      log.info("[tcl] Credentials saved");
    } catch (err) {
      log.warn("[tcl] Failed to save credentials:", (err as Error).message);
    }
  }

  private async loadCredentials(): Promise<void> {
    try {
      const raw = await readFile(CREDENTIALS_FILE, "utf-8");
      const state = JSON.parse(raw) as PersistedState;
      this.authData = state.authData ?? null;
      this.tokenData = state.tokenData ?? null;
      this.awsCreds = state.awsCreds ?? null;
      this.tokenExpiry = state.tokenExpiry ?? 0;
      if (state.baseApiUrl) this.baseApiUrl = state.baseApiUrl;
      log.info("[tcl] Loaded cached credentials");
    } catch {
      // No cached credentials, will do fresh login
    }
  }
}
