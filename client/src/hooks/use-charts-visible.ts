import { createElement, createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";

const STORAGE_KEY = "home-dashboard-charts-visible";

interface ChartsVisibleContextValue {
  chartsVisible: boolean;
  toggleCharts: () => void;
}

const ChartsVisibleContext = createContext<ChartsVisibleContextValue | null>(null);

function readStorage(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null ? true : v === "true";
  } catch {
    return true;
  }
}

export function ChartsVisibleProvider({ children }: { children: ReactNode }) {
  const [chartsVisible, setChartsVisible] = useState(readStorage);

  const toggleCharts = useCallback(() => {
    setChartsVisible((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setChartsVisible(e.newValue !== "false");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return createElement(ChartsVisibleContext.Provider, { value: { chartsVisible, toggleCharts } }, children);
}

export function useChartsVisible() {
  const ctx = useContext(ChartsVisibleContext);
  if (!ctx) throw new Error("useChartsVisible must be used within ChartsVisibleProvider");
  return ctx;
}
