import { useState, useEffect, useCallback, useRef } from "react";
import type { AcDevice } from "@/types/ac";

function getOptimisticUpdate(command: string, value: unknown): Partial<AcDevice> | null {
  switch (command) {
    case "set_power": return { power: value === 1 };
    case "set_mode": return { mode: value as number };
    case "set_temperature": return { targetTemp: value as number };
    case "set_fan_speed": return { fanSpeed: value as number };
    case "set_eco": return { eco: value === 1 };
    case "set_screen": return { screen: value === 1 };
    case "set_sleep": return { sleep: value as number };
    case "set_vertical_swing": return { verticalSwing: value as number };
    case "set_horizontal_swing": return { horizontalSwing: value as number };
    case "set_turbo": return { turbo: value === 1 };
    case "set_fresh_air": return { freshAir: value === 1 };
    case "set_generator_mode": return { generatorMode: value as number };
    default: return null;
  }
}

export function useAcDevices() {
  const [devices, setDevices] = useState<AcDevice[]>([]);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const controlUntil = useRef(0);

  const fetchAll = useCallback(async (force?: boolean) => {
    if (!force && Date.now() < controlUntil.current) return;
    try {
      const resp = await fetch("/api/ac/devices");
      if (resp.ok) {
        const data = (await resp.json()) as { devices: AcDevice[]; available: boolean };
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
    const interval = setInterval(() => fetchAll(), 10_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const sendControl = useCallback(async (deviceId: string, command: string, value: unknown): Promise<void> => {
    const optimistic = getOptimisticUpdate(command, value);
    let snapshot: AcDevice | undefined;

    if (optimistic) {
      controlUntil.current = Date.now() + 5000;
      setDevices(prev => {
        snapshot = prev.find(d => d.id === deviceId);
        return prev.map(d => d.id === deviceId ? { ...d, ...optimistic } : d);
      });
    }

    try {
      const resp = await fetch(`/api/ac/devices/${deviceId}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, value }),
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

  return { devices, available, loading, sendControl, refetch: fetchAll };
}
