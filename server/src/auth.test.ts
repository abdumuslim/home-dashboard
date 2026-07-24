import { describe, it, expect } from "vitest";
import type { Request, Response } from "express";
import { clientIp, handleLogin, ipInRanges, resetLoginRateLimiterForTests, signToken, verifyToken } from "./auth.js";
import type { Config } from "./config.js";

const SECRET = "test-secret-key-for-jwt";

describe("JWT auth", () => {
  it("signs and verifies a valid token", () => {
    const payload = { user: "admin", exp: Date.now() + 60_000 };
    const token = signToken(payload, SECRET);
    const decoded = verifyToken(token, SECRET);
    expect(decoded).not.toBeNull();
    expect(decoded!.user).toBe("admin");
  });

  it("rejects a token with wrong secret", () => {
    const token = signToken({ user: "admin", exp: Date.now() + 60_000 }, SECRET);
    const decoded = verifyToken(token, "wrong-secret");
    expect(decoded).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signToken({ user: "admin", exp: Date.now() - 1000 }, SECRET);
    const decoded = verifyToken(token, SECRET);
    expect(decoded).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(verifyToken("not.a.valid.token", SECRET)).toBeNull();
    expect(verifyToken("abc", SECRET)).toBeNull();
    expect(verifyToken("", SECRET)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = signToken({ user: "admin", exp: Date.now() + 60_000 }, SECRET);
    const [header, , sig] = token.split(".");
    // Tamper with payload
    const tamperedBody = Buffer.from(JSON.stringify({ user: "hacker", exp: Date.now() + 60_000 })).toString("base64url");
    const tampered = `${header}.${tamperedBody}.${sig}`;
    expect(verifyToken(tampered, SECRET)).toBeNull();
  });

  it("handles token without exp field", () => {
    const token = signToken({ user: "admin" }, SECRET);
    const decoded = verifyToken(token, SECRET);
    expect(decoded).not.toBeNull();
    expect(decoded!.user).toBe("admin");
  });
});

function makeReq(headers: Record<string, string | string[]>, socketIp = "172.20.0.5"): Request {
  return {
    headers,
    socket: { remoteAddress: socketIp },
    ip: socketIp,
    body: { username: "admin", password: "wrong-password" },
  } as unknown as Request;
}

function makeRes(): Response & { statusCode: number; body?: unknown } {
  const res = { statusCode: 200 } as Response & { statusCode: number; body?: unknown };
  res.status = ((c: number) => { res.statusCode = c; return res; }) as Response["status"];
  res.json = ((b: unknown) => { res.body = b; return res; }) as Response["json"];
  res.setHeader = (() => res) as unknown as Response["setHeader"];
  return res;
}

const AUTH_CONFIG = { adminUser: "admin", adminPassword: "correct-password", authSecret: SECRET } as unknown as Config;
const CF_HOP = "162.158.1.1"; // inside Cloudflare's 162.158.0.0/15
const DIRECT_HOP = "203.0.113.7"; // TEST-NET-3, not Cloudflare

describe("clientIp (Cloudflare-gated)", () => {
  it("ignores a forged cf-connecting-ip when the connection did not transit Cloudflare", () => {
    // Upstream hop is not a Cloudflare address → cf-connecting-ip is untrusted,
    // and a client-supplied XFF is never adopted as the value: fall back to the
    // real socket peer (Traefik in production).
    const ip = clientIp(makeReq({ "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": DIRECT_HOP }, "172.20.0.5"));
    expect(ip).toBe("172.20.0.5");
    expect(ip).not.toBe("9.9.9.9");
  });

  it("trusts cf-connecting-ip when the upstream hop is a Cloudflare address", () => {
    const ip = clientIp(makeReq({ "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": `9.9.9.9, ${CF_HOP}` }));
    expect(ip).toBe("9.9.9.9");
  });

  it("falls back to the socket peer when no forwarding header is present", () => {
    expect(clientIp(makeReq({}, "172.20.0.9"))).toBe("172.20.0.9");
  });

  it("ipInRanges matches v4 and v6 Cloudflare CIDRs", () => {
    expect(ipInRanges("162.158.1.1", ["162.158.0.0/15"])).toBe(true);
    expect(ipInRanges("203.0.113.7", ["162.158.0.0/15"])).toBe(false);
    expect(ipInRanges("2606:4700:1::1", ["2606:4700::/32"])).toBe(true);
    expect(ipInRanges("::ffff:104.16.0.1", ["104.16.0.0/13"])).toBe(true); // v4-mapped v6
  });
});

describe("login rate limiter (per real IP)", () => {
  it("cannot be bypassed by rotating cf-connecting-ip on a non-Cloudflare connection", () => {
    resetLoginRateLimiterForTests();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = makeRes();
      // Distinct spoofed cf-connecting-ip each time, but the real upstream hop is
      // NOT Cloudflare — so all six key on the same DIRECT_HOP bucket.
      handleLogin(AUTH_CONFIG)(makeReq({ "cf-connecting-ip": `1.2.3.${i}`, "x-forwarded-for": DIRECT_HOP }), res);
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });

  it("keys per cf-connecting-ip for requests that transit Cloudflare", () => {
    resetLoginRateLimiterForTests();
    // Exhaust client A's bucket (5 attempts through Cloudflare).
    for (let i = 0; i < 5; i++) {
      handleLogin(AUTH_CONFIG)(makeReq({ "cf-connecting-ip": "5.5.5.5", "x-forwarded-for": `5.5.5.5, ${CF_HOP}` }), makeRes());
    }
    const sixthA = makeRes();
    handleLogin(AUTH_CONFIG)(makeReq({ "cf-connecting-ip": "5.5.5.5", "x-forwarded-for": `5.5.5.5, ${CF_HOP}` }), sixthA);
    expect(sixthA.statusCode).toBe(429); // A is limited
    const firstB = makeRes();
    handleLogin(AUTH_CONFIG)(makeReq({ "cf-connecting-ip": "6.6.6.6", "x-forwarded-for": `6.6.6.6, ${CF_HOP}` }), firstB);
    expect(firstB.statusCode).toBe(401); // B has its own independent bucket
  });
});
