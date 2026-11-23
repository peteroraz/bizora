import { expect, test } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test.use({ viewport: { width: 360, height: 780 } });

test("boxes take only what fits: names, Ghana phone numbers, cedi amounts, and stock is added up", async ({ page, request }) => {
  test.setTimeout(120_000);
  const suffix = `${Date.now()}`;
  const email = `typing.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { acceptTerms: true, email, password, displayName: "Ama Owner", organizationName: `Ama Stores ${suffix}`, countryCode: "GH", baseCurrencyCode: "GHS", timezone: "Africa/Accra" },
  });
  const headers = { authorization: `Bearer ${(await registered.json()).data.accessToken}` };
  expect(
    (
      await request.patch("/api/v1/onboarding", {
        headers,
        data: { countryCode: "GH", industryCode: "general-retail", baseCurrencyCode: "GHS", timezone: "Africa/Accra", businessName: "Ama Stores", branchName: "Osu" },
      })
    ).ok(),
  ).toBeTruthy();

  await page.goto("/login");
  await page.getByLabel("Email").fill(email.toUpperCase());
  await expect(page.getByLabel("Email")).toHaveValue(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);

  // A customer: the name gets its capitals, the phone is checked against Ghana's numbers.
  await page.goto("/app/customers/new");
  const name = page.getByLabel("Name", { exact: true });
  await name.pressSequentially("kofi mensah");
  await expect(name).toHaveValue("Kofi Mensah");
  const phone = page.getByLabel("Phone", { exact: true });
  await expect(phone).toHaveAttribute("placeholder", /^0\d{2} \d{3} \d{4}$/);
  await phone.pressSequentially("024123");
  await phone.blur();
  await expect(page.getByTestId("phone-problem")).toHaveText(/This number is too short for Ghana\. Numbers there look like 0\d{2} \d{3} \d{4}\./);
  await phone.fill("");
  await phone.pressSequentially("0241234567");
  await expect(phone).toHaveValue("024 123 4567");
  await phone.blur();
  await expect(page.getByTestId("phone-problem")).toHaveCount(0);
  await page.getByRole("button", { name: "Save customer" }).click();
  await expect(page).toHaveURL(/\/app\/customers\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: "Kofi Mensah" })).toBeVisible();

  // A product: cedi amounts with commas and two decimals, and the opening cost worked out.
  await page.goto("/app/stock/new");
  await page.getByLabel("Item name").pressSequentially("rice 5kg");
  await expect(page.getByLabel("Item name")).toHaveValue("Rice 5kg");
  const price = page.getByLabel("Selling price per piece");
  await price.pressSequentially("1500.555abc");
  await expect(price).toHaveValue("1,500.55");
  await page.getByLabel("How many pieces you have").pressSequentially("10");
  await page.getByRole("button", { name: "More options" }).click();
  await page.getByLabel("Cost price per piece").pressSequentially("1200");
  await expect(page.getByText("10 × GH₵1,200.00 = GH₵12,000.00")).toBeVisible();
  await page.getByRole("button", { name: "Save item" }).click();
  await expect(page).toHaveURL(/\/app\/stock\/[0-9a-f-]+$/);

  // Stock in: the cost of one works out the total.
  await page.getByLabel("Quantity").first().pressSequentially("5");
  await page.getByLabel("Cost of one").pressSequentially("1100");
  await expect(page.getByLabel("Total cost")).toHaveValue("5,500");
  await page.getByLabel("Supplier").pressSequentially("kwame wholesale");
  await page.getByRole("button", { name: "Record stock in" }).click();
  await expect(page.getByText("Stock in recorded.").or(page.getByRole("status"))).toBeVisible();

  // The stock list adds everything up.
  await page.goto("/app/stock");
  await expect(page.getByTestId("stock-cost-value")).toHaveText("GH₵17,500.00");
  await expect(page.getByTestId("stock-selling-value")).toHaveText("GH₵22,508.25");
});
