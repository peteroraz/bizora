import { describe, expect, it } from "vitest";
import { blocking, buildReview, checkReview, priceLine, type ReviewProduct } from "./review.js";
import { parseSpokenSale } from "./spoken-sale.js";

const products: ReviewProduct[] = [
  { id: "rice", name: "Rice 50kg", baseUnit: "bag", priceMinor: "7500000", packs: [] },
  { id: "indomie", name: "Indomie Noodles", baseUnit: "piece", priceMinor: "25000", packs: [{ unitCode: "carton", baseQuantity: "40000", priceMinor: "1200000" }] },
  { id: "cement", name: "Dangote Cement", baseUnit: "bag", priceMinor: "950000", packs: [] },
  { id: "peak", name: "Peak Milk", baseUnit: "tin", priceMinor: "60000", packs: [] },
  { id: "pick", name: "Pick n Pay Bag", baseUnit: "piece", priceMinor: "10000", packs: [] },
];
const customers = [
  { id: "emeka", name: "Emeka Obi", creditAllowed: true },
  { id: "chinedu", name: "Chinedu Eze", creditAllowed: false },
  { id: "ada1", name: "Ada Okafor", creditAllowed: true },
  { id: "ada2", name: "Ada Nwosu", creditAllowed: true },
];
const manager = { canChangePrice: true, canGiveCredit: true };
const cashier = { canChangePrice: false, canGiveCredit: true };
const review = (text: string, options = manager) => buildReview(parseSpokenSale(text, { currency: "NGN" }), products, customers, options);
const warnings = (text: string, options = manager) => review(text, options).warnings.map((warning) => warning.code);

describe("checking a spoken sale against the shop", () => {
  it("matches the product, unit, price and customer of the brief's sale", () => {
    const result = review("I sold five bags of rice at seventy-five thousand naira each to Emeka. He paid three hundred thousand and will balance seventy-five thousand.");
    expect(result.lines[0]).toMatchObject({ product: { id: "rice" }, unit: "bag", quantity: 5000n, priceMinor: 7_500_000n, priceSource: "said", totalMinor: 37_500_000n });
    expect(result.customer).toMatchObject({ id: "emeka" });
    expect([result.totalMinor, result.paidMinor, result.balanceMinor]).toEqual([37_500_000n, 30_000_000n, 7_500_000n]);
    expect(blocking(result)).toEqual([]);
  });

  it("uses the pack's price for a pack and the list price when none was said, and says so", () => {
    const result = review("two cartons of Indomie and a bag of cement, cash");
    expect(result.lines.map((line) => [line.product?.id, line.unit, line.priceMinor, line.priceSource])).toEqual([
      ["indomie", "carton", 1_200_000n, "list"],
      ["cement", "bag", 950_000n, "list"],
    ]);
    expect(result.totalMinor).toBe(3_350_000n);
    expect(result.paidMinor).toBe(3_350_000n);
    expect(blocking(result)).toEqual([]);
  });

  it("never lets a said price replace the list price for someone who may not change prices", () => {
    const text = "five bags of rice at 70k each, cash";
    expect(warnings(text)).toEqual(["price_differs"]);
    const forCashier = review(text, cashier);
    expect(blocking(forCashier).map((warning) => warning.code)).toEqual(["price_needs_manager"]);
    // The cashier chooses the list price instead.
    const fixed = checkReview({ ...forCashier, paidMinor: null, lines: forCashier.lines.map((line) => priceLine({ ...line, priceOverride: line.listPriceMinor })) }, cashier);
    expect(fixed.lines[0]).toMatchObject({ priceMinor: 7_500_000n, priceSource: "list" });
    expect(blocking(fixed)).toEqual([]);
    expect(fixed.totalMinor).toBe(37_500_000n);
  });

  it("works out whether an unclear amount was for one or for all from the list price", () => {
    expect(review("two bags of rice 150k cash").lines[0]).toMatchObject({ priceMinor: 7_500_000n, totalMinor: 15_000_000n });
    expect(review("two bags of rice 75k cash").lines[0]).toMatchObject({ priceMinor: 7_500_000n, totalMinor: 15_000_000n });
    expect(warnings("two bags of rice 90k cash")).toContain("price_unclear");
  });

  it("asks which product or customer when two fit, and never makes one up", () => {
    expect(warnings("two tins of sardines cash")).toContain("product_unknown");
    const ada = review("a bag of rice at 75k to Ada, paid 50k");
    expect(ada.customerStatus).toBe("choose");
    expect(ada.customerOptions.map((item) => item.id).sort()).toEqual(["ada1", "ada2"]);
    expect(blocking(ada).map((warning) => warning.code)).toContain("customer_choose");
    expect(warnings("a bag of rice at 75k to Bola, cash")).toContain("customer_unknown");
  });

  it("stops credit for a customer the owner has not approved, or with no customer", () => {
    expect(warnings("Chinedu collected three cartons of Indomie, twelve thousand each, paid twenty thousand, balance sixteen thousand.")).toContain("customer_no_credit");
    expect(warnings("three cartons of Indomie at 12k each, paid 20k")).toContain("credit_needs_customer");
    expect(warnings("three cartons of Indomie at 12k each to Emeka, paid 20k", { canChangePrice: false, canGiveCredit: false })).toContain("credit_not_allowed");
  });

  it("flags a total or payment that does not add up, and a missing payment", () => {
    expect(warnings("five bags of rice at 75k each, total 400k, paid in full")).toContain("said_total_differs");
    expect(warnings("five bags of rice at 75k each, paid 300k, balance 50k")).toContain("payment_unclear");
    expect(warnings("two bags of rice at 75k each, paid 200k")).toContain("paid_more_than_total");
    expect(warnings("two bags of rice at 75k each")).toContain("no_payment");
    expect(warnings("two bags of rice at 50 dollars each, cash")).toContain("currency_mismatch");
  });

  it("tells a similar-sounding product from the right one", () => {
    expect(review("three tins of pick milk, cash").lines[0]).toMatchObject({ product: { id: "peak" } });
  });

  it("sells an item not in the products as a new typed item when the shop allows it (ADR-041)", () => {
    const sale = parseSpokenSale("Sold two bags of beans at 40k each and three loaves of Agege bread at 1500, cash.", { currency: "NGN" });
    const withTyped = buildReview(sale, products, customers, { canChangePrice: false, canGiveCredit: true, typedItems: true });
    const beans = withTyped.lines[0]!;
    expect(beans.product).toMatchObject({ name: "Beans", typed: true, isNew: true, baseUnit: "bag" });
    // A cashier may set a typed item's price: it is not a discount on a list price.
    expect(beans.priceMinor).toBe(4_000_000n);
    expect(withTyped.warnings.map((warning) => warning.code)).toContain("new_item");
    expect(blocking(withTyped)).toEqual([]);
    // Products only: the same words stop until a product is chosen.
    const listOnly = buildReview(sale, products, customers, { canChangePrice: false, canGiveCredit: true });
    expect(blocking(listOnly).map((warning) => warning.code)).toContain("product_unknown");
  });

  it("matches a saved typed item and uses its last price as a suggestion only", () => {
    const saved = { id: "typed:agege bread", name: "Agege bread", baseUnit: "piece", priceMinor: "150000", packs: [], typed: true };
    const sale = parseSpokenSale("Three Agege bread, cash.", { currency: "NGN" });
    const review = buildReview(sale, [...products, saved], customers, { canChangePrice: false, canGiveCredit: true, typedItems: true });
    expect(review.lines[0]).toMatchObject({ priceMinor: 150_000n, priceSource: "list", totalMinor: 450_000n });
    expect(review.lines[0]!.product).toMatchObject({ id: "typed:agege bread" });
    expect(review.warnings.map((warning) => warning.code)).not.toContain("new_item");
    // A different price said is fine for a typed item, even for a cashier.
    const dearer = buildReview(parseSpokenSale("Three Agege bread at 1700 each, cash.", { currency: "NGN" }), [...products, saved], customers, { canChangePrice: false, canGiveCredit: true, typedItems: true });
    expect(dearer.lines[0]!.priceMinor).toBe(170_000n);
    expect(blocking(dearer)).toEqual([]);
  });
});
