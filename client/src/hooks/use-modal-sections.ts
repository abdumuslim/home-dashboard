import { useState, useCallback } from "react";

export type ModalSectionId = "alerts" | "automations" | "leveling";

const STORAGE_KEY = "alerts-modal-sections";

const DEFAULT_COLLAPSED: Record<ModalSectionId, boolean> = {
  alerts: false,
  automations: false,
  leveling: false,
};

function loadCollapsed(): Record<ModalSectionId, boolean> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed === "object") {
        return { ...DEFAULT_COLLAPSED, ...parsed };
      }
    }
  } catch { /* ignore */ }
  return DEFAULT_COLLAPSED;
}

/** Persisted collapse state for the bell-modal sections. */
export function useModalSections() {
  const [collapsed, setCollapsed] = useState<Record<ModalSectionId, boolean>>(loadCollapsed);

  const toggle = useCallback((id: ModalSectionId) => {
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  return { collapsed, toggle };
}
