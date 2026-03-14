import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import type { Config } from "./config.js";

declare module "express" {
  interface Request {
    authenticated?: boolean;
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

export function createAuthMiddleware(config: Config) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.authenticated = false;
    if (!config.authSecret) {
      next();
      return;
    }
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies["auth"];
    if (token) {
      const payload = verifyToken(token, config.authSecret);
      if (payload && payload.user === config.adminUser) {
        req.authenticated = true;
      }
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
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (!checkRateLimit(ip)) {
      res.status(429).json({ error: "Too many login attempts. Try again later." });
      return;
    }

    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) {
      res.status(400).json({ error: "Missing username or password" });
      return;
    }

    const userMatch =
      username.length === config.adminUser.length &&
      timingSafeEqual(Buffer.from(username), Buffer.from(config.adminUser));
    const passMatch =
      password.length === config.adminPassword.length &&
      timingSafeEqual(Buffer.from(password), Buffer.from(config.adminPassword));

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
