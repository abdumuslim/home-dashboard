import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const iconBgClasses: Record<string, string> = {
  cyan: "bg-cyan",
  blue: "bg-blue",
  yellow: "bg-yellow",
  orange: "bg-orange",
  red: "bg-red",
  green: "bg-green",
  purple: "bg-purple",
};

interface CardTopProps {
  icon: ReactNode;
  iconColor: string;
  title: string | ReactNode;
}

export function CardTop({ icon, iconColor, title }: CardTopProps) {
  return (
    <div className="relative flex justify-center items-center mb-1">
      <span className="text-sm font-normal text-text">{title}</span>
      <div
        className={cn(
          "absolute right-0 top-0 w-6 h-6 rounded-full shrink-0 flex items-center justify-center",
          iconBgClasses[iconColor] || iconBgClasses.cyan
        )}
      >
        <div className="w-3 h-3 text-white">{icon}</div>
      </div>
    </div>
  );
}
