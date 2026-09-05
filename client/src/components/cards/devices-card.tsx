import { memo } from "react";
import { CloudOff } from "lucide-react";
import { MetricCard } from "@/components/ui/metric-card";
import { AcWidget, type AcTimerData } from "@/components/ac-widget";
import { PurifierWidget } from "@/components/purifier-widget";
import type { AcDevice } from "@/types/ac";
import type { PurifierDevice } from "@/types/automations";

export interface AcEntry {
  device: AcDevice;
  label: string;
  onControl: (cmd: string, val: unknown) => Promise<void>;
  timer: AcTimerData | null;
  onSetTimer: (action: "on" | "off", minutes: number, preset?: Record<string, unknown>) => Promise<void>;
  onCancelTimer: () => Promise<void>;
}

export interface PurifierEntry {
  device: PurifierDevice;
  label: string;
  onControl: (cmd: string, params: unknown[]) => Promise<void>;
}

/** live = cloud reachable · stale = last-known readings while it is not · unavailable = nothing to show */
export type PurifierStatus = "live" | "stale" | "unavailable";

interface DevicesCardProps {
  acs: AcEntry[];
  purifiers: PurifierEntry[];
  purifierStatus?: PurifierStatus;
  purifierError?: string;
}

export const DevicesCard = memo(function DevicesCard({ acs, purifiers, purifierStatus = "live", purifierError }: DevicesCardProps) {
  const outageTitle = purifierError
    ? `Xiaomi Cloud unreachable: ${purifierError}`
    : "Xiaomi Cloud unreachable";
  return (
    <MetricCard className="p-3 col-span-2 md:col-span-1 overflow-hidden">
      <div className="grid grid-cols-[minmax(0,1fr)_1px_minmax(4.25rem,0.58fr)] gap-2.5 items-start">
        <section className="min-w-0">
          <div className="grid grid-cols-2 gap-2 place-items-center">
            {acs.map((ac) => (
              <AcWidget
                key={ac.device.id}
                device={ac.device}
                label={ac.label}
                onControl={ac.onControl}
                timer={ac.timer}
                onSetTimer={ac.onSetTimer}
                onCancelTimer={ac.onCancelTimer}
              />
            ))}
          </div>
        </section>
        <div className="h-full min-h-28 bg-white/[0.06]" />
        {/* Reserved grid track: leaving it empty during an outage reads as a layout glitch */}
        <section className="min-w-0">
          {purifierStatus === "unavailable" ? (
            <div
              className="flex w-full min-w-0 flex-col items-center gap-0.5 rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] px-1 py-2 shadow-[0_4px_12px_-4px_rgba(0,0,0,0.5)]"
              title={outageTitle}
            >
              <CloudOff className="w-4 h-4 text-amber-400" />
              <span className="text-[0.6rem] font-bold tracking-wide text-text/70 leading-tight">Purifiers</span>
              <span className="text-[0.55rem] font-bold tracking-wide text-amber-400 leading-tight">Unavailable</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              {purifierStatus === "stale" && (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-amber-400/15 px-2 py-0.5 text-[0.55rem] font-bold tracking-wide text-amber-400"
                  title={`${outageTitle}. Showing last-known readings`}
                >
                  <CloudOff className="w-2.5 h-2.5 shrink-0" /> Stale
                </span>
              )}
              {purifiers.map((p) => (
                <PurifierWidget key={p.device.id} device={p.device} label={p.label} onControl={p.onControl} />
              ))}
            </div>
          )}
        </section>
      </div>
    </MetricCard>
  );
});
