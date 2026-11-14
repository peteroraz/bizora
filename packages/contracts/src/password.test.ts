import { describe, expect, it } from "vitest";
import { registerRequestSchema } from "./index.js";
import { passwordRules, passwordSchema } from "./password.js";

describe("password schema", () => {
  it("accepts a password that meets every published rule and rejects the others", () => {
    expect(passwordSchema.safeParse("LocalOnly!Passw0rd").success).toBe(true);
    expect(passwordRules.map((rule) => [rule.id, rule.met("short")])).toEqual([
      ["min-length", false],
      ["max-length", true],
    ]);
    expect(passwordRules.map((rule) => [rule.id, rule.met("x".repeat(129))])).toEqual([
      ["min-length", true],
      ["max-length", false],
    ]);
  });

  it("reports the same rule text when registration parses a short password", () => {
    const parsed = registerRequestSchema.safeParse({
      email: "ada@bizora.test",
      password: "short",
      displayName: "Ada",
      organizationName: "Ada Foods",
      countryCode: "ng",
      baseCurrencyCode: "ngn",
      timezone: "Africa/Lagos",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.message)).toContain("At least 12 characters");
    expect(parsed.error.issues.some((issue) => issue.path.join(".") === "password")).toBe(true);
  });
});
