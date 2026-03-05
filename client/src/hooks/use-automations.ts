import { useState, useEffect, useCallback } from "react";
import type { AutomationRule } from "@/types/automations";

export function useAutomations() {
  const [automations, setAutomations] = useState<AutomationRule[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAutomations = useCallback(async () => {
    try {
      const resp = await fetch("/api/automations");
      if (resp.ok) {
        const data = (await resp.json()) as { automations: AutomationRule[] };
        setAutomations(data.automations);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchAutomations();
  }, [fetchAutomations]);

  const createAutomation = useCallback(
    async (body: Record<string, unknown>) => {
      const resp = await fetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error((await resp.json() as { error: string }).error);
      await fetchAutomations();
    },
    [fetchAutomations],
  );

  const deleteAutomation = useCallback(
    async (id: number) => {
      await fetch(`/api/automations/${id}`, { method: "DELETE" });
      await fetchAutomations();
    },
    [fetchAutomations],
  );

  const updateAutomation = useCallback(
    async (id: number, body: Record<string, unknown>) => {
      const resp = await fetch(`/api/automations/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error((await resp.json() as { error: string }).error);
      await fetchAutomations();
    },
    [fetchAutomations],
  );

  const toggleAutomation = useCallback(
    async (id: number, enabled: boolean) => {
      await fetch(`/api/automations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      await fetchAutomations();
    },
    [fetchAutomations],
  );

  return { automations, loading, createAutomation, updateAutomation, deleteAutomation, toggleAutomation };
}
