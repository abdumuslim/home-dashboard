import { useState, useCallback, lazy, Suspense, type ReactNode } from "react";
import { useCurrentData } from "@/hooks/use-current-data";
import { useHistoryData } from "@/hooks/use-history-data";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Header } from "@/components/Header";
import { DashboardTab } from "@/components/dashboard-tab";
import type { TimeRange, WeatherReading, AirReading } from "@/types/api";

const ChartOverlay = lazy(() => import("@/components/ui/chart-overlay").then(m => ({ default: m.ChartOverlay })));
const SettingsModal = lazy(() => import("@/components/ui/settings-modal").then(m => ({ default: m.SettingsModal })));
const AlertsModal = lazy(() => import("@/components/ui/alerts-modal").then(m => ({ default: m.AlertsModal })));
const LoginModal = lazy(() => import("@/components/ui/login-modal").then(m => ({ default: m.LoginModal })));

interface OverlayState {
  title: string;
  renderExpanded: (range: TimeRange, wh: WeatherReading[], ah: AirReading[]) => ReactNode;
}

function AppInner() {
  const { isAdmin, logout } = useAuth();
  const { weather, air, power } = useCurrentData();
  const { weatherHistory, airHistory, powerHistory } = useHistoryData("24h", true);
  const [overlay, setOverlay] = useState<OverlayState | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
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
        isAdmin={isAdmin}
        onLoginClick={() => setShowLogin(true)}
        onLogout={logout}
      />

      <div className="max-w-[1536px] mx-auto px-5 pt-8 pb-2">
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
        isAdmin={isAdmin}
      />

      <Suspense>
        {overlay && (
          <ChartOverlay
            title={overlay.title}
            renderExpanded={overlay.renderExpanded}
            onClose={() => setOverlay(null)}
          />
        )}

        {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
        {showAlerts && <AlertsModal onClose={() => setShowAlerts(false)} isAdmin={isAdmin} />}
        {showLogin && <LoginModal onClose={() => setShowLogin(false)} />}
      </Suspense>
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  );
}
