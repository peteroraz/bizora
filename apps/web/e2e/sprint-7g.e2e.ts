import { expect, test } from "@playwright/test";

const password = "LocalOnly!Passw0rd";
// A real 200×200 PNG: big enough to be a useful product photo.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAIAAAAiOjnJAAABeElEQVR42u3SMQ0AAAgEsZeDRCQiCxMMDE2q4HKZLjgXCTAWxsJYYCyMhbHAWBgLY4GxMBbGAmNhLIwFxsJYGAuMhbEwFhgLY2EsMBbGwlhgLIyFscBYGAtjgbEwFsYCY2EsjAXGwlgYC4yFsTAWGAtjYSwwFsbCWGAsjIWxwFgYC2OBsTAWxgJjYSyMBcbCWBgLjIWxMBYYC2NhLDAWxsJYYCyMhbHAWBgLY4GxMBbGAmNhLIyFsVTAWBgLY4GxMBbGAmNhLIwFxsJYGAuMhbEwFhgLY2EsMBbGwlhgLIyFscBYGAtjgbEwFsYCY2EsjAXGwlgYC4yFsTAWGAtjYSwwFsbCWGAsjIWxwFgYC2OBsTAWxgJjYSyMBcbCWBgLjIWxMBYYC2NhLDAWxsJYYCyMhbHAWBgLY4GxMBbGAmNhLIwFxsJYGAtjqYCxMBbGAmNhLIwFxsJYGAuMhbEwFhgLY2EsMBbGwlhgLIyFscBYGAtjgbH4ZgEgJ8bWFPsV7wAAAABJRU5ErkJggg==", "base64");

test.use({
  viewport: { width: 360, height: 780 },
  permissions: ["microphone"],
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
});

test("product photos, a spoken sale and a forwarded voice note for damaged stock", async ({ page, request }) => {
  test.setTimeout(120_000);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `voice.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { acceptTerms: true, email, password, displayName: "Bisi Owner", organizationName: `Bisi Voice ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  const token = (await registered.json()).data.accessToken as string;
  const headers = { authorization: `Bearer ${token}` };
  expect((await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Bisi Voice", branchName: "Main" } })).ok()).toBeTruthy();
  const product = await request.post("/api/v1/products", { headers, data: { name: "Peak Milk", baseUnit: "tin", priceMinor: "45000", openingQuantity: "10", openingCostMinor: "350000" } });
  const productId = (await product.json()).data.product.id as string;
  const stock = async () => (await (await request.get(`/api/v1/products/${productId}`, { headers })).json()).data.product.stock.quantity as string;

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);

  // A photo of the product: shrunk on the phone, then shown on the product and in the list.
  await page.goto(`/app/stock/${productId}`);
  await expect(page.getByTestId("product-photos")).toBeVisible();
  await page.getByTestId("add-product-photo").setInputFiles({ name: "milk.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByRole("img", { name: "Peak Milk, photo 1" })).toBeVisible();
  await expect(page.getByText("1 of 5")).toBeVisible();

  // Say the sale: the cart is filled, then checked and recorded as usual.
  await page.goto("/app/sales/new");
  await page.getByTestId("say-sale").click();
  await page.getByRole("button", { name: "Record voice note" }).click();
  await expect(page.getByRole("button", { name: /Stop \(\d+s\)/ })).toBeVisible();
  await page.waitForTimeout(1_500);
  await page.getByRole("button", { name: /Stop/ }).click();
  await expect(page.getByText("Heard: “I sold two Peak Milk for cash.”")).toBeVisible();
  await expect(page.getByText(/Not found in your products: Unknown thing/)).toBeVisible();
  await expect(page.getByTestId("sale-total")).toHaveText("₦900.00");
  expect(await stock()).toBe("10000");
  await page.getByRole("button", { name: "Record sale" }).click();
  await expect(page.getByRole("heading", { name: "R-000001" })).toBeVisible();
  expect(await stock()).toBe("8000");

  // A voice note forwarded from WhatsApp: damaged goods come off only after checking.
  await page.goto("/app/stock");
  await page.getByRole("link", { name: "Say or snap stock" }).click();
  await page.getByRole("tab", { name: "Damaged, missing or found" }).click();
  await expect(page.getByText("Say what was damaged, missing, used or found")).toBeVisible();
  await page.locator('input[accept="image/*,application/pdf,audio/*"]').setInputFiles({ name: "PTT-20261119-WA0003.opus", mimeType: "", buffer: Buffer.from("voice") });
  await expect(page.getByText("1 row was read from your photo or voice note.")).toBeVisible();
  await expect(page.getByLabel("Note, row 1")).toHaveValue("Tin was dented");
  await page.getByRole("button", { name: "Check rows" }).click();
  await expect(page.getByText("All rows look right: 1 new, 0 updates.")).toBeVisible();
  await page.getByRole("button", { name: "Save 1 row" }).click();
  await expect(page.getByText("Saved: 1 new, 0 updated.")).toBeVisible();
  expect(await stock()).toBe("7000");
});
