import { useState, useEffect } from "react";
import type { WeatherReading, AirReading, PowerReading, TimeRange } from "@/types/api";
import { CHART_REFRESH } from "@/constants/thresholds";

export function useHistoryData(range: TimeRange, active: boolean) {
  const [weatherHistory, setWeatherHistory] = useState<WeatherReading[]>([]);
  const [airHistory, setAirHistory] = useState<AirReading[]>([]);
  const [powerHistory, setPowerHistory] = useState<PowerReading[]>([]);

  useEffect(() => {
    let mounted = true;

    const fetchHistory = async () => {
      try {
        const [wr, ar, pr] = await Promise.all([
          fetch(`/api/history?source=weather&range=${range}`),
          fetch(`/api/history?source=air&range=${range}`),
          fetch(`/api/history?source=power&range=${range}`),
        ]);
        const w = await wr.json();
        const a = await ar.json();
        const p = await pr.json();
        if (mounted) {
          setWeatherHistory(w.data || []);
          setAirHistory(a.data || []);
          setPowerHistory(p.data || []);
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

  return { weatherHistory, airHistory, powerHistory };
}
