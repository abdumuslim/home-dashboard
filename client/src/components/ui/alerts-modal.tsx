import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, Trash2, Pencil, Bell, BellOff, Plus, Loader2, Clock, Activity, Snowflake } from "lucide-react";
import { Coordinates, CalculationMethod, PrayerTimes, Rounding } from "adhan";
import { cn } from "@/lib/utils";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { useAlerts } from "@/hooks/use-alerts";
import { useAutomations } from "@/hooks/use-automations";
import { useDevices } from "@/hooks/use-devices";
import { useAcDevices } from "@/hooks/use-ac-devices";
import { ALERT_METRICS, PRAYER_NAMES, PRAYER_LABELS } from "@/constants/alert-metrics";
import type { AlertCondition, PrayerTiming, AlertRule, MetricInfo } from "@/types/alerts";
import type { PurifierDevice, AutomationRule, AutomationRangeSlot } from "@/types/automations";
import type { AcDevice } from "@/types/ac";

function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("animate-spin", className)} />;
}

function describeAlert(alert: AlertRule, metrics: Record<string, MetricInfo>): string {
  if (alert.alert_type === "sensor" && alert.metric) {
    const m = metrics[alert.metric];
    const label = m?.label ?? alert.metric;
    const unit = m?.unit ? ` ${m.unit}` : "";
    return `${label} ${alert.condition} ${alert.threshold}${unit}`;
  }
  if (alert.alert_type === "prayer" && alert.prayer_names) {
    const names = alert.prayer_names.map((n) => PRAYER_LABELS[n] ?? n).join(", ");
    if (alert.prayer_timing === "at_time") return `${names} — at time`;
    return `${names} — ${alert.prayer_minutes} min before`;
  }
  return "Unknown alert";
}

interface AlertsModalProps {
  onClose: () => void;
  isAdmin?: boolean;
}

// Only AQ metrics relevant for purifier triggers (exclude noise, temp, humidity)
const TRIGGER_METRICS: Record<string, MetricInfo> = Object.fromEntries(
  Object.entries(ALERT_METRICS).filter(
    ([k, v]) => v.group === "Air Quality" && !["noise", "temperature_air", "humidity_air"].includes(k),
  ),
);

const FEELS_LIKE_MAP: Record<string, string> = {
  temp_indoor_c: "feels_like_indoor_c",
  temp_ch8_c: "feels_like_ch8_c",
};
const REVERSE_FEELS_LIKE: Record<string, string> = Object.fromEntries(
  Object.entries(FEELS_LIKE_MAP).map(([k, v]) => [v, k]),
);

const AC_TRIGGER_METRICS: Record<string, MetricInfo> = Object.fromEntries(
  Object.entries(ALERT_METRICS).filter(
    ([k, v]) => (v.group === "Indoor" || (v.group === "Air Quality" && !["noise", "humidity_air"].includes(k)))
      && !(k in REVERSE_FEELS_LIKE),
  ),
);

const AC_MODE_NAMES = ["Auto", "Cool", "Dry", "Fan", "Heat"] as const;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTES_PER_DAY = 1440;
const BAGHDAD = new Coordinates(33.321502, 44.358335);
const PRAYER_PARAMS = CalculationMethod.Dubai();
PRAYER_PARAMS.adjustments = { fajr: 0, sunrise: 2, dhuhr: 2, asr: 0, maghrib: 0, isha: -6 };
PRAYER_PARAMS.rounding = Rounding.None;

function createRangeSlot(overrides: Partial<AutomationRangeSlot> = {}): AutomationRangeSlot {
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `slot-${Date.now()}`,
    type: "window",
    start_mode: "exact",
    start_time: "08:00",
    end_mode: "exact",
    end_time: "12:00",
    threshold_low: 22,
    threshold: 26,
    ...overrides,
  };
}

function rangeSlotsFromRule(rule: AutomationRule | null): AutomationRangeSlot[] {
  if (rule?.device_type === "ac" && rule.automation_type === "metric") {
    if (rule.range_slots?.length) return rule.range_slots;
    if (rule.threshold_low != null && rule.threshold != null) {
      return [createRangeSlot({ id: "default", type: "all_day", threshold_low: rule.threshold_low, threshold: rule.threshold })];
    }
  }
  return [createRangeSlot({ id: "default", type: "all_day" })];
}

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function roundPrayerTime(date: Date, prayer: string): Date {
  const d = new Date(date);
  const s = d.getSeconds();
  const ms = d.getMilliseconds();
  if (prayer === "fajr") {
    if (s > 0 || ms > 0) d.setMinutes(d.getMinutes() + 1);
  } else if (s >= 30) {
    d.setMinutes(d.getMinutes() + 1);
  }
  d.setSeconds(0, 0);
  return d;
}

function resolvePrayerMinutes(prayer: string, offset: number): number | null {
  if (!PRAYER_NAMES.includes(prayer as (typeof PRAYER_NAMES)[number])) return null;
  const dateKey = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Baghdad" });
  const [y, m, d] = dateKey.split("-").map(Number);
  const prayerTimes = new PrayerTimes(BAGHDAD, new Date(y, m - 1, d, 12, 0, 0), PRAYER_PARAMS);
  const raw = prayerTimes[prayer as keyof PrayerTimes] as Date | undefined;
  if (!(raw instanceof Date)) return null;
  const rounded = roundPrayerTime(raw, prayer);
  const bd = new Date(rounded.toLocaleString("en-US", { timeZone: "Asia/Baghdad" }));
  return ((bd.getHours() * 60 + bd.getMinutes() + offset) % MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

function resolveSlotEndpoint(slot: AutomationRangeSlot, prefix: "start" | "end"): number | null {
  const mode = slot[`${prefix}_mode`] ?? "exact";
  if (mode === "prayer") {
    const prayer = slot[`${prefix}_prayer`];
    const offset = slot[`${prefix}_prayer_offset`] ?? 0;
    if (!prayer || !Number.isInteger(offset) || offset < -120 || offset > 120) return null;
    return resolvePrayerMinutes(prayer, offset);
  }
  const time = slot[`${prefix}_time`];
  return time && TIME_RE.test(time) ? parseTimeToMinutes(time) : null;
}

function slotIntervals(slot: AutomationRangeSlot): Array<{ start: number; end: number }> | null {
  if (slot.type === "all_day") return [];
  const start = resolveSlotEndpoint(slot, "start");
  const end = resolveSlotEndpoint(slot, "end");
  if (start == null || end == null || start === end) return null;
  return start < end ? [{ start, end }] : [{ start, end: MINUTES_PER_DAY }, { start: 0, end }];
}

function validateRangeSlotsForForm(slots: AutomationRangeSlot[], metricDef: MetricInfo | null): { valid: boolean; error: string; conflicts: Set<string> } {
  const conflicts = new Set<string>();
  if (!metricDef) return { valid: false, error: "", conflicts };
  if (slots.length < 1 || slots.length > 24) return { valid: false, error: "Use 1-24 range slots.", conflicts };

  let allDayCount = 0;
  const windows: Array<{ slot: AutomationRangeSlot; intervals: Array<{ start: number; end: number }> }> = [];

  for (const slot of slots) {
    if (!Number.isFinite(slot.threshold_low) || !Number.isFinite(slot.threshold)) {
      return { valid: false, error: "Every slot needs low and high thresholds.", conflicts };
    }
    if (slot.threshold_low < metricDef.min || slot.threshold > metricDef.max || slot.threshold_low >= slot.threshold) {
      return { valid: false, error: `Ranges must stay within ${metricDef.min}-${metricDef.max}${metricDef.unit} and low must be below high.`, conflicts };
    }
    if (slot.type === "all_day") {
      allDayCount += 1;
      if (allDayCount > 1) return { valid: false, error: "Only one all-day slot is allowed.", conflicts };
      continue;
    }
    const intervals = slotIntervals(slot);
    if (!intervals) return { valid: false, error: "Window slots need valid, different start and end times.", conflicts };
    windows.push({ slot, intervals });
  }

  for (let i = 0; i < windows.length; i += 1) {
    for (let j = i + 1; j < windows.length; j += 1) {
      const overlaps = windows[i].intervals.some((a) => windows[j].intervals.some((b) => a.start < b.end && b.start < a.end));
      if (overlaps) {
        conflicts.add(windows[i].slot.id);
        conflicts.add(windows[j].slot.id);
      }
    }
  }

  return {
    valid: conflicts.size === 0,
    error: conflicts.size > 0 ? "Timed range slots cannot overlap." : "",
    conflicts,
  };
}

function primaryRangeSlot(slots: AutomationRangeSlot[]): AutomationRangeSlot {
  return slots.find((s) => s.type === "all_day") ?? slots[0];
}

async function loadAcPresets(deviceId: string): Promise<Record<number, Record<string, unknown> | null>> {
  try {
    const resp = await fetch(`/api/ac/presets/${deviceId}`);
    if (resp.ok) {
      const json = (await resp.json()) as { presets: Record<number, Record<string, unknown> | null> };
      return json.presets;
    }
  } catch { /* ignore */ }
  return { 1: null, 2: null, 3: null, 4: null, 5: null };
}

function formatTimeAmPm(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatPrayerLabel(mode: string | undefined, time: string | null, prayer: string | null, offset: number | null): string {
  if (mode === "prayer" && prayer) {
    const abs = Math.abs(offset ?? 0);
    const dir = (offset ?? 0) < 0 ? "before" : (offset ?? 0) > 0 ? "after" : "at";
    const label = PRAYER_LABELS[prayer] ?? prayer;
    return abs > 0 ? `${abs}m ${dir} ${label}` : label;
  }
  return time ?? "??:??";
}

function describeTrigger(r: AutomationRule): string {
  const names = (r.device_names ?? [r.device_name]).join(", ");
  if (r.automation_type === "schedule") {
    const off = r.turn_off_at_end ? " (off)" : "";
    const startLabel = formatPrayerLabel(r.start_mode, r.time_start, r.start_prayer, r.start_prayer_offset);
    const endLabel = formatPrayerLabel(r.end_mode, r.time_end, r.end_prayer, r.end_prayer_offset);
    return `${startLabel} – ${endLabel}${off} → ${names}`;
  }
  const m = r.metric ? ALERT_METRICS[r.metric] : null;
  const label = m?.label ?? r.metric ?? "";
  const unit = m?.unit ? ` ${m.unit}` : "";
  const dur = r.sustained_minutes > 0 ? ` for ${r.sustained_minutes}min` : "";
  const off = r.turn_off_at_end ? " (off)" : "";
  if (r.device_type === "ac" && r.range_slots?.length) {
    const fallback = r.range_slots.find((s) => s.type === "all_day");
    const summary = r.range_slots.length === 1
      ? `${r.range_slots[0].threshold_low}–${r.range_slots[0].threshold}${unit}`
      : fallback
        ? `${r.range_slots.length} ranges, default ${fallback.threshold_low}–${fallback.threshold}${unit}`
        : `${r.range_slots.length} ranges`;
    return `${label} ${summary} → ${names}`;
  }
  if (r.threshold_low != null && r.threshold != null) {
    return `${label} ${r.threshold_low}–${r.threshold}${unit} → ${names}`;
  }
  return `${label} ${r.condition} ${r.threshold}${unit}${dur}${off} → ${names}`;
}

export function AlertsModal({ onClose, isAdmin }: AlertsModalProps) {
  const { isSupported, isSubscribed, permission, endpoint, subscribe, unsubscribe } = usePushNotifications();
  const { alerts, loading, createAlert, updateAlert, deleteAlert } = useAlerts(endpoint);
  const { automations, createAutomation, updateAutomation, deleteAutomation, toggleAutomation } = useAutomations();
  const { devices } = useDevices();
  const { devices: acDevices } = useAcDevices(isAdmin ?? false);
  const metrics = ALERT_METRICS;
  const prayerNames = [...PRAYER_NAMES];
  const [phase, setPhase] = useState<"in" | "out">("in");
  const [showForm, setShowForm] = useState(false);
  const [editingAlert, setEditingAlert] = useState<AlertRule | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [unsubscribing, setUnsubscribing] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const handleClose = useCallback(() => {
    setPhase("out");
    setTimeout(onClose, 150);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") handleClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  const handleSubscribe = async () => {
    setSubscribing(true);
    try { await subscribe(); } finally { setSubscribing(false); }
  };

  const handleUnsubscribe = async () => {
    setUnsubscribing(true);
    try { await unsubscribe(); } finally { setUnsubscribing(false); }
  };

  const handleDelete = async (id: number) => {
    setDeletingId(id);
    try { await deleteAlert(id); } finally { setDeletingId(null); }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-overlay-in"
      style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className={cn(
          "glass-card flex flex-col w-[480px] max-w-[95vw] max-h-[80vh]",
          phase === "in" ? "animate-panel-in" : "animate-panel-out",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
          <h2 className="text-base font-medium text-text">Alerts</h2>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg text-dim hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          {/* Not supported */}
          {!isSupported && (
            <div className="px-5 py-8 text-center text-dim text-sm">
              Push notifications are not supported in this browser.
            </div>
          )}

          {/* Permission denied */}
          {isSupported && permission === "denied" && (
            <div className="px-5 py-8 text-center text-dim text-sm">
              Notification permission was denied. Please enable it in browser settings.
            </div>
          )}

          {/* Not subscribed */}
          {isSupported && permission !== "denied" && !isSubscribed && (
            <div className="px-5 py-8 flex flex-col items-center gap-4">
              <BellOff className="w-10 h-10 text-dim" />
              <p className="text-sm text-dim text-center">
                Enable notifications to receive alerts for sensor thresholds and prayer times.
              </p>
              <button
                onClick={handleSubscribe}
                disabled={subscribing}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-cyan/20 text-cyan hover:bg-cyan/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {subscribing && <Spinner className="w-4 h-4" />}
                {subscribing ? "Enabling..." : "Enable Notifications"}
              </button>
            </div>
          )}

          {/* Subscribed — show alerts + form */}
          {isSupported && isSubscribed && (
            <div className="flex flex-col">
              {/* Alert list */}
              <div className="px-5 py-4 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-medium tracking-wider text-dim uppercase">Your Alerts</h3>
                  {!showForm && !editingAlert && (
                    <button
                      onClick={() => setShowForm(true)}
                      className="flex items-center gap-1 text-xs text-cyan hover:text-cyan/80 transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add
                    </button>
                  )}
                </div>

                {loading ? (
                  <div className="flex items-center gap-2 py-3 text-sm text-dim">
                    <Spinner className="w-4 h-4" />
                    Loading alerts...
                  </div>
                ) : alerts.length === 0 && !showForm ? (
                  <p className="text-sm text-dim py-2">No alerts configured yet.</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {alerts.map((alert) => (
                      <div
                        key={alert.id}
                        className={cn(
                          "flex items-center justify-between px-3 py-2 rounded-lg bg-white/5",
                          deletingId === alert.id && "opacity-50",
                        )}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Bell className="w-3.5 h-3.5 text-cyan shrink-0" />
                          <span className="text-sm text-text truncate">
                            {describeAlert(alert, metrics)}
                          </span>
                        </div>
                        <div className="flex items-center gap-0.5 shrink-0">
                          <button
                            onClick={() => {
                              setEditingAlert(alert);
                              setShowForm(false);
                            }}
                            disabled={deletingId !== null || editingAlert !== null}
                            className="p-1 rounded text-dim hover:text-cyan hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title="Edit alert"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDelete(alert.id)}
                            disabled={deletingId !== null}
                            className="p-1 rounded text-dim hover:text-red-400 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title="Delete alert"
                          >
                            {deletingId === alert.id
                              ? <Spinner className="w-3.5 h-3.5" />
                              : <Trash2 className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* New / Edit alert form */}
              {(showForm || editingAlert) && (
                <AlertForm
                  metrics={metrics}
                  prayerNames={prayerNames}
                  editing={editingAlert}
                  onSave={async (data) => {
                    if (editingAlert) {
                      await updateAlert(editingAlert.id, data);
                    } else {
                      await createAlert(data);
                    }
                    setShowForm(false);
                    setEditingAlert(null);
                  }}
                  onCancel={() => { setShowForm(false); setEditingAlert(null); }}
                />
              )}

              {/* Unsubscribe */}
              <div className="px-5 py-3 border-t border-white/10">
                <button
                  onClick={handleUnsubscribe}
                  disabled={unsubscribing}
                  className="flex items-center gap-1.5 text-xs text-dim hover:text-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {unsubscribing && <Spinner className="w-3 h-3" />}
                  {unsubscribing ? "Disabling..." : "Disable all notifications"}
                </button>
              </div>
            </div>
          )}

          {/* Automations — admin only */}
          {isAdmin && (
            <AutomationsPanel
              automations={automations}
              devices={devices}
              acDevices={acDevices}
              onCreate={createAutomation}
              onUpdate={updateAutomation}
              onDelete={deleteAutomation}
              onToggle={toggleAutomation}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------- Alert Creation Form ----------

interface AlertFormProps {
  metrics: Record<string, MetricInfo>;
  prayerNames: string[];
  editing: AlertRule | null;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}

function AlertForm({ metrics, prayerNames, editing, onSave, onCancel }: AlertFormProps) {
  const [metric, setMetric] = useState(() => {
    if (!editing) return "";
    return editing.alert_type === "prayer" ? "prayer" : (editing.metric ?? "");
  });
  const [condition, setCondition] = useState<AlertCondition | "">(() =>
    editing?.condition ?? "",
  );
  const [threshold, setThreshold] = useState(() =>
    editing?.threshold != null ? String(editing.threshold) : "",
  );
  const [prayerTiming, setPrayerTiming] = useState<PrayerTiming | "">(() =>
    editing?.prayer_timing ?? "",
  );
  const [prayerMinutes, setPrayerMinutes] = useState(() =>
    editing?.prayer_minutes != null ? String(editing.prayer_minutes) : "",
  );
  const [selectedPrayers, setSelectedPrayers] = useState<Set<string>>(() =>
    new Set(editing?.prayer_names ?? []),
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Touched states for inline validation
  const [touchedThreshold, setTouchedThreshold] = useState(false);
  const [touchedMinutes, setTouchedMinutes] = useState(false);
  const [touchedPrayers, setTouchedPrayers] = useState(false);

  const isPrayer = metric === "prayer";
  const isSensor = metric !== "" && !isPrayer;
  const metricDef = isSensor ? metrics[metric] : null;

  // Group metrics for the dropdown
  const groups = new Map<string, { key: string; label: string }[]>();
  for (const [key, info] of Object.entries(metrics)) {
    const group = info.group;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push({ key, label: info.label });
  }

  // Validation
  const thresholdNum = parseFloat(threshold);
  const thresholdValid =
    isSensor && metricDef
      ? threshold !== "" && isFinite(thresholdNum) && thresholdNum >= metricDef.min && thresholdNum <= metricDef.max
      : false;
  const thresholdError =
    touchedThreshold && isSensor && metricDef && threshold !== "" && !thresholdValid
      ? `Must be between ${metricDef.min} and ${metricDef.max}`
      : "";

  const minutesNum = parseInt(prayerMinutes, 10);
  const minutesValid = isPrayer && prayerTiming === "before"
    ? prayerMinutes !== "" && Number.isInteger(minutesNum) && minutesNum >= 1 && minutesNum <= 120
    : true;
  const minutesError =
    touchedMinutes && isPrayer && prayerTiming === "before" && prayerMinutes !== "" && !minutesValid
      ? "Must be 1–120"
      : "";

  const prayersValid = isPrayer ? selectedPrayers.size > 0 : true;
  const prayersError =
    touchedPrayers && isPrayer && !prayersValid ? "Select at least one prayer" : "";

  // Can save?
  const canSave =
    (isSensor && condition !== "" && thresholdValid) ||
    (isPrayer && prayerTiming !== "" &&
      (prayerTiming === "at_time" || minutesValid) &&
      prayersValid);

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError("");
    try {
      if (isSensor) {
        await onSave({
          alert_type: "sensor",
          metric,
          condition,
          threshold: thresholdNum,
        });
      } else {
        await onSave({
          alert_type: "prayer",
          prayer_timing: prayerTiming,
          prayer_minutes: prayerTiming === "before" ? minutesNum : undefined,
          prayer_names: Array.from(selectedPrayers),
        });
      }
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const allPrayersSelected = prayerNames.every((n) => selectedPrayers.has(n));

  return (
    <div className="px-5 py-4 border-t border-white/10 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium tracking-wider text-dim uppercase">{editing ? "Edit Alert" : "New Alert"}</h3>
        <button onClick={onCancel} className="text-xs text-dim hover:text-white transition-colors">
          Cancel
        </button>
      </div>

      {/* Step 1: Select metric */}
      <div>
        <label className="text-xs text-dim block mb-1">Metric</label>
        <select
          value={metric}
          onChange={(e) => {
            setMetric(e.target.value);
            setCondition("");
            setThreshold("");
            setPrayerTiming("");
            setPrayerMinutes("");
            setSelectedPrayers(new Set());
            setTouchedThreshold(false);
            setTouchedMinutes(false);
            setTouchedPrayers(false);
          }}
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-text outline-none focus:border-cyan/50 transition-colors"
        >
          <option value="" className="bg-[#1a1a2e]">Select...</option>
          {Array.from(groups.entries()).map(([group, items]) => (
            <optgroup key={group} label={group} className="bg-[#1a1a2e]">
              {items.map(({ key, label }) => (
                <option key={key} value={key} className="bg-[#1a1a2e]">{label}</option>
              ))}
            </optgroup>
          ))}
          <optgroup label="Special" className="bg-[#1a1a2e]">
            <option value="prayer" className="bg-[#1a1a2e]">Prayer Times</option>
          </optgroup>
        </select>
      </div>

      {/* Step 2: Sensor — condition */}
      {isSensor && (
        <div>
          <label className="text-xs text-dim block mb-1">Condition</label>
          <div className="flex gap-2">
            {(["above", "below"] as const).map((c) => (
              <button
                key={c}
                onClick={() => setCondition(c)}
                className={cn(
                  "flex-1 px-3 py-2 rounded-lg text-sm border transition-colors",
                  condition === c
                    ? "border-cyan/50 bg-cyan/10 text-cyan"
                    : "border-white/10 bg-white/5 text-dim hover:text-text hover:border-white/20",
                )}
              >
                {c === "above" ? "Above" : "Below"}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 3: Sensor — threshold */}
      {isSensor && condition !== "" && (
        <div>
          <label className="text-xs text-dim block mb-1">
            Threshold{metricDef?.unit ? ` (${metricDef.unit})` : ""}
          </label>
          <input
            type="number"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            onBlur={() => setTouchedThreshold(true)}
            placeholder={metricDef ? `${metricDef.min} – ${metricDef.max}` : ""}
            step="any"
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-text outline-none focus:border-cyan/50 transition-colors"
          />
          {thresholdError && <p className="text-xs text-red-400 mt-1">{thresholdError}</p>}
        </div>
      )}

      {/* Step 2: Prayer — timing */}
      {isPrayer && (
        <div>
          <label className="text-xs text-dim block mb-1">When</label>
          <div className="flex gap-2">
            {([{ v: "at_time", l: "At time" }, { v: "before", l: "Before" }] as const).map(({ v, l }) => (
              <button
                key={v}
                onClick={() => {
                  setPrayerTiming(v);
                  setPrayerMinutes("");
                  setTouchedMinutes(false);
                }}
                className={cn(
                  "flex-1 px-3 py-2 rounded-lg text-sm border transition-colors",
                  prayerTiming === v
                    ? "border-cyan/50 bg-cyan/10 text-cyan"
                    : "border-white/10 bg-white/5 text-dim hover:text-text hover:border-white/20",
                )}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 3: Prayer — minutes before */}
      {isPrayer && prayerTiming === "before" && (
        <div>
          <label className="text-xs text-dim block mb-1">Minutes before</label>
          <input
            type="number"
            value={prayerMinutes}
            onChange={(e) => setPrayerMinutes(e.target.value)}
            onBlur={() => setTouchedMinutes(true)}
            placeholder="1 – 120"
            min={1}
            max={120}
            step={1}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-text outline-none focus:border-cyan/50 transition-colors"
          />
          {minutesError && <p className="text-xs text-red-400 mt-1">{minutesError}</p>}
        </div>
      )}

      {/* Step 4: Prayer — select prayers */}
      {isPrayer && prayerTiming !== "" && (prayerTiming === "at_time" || prayerMinutes !== "") && (
        <div>
          <label className="text-xs text-dim block mb-1">Prayers</label>
          <div className="flex flex-wrap gap-2">
            {/* All checkbox */}
            <label className="flex items-center gap-1.5 cursor-pointer text-sm text-dim">
              <span
                className={cn(
                  "w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors",
                  allPrayersSelected ? "border-green-400 bg-green-400/20" : "border-dim",
                )}
              >
                {allPrayersSelected && <span className="text-green-400 text-[10px] leading-none">&#10003;</span>}
              </span>
              <input
                type="checkbox"
                checked={allPrayersSelected}
                onChange={() => {
                  setTouchedPrayers(true);
                  if (allPrayersSelected) {
                    setSelectedPrayers(new Set());
                  } else {
                    setSelectedPrayers(new Set(prayerNames));
                  }
                }}
                className="sr-only"
              />
              <span className={allPrayersSelected ? "text-text" : ""}>All</span>
            </label>
            {prayerNames.map((name) => {
              const checked = selectedPrayers.has(name);
              return (
                <label key={name} className="flex items-center gap-1.5 cursor-pointer text-sm text-dim">
                  <span
                    className={cn(
                      "w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors",
                      checked ? "border-green-400 bg-green-400/20" : "border-dim",
                    )}
                  >
                    {checked && <span className="text-green-400 text-[10px] leading-none">&#10003;</span>}
                  </span>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      setTouchedPrayers(true);
                      const next = new Set(selectedPrayers);
                      if (checked) next.delete(name);
                      else next.add(name);
                      setSelectedPrayers(next);
                    }}
                    className="sr-only"
                  />
                  <span className={checked ? "text-text" : ""}>{PRAYER_LABELS[name] ?? name}</span>
                </label>
              );
            })}
          </div>
          {prayersError && <p className="text-xs text-red-400 mt-1">{prayersError}</p>}
        </div>
      )}

      {/* Error */}
      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* Save button */}
      {metric !== "" && (
        <button
          onClick={handleSave}
          disabled={!canSave || saving}
          className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-cyan/20 text-cyan hover:bg-cyan/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {saving && <Spinner className="w-4 h-4" />}
          {saving ? "Saving..." : editing ? "Update Alert" : "Save Alert"}
        </button>
      )}
    </div>
  );
}

// ---------- Automations Panel ----------

function AutomationsPanel({ automations, devices, acDevices, onCreate, onUpdate, onDelete, onToggle }: {
  automations: AutomationRule[];
  devices: PurifierDevice[];
  acDevices: AcDevice[];
  onCreate: (body: Record<string, unknown>) => Promise<void>;
  onUpdate: (id: number, body: Record<string, unknown>) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onToggle: (id: number, enabled: boolean) => Promise<void>;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editingRule, setEditingRule] = useState<AutomationRule | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  return (
    <div className="px-5 py-4 flex flex-col gap-2 border-t border-white/10">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium tracking-wider text-dim uppercase">Auto Triggers</h3>
        {!showForm && !editingRule && (
          <button onClick={() => setShowForm(true)} className="flex items-center gap-1 text-xs text-cyan hover:text-cyan/80 transition-colors">
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        )}
      </div>

      {automations.length === 0 && !showForm && !editingRule && (
        <p className="text-sm text-dim py-1">No triggers configured.</p>
      )}

      {automations.map((a) => (
        <div key={a.id} className={cn("flex items-center justify-between px-3 py-2 rounded-lg bg-white/5 text-sm", !a.enabled && "opacity-40")}>
          <span className="text-text truncate flex items-center gap-1.5">
            {a.device_type === "ac"
              ? <Snowflake className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              : a.automation_type === "schedule"
                ? <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                : <Activity className="w-3.5 h-3.5 text-cyan shrink-0" />}
            {describeTrigger(a)}
          </span>
          <div className="flex items-center gap-1 shrink-0 ml-2">
            <button
              onClick={() => onToggle(a.id, !a.enabled)}
              className={cn("w-8 h-4 rounded-full relative transition-colors", a.enabled ? "bg-cyan/30" : "bg-white/10")}
            >
              <span className={cn("absolute top-0.5 w-3 h-3 rounded-full transition-all", a.enabled ? "left-4 bg-cyan" : "left-0.5 bg-dim")} />
            </button>
            <button
              onClick={() => { setEditingRule(a); setShowForm(false); }}
              className="p-1 rounded text-dim hover:text-cyan hover:bg-white/10 transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={async () => { setDeletingId(a.id); await onDelete(a.id); setDeletingId(null); }}
              disabled={deletingId !== null}
              className="p-1 rounded text-dim hover:text-red-400 hover:bg-white/10 transition-colors"
            >
              {deletingId === a.id ? <Spinner className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      ))}

      {(showForm || editingRule) && (
        <AutomationTriggerForm
          devices={devices}
          acDevices={acDevices}
          editing={editingRule}
          onSave={async (data) => {
            if (editingRule) {
              await onUpdate(editingRule.id, data);
              setEditingRule(null);
            } else {
              await onCreate(data);
              setShowForm(false);
            }
          }}
          onCancel={() => { setShowForm(false); setEditingRule(null); }}
        />
      )}
    </div>
  );
}

function DeviceCheckboxes({ devices, selectedDevices, setSelectedDevices }: {
  devices: { id: string; name: string }[];
  selectedDevices: Set<string>;
  setSelectedDevices: (s: Set<string>) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {devices.map((d) => {
        const checked = selectedDevices.has(d.id);
        return (
          <label key={d.id} className="flex items-center gap-1.5 cursor-pointer text-xs text-dim">
            <span className={cn("w-3.5 h-3.5 rounded border flex items-center justify-center", checked ? "border-cyan bg-cyan/20" : "border-dim")}>
              {checked && <span className="text-cyan text-[10px]">&#10003;</span>}
            </span>
            <input
              type="checkbox"
              checked={checked}
              onChange={() => {
                const next = new Set(selectedDevices);
                if (checked) next.delete(d.id); else next.add(d.id);
                setSelectedDevices(next);
              }}
              className="sr-only"
            />
            <span className={checked ? "text-text" : ""}>{d.name}</span>
          </label>
        );
      })}
    </div>
  );
}

function RangeSlotsEditor({ slots, metricDef, conflicts, onChange }: {
  slots: AutomationRangeSlot[];
  metricDef: MetricInfo | null;
  conflicts: Set<string>;
  onChange: (slots: AutomationRangeSlot[]) => void;
}) {
  const [prayerOffsetDirs, setPrayerOffsetDirs] = useState<Record<string, "before" | "after">>({});
  const updateSlot = (id: string, patch: Partial<AutomationRangeSlot>) => {
    onChange(slots.map((slot) => slot.id === id ? { ...slot, ...patch } : slot));
  };
  const updatePrayerOffset = (slotId: string, prefix: "start" | "end", dir: "before" | "after", minutes: number) => {
    const safeMinutes = Number.isFinite(minutes) ? Math.max(0, Math.min(120, Math.trunc(minutes))) : 0;
    setPrayerOffsetDirs((prev) => ({ ...prev, [`${slotId}:${prefix}`]: dir }));
    updateSlot(slotId, { [`${prefix}_prayer_offset`]: dir === "before" ? -safeMinutes : safeMinutes });
  };
  const moveSlot = (index: number, dir: -1 | 1) => {
    const next = [...slots];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2 p-2.5 rounded-lg bg-sky-400/5 border border-sky-400/20">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-sky-400/70 uppercase tracking-wider">Ranges</span>
        <button
          onClick={() => onChange([...slots, createRangeSlot({ id: `slot-${Date.now()}`, type: "window" })])}
          disabled={slots.length >= 24}
          className="flex items-center gap-1 px-2 py-1 rounded border border-white/10 bg-white/5 text-[10px] text-dim hover:text-text disabled:opacity-30"
        >
          <Plus className="w-3 h-3" /> Add
        </button>
      </div>

      {slots.map((slot, index) => {
        const conflicted = conflicts.has(slot.id);
        return (
          <div key={slot.id} className={cn("flex flex-col gap-2 p-2 rounded-lg border bg-black/10", conflicted ? "border-red-400/50" : "border-white/10")}>
            <div className="flex items-center gap-1.5">
              <input
                value={slot.label ?? ""}
                onChange={(e) => updateSlot(slot.id, { label: e.target.value })}
                placeholder={`Slot ${index + 1}`}
                className="min-w-0 flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-text outline-none focus:border-cyan/50"
              />
              <button onClick={() => moveSlot(index, -1)} disabled={index === 0} className="px-1.5 py-1 rounded text-[10px] text-dim border border-white/10 disabled:opacity-30">Up</button>
              <button onClick={() => moveSlot(index, 1)} disabled={index === slots.length - 1} className="px-1.5 py-1 rounded text-[10px] text-dim border border-white/10 disabled:opacity-30">Down</button>
              <button
                onClick={() => onChange([...slots.slice(0, index + 1), { ...slot, id: `slot-${Date.now()}` }, ...slots.slice(index + 1)])}
                disabled={slots.length >= 24}
                className="px-1.5 py-1 rounded text-[10px] text-dim border border-white/10 disabled:opacity-30"
              >
                Copy
              </button>
              <button
                onClick={() => onChange(slots.filter((s) => s.id !== slot.id))}
                disabled={slots.length <= 1}
                className="p-1 rounded text-dim hover:text-red-400 border border-white/10 disabled:opacity-30"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>

            <div className="flex gap-1.5">
              {(["all_day", "window"] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => updateSlot(slot.id, { type })}
                  className={cn(
                    "flex-1 px-2 py-1 rounded text-[10px] border transition-colors",
                    slot.type === type ? "border-sky-400/50 bg-sky-400/15 text-sky-300" : "border-white/10 bg-white/5 text-dim hover:text-text",
                  )}
                >
                  {type === "all_day" ? "All day" : "Window"}
                </button>
              ))}
            </div>

            {slot.type === "window" && (
              <div className="grid grid-cols-2 gap-2">
                {(["start", "end"] as const).map((prefix) => {
                  const mode = slot[`${prefix}_mode`] ?? "exact";
                  const prayer = slot[`${prefix}_prayer`] ?? (prefix === "start" ? "isha" : "fajr");
                  const rawOffset = slot[`${prefix}_prayer_offset`] ?? 0;
                  const offset = Number.isFinite(rawOffset) ? rawOffset : Number.NaN;
                  const offsetKey = `${slot.id}:${prefix}`;
                  const offsetDir = prayerOffsetDirs[offsetKey] ?? (offset < 0 ? "before" : "after");
                  const offsetMin = Number.isFinite(offset) ? Math.abs(offset) : "";
                  return (
                    <div key={prefix} className="flex flex-col gap-1">
                      <span className="text-[10px] text-dim">{prefix === "start" ? "From" : "To"}</span>
                      <div className="flex gap-1">
                        {(["exact", "prayer"] as const).map((m) => (
                          <button
                            key={m}
                            onClick={() => updateSlot(slot.id, { [`${prefix}_mode`]: m })}
                            className={cn("flex-1 px-1.5 py-0.5 rounded text-[10px] border", mode === m ? "border-cyan/50 bg-cyan/10 text-cyan" : "border-white/10 bg-white/5 text-dim")}
                          >
                            {m === "exact" ? "Time" : "Prayer"}
                          </button>
                        ))}
                      </div>
                      {mode === "exact" ? (
                        <input
                          type="time"
                          step={60}
                          value={slot[`${prefix}_time`] ?? (prefix === "start" ? "08:00" : "12:00")}
                          onChange={(e) => updateSlot(slot.id, { [`${prefix}_time`]: e.target.value })}
                          className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-text outline-none focus:border-cyan/50 [color-scheme:dark]"
                        />
                      ) : (
                        <>
                          <div className="flex gap-1">
                            <select
                              value={prayer}
                              onChange={(e) => updateSlot(slot.id, { [`${prefix}_prayer`]: e.target.value })}
                              className="min-w-0 flex-1 bg-white/5 border border-white/10 rounded px-1 py-1 text-xs text-text outline-none focus:border-cyan/50"
                            >
                              {PRAYER_NAMES.map((p) => <option key={p} value={p} className="bg-[#1a1a2e]">{PRAYER_LABELS[p]}</option>)}
                            </select>
                          </div>
                          <div className="flex items-center gap-1">
                            {(["before", "after"] as const).map((dir) => (
                              <button
                                key={dir}
                                onClick={() => updatePrayerOffset(slot.id, prefix, dir, typeof offsetMin === "number" ? offsetMin : 0)}
                                className={cn(
                                  "px-1.5 py-0.5 rounded text-[10px] border transition-colors",
                                  offsetDir === dir
                                    ? "border-cyan/50 bg-cyan/10 text-cyan"
                                    : "border-white/10 bg-white/5 text-dim hover:text-text",
                                )}
                              >
                                {dir}
                              </button>
                            ))}
                            <input
                              type="number"
                              min={0}
                              max={120}
                              value={offsetMin}
                              onChange={(e) => {
                                const minutes = e.target.value === "" ? 0 : parseInt(e.target.value, 10);
                                updatePrayerOffset(slot.id, prefix, offsetDir, minutes);
                              }}
                              className="w-14 bg-white/5 border border-white/10 rounded px-1 py-1 text-xs text-text outline-none focus:border-cyan/50 text-center"
                            />
                            <span className="text-[10px] text-dim">min</span>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex items-center gap-2">
              <div className="flex-1 flex flex-col gap-0.5">
                <span className="text-[10px] text-dim">Low</span>
                <input
                  type="number"
                  value={Number.isFinite(slot.threshold_low) ? slot.threshold_low : ""}
                  onChange={(e) => updateSlot(slot.id, { threshold_low: e.target.value === "" ? Number.NaN : parseFloat(e.target.value) })}
                  placeholder={metricDef ? `${metricDef.min}` : ""}
                  step="any"
                  className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-text outline-none focus:border-cyan/50"
                />
              </div>
              <span className="text-dim text-sm mt-4">-</span>
              <div className="flex-1 flex flex-col gap-0.5">
                <span className="text-[10px] text-dim">High</span>
                <input
                  type="number"
                  value={Number.isFinite(slot.threshold) ? slot.threshold : ""}
                  onChange={(e) => updateSlot(slot.id, { threshold: e.target.value === "" ? Number.NaN : parseFloat(e.target.value) })}
                  placeholder={metricDef ? `${metricDef.max}` : ""}
                  step="any"
                  className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-text outline-none focus:border-cyan/50"
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AutomationTriggerForm({ devices, acDevices, editing, onSave, onCancel }: {
  devices: PurifierDevice[];
  acDevices: AcDevice[];
  editing: AutomationRule | null;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [deviceType, setDeviceType] = useState<"purifier" | "ac">(editing?.device_type ?? "purifier");
  const [automationType, setAutomationType] = useState<"metric" | "schedule" | "">(editing?.automation_type ?? "");
  // Metric state
  const [metric, setMetric] = useState(() => {
    const raw = editing?.metric ?? "";
    return REVERSE_FEELS_LIKE[raw] ?? raw;
  });
  const [useFeelsLike, setUseFeelsLike] = useState(() => !!(editing?.metric && editing.metric in REVERSE_FEELS_LIKE));
  const [condition, setCondition] = useState<"above" | "below" | "">(editing?.condition ?? "");
  const [threshold, setThreshold] = useState(editing?.threshold != null ? String(editing.threshold) : "");
  const [rangeSlots, setRangeSlots] = useState<AutomationRangeSlot[]>(() => rangeSlotsFromRule(editing));
  const [sustainedMinutes, setSustainedMinutes] = useState(String(editing?.sustained_minutes ?? 0));
  // Schedule state
  const [timeStart, setTimeStart] = useState(editing?.time_start ?? "22:00");
  const [timeEnd, setTimeEnd] = useState(editing?.time_end ?? "07:00");
  const [turnOffAtEnd, setTurnOffAtEnd] = useState(editing?.turn_off_at_end ?? false);
  // Start prayer-relative
  const [startMode, setStartMode] = useState<"exact" | "prayer">(editing?.start_mode ?? "exact");
  const [startPrayer, setStartPrayer] = useState(editing?.start_prayer ?? "isha");
  const [startOffsetDir, setStartOffsetDir] = useState<"before" | "after">(
    () => (editing?.start_prayer_offset ?? 0) < 0 ? "before" : "after",
  );
  const [startOffsetMin, setStartOffsetMin] = useState(() => String(Math.abs(editing?.start_prayer_offset ?? 0)));
  // End prayer-relative
  const [endMode, setEndMode] = useState<"exact" | "prayer">(editing?.end_mode ?? "exact");
  const [endPrayer, setEndPrayer] = useState(editing?.end_prayer ?? "fajr");
  const [endOffsetDir, setEndOffsetDir] = useState<"before" | "after">(
    () => (editing?.end_prayer_offset ?? 0) < 0 ? "before" : "after",
  );
  const [endOffsetMin, setEndOffsetMin] = useState(() => String(Math.abs(editing?.end_prayer_offset ?? 30)));
  // AC preset state — restore from editing.action_on when editing
  const [selectedPreset, setSelectedPreset] = useState<number | null>(() => {
    if (editing?.device_type === "ac" && editing.action_on?._preset_slot != null) return Number(editing.action_on._preset_slot);
    return null;
  });
  const [presetData, setPresetData] = useState<Record<string, unknown> | null>(() => {
    if (editing?.device_type === "ac" && editing.action_on?._preset_slot != null) {
      const a = editing.action_on;
      return { mode: a.mode, targetTemp: a.temperature, fanSpeed: a.fan_speed, eco: !!a.eco, turbo: !!a.turbo, screen: !!a.screen, verticalSwing: a.vertical_swing, horizontalSwing: a.horizontal_swing, freshAir: !!a.fresh_air, generatorMode: a.generator_mode };
    }
    return null;
  });
  // AC single device selection
  const [selectedAcId, setSelectedAcId] = useState<string>(() => {
    if (editing?.device_type === "ac") return editing.device_ids?.[0] ?? editing.device_id ?? acDevices[0]?.id ?? "";
    return acDevices[0]?.id ?? "";
  });
  // Shared state — for purifiers: multi-select; for AC: derived from selectedAcId
  const [selectedDevices, setSelectedDevices] = useState<Set<string>>(() => {
    const ids = editing?.device_ids ?? (editing ? [editing.device_id] : null);
    return new Set(ids ?? devices.map((d) => d.id));
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [acPresets, setAcPresets] = useState<Record<number, Record<string, unknown> | null>>({ 1: null, 2: null, 3: null, 4: null, 5: null });
  useEffect(() => {
    if (deviceType === "ac" && selectedAcId) loadAcPresets(selectedAcId).then(setAcPresets);
  }, [deviceType, selectedAcId]);

  const triggerMetrics = deviceType === "ac" ? AC_TRIGGER_METRICS : TRIGGER_METRICS;
  const metricDef = metric ? triggerMetrics[metric] : null;
  const thresholdNum = parseFloat(threshold);
  const thresholdValid = metricDef && threshold !== "" && isFinite(thresholdNum) && thresholdNum >= metricDef.min && thresholdNum <= metricDef.max;
  const slotValidation = deviceType === "ac" && automationType === "metric"
    ? validateRangeSlotsForForm(rangeSlots, metricDef)
    : { valid: false, error: "", conflicts: new Set<string>() };

  const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const prayerNames = PRAYER_NAMES as readonly string[];
  const startValid = startMode === "exact"
    ? timeRegex.test(timeStart)
    : prayerNames.includes(startPrayer) && parseInt(startOffsetMin) >= 0 && parseInt(startOffsetMin) <= 120;
  const endValid = endMode === "exact"
    ? timeRegex.test(timeEnd)
    : prayerNames.includes(endPrayer) && parseInt(endOffsetMin) >= 0 && parseInt(endOffsetMin) <= 120;
  const timeValid = startValid && endValid
    && !(startMode === "exact" && endMode === "exact" && timeStart === timeEnd);

  const hasDeviceSelected = deviceType === "ac" ? selectedAcId !== "" : selectedDevices.size > 0;
  const hasAcProfile = deviceType !== "ac" || presetData != null;
  const canSaveMetricPurifier = deviceType !== "ac" && automationType === "metric" && metric !== "" && condition !== "" && thresholdValid && hasDeviceSelected;
  const canSaveMetricAc = deviceType === "ac" && automationType === "metric" && metric !== "" && slotValidation.valid && hasDeviceSelected && hasAcProfile;
  const canSaveMetric = canSaveMetricPurifier || canSaveMetricAc;
  const canSaveSchedule = automationType === "schedule" && timeValid && hasDeviceSelected && hasAcProfile;
  const canSave = canSaveMetric || canSaveSchedule;

  const showDevices = deviceType === "ac"
    ? automationType !== ""
    : automationType === "schedule" || (condition !== "" && threshold !== "");

  const handleDeviceTypeChange = (dt: "purifier" | "ac") => {
    setDeviceType(dt);
    setMetric("");
    setThreshold("");
    setRangeSlots([createRangeSlot({ id: "default", type: "all_day" })]);
    setUseFeelsLike(false);
    setSelectedPreset(null);
    setPresetData(null);
    if (dt === "ac") {
      setSelectedAcId(acDevices[0]?.id ?? "");
    } else {
      setSelectedDevices(new Set(devices.map((d) => d.id)));
    }
  };

  const buildPayload = (): Record<string, unknown> => {
    const ids = deviceType === "ac" ? [selectedAcId] : Array.from(selectedDevices);
    const devs = deviceType === "ac" ? acDevices : devices;
    const names = ids.map((id) => devs.find((d) => d.id === id)?.name ?? id);
    const acProfile = deviceType === "ac" && presetData ? {
      mode: (presetData as Record<string, unknown>).mode,
      temperature: (presetData as Record<string, unknown>).targetTemp,
      fan_speed: (presetData as Record<string, unknown>).fanSpeed,
      eco: (presetData as Record<string, unknown>).eco ? 1 : 0,
      turbo: (presetData as Record<string, unknown>).turbo ? 1 : 0,
      screen: (presetData as Record<string, unknown>).screen ? 1 : 0,
      vertical_swing: (presetData as Record<string, unknown>).verticalSwing,
      horizontal_swing: (presetData as Record<string, unknown>).horizontalSwing,
      fresh_air: (presetData as Record<string, unknown>).freshAir ? 1 : 0,
      generator_mode: (presetData as Record<string, unknown>).generatorMode,
      _preset_slot: selectedPreset,
    } : undefined;
    const isAcMetric = deviceType === "ac" && automationType === "metric";
    const effectiveTurnOff = isAcMetric ? true : turnOffAtEnd;
    const base = { device_type: deviceType, device_ids: ids, device_names: names, turn_off_at_end: effectiveTurnOff, ...(acProfile ? { ac_profile: acProfile } : {}) };

    if (automationType === "schedule") {
      return {
        ...base,
        automation_type: "schedule",
        time_start: startMode === "exact" ? timeStart : null,
        time_end: endMode === "exact" ? timeEnd : null,
        start_mode: startMode,
        start_prayer: startMode === "prayer" ? startPrayer : null,
        start_prayer_offset: startMode === "prayer"
          ? (startOffsetDir === "before" ? -parseInt(startOffsetMin) : parseInt(startOffsetMin))
          : null,
        end_mode: endMode,
        end_prayer: endMode === "prayer" ? endPrayer : null,
        end_prayer_offset: endMode === "prayer"
          ? (endOffsetDir === "before" ? -parseInt(endOffsetMin) : parseInt(endOffsetMin))
          : null,
      };
    }
    const mins = parseInt(sustainedMinutes, 10);
    if (isAcMetric) {
      const effectiveMetric = useFeelsLike && metric in FEELS_LIKE_MAP ? FEELS_LIKE_MAP[metric] : metric;
      const primary = primaryRangeSlot(rangeSlots);
      return {
        ...base,
        metric: effectiveMetric,
        condition: "above",
        threshold: primary.threshold,
        threshold_low: primary.threshold_low,
        range_slots: rangeSlots,
        sustained_minutes: 0,
      };
    }
    return { ...base, metric, condition, threshold: thresholdNum, sustained_minutes: isFinite(mins) && mins > 0 ? mins : 0 };
  };

  return (
    <div className="flex flex-col gap-2.5 p-3 rounded-lg bg-white/5 border border-white/10">
      <div className="flex items-center justify-between">
        <span className="text-xs text-dim uppercase tracking-wider">{editing ? "Edit Trigger" : "New Trigger"}</span>
        <button onClick={onCancel} className="text-xs text-dim hover:text-white">Cancel</button>
      </div>

      {/* Device type selector */}
      <div className="flex gap-2">
        {(["purifier", "ac"] as const).map((dt) => (
          <button
            key={dt}
            onClick={() => handleDeviceTypeChange(dt)}
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors",
              deviceType === dt
                ? dt === "ac" ? "border-sky-400/50 bg-sky-400/10 text-sky-400" : "border-cyan/50 bg-cyan/10 text-cyan"
                : "border-white/10 bg-white/5 text-dim hover:text-text",
            )}
          >
            {dt === "ac" ? <Snowflake className="w-3 h-3" /> : <Activity className="w-3 h-3" />}
            {dt === "ac" ? "AC" : "Purifier"}
          </button>
        ))}
      </div>

      {/* Trigger type selector */}
      <div className="flex gap-2">
        {(["metric", "schedule"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setAutomationType(t)}
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors",
              automationType === t ? "border-cyan/50 bg-cyan/10 text-cyan" : "border-white/10 bg-white/5 text-dim hover:text-text",
            )}
          >
            {t === "metric" ? <Activity className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
            {t === "metric" ? "Metric" : "Schedule"}
          </button>
        ))}
      </div>

      {/* Metric path */}
      {automationType === "metric" && (
        <>
          <select
            value={metric}
            onChange={(e) => { setMetric(e.target.value); setThreshold(""); setRangeSlots([createRangeSlot({ id: "default", type: "all_day" })]); setUseFeelsLike(false); }}
            className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-text outline-none focus:border-cyan/50"
          >
            <option value="" className="bg-[#1a1a2e]">Select metric...</option>
            {Object.entries(triggerMetrics).map(([key, info]) => (
              <option key={key} value={key} className="bg-[#1a1a2e]">{info.label}</option>
            ))}
          </select>

          {metric && deviceType === "ac" && metric in FEELS_LIKE_MAP && (
            <div className="flex gap-2">
              {([false, true] as const).map((fl) => (
                <button
                  key={String(fl)}
                  onClick={() => setUseFeelsLike(fl)}
                  className={cn(
                    "flex-1 px-3 py-1.5 rounded-lg text-xs border transition-colors",
                    useFeelsLike === fl
                      ? "border-cyan/50 bg-cyan/10 text-cyan"
                      : "border-white/10 bg-white/5 text-dim hover:text-text",
                  )}
                >
                  {fl ? "Feels like" : "Real temp"}
                </button>
              ))}
            </div>
          )}

          {metric && deviceType === "ac" && (
            <>
              <RangeSlotsEditor
                slots={rangeSlots}
                metricDef={metricDef}
                conflicts={slotValidation.conflicts}
                onChange={setRangeSlots}
              />
              {slotValidation.error && <p className="text-xs text-red-400">{slotValidation.error}</p>}
            </>
          )}

          {metric && deviceType !== "ac" && (
            <div className="flex gap-2">
              {(["above", "below"] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setCondition(c)}
                  className={cn(
                    "px-3 py-1.5 rounded-lg text-xs border transition-colors",
                    condition === c ? "border-cyan/50 bg-cyan/10 text-cyan" : "border-white/10 bg-white/5 text-dim hover:text-text",
                  )}
                >
                  {c === "above" ? "Above" : "Below"}
                </button>
              ))}
              {condition && (
                <input
                  type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)}
                  placeholder={metricDef ? `${metricDef.min}–${metricDef.max} ${metricDef.unit}` : ""} step="any"
                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-text outline-none focus:border-cyan/50 min-w-0"
                />
              )}
            </div>
          )}

          {deviceType !== "ac" && condition && threshold && (
            <div className="flex items-center gap-2 text-xs text-dim">
              <span>For</span>
              <input
                type="number" value={sustainedMinutes} onChange={(e) => setSustainedMinutes(e.target.value)}
                min={0} max={60}
                className="w-14 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-sm text-text outline-none focus:border-cyan/50 text-center"
              />
              <span>min <span className="text-dim/60">(0 = immediate)</span></span>
            </div>
          )}
        </>
      )}

      {/* Schedule path */}
      {automationType === "schedule" && (
        <>
          {/* From */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-dim">From</label>
            <div className="flex gap-1">
              {(["exact", "prayer"] as const).map((m) => (
                <button key={m} onClick={() => setStartMode(m)} className={cn(
                  "px-2 py-0.5 rounded text-[10px] border transition-colors",
                  startMode === m ? "border-cyan/50 bg-cyan/10 text-cyan" : "border-white/10 bg-white/5 text-dim hover:text-text",
                )}>
                  {m === "exact" ? "Time" : "Prayer"}
                </button>
              ))}
            </div>
            {startMode === "exact" ? (
              <>
                <input type="time" step={60} value={timeStart} onChange={(e) => setTimeStart(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-text outline-none focus:border-cyan/50 [color-scheme:dark]" />
                <span className="text-[10px] text-dim">{formatTimeAmPm(timeStart)}</span>
              </>
            ) : (
              <>
                <select value={startPrayer} onChange={(e) => setStartPrayer(e.target.value)}
                  className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-text outline-none focus:border-cyan/50">
                  {PRAYER_NAMES.map((p) => <option key={p} value={p} className="bg-[#1a1a2e]">{PRAYER_LABELS[p]}</option>)}
                </select>
                <div className="flex items-center gap-1.5">
                  {(["before", "after"] as const).map((d) => (
                    <button key={d} onClick={() => setStartOffsetDir(d)} className={cn(
                      "px-2 py-0.5 rounded text-[10px] border transition-colors",
                      startOffsetDir === d ? "border-cyan/50 bg-cyan/10 text-cyan" : "border-white/10 bg-white/5 text-dim hover:text-text",
                    )}>
                      {d}
                    </button>
                  ))}
                  <input type="number" value={startOffsetMin} onChange={(e) => setStartOffsetMin(e.target.value)}
                    min={0} max={120}
                    className="w-14 bg-white/5 border border-white/10 rounded-lg px-2 py-0.5 text-sm text-text outline-none focus:border-cyan/50 text-center" />
                  <span className="text-[10px] text-dim">min</span>
                </div>
              </>
            )}
          </div>

          {/* To */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-dim">To</label>
            <div className="flex gap-1">
              {(["exact", "prayer"] as const).map((m) => (
                <button key={m} onClick={() => setEndMode(m)} className={cn(
                  "px-2 py-0.5 rounded text-[10px] border transition-colors",
                  endMode === m ? "border-cyan/50 bg-cyan/10 text-cyan" : "border-white/10 bg-white/5 text-dim hover:text-text",
                )}>
                  {m === "exact" ? "Time" : "Prayer"}
                </button>
              ))}
            </div>
            {endMode === "exact" ? (
              <>
                <input type="time" step={60} value={timeEnd} onChange={(e) => setTimeEnd(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-text outline-none focus:border-cyan/50 [color-scheme:dark]" />
                <span className="text-[10px] text-dim">{formatTimeAmPm(timeEnd)}</span>
              </>
            ) : (
              <>
                <select value={endPrayer} onChange={(e) => setEndPrayer(e.target.value)}
                  className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-text outline-none focus:border-cyan/50">
                  {PRAYER_NAMES.map((p) => <option key={p} value={p} className="bg-[#1a1a2e]">{PRAYER_LABELS[p]}</option>)}
                </select>
                <div className="flex items-center gap-1.5">
                  {(["before", "after"] as const).map((d) => (
                    <button key={d} onClick={() => setEndOffsetDir(d)} className={cn(
                      "px-2 py-0.5 rounded text-[10px] border transition-colors",
                      endOffsetDir === d ? "border-cyan/50 bg-cyan/10 text-cyan" : "border-white/10 bg-white/5 text-dim hover:text-text",
                    )}>
                      {d}
                    </button>
                  ))}
                  <input type="number" value={endOffsetMin} onChange={(e) => setEndOffsetMin(e.target.value)}
                    min={0} max={120}
                    className="w-14 bg-white/5 border border-white/10 rounded-lg px-2 py-0.5 text-sm text-text outline-none focus:border-cyan/50 text-center" />
                  <span className="text-[10px] text-dim">min</span>
                </div>
              </>
            )}
          </div>

        </>
      )}

      {/* AC Preset selector */}
      {deviceType === "ac" && automationType !== "" && (() => {
        if (!selectedAcId) return null;
        const filledSlots = Object.entries(acPresets).filter(([, v]) => v != null) as [string, Record<string, unknown>][];
        if (filledSlots.length === 0) return (
          <p className="text-xs text-dim/60 py-1">No presets saved. Save presets in the AC card first.</p>
        );
        return (
          <div className="flex flex-col gap-1.5 p-2.5 rounded-lg bg-sky-400/5 border border-sky-400/20">
            <span className="text-[10px] text-sky-400/70 uppercase tracking-wider">Apply Preset on trigger</span>
            <div className="flex gap-1.5">
              {filledSlots.map(([slot, data]) => (
                <button
                  key={slot}
                  onClick={() => { setSelectedPreset(Number(slot)); setPresetData(data); }}
                  className={cn(
                    "flex-1 flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg border text-xs transition-colors",
                    selectedPreset === Number(slot)
                      ? "border-sky-400/50 bg-sky-400/15 text-sky-300"
                      : "border-white/10 bg-white/5 text-dim hover:text-text",
                  )}
                >
                  <span className="font-medium">{slot}</span>
                  <span className="text-[9px] text-dim/70">
                    {AC_MODE_NAMES[(data as Record<string, number>).mode ?? 0]} {(data as Record<string, number>).targetTemp ?? "?"}°
                  </span>
                </button>
              ))}
              <button
                onClick={() => { setSelectedPreset(null); setPresetData(null); }}
                className={cn(
                  "px-2 py-1.5 rounded-lg border text-xs transition-colors",
                  selectedPreset == null
                    ? "border-sky-400/50 bg-sky-400/15 text-sky-300"
                    : "border-white/10 bg-white/5 text-dim hover:text-text",
                )}
              >
                None
              </button>
            </div>
          </div>
        );
      })()}

      {!(deviceType === "ac" && automationType === "metric") && (
        <label className="flex items-center gap-1.5 cursor-pointer text-xs text-dim">
          <span className={cn("w-3.5 h-3.5 rounded border flex items-center justify-center", turnOffAtEnd ? "border-cyan bg-cyan/20" : "border-dim")}>
            {turnOffAtEnd && <span className="text-cyan text-[10px]">&#10003;</span>}
          </span>
          <input type="checkbox" checked={turnOffAtEnd} onChange={(e) => setTurnOffAtEnd(e.target.checked)} className="sr-only" />
          <span className={turnOffAtEnd ? "text-text" : ""}>{automationType === "schedule" ? "Turn off at end" : "Turn off when resolved"}</span>
        </label>
      )}

      {/* Device selection */}
      {showDevices && deviceType === "ac" ? (
        <div className="flex flex-wrap gap-2">
          {acDevices.map((d) => (
            <label key={d.id} className="flex items-center gap-1.5 cursor-pointer text-xs text-dim">
              <span className={cn("w-3.5 h-3.5 rounded-full border flex items-center justify-center", selectedAcId === d.id ? "border-sky-400 bg-sky-400/20" : "border-dim")}>
                {selectedAcId === d.id && <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />}
              </span>
              <input type="radio" name="ac-device" checked={selectedAcId === d.id} onChange={() => { setSelectedAcId(d.id); setSelectedPreset(null); setPresetData(null); }} className="sr-only" />
              <span className={selectedAcId === d.id ? "text-text" : ""}>{d.name}</span>
            </label>
          ))}
        </div>
      ) : showDevices ? (
        <DeviceCheckboxes devices={devices} selectedDevices={selectedDevices} setSelectedDevices={setSelectedDevices} />
      ) : null}

      {error && <p className="text-xs text-red-400">{error}</p>}

      <button
        onClick={async () => {
          if (!canSave) return;
          setSaving(true);
          setError("");
          try {
            await onSave(buildPayload());
          } catch (err: unknown) {
            setError((err as Error).message);
          } finally {
            setSaving(false);
          }
        }}
        disabled={!canSave || saving}
        className="flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-cyan/20 text-cyan hover:bg-cyan/30 disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {saving && <Spinner className="w-4 h-4" />}
        {saving ? "Saving..." : editing ? "Update Trigger" : "Save Trigger"}
      </button>
    </div>
  );
}
