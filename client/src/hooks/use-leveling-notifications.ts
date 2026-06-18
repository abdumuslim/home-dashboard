import { useState, useEffect, useCallback } from "react";

/**
 * Per-device opt-in for Smart AC Leveling push notifications (off by default).
 * Keyed on the browser's push subscription endpoint; no-op when not subscribed.
 */
export function useLevelingNotifications(endpoint: string | null) {
  const [enabled, setEnabledState] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!endpoint) {
      setEnabledState(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetch(`/api/push/leveling?endpoint=${encodeURIComponent(endpoint)}`)
      .then((resp) => (resp.ok ? resp.json() : { enabled: false }))
      .then((data: { enabled?: boolean }) => {
        if (!cancelled) setEnabledState(data.enabled === true);
      })
      .catch(() => { /* ignore */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [endpoint]);

  const setEnabled = useCallback(
    async (next: boolean) => {
      if (!endpoint) return;
      const prev = enabled;
      setEnabledState(next); // optimistic
      try {
        const resp = await fetch("/api/push/leveling", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint, enabled: next }),
        });
        if (!resp.ok) throw new Error(`Server error (${resp.status})`);
      } catch {
        setEnabledState(prev); // rollback
      }
    },
    [endpoint, enabled],
  );

  return { enabled, setEnabled, loading };
}
