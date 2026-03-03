import { useState, useEffect, useCallback } from "react";
import type { AlertRule } from "@/types/alerts";
import { ALERT_METRICS, PRAYER_NAMES } from "@/constants/alert-metrics";

export function useAlerts(endpoint: string | null) {
  const [alerts, setAlerts] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);

  // Fetch alerts when endpoint changes
  const fetchAlerts = useCallback(async () => {
    if (!endpoint) {
      setAlerts([]);
      setLoading(false);
      return;
    }
    try {
      const resp = await fetch(`/api/alerts?endpoint=${encodeURIComponent(endpoint)}`);
      if (resp.ok) {
        const data = (await resp.json()) as { alerts: AlertRule[] };
        setAlerts(data.alerts);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    setLoading(true);
    fetchAlerts();
  }, [fetchAlerts]);

  const createAlert = useCallback(
    async (body: Record<string, unknown>) => {
      if (!endpoint) return;
      const resp = await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint, ...body }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        let msg = `Server error (${resp.status})`;
        try { msg = (JSON.parse(text) as { error: string }).error; } catch { /* not JSON */ }
        throw new Error(msg);
      }
      await fetchAlerts();
    },
    [endpoint, fetchAlerts],
  );

  const updateAlert = useCallback(
    async (alertId: number, body: Record<string, unknown>) => {
      if (!endpoint) return;
      const resp = await fetch(`/api/alerts/${alertId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint, ...body }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        let msg = `Server error (${resp.status})`;
        try { msg = (JSON.parse(text) as { error: string }).error; } catch { /* not JSON */ }
        throw new Error(msg);
      }
      await fetchAlerts();
    },
    [endpoint, fetchAlerts],
  );

  const deleteAlert = useCallback(
    async (alertId: number) => {
      if (!endpoint) return;
      await fetch(`/api/alerts/${alertId}?endpoint=${encodeURIComponent(endpoint)}`, {
        method: "DELETE",
      });
      await fetchAlerts();
    },
    [endpoint, fetchAlerts],
  );

  return { alerts, metrics: ALERT_METRICS, prayerNames: [...PRAYER_NAMES], loading, createAlert, updateAlert, deleteAlert };
}
