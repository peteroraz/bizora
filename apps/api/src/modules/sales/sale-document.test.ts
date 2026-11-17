import { describe, expect, it } from "vitest";
import { availableDocuments, brandFor, documentModel, renderPdf, unitText, type CompanyBranding, type DocumentInput } from "./sale-document.js";

const base: DocumentInput = {
  sale: {
    status: "awaiting_payment",
    historyOnly: false,
    saleNumber: null,
    invoiceNumber: "INV-000001",
    provisionalNumber: null,
    collectedAt: null,
    soldAt: new Date("2026-11-16T09:30:00Z"),
    dueDate: null,
    currency: "NGN",
    subtotalMinor: 135000n,
    discountMinor: 0n,
    totalMinor: 135000n,
    paidMinor: 0n,
    balanceMinor: 135000n,
    voidReason: null,
  },
  business: { name: "Ada Wholesale", phone: "+2348031234567", timezone: "Africa/Lagos" },
  branch: { name: "Main", address: "Shop 12, Balogun Market, Lagos", phone: null },
  customerName: "Alhaji Musa",
  servedBy: "Chidi",
  cashier: null,
  lines: [{ description: "Peak Milk", enteredQuantity: 3000n, enteredUnit: "tin", unitPriceMinor: 45000n, lineTotalMinor: 135000n }],
  payments: [],
};

const text = (model: ReturnType<typeof documentModel>) => JSON.stringify(model);

describe("sale documents", () => {
  it("gives an unpaid desk sale an invoice to take to the cashier, and no receipt", () => {
    expect(availableDocuments(base.sale)).toEqual(["invoice"]);
    const invoice = documentModel(base, "invoice");
    expect(invoice).toMatchObject({ title: "Invoice", number: "INV-000001", fileName: "Invoice-INV-000001.pdf" });
    expect(invoice.lines).toEqual([{ description: "Peak Milk", quantity: "3 tins", price: "₦450.00", total: "₦1,350.00" }]);
    expect(invoice.notices[0]).toMatchObject({ tone: "warning", text: "Not paid yet. Pay ₦1,350.00 at the cashier with invoice number INV-000001." });
    expect(invoice.shop).toEqual(["Ada Wholesale", "Main", "Shop 12, Balogun Market, Lagos", "+2348031234567"]);
    expect(() => documentModel(base, "receipt")).toThrow();
  });

  it("turns into a credit invoice with the balance and due date, alongside the receipt for what was paid", () => {
    const credit: DocumentInput = {
      ...base,
      sale: { ...base.sale, status: "completed", saleNumber: "R-000001", collectedAt: new Date("2026-11-16T10:00:00Z"), paidMinor: 50000n, balanceMinor: 85000n, dueDate: "2026-11-20" },
      cashier: "Ngozi",
      payments: [{ method: "cash", amountMinor: 50000n }],
    };
    expect(availableDocuments(credit.sale)).toEqual(["invoice", "receipt"]);
    const invoice = documentModel(credit, "invoice");
    expect(invoice.title).toBe("Credit invoice");
    expect(invoice.totals).toEqual([
      ["Total", "₦1,350.00", true],
      ["Paid (Cash)", "₦500.00"],
      ["Balance owing", "₦850.00", true],
      ["Payment due", "20 Nov 2026"],
    ]);
    expect(invoice.notices[0]?.text).toBe("₦850.00 is owed on credit and should be paid by 20 Nov 2026.");
    const receipt = documentModel(credit, "receipt");
    expect(receipt.details).toContainEqual(["Invoice no.", "INV-000001"]);
    expect(receipt.details).toContainEqual(["Cashier", "Ngozi"]);
  });

  it("marks paid and cancelled documents, and history-only sales have none", () => {
    const paid: DocumentInput = { ...base, sale: { ...base.sale, status: "completed", saleNumber: "R-000002", invoiceNumber: null, collectedAt: new Date(), paidMinor: 135000n, balanceMinor: 0n }, payments: [{ method: "transfer", amountMinor: 135000n }] };
    expect(availableDocuments(paid.sale)).toEqual(["receipt"]);
    expect(text(documentModel(paid, "receipt"))).toContain("Paid in full. Thank you");
    expect(text(documentModel({ ...paid, sale: { ...paid.sale, status: "voided", voidReason: "Wrong item" } }, "receipt"))).toContain("CANCELLED: Wrong item");
    expect(availableDocuments({ ...paid.sale, historyOnly: true })).toEqual([]);
    expect([unitText("tin", "1"), unitText("carton", "2"), unitText("kg", "2.5")]).toEqual(["tin", "cartons", "kg"]);
  });

  it("renders a PDF with the naira font embedded", async () => {
    const pdf = await renderPdf(documentModel(base, "invoice"));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("DejaVuSans");
    expect(pdf.length).toBeGreaterThan(5_000);
  });
  it("prints the owner's texts on the right documents, and keeps colours readable", () => {
    const branding: CompanyBranding = { primaryColor: "#0B6E4F", receiptMessage: "Thank you, come again.", invoiceMessage: "Pay to GTBank 0123456789.", documentTerms: "No returns.", logo: null };
    expect(brandFor(branding, "invoice")).toEqual({ color: "#0B6E4F", logo: null, message: "Pay to GTBank 0123456789.", terms: "No returns." });
    expect(brandFor(branding, "receipt")).toMatchObject({ message: "Thank you, come again.", terms: "No returns." });
    expect(brandFor(branding, "payment_receipt")).toMatchObject({ message: "Thank you, come again.", terms: null });
    expect(brandFor(branding, "statement")).toMatchObject({ message: "Pay to GTBank 0123456789.", terms: null });
    expect(brandFor({ ...branding, primaryColor: "#FFFF99" }, "receipt").color).toBeNull();
    expect(brandFor(null, "receipt")).toEqual({ color: null, logo: null, message: null, terms: null });
  });

  it("moves long terms to a second page, with the Bizora line on every page", async () => {
    const terms = Array.from({ length: 12 }, (_, index) => `${index + 1}. ${"Goods once sold cannot be returned except where they are faulty. ".repeat(4)}`).join("\n");
    const pdf = await renderPdf(documentModel(base, "invoice"), { color: "#0B6E4F", logo: null, message: "Pay to GTBank 0123456789.", terms });
    const text = pdf.toString("latin1");
    expect(text.match(/\/Type \/Page\b/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
