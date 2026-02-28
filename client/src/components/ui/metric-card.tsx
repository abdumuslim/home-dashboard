import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { StatusLevel } from "@/types/api";

interface MetricCardProps {
  id?: string;
  children: ReactNode;
  flash?: boolean;
  level?: StatusLevel | null;
  className?: string;
}

const levelBorders: Record<string, string> = {
  good: "border-green",
  moderate: "border-yellow",
  poor: "border-red",
};

export function MetricCard({ id, children, flash, level, className }: MetricCardProps) {
  return (
    <div
      id={id}
      className={cn(
        "glass-card px-4 py-3 text-white",
        "flex flex-col min-h-[220px] h-full relative overflow-hidden",
        "transition-[border-color] duration-300",
        flash && "animate-card-flash",
        level && levelBorders[level],
        className
      )}
    >
      {children}
    </div>
  );
}
