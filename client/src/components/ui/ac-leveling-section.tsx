import { useState, useEffect } from "react";
import { ChevronUp, ChevronDown, Zap, PowerOff, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAcLeveling } from "@/hooks/use-ac-leveling";
import { AcCalibrationPanel } from "@/components/ui/ac-calibration-panel";
import type { AcDevice } from "@/types/ac";
import type { AcLevelingConfig, AcLevelingAcStatus, CalibrationFit, NeedTier } from "@/types/leveling";

const NEED_COLORS: Record<NeedTier, string> = {
  satisfied: "bg-emerald-400",
  mild: "bg-amber-400",
  full: "bg-red-400",
};

const NEED_LABELS: Record<NeedTier, string> = {
  satisfied: "Room satisfied",
  mild: "Mild cooling need",
  full: "Full cooling need",
};

function defaultAmpModel(name: string): { baseAmps: number; stepAmps: number } {
  const n = name.toLowerCase();
  // Abdu's unit draws ~4A at L1 + 2A per level; the others ~2A + 1A per level
  if (n.includes("abdu") && !n.includes("abdullah")) return { baseAmps: 4, stepAmps: 2 };
  return { baseAmps: 2, stepAmps: 1 };
}

/** Fill priority/ampModels gaps so every known AC is configurable. */
function seedDraft(config: AcLevelingConfig, acDevices: AcDevice[]): AcLevelingConfig {
  const priority = [...config.priority];
  const ampModels = { ...config.ampModels };
  const genAmpModels = { ...(config.genAmpModels ?? {}) };
  const levelBoosts = { ...(config.levelBoosts ?? {}) };
  for (const d of acDevices) {
    if (!priority.includes(d.id)) priority.push(d.id);
    if (!ampModels[d.id]) ampModels[d.id] = defaultAmpModel(d.name);
    // Gen draws more at lower voltage — start from the grid model until calibrated
    if (!genAmpModels[d.id]) genAmpModels[d.id] = { ...ampModels[d.id] };
    // Abdullah's AC can't cool at L1 in extreme heat — seed its boost rule
    if (!levelBoosts[d.id] && d.name.toLowerCase().includes("abdullah")) {
      levelBoosts[d.id] = { minLevel: 2, outdoorAtLeastC: 37 };
    }
  }
  // Prefill the raise buffer for configs saved before the field existed, so its
  // input never renders uncontrolled. Seeding does NOT mark the draft dirty.
  const raiseBufferAmps = config.raiseBufferAmps ?? 1;
  return { ...config, priority, ampModels, genAmpModels, levelBoosts, raiseBufferAmps };
}

function NumberField({ label, value, step, onChange }: {
  label: string;
  value: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[0.65rem] text-dim">{label}</span>
      <input
        type="number"
        value={value}
        step={step ?? 1}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (isFinite(v)) onChange(v);
        }}
        className="w-full px-2 py-1 rounded-lg bg-white/10 border border-white/10 text-xs text-text focus:outline-none focus:border-cyan/50"
      />
    </label>
  );
}

function AcStatusBadges({ ac }: { ac: AcLevelingAcStatus }) {
  return (
    <span className="flex items-center gap-1">
      {ac.shed && (
        <span className="px-1.5 py-0.5 rounded text-[0.6rem] font-medium bg-red-400/15 text-red-400" title="Turned off by the leveler — restores automatically">
          shed
        </span>
      )}
      {!ac.managed && (
        <span className="px-1.5 py-0.5 rounded text-[0.6rem] font-medium bg-white/10 text-dim" title="An automation opted this AC out of leveling">
          opt-out
        </span>
      )}
      {ac.manualCap != null && (
        <span className="px-1.5 py-0.5 rounded text-[0.6rem] font-medium bg-amber-400/15 text-amber-400" title="Manual reduction — leveler won't raise above this">
          cap L{ac.manualCap}
        </span>
      )}
      {ac.manualTarget != null && (
        <span className="px-1.5 py-0.5 rounded text-[0.6rem] font-medium bg-sky-400/15 text-sky-400" title="Manual target — overrides the need cap">
          → L{ac.manualTarget}
        </span>
      )}
      {ac.minLevel > 1 && (
        <span className="px-1.5 py-0.5 rounded text-[0.6rem] font-medium bg-violet-400/15 text-violet-400" title="Outdoor-heat minimum level active">
          min L{ac.minLevel}
        </span>
      )}
      {ac.slotCap != null && (
        <span className="px-1.5 py-0.5 rounded text-[0.6rem] font-medium bg-sky-400/15 text-sky-300" title="Range-slot cap — never raised above this while the slot is active">
          slot L{ac.slotCap}
        </span>
      )}
      {ac.unreachableLevels.length > 0 && (
        <span
          className="px-1.5 py-0.5 rounded text-[0.6rem] font-medium bg-amber-400/15 text-amber-400"
          title="Firmware never confirmed these levels after repeated sends — using the next lower level"
        >
          L{ac.unreachableLevels.join("/L")} n/a
        </span>
      )}
      {ac.bounceCap != null && (
        <span
          className="px-1.5 py-0.5 rounded text-[0.6rem] font-medium bg-orange-400/15 text-orange-400"
          title={`Raise bounced over the limit — retries when total load drops below ${ac.bounceRetryBelowAmps?.toFixed(1) ?? "?"}A (consider calibration)`}
        >
          bounce L{ac.bounceCap}
        </span>
      )}
      {ac.restoreBlocked && (
        <span
          className="px-1.5 py-0.5 rounded text-[0.6rem] font-medium bg-orange-400/15 text-orange-400"
          title={`Restore bounced (re-shed) — retries when total load drops below ${ac.bounceRetryBelowAmps?.toFixed(1) ?? "?"}A (consider calibration)`}
        >
          restore wait
        </span>
      )}
    </span>
  );
}

export function AcLevelingSection({ active, acDevices }: { active: boolean; acDevices: AcDevice[] }) {
  const { config, status, loading, error, saveConfig } = useAcLeveling(active);
  const [draft, setDraft] = useState<AcLevelingConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    if (config && !dirty) setDraft(seedDraft(config, acDevices));
  }, [config, acDevices, dirty]);

  const update = (patch: Partial<AcLevelingConfig>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  };

  const movePriority = (deviceId: string, dir: -1 | 1) => {
    if (!draft) return;
    const idx = draft.priority.indexOf(deviceId);
    const next = idx + dir;
    if (idx < 0 || next < 0 || next >= draft.priority.length) return;
    const priority = [...draft.priority];
    [priority[idx], priority[next]] = [priority[next], priority[idx]];
    update({ priority });
  };

  const save = async (override?: Partial<AcLevelingConfig>) => {
    if (!draft) return;
    setSaving(true);
    setSaveError("");
    try {
      await saveConfig({ ...draft, ...override });
      setDirty(false);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async () => {
    if (!draft) return;
    const enabled = !draft.enabled;
    setDraft({ ...draft, enabled });
    await save({ enabled });
  };

  /** Calibration "Apply" — write a fitted model into the draft and save right away. */
  const applyFit = async (deviceId: string, fitSource: "grid" | "gen", fit: CalibrationFit) => {
    if (!draft) return;
    const patch: Partial<AcLevelingConfig> = fitSource === "grid"
      ? { ampModels: { ...draft.ampModels, [deviceId]: { ...fit } } }
      : { genAmpModels: { ...(draft.genAmpModels ?? {}), [deviceId]: { ...fit } } };
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    await save(patch);
  };

  if (loading && !draft) {
    return (
      <div className="px-5 pb-4 flex items-center gap-2 text-sm text-dim">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading...
      </div>
    );
  }
  if (!draft) {
    return <div className="px-5 pb-4 text-sm text-dim">{error || "Smart AC leveling unavailable."}</div>;
  }

  const deviceName = (id: string): string =>
    acDevices.find((d) => d.id === id)?.name ?? status?.acs.find((a) => a.deviceId === id)?.name ?? id;
  const statusFor = (id: string): AcLevelingAcStatus | undefined => status?.acs.find((a) => a.deviceId === id);

  const sourceActive = status?.source && status.source !== "none";
  const overLimit = status?.measuredAmps != null && status.limitAmps != null && status.measuredAmps > status.limitAmps;

  return (
    <div className="px-5 pb-4 flex flex-col gap-3">
      {/* Master toggle + live source readout */}
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 cursor-pointer">
          <button
            onClick={toggleEnabled}
            disabled={saving}
            className={cn("w-9 h-5 rounded-full relative transition-colors", draft.enabled ? "bg-emerald-400/30" : "bg-white/10")}
          >
            <span className={cn("absolute top-0.5 w-4 h-4 rounded-full transition-all", draft.enabled ? "left-[18px] bg-emerald-400" : "left-0.5 bg-dim")} />
          </button>
          <span className={cn("text-xs font-medium", draft.enabled ? "text-text" : "text-dim")}>
            {draft.enabled ? "Active" : "Disabled"}
          </span>
        </label>

        {sourceActive ? (
          <span
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
              status!.source === "grid" ? "bg-indigo-400/15 text-indigo-300" : "bg-rose-400/15 text-rose-300",
            )}
          >
            <Zap className="w-3 h-3" />
            {status!.source === "grid" ? "Grid" : "Generator"}
            {status!.measuredAmps != null && status!.limitAmps != null && (
              <span className={cn("font-semibold", overLimit && "text-red-400")}>
                {status!.measuredAmps.toFixed(1)} / {status!.limitAmps} A
              </span>
            )}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-white/5 text-dim">
            <PowerOff className="w-3 h-3" /> No power
          </span>
        )}
      </div>

      {/* Gating hints */}
      {draft.enabled && status && (status.overLimitStreak > 0 || status.settleRemainingMs > 0 || status.raiseHoldRemainingMs > 0 || status.expectedAmps != null) && (
        <div className="text-[0.65rem] text-dim -mt-1.5">
          {[
            status.overLimitStreak > 0 && (
              status.severeOverLimitStreak > 0 ? (
                <span key="over" className="text-amber-400">severe over-limit {Math.min(status.severeOverLimitStreak, 2)}/2 readings</span>
              ) : (
                <span key="over" className="text-amber-400">over-limit {Math.min(status.overLimitStreak, 5)}/5 readings</span>
              )
            ),
            status.settleRemainingMs > 0 && <span key="settle">settling {Math.ceil(status.settleRemainingMs / 1000)}s</span>,
            status.raiseHoldRemainingMs > 0 && (
              <span key="hold" className="text-amber-400" title="Last raise didn't draw the expected amps — the headroom may be fake, raises wait">
                raise hold {Math.ceil(status.raiseHoldRemainingMs / 1000)}s
              </span>
            ),
            status.expectedAmps != null && (
              <span key="expect" title="Predicted steady-state total once the last commands take effect">
                expecting {status.expectedAmps.toFixed(1)} A
              </span>
            ),
          ].filter(Boolean).map((el, i) => (
            <span key={i}>{i > 0 && " · "}{el}</span>
          ))}
        </div>
      )}

      {/* Amp-model accuracy: expected vs measured after the last command batch settled */}
      {draft.enabled && status?.lastPrediction && (() => {
        const p = status.lastPrediction;
        const delta = p.actualAmps - p.expectedAmps;
        return (
          <div className="text-[0.65rem] text-dim -mt-1.5">
            model check: expected {p.expectedAmps.toFixed(1)} A → measured {p.actualAmps.toFixed(1)} A{" "}
            <span className={cn(Math.abs(delta) > 2 && "text-amber-400")} title={Math.abs(delta) > 2 ? "Amp model is off — consider running calibration" : "Amp model is accurate"}>
              ({delta >= 0 ? "+" : ""}{delta.toFixed(1)})
            </span>
          </div>
        );
      })()}

      {/* Limits */}
      <div className="grid grid-cols-5 gap-2">
        <NumberField label="Grid limit A" value={draft.gridLimitAmps} onChange={(v) => update({ gridLimitAmps: v })} />
        <NumberField label="Gen limit A" value={draft.genLimitAmps} onChange={(v) => update({ genLimitAmps: v })} />
        <NumberField label="Margin A" step={0.5} value={draft.marginAmps} onChange={(v) => update({ marginAmps: v })} />
        <NumberField label="Raise buffer A" step={0.5} value={draft.raiseBufferAmps} onChange={(v) => update({ raiseBufferAmps: v })} />
        <NumberField label="Comfort °C" step={0.5} value={draft.comfortTargetC} onChange={(v) => update({ comfortTargetC: v })} />
      </div>

      {/* Priority + per-AC amp model + live state */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[0.65rem] text-dim">Priority (top keeps its level longest) · amps at L1 / per level</span>
        {draft.priority.map((id, idx) => {
          const ac = statusFor(id);
          const model = draft.ampModels[id] ?? { baseAmps: 2, stepAmps: 1 };
          const genModel = draft.genAmpModels?.[id] ?? model;
          const boost = draft.levelBoosts[id] ?? { minLevel: 1, outdoorAtLeastC: 37 };
          return (
            <div key={id} className="flex flex-col gap-1 px-2.5 py-1.5 rounded-lg bg-white/5">
              <div className="flex items-center gap-2">
                <div className="flex flex-col -my-0.5">
                  <button
                    onClick={() => movePriority(id, -1)}
                    disabled={idx === 0}
                    className="p-0.5 rounded text-dim hover:text-white hover:bg-white/10 disabled:opacity-20"
                  >
                    <ChevronUp className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => movePriority(id, 1)}
                    disabled={idx === draft.priority.length - 1}
                    className="p-0.5 rounded text-dim hover:text-white hover:bg-white/10 disabled:opacity-20"
                  >
                    <ChevronDown className="w-3 h-3" />
                  </button>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-text font-medium truncate">{deviceName(id)}</span>
                    {ac && <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", ac.on ? NEED_COLORS[ac.needTier] : "bg-white/20")} title={ac.on ? NEED_LABELS[ac.needTier] : "Off"} />}
                  </div>
                  <div className="flex items-center gap-1.5 text-[0.65rem] text-dim">
                    {ac?.on
                      ? (
                        <span>
                          {ac.level > 0 ? `L${ac.level}` : "no cap"} · ~{ac.estAmps.toFixed(1)} A
                          {" · "}
                          <span title="Room °C above target">Δ{ac.needDelta >= 0 ? "+" : ""}{ac.needDelta.toFixed(1)}°</span>
                        </span>
                      )
                      : <span>off</span>}
                    {ac && <AcStatusBadges ac={ac} />}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-[0.6rem] text-indigo-300" title="Draw model while on Grid">Grid</span>
                  <input
                    type="number"
                    value={model.baseAmps}
                    step={0.5}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (isFinite(v)) update({ ampModels: { ...draft.ampModels, [id]: { ...model, baseAmps: v } } });
                    }}
                    className="w-11 px-1 py-0.5 rounded bg-white/10 border border-white/10 text-[0.7rem] text-text text-center focus:outline-none focus:border-cyan/50"
                    title="Amps at L1 on Grid"
                  />
                  <span className="text-[0.6rem] text-dim">/</span>
                  <input
                    type="number"
                    value={model.stepAmps}
                    step={0.5}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (isFinite(v)) update({ ampModels: { ...draft.ampModels, [id]: { ...model, stepAmps: v } } });
                    }}
                    className="w-11 px-1 py-0.5 rounded bg-white/10 border border-white/10 text-[0.7rem] text-text text-center focus:outline-none focus:border-cyan/50"
                    title="Amps added per level on Grid"
                  />
                </div>
              </div>

              {/* Conditional minimum level: AC can't cool at L1 in extreme outdoor heat */}
              <div className="flex items-center gap-1.5 pl-7 text-[0.65rem] text-dim">
                <span>Min L</span>
                <input
                  type="number"
                  min={1}
                  max={6}
                  value={boost.minLevel}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (Number.isInteger(v) && v >= 1 && v <= 6) {
                      update({ levelBoosts: { ...draft.levelBoosts, [id]: { ...boost, minLevel: v } } });
                    }
                  }}
                  className="w-9 px-1 py-0.5 rounded bg-white/10 border border-white/10 text-[0.7rem] text-text text-center focus:outline-none focus:border-cyan/50"
                  title="Minimum generator level (1 = no rule)"
                />
                <span>when outdoor ≥</span>
                <input
                  type="number"
                  min={25}
                  max={55}
                  value={boost.outdoorAtLeastC}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (isFinite(v) && v >= 25 && v <= 55) {
                      update({ levelBoosts: { ...draft.levelBoosts, [id]: { ...boost, outdoorAtLeastC: v } } });
                    }
                  }}
                  className="w-11 px-1 py-0.5 rounded bg-white/10 border border-white/10 text-[0.7rem] text-text text-center focus:outline-none focus:border-cyan/50"
                  title="Outdoor temperature that activates the minimum"
                />
                <span>°C</span>
                <span className="mx-0.5">·</span>
                <span className="text-rose-300" title="Draw model while on Generator (lower voltage → more amps)">Gen</span>
                <input
                  type="number"
                  value={genModel.baseAmps}
                  step={0.5}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (isFinite(v)) update({ genAmpModels: { ...(draft.genAmpModels ?? {}), [id]: { ...genModel, baseAmps: v } } });
                  }}
                  className="w-11 px-1 py-0.5 rounded bg-white/10 border border-white/10 text-[0.7rem] text-text text-center focus:outline-none focus:border-cyan/50"
                  title="Amps at L1 on Generator"
                />
                <span>/</span>
                <input
                  type="number"
                  value={genModel.stepAmps}
                  step={0.5}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (isFinite(v)) update({ genAmpModels: { ...(draft.genAmpModels ?? {}), [id]: { ...genModel, stepAmps: v } } });
                  }}
                  className="w-11 px-1 py-0.5 rounded bg-white/10 border border-white/10 text-[0.7rem] text-text text-center focus:outline-none focus:border-cyan/50"
                  title="Amps added per level on Generator"
                />
              </div>
            </div>
          );
        })}
      </div>

      {(saveError || error) && <p className="text-xs text-red-400">{saveError || error}</p>}

      {dirty && (
        <button
          onClick={() => save()}
          disabled={saving}
          className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-cyan/20 text-cyan hover:bg-cyan/30 transition-colors disabled:opacity-50"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          {saving ? "Saving..." : "Save Leveling Settings"}
        </button>
      )}

      <AcCalibrationPanel
        active={active}
        acDevices={acDevices}
        source={status?.source}
        onApplyFit={applyFit}
      />
    </div>
  );
}
