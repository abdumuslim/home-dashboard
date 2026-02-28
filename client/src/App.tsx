import { useCurrentData } from "@/hooks/use-current-data";
import { useHistoryData } from "@/hooks/use-history-data";
import { Header } from "@/components/header";
import { DashboardTab } from "@/components/dashboard-tab";

export default function App() {
  const { weather, air } = useCurrentData();
  const { weatherHistory, airHistory } = useHistoryData("24h", true);

  return (
    <>
      <Header weatherTs={weather?.ts} airTs={air?.ts} />

      <div className="max-w-[1440px] mx-auto px-5 pt-8 pb-2">
        <h1 className="text-3xl font-medium tracking-wide text-white">Home Dashboard</h1>
      </div>

      <DashboardTab weather={weather} air={air} weatherHistory={weatherHistory} airHistory={airHistory} />
    </>
  );
}
