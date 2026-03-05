import { useState, useEffect, useCallback } from "react";
import type { PurifierDevice } from "@/types/automations";

type AuthStatus = "authenticated" | "needs_2fa" | "needs_captcha" | "not_configured" | "error";

interface AuthState {
  status: AuthStatus;
  error?: string;
  captchaImage?: string;
}

export function useDevices() {
  const [devices, setDevices] = useState<PurifierDevice[]>([]);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authState, setAuthState] = useState<AuthState>({ status: "not_configured" });

  const fetchAll = useCallback(async () => {
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
    fetchAll();
    // Poll every 10s while mounted
    const interval = setInterval(fetchAll, 10_000);
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
    const resp = await fetch(`/api/devices/${deviceId}/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, params }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(text);
    }
    // Refresh status after control
    setTimeout(fetchAll, 1000);
  }, [fetchAll]);

  return { devices, available, loading, authState, submitVerification, sendControl, refetch: fetchAll };
}
