import { DEVICE_COOKIE as API_DEVICE, REFRESH_COOKIE as API_REFRESH, SESSION_COOKIE as API_SESSION } from "../../../../packages/auth/src/index";
import { describe, expect, it } from "vitest";
import { cookiePair, DEVICE_COOKIE, isSignedOutError, passNeedsRenewal, REFRESH_COOKIE, SESSION_COOKIE } from "./session-pass";

const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

describe("session pass", () => {
  it("uses the same cookie names as the API", () => {
    expect([SESSION_COOKIE, REFRESH_COOKIE, DEVICE_COOKIE]).toEqual([API_SESSION, API_REFRESH, API_DEVICE]);
  });

  it("renews a missing, broken or nearly expired pass, and leaves a fresh one", () => {
    const now = 1_800_000_000_000;
    expect(passNeedsRenewal(undefined, now)).toBe(true);
    expect(passNeedsRenewal("not-a-token", now)).toBe(true);
    expect(passNeedsRenewal(jwt({ exp: now / 1000 + 30 }), now)).toBe(true);
    expect(passNeedsRenewal(jwt({ exp: now / 1000 + 600 }), now)).toBe(false);
    expect(passNeedsRenewal(jwt({ sub: "no-expiry" }), now)).toBe(true);
  });

  it("reads the name and value from a Set-Cookie header", () => {
    expect(cookiePair("bizora_session=abc.def=; Path=/; HttpOnly")).toEqual(["bizora_session", "abc.def="]);
    expect(cookiePair("=broken")).toBeNull();
  });

  it("treats only a signed-out 401 as signed out, not a wrong password", () => {
    expect(isSignedOutError({ error: { code: "UNAUTHENTICATED" } })).toBe(true);
    expect(isSignedOutError(null)).toBe(true);
    expect(isSignedOutError({ error: { code: "INVALID_CREDENTIALS" } })).toBe(false);
    expect(isSignedOutError({ error: { code: "INVALID_PIN" } })).toBe(false);
  });
});
