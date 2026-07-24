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

/**
 * Caller IP through the Cloudflare → Traefik chain. Express `req.ip` only ever
 * sees Traefik, so `cf-connecting-ip` — which Cloudflare overwrites on every
 * request, making it unspoofable for traffic that actually transits CF — is the
 * trusted source. `x-forwarded-for` is deliberately NOT used: its leftmost entry
 * is whatever the client claimed, and this value is an audit record. Falling
 * back to the socket peer means a request that bypassed Cloudflare records as
 * the proxy address rather than as an attacker-chosen one, which is itself the
 * signal worth having.
 */
export function clientIp(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
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

export function handleLogin(config: Config) {
  return (req: Request, res: Response) => {
    // Behind Cloudflare → Traefik every request shares one socket peer, which
    // bucketed all login attempts into a single global 5/15min limit.
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
