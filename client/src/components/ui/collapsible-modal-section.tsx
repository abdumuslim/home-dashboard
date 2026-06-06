import { type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface CollapsibleModalSectionProps {
  id: string;
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  headerRight?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** Collapsible section for modal panels — modal-styled variant of SectionWrapper. */
export function CollapsibleModalSection({
  id,
  title,
  collapsed,
  onToggle,
  headerRight,
  className,
  children,
}: CollapsibleModalSectionProps) {
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="px-5 pt-4 pb-2 flex items-center justify-between">
        <button
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={`modal-section-${id}`}
          className="flex items-center gap-1 cursor-pointer text-left -ml-1"
        >
          <ChevronRight
            className={cn("w-3.5 h-3.5 text-dim transition-transform duration-200", !collapsed && "rotate-90")}
          />
          <h3 className="text-xs font-medium tracking-wider text-dim uppercase">{title}</h3>
        </button>
        {!collapsed && headerRight}
      </div>

      <div
        id={`modal-section-${id}`}
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: collapsed ? "0fr" : "1fr" }}
      >
        <div className="overflow-hidden">
          <div className="flex flex-col">{children}</div>
        </div>
      </div>
    </div>
  );
}
