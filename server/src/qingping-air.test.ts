import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { Config } from "./config.js";
import { Collector, QP_INTERVAL_RESEND_MIN_MS, QP_SLOW_REPORT_GAP_MS } from "./collector.js";

// 2026-11-23: the Qingping air monitor ran its battery flat, rebooted on its factory
// 15-minute report interval, and the dashboard showed ~15-minute-old air data for 3 hours,
// because the 15 s interval setting was only ever sent when OUR MQTT client connected. On
// top of that the cloud fallback replaced a newer MQTT reading with an older cloud sample.
// Uplink "12" is one real-time reading; uplink "17" is a rolling history window (50 samples,
// newest first, re-sent every report), captured live the same day.

const config = {
  qpAppKey: "", qpAppSecret: "", awApiKey: "", awAppKey: "", databaseUrl: "",
  vapidPublicKey: "", vapidPrivateKey: "", vapidSubject: "",
  mqttBrokerUrl: "", mqttUsername: "", mqttPassword: "", mqttQingpingMac: "582D3470F981",
  miEmail: "", miPassword: "", miRegion: "sg", tclUsername: "", tclPassword: "",
  authSecret: "", adminUser: "", adminPassword: "", hermesApiToken: "", observedOffLocks: true,
} as Config;

interface QpSeam {
  mqttClient: { connected: boolean; publish: ReturnType<typeof vi.fn> } | null;
  handleMqttMessage(payload: Buffer): Promise<void>;
  collectQingping(): Promise<void>;
  ensureQpToken(): Promise<void>;
  latestAirTs: Date | null;
  lastMqttMessage: number;
}

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** A real-time type-12 reading, sampled at `sampleIso` (default: now). */
function reading(co2: number, sampleIso?: string): Buffer {
  const timestamp = { value: sec(sampleIso ?? new Date().toISOString()) };
  return Buffer.from(JSON.stringify({
    type: "12",
    sensorData: [{ co2: { value: co2 }, pm25: { value: 30 }, battery: { value: 100, status: 1 }, timestamp }],
  }));
}

/** A type-17 history window, newest first. */
function history(entries: Array<{ co2: number; sampleIso: string }>): Buffer {
  return Buffer.from(JSON.stringify({
    type: "17",
    need_ack: 1,
    sensorData: entries.map((e) => ({ co2: { value: e.co2 }, timestamp: { value: sec(e.sampleIso) } })),
  }));
}

function setup() {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const collector = new Collector({ query } as never, config);
  const seam = collector as unknown as QpSeam;
  const publish = vi.fn((_topic: string, _msg: string, _opts: unknown, cb?: (err?: Error) => void) => cb?.());
  seam.mqttClient = { connected: true, publish };
  seam.ensureQpToken = async () => undefined;
  const intervalSends = () =>
    publish.mock.calls.filter(([topic, msg]) => topic === "qingping/582D3470F981/down" && JSON.parse(msg as string).type === "17");
  return { collector, seam, publish, intervalSends, query };
}

function stubCloud(sampleIso: string, co2: number) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({ devices: [{ data: { timestamp: { value: sec(sampleIso) }, co2: { value: co2 } } }] }),
  })));
}

describe("Qingping air monitor: interval re-send after a slow report (2026-11-23)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T01:36:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("re-sends the 15 s interval when a reading arrives after a long silence (rebooted on its default)", async () => {
    const { seam, intervalSends } = setup();
    await seam.handleMqttMessage(reading(600));
    vi.advanceTimersByTime(15 * 60_000); // the factory 15-minute cadence
    await seam.handleMqttMessage(reading(610));
    expect(intervalSends()).toHaveLength(1);
    const cfg = JSON.parse(intervalSends()[0][1] as string);
    expect(cfg.setting).toMatchObject({ report_interval: 15, collect_interval: 15 });
  });

  it("stays quiet on the normal 15 s cadence and on the first reading after our own boot", async () => {
    const { seam, intervalSends } = setup();
    await seam.handleMqttMessage(reading(600)); // first reading: connect already sent the setting
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(15_000);
      await seam.handleMqttMessage(reading(600 + i));
    }
    expect(intervalSends()).toHaveLength(0);
  });

  it("treats a gap just over the threshold as slow, and exactly at it as normal", async () => {
    const { seam, intervalSends } = setup();
    await seam.handleMqttMessage(reading(600));
    vi.advanceTimersByTime(QP_SLOW_REPORT_GAP_MS);
    await seam.handleMqttMessage(reading(601));
    expect(intervalSends()).toHaveLength(0);
    vi.advanceTimersByTime(QP_SLOW_REPORT_GAP_MS + 1);
    await seam.handleMqttMessage(reading(602));
    expect(intervalSends()).toHaveLength(1);
  });

  it("throttles re-sends for a unit that keeps ignoring the setting", async () => {
    const { seam, intervalSends } = setup();
    await seam.handleMqttMessage(reading(600));
    vi.advanceTimersByTime(2 * 60_000);
    await seam.handleMqttMessage(reading(601)); // send #1
    vi.advanceTimersByTime(2 * 60_000);
    await seam.handleMqttMessage(reading(602)); // inside the throttle window
    expect(intervalSends()).toHaveLength(1);
    vi.advanceTimersByTime(QP_INTERVAL_RESEND_MIN_MS);
    await seam.handleMqttMessage(reading(603)); // window passed
    expect(intervalSends()).toHaveLength(2);
  });

  it("allows the next re-send at exactly the throttle window", async () => {
    const { seam, intervalSends } = setup();
    await seam.handleMqttMessage(reading(600));
    vi.advanceTimersByTime(2 * 60_000);
    await seam.handleMqttMessage(reading(601)); // send #1
    vi.advanceTimersByTime(QP_INTERVAL_RESEND_MIN_MS);
    await seam.handleMqttMessage(reading(602)); // exactly 5 min later, gap > 60 s
    expect(intervalSends()).toHaveLength(2);
  });

  it("does not let a settings ack reset the report clock (it is not a report)", async () => {
    const { seam, intervalSends } = setup();
    await seam.handleMqttMessage(reading(600));
    vi.advanceTimersByTime(55_000);
    await seam.handleMqttMessage(Buffer.from(JSON.stringify({ type: "28", setting: { report_interval: 15 } })));
    vi.advanceTimersByTime(10_000);
    await seam.handleMqttMessage(reading(601)); // 65 s after the last report
    expect(intervalSends()).toHaveLength(1);
  });

  it("counts a history window as a report for the cadence (it arrives with every report)", async () => {
    const { seam, intervalSends } = setup();
    await seam.handleMqttMessage(reading(600));
    vi.advanceTimersByTime(50_000);
    await seam.handleMqttMessage(history([{ co2: 600, sampleIso: new Date().toISOString() }]));
    vi.advanceTimersByTime(50_000);
    await seam.handleMqttMessage(reading(601));
    expect(intervalSends()).toHaveLength(0);
  });
});

describe("Qingping live reading: real-time MQTT wins, history and stale cloud never rewind it (2026-11-23)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T04:21:01Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a newer MQTT reading when the cloud sample is older, but still stores the sample", async () => {
    const { collector, seam, query } = setup();
    await seam.handleMqttMessage(reading(625, "2026-11-23T04:21:00Z")); // arrives 04:21:01
    stubCloud("2026-11-23T04:15:00Z", 602);
    await seam.collectQingping();
    expect(collector.getLatestAir()).toMatchObject({ co2: 625 });
    expect(seam.latestAirTs?.toISOString()).toBe("2026-11-23T04:21:01.000Z");
    const inserts = query.mock.calls.filter((c) => String((c as unknown[])[0]).includes("INSERT INTO air_readings"));
    expect(inserts.some((c) => ((c as unknown[])[1] as unknown[])[3] === 602)).toBe(true);
  });

  it("a history window never drives the live reading, however old or new its entries", async () => {
    const { collector, seam } = setup();
    stubCloud("2026-11-23T04:20:00Z", 633);
    await seam.collectQingping(); // cloud 04:20 is live
    vi.advanceTimersByTime(15_000);
    // Offline backlog, 4 min and 61 min behind the live sample.
    await seam.handleMqttMessage(history([
      { co2: 611, sampleIso: "2026-11-23T04:16:00Z" },
      { co2: 590, sampleIso: "2026-11-23T03:19:00Z" },
    ]));
    expect(collector.getLatestAir()).toMatchObject({ co2: 633 });
    expect(seam.latestAirTs?.toISOString()).toBe("2026-11-23T04:20:00.000Z");
    // ...and it does not count as live MQTT, so the cloud fallback is not paused by it.
    expect(seam.lastMqttMessage).toBe(0);
    // A real-time reading takes over at once.
    await seam.handleMqttMessage(reading(640));
    expect(collector.getLatestAir()).toMatchObject({ co2: 640 });
  });

  it("a real-time reading wins even when the device clock jumped back (deep reboot)", async () => {
    const { collector, seam } = setup();
    await seam.handleMqttMessage(reading(625, "2026-11-23T04:21:00Z"));
    vi.advanceTimersByTime(15_000);
    await seam.handleMqttMessage(reading(650, "2026-11-23T03:50:00Z")); // 31 min back
    expect(collector.getLatestAir()).toMatchObject({ co2: 650 });
    vi.advanceTimersByTime(15_000);
    await seam.handleMqttMessage(reading(655, "2020-01-01T00:00:15Z")); // years back
    expect(collector.getLatestAir()).toMatchObject({ co2: 655 });
  });

  it("a future-dated cloud sample (wrong device clock) is stored but never goes live, and cannot block recovery", async () => {
    const { collector, seam, query } = setup();
    stubCloud("2026-11-23T09:00:00Z", 700);
    await seam.collectQingping();
    expect(collector.getLatestAir()).toBeNull();
    expect(query.mock.calls.some((c) => String((c as unknown[])[0]).includes("INSERT INTO air_readings"))).toBe(true);
    vi.advanceTimersByTime(60_000);
    stubCloud("2026-11-23T04:22:00Z", 610); // the clock corrected: adopted at once, not at 09:00
    await seam.collectQingping();
    expect(collector.getLatestAir()).toMatchObject({ co2: 610 });
  });

  it("a cloud sample dated seconds ahead waits until it is in the past, and never re-wins after MQTT (recheck 4)", async () => {
    const { collector, seam } = setup();
    stubCloud("2026-11-23T04:21:30Z", 640); // device clock 29 s fast, now 04:21:01
    await seam.collectQingping();
    expect(collector.getLatestAir()).toBeNull();
    vi.advanceTimersByTime(30_000); // 04:21:31: now in the past
    await seam.collectQingping();
    expect(collector.getLatestAir()).toMatchObject({ co2: 640 });
    vi.advanceTimersByTime(15_000);
    await seam.handleMqttMessage(reading(625)); // 04:21:46, after the adopted sample
    vi.advanceTimersByTime(3 * 60_000);
    await seam.collectQingping(); // the same cached sample again
    expect(collector.getLatestAir()).toMatchObject({ co2: 625 });
    expect(seam.latestAirTs?.toISOString()).toBe("2026-11-23T04:21:46.000Z");
  });

  it("a type-12 reading that lands during the token refresh also wins (recheck 4)", async () => {
    const { collector, seam } = setup();
    seam.ensureQpToken = async () => {
      await seam.handleMqttMessage(reading(625)); // 04:21:01
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => {
        vi.advanceTimersByTime(20_000); // a slow cloud answer: now 04:21:21
        // Newer than the MQTT arrival and already in the past: only the in-flight guard stops it.
        return { devices: [{ data: { timestamp: { value: sec("2026-11-23T04:21:10Z") }, co2: { value: 602 } } }] };
      },
    })));
    await seam.collectQingping();
    expect(collector.getLatestAir()).toMatchObject({ co2: 625 });
  });

  it.each([["a string", "bogus"], ["null (would coerce to 1970)", null], ["zero", 0], ["missing", undefined], ["beyond the Date range", 1e20]])(
    "a cloud sample whose timestamp is %s is ignored and the next valid poll still updates",
    async (_label, value) => {
      const { collector, seam, query } = setup();
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: true,
        json: async () => ({ devices: [{ data: { timestamp: value === undefined ? undefined : { value }, co2: { value: 1 } } }] }),
      })));
      await seam.collectQingping();
      expect(collector.getLatestAir()).toBeNull();
      expect(query.mock.calls.some((c) => String((c as unknown[])[0]).includes("INSERT INTO air_readings"))).toBe(false);
      stubCloud("2026-11-23T04:20:00Z", 602);
      await seam.collectQingping();
      expect(collector.getLatestAir()).toMatchObject({ co2: 602 });
    },
  );

  it("a type-12 reading stamped with the SAME time as the last one (clock stepped back) mid-poll still wins (recheck 6)", async () => {
    const { collector, seam, query } = setup();
    await seam.handleMqttMessage(reading(600)); // 04:21:01
    vi.setSystemTime(new Date("2026-11-23T04:24:00Z")); // MQTT quiet, a fallback poll starts
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => {
        vi.setSystemTime(new Date("2026-11-23T04:21:01Z")); // clock steps back to the same ms
        await seam.handleMqttMessage(reading(625));
        vi.setSystemTime(new Date("2026-11-23T04:21:21Z"));
        return { devices: [{ data: { timestamp: { value: sec("2026-11-23T04:21:10Z") }, co2: { value: 602 } } }] };
      },
    })));
    await seam.collectQingping();
    expect(collector.getLatestAir()).toMatchObject({ co2: 625 });
    const inserts = query.mock.calls.filter((c) => String((c as unknown[])[0]).includes("INSERT INTO air_readings"));
    expect(inserts.some((c) => ((c as unknown[])[1] as unknown[])[3] === 602)).toBe(true);
  });

  it("a server clock stepping back never rewinds the live time, so the cached cloud sample cannot reclaim live (recheck 5)", async () => {
    const { collector, seam } = setup();
    stubCloud("2026-11-23T04:20:00Z", 600);
    await seam.collectQingping(); // cloud 04:20 live
    vi.setSystemTime(new Date("2026-11-23T04:10:00Z")); // server clock steps back 11 min
    await seam.handleMqttMessage(reading(625));
    expect(collector.getLatestAir()).toMatchObject({ co2: 625 }); // MQTT still updates the value
    expect(seam.latestAirTs?.toISOString()).toBe("2026-11-23T04:20:00.000Z"); // never decreases
    vi.setSystemTime(new Date("2026-11-23T04:25:00Z")); // MQTT quiet, clock past the cloud sample
    await seam.collectQingping(); // the identical cached 04:20 sample
    expect(collector.getLatestAir()).toMatchObject({ co2: 625 });
  });

  it("a type-12 reading that lands while a cloud poll is in flight stays live (the sample is still stored)", async () => {
    const { collector, seam, query } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => {
        await seam.handleMqttMessage(reading(625)); // arrives mid-poll, 04:21:01
        // The cloud's sample is dated after it (device clock a few seconds ahead).
        return { devices: [{ data: { timestamp: { value: sec("2026-11-23T04:21:30Z") }, co2: { value: 602 } } }] };
      },
    })));
    await seam.collectQingping();
    expect(collector.getLatestAir()).toMatchObject({ co2: 625 });
    const inserts = query.mock.calls.filter((c) => String((c as unknown[])[0]).includes("INSERT INTO air_readings"));
    expect(inserts.some((c) => ((c as unknown[])[1] as unknown[])[3] === 602)).toBe(true);
  });

  it("a replayed or out-of-order older cloud sample never reclaims the live row", async () => {
    const { collector, seam } = setup();
    stubCloud("2026-11-23T04:15:00Z", 600); // A
    await seam.collectQingping();
    expect(collector.getLatestAir()).toMatchObject({ co2: 600 });
    vi.advanceTimersByTime(15_000);
    await seam.handleMqttMessage(reading(625)); // MQTT takes over, 04:21:16
    vi.advanceTimersByTime(3 * 60_000);
    stubCloud("2026-11-23T04:18:00Z", 610); // B, older than live
    await seam.collectQingping();
    stubCloud("2026-11-23T04:15:00Z", 600); // A again (replay / a slow poll finishing late)
    await seam.collectQingping();
    expect(collector.getLatestAir()).toMatchObject({ co2: 625 });
    expect(seam.latestAirTs?.toISOString()).toBe("2026-11-23T04:21:16.000Z");
  });

  it("adopts a new cloud sample newer than the live reading", async () => {
    const { collector, seam } = setup();
    await seam.handleMqttMessage(reading(625));
    vi.advanceTimersByTime(20 * 60_000);
    stubCloud("2026-11-23T04:30:00Z", 640);
    await seam.collectQingping();
    expect(collector.getLatestAir()).toMatchObject({ co2: 640 });
  });

  it("adopts the cloud sample when there is no live reading yet", async () => {
    const { collector, seam } = setup();
    stubCloud("2026-11-23T04:15:00Z", 602);
    await seam.collectQingping();
    expect(collector.getLatestAir()).toMatchObject({ co2: 602 });
  });

  it("falls back to the arrival time when a real-time reading carries no sample time", async () => {
    const { collector, seam } = setup();
    await seam.handleMqttMessage(Buffer.from(JSON.stringify({ type: "12", sensorData: [{ co2: { value: 625 } }] })));
    stubCloud("2026-11-23T04:15:00Z", 602);
    await seam.collectQingping();
    expect(collector.getLatestAir()).toMatchObject({ co2: 625 });
  });
});
