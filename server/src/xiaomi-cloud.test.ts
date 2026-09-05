import { describe, it, expect, vi } from "vitest";
import { XiaomiCloud, isAuthError, mergeDeviceCache, type PurifierDevice } from "./xiaomi-cloud.js";

// The 2026-08-31 wedge: both purifiers vanished from the dashboard for ~1h25m.
// A 401 on /home/device_list was swallowed by fetchPurifiersForRegion's catch
// and returned as [], which read as "this region has no purifiers". The empty
// list clobbered cachedDevices, which emptied the props loop that owns the ONLY
// other 401 detector (sendCommand), so authStatus stayed "authenticated",
// isReady() stayed true and the collector's re-auth never fired. The failure
// erased its own repair trigger; recovery needed a human to poke a device.

type MiotRequest = (path: string, body?: unknown) => Promise<unknown>;

type CloudSeam = {
  client: {
    miot: { request: MiotRequest; login: (opts: unknown) => Promise<void> };
    config: { credentials: Record<string, unknown> };
  };
  cachedDevices: PurifierDevice[];
  deviceCacheTime: number;
  authStatus: string;
  authError: string | null;
  pending2faResolve: ((code: string) => void) | null;
};

type LoginHandlers = {
  on2fa: (url: string) => Promise<string>;
  onCaptcha: (imageB64: string) => Promise<string>;
};

function purifier(id: string, model = "zhimi.airpurifier.v7"): PurifierDevice {
  return { id, name: `purifier-${id}`, model, isOnline: true };
}

/** Flush every pending microtask chain (no fake timers in this file). */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function listResult(devices: PurifierDevice[]) {
  return { result: { list: devices.map((d) => ({ did: d.id, name: d.name, model: d.model, isOnline: d.isOnline })) } };
}

/**
 * The constructor does no network, so a plain instance plus a stubbed `client`
 * is the whole harness (same private-field seam as tcl-cloud.test.ts).
 * invalidateAuth() also unlinks /app/data/xiaomi-credentials.json, which simply
 * does not exist here and is already swallowed.
 */
function cloudWith(request: MiotRequest, devices: PurifierDevice[] = []): { cloud: XiaomiCloud; seam: CloudSeam } {
  const cloud = new XiaomiCloud("user@example.com", "pw", "sg");
  const seam = cloud as unknown as CloudSeam;
  seam.client = {
    miot: { request, login: async () => undefined },
    config: { credentials: { username: "user@example.com", password: "pw", country: "sg" } },
  };
  seam.cachedDevices = devices;
  seam.deviceCacheTime = Date.now();
  seam.authStatus = "authenticated";
  return { cloud, seam };
}

describe("isAuthError", () => {
  it("matches only a dead serviceToken, never another failure", () => {
    expect(isAuthError(new Error("Request error with status Unauthorized"))).toBe(true);
    expect(isAuthError(new Error("401"))).toBe(true);
    expect(isAuthError(new Error("Request timed out"))).toBe(false);
    // A 429 must NOT invalidate auth: throwing the session away on rate
    // limiting turns a slowdown into a re-login storm (and then a captcha).
    expect(isAuthError(new Error("Request error with status Too Many Requests"))).toBe(false);
    expect(isAuthError(new Error("Request error with status Forbidden"))).toBe(false);
    expect(isAuthError({})).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });

  it("does not fire on a bare 401 substring inside another number", () => {
    // A bare includes("401") matches a device id or a byte count, and a false
    // positive drops a healthy session and deletes the credentials file.
    expect(isAuthError(new Error("device 34012345 unreachable"))).toBe(false);
    expect(isAuthError(new Error("received 1401 bytes"))).toBe(false);
    expect(isAuthError(new Error("Request error with status 401"))).toBe(true);
    // The message invalidateAuth() itself records must still read as auth.
    expect(isAuthError(new Error("serviceToken expired (401)"))).toBe(true);
  });
});

describe("device-list failures", () => {
  it("keeps the cached purifiers and flips the status when the list 401s (2026-08-31 purifier wedge)", async () => {
    const request = vi.fn(async () => { throw new Error("Request error with status Unauthorized"); });
    const { cloud } = cloudWith(request, [
      purifier("317499063", "zhimi.airpurifier.vb2"),
      purifier("357465941"),
    ]);

    // The 401 must REACH the caller: swallowing it as [] is what erased the
    // repair trigger and made routes.ts's catch unreachable.
    await expect(cloud.fetchDevicesLive()).rejects.toThrow("Unauthorized");

    expect(cloud.isReady()).toBe(false);
    expect(cloud.getAuthStatus().status).toBe("error");
    expect(cloud.getDevices().map((d) => d.id)).toEqual(["317499063", "357465941"]);
  });

  it("keeps the cached purifiers on a network blip without touching the session", async () => {
    // Rewritten: the old contract here ("a blip resolves with []") encoded the
    // bug. Returning [] for a timeout, a DNS failure or a 500 blanked the tiles
    // while the route still reported available:true, which is the wedge's own
    // symptom reached through a different door. An empty list may ONLY mean the
    // cloud answered and had nothing to report.
    const request = vi.fn(async () => { throw new Error("Request timed out"); });
    const { cloud } = cloudWith(request, [purifier("317499063")]);

    await expect(cloud.fetchDevicesLive()).rejects.toThrow("Request timed out");

    expect(cloud.getDevices().map((d) => d.id)).toEqual(["317499063"]);
    // A blip is not a dead token: flipping the status would spend a full
    // re-login (and risk a captcha) on a dropped packet.
    expect(cloud.isReady()).toBe(true);
    expect(cloud.getAuthStatus().status).toBe("authenticated");
  });

  it("keeps the cached purifiers when refreshDevices hits a network blip", async () => {
    const request = vi.fn(async () => { throw new Error("connect ECONNRESET 1.2.3.4:443"); });
    const { cloud, seam } = cloudWith(request, [purifier("317499063")]);
    seam.deviceCacheTime = 0;

    await expect(cloud.refreshDevices()).resolves.toEqual([purifier("317499063")]);
    await cloud.refreshDevices();

    expect(cloud.getDevices().map((d) => d.id)).toEqual(["317499063"]);
    expect(cloud.isReady()).toBe(true);
    // A failure does not advance deviceCacheTime, so without the retry gate the
    // ~5s collector loop would answer an outage with a list call per tick.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("falls through to the region scan on a blip instead of flipping the auth status", async () => {
    // A non-auth throw from the FIRST discover call would reach init()'s catch
    // and set authStatus "error", making the collector re-login over a blip.
    let call = 0;
    const request = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error("Request timed out");
      return listResult([purifier("357465941")]);
    });
    const { cloud } = cloudWith(request, []);

    await cloud.init();

    expect(cloud.getAuthStatus().status).toBe("authenticated");
    expect(cloud.getDevices().map((d) => d.id)).toEqual(["357465941"]);
  });

  it("does not blank the cache when no region answers", async () => {
    const request = vi.fn(async () => { throw new Error("getaddrinfo ENOTFOUND"); });
    const { cloud } = cloudWith(request, [purifier("317499063")]);

    await cloud.init();

    // "No purifiers found in any region" is a claim only every region answering
    // can support; six silent regions must never empty the cache.
    expect(cloud.getDevices().map((d) => d.id)).toEqual(["317499063"]);
    expect(cloud.isReady()).toBe(true);
  });

  it("stops the region scan on the first 401 instead of burning one per region", async () => {
    const request = vi.fn(async () => { throw new Error("Request error with status Unauthorized"); });
    const { cloud } = cloudWith(request, [purifier("317499063")]);

    await expect(
      (cloud as unknown as { discoverRegionAndDevices: () => Promise<void> }).discoverRegionAndDevices(),
    ).rejects.toThrow("Unauthorized");

    expect(request).toHaveBeenCalledTimes(1); // not one per ALL_REGIONS entry
    expect(cloud.getDevices().map((d) => d.id)).toEqual(["317499063"]);
  });
});

describe("refreshDevices throttle", () => {
  it("throttles even when the cache is empty (the hammering path)", async () => {
    const request = vi.fn(async () => listResult([]));
    const { cloud, seam } = cloudWith(request, []);
    seam.deviceCacheTime = 0;

    await cloud.refreshDevices();
    await cloud.refreshDevices(); // inside the 5-minute window, empty cache

    // The old "&& cachedDevices.length > 0" made an empty cache bypass the
    // throttle entirely, i.e. maximum hammering in exactly the wedged state.
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("device cache merge", () => {
  // The list call answers with identity only; power/mode/aqi/temperature arrive
  // from the props RPCs that follow it. Assigning the list straight over the
  // cache therefore stripped every reading, and the collector's 5-minute step
  // did it twelve times an hour, so the "serve the last-known devices on
  // failure" guarantee handed back tiles with no readings at all.
  it("keeps the enriched readings when the periodic refresh returns identity only", async () => {
    const enriched: PurifierDevice = {
      ...purifier("317499063"),
      power: "on", mode: "auto", aqi: 12, temperature: 24.5, humidity: 41, filter_life: 88, led: true, child_lock: false,
    };
    const request = vi.fn(async () => listResult([{ ...purifier("317499063"), name: "Abdu", isOnline: false }]));
    const { cloud, seam } = cloudWith(request, [enriched]);
    seam.deviceCacheTime = 0;

    await cloud.refreshDevices();

    // Fresh identity (name, isOnline) wins; every reading survives untouched.
    expect(cloud.getDevices()).toEqual([{
      id: "317499063", name: "Abdu", model: "zhimi.airpurifier.v7", isOnline: false,
      power: "on", mode: "auto", aqi: 12, temperature: 24.5, humidity: 41, filter_life: 88, led: true, child_lock: false,
    }]);
  });

  it("drops a device the fresh list no longer contains", async () => {
    const request = vi.fn(async () => listResult([purifier("357465941")]));
    const { cloud, seam } = cloudWith(request, [
      { ...purifier("317499063"), aqi: 12 },
      { ...purifier("357465941"), aqi: 7 },
    ]);
    seam.deviceCacheTime = 0;

    await cloud.refreshDevices();

    // Membership follows the list: merging must not resurrect a device the
    // account no longer has.
    expect(cloud.getDevices().map((d) => d.id)).toEqual(["357465941"]);
    expect(cloud.getDevices()[0].aqi).toBe(7);
  });

  it("keeps a device's last-known readings when its props RPC fails, and marks them not live", async () => {
    const request = vi.fn(async (path: string) => {
      if (path === "/home/device_list") return listResult([purifier("317499063"), purifier("357465941")]);
      if (path === "/home/rpc/317499063") throw new Error("Request timed out");
      // get_prop order: power, mode, favorite_level, aqi, temp_dec, humidity, filter1_life, led, buzzer, child_lock
      return { result: ["on", "auto", 5, 7, 233, 40, 88, "off", "off", "off"] };
    });
    const { cloud } = cloudWith(request, [
      { ...purifier("317499063"), power: "on", aqi: 12, temperature: 24.5 },
      { ...purifier("357465941"), power: "off", aqi: 99 },
    ]);

    const devices = await cloud.fetchDevicesLive();

    const failed = devices.find((d) => d.id === "317499063")!;
    expect(failed.power).toBe("on");
    expect(failed.aqi).toBe(12);
    expect(failed.temperature).toBe(24.5);
    // A kept reading that still claims to be live is the same lie as an
    // available:true with no devices, one device down.
    expect(failed.readingsStale).toBe(true);

    const live = devices.find((d) => d.id === "357465941")!;
    expect(live.aqi).toBe(7);
    expect(live.temperature).toBe(23.3);
    expect(live.readingsStale).toBe(false);
    // A timeout on one device is not a dead token.
    expect(cloud.isReady()).toBe(true);
  });

  it("merges by device id: the list owns identity and membership, the cache owns the readings", () => {
    const previous: PurifierDevice[] = [
      { ...purifier("a"), power: "on", aqi: 12 },
      { ...purifier("b"), aqi: 5 },
    ];
    const fetched: PurifierDevice[] = [
      { ...purifier("a"), name: "renamed", isOnline: false },
      purifier("c"),
    ];

    expect(mergeDeviceCache(previous, fetched)).toEqual([
      { id: "a", name: "renamed", model: "zhimi.airpurifier.v7", isOnline: false, power: "on", aqi: 12 },
      { id: "c", name: "purifier-c", model: "zhimi.airpurifier.v7", isOnline: true },
    ]);
  });
});

describe("concurrent region fetches", () => {
  it("serializes the region borrow so creds.country is never restored out of order", async () => {
    // The fetch points the shared client at its region and restores the old
    // value in a finally, so two overlapping calls restore each other's
    // mid-flight value and aim every later RPC at the wrong regional endpoint.
    const seen: string[] = [];
    const gates: Array<() => void> = [];
    const request = vi.fn(async () => {
      seen.push(String(seam.client.config.credentials.country));
      await new Promise<void>((resolve) => gates.push(resolve));
      return listResult([]);
    });
    const { cloud, seam } = cloudWith(request, []);
    const scan = cloud as unknown as { fetchPurifiersForRegion: (region: string) => Promise<PurifierDevice[]> };

    const first = scan.fetchPurifiersForRegion("de");
    const second = scan.fetchPurifiersForRegion("us");
    await tick();

    // The second borrow may not start while the first one holds the country.
    expect(seen).toEqual(["de"]);
    gates[0]();
    await tick();
    expect(seen).toEqual(["de", "us"]);
    gates[1]();
    await Promise.all([first, second]);

    // Each request saw its own region, and the client is back where it started.
    expect(seam.client.config.credentials.country).toBe("sg");
  });
});

describe("auth status reporting", () => {
  it("clears a stale authError once the session is healthy again", async () => {
    const request = vi.fn(async () => listResult([purifier("317499063", "zhimi.airpurifier.vb2")]));
    const { cloud, seam } = cloudWith(request, []);
    seam.authStatus = "error";
    seam.authError = "serviceToken expired (401)";

    await cloud.init();

    expect(cloud.getAuthStatus().status).toBe("authenticated");
    // Live after the recovery: {"status":"authenticated","error":"serviceToken expired (401)"}
    expect(cloud.getAuthStatus().error).toBeUndefined();
  });
});

describe("protocol selection with an empty cache", () => {
  it("populates the cache before the model lookup so a MIoT unit is not downgraded to miIO", async () => {
    const request = vi.fn(async (path: string) => {
      if (path === "/home/device_list") return listResult([purifier("317499063", "zhimi.airpurifier.vb2")]);
      return { result: "ok" };
    });
    const { cloud } = cloudWith(request, []);

    await cloud.executeAction("317499063", { power: "on" });

    expect(request).toHaveBeenNthCalledWith(1, "/home/device_list", {});
    expect(request).toHaveBeenNthCalledWith(2, "/home/rpc/317499063", {
      method: "set_properties",
      params: [{ did: "power", siid: 2, piid: 2, value: true }],
    });
  });

  it("refuses the command rather than guessing the protocol when the list call fails", async () => {
    // ensureDeviceCachePopulated now throws on a blip. Proceeding would send a
    // legacy miIO set_power to the MIoT vb2 off an unpopulated cache. The route
    // answers 500 and the collector's automation step logs and retries.
    const request = vi.fn(async () => { throw new Error("Request timed out"); });
    const { cloud } = cloudWith(request, []);

    await expect(cloud.executeAction("317499063", { power: "on" })).rejects.toThrow("Request timed out");

    // The list call and nothing else: no RPC was attempted.
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/home/device_list", {});
  });
});

describe("superseded login attempts", () => {
  // The collector holds a single login slot, but it writes an attempt off after
  // a deadline so a genuinely hung init() cannot wedge recovery for good. That
  // permits exactly one overlap: the written-off attempt is still alive when a
  // newer login succeeds, and it settles afterwards. init()'s catch sets
  // authStatus "error" outside the 2FA guard, so without an attempt id inside
  // the cloud object that late settle stamps a HEALTHY session back to "error"
  // (the collector's guard cannot see in here).

  /** login stub whose first call is held open, standing in for the hung attempt. */
  function gatedLogin(): { login: (opts: unknown) => Promise<void>; settleFirst: (err?: Error) => void; handlers: LoginHandlers[] } {
    const handlers: LoginHandlers[] = [];
    let resolveFirst: () => void = () => {};
    let rejectFirst: (err: Error) => void = () => {};
    let calls = 0;
    const login = vi.fn(async (opts: unknown) => {
      handlers.push(opts as LoginHandlers);
      calls++;
      if (calls === 1) {
        return new Promise<void>((resolve, reject) => {
          resolveFirst = resolve;
          rejectFirst = reject;
        });
      }
      return undefined;
    });
    return { login, settleFirst: (err?: Error) => (err ? rejectFirst(err) : resolveFirst()), handlers };
  }

  it("keeps a healthy session healthy when a superseded attempt fails late", async () => {
    const request = vi.fn(async () => listResult([purifier("317499063")]));
    const { cloud, seam } = cloudWith(request, []);
    const { login, settleFirst } = gatedLogin();
    seam.client.miot.login = login;
    seam.authStatus = "error";
    seam.authError = "serviceToken expired (401)";

    const superseded = cloud.init(); // hangs past the collector's deadline
    await tick();
    await cloud.init();               // the newer login that actually recovers
    expect(cloud.isReady()).toBe(true);

    settleFirst(new Error("Request timed out"));
    await superseded;

    expect(cloud.getAuthStatus().status).toBe("authenticated");
    expect(cloud.getAuthStatus().error).toBeUndefined();
    expect(cloud.isReady()).toBe(true);
    expect(cloud.getDevices().map((d) => d.id)).toEqual(["317499063"]);
  });

  it("still records the error when the CURRENT attempt fails", async () => {
    // The guard may only silence a superseded attempt: silencing the live one
    // would leave the collector with no failure to escalate on.
    const { cloud, seam } = cloudWith(vi.fn(async () => listResult([])), []);
    seam.client.miot.login = vi.fn(async () => { throw new Error("Request error with status Unauthorized"); });
    seam.authStatus = "not_configured";

    await cloud.init();

    expect(cloud.getAuthStatus().status).toBe("error");
    expect(cloud.getAuthStatus().error).toBe("Request error with status Unauthorized");
    expect(cloud.isReady()).toBe(false);
  });

  it("discards a superseded attempt's late SUCCESS instead of overwriting the current session", async () => {
    const request = vi.fn(async () => listResult([purifier("357465941")]));
    const { cloud, seam } = cloudWith(request, []);
    const { login, settleFirst } = gatedLogin();
    seam.client.miot.login = login;

    const superseded = cloud.init();
    await tick();
    await cloud.init();
    const listCalls = request.mock.calls.length;

    // The current session then loses its token (a 401 anywhere on the props or
    // list path), so "authenticated" is now the wrong answer.
    await cloud.invalidateAuth();

    settleFirst();
    await superseded;

    // A late success republishing "authenticated" is the mirror of the late
    // failure: isReady() true on tokens the cloud has already rejected. And it
    // must not run a second discovery pass over the current cache.
    expect(cloud.getAuthStatus().status).toBe("error");
    expect(cloud.getAuthStatus().error).toBe("serviceToken expired (401)");
    expect(cloud.isReady()).toBe(false);
    expect(request.mock.calls.length).toBe(listCalls);
    expect(cloud.getDevices().map((d) => d.id)).toEqual(["357465941"]);
  });

  it("abandons a superseded attempt's 2FA prompt instead of stealing the live resolver", async () => {
    const request = vi.fn(async () => listResult([purifier("317499063")]));
    const { cloud, seam } = cloudWith(request, []);
    const { login, handlers } = gatedLogin();
    seam.client.miot.login = login;
    seam.authStatus = "error";

    void cloud.init(); // held open: the attempt the collector writes off
    await tick();
    await cloud.init();

    // POST /api/xiaomi/verify hands the code to whichever resolver is parked on
    // the instance, so a dead attempt parking one spends the human's code on a
    // login nobody is waiting for. "" is xmihome's abort answer.
    await expect(handlers[0].on2fa("https://account.xiaomi.com/notification")).resolves.toBe("");
    await expect(handlers[0].onCaptcha("data:image/jpeg;base64,AAA")).resolves.toBe("");

    expect(seam.pending2faResolve).toBeNull();
    expect(cloud.getAuthStatus().status).toBe("authenticated");
    expect(cloud.isReady()).toBe(true);
  });

  it("still parks the resolver and reports needs_2fa for the CURRENT attempt", async () => {
    const request = vi.fn(async () => listResult([purifier("317499063")]));
    const { cloud, seam } = cloudWith(request, []);
    const { login, handlers } = gatedLogin();
    seam.client.miot.login = login;
    seam.authStatus = "error";

    void cloud.init();
    await tick();

    const prompt = handlers[0].on2fa("https://account.xiaomi.com/notification");
    await tick();

    expect(cloud.getAuthStatus().status).toBe("needs_2fa");
    expect(typeof seam.pending2faResolve).toBe("function");
    // The parked resolver is the one /api/xiaomi/verify feeds.
    seam.pending2faResolve!("123456");
    await expect(prompt).resolves.toBe("123456");
  });
});
