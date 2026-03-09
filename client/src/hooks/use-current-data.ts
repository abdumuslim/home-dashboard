import { useState, useEffect, useRef } from "react";
import type { CurrentData } from "@/types/api";
import { REFRESH } from "@/constants/thresholds";

export function useCurrentData() {
  const [data, setData] = useState<CurrentData>({ weather: null, air: null, power: null });
  const prevRef = useRef<CurrentData>({ weather: null, air: null, power: null });

  useEffect(() => {
    let mounted = true;

    const fetchData = async () => {
      try {
        const res = await fetch("/api/current");
        const json: CurrentData = await res.json();
        if (mounted) {
          setData((prev) => {
            prevRef.current = prev;
            return json;
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

  return { ...data, prev: prevRef.current };
}
