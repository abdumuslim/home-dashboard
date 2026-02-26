import { useState, useEffect, useRef } from "react";

export function useFlash(currentValue: string | number | null | undefined) {
  const prevRef = useRef<string | undefined>(undefined);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    const current = String(currentValue ?? "--");
    if (prevRef.current !== undefined && prevRef.current !== current) {
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), 800);
      return () => clearTimeout(timer);
    }
    prevRef.current = current;
  }, [currentValue]);

  return flash;
}
