import type { ReactNode } from "react";

export function ChartContainer({ children }: { children: ReactNode }) {
  return (
    <div className="bg-card-bg border border-card-border rounded-[12px] px-4 py-3 h-[270px] max-md:h-[220px]">
      {children}
    </div>
  );
}
