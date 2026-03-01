import { Settings } from "lucide-react";
import { useClock } from "@/hooks/use-clock";
import { StatusPill } from "./status-pill";

interface HeaderProps {
  weatherTs: string | null | undefined;
  airTs: string | null | undefined;
  onOpenSettings: () => void;
}

export function Header({ weatherTs, airTs, onOpenSettings }: HeaderProps) {
  const { formatTime, getAgo } = useClock();
  const weatherAgo = getAgo(weatherTs);
  const airAgo = getAgo(airTs);

  return (
    <header className="flex justify-between items-center px-5 py-2.5 border-b border-card-border">
      <div>
        <span className="font-mono text-[0.85rem] text-text">{formatTime()}</span>
      </div>
      <div className="flex gap-4 items-center">
        <StatusPill label="Weather" status={weatherAgo.status} text={weatherAgo.text} />
        <StatusPill label="Air" status={airAgo.status} text={airAgo.text} />
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
