import mqtt from "mqtt";
import { childLogger } from "./logger.js";

const log = childLogger("ct02");

/**
 * CT02 open-firmware power-meter feed (QS-WIFI-S04-CT02 running OpenBeken +
 * our custom `drv_hlw8112_uart` driver — see docs/CT02_FLASH_PLAN.md).
 *
 * DELIBERATELY ISOLATED, exactly like tuya-power.ts: this module owns its own
 * MQTT connection, keeps everything in memory, writes NOTHING to the database
 * and never reaches the ESP power path, `latestPower`, or the AC leveller. The
 * leveller's strain detection and flicker statistics key off the single ESP
 * stream; a second interleaved feed corrupts them. Nothing here may change that.
 *
 * Transport: the device publishes to our Mosquitto broker as
 * `<topicBase>/<channelIndex>/get` with a RAW INTEGER payload (OpenBeken only
 * publishes pre-scaled floats when the `OBK_FLAG_PUBLISH_MULTIPLIED_VALUES`
 * flag — bit 33 — is set, which it is not). The divisor per channel comes from
 * the `CHANNEL_SetType` calls in `drv_hlw8112_uart.c::HLW8112UART_InitChannels`.
 */

export interface Ct02ChannelSpec {
  /** OpenBeken channel index — the middle segment of the MQTT topic. */
  index: number;
  key: string;
  label: string;
  unit: string;
  /** Raw integer is divided by this to reach SI units. */
  divisor: number;
  /** Which CT clamp port this belongs to, or null for shared/line values. */
  port: "A" | "B" | null;
}

/**
 * Indices mirror `HLW8112_Device_channels` in drv_hlw8112.h. PowerFactor (2)
 * and apparent_power_A (7) are intentionally absent — the driver never
 * populates them (they need the 0x5A/0xA5 channel-select dance).
 */
export const CT02_CHANNELS: readonly Ct02ChannelSpec[] = [
  { index: 0, key: "voltage", label: "Voltage", unit: "V", divisor: 100, port: null },
  { index: 1, key: "frequency", label: "Frequency", unit: "Hz", divisor: 100, port: null },
  { index: 3, key: "current_a", label: "Current A", unit: "A", divisor: 1000, port: "A" },
  { index: 4, key: "current_b", label: "Current B", unit: "A", divisor: 1000, port: "B" },
  { index: 5, key: "power_a", label: "Power A", unit: "W", divisor: 100, port: "A" },
  { index: 6, key: "power_b", label: "Power B", unit: "W", divisor: 100, port: "B" },
  { index: 8, key: "export_a", label: "Energy Export A", unit: "kWh", divisor: 1000, port: "A" },
  { index: 9, key: "export_b", label: "Energy Export B", unit: "kWh", divisor: 1000, port: "B" },
  { index: 10, key: "import_a", label: "Energy Import A", unit: "kWh", divisor: 1000, port: "A" },
  { index: 11, key: "import_b", label: "Energy Import B", unit: "kWh", divisor: 1000, port: "B" },
];

const CHANNEL_BY_INDEX = new Map<number, Ct02ChannelSpec>(CT02_CHANNELS.map(c => [c.index, c]));

export interface Ct02ChannelState {
  index: number;
  key: string;
  label: string;
  unit: string;
  port: "A" | "B" | null;
  /** Scaled SI value. */
  value: number;
  /**
   * The integer exactly as the device sent it. Kept because "raw 0" (the meter
   * truncated to nothing) and "raw 3" (0.003 A of noise floor) are different
   * diagnoses for a silent CT port, and scaling hides the difference.
   */
  raw: number;
  /** True when the payload already carried a decimal point (multiplied-values flag on). */
  preScaled: boolean;
  updatedAt: number;
  updateCount: number;
  /** How many consecutive updates arrived with an identical raw value. */
  unchangedFor: number;
}

export interface Ct02Sample {
  ts: number;
  voltage: number | null;
  frequency: number | null;
  current_a: number | null;
  current_b: number | null;
  power_a: number | null;
  power_b: number | null;
  /**
   * The current channels' raw integers, carried alongside the scaled values.
   * Without these, "port B has been an exact zero" can only be asserted about
   * the newest reading — a scaled 0.000 hides any raw value under 1 mA.
   */
  raw_a: number | null;
  raw_b: number | null;
}

/**
 * One real reading of one CT port.
 *
 * These are recorded on EVERY current-channel message, independently of the
 * chart's one-per-second sample throttle. Deriving them from samples instead
 * lost readings the throttle skipped and collapsed two readings that shared a
 * millisecond — either of which can flip a verdict (Codex round 3, finding 2).
 * The verdict reads these; `Ct02Sample` exists only to draw the chart.
 */
export interface PortObservation {
  at: number;
  value: number;
  raw: number;
}

export interface Ct02ConnectionState {
  configured: boolean;
  connected: boolean;
  connectedSince: number | null;
  disconnectedSince: number | null;
  connectCount: number;
  reconnectCount: number;
  messageCount: number;
  lastMessageAt: number | null;
  lastError: string | null;
  /** Topics dropped by the CT02_MAX_TOPICS cap — a silent cap would misreport coverage. */
  topicsEvicted: number;
  brokerUrl: string;
  topicBase: string;
  subscriptions: string[];
}

/** Rolling verdict on the CT-B port — the reason this page exists. */
export type Ct02PortBVerdict =
  | "no-data"
  | "stale"
  | "both-live"
  | "b-silent-while-a-live"
  | "b-live-while-a-silent"
  | "both-idle";

export interface Ct02PortAssessment {
  verdict: Ct02PortBVerdict;
  detail: string;
  windowSeconds: number;
  sampleCount: number;
  aMax: number | null;
  bMax: number | null;
  aNonZero: number;
  bNonZero: number;
  /** True when every B reading IN THE WINDOW was an exact integer zero. */
  bAlwaysExactZero: boolean;
  /** Observations where both ports were seen carrying load within CT02_PAIR_WINDOW_MS. */
  pairedLiveObservations: number;
  /** Per-port reporting age, so the page can show WHY a verdict was withheld. */
  aAgeSeconds: number | null;
  bAgeSeconds: number | null;
  /**
   * Whether each port failed to report inside the window. Computed here so the
   * page never has to restate the threshold — a duplicated 120 that drifted out
   * of step with the server would render stale values as live ones.
   */
  aStale: boolean;
  bStale: boolean;
}

export interface Ct02Snapshot {
  connection: Ct02ConnectionState;
  channels: Record<string, Ct02ChannelState>;
  /** Every topic seen under the device's tree, decoded or not. */
  topics: Array<{ topic: string; value: string; updatedAt: number; count: number }>;
  history: Ct02Sample[];
  assessment: Ct02PortAssessment;
}

/**
 * Current below this (amps) counts as "nothing flowing" when judging a port.
 * The meter's own noise floor sat at 0.005 A on the bench with the line idle.
 */
export const CT02_IDLE_CURRENT_A = 0.02;

/**
 * Only samples this recent are allowed to shape the verdict. The feed retains
 * far more history for the chart, but a compressor that ran twenty minutes ago
 * must not still be reported as "port A is live" — this project has been burnt
 * repeatedly by conclusions drawn from readings older than the event they
 * describe (AGENTS.md hard rule 5b).
 *
 * This doubles as the freshness bar: the device rebroadcasts every channel each
 * minute, so a port with no observation inside this window has missed two
 * heartbeats and is not judgeable. One threshold, not two.
 */
export const CT02_ASSESS_WINDOW_MS = 120_000;

/**
 * Two observations of different ports count as simultaneous within this gap.
 * Used only to describe whether both ports were seen carrying load together;
 * it never gates the verdict.
 */
export const CT02_PAIR_WINDOW_MS = 30_000;

/**
 * Caps on the raw-topic map. The device publishes ~20 distinct topics, so these
 * are far above normal use — they exist so a malfunctioning or hostile
 * publisher on the shared broker cannot grow this map (and every /api/diag
 * response) without limit. The broker has no ACLs, so any authenticated client
 * can publish under this device's tree.
 */
export const CT02_MAX_TOPICS = 200;

/** Non-channel topics the device publishes with its periodic full broadcast. */
export const CT02_DEVICE_TOPICS = new Set([
  "connected", "build", "ip", "mac", "ssid", "rssi",
  "freeheap", "uptime", "temp", "sockets", "host", "datetime",
]);
export const CT02_MAX_PAYLOAD_CHARS = 256;

/** Per-port observation ring size. At the device's cadence this is many windows deep. */
export const CT02_MAX_OBSERVATIONS = 600;

export interface Ct02FeedOptions {
  brokerUrl: string;
  username: string;
  password: string;
  topicBase: string;
  /**
   * Max decoded samples retained. Publishing is change-driven, so this is a
   * point count, not a fixed duration: a busy line fills it in ~30 min at the
   * 1 s throttle, an idle one can span hours.
   */
  historyLimit?: number;
  /** Minimum gap between retained history samples, ms. Default 1000. */
  historyMinGapMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Parses one `<base>/<channel>/get` payload.
 *
 * OpenBeken sends a bare integer that must be divided by the channel's scale.
 * If the flag that publishes pre-multiplied floats is ever switched on the
 * payload arrives with a decimal point already applied — dividing it again
 * would silently under-report by 100–1000×, so the decimal point is treated as
 * the signal that no scaling is owed.
 */
export function decodeChannelPayload(
  spec: Ct02ChannelSpec,
  payload: string,
): { value: number; raw: number; preScaled: boolean } | null {
  const text = payload.trim();
  if (!text) return null;
  const num = Number(text);
  if (!Number.isFinite(num)) return null;

  const preScaled = text.includes(".");
  return preScaled
    ? { value: num, raw: Math.round(num * spec.divisor), preScaled: true }
    : { value: num / spec.divisor, raw: num, preScaled: false };
}

/** Splits a device topic into its channel segment, or null if it is not a channel publish. */
export function parseChannelTopic(topic: string, topicBase: string): Ct02ChannelSpec | null {
  if (!topicBase) return null;
  const prefix = `${topicBase}/`;
  if (!topic.startsWith(prefix)) return null;
  const rest = topic.slice(prefix.length);
  if (!rest.endsWith("/get")) return null;
  const middle = rest.slice(0, -"/get".length);
  if (!/^\d+$/.test(middle)) return null;
  const spec = CHANNEL_BY_INDEX.get(Number(middle));
  if (!spec) return null;
  // Only the canonical form counts. "03" and "003" also parse to 3, and each
  // would be a distinct — and protected — key in the topic map, letting a
  // publisher mint unlimited "recognised" topics and walk past the cap
  // (Codex round 3, finding 1).
  return middle === String(spec.index) ? spec : null;
}

/**
 * Judges the two CT ports over the retained window. Pure so the verdict is
 * testable without a broker — and so it stays honest: it reports what the
 * samples show and never guesses at a cause.
 */
/** Observations inside [now - windowMs, now], newest-bounded so a backward clock step cannot leak future readings in. */
function inWindow(observations: PortObservation[], now: number, windowMs: number): PortObservation[] {
  const windowStart = now - windowMs;
  return observations.filter(o => o.at >= windowStart && o.at <= now);
}

export function assessPorts(
  aObservations: PortObservation[],
  bObservations: PortObservation[],
  channels: Record<string, Ct02ChannelState>,
  now: number,
  windowMs: number = CT02_ASSESS_WINDOW_MS,
): Ct02PortAssessment {
  const aChannel = channels["current_a"];
  const bChannel = channels["current_b"];
  const aAgeSeconds = aChannel ? Math.round((now - aChannel.updatedAt) / 1000) : null;
  const bAgeSeconds = bChannel ? Math.round((now - bChannel.updatedAt) / 1000) : null;

  const aObs = inWindow(aObservations, now, windowMs);
  const bObs = inWindow(bObservations, now, windowMs);

  const allAt = [...aObs, ...bObs].map(o => o.at);
  const windowSeconds = allAt.length >= 2
    ? Math.round((Math.max(...allAt) - Math.min(...allAt)) / 1000)
    : 0;

  const aMax = aObs.length ? Math.max(...aObs.map(o => o.value)) : null;
  const bMax = bObs.length ? Math.max(...bObs.map(o => o.value)) : null;
  const aLive = aObs.filter(o => o.value > CT02_IDLE_CURRENT_A);
  const bLive = bObs.filter(o => o.value > CT02_IDLE_CURRENT_A);

  // "Exact zero" is judged on the raw integers of the window's real B
  // observations: a scaled 0.000 could be any raw value under 1 mA, and that
  // distinction is the whole point of watching port B.
  const bAlwaysExactZero = bObs.length > 0 && bObs.every(o => o.raw === 0);

  // Paired within CT02_PAIR_WINDOW_MS, so "both live" can never mean "each was
  // live at some unrelated moment inside the window".
  const pairedLiveObservations = bLive.filter(
    b => aLive.some(a => Math.abs(a.at - b.at) <= CT02_PAIR_WINDOW_MS),
  ).length;

  const base = {
    windowSeconds,
    sampleCount: aObs.length + bObs.length,
    aMax,
    bMax,
    aNonZero: aLive.length,
    bNonZero: bLive.length,
    bAlwaysExactZero,
    pairedLiveObservations,
    aAgeSeconds,
    bAgeSeconds,
    aStale: aObs.length === 0,
    bStale: bObs.length === 0,
  };

  if (!aChannel && !bChannel) {
    return { ...base, verdict: "no-data", detail: "No current readings received yet." };
  }

  // Judgeability is decided by whether each port actually SPOKE inside the
  // window, never by a value copied forward into it.
  if (aObs.length === 0 || bObs.length === 0) {
    const parts: string[] = [];
    if (aObs.length === 0) {
      parts.push(aAgeSeconds === null ? "port A has never reported" : `port A last reported ${aAgeSeconds}s ago`);
    }
    if (bObs.length === 0) {
      parts.push(bAgeSeconds === null ? "port B has never reported" : `port B last reported ${bAgeSeconds}s ago`);
    }
    return {
      ...base,
      verdict: "stale",
      detail: `Cannot judge: ${parts.join(" and ")}. The device rebroadcasts every channel each minute, so this is a feed problem, not a clamp reading.`,
    };
  }

  let verdict: Ct02PortBVerdict;
  let detail: string;
  if (!aLive.length && !bLive.length) {
    verdict = "both-idle";
    detail = "Neither port is carrying load — put a load on the conductor before judging.";
  } else if (aLive.length > 0 && bLive.length > 0) {
    verdict = "both-live";
    detail = pairedLiveObservations > 0
      ? "Both CT ports are reading current."
      : "Both CT ports read current within the window, but never at the same time.";
  } else if (aLive.length > 0) {
    verdict = "b-silent-while-a-live";
    detail = bAlwaysExactZero
      ? `Port A is carrying up to ${aMax?.toFixed(3)} A while port B has stayed at an exact raw zero.`
      : `Port A is carrying up to ${aMax?.toFixed(3)} A while port B stayed under ${CT02_IDLE_CURRENT_A} A.`;
  } else {
    verdict = "b-live-while-a-silent";
    detail = `Port B is carrying up to ${bMax?.toFixed(3)} A while port A stayed under ${CT02_IDLE_CURRENT_A} A.`;
  }

  return { ...base, verdict, detail };
}

export class Ct02Feed {
  private client: mqtt.MqttClient | null = null;
  private readonly opts: Required<Omit<Ct02FeedOptions, "now">> & { now: () => number };
  private readonly channels = new Map<string, Ct02ChannelState>();
  private readonly topics = new Map<string, { value: string; updatedAt: number; count: number }>();
  private history: Ct02Sample[] = [];
  private lastHistoryAt = 0;
  // Verdict inputs. Appended on EVERY current-channel message, so the chart's
  // throttle can never drop a reading the assessment needed.
  private aObservations: PortObservation[] = [];
  private bObservations: PortObservation[] = [];

  /**
   * Fixed at construction so the "never collides with the collector's Qingping
   * client" invariant is testable. A collision makes the broker evict one of the
   * two into a permanent reconnect loop, silently killing the air feed.
   */
  readonly clientId: string;

  private connected = false;
  private connectedSince: number | null = null;
  private disconnectedSince: number | null = null;
  private connectCount = 0;
  private reconnectCount = 0;
  private messageCount = 0;
  private topicsEvicted = 0;
  private lastMessageAt: number | null = null;
  private lastError: string | null = null;

  constructor(options: Ct02FeedOptions) {
    this.opts = {
      brokerUrl: options.brokerUrl,
      username: options.username,
      password: options.password,
      topicBase: options.topicBase,
      historyLimit: options.historyLimit ?? 1800,
      historyMinGapMs: options.historyMinGapMs ?? 1000,
      now: options.now ?? (() => Date.now()),
    };
    this.clientId = `home-dashboard-ct02-${this.opts.now()}`;
  }

  get configured(): boolean {
    return Boolean(this.opts.brokerUrl && this.opts.topicBase);
  }

  /** Topics we subscribe to: the whole device tree plus its Tasmota-style telemetry. */
  get subscriptions(): string[] {
    const base = this.opts.topicBase;
    return base ? [`${base}/#`, `tele/${base}/#`, `stat/${base}/#`] : [];
  }

  start(): void {
    if (!this.configured) {
      log.info("[ct02] feed not configured (no broker url or topic base), skipping");
      return;
    }
    if (this.client) return;

    this.disconnectedSince = this.opts.now();
    this.client = mqtt.connect(this.opts.brokerUrl, {
      username: this.opts.username,
      password: this.opts.password,
      // Distinct from the collector's Qingping client id — a collision would
      // make the broker kick one of the two off in a reconnect loop.
      clientId: this.clientId,
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 30000,
    });

    this.client.on("connect", () => {
      this.connected = true;
      this.connectCount++;
      this.connectedSince = this.opts.now();
      this.disconnectedSince = null;
      log.info(`[ct02] MQTT connected, subscribing to ${this.subscriptions.join(", ")}`);
      this.client!.subscribe(this.subscriptions, { qos: 0 }, (err) => {
        if (err) {
          this.lastError = `subscribe: ${err.message}`;
          log.error("[ct02] subscribe error:", err);
        }
      });
    });

    this.client.on("message", (topic: string, payload: Buffer) => {
      try {
        this.handleMessage(topic, payload.toString("utf-8"));
      } catch (err) {
        this.lastError = `message: ${(err as Error).message}`;
        log.error("[ct02] message handling error:", err);
      }
    });

    this.client.on("close", () => {
      if (this.connected) {
        this.connected = false;
        this.disconnectedSince = this.opts.now();
      }
    });

    this.client.on("reconnect", () => {
      this.reconnectCount++;
    });

    this.client.on("error", (err: Error) => {
      this.lastError = err.message;
      log.error("[ct02] MQTT error:", err);
    });
  }

  stop(): void {
    this.client?.end(true);
    this.client = null;
    this.connected = false;
  }

  /**
   * True for topics the device itself is expected to publish: its decoded
   * channels and the device-health values the page renders by name. These are
   * never evicted to make room for unknown traffic.
   */
  private isRecognisedTopic(topic: string): boolean {
    if (parseChannelTopic(topic, this.opts.topicBase) !== null) return true;
    const prefix = `${this.opts.topicBase}/`;
    if (!topic.startsWith(prefix)) return false;
    return CT02_DEVICE_TOPICS.has(topic.slice(prefix.length));
  }

  /**
   * Records one message. Public and transport-free so tests can drive the whole
   * decode/history/verdict path without a broker.
   */
  handleMessage(topic: string, payload: string): void {
    const now = this.opts.now();
    this.messageCount++;
    this.lastMessageAt = now;

    const existing = this.topics.get(topic);
    if (!existing && this.topics.size >= CT02_MAX_TOPICS) {
      // Evict the least recently updated UNRECOGNISED topic. Anything the
      // device legitimately publishes is protected, so a flood of junk topics
      // cannot push the channels and device-health rows out of the map and
      // quietly blank the page (Codex round 2, finding 3).
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [key, entry] of this.topics) {
        if (this.isRecognisedTopic(key)) continue;
        if (entry.updatedAt < oldestAt) { oldestAt = entry.updatedAt; oldestKey = key; }
      }
      if (oldestKey === null) {
        // Every slot holds a recognised topic. Fall back to evicting the
        // least-recently-updated entry of any kind so the cap is a real
        // ceiling rather than a preference (Codex round 3, finding 1).
        let fallbackAt = Infinity;
        for (const [key, entry] of this.topics) {
          if (entry.updatedAt < fallbackAt) { fallbackAt = entry.updatedAt; oldestKey = key; }
        }
      }
      if (oldestKey !== null) {
        this.topics.delete(oldestKey);
        this.topicsEvicted++;
      }
    }
    this.topics.set(topic, {
      value: payload.length > CT02_MAX_PAYLOAD_CHARS
        ? `${payload.slice(0, CT02_MAX_PAYLOAD_CHARS)}…`
        : payload,
      updatedAt: now,
      count: (existing?.count ?? 0) + 1,
    });

    const spec = parseChannelTopic(topic, this.opts.topicBase);
    if (!spec) return;

    const decoded = decodeChannelPayload(spec, payload);
    if (!decoded) return;

    if (spec.key === "current_a" || spec.key === "current_b") {
      const ring = spec.key === "current_a" ? this.aObservations : this.bObservations;
      ring.push({ at: now, value: decoded.value, raw: decoded.raw });
      if (ring.length > CT02_MAX_OBSERVATIONS) ring.splice(0, ring.length - CT02_MAX_OBSERVATIONS);
    }

    const prev = this.channels.get(spec.key);
    this.channels.set(spec.key, {
      index: spec.index,
      key: spec.key,
      label: spec.label,
      unit: spec.unit,
      port: spec.port,
      value: decoded.value,
      raw: decoded.raw,
      preScaled: decoded.preScaled,
      updatedAt: now,
      updateCount: (prev?.updateCount ?? 0) + 1,
      unchangedFor: prev && prev.raw === decoded.raw ? prev.unchangedFor + 1 : 0,
    });

    this.recordSample(now);
  }

  /**
   * Appends a history point, throttled. Channels publish on change, so the
   * instantaneous channels are sampled together whenever any of them moves.
   */
  private recordSample(now: number): void {
    if (now - this.lastHistoryAt < this.opts.historyMinGapMs) return;
    this.lastHistoryAt = now;

    const read = (key: string): number | null => this.channels.get(key)?.value ?? null;
    const readRaw = (key: string): number | null => this.channels.get(key)?.raw ?? null;
    this.history.push({
      ts: now,
      voltage: read("voltage"),
      frequency: read("frequency"),
      current_a: read("current_a"),
      current_b: read("current_b"),
      power_a: read("power_a"),
      power_b: read("power_b"),
      raw_a: readRaw("current_a"),
      raw_b: readRaw("current_b"),
    });

    if (this.history.length > this.opts.historyLimit) {
      this.history = this.history.slice(-this.opts.historyLimit);
    }
  }

  snapshot(): Ct02Snapshot {
    const channels: Record<string, Ct02ChannelState> = {};
    for (const [key, state] of this.channels) channels[key] = state;

    const topics = [...this.topics.entries()]
      .map(([topic, t]) => ({ topic, value: t.value, updatedAt: t.updatedAt, count: t.count }))
      .sort((a, b) => a.topic.localeCompare(b.topic, undefined, { numeric: true }));

    return {
      connection: {
        configured: this.configured,
        connected: this.connected,
        connectedSince: this.connectedSince,
        disconnectedSince: this.disconnectedSince,
        connectCount: this.connectCount,
        reconnectCount: this.reconnectCount,
        messageCount: this.messageCount,
        lastMessageAt: this.lastMessageAt,
        lastError: this.lastError,
        topicsEvicted: this.topicsEvicted,
        brokerUrl: this.opts.brokerUrl,
        topicBase: this.opts.topicBase,
        subscriptions: this.subscriptions,
      },
      channels,
      topics,
      history: this.history,
      assessment: assessPorts(this.aObservations, this.bObservations, channels, this.opts.now()),
    };
  }
}
