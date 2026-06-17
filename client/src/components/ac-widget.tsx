import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { Power, Settings, Loader2, X, ChevronUp, ChevronDown, Snowflake, Sun, Wind, Droplets, Zap, Gauge, AirVent, Save, Check, Timer, TimerOff, Volume2, EarOff, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AcDevice } from "@/types/ac";
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
    p.generatorMode === d.generatorMode
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

  const handlePowerToggle = async () => {
    if (offline || powerBusy) return;
    setPowerBusy(true);
    try { await onControl("set_power", isOn ? 0 : 1); } finally { setPowerBusy(false); }
  };

  return (
    <>
      <div className={cn(
        "flex flex-col items-center bg-[#171920]/90 border border-white/[0.05] p-1 rounded-2xl shadow-[0_4px_12px_-4px_rgba(0,0,0,0.5)] backdrop-blur-xl transition-all shrink-0 self-start",
        offline ? "opacity-40" : "hover:border-white/10 hover:bg-[#1a1c23]/95"
      )}>
        {/* Header */}
        <span className="text-[0.65rem] text-text/70 font-bold tracking-wider mt-0.5 mb-0.5">{label ?? "AC"}</span>

        {/* Row 1: Power + Settings */}
        <div className="flex items-center gap-1">
          <button
            onClick={handlePowerToggle}
            disabled={offline || powerBusy}
            className={cn(
              "relative flex items-center justify-center w-7 h-7 rounded-full transition-all shrink-0",
              !isOn && "bg-white/[0.03] text-dim hover:bg-white/10 hover:text-white",
              (offline || powerBusy) && "cursor-not-allowed",
            )}
            style={isOn ? { backgroundColor: colors.accent, color: "#000", boxShadow: `0 0 12px ${colors.glow}` } : undefined}
            title={offline ? "Offline" : isOn ? "Turn off" : "Turn on"}
          >
            {powerBusy
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Power className="w-3.5 h-3.5" strokeWidth={2.5} />
            }
          </button>
          <button
            onClick={() => setShowDetail(true)}
            className="flex items-center justify-center w-7 h-7 rounded-full text-dim hover:text-white hover:bg-white/10 transition-colors shrink-0"
            title="AC settings"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>

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
  const [presets, setPresets] = useState<PresetSlots>({ ...EMPTY_PRESETS });

  const applyPreset = async (slot: number, sv: PresetData) => {
    setApplyingPreset(slot);
    try {
      // Mode first — firmware may reset fan speed on mode change
      if (sv.mode !== d.mode) try { await onControl("set_mode", sv.mode); } catch {}
      if (sv.targetTemp !== d.targetTemp) try { await onControl("set_temperature", sv.targetTemp); } catch {}
      if (sv.eco !== d.eco) try { await onControl("set_eco", sv.eco ? 1 : 0); } catch {}
      if (sv.screen !== d.screen) try { await onControl("set_screen", sv.screen ? 1 : 0); } catch {}
      if (sv.verticalSwing !== d.verticalSwing) try { await onControl("set_vertical_swing", sv.verticalSwing); } catch {}
      if (sv.horizontalSwing !== d.horizontalSwing) try { await onControl("set_horizontal_swing", sv.horizontalSwing); } catch {}
      if (sv.freshAir !== d.freshAir) try { await onControl("set_fresh_air", sv.freshAir ? 1 : 0); } catch {}
      if (sv.generatorMode !== d.generatorMode) try { await onControl("set_generator_mode", sv.generatorMode); } catch {}
      // Fan speed last — after mode change processed by firmware
      if (sv.fanSpeed !== d.fanSpeed) try { await onControl("set_fan_speed", sv.fanSpeed); } catch {}
      if (sv.turbo !== d.turbo) try { await onControl("set_turbo", sv.turbo ? 1 : 0); } catch {}
      fetch("/api/ac/preset-apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: d.id, slot, presetData: sv }),
      }).catch(() => {});
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
            <h2 className="text-base font-medium text-text">{d.name}</h2>
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
              onClick={() => send("set_temperature", Math.max(16, +(d.targetTemp - (d.tempStep || 1)).toFixed(1)))}
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
              onClick={() => send("set_temperature", Math.min(36, +(d.targetTemp + (d.tempStep || 1)).toFixed(1)))}
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
                        const preset = timerAction === "on" && timerPreset != null && presets[timerPreset]
                          ? {
                              mode: presets[timerPreset]!.mode,
                              temperature: presets[timerPreset]!.targetTemp,
                              fan_speed: presets[timerPreset]!.fanSpeed,
                              eco: presets[timerPreset]!.eco ? 1 : 0,
                              turbo: presets[timerPreset]!.turbo ? 1 : 0,
                              screen: presets[timerPreset]!.screen ? 1 : 0,
                              vertical_swing: presets[timerPreset]!.verticalSwing,
                              horizontal_swing: presets[timerPreset]!.horizontalSwing,
                              fresh_air: presets[timerPreset]!.freshAir ? 1 : 0,
                              generator_mode: presets[timerPreset]!.generatorMode,
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
          {isOn && !offline && (
            <>
              <div>
                <span className="text-xs text-dim mb-1.5 block">Mode</span>
                <div className="grid grid-cols-5 gap-1.5">
                  {([0, 1, 2, 3, 4] as const).map((m) => {
                    const info = MODE_LABELS[m] ?? MODE_LABELS[0];
                    const Icon = info.icon;
                    const mc = getModeColors(m);
                    return (
                      <button
                        key={m}
                        onClick={() => send("set_mode", m)}
                        className={cn(
                          "flex flex-col items-center gap-1 px-2 py-2 rounded-lg text-xs border transition-colors",
                          d.mode !== m && "border-white/10 bg-white/5 text-dim hover:text-text hover:border-white/20",
                        )}
                        style={d.mode === m ? { borderColor: mc.border, backgroundColor: mc.bg, color: mc.text } : undefined}
                      >
                        <Icon className="w-4 h-4" />
                        <span className="text-[0.65rem]">{info.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Fan speed selector */}
              <div>
                <span className="text-xs text-dim mb-1.5 block">Fan Speed</span>
                <div className="flex gap-1.5">
                  {[0, ...Array.from({ length: (d.maxFanSpeed || 7) - (d.minFanSpeed || 1) + 1 }, (_, i) => i + (d.minFanSpeed || 1))].map((s) => {
                    return (
                      <button
                        key={s}
                        onClick={() => send("set_fan_speed", s)}
                        className={cn(
                          "flex-1 py-1.5 rounded-lg text-xs border transition-colors",
                          d.fanSpeed !== s && "border-white/10 bg-white/5 text-dim hover:text-text hover:border-white/20",
                        )}
                        style={d.fanSpeed === s ? { borderColor: colors.border, backgroundColor: colors.bg, color: colors.text } : undefined}
                      >
                        {d.model !== "TAC-24CHSA" && s === 1
                          ? <EarOff className="w-3 h-3 mx-auto" />
                          : d.model !== "TAC-24CHSA" && s >= 2
                            ? `${s - 1}`
                            : (FAN_LABELS[s] ?? `${s}`)}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Vertical swing */}
              <SwingSelector
                label="Vertical"
                value={d.verticalSwing}
                onChange={(v) => send("set_vertical_swing", v)}
                axis="vertical"
                colors={colors}
              />

              {/* Horizontal swing */}
              <SwingSelector
                label="Horizontal"
                value={d.horizontalSwing}
                onChange={(v) => send("set_horizontal_swing", v)}
                axis="horizontal"
                colors={colors}
              />

              {/* Toggles */}
              <div className="grid grid-cols-3 gap-1.5">
                <AcToggle label="ECO" value={d.eco} onChange={(v) => send("set_eco", v ? 1 : 0)} colors={colors} />
                <AcToggle label="Turbo" value={d.turbo} onChange={(v) => send("set_turbo", v ? 1 : 0)} icon={<Zap className="w-3 h-3" />} colors={colors} />
                <AcToggle label="Screen" value={d.screen} onChange={(v) => send("set_screen", v ? 1 : 0)} colors={colors} />
                <AcToggle label="Beep" value={d.beep} onChange={(v) => send("set_beep", v ? 1 : 0)} icon={<Volume2 className="w-3 h-3" />} colors={colors} />
                {d.hasFreshAir && (
                  <AcToggle label="Fresh" value={d.freshAir} onChange={(v) => send("set_fresh_air", v ? 1 : 0)} icon={<AirVent className="w-3 h-3" />} colors={colors} />
                )}
              </div>

              {/* Generator mode */}
              <div>
                <span className="text-[0.65rem] text-dim uppercase tracking-wider mb-1.5 block">Generator</span>
                <div className="flex gap-1.5 flex-wrap">
                  {[0, ...Array.from({ length: d.maxGeneratorLevel }, (_, i) => i + 1)].map((lvl) => {
                    return (
                      <button
                        key={lvl}
                        onClick={() => send("set_generator_mode", lvl)}
                        className={cn(
                          "px-2.5 py-1.5 rounded-lg text-xs border transition-colors",
                          d.generatorMode !== lvl && "border-white/10 bg-white/5 text-dim hover:text-text hover:border-white/20",
                        )}
                        style={d.generatorMode === lvl ? { borderColor: colors.border, backgroundColor: colors.bg, color: colors.text } : undefined}
                      >
                        {lvl === 0 ? "OFF" : lvl}
                      </button>
                    );
                  })}
                </div>
              </div>

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
              </div>
            </>
          )}

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

// ---------- Swing Selector ----------

function SwingSelector({ label, value, onChange, axis, colors }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  axis: "vertical" | "horizontal";
  colors: { accent: string; border: string; bg: string; text: string };
}) {
  const options = axis === "vertical" ? VERTICAL_SWING_OPTIONS : HORIZONTAL_SWING_OPTIONS;
  const swingOpts = options.filter(o => o.type === "swing");
  const fixOpts = options.filter(o => o.type === "fix");
  const IconComponent = axis === "vertical" ? VerticalIcon : HorizontalIcon;

  const renderBtn = (o: typeof options[number]) => {
    return (
      <button
        key={o.value}
        onClick={() => onChange(o.value)}
        className={cn(
          "flex items-center justify-center w-8 h-8 rounded-lg border transition-colors",
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

function AcToggle({ label, value, onChange, icon, disabled, colors }: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  icon?: React.ReactNode;
  disabled?: boolean;
  colors: { toggleBg: string; toggleDot: string };
}) {
  return (
    <button
      onClick={() => onChange(!value)}
      disabled={disabled}
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
