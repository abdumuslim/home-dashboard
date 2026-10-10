// Test-support module (not a test): localhost HTTP servers for fetch-driven route tests.
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// WHATWG Fetch "bad port" list, enforced by Node's undici fetch ("bad port" TypeError).
// It matters here because this PC's dynamic port range starts at 1024, so listen(0) can
// hand out a port fetch refuses before the request ever leaves the process.
export const FETCH_BAD_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
  5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const MAX_ATTEMPTS = 20;

function listenOnce(app: Express): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(0, () => resolve(server));
    server.once("error", reject);
  });
}

/** Listens on an ephemeral port that fetch accepts, retrying while the OS hands out a bad one. */
export async function listenOnFetchSafePort(app: Express): Promise<Server> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const server = await listenOnce(app);
    const { port } = server.address() as AddressInfo;
    if (!FETCH_BAD_PORTS.has(port)) return server;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error(`No fetch-safe ephemeral port after ${MAX_ATTEMPTS} attempts`);
}
