import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EARLY_MAX_AGE_MS, EARLY_REQUESTS, earlyRequestScript, takeEarly } from "./early-requests";

/** Runs the page's script as a browser would, in a bare window with the given address. */
function runScript(pathname: string, search = "", fetchImpl: (url: string) => Promise<unknown> = async () => ({ ok: true })) {
  const fetch = vi.fn(fetchImpl);
  const page: Record<string, unknown> = { location: { pathname, search }, fetch, Date };
  page.window = page;
  runInNewContext(earlyRequestScript(), page);
  return { page, fetch };
}

describe("ADR-072: a screen's first requests start from its HTML", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts the stock screen's list, with the sign-in cookie, and nothing for other screens", () => {
    const { page, fetch } = runScript("/app/stock");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([...(EARLY_REQUESTS["/app/stock"] ?? [])]);
    expect(fetch).toHaveBeenCalledWith("/api/v1/products?page=1", { credentials: "include" });
    expect(Object.keys(page.__bizoraEarly as object)).toContain("/api/v1/products?page=1");

    expect(runScript("/app/money").fetch).not.toHaveBeenCalled();
    // A search or filter in the address means the screen asks for something else.
    expect(runScript("/app/stock", "?q=rice").fetch).not.toHaveBeenCalled();
  });

  it("never throws or reports an error when there is no network", async () => {
    const { page } = runScript("/app/customers", "", () => Promise.reject(new TypeError("Failed to fetch")));
    const store = page.__bizoraEarly as Record<string, { response: Promise<unknown> }>;
    await expect(store["/api/v1/customers?page=1"]?.response).rejects.toThrow("Failed to fetch");
  });

  it("hands each early answer over once, and not when it is too old", () => {
    const fresh = Promise.resolve(new Response("{}"));
    const stale = Promise.resolve(new Response("{}"));
    vi.stubGlobal("window", { __bizoraEarly: { "/api/v1/customers?page=1": { at: 1_000, response: fresh }, "/api/v1/notifications": { at: 1_000, response: stale } } });
    expect(takeEarly("/api/v1/customers?page=1", 1_000 + EARLY_MAX_AGE_MS)).toBe(fresh);
    expect(takeEarly("/api/v1/customers?page=1", 1_000 + EARLY_MAX_AGE_MS)).toBeNull();
    expect(takeEarly("/api/v1/notifications", 1_001 + EARLY_MAX_AGE_MS)).toBeNull();
    expect(takeEarly("/api/v1/products?page=1")).toBeNull();
  });

  it("is safe to place in HTML: the address list cannot close the script tag", () => {
    expect(earlyRequestScript()).not.toContain("</");
  });
});
