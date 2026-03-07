import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, Power } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PurifierDevice } from "@/types/automations";

const MIOT_MODELS = [
  "zhimi.airpurifier.mb3", "zhimi.airpurifier.mb4", "zhimi.airpurifier.mb5",
  "zhimi.airpurifier.vb2", "zhimi.airpurifier.va2", "zhimi.airpurifier.rma1",
];

function Toggle({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => onChange(!value)}
      disabled={disabled}
      className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-40"
    >
      <span className="text-xs text-dim">{label}</span>
      <span className={cn("w-7 h-3.5 rounded-full relative transition-colors", value ? "bg-cyan/30" : "bg-white/10")}>
        <span className={cn("absolute top-0.5 w-2.5 h-2.5 rounded-full transition-all", value ? "left-3.5 bg-cyan" : "left-0.5 bg-dim")} />
      </span>
    </button>
  );
}

interface PurifierDetailOverlayProps {
  device: PurifierDevice;
  onControl: (command: string, params: unknown[]) => Promise<void>;
  onClose: () => void;
}

export function PurifierDetailOverlay({ device: d, onControl, onClose }: PurifierDetailOverlayProps) {
  const [phase, setPhase] = useState<"in" | "out">("in");

  const isMiot = MIOT_MODELS.includes(d.model);
  const isOn = d.power === "on";
  const offline = !d.isOnline;

  const handleClose = useCallback(() => {
    setPhase("out");
    setTimeout(onClose, 150);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") handleClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  const send = (command: string, params: unknown[]) => {
    onControl(command, params).catch(() => {});
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
            <span className={cn("w-2 h-2 rounded-full", offline ? "bg-dim" : isOn ? "bg-cyan" : "bg-emerald-400")} />
            <h2 className="text-base font-medium text-text">{d.name}</h2>
            <span className="text-xs text-dim">{offline ? "offline" : isOn ? "on" : "off"}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => send("set_power", [isOn ? "off" : "on"])}
              disabled={offline}
              className={cn(
                "p-2 rounded-lg transition-colors",
                isOn ? "bg-cyan/20 text-cyan hover:bg-cyan/30" : "bg-white/5 text-dim hover:bg-white/10",
                offline && "opacity-40 cursor-not-allowed",
              )}
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
          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-3">
            {d.aqi != null && (
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-dim">AQI (PM2.5)</span>
                <span className="text-lg font-semibold text-text">{d.aqi} <span className="text-xs text-dim">µg/m³</span></span>
              </div>
            )}
            {d.temperature != null && (
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-dim">Temperature</span>
                <span className="text-lg font-semibold text-text">{d.temperature.toFixed(1)}<span className="text-xs text-dim">°C</span></span>
              </div>
            )}
            {d.humidity != null && (
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-dim">Humidity</span>
                <span className="text-lg font-semibold text-text">{d.humidity}<span className="text-xs text-dim">%</span></span>
              </div>
            )}
            {d.filter_life != null && (
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-dim">Filter Life</span>
                <span className="text-lg font-semibold text-text">{d.filter_life}<span className="text-xs text-dim">%</span></span>
              </div>
            )}
          </div>

          {/* Controls (when on + online) */}
          {isOn && !offline && (
            <>
              {/* Mode selector */}
              <div>
                <span className="text-xs text-dim mb-1.5 block">Mode</span>
                {isMiot ? (
                  <div className="grid grid-cols-3 gap-1.5">
                    {([
                      { key: "auto", label: "Auto", active: d.mode === "auto" },
                      { key: "silent", label: "Sleep", active: d.mode === "silent" },
                      { key: "fan-1", label: "Fan 1", active: d.mode === "fan" && d.fan_level === 1 },
                      { key: "fan-2", label: "Fan 2", active: d.mode === "fan" && d.fan_level === 2 },
                      { key: "fan-3", label: "Fan 3", active: d.mode === "fan" && d.fan_level === 3 },
                      { key: "favorite", label: "Favorite", active: d.mode === "favorite" },
                    ] as const).map((m) => (
                      <button
                        key={m.key}
                        onClick={() => {
                          if (m.key === "auto" || m.key === "silent" || m.key === "favorite") {
                            send("set_mode", [m.key]);
                          } else {
                            const level = parseInt(m.key.split("-")[1], 10);
                            if (d.mode !== "fan") send("set_mode", ["fan"]);
                            send("set_fan_level", [level]);
                          }
                        }}
                        className={cn(
                          "px-2 py-1.5 rounded-lg text-xs border transition-colors",
                          m.active
                            ? "border-cyan/50 bg-cyan/10 text-cyan"
                            : "border-white/10 bg-white/5 text-dim hover:text-text hover:border-white/20",
                        )}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="flex gap-1.5">
                    {(["auto", "silent", "favorite"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => send("set_mode", [m])}
                        className={cn(
                          "flex-1 px-2 py-1.5 rounded-lg text-xs border transition-colors",
                          d.mode === m
                            ? "border-cyan/50 bg-cyan/10 text-cyan"
                            : "border-white/10 bg-white/5 text-dim hover:text-text hover:border-white/20",
                        )}
                      >
                        {m === "auto" ? "Auto" : m === "silent" ? "Silent" : "Favorite"}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Favorite level slider */}
              {d.mode === "favorite" && (
                <div>
                  <span className="text-xs text-dim mb-1.5 block">
                    Favorite Level <span className="text-text font-medium">{d.favorite_level ?? 0}</span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={isMiot ? 9 : 16}
                    value={d.favorite_level ?? 0}
                    onChange={(e) => send("set_level_favorite", [parseInt(e.target.value, 10)])}
                    className="w-full accent-cyan h-1.5"
                  />
                </div>
              )}

              {/* Toggles */}
              <div className="grid grid-cols-3 gap-1.5">
                <Toggle label="LED" value={d.led ?? false} onChange={(v) => send("set_led", [v ? "on" : "off"])} />
                <Toggle label="Buzzer" value={d.buzzer ?? false} onChange={(v) => send("set_buzzer", [v ? "on" : "off"])} />
                <Toggle label="Lock" value={d.child_lock ?? false} onChange={(v) => send("set_child_lock", [v ? "on" : "off"])} />
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
