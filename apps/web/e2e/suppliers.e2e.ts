import { expect, test } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test.use({ viewport: { width: 360, height: 780 } });

test("stock bought on credit is owed to its supplier, paid off, and cancelled payments put it back", async ({ page, request }) => {
  test.setTimeout(150_000);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `suppliers.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { acceptTerms: true, email, password, displayName: "Bola Owner", organizationName: `Bola Stores ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  const headers = { authorization: `Bearer ${(await registered.json()).data.accessToken}` };
  expect((await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Bola Stores", branchName: "Main" } })).ok()).toBeTruthy();
  const product = await request.post("/api/v1/products", { headers, data: { name: "Rice 50kg", baseUnit: "piece", priceMinor: "8000000" } });
  const productId = (await product.json()).data.product.id as string;
  const today = (await (await request.get("/api/v1/sales/summary", { headers })).json()).data.date as string;
  const lastWeek = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);

  // Stock in owed to a supplier: the supplier must be named.
  await page.goto(`/app/stock/${productId}`);
  await page.getByLabel("Quantity").first().pressSequentially("10");
  await page.getByLabel("Total cost").pressSequentially("50000");
  await expect(page.getByLabel("Paid from")).toHaveValue("credit");
  await page.getByRole("button", { name: "Record stock in" }).click();
  await expect(page.getByLabel("Supplier")).toHaveJSProperty("validity.valueMissing", true);
  await page.getByLabel("Supplier").pressSequentially("dangote distributors");
  await expect(page.getByLabel("Supplier")).toHaveValue("Dangote Distributors");
  await page.getByLabel("Pay by").fill(lastWeek);
  await page.getByRole("button", { name: "Record stock in" }).click();
  await expect(page.getByText("Stock in recorded.")).toBeVisible();

  // The supplier owes nothing back yet: it is all owed, and late.
  await page.goto("/app/suppliers");
  await expect(page.getByTestId("suppliers-total")).toContainText("₦50,000.00");
  await expect(page.getByTestId("suppliers-total")).toContainText("₦50,000.00 is late");
  await page.getByRole("link", { name: /Dangote Distributors/ }).click();
  await expect(page.getByTestId("supplier-owed")).toContainText("₦50,000.00");
  await expect(page.getByTestId("supplier-history")).toContainText("Rice 50kg: 10 pieces");

  // Pay part from the drawer.
  await page.getByRole("button", { name: "Pay this supplier" }).click();
  await page.getByLabel("Amount paid").pressSequentially("20000");
  await page.getByLabel("Cash from the drawer").check();
  await page.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText("Payment recorded.")).toBeVisible();
  await expect(page.getByTestId("supplier-owed")).toContainText("₦30,000.00");
  await expect(page.getByTestId("supplier-owed")).toContainText("₦30,000.00 is late");

  // What was owed before Bizora.
  await page.getByRole("button", { name: "Already owed before Bizora" }).click();
  await page.getByLabel("Amount owed").pressSequentially("5000");
  await page.getByRole("button", { name: "Add what was owed" }).click();
  await expect(page.getByTestId("supplier-owed")).toContainText("₦35,000.00");

  // The owner cancels the payment: the debt comes back.
  const payment = page.getByTestId("supplier-history").getByRole("listitem").filter({ hasText: "Cash from the drawer" });
  await payment.getByRole("button", { name: "Cancel" }).click();
  await payment.getByLabel("Why?").fill("Paid the wrong supplier");
  await payment.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Cancelled.")).toBeVisible();
  await expect(page.getByTestId("supplier-owed")).toContainText("₦55,000.00");

  await page.goto("/app/money");
  await expect(page.getByTestId("money-suppliers")).toContainText("You owe ₦55,000.00");
});
