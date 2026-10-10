import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { Request } from "express";
import { createRouter } from "./routes.js";
import type { Config } from "./config.js";
import { signToken } from "./auth.js";
import { createAutomationAuditor, formatAutomationAuditLine, type AuditPool } from "./automation-audit.js";

// 2026-09-26: the owner disabled and re-enabled an automation and the server
// kept no trace of it; the toggle also waited up to 30 s for the collector's
// rule cache. These pin the log/audit/invalidate trio on every mutation route.

const TEST_CONFIG = {
  authSecret: "auth-secret",
  adminUser: "admin",
  adminPassword: "password",
  hermesApiToken: "hermes-secret",
} as Config;

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

function createPool(options: { failAudit?: boolean; row?: Record<string, unknown> | null } = {}) {
  const queries: RecordedQuery[] = [];
  const row = options.row === undefined ? { id: 7, name: "AC Schedule 22:00 – 06:00", enabled: false } : options.row;
  return {
    queries,
    audits: () => queries.filter((q) => q.sql.includes("INSERT INTO automation_audit")),
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("INSERT INTO automation_audit")) {
        if (options.failAudit) throw new Error("relation automation_audit does not exist");
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE automations") && sql.includes("enabled_before")) {
        return row
          ? { rows: [{ ...row, enabled: params[0], enabled_before: !params[0] }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes("DELETE FROM automations")) {
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      // Create/update: echo the row the statement would write ($1 = name, $2 = enabled).
      if (sql.includes("INSERT INTO automations") || sql.includes("UPDATE automations SET name=")) {
        return row ? { rows: [{ id: 7, name: params[0], enabled: params[1] }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  })));
});

async function startServer(pool: ReturnType<typeof createPool>, onRulesChanged: () => void) {
  const app = express();
  app.use(express.json());
  app.use(createRouter(
    pool as never,
    TEST_CONFIG,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    onRulesChanged,
  ));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server port");
  return `http://127.0.0.1:${address.port}`;
}

const cookie = (agent = false) =>
  `auth=${signToken(agent ? { user: "admin", agent: true, exp: Date.now() + 60_000 } : { user: "admin", exp: Date.now() + 60_000 }, TEST_CONFIG.authSecret)}`;

function patch(url: string, id: number | string, body: unknown, agent = false) {
  return fetch(`${url}/api/automations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie(agent), "User-Agent": "vitest-ua" },
    body: JSON.stringify(body),
  });
}

// The audit INSERT is fire-and-forget; let its microtask run before asserting.
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("formatAutomationAuditLine", () => {
  it("names the automation, the transition and the actor", () => {
    expect(
      formatAutomationAuditLine(
        { automationId: 7, automationName: "Night", action: "disable", enabledBefore: true, enabledAfter: false },
        "user",
        "1.2.3.4",
      ),
    ).toBe('[automation-audit] Automation 7 "Night" disable: enabled true→false (user, ip=1.2.3.4)');
  });
});

describe("createAutomationAuditor", () => {
  const fakeReq = (authKind?: "user" | "agent") =>
    ({ authKind, headers: { "user-agent": "ua" }, socket: { remoteAddress: "10.0.0.1" } }) as unknown as Request;

  it("writes one row with every column, defaulting auth_kind to user", async () => {
    const queries: RecordedQuery[] = [];
    const pool: AuditPool = { query: async (sql, params = []) => { queries.push({ sql, params }); return {}; } };
    createAutomationAuditor(pool)(fakeReq(), {
      automationId: 3, automationName: "X", action: "enable", enabledBefore: false, enabledAfter: true,
    });
    const insert = queries.find((q) => q.sql.includes("INSERT INTO automation_audit"));
    expect(insert?.params).toEqual([3, "X", "enable", false, true, "user", "10.0.0.1", "ua"]);
  });

  it("prunes at most once a day", () => {
    const queries: RecordedQuery[] = [];
    const pool: AuditPool = { query: async (sql, params = []) => { queries.push({ sql, params }); return {}; } };
    let t = 1_000_000_000_000;
    const audit = createAutomationAuditor(pool, () => t);
    const entry = { automationId: 1, automationName: null, action: "update" as const, enabledBefore: null, enabledAfter: true };
    audit(fakeReq("agent"), entry);
    audit(fakeReq("agent"), entry);
    t += 25 * 3_600_000;
    audit(fakeReq("agent"), entry);
    expect(queries.filter((q) => q.sql.startsWith("DELETE FROM automation_audit"))).toHaveLength(2);
    expect(queries.filter((q) => q.sql.includes("INSERT INTO automation_audit"))).toHaveLength(3);
  });

  it("never throws, even when the pool throws synchronously", () => {
    const pool: AuditPool = { query: () => { throw new Error("boom"); } };
    expect(() =>
      createAutomationAuditor(pool)(fakeReq(), {
        automationId: 1, automationName: null, action: "delete", enabledBefore: true, enabledAfter: null,
      }),
    ).not.toThrow();
  });
});

describe("PATCH /api/automations/:id (enable/disable toggle)", () => {
  it("audits the before/after, invalidates the rule cache, and returns the plain row", async () => {
    const pool = createPool();
    const onRulesChanged = vi.fn();
    const url = await startServer(pool, onRulesChanged);

    const res = await patch(url, 7, { enabled: false }, true);
    await flush();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { automation: Record<string, unknown> };
    expect(body.automation).toEqual({ id: 7, name: "AC Schedule 22:00 – 06:00", enabled: false });
    expect(onRulesChanged).toHaveBeenCalledTimes(1);
    const audits = pool.audits();
    expect(audits).toHaveLength(1);
    expect(audits[0].params.slice(0, 6)).toEqual([7, "AC Schedule 22:00 – 06:00", "disable", true, false, "agent"]);
    expect(audits[0].params[7]).toBe("vitest-ua");
  });

  it("reads the before-image under a row lock in the same statement as the update", async () => {
    // No real Postgres in the suite, so pin the statement shape: the prior-state
    // read must take FOR UPDATE, or two concurrent toggles can both read the same
    // before value and one audit row records a transition that never happened.
    const pool = createPool();
    const url = await startServer(pool, vi.fn());

    await patch(url, 7, { enabled: false });

    const update = pool.queries.find((q) => q.sql.includes("UPDATE automations"));
    const sql = update!.sql.replace(/\s+/g, " ");
    expect(sql).toMatch(/WITH prev AS \(SELECT id, enabled FROM automations WHERE id = \$2 FOR UPDATE\)/);
    expect(sql).toMatch(/UPDATE automations a SET enabled = \$1 FROM prev WHERE a\.id = prev\.id/);
    expect(sql).toMatch(/RETURNING a\.\*, prev\.enabled AS enabled_before/);
    expect(pool.queries.filter((q) => q.sql.includes("FROM automations") && !q.sql.includes("INSERT"))).toHaveLength(1);
  });

  it("still answers 200 and invalidates when the audit insert fails", async () => {
    const pool = createPool({ failAudit: true });
    const onRulesChanged = vi.fn();
    const url = await startServer(pool, onRulesChanged);

    const res = await patch(url, 7, { enabled: true });
    await flush();

    expect(res.status).toBe(200);
    expect(onRulesChanged).toHaveBeenCalledTimes(1);
  });

  it("neither audits nor invalidates a 404 or a bad body", async () => {
    const pool = createPool({ row: null });
    const onRulesChanged = vi.fn();
    const url = await startServer(pool, onRulesChanged);

    expect((await patch(url, 99, { enabled: true })).status).toBe(404);
    expect((await patch(url, 7, { enabled: "yes" })).status).toBe(400);
    await flush();

    expect(onRulesChanged).not.toHaveBeenCalled();
    expect(pool.audits()).toHaveLength(0);
  });
});

describe("DELETE /api/automations/:id", () => {
  it("audits the deletion with the row's last state and invalidates the rule cache", async () => {
    const pool = createPool({ row: { id: 7, name: "Night", enabled: true } });
    const onRulesChanged = vi.fn();
    const url = await startServer(pool, onRulesChanged);

    const res = await fetch(`${url}/api/automations/7`, { method: "DELETE", headers: { Cookie: cookie() } });
    await flush();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(onRulesChanged).toHaveBeenCalledTimes(1);
    expect(pool.audits()[0].params.slice(0, 6)).toEqual([7, "Night", "delete", true, null, "user"]);
  });
});

describe("POST/PUT /api/automations (create and edit)", () => {
  const schedule = {
    automation_type: "schedule",
    device_type: "purifier",
    enabled: false,
    time_start: "22:00",
    time_end: "06:00",
    device_ids: ["pur1"],
    device_names: ["Purifier"],
  };
  const metric = {
    automation_type: "metric",
    device_type: "purifier",
    enabled: true,
    metric: "pm25",
    condition: "above",
    threshold: 35,
    device_ids: ["pur1"],
    device_names: ["Purifier"],
  };

  function send(url: string, method: "POST" | "PUT", body: unknown) {
    return fetch(`${url}/api/automations${method === "PUT" ? "/7" : ""}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie() },
      body: JSON.stringify(body),
    });
  }

  for (const [method, action] of [["POST", "create"], ["PUT", "update"]] as const) {
    for (const [kind, body] of [["schedule", schedule], ["metric", metric]] as const) {
      it(`${method} ${kind}: unchanged response, audit action=${action} with the saved enabled, cache invalidated`, async () => {
        const pool = createPool();
        const onRulesChanged = vi.fn();
        const url = await startServer(pool, onRulesChanged);

        const res = await send(url, method, body);
        await flush();

        expect(res.status).toBe(200);
        const json = (await res.json()) as Record<string, unknown>;
        expect(Object.keys(json)).toEqual(["automation"]);
        const automation = json.automation as { id: number; name: string; enabled: boolean };
        expect(automation.id).toBe(7);
        expect(automation.enabled).toBe(body.enabled);
        expect(onRulesChanged).toHaveBeenCalledTimes(1);
        const audits = pool.audits();
        expect(audits).toHaveLength(1);
        expect(audits[0].params.slice(0, 6)).toEqual([7, automation.name, action, null, body.enabled, "user"]);
      });
    }
  }

  it("PUT of a missing automation is a 404 with no audit and no invalidation", async () => {
    const pool = createPool({ row: null });
    const onRulesChanged = vi.fn();
    const url = await startServer(pool, onRulesChanged);

    expect((await send(url, "PUT", metric)).status).toBe(404);
    await flush();

    expect(onRulesChanged).not.toHaveBeenCalled();
    expect(pool.audits()).toHaveLength(0);
  });
});
