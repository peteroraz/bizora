import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A browser where every request, renewal included, comes back signed out: what the old page sees mid-switch. */
function signedOutEverywhere() {
  const location = { href: "http://localhost/app/stock", pathname: "/app/stock", search: "" };
  vi.stubGlobal("window", { location, localStorage: { getItem: () => null } });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Session revoked." } }), { status: 401 })),
  );
  return location;
}

describe("a request that comes back signed out", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the sign-in page when renewing fails", async () => {
    const location = signedOutEverywhere();
    const { api } = await import("./api");
    await api("/api/v1/notifications");
    expect(location.href).toBe("/login?reason=session&returnTo=%2Fapp%2Fstock");
  });

  it("stays put while the person is switching shop, then behaves as usual if the switch did not happen", async () => {
    const location = signedOutEverywhere();
    const { api, beginSwitch } = await import("./api");
    const stay = beginSwitch();
    const response = await api("/api/v1/notifications");
    expect(response.status).toBe(401);
    expect(location.href).toBe("http://localhost/app/stock");
    stay();
    stay();
    await api("/api/v1/notifications");
    expect(location.href).toBe("/login?reason=session&returnTo=%2Fapp%2Fstock");
  });
});
