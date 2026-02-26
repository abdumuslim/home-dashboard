import type { TimeRange } from "@/types/api";
import { cn } from "@/lib/utils";

const ranges: { value: TimeRange; label: string }[] = [
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "48h", label: "48h" },
  { value: "1w", label: "1W" },
  { value: "30d", label: "30D" },
];

interface RangeSelectorProps {
  current: TimeRange;
  onChange: (range: TimeRange) => void;
}

export function RangeSelector({ current, onChange }: RangeSelectorProps) {
  return (
    <div className="flex justify-center mb-4">
      <div className="flex gap-1 bg-card-bg border border-card-border rounded-[10px] p-1">
        {ranges.map((r) => (
          <button
            key={r.value}
            onClick={() => onChange(r.value)}
            className={cn(
              "bg-transparent border-none text-dim font-medium text-[0.78rem] leading-none",
              "px-3.5 py-2 rounded-[8px] cursor-pointer transition-all duration-150",
              "hover:text-text font-[Inter,sans-serif]",
              current === r.value && "bg-cyan text-[#111]"
            )}
          >
            {r.label}
          </button>
        ))}
      </div>
    </div>
  );
}
