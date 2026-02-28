import { Home, User, CookingPot } from "lucide-react";
import type { WeatherReading, AirReading } from "@/types/api";
import { IndoorCard } from "@/components/cards/indoor-card";

interface IndoorSectionProps {
  weather: WeatherReading | null;
  air: AirReading | null;
  weatherHistory: WeatherReading[];
  airHistory: AirReading[];
}

export function IndoorSection({ weather, air, weatherHistory, airHistory }: IndoorSectionProps) {
  return (
    <section className="mb-6">
      <div className="px-0.5 pt-5 pb-3">
        <h2 className="text-base font-medium tracking-wider text-white">INDOOR</h2>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <IndoorCard
          title="Mom"
          icon={<Home className="w-full h-full" />}
          iconColor="blue"
          temp={weather?.temp_indoor_c}
          humidity={weather?.humidity_indoor}
          dewPoint={weather?.dew_point_indoor_c}
          feelsLike={weather?.feels_like_indoor_c}
          history={weatherHistory}
          metricKey="temp_indoor_c"
        />
        <IndoorCard
          title="Abdu"
          icon={<User className="w-full h-full" />}
          iconColor="purple"
          temp={weather?.temp_ch8_c}
          humidity={weather?.humidity_ch8}
          dewPoint={weather?.dew_point_ch8_c}
          feelsLike={weather?.feels_like_ch8_c}
          history={weatherHistory}
          metricKey="temp_ch8_c"
        />
        <IndoorCard
          title="Kitchen"
          icon={<CookingPot className="w-full h-full" />}
          iconColor="green"
          temp={air?.temperature}
          humidity={air?.humidity}
          noise={air?.noise}
          history={airHistory}
          metricKey="temperature"
        />
      </div>
    </section>
  );
}
