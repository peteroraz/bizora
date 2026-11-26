import { expect, test, type Browser } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test.use({ viewport: { width: 360, height: 780 } });

async function signIn(browser: Browser, email: string) {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);
  return { context, page };
}

test("expenses, the cash in the drawer, a blind count, money to the bank and the day's profit", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `money.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { acceptTerms: true, email, password, displayName: "Ada Owner", organizationName: `Ada Stores ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  const headers = { authorization: `Bearer ${(await registered.json()).data.accessToken}` };
  expect((await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ada Stores", branchName: "Main" } })).ok()).toBeTruthy();
  const me = (await (await request.get("/api/v1/auth/me", { headers })).json()).data.tenant;
  // Two bags of rice sold for ₦10,000 cash; they cost ₦6,000.
  const product = await request.post("/api/v1/products", { headers, data: { name: "Rice 5kg", baseUnit: "piece", priceMinor: "500000", openingQuantity: "10", openingCostMinor: "3000000" } });
  await request.post("/api/v1/sales", { headers, data: { lines: [{ productId: (await product.json()).data.product.id, quantity: "2", unit: "piece" }], payments: [{ method: "cash", amountMinor: "1000000" }] } });
  const cashierEmail = `cashier.${suffix}@bizora.test`;
  const invited = await request.post("/api/v1/invitations", { headers, data: { email: cashierEmail, role: "CASHIER", businessId: me.businessId, branchId: me.branchId } });
  await request.post("/api/v1/invitations/accept", { data: { token: (await invited.json()).data.invitation.token, displayName: "Ngozi Cashier", password } });

  const { page } = await signIn(browser, email);
  await expect(page.getByTestId("home-cash")).toContainText("₦10,000.00");

  // An expense paid from the drawer.
  await page.goto("/app/money/expenses/new");
  await page.getByLabel("What was it for?").selectOption({ label: "Transport and delivery" });
  await page.getByLabel("Amount").pressSequentially("1500");
  await page.getByLabel("Cash from the drawer").check();
  await page.getByLabel("Paid to").pressSequentially("okada to market");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/app\/money\/expenses\?saved=approved/);
  await expect(page.getByText("Expense recorded.")).toBeVisible();
  await expect(page.getByTestId("expense-totals")).toContainText("₦1,500.00");
  await expect(page.getByTestId("expense-list")).toContainText("Okada To Market");

  // The drawer: ₦10,000 in from sales, ₦1,500 out for the expense.
  await page.goto("/app/money/cash");
  await expect(page.getByTestId("cash-expected")).toHaveText("₦8,500.00");
  await expect(page.getByTestId("cash-flow-sales")).toContainText("+₦10,000.00");
  await expect(page.getByTestId("cash-flow-expenses")).toContainText("−₦1,500.00");

  // The cashier counts without seeing what was expected.
  const cashier = await signIn(browser, cashierEmail);
  await cashier.page.goto("/app/money");
  await expect(cashier.page.getByTestId("money-cash")).not.toContainText("₦");
  await cashier.page.getByRole("link", { name: "Count the cash" }).click();
  await cashier.page.getByLabel("Cash counted").pressSequentially("8000");
  await cashier.page.getByRole("button", { name: "Save" }).click();
  await expect(cashier.page.getByTestId("count-result")).toHaveText("Count saved. Your manager sees whether it matches.");
  await cashier.context.close();

  // The owner sees the drawer was ₦500 short, and pays ₦3,000 into the bank.
  await page.reload();
  await expect(page.getByTestId("cash-counts")).toContainText("Short by ₦500.00");
  await expect(page.getByTestId("cash-expected")).toHaveText("₦8,000.00");
  await page.getByRole("link", { name: "Record money in or out" }).click();
  await page.getByLabel("Cash from the drawer paid into the bank").check();
  await page.getByLabel("Amount").pressSequentially("3000");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/app\/money\/cash$/);
  await expect(page.getByTestId("cash-expected")).toHaveText("₦5,000.00");

  // Profit: ₦10,000 sales − ₦6,000 cost − ₦1,500 transport − ₦500 short = ₦2,000.
  await page.goto("/app/money/profit");
  await expect(page.getByTestId("profit-amount")).toHaveText("₦2,000.00");
  await expect(page.getByTestId("profit-uncosted")).toHaveCount(0);
  await expect(page.getByTestId("profit-card")).toContainText("Transport and delivery");
  await expect(page.getByTestId("profit-card")).toContainText("Cash short or over");
  await page.getByRole("tab", { name: "This month" }).click();
  await expect(page.getByTestId("profit-amount")).toHaveText("₦2,000.00");
  await page.goto("/app");
  await expect(page.getByTestId("home-profit")).toContainText("₦2,000.00");
  await expect(page.getByTestId("home-profit-cost-missing")).toHaveCount(0);
});

test("goods added with no cost are not shown as all profit (review, 26 Nov)", async ({ browser, request }) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `nocost.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { acceptTerms: true, email, password, displayName: "Bisi Owner", organizationName: `Bisi Provisions ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  const headers = { authorization: `Bearer ${(await registered.json()).data.accessToken}` };
  expect((await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Bisi Provisions", branchName: "Main" } })).ok()).toBeTruthy();
  // 20 bags added with no cost, 2 sold for ₦4,400.
  const product = await request.post("/api/v1/products", { headers, data: { name: "Semovita 1kg", baseUnit: "bag", priceMinor: "220000", openingQuantity: "20" } });
  await request.post("/api/v1/sales", { headers, data: { lines: [{ productId: (await product.json()).data.product.id, quantity: "2", unit: "bag" }], payments: [{ method: "cash", amountMinor: "440000" }] } });

  const { context, page } = await signIn(browser, email);
  await expect(page.getByTestId("home-profit")).toContainText("₦4,400.00");
  await expect(page.getByTestId("home-profit-cost-missing")).toHaveText("Some goods sold have no cost, so the real profit may be lower.");
  await page.goto("/app/money");
  await expect(page.getByTestId("money-profit-cost-missing")).toBeVisible();
  await page.goto("/app/money/profit");
  await expect(page.getByTestId("profit-uncosted")).toContainText("₦4,400.00 of sales (100%) have no cost recorded.");
  await context.close();
});
