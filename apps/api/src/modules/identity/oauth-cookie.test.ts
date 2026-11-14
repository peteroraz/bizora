import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openOauthTransaction, sealOauthTransaction, type OauthTransaction } from "./oauth-cookie.js";

const secret = "test-secret-must-be-at-least-32-chars";

function transaction(iat: number): OauthTransaction {
  return {
    provider: "google",
    state: "state-value",
    nonce: "nonce-value",
    codeVerifier: "verifier-value",
    returnTo: "/app",
    intent: "login",
    iat,
  };
}

function sealWithoutIssuedAt(payload: Omit<OauthTransaction, "iat">): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

describe("oauth transaction cookie", () => {
  it("accepts a transaction sealed within 10 minutes", () => {
    const opened = openOauthTransaction(sealOauthTransaction(transaction(Date.now() - 9 * 60 * 1000), secret), secret);
    expect(opened?.state).toBe("state-value");
    expect(opened?.iat).toEqual(expect.any(Number));
  });

  it("rejects a transaction older than 10 minutes and one with no issued-at time", () => {
    expect(openOauthTransaction(sealOauthTransaction(transaction(Date.now() - 11 * 60 * 1000), secret), secret)).toBeNull();
    const { iat: _iat, ...withoutIssuedAt } = transaction(Date.now());
    expect(openOauthTransaction(sealWithoutIssuedAt(withoutIssuedAt), secret)).toBeNull();
  });
});
