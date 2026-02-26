import { useState, useEffect } from "react";
import type { WeatherReading, AirReading, TimeRange } from "@/types/api";
import { CHART_REFRESH } from "@/constants/thresholds";

export function useHistoryData(range: TimeRange, active: boolean) {
  const [weatherHistory, setWeatherHistory] = useState<WeatherReading[]>([]);
  const [airHistory, setAirHistory] = useState<AirReading[]>([]);

  useEffect(() => {
    let mounted = true;

    const fetchHistory = async () => {
      try {
        const [wr, ar] = await Promise.all([
          fetch(`/api/history?source=weather&range=${range}`),
          fetch(`/api/history?source=air&range=${range}`),
        ]);
        const w = await wr.json();
        const a = await ar.json();
        if (mounted) {
          setWeatherHistory(w.data || []);
          setAirHistory(a.data || []);
        }
      } catch (e) {
        console.error("Failed to fetch history:", e);
      }
    };

    // Always fetch for pressure trend (even on dashboard tab)
    fetchHistory();
    const id = setInterval(fetchHistory, CHART_REFRESH);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [range, active]);

  return { weatherHistory, airHistory };
}
