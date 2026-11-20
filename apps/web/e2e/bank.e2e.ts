import { expect, test } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test.use({ viewport: { width: 360, height: 780 } });

function lagosToday() {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).split("-");
  return `${day}/${month}/${year}`;
}

test("a bank statement is uploaded, transfers are matched to sales and debtors, POS money is not counted as sales, and a match is undone", async ({ page, request }) => {
  test.setTimeout(120_000);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `bank.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { acceptTerms: true, email, password, displayName: "Ada Owner", organizationName: `Ada Bank ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  const token = (await registered.json()).data.accessToken as string;
  const headers = { authorization: `Bearer ${token}` };
  expect((await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ada Bank", branchName: "Main" } })).ok()).toBeTruthy();
  const product = await request.post("/api/v1/products", { headers, data: { name: "Rice 50kg", baseUnit: "bag", priceMinor: "1000000", openingQuantity: "20", openingCostMinor: "16000000" } });
  const productId = (await product.json()).data.product.id as string;
  const customer = await request.post("/api/v1/customers", { headers, data: { name: "Mama Chika", phone: "08031234567", creditAllowed: true } });
  const customerId = (await customer.json()).data.customer.id as string;
  // Mama Chika owes ₦20,000; another customer paid ₦10,000 by transfer, reference GTB12345.
  expect((await request.post("/api/v1/sales", { headers, data: { lines: [{ productId, quantity: "2", unit: "bag" }], customerId, payments: [], dueDate: "2099-01-31", comment: "Pays weekly" } })).ok()).toBeTruthy();
  expect((await request.post("/api/v1/sales", { headers, data: { lines: [{ productId, quantity: "1", unit: "bag" }], payments: [{ method: "transfer", amountMinor: "1000000", reference: "GTB12345" }] } })).ok()).toBeTruthy();

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);

  // Upload the statement from Money.
  await page.goto("/app/money");
  await page.getByRole("link", { name: "Upload a statement" }).click();
  await page.getByLabel("Which account is this?").fill("GTBank 0123");
  const today = lagosToday();
  await page.locator('input[accept=".csv,text/csv"]').setInputFiles({
    name: "statement.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      `Trans. Date,Narration,Reference,Debits,Credits,Balance\n${today},NIP CR/MAMA CHIKA/GTB/rice,S1,,"15,000.00",\n${today},TRF FRM BOLA REF GTB12345,S2,,"10,000.00",\n${today},POS SETTLEMENT MONIEPOINT 0012,S3,,"25,000.00",\n${today},ATM WITHDRAWAL,S4,"3,000.00",,\n`,
    ),
  });
  await page.getByRole("button", { name: "Check rows" }).click();
  await expect(page.getByText("Money out: matching comes with money in and out (Sprint 7).")).toBeVisible();
  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(page.getByText("3 lines were added.")).toBeVisible();

  // The transfer recorded at the counter was matched by its reference; two lines are left to check.
  await page.getByRole("link", { name: "Check bank lines" }).first().click();
  await expect(page.getByTestId("statement-line")).toHaveCount(2);
  const chika = page.getByTestId("statement-line").filter({ hasText: "MAMA CHIKA" });
  await chika.getByRole("button", { name: /Payment from Mama Chika \(owes ₦20,000\.00\)/ }).click();
  await expect(page.getByText("Done: ₦15,000.00 is now in your books.")).toBeVisible();

  // POS money settled to the bank: money moving, not sales. Remember it for next time.
  const pos = page.getByTestId("statement-line").filter({ hasText: "POS SETTLEMENT" });
  await pos.getByRole("button", { name: "Other…" }).click();
  await pos.getByLabel("What is this money?").selectOption("own_transfer:pos_settlement");
  await pos.getByText("Always do this for lines like this").click();
  await pos.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Nothing to check")).toBeVisible();
  await expect(page.getByTestId("statement-rule")).toContainText("POS SETTLEMENT");

  const debtor = await request.get(`/api/v1/debtors/${customerId}`, { headers });
  expect((await debtor.json()).data.account.owingMinor).toBe("500000");

  // Undo the debtor match: the payment is cancelled and she owes ₦20,000 again.
  await page.getByRole("tab", { name: /Done/ }).click();
  await expect(page.getByTestId("statement-done")).toHaveCount(3);
  await expect(page.getByText("Matched for you")).toBeVisible();
  await page.getByTestId("statement-done").filter({ hasText: "MAMA CHIKA" }).getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Undone. The line is back in To check.")).toBeVisible();
  await expect(page.getByTestId("statement-done")).toHaveCount(2);
  const after = await request.get(`/api/v1/debtors/${customerId}`, { headers });
  expect((await after.json()).data.account.owingMinor).toBe("2000000");
});
