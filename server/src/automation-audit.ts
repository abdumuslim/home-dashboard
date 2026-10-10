// Durable record of who changed an automation. PATCH /api/automations/:id (the
// dashboard's enable/disable toggle) wrote the row with no log line and no
// audit, so on 2026-09-26 the owner's disable/re-enable of an automation could
// not be verified afterwards. Mirrors ac_leveling_config_audit: one INSERT per
// change, fire-and-forget, opportunistic daily prune to 30 days.

import type { Request } from "express";
import { clientIp, type AuthKind } from "./auth.js";
import { childLogger } from "./logger.js";

const log = childLogger("automation-audit");

export const AUTOMATION_AUDIT_RETENTION_DAYS = 30;
const PRUNE_EVERY_MS = 24 * 3_600_000;

export type AutomationAuditAction = "enable" | "disable" | "create" | "update" | "delete";

export interface AutomationAuditEntry {
  automationId: number;
  automationName: string | null;
  action: AutomationAuditAction;
  /** null when the route cannot know it (create, and update, which does not read the old row). */
  enabledBefore: boolean | null;
  /** null after a delete. */
  enabledAfter: boolean | null;
}

/** The minimal pool surface the auditor needs (a pg.Pool satisfies it). */
export interface AuditPool {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export function formatAutomationAuditLine(entry: AutomationAuditEntry, authKind: AuthKind, ip: string): string {
  const name = entry.automationName != null ? ` "${entry.automationName}"` : "";
  return (
    `[automation-audit] Automation ${entry.automationId}${name} ${entry.action}: ` +
    `enabled ${entry.enabledBefore}→${entry.enabledAfter} (${authKind}, ip=${ip})`
  );
}

/**
 * Build the per-router audit function. Never throws and never awaits: an audit
 * failure must not fail (or slow) the change it records.
 */
export function createAutomationAuditor(
  pool: AuditPool,
  now: () => number = Date.now,
): (req: Request, entry: AutomationAuditEntry) => void {
  let lastPruneAt = 0;
  return (req, entry) => {
    try {
      const authKind: AuthKind = req.authKind ?? "user";
      const ip = clientIp(req);
      const uaHeader = req.headers["user-agent"];
      const userAgent = (Array.isArray(uaHeader) ? uaHeader[0] : uaHeader)?.slice(0, 300) ?? null;
      log.info(formatAutomationAuditLine(entry, authKind, ip));
      void pool
        .query(
          `INSERT INTO automation_audit (automation_id, automation_name, action, enabled_before, enabled_after, auth_kind, ip, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            entry.automationId,
            entry.automationName,
            entry.action,
            entry.enabledBefore,
            entry.enabledAfter,
            authKind,
            ip,
            userAgent,
          ],
        )
        .catch((err) => log.warn("[automation-audit] Insert failed:", err));

      const t = now();
      if (t - lastPruneAt > PRUNE_EVERY_MS) {
        lastPruneAt = t;
        void pool
          .query("DELETE FROM automation_audit WHERE at < NOW() - ($1 || ' days')::interval", [
            String(AUTOMATION_AUDIT_RETENTION_DAYS),
          ])
          .catch((err) => log.warn("[automation-audit] Prune failed:", err));
      }
    } catch (err) {
      log.warn("[automation-audit] Audit skipped:", err);
    }
  };
}
