import type { WeatherReading } from "@/types/api";
import { TemperatureCard } from "@/components/cards/temperature-card";
import { WindCard } from "@/components/cards/wind-card";
import { RainfallCard } from "@/components/cards/rainfall-card";
import { SolarCard } from "@/components/cards/solar-card";

interface OutdoorSectionProps {
  weather: WeatherReading | null;
  weatherHistory: WeatherReading[];
}

export function OutdoorSection({ weather, weatherHistory }: OutdoorSectionProps) {
  return (
    <section className="mb-6">
      <div className="flex justify-between items-baseline px-0.5 pt-3 pb-2">
        <h2 className="text-base font-semibold">Outdoor</h2>
        <span className="text-[0.75rem] text-dim">WS-2000</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <TemperatureCard
          temp={weather?.temp_c}
          humidity={weather?.humidity}
          dewPoint={weather?.dew_point_c}
          feelsLike={weather?.feels_like_c}
        />
        <WindCard
          speed={weather?.wind_speed_kmh}
          gust={weather?.wind_gust_kmh}
          dir={weather?.wind_dir}
        />
        <RainfallCard
          hourly={weather?.rain_hourly_mm}
          daily={weather?.rain_daily_mm}
          monthly={weather?.rain_monthly_mm}
          pressure={weather?.pressure_rel_hpa}
          weatherHistory={weatherHistory}
        />
        <SolarCard
          radiation={weather?.solar_radiation}
          uvIndex={weather?.uv_index}
        />
      </div>
    </section>
  );
}
