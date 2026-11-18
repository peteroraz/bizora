import { expect, test } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test.use({ viewport: { width: 360, height: 780 } });

test("an expired sign-in pass is renewed without leaving the page, and sales open on any chosen day", async ({ page, request }) => {
  test.setTimeout(120_000);
  const suffix = `${Date.now()}`;
  const email = `days.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { email, password, displayName: "Kofi Owner", organizationName: `Kofi Stores ${suffix}`, countryCode: "GH", baseCurrencyCode: "GHS", timezone: "Africa/Accra" },
  });
  const headers = { authorization: `Bearer ${(await registered.json()).data.accessToken}` };
  expect((await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "GH", industryCode: "general-retail", baseCurrencyCode: "GHS", timezone: "Africa/Accra", businessName: "Kofi Stores", branchName: "Osu" } })).ok()).toBeTruthy();
  const product = await request.post("/api/v1/products", { headers, data: { name: "Rice 5kg", baseUnit: "piece", priceMinor: "9000", openingQuantity: "10", openingCostMinor: "60000" } });
  await request.post("/api/v1/sales", { headers, data: { lines: [{ productId: (await product.json()).data.product.id, quantity: "1", unit: "piece" }], payments: [{ method: "cash", amountMinor: "9000" }] } });
  const today = (await (await request.get("/api/v1/sales/summary", { headers })).json()).data.date as string;
  const shift = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await page.goto("/app/sales");
  await expect(page.getByTestId("day-label")).toHaveText("Today");
  await expect(page.getByTestId("sales-day-total")).toContainText("90");

  // Go straight to a day with the calendar: the day is kept in the address.
  const lastWeek = shift(-7);
  await page.getByTestId("day-input").fill(lastWeek, { force: true });
  await expect(page).toHaveURL(new RegExp(`/app/sales\\?day=${lastWeek}$`));
  await expect(page.getByTestId("day-label")).not.toHaveText(/Today|Yesterday/);
  await expect(page.getByTestId("sales-day-total")).toContainText("0.00");
  await expect(page.getByRole("button", { name: "Pick a day" })).toBeVisible();
  // A day after today cannot be picked.
  await page.getByTestId("day-input").fill(shift(3), { force: true });
  await expect(page).toHaveURL(new RegExp(`day=${lastWeek}$`));

  // The 15-minute pass runs out while the page is open: the next tap renews it and carries on.
  await page.context().clearCookies({ name: "bizora_session" });
  await page.getByRole("button", { name: "Next day" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/sales\\?day=${shift(-6)}$`));
  await expect.poll(async () => (await page.context().cookies()).some((cookie) => cookie.name === "bizora_session")).toBe(true);
  await expect(page).toHaveURL(/\/app\/sales/);
  await expect(page.getByTestId("sales-day-total")).toContainText("0.00");

  // It runs out again and the page is reloaded: still signed in, still on the same day.
  await page.context().clearCookies({ name: "bizora_session" });
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/app/sales\\?day=${shift(-6)}$`));
  await expect(page.getByTestId("day-switcher")).toBeVisible();

  await page.getByRole("button", { name: "Back to today" }).click();
  await expect(page).toHaveURL(/\/app\/sales$/);
  await expect(page.getByTestId("day-label")).toHaveText("Today");
  await expect(page.getByTestId("sales-day-total")).toContainText("90");

  // Signed out for real (both passes gone): the sign-in page brings the person back where they were.
  await page.context().clearCookies({ name: "bizora_session" });
  await page.context().clearCookies({ name: "bizora_refresh" });
  await page.getByRole("button", { name: "Day before" }).click();
  await expect(page).toHaveURL(/\/login\?reason=session&returnTo=%2Fapp%2Fsales/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/sales/);
});
