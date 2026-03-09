import { useState, useCallback, type ReactNode } from "react";
import { useCurrentData } from "@/hooks/use-current-data";
import { useHistoryData } from "@/hooks/use-history-data";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { Header } from "@/components/Header";
import { DashboardTab } from "@/components/dashboard-tab";
import { ChartOverlay } from "@/components/ui/chart-overlay";
import { SettingsModal } from "@/components/ui/settings-modal";
import { AlertsModal } from "@/components/ui/alerts-modal";
import type { TimeRange, WeatherReading, AirReading } from "@/types/api";

interface OverlayState {
  title: string;
  renderExpanded: (range: TimeRange, wh: WeatherReading[], ah: AirReading[]) => ReactNode;
}

export default function App() {
  const { weather, air, power } = useCurrentData();
  const { weatherHistory, airHistory, powerHistory } = useHistoryData("24h", true);
  const [overlay, setOverlay] = useState<OverlayState | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);
  const { isSubscribed } = usePushNotifications();

  const openOverlay = useCallback(
    (title: string, renderExpanded: (range: TimeRange, wh: WeatherReading[], ah: AirReading[]) => ReactNode) => {
      setOverlay({ title, renderExpanded });
    },
    [],
  );

  return (
    <>
      <Header
        weatherTs={weather?.ts}
        airTs={air?.ts}
        onOpenSettings={() => setShowSettings(true)}
        onOpenAlerts={() => setShowAlerts(true)}
        alertsActive={isSubscribed}
      />

      <div className="max-w-[1440px] mx-auto px-5 pt-8 pb-2">
        <h1 className="text-3xl font-medium tracking-wide text-white">Home Dashboard</h1>
      </div>

      <DashboardTab
        weather={weather}
        air={air}
        weatherHistory={weatherHistory}
        airHistory={airHistory}
        openOverlay={openOverlay}
        power={power ?? null}
        powerHistory={powerHistory}
      />

      {overlay && (
        <ChartOverlay
          title={overlay.title}
          renderExpanded={overlay.renderExpanded}
          onClose={() => setOverlay(null)}
        />
      )}

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showAlerts && <AlertsModal onClose={() => setShowAlerts(false)} />}
    </>
  );
}
