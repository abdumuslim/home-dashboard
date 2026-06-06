/**
 * Delta-based smart auto fan for AC range automations.
 *
 * When a range slot (or the preset profile) resolves the fan to Auto (0), the
 * collector never sends the AC's built-in auto — it computes a fixed level
 * from how far the metric is past the slot's satisfied point:
 *   delta ≤ 0.5° → L1, ≤ 1.0° → L2, then +1 level per 0.2° further, capped at L7.
 */

const AUTO_FAN_DOWN_HYSTERESIS = 0.1;

/** Raw delta→level mapping with no hysteresis. The epsilon keeps exact boundaries (e.g. 1.3) on the lower level despite FP error. */
function rawAutoFanLevel(delta: number): number {
  if (delta <= 0.5) return 1;
  if (delta <= 1.0) return 2;
  return Math.min(7, 2 + Math.ceil((delta - 1.0) / 0.2 - 1e-9));
}

/**
 * Compute the smart-auto fan level for a temperature delta.
 *
 * `previousLevel` is the automation's last commanded fan level (anti-flap):
 * raises apply immediately; lowering only happens when the level computed
 * with a +0.1° bias is still below the previous level — otherwise the
 * previous level is held so the fan doesn't oscillate at a boundary.
 */
export function computeAutoFanLevel(delta: number, previousLevel?: number | null): number {
  const raw = rawAutoFanLevel(delta);
  if (previousLevel == null || previousLevel < 1 || previousLevel > 7) return raw;
  if (raw >= previousLevel) return raw;
  const biased = rawAutoFanLevel(delta + AUTO_FAN_DOWN_HYSTERESIS);
  return biased < previousLevel ? raw : previousLevel;
}
