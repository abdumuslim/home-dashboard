import { useState, useEffect } from "react";
import { fmtHoursCompact, fmtDur } from "@/constants/thresholds";
import { GRID_COLOR, GEN_COLOR } from "@/components/cards/power-card";
import type { PowerDayBreakdownResponse, PowerDayBreakdownEntry, TimeRange } from "@/types/api";

const breakdownCache = new Map<TimeRange, PowerDayBreakdownResponse>();

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function baghdadTodayKey(): string {
  // en-CA renders as YYYY-MM-DD, matching the server's Baghdad day keys.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Baghdad" }).format(new Date());
}

function fmtDayLabel(date: string): string {
  if (date === baghdadTodayKey()) return "Today";
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12)); // noon UTC keeps the weekday stable
  return `${WEEKDAYS[dt.getUTCDay()]} ${d}`;
}

function pct(hours: number, d: PowerDayBreakdownEntry): number {
  const covered = d.gridHours + d.genHours + d.offHours;
  return covered > 0 ? (hours / covered) * 100 : 0;
}

export function PowerBreakdownPanel({ range }: { range: TimeRange }) {
  const [data, setData] = useState<PowerDayBreakdownResponse | null>(
    () => breakdownCache.get(range) ?? null,
  );

  useEffect(() => {
    let mounted = true;
    const cached = breakdownCache.get(range);
    if (cached) setData(cached);

    const load = async () => {
      try {
        const res = await fetch(`/api/power/day-breakdown?range=${range}`);
        const json: PowerDayBreakdownResponse = await res.json();
        if (mounted) {
          setData(json);
          breakdownCache.set(range, json);
        }
      } catch (e) {
        console.error("Failed to fetch power breakdown:", e);
      }
    };
    load();
    return () => { mounted = false; };
  }, [range]);

  if (!data) return null;

  return (
    <div className="w-full sm:w-[230px] shrink-0 flex flex-col text-[0.7rem] max-h-[45%] sm:max-h-none">
      <div className="flex-1 overflow-y-auto pr-1 space-y-1.5">
        {data.days.map((d) => (
          <div key={d.date} className="flex items-center gap-2">
            <span
              className={`w-12 shrink-0 ${d.partial ? "text-dim/60" : "text-dim"}`}
              title={d.partial ? "partial day" : undefined}
            >
              {fmtDayLabel(d.date)}{d.partial ? "*" : ""}
            </span>
            <div className="flex-1 h-1.5 rounded-full overflow-hidden flex bg-white/5">
              <div style={{ width: `${pct(d.gridHours, d)}%`, background: GRID_COLOR }} />
              <div style={{ width: `${pct(d.genHours, d)}%`, background: GEN_COLOR }} />
            </div>
            <span className="tabular-nums shrink-0">
              <span style={{ color: GRID_COLOR }}>{fmtHoursCompact(d.gridHours)}</span>
              /
              <span style={{ color: GEN_COLOR }}>{fmtHoursCompact(d.genHours)}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="border-t border-white/10 pt-1.5 mt-1.5 flex items-center justify-between shrink-0">
        <span className="text-dim">Total</span>
        <span className="tabular-nums">
          <span style={{ color: GRID_COLOR }}>{fmtHoursCompact(data.totals.gridHours)}</span>
          /
          <span style={{ color: GEN_COLOR }}>{fmtHoursCompact(data.totals.genHours)}</span>
          <span className="text-dim"> · off {fmtDur(data.totals.offHours * 60)}</span>
        </span>
      </div>
    </div>
  );
}
