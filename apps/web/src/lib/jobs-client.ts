import { parseAmount, parseQuantity, type CaptureResult, type JobLineKind, type JobPaidFrom } from "@bizora/contracts";
import { api } from "./api";
import { listPrice, sellingUnits } from "./sales-client";
import type { ProductView } from "./stock-client";

/** One line being typed or checked before it is saved on a job (ADR-035). */
export type DraftLine = {
  key: string;
  kind: JobLineKind;
  description: string;
  productId: string | null;
  units: string[];
  quantity: string;
  unit: string;
  /** Work: what is charged. Part: price for one. Bought: charged in total (empty = what it cost). */
  price: string;
  /** Bought or helper: what was paid. */
  cost: string;
  paidFrom: JobPaidFrom;
  supplier: string;
  /** Work: save as a regular job. */
  save: boolean;
};

export type JobView = {
  job: {
    id: string;
    number: string;
    title: string | null;
    problem: string | null;
    summary: string | null;
    status: "open" | "done" | "cancelled";
    openedOn: string;
    promisedOn: string | null;
    finishedAt: string | null;
    cancelledAt: string | null;
    cancelReason: string | null;
    createdBy: string | null;
  };
  customer: { id: string; name: string; phone: string | null } | null;
  lines: {
    id: string;
    kind: JobLineKind;
    description: string;
    productId: string | null;
    quantity: string;
    unit: string;
    unitPriceMinor: string;
    totalMinor: string;
    costMinor?: string;
    paidFrom: JobPaidFrom | null;
    supplier: string | null;
    usedOn: string;
    addedBy: string | null;
    removed: { at: string; reason: string | null } | null;
  }[];
  payments: { id: string; number: string; method: string; amountMinor: string; receivedAt: string; status: string; confirmation: string; receiptToken: string | null }[];
  sale: { id: string; number: string | null; invoiceNumber: string | null; totalMinor: string; paidMinor: string; balanceMinor: string; dueDate: string | null; receiptToken: string } | null;
  totals: { chargedMinor: string; depositsMinor: string; paidMinor: string; leftMinor: string; costMinor?: string; profitMinor?: string };
};

export type JobListItem = {
  id: string;
  number: string;
  title: string | null;
  status: "open" | "done" | "cancelled";
  customer: { id: string; name: string };
  openedOn: string;
  promisedOn: string | null;
  chargedMinor: string;
  paidMinor: string;
  leftMinor: string;
};

export type Regular = { id: string; name: string; priceMinor: string | null };

let counter = 0;
export const newKey = () => `line-${Date.now()}-${(counter += 1)}`;

export function blankLine(kind: JobLineKind): DraftLine {
  return { key: newKey(), kind, description: "", productId: null, units: ["piece"], quantity: "1", unit: "piece", price: "", cost: "", paidFrom: "cash", supplier: "", save: false };
}

/** "18000" → "18,000" for the amount boxes; minor units → the typed form. */
export function minorToText(minor: bigint | string | null | undefined, digits: number) {
  if (minor === null || minor === undefined) return "";
  const value = BigInt(minor);
  const whole = (value / 10n ** BigInt(digits)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (digits === 0) return whole;
  const fraction = (value % 10n ** BigInt(digits)).toString().padStart(digits, "0");
  return /^0+$/.test(fraction) ? whole : `${whole}.${fraction}`;
}

/** Turns typed lines into what the API takes, or the first problem in plain words (as a message key and line). */
export function linesToPayload(lines: DraftLine[], currency: string): { lines: Record<string, unknown>[] } | { problem: string; line: number } {
  const out: Record<string, unknown>[] = [];
  for (const [index, line] of lines.entries()) {
    const at = index + 1;
    const amount = (text: string) => (text.trim() ? parseAmount(text, currency) : null);
    const quantity = line.quantity.trim() || "1";
    if (parseQuantity(quantity) === null) return { problem: "quantity", line: at };
    if (line.kind === "work") {
      const price = amount(line.price);
      if (!line.description.trim()) return { problem: "description", line: at };
      if (price === null) return { problem: "price", line: at };
      out.push({ kind: "work", description: line.description.trim(), quantity, unitPriceMinor: price.toString(), ...(line.productId ? { productId: line.productId } : {}), ...(line.save && !line.productId ? { save: true } : {}) });
    } else if (line.kind === "part") {
      if (!line.productId) return { problem: "product", line: at };
      const price = amount(line.price);
      out.push({ kind: "part", productId: line.productId, quantity, unit: line.unit, ...(price !== null ? { unitPriceMinor: price.toString() } : {}) });
    } else if (line.kind === "bought") {
      const cost = amount(line.cost);
      const charge = amount(line.price);
      if (!line.description.trim()) return { problem: "description", line: at };
      if (cost === null || cost <= 0n) return { problem: "cost", line: at };
      if (line.paidFrom === "owed" && !line.supplier.trim()) return { problem: "supplier", line: at };
      out.push({
        kind: "bought",
        description: line.description.trim(),
        quantity,
        unit: line.unit,
        costMinor: cost.toString(),
        ...(charge !== null ? { chargeMinor: charge.toString() } : {}),
        paidFrom: line.paidFrom,
        ...(line.productId ? { productId: line.productId } : {}),
        ...(line.supplier.trim() ? { supplier: line.supplier.trim() } : {}),
      });
    } else {
      const cost = amount(line.cost);
      if (!line.description.trim()) return { problem: "description", line: at };
      if (cost === null || cost <= 0n) return { problem: "cost", line: at };
      out.push({ kind: "helper", description: line.description.trim(), costMinor: cost.toString(), paidFrom: line.paidFrom });
    }
  }
  return { lines: out };
}

/** DD/MM/YYYY (as the AI writes dates) → YYYY-MM-DD, or "" when it is not a date. */
export function isoFromSpoken(text: string | undefined) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((text ?? "").trim());
  if (!match) return "";
  const iso = `${match[3]}-${match[2]!.padStart(2, "0")}-${match[1]!.padStart(2, "0")}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? "" : iso;
}

const plain = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

async function findProduct(name: string): Promise<ProductView | null> {
  if (!name.trim()) return null;
  const response = await api(`/api/v1/products?q=${encodeURIComponent(name.trim())}`).catch(() => null);
  if (!response?.ok) return null;
  const items = ((await response.json()).data.items ?? []) as ProductView[];
  const exact = items.find((item) => plain(item.name) === plain(name));
  if (exact) return exact;
  return items.length === 1 ? (items[0] as ProductView) : null;
}

const each = (total: bigint | null, quantity: string) => {
  const thousandths = parseQuantity(quantity || "1") ?? 1000n;
  return total === null ? null : (total * 1000n + thousandths / 2n) / thousandths;
};

/**
 * What the AI heard, as a job to check (ADR-035): the header from the first row, one line per thing done, used,
 * bought or paid to a helper, and the customer's payment. Parts are matched to the shop's products; a regular job is
 * matched by name. Nothing is saved until the person checks it.
 */
export async function draftFromCapture(result: CaptureResult, currency: string, digits: number, regulars: Regular[]) {
  const first = result.rows[0] ?? {};
  const lines: DraftLine[] = [];
  let paid = 0n;
  let method: "cash" | "transfer" | "pos" = "cash";
  const money = (text: string | undefined) => (text?.trim() ? parseAmount(text.replace(/[^\d.,]/g, ""), currency) : null);
  for (const row of result.rows) {
    const kind = (row.kind ?? "").trim().toLowerCase();
    const description = (row.description ?? "").trim();
    const quantity = (row.quantity ?? "").trim() || "1";
    if (kind === "payment") {
      paid += money(row.price) ?? 0n;
      const said = (row.paidFrom ?? "").toLowerCase();
      if (said === "transfer" || said === "pos") method = said;
      continue;
    }
    if (kind === "helper") {
      lines.push({ ...blankLine("helper"), description, cost: minorToText(money(row.cost), digits), paidFrom: row.paidFrom === "owed" || row.paidFrom === "bank" ? row.paidFrom : "cash" });
      continue;
    }
    if (kind === "part" || kind === "bought") {
      const product = await findProduct(description);
      if (kind === "part" && product?.trackStock) {
        const unit = sellingUnits(product).includes((row.unit ?? "").trim()) ? (row.unit ?? "").trim() : product.baseUnit;
        const price = money(row.price);
        lines.push({
          ...blankLine("part"),
          description: product.name,
          productId: product.id,
          units: sellingUnits(product),
          unit,
          quantity,
          price: minorToText(price !== null ? each(price, quantity) : listPrice(product, unit), digits),
        });
        continue;
      }
      lines.push({
        ...blankLine("bought"),
        description: product?.name ?? description,
        productId: product?.trackStock ? product.id : null,
        units: product?.trackStock ? sellingUnits(product) : ["piece", "litre", "kg", "metre", "yard", "set", "pair"],
        unit: (row.unit ?? "").trim() || product?.baseUnit || "piece",
        quantity,
        cost: minorToText(money(row.cost), digits),
        price: minorToText(money(row.price), digits),
        paidFrom: row.paidFrom === "owed" || row.paidFrom === "bank" ? row.paidFrom : "cash",
        supplier: (row.supplier ?? "").trim(),
      });
      continue;
    }
    // Work done (and anything unclear): a regular job when the name matches one.
    const regular = regulars.find((item) => plain(item.name) === plain(description));
    const price = money(row.price);
    lines.push({
      ...blankLine("work"),
      description: regular?.name ?? description,
      productId: regular?.id ?? null,
      price: minorToText(price ?? (regular?.priceMinor ? BigInt(regular.priceMinor) : null), digits),
    });
  }
  return {
    customer: (first.customer ?? "").trim(),
    phone: (first.phone ?? "").trim(),
    title: (first.title ?? "").trim(),
    problem: (first.problem ?? "").trim(),
    day: isoFromSpoken(first.day),
    promisedOn: isoFromSpoken(first.promised),
    finished: /^(yes|true|done|finished|completed)/i.test((first.finished ?? "").trim()),
    summary: (first.summary ?? "").trim(),
    lines: lines.filter((line) => line.description || line.cost || line.price),
    paid: paid > 0n ? minorToText(paid, digits) : "",
    method,
  };
}
