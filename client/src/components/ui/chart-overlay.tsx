import { useState, useEffect, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHistoryData } from "@/hooks/use-history-data";
import type { TimeRange, WeatherReading, AirReading } from "@/types/api";

const RANGES: TimeRange[] = ["6h", "24h", "48h", "1w", "30d"];

interface ChartOverlayProps {
  title: string;
  renderExpanded: (range: TimeRange, weatherHistory: WeatherReading[], airHistory: AirReading[]) => ReactNode;
  onClose: () => void;
}

export function ChartOverlay({ title, renderExpanded, onClose }: ChartOverlayProps) {
  const [range, setRange] = useState<TimeRange>("24h");
  const [phase, setPhase] = useState<"in" | "out">("in");
  const { weatherHistory, airHistory } = useHistoryData(range, true);

  const handleClose = useCallback(() => {
    setPhase("out");
    setTimeout(onClose, 150);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  // Prevent body scroll while overlay is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-overlay-in"
      style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className={cn(
          "glass-card flex flex-col w-[95vw] max-w-5xl h-[30vh]",
          phase === "in" ? "animate-panel-in" : "animate-panel-out"
        )}
      >
        {/* Header */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center px-5 py-3 border-b border-white/10 shrink-0">
          <h2 className="text-base font-medium text-text">{title}</h2>

          <div className="flex items-center gap-1">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={cn(
                  "px-3 py-1 rounded-full text-xs font-medium transition-colors",
                  r === range
                    ? "bg-cyan/20 text-cyan"
                    : "text-dim hover:text-text hover:bg-white/5"
                )}
              >
                {r}
              </button>
            ))}
          </div>

          <button
            onClick={handleClose}
            className="p-1 rounded-lg text-dim hover:text-white hover:bg-white/10 transition-colors justify-self-end"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Chart area — h-0 + flex-1 forces it to fill remaining space */}
        <div className="flex-1 h-0 p-5">
          {renderExpanded(range, weatherHistory, airHistory)}
        </div>
      </div>
    </div>,
    document.body
  );
}
