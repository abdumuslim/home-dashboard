import XiaomiMiHome from "xmihome";
import { writeFile } from "fs/promises";

export interface PurifierDevice {
  id: string;
  name: string;
  model: string;
  isOnline: boolean;
  power?: "on" | "off";
  mode?: string;
  favorite_level?: number;
  aqi?: number;
  temperature?: number;
  humidity?: number;
  filter_life?: number;
  led?: boolean;
  buzzer?: boolean;
  child_lock?: boolean;
}

export interface PurifierAction {
  power?: "on" | "off";
  mode?: "auto" | "silent" | "favorite";
  fan_level?: number;
}

const PURIFIER_MODELS = ["zhimi.airpurifier"];
const ALL_REGIONS = ["sg", "de", "us", "cn", "ru", "tw"] as const;
const CREDENTIALS_FILE = "/app/data/xiaomi-credentials.json";

// MIoT models use get_properties/set_properties instead of get_prop/set_power
const MIOT_MODELS = ["zhimi.airpurifier.mb3", "zhimi.airpurifier.mb4", "zhimi.airpurifier.mb5",
  "zhimi.airpurifier.vb2", "zhimi.airpurifier.va2", "zhimi.airpurifier.rma1"];

// MIoT property mappings (siid.piid)
const MIOT_PROPS = {
  power:       { siid: 2, piid: 2 },   // bool
  fan_level:   { siid: 2, piid: 4 },   // int 0-3
  mode:        { siid: 2, piid: 5 },   // int: 0=auto, 1=silent, 2=favorite, 3=fan
  aqi:         { siid: 3, piid: 6 },   // int
  humidity:    { siid: 3, piid: 7 },   // int
  temperature: { siid: 3, piid: 8 },   // float
  filter_life: { siid: 4, piid: 3 },   // int %
  buzzer:      { siid: 5, piid: 1 },   // bool
  led_bright:  { siid: 6, piid: 1 },   // int 0-2
  led:         { siid: 6, piid: 6 },   // bool
  child_lock:  { siid: 7, piid: 1 },   // bool
} as const;

const MIOT_MODE_MAP: Record<number, string> = { 0: "auto", 1: "silent", 2: "favorite", 3: "fan" };
const MIOT_MODE_REVERSE: Record<string, number> = { auto: 0, silent: 1, favorite: 2, fan: 3 };

function isPurifier(model: string): boolean {
  return PURIFIER_MODELS.some((prefix) => model.startsWith(prefix));
}

type AuthStatus = "authenticated" | "needs_2fa" | "needs_captcha" | "not_configured" | "error";

export class XiaomiCloud {
  private client: XiaomiMiHome;
  private email: string;
  private password: string;
  private region: string;
  private cachedDevices: PurifierDevice[] = [];
  private deviceCacheTime = 0;

  // 2FA state
  private authStatus: AuthStatus = "not_configured";
  private authError: string | null = null;
  private pending2faResolve: ((code: string) => void) | null = null;
  private pendingCaptchaResolve: ((code: string) => void) | null = null;
  private captchaImage: string | null = null;

  constructor(email: string, password: string, region: string) {
    this.email = email;
    this.password = password;
    this.region = region;
    this.client = new XiaomiMiHome({
      credentials: {
        username: email,
        password: password,
        country: region,
      },
      credentialsFile: CREDENTIALS_FILE,
      connectionType: "cloud",
      logLevel: "info",
    });
  }

  async init(): Promise<void> {
    try {
      await this.client.miot.login({
        on2fa: async (_url: string) => {
          console.log("[xiaomi] 2FA verification required — waiting for code via /api/xiaomi/verify");
          this.authStatus = "needs_2fa";
          return new Promise<string>((resolve) => {
            this.pending2faResolve = resolve;
          });
        },
        onCaptcha: async (imageB64: string) => {
          console.log("[xiaomi] CAPTCHA required — waiting for solution via /api/xiaomi/verify");
          this.authStatus = "needs_captcha";
          this.captchaImage = imageB64;
          return new Promise<string>((resolve) => {
            this.pendingCaptchaResolve = resolve;
          });
        },
      });

      // Save credentials to file for next restart
      await this.saveCredentials();
      this.authStatus = "authenticated";
      console.log("[xiaomi] Cloud login successful");

      await this.discoverRegionAndDevices();
      console.log(
        `[xiaomi] Region: ${this.region}, found ${this.cachedDevices.length} purifier(s)`,
      );
      for (const d of this.cachedDevices) {
        console.log(`[xiaomi]   - ${d.name} (${d.model}, ${d.isOnline ? "online" : "offline"})`);
      }
    } catch (err) {
      this.authError = (err as Error).message;
      if (this.authStatus !== "needs_2fa" && this.authStatus !== "needs_captcha") {
        this.authStatus = "error";
      }
      console.error("[xiaomi] Cloud init failed:", this.authError);
    }
  }

  /** Called from the API when user submits 2FA code or captcha solution */
  async submitVerification(code: string): Promise<{ ok: boolean; error?: string }> {
    if (this.pending2faResolve) {
      this.pending2faResolve(code);
      this.pending2faResolve = null;
      // Wait a bit for the login to complete
      await new Promise((r) => setTimeout(r, 5000));
      if (this.authStatus === "authenticated") {
        return { ok: true };
      }
      return { ok: false, error: this.authError ?? "Verification failed" };
    }
    if (this.pendingCaptchaResolve) {
      this.pendingCaptchaResolve(code);
      this.pendingCaptchaResolve = null;
      await new Promise((r) => setTimeout(r, 5000));
      if (this.authStatus === "authenticated") {
        return { ok: true };
      }
      return { ok: false, error: this.authError ?? "Captcha failed" };
    }
    return { ok: false, error: "No pending verification" };
  }

  getAuthStatus(): { status: AuthStatus; error?: string; captchaImage?: string } {
    return {
      status: this.authStatus,
      error: this.authError ?? undefined,
      captchaImage: this.authStatus === "needs_captcha" ? (this.captchaImage ?? undefined) : undefined,
    };
  }

  private async saveCredentials(): Promise<void> {
    try {
      const creds = this.client.config.credentials;
      if (creds?.userId && creds?.ssecurity && creds?.serviceToken) {
        await writeFile(CREDENTIALS_FILE, JSON.stringify({
          userId: creds.userId,
          ssecurity: creds.ssecurity,
          serviceToken: creds.serviceToken,
          country: creds.country ?? this.region,
        }));
        console.log("[xiaomi] Credentials saved to", CREDENTIALS_FILE);
      }
    } catch (err) {
      console.warn("[xiaomi] Failed to save credentials:", (err as Error).message);
    }
  }

  private async discoverRegionAndDevices(): Promise<void> {
    const devices = await this.fetchPurifiersForRegion(this.region);
    if (devices.length > 0) {
      this.cachedDevices = devices;
      this.deviceCacheTime = Date.now();
      return;
    }

    console.log(`[xiaomi] No purifiers in region "${this.region}", scanning all regions...`);
    for (const region of ALL_REGIONS) {
      if (region === this.region) continue;
      try {
        const found = await this.fetchPurifiersForRegion(region);
        if (found.length > 0) {
          console.log(`[xiaomi] Found ${found.length} purifier(s) in region "${region}"`);
          this.region = region;
          // Update the client's country for future requests
          this.client.config.credentials!.country = region;
          this.cachedDevices = found;
          this.deviceCacheTime = Date.now();
          await this.saveCredentials();
          return;
        }
      } catch (err) {
        console.warn(`[xiaomi] Region "${region}" scan failed: ${(err as Error).message}`);
      }
    }
    console.warn("[xiaomi] No purifiers found in any region");
    this.cachedDevices = [];
    this.deviceCacheTime = Date.now();
  }

  private async fetchPurifiersForRegion(region: string): Promise<PurifierDevice[]> {
    const creds = this.client.config.credentials!;
    const savedCountry = creds.country;
    creds.country = region;
    try {
      const { result } = await this.client.miot.request("/home/device_list", {}) as {
        result: { list: Array<{ did: string; name: string; model: string; isOnline: boolean }> };
      };
      const all = result.list ?? [];
      const purifiers = all
        .filter((d) => isPurifier(d.model))
        .map((d) => ({ id: d.did, name: d.name, model: d.model, isOnline: d.isOnline }));
      if (all.length > 0) {
        console.log(`[xiaomi] Region "${region}": ${all.length} device(s), ${purifiers.length} purifier(s)`);
      }
      return purifiers;
    } catch (err) {
      console.warn(`[xiaomi] Fetch devices for region "${region}" failed:`, (err as Error).message);
      return [];
    } finally {
      creds.country = savedCountry;
    }
  }

  async refreshDevices(): Promise<PurifierDevice[]> {
    if (this.authStatus !== "authenticated") return this.cachedDevices;
    if (Date.now() - this.deviceCacheTime < 300_000 && this.cachedDevices.length > 0) {
      return this.cachedDevices;
    }
    this.cachedDevices = await this.fetchPurifiersForRegion(this.region);
    this.deviceCacheTime = Date.now();
    return this.cachedDevices;
  }

  /** Fetch fresh device list + live props (bypasses cache, for API use) */
  async fetchDevicesLive(): Promise<PurifierDevice[]> {
    if (this.authStatus !== "authenticated") return this.cachedDevices;
    const devices = await this.fetchPurifiersForRegion(this.region);
    this.cachedDevices = devices;
    this.deviceCacheTime = Date.now();

    // Query live props for each online device
    await Promise.all(
      devices.filter((d) => d.isOnline).map(async (d) => {
        try {
          Object.assign(d, await this.getDeviceProps(d.id));
        } catch {
          // ignore — device may be unreachable
        }
      }),
    );
    return devices;
  }

  private isMiot(model: string): boolean {
    return MIOT_MODELS.includes(model);
  }

  private getModel(deviceId: string): string {
    return this.cachedDevices.find((d) => d.id === deviceId)?.model ?? "";
  }

  private async getDeviceProps(deviceId: string): Promise<Partial<PurifierDevice>> {
    if (this.isMiot(this.getModel(deviceId))) {
      return this.getMiotProps(deviceId);
    }
    return this.getMiioProps(deviceId);
  }

  private async getMiioProps(deviceId: string): Promise<Partial<PurifierDevice>> {
    const result = await this.sendCommand(deviceId, "get_prop", [
      "power", "mode", "favorite_level", "aqi", "temp_dec", "humidity",
      "filter1_life", "led", "buzzer", "child_lock",
    ]) as unknown[];
    return {
      power: result?.[0] === "on" ? "on" : result?.[0] === "off" ? "off" : undefined,
      mode: typeof result?.[1] === "string" ? result[1] : undefined,
      favorite_level: typeof result?.[2] === "number" ? result[2] : undefined,
      aqi: typeof result?.[3] === "number" ? result[3] : undefined,
      temperature: typeof result?.[4] === "number" ? result[4] / 10 : undefined,
      humidity: typeof result?.[5] === "number" ? result[5] : undefined,
      filter_life: typeof result?.[6] === "number" ? result[6] : undefined,
      led: result?.[7] === "on" || result?.[7] === true ? true : result?.[7] === "off" || result?.[7] === false ? false : undefined,
      buzzer: result?.[8] === "on" || result?.[8] === true ? true : result?.[8] === "off" || result?.[8] === false ? false : undefined,
      child_lock: result?.[9] === "on" || result?.[9] === true ? true : result?.[9] === "off" || result?.[9] === false ? false : undefined,
    };
  }

  private async getMiotProps(deviceId: string): Promise<Partial<PurifierDevice>> {
    const propKeys = ["power", "mode", "fan_level", "aqi", "temperature", "humidity", "filter_life", "led", "buzzer", "child_lock"] as const;
    const params = propKeys.map((k) => ({
      did: k,
      siid: MIOT_PROPS[k === "fan_level" ? "fan_level" : k].siid,
      piid: MIOT_PROPS[k === "fan_level" ? "fan_level" : k].piid,
    }));
    const result = await this.sendCommand(deviceId, "get_properties", params) as Array<{ did: string; value: unknown; code: number }>;
    const vals: Record<string, unknown> = {};
    for (const r of result ?? []) {
      if (r.code === 0) vals[r.did] = r.value;
    }
    return {
      power: vals.power === true ? "on" : vals.power === false ? "off" : undefined,
      mode: typeof vals.mode === "number" ? (MIOT_MODE_MAP[vals.mode] ?? String(vals.mode)) : undefined,
      favorite_level: typeof vals.fan_level === "number" ? vals.fan_level : undefined,
      aqi: typeof vals.aqi === "number" ? vals.aqi : undefined,
      temperature: typeof vals.temperature === "number" ? vals.temperature : undefined,
      humidity: typeof vals.humidity === "number" ? vals.humidity : undefined,
      filter_life: typeof vals.filter_life === "number" ? vals.filter_life : undefined,
      led: typeof vals.led === "boolean" ? vals.led : undefined,
      buzzer: typeof vals.buzzer === "boolean" ? vals.buzzer : undefined,
      child_lock: typeof vals.child_lock === "boolean" ? vals.child_lock : undefined,
    };
  }

  getDevices(): PurifierDevice[] {
    return this.cachedDevices;
  }

  getRegion(): string {
    return this.region;
  }

  isReady(): boolean {
    return this.authStatus === "authenticated";
  }

  async sendCommand(deviceId: string, method: string, params: unknown[]): Promise<unknown> {
    if (!this.isReady()) throw new Error("Xiaomi Cloud not authenticated");
    const { result } = await this.client.miot.request(`/home/rpc/${deviceId}`, {
      method,
      params,
    }) as { result: unknown };
    console.log(`[xiaomi] Command ${method}(${JSON.stringify(params)}) → device ${deviceId}: OK`);
    return result;
  }

  async executeAction(deviceId: string, action: PurifierAction): Promise<void> {
    if (this.isMiot(this.getModel(deviceId))) {
      await this.executeMiotAction(deviceId, action);
    } else {
      await this.executeMiioAction(deviceId, action);
    }
  }

  private async executeMiioAction(deviceId: string, action: PurifierAction): Promise<void> {
    if (action.power != null) {
      await this.sendCommand(deviceId, "set_power", [action.power]);
    }
    if (action.mode != null) {
      await this.sendCommand(deviceId, "set_mode", [action.mode]);
    }
    if (action.fan_level != null) {
      await this.sendCommand(deviceId, "set_level_favorite", [action.fan_level]);
    }
  }

  private async executeMiotAction(deviceId: string, action: PurifierAction): Promise<void> {
    const props: Array<{ did: string; siid: number; piid: number; value: unknown }> = [];
    if (action.power != null) {
      props.push({ did: "power", ...MIOT_PROPS.power, value: action.power === "on" });
    }
    if (action.mode != null) {
      const modeNum = MIOT_MODE_REVERSE[action.mode];
      if (modeNum != null) props.push({ did: "mode", ...MIOT_PROPS.mode, value: modeNum });
    }
    if (action.fan_level != null) {
      props.push({ did: "fan_level", ...MIOT_PROPS.fan_level, value: action.fan_level });
    }
    if (props.length > 0) {
      await this.sendCommand(deviceId, "set_properties", props);
    }
  }

  /** Send a control command, auto-detecting miIO vs MIoT protocol */
  async sendControlCommand(deviceId: string, command: string, params: unknown[]): Promise<unknown> {
    if (this.isMiot(this.getModel(deviceId))) {
      return this.sendMiotControl(deviceId, command, params);
    }
    return this.sendCommand(deviceId, command, params);
  }

  private async sendMiotControl(deviceId: string, command: string, params: unknown[]): Promise<unknown> {
    // Translate miIO-style commands to MIoT set_properties
    const val = params[0];
    switch (command) {
      case "set_power":
        return this.sendCommand(deviceId, "set_properties", [{ did: "power", ...MIOT_PROPS.power, value: val === "on" }]);
      case "set_mode": {
        const modeNum = MIOT_MODE_REVERSE[val as string];
        if (modeNum == null) throw new Error(`Unknown mode: ${val}`);
        return this.sendCommand(deviceId, "set_properties", [{ did: "mode", ...MIOT_PROPS.mode, value: modeNum }]);
      }
      case "set_level_favorite":
        return this.sendCommand(deviceId, "set_properties", [{ did: "fan_level", ...MIOT_PROPS.fan_level, value: val }]);
      case "set_led":
        return this.sendCommand(deviceId, "set_properties", [{ did: "led", ...MIOT_PROPS.led, value: val === "on" }]);
      case "set_buzzer":
        return this.sendCommand(deviceId, "set_properties", [{ did: "buzzer", ...MIOT_PROPS.buzzer, value: val === "on" }]);
      case "set_child_lock":
        return this.sendCommand(deviceId, "set_properties", [{ did: "child_lock", ...MIOT_PROPS.child_lock, value: val === "on" }]);
      default:
        return this.sendCommand(deviceId, command, params);
    }
  }
}
