import { createElement, createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import {
  type UnitPreferences,
  DEFAULT_UNITS,
  STORAGE_KEY,
  TEMP_LABELS,
  PRESSURE_LABELS,
  WIND_LABELS,
  RAIN_RATE_LABELS,
  RAIN_ACCUM_LABELS,
  SOLAR_LABELS,
  TEMP_DECIMALS,
  PRESSURE_DECIMALS,
  WIND_DECIMALS,
  RAIN_DECIMALS,
  SOLAR_DECIMALS,
  convertTemp,
  convertTempDelta,
  convertPressure,
  convertWindSpeed,
  convertRainfall,
  convertSolar,
} from "@/constants/units";
import { fmt } from "@/constants/thresholds";

interface UnitsContextValue {
  units: UnitPreferences;
  setUnits: (u: UnitPreferences) => void;

  // Raw converters (metric → selected unit)
  temp: (v: number | null | undefined) => number | null;
  tempDelta: (v: number | null | undefined) => number | null;
  pressure: (v: number | null | undefined) => number | null;
  wind: (v: number | null | undefined) => number | null;
  rain: (v: number | null | undefined) => number | null;
  solar: (v: number | null | undefined) => number | null;

  // Format helpers: convert + toFixed with proper decimals
  fmtTemp: (v: number | null | undefined) => string;
  fmtPressure: (v: number | null | undefined) => string;
  fmtWind: (v: number | null | undefined) => string;
  fmtRain: (v: number | null | undefined) => string;
  fmtSolar: (v: number | null | undefined) => string;

  // Label strings
  tempLabel: string;
  pressureLabel: string;
  windLabel: string;
  rainLabel: string;
  rainAccumLabel: string;
  solarLabel: string;
}

const UnitsContext = createContext<UnitsContextValue | null>(null);

function loadUnits(): UnitPreferences {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return { ...DEFAULT_UNITS, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return DEFAULT_UNITS;
}

export function UnitsProvider({ children }: { children: ReactNode }) {
  const [units, setUnitsState] = useState<UnitPreferences>(loadUnits);

  const setUnits = useCallback((u: UnitPreferences) => {
    setUnitsState(u);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
  }, []);

  // Cross-tab sync
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        try { setUnitsState({ ...DEFAULT_UNITS, ...JSON.parse(e.newValue) }); } catch { /* ignore */ }
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const temp = useCallback(
    (v: number | null | undefined) => (v != null ? convertTemp(v, units.temperature) : null),
    [units.temperature],
  );
  const tempDeltaFn = useCallback(
    (v: number | null | undefined) => (v != null ? convertTempDelta(v, units.temperature) : null),
    [units.temperature],
  );
  const pressure = useCallback(
    (v: number | null | undefined) => (v != null ? convertPressure(v, units.pressure) : null),
    [units.pressure],
  );
  const wind = useCallback(
    (v: number | null | undefined) => (v != null ? convertWindSpeed(v, units.windSpeed) : null),
    [units.windSpeed],
  );
  const rain = useCallback(
    (v: number | null | undefined) => (v != null ? convertRainfall(v, units.rainfall) : null),
    [units.rainfall],
  );
  const solarFn = useCallback(
    (v: number | null | undefined) => (v != null ? convertSolar(v, units.solar) : null),
    [units.solar],
  );

  const fmtTemp = useCallback(
    (v: number | null | undefined) => (v != null ? fmt(convertTemp(v, units.temperature), TEMP_DECIMALS[units.temperature]) : "--"),
    [units.temperature],
  );
  const fmtPressure = useCallback(
    (v: number | null | undefined) => (v != null ? fmt(convertPressure(v, units.pressure), PRESSURE_DECIMALS[units.pressure]) : "--"),
    [units.pressure],
  );
  const fmtWind = useCallback(
    (v: number | null | undefined) => (v != null ? fmt(convertWindSpeed(v, units.windSpeed), WIND_DECIMALS[units.windSpeed]) : "--"),
    [units.windSpeed],
  );
  const fmtRain = useCallback(
    (v: number | null | undefined) => (v != null ? fmt(convertRainfall(v, units.rainfall), RAIN_DECIMALS[units.rainfall]) : "--"),
    [units.rainfall],
  );
  const fmtSolar = useCallback(
    (v: number | null | undefined) => (v != null ? fmt(convertSolar(v, units.solar), SOLAR_DECIMALS[units.solar]) : "--"),
    [units.solar],
  );

  const value: UnitsContextValue = {
    units,
    setUnits,
    temp,
    tempDelta: tempDeltaFn,
    pressure,
    wind,
    rain,
    solar: solarFn,
    fmtTemp,
    fmtPressure,
    fmtWind,
    fmtRain,
    fmtSolar,
    tempLabel: TEMP_LABELS[units.temperature],
    pressureLabel: PRESSURE_LABELS[units.pressure],
    windLabel: WIND_LABELS[units.windSpeed],
    rainLabel: RAIN_RATE_LABELS[units.rainfall],
    rainAccumLabel: RAIN_ACCUM_LABELS[units.rainfall],
    solarLabel: SOLAR_LABELS[units.solar],
  };

  return createElement(UnitsContext.Provider, { value }, children);
}

export function useUnits(): UnitsContextValue {
  const ctx = useContext(UnitsContext);
  if (!ctx) throw new Error("useUnits must be used within UnitsProvider");
  return ctx;
}
