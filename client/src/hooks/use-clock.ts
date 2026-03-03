import { useState, useEffect, useCallback } from "react";
import { TZ } from "@/constants/thresholds";

type ConnectionStatus = "online" | "stale" | "offline";

export function useClock() {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const formatTime = useCallback(() => {
    return new Date(now).toLocaleTimeString("en-US", {
      timeZone: TZ,
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  }, [now]);

  const formatDate = useCallback(() => {
    return new Date(now).toLocaleDateString("en-US", {
      timeZone: TZ,
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }, [now]);

  const getAgo = useCallback(
    (ts: string | null | undefined): { text: string; status: ConnectionStatus } => {
      if (!ts) return { text: "offline", status: "offline" };
      const s = Math.floor((now - new Date(ts).getTime()) / 1000);
      const status: ConnectionStatus = s < 900 ? "online" : s < 3600 ? "stale" : "offline";
      const text =
        s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
      return { text, status };
    },
    [now]
  );

  return { formatTime, formatDate, getAgo };
}
