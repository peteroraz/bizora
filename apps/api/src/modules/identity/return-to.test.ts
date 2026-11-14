import { describe, expect, it } from "vitest";
import { ApiError } from "../../common/errors.js";
import { safeReturnTo } from "./return-to.js";

describe("return paths", () => {
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
});
