import { useState, useEffect, useCallback, useRef } from "react";
import type { PurifierDevice } from "@/types/automations";

export type AuthStatus = "authenticated" | "needs_2fa" | "needs_captcha" | "not_configured" | "error";

export interface AuthState {
  status: AuthStatus;
  error?: string;
  captchaImage?: string;
}

interface DevicesResponse {
  devices: PurifierDevice[];
  available: boolean;
  authStatus?: AuthStatus;
  region?: string;
  error?: string;
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

export function useDevices(enabled = true) {
  const [devices, setDevices] = useState<PurifierDevice[]>([]);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [authState, setAuthState] = useState<AuthState>({ status: "not_configured" });
  const controlUntil = useRef(0); // suppress polling until this timestamp

  const fetchAll = useCallback(async (force?: boolean) => {
    if (!force && Date.now() < controlUntil.current) return;
    // The dashboard API failing is a different outage from the Xiaomi cloud failing, so it
    // gets its own message; the devices on screen stay put and turn stale, never live.
    const markUnreachable = (message: string) => {
      setAvailable(false);
      setError(message);
    };
    try {
      const [authResp, devResp] = await Promise.all([
        fetch("/api/xiaomi/auth-status"),
        fetch("/api/devices"),
      ]);
      if (authResp.ok) {
        setAuthState(await authResp.json() as AuthState);
      }
      if (!devResp.ok) {
        markUnreachable(`Dashboard API error (HTTP ${devResp.status})`);
        return;
      }
      const data = (await devResp.json()) as DevicesResponse;
      // Re-check: a control command may have fired while this fetch was in-flight
      if (!force && Date.now() < controlUntil.current) return;
      // A cloud outage must not blank the UI: keep the last-known devices when the
      // server has none to send, and let callers mark them stale via `available`.
      setDevices(prev => (data.available || data.devices.length > 0 ? data.devices : prev));
      setAvailable(data.available);
      setError(data.error);
      // Fallback only: /api/xiaomi/auth-status is the richer source (it carries the captcha)
      if (!authResp.ok && data.authStatus) {
        setAuthState({ status: data.authStatus, error: data.error });
      }
    } catch (err) {
      // A dead poll says nothing about the purifiers, so keep the last-known devices,
      // but never keep claiming they are live: that is the server-side bug one layer out.
      markUnreachable(err instanceof Error ? `Dashboard API unreachable: ${err.message}` : "Dashboard API unreachable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setDevices([]);
      setAvailable(false);
      setError(undefined);
      setLoading(false);
      return;
    }
    fetchAll(true);
    // Poll every 10s while mounted
    const interval = setInterval(() => fetchAll(), 10_000);
    return () => clearInterval(interval);
  }, [fetchAll, enabled]);

  // Resolves on every path (a proxy error page makes resp.json() throw): a rejection here
  // would leave the verify form's busy flag stuck and disable the button for good.
  const submitVerification = useCallback(async (code: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const resp = await fetch("/api/xiaomi/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const result = await resp.json() as { ok?: boolean; error?: string };
      if (!resp.ok || !result.ok) return { ok: false, error: result.error ?? "Verification failed" };
      // Refresh after successful auth
      await fetchAll();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Verification failed" };
    }
  }, [fetchAll]);

  // Supported recovery path: drops the dead token so the collector logs in again
  const requestRelogin = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const resp = await fetch("/api/xiaomi/relogin", { method: "POST" });
      const result = await resp.json() as { ok?: boolean; error?: string };
      if (!resp.ok || !result.ok) return { ok: false, error: result.error ?? "Sign-in retry failed" };
      await fetchAll(true);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Sign-in retry failed" };
    }
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

  return { devices, available, error, loading, authState, submitVerification, requestRelogin, sendControl, refetch: fetchAll };
}
