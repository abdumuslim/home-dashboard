import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { Power, Settings, Loader2, X, ChevronUp, ChevronDown, Snowflake, Sun, Wind, Droplets, Zap, Gauge, AirVent, Save, Check, Timer, TimerOff, Volume2, EarOff, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AcControlCapability, AcDevice, AcFeatureId, AcOption } from "@/types/ac";
import { VERTICAL_SWING_OPTIONS, HORIZONTAL_SWING_OPTIONS, VerticalIcon, HorizontalIcon } from "@/components/ui/swing-controls";

const MODE_LABELS: Record<number, { label: string; icon: typeof Snowflake }> = {
  0: { label: "Auto", icon: Gauge },
  1: { label: "Cool", icon: Snowflake },
  2: { label: "Dry", icon: Droplets },
  3: { label: "Fan", icon: Wind },
  4: { label: "Heat", icon: Sun },
};

// Mode-based color scheme
const MODE_COLORS: Record<number, { accent: string; bg: string; border: string; glow: string; text: string; toggleBg: string; toggleDot: string }> = {
  0: { accent: "#34d399", bg: "rgba(52,211,153,0.1)", border: "rgba(52,211,153,0.5)", glow: "rgba(52,211,153,0.3)", text: "#34d399", toggleBg: "rgba(52,211,153,0.3)", toggleDot: "#34d399" },   // emerald
  1: { accent: "#38bdf8", bg: "rgba(56,189,248,0.1)", border: "rgba(56,189,248,0.5)", glow: "rgba(56,189,248,0.3)", text: "#38bdf8", toggleBg: "rgba(56,189,248,0.3)", toggleDot: "#38bdf8" },   // sky
  2: { accent: "#2dd4bf", bg: "rgba(45,212,191,0.1)", border: "rgba(45,212,191,0.5)", glow: "rgba(45,212,191,0.3)", text: "#2dd4bf", toggleBg: "rgba(45,212,191,0.3)", toggleDot: "#2dd4bf" },   // teal
  3: { accent: "#94a3b8", bg: "rgba(148,163,184,0.1)", border: "rgba(148,163,184,0.5)", glow: "rgba(148,163,184,0.3)", text: "#94a3b8", toggleBg: "rgba(148,163,184,0.3)", toggleDot: "#94a3b8" }, // slate
  4: { accent: "#f87171", bg: "rgba(248,113,113,0.1)",  border: "rgba(248,113,113,0.5)",  glow: "rgba(248,113,113,0.3)",  text: "#f87171", toggleBg: "rgba(248,113,113,0.3)",  toggleDot: "#f87171" },  // red
};

const DEFAULT_COLORS = MODE_COLORS[1];

function getModeColors(mode: number) {
  return MODE_COLORS[mode] ?? DEFAULT_COLORS;
}

const FAN_LABELS: Record<number, string> = {
  0: "A",
  1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7",
};

const FEATURE_UI: Record<AcFeatureId, { label: string; command: string; section: "Comfort" | "Air" | "Device" }> = {
  eco: { label: "Eco", command: "set_eco", section: "Comfort" },
  aiEco: { label: "AI Eco", command: "set_ai_eco", section: "Comfort" },
  turbo: { label: "Turbo", command: "set_turbo", section: "Comfort" },
  sleep: { label: "Sleep", command: "set_sleep", section: "Comfort" },
  gentleBreeze: { label: "Gentle breeze", command: "set_gentle_breeze", section: "Comfort" },
  eightDegreeHeat: { label: "8°C heating", command: "set_8c_heat", section: "Comfort" },
  healthy: { label: "Healthy / Ion", command: "set_healthy", section: "Air" },
  freshAir: { label: "Fresh air", command: "set_fresh_air", section: "Air" },
  freshAirStrength: { label: "Fresh air strength", command: "set_fresh_air_strength", section: "Air" },
  drying: { label: "Drying / Anti-mildew", command: "set_drying", section: "Air" },
  selfClean: { label: "Self clean", command: "set_self_clean", section: "Device" },
  screen: { label: "Display", command: "set_screen", section: "Device" },
  lightSense: { label: "Light sensing", command: "set_light_sense", section: "Device" },
  beep: { label: "Beep", command: "set_beep", section: "Device" },
};

function supportsCommand(d: AcDevice, command: string, value?: number): boolean {
  const has = (options: AcOption[]) => value == null ? options.length > 0 : options.some((option) => option.value === value);
  if (command === "set_mode") return has(d.capabilities.modes);
  if (command === "set_fan_speed") return has(d.capabilities.fanSpeeds);
  if (command === "set_vertical_swing") return has(d.capabilities.verticalSwing);
  if (command === "set_horizontal_swing") return has(d.capabilities.horizontalSwing);
  if (command === "set_generator_mode") return has(d.capabilities.generatorLevels);
  if (command === "set_temperature" || command === "set_power") return true;
  return Object.entries(FEATURE_UI).some(([id, meta]) => meta.command === command && d.capabilities.controls.some((control) => control.id === id));
}

function effectiveGeneratorLevel(d: AcDevice, storedLevel: number): number | null {
  const values = d.capabilities.generatorLevels.map((option) => option.value);
  if (values.length === 0 || !Number.isInteger(storedLevel) || storedLevel < 0) return null;
  if (values.includes(storedLevel)) return storedLevel;
  // Firmware can remove upper levels while old presets still carry them.
  return Math.min(storedLevel, Math.max(...values));
}

// ---------- Presets ----------

interface PresetData {
  mode: number;
  targetTemp: number;
  fanSpeed: number;
  eco: boolean;
  turbo: boolean;
  screen: boolean;
  verticalSwing: number;
  horizontalSwing: number;
  freshAir: boolean;
  generatorMode: number;
}

type PresetSlots = Record<number, PresetData | null>;

const PRESET_COUNT = 10;
const PRESET_SLOTS = Array.from({ length: PRESET_COUNT }, (_, i) => i + 1);
const EMPTY_PRESETS: PresetSlots = Object.fromEntries(PRESET_SLOTS.map((s) => [s, null])) as PresetSlots;

async function loadPresetsFromServer(deviceId: string): Promise<PresetSlots> {
  try {
    const resp = await fetch(`/api/ac/presets/${deviceId}`);
    if (resp.ok) {
      const json = (await resp.json()) as { presets: PresetSlots };
      return json.presets;
    }
  } catch { /* ignore */ }
  return { ...EMPTY_PRESETS };
}

function savePresets(deviceId: string, presets: PresetSlots, changedSlot?: number) {
  if (changedSlot != null && presets[changedSlot]) {
    fetch("/api/ac/preset-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, slot: changedSlot, presetData: presets[changedSlot] }),
    }).catch(() => {});
  }
}

function migrateLocalPresets(deviceId: string) {
  const key = `ac-presets-${deviceId}`;
  const raw = localStorage.getItem(key);
  if (!raw) return;
  try {
    const local = JSON.parse(raw) as PresetSlots;
    for (const [slot, data] of Object.entries(local)) {
      if (data != null) {
        fetch(`/api/ac/presets/${deviceId}/${slot}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ presetData: data }),
        }).catch(() => {});
      }
    }
    localStorage.removeItem(key);
  } catch { /* ignore */ }
}

function capturePreset(d: AcDevice): PresetData {
  return {
    mode: d.mode,
    targetTemp: d.targetTemp,
    fanSpeed: d.fanSpeed,
    eco: d.eco,
    turbo: d.turbo,
    screen: d.screen,
    verticalSwing: d.verticalSwing,
    horizontalSwing: d.horizontalSwing,
    freshAir: d.freshAir,
    generatorMode: d.generatorMode,
  };
}

function fanLabel(fanSpeed: number): string {
  return FAN_LABELS[fanSpeed] ?? String(fanSpeed);
}

// A profile is "active" when its visible summary (mode, temp, fan, generator)
// matches the AC's current applied state. Hidden props (eco/turbo/swings) are ignored.
function presetMatchesCurrent(p: PresetData, d: AcDevice): boolean {
  if (!d.power) return false;
  const round = (n: number) => Math.round(n * 2) / 2; // 0.5°C steps
  return (
    p.mode === d.mode &&
    round(p.targetTemp) === round(d.targetTemp) &&
    p.fanSpeed === d.fanSpeed &&
    (effectiveGeneratorLevel(d, p.generatorMode) ?? d.generatorMode) === d.generatorMode
  );
}

// ---------- Timer helpers ----------

interface AcTimerData {
  deviceId: string;
  action: "on" | "off";
  preset?: Record<string, unknown>;
  fireAt: number;
}

function useAcTimers() {
  const [timers, setTimers] = useState<AcTimerData[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const fetchTimers = useCallback(async () => {
    try {
      const resp = await fetch("/api/ac/timers");
      if (resp.ok) {
        const data = (await resp.json()) as { timers: AcTimerData[] };
        setTimers(data.timers);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchTimers();
    intervalRef.current = setInterval(fetchTimers, 5_000);
    return () => clearInterval(intervalRef.current);
  }, [fetchTimers]);

  const setTimer = async (deviceId: string, action: "on" | "off", minutes: number, preset?: Record<string, unknown>) => {
    await fetch("/api/ac/timer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, action, minutes, preset }),
    });
    await fetchTimers();
  };

  const cancelTimer = async (deviceId: string) => {
    await fetch(`/api/ac/timer/${deviceId}`, { method: "DELETE" });
    await fetchTimers();
  };

  return { timers, setTimer, cancelTimer, refetch: fetchTimers };
}

function formatCountdown(fireAt: number): string {
  const remaining = Math.max(0, fireAt - Date.now());
  const mins = Math.ceil(remaining / 60_000);
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${mins}m`;
}

interface AcWidgetProps {
  device: AcDevice;
  onControl: (command: string, value: unknown) => Promise<void>;
  timer?: AcTimerData | null;
  onSetTimer?: (action: "on" | "off", minutes: number, preset?: Record<string, unknown>) => Promise<void>;
  onCancelTimer?: () => Promise<void>;
  label?: string;
}

export { useAcTimers, type AcTimerData };

export function AcWidget({ device: d, onControl, timer, onSetTimer, onCancelTimer, label }: AcWidgetProps) {
  const [showDetail, setShowDetail] = useState(false);
  const [powerBusy, setPowerBusy] = useState(false);
  const [powerError, setPowerError] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!timer) return;
    const id = setInterval(() => setTick(t => t + 1), 10_000);
    return () => clearInterval(id);
  }, [timer]);
  void tick;

  const isOn = d.power;
  const offline = !d.isOnline;
  const colors = getModeColors(d.mode);
  const modeInfo = MODE_LABELS[d.mode] ?? MODE_LABELS[0];

  // A refused power command used to fail silently (the optimistic state just
  // reverted). Show the server's reason, e.g. a dashboard ON superseded by a
  // Smart AC Leveling overload shed (409 "superseded", 2026-09-27).
  useEffect(() => {
    if (!powerError) return;
    const id = setTimeout(() => setPowerError(""), 10_000);
    return () => clearTimeout(id);
  }, [powerError]);

  // Offline while ON (the grid-only Guest on generator): the power button arms
  // a one-shot OFF the server sends when the unit reports again.
  // The optimistic value yields to any fresh snapshot of the unit, not only an
  // offWhenOnline change: the server can arm and resolve between two polls, and
  // then that flag never changes while online, power and last-seen do.
  const [armedLocal, setArmedLocal] = useState<boolean | null>(null);
  useEffect(() => { setArmedLocal(null); }, [d.offWhenOnline, d.isOnline, d.power, d.lastSeenAt]);
  const offArmed = armedLocal ?? d.offWhenOnline === true;
  // ACs outside Smart AC Leveling only (the server refuses the rest): a leveled
  // AC offline keeps the disabled power button.
  const canArmOff = offline && !d.levelingEligible && (isOn || offArmed);

  const handleArmOff = async () => {
    if (powerBusy) return;
    const next = !offArmed;
    setPowerBusy(true);
    setPowerError("");
    try {
      const resp = await fetch(`/api/ac/devices/${encodeURIComponent(d.id)}/off-when-online`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const body = await resp.json().catch(() => ({})) as { error?: string; offWhenOnline?: unknown };
      // The server's answer is authoritative, not the request (it can refuse an
      // arm, or the arm can already have resolved), also on a 500 whose change
      // holds in memory only.
      if (typeof body.offWhenOnline === "boolean") setArmedLocal(body.offWhenOnline);
      if (!resp.ok) throw new Error(body.error ?? `Request failed (${resp.status})`);
    } catch (err) {
      setPowerError((err as Error).message || "Command failed");
    } finally {
      setPowerBusy(false);
    }
  };

  const handlePowerToggle = async () => {
    if (canArmOff) { await handleArmOff(); return; }
    if (offline || powerBusy) return;
    setPowerBusy(true);
    setPowerError("");
    try {
      await onControl("set_power", isOn ? 0 : 1);
    } catch (err) {
      const raw = (err as Error).message ?? "";
      let message = raw || "Command failed";
      try {
        const body = JSON.parse(raw) as { message?: string; error?: string };
        message = body.message ?? body.error ?? message;
      } catch { /* not JSON: show as is */ }
      setPowerError(message);
    } finally {
      setPowerBusy(false);
    }
  };

  return (
    <>
      <div className={cn(
        "flex flex-col items-center bg-[#171920]/90 border border-white/[0.05] p-1 rounded-2xl shadow-[0_4px_12px_-4px_rgba(0,0,0,0.5)] backdrop-blur-xl transition-all shrink-0 self-start",
        offline ? (canArmOff ? "opacity-70" : "opacity-40") : "hover:border-white/10 hover:bg-[#1a1c23]/95"
      )}>
        {/* Header */}
        <span className="text-[0.65rem] text-text/70 font-bold tracking-wider mt-0.5 mb-0.5">{label ?? "AC"}</span>

        {/* Row 1: Power + Settings */}
        <div className="flex items-center gap-1">
          <button
            onClick={handlePowerToggle}
            disabled={(offline && !canArmOff) || powerBusy}
            className={cn(
              "relative flex items-center justify-center w-7 h-7 rounded-full transition-all shrink-0",
              canArmOff
                ? (offArmed ? "bg-amber-400/90 text-black shadow-[0_0_12px_rgba(251,191,36,0.5)]" : "bg-white/[0.06] text-dim hover:bg-white/15 hover:text-white")
                : !isOn && "bg-white/[0.03] text-dim hover:bg-white/10 hover:text-white",
              ((offline && !canArmOff) || powerBusy) && "cursor-not-allowed",
            )}
            style={isOn && !canArmOff ? { backgroundColor: colors.accent, color: "#000", boxShadow: `0 0 12px ${colors.glow}` } : undefined}
            title={canArmOff
              ? (offArmed ? "Will turn off when back online (tap to cancel)" : "Offline: turn off when back online")
              : offline ? "Offline" : isOn ? "Turn off" : "Turn on"}
          >
            {powerBusy
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : offArmed && canArmOff
                ? <TimerOff className="w-3.5 h-3.5" strokeWidth={2.5} />
                : <Power className="w-3.5 h-3.5" strokeWidth={2.5} />
            }
          </button>
          <button
            onClick={() => setShowDetail(true)}
            className="flex items-center justify-center w-7 h-7 rounded-full text-dim hover:text-white hover:bg-white/10 transition-colors shrink-0"
            title={`${label ?? d.displayName} AC settings`}
            aria-label={`${label ?? d.displayName} AC settings`}
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>

        {powerError && (
          <p role="alert" className="mt-0.5 max-w-[8.5rem] text-center text-[0.55rem] leading-tight text-red-400">{powerError}</p>
        )}
        {canArmOff && offArmed && !powerError && (
          <p className="mt-0.5 max-w-[8.5rem] text-center text-[0.55rem] leading-tight text-amber-300">off when back</p>
        )}

        <div className="h-[1px] w-3/4 bg-white/[0.08] my-1" />

        {/* Row 2: Temperature + Fan/Power indicators */}
        <div className="flex items-center gap-2 px-2 py-1">
          {/* Left col: Temperature */}
          <div className="flex flex-col items-center">
            {isOn ? (
              <>
                <span className="text-lg font-bold leading-none tabular-nums" style={{ color: colors.text }}>
                  {d.targetTemp}°
                </span>
                <span className="text-[0.55rem] text-dim font-medium mt-0.5">
                  {d.currentTemp > 0 ? `${d.currentTemp}°` : modeInfo.label}
                </span>
              </>
            ) : (
              d.manualOffLocked
                ? <Lock className="w-4 h-4 text-dim" />
                : <Snowflake className="w-4 h-4 text-dim" />
            )}
          </div>

          {/* Right col: Fan + Generator (when on) */}
          {isOn && (
            <div className="flex flex-col items-center gap-0.5">
              <div className="flex items-center gap-0.5">
                <Wind className="w-2.5 h-2.5 text-dim" />
                <span className="text-[0.55rem] text-dim font-bold tabular-nums">
                  {FAN_LABELS[d.fanSpeed] ?? "A"}
                </span>
              </div>
              {d.generatorMode > 0 && (
                <div className="flex items-center gap-0.5">
                  <Zap className="w-2.5 h-2.5" style={{ color: colors.accent }} />
                  <span className="text-[0.55rem] font-bold tabular-nums" style={{ color: colors.accent }}>
                    L{d.generatorMode}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Timer countdown indicator */}
        {timer && (
          <div className="flex items-center gap-0.5 px-1.5 py-0.5 mt-0.5">
            <Timer className="w-2.5 h-2.5" style={{ color: timer.action === "on" ? "#34d399" : "#f87171" }} />
            <span className="text-[0.55rem] font-bold tabular-nums" style={{ color: timer.action === "on" ? "#34d399" : "#f87171" }}>
              {formatCountdown(timer.fireAt)}
            </span>
          </div>
        )}
      </div>

      {showDetail && (
        <AcDetailOverlay device={d} onControl={onControl} onClose={() => setShowDetail(false)} timer={timer} onSetTimer={onSetTimer} onCancelTimer={onCancelTimer} />
      )}
    </>
  );
}

// ---------- Detail Overlay ----------

function AcDetailOverlay({ device: d, onControl, onClose, timer, onSetTimer, onCancelTimer }: {
  device: AcDevice;
  onControl: (command: string, value: unknown) => Promise<void>;
  onClose: () => void;
  timer?: AcTimerData | null;
  onSetTimer?: (action: "on" | "off", minutes: number, preset?: Record<string, unknown>) => Promise<void>;
  onCancelTimer?: () => Promise<void>;
}) {
  const [phase, setPhase] = useState<"in" | "out">("in");
  const [saveMode, setSaveMode] = useState(false);
  const [applyingPreset, setApplyingPreset] = useState<number | null>(null);
  const [presetError, setPresetError] = useState("");
  const [presets, setPresets] = useState<PresetSlots>({ ...EMPTY_PRESETS });

  const applyPreset = async (slot: number, sv: PresetData) => {
    setApplyingPreset(slot);
    setPresetError("");
    try {
      const generatorMode = effectiveGeneratorLevel(d, sv.generatorMode);
      const response = await fetch("/api/ac/preset-apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: d.id, slot, presetData: generatorMode == null ? sv : { ...sv, generatorMode } }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? "Failed to apply preset");
      }
    } catch (err) {
      setPresetError((err as Error).message || "Failed to apply preset");
    } finally {
      setApplyingPreset(null);
    }
  };

  useEffect(() => {
    migrateLocalPresets(d.id);
    loadPresetsFromServer(d.id).then(setPresets);
  }, [d.id]);
  const [timerOpen, setTimerOpen] = useState(false);
  const [timerMinutes, setTimerMinutes] = useState(60);
  const [timerAction, setTimerAction] = useState<"on" | "off">("off");
  const [timerPreset, setTimerPreset] = useState<number | null>(null);
  const isOn = d.power;
  const offline = !d.isOnline;
  const colors = getModeColors(d.mode);
  const turnOnTimerBlocked = timerAction === "on" && d.manualOffLocked;

  const handleClose = useCallback(() => {
    setSaveMode(false);
    setPhase("out");
    setTimeout(onClose, 150);
  }, [onClose]);

  const send = (command: string, value: unknown) => {
    onControl(command, value).catch(() => {});
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-overlay-in"
      style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className={cn(
          "glass-card flex flex-col w-[460px] max-w-[95vw] max-h-[80vh]",
          phase === "in" ? "animate-panel-in" : "animate-panel-out",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: offline ? "#7a8ba8" : isOn ? colors.accent : "#71717a" }} />
            <h2 className="text-base font-medium text-text">{d.displayName}</h2>
            <span className="text-xs text-dim">{offline ? "offline" : isOn ? "on" : "off"}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => send("set_power", isOn ? 0 : 1)}
              disabled={offline}
              className={cn(
                "p-2 rounded-lg transition-colors",
                !isOn && "bg-white/5 text-dim hover:bg-white/10",
                offline && "opacity-40 cursor-not-allowed",
              )}
              style={isOn ? { backgroundColor: colors.bg, color: colors.text } : undefined}
            >
              <Power className="w-5 h-5" />
            </button>
            <button
              onClick={handleClose}
              className="p-1 rounded-lg text-dim hover:text-white hover:bg-white/10 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4 flex flex-col gap-4">
          {/* Temperature control */}
          <div className="flex items-center justify-center gap-6">
            <button
              onClick={() => send("set_temperature", Math.max(d.capabilities.temperature.min, +(d.targetTemp - d.capabilities.temperature.step).toFixed(1)))}
              disabled={offline || !isOn}
              className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-dim hover:text-white transition-colors disabled:opacity-30"
            >
              <ChevronDown className="w-6 h-6" />
            </button>
            <div className="flex flex-col items-center">
              <span className="text-4xl font-bold tabular-nums leading-none" style={{ color: colors.text }}>
                {d.targetTemp}°
              </span>
              <span className="text-xs text-dim mt-1">Target</span>
            </div>
            <button
              onClick={() => send("set_temperature", Math.min(d.capabilities.temperature.max, +(d.targetTemp + d.capabilities.temperature.step).toFixed(1)))}
              disabled={offline || !isOn}
              className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-dim hover:text-white transition-colors disabled:opacity-30"
            >
              <ChevronUp className="w-6 h-6" />
            </button>
          </div>

          {/* Current temp */}
          {d.currentTemp > 0 && (
            <div className="text-center">
              <span className="text-sm text-dim">Room: </span>
              <span className="text-sm text-text font-medium">{d.currentTemp}°C</span>
            </div>
          )}

          {/* Timer — always visible */}
          {!offline && (
            <div>
              <span className="text-[0.65rem] text-dim uppercase tracking-wider mb-1.5 block">Timer</span>
              {timer ? (
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 flex-1">
                    <Timer className="w-3.5 h-3.5" style={{ color: timer.action === "on" ? "#34d399" : "#f87171" }} />
                    <span className="text-sm font-medium" style={{ color: timer.action === "on" ? "#34d399" : "#f87171" }}>
                      {timer.action === "on" ? "Turn ON" : "Turn OFF"} in {formatCountdown(timer.fireAt)}
                    </span>
                  </div>
                  <button
                    onClick={() => onCancelTimer?.()}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg border border-red-400/30 bg-red-400/10 text-red-400 text-xs hover:bg-red-400/20 transition-colors"
                  >
                    <TimerOff className="w-3 h-3" /> Cancel
                  </button>
                </div>
              ) : !timerOpen ? (
                <button
                  onClick={() => { setTimerOpen(true); setTimerAction(isOn ? "off" : "on"); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-dim text-xs hover:text-text hover:border-white/20 transition-colors"
                >
                  <Timer className="w-3.5 h-3.5" /> Set timer
                </button>
              ) : (
                <div className="flex flex-col gap-2 p-2.5 rounded-lg bg-white/5 border border-white/10">
                  <div className="flex gap-1.5">
                    {(["on", "off"] as const).map((a) => (
                      <button key={a} onClick={() => setTimerAction(a)} className={cn(
                        "flex-1 px-2 py-1 rounded-lg text-xs border transition-colors",
                        timerAction === a
                          ? a === "on" ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-400" : "border-red-400/50 bg-red-400/10 text-red-400"
                          : "border-white/10 bg-white/5 text-dim hover:text-text",
                      )}>
                        Turn {a.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {[15, 30, 60, 90, 120, 180, 240].map((m) => (
                      <button key={m} onClick={() => setTimerMinutes(m)} className={cn(
                        "px-2 py-1 rounded text-xs border transition-colors",
                        timerMinutes === m ? "border-sky-400/50 bg-sky-400/15 text-sky-300" : "border-white/10 bg-white/5 text-dim hover:text-text",
                      )}>
                        {m >= 60 ? `${m / 60}h` : `${m}m`}
                      </button>
                    ))}
                  </div>
                  {timerAction === "on" && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-dim">Preset:</span>
                      <button onClick={() => setTimerPreset(null)} className={cn(
                        "px-2 py-0.5 rounded text-[10px] border transition-colors",
                        timerPreset == null ? "border-sky-400/50 bg-sky-400/15 text-sky-300" : "border-white/10 bg-white/5 text-dim",
                      )}>None</button>
                      {PRESET_SLOTS.filter(s => presets[s] != null).map(s => (
                        <button key={s} onClick={() => setTimerPreset(s)} className={cn(
                          "px-2 py-0.5 rounded text-[10px] border transition-colors",
                          timerPreset === s ? "border-sky-400/50 bg-sky-400/15 text-sky-300" : "border-white/10 bg-white/5 text-dim",
                        )}>{s}</button>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => setTimerOpen(false)}
                      className="flex-1 px-2 py-1 rounded-lg text-xs border border-white/10 bg-white/5 text-dim hover:text-text transition-colors"
                    >Cancel</button>
                    <button
                      onClick={async () => {
                        if (turnOnTimerBlocked) return;
                        const savedPreset = timerPreset == null ? null : presets[timerPreset];
                        const timerGeneratorMode = savedPreset == null ? null : effectiveGeneratorLevel(d, savedPreset.generatorMode);
                        const preset = timerAction === "on" && savedPreset
                          ? {
                              ...(supportsCommand(d, "set_mode", savedPreset.mode) ? { mode: savedPreset.mode } : {}),
                              temperature: savedPreset.targetTemp,
                              ...(supportsCommand(d, "set_fan_speed", savedPreset.fanSpeed) ? { fan_speed: savedPreset.fanSpeed } : {}),
                              ...(supportsCommand(d, "set_eco") ? { eco: savedPreset.eco ? 1 : 0 } : {}),
                              ...(supportsCommand(d, "set_turbo") ? { turbo: savedPreset.turbo ? 1 : 0 } : {}),
                              ...(supportsCommand(d, "set_screen") ? { screen: savedPreset.screen ? 1 : 0 } : {}),
                              ...(supportsCommand(d, "set_vertical_swing", savedPreset.verticalSwing) ? { vertical_swing: savedPreset.verticalSwing } : {}),
                              ...(supportsCommand(d, "set_horizontal_swing", savedPreset.horizontalSwing) ? { horizontal_swing: savedPreset.horizontalSwing } : {}),
                              ...(supportsCommand(d, "set_fresh_air") ? { fresh_air: savedPreset.freshAir ? 1 : 0 } : {}),
                              ...(timerGeneratorMode != null ? { generator_mode: timerGeneratorMode } : {}),
                            }
                          : undefined;
                        await onSetTimer?.(timerAction, timerMinutes, preset);
                        setTimerOpen(false);
                      }}
                      disabled={turnOnTimerBlocked}
                      title={turnOnTimerBlocked ? "Turn the AC on manually before setting an on timer" : undefined}
                      className={cn(
                        "flex-1 px-2 py-1 rounded-lg text-xs border transition-colors",
                        turnOnTimerBlocked && "opacity-40 cursor-not-allowed",
                      )}
                      style={{ borderColor: colors.border, backgroundColor: colors.bg, color: colors.text }}
                    >Start</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Mode selector */}
          <>
              {d.capabilities.modes.length > 0 && (
              <div>
                <span className="text-xs text-dim mb-1.5 block">Mode</span>
                <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${d.capabilities.modes.length}, minmax(0, 1fr))` }}>
                  {d.capabilities.modes.map((option) => {
                    const m = option.value;
                    const info = MODE_LABELS[m] ?? { label: option.label, icon: Gauge };
                    const Icon = info.icon;
                    const mc = getModeColors(m);
                    return (
                      <button
                        key={m}
                        onClick={() => send("set_mode", m)}
                        disabled={offline || !isOn}
                        className={cn(
                          "flex flex-col items-center gap-1 px-2 py-2 rounded-lg text-xs border transition-colors disabled:opacity-35 disabled:cursor-not-allowed",
                          d.mode !== m && "border-white/10 bg-white/5 text-dim hover:text-text hover:border-white/20",
                        )}
                        style={d.mode === m ? { borderColor: mc.border, backgroundColor: mc.bg, color: mc.text } : undefined}
                      >
                        <Icon className="w-4 h-4" />
                        <span className="text-[0.65rem]">{option.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              )}

              {/* Fan speed selector */}
              {d.capabilities.fanSpeeds.length > 0 && <div>
                <span className="text-xs text-dim mb-1.5 block">Fan Speed</span>
                <div className="flex gap-1.5 flex-wrap">
                  {d.capabilities.fanSpeeds.map((option) => {
                    const s = option.value;
                    return (
                      <button
                        key={s}
                        onClick={() => send("set_fan_speed", s)}
                        disabled={offline || !isOn}
                        title={option.label}
                        className={cn(
                          "min-w-9 flex-1 py-1.5 rounded-lg text-xs border transition-colors disabled:opacity-35 disabled:cursor-not-allowed",
                          d.fanSpeed !== s && "border-white/10 bg-white/5 text-dim hover:text-text hover:border-white/20",
                        )}
                        style={d.fanSpeed === s ? { borderColor: colors.border, backgroundColor: colors.bg, color: colors.text } : undefined}
                      >
                        {option.label === "Silent"
                          ? <EarOff className="w-3 h-3 mx-auto" />
                          : option.label === "Auto" ? "A" : option.label === "Max" ? "Max" : option.label}
                      </button>
                    );
                  })}
                </div>
              </div>}

              {/* Vertical swing */}
              {d.capabilities.verticalSwing.length > 0 && <SwingSelector
                label="Vertical"
                value={d.verticalSwing}
                onChange={(v) => send("set_vertical_swing", v)}
                axis="vertical"
                values={d.capabilities.verticalSwing}
                disabled={offline || !isOn}
                colors={colors}
              />}

              {/* Horizontal swing */}
              {d.capabilities.horizontalSwing.length > 0 && <SwingSelector
                label="Horizontal"
                value={d.horizontalSwing}
                onChange={(v) => send("set_horizontal_swing", v)}
                axis="horizontal"
                values={d.capabilities.horizontalSwing}
                disabled={offline || !isOn}
                colors={colors}
              />}

              <CapabilitySections controls={d.capabilities.controls} send={send} offline={offline} colors={colors} />

              {/* Generator mode */}
              {d.capabilities.generatorLevels.length > 0 && <div>
                <span className="text-[0.65rem] text-dim uppercase tracking-wider mb-1.5 block">Generator</span>
                <div className="flex gap-1.5 flex-wrap">
                  {d.capabilities.generatorLevels.map((option) => {
                    const lvl = option.value;
                    return (
                      <button
                        key={lvl}
                        onClick={() => send("set_generator_mode", lvl)}
                        disabled={offline || !isOn}
                        className={cn(
                          "px-2.5 py-1.5 rounded-lg text-xs border transition-colors disabled:opacity-35 disabled:cursor-not-allowed",
                          d.generatorMode !== lvl && "border-white/10 bg-white/5 text-dim hover:text-text hover:border-white/20",
                        )}
                        style={d.generatorMode === lvl ? { borderColor: colors.border, backgroundColor: colors.bg, color: colors.text } : undefined}
                      >
                        {option.label === "Off" ? "OFF" : `L${option.label}`}
                      </button>
                    );
                  })}
                </div>
              </div>}

              {/* Presets */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[0.65rem] text-dim uppercase tracking-wider">Presets</span>
                  {/* Save button */}
                  <button
                    onClick={() => setSaveMode((v) => !v)}
                    className={cn(
                      "flex items-center justify-center w-8 h-8 rounded-lg border text-xs transition-colors",
                      !saveMode && "border-white/10 bg-white/5 text-dim hover:text-text hover:border-white/20",
                    )}
                    style={saveMode ? { borderColor: colors.border, backgroundColor: colors.bg, color: colors.text } : undefined}
                    title={saveMode ? "Cancel save" : "Save to preset"}
                  >
                    <Save className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Preset slots 1-10 (5x2 grid) */}
                <div className="grid grid-cols-5 gap-1.5">
                  {PRESET_SLOTS.map((slot) => {
                    const p = presets[slot];
                    const filled = p != null;
                    const isApplying = applyingPreset === slot;
                    const isCurrent = filled && presetMatchesCurrent(p, d);
                    const pColors = filled ? getModeColors(p.mode) : colors;
                    const ModeIcon = filled ? MODE_LABELS[p.mode]?.icon : undefined;
                    return (
                      <button
                        key={slot}
                        onClick={() => {
                          if (saveMode) {
                            const next = { ...presets, [slot]: capturePreset(d) };
                            setPresets(next);
                            savePresets(d.id, next, slot);
                            setSaveMode(false);
                          } else if (filled && applyingPreset == null) {
                            void applyPreset(slot, p);
                          }
                        }}
                        disabled={!saveMode && applyingPreset != null}
                        className={cn(
                          "relative flex flex-col items-center justify-center gap-0.5 h-14 rounded-lg border px-1 py-1 text-xs font-medium transition-colors",
                          saveMode && "animate-preset-blink",
                          !isApplying && !saveMode && !filled && "border-white/[0.06] bg-white/[0.02] text-dim/50",
                          !isApplying && !saveMode && filled && "border-white/15 bg-white/5 text-dim hover:text-text hover:border-white/25",
                        )}
                        style={
                          isApplying
                            ? { borderColor: pColors.border, backgroundColor: pColors.bg, color: pColors.text, boxShadow: `0 0 8px ${pColors.glow}` }
                            : isCurrent
                              ? { borderColor: pColors.border, boxShadow: `inset 0 0 0 1px ${pColors.border}` }
                              : undefined
                        }
                        title={filled ? `Apply preset ${slot}` : `Empty slot ${slot}`}
                      >
                        {isCurrent && (
                          <span
                            className="absolute top-0.5 right-0.5 flex items-center justify-center w-3.5 h-3.5 rounded-full"
                            style={{ backgroundColor: pColors.accent }}
                          >
                            <Check className="w-2.5 h-2.5 text-black" />
                          </span>
                        )}
                        <span className="leading-none">{slot}</span>
                        {filled ? (
                          <>
                            <span className="flex items-center gap-0.5 leading-none">
                              {ModeIcon && <ModeIcon className="w-2.5 h-2.5" style={{ color: pColors.accent }} />}
                              <span className="text-[0.55rem] tabular-nums text-text">{p.targetTemp}°</span>
                            </span>
                            <span className="flex items-center gap-1 text-[0.5rem] tabular-nums text-dim leading-none">
                              <span className="flex items-center gap-0.5"><Wind className="w-2 h-2" />{fanLabel(p.fanSpeed)}</span>
                              {p.generatorMode > 0 && (
                                <span className="flex items-center gap-0.5" style={{ color: pColors.accent }}>
                                  <Zap className="w-2 h-2" />{p.generatorMode}
                                </span>
                              )}
                            </span>
                          </>
                        ) : (
                          <span className="text-[0.6rem] text-dim/40 leading-none">—</span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {presetError && <p role="alert" className="mt-1.5 text-[0.65rem] text-red-400">{presetError}</p>}
              </div>
            </>

          {offline && (
            <p className="text-sm text-dim text-center py-2">
              Device is offline
              {d.lastSeenAt != null && (
                <span className="block text-xs opacity-70">
                  last seen {new Date(d.lastSeenAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function featureIcon(id: AcFeatureId): React.ReactNode {
  switch (id) {
    case "turbo": return <Zap className="w-3 h-3" />;
    case "healthy":
    case "freshAir":
    case "freshAirStrength": return <AirVent className="w-3 h-3" />;
    case "drying": return <Droplets className="w-3 h-3" />;
    case "beep": return <Volume2 className="w-3 h-3" />;
    case "gentleBreeze": return <Wind className="w-3 h-3" />;
    case "eightDegreeHeat": return <Sun className="w-3 h-3" />;
    default: return <Gauge className="w-3 h-3" />;
  }
}

function CapabilitySections({ controls, send, offline, colors }: {
  controls: AcControlCapability[];
  send: (command: string, value: unknown) => void;
  offline: boolean;
  colors: { toggleBg: string; toggleDot: string; border: string; bg: string; text: string };
}) {
  return (
    <>
      {(["Comfort", "Air", "Device"] as const).map((section) => {
        const sectionControls = controls.filter((control) => FEATURE_UI[control.id].section === section);
        if (sectionControls.length === 0) return null;
        return (
          <div key={section}>
            <span className="text-[0.65rem] text-dim uppercase tracking-wider mb-1.5 block">{section}</span>
            <div className="grid grid-cols-2 gap-1.5">
              {sectionControls.map((control) => {
                const meta = FEATURE_UI[control.id];
                const disabled = offline || !control.available;
                const title = disabled ? (offline ? "Device is offline" : control.unavailableReason) : undefined;
                if (control.kind === "select") {
                  return (
                    <label key={control.id} className={cn("flex flex-col gap-1 rounded-lg bg-white/5 px-2.5 py-2", disabled && "opacity-40")} title={title}>
                      <span className="text-[0.65rem] text-dim flex items-center gap-1">{featureIcon(control.id)}{meta.label}</span>
                      <select
                        value={control.value ?? 0}
                        onChange={(event) => send(meta.command, Number(event.target.value))}
                        disabled={disabled}
                        className="w-full rounded-md border border-white/10 bg-[#171920] px-2 py-1 text-xs text-text disabled:cursor-not-allowed"
                      >
                        {(control.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                  );
                }
                if (control.kind === "action") {
                  const active = control.value === 1;
                  return (
                    <button
                      key={control.id}
                      onClick={() => send(meta.command, active ? 0 : 1)}
                      disabled={disabled}
                      title={title}
                      className="col-span-2 flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                      style={{ borderColor: colors.border, backgroundColor: colors.bg, color: colors.text }}
                    >
                      <Settings className="w-3.5 h-3.5" /> {active ? "Stop self clean" : "Start self clean"}
                    </button>
                  );
                }
                return (
                  <AcToggle
                    key={control.id}
                    label={meta.label}
                    value={control.value === 1}
                    onChange={(value) => send(meta.command, value ? 1 : 0)}
                    icon={featureIcon(control.id)}
                    disabled={disabled}
                    title={title}
                    colors={colors}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ---------- Swing Selector ----------

function SwingSelector({ label, value, onChange, axis, values, disabled, colors }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  axis: "vertical" | "horizontal";
  values: AcOption[];
  disabled?: boolean;
  colors: { accent: string; border: string; bg: string; text: string };
}) {
  const allowed = new Set(values.map((option) => option.value));
  const options = (axis === "vertical" ? VERTICAL_SWING_OPTIONS : HORIZONTAL_SWING_OPTIONS).filter((option) => allowed.has(option.value));
  const swingOpts = options.filter(o => o.type === "swing");
  const fixOpts = options.filter(o => o.type === "fix");
  const IconComponent = axis === "vertical" ? VerticalIcon : HorizontalIcon;

  const renderBtn = (o: typeof options[number]) => {
    return (
      <button
        key={o.value}
        onClick={() => onChange(o.value)}
        disabled={disabled}
        className={cn(
          "flex items-center justify-center w-8 h-8 rounded-lg border transition-colors disabled:opacity-35 disabled:cursor-not-allowed",
          value !== o.value && "border-white/10 bg-white/5 text-dim hover:text-text hover:border-white/20",
        )}
        style={value === o.value ? { borderColor: colors.border, backgroundColor: colors.bg, color: colors.text } : undefined}
        title={o.label}
      >
        <IconComponent value={o.value} />
      </button>
    );
  };

  return (
    <div>
      <span className="text-[0.65rem] text-dim uppercase tracking-wider mb-1.5 block">{label}</span>
      <div className="flex gap-1 flex-wrap">
        {swingOpts.map(renderBtn)}
        <div className="w-px bg-white/10 mx-0.5 self-stretch" />
        {fixOpts.map(renderBtn)}
      </div>
    </div>
  );
}

function AcToggle({ label, value, onChange, icon, disabled, title, colors }: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  icon?: React.ReactNode;
  disabled?: boolean;
  title?: string;
  colors: { toggleBg: string; toggleDot: string };
}) {
  return (
    <button
      onClick={() => onChange(!value)}
      disabled={disabled}
      title={title}
      className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-40"
    >
      <span className="text-xs text-dim flex items-center gap-1">{icon}{label}</span>
      <span
        className="w-7 h-3.5 rounded-full relative transition-colors"
        style={{ backgroundColor: value ? colors.toggleBg : "rgba(255,255,255,0.1)" }}
      >
        <span
          className={cn("absolute top-0.5 w-2.5 h-2.5 rounded-full transition-all", value ? "left-3.5" : "left-0.5")}
          style={{ backgroundColor: value ? colors.toggleDot : "#7a8ba8" }}
        />
      </span>
    </button>
  );
}
