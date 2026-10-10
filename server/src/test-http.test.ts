import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { FETCH_BAD_PORTS, listenOnFetchSafePort } from "./test-http.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    if (!s.listening) return resolve();
    s.close(() => resolve());
  })));
});

// Makes the first `badPorts.length` servers report a bad port, then behaves normally.
function appReportingBadPorts(badPorts: number[]) {
  const app = express();
  const realListen = app.listen.bind(app) as (...args: unknown[]) => Server;
  const opened: Server[] = [];
  (app as unknown as { listen: (...args: unknown[]) => Server }).listen = (...args) => {
    const server = realListen(...args);
    opened.push(server);
    const fake = badPorts[opened.length - 1];
    if (fake !== undefined) server.address = () => ({ address: "127.0.0.1", family: "IPv4", port: fake });
    return server;
  };
  return { app, opened };
}

describe("FETCH_BAD_PORTS", () => {
  it("holds the well-known refused ports and not ordinary ones", () => {
    for (const port of [2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6669, 6679, 6697, 10080]) {
      expect(FETCH_BAD_PORTS.has(port)).toBe(true);
    }
    expect(FETCH_BAD_PORTS.has(8000)).toBe(false);
  });
});

describe("listenOnFetchSafePort", () => {
  it("returns a listening server on a port outside the bad list", async () => {
    const server = await listenOnFetchSafePort(express());
    servers.push(server);
    expect(server.listening).toBe(true);
    expect(FETCH_BAD_PORTS.has((server.address() as AddressInfo).port)).toBe(false);
  });

  it("closes a server that was given a bad port and listens again", async () => {
    const { app, opened } = appReportingBadPorts([6000, 6666]);
    const server = await listenOnFetchSafePort(app);
    servers.push(...opened);
    expect(opened).toHaveLength(3);
    expect(server).toBe(opened[2]);
    expect(opened[0]!.listening).toBe(false);
    expect(opened[1]!.listening).toBe(false);
    expect(server.listening).toBe(true);
  });

  it("throws a clear error once the bounded retries run out", async () => {
    const { app, opened } = appReportingBadPorts(Array(20).fill(6000));
    await expect(listenOnFetchSafePort(app)).rejects.toThrow(/No fetch-safe ephemeral port after 20 attempts/);
    servers.push(...opened);
    expect(opened).toHaveLength(20);
    expect(opened.every((s) => !s.listening)).toBe(true);
  });
});
