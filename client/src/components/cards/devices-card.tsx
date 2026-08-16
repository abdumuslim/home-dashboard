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
        <section className="min-w-0">
          <div className="flex flex-col items-center gap-2">
            {purifiers.map((p) => (
              <PurifierWidget key={p.device.id} device={p.device} label={p.label} onControl={p.onControl} />
            ))}
          </div>
        </section>
      </div>
    </MetricCard>
  );
});
