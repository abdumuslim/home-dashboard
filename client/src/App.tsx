import { useState, lazy, Suspense } from "react";
import { useCurrentData } from "@/hooks/use-current-data";
import { useHistoryData } from "@/hooks/use-history-data";
import { Header } from "@/components/header";
import { DashboardTab } from "@/components/dashboard-tab";
import { cn } from "@/lib/utils";

const ChartsTab = lazy(() =>
  import("@/components/charts-tab").then((m) => ({ default: m.ChartsTab }))
);

type Tab = "dashboard" | "charts";

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const { weather, air } = useCurrentData();
  const { weatherHistory } = useHistoryData("24h", true);

  return (
    <>
      <Header weatherTs={weather?.ts} airTs={air?.ts} />

      <nav className="flex px-5 border-b border-card-border bg-bg max-md:px-3">
        {(["dashboard", "charts"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "bg-transparent border-none text-dim font-medium text-[0.8rem] leading-none",
              "px-4 py-2.5 cursor-pointer border-b-2 border-b-transparent transition-all duration-150",
              "hover:text-text font-[Inter,sans-serif] capitalize",
              activeTab === tab && "text-text border-b-cyan"
            )}
          >
            {tab}
          </button>
        ))}
      </nav>

      {activeTab === "dashboard" && (
        <DashboardTab weather={weather} air={air} weatherHistory={weatherHistory} />
      )}

      {activeTab === "charts" && (
        <Suspense fallback={<div className="text-center text-dim py-8">Loading charts...</div>}>
          <ChartsTab />
        </Suspense>
      )}
    </>
  );
}
