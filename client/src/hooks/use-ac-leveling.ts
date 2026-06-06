import { useState, useEffect, useCallback } from "react";
import type { AcLevelingConfig, AcLevelingResponse, AcLevelingStatus } from "@/types/leveling";

const POLL_INTERVAL = 5_000;

/** Polls GET /api/ac/leveling while enabled (section expanded + admin). */
export function useAcLeveling(enabled: boolean) {
  const [config, setConfig] = useState<AcLevelingConfig | null>(null);
  const [status, setStatus] = useState<AcLevelingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchLeveling = useCallback(async () => {
    try {
      const resp = await fetch("/api/ac/leveling");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as AcLevelingResponse;
      setConfig(data.config);
      setStatus(data.status);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    fetchLeveling();
    const interval = setInterval(fetchLeveling, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [enabled, fetchLeveling]);

  const saveConfig = useCallback(async (next: AcLevelingConfig): Promise<void> => {
    const resp = await fetch("/api/ac/leveling", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `HTTP ${resp.status}`);
    }
    const data = await resp.json() as { config: AcLevelingConfig };
    setConfig(data.config);
  }, []);

  return { config, status, loading, error, saveConfig, refresh: fetchLeveling };
}
