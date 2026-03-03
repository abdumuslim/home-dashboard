import { useState, useEffect, useCallback } from "react";
import type { AlertRule } from "@/types/alerts";

async function throwIfNotOk(resp: Response): Promise<void> {
  if (resp.ok) return;
  const text = await resp.text();
  let msg = `Server error (${resp.status})`;
  try { msg = (JSON.parse(text) as { error: string }).error; } catch { /* not JSON */ }
  throw new Error(msg);
}

export function useAlerts(endpoint: string | null) {
  const [alerts, setAlerts] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);

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
      await throwIfNotOk(resp);
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
      await throwIfNotOk(resp);
      await fetchAlerts();
    },
    [endpoint, fetchAlerts],
  );

  const deleteAlert = useCallback(
    async (alertId: number) => {
      if (!endpoint) return;
      const resp = await fetch(`/api/alerts/${alertId}?endpoint=${encodeURIComponent(endpoint)}`, {
        method: "DELETE",
      });
      await throwIfNotOk(resp);
      await fetchAlerts();
    },
    [endpoint, fetchAlerts],
  );

  return { alerts, loading, createAlert, updateAlert, deleteAlert };
}
