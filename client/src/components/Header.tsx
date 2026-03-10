import { Bell, Settings, LogOut } from "lucide-react";
import { useClock } from "@/hooks/use-clock";
import { useChartsVisible } from "@/hooks/use-charts-visible";
import { StatusPill } from "./status-pill";

interface HeaderProps {
  weatherTs: string | null | undefined;
  airTs: string | null | undefined;
  onOpenSettings: () => void;
  onOpenAlerts: () => void;
  alertsActive: boolean;
  isAdmin: boolean;
  onLoginClick: () => void;
  onLogout: () => void;
}

export function Header({ weatherTs, airTs, onOpenSettings, onOpenAlerts, alertsActive, isAdmin, onLoginClick, onLogout }: HeaderProps) {
  const { formatTime, formatDate, getAgo } = useClock();
  const { chartsVisible, toggleCharts } = useChartsVisible();
  const weatherAgo = getAgo(weatherTs);
  const airAgo = getAgo(airTs);

  return (
    <header className="flex flex-wrap items-center justify-between px-5 py-2 border-b border-card-border gap-y-1">
      {/* Left: time + date */}
      <div className="flex items-center gap-2">
        <span className="font-mono text-[0.85rem] text-text">{formatTime()}</span>
        <span className="text-[0.8rem] text-dim">{formatDate()}</span>
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-3">
        {/* Status pills inline on sm+ */}
        <div className="hidden sm:flex gap-4 items-center">
          <StatusPill label="Weather" status={weatherAgo.status} text={weatherAgo.text} />
          <StatusPill label="Air" status={airAgo.status} text={airAgo.text} />
        </div>
        <button
          onClick={toggleCharts}
          className="flex items-center gap-1.5 text-[0.75rem] text-dim hover:text-white transition-colors"
          title={chartsVisible ? "Hide charts" : "Show charts"}
        >
          <span>Charts</span>
          <div className={`relative w-7 h-4 rounded-full transition-colors duration-200 ${chartsVisible ? "bg-cyan/80" : "bg-white/15"}`}>
            <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-[left] duration-200 ${chartsVisible ? "left-3.5" : "left-0.5"}`} />
          </div>
        </button>
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
        {isAdmin ? (
          <button
            onClick={onLogout}
            className="p-1.5 rounded-lg text-cyan hover:text-white hover:bg-white/10 transition-colors"
            title="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={onLoginClick}
            className="px-3 py-1 rounded-full text-[0.7rem] font-medium tracking-wide bg-cyan/15 text-cyan hover:bg-cyan/25 transition-colors"
          >
            Login
          </button>
        )}
      </div>

      {/* Mobile-only status row */}
      <div className="flex sm:hidden gap-4 items-center w-full">
        <StatusPill label="Weather" status={weatherAgo.status} text={weatherAgo.text} />
        <StatusPill label="Air" status={airAgo.status} text={airAgo.text} />
      </div>
    </header>
  );
}
