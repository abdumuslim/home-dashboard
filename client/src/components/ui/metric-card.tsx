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
        "bg-card-bg border border-card-border rounded-[12px] px-4 py-3",
        "flex flex-col min-h-[150px] h-full",
        "transition-[border-color] duration-300",
        "hover:border-card-hover",
        flash && "animate-card-flash",
        level && levelBorders[level],
        className
      )}
    >
      {children}
    </div>
  );
}
