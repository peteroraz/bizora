import { createRequire } from "node:module";
import { quantityToString } from "@bizora/contracts";
import { formatMoney } from "@bizora/money/format";
import PDFDocument from "pdfkit";

/**
 * Invoices, credit invoices and receipts (ADR-017). `documentModel` decides what a document says from the sale; it
 * has no I/O, so it is tested directly. `renderPdf` lays the model out on an A5 page.
 */
export const SALE_DOCUMENT_TYPES = ["invoice", "receipt"] as const;
export type SaleDocumentType = (typeof SALE_DOCUMENT_TYPES)[number];

export type DocumentSale = {
  status: "awaiting_payment" | "awaiting_release" | "completed" | "voided";
  historyOnly: boolean;
  saleNumber: string | null;
  invoiceNumber: string | null;
  provisionalNumber: string | null;
  collectedAt: Date | null;
  soldAt: Date;
  dueDate: string | null;
  currency: string;
  subtotalMinor: bigint;
  discountMinor: bigint;
  totalMinor: bigint;
  paidMinor: bigint;
  balanceMinor: bigint;
  voidReason: string | null;
};

export type DocumentInput = {
  sale: DocumentSale;
  business: { name: string; phone: string | null; timezone: string };
  branch: { name: string; address: string | null; phone: string | null };
  customerName: string | null;
  servedBy: string | null;
  cashier: string | null;
  lines: { description: string; enteredQuantity: bigint; enteredUnit: string; unitPriceMinor: bigint; lineTotalMinor: bigint }[];
  payments: { method: string; amountMinor: bigint; label?: string }[];
};

export type DocumentModel = {
  type: SaleDocumentType;
  title: string;
  number: string;
  fileName: string;
  shop: string[];
  details: [string, string][];
  lines: { description: string; quantity: string; price: string; total: string }[];
  totals: [string, string, boolean?][];
  notices: { text: string; tone: "info" | "warning" | "danger" }[];
};

/** Which documents a sale has: an invoice once it has an invoice number, a receipt once the money was taken. */
export function availableDocuments(sale: Pick<DocumentSale, "historyOnly" | "saleNumber" | "invoiceNumber" | "collectedAt">): SaleDocumentType[] {
  if (sale.historyOnly) return [];
  const types: SaleDocumentType[] = [];
  if (sale.invoiceNumber) types.push("invoice");
  if (sale.saleNumber && sale.collectedAt) types.push("receipt");
  return types;
}

const METHOD = { cash: "Cash", transfer: "Bank transfer", pos: "POS" } as Record<string, string>;
const SAME_PLURAL = new Set(["kg", "g", "ml", "dozen"]);

export function unitText(unit: string, quantity: string) {
  if (quantity === "1" || SAME_PLURAL.has(unit)) return unit;
  return `${unit}s`;
}

export function documentModel(input: DocumentInput, type: SaleDocumentType): DocumentModel {
  const { sale } = input;
  if (!availableDocuments(sale).includes(type)) throw new Error(`This sale has no ${type}.`);
  const money = (minor: bigint) => formatMoney(minor, sale.currency, "en-NG");
  const when = (value: Date) => new Intl.DateTimeFormat("en-NG", { timeZone: input.business.timezone, dateStyle: "medium", timeStyle: "short" }).format(value);
  const credit = sale.balanceMinor > 0n && sale.collectedAt !== null;
  const unpaid = sale.collectedAt === null;
  const title = type === "receipt" ? "Receipt" : credit ? "Credit invoice" : "Invoice";
  const number = (type === "receipt" ? sale.saleNumber : sale.invoiceNumber) ?? "";

  const details: [string, string][] = [[type === "receipt" ? "Receipt no." : "Invoice no.", number]];
  if (type === "receipt" && sale.invoiceNumber) details.push(["Invoice no.", sale.invoiceNumber]);
  if (type === "invoice" && sale.saleNumber && !unpaid) details.push(["Receipt no.", sale.saleNumber]);
  if (sale.provisionalNumber) details.push(["Offline no.", sale.provisionalNumber]);
  details.push(["Date", when(type === "receipt" && sale.collectedAt ? sale.collectedAt : sale.soldAt)]);
  if (input.customerName) details.push(["Customer", input.customerName]);
  if (input.servedBy) details.push(["Served by", input.servedBy]);
  if (type === "receipt" && input.cashier && input.cashier !== input.servedBy) details.push(["Cashier", input.cashier]);

  const totals: [string, string, boolean?][] = [];
  if (sale.discountMinor > 0n) {
    totals.push(["Subtotal", money(sale.subtotalMinor)]);
    totals.push(["Discount", money(-sale.discountMinor)]);
  }
  totals.push(["Total", money(sale.totalMinor), true]);
  if (!unpaid) {
    for (const payment of input.payments) totals.push([payment.label ?? `Paid (${METHOD[payment.method] ?? payment.method})`, money(payment.amountMinor)]);
    if (sale.balanceMinor > 0n) totals.push(["Balance owing", money(sale.balanceMinor), true]);
    if (sale.balanceMinor > 0n && sale.dueDate) totals.push(["Payment due", formatDate(sale.dueDate)]);
  }

  const notices: DocumentModel["notices"] = [];
  if (sale.status === "voided") notices.push({ text: `CANCELLED${sale.voidReason ? `: ${sale.voidReason}` : ""}. This document is no longer valid.`, tone: "danger" });
  else if (unpaid) notices.push({ text: `Not paid yet. Pay ${money(sale.totalMinor)} at the cashier with invoice number ${number}.`, tone: "warning" });
  else if (credit)
    notices.push({
      text: `${money(sale.balanceMinor)} is owed on credit${sale.dueDate ? ` and should be paid by ${formatDate(sale.dueDate)}` : ""}.`,
      tone: "warning",
    });
  else if (type === "invoice") notices.push({ text: `Paid in full. Receipt ${sale.saleNumber ?? ""}.`, tone: "info" });
  else notices.push({ text: "Paid in full. Thank you for your custom.", tone: "info" });

  return {
    type,
    title,
    number,
    fileName: `${title.replace(/\s+/g, "-")}-${number || "draft"}.pdf`,
    shop: [input.business.name, input.branch.name !== input.business.name ? input.branch.name : null, input.branch.address, input.branch.phone ?? input.business.phone].filter(
      (value): value is string => Boolean(value),
    ),
    details,
    lines: input.lines.map((line) => {
      const quantity = quantityToString(line.enteredQuantity);
      return { description: line.description, quantity: `${quantity} ${unitText(line.enteredUnit, quantity)}`, price: money(line.unitPriceMinor), total: money(line.lineTotalMinor) };
    }),
    totals,
    notices,
  };
}

function formatDate(isoDate: string) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-NG", { timeZone: "UTC", dateStyle: "medium" }).format(new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)));
}

// The PDF's built-in fonts have no naira sign (₦); DejaVu Sans does, and its licence allows embedding.
const require = createRequire(import.meta.url);
const FONT = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf");
const BOLD = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf");
const TONE = { info: "#1f6f43", warning: "#8a5a00", danger: "#b42318" } as const;

export function renderPdf(model: DocumentModel): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A5", margin: 36, info: { Title: `${model.title} ${model.number}`, Creator: "Bizora" } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.registerFont("body", FONT);
    doc.registerFont("bold", BOLD);
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;

    doc.font("bold").fontSize(14).fillColor("#111111").text(model.shop[0] ?? "", left, doc.y, { width: width * 0.6 });
    doc.font("body").fontSize(8).fillColor("#555555");
    for (const line of model.shop.slice(1)) doc.text(line, { width: width * 0.6 });
    doc.font("bold").fontSize(16).fillColor("#111111").text(model.title.toUpperCase(), left, 36, { width, align: "right" });
    doc.moveDown(2);
    doc.y = Math.max(doc.y, 90);

    doc.fontSize(8.5);
    for (const [label, value] of model.details) {
      const y = doc.y;
      doc.font("body").fillColor("#555555").text(label, left, y, { width: 80 });
      doc.font("bold").fillColor("#111111").text(value, left + 84, y, { width: width - 84 });
    }
    doc.moveDown();

    const columns = [left, left + width * 0.46, left + width * 0.64, left + width * 0.82];
    const header = doc.y;
    doc.font("bold").fontSize(8).fillColor("#555555");
    doc.text("Item", columns[0], header, { width: width * 0.45 });
    doc.text("Qty", columns[1], header, { width: width * 0.17 });
    doc.text("Price", columns[2], header, { width: width * 0.17, align: "right" });
    doc.text("Amount", columns[3], header, { width: width * 0.18, align: "right" });
    doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).strokeColor("#cccccc").stroke();
    doc.moveDown(0.5);
    doc.font("body").fontSize(8.5).fillColor("#111111");
    for (const line of model.lines) {
      const y = doc.y;
      doc.text(line.description, columns[0], y, { width: width * 0.45 });
      const after = doc.y;
      doc.text(line.quantity, columns[1], y, { width: width * 0.17 });
      doc.text(line.price, columns[2], y, { width: width * 0.17, align: "right" });
      doc.text(line.total, columns[3], y, { width: width * 0.18, align: "right" });
      doc.y = Math.max(after, doc.y) + 3;
    }
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor("#cccccc").stroke();
    doc.moveDown(0.5);

    for (const [label, value, strong] of model.totals) {
      const y = doc.y;
      doc.font(strong ? "bold" : "body").fontSize(strong ? 10 : 8.5).fillColor("#111111");
      doc.text(label, left + width * 0.4, y, { width: width * 0.35 });
      doc.text(value, left + width * 0.75, y, { width: width * 0.25, align: "right" });
    }
    doc.moveDown();
    for (const notice of model.notices) {
      doc.font("bold").fontSize(9).fillColor(TONE[notice.tone]).text(notice.text, left, doc.y, { width });
      doc.moveDown(0.5);
    }
    doc.font("body").fontSize(7).fillColor("#888888").text("Generated by Bizora", left, doc.page.height - 48, { width, align: "center" });
    doc.end();
  });
}
