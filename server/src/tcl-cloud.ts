import { createHash, createHmac } from "crypto";
import { readFile, writeFile } from "fs/promises";
import { IoTDataPlaneClient, PublishCommand } from "@aws-sdk/client-iot-data-plane";
import { childLogger } from "./logger.js";

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

/**
 * AC hardware model family — drives protocol differences (fan encoding,
 * swing property names, eco/turbo support, save-props list, temp step).
 * Detected from the shadow: presence of `autoGeneratorMode` → TAC-24CHSA
 * (Najat); absence → TAC-12CHSD (Abdu/Abdullah). Never infer the model from
 * maxGeneratorLevel — TCL changes level counts via firmware updates.
 */
export type AcModel = "TAC-24CHSA" | "TAC-12CHSD";

export interface AcDevice {
  id: string;
  name: string;
  model: AcModel;
  isOnline: boolean;
  /** Epoch ms of the device's last shadow report (null if unknown) — drives "last seen" + the offline check. */
  lastSeenAt: number | null;
  power: boolean;
  mode: number;
  targetTemp: number;
  currentTemp: number;
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
 * Max generator-mode level for ALL models since 2026-06: TCL removed levels
 * 4–6 from the TAC-24CHSA (Najat) via firmware/app update, standardizing on
 * the documented 3-level GEN mode (L1=30%, L2=50%, L3=70% of rated current).
 * The cloud still ACCEPTS set_generator_mode 4–6 but the firmware never
 * applies them (shadow keeps reporting the old value) — hence the clamp in
 * clampGeneratorMode().
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

  private static readonly STATE_FILE = "/app/data/ac-last-state.json";

  // Properties to save/restore per model type
  private static readonly SAVE_PROPS_NAJAT = [
    "workMode", "targetTemperature", "screen", "sleep",
    "verticalWind", "horizontalWind", "verticalDirection", "horizontalDirection",
    "generatorMode", "windSpeed7Gear", "newWindSwitch",
  ];
  private static readonly SAVE_PROPS_OTHER = [
    "workMode", "targetTemperature", "screen", "sleep",
    "verticalSwitch", "horizontalSwitch", "verticalDirection", "horizontalDirection",
    "generatorMode", "windSpeed", "ECO", "turbo", "silenceSwitch",
  ];

  constructor(username: string, password: string) {
    this.username = username;
    this.passwordMd5 = md5hex(password);
    this.loadLastState();
  }

  async init(): Promise<void> {
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
    return devices;
  }

  async ensureDeviceCachePopulated(): Promise<void> {
    if (this.cachedDevices.length === 0) {
      await this.fetchDevicesLive();
    }
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
    const skipTurbo = desired.fan_speed != null && !this.isNajatModel(deviceId);
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

  private isNajatModel(deviceId: string): boolean {
    const dev = this.cachedDevices.find(d => d.id === deviceId);
    return dev ? dev.model === "TAC-24CHSA" : false;
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

  async sendControl(deviceId: string, command: string, value: unknown, skipRestore = false): Promise<void> {
    await this.ensureValidTokens();

    // Handle power-on: restore last saved state
    if (command === "set_power" && value === 1) {
      const desired: Record<string, unknown> = { powerSwitch: 1 };
      try {
        await this.publishShadowUpdate(deviceId, desired);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        const name = (err as { name?: string }).name ?? "";
        if (msg.includes("403") || msg.includes("Forbidden") || name.includes("Credential") || name.includes("ExpiredToken")) {
          log.warn(`[tcl] Control publish failed (${name}), forcing re-auth and retrying`);
          this.awsCreds = null;
          this.tokenExpiry = 0;
          this.tokenData = null;
          await this.ensureValidTokens();
          await this.publishShadowUpdate(deviceId, desired);
        } else {
          throw err;
        }
      }
      log.info(`[tcl] Control ${command}=${value} → device ${deviceId}: OK`);
      if (!skipRestore) {
        await this.restoreLastState(deviceId);
      }
      return;
    }

    // Handle swing commands specially (sets both switch + direction)
    if (command === "set_vertical_swing" || command === "set_horizontal_swing") {
      const v = value as number;
      const prefix = command === "set_vertical_swing" ? "vertical" : "horizontal";
      const switchProp = this.isNajatModel(deviceId) ? `${prefix}Wind` : `${prefix}Switch`;
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
        await this.publishShadowUpdate(deviceId, desired);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        const name = (err as { name?: string }).name ?? "";
        if (msg.includes("403") || msg.includes("Forbidden") || name.includes("Credential") || name.includes("ExpiredToken")) {
          log.warn(`[tcl] Control publish failed (${name}), forcing re-auth and retrying`);
          this.awsCreds = null;
          this.tokenExpiry = 0;
          this.tokenData = null;
          await this.ensureValidTokens();
          await this.publishShadowUpdate(deviceId, desired);
        } else {
          throw err;
        }
      }
      log.info(`[tcl] Control ${command}=${value} → device ${deviceId}: OK`);
      return;
    }

    const najat = this.isNajatModel(deviceId);

    // Handle fan speed specially for non-Najat: 1=silent, 7=turbo/max
    if (command === "set_fan_speed" && !najat) {
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
        await this.publishShadowUpdate(deviceId, desired);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        const name = (err as { name?: string }).name ?? "";
        if (msg.includes("403") || msg.includes("Forbidden") || name.includes("Credential") || name.includes("ExpiredToken")) {
          log.warn(`[tcl] Control publish failed (${name}), forcing re-auth and retrying`);
          this.awsCreds = null;
          this.tokenExpiry = 0;
          this.tokenData = null;
          await this.ensureValidTokens();
          await this.publishShadowUpdate(deviceId, desired);
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
    if (!prop) throw new Error(`Unknown command: ${command}`);

    // Firmware ignores gen levels above the device max — send the clamped value
    if (command === "set_generator_mode" && typeof value === "number") {
      value = this.clampGeneratorMode(deviceId, value);
    }
    const desired: Record<string, unknown> = { [prop]: value };
    try {
      await this.publishShadowUpdate(deviceId, desired);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      const name = (err as { name?: string }).name ?? "";
      if (msg.includes("403") || msg.includes("Forbidden") || name.includes("Credential") || name.includes("ExpiredToken")) {
        log.warn(`[tcl] Control publish failed (${name}), forcing re-auth and retrying`);
        this.awsCreds = null;
        this.tokenExpiry = 0;
        this.tokenData = null;
        await this.ensureValidTokens();
        await this.publishShadowUpdate(deviceId, desired);
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
        if (this.awsCreds) {
          try {
            const result = await this.getThingShadow(dev.deviceId);
            shadow = result.reported;
            reportedAt = result.reportedAt;
          } catch (err) {
            log.warn(`[tcl] Shadow read failed for ${dev.deviceId}:`, (err as Error).message);
          }
        }
        // A persisted shadow alone no longer means "online" — it never clears
        // when the AC loses power, so a blacked-out AC read online forever.
        // Require the shadow to be fresh (last report within SHADOW_STALE_MS).
        const online = deviceOnline(tclOnline, Object.keys(shadow).length > 0, reportedAt, Date.now(), SHADOW_STALE_MS);

        const powerFromId = (dev.identifiers ?? []).find(i => i.identifier === "powerSwitch");

        // Najat uses different property names than Abdu/Abdullah
        const isNajatModel = 'autoGeneratorMode' in shadow;
        const vSwitch = isNajatModel ? shadow.verticalWind : shadow.verticalSwitch;
        const hSwitch = isNajatModel ? shadow.horizontalWind : shadow.horizontalSwitch;

        devices.push({
          id: dev.deviceId,
          name: dev.nickName || dev.deviceName || dev.deviceId,
          model: isNajatModel ? "TAC-24CHSA" : "TAC-12CHSD",
          isOnline: online,
          lastSeenAt: reportedAt,
          power: shadow.powerSwitch != null ? shadow.powerSwitch === 1 : powerFromId?.value === 1,
          mode: shadow.workMode ?? 0,
          targetTemp: shadow.targetTemperature ?? 24,
          currentTemp: shadow.currentTemperature ?? 0,
          fanSpeed: isNajatModel
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
          // 3 for ALL models since 2026-06 — TCL removed Najat's levels 4–6
          // (see MAX_GENERATOR_LEVEL). Kept per-device for future divergence.
          maxGeneratorLevel: MAX_GENERATOR_LEVEL,
          tempStep: isNajatModel ? 0.5 : 1,
          minFanSpeed: 1,
          maxFanSpeed: 7,
          beep: shadow.beepSwitch === 1,
        });

        // Save state when device is on (for restore on next power-on)
        if (shadow.powerSwitch === 1) {
          this.saveStateProps(dev.deviceId, shadow, isNajatModel);
        }
      }
    }

    return devices;
  }

  private async getThingShadow(deviceId: string): Promise<{ reported: Record<string, number>; reportedAt: number | null }> {
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
    };
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

  // ---------- Last State Persistence ----------

  private saveStateProps(deviceId: string, shadow: Record<string, number>, isNajat: boolean): void {
    const props = isNajat ? TclCloud.SAVE_PROPS_NAJAT : TclCloud.SAVE_PROPS_OTHER;
    const state: Record<string, unknown> = {};
    for (const p of props) {
      if (p in shadow) state[p] = shadow[p];
    }
    if (Object.keys(state).length > 0) {
      this.lastState[deviceId] = state;
      this.saveLastState();
    }
  }

  async executeAcAction(deviceId: string, action: AcAction): Promise<void> {
    if (action.power === 0) {
      await this.sendControl(deviceId, "set_power", 0);
      return;
    }

    const desired = this.buildProfileShadowPayload(deviceId, action);
    const hasProfile = Object.keys(desired).length > 0;

    if (action.power === 1) {
      if (!hasProfile) {
        await this.sendControl(deviceId, "set_power", 1);
        return;
      }
      await this.publishWithRetry(deviceId, { powerSwitch: 1 });
      log.info(`[tcl] Power ON sent to device ${deviceId}, waiting for boot`);
      await new Promise(r => setTimeout(r, 3000));
    }

    if (hasProfile) {
      const najat = this.isNajatModel(deviceId);
      const fanKeys = ["windSpeed", "silenceSwitch", "turbo"];
      const hasFan = !najat && fanKeys.some(k => k in desired);
      const hasMode = "workMode" in desired;

      if (hasFan && hasMode) {
        const fanPayload: Record<string, unknown> = {};
        for (const k of fanKeys) {
          if (k in desired) { fanPayload[k] = desired[k]; delete desired[k]; }
        }
        await this.publishWithRetry(deviceId, desired);
        log.info(`[tcl] Profile (main) applied to ${deviceId}: ${JSON.stringify(desired)}`);
        await new Promise(r => setTimeout(r, 500));
        await this.publishWithRetry(deviceId, fanPayload);
        log.info(`[tcl] Profile (fan) applied to ${deviceId}: ${JSON.stringify(fanPayload)}`);
      } else {
        await this.publishWithRetry(deviceId, desired);
        log.info(`[tcl] Profile applied to device ${deviceId}: ${JSON.stringify(desired)}`);
      }
    }
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
      const switchProp = this.isNajatModel(deviceId) ? `${prefix}Wind` : `${prefix}Switch`;
      if (value === 0) return { [switchProp]: 0, [`${prefix}Direction`]: 8 };
      if (value >= 1 && value <= 4) return { [switchProp]: 1, [`${prefix}Direction`]: value };
      if (value >= 9 && value <= 13) return { [switchProp]: 0, [`${prefix}Direction`]: value };
      return null;
    }
    if (command === "set_fan_speed" && !this.isNajatModel(deviceId)) {
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
    return prop ? { [prop]: value } : null;
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
  async sendControlVerified(deviceId: string, command: string, value: unknown): Promise<void> {
    const payload = this.controlShadowPayload(deviceId, command, value);
    let pre: Record<string, number> | null = null;
    if (payload) {
      try {
        pre = (await this.getThingShadow(deviceId)).reported;
      } catch {
        // No pre-state — verification still runs, external-change detection degrades gracefully.
      }
    }
    await this.sendControl(deviceId, command, value);
    if (!payload) return;
    // Fire-and-forget — the route responds immediately; kept on a field so
    // tests can await the loop.
    this.lastControlVerify = this.verifyControlApplied(deviceId, command, payload, pre).catch((err) => {
      log.warn(`[tcl] Verify-resend loop failed for ${command} on ${deviceId}: ${(err as Error).message}`);
    });
  }

  private lastControlVerify: Promise<void> | null = null;

  private async verifyControlApplied(
    deviceId: string,
    command: string,
    payload: Record<string, number>,
    pre: Record<string, number> | null,
  ): Promise<void> {
    for (let attempt = 1; attempt <= CONTROL_VERIFY_MAX_RESENDS + 1; attempt++) {
      await this.controlVerifyDelay();
      const reported = (await this.getThingShadow(deviceId)).reported;
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
      await this.publishWithRetry(deviceId, payload);
    }
  }

  private async publishWithRetry(deviceId: string, payload: Record<string, unknown>): Promise<void> {
    await this.ensureValidTokens();
    try {
      await this.publishShadowUpdate(deviceId, payload);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      const name = (err as { name?: string }).name ?? "";
      if (msg.includes("403") || msg.includes("Forbidden") || name.includes("Credential") || name.includes("ExpiredToken")) {
        log.warn(`[tcl] Shadow publish failed (${name}), forcing re-auth and retrying`);
        this.awsCreds = null;
        this.tokenExpiry = 0;
        this.tokenData = null;
        await this.ensureValidTokens();
        await this.publishShadowUpdate(deviceId, payload);
      } else {
        throw err;
      }
    }
  }

  private buildProfileShadowPayload(deviceId: string, action: AcAction): Record<string, unknown> {
    const najat = this.isNajatModel(deviceId);
    const desired: Record<string, unknown> = {};

    if (action.mode != null) {
      desired.workMode = action.mode;
    }

    if (action.temperature != null) {
      desired.targetTemperature = action.temperature;
    }

    if (action.fan_speed != null) {
      if (najat) {
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

    if (action.eco != null && !najat) {
      desired.ECO = action.eco;
    }

    // Turbo: any fan_speed owns windSpeed/silenceSwitch/turbo atomically —
    // an explicit turbo must never override the fan block (1=silent, 7=turbo)
    if (action.turbo != null && !najat && action.fan_speed == null) {
      desired.turbo = action.turbo;
    }

    if (action.screen != null) {
      desired.screen = action.screen;
    }

    if (action.vertical_swing != null) {
      const v = action.vertical_swing;
      const switchProp = najat ? "verticalWind" : "verticalSwitch";
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

    if (action.horizontal_swing != null) {
      const v = action.horizontal_swing;
      const switchProp = najat ? "horizontalWind" : "horizontalSwitch";
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

    if (action.fresh_air != null && najat) {
      desired.newWindSwitch = action.fresh_air;
    }

    if (action.generator_mode != null) {
      // Stored profiles/presets may predate a firmware level-count reduction
      desired.generatorMode = this.clampGeneratorMode(deviceId, action.generator_mode);
    }

    return desired;
  }

  private async restoreLastState(deviceId: string): Promise<void> {
    const saved = this.lastState[deviceId];
    if (!saved || Object.keys(saved).length === 0) return;
    try {
      await new Promise(r => setTimeout(r, 1000));
      // Saved state may predate a firmware level-count reduction
      const payload = typeof saved.generatorMode === "number"
        ? { ...saved, generatorMode: this.clampGeneratorMode(deviceId, saved.generatorMode) }
        : saved;
      await this.publishShadowUpdate(deviceId, payload);
      log.info(`[tcl] Restored last state for device ${deviceId}:`, JSON.stringify(payload));
    } catch (err) {
      log.warn(`[tcl] Failed to restore last state for ${deviceId}:`, (err as Error).message);
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
