import { useState, useEffect, useCallback } from "react";
import type { AcCalibrationResponse } from "@/types/leveling";

const POLL_INTERVAL = 3_000;

/** Polls GET /api/ac/calibration while enabled (panel visible + admin). */
export function useAcCalibration(enabled: boolean) {
  const [data, setData] = useState<AcCalibrationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const resp = await fetch("/api/ac/calibration");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setData(await resp.json() as AcCalibrationResponse);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [enabled, refresh]);

  const start = useCallback(async (deviceIds: string[], includeFan: boolean): Promise<void> => {
    const resp = await fetch("/api/ac/calibration/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceIds, includeFan }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `HTTP ${resp.status}`);
    }
    await refresh();
  }, [refresh]);

  const abort = useCallback(async (): Promise<void> => {
    const resp = await fetch("/api/ac/calibration/abort", { method: "POST" });
    if (!resp.ok) {
      const body = await resp.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `HTTP ${resp.status}`);
    }
    await refresh();
  }, [refresh]);

  return { data, loading, error, start, abort, refresh };
}
