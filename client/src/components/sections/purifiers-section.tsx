import { useState } from "react";
import { Plus, Trash2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDevices } from "@/hooks/use-devices";
import { useAutomations } from "@/hooks/use-automations";
import { PurifierCard } from "@/components/cards/purifier-card";
import { ALERT_METRICS } from "@/constants/alert-metrics";
import type { PurifierDevice, AutomationRule } from "@/types/automations";
import type { MetricInfo } from "@/types/alerts";

// Only AQ metrics relevant for purifier triggers (exclude noise, temp, humidity)
const TRIGGER_METRICS: Record<string, MetricInfo> = Object.fromEntries(
  Object.entries(ALERT_METRICS).filter(
    ([k, v]) => v.group === "Air Quality" && !["noise", "temperature_air", "humidity_air"].includes(k),
  ),
);

function describeTrigger(r: AutomationRule): string {
  const m = ALERT_METRICS[r.metric];
  const label = m?.label ?? r.metric;
  const unit = m?.unit ? ` ${m.unit}` : "";
  const names = (r.device_names ?? [r.device_name]).join(", ");
  return `${label} ${r.condition} ${r.threshold}${unit} → ${names}`;
}

export function PurifiersSection() {
  const { devices, authState, submitVerification, sendControl } = useDevices();
  const { automations, createAutomation, deleteAutomation, toggleAutomation } = useAutomations();

  // 2FA state
  const [verifyCode, setVerifyCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState("");

  if (authState.status === "not_configured") {
    return <p className="text-sm text-dim py-4">Xiaomi Cloud not configured.</p>;
  }

  if (authState.status === "needs_2fa" || authState.status === "needs_captcha") {
    return (
      <div className="flex flex-col items-center gap-3 py-6">
        {authState.captchaImage && <img src={authState.captchaImage} alt="CAPTCHA" className="rounded-lg" />}
        <p className="text-sm text-dim text-center">
          {authState.status === "needs_2fa"
            ? "Enter the verification code sent to your email."
            : "Enter the CAPTCHA text."}
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={verifyCode}
            onChange={(e) => setVerifyCode(e.target.value)}
            placeholder="Code"
            className="w-36 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-text text-center outline-none focus:border-cyan/50"
          />
          <button
            onClick={async () => {
              if (!verifyCode.trim()) return;
              setVerifying(true);
              setVerifyError("");
              const res = await submitVerification(verifyCode.trim());
              setVerifying(false);
              if (!res.ok) setVerifyError(res.error ?? "Failed");
            }}
            disabled={verifying || !verifyCode.trim()}
            className="px-3 py-1.5 rounded-lg text-sm bg-cyan/20 text-cyan hover:bg-cyan/30 disabled:opacity-50"
          >
            {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : "Submit"}
          </button>
        </div>
        {verifyError && <p className="text-xs text-red-400">{verifyError}</p>}
      </div>
    );
  }

  if (authState.status === "error") {
    return <p className="text-sm text-dim py-4">Xiaomi Cloud error: {authState.error}</p>;
  }

  if (devices.length === 0) {
    return <p className="text-sm text-dim py-4">No purifiers found. Check MI_REGION.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Device cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 md:gap-6">
        {devices.map((d) => (
          <PurifierCard
            key={d.id}
            device={d}
            onControl={(cmd, params) => sendControl(d.id, cmd, params)}
          />
        ))}
      </div>

      {/* Triggers */}
      <TriggersPanel devices={devices} automations={automations} onCreate={createAutomation} onDelete={deleteAutomation} onToggle={toggleAutomation} />
    </div>
  );
}

// ---------- Triggers Panel ----------

interface TriggersPanelProps {
  devices: PurifierDevice[];
  automations: AutomationRule[];
  onCreate: (body: Record<string, unknown>) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onToggle: (id: number, enabled: boolean) => Promise<void>;
}

function TriggersPanel({ devices, automations, onCreate, onDelete, onToggle }: TriggersPanelProps) {
  const [showForm, setShowForm] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium tracking-wider text-dim uppercase">Auto Triggers</h3>
        {!showForm && (
          <button onClick={() => setShowForm(true)} className="flex items-center gap-1 text-xs text-cyan hover:text-cyan/80">
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        )}
      </div>

      {automations.length === 0 && !showForm && (
        <p className="text-xs text-dim">No triggers yet.</p>
      )}

      {automations.map((a) => (
        <div key={a.id} className={cn("flex items-center justify-between px-3 py-2 rounded-lg bg-white/5 text-sm", !a.enabled && "opacity-40")}>
          <span className="text-text truncate">{describeTrigger(a)}</span>
          <div className="flex items-center gap-1 shrink-0 ml-2">
            <button
              onClick={() => onToggle(a.id, !a.enabled)}
              className={cn("w-8 h-4 rounded-full relative transition-colors", a.enabled ? "bg-cyan/30" : "bg-white/10")}
            >
              <span className={cn("absolute top-0.5 w-3 h-3 rounded-full transition-all", a.enabled ? "left-4 bg-cyan" : "left-0.5 bg-dim")} />
            </button>
            <button
              onClick={async () => { setDeletingId(a.id); await onDelete(a.id); setDeletingId(null); }}
              disabled={deletingId !== null}
              className="p-1 rounded text-dim hover:text-red-400 hover:bg-white/10 transition-colors"
            >
              {deletingId === a.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      ))}

      {showForm && (
        <TriggerForm
          devices={devices}
          onSave={async (data) => { await onCreate(data); setShowForm(false); }}
          onCancel={() => setShowForm(false)}
        />
      )}
    </div>
  );
}

// ---------- Trigger Form ----------

function TriggerForm({ devices, onSave, onCancel }: {
  devices: PurifierDevice[];
  onSave: (data: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [metric, setMetric] = useState("");
  const [condition, setCondition] = useState<"above" | "below" | "">("");
  const [threshold, setThreshold] = useState("");
  const [selectedDevices, setSelectedDevices] = useState<Set<string>>(() => new Set(devices.map((d) => d.id)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const metricDef = metric ? TRIGGER_METRICS[metric] : null;
  const thresholdNum = parseFloat(threshold);
  const thresholdValid = metricDef && threshold !== "" && isFinite(thresholdNum) && thresholdNum >= metricDef.min && thresholdNum <= metricDef.max;
  const canSave = metric !== "" && condition !== "" && thresholdValid && selectedDevices.size > 0;

  return (
    <div className="flex flex-col gap-2.5 p-3 rounded-lg bg-white/5 border border-white/10">
      <div className="flex items-center justify-between">
        <span className="text-xs text-dim uppercase tracking-wider">New Trigger</span>
        <button onClick={onCancel} className="text-xs text-dim hover:text-white">Cancel</button>
      </div>

      {/* Metric */}
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

      {/* Condition + Threshold inline */}
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

      {/* Device checkboxes */}
      {condition && threshold && (
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
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* Save */}
      <button
        onClick={async () => {
          if (!canSave) return;
          setSaving(true);
          setError("");
          try {
            const ids = Array.from(selectedDevices);
            await onSave({
              metric,
              condition,
              threshold: thresholdNum,
              device_ids: ids,
              device_names: ids.map((id) => devices.find((d) => d.id === id)?.name ?? id),
            });
          } catch (err: unknown) {
            setError((err as Error).message);
          } finally {
            setSaving(false);
          }
        }}
        disabled={!canSave || saving}
        className="flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-cyan/20 text-cyan hover:bg-cyan/30 disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {saving && <Loader2 className="w-4 h-4 animate-spin" />}
        {saving ? "Saving..." : "Save Trigger"}
      </button>
    </div>
  );
}
