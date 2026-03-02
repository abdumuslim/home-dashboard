import { type ReactNode } from "react";
import { ChevronRight, ChevronUp, ChevronDown } from "lucide-react";
import type { SectionId } from "@/hooks/use-section-layout";

interface SectionWrapperProps {
  id: SectionId;
  collapsed: boolean;
  isFirst: boolean;
  isLast: boolean;
  onToggleCollapse: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  headerContent: ReactNode;
  headerRight?: ReactNode;
  children: ReactNode;
}

export function SectionWrapper({
  id,
  collapsed,
  isFirst,
  isLast,
  onToggleCollapse,
  onMoveUp,
  onMoveDown,
  headerContent,
  headerRight,
  children,
}: SectionWrapperProps) {
  return (
    <section className="mb-6">
      <div className="px-0.5 pt-5 pb-3 flex items-center justify-between group">
        <button
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          aria-controls={`section-${id}-content`}
          className="flex items-center gap-1.5 cursor-pointer text-left"
        >
          <ChevronRight
            className={`w-4 h-4 text-dim transition-transform duration-200 ${!collapsed ? "rotate-90" : ""}`}
          />
          {headerContent}
        </button>

        <div className="flex items-center gap-1">
          {headerRight}
          <div className="flex items-center gap-0.5 md:hidden md:group-hover:flex">
            {!isFirst && (
              <button
                onClick={onMoveUp}
                className="p-1 rounded hover:bg-white/10 text-dim hover:text-white transition-colors"
                title="Move up"
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
            )}
            {!isLast && (
              <button
                onClick={onMoveDown}
                className="p-1 rounded hover:bg-white/10 text-dim hover:text-white transition-colors"
                title="Move down"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      <div
        id={`section-${id}-content`}
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: collapsed ? "0fr" : "1fr" }}
      >
        <div className="overflow-hidden">
          {children}
        </div>
      </div>
    </section>
  );
}
