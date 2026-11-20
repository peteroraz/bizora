import { describe, expect, it } from "vitest";
import { chartOfAccountsTemplate } from "./ledger.js";
import { isUuidV7, uuidv7, uuidv7Time } from "./ids.js";
import { formatOfficialNumber, provisionalNumber, syncPushSchema } from "./sync.js";

describe("client IDs", () => {
  it("makes valid, unique, time-ordered UUIDv7s", () => {
    const first = uuidv7(1_700_000_000_000);
    const second = uuidv7(1_700_000_000_001);
    expect(isUuidV7(first)).toBe(true);
    expect(uuidv7Time(first)).toBe(1_700_000_000_000);
    expect(first < second).toBe(true);
    const many = new Set(Array.from({ length: 1000 }, () => uuidv7()));
    expect(many.size).toBe(1000);
    expect(isUuidV7("8f0d9c5e-0d7f-4c55-9d3f-2a4b6e7c8d90")).toBe(false);
  });
});

describe("sync push", () => {
  it("accepts device operations and refuses non-v7 IDs and large batches", () => {
    const operation = { id: uuidv7(), type: "customer.create", occurredAt: new Date().toISOString(), payload: { name: "Chika" } };
    expect(syncPushSchema.safeParse({ operations: [operation] }).success).toBe(true);
    expect(syncPushSchema.safeParse({ operations: [{ ...operation, id: "8f0d9c5e-0d7f-4c55-9d3f-2a4b6e7c8d90" }] }).success).toBe(false);
    expect(syncPushSchema.safeParse({ operations: [{ ...operation, type: "sale.delete" }] }).success).toBe(false);
    expect(syncPushSchema.safeParse({ operations: Array.from({ length: 51 }, () => ({ ...operation, id: uuidv7() })) }).success).toBe(false);
  });
});

describe("document numbers", () => {
  it("formats official and provisional numbers", () => {
    expect(formatOfficialNumber("receipt", 45n)).toBe("R-000045");
    expect(formatOfficialNumber("invoice", 1234567)).toBe("INV-1234567");
    expect(provisionalNumber(3, 45)).toBe("DEV3-000045");
  });
});

describe("chart of accounts template", () => {
  it("gives every business stock, jobs in progress and service income; services earn service income", () => {
    const shop = chartOfAccountsTemplate("shop");
    expect(shop.map((account) => account.role)).toEqual(expect.arrayContaining(["stock", "sales", "service_income", "cogs", "jobs_in_progress", "debtors", "bank"]));
    // Service businesses keep parts for jobs (ADR-035), but have no goods "Sales" account.
    const services = chartOfAccountsTemplate("services");
    expect(services.map((account) => account.role)).toEqual(expect.arrayContaining(["stock", "cogs", "jobs_in_progress"]));
    expect(services.some((account) => account.role === "sales")).toBe(false);
    expect(services.find((account) => account.code === "4000")?.role).toBe("service_income");
  });

  it("has unique codes, and changes for one type do not leak into another", () => {
    for (const type of ["shop", "market-stall", "wholesale", "food", "services", "other"] as const) {
      const codes = chartOfAccountsTemplate(type).map((account) => account.code);
      expect(new Set(codes).size).toBe(codes.length);
    }
    expect(chartOfAccountsTemplate("food").find((account) => account.role === "cogs")?.name).toBe("Cost of food and drinks sold");
    expect(chartOfAccountsTemplate("shop").find((account) => account.role === "cogs")?.name).toBe("Cost of goods sold");
  });
});
