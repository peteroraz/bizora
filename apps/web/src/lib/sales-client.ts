import type { CachedProduct } from "./offline/catalog";

export type SaleLineView = {
  productId: string | null;
  description: string;
  quantity: string;
  enteredQuantity: string;
  enteredUnit: string;
  unitPriceMinor: string;
  discountMinor?: string;
  lineTotalMinor: string;
  costMinor?: string;
};

export type SaleView = {
  id: string;
  number: string | null;
  invoiceNumber: string | null;
  provisionalNumber: string | null;
  externalRef: string | null;
  status: SaleStatus;
  paymentState: "unpaid" | "paid" | "credit";
  historyOnly: boolean;
  source: "pos" | "offline" | "import" | "capture";
  currency: string;
  subtotalMinor: string;
  discountMinor: string;
  totalMinor: string;
  paidMinor: string;
  balanceMinor: string;
  dueDate: string | null;
  soldAt: string;
  customerId: string | null;
  customerName: string | null;
  byName: string | null;
  itemCount?: number;
  view: "full";
};

export type SaleStatus = "awaiting_payment" | "awaiting_release" | "completed" | "voided";

/** The store keeper's view of a sale: what to give out, with no amounts or customer (ADR-016). */
export type SaleReleaseRow = {
  id: string;
  number: string | null;
  invoiceNumber: string | null;
  provisionalNumber: string | null;
  status: SaleStatus;
  paymentState: "unpaid" | "paid" | "credit";
  historyOnly: boolean;
  soldAt: string;
  byName: string | null;
  itemCount?: number;
  view: "release";
};

export type SaleComment = { id: string; kind: "comment" | "credit"; role: string | null; body: string; byName: string | null; createdAt: string };

type Stages = {
  mine: boolean;
  requestedPayment: "cash" | "transfer" | "pos" | "split" | "credit" | null;
  collectedAt: string | null;
  collectedByName: string | null;
  releasedAt: string | null;
  releasedByName: string | null;
  byName: string | null;
  branchName: string | null;
  comments: SaleComment[];
};

export type SaleReleaseDetail = Omit<SaleReleaseRow, "itemCount"> &
  Stages & { lines: { description: string; enteredQuantity: string; enteredUnit: string }[] };

export type SaleDetail = Omit<SaleView, "itemCount"> &
  Stages & {
  customerPhoneLast4: string | null;
  customerCredit: { allowed: boolean; limitMinor: string | null; owingMinor: string } | null;
  businessName: string | null;
  note: string | null;
  voidReason: string | null;
  receiptPath: string;
  documents: ("invoice" | "receipt")[];
  whatsApp: { text: string; phone: string | null; hrefPrefix: string };
  lines: SaleLineView[];
  payments: { method: "cash" | "transfer" | "pos"; amountMinor: string; reference: string | null }[];
  laterPayments: { id: string; number: string; method: "cash" | "transfer" | "pos"; amountMinor: string; receivedAt: string }[];
};

export type SaleSummary = {
  date: string;
  currency: string;
  mine: boolean;
  count: number;
  totalMinor: string;
  creditMinor: string;
  byMethod: Partial<Record<"cash" | "transfer" | "pos", string>>;
};

const SCALE = 1000n;

/** Divides and rounds half up, the way the server does (quantities are in thousandths). */
function divide(value: bigint, by: bigint) {
  return value >= 0n ? (value + by / 2n) / by : -((-value + by / 2n) / by);
}

/** The units a product sells in: its base unit and any packs. */
export function sellingUnits(product: Pick<CachedProduct, "baseUnit" | "packs">) {
  return [product.baseUnit, ...product.packs.map((pack) => pack.unitCode)];
}

/** The list price for one unit (base unit or pack), or null when the product has no price. Mirrors SaleService. */
export function listPrice(product: Pick<CachedProduct, "baseUnit" | "packs" | "priceMinor">, unit: string): bigint | null {
  if (unit === product.baseUnit) return product.priceMinor === null ? null : BigInt(product.priceMinor);
  const pack = product.packs.find((item) => item.unitCode === unit);
  if (!pack) return null;
  if (pack.priceMinor !== null) return BigInt(pack.priceMinor);
  return product.priceMinor === null ? null : divide(BigInt(product.priceMinor) * BigInt(pack.baseQuantity), SCALE);
}

/** Line total for a quantity in thousandths of the chosen unit. */
export function lineTotal(unitPriceMinor: bigint, enteredThousandths: bigint) {
  return divide(unitPriceMinor * enteredThousandths, SCALE);
}

/** Thousandths of the base unit, for checking stock on the phone. */
export function baseQuantity(product: Pick<CachedProduct, "baseUnit" | "packs">, unit: string, enteredThousandths: bigint) {
  if (unit === product.baseUnit) return enteredThousandths;
  const pack = product.packs.find((item) => item.unitCode === unit);
  return pack ? divide(enteredThousandths * BigInt(pack.baseQuantity), SCALE) : enteredThousandths;
}

/** The WhatsApp link for a receipt: the customer's chat when staff may see their number, otherwise the share sheet. */
export function whatsAppLink(sale: Pick<SaleDetail, "whatsApp" | "receiptPath">, origin: string) {
  return `${sale.whatsApp.hrefPrefix}?text=${encodeURIComponent(`${sale.whatsApp.text}${origin}${sale.receiptPath}`)}`;
}
