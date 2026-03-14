import { useState, useEffect, useRef } from "react";
import type { WeatherReading, AirReading, PowerReading, TimeRange } from "@/types/api";
import { CHART_REFRESH } from "@/constants/thresholds";

interface HistoryCache {
  weather: WeatherReading[];
  air: AirReading[];
  power: PowerReading[];
}

export function useHistoryData(range: TimeRange, active: boolean) {
  const [weatherHistory, setWeatherHistory] = useState<WeatherReading[]>([]);
  const [airHistory, setAirHistory] = useState<AirReading[]>([]);
  const [powerHistory, setPowerHistory] = useState<PowerReading[]>([]);
  const cacheRef = useRef<Map<TimeRange, HistoryCache>>(new Map());

  useEffect(() => {
    if (!active) return;
    let mounted = true;

    // Restore from cache immediately on range switch
    const cached = cacheRef.current.get(range);
    if (cached) {
      setWeatherHistory(cached.weather);
      setAirHistory(cached.air);
      setPowerHistory(cached.power);
    }

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
          const weather = w.data || [];
          const air = a.data || [];
          const power = p.data || [];
          setWeatherHistory(weather);
          setAirHistory(air);
          setPowerHistory(power);
          cacheRef.current.set(range, { weather, air, power });
        }
      } catch (e) {
        console.error("Failed to fetch history:", e);
      }
    };

    fetchHistory();
    const id = setInterval(fetchHistory, CHART_REFRESH);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [range, active]);

  return { weatherHistory, airHistory, powerHistory };
}
