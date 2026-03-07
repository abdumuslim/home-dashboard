import { useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { Power, Settings, Loader2, X, ChevronUp, ChevronDown, ChevronsUpDown, ChevronsLeftRight, ChevronLeft, ChevronRight, Minus, Snowflake, Sun, Wind, Droplets, Zap, Gauge } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AcDevice } from "@/types/ac";

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
  0: "Auto",
  2: "Low",
  3: "Mid-Lo",
  4: "Med",
  5: "Mid-Hi",
  6: "High",
};

interface AcWidgetProps {
  device: AcDevice;
  onControl: (command: string, value: unknown) => Promise<void>;
}

export function AcWidget({ device: d, onControl }: AcWidgetProps) {
  const [showDetail, setShowDetail] = useState(false);
  const [powerBusy, setPowerBusy] = useState(false);

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
        <span className="text-[0.65rem] text-text/70 font-bold uppercase tracking-wider mt-0.5 mb-0.5">AC</span>

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
                  {d.currentTemp > 0 ? `${d.currentTemp}° now` : modeInfo.label}
                </span>
              </>
            ) : (
              <Snowflake className="w-4 h-4 text-dim" />
            )}
          </div>

          {/* Right col: Fan + Generator (when on) */}
          {isOn && (
            <div className="flex flex-col items-center gap-0.5">
              <div className="flex items-center gap-0.5">
                <Wind className="w-2.5 h-2.5 text-dim" />
                <span className="text-[0.55rem] text-dim font-bold tabular-nums">
                  {FAN_LABELS[d.fanSpeed] ?? "Auto"}
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
      </div>

      {showDetail && (
        <AcDetailOverlay device={d} onControl={onControl} onClose={() => setShowDetail(false)} />
      )}
    </>
  );
}

// ---------- Detail Overlay ----------

function AcDetailOverlay({ device: d, onControl, onClose }: {
  device: AcDevice;
  onControl: (command: string, value: unknown) => Promise<void>;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<"in" | "out">("in");
  const isOn = d.power;
  const offline = !d.isOnline;
  const colors = getModeColors(d.mode);

  const handleClose = useCallback(() => {
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
          "glass-card flex flex-col w-[400px] max-w-[95vw] max-h-[80vh]",
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
              onClick={() => send("set_temperature", Math.max(16, d.targetTemp - 1))}
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
              onClick={() => send("set_temperature", Math.min(36, d.targetTemp + 1))}
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
                <div className="grid grid-cols-3 gap-1.5">
                  {([0, 2, 3, 4, 5, 6] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => send("set_fan_speed", s)}
                      className={cn(
                        "px-2 py-1.5 rounded-lg text-xs border transition-colors",
                        d.fanSpeed !== s && "border-white/10 bg-white/5 text-dim hover:text-text hover:border-white/20",
                      )}
                      style={d.fanSpeed === s ? { borderColor: colors.border, backgroundColor: colors.bg, color: colors.text } : undefined}
                    >
                      {FAN_LABELS[s] ?? `${s}`}
                    </button>
                  ))}
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
              </div>

              {/* Generator mode */}
              <div>
                <span className="text-[0.65rem] text-dim uppercase tracking-wider mb-1.5 block">Generator</span>
                <div className="flex gap-1.5 flex-wrap">
                  {[0, ...Array.from({ length: d.maxGeneratorLevel }, (_, i) => i + 1)].map((lvl) => (
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
                  ))}
                </div>
              </div>
            </>
          )}

          {offline && (
            <p className="text-sm text-dim text-center py-2">Device is offline</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------- Swing Selector ----------

const VERTICAL_OPTIONS: { value: number; label: string; type: "swing" | "fix" }[] = [
  { value: 0, label: "Off", type: "swing" },
  { value: 1, label: "Full", type: "swing" },
  { value: 2, label: "Up", type: "swing" },
  { value: 3, label: "Down", type: "swing" },
  { value: 9, label: "Top", type: "fix" },
  { value: 10, label: "Upper", type: "fix" },
  { value: 11, label: "Mid", type: "fix" },
  { value: 12, label: "Lower", type: "fix" },
  { value: 13, label: "Bottom", type: "fix" },
];

const HORIZONTAL_OPTIONS: { value: number; label: string; type: "swing" | "fix" }[] = [
  { value: 0, label: "Off", type: "swing" },
  { value: 1, label: "Full", type: "swing" },
  { value: 2, label: "Left", type: "swing" },
  { value: 3, label: "Mid", type: "swing" },
  { value: 4, label: "Right", type: "swing" },
  { value: 9, label: "L", type: "fix" },
  { value: 10, label: "CL", type: "fix" },
  { value: 11, label: "M", type: "fix" },
  { value: 12, label: "CR", type: "fix" },
  { value: 13, label: "R", type: "fix" },
];

function VerticalIcon({ value }: { value: number }) {
  switch (value) {
    case 0: return <X className="w-3.5 h-3.5" />;
    case 1: return <ChevronsUpDown className="w-3.5 h-3.5" />;
    case 2: return <ChevronUp className="w-3.5 h-3.5" />;
    case 3: return <ChevronDown className="w-3.5 h-3.5" />;
    default: return <FixedPositionDot axis="vertical" position={value} />;
  }
}

function HorizontalIcon({ value }: { value: number }) {
  switch (value) {
    case 0: return <X className="w-3.5 h-3.5" />;
    case 1: return <ChevronsLeftRight className="w-3.5 h-3.5" />;
    case 2: return <ChevronLeft className="w-3.5 h-3.5" />;
    case 3: return <Minus className="w-3.5 h-3.5" />;
    case 4: return <ChevronRight className="w-3.5 h-3.5" />;
    default: return <FixedPositionDot axis="horizontal" position={value} />;
  }
}

function FixedPositionDot({ axis, position }: { axis: "vertical" | "horizontal"; position: number }) {
  const idx = position - 9; // 0-4
  if (axis === "vertical") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14">
        <line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity={0.3} />
        <circle cx="7" cy={1 + idx * 3} r="2" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity={0.3} />
      <circle cx={1 + idx * 3} cy="7" r="2" fill="currentColor" />
    </svg>
  );
}

function SwingSelector({ label, value, onChange, axis, colors }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  axis: "vertical" | "horizontal";
  colors: { border: string; bg: string; text: string };
}) {
  const options = axis === "vertical" ? VERTICAL_OPTIONS : HORIZONTAL_OPTIONS;
  const swingOpts = options.filter(o => o.type === "swing");
  const fixOpts = options.filter(o => o.type === "fix");
  const IconComponent = axis === "vertical" ? VerticalIcon : HorizontalIcon;

  return (
    <div>
      <span className="text-[0.65rem] text-dim uppercase tracking-wider mb-1.5 block">{label}</span>
      <div className="flex gap-1 flex-wrap">
        {swingOpts.map((o) => (
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
        ))}
        <div className="w-px bg-white/10 mx-0.5 self-stretch" />
        {fixOpts.map((o) => (
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
        ))}
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
