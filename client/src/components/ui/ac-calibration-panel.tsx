import { useState } from "react";
import { Gauge, Loader2, OctagonX, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAcCalibration } from "@/hooks/use-ac-calibration";
import type { AcDevice } from "@/types/ac";
import type { AcCalibrationStatus, CalibrationFit, CalibrationResultRow } from "@/types/leveling";

interface AcCalibrationPanelProps {
  active: boolean;
  acDevices: AcDevice[];
  /** Live source from the leveling status — calibration runs on whatever is active now. */
  source: "grid" | "gen" | "none" | undefined;
  onApplyFit: (deviceId: string, source: "grid" | "gen", fit: CalibrationFit) => Promise<void>;
}

function phaseLabel(status: AcCalibrationStatus): string {
  switch (status.phase) {
    case "prep": return "Turning other ACs off";
    case "baseline": return "Measuring all-off baseline";
    case "ramp": return "Waiting for compressor ramp-up";
    case "sample":
      return status.step
        ? `${status.step.kind === "level" ? "Level" : "Fan"} ${status.step.value} — sampling`
        : "Sampling";
    case "restore": return "Restoring ACs";
    default: return "";
  }
}

function stepLabel(row: Pick<CalibrationResultRow, "kind" | "step">): string {
  return `${row.kind === "level" ? "L" : "F"}${row.step}`;
}

export function AcCalibrationPanel({ active, acDevices, source, onApplyFit }: AcCalibrationPanelProps) {
  const { data, error, start, abort } = useAcCalibration(active);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeFan, setIncludeFan] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [applying, setApplying] = useState("");

  const status = data?.status;
  const running = status?.active === true;
  const sourceActive = source === "grid" || source === "gen";

  const deviceName = (id: string): string => acDevices.find((d) => d.id === id)?.name ?? id;

  const toggleDevice = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleStart = async () => {
    setBusy(true);
    setActionError("");
    try {
      await start([...selected], includeFan);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleAbort = async () => {
    setBusy(true);
    setActionError("");
    try {
      await abort();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async (deviceId: string, fitSource: "grid" | "gen", fit: CalibrationFit) => {
    setApplying(`${deviceId}:${fitSource}`);
    setActionError("");
    try {
      await onApplyFit(deviceId, fitSource, fit);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setApplying("");
    }
  };

  // Group results: deviceId → step key → { grid?, gen? }
  const resultDeviceIds = [...new Set((data?.results ?? []).map((r) => r.deviceId))];
  const rowsFor = (deviceId: string) => {
    const rows = (data?.results ?? []).filter((r) => r.deviceId === deviceId);
    const keys = [...new Set(rows.map((r) => `${r.kind}:${r.step}`))].sort((a, b) => {
      const [ka, sa] = a.split(":");
      const [kb, sb] = b.split(":");
      if (ka !== kb) return ka === "level" ? -1 : 1;
      return Number(sa) - Number(sb);
    });
    return keys.map((key) => {
      const [kind, step] = key.split(":");
      return {
        kind: kind as "level" | "fan",
        step: Number(step),
        grid: rows.find((r) => r.source === "grid" && r.kind === kind && r.step === Number(step)),
        gen: rows.find((r) => r.source === "gen" && r.kind === kind && r.step === Number(step)),
      };
    });
  };

  return (
    <div className="flex flex-col gap-2 pt-3 mt-1 border-t border-white/10">
      <div className="flex items-center gap-1.5 text-[0.7rem] font-medium text-text">
        <Gauge className="w-3.5 h-3.5 text-cyan" />
        Calibration
        <span className="text-[0.65rem] text-dim font-normal">
          — measures each AC's real draw per level{includeFan ? " and fan" : ""} on the active source
        </span>
      </div>

      {running && status ? (
        <div className="flex flex-col gap-1.5 px-2.5 py-2 rounded-lg bg-cyan/5 border border-cyan/20">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs text-text font-medium">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan" />
              {status.currentDeviceName ?? "—"}
              <span className="text-dim font-normal">on {status.source === "grid" ? "Grid" : "Generator"}</span>
            </span>
            <button
              onClick={handleAbort}
              disabled={busy}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-[0.7rem] font-medium bg-red-400/15 text-red-400 hover:bg-red-400/25 transition-colors disabled:opacity-50"
            >
              <OctagonX className="w-3 h-3" /> Abort
            </button>
          </div>
          <div className="text-[0.65rem] text-dim">
            {phaseLabel(status)}
            {status.phase === "sample" && ` · sample ${status.samplesCollected}/${status.samplesNeeded}`}
          </div>
          {status.powerGapSeconds != null && (
            <div className="text-[0.65rem] text-amber-400">
              Power feed lost {status.powerGapSeconds}s ago — run paused (aborts at 3 min)
            </div>
          )}
          <div className="h-1 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full bg-cyan transition-all"
              style={{ width: `${status.totalSteps > 0 ? Math.round((status.stepsDone / status.totalSteps) * 100) : 0}%` }}
            />
          </div>
          <div className="text-[0.6rem] text-dim">{status.stepsDone}/{status.totalSteps} steps · other ACs are off during the run</div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {acDevices.map((d) => (
              <label key={d.id} className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/5 cursor-pointer text-[0.7rem] text-text">
                <input
                  type="checkbox"
                  checked={selected.has(d.id)}
                  onChange={() => toggleDevice(d.id)}
                  className="accent-cyan w-3 h-3"
                />
                {d.name}
              </label>
            ))}
            <label className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/5 cursor-pointer text-[0.7rem] text-dim">
              <input
                type="checkbox"
                checked={includeFan}
                onChange={() => setIncludeFan(!includeFan)}
                className="accent-cyan w-3 h-3"
              />
              Fan sweep
            </label>
            <button
              onClick={handleStart}
              disabled={busy || !sourceActive || selected.size === 0}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[0.7rem] font-medium bg-cyan/20 text-cyan hover:bg-cyan/30 transition-colors disabled:opacity-40"
              title={!sourceActive ? "No active power source" : selected.size === 0 ? "Select at least one AC" : ""}
            >
              {busy && <Loader2 className="w-3 h-3 animate-spin" />}
              Calibrate on {source === "gen" ? "Generator" : "Grid"}
            </button>
          </div>
          <p className="text-[0.6rem] text-dim -mt-1">
            Tests selected ACs one by one with every other AC turned off (~10–18 min per AC; everything is restored after).
            Run once on Grid and once on Generator to fill both columns.
          </p>
          {status?.abortReason && (
            <p className="text-[0.65rem] text-amber-400">
              Last run aborted ({status.abortReason.replace(/_/g, " ")}) — partial results kept.
            </p>
          )}
        </div>
      )}

      {(actionError || error) && <p className="text-xs text-red-400">{actionError || error}</p>}

      {/* Results per device */}
      {resultDeviceIds.map((deviceId) => {
        const rows = rowsFor(deviceId);
        const fit = data?.suggestedFit[deviceId];
        return (
          <div key={deviceId} className="flex flex-col gap-1 px-2.5 py-1.5 rounded-lg bg-white/5">
            <span className="text-[0.7rem] text-text font-medium">{deviceName(deviceId)}</span>
            <div className="grid grid-cols-[2rem_1fr_1fr] gap-x-2 text-[0.65rem]">
              <span className="text-dim"></span>
              <span className="text-indigo-300">Grid</span>
              <span className="text-rose-300">Gen</span>
              {rows.map((row) => (
                <div key={`${row.kind}${row.step}`} className="contents">
                  <span className="text-dim" title={row.kind === "level" ? `Generator level ${row.step}` : `Fan speed ${row.step}`}>
                    {stepLabel(row)}
                  </span>
                  <span className="text-text">{row.grid ? `${row.grid.amps.toFixed(2)} A` : "—"}</span>
                  <span className="text-text">
                    {row.gen ? `${row.gen.amps.toFixed(2)} A` : "—"}
                    {row.gen?.stddev != null && row.gen.stddev > 0 && (
                      <span className="text-dim"> ±{row.gen.stddev.toFixed(2)}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
            {(fit?.grid || fit?.gen) && (
              <div className="flex flex-wrap items-center gap-2 pt-0.5 text-[0.65rem] text-dim">
                {(["grid", "gen"] as const).map((s) => {
                  const f = fit?.[s];
                  if (!f) return null;
                  const key = `${deviceId}:${s}`;
                  return (
                    <span key={s} className="flex items-center gap-1">
                      <span className={s === "grid" ? "text-indigo-300" : "text-rose-300"}>
                        {s === "grid" ? "Grid" : "Gen"} fit: {f.baseAmps} + {f.stepAmps}/L
                      </span>
                      <button
                        onClick={() => handleApply(deviceId, s, f)}
                        disabled={applying === key}
                        className={cn(
                          "flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[0.6rem] font-medium transition-colors",
                          "bg-emerald-400/15 text-emerald-400 hover:bg-emerald-400/25 disabled:opacity-50",
                        )}
                        title="Write this fit into the leveling amp model and save"
                      >
                        {applying === key ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Check className="w-2.5 h-2.5" />}
                        Apply
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
