import { describe, expect, it } from "vitest";
import { ApiError } from "../../common/errors.js";
import { microsoftIssuer, safeReturnTo } from "./return-to.js";

describe("return paths and Microsoft issuers", () => {
  it("allows a same-origin relative path and defaults to the app", () => {
    expect(safeReturnTo("/app")).toBe("/app");
    expect(safeReturnTo("/app/settings?tab=security")).toBe("/app/settings?tab=security");
    expect(safeReturnTo(undefined)).toBe("/app");
    expect(safeReturnTo("")).toBe("/app");
  });

  it("rejects open redirects", () => {
    for (const value of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/app\\evil",
      "/%2f%2fevil.example",
      "/%2F%2Fevil.example",
      "/%5cevil.example",
      "http://localhost:3000/app",
      "/login?next=@evil.example",
    ]) {
      expect(() => safeReturnTo(value), value).toThrow(ApiError);
    }
  });

  it("checks the Microsoft issuer against the tenant id", () => {
    const tid = "11111111-1111-4111-8111-111111111111";
    expect(microsoftIssuer("https://login.microsoftonline.com/{tenantid}/v2.0", tid)).toBe(
      `https://login.microsoftonline.com/${tid}/v2.0`,
    );
    expect(microsoftIssuer("http://127.0.0.1:9/", tid)).toBe("http://127.0.0.1:9/");
    expect(() => microsoftIssuer("https://login.microsoftonline.com/{tenantid}/v2.0", "common")).toThrow(ApiError);
  });
});
