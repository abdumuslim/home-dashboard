import { useState, useEffect } from "react";
import type { PowerSource, PowerStats } from "@/types/api";
import { CHART_REFRESH } from "@/constants/thresholds";

// Polls /api/power/stats every 60s. `liveSource` is a dependency: a grid<->gen
// (or blackout) flip restarts the effect for an immediate refetch — the server
// cache also invalidates on a source change, so the refetch returns fresh data.
export function usePowerStats(liveSource: PowerSource): PowerStats | null {
  const [stats, setStats] = useState<PowerStats | null>(null);

  useEffect(() => {
    let mounted = true;

    const fetchStats = async () => {
      try {
        const res = await fetch("/api/power/stats");
        const json: PowerStats | null = await res.json();
        if (mounted) setStats(json);
      } catch (e) {
        console.error("Failed to fetch power stats:", e);
      }
    };

    fetchStats();
    const id = setInterval(fetchStats, CHART_REFRESH);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [liveSource]);

  return stats;
}
