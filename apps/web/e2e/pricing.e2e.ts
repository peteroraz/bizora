import { expect, test } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test.use({ viewport: { width: 360, height: 780 } });

test("a wholesale price list prices a customer's sale, and delivery charges go into the stock's cost (ADR-048)", async ({ page, request }) => {
  test.setTimeout(180_000);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `pricing.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { acceptTerms: true, email, password, displayName: "Ada Owner", organizationName: `Ada Wholesale ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  const headers = { authorization: `Bearer ${(await registered.json()).data.accessToken}` };
  expect((await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ada Wholesale", branchName: "Main" } })).ok()).toBeTruthy();
  const product = await request.post("/api/v1/products", { headers, data: { name: "Rice 50kg", baseUnit: "piece", priceMinor: "8000000", openingQuantity: "20", openingCostMinor: "140000000" } });
  const productId = (await product.json()).data.product.id as string;
  const customer = await request.post("/api/v1/customers", { headers, data: { name: "Alhaji Musa", phone: "08035550101" } });
  const customerId = (await customer.json()).data.customer.id as string;
  expect((await request.post("/api/v1/suppliers", { headers, data: { name: "Kano Grains" } })).ok()).toBeTruthy();

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);

  // A wholesale list with a price for rice.
  await page.goto("/app/stock");
  await page.getByRole("link", { name: "Price lists" }).click();
  await page.getByLabel("New price list").fill("Wholesale");
  await page.getByRole("button", { name: "Add price list" }).click();
  await expect(page.getByText("Wholesale added. Now add its prices.")).toBeVisible();
  await page.getByPlaceholder("Product name, barcode or supplier's code").fill("rice");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await page.getByRole("button", { name: "Rice 50kg" }).click();
  await page.getByLabel("Price each").pressSequentially("75000");
  await page.getByRole("button", { name: "Save price" }).click();
  await expect(page.getByText("Price saved for Rice 50kg.")).toBeVisible();
  await expect(page.getByTestId("list-prices")).toContainText("₦75,000.00");
  await expect(page.getByTestId("list-prices")).toContainText("Everyday price ₦80,000.00");

  // The customer buys at wholesale prices.
  await page.goto(`/app/customers/${customerId}`);
  await page.getByLabel("Prices for this customer").selectOption({ label: "Wholesale" });
  await expect(page.getByText("This customer now buys at Wholesale prices.")).toBeVisible();

  // The sale screen shows the price the sale will use.
  await page.goto(`/app/sales/new?customer=${customerId}&name=${encodeURIComponent("Alhaji Musa")}`);
  await expect(page.getByText("Selling at Wholesale prices for this customer.")).toBeVisible();
  await page.getByLabel("Find a product").fill("rice");
  await page.getByRole("button", { name: /Rice 50kg/ }).click();
  await page.getByRole("button", { name: "One more Rice 50kg" }).click();
  await expect(page.getByTestId("sale-total")).toHaveText("₦150,000.00");
  await page.getByRole("button", { name: "Record sale", exact: true }).click();
  await expect(page.getByRole("heading", { name: "R-000001" })).toBeVisible();
  await expect(page.getByText("₦150,000.00").first()).toBeVisible();

  // A delivery with transport paid from the drawer: the cost of each bag includes it.
  await page.goto("/app/stock");
  await page.getByRole("link", { name: "Delivery with charges" }).click();
  await page.getByLabel("Supplier").selectOption({ label: "Kano Grains" });
  await page.getByPlaceholder("Product name, barcode or supplier's code").fill("rice");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await page.getByRole("button", { name: "Rice 50kg" }).click();
  await page.getByLabel("Quantity").pressSequentially("10");
  await page.getByLabel("Cost of these goods").pressSequentially("700000");
  await page.getByLabel("Amount").pressSequentially("5000");
  await expect(page.getByTestId("line-landed")).toHaveText("₦5,000.00 of the charges. Stock value ₦705,000.00.");
  await page.getByRole("button", { name: "Save delivery" }).click();
  await expect(page.getByText("Delivery saved: goods ₦700,000.00, charges ₦5,000.00.")).toBeVisible();

  await page.goto(`/app/stock/${productId}`);
  await expect(page.getByTestId("product-buying")).toContainText("Last bought at ₦70,000.00 each, ₦70,500.00 with delivery charges.");
  await expect(page.getByTestId("product-buying")).toContainText("Kano Grains");
  await expect(page.getByTestId("product-buying")).toContainText("Wholesale, each piece");
});
