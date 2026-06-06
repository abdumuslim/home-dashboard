export interface PurifierDevice {
  id: string;
  name: string;
  model: string;
  isOnline: boolean;
  power?: "on" | "off";
  mode?: string;
  fan_level?: number;
  favorite_level?: number;
  aqi?: number;
  temperature?: number;
  humidity?: number;
  filter_life?: number;
  led?: boolean;
  buzzer?: boolean;
  child_lock?: boolean;
}

export interface AcProfile {
  mode: number;
  temperature: number;
  fan_speed: number;
}

export interface AutomationRangeSlot {
  id: string;
  label?: string;
  type: "all_day" | "window";
  start_mode?: "exact" | "prayer";
  start_time?: string;
  start_prayer?: string;
  start_prayer_offset?: number;
  end_mode?: "exact" | "prayer";
  end_time?: string;
  end_prayer?: string;
  end_prayer_offset?: number;
  threshold_low: number;
  threshold: number;
}

export interface AutomationRule {
  id: number;
  name: string;
  enabled: boolean;
  automation_type: "metric" | "schedule";
  device_type: "purifier" | "ac";
  action_on?: Record<string, unknown>;
  metric: string | null;
  condition: "above" | "below" | null;
  threshold: number | null;
  threshold_low: number | null;
  range_slots: AutomationRangeSlot[] | null;
  time_start: string | null;
  time_end: string | null;
  start_mode: "exact" | "prayer";
  start_prayer: string | null;
  start_prayer_offset: number | null;
  end_mode: "exact" | "prayer";
  end_prayer: string | null;
  end_prayer_offset: number | null;
  device_ids: string[] | null;
  device_names: string[] | null;
  turn_off_at_end: boolean;
  sustained_minutes: number;
  smart_leveling: boolean; // AC only — leveler owns the generator level (default true)
  device_id: string;
  device_name: string;
  created_at: string;
}
