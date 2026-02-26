import { cn } from "@/lib/utils";

const dotColors = {
  online: "bg-green",
  stale: "bg-yellow",
  offline: "bg-red",
} as const;

interface StatusPillProps {
  status: "online" | "stale" | "offline";
  text: string;
}

export function StatusPill({ status, text }: StatusPillProps) {
  return (
    <div className="flex items-center gap-1.5 text-[0.75rem] text-dim">
      <span className={cn("w-[7px] h-[7px] rounded-full", dotColors[status])} />
      <span>{text}</span>
    </div>
  );
}
