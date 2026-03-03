import { Bell, Settings } from "lucide-react";
import { useClock } from "@/hooks/use-clock";
import { StatusPill } from "./status-pill";

interface HeaderProps {
  weatherTs: string | null | undefined;
  airTs: string | null | undefined;
  onOpenSettings: () => void;
  onOpenAlerts: () => void;
  alertsActive: boolean;
}

export function Header({ weatherTs, airTs, onOpenSettings, onOpenAlerts, alertsActive }: HeaderProps) {
  const { formatTime, formatDate, getAgo } = useClock();
  const weatherAgo = getAgo(weatherTs);
  const airAgo = getAgo(airTs);

  return (
    <header className="flex flex-wrap justify-between items-center px-5 py-2.5 border-b border-card-border gap-y-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[0.85rem] text-text">{formatTime()}</span>
        <span className="text-[0.8rem] text-dim">{formatDate()}</span>
      </div>
      <div className="flex gap-4 items-center">
        <StatusPill label="Weather" status={weatherAgo.status} text={weatherAgo.text} />
        <StatusPill label="Air" status={airAgo.status} text={airAgo.text} />
        <button
          onClick={onOpenAlerts}
          className="p-1.5 rounded-lg text-dim hover:text-white hover:bg-white/10 transition-colors relative"
          title="Alerts"
        >
          <Bell className="w-4 h-4" />
          {alertsActive && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-cyan rounded-full" />
          )}
        </button>
        <button
          onClick={onOpenSettings}
          className="p-1.5 rounded-lg text-dim hover:text-white hover:bg-white/10 transition-colors"
          title="Unit Settings"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
