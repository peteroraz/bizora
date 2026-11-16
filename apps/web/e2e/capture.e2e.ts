import { expect, test } from "@playwright/test";

const password = "LocalOnly!Passw0rd";
// A real 1×1 PNG, so the phone-side resizing runs as it would on a photo.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// A fake microphone, so a voice note can be recorded in the test browser.
test.use({
  viewport: { width: 360, height: 780 },
  permissions: ["microphone"],
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
});

test("a delivery photo and a spoken sales list become rows to check, and are saved only after checking", async ({ page, request }) => {
  test.setTimeout(120_000);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `capture.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { email, password, displayName: "Ada Owner", organizationName: `Ada Capture ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  const token = (await registered.json()).data.accessToken as string;
  const headers = { authorization: `Bearer ${token}` };
  expect((await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ada Capture", branchName: "Main" } })).ok()).toBeTruthy();
  const product = await request.post("/api/v1/products", { headers, data: { name: "Peak Milk", baseUnit: "tin", priceMinor: "45000", openingQuantity: "96", openingCostMinor: "3360000" } });
  const productId = (await product.json()).data.product.id as string;
  const stock = async () => (await (await request.get(`/api/v1/products/${productId}`, { headers })).json()).data.product.stock.quantity as string;

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);

  // A supplier's delivery note, from a photo.
  await page.goto("/app/stock");
  await page.getByRole("link", { name: "Record a delivery" }).click();
  await expect(page.getByText("Snap the invoice or say what arrived")).toBeVisible();
  await page.locator('input[accept="image/*,application/pdf"]').setInputFiles({ name: "delivery.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByText("1 row was read from your photo or voice note.")).toBeVisible();
  await expect(page.getByLabel("Supplier, row 1")).toHaveValue("Dangote Distributors");
  expect(await stock()).toBe("96000");
  await page.getByLabel("Quantity, row 1").fill("3");
  await page.getByRole("button", { name: "Check rows" }).click();
  await expect(page.getByText("All rows look right: 1 new, 0 updates.")).toBeVisible();
  await page.getByRole("button", { name: "Save 1 row" }).click();
  await expect(page.getByText("Saved: 1 new, 0 updated.")).toBeVisible();
  expect(await stock()).toBe("99000");

  // Today's sales, said out loud.
  await page.goto("/app/sales/import");
  await page.getByRole("button", { name: "Record voice note" }).click();
  await expect(page.getByRole("button", { name: /Stop \(\d+s\)/ })).toBeVisible();
  await page.waitForTimeout(1_500);
  await page.getByRole("button", { name: /Stop/ }).click();
  await expect(page.getByText("2 rows were read from your photo or voice note.")).toBeVisible();
  await expect(page.getByText("I sold two Peak Milk for cash.")).toBeVisible();
  await page.getByRole("button", { name: "Check rows" }).click();
  await expect(page.getByText("All rows look right: 2 new, 0 updates.")).toBeVisible();
  await page.getByRole("button", { name: "Save 2 rows" }).click();
  await expect(page.getByText("Saved: 2 new, 0 updated.")).toBeVisible();
  expect(await stock()).toBe("96000");
  const sales = (await (await request.get("/api/v1/sales", { headers })).json()).data;
  expect(sales.total).toBe(2);
});
