export interface PurifierDevice {
  id: string;
  name: string;
  model: string;
  isOnline: boolean;
  power?: "on" | "off";
  mode?: string;
  favorite_level?: number;
  aqi?: number;
  temperature?: number;
  humidity?: number;
  filter_life?: number;
  led?: boolean;
  buzzer?: boolean;
  child_lock?: boolean;
}

export interface AutomationRule {
  id: number;
  name: string;
  enabled: boolean;
  automation_type: "metric" | "schedule";
  metric: string | null;
  condition: "above" | "below" | null;
  threshold: number | null;
  time_start: string | null;
  time_end: string | null;
  device_ids: string[] | null;
  device_names: string[] | null;
  turn_off_at_end: boolean;
  sustained_minutes: number;
  device_id: string;
  device_name: string;
  created_at: string;
}
