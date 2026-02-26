import { useClock } from "@/hooks/use-clock";
import { StatusPill } from "./status-pill";

interface HeaderProps {
  weatherTs: string | null | undefined;
  airTs: string | null | undefined;
}

export function Header({ weatherTs, airTs }: HeaderProps) {
  const { formatTime, getAgo } = useClock();
  const weatherAgo = getAgo(weatherTs);
  const airAgo = getAgo(airTs);

  return (
    <header className="flex justify-between items-center px-5 py-2.5 border-b border-card-border">
      <div>
        <span className="font-mono text-[0.85rem] text-text">{formatTime()}</span>
      </div>
      <div className="flex gap-4 items-center">
        <StatusPill status={weatherAgo.status} text={weatherAgo.text} />
        <StatusPill status={airAgo.status} text={airAgo.text} />
      </div>
    </header>
  );
}
