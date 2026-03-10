import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, Trash2, Pencil, Bell, BellOff, Plus, Loader2, Clock, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { useAlerts } from "@/hooks/use-alerts";
import { useAutomations } from "@/hooks/use-automations";
import { useDevices } from "@/hooks/use-devices";
import { ALERT_METRICS, PRAYER_NAMES, PRAYER_LABELS } from "@/constants/alert-metrics";
import type { AlertCondition, PrayerTiming, AlertRule, MetricInfo } from "@/types/alerts";
import type { PurifierDevice, AutomationRule } from "@/types/automations";

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

function formatTimeAmPm(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function describeTrigger(r: AutomationRule): string {
  const names = (r.device_names ?? [r.device_name]).join(", ");
  if (r.automation_type === "schedule") {
    const off = r.turn_off_at_end ? " (off)" : "";
    return `${r.time_start} – ${r.time_end}${off} → ${names}`;
  }
  const m = r.metric ? ALERT_METRICS[r.metric] : null;
  const label = m?.label ?? r.metric ?? "";
  const unit = m?.unit ? ` ${m.unit}` : "";
  const dur = r.sustained_minutes > 0 ? ` for ${r.sustained_minutes}min` : "";
  return `${label} ${r.condition} ${r.threshold}${unit}${dur} → ${names}`;
}

export function AlertsModal({ onClose, isAdmin }: AlertsModalProps) {
  const { isSupported, isSubscribed, permission, endpoint, subscribe, unsubscribe } = usePushNotifications();
  const { alerts, loading, createAlert, updateAlert, deleteAlert } = useAlerts(endpoint);
  const { automations, createAutomation, updateAutomation, deleteAutomation, toggleAutomation } = useAutomations();
  const { devices } = useDevices();
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

function AutomationsPanel({ automations, devices, onCreate, onUpdate, onDelete, onToggle }: {
  automations: AutomationRule[];
  devices: PurifierDevice[];
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
        <h3 className="text-xs font-medium tracking-wider text-dim uppercase">Purifier Auto Triggers</h3>
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
            {a.automation_type === "schedule"
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
  devices: PurifierDevice[];
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

function AutomationTriggerForm({ devices, editing, onSave, onCancel }: {
  devices: PurifierDevice[];
  editing: AutomationRule | null;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [automationType, setAutomationType] = useState<"metric" | "schedule" | "">(editing?.automation_type ?? "");
  // Metric state
  const [metric, setMetric] = useState(editing?.metric ?? "");
  const [condition, setCondition] = useState<"above" | "below" | "">(editing?.condition ?? "");
  const [threshold, setThreshold] = useState(editing?.threshold != null ? String(editing.threshold) : "");
  const [sustainedMinutes, setSustainedMinutes] = useState(String(editing?.sustained_minutes ?? 0));
  // Schedule state
  const [timeStart, setTimeStart] = useState(editing?.time_start ?? "22:00");
  const [timeEnd, setTimeEnd] = useState(editing?.time_end ?? "07:00");
  const [turnOffAtEnd, setTurnOffAtEnd] = useState(editing?.turn_off_at_end ?? false);
  // Shared state
  const [selectedDevices, setSelectedDevices] = useState<Set<string>>(() => {
    const ids = editing?.device_ids ?? (editing ? [editing.device_id] : null);
    return new Set(ids ?? devices.map((d) => d.id));
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const metricDef = metric ? TRIGGER_METRICS[metric] : null;
  const thresholdNum = parseFloat(threshold);
  const thresholdValid = metricDef && threshold !== "" && isFinite(thresholdNum) && thresholdNum >= metricDef.min && thresholdNum <= metricDef.max;

  const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const timeValid = timeRegex.test(timeStart) && timeRegex.test(timeEnd) && timeStart !== timeEnd;

  const canSaveMetric = automationType === "metric" && metric !== "" && condition !== "" && thresholdValid && selectedDevices.size > 0;
  const canSaveSchedule = automationType === "schedule" && timeValid && selectedDevices.size > 0;
  const canSave = canSaveMetric || canSaveSchedule;

  // Show device checkboxes when enough fields are filled
  const showDevices = automationType === "schedule" || (condition !== "" && threshold !== "");

  return (
    <div className="flex flex-col gap-2.5 p-3 rounded-lg bg-white/5 border border-white/10">
      <div className="flex items-center justify-between">
        <span className="text-xs text-dim uppercase tracking-wider">{editing ? "Edit Trigger" : "New Trigger"}</span>
        <button onClick={onCancel} className="text-xs text-dim hover:text-white">Cancel</button>
      </div>

      {/* Type selector */}
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
            onChange={(e) => { setMetric(e.target.value); setThreshold(""); }}
            className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-text outline-none focus:border-cyan/50"
          >
            <option value="" className="bg-[#1a1a2e]">Select metric...</option>
            {Object.entries(TRIGGER_METRICS).map(([key, info]) => (
              <option key={key} value={key} className="bg-[#1a1a2e]">{info.label}</option>
            ))}
          </select>

          {metric && (
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
                  type="number"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  placeholder={metricDef ? `${metricDef.min}–${metricDef.max} ${metricDef.unit}` : ""}
                  step="any"
                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-text outline-none focus:border-cyan/50 min-w-0"
                />
              )}
            </div>
          )}

          {condition && threshold && (
            <div className="flex items-center gap-2 text-xs text-dim">
              <span>For</span>
              <input
                type="number"
                value={sustainedMinutes}
                onChange={(e) => setSustainedMinutes(e.target.value)}
                min={0}
                max={60}
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
          <div className="flex gap-2 items-center">
            <div className="flex-1">
              <label className="text-xs text-dim block mb-1">From</label>
              <input
                type="time"
                step={60}
                value={timeStart}
                onChange={(e) => setTimeStart(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-text outline-none focus:border-cyan/50 [color-scheme:dark]"
              />
              <span className="text-[10px] text-dim mt-0.5 block">{formatTimeAmPm(timeStart)}</span>
            </div>
            <span className="text-dim text-sm mt-2">–</span>
            <div className="flex-1">
              <label className="text-xs text-dim block mb-1">To</label>
              <input
                type="time"
                step={60}
                value={timeEnd}
                onChange={(e) => setTimeEnd(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-text outline-none focus:border-cyan/50 [color-scheme:dark]"
              />
              <span className="text-[10px] text-dim mt-0.5 block">{formatTimeAmPm(timeEnd)}</span>
            </div>
          </div>
          <label className="flex items-center gap-1.5 cursor-pointer text-xs text-dim">
            <span className={cn("w-3.5 h-3.5 rounded border flex items-center justify-center", turnOffAtEnd ? "border-cyan bg-cyan/20" : "border-dim")}>
              {turnOffAtEnd && <span className="text-cyan text-[10px]">&#10003;</span>}
            </span>
            <input type="checkbox" checked={turnOffAtEnd} onChange={(e) => setTurnOffAtEnd(e.target.checked)} className="sr-only" />
            <span className={turnOffAtEnd ? "text-text" : ""}>Turn off at end time</span>
          </label>
        </>
      )}

      {/* Device selection (shared) */}
      {showDevices && (
        <DeviceCheckboxes devices={devices} selectedDevices={selectedDevices} setSelectedDevices={setSelectedDevices} />
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      <button
        onClick={async () => {
          if (!canSave) return;
          setSaving(true);
          setError("");
          try {
            const ids = Array.from(selectedDevices);
            const names = ids.map((id) => devices.find((d) => d.id === id)?.name ?? id);
            if (automationType === "schedule") {
              await onSave({ automation_type: "schedule", time_start: timeStart, time_end: timeEnd, turn_off_at_end: turnOffAtEnd, device_ids: ids, device_names: names });
            } else {
              const mins = parseInt(sustainedMinutes, 10);
              await onSave({ metric, condition, threshold: thresholdNum, sustained_minutes: isFinite(mins) && mins > 0 ? mins : 0, device_ids: ids, device_names: names });
            }
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
