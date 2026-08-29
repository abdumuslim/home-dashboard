import { describe, it, expect } from "vitest";
import {
  Ct02Feed,
  CT02_CHANNELS,
  CT02_MAX_TOPICS,
  CT02_MAX_PAYLOAD_CHARS,
  CT02_METER_MIN_GAP_MS,
  CT02_METER_CHANNEL_FRESH_MS,
  CT02_METER_RESUME_GAP_MS,
  assessPorts,
  decodeChannelPayload,
  parseChannelTopic,
  CT02_MAX_OBSERVATIONS,
  type Ct02ChannelState,
  type Ct02MeterReading,
  type PortObservation,
} from "./ct02-feed.js";

const BASE = "ln882hC25E1088";

function spec(key: string) {
  const found = CT02_CHANNELS.find(c => c.key === key);
  if (!found) throw new Error(`no channel spec for ${key}`);
  return found;
}

/** Feed with a controllable clock so history/throttle behaviour is deterministic. */
function makeFeed(startMs = 1_000_000) {
  let now = startMs;
  const feed = new Ct02Feed({
    brokerUrl: "mqtt://test:1883",
    username: "u",
    password: "p",
    topicBase: BASE,
    now: () => now,
  });
  return {
    feed,
    advance(ms: number) { now += ms; },
    at() { return now; },
  };
}

describe("parseChannelTopic", () => {
  it("maps the device's channel indices to their meaning", () => {
    expect(parseChannelTopic(`${BASE}/3/get`, BASE)?.key).toBe("current_a");
    expect(parseChannelTopic(`${BASE}/4/get`, BASE)?.key).toBe("current_b");
    expect(parseChannelTopic(`${BASE}/0/get`, BASE)?.key).toBe("voltage");
    expect(parseChannelTopic(`${BASE}/11/get`, BASE)?.key).toBe("import_b");
  });

  it("ignores foreign, malformed and unmapped topics", () => {
    expect(parseChannelTopic("qingping/582D3470F981/up", BASE)).toBeNull();
    expect(parseChannelTopic(`${BASE}/3/set`, BASE)).toBeNull();
    expect(parseChannelTopic(`${BASE}/voltage/get`, BASE)).toBeNull();
    // Channel 2 (PowerFactor) and 7 (apparent power) are never populated by the driver.
    expect(parseChannelTopic(`${BASE}/2/get`, BASE)).toBeNull();
    expect(parseChannelTopic(`${BASE}/7/get`, BASE)).toBeNull();
    expect(parseChannelTopic(`${BASE}/3/get`, "")).toBeNull();
  });

  it("does not match a different device sharing a topic prefix", () => {
    expect(parseChannelTopic(`${BASE}extra/3/get`, BASE)).toBeNull();
  });

  it("rejects non-canonical index aliases", () => {
    // "03"/"003" also parse to 3. Accepting them would mint unlimited distinct
    // topic-map keys that all count as recognised, walking past the topic cap.
    expect(parseChannelTopic(`${BASE}/03/get`, BASE)).toBeNull();
    expect(parseChannelTopic(`${BASE}/003/get`, BASE)).toBeNull();
    expect(parseChannelTopic(`${BASE}/0003/get`, BASE)).toBeNull();
    expect(parseChannelTopic(`${BASE}/3/get`, BASE)?.key).toBe("current_a");
  });
});

describe("decodeChannelPayload", () => {
  it("scales the raw integer OpenBeken publishes", () => {
    expect(decodeChannelPayload(spec("current_a"), "4140")).toEqual({
      value: 4.14, raw: 4140, preScaled: false,
    });
    expect(decodeChannelPayload(spec("voltage"), "21502")).toEqual({
      value: 215.02, raw: 21502, preScaled: false,
    });
  });

  it("keeps an exact zero distinguishable from a noise-floor reading", () => {
    expect(decodeChannelPayload(spec("current_b"), "0")?.raw).toBe(0);
    expect(decodeChannelPayload(spec("current_b"), "3")?.raw).toBe(3);
    expect(decodeChannelPayload(spec("current_b"), "3")?.value).toBeCloseTo(0.003, 6);
  });

  it("treats a decimal payload as already scaled, so multiplied-values mode is not divided twice", () => {
    expect(decodeChannelPayload(spec("current_a"), "4.140")).toEqual({
      value: 4.14, raw: 4140, preScaled: true,
    });
  });

  it("accepts a negative power reading (clamp A is mounted backwards)", () => {
    expect(decodeChannelPayload(spec("power_a"), "-73500")?.value).toBeCloseTo(-735, 6);
  });

  it("rejects junk instead of poisoning the snapshot with NaN", () => {
    expect(decodeChannelPayload(spec("current_a"), "")).toBeNull();
    expect(decodeChannelPayload(spec("current_a"), "  ")).toBeNull();
    expect(decodeChannelPayload(spec("current_a"), "online")).toBeNull();
  });
});

describe("Ct02Feed.handleMessage", () => {
  it("decodes channel updates and counts them", () => {
    const { feed, advance } = makeFeed();
    feed.handleMessage(`${BASE}/3/get`, "1000");
    advance(2000);
    feed.handleMessage(`${BASE}/3/get`, "2000");

    const snap = feed.snapshot();
    expect(snap.channels.current_a.value).toBe(2);
    expect(snap.channels.current_a.updateCount).toBe(2);
    expect(snap.connection.messageCount).toBe(2);
  });

  it("tracks how long a value has been frozen — a silent port's tell", () => {
    const { feed, advance } = makeFeed();
    for (let i = 0; i < 4; i++) {
      feed.handleMessage(`${BASE}/4/get`, "0");
      advance(2000);
    }
    expect(feed.snapshot().channels.current_b.unchangedFor).toBe(3);

    feed.handleMessage(`${BASE}/4/get`, "120");
    expect(feed.snapshot().channels.current_b.unchangedFor).toBe(0);
  });

  it("records every topic seen, including ones it cannot decode", () => {
    const { feed } = makeFeed();
    feed.handleMessage(`${BASE}/connected`, "online");
    feed.handleMessage(`tele/${BASE}/SENSOR`, '{"ENERGY":{}}');

    const topics = feed.snapshot().topics.map(t => t.topic);
    expect(topics).toContain(`${BASE}/connected`);
    expect(topics).toContain(`tele/${BASE}/SENSOR`);
    expect(feed.snapshot().channels.current_a).toBeUndefined();
  });

  it("throttles history so a burst of channel publishes is one sample", () => {
    const { feed, advance } = makeFeed();
    feed.handleMessage(`${BASE}/0/get`, "21500");
    feed.handleMessage(`${BASE}/3/get`, "1000");
    feed.handleMessage(`${BASE}/4/get`, "0");
    expect(feed.snapshot().history).toHaveLength(1);

    advance(1500);
    feed.handleMessage(`${BASE}/3/get`, "1100");
    expect(feed.snapshot().history).toHaveLength(2);
  });

  it("caps retained history", () => {
    let now = 0;
    const feed = new Ct02Feed({
      brokerUrl: "mqtt://test:1883", username: "u", password: "p", topicBase: BASE,
      historyLimit: 5, historyMinGapMs: 0, now: () => now,
    });
    for (let i = 0; i < 20; i++) { now += 1000; feed.handleMessage(`${BASE}/3/get`, String(i)); }

    const history = feed.snapshot().history;
    expect(history).toHaveLength(5);
    expect(history[history.length - 1].current_a).toBeCloseTo(0.019, 6);
  });

  it("carries the newest value of every channel into each sample", () => {
    const { feed, advance } = makeFeed();
    feed.handleMessage(`${BASE}/0/get`, "21500");
    feed.handleMessage(`${BASE}/3/get`, "4140");
    advance(1500);
    feed.handleMessage(`${BASE}/4/get`, "0");

    const latest = feed.snapshot().history.at(-1)!;
    expect(latest.voltage).toBe(215);
    expect(latest.current_a).toBeCloseTo(4.14, 6);
    expect(latest.current_b).toBe(0);
  });

  it("keeps a distinct MQTT client id from the collector's Qingping client", () => {
    const { feed } = makeFeed();
    // The collector uses `home-dashboard-<ts>`; a collision evicts one client
    // into a permanent reconnect loop and silently kills the air feed.
    expect(feed.clientId).toMatch(/^home-dashboard-ct02-\d+$/);
    expect(feed.clientId).not.toMatch(/^home-dashboard-\d+$/);
    expect(feed.subscriptions).toEqual([`${BASE}/#`, `tele/${BASE}/#`, `stat/${BASE}/#`]);
    expect(feed.configured).toBe(true);
  });

  it("bounds the topic map so a rogue publisher cannot grow it without limit", () => {
    const { feed, advance } = makeFeed();
    for (let i = 0; i < CT02_MAX_TOPICS + 25; i++) {
      advance(1);
      feed.handleMessage(`${BASE}/junk${i}`, "x");
    }

    const snap = feed.snapshot();
    expect(snap.topics.length).toBeLessThanOrEqual(CT02_MAX_TOPICS);
    expect(snap.connection.topicsEvicted).toBe(25);
  });

  it("protects the device's own topics from a junk-topic flood", () => {
    const { feed, advance } = makeFeed();
    feed.handleMessage(`${BASE}/3/get`, "4140");
    feed.handleMessage(`${BASE}/rssi`, "-50");

    for (let i = 0; i < CT02_MAX_TOPICS * 3; i++) {
      advance(1);
      feed.handleMessage(`${BASE}/junk${i}`, "x");
    }

    const snap = feed.snapshot();
    const topics = snap.topics.map(t => t.topic);
    expect(topics).toContain(`${BASE}/3/get`);
    expect(topics).toContain(`${BASE}/rssi`);
    expect(snap.channels.current_a.value).toBeCloseTo(4.14, 6);
    expect(snap.connection.topicsEvicted).toBeGreaterThan(0);
  });

  it("never exceeds the topic cap, even flooded with alias-shaped topics", () => {
    const { feed, advance } = makeFeed();
    for (let i = 0; i < CT02_MAX_TOPICS * 2; i++) {
      advance(1);
      feed.handleMessage(`${BASE}/${"0".repeat(i % 5 + 1)}3/get`, "4140");
    }
    expect(feed.snapshot().topics.length).toBeLessThanOrEqual(CT02_MAX_TOPICS);
  });

  it("truncates an oversized payload but still decodes the real value", () => {
    const { feed } = makeFeed();
    feed.handleMessage(`${BASE}/note`, "z".repeat(CT02_MAX_PAYLOAD_CHARS + 50));
    feed.handleMessage(`${BASE}/3/get`, "4140");

    const note = feed.snapshot().topics.find(t => t.topic === `${BASE}/note`)!;
    expect(note.value.length).toBe(CT02_MAX_PAYLOAD_CHARS + 1); // + the ellipsis
    expect(feed.snapshot().channels.current_a.value).toBeCloseTo(4.14, 6);
  });

  it("judges a port by when it ACTUALLY reported, not by the newest sample's time", () => {
    // A reports, then falls silent for 150s while B keeps publishing. Samples
    // written during that silence still carry A's 4.14 A forward, but A's own
    // observation is outside the window, so the verdict must be withheld.
    const { feed, advance } = makeFeed();
    feed.handleMessage(`${BASE}/3/get`, "4140");

    advance(150_000);
    feed.handleMessage(`${BASE}/4/get`, "0");

    const snap = feed.snapshot();
    expect(snap.history.at(-1)!.current_a).toBeCloseTo(4.14, 6); // carried forward for the chart
    expect(snap.assessment.aStale).toBe(true);
    expect(snap.assessment.verdict).toBe("stale");
    expect(snap.assessment.aNonZero).toBe(0);
  });

  it("records an observation for EVERY current reading, not just the throttled samples", () => {
    // Codex round 3, finding 2. The chart throttles to one sample per second;
    // the verdict must still see every reading.
    const { feed } = makeFeed();
    for (let i = 0; i < 5; i++) feed.handleMessage(`${BASE}/3/get`, String(1000 + i));

    // All five landed in the same millisecond, so the chart kept one sample...
    expect(feed.snapshot().history).toHaveLength(1);
    // ...but the assessment must have seen all five.
    expect(feed.snapshot().assessment.aNonZero).toBe(5);
  });

  it("does not collapse two different readings that share a millisecond", () => {
    const { feed } = makeFeed();
    feed.handleMessage(`${BASE}/4/get`, "0");
    feed.handleMessage(`${BASE}/4/get`, "4100");
    feed.handleMessage(`${BASE}/3/get`, "4200");

    // The live B reading must not be swallowed by the zero that shared its tick.
    const assessment = feed.snapshot().assessment;
    expect(assessment.bNonZero).toBe(1);
    expect(assessment.verdict).toBe("both-live");
  });

  it("bounds the observation rings", () => {
    const { feed, advance } = makeFeed();
    for (let i = 0; i < CT02_MAX_OBSERVATIONS + 50; i++) {
      advance(1);
      feed.handleMessage(`${BASE}/3/get`, "4140");
    }
    // Ring is capped; the window filter then trims further by age.
    expect(feed.snapshot().assessment.aNonZero).toBeLessThanOrEqual(CT02_MAX_OBSERVATIONS);
  });

  it("keeps the raw integers in history so an exact zero stays provable", () => {
    const { feed, advance } = makeFeed();
    feed.handleMessage(`${BASE}/3/get`, "4140");
    advance(1500);
    feed.handleMessage(`${BASE}/4/get`, "0");

    const latest = feed.snapshot().history.at(-1)!;
    expect(latest.raw_a).toBe(4140);
    expect(latest.raw_b).toBe(0);
  });
});

describe("Ct02Feed meter emission (onReading)", () => {
  /** Feed wired as the active power meter, capturing every emitted reading. */
  function makeMeterFeed(startMs = 1_000_000) {
    let now = startMs;
    const readings: Ct02MeterReading[] = [];
    const feed = new Ct02Feed({
      brokerUrl: "mqtt://test:1883", username: "u", password: "p", topicBase: BASE,
      now: () => now,
      onReading: (r) => readings.push(r),
    });
    return { feed, readings, advance(ms: number) { now += ms; } };
  }

  it("does not emit until voltage, current_a and current_b have all been seen", () => {
    const { feed, readings, advance } = makeMeterFeed();
    feed.handleMessage(`${BASE}/0/get`, "21160"); // voltage 211.6 V
    advance(2000);
    feed.handleMessage(`${BASE}/3/get`, "7");      // grid clamp 0.007 A
    advance(2000);
    expect(readings).toHaveLength(0);              // current_b still unseen

    feed.handleMessage(`${BASE}/4/get`, "9144");   // gen clamp 9.144 A -> all three
    expect(readings).toHaveLength(1);
  });

  it("maps port A to i1, port B to i2 and voltage to v, with raw integers scaled", () => {
    const { feed, readings } = makeMeterFeed();
    feed.handleMessage(`${BASE}/0/get`, "21160");
    feed.handleMessage(`${BASE}/3/get`, "7");
    feed.handleMessage(`${BASE}/4/get`, "9144");   // raw 9144 -> 9.144
    expect(readings).toEqual([{ v: 211.6, i1: 0.007, i2: 9.144 }]);
  });

  it("emits on the current_b message, never on this tick's earlier voltage/current_a", () => {
    const { feed, readings, advance } = makeMeterFeed();
    // First full tick establishes all three and emits on its current_b.
    feed.handleMessage(`${BASE}/0/get`, "22000");
    feed.handleMessage(`${BASE}/3/get`, "6000");
    feed.handleMessage(`${BASE}/4/get`, "0");
    expect(readings).toEqual([{ v: 220, i1: 6, i2: 0 }]);

    // Next tick, a full throttle window later. voltage and current_a arrive
    // first: emitting on either would pair this tick's voltage with the previous
    // tick's currents ({v:211.6, i1:6, i2:0}). Only the current_b arrival emits,
    // as a coherent same-tick snapshot.
    advance(1000);
    feed.handleMessage(`${BASE}/0/get`, "21160");
    feed.handleMessage(`${BASE}/3/get`, "7");
    expect(readings).toHaveLength(1);
    feed.handleMessage(`${BASE}/4/get`, "9144");
    expect(readings).toHaveLength(2);
    expect(readings[1]).toEqual({ v: 211.6, i1: 0.007, i2: 9.144 });
  });

  it("throttles to one emission per meterMinGapMs under rapid updates", () => {
    const { feed, readings, advance } = makeMeterFeed();
    feed.handleMessage(`${BASE}/0/get`, "21160");
    feed.handleMessage(`${BASE}/3/get`, "7");
    feed.handleMessage(`${BASE}/4/get`, "9144");   // t0: first emission
    expect(readings).toHaveLength(1);

    for (let i = 0; i < 3; i++) {
      advance(200);                                // 200ms current_b ticks, inside the 1s window
      feed.handleMessage(`${BASE}/4/get`, String(9000 + i));
    }
    expect(readings).toHaveLength(1);              // all inside the throttle window

    advance(CT02_METER_MIN_GAP_MS);                // now a full gap past the last emit
    feed.handleMessage(`${BASE}/4/get`, "9200");
    expect(readings).toHaveLength(2);
  });

  it("stops emitting when a channel misses two heartbeats, and resumes when it returns", () => {
    const { feed, readings, advance } = makeMeterFeed();
    feed.handleMessage(`${BASE}/0/get`, "21160");
    feed.handleMessage(`${BASE}/3/get`, "7");
    feed.handleMessage(`${BASE}/4/get`, "9144");
    expect(readings).toHaveLength(1);

    // current_a goes silent past the freshness bar; voltage + current_b keep ticking.
    advance(CT02_METER_CHANNEL_FRESH_MS + 10_000);
    feed.handleMessage(`${BASE}/0/get`, "21150");
    feed.handleMessage(`${BASE}/4/get`, "9000");
    expect(readings).toHaveLength(1);              // current_a half-dead -> no fiction emitted

    // Next tick current_a is back, so the current_b arrival emits the latest of each.
    advance(1000);
    feed.handleMessage(`${BASE}/0/get`, "21150");
    feed.handleMessage(`${BASE}/3/get`, "8");
    feed.handleMessage(`${BASE}/4/get`, "9000");
    expect(readings).toHaveLength(2);
    expect(readings[1]).toEqual({ v: 211.5, i1: 0.008, i2: 9.0 });
  });

  it("keeps a flat channel eligible through identical-value heartbeat rebroadcasts", () => {
    const { feed, readings, advance } = makeMeterFeed();
    feed.handleMessage(`${BASE}/0/get`, "21160");
    feed.handleMessage(`${BASE}/3/get`, "7");      // flat grid clamp
    feed.handleMessage(`${BASE}/4/get`, "9144");
    expect(readings).toHaveLength(1);

    // 60 s heartbeat: the flat clamp rebroadcasts the SAME raw value.
    advance(60_000);
    feed.handleMessage(`${BASE}/0/get`, "21160");
    feed.handleMessage(`${BASE}/3/get`, "7");      // identical raw still refreshes updatedAt
    feed.handleMessage(`${BASE}/4/get`, "9140");
    expect(readings).toHaveLength(2);

    // Another heartbeat: current_a's value is now 120 s old but still refreshed.
    advance(60_000);
    feed.handleMessage(`${BASE}/0/get`, "21160");
    feed.handleMessage(`${BASE}/3/get`, "7");
    feed.handleMessage(`${BASE}/4/get`, "9140");
    expect(readings).toHaveLength(3);
    expect(readings[2].i1).toBeCloseTo(0.007, 6);
    expect(feed.snapshot().channels.current_a.unchangedFor).toBeGreaterThan(0);
  });

  it("emits pre-scaled (decimal) payloads without re-dividing them", () => {
    const { feed, readings } = makeMeterFeed();
    feed.handleMessage(`${BASE}/0/get`, "211.60");
    feed.handleMessage(`${BASE}/3/get`, "0.007");
    feed.handleMessage(`${BASE}/4/get`, "9.144");
    expect(readings).toEqual([{ v: 211.6, i1: 0.007, i2: 9.144 }]);
  });

  it("stays a pure diagnostics feed when onReading is not configured", () => {
    const { feed } = makeFeed(); // no onReading
    feed.handleMessage(`${BASE}/0/get`, "21160");
    feed.handleMessage(`${BASE}/3/get`, "7");
    feed.handleMessage(`${BASE}/4/get`, "9144");
    // No emission path, and the channel state is still decoded for /diag.
    expect(feed.snapshot().channels.current_b.value).toBeCloseTo(9.144, 6);
  });

  it("does not mix pre- and post-changeover channels when the device power-cycles", () => {
    const { feed, readings, advance } = makeMeterFeed();
    // Steady on grid: A carries load, B (gen) idle.
    feed.handleMessage(`${BASE}/0/get`, "22000"); // 220.0 V
    feed.handleMessage(`${BASE}/3/get`, "6000");  // grid clamp 6.0 A
    feed.handleMessage(`${BASE}/4/get`, "0");     // gen clamp idle
    expect(readings).toEqual([{ v: 220, i1: 6, i2: 0 }]);

    // Changeover: the CT02 drops off, then reconnects after a 30s silence and
    // republishes the tick in firmware order. The current_b arrival must emit
    // this tick's post-changeover values, never its gen current beside the
    // pre-changeover grid 6 A still sitting in the map.
    advance(CT02_METER_RESUME_GAP_MS + 15_000);
    feed.handleMessage(`${BASE}/0/get`, "21160"); // 211.6 V, first back (arms epoch)
    feed.handleMessage(`${BASE}/3/get`, "7");     // grid clamp 0.007 A, grid now dead
    expect(readings).toHaveLength(1);             // no emit until current_b
    feed.handleMessage(`${BASE}/4/get`, "9144");  // gen clamp 9.144 A -> emit
    expect(readings).toHaveLength(2);
    // Every value is post-changeover: no phantom grid current on i1.
    expect(readings[1]).toEqual({ v: 211.6, i1: 0.007, i2: 9.144 });
  });

  it("never epoch-gates a continuous healthy stream", () => {
    const { feed, readings, advance } = makeMeterFeed();
    feed.handleMessage(`${BASE}/0/get`, "22000");
    feed.handleMessage(`${BASE}/3/get`, "6000");
    feed.handleMessage(`${BASE}/4/get`, "0");
    expect(readings).toHaveLength(1);

    // A full tick every 5s, comfortably under the 15s resume gap: the epoch gate
    // must never arm, so every tick's current_b past the throttle keeps emitting.
    for (let i = 0; i < 6; i++) {
      advance(5000);
      feed.handleMessage(`${BASE}/0/get`, "22000");
      feed.handleMessage(`${BASE}/3/get`, String(6000 + i));
      feed.handleMessage(`${BASE}/4/get`, "0");
    }
    expect(readings).toHaveLength(7);
  });

  it("arms a fresh epoch on a <base>/connected message even after a sub-15s outage", () => {
    const { feed, readings, advance } = makeMeterFeed();
    feed.handleMessage(`${BASE}/0/get`, "22000");
    feed.handleMessage(`${BASE}/3/get`, "6000");
    feed.handleMessage(`${BASE}/4/get`, "0");
    expect(readings).toHaveLength(1);

    // Device reboots and reconnects after only 5s (under the silence threshold),
    // publishing its OpenBeken birth message, which arms the epoch.
    advance(5000);
    feed.handleMessage(`${BASE}/connected`, "online");

    // If current_b returns before voltage/current_a re-report, they are still
    // fresh (5s old) but pre-epoch, so the reading is withheld.
    feed.handleMessage(`${BASE}/4/get`, "9144");
    expect(readings).toHaveLength(1);

    // A full post-connect tick re-reports all three; current_b then emits.
    feed.handleMessage(`${BASE}/0/get`, "21160");
    feed.handleMessage(`${BASE}/3/get`, "7");
    feed.handleMessage(`${BASE}/4/get`, "9144");
    expect(readings).toHaveLength(2);
    expect(readings[1]).toEqual({ v: 211.6, i1: 0.007, i2: 9.144 });
  });

  it("does not emit when a non-meter channel arrives first after a silence", () => {
    const { feed, readings, advance } = makeMeterFeed();
    feed.handleMessage(`${BASE}/0/get`, "22000");
    feed.handleMessage(`${BASE}/3/get`, "6000");
    feed.handleMessage(`${BASE}/4/get`, "0");
    expect(readings).toHaveLength(1);

    // 30s silence, then power_a (channel 5, not one of the gated three) is first
    // back. It must arm the epoch (P1-3), so the pre-gap meter channels cannot
    // ride through.
    advance(30_000);
    feed.handleMessage(`${BASE}/5/get`, "60000"); // power_a, arms the epoch
    expect(readings).toHaveLength(1);

    // current_b back before voltage/current_a re-report: still fresh but
    // pre-epoch, so the reading is withheld (no gen current beside the pre-gap grid value).
    feed.handleMessage(`${BASE}/4/get`, "9144");
    expect(readings).toHaveLength(1);

    // Full tick re-reports all three; current_b then emits the coherent snapshot.
    feed.handleMessage(`${BASE}/0/get`, "21160");
    feed.handleMessage(`${BASE}/3/get`, "7");
    feed.handleMessage(`${BASE}/4/get`, "9144");
    expect(readings).toHaveLength(2);
    expect(readings[1]).toEqual({ v: 211.6, i1: 0.007, i2: 9.144 });
  });
});

describe("assessPorts", () => {
  const NOW = 10_000_000;

  /** An observation of one port, `agoMs` before NOW. */
  function obs(agoMs: number, amps: number): PortObservation {
    return { at: NOW - agoMs, value: amps, raw: Math.round(amps * 1000) };
  }

  function channels(aAgoMs = 0, bAgoMs = 0): Record<string, Ct02ChannelState> {
    const mk = (index: number, key: string, port: "A" | "B", agoMs: number): Ct02ChannelState => ({
      index, key, label: key, unit: "A", port,
      value: 0, raw: 0, preScaled: false, updatedAt: NOW - agoMs, updateCount: 1, unchangedFor: 0,
    });
    return {
      current_a: mk(3, "current_a", "A", aAgoMs),
      current_b: mk(4, "current_b", "B", bAgoMs),
    };
  }

  it("reports the live fault: A carrying load while B sits at an exact zero", () => {
    const a = [obs(2000, 3.4), obs(1000, 4.2), obs(0, 4.1)];
    const b = [obs(2000, 0), obs(1000, 0), obs(0, 0)];
    const result = assessPorts(a, b, channels(), NOW);

    expect(result.verdict).toBe("b-silent-while-a-live");
    expect(result.bAlwaysExactZero).toBe(true);
    expect(result.aMax).toBeCloseTo(4.2, 6);
    expect(result.bNonZero).toBe(0);
    expect(result.windowSeconds).toBe(2);
  });

  it("does not call an exact zero when B is reading its noise floor", () => {
    const result = assessPorts([obs(1000, 3.4), obs(0, 4.2)], [obs(1000, 0.003), obs(0, 0.004)], channels(), NOW);

    expect(result.verdict).toBe("b-silent-while-a-live");
    expect(result.bAlwaysExactZero).toBe(false);
  });

  it("does not claim an exact zero when only the newest B reading was zero", () => {
    const b = [obs(2000, 0.004), obs(1000, 0), obs(0, 0)];
    expect(assessPorts([obs(1000, 4.2), obs(0, 4.2)], b, channels(), NOW).bAlwaysExactZero).toBe(false);
  });

  it("clears once both ports read — the swap test succeeding", () => {
    const result = assessPorts([obs(1000, 3.4), obs(0, 4.2)], [obs(1000, 3.3), obs(0, 4.1)], channels(), NOW);
    expect(result.verdict).toBe("both-live");
    expect(result.pairedLiveObservations).toBe(2);
  });

  it("names the mirrored case, so a swapped-terminal result is unambiguous", () => {
    const result = assessPorts([obs(1000, 0), obs(0, 0)], [obs(1000, 3.3), obs(0, 4.1)], channels(), NOW);
    expect(result.verdict).toBe("b-live-while-a-silent");
  });

  it("distinguishes both-live-together from live-at-different-moments", () => {
    // A live 110s ago, B live 1s ago: both inside the window, never together.
    const result = assessPorts([obs(110_000, 4.2)], [obs(1000, 4.1)], channels(), NOW);

    expect(result.verdict).toBe("both-live");
    expect(result.pairedLiveObservations).toBe(0);
    expect(result.detail).toMatch(/never at the same time/);
  });

  it("refuses to judge an unloaded conductor", () => {
    const result = assessPorts([obs(1000, 0.004), obs(0, 0.005)], [obs(1000, 0), obs(0, 0)], channels(), NOW);

    expect(result.verdict).toBe("both-idle");
    expect(result.detail).toMatch(/load/i);
  });

  it("refuses to judge on a port that has stopped reporting", () => {
    // A's newest observation is 150s old — outside the 120s window — while B
    // keeps reporting. Judging here would accuse a healthy port B.
    const result = assessPorts([obs(150_000, 4.2)], [obs(1000, 0)], channels(150_000, 1000), NOW);

    expect(result.verdict).toBe("stale");
    expect(result.verdict).not.toBe("b-silent-while-a-live");
    expect(result.detail).toMatch(/port A last reported/);
    expect(result.aMax).toBeNull();
    expect(result.aStale).toBe(true);
    expect(result.bStale).toBe(false);
  });

  it("ignores observations older than the window but keeps the recent ones", () => {
    // A ran hard half an hour ago and everything has been idle since.
    const a = [obs(1_800_000, 4.2), obs(1000, 0.004), obs(0, 0.004)];
    const result = assessPorts(a, [obs(1000, 0), obs(0, 0)], channels(), NOW);

    expect(result.verdict).toBe("both-idle");
    expect(result.aMax).toBeCloseTo(0.004, 6);
  });

  it("ignores a future-dated observation, so a backward clock step cannot drive a verdict", () => {
    // Clock stepped back: a pre-step reading now sits in the future.
    const result = assessPorts([{ at: NOW + 60_000, value: 4.2, raw: 4200 }], [obs(1000, 0)], channels(), NOW);

    expect(result.aStale).toBe(true);
    expect(result.verdict).toBe("stale");
    expect(result.aMax).toBeNull();
  });

  it("reports no-data rather than inventing a verdict before anything arrives", () => {
    expect(assessPorts([], [], {}, NOW).verdict).toBe("no-data");
  });
});
