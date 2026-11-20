import { describe, expect, it } from "vitest";
import { ADMIN_ROLES, adminAbilities, adminCan, adminStaffAddSchema } from "./admin.js";

describe("Admin portal roles (ADR-037)", () => {
  it("gives each role only its own abilities", () => {
    expect(adminAbilities(["viewer"])).toEqual(["businesses.read", "people.read"]);
    expect(adminCan(["support"], "devices.stop")).toBe(true);
    expect(adminCan(["support"], "audit.read")).toBe(false);
    expect(adminCan(["operations"], "audit.read")).toBe(true);
    expect(adminCan(["finance", "viewer"], "support.act")).toBe(false);
    expect(adminAbilities(["super_admin"])).toHaveLength(8);
    expect(adminCan(["owner"], "businesses.read")).toBe(false);
  });

  it("only accepts known roles and real emails when adding staff", () => {
    expect(adminStaffAddSchema.parse({ email: " Ama@Bizora.test ", name: "Ama", roles: ["support"] }).email).toBe("ama@bizora.test");
    expect(adminStaffAddSchema.safeParse({ email: "ama@bizora.test", name: "Ama", roles: [] }).success).toBe(false);
    expect(adminStaffAddSchema.safeParse({ email: "ama@bizora.test", name: "Ama", roles: ["OWNER"] }).success).toBe(false);
    expect(ADMIN_ROLES).toContain("super_admin");
  });
});
