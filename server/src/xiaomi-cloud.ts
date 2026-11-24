import XiaomiMiHome from "xmihome";
import { writeFile, unlink } from "fs/promises";
import { childLogger } from "./logger.js";

const log = childLogger("xiaomi");

export interface PurifierDevice {
  id: string;
  name: string;
  model: string;
  isOnline: boolean;
  power?: "on" | "off";
  mode?: string;
  fan_level?: number;       // 1-3 (Fan mode level, MIoT only)
  favorite_level?: number;  // 0-14 for MIoT, 0-16 for MiIO
  aqi?: number;
  temperature?: number;
  humidity?: number;
  filter_life?: number;
  led?: boolean;
  buzzer?: boolean;
  child_lock?: boolean;
  // True when the last props RPC for this device failed: the readings above are
  // the last-known ones, kept rather than blanked, but they are NOT live. An
  // offline device keeps the previous attempt's verdict (it gets no RPC), and
  // fetchDevicesLive writes the flag on both outcomes, because a flag that is
  // only ever set one way is the ambiguity that made an empty list mean two
  // different things in the first place.
  readingsStale?: boolean;
  /** Receipt time of this device's last successful properties RPC. */
  readingsAt?: number;
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
  power:          { siid: 2,  piid: 2 },   // bool
  fan_level:      { siid: 2,  piid: 4 },   // int 1-3 (Fan mode)
  mode:           { siid: 2,  piid: 5 },   // int: 0=auto, 1=silent, 2=favorite, 3=fan
  aqi:            { siid: 3,  piid: 6 },   // int
  humidity:       { siid: 3,  piid: 7 },   // int
  temperature:    { siid: 3,  piid: 8 },   // float
  filter_life:    { siid: 4,  piid: 3 },   // int %
  buzzer:         { siid: 5,  piid: 1 },   // bool
  led_bright:     { siid: 6,  piid: 1 },   // int 0-2
  led:            { siid: 6,  piid: 6 },   // bool
  child_lock:     { siid: 7,  piid: 1 },   // bool
  favorite_level: { siid: 10, piid: 10 },  // int 0-14 (Favorite mode)
} as const;

const MIOT_MODE_MAP: Record<number, string> = { 0: "auto", 1: "silent", 2: "favorite", 3: "fan" };
const MIOT_MODE_REVERSE: Record<string, number> = { auto: 0, silent: 1, favorite: 2, fan: 3 };

function isPurifier(model: string): boolean {
  return PURIFIER_MODELS.some((prefix) => model.startsWith(prefix));
}

/**
 * The list call answers with identity only ({id, name, model, isOnline}); power,
 * mode, aqi, temperature, humidity, filter_life, led and child_lock arrive after
 * it, one props RPC per device. So assigning a fresh list straight over the
 * cache STRIPS every reading, and the collector's 5-minute refresh did exactly
 * that: the "serve the last-known devices on failure" guarantee then handed back
 * tiles with no readings at all.
 *
 * Merge, never replace. The fresh list owns identity and membership (a device it
 * no longer lists has genuinely gone), the cache owns the readings until a props
 * RPC replaces them.
 */
export function mergeDeviceCache(previous: PurifierDevice[], fetched: PurifierDevice[]): PurifierDevice[] {
  const known = new Map(previous.map((d) => [d.id, d]));
  return fetched.map((d) => {
    const prev = known.get(d.id);
    return prev ? { ...prev, ...d } : d;
  });
}

/**
 * The single test for "the serviceToken died". Every path that invalidates auth
 * must key on exactly the same condition, so these literals live here only.
 * A 429 or a timeout is NOT an auth failure and must never drop the session.
 */
export function isAuthError(err: unknown): boolean {
  const msg = (err as Error | null | undefined)?.message;
  if (typeof msg !== "string") return false;
  // \b401\b, never a bare substring: "401" also lives inside a device id, a byte
  // count, a timestamp or a port, and a false positive here is expensive and
  // silent: it drops a healthy session and deletes the credentials file.
  return msg.includes("Unauthorized") || /\b401\b/.test(msg);
}

type AuthStatus = "authenticated" | "needs_2fa" | "needs_captcha" | "not_configured" | "error";

export class XiaomiCloud {
  private client: XiaomiMiHome;
  private email: string;
  private password: string;
  private region: string;
  private cachedDevices: PurifierDevice[] = [];
  private listFetch?: Promise<PurifierDevice[]>;
  private liveFetch?: Promise<PurifierDevice[]>;
  private deviceCacheTime = 0;
  // Armed after a failed list call. A failure leaves deviceCacheTime untouched
  // (the cache did not refresh), and the collector loop ticks every ~5s, so
  // without this gate an outage would be answered with a list call per tick.
  private deviceListRetryAt = 0;
  // Serializes the region borrow in fetchPurifiersForRegion (see there).
  private regionFetchChain: Promise<unknown> = Promise.resolve();

  // 2FA state
  private authStatus: AuthStatus = "not_configured";
  private authError: string | null = null;
  private pending2faResolve: ((code: string) => void) | null = null;
  private pendingCaptchaResolve: ((code: string) => void) | null = null;
  private captchaImage: string | null = null;
  /**
   * Monotonic id of the login attempt that owns the session state. The
   * collector runs one init() at a time, but it writes an attempt off after a
   * deadline so a hung login cannot wedge recovery for good, which by design
   * permits exactly one overlap: the written-off attempt is still alive when a
   * newer login succeeds. Its late settle then lands in init()'s catch, which
   * sets "error" outside the 2FA guard, and a healthy session is stamped back
   * to "error". The collector's guard cannot see in here; this id can, so a
   * superseded attempt may read but never write.
   */
  private authAttempt = 0;

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

  /** False once a newer init() has claimed the session (see authAttempt). */
  private isCurrentAuthAttempt(attempt: number): boolean {
    return attempt === this.authAttempt;
  }

  async init(): Promise<void> {
    const attempt = ++this.authAttempt;
    try {
      await this.client.miot.login({
        on2fa: async (_url: string) => {
          // A superseded attempt must not park its resolver here:
          // /api/xiaomi/verify hands the human's code to whichever resolver is
          // parked on the instance, so a dead attempt would spend the code and
          // leave the live prompt waiting for one that never comes. An empty
          // answer is xmihome's own abort path ("2FA ticket was not
          // provided"), so this attempt settles into the guarded catch below
          // instead of hanging on a prompt nobody will answer.
          if (!this.isCurrentAuthAttempt(attempt)) {
            log.warn("[xiaomi] 2FA prompt for a superseded login attempt, abandoning it");
            return "";
          }
          log.info("[xiaomi] 2FA verification required — waiting for code via /api/xiaomi/verify");
          this.authStatus = "needs_2fa";
          return new Promise<string>((resolve) => {
            this.pending2faResolve = resolve;
          });
        },
        onCaptcha: async (imageB64: string) => {
          if (!this.isCurrentAuthAttempt(attempt)) {
            log.warn("[xiaomi] CAPTCHA prompt for a superseded login attempt, abandoning it");
            return "";
          }
          log.info("[xiaomi] CAPTCHA required — waiting for solution via /api/xiaomi/verify");
          this.authStatus = "needs_captcha";
          this.captchaImage = imageB64;
          return new Promise<string>((resolve) => {
            this.pendingCaptchaResolve = resolve;
          });
        },
      });

      // A late SUCCESS is as damaging as a late failure: saveCredentials()
      // would overwrite the live session's token file with this attempt's,
      // discoverRegionAndDevices() rewrites cachedDevices, and its 401 path
      // calls invalidateAuth(), i.e. it would drop a session it does not own.
      if (!this.isCurrentAuthAttempt(attempt)) {
        log.warn("[xiaomi] Login succeeded after being superseded, discarding its result");
        return;
      }

      // Save credentials to file for next restart
      await this.saveCredentials();
      this.authStatus = "authenticated";
      // Without this the stale "serviceToken expired (401)" outlives the
      // recovery and /api/xiaomi/auth-status reports an error while healthy.
      this.authError = null;
      log.info("[xiaomi] Cloud login successful");

      await this.discoverRegionAndDevices();
      log.info(
        `[xiaomi] Region: ${this.region}, found ${this.cachedDevices.length} purifier(s)`,
      );
      for (const d of this.cachedDevices) {
        log.info(`[xiaomi]   - ${d.name} (${d.model}, ${d.isOnline ? "online" : "offline"})`);
      }
    } catch (err) {
      if (!this.isCurrentAuthAttempt(attempt)) {
        // The whole point of the id: this failure belongs to an attempt the
        // collector already wrote off, and the session it would report on is a
        // newer login's. Stamping "error" here costs a healthy session and a
        // spurious re-login.
        log.warn("[xiaomi] Superseded login attempt failed, leaving the current session alone:", (err as Error).message);
        return;
      }
      this.authError = (err as Error).message;
      if (this.authStatus !== "needs_2fa" && this.authStatus !== "needs_captcha") {
        this.authStatus = "error";
      }
      log.error("[xiaomi] Cloud init failed:", this.authError);
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
        log.info("[xiaomi] Credentials saved to", CREDENTIALS_FILE);
      }
    } catch (err) {
      log.warn("[xiaomi] Failed to save credentials:", (err as Error).message);
    }
  }

  private async discoverRegionAndDevices(): Promise<void> {
    // "This account has no purifiers" is a finding; "we could not ask" is not.
    // The cache may only be emptied at the end when every region answered.
    let everyRegionAnswered = true;
    try {
      const devices = await this.fetchPurifiersForRegion(this.region);
      if (devices.length > 0) {
        // Merged like every other list assignment: init() runs again after a
        // re-login, and replacing here would throw away the readings the cache
        // held through the outage.
        this.cachedDevices = mergeDeviceCache(this.cachedDevices, devices);
        this.deviceCacheTime = Date.now();
        return;
      }
      log.info(`[xiaomi] No purifiers in region "${this.region}", scanning all regions...`);
    } catch (err) {
      // Deliberate: a non-auth failure here must NOT reach init()'s catch,
      // which would flip authStatus to "error" and spend a full re-login (and
      // risk a captcha) on a dropped packet. Only an auth failure moves the
      // status; a blip falls through to the scan below.
      if (isAuthError(err)) throw err;
      everyRegionAnswered = false;
      log.warn(`[xiaomi] Region "${this.region}" did not answer, scanning all regions`);
    }

    for (const region of ALL_REGIONS) {
      if (region === this.region) continue;
      try {
        const found = await this.fetchPurifiersForRegion(region);
        if (found.length > 0) {
          log.info(`[xiaomi] Found ${found.length} purifier(s) in region "${region}"`);
          this.region = region;
          // Update the client's country for future requests
          this.client.config.credentials!.country = region;
          this.cachedDevices = mergeDeviceCache(this.cachedDevices, found);
          this.deviceCacheTime = Date.now();
          await this.saveCredentials();
          return;
        }
      } catch (err) {
        // A dead token fails identically in every region: rethrow so init()'s
        // catch flips authStatus to "error" (which re-arms the collector's
        // re-auth) instead of burning six 401s and then clobbering the cache.
        if (isAuthError(err)) throw err;
        everyRegionAnswered = false;
        log.warn(`[xiaomi] Region "${region}" scan failed: ${(err as Error).message}`);
      }
    }

    if (!everyRegionAnswered) {
      // Silence from a region is not evidence of an empty account: emptying the
      // cache on that would blank the tiles for a network blip.
      log.warn("[xiaomi] Region scan incomplete, keeping the last-known purifiers");
      return;
    }
    log.warn("[xiaomi] No purifiers found in any region");
    this.cachedDevices = [];
    this.deviceCacheTime = Date.now();
  }

  /**
   * Region fetches run one at a time. The fetch below has to point the shared
   * client at `region` and put the previous value back afterwards, so two
   * overlapping calls restore each other's mid-flight value and leave every
   * later RPC aimed at the wrong regional endpoint. It is reachable because
   * init() publishes authStatus "authenticated" BEFORE discoverRegionAndDevices()
   * finishes, so a browser /api/devices poll or the collector's refresh step can
   * land inside a multi-region scan.
   *
   * One queue, same idiom as RateGate (rate-gate.ts) minus the pacing: a caller
   * that lands mid-scan waits for it instead of racing it.
   */
  private fetchPurifiersForRegion(region: string): Promise<PurifierDevice[]> {
    const result = this.regionFetchChain.then(() => this.requestPurifiersForRegion(region));
    // The queue must survive a rejected fetch: swallow here, not for the caller,
    // who still gets the rejection from `result`.
    this.regionFetchChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async requestPurifiersForRegion(region: string): Promise<PurifierDevice[]> {
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
        log.info(`[xiaomi] Region "${region}": ${all.length} device(s), ${purifiers.length} purifier(s)`);
      }
      return purifiers;
    } catch (err) {
      // The 2026-08-31 wedge: returning [] here read as "no purifiers", clobbered
      // cachedDevices and left authStatus "authenticated", so the props loop that
      // owns the only other 401 detector never ran and nothing ever re-logged in.
      // The failure erased its own repair trigger. Invalidate and rethrow: the
      // status flip is the signal, and callers keep their last-known devices.
      if (isAuthError(err)) {
        log.warn(`[xiaomi] Auth failure fetching devices for region "${region}", invalidating auth for re-login:`, (err as Error).message);
        await this.invalidateAuth();
        throw err;
      }
      // A timeout, a DNS failure or a 500 gets the same treatment minus the
      // invalidation: returning [] for those blanked the purifier tiles while
      // the route still answered available:true, which is the wedge's own
      // symptom reached through a different door. This is the throwing
      // primitive, so an empty list can only ever mean the cloud answered and
      // had nothing to report. It logs the detail; callers log the consequence.
      log.warn(`[xiaomi] Fetch devices for region "${region}" failed:`, (err as Error).message);
      throw err;
    } finally {
      creds.country = savedCountry;
    }
  }

  async refreshDevices(): Promise<PurifierDevice[]> {
    if (this.authStatus !== "authenticated") return this.cachedDevices;
    // No "&& cachedDevices.length > 0": an empty cache DEFEATED this throttle,
    // i.e. maximum hammering in exactly the wedged state. An empty list is not
    // the failure signal; the auth status flip is.
    if (Date.now() - this.deviceCacheTime < 300_000) return this.cachedDevices;
    if (Date.now() < this.deviceListRetryAt) return this.cachedDevices;
    try {
      // Merged: this step runs every 5 minutes and the list it gets back is
      // identity only, so replacing here stripped every reading out of the
      // cache twelve times an hour and left the failure path serving tiles with
      // no power, mode, aqi or temperature. It refreshes identity, not readings.
      await this.refreshDeviceList();
    } catch (err) {
      // Keep the last-known-good list on ANY failure, not just an auth one: an
      // empty list is a claim about the account, and a blip cannot make it.
      // A 401 already invalidated auth inside the fetch, so the status guard
      // above short-circuits every call until re-login; a blip leaves the
      // session alone and comes back through the retry gate.
      this.deviceListRetryAt = Date.now() + 60_000;
      log.warn("[xiaomi] Device refresh failed, keeping cached devices:", (err as Error).message);
    }
    return this.cachedDevices;
  }

  private refreshDeviceList(): Promise<PurifierDevice[]> {
    // List-only polling and live property readers share the same cache commit.
    return this.listFetch ??= this.fetchPurifiersForRegion(this.region).then(list => {
      this.cachedDevices = mergeDeviceCache(this.cachedDevices, list);
      this.deviceCacheTime = Date.now();
      this.deviceListRetryAt = 0;
      return this.cachedDevices;
    }).finally(() => { this.listFetch = undefined; });
  }

  /** All live readers share the list and the whole batch of properties RPCs. */
  fetchDevicesLive(): Promise<PurifierDevice[]> {
    return this.liveFetch ??= this.refreshLiveProperties().finally(() => { this.liveFetch = undefined; });
  }

  private async refreshLiveProperties(): Promise<PurifierDevice[]> {
    if (this.authStatus !== "authenticated") return this.cachedDevices;
    // Deliberately unguarded: ANY failing list call throws past this assignment,
    // so cachedDevices keeps its last-known-good contents and the route reports
    // the failure instead of serving an empty list as if it were the truth. For
    // a blip that is honest ("we could not confirm these are live") and it
    // surfaces as the client's stale marker for a poll or two.
    const devices = await this.refreshDeviceList();

    // Query live props for each online device
    await Promise.all(
      devices.filter((d) => d.isOnline).map(async (d) => {
        try {
          // A successful RPC is the whole truth for this device: an undefined
          // prop means it answered without one, so it must clear the merged
          // value rather than leave yesterday's reading standing.
          Object.assign(d, await this.getDeviceProps(d.id), { readingsStale: false, readingsAt: Date.now() });
        } catch (err) {
          // Was a silent `catch {}`. With the merge above the device now keeps
          // its previous readings instead of losing them, which is the right
          // trade only if it stops claiming to be live: mark it and say so,
          // otherwise one dead device reads exactly like its healthy siblings.
          // A 401 here already invalidated auth inside sendCommand, so the
          // route re-reads isReady() and answers available:false.
          d.readingsStale = true;
          log.warn(`[xiaomi] Props read failed for device ${d.id}, keeping the last-known readings:`, (err as Error).message);
        }
      }),
    );
    return devices;
  }

  private isMiot(model: string): boolean {
    return MIOT_MODELS.includes(model);
  }

  /**
   * getModel() returns "" for an unknown id, so with an empty cache isMiot() is
   * false and a MIoT unit silently receives legacy miIO commands. Populate
   * before any model lookup on a control path (mirrors TCL's namesake).
   *
   * Throws when the list call fails, deliberately: refusing the command beats
   * sending the wrong protocol off an unpopulated cache. Both callers tolerate
   * it (the control route answers 500, the collector's automation step logs and
   * moves to the next tick), and a cache that survives blips now means this
   * only bites on a cold start.
   */
  private async ensureDeviceCachePopulated(): Promise<void> {
    if (this.cachedDevices.length > 0) return;
    if (this.authStatus !== "authenticated") return;
    await this.refreshDeviceList();
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
    const propKeys = ["power", "mode", "fan_level", "aqi", "temperature", "humidity", "filter_life", "led", "buzzer", "child_lock", "favorite_level"] as const;
    const params = propKeys.map((k) => ({
      did: k,
      siid: MIOT_PROPS[k].siid,
      piid: MIOT_PROPS[k].piid,
    }));
    const result = await this.sendCommand(deviceId, "get_properties", params) as Array<{ did: string; value: unknown; code: number }>;
    const vals: Record<string, unknown> = {};
    for (const r of result ?? []) {
      if (r.code === 0) vals[r.did] = r.value;
    }
    return {
      power: vals.power === true ? "on" : vals.power === false ? "off" : undefined,
      mode: typeof vals.mode === "number" ? (MIOT_MODE_MAP[vals.mode] ?? String(vals.mode)) : undefined,
      fan_level: typeof vals.fan_level === "number" ? vals.fan_level : undefined,
      favorite_level: typeof vals.favorite_level === "number" ? vals.favorite_level : undefined,
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

  /** Lightweight power-only query for automation checks */
  async getDevicePower(deviceId: string): Promise<"on" | "off" | undefined> {
    if (this.isMiot(this.getModel(deviceId))) {
      const result = await this.sendCommand(deviceId, "get_properties", [
        { did: "power", siid: MIOT_PROPS.power.siid, piid: MIOT_PROPS.power.piid },
      ]) as Array<{ did: string; value: unknown; code: number }>;
      const val = result?.[0];
      if (val?.code === 0) return val.value === true ? "on" : "off";
      return undefined;
    }
    const result = await this.sendCommand(deviceId, "get_prop", ["power"]) as unknown[];
    return result?.[0] === "on" ? "on" : result?.[0] === "off" ? "off" : undefined;
  }

  getRegion(): string {
    return this.region;
  }

  isReady(): boolean {
    return this.authStatus === "authenticated";
  }

  async invalidateAuth(): Promise<void> {
    this.authStatus = "error";
    this.authError = "serviceToken expired (401)";
    const creds = this.client.config.credentials;
    if (creds) {
      delete (creds as Record<string, unknown>).userId;
      delete (creds as Record<string, unknown>).ssecurity;
      delete (creds as Record<string, unknown>).serviceToken;
    }
    try {
      await unlink(CREDENTIALS_FILE);
      log.info("[xiaomi] Deleted stale credentials file");
    } catch (err) {
      // ENOENT is the happy case (the file is already gone). Anything else is
      // severe and must be loud: xmihome's login() short-circuits while the file
      // still holds userId+ssecurity+serviceToken, so a surviving stale file
      // turns every re-login attempt into a permanent no-op.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("[xiaomi] Failed to delete stale credentials file, re-login may be a no-op:", (err as Error).message);
      }
    }
  }

  async sendCommand(deviceId: string, method: string, params: unknown[]): Promise<unknown> {
    if (!this.isReady()) throw new Error("Xiaomi Cloud not authenticated");
    try {
      const { result } = await this.client.miot.request(`/home/rpc/${deviceId}`, {
        method,
        params,
      }) as { result: unknown };
      log.info(`[xiaomi] Command ${method}(${JSON.stringify(params)}) → device ${deviceId}: OK`);
      return result;
    } catch (err) {
      if (isAuthError(err)) {
        log.warn("[xiaomi] Got 401/Unauthorized, invalidating auth for re-login");
        await this.invalidateAuth();
      }
      throw err;
    }
  }

  async executeAction(deviceId: string, action: PurifierAction): Promise<void> {
    await this.ensureDeviceCachePopulated();
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
    await this.ensureDeviceCachePopulated();
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
        return this.sendCommand(deviceId, "set_properties", [{ did: "favorite_level", ...MIOT_PROPS.favorite_level, value: val }]);
      case "set_fan_level":
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
