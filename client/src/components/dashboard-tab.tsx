import type { ReactNode } from "react";
import type { WeatherReading, AirReading, PowerReading, OpenOverlayFn } from "@/types/api";
import type { ForecastResponse } from "@/types/forecast";
import { useSectionLayout, type SectionId } from "@/hooks/use-section-layout";
import { useDevices } from "@/hooks/use-devices";
import { useAcDevices } from "@/hooks/use-ac-devices";
import { SectionWrapper } from "./ui/section-wrapper";
import { OutdoorSection } from "./sections/outdoor-section";
import { IndoorSection } from "./sections/indoor-section";
import { AirQualitySection } from "./sections/air-quality-section";
import { PrayerSectionHeader, PrayerSectionContent } from "./sections/prayer-section";
import { ForecastSection } from "./sections/forecast-section";
import { BatteryIndicator } from "./ui/battery-indicator";

interface DashboardTabProps {
  weather: WeatherReading | null;
  air: AirReading | null;
  weatherHistory: WeatherReading[];
  airHistory: AirReading[];
  openOverlay: OpenOverlayFn;
  power: PowerReading | null;
  powerHistory: PowerReading[];
  isAdmin: boolean;
  forecast: ForecastResponse | null;
}

export function DashboardTab({ weather, air, weatherHistory, airHistory, openOverlay, power, powerHistory, isAdmin, forecast }: DashboardTabProps) {
  const { order, collapsed, toggleCollapsed, moveUp, moveDown } = useSectionLayout();
  const { devices, sendControl } = useDevices(isAdmin);
  const { devices: acDevices, sendControl: acSendControl } = useAcDevices(isAdmin);

  const visibleOrder = isAdmin ? order : order.filter((id) => id !== "indoor");

  const sections: Record<SectionId, { header: ReactNode; headerRight?: ReactNode; content: ReactNode }> = {
    outdoor: {
      header: (
        <h2 className="text-base font-medium tracking-wider text-white">
          OUTDOOR <span className="text-dim text-sm tracking-normal ml-1">(WS-2000)</span>
        </h2>
      ),
      content: <OutdoorSection weather={weather} weatherHistory={weatherHistory} openOverlay={openOverlay} />,
    },
    indoor: {
      header: <h2 className="text-base font-medium tracking-wider text-white">INDOOR</h2>,
      content: (
        <IndoorSection
          weather={weather}
          air={air}
          weatherHistory={weatherHistory}
          airHistory={airHistory}
          openOverlay={openOverlay}
          devices={devices}
          sendControl={sendControl}
          acDevices={acDevices}
          acSendControl={acSendControl}
          power={power}
          powerHistory={powerHistory}
        />
      ),
    },
    "air-quality": {
      header: (
        <h2 className="text-base font-medium tracking-wider text-white inline-flex items-center">
          AIR QUALITY{" "}
          <span className="text-dim text-[0.85rem] tracking-normal ml-2 inline-flex items-center gap-1.5">
            Qingping CGS2 <BatteryIndicator percentage={air?.battery ?? null} charging={air?.batteryCharging} />
          </span>
        </h2>
      ),
      content: <AirQualitySection air={air} airHistory={airHistory} openOverlay={openOverlay} />,
    },
    prayer: {
      header: <PrayerSectionHeader />,
      content: <PrayerSectionContent />,
    },
    forecast: {
      header: (
        <h2 className="text-base font-medium tracking-wider text-white inline-flex items-center">
          FORECAST <span className="text-dim text-sm tracking-normal ml-2">7-Day</span>
        </h2>
      ),
      content: <ForecastSection forecast={forecast} />,
    },
  };

  return (
    <div className="max-w-[1536px] mx-auto px-5 pt-2 pb-8">
      {visibleOrder.map((id, idx) => (
        <SectionWrapper
          key={id}
          id={id}
          collapsed={collapsed[id]}
          isFirst={idx === 0}
          isLast={idx === visibleOrder.length - 1}
          onToggleCollapse={() => toggleCollapsed(id)}
          onMoveUp={() => moveUp(id)}
          onMoveDown={() => moveDown(id)}
          headerContent={sections[id].header}
          headerRight={sections[id].headerRight}
        >
          {sections[id].content}
        </SectionWrapper>
      ))}
    </div>
  );
}
