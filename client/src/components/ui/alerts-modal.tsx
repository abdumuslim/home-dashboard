import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, Trash2, Pencil, Bell, BellOff, Plus, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { useAlerts } from "@/hooks/use-alerts";
import { ALERT_METRICS, PRAYER_NAMES, PRAYER_LABELS } from "@/constants/alert-metrics";
import type { AlertCondition, PrayerTiming, AlertRule, MetricInfo } from "@/types/alerts";

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
}

export function AlertsModal({ onClose }: AlertsModalProps) {
  const { isSupported, isSubscribed, permission, endpoint, subscribe, unsubscribe } = usePushNotifications();
  const { alerts, loading, createAlert, updateAlert, deleteAlert } = useAlerts(endpoint);
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
