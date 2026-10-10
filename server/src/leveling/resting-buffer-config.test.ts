import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { createRouter, type AcLevelingHandlers } from "../routes.js";
import type { Config } from "../config.js";
import { signToken } from "../auth.js";
import { LevelingControllerV2 } from "./controller.js";
import type { LevelingDeps } from "./api.js";

// 2026-09-27: the dashboard's "Raise buffer A" edited row 1's `raiseBufferAmps`,
// but the acting v2 controller reads `restingBufferAmps`, which
// mergeLevelingConfigV2 prefers once row 2 carries it, and every UI save
// round-tripped the stale row-2 value. The UI now writes BOTH keys; these tests
// pin that such a save reaches the controller, and why a raise-only save did not.

const TEST_CONFIG = { authSecret: "auth-secret", adminUser: "admin", adminPassword: "password" } as Config;

function createMockPool() {
  const configById = new Map<number, Record<string, unknown>>();
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM ac_leveling_config") && sql.includes("id IN (1, 2)")) {
      const rows = [1, 2].filter((id) => configById.has(id)).map((id) => ({ id, config: configById.get(id) }));
      return { rows, rowCount: rows.length };
    }
    const selectId = /SELECT config FROM ac_leveling_config WHERE id = (\d)/.exec(sql);
    if (selectId) {
      const id = Number(selectId[1]);
      return { rows: configById.has(id) ? [{ config: configById.get(id) }] : [], rowCount: configById.has(id) ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO ac_leveling_config (id")) {
      const id = Number(/VALUES \((\d)/.exec(sql)?.[1] ?? 2);
      configById.set(id, JSON.parse(String(params[0])));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("COUNT(*)") && sql.includes("ac_leveling_costs")) return { rows: [{ n: 0 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as never, configById };
}

function createDeps(): LevelingDeps {
  return {
    getTclCloud: () => null,
    broadcast: async () => undefined,
    setDevicePowerCache: () => undefined,
    isManualOffLocked: async () => false,
    onLevelerFanCommand: () => undefined,
  };
}

/** Wired the way index.ts wires it while v2 is the acting controller. */
function handlersFor(controller: LevelingControllerV2): AcLevelingHandlers {
  return {
    getConfig: () => controller.getConfig(),
    updateConfig: (cfg) => controller.updateConfig(cfg as never),
    getStatus: () => controller.getStatus() as never,
    onUserPowerOff: async () => undefined,
    onUserPowerOn: async () => undefined,
    onUserGenLevel: async (_id, level) => ({ reverted: false, level }),
    updateV2Config: (cfg) => controller.updateConfig(cfg),
  };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  })));
});

async function setup() {
  const mock = createMockPool();
  // Today's live shape: both rows carry 0.2.
  mock.configById.set(1, { gridLimitAmps: 30, genLimitAmps: 15, marginAmps: 1, raiseBufferAmps: 0.2 });
  mock.configById.set(2, { controller: "v2", enabled: true, restingBufferAmps: 0.2 });
  const controller = new LevelingControllerV2(mock.pool, createDeps());
  await controller.ensureLoaded();

  const app = express();
  app.use(express.json());
  app.use(createRouter(
    mock.pool,
    TEST_CONFIG,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    handlersFor(controller),
  ));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server port");
  return { controller, mock, url: `http://127.0.0.1:${address.port}` };
}

const baseBody = {
  enabled: true,
  gridLimitAmps: 30,
  genLimitAmps: 15,
  marginAmps: 1,
  comfortTargetC: 24,
  priority: [],
  ampModels: {},
};

function put(url: string, body: Record<string, unknown>) {
  const cookie = `auth=${signToken({ user: "admin", exp: Date.now() + 60_000 }, TEST_CONFIG.authSecret)}`;
  return fetch(`${url}/api/ac/leveling`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

const restingBufferOf = async (c: LevelingControllerV2) => (await c.getConfig()).restingBufferAmps;

describe("PUT /api/ac/leveling: the raise buffer reaches the acting controller (2026-09-27)", () => {
  it("a save carrying raiseBufferAmps AND a matching restingBufferAmps changes the effective resting buffer", async () => {
    const { controller, mock, url } = await setup();
    expect(await restingBufferOf(controller)).toBe(0.2);

    const res = await put(url, { ...baseBody, raiseBufferAmps: 0.7, restingBufferAmps: 0.7 });

    expect(res.status).toBe(200);
    expect(await restingBufferOf(controller)).toBe(0.7);
    // Both rows move together, so neither can later shadow the other.
    expect(mock.configById.get(1)?.raiseBufferAmps).toBe(0.7);
    expect(mock.configById.get(2)?.restingBufferAmps).toBe(0.7);
    const body = (await res.json()) as { config: Record<string, unknown> };
    expect(body.config.restingBufferAmps).toBe(0.7);
  });

  it("documents the old bug: raiseBufferAmps with the stale round-tripped restingBufferAmps changes nothing the controller reads", async () => {
    const { controller, url } = await setup();

    const res = await put(url, { ...baseBody, raiseBufferAmps: 0.7, restingBufferAmps: 0.2 });

    expect(res.status).toBe(200);
    expect(await restingBufferOf(controller)).toBe(0.2);
  });
});
