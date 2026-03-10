import { useState, useEffect, useRef } from "react";
import type { CurrentData, PowerReading } from "@/types/api";
import { REFRESH } from "@/constants/thresholds";

const POWER_REFRESH = 1000;

export function useCurrentData() {
  const [data, setData] = useState<CurrentData>({ weather: null, air: null, power: null });
  const prevRef = useRef<CurrentData>({ weather: null, air: null, power: null });

  // Weather + air at 5s
  useEffect(() => {
    let mounted = true;

    const fetchData = async () => {
      try {
        const res = await fetch("/api/current");
        const json: CurrentData = await res.json();
        if (mounted) {
          setData((prev) => {
            prevRef.current = prev;
            return { ...json, power: prev.power };
          });
        }
      } catch (e) {
        console.error("Failed to fetch current data:", e);
      }
    };

    fetchData();
    const id = setInterval(fetchData, REFRESH);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  // Power at 1s (lightweight endpoint)
  useEffect(() => {
    let mounted = true;

    const fetchPower = async () => {
      try {
        const res = await fetch("/api/current/power");
        const json: PowerReading | null = await res.json();
        if (mounted && json) {
          setData((prev) => {
            prevRef.current = prev;
            return { ...prev, power: json };
          });
        }
      } catch (e) {
        console.error("Failed to fetch power:", e);
      }
    };

    fetchPower();
    const id = setInterval(fetchPower, POWER_REFRESH);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  return { ...data, prev: prevRef.current };
}
