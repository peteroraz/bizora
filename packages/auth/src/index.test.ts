import { describe, expect, it } from "vitest";
import { hashPassword, readBearerToken, signAccessToken, verifyAccessToken, verifyPassword } from "./index.js";

const secret = "test-secret-must-be-at-least-32-chars";

describe("auth primitives", () => {
  it("hashes and verifies passwords with argon2id", async () => {
    const hash = await hashPassword("correct-horse-battery");
    expect(hash).not.toContain("correct-horse-battery");
    await expect(verifyPassword(hash, "correct-horse-battery")).resolves.toBe(true);
    await expect(verifyPassword(hash, "wrong-password")).resolves.toBe(false);
  });

  it("round-trips tenant claims in signed tokens", async () => {
    const token = await signAccessToken(
      {
        sub: "11111111-1111-4111-8111-111111111111",
        org: "22222222-2222-4222-8222-222222222222",
        bid: "33333333-3333-4333-8333-333333333333",
        br: null,
        mid: "44444444-4444-4444-8444-444444444444",
        role: "OWNER",
      },
      secret,
      "15m",
    );
    const claims = await verifyAccessToken(token, secret);
    expect(claims.org).toBe("22222222-2222-4222-8222-222222222222");
    expect(claims.role).toBe("OWNER");
  });

  it("parses bearer tokens", () => {
    expect(readBearerToken("Bearer abc")).toBe("abc");
    expect(readBearerToken("Basic abc")).toBeNull();
  });
});
