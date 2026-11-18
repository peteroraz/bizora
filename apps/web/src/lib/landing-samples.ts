/**
 * Made-up receipts for the homepage's printing receipt (ADR-025): five kinds of business, five countries, five
 * currencies. Amounts are minor units (cents, kobo, paise), the same way Bizora stores money.
 */
export type SampleReceipt = {
  business: string;
  place: string;
  handle: string;
  number: string;
  currency: string;
  locale: string;
  method: "cash" | "transfer" | "pos";
  lines: { item: string; quantity: number; amountMinor: bigint }[];
};

export const SAMPLE_RECEIPTS: SampleReceipt[] = [
  {
    business: "Ama's Hair Studio",
    place: "Accra",
    handle: "amas-hair",
    number: "R-000214",
    currency: "GHS",
    locale: "en-GH",
    method: "transfer",
    lines: [
      { item: "Knotless braids", quantity: 1, amountMinor: 35_000n },
      { item: "Hair cream", quantity: 1, amountMinor: 4_500n },
    ],
  },
  {
    business: "Duka la Neema",
    place: "Nairobi",
    handle: "duka-la-neema",
    number: "R-001087",
    currency: "KES",
    locale: "en-KE",
    method: "cash",
    lines: [
      { item: "Sugar 2 kg", quantity: 2, amountMinor: 46_000n },
      { item: "Cooking oil 1 L", quantity: 1, amountMinor: 39_000n },
    ],
  },
  {
    business: "Boulangerie Lune",
    place: "Lyon",
    handle: "boulangerie-lune",
    number: "R-003310",
    currency: "EUR",
    locale: "fr-FR",
    method: "pos",
    lines: [
      { item: "Pain au levain", quantity: 1, amountMinor: 450n },
      { item: "Croissant", quantity: 3, amountMinor: 360n },
    ],
  },
  {
    business: "Ada Stores",
    place: "Lagos",
    handle: "ada-stores",
    number: "R-000562",
    currency: "NGN",
    locale: "en-NG",
    method: "transfer",
    lines: [
      { item: "Indomie, carton of 40", quantity: 1, amountMinor: 950_000n },
      { item: "Peak Milk 400 g", quantity: 2, amountMinor: 900_000n },
    ],
  },
  {
    business: "Kapoor Medicals",
    place: "Pune",
    handle: "kapoor-medicals",
    number: "R-002741",
    currency: "INR",
    locale: "en-IN",
    method: "cash",
    lines: [
      { item: "Paracetamol 500 mg strip", quantity: 2, amountMinor: 6_000n },
      { item: "ORS sachet", quantity: 5, amountMinor: 10_000n },
    ],
  },
];
