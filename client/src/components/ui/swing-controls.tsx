import { X, ChevronUp, ChevronDown, ChevronsUpDown, ChevronsLeftRight, ChevronLeft, ChevronRight, Minus } from "lucide-react";

// ---------- Swing options (TCL vertical/horizontal direction encoding) ----------

export interface SwingOption {
  value: number;
  label: string;
  type: "swing" | "fix";
}

export const VERTICAL_SWING_OPTIONS: SwingOption[] = [
  { value: 0, label: "Off", type: "swing" },
  { value: 1, label: "Full", type: "swing" },
  { value: 2, label: "Up", type: "swing" },
  { value: 3, label: "Down", type: "swing" },
  { value: 9, label: "Top", type: "fix" },
  { value: 10, label: "Upper", type: "fix" },
  { value: 11, label: "Mid", type: "fix" },
  { value: 12, label: "Lower", type: "fix" },
  { value: 13, label: "Bottom", type: "fix" },
];

export const HORIZONTAL_SWING_OPTIONS: SwingOption[] = [
  { value: 0, label: "Off", type: "swing" },
  { value: 1, label: "Full", type: "swing" },
  { value: 2, label: "Left", type: "swing" },
  { value: 3, label: "Mid", type: "swing" },
  { value: 4, label: "Right", type: "swing" },
  { value: 9, label: "L", type: "fix" },
  { value: 10, label: "CL", type: "fix" },
  { value: 11, label: "M", type: "fix" },
  { value: 12, label: "CR", type: "fix" },
  { value: 13, label: "R", type: "fix" },
];

/** Server validation set must match these. */
export const VALID_VERTICAL_SWING_VALUES = new Set(VERTICAL_SWING_OPTIONS.map((o) => o.value));

// ---------- Icons ----------

export function VerticalIcon({ value }: { value: number }) {
  switch (value) {
    case 0: return <X className="w-3.5 h-3.5" />;
    case 1: return <ChevronsUpDown className="w-3.5 h-3.5" />;
    case 2: return <ChevronUp className="w-3.5 h-3.5" />;
    case 3: return <ChevronDown className="w-3.5 h-3.5" />;
    default: return <FixedPositionDot axis="vertical" position={value} />;
  }
}

export function HorizontalIcon({ value }: { value: number }) {
  switch (value) {
    case 0: return <X className="w-3.5 h-3.5" />;
    case 1: return <ChevronsLeftRight className="w-3.5 h-3.5" />;
    case 2: return <ChevronLeft className="w-3.5 h-3.5" />;
    case 3: return <Minus className="w-3.5 h-3.5" />;
    case 4: return <ChevronRight className="w-3.5 h-3.5" />;
    default: return <FixedPositionDot axis="horizontal" position={value} />;
  }
}

export function FixedPositionDot({ axis, position }: { axis: "vertical" | "horizontal"; position: number }) {
  const idx = position - 9; // 0-4
  if (axis === "vertical") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14">
        <line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity={0.3} />
        <circle cx="7" cy={1 + idx * 3} r="2" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity={0.3} />
      <circle cx={1 + idx * 3} cy="7" r="2" fill="currentColor" />
    </svg>
  );
}
