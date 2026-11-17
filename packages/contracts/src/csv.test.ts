import { describe, expect, it } from "vitest";
import { matchColumns, parseCsv, parseTraderDate, PRODUCT_IMPORT_COLUMNS, rowsFromCsv, SALES_IMPORT_COLUMNS } from "./csv.js";

describe("CSV", () => {
  it("handles quotes, commas, line breaks and a byte-order mark", () => {
    expect(parseCsv('\uFEFFname,price\r\n"Rice, 50kg","85,000"\n"Say ""hi""",1\n\n')).toEqual([
      ["name", "price"],
      ["Rice, 50kg", "85,000"],
      ['Say "hi"', "1"],
    ]);
  });

  it("matches the column names traders use", () => {
    expect(matchColumns(["Item", "Qty", "Selling Price", "Cost Price"], PRODUCT_IMPORT_COLUMNS)).toEqual({ name: 0, quantity: 1, price: 2, cost: 3 });
    const { rows } = rowsFromCsv("Date,Item,Qty,Amount,Paid by\n16/11/2026,Indomie,2,500,Cash\n", SALES_IMPORT_COLUMNS);
    expect(rows[0]).toMatchObject({ date: "16/11/2026", product: "Indomie", quantity: "2", total: "500", payment: "Cash", price: "" });
  });

  it("reads trader dates, day before month", () => {
    expect(parseTraderDate("16/11/2026")).toBe("2026-11-16");
    expect(parseTraderDate("5-1-26")).toBe("2026-01-05");
    expect(parseTraderDate("16 Nov 2026")).toBe("2026-11-16");
    expect(parseTraderDate("2026-11-16")).toBe("2026-11-16");
    expect(parseTraderDate("31/02/2026")).toBeNull();
    expect(parseTraderDate("yesterday")).toBeNull();
  });
});

describe("bank statement dates", () => {
  it("reads the formats Nigerian banks export", () => {
    expect(parseTraderDate("16/11/2026 10:22:01")).toBe("2026-11-16");
    expect(parseTraderDate("2026-11-16T10:22")).toBe("2026-11-16");
    expect(parseTraderDate("16-Nov-2026")).toBe("2026-11-16");
    expect(parseTraderDate("16-Nov-26")).toBe("2026-11-16");
    expect(parseTraderDate("16 November, 2026")).toBe("2026-11-16");
    expect(parseTraderDate("16 Nov 2026 3:04 PM")).toBe("2026-11-16");
  });
});
