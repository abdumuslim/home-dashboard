import { Zap } from "lucide-react";

interface BatteryIndicatorProps {
  percentage: number | null;
  charging?: boolean;
}

export function BatteryIndicator({ percentage, charging }: BatteryIndicatorProps) {
  const pct = percentage ?? 0;
  const hasValue = percentage != null;

  // Color based on percentage
  const fill = pct >= 50 ? "#22c55e" : pct >= 20 ? "#f59e0b" : "#ef4444";

  // Battery body dimensions
  const bodyW = 30;
  const bodyH = 14;
  const bodyR = 2.5;
  const termW = 2.5;
  const termH = 6;
  const pad = 1.5;

  // Inner fill dimensions
  const innerW = bodyW - pad * 2;
  const innerH = bodyH - pad * 2;
  const fillW = hasValue ? (pct / 100) * innerW : 0;

  const svgW = bodyW + termW + 1;
  const svgH = bodyH + 2;

  return (
    <span className="inline-flex items-center relative">
      <svg
        width={svgW}
        height={svgH}
        viewBox={`0 0 ${svgW} ${svgH}`}
        className="inline-block align-middle"
        aria-label={hasValue ? `Battery ${pct}%${charging ? " charging" : ""}` : "Battery unknown"}
      >
        {/* Battery body */}
        <rect
          x={0.5}
          y={1}
          width={bodyW}
          height={bodyH}
          rx={bodyR}
          ry={bodyR}
          fill="none"
          stroke="rgba(255,255,255,0.35)"
          strokeWidth={1}
        />

        {/* Terminal nub */}
        <rect
          x={bodyW + 0.5}
          y={(bodyH - termH) / 2 + 1}
          width={termW}
          height={termH}
          rx={1}
          ry={1}
          fill="rgba(255,255,255,0.35)"
        />

        {/* Fill level */}
        {fillW > 0 && (
          <rect
            x={0.5 + pad}
            y={1 + pad}
            width={fillW}
            height={innerH}
            rx={1.5}
            ry={1.5}
            fill={fill}
          />
        )}

        {/* Percentage text (only when not charging) */}
        {!charging && (
          <text
            x={bodyW / 2 + 0.5}
            y={bodyH / 2 + 1}
            textAnchor="middle"
            dominantBaseline="central"
            fill="white"
            fontSize={hasValue ? "8" : "7"}
            fontWeight="600"
            opacity={0.9}
          >
            {hasValue ? pct : "--"}
          </text>
        )}
      </svg>

      {/* Zap icon centered over battery body when charging */}
      {charging && (
        <Zap
          size={10}
          className="absolute"
          style={{ left: (bodyW - 10) / 2 + 0.5, top: (svgH - 10) / 2 }}
          fill="white"
          color="white"
          opacity={0.95}
        />
      )}
    </span>
  );
}
