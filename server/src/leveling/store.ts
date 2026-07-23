// DB persistence for leveling v2 (tables: ac_leveling_costs, ac_leveling_journal;
// the shed / fan-hold / remembered-level tables are reused as-is by the
// controller shell). Thin CRUD only — no decision logic here.

import pg from "pg";
import { childLogger } from "../logger.js";
import type { CostBook } from "./costs.js";
import { COST_SEEDS } from "./costs.js";
import type { Command, Decision, LearnedCost, Mode, PowerSource, Severity } from "./types.js";

const log = childLogger("leveling-store");

export class LevelingStore {
  constructor(private pool: pg.Pool) {}

  // ---- learned costs ----

  async loadCosts(): Promise<CostBook> {
    const res = await this.pool.query(
      "SELECT device_id, source, transition, ewma_amps, samples, EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms FROM ac_leveling_costs",
    );
    const book: Record<string, LearnedCost> = {};
    for (const row of res?.rows ?? []) {
      book[`${row.device_id}|${row.source}|${row.transition}`] = {
        ewmaAmps: Number(row.ewma_amps),
        samples: Number(row.samples),
        updatedAt: Number(row.updated_ms),
      };
    }
    return book;
  }

  async upsertCost(
    deviceId: string,
    source: PowerSource,
    transition: string,
    entry: LearnedCost,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO ac_leveling_costs (device_id, source, transition, ewma_amps, samples, updated_at)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))
       ON CONFLICT (device_id, source, transition)
       DO UPDATE SET ewma_amps = $4, samples = $5, updated_at = to_timestamp($6 / 1000.0)`,
      [deviceId, source, transition, entry.ewmaAmps, entry.samples, entry.updatedAt],
    );
  }

  /** Seed the mined 2026-07 values once — only when the table is empty. */
  async seedCostsIfEmpty(now: number): Promise<void> {
    const res = await this.pool.query("SELECT COUNT(*)::int AS n FROM ac_leveling_costs");
    if (Number(res?.rows?.[0]?.n ?? 0) > 0) return;
    for (const seed of COST_SEEDS) {
      await this.upsertCost(seed.deviceId, seed.source, seed.transition, {
        ewmaAmps: seed.amps,
        samples: 2, // low confidence: live graded batches overtake within hours
        updatedAt: now,
      });
    }
    log.info(`[leveling-store] Seeded ${COST_SEEDS.length} learned-cost rows (table was empty)`);
  }

  async resetCosts(): Promise<void> {
    await this.pool.query("DELETE FROM ac_leveling_costs");
  }

  // ---- journal ----

  async insertJournal(row: {
    at: number;
    source: PowerSource;
    mode: Mode;
    severity: Severity | null;
    reason: string;
    requiredAmps: number | null;
    preAmps: number | null;
    commands: Command[];
    decisions: Decision[];
    expectedDelta: number | null;
    executed: boolean;
  }): Promise<number> {
    const res = await this.pool.query(
      `INSERT INTO ac_leveling_journal
         (at, source, mode, severity, reason, required_amps, pre_amps, commands, decisions, expected_delta, executed)
       VALUES (to_timestamp($1 / 1000.0), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        row.at,
        row.source,
        row.mode,
        row.severity,
        row.reason,
        row.requiredAmps,
        row.preAmps,
        JSON.stringify(row.commands),
        JSON.stringify(row.decisions),
        row.expectedDelta,
        row.executed,
      ],
    );
    return Number(res.rows[0].id);
  }

  async gradeJournal(id: number, gradedAt: number, postAmps: number, observedDelta: number): Promise<void> {
    await this.pool.query(
      `UPDATE ac_leveling_journal
       SET graded_at = to_timestamp($2 / 1000.0), post_amps = $3, observed_delta = $4
       WHERE id = $1`,
      [id, gradedAt, postAmps, observedDelta],
    );
  }

  async recentJournal(hours: number, limit = 500): Promise<Record<string, unknown>[]> {
    const res = await this.pool.query(
      `SELECT id, at, source, mode, severity, reason, required_amps, pre_amps, commands, decisions,
              expected_delta, executed, graded_at, post_amps, observed_delta
       FROM ac_leveling_journal
       WHERE at >= NOW() - ($1 || ' hours')::interval
       ORDER BY at DESC
       LIMIT $2`,
      [String(Math.max(1, Math.min(24 * 60, hours))), limit],
    );
    return res.rows;
  }

  /** Retention prune — call opportunistically (e.g. daily from the controller). */
  async pruneJournal(days = 60): Promise<void> {
    await this.pool.query("DELETE FROM ac_leveling_journal WHERE at < NOW() - ($1 || ' days')::interval", [
      String(days),
    ]);
  }
}
