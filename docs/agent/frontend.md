<!-- Tier-3 agent doc. Loaded on demand via CLAUDE.md / AGENTS.md routing table. -->
# Frontend — Dashboard Layout, Card Design Language & Widgets

**TL;DR:** The React/TypeScript dashboard (Vite + Tailwind CSS v4 + Chart.js + lucide-react) renders 4 sections (Outdoor / Indoor / Air Quality / Prayer Times) across Dashboard and Charts tabs. The Indoor section is admin-only. All metric cards follow one strict design language (glass-card, hero row, absolute bottom chart). Purifier/AC controls live in vertical capsule widgets inside the Devices card. The Solar card classifies sky condition client-side with a Baghdad-calibrated Haurwitz clear-sky model.

Related docs: server-side preset/automation semantics → [ac-automations.md](ac-automations.md); TCL shadow properties and AC model quirks → [tcl-ac.md](tcl-ac.md); React performance patterns (React.memo, chart memoization, code splitting, history caching) → [architecture.md](architecture.md).

## Layout

4 sections with tabs (Dashboard / Charts). **Indoor section is admin-only** (hidden for guests):

- **Outdoor** (4-col grid): Temperature, Wind, Rainfall (+ Barometer), Solar.
- **Indoor** (5-col equal grid `md:grid-cols-5`, **admin-only**): Devices, Mom, Abdu, Kitchen, Power — all equal width. Devices card contains all 3 AC capsules (row 1) + 2 purifier capsules (row 2) with a thin divider between. Mom/Abdu are pure environmental displays (temp/humidity/feels-like + chart, no embedded widgets). Power card shows hero W/V/A from active source, then a **single-line source-stats row** (replaced the old two Grid/Gen pills 2026-07-09), then a bar chart (30-min buckets, colored by source: sky=Grid `#38bdf8`, orange=Generator `#fb923c`; AQ-style bars `barThickness: 2, borderRadius: 1`). The expanded power chart is mixed bar+line — power bars colored per source + voltage as a dashed line on a right Y-axis — and fetches its own history (doesn't use the shared OpenOverlayFn params; module-level cache); it now sits beside a **per-day grid/gen breakdown panel** (`power-breakdown-panel.tsx`).
  - **Source-stats row** (`power-card.tsx`, `flex items-center gap-x-1.5 text-[0.6rem] whitespace-nowrap ... overflow-hidden tabular-nums`): one switching `SourcePill` (Grid / Gen / "Off" when no power), then `24h <gridHours>` (value in grid sky), then `<gridAvg>/<genAvg>` (avg length of one grid/gen stretch = time between switches, last 7 days; grid sky / gen orange), then `<sessionDuration> ·~<remaining>` (colored by the **current** source — sky/orange, or gray when Off). Every value is power-colored (no white/`text-text`); only the `24h`/`/`/`·~` separators stay dim. Fed by `usePowerStats(liveSource)` → `GET /api/power/stats` (60s poll; refetches immediately on a source flip). Session duration ticks live off `sessionStartTs` (card re-renders every 1s via the power poll); the `·~remaining` estimate is hidden when the prediction is null (<2 usable sample days) or the source just switched (`stats.source !== liveSource`). **Width measured** (worst-case values ~227px): fits every card width ≥1440px fully; `overflow-hidden` + `whitespace-nowrap` means it clips gracefully (never wraps) on narrower laptops. If a sub-1440 screen needs the full row, the remaining lever is shrinking `SourcePill` to `text-[0.6rem] px-1.5` (or dropping the `24h` label). `GRID_COLOR`/`GEN_COLOR` are exported from `power-card.tsx`; `fmtDur`/`fmtHoursCompact` live in `constants/thresholds.ts`.
  - **Breakdown panel** (`power-breakdown-panel.tsx`): `GET /api/power/day-breakdown?range=` (module-level cache per range, fetched only while the overlay is open). Scrollable list of Baghdad days (label `Today`/`EEE d`, `*` = partial day) each with a stacked grid/gen mini-bar + `grid/gen` hours, and a pinned range-totals footer (`grid/gen · off <dur>`). Side panel on desktop, stacks under the chart on mobile. Both stats endpoints derive everything server-side from `power_readings` — see [architecture.md](architecture.md) "Power source stats".
- **Air Quality** (5-col grid): CO2, PM2.5, PM10, tVOC, Noise — section header shows "Qingping CGS2" with the `BatteryIndicator` component (`ui/battery-indicator.tsx`): custom SVG battery shape with percentage-proportional fill (green >=50%, amber 20-49%, red <20%), percentage text inside when discharging, lucide `Zap` icon when charging. The `batteryCharging` field is live-only (in-memory, not stored in DB), derived from MQTT `battery.status` (1=charging).
- **Prayer Times**: Daily prayer schedule (server-side `prayer-engine`, `BaghdadYMA` profile — ≤1 min vs the official جمعية الشبان المسلمين calendar). 6 prayers: Fajr, Sunrise, Dhuhr, Asr, Maghrib, Isha. The card fetches `/api/prayer-times` and ticks the countdown locally from the returned timestamps.

Purifier and AC controls live in the dedicated **Devices card** (`devices-card.tsx`) as vertical capsule widgets. `PurifierWidget` (`purifier-widget.tsx`) is a standalone component extracted from IndoorCard. `AcWidget` (`ac-widget.tsx`) accepts an optional `label` prop for the capsule header. Device matching in `indoor-section.tsx`: Najat AC → "Mom" label, Abdu AC → "Abdu" label, Abdullah AC → "Abdullah" label; purifiers matched by name ("mom"/"abdu").

### Page header & section details (extended notes)

- Page header title: "Home Dashboard" (`text-3xl`, `tracking-wide`). Tab bar: Dashboard / Charts (transparent bg, no border). Header wraps on narrow screens.
- Section headers: uppercase, `tracking-wider`, source label parenthetical and dimmed (e.g. "Indoor (WS Console)").
- **Outdoor card content** (WS-2000): Temperature card shows hi/lo today, dew point + feels like in a compact row, hourly-smoothed 24h line chart. Wind card: golden SVG compass circle + arrow + gust + max daily gust + 10-min rolling median + 24h chart. Rainfall card combines rain + barometer: SVG water drop, 6 rain accumulators, pressure with 3h trend, dual-axis chart. Solar card: radiation + UV, sky condition icon, 10-min variability detection, peak rad/UV, dual-axis chart with UV dashed line.
- **Kitchen card** (Qingping CGS2): temp, humidity, noise (colored by status) + 24h temp line chart.
- **Air Quality cards**: circular SVG progress indicators (colored by severity), bar charts showing 24h history bucketed into 1-hour intervals.
- **Responsive breakpoints**: Outdoor/Indoor grids: `grid-cols-1` (<640px) → `grid-cols-2` (sm:640px) → full cols (md:768px). AQ goes 2-col → 4-col. Hero values `text-2xl md:text-3xl`, responsive gaps, wind circle 60/72px, AQ ring 60/80px.

> **Conflicts with older notes (current layout wins):** an older memory described Indoor as a 4-col `3fr 3fr 2fr 2fr` grid with purifier/AC capsules embedded inside the Mom and Abdu cards — that layout is obsolete; all device capsules moved to the dedicated Devices card and Indoor is now 5 equal columns. The same memory listed the AQ card order as "PM2.5, PM10, tVOC, Noise, CO2 (CO2 last)"; the current order is CO2, PM2.5, PM10, tVOC, Noise.

### Severity thresholds (`constants/thresholds.ts`)

- **CO2:** Normal (≤1000), Slightly high (≤2000), High (≤3000), Very high (>3000)
- **tVOC:** Excellent (≤3), Good (≤37), Slightly high (≤120), High (≤293), Very high (>293)
- **Noise:** Low (≤50), Moderate (≤70), High (>70)

## Sky condition & solar model

The Solar card displays real-time sky condition using a theoretical clear-sky model + CSI (clear-sky index) algorithm:

- **`constants/solar-model.ts`**: Haurwitz model computes clear-sky GHI from solar geometry (lat 33.3215, lon 44.3583, date/time). Purely client-side, no API call, immune to prolonged dusty/cloudy periods unlike the old empirical 7-day reference. **Calibrated for Baghdad's dusty atmosphere** — coefficients (A=1250, k=0.43) fitted to empirical clear-sky data instead of standard clean-atmosphere values (1098, 0.057). The standard model overestimated by 40% at noon and up to 180% at low sun angles due to Baghdad's high atmospheric turbidity (Linke ~4–5).
- **`constants/sky-condition.ts`**: `getSkyCondition()` classifies into 8 states using CSI (`measured / theoretical`), variability (10-min RMS deviation from linear trend, with 15 W/m² noise floor and 200 W/m² denominator floor), rain, humidity, and dew point spread:
  - **Daytime**: Sunny (`clear-day`), Partly Cloudy (`partly-cloudy-day`), Mostly Cloudy (`overcast-day`), Cloudy (`cloudy`)
  - **Rain**: Light Rain (`drizzle`, <=2.5mm/hr), Heavy Rain (`rain`, >2.5mm/hr) — overrides cloud states
  - **Night**: Clear Night (`clear-night`, humidity <85% and dew spread >=2.5°C), Cloudy Night (`overcast-night`)
- **Icons**: Animated colored SVGs from [Meteocons](https://basmilius.github.io/weather-icons/) (MIT license, fill style) stored in `client/public/weather-icons/`. Rendered as `<img>` tags (`w-16 h-16 -my-3`), not lucide components.
- **`/api/solar-reference`** endpoint still exists on the server (computes empirical baseline from top 3 clearest days in a 7-day window) but is **no longer fetched by the frontend** — the theoretical model replaced it for sky detection. (Older notes describing the solar card icon as driven by a clearness index from `/api/solar-reference` weekly max / "avg of 3 clearest days" describe the pre-replacement behavior.)

### Calibration record (2026-03-16)

The standard Haurwitz clear-sky model (A=1098, k=0.057) assumes a clean temperate atmosphere and massively overestimates Baghdad's actual clear-sky radiation due to chronic atmospheric dust/aerosols (Linke turbidity ~4–5).

- **Symptoms:** Sky condition showed "Mostly Cloudy" on a clear afternoon (5+ hours of clear sky). At 4:34 PM, the sensor read 117 W/m² (normal), but the model predicted 297 → CSI=0.39 → "Mostly Cloudy".
- **Fix:** `client/src/constants/solar-model.ts` line 54 — changed coefficients to A=1250, k=0.43. Derived by fitting `GHI = A × cosZ × exp(-k / cosZ)` to empirical clear-sky data from `/api/solar-reference`.

**Verification data:**

| Local Time | Empirical | Old Model | Calibrated |
|---|---|---|---|
| 9:00 AM | 299 | 518 | 299 |
| 12:00 PM | 581 | 831 | 595 |
| 3:00 PM | 351 | 577 | 363 |
| 4:30 PM | 105 | 297 | 105 |

**Variability fix (same session):** the original variability used `maxDev / clearSkyGHI` — a single noisy reading dominated, and tiny denominators at low sun amplified sensor noise into false "Partly Cloudy". Replaced with:
- **RMS deviation** instead of maxDev (robust to outlier readings)
- **15 W/m² noise floor**: below this RMS, variability = 0 (sensor noise at any time of day)
- **200 W/m² denominator floor**: `rmsDev / Math.max(clearSkyGHI, 200)` prevents amplification at low sun angles
- Real clouds (40+ W/m² RMS swings) are still detected; normal sensor noise (~5-10 W/m²) is ignored

**Key details:**
- `getClearSky()` is only consumed by `getSkyCondition()` in `sky-condition.ts` → `solar-card.tsx`
- The dashed line on the solar chart is UV Index (right y-axis), NOT a theoretical reference line
- `/api/solar-reference` times are in **local Baghdad time**, not UTC
- At very low sun angles (<5°), the calibrated model gives <1 W/m² → the classifier returns `null` (acceptable)
- May need seasonal re-check: summer has more dust (higher turbidity) but also higher sun angles — effects may partially cancel

**Night thresholds fix (same session):** original thresholds (humidity >= 70 OR dew spread < 4°C) were too aggressive for Baghdad — after rain, humidity stays 70-80% on clear nights. Tightened to humidity >= 85% OR dew spread < 2.5°C. The 2.5°C dew depression is the standard meteorological cloud indicator.

**Why:** The standard Haurwitz model is designed for clean mid-latitude atmospheres. Baghdad's arid climate with chronic dust requires much higher atmospheric extinction. Night thresholds also needed Baghdad-specific tuning.
**How to apply:** If sky condition seems inaccurate again in a different season, re-validate against `/api/solar-reference` empirical data. The coefficients may need seasonal adjustment if summer accuracy degrades. Night thresholds may also need summer adjustment (Baghdad summer nights can be very dry → current thresholds should work fine).

## Card design language

All metric cards follow a consistent design language established in the Temperature and Wind cards.

### Theme & typography

- **Font:** Inter from Google Fonts CDN.
- **Theme:** Glassmorphism — radial gradient background (purple/blue tints on `#0b0f1a`), glass-card with `backdrop-filter: blur(12px)`, `rgba(255,255,255,0.05)` background, 1px white/10% border.
- **Flash animation:** cyan glow on value change.

### Layout structure

- **Title:** `h3` with `text-[0.95rem] font-medium text-text mb-2`
- **Hero row:** 1-2 primary values side by side, `flex items-baseline gap-8 mb-2`
  - Value: `text-3xl font-semibold leading-none tracking-tight` with a distinct color per metric
  - Unit: `text-xl` inline with value (e.g. `°C`, `%`) or `text-sm text-dim` separated (e.g. `km/h`)
  - Label below: `text-[0.75rem] text-text font-medium mt-1`
- **Secondary row:** compact supporting info, `flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim`
  - Values highlighted with `text-text font-medium`
- **Content spacing:** `mb-[100px]` on content div to reserve space for the chart below
- **Chart:** absolute-positioned at bottom, `h-[100px]`, `z-0 rounded-b-xl overflow-hidden`, `px-2 pb-1`

### Card container

- Uses the `MetricCard` component (glass-card, `min-h-[220px]`, `relative overflow-hidden` — the chart is absolute-positioned at the bottom, 100px height)
- Or raw `div.glass-card` for cards not using MetricCard (indoor, AQ)
- `p-4 pb-0 flex flex-col` on MetricCard className

### Devices card

- No title/header — compact layout with AC capsules row + divider + purifier capsules row.
- Uses `MetricCard` wrapper with `p-3 flex flex-col justify-center gap-2`.
- AC row: `flex items-start justify-center gap-3` (no wrap — always single row).
- Purifier row: `flex items-start justify-center gap-3 flex-wrap`.
- `DevicesCard` exports `AcEntry` and `PurifierEntry` interfaces consumed by `IndoorSection`.

### Wind card specifics

- Speed + 10Min Med as hero values (`text-3xl`).
- Dual-arrow compass (72px): cyan filled arrow = current direction, amber outline arrow = 10-min mean direction, snapped to 16 compass points (22.5°), direction label (cyan) inside.
- Gust + Max in the secondary row. Trailing 10-min window for both speed median and direction mean.
- 30-min median-bucketed chart with monotone interpolation.

### Solar card specifics

- Radiation (yellow `#ffc107`) + UV Index (threshold-colored) hero row, sky condition icon on the right (see Sky condition section — Meteocons SVGs, formerly lucide Sun/CloudSun/Cloud driven by `/api/solar-reference`).
- Detrended 10-min variability for cloud detection, peak rad + peak UV secondary row.
- Dual-axis chart (solar radiation yellow left + UV orange dashed right), memoized chart data/options to prevent re-animation.

## Widgets

### Purifier widget

- Standalone component (`purifier-widget.tsx`) — vertical capsule matching the AC widget design.
- Displays: label header, power/settings buttons, AQI status pill (with inline colored filter life %), `PurifierDetailOverlay` portal.
- Filter life shown as colored percentage text (green ≥20%, red <20%) inline with AQI — no progress bar.
- Detail overlay: mode selector, fan speed, LED/Buzzer/Child Lock toggles.

### AC widget

- Vertical capsule (`ac-widget.tsx`) matching the purifier design language.
- Header label: `{label ?? "AC"}` — title-case, `text-[0.65rem] text-text/70 font-bold tracking-wider` (no `uppercase`).
- Mode-based color theming: Auto=emerald, Cool=sky, Dry=teal, Fan=slate, Heat=red.
- Main capsule row 2: two-column layout — left=target temp, right=fan speed + generator indicator.
- Detail overlay (portal): temp +/- controls (0.5° step for Najat, 1° for others), mode selector (5 icons), fan speed (Auto + 1-7 single row; Abdu: 1=silent/7=max via silenceSwitch/turbo), vertical/horizontal swing selectors (swing modes + fixed positions with SVG dot indicators), toggles (ECO, Turbo, Screen, Beep, Fresh Air for Najat only), generator mode.
- **Beep off is sticky**: turning the Beep toggle off records a persistent pref (`ac_beep_off` table) that the collector re-enforces whenever the beep comes back on (firmware resets it after AC power-loss restarts); turning it on releases the pref. Server-side enforcement details → [ac-automations.md](ac-automations.md).
- Allowed commands: `set_power`, `set_mode`, `set_temperature`, `set_fan_speed`, `set_eco`, `set_screen`, `set_sleep`, `set_vertical_swing`, `set_horizontal_swing`, `set_turbo`, `set_fresh_air`, `set_generator_mode`.
- **Last state restore**: on power-on, the backend restores all saved properties (mode, temp, fan, swing, etc.) from `/app/data/ac-last-state.json`; state is saved on every shadow poll while the device is on. Details → [tcl-ac.md](tcl-ac.md).
- **Two AC models with different shadow properties** (Najat TAC-24CHSA vs Abdu TAC-12CHSD, detected via `autoGeneratorMode` presence in shadow) — full shadow property mapping (`windSpeed7Gear`, `verticalWind`/`horizontalWind`, `newWindSwitch` vs `windSpeed`, `verticalSwitch`/`horizontalSwitch`, `ECO`, `turbo`, `silenceSwitch`) → [tcl-ac.md](tcl-ac.md).

### Timer UI

- Server-side countdown (visible even when the AC is off). Compact countdown indicator on the capsule (green=turn-on, red=turn-off).
- Detail overlay has a timer section with on/off toggle, duration pills (15m–4h), and an optional preset for turn-on timers.
- `useAcTimers()` hook polls `/api/ac/timers` every 5s. Timer props flow: IndoorSection → DevicesCard → AcWidget → AcDetailOverlay.
- Timer server semantics (manual-off locks, leveler interaction) → [ac-automations.md](ac-automations.md).

## Presets UI

- **10 slots per device** (was 5 until 2026-06-06), stored server-side in the `ac_presets` PostgreSQL table (shared across all browsers/devices). `PresetData` captures 10 properties (mode, targetTemp, fanSpeed, eco, turbo, screen, verticalSwing, horizontalSwing, freshAir, generatorMode). Slot count derives from the `PRESET_COUNT`/`PRESET_SLOTS` constants in `ac-widget.tsx` — **never hardcode `[1,2,3,4,5]` arrays**. One-time migration from localStorage on first overlay open. Preset API routes and apply/sync-to-automations semantics → [ac-automations.md](ac-automations.md).
- **UI (5×2 grid of detail cards)**: each filled card shows slot number, mode icon + target temp (tinted with the *preset's* mode color via `getModeColors(p.mode)`), fan label (Wind icon + `A`/1–7 via `fanLabel()`), and generator level (Zap icon + number, only when > 0). Empty slots show a dim `—`. The Save button sits in the section header.
- **Direct apply (no Apply button)**: tapping a filled card immediately runs `applyPreset()` — diff-and-send of only changed properties, mode first / fan speed last (firmware quirk), then a fire-and-forget `POST /api/ac/preset-apply`. While in flight, the tapped card glows in its preset's mode color and other slots are disabled (`applyingPreset` state). The old stage-then-apply flow (`stagedValues`/`activePreset`, dashed staging outlines, dimmed staged temp preview) was removed entirely (2026-06-06).
- **Active-match highlight**: `presetMatchesCurrent(p, d)` marks a card as "current" (ring + check badge in the preset's mode color) when its **4 visible** props match the device — mode, targetTemp (compared on 0.5° rounding), fanSpeed, generatorMode. Hidden props (eco/turbo/screen/swings/freshAir) are intentionally ignored (user choice: remote tweaks to those shouldn't kill the highlight). Returns false when the AC is off.

## Charts

### Chart defaults

- Line charts: `borderWidth: 2, pointRadius: 0, tension: 0.4, cubicInterpolationMode: "monotone", fill: true`
- Bar charts: `borderRadius: 2` (or 1 for AQ), colored per severity
- Smoothing: range-adaptive bucketing — 6h/24h/48h: 5-min buckets, 1w: 1-hr buckets, 30d: server hourly avg → frontend 3-hr buckets. Three bucket functions: `bucketAverage`, `bucketMedian` (wind), `bucketMax`. See `constants/chart-utils.ts`.
- X-axis: `type: "time"`, unit/stepSize adapts per range (hour for short ranges, day for long). For the 24h range: hourly ticks (24), no rotation, 12h-format tooltips.
- Y-axis: `position: "left"`, subtle grid `rgba(255,255,255,0.05)`

### Charts tab & data flow

- The Charts tab is lazy-loaded, with 6 Chart.js charts and a range selector.
- Embedded dashboard sparkline data flow: `App.tsx` → `useHistoryData("24h")` fetches both weatherHistory & airHistory → `DashboardTab` receives both history arrays (always rendered, not conditional on tab) → `OutdoorSection` passes weatherHistory to the Temperature/Wind/Solar/Rainfall cards → `IndoorSection` passes weatherHistory to the Mom/Abdu cards and airHistory to the Kitchen card (with a `metricKey` prop) → `AirQualitySection` passes airHistory to all AQ cards → each card renders its own Chart.js sparkline from the history data.
- Chart memoization/caching specifics → [architecture.md](architecture.md).

## Colors

- **Primary metric:** cyan `#00d4ff` (temp uses CSS gradient text via `getTempGradientStyle()` — 14-range scale)
- **Secondary metric:** white `text-white` or a complementary color (e.g. amber `#f59e0b` for wind median)
- **Pressure/Baro:** emerald `#10b981` (value + chart line)
- **Rain drop SVG:** blue `#2196ff` (stroke + fill)
- **Labels:** `text-text` (light gray)
- **Dim text/units:** `text-dim`
- **Chart fill:** primary color at 15% opacity
- **AQ severity colors:** excellent/good=`#1bd929`, normal/low=`#0df41e`, moderate/slightly_high=`#fbbf24`, poor/high=`#f97316`, very_high=`#9f1239`, severe=`#ef4444`, extreme=`#9333ea`
- **Temp colors — older 9-grade scale** via `getTempColor()`: ≤0=`#60a5fa` (blue), ≤5=`#38bdf8` (sky), ≤10=`#22d3ee` (cyan), ≤18=`#4ade80` (green), ≤26=`#a3e635` (lime), ≤32=`#facc15` (yellow), ≤40=`#fb923c` (orange), ≤49=`#fb7185` (rose), ≥50=`#c084fc` (purple). Note: the current temperature hero uses the 14-range `getTempGradientStyle()` gradient (CLAUDE.md is authoritative); the 9-grade `getTempColor()` table is the older scale recorded in memory notes.

## Hooks & update intervals

### Client source map (annotations from the project-structure tree)

- `client/src/hooks/` — useCurrentData, useHistoryData, useClock, useFlash, useAlerts, usePushNotifications, useDevices, useAcDevices, useAutomations, useAuth, useForecast, useModalSections (bell-modal collapse state, localStorage), useAcLeveling (polls `/api/ac/leveling` 5s while expanded), useAcCalibration (polls `/api/ac/calibration` 3s while expanded), useUnits (unit-preference context + converters, localStorage), usePrayerTimes (fetches `/api/prayer-times` once per Baghdad day, ticks countdown locally from timestamps; Hijri date/events local via Intl — no client-side prayer math), useSectionLayout (section order/collapse state, localStorage), useChartsVisible (global charts show/hide toggle, localStorage)
- `client/src/components/` — Header, sections, cards (devices-card, indoor-card, power-card), purifier-widget, ac-widget, charts, AlertsModal, ui/battery-indicator, ui/collapsible-modal-section (chevron + 0fr/1fr grid collapse), ui/ac-leveling-section (leveling config + live status), ui/ac-calibration-panel (calibration selection/progress/results/apply)
- `client/src/types/` — API type definitions (api.ts, alerts.ts, automations.ts, ac.ts, forecast.ts, leveling.ts)
- `client/src/constants/` — Thresholds, directions, helpers, alert-metrics, solar-model, sky-condition, chart-utils, forecast-utils

### Frontend update intervals

- Current readings: fetched every 5 seconds
- Charts: fetched every 60 seconds
- Live clock + "ago" counters: tick every 1 second
- Cards flash cyan glow when values change

Additional polling cadences referenced elsewhere in this doc: AC device state `/api/ac/devices` every 10s, `useAcTimers()` every 5s, `useAcLeveling(active)` every 5s while its modal section is expanded, `useAcCalibration(active)` every 3s while expanded.
