import { describe, expect, it } from "vitest";
import { confirmPasswordError } from "./password";

describe("confirm password", () => {
  it("accepts two identical values, including both empty", () => {
    expect(confirmPasswordError("LocalOnly!Passw0rd", "LocalOnly!Passw0rd")).toBeNull();
    expect(confirmPasswordError("", "")).toBeNull();
  });

  it("rejects values that differ", () => {
    expect(confirmPasswordError("LocalOnly!Passw0rd", "LocalOnly!Passw0rd!")).toBe("Passwords do not match.");
    expect(confirmPasswordError("LocalOnly!Passw0rd", "")).toBe("Passwords do not match.");
  });
});
