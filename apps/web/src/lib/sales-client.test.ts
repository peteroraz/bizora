import { describe, expect, it } from "vitest";
import { baseQuantity, lineTotal, listPrice, sellingUnits, whatsAppLink } from "./sales-client";

const milk = { baseUnit: "tin", priceMinor: "45000", packs: [{ unitCode: "carton", baseQuantity: "48000", priceMinor: "2000000" }, { unitCode: "pack", baseQuantity: "12000", priceMinor: null }] };

describe("sale pricing on the phone", () => {
  it("uses the pack price when there is one, and works it out from the piece price when not", () => {
    expect(sellingUnits(milk)).toEqual(["tin", "carton", "pack"]);
    expect(listPrice(milk, "tin")).toBe(45000n);
    expect(listPrice(milk, "carton")).toBe(2000000n);
    expect(listPrice(milk, "pack")).toBe(540000n);
    expect(listPrice({ ...milk, priceMinor: null }, "tin")).toBeNull();
  });

  it("totals and converts quantities in thousandths", () => {
    expect(lineTotal(45000n, 2500n)).toBe(112500n);
    expect(lineTotal(333n, 1000n)).toBe(333n);
    expect(baseQuantity(milk, "carton", 1000n)).toBe(48000n);
    expect(baseQuantity(milk, "tin", 2000n)).toBe(2000n);
  });

  it("builds the WhatsApp receipt link", () => {
    const link = whatsAppLink({ receiptPath: "/r/abc", whatsApp: { text: "Receipt R-000001 from Shop. View it here: ", phone: null, hrefPrefix: "https://wa.me/" } }, "https://bizora.test");
    expect(link).toBe(`https://wa.me/?text=${encodeURIComponent("Receipt R-000001 from Shop. View it here: https://bizora.test/r/abc")}`);
  });
});

describe("import templates", () => {
  it("use column names the importer recognises", async () => {
    const { PRODUCT_IMPORT_COLUMNS, SALES_IMPORT_COLUMNS, matchColumns } = await import("@bizora/contracts");
    const messages = (await import("../../messages/en.json")).default.imports;
    const products = matchColumns(Object.values(messages.productColumns), PRODUCT_IMPORT_COLUMNS);
    expect(Object.keys(products).sort()).toEqual(Object.keys(PRODUCT_IMPORT_COLUMNS).sort());
    const sales = matchColumns(Object.values(messages.salesColumns), SALES_IMPORT_COLUMNS);
    expect(Object.keys(sales).sort()).toEqual(Object.keys(SALES_IMPORT_COLUMNS).sort());
  });
});
