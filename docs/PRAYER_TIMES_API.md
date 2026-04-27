# Prayer Times API

## GET /api/prayer-times

**Public** (no auth required). Returns today's prayer times for Baghdad, Hijri date, and next Islamic event.

```
GET https://home.altijwal.com/api/prayer-times
```

## Response

```json
{
  "prayers": [
    { "name": "fajr",    "label": "Fajr",    "time": "3:50 AM",  "isPassed": true,  "isNext": false, "countdown": null },
    { "name": "sunrise", "label": "Sunrise", "time": "5:19 AM",  "isPassed": true,  "isNext": false, "countdown": null },
    { "name": "dhuhr",   "label": "Dhuhr",   "time": "12:05 PM", "isPassed": false, "isNext": true,  "countdown": "2h 5m" },
    { "name": "asr",     "label": "Asr",     "time": "3:45 PM",  "isPassed": false, "isNext": false, "countdown": "5h 45m" },
    { "name": "maghrib", "label": "Maghrib", "time": "6:44 PM",  "isPassed": false, "isNext": false, "countdown": "8h 44m" },
    { "name": "isha",    "label": "Isha",    "time": "8:06 PM",  "isPassed": false, "isNext": false, "countdown": "10h 6m" }
  ],
  "nextPrayer": {
    "name": "dhuhr",
    "label": "Dhuhr",
    "time": "12:05 PM",
    "countdown": "2h 5m"
  },
  "hijriDate": "Dhul-Qi'dah 9, 1447 AH",
  "nextEvent": {
    "name": "Day of Arafah",
    "isToday": false,
    "daysLeft": 30
  }
}
```

## Fields

| Field | Type | Description |
|-------|------|-------------|
| `prayers` | array | All 6 prayer times: fajr, sunrise, dhuhr, asr, maghrib, isha |
| `prayers[].name` | string | Prayer key (`fajr`, `sunrise`, `dhuhr`, `asr`, `maghrib`, `isha`) |
| `prayers[].label` | string | Display name |
| `prayers[].time` | string | Formatted 12-hour time in Baghdad timezone (Asia/Baghdad, UTC+3) |
| `prayers[].isPassed` | boolean | Whether this prayer time has already passed today |
| `prayers[].isNext` | boolean | Whether this is the next upcoming prayer |
| `prayers[].countdown` | string\|null | Time remaining (e.g. `"2h 5m"`, `"45m 12s"`, `"30s"`), `null` if passed |
| `nextPrayer` | object | The next upcoming prayer with its countdown |
| `nextPrayer.name` | string | Prayer key |
| `nextPrayer.label` | string | Display name. Shows `"Fajr (tomorrow)"` after all today's prayers have passed |
| `nextPrayer.time` | string | Formatted 12-hour time |
| `nextPrayer.countdown` | string | Time remaining until this prayer |
| `hijriDate` | string | Today's Hijri date using the Umm al-Qura calendar |
| `nextEvent` | object\|null | Next upcoming Islamic event |
| `nextEvent.name` | string | Event name |
| `nextEvent.isToday` | boolean | `true` if the event is today |
| `nextEvent.daysLeft` | number | Days until the event (0 = today) |

## Tracked Islamic Events

| Event | Hijri Date |
|-------|------------|
| Islamic New Year | 1 Muharram |
| Day of Ashura | 10 Muharram |
| Mawlid al-Nabi | 12 Rabi al-Awwal |
| Isra & Mi'raj | 27 Rajab |
| Change of Qibla | 15 Sha'ban |
| Ramadan | 1 Ramadan |
| Laylat al-Qadr | 27 Ramadan |
| Eid al-Fitr | 1 Shawwal |
| Day of Arafah | 9 Dhul Hijjah |
| Eid al-Adha | 10 Dhul Hijjah |

## Calculation Details

| Parameter | Value |
|-----------|-------|
| Coordinates | 33.321502, 44.358335 (Baghdad) |
| Method | Dubai (CalculationMethod.Dubai) |
| Adjustments | Sunrise +2min, Dhuhr +2min, Isha -6min |
| Rounding | Fajr: ceiling (conservative for fasting). Others: nearest minute |
| Calendar | islamic-umalqura (Umm al-Qura) |
| Timezone | Asia/Baghdad (UTC+3) |
