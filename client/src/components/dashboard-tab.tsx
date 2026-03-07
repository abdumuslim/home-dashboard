import type { ReactNode } from "react";
import type { WeatherReading, AirReading, OpenOverlayFn } from "@/types/api";
import { useSectionLayout, type SectionId } from "@/hooks/use-section-layout";
import { useDevices } from "@/hooks/use-devices";
import { useAcDevices } from "@/hooks/use-ac-devices";
import { SectionWrapper } from "./ui/section-wrapper";
import { OutdoorSection } from "./sections/outdoor-section";
import { IndoorSection } from "./sections/indoor-section";
import { AirQualitySection } from "./sections/air-quality-section";
import { PrayerSectionHeader, PrayerSectionContent } from "./sections/prayer-section";

interface DashboardTabProps {
  weather: WeatherReading | null;
  air: AirReading | null;
  weatherHistory: WeatherReading[];
  airHistory: AirReading[];
  openOverlay: OpenOverlayFn;
}

export function DashboardTab({ weather, air, weatherHistory, airHistory, openOverlay }: DashboardTabProps) {
  const { order, collapsed, toggleCollapsed, moveUp, moveDown } = useSectionLayout();
  const { devices, sendControl } = useDevices();
  const { devices: acDevices, sendControl: acSendControl } = useAcDevices();

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
        />
      ),
    },
    "air-quality": {
      header: (
        <h2 className="text-base font-medium tracking-wider text-white">
          AIR QUALITY{" "}
          <span className="text-dim text-[0.85rem] tracking-normal ml-2">
            Qingping CGS1 {air?.battery ?? "--"}%
          </span>
        </h2>
      ),
      content: <AirQualitySection air={air} airHistory={airHistory} openOverlay={openOverlay} />,
    },
    prayer: {
      header: <PrayerSectionHeader />,
      content: <PrayerSectionContent />,
    },
  };

  return (
    <div className="max-w-[1440px] mx-auto px-5 pt-2 pb-8">
      {order.map((id, idx) => (
        <SectionWrapper
          key={id}
          id={id}
          collapsed={collapsed[id]}
          isFirst={idx === 0}
          isLast={idx === order.length - 1}
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
