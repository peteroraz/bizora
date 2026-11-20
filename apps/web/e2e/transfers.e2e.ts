import { expect, test } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test.use({ viewport: { width: 360, height: 780 } });

test("a cashier's transfer waits for the owner, who confirms one and writes off a fake one; the report shows it", async ({ page, request }) => {
  test.setTimeout(150_000);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `transfers.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { acceptTerms: true, email, password, displayName: "Ada Owner", organizationName: `Ada Shoes ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  const headers = { authorization: `Bearer ${(await registered.json()).data.accessToken}` };
  expect((await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ada Shoes", branchName: "Main" } })).ok()).toBeTruthy();
  const me = (await (await request.get("/api/v1/auth/me", { headers })).json()).data.tenant;
  const product = await request.post("/api/v1/products", { headers, data: { name: "Sneakers", baseUnit: "piece", priceMinor: "2500000", openingQuantity: "10", openingCostMinor: "15000000" } });
  const productId = (await product.json()).data.product.id as string;
  const cashierEmail = `cashier.${suffix}@bizora.test`;
  const invited = await request.post("/api/v1/invitations", { headers, data: { email: cashierEmail, role: "CASHIER", businessId: me.businessId, branchId: me.branchId } });
  await request.post("/api/v1/invitations/accept", { data: { token: (await invited.json()).data.invitation.token, displayName: "Ngozi Cashier", password } });
  const cashierLogin = await request.post("/api/v1/auth/login", { data: { email: cashierEmail, password } });
  const cashier = { authorization: `Bearer ${(await cashierLogin.json()).data.accessToken}` };
  const sell = async (reference: string) => {
    const sale = await request.post("/api/v1/sales", { headers: cashier, data: { lines: [{ productId, quantity: "1", unit: "piece" }], payments: [{ method: "transfer", amountMinor: "2500000", reference }] } });
    expect(sale.ok()).toBeTruthy();
    return (await sale.json()).data.sale as { id: string; number: string };
  };
  const real = await sell("GTB-REAL");
  const fake = await sell("FAKE-ALERT");

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);

  // Home and Money tell the owner there is something to check.
  await expect(page.getByTestId("home-transfers")).toContainText("2 transfers to check against the bank");
  await page.goto(`/app/sales/${real.id}`);
  await expect(page.getByTestId("transfer-waiting-label")).toHaveText("Waiting for the owner to check the bank");
  await page.goto("/app/money");
  await expect(page.getByTestId("money-transfers")).toContainText("2 transfers waiting, ₦50,000.00");
  await page.getByRole("link", { name: "Check transfers" }).click();
  await expect(page.getByTestId("transfers-waiting-total")).toHaveText("2 transfers waiting, ₦50,000.00 in all");
  await expect(page.getByTestId("transfer-waiting").first()).toContainText("Recorded by Ngozi Cashier");

  // The real one came in.
  const realCard = page.getByTestId("transfer-waiting").filter({ hasText: "GTB-REAL" });
  await realCard.getByRole("button", { name: "It came in" }).click();
  await expect(page.getByRole("status")).toHaveText("₦25,000.00 confirmed. It now counts as money in the bank.");
  await expect(page.getByTestId("transfer-waiting")).toHaveCount(1);

  // The fake one never came, and there is no customer to owe it.
  const fakeCard = page.getByTestId("transfer-waiting").filter({ hasText: "FAKE-ALERT" });
  await fakeCard.getByRole("button", { name: "It never came" }).click();
  await expect(fakeCard.getByLabel("Write it off as lost")).toBeChecked();
  await fakeCard.getByLabel("What happened").pressSequentially("fake alert screenshot");
  await fakeCard.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toContainText("written off as lost");
  await expect(page.getByText("Nothing to check")).toBeVisible();
  await expect(page.getByTestId("transfers-recent")).toContainText("Never came. Written off as lost (by Ada Owner)");
  await expect(page.getByTestId("transfers-recent")).toContainText("Confirmed by Ada Owner");

  // The report shows the lost transfer against the cashier who took it.
  await page.goto("/app/money/discounts");
  await expect(page.getByTestId("discounts-totals")).toContainText("Transfers that never came₦25,000.00");
  await expect(page.getByTestId("discounts-people")).toContainText("Ngozi Cashier");
  await expect(page.getByTestId("discounts-people")).toContainText("1 transfer never came ₦25,000.00");
  await expect(page.getByRole("list", { name: "Transfers that never came" })).toContainText("Fake alert screenshot");

  // The fake sale says so.
  await page.goto(`/app/sales/${fake.id}`);
  await expect(page.getByText("Never came: written off")).toBeVisible();
});
