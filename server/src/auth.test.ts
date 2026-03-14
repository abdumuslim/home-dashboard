import { describe, it, expect } from "vitest";
import { signToken, verifyToken } from "./auth.js";

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
