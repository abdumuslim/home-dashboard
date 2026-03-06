import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useChartsVisible } from "@/hooks/use-charts-visible";
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
  const { chartsVisible } = useChartsVisible();
  return (
    <div
      id={id}
      className={cn(
        "glass-card px-4 py-3 text-white",
        "flex flex-col h-full relative overflow-hidden",
        chartsVisible ? "min-h-[220px]" : "min-h-0",
        "transition-[min-height,border-color] duration-300",
        flash && "animate-card-flash",
        level && levelBorders[level],
        className
      )}
    >
      {children}
    </div>
  );
}
