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
  metric: string;
  condition: "above" | "below";
  threshold: number;
  device_ids: string[] | null;
  device_names: string[] | null;
  device_id: string;
  device_name: string;
  created_at: string;
}
