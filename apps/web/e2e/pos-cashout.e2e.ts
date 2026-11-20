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

test("cash already in the drawer is not profit, and a POS cash-out counts only its fee (ADR-038)", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `pos.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { email, password, displayName: "Tunde Owner", organizationName: `Tunde Stores ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  const headers = { authorization: `Bearer ${(await registered.json()).data.accessToken}` };
  expect((await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Tunde Stores", branchName: "Main" } })).ok()).toBeTruthy();
  const me = (await (await request.get("/api/v1/auth/me", { headers })).json()).data.tenant;
  const cashierEmail = `pos.cashier.${suffix}@bizora.test`;
  const invited = await request.post("/api/v1/invitations", { headers, data: { email: cashierEmail, role: "CASHIER", businessId: me.businessId, branchId: me.branchId } });
  await request.post("/api/v1/invitations/accept", { data: { token: (await invited.json()).data.invitation.token, displayName: "Bimpe Cashier", password } });

  // The cashier counts the ₦50,000 already in the drawer, then gives a customer ₦10,000 on the POS for a ₦200 fee.
  const cashier = await signIn(browser, cashierEmail);
  await cashier.page.goto("/app/money/cash/count");
  await cashier.page.getByLabel("Cash counted").pressSequentially("50000");
  await cashier.page.getByRole("button", { name: "Save" }).click();
  await expect(cashier.page.getByTestId("count-result")).toBeVisible();
  await cashier.page.goto("/app");
  await cashier.page.getByTestId("home-pos-cashout").click();
  await expect(cashier.page.getByRole("heading", { name: "POS cash-out" })).toBeVisible();
  await cashier.page.getByLabel("Cash given to the customer").pressSequentially("10000");
  await cashier.page.getByLabel("Your fee").pressSequentially("200");
  await expect(cashier.page.getByTestId("pos-cashout-summary")).toHaveText("The POS should show ₦10,200.00. The drawer goes down by ₦10,000.00.");
  await cashier.page.getByRole("button", { name: "Save cash-out" }).click();
  await expect(cashier.page.getByTestId("pos-cashout-saved")).toHaveText("Saved. ₦10,000.00 given out, fee ₦200.00.");
  await cashier.context.close();

  const { page } = await signIn(browser, email);
  await page.goto("/app/money/cash");
  await expect(page.getByTestId("cash-expected")).toHaveText("₦40,000.00");
  await expect(page.getByTestId("cash-flow-pos_cashout")).toContainText("−₦10,000.00");
  await expect(page.getByText("POS cash-out (fee ₦200.00 on the POS)")).toBeVisible();

  // Profit is the fee only: the ₦50,000 found in the drawer is shown apart and not counted.
  await page.goto("/app/money/profit");
  await expect(page.getByTestId("profit-amount")).toHaveText("₦200.00");
  await expect(page.getByTestId("profit-card")).toContainText("Fees for POS cash-outs");
  await expect(page.getByTestId("profit-not-from-sales")).toContainText("₦50,000.00 came in that was not from sales");
});
