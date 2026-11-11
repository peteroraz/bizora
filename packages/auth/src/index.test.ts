import { describe, expect, it } from "vitest";
import { hashPassword, readBearerToken, signAccessToken, verifyAccessToken, verifyPassword } from "./index.js";

const secret = "test-secret-must-be-at-least-32-chars";
const claims = {
  sub: "11111111-1111-4111-8111-111111111111",
  sid: "55555555-5555-4555-8555-555555555555",
  typ: "access" as const,
  org: "22222222-2222-4222-8222-222222222222",
  bid: "33333333-3333-4333-8333-333333333333",
  br: null,
  mid: "44444444-4444-4444-8444-444444444444",
};

describe("auth primitives", () => {
  it("hashes and verifies passwords with argon2id", async () => {
    const hash = await hashPassword("correct-horse-battery");
    expect(hash).not.toContain("correct-horse-battery");
    await expect(verifyPassword(hash, "correct-horse-battery")).resolves.toBe(true);
    await expect(verifyPassword(hash, "wrong-password")).resolves.toBe(false);
  });

  it("round-trips tenant claims in signed tokens", async () => {
    const token = await signAccessToken(claims, secret, "15m");
    const verified = await verifyAccessToken(token, secret);
    expect(verified.org).toBe(claims.org);
    expect(verified.sid).toBe(claims.sid);
    expect(verified.typ).toBe("access");
  });

  it("rejects malformed claims", async () => {
    const token = await signAccessToken(claims, secret, "15m");
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) throw new Error("token parts");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as { sub: string };
    payload.sub = "not-a-uuid";
    const malformed = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
    await expect(verifyAccessToken(malformed, secret)).rejects.toBeTruthy();
  });

  it("parses bearer tokens", () => {
    expect(readBearerToken("Bearer abc")).toBe("abc");
    expect(readBearerToken("Basic abc")).toBeNull();
  });
});
