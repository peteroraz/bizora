import { expect, test } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test.use({ viewport: { width: 360, height: 780 } });

test("a customer brings goods back for cash, and goods go back to the supplier off what is owed", async ({ page, request }) => {
  test.setTimeout(150_000);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `returns.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { email, password, displayName: "Ada Owner", organizationName: `Ada Provisions ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  const headers = { authorization: `Bearer ${(await registered.json()).data.accessToken}` };
  expect((await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ada Provisions", branchName: "Main" } })).ok()).toBeTruthy();
  const product = await request.post("/api/v1/products", { headers, data: { name: "Groundnut oil 5L", baseUnit: "piece", priceMinor: "900000", openingQuantity: "10", openingCostMinor: "6000000" } });
  const productId = (await product.json()).data.product.id as string;
  const sale = await request.post("/api/v1/sales", { headers, data: { lines: [{ productId, quantity: "3", unit: "piece" }], payments: [{ method: "cash", amountMinor: "2700000" }] } });
  const saleId = (await sale.json()).data.sale.id as string;
  expect(
    (await request.post("/api/v1/stock/receive", { headers, data: { productId, quantity: "5", unit: "piece", totalCostMinor: "3000000", paidFrom: "credit", supplier: "Kings Oil" } })).ok(),
  ).toBeTruthy();

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);

  // One of three bottles comes back and goes back on the shelf; the money comes from the drawer.
  await page.goto(`/app/sales/${saleId}`);
  await page.getByTestId("return-goods").click();
  await page.getByLabel("Groundnut oil 5L").pressSequentially("1");
  await expect(page.getByTestId("return-worth")).toContainText("Give back ₦9,000.00");
  await page.getByLabel("Why they brought it back").pressSequentially("leaking cap");
  await page.getByRole("button", { name: "Take goods back" }).click();
  await expect(page.getByTestId("sale-return")).toContainText("RET-000001");
  await expect(page.getByTestId("sale-return")).toContainText("₦9,000.00 given back by Cash from the drawer");
  await expect(page.getByTestId("sale-returned")).toContainText("₦9,000.00");
  await expect(page.getByText("1 brought back")).toBeVisible();
  // A sale with returns is not cancelled as a whole any more.
  await expect(page.getByRole("button", { name: "Cancel this sale" })).toHaveCount(0);

  // More than is left cannot come back.
  await page.getByTestId("return-goods").click();
  await page.getByLabel("Groundnut oil 5L").pressSequentially("3");
  await page.getByLabel("Why they brought it back").pressSequentially("Again");
  await page.getByRole("button", { name: "Take goods back" }).click();
  await expect(page.getByText("Only 2 of Groundnut oil 5L can still come back.")).toBeVisible();
  // Swapping starts a new sale that says what it replaces.
  await page.getByTestId("swap-goods").click();
  await expect(page).toHaveURL(/\/app\/sales\/new/);

  // The stock went back up by the returned bottle: 10 − 3 + 1 + 5 delivered.
  await page.goto(`/app/stock/${productId}`);
  await expect(page.getByText("13 pieces").first()).toBeVisible();

  // Two bottles go back to Kings Oil, taken off what is owed.
  await page.locator("#sendback-supplier").selectOption({ label: "Kings Oil" });
  await page.locator("#sendback-quantity").pressSequentially("2");
  await expect(page.getByLabel("How it is settled")).toHaveValue("owed");
  await page.getByRole("button", { name: "Send back" }).click();
  await expect(page.getByText("Sent back. Your stock went down.")).toBeVisible();
  await expect(page.getByText("11 pieces").first()).toBeVisible();

  await page.goto("/app/suppliers");
  await page.getByRole("link", { name: /Kings Oil/ }).click();
  await expect(page.getByTestId("supplier-owed")).toContainText("₦18,000.00");
  await expect(page.getByTestId("supplier-history")).toContainText("Goods sent back");
});
