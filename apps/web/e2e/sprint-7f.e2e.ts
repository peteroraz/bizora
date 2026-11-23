import { expect, test } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test.use({ viewport: { width: 390, height: 844 }, permissions: ["clipboard-read", "clipboard-write"] });

test("edit a customer, copy a receipt link twice, and give a reason for a new price", async ({ page, request }) => {
  test.setTimeout(150_000);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `fixes.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { acceptTerms: true, email, password, displayName: "Ada Owner", organizationName: `Ada Foods ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  const headers = { authorization: `Bearer ${(await registered.json()).data.accessToken}` };
  expect((await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ada Foods", branchName: "Main" } })).ok()).toBeTruthy();
  const product = await request.post("/api/v1/products", { headers, data: { name: "Indomie carton", baseUnit: "piece", priceMinor: "2400000", openingQuantity: "20", openingCostMinor: "36000000" } });
  const productId = (await product.json()).data.product.id as string;
  const customer = await request.post("/api/v1/customers", { headers, data: { name: "Koko Buka", phone: "08031234567" } });
  const customerId = (await customer.json()).data.customer.id as string;
  const sale = await request.post("/api/v1/sales", { headers, data: { lines: [{ productId, quantity: "3", unit: "piece" }], customerId, payments: [{ method: "transfer", amountMinor: "7200000" }] } });
  const saleId = (await sale.json()).data.sale.id as string;

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);

  // The customer's details can be changed; "More" says "Less" while open.
  await page.goto(`/app/customers/${customerId}`);
  await page.getByTestId("edit-customer").click();
  await expect(page.locator("#edit-customer-phone")).toHaveValue("0803 123 4567");
  await page.getByLabel("Email").fill("koko@example.com");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByTestId("customer-details")).toContainText("koko@example.com");
  await expect(page.getByText("0803 123 4567")).toBeVisible();
  const actions = page.locator("main summary").filter({ hasText: /More|Less/ });
  await expect(actions).toHaveText("⋯ More");
  await actions.click();
  await expect(actions).toHaveText("Less");
  await actions.click();
  await expect(actions).toHaveText("⋯ More");

  // The receipt link copies as often as needed.
  await page.goto(`/app/sales/${saleId}`);
  await page.getByText("More ways to share").click();
  const copy = page.getByTestId("copy-receipt-link");
  await copy.click();
  await expect(copy).toHaveText("Link copied");
  await expect(copy).toHaveText("Copy link", { timeout: 5_000 });
  await copy.click();
  await expect(copy).toHaveText("Link copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("/r/");

  // A new selling price says why, and the history shows it.
  await page.goto(`/app/stock/${productId}`);
  await page.locator("#edit-price").fill("25,000");
  await page.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByText("Say why the price or cost is changing.")).toBeVisible();
  await page.locator("#edit-reason").pressSequentially("supplier raised the carton price");
  await page.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByTestId("product-change").first()).toContainText("Selling price: ₦24,000.00 → ₦25,000.00");
  await expect(page.getByTestId("product-change").first()).toContainText("Reason: Supplier raised the carton price");
});
