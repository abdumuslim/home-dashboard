import { useState } from "react";
import { Power, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PurifierDevice } from "@/types/automations";

interface PurifierCardProps {
  device: PurifierDevice;
  onControl: (command: string, params: unknown[]) => Promise<void>;
}

function Toggle({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => onChange(!value)}
      disabled={disabled}
      className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-40"
    >
      <span className="text-xs text-dim">{label}</span>
      <span className={cn("w-7 h-3.5 rounded-full relative transition-colors", value ? "bg-cyan/30" : "bg-white/10")}>
        <span className={cn("absolute top-0.5 w-2.5 h-2.5 rounded-full transition-all", value ? "left-3.5 bg-cyan" : "left-0.5 bg-dim")} />
      </span>
    </button>
  );
}

export function PurifierCard({ device: d, onControl }: PurifierCardProps) {
  const [busy, setBusy] = useState<string | null>(null);

  const send = async (command: string, params: unknown[]) => {
    setBusy(command);
    try { await onControl(command, params); } finally { setBusy(null); }
  };

  const isOn = d.power === "on";
  const offline = !d.isOnline;

  return (
    <div className={cn("glass-card p-4 flex flex-col gap-3", offline && "opacity-50")}>
      {/* Header: name + power */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={cn("w-2 h-2 rounded-full", offline ? "bg-dim" : isOn ? "bg-cyan" : "bg-emerald-400")} />
          <span className="text-[0.95rem] font-medium text-text">{d.name}</span>
          <span className="text-xs text-dim">{offline ? "offline" : isOn ? "on" : "off"}</span>
        </div>
        <button
          onClick={() => send("set_power", [isOn ? "off" : "on"])}
          disabled={offline || busy !== null}
          className={cn(
            "p-2 rounded-lg transition-colors",
            isOn ? "bg-cyan/20 text-cyan hover:bg-cyan/30" : "bg-white/5 text-dim hover:bg-white/10",
            (offline || busy !== null) && "opacity-40 cursor-not-allowed",
          )}
        >
          {busy === "set_power" ? <Loader2 className="w-5 h-5 animate-spin" /> : <Power className="w-5 h-5" />}
        </button>
      </div>

      {/* Status row */}
      {d.isOnline && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-dim">
          {d.aqi != null && <span>AQI <span className="text-text font-medium">{d.aqi}</span></span>}
          {d.temperature != null && <span>{d.temperature.toFixed(1)}°C</span>}
          {d.humidity != null && <span>{d.humidity}%</span>}
          {d.filter_life != null && <span>Filter <span className="text-text font-medium">{d.filter_life}%</span></span>}
        </div>
      )}

      {/* Controls (when on) */}
      {isOn && !offline && (
        <>
          {/* Mode selector */}
          <div>
            <span className="text-xs text-dim mb-1 block">Mode</span>
            <div className="flex gap-1.5">
              {(["auto", "silent", "favorite"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => send("set_mode", [m])}
                  disabled={busy !== null}
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
          </div>

          {/* Fan level (only in favorite mode) */}
          {d.mode === "favorite" && (
            <div>
              <span className="text-xs text-dim mb-1 block">
                Fan Level <span className="text-text font-medium">{d.favorite_level ?? 0}</span>
              </span>
              <input
                type="range"
                min={0}
                max={16}
                value={d.favorite_level ?? 0}
                onChange={(e) => send("set_level_favorite", [parseInt(e.target.value, 10)])}
                disabled={busy !== null}
                className="w-full accent-cyan h-1.5"
              />
            </div>
          )}

          {/* Toggles */}
          <div className="grid grid-cols-3 gap-1.5">
            <Toggle label="LED" value={d.led ?? false} onChange={(v) => send("set_led", [v ? "on" : "off"])} disabled={busy !== null} />
            <Toggle label="Buzzer" value={d.buzzer ?? false} onChange={(v) => send("set_buzzer", [v ? "on" : "off"])} disabled={busy !== null} />
            <Toggle label="Lock" value={d.child_lock ?? false} onChange={(v) => send("set_child_lock", [v ? "on" : "off"])} disabled={busy !== null} />
          </div>
        </>
      )}
    </div>
  );
}
