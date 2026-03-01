import type { PrayerInfo, ProximityLevel } from "@/hooks/use-prayer-times";

const PROXIMITY_COLORS: Record<ProximityLevel, string> = {
  safe: "#4caf50",
  warning: "#ffc107",
  urgent: "#ff9800",
  critical: "#ff5252",
  imminent: "#c62828",
};

export function PrayerCard({ prayer }: { prayer: PrayerInfo }) {
  const { isPassed, isNext, proximity, formattedTime, countdown, label } = prayer;

  const accentColor = isPassed
    ? "#7a8ba8"
    : proximity
      ? PROXIMITY_COLORS[proximity]
      : "#4caf50";

  return (
    <div
      className={[
        "glass-card px-4 py-3 flex flex-col items-center justify-center",
        "min-h-[140px] relative overflow-hidden transition-all duration-300",
        isPassed ? "opacity-50" : "",
        isNext ? "ring-1" : "",
        isNext && proximity === "imminent" ? "animate-prayer-blink" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        isNext
          ? {
              "--tw-ring-color": accentColor,
              borderColor: accentColor,
              boxShadow: `0 0 12px ${accentColor}33`,
            } as React.CSSProperties
          : undefined
      }
    >
      <h3 className="text-[0.85rem] font-medium text-dim tracking-wide uppercase mb-2">
        {label}
      </h3>

      <span
        className="text-2xl font-semibold leading-none tracking-tight mb-2"
        style={{ color: isPassed ? "#7a8ba8" : "#e0e0e0" }}
      >
        {formattedTime}
      </span>

      <span className="text-sm font-medium" style={{ color: accentColor }}>
        {isPassed ? "Passed" : countdown}
      </span>
    </div>
  );
}
