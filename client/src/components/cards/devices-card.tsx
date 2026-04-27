import { memo } from "react";
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

interface DevicesCardProps {
  acs: AcEntry[];
  purifiers: PurifierEntry[];
}

export const DevicesCard = memo(function DevicesCard({ acs, purifiers }: DevicesCardProps) {
  return (
    <MetricCard className="p-3 flex flex-col justify-center gap-2 col-span-2 md:col-span-1">
      {acs.length > 0 && (
        <div className="flex items-start justify-center gap-3">
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
      )}

      {acs.length > 0 && purifiers.length > 0 && (
        <div className="h-[1px] w-full bg-white/[0.05]" />
      )}

      {purifiers.length > 0 && (
        <div className="flex items-start justify-center gap-3 flex-wrap">
          {purifiers.map((p) => (
            <PurifierWidget key={p.device.id} device={p.device} label={p.label} onControl={p.onControl} />
          ))}
        </div>
      )}
    </MetricCard>
  );
});
