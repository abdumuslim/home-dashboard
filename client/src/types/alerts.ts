export type AlertType = "sensor" | "prayer";
export type AlertCondition = "above" | "below";
export type PrayerTiming = "at_time" | "before";

export interface AlertRule {
  id: number;
  endpoint: string;
  alert_type: AlertType;
  metric?: string | null;
  condition?: AlertCondition | null;
  threshold?: number | null;
  prayer_timing?: PrayerTiming | null;
  prayer_minutes?: number | null;
  prayer_names?: string[] | null;
  created_at: string;
}

export interface MetricInfo {
  label: string;
  unit: string;
  group: string;
  min: number;
  max: number;
}

export interface AlertMetricsResponse {
  metrics: Record<string, MetricInfo>;
  prayerNames: string[];
}
