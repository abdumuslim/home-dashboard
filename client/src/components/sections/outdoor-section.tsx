import type { WeatherReading, OpenOverlayFn } from "@/types/api";
import { TemperatureCard } from "@/components/cards/temperature-card";
import { WindCard } from "@/components/cards/wind-card";
import { RainfallCard } from "@/components/cards/rainfall-card";
import { SolarCard } from "@/components/cards/solar-card";

interface OutdoorSectionProps {
  weather: WeatherReading | null;
  weatherHistory: WeatherReading[];
  openOverlay: OpenOverlayFn;
}

export function OutdoorSection({ weather, weatherHistory, openOverlay }: OutdoorSectionProps) {
  return (
    <section className="mb-6">
      <div className="px-0.5 pt-5 pb-3">
        <h2 className="text-base font-medium tracking-wider text-white">OUTDOOR <span className="text-dim text-sm tracking-normal ml-1">(WS-2000)</span></h2>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <TemperatureCard
          temp={weather?.temp_c}
          humidity={weather?.humidity}
          dewPoint={weather?.dew_point_c}
          feelsLike={weather?.feels_like_c}
          weatherHistory={weatherHistory}
          openOverlay={openOverlay}
        />
        <WindCard
          speed={weather?.wind_speed_kmh}
          gust={weather?.wind_gust_kmh}
          maxDailyGust={weather?.max_daily_gust_kmh}
          dir={weather?.wind_dir}
          weatherHistory={weatherHistory}
          openOverlay={openOverlay}
        />
        <RainfallCard
          hourly={weather?.rain_hourly_mm}
          event={weather?.rain_event_mm}
          daily={weather?.rain_daily_mm}
          weekly={weather?.rain_weekly_mm}
          monthly={weather?.rain_monthly_mm}
          yearly={weather?.rain_yearly_mm}
          lastRain={weather?.last_rain}
          pressure={weather?.pressure_rel_hpa}
          weatherHistory={weatherHistory}
          openOverlay={openOverlay}
        />
        <SolarCard
          radiation={weather?.solar_radiation}
          uvIndex={weather?.uv_index}
          weatherHistory={weatherHistory}
          openOverlay={openOverlay}
        />
      </div>
    </section>
  );
}
