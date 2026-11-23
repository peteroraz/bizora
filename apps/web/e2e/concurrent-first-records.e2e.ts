import { expect, test } from "@playwright/test";

// On real Postgres (PGlite runs one query at a time, so unit tests cannot see this): a new business whose first
// products, each with opening stock, are added at the same moment. The chart of accounts used to lock the business
// row and deadlock with a document number already taken; four of five requests failed (performance baseline).
test("several products with opening stock, added at once in a new business, are all saved", async ({ request }) => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { acceptTerms: true, email: `race.${stamp}@bizora.test`, password: "LocalOnly!Passw0rd", displayName: "Race Owner", organizationName: `Race Shop ${stamp}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" },
  });
  expect(registered.ok()).toBeTruthy();
  const headers = { authorization: `Bearer ${(await registered.json()).data.accessToken as string}` };
  const made = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      request.post("/api/v1/products", { headers, data: { name: `Item ${index + 1}`, baseUnit: "piece", priceMinor: "100000", openingQuantity: "10", openingCostMinor: "600000" } }),
    ),
  );
  expect(made.map((response) => response.status())).toEqual([201, 201, 201, 201, 201, 201]);
  const sold = await Promise.all(
    made.map(async (response) =>
      request.post("/api/v1/sales", {
        headers,
        data: { lines: [{ productId: (await response.json()).data.product.id, quantity: "1", unit: "piece" }], payments: [{ method: "cash", amountMinor: "100000" }] },
      }),
    ),
  );
  expect(sold.map((response) => response.status())).toEqual([201, 201, 201, 201, 201, 201]);
});
