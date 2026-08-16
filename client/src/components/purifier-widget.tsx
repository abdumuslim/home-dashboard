import { useState } from "react";
import { Power, Fan, Settings, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { getStatus } from "@/constants/thresholds";
import { PurifierDetailOverlay } from "@/components/ui/purifier-detail-overlay";
import type { PurifierDevice } from "@/types/automations";

const STATUS_COLORS: Record<string, string> = {
  excellent: "#0df41e", good: "#1bd929", normal: "#0df41e", low: "#0df41e",
  moderate: "#fbbf24", slightly_high: "#fbbf24",
  poor: "#f97316", high: "#f97316",
  very_high: "#9f1239", severe: "#ef4444", extreme: "#9333ea",
};

export interface PurifierWidgetProps {
  device: PurifierDevice;
  onControl: (command: string, params: unknown[]) => Promise<void>;
  label?: string;
}

export function PurifierWidget({ device, onControl, label }: PurifierWidgetProps) {
  const [showDetail, setShowDetail] = useState(false);
  const [powerBusy, setPowerBusy] = useState(false);

  const isOn = device.power === "on";
  const offline = !device.isOnline;
  const filterLow = device.filter_life != null && device.filter_life <= 20;

  const handlePowerToggle = async () => {
    if (offline || powerBusy) return;
    setPowerBusy(true);
    try { await onControl("set_power", [isOn ? "off" : "on"]); } finally { setPowerBusy(false); }
  };

  return (
    <>
      <div className={cn(
        "flex w-full min-w-0 flex-col items-center bg-[#171920]/90 border border-white/[0.05] p-1 rounded-2xl shadow-[0_4px_12px_-4px_rgba(0,0,0,0.5)] backdrop-blur-xl transition-all self-start",
        offline ? "opacity-40" : "hover:border-white/10 hover:bg-[#1a1c23]/95"
      )}>
        <span className="text-[0.65rem] text-text/70 font-bold tracking-wider mt-0.5 mb-0.5">
          {label ?? "Purifier"}
        </span>

        <div className="flex items-center gap-1">
          <button
            onClick={handlePowerToggle}
            disabled={offline || powerBusy}
            className={cn(
              "relative flex items-center justify-center w-7 h-7 rounded-full transition-all shrink-0",
              isOn
                ? "bg-emerald-500 text-black hover:bg-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.3)]"
                : "bg-white/[0.03] text-dim hover:bg-white/10 hover:text-white",
              (offline || powerBusy) && "cursor-not-allowed",
            )}
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
            title="Purifier settings"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>

        <div className="h-[1px] w-3/4 bg-white/[0.08] my-1" />

        {(() => {
          const aqiStatus = device.isOnline && device.aqi != null ? getStatus("pm25", device.aqi) : null;
          if (!aqiStatus) return null;
          const aqiColor = aqiStatus.level ? STATUS_COLORS[aqiStatus.level] : undefined;
          return (
            <div
              className={cn(
                "flex h-7 w-full min-w-0 items-center justify-center gap-0.5 px-1 py-1.5 rounded-full transition-colors",
                isOn ? "shadow-inner" : "bg-white/[0.03]"
              )}
              style={isOn ? { backgroundColor: aqiColor ? `${aqiColor}15` : "rgba(16,185,129,0.15)", color: aqiColor || "#34d399" } : undefined}
            >
              <Fan className={cn("w-3 h-3 shrink-0", isOn && "animate-[spin_3s_linear_infinite]")} />
              <span className="flex min-w-0 items-baseline gap-0.5 text-[0.65rem] font-bold tracking-wide text-text">
                {device.aqi} <span className="text-[0.48rem] font-bold uppercase text-dim">AQI</span>
              </span>
              {device.filter_life != null && (
                <span
                  className="shrink-0 text-[0.52rem] font-bold tabular-nums"
                  style={{ color: filterLow ? "#f87171" : "#34d399" }}
                  title={`Filter: ${device.filter_life}%`}
                >
                  {device.filter_life}%
                </span>
              )}
            </div>
          );
        })()}
      </div>

      {showDetail && (
        <PurifierDetailOverlay device={device} onControl={onControl} onClose={() => setShowDetail(false)} />
      )}
    </>
  );
}
