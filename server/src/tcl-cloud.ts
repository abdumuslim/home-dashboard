import { createHash, createHmac } from "crypto";
import { readFile, writeFile } from "fs/promises";

export interface AcDevice {
  id: string;
  name: string;
  isOnline: boolean;
  power: boolean;
  mode: number;
  targetTemp: number;
  currentTemp: number;
  fanSpeed: number;
  eco: boolean;
  sleep: number;
  screen: boolean;
  swing: boolean;
  turbo: boolean;
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

  constructor(username: string, password: string) {
    this.username = username;
    this.passwordMd5 = md5hex(password);
  }

  async init(): Promise<void> {
    await this.loadCredentials();

    await this.ensureValidTokens();
    console.log("[tcl] Cloud initialized successfully");

    try {
      const devices = await this.fetchDevices();
      this.cachedDevices = devices;
      this.deviceCacheTime = Date.now();

      console.log(`[tcl] Found ${devices.length} AC device(s)`);
      for (const d of devices) {
        console.log(`[tcl]   - ${d.name} (${d.id}, ${d.isOnline ? "online" : "offline"}, power=${d.power ? "on" : "off"})`);
      }
    } catch (err) {
      console.warn("[tcl] Device fetch during init failed (will retry on first API call):", (err as Error).message);
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

  async sendControl(deviceId: string, command: string, value: unknown): Promise<void> {
    await this.ensureValidTokens();

    const propMap: Record<string, string> = {
      set_power: "powerSwitch",
      set_mode: "workMode",
      set_temperature: "targetTemperature",
      set_fan_speed: "windSpeed",
      set_eco: "ECO",
      set_screen: "screen",
      set_sleep: "sleep",
      set_swing: "verticalSwitch",
      set_turbo: "turbo",
    };

    const prop = propMap[command];
    if (!prop) throw new Error(`Unknown command: ${command}`);

    const desired: Record<string, unknown> = { [prop]: value };
    await this.publishShadowUpdate(deviceId, desired);
    console.log(`[tcl] Control ${command}=${value} → device ${deviceId}: OK`);
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

    console.log(`[tcl] Login OK — user=${data.user.username}, country=${data.user.countryAbbr}`);
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

    console.log(`[tcl] Tokens refreshed — mqtt=${d.mqttEndpoint}, cognitoId=${d.cognitoId}`);
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

    console.log(`[tcl] AWS credentials obtained for region ${region}`);
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
        console.warn(`[tcl] fetchDevices got ${resp.status} (expired token), forcing re-auth and retrying`);
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
        console.warn(`[tcl] fetchDevices got code ${data.code} (${data.message}), forcing re-auth and retrying`);
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

        const online = dev.isOnline === "online" || dev.isOnline === "1" || dev.isOnline === true || dev.isOnline === 1;

        // Read full state from IoT shadow (identifiers only has powerSwitch)
        let shadow: Record<string, number> = {};
        if (online && this.awsCreds) {
          try {
            shadow = await this.getThingShadow(dev.deviceId);
          } catch (err) {
            console.warn(`[tcl] Shadow read failed for ${dev.deviceId}:`, (err as Error).message);
          }
        }

        const powerFromId = (dev.identifiers ?? []).find(i => i.identifier === "powerSwitch");

        devices.push({
          id: dev.deviceId,
          name: dev.nickName || dev.deviceName || dev.deviceId,
          isOnline: online,
          power: shadow.powerSwitch != null ? shadow.powerSwitch === 1 : powerFromId?.value === 1,
          mode: shadow.workMode ?? 0,
          targetTemp: shadow.targetTemperature ?? 24,
          currentTemp: shadow.currentTemperature ?? 0,
          fanSpeed: shadow.windSpeed ?? 0,
          eco: shadow.ECO === 1,
          sleep: shadow.sleep ?? 0,
          screen: shadow.screen === 1,
          swing: shadow.verticalSwitch === 1,
          turbo: shadow.turbo === 1,
        });
      }
    }

    return devices;
  }

  private async getThingShadow(deviceId: string): Promise<Record<string, number>> {
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
    };

    return shadow.state?.reported ?? {};
  }

  private async publishShadowUpdate(deviceId: string, desired: Record<string, unknown>): Promise<void> {
    if (!this.awsCreds) throw new Error("No AWS credentials");

    const region = this.awsCreds.region;
    const host = `data-ats.iot.${region}.amazonaws.com`;
    const topic = `$aws/things/${deviceId}/shadow/update`;
    const path = `/topics/${encodeURIComponent(topic)}?qos=1`;
    const method = "POST";
    const body = JSON.stringify({
      state: { desired },
      clientToken: `mobile_${Date.now()}`,
    });

    const headers = this.signAwsRequest(method, host, path, body, region, "iotdata");

    const resp = await fetch(`https://${host}${path}`, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      throw new Error(`IoT Publish HTTP ${resp.status}: ${await resp.text()}`);
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
      console.log("[tcl] Credentials saved");
    } catch (err) {
      console.warn("[tcl] Failed to save credentials:", (err as Error).message);
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
      console.log("[tcl] Loaded cached credentials");
    } catch {
      // No cached credentials, will do fresh login
    }
  }
}
