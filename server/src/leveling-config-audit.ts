/**
 * Pure diff for the Smart AC Leveling config audit (see PUT /api/ac/leveling in
 * routes.ts). Born from the 2026-08-06 gap: a dashboard disable that no server
 * record could attribute — so a save now records WHICH top-level keys it touched.
 */

/**
 * Top-level keys whose JSON-stringified value differs between two config
 * snapshots. Nested objects collapse to their parent key (a change anywhere
 * under `ampModels` reports `ampModels`, not the inner path) — the granularity
 * the audit needs ("what did this save touch?") without diffing deep. A key
 * present on only one side counts as changed: `JSON.stringify(undefined)` is
 * `undefined`, which never equals a stringified value, so an added or dropped
 * key surfaces. Result is sorted for a stable audit row.
 */
export function computeChangedKeys(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): string[] {
  const a = before ?? {};
  const b = after ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) changed.push(key);
  }
  return changed.sort();
}
