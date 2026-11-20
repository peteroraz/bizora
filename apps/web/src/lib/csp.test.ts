import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, newNonce } from "./csp";

describe("content security policy", () => {
  it("lets only this page's scripts run, loads nothing from other sites, and cannot be framed", () => {
    const policy = contentSecurityPolicy("abc", { https: true, development: false });
    expect(policy).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(policy).not.toMatch(/'unsafe-eval'/);
    // Offline voice's WebAssembly may compile, which does not allow eval() (ADR-040).
    expect(policy).toContain("'wasm-unsafe-eval'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("upgrade-insecure-requests");
    expect(contentSecurityPolicy("abc", { https: false, development: true })).toContain("'unsafe-eval'");
    expect(contentSecurityPolicy("abc", { https: false, development: false })).not.toContain("upgrade-insecure-requests");
  });

  it("makes a different nonce every time", () => {
    const one = newNonce();
    expect(one).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newNonce()).not.toBe(one);
  });
});
