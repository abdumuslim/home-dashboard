import { useState, useEffect, useCallback, useRef } from "react";
import type { PurifierDevice } from "@/types/automations";

type AuthStatus = "authenticated" | "needs_2fa" | "needs_captcha" | "not_configured" | "error";

interface AuthState {
  status: AuthStatus;
  error?: string;
  captchaImage?: string;
}

function getOptimisticUpdate(command: string, params: unknown[]): Partial<PurifierDevice> | null {
  const val = params[0];
  switch (command) {
    case "set_power": return { power: val === "on" ? "on" : "off" };
    case "set_mode": return { mode: val as string };
    case "set_fan_level": return { fan_level: val as number, mode: "fan" };
    case "set_level_favorite": return { favorite_level: val as number };
    case "set_led": return { led: val === "on" };
    case "set_buzzer": return { buzzer: val === "on" };
    case "set_child_lock": return { child_lock: val === "on" };
    default: return null;
  }
}

export function useDevices() {
  const [devices, setDevices] = useState<PurifierDevice[]>([]);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authState, setAuthState] = useState<AuthState>({ status: "not_configured" });
  const controlUntil = useRef(0); // suppress polling until this timestamp

  const fetchAll = useCallback(async (force?: boolean) => {
    if (!force && Date.now() < controlUntil.current) return;
    try {
      const [authResp, devResp] = await Promise.all([
        fetch("/api/xiaomi/auth-status"),
        fetch("/api/devices"),
      ]);
      if (authResp.ok) {
        setAuthState(await authResp.json() as AuthState);
      }
      if (devResp.ok) {
        const data = (await devResp.json()) as { devices: PurifierDevice[]; available: boolean };
        // Re-check: a control command may have fired while this fetch was in-flight
        if (!force && Date.now() < controlUntil.current) return;
        setDevices(data.devices);
        setAvailable(data.available);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll(true);
    // Poll every 10s while mounted
    const interval = setInterval(() => fetchAll(), 10_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const submitVerification = useCallback(async (code: string): Promise<{ ok: boolean; error?: string }> => {
    const resp = await fetch("/api/xiaomi/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const result = await resp.json() as { ok: boolean; error?: string };
    if (result.ok) {
      // Refresh after successful auth
      await fetchAll();
    }
    return result;
  }, [fetchAll]);

  const sendControl = useCallback(async (deviceId: string, command: string, params: unknown[]): Promise<void> => {
    const optimistic = getOptimisticUpdate(command, params);
    let snapshot: PurifierDevice | undefined;

    if (optimistic) {
      controlUntil.current = Date.now() + 5000;
      setDevices(prev => {
        snapshot = prev.find(d => d.id === deviceId);
        return prev.map(d => d.id === deviceId ? { ...d, ...optimistic } : d);
      });
    }

    try {
      const resp = await fetch(`/api/devices/${deviceId}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, params }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      setTimeout(() => fetchAll(true), 2000);
    } catch (err) {
      if (snapshot) {
        setDevices(prev => prev.map(d => d.id === deviceId ? snapshot! : d));
      }
      throw err;
    }
  }, [fetchAll]);

  return { devices, available, loading, authState, submitVerification, sendControl, refetch: fetchAll };
}
