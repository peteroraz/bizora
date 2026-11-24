import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// Batches and expiry dates (ADR-061).

test.use({ viewport: { width: 360, height: 780 } });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

test("a pharmacy records a batch with its expiry, sees what is expiring and takes expired stock off", async ({ page, request }) => {
  const { email, headers } = await shop(request);
  const created = await request.post("/api/v1/products", { headers, data: { name: "Amoxicillin 500mg", baseUnit: "pack", priceMinor: "250000" } });
  const productId = (await created.json()).data.product.id as string;
  // An older delivery, already past its date.
  await request.patch(`/api/v1/products/${productId}`, { headers, data: { name: "Amoxicillin 500mg", baseUnit: "pack", priceMinor: "250000", tracksBatches: true } });
  await request.post("/api/v1/stock/receive", { headers, data: { productId, quantity: "3", unit: "pack", paidFrom: "cash", totalCostMinor: "450000", batch: { batchNumber: "AMX-OLD", expiryDate: day(-3) } } });

  await signIn(page, email);
  await page.goto(`/app/stock/${productId}`);
  await page.getByLabel("Quantity", { exact: true }).first().fill("10");
  await page.getByLabel("Paid from").selectOption("cash");
  await page.getByLabel("Batch or lot number").fill("AMX-2611");
  await page.getByLabel("Expiry date", { exact: true }).fill(day(12));
  await page.getByRole("button", { name: "Record stock in" }).click();
  await expect(page.getByTestId("product-batches")).toContainText("AMX-2611");
  const rows = page.getByTestId("batch-row");
  await expect(rows.first()).toContainText("AMX-OLD");
  await expect(rows.first()).toContainText("Expired");
  await expect(rows.nth(1)).toContainText("12 days left");

  await page.goto("/app/stock");
  await expect(page.getByTestId("expiring-notice")).toContainText("1 batch is past its expiry date. 1 batch expires soon.");
  await page.getByTestId("expiring-notice").click();
  await expect(page.getByTestId("expiring-row")).toHaveCount(2);
  await page.getByTestId("expiring-row").first().getByRole("link").click();

  await page.getByTestId("product-batches").getByRole("button", { name: "Take off as expired" }).click();
  await expect(page.getByText("Expired stock taken off.")).toBeVisible();
  await expect(page.getByTestId("batch-row")).toHaveCount(1);
  await expect(page.getByTestId("batch-row")).toContainText("AMX-2611");
});
