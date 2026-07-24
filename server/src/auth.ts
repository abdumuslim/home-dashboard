import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import type { Config } from "./config.js";

/** Who is behind an authenticated request: a human dashboard session or the Hermes agent. */
export type AuthKind = "user" | "agent";

declare module "express" {
  interface Request {
    authenticated?: boolean;
    authKind?: AuthKind;
  }
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function base64urlEncode(str: string): string {
  return base64url(Buffer.from(str));
}

export function signToken(payload: Record<string, unknown>, secret: string): string {
  const header = base64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64urlEncode(JSON.stringify(payload));
  const sig = base64url(createHmac("sha256", secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = base64url(createHmac("sha256", secret).update(`${header}.${body}`).digest());
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function safeCompare(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

function parseBearerToken(header: string | string[] | undefined): string | null {
  if (Array.isArray(header)) return null;
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function isHermesBearerRequest(req: Request, config: Config): boolean {
  if (!config.hermesApiToken) return false;
  const token = parseBearerToken(req.headers.authorization);
  return !!token && safeCompare(token, config.hermesApiToken);
}

// Cloudflare's published edge ranges (https://www.cloudflare.com/ips/, retrieved
// 2026-07-24). `cf-connecting-ip` is only trusted when the request's immediate
// upstream hop is one of these — see clientIp().
const CLOUDFLARE_RANGES: readonly string[] = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
  "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function ipv6ToBigInt(ip: string): bigint | null {
  const addr = ip.split("%")[0];
  if (!addr.includes(":")) return null;
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const expand = (segs: string[]): string[] | null => {
    const out: string[] = [];
    for (const grp of segs) {
      if (grp === "") continue;
      if (grp.includes(".")) {
        const v4 = ipv4ToInt(grp);
        if (v4 == null) return null;
        out.push(((v4 >>> 16) & 0xffff).toString(16), (v4 & 0xffff).toString(16));
      } else out.push(grp);
    }
    return out;
  };
  const head = expand(halves[0] ? halves[0].split(":") : []);
  const tail = expand(halves.length === 2 && halves[1] ? halves[1].split(":") : []);
  if (head == null || tail == null) return null;
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    groups = [...head, ...new Array(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    const v = parseInt(g, 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
    n = (n << 16n) | BigInt(v);
  }
  return n;
}

/** True when `ip` falls inside any CIDR in `ranges` (dependency-free v4 + v6). */
export function ipInRanges(ip: string, ranges: readonly string[]): boolean {
  const cleaned = ip.replace(/^::ffff:/i, "").split("%")[0];
  const isV4 = cleaned.includes(".") && !cleaned.includes(":");
  for (const cidr of ranges) {
    const slash = cidr.indexOf("/");
    if (slash < 0) continue;
    const base = cidr.slice(0, slash);
    const prefix = Number(cidr.slice(slash + 1));
    const baseV4 = base.includes(".") && !base.includes(":");
    if (isV4 !== baseV4) continue;
    if (isV4) {
      const ipN = ipv4ToInt(cleaned);
      const baseN = ipv4ToInt(base);
      if (ipN == null || baseN == null || prefix < 0 || prefix > 32) continue;
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      if ((ipN & mask) === (baseN & mask)) return true;
    } else {
      const ipN = ipv6ToBigInt(cleaned);
      const baseN = ipv6ToBigInt(base);
      if (ipN == null || baseN == null || prefix < 0 || prefix > 128) continue;
      const shift = BigInt(128 - prefix);
      if (prefix === 0 || ipN >> shift === baseN >> shift) return true;
    }
  }
  return false;
}

/** The immediate upstream hop: the RIGHTMOST X-Forwarded-For entry (appended by
 *  our own Traefik). Everything to its left is client-claimed and untrusted. */
function lastForwardedHop(req: Request): string | null {
  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff.join(",") : xff;
  if (!raw) return null;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

/**
 * Caller IP through the Cloudflare → Traefik chain, used for the audit trail and
 * the login rate limiter. `cf-connecting-ip` is trusted ONLY when the request
 * actually transited Cloudflare — i.e. the immediate upstream hop (rightmost
 * X-Forwarded-For entry, appended by our Traefik) is a published Cloudflare
 * address. A request that bypassed Cloudflare and hit the origin directly can
 * forge `cf-connecting-ip`, so we ignore it there and key on the real connecting
 * hop instead. Without this, an attacker could rotate the header per request and
 * evade the per-IP login limit entirely.
 */
export function clientIp(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  const hop = lastForwardedHop(req);
  if (typeof cf === "string" && cf.trim() && hop != null && ipInRanges(hop, CLOUDFLARE_RANGES)) {
    return cf.trim();
  }
  // Not verifiably from Cloudflare: never adopt the client-supplied X-Forwarded-For
  // as the value (only the CF check above reads it). Fall back to the real socket
  // peer — Traefik in production. An off-Cloudflare flood therefore buckets on the
  // proxy peer (bounded), while legitimate CF traffic keeps its per-client IP.
  return req.socket.remoteAddress || req.ip || "unknown";
}

export function createAuthMiddleware(config: Config) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.authenticated = false;
    req.authKind = undefined;
    if (!config.authSecret) {
      if (isHermesBearerRequest(req, config)) {
        req.authenticated = true;
        req.authKind = "agent";
      }
      next();
      return;
    }
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies["auth"];
    if (token) {
      const payload = verifyToken(token, config.authSecret);
      if (payload && payload.user === config.adminUser) {
        req.authenticated = true;
        // Sessions minted by /api/agent/session carry the agent claim; a human
        // dashboard login does not.
        req.authKind = payload.agent === true ? "agent" : "user";
      }
    }
    if (!req.authenticated && isHermesBearerRequest(req, config)) {
      req.authenticated = true;
      req.authKind = "agent";
    }
    next();
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.authenticated) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// In-memory rate limiter for login: max 5 attempts per IP per 15 minutes
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// Periodic cleanup of expired entries (every 15 min)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, RATE_LIMIT_WINDOW);

/** Test-only: clear the login rate-limiter buckets between cases. */
export function resetLoginRateLimiterForTests(): void {
  loginAttempts.clear();
}

export function handleLogin(config: Config) {
  return (req: Request, res: Response) => {
    // Per-IP via clientIp(): the real client through Cloudflare when the request
    // transited CF, else the true connecting hop (a forged cf-connecting-ip on a
    // direct-to-origin request can't shrink the bucket to one attempt per value).
    const ip = clientIp(req);
    if (!checkRateLimit(ip)) {
      res.status(429).json({ error: "Too many login attempts. Try again later." });
      return;
    }

    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) {
      res.status(400).json({ error: "Missing username or password" });
      return;
    }

    const userMatch = safeCompare(username, config.adminUser);
    const passMatch = safeCompare(password, config.adminPassword);

    if (!userMatch || !passMatch) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const token = signToken(
      { user: config.adminUser, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 },
      config.authSecret,
    );

    const isProduction = !!process.env.DATABASE_URL;
    res.setHeader(
      "Set-Cookie",
      `auth=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Strict${isProduction ? "; Secure" : ""}`,
    );
    res.json({ ok: true });
  };
}

export function handleAgentSession(config: Config) {
  return (req: Request, res: Response) => {
    if (!isHermesBearerRequest(req, config)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!config.authSecret || !config.adminUser) {
      res.status(503).json({ error: "Dashboard auth is not configured" });
      return;
    }

    // `agent: true` is what makes an agent-issued session distinguishable from a
    // human dashboard login for the rest of the app (audit trail, push bodies).
    const token = signToken(
      { user: config.adminUser, agent: true, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 },
      config.authSecret,
    );

    const isProduction = !!process.env.DATABASE_URL;
    res.setHeader(
      "Set-Cookie",
      `auth=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Strict${isProduction ? "; Secure" : ""}`,
    );
    res.json({ ok: true });
  };
}

export function handleLogout(_req: Request, res: Response) {
  res.setHeader(
    "Set-Cookie",
    "auth=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict",
  );
  res.json({ ok: true });
}

export function handleAuthStatus(req: Request, res: Response) {
  res.json({ authenticated: !!req.authenticated });
}
