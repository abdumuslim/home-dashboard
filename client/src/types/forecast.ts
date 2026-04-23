export interface ForecastResponse {
  generated_at: string;
  hourly: {
    time: string[];
    temperature: (number | null)[];
    humidity: (number | null)[];
    dew_point: (number | null)[];
    feels_like: (number | null)[];
    pressure: (number | null)[];
    wind_speed: (number | null)[];
    wind_direction: (number | null)[];
    wind_gusts: (number | null)[];
    solar_radiation: (number | null)[];
    uv_index: (number | null)[];
    cloud_cover: (number | null)[];
    precip_probability: (number | null)[];
    precipitation: (number | null)[];
    weather_code: (number | null)[];
  };
  daily: {
    date: string[];
    temp_max: (number | null)[];
    temp_min: (number | null)[];
    sunrise: string[];
    sunset: string[];
    precip_sum: (number | null)[];
    precip_probability_max: (number | null)[];
    uv_index_max: (number | null)[];
    wind_speed_max: (number | null)[];
    weather_code: (number | null)[];
  };
}
