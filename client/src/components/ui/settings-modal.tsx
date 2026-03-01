import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUnits } from "@/hooks/use-units";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { UNIT_OPTIONS, type UnitPreferences } from "@/constants/units";

const NOTIFICATION_BREAKPOINTS = [
  { value: 15, label: "15 min" },
  { value: 7, label: "7 min" },
  { value: 4, label: "4 min" },
  { value: 2, label: "2 min" },
  { value: 0, label: "At time" },
];

interface SettingsModalProps {
  onClose: () => void;
}

const SECTIONS: { key: keyof typeof UNIT_OPTIONS; label: string }[] = [
  { key: "temperature", label: "Temperature" },
  { key: "pressure", label: "Barometer" },
  { key: "windSpeed", label: "Wind Speed" },
  { key: "rainfall", label: "Rainfall" },
  { key: "solar", label: "Solar Radiation" },
];

export function SettingsModal({ onClose }: SettingsModalProps) {
  const { units, setUnits } = useUnits();
  const { isSupported, isSubscribed, breakpoints, setBreakpoints } = usePushNotifications();
  const [draft, setDraft] = useState<UnitPreferences>({ ...units });
  const [phase, setPhase] = useState<"in" | "out">("in");

  const handleClose = useCallback(() => {
    setPhase("out");
    setTimeout(onClose, 150);
  }, [onClose]);

  const handleChange = (key: keyof UnitPreferences, value: string) => {
    const next = { ...draft, [key]: value } as UnitPreferences;
    setDraft(next);
    setUnits(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") handleClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

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
          "glass-card flex flex-col w-[420px] max-w-[95vw]",
          phase === "in" ? "animate-panel-in" : "animate-panel-out",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
          <h2 className="text-base font-medium text-text">Settings</h2>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg text-dim hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Units */}
        <div className="px-5 py-4 flex flex-col gap-4">
          <h3 className="text-xs font-medium tracking-wider text-dim uppercase">Units</h3>
          {SECTIONS.map(({ key, label }) => (
            <div key={key} className="flex items-center justify-between border-b border-white/5 pb-3 last:border-0 last:pb-0">
              <span className="text-sm text-text">{label}</span>
              <div className="flex gap-3">
                {UNIT_OPTIONS[key].map((opt) => (
                  <label key={opt.value} className="flex items-center gap-1.5 cursor-pointer text-sm text-dim">
                    <span
                      className={cn(
                        "w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center transition-colors",
                        draft[key] === opt.value ? "border-green-400" : "border-dim",
                      )}
                    >
                      {draft[key] === opt.value && (
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                      )}
                    </span>
                    <input
                      type="radio"
                      name={key}
                      value={opt.value}
                      checked={draft[key] === opt.value}
                      onChange={() => handleChange(key, opt.value)}
                      className="sr-only"
                    />
                    <span className={draft[key] === opt.value ? "text-text" : ""}>{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Prayer Notifications */}
        {isSupported && isSubscribed && (
          <div className="px-5 py-4 flex flex-col gap-3 border-t border-white/10">
            <h3 className="text-xs font-medium tracking-wider text-dim uppercase">Prayer Notifications</h3>
            <div className="flex flex-wrap gap-3">
              {NOTIFICATION_BREAKPOINTS.map(({ value, label }) => {
                const checked = breakpoints.includes(value);
                return (
                  <label key={value} className="flex items-center gap-1.5 cursor-pointer text-sm text-dim">
                    <span
                      className={cn(
                        "w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors",
                        checked ? "border-green-400 bg-green-400/20" : "border-dim",
                      )}
                    >
                      {checked && <span className="text-green-400 text-[10px] leading-none">&#10003;</span>}
                    </span>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = checked
                          ? breakpoints.filter((b) => b !== value)
                          : [...breakpoints, value].sort((a, b) => b - a);
                        setBreakpoints(next);
                      }}
                      className="sr-only"
                    />
                    <span className={checked ? "text-text" : ""}>{label}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
