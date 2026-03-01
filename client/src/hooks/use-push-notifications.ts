import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "home-dashboard-notification-prefs";
const DEFAULT_BREAKPOINTS = [15, 7, 4, 2, 0];

function loadBreakpoints(): number[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored) as number[];
  } catch { /* ignore */ }
  return DEFAULT_BREAKPOINTS;
}

function saveBreakpoints(bp: number[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bp));
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function usePushNotifications() {
  const isSupported = "serviceWorker" in navigator && "PushManager" in window;
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>(
    isSupported ? Notification.permission : "denied"
  );
  const [breakpoints, setBreakpointsState] = useState<number[]>(loadBreakpoints);

  // Check existing subscription on mount
  useEffect(() => {
    if (!isSupported) return;
    navigator.serviceWorker.ready.then((reg) => {
      reg.pushManager.getSubscription().then((sub) => {
        setIsSubscribed(!!sub);
      });
    });
  }, [isSupported]);

  const subscribe = useCallback(async () => {
    if (!isSupported) return;
    const perm = await Notification.requestPermission();
    setPermission(perm);
    if (perm !== "granted") return;

    const reg = await navigator.serviceWorker.ready;
    const resp = await fetch("/api/push/vapid-key");
    const { publicKey } = (await resp.json()) as { publicKey: string };

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
    });

    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON(), breakpoints }),
    });

    setIsSubscribed(true);
  }, [isSupported, breakpoints]);

  const unsubscribe = useCallback(async () => {
    if (!isSupported) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
    }
    setIsSubscribed(false);
  }, [isSupported]);

  const setBreakpoints = useCallback(async (bp: number[]) => {
    setBreakpointsState(bp);
    saveBreakpoints(bp);

    // If already subscribed, update the server
    if (!isSupported) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), breakpoints: bp }),
      });
    }
  }, [isSupported]);

  return { isSupported, isSubscribed, permission, subscribe, unsubscribe, breakpoints, setBreakpoints };
}
