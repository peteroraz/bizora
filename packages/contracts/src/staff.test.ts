import { describe, expect, it } from "vitest";
import { CUSTOMER_IMPORT_MAX_ROWS, parseCustomerCsv } from "./customers.js";
import { createStaffSchema, isWeakPin, pinSchema } from "./staff.js";

describe("staff PIN rules", () => {
  it("refuses repeated digits and runs", () => {
    for (const pin of ["1111", "000000", "1234", "4567", "9876", "3210", "8901", "123456"]) {
      expect(isWeakPin(pin)).toBe(true);
      expect(pinSchema.safeParse(pin).success).toBe(false);
    }
  });

  it("accepts ordinary PINs of 4 to 6 digits", () => {
    for (const pin of ["4821", "5093", "730162"]) expect(pinSchema.safeParse(pin).success).toBe(true);
    for (const pin of ["482", "4821739", "48a1", " 4821"]) expect(pinSchema.safeParse(pin).success).toBe(false);
  });

  it("only lets shop roles be created as PIN staff", () => {
    const base = { displayName: "Chika", branchId: "8f0d9c5e-0d7f-4c55-9d3f-2a4b6e7c8d90", pin: "4821" };
    expect(createStaffSchema.safeParse({ ...base, role: "SALES" }).success).toBe(true);
    expect(createStaffSchema.safeParse({ ...base, role: "OWNER" }).success).toBe(false);
    expect(createStaffSchema.safeParse({ ...base, role: "MANAGER" }).success).toBe(false);
  });
});

describe("customer CSV row cap", () => {
  it("rejects files over the row limit with a plain message", () => {
    const rows = Array.from({ length: CUSTOMER_IMPORT_MAX_ROWS + 1 }, (_, i) => `Customer ${i},080${String(i).padStart(8, "0")},,`);
    const result = parseCustomerCsv(["name,phone,email,notes", ...rows].join("\n"));
    expect(result.rows).toHaveLength(0);
    expect(result.error).toContain(`at most ${CUSTOMER_IMPORT_MAX_ROWS} rows`);
    const atLimit = parseCustomerCsv(["name,phone,email,notes", ...rows.slice(0, CUSTOMER_IMPORT_MAX_ROWS)].join("\n"));
    expect(atLimit.error).toBeUndefined();
    expect(atLimit.rows).toHaveLength(CUSTOMER_IMPORT_MAX_ROWS);
  });
});
