import { useState, useCallback, useEffect } from "react";

export type SectionId = "outdoor" | "indoor" | "air-quality" | "prayer";

const ALL_SECTIONS: SectionId[] = ["outdoor", "indoor", "air-quality", "prayer"];
const STORAGE_KEY = "home-dashboard-layout";

interface SectionLayout {
  order: SectionId[];
  collapsed: Record<SectionId, boolean>;
}

const DEFAULT_LAYOUT: SectionLayout = {
  order: [...ALL_SECTIONS],
  collapsed: { outdoor: false, indoor: false, "air-quality": false, prayer: false },
};

function migrateOrder(order: string[]): SectionId[] {
  // Strip removed sections (e.g. "purifiers") and add any missing ones
  const valid = new Set<string>(ALL_SECTIONS);
  const filtered = order.filter((id) => valid.has(id)) as SectionId[];
  for (const id of ALL_SECTIONS) {
    if (!filtered.includes(id)) filtered.push(id);
  }
  return filtered;
}

function isValidLayout(data: unknown): data is SectionLayout {
  if (!data || typeof data !== "object") return false;
  const d = data as SectionLayout;
  if (!Array.isArray(d.order)) return false;
  return true;
}

function loadLayout(): SectionLayout {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (isValidLayout(parsed)) {
        const order = migrateOrder(parsed.order);
        const layout: SectionLayout = {
          order,
          collapsed: { ...DEFAULT_LAYOUT.collapsed, ...parsed.collapsed },
        };
        // Persist migrated layout
        if (order.length !== parsed.order.length) saveLayout(layout);
        return layout;
      }
    }
  } catch { /* ignore */ }
  return DEFAULT_LAYOUT;
}

function saveLayout(layout: SectionLayout) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
}

export function useSectionLayout() {
  const [layout, setLayoutState] = useState<SectionLayout>(loadLayout);

  // Cross-tab sync
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue);
          if (isValidLayout(parsed)) {
            setLayoutState({
              order: parsed.order,
              collapsed: { ...DEFAULT_LAYOUT.collapsed, ...parsed.collapsed },
            });
          }
        } catch { /* ignore */ }
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const setLayout = useCallback((updater: (prev: SectionLayout) => SectionLayout) => {
    setLayoutState((prev) => {
      const next = updater(prev);
      saveLayout(next);
      return next;
    });
  }, []);

  const toggleCollapsed = useCallback((id: SectionId) => {
    setLayout((prev) => ({
      ...prev,
      collapsed: { ...prev.collapsed, [id]: !prev.collapsed[id] },
    }));
  }, [setLayout]);

  const moveUp = useCallback((id: SectionId) => {
    setLayout((prev) => {
      const idx = prev.order.indexOf(id);
      if (idx <= 0) return prev;
      const order = [...prev.order];
      [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
      return { ...prev, order };
    });
  }, [setLayout]);

  const moveDown = useCallback((id: SectionId) => {
    setLayout((prev) => {
      const idx = prev.order.indexOf(id);
      if (idx < 0 || idx >= prev.order.length - 1) return prev;
      const order = [...prev.order];
      [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
      return { ...prev, order };
    });
  }, [setLayout]);

  return {
    order: layout.order,
    collapsed: layout.collapsed,
    toggleCollapsed,
    moveUp,
    moveDown,
  };
}
