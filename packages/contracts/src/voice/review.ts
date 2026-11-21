import { ENGLISH, type VoiceLexicon } from "./lexicon.js";
import { decide, rank } from "./match.js";
import { spokenLineTotal, type SpokenLine, type SpokenSale } from "./spoken-sale.js";

/**
 * A spoken sale checked against this shop's own products, prices and customers (ADR-040), ready for the person to
 * correct and confirm. Prices said and list prices are kept apart; a said price never replaces the list price
 * silently, and someone who may not change prices is told before saving.
 */
export type ReviewProduct = {
  id: string;
  name: string;
  baseUnit: string;
  priceMinor: string | null;
  packs: { unitCode: string; baseQuantity: string; priceMinor: string | null }[];
  trackStock?: boolean;
};
export type ReviewCustomer = { id: string; name: string; creditAllowed: boolean };

export type ReviewLine = {
  spoken: SpokenLine;
  product: ReviewProduct | null;
  options: ReviewProduct[];
  productStatus: "sure" | "choose" | "none";
  unit: string | null;
  /** The unit said is not one this product is sold in. */
  unitNotSold: boolean;
  quantity: bigint | null;
  listPriceMinor: bigint | null;
  saidPriceMinor: bigint | null;
  /** A price the person typed or chose on the review screen; wins over what was said. */
  priceOverride: bigint | null;
  /** What this line will charge for one, and where it came from. */
  priceMinor: bigint | null;
  priceSource: "said" | "list" | "typed" | "none";
  totalMinor: bigint | null;
};

export type ReviewWarning =
  | { code: "product_unknown"; line: number; said: string }
  | { code: "product_choose"; line: number; said: string }
  | { code: "unit_not_sold"; line: number; unit: string }
  | { code: "no_quantity"; line: number }
  | { code: "no_price"; line: number }
  | { code: "price_unclear"; line: number; amountMinor: bigint }
  | { code: "price_differs"; line: number; saidMinor: bigint; listMinor: bigint }
  | { code: "price_needs_manager"; line: number; saidMinor: bigint; listMinor: bigint }
  | { code: "customer_unknown"; said: string }
  | { code: "customer_choose"; said: string }
  | { code: "credit_needs_customer" }
  | { code: "customer_no_credit"; name: string }
  | { code: "credit_not_allowed" }
  | { code: "said_total_differs"; saidMinor: bigint; workedOutMinor: bigint }
  | { code: "paid_more_than_total"; totalMinor: bigint; paidMinor: bigint }
  | { code: "payment_unclear" }
  | { code: "no_payment" }
  | { code: "currency_mismatch"; said: string; expected: string }
  | { code: "no_items" };

export type SaleReview = {
  sale: SpokenSale;
  lines: ReviewLine[];
  customer: ReviewCustomer | null;
  customerOptions: ReviewCustomer[];
  customerStatus: "sure" | "choose" | "none" | "not_said";
  totalMinor: bigint | null;
  paidMinor: bigint | null;
  balanceMinor: bigint | null;
  warnings: ReviewWarning[];
};

export type ReviewOptions = {
  /** Whether this person may sell at a price other than the list price. */
  canChangePrice: boolean;
  /** Whether this person may leave money owed. */
  canGiveCredit: boolean;
  lexicon?: VoiceLexicon;
};

export function sellingUnitsOf(product: ReviewProduct) {
  return [product.baseUnit, ...product.packs.map((pack) => pack.unitCode)];
}

export function listPriceOf(product: ReviewProduct, unit: string): bigint | null {
  if (unit === product.baseUnit) return product.priceMinor === null ? null : BigInt(product.priceMinor);
  const pack = product.packs.find((item) => item.unitCode === unit);
  if (!pack) return null;
  if (pack.priceMinor !== null) return BigInt(pack.priceMinor);
  if (product.priceMinor === null) return null;
  return spokenLineTotal(BigInt(product.priceMinor), BigInt(pack.baseQuantity));
}

function reviewLine(spoken: SpokenLine, products: ReviewProduct[], lexicon: VoiceLexicon): ReviewLine {
  const found = decide(rank(spoken.productText, products, (product) => [product.name], { lexicon }));
  const product = found.status === "sure" ? found.best : null;
  return priceLine({
    spoken,
    product,
    options: found.options,
    productStatus: found.status,
    unit: null,
    unitNotSold: false,
    quantity: spoken.quantity,
    listPriceMinor: null,
    saidPriceMinor: null,
    priceOverride: null,
    priceMinor: null,
    priceSource: "none",
    totalMinor: null,
  });
}

/** Works out a line's unit, list price and charge from its product. Called again when the person picks a product. */
export function priceLine(line: ReviewLine): ReviewLine {
  const { spoken, product } = line;
  const next: ReviewLine = { ...line };
  if (!product) {
    next.unit = spoken.unit;
    next.listPriceMinor = null;
  } else {
    const units = sellingUnitsOf(product);
    const said = spoken.unit;
    next.unitNotSold = Boolean(spoken.unitText) && !(said && units.includes(said));
    if (line.unit && units.includes(line.unit) && line.unit !== spoken.unit) next.unit = line.unit;
    else next.unit = said && units.includes(said) ? said : product.baseUnit;
    next.listPriceMinor = listPriceOf(product, next.unit);
  }
  let said = spoken.unitPriceMinor;
  // "two bags of rice 150k": the list price tells whether that was one bag or both.
  if (said === null && spoken.unclearAmountMinor !== null && next.quantity !== null && next.listPriceMinor !== null) {
    if (spoken.unclearAmountMinor === spokenLineTotal(next.listPriceMinor, next.quantity)) said = next.listPriceMinor;
    else if (spoken.unclearAmountMinor === next.listPriceMinor) said = next.listPriceMinor;
  }
  if (said === null && spoken.lineTotalMinor !== null && next.quantity !== null && next.quantity > 0n && (spoken.lineTotalMinor * 1000n) % next.quantity === 0n) {
    said = (spoken.lineTotalMinor * 1000n) / next.quantity;
  }
  next.saidPriceMinor = said;
  if (line.priceOverride !== null) {
    next.priceMinor = line.priceOverride;
    next.priceSource = line.priceOverride === next.listPriceMinor ? "list" : "typed";
  } else if (said !== null) {
    next.priceMinor = said;
    next.priceSource = "said";
  } else if (spoken.unclearAmountMinor !== null) {
    // An amount was said but it is not clear for how many: the person says which, the list price is not used.
    next.priceMinor = null;
    next.priceSource = "none";
  } else if (next.listPriceMinor !== null) {
    next.priceMinor = next.listPriceMinor;
    next.priceSource = "list";
  } else {
    next.priceMinor = null;
    next.priceSource = "none";
  }
  next.totalMinor = next.priceMinor !== null && next.quantity !== null ? spokenLineTotal(next.priceMinor, next.quantity) : null;
  return next;
}

export function buildReview(sale: SpokenSale, products: ReviewProduct[], customers: ReviewCustomer[], options: ReviewOptions): SaleReview {
  const lexicon = options.lexicon ?? ENGLISH;
  const lines = sale.lines.map((line) => reviewLine(line, products, lexicon));
  let customer: ReviewCustomer | null = null;
  let customerOptions: ReviewCustomer[] = [];
  let customerStatus: SaleReview["customerStatus"] = "not_said";
  if (sale.customerText) {
    const found = decide(rank(sale.customerText, customers, (item) => [item.name], { lexicon, people: true }));
    customerStatus = found.status;
    customerOptions = found.options;
    customer = found.status === "sure" ? found.best : null;
  }
  return checkReview({ sale, lines, customer, customerOptions, customerStatus, totalMinor: null, paidMinor: null, balanceMinor: null, warnings: [] }, options);
}

/**
 * Totals and warnings for what is on screen now. The amount paid follows what was said: an amount, "paid in full",
 * or "balance X" (the rest was paid). The balance is what is left.
 */
export function checkReview(review: SaleReview, options: ReviewOptions): SaleReview {
  const warnings: ReviewWarning[] = [];
  const { sale } = review;
  for (const issue of sale.issues) {
    if (issue.code === "currency_mismatch") warnings.push(issue);
  }
  if (review.lines.length === 0) warnings.push({ code: "no_items" });
  let total = 0n;
  let complete = review.lines.length > 0;
  review.lines.forEach((line, index) => {
    if (!line.product) {
      warnings.push({ code: line.productStatus === "choose" ? "product_choose" : "product_unknown", line: index, said: line.spoken.productText });
      complete = false;
    }
    if (line.product && line.unitNotSold && line.spoken.unitText) warnings.push({ code: "unit_not_sold", line: index, unit: line.spoken.unitText });
    if (line.quantity === null || line.quantity <= 0n) {
      warnings.push({ code: "no_quantity", line: index });
      complete = false;
    }
    if (line.priceMinor === null) {
      if (line.spoken.unclearAmountMinor !== null) warnings.push({ code: "price_unclear", line: index, amountMinor: line.spoken.unclearAmountMinor });
      else warnings.push({ code: "no_price", line: index });
      complete = false;
    }
    if ((line.priceSource === "said" || line.priceSource === "typed") && line.listPriceMinor !== null && line.priceMinor !== null && line.priceMinor !== line.listPriceMinor) {
      warnings.push({ code: options.canChangePrice ? "price_differs" : "price_needs_manager", line: index, saidMinor: line.priceMinor, listMinor: line.listPriceMinor });
    }
    total += line.totalMinor ?? 0n;
  });
  const totalMinor = complete ? total : null;
  if (totalMinor !== null && sale.saidTotalMinor !== null && sale.saidTotalMinor !== totalMinor) {
    warnings.push({ code: "said_total_differs", saidMinor: sale.saidTotalMinor, workedOutMinor: totalMinor });
  }
  const saidPaid = sale.payments.some((payment) => payment.amountMinor !== null) ? sale.payments.reduce((sum, payment) => sum + (payment.amountMinor ?? 0n), 0n) : null;
  let paidMinor: bigint | null = review.paidMinor;
  if (paidMinor === null && totalMinor !== null) {
    if (saidPaid !== null) paidMinor = saidPaid;
    else if (sale.onCredit) paidMinor = 0n;
    else if (sale.balanceMinor !== null) paidMinor = totalMinor - sale.balanceMinor;
    else if (sale.paidInFull || sale.payments.length > 0) paidMinor = totalMinor;
  }
  if (paidMinor === null && saidPaid === null && !sale.onCredit && sale.balanceMinor === null && !sale.paidInFull && sale.payments.length === 0) warnings.push({ code: "no_payment" });
  if (totalMinor !== null && saidPaid !== null && sale.balanceMinor !== null && saidPaid + sale.balanceMinor !== totalMinor) warnings.push({ code: "payment_unclear" });
  let balanceMinor: bigint | null = null;
  if (totalMinor !== null && paidMinor !== null) {
    if (paidMinor > totalMinor) warnings.push({ code: "paid_more_than_total", totalMinor, paidMinor });
    else balanceMinor = totalMinor - paidMinor;
  }
  if (sale.customerText && !review.customer) warnings.push({ code: review.customerStatus === "choose" ? "customer_choose" : "customer_unknown", said: sale.customerText });
  if (balanceMinor !== null && balanceMinor > 0n) {
    if (!options.canGiveCredit) warnings.push({ code: "credit_not_allowed" });
    else if (!review.customer) warnings.push({ code: "credit_needs_customer" });
    else if (!review.customer.creditAllowed) warnings.push({ code: "customer_no_credit", name: review.customer.name });
  }
  return { ...review, totalMinor, paidMinor, balanceMinor, warnings };
}

/** Warnings that must be settled before the sale is saved; the rest are worth a look but do not stop it. */
export const BLOCKING_WARNINGS: ReviewWarning["code"][] = [
  "no_items",
  "product_unknown",
  "product_choose",
  "no_quantity",
  "no_price",
  "price_unclear",
  "price_needs_manager",
  "customer_choose",
  "credit_needs_customer",
  "customer_no_credit",
  "credit_not_allowed",
  "paid_more_than_total",
  "payment_unclear",
  "said_total_differs",
  "currency_mismatch",
  "no_payment",
];

export function blocking(review: SaleReview) {
  return review.warnings.filter((warning) => BLOCKING_WARNINGS.includes(warning.code));
}
