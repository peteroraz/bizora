import { expect, test } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test.use({ viewport: { width: 360, height: 780 } });

test("a debtor pays part of what they owe, gets a receipt and a statement link, and a new customer is added during a sale", async ({ page, request, browser }) => {
  test.setTimeout(120_000);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `debtors.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { acceptTerms: true, email, password, displayName: "Ada Owner", organizationName: `Ada Debtors ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  const token = (await registered.json()).data.accessToken as string;
  const headers = { authorization: `Bearer ${token}` };
  expect((await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ada Debtors", branchName: "Main" } })).ok()).toBeTruthy();
  const product = await request.post("/api/v1/products", { headers, data: { name: "Rice 50kg", baseUnit: "bag", priceMinor: "1000000", openingQuantity: "20", openingCostMinor: "16000000" } });
  const productId = (await product.json()).data.product.id as string;
  const customer = await request.post("/api/v1/customers", { headers, data: { name: "Mama Chika", phone: "08031234567", creditAllowed: true } });
  const customerId = (await customer.json()).data.customer.id as string;
  const sale = await request.post("/api/v1/sales", {
    headers,
    data: { lines: [{ productId, quantity: "2", unit: "bag" }], customerId, payments: [{ method: "cash", amountMinor: "500000" }], dueDate: "2099-01-31", comment: "Pays after market day" },
  });
  expect(sale.ok()).toBeTruthy();

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);

  // Home shows what is owed; Debtors lists who owes.
  await expect(page.getByTestId("home-debtors")).toContainText("₦15,000.00");
  await page.getByTestId("home-debtors").click();
  await expect(page.getByTestId("debtors-total")).toHaveText("₦15,000.00");
  await page.getByRole("link", { name: /Mama Chika/ }).click();
  await expect(page.getByTestId("account-owing")).toHaveText("₦15,000.00");
  await expect(page.getByRole("link", { name: "Send reminder on WhatsApp" })).toHaveAttribute("href", /^https:\/\/wa\.me\/2348031234567\?text=.*%2Fs%2F/);

  // A part payment by transfer.
  await page.getByLabel("Amount received").fill("5000");
  await page.getByLabel("Paid with").selectOption("transfer");
  await page.getByLabel("Reference").fill("GTB 0412");
  await page.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText("Payment PAY-000001 of ₦5,000.00 recorded.")).toBeVisible();
  await expect(page.getByTestId("account-owing")).toHaveText("₦10,000.00");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Send receipt PDF" }).click();
  expect((await download).suggestedFilename()).toBe("Payment-receipt-PAY-000001.pdf");

  // The customer opens their statement without signing in.
  const statementPath = await page.getByRole("link", { name: "View statement" }).getAttribute("href");
  const stranger = await browser.newContext();
  const statement = await stranger.newPage();
  await statement.goto(statementPath ?? "/s/missing");
  await expect(statement.getByText("₦10,000.00").first()).toBeVisible();
  await expect(statement.getByText(/PAY-000001/)).toBeVisible();
  const pdf = await request.get((await statement.getByRole("link", { name: "Download statement (PDF)" }).getAttribute("href")) ?? "/missing");
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  await stranger.close();

  // A new customer, added while recording a sale.
  await page.goto("/app/sales/new");
  await page.getByLabel("Find a product").fill("rice");
  await page.getByRole("button", { name: /Rice 50kg/ }).click();
  await page.getByRole("button", { name: "+ New or walk-in customer" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Bola Ade");
  await page.getByLabel("Phone number", { exact: true }).fill("08051112222");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByText("Bola Ade")).toBeVisible();
  await page.getByRole("button", { name: "Record sale", exact: true }).click();
  await expect(page.getByText("Customer: Bola Ade (phone ending 2222)")).toBeVisible();
});
