import { expect, test } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test.use({ viewport: { width: 360, height: 780 } });

test("owner adds a product, records stock in and damage, sees low stock, and counts with no network", async ({ page, context, request }) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `stock.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { email, password, displayName: "Bola Owner", organizationName: `Bola Provisions ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  expect(registered.ok()).toBeTruthy();
  const token = (await registered.json()).data.accessToken as string;
  const onboarded = await request.patch("/api/v1/onboarding", {
    headers: { authorization: `Bearer ${token}` },
    data: { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Bola Provisions", branchName: "Main" },
  });
  expect(onboarded.ok()).toBeTruthy();

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);

  // Add a product counted in pieces, sold by the carton too, with stock on hand today.
  await page.goto("/app/stock/new");
  await page.getByLabel("Product name").fill("Peak Milk Tin");
  await page.getByLabel("How you count it").selectOption("tin");
  await page.getByLabel("Selling price per tin (₦)").fill("450");
  await page.getByRole("button", { name: "Add a pack size" }).click();
  await page.getByLabel("Pack", { exact: true }).selectOption("carton");
  await page.getByLabel("How many tins in one").fill("48");
  await page.getByLabel("Warn me when stock falls to (in tins)").fill("30");
  await page.getByLabel("How many tins you have").fill("40");
  await page.getByLabel("What they cost in total (₦)").fill("14,000");
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page.getByRole("heading", { name: "Peak Milk Tin" })).toBeVisible();
  await expect(page.getByText("40 tins").first()).toBeVisible();

  // Two cartons arrive, paid from shop cash.
  await page.getByLabel("Quantity").first().fill("2");
  await page.locator("#receive-unit").selectOption("carton");
  await page.getByLabel("Total cost (₦)").fill("33,600");
  await page.locator("#receive-paid").selectOption("cash");
  await page.getByRole("button", { name: "Record stock in" }).click();
  await expect(page.getByText("Stock in recorded.")).toBeVisible();
  await expect(page.getByText("2 cartons, 40 tins").first()).toBeVisible();

  // 110 tins were damaged: stock falls below the warning level.
  await page.locator("#adjust-reason").selectOption("damaged");
  await page.locator("#adjust-quantity").fill("110");
  await page.getByRole("button", { name: "Save change" }).click();
  await expect(page.getByText("Stock updated.")).toBeVisible();
  await expect(page.getByText("26 tins").first()).toBeVisible();
  await expect(page.getByText("Low", { exact: true })).toBeVisible();
  await expect(page.getByText(/Removed or added · Damaged/)).toBeVisible();
  await expect(page.getByText(/Bola Owner · Main/).first()).toBeVisible();

  // Prices change: the owner updates the selling price.
  await page.locator("#edit-price").fill("500");
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page.getByText("Product updated.")).toBeVisible();
  await expect(page.getByText(/₦500\.00 per tin/)).toBeVisible();

  // Home shows it under low stock.
  await page.goto("/app");
  await expect(page.getByRole("link", { name: "Peak Milk Tin: 26 tins" })).toBeVisible();

  // Count with no network: saved on the phone, synced when the network is back.
  await page.goto("/app/stock");
  await page.getByRole("link", { name: /Peak Milk Tin/ }).click();
  await expect(page.getByRole("heading", { name: "Peak Milk Tin" })).toBeVisible();
  await context.setOffline(true);
  await page.locator("#count-quantity").fill("25");
  await page.getByRole("button", { name: "Save count" }).click();
  await expect(page.getByText("No network. Saved on this phone")).toBeVisible();
  await expect(page.getByText("1 change waiting to sync")).toBeVisible();

  // The network comes back: the count is sent and applied (an owner's count needs no approval).
  await context.setOffline(false);
  await expect(page.getByText("1 change waiting to sync")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(/could not be saved/)).toHaveCount(0);
  await expect
    .poll(async () => {
      const product = await request.get("/api/v1/products?q=Peak", { headers: { authorization: `Bearer ${token}` } });
      return ((await product.json()).data.items as { stock: { quantity: string } }[])[0]?.stock.quantity;
    })
    .toBe("25000");
});
