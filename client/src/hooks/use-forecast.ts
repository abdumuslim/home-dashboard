import { useState, useEffect } from "react";
import type { ForecastResponse } from "@/types/forecast";

const FORECAST_REFRESH = 5 * 60 * 1000; // 5 minutes

export function useForecast() {
  const [forecast, setForecast] = useState<ForecastResponse | null>(null);

  useEffect(() => {
    let mounted = true;

    const fetchForecast = async () => {
      try {
        const res = await fetch("/api/forecast");
        if (!res.ok) return;
        const json: ForecastResponse = await res.json();
        if (mounted) setForecast(json);
      } catch (e) {
        console.error("Failed to fetch forecast:", e);
      }
    };

    fetchForecast();
    const id = setInterval(fetchForecast, FORECAST_REFRESH);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  return forecast;
}
