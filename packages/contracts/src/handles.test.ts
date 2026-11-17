import { describe, expect, it } from "vitest";
import { handleFromName, handleSchema, isReservedHandle } from "./handles.js";

describe("business link names", () => {
  it("makes a tidy first suggestion from the business name", () => {
    expect(handleFromName("Ada's Stores & Co.")).toBe("adas-stores-co");
    expect(handleFromName("Café Délice")).toBe("cafe-delice");
    expect(handleFromName("A1")).toBe("a1-shop");
    expect(handleFromName("Login")).toBe("login-shop");
    expect(handleFromName("你好")).toBe("my-shop");
  });

  it("accepts good names and refuses reserved or badly formed ones", () => {
    expect(handleSchema.parse(" Ada-Stores ")).toBe("ada-stores");
    for (const bad of ["ab", "-ada", "ada-", "ada--stores", "ada stores", "app", "api", "bizora-help", "x".repeat(41)]) {
      expect(handleSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(isReservedHandle("_next")).toBe(true);
  });
});
