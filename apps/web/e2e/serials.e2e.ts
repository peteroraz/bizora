import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// Serial numbers and IMEIs (ADR-062).

test.use({ viewport: { width: 360, height: 780 } });

test("a phone shop records IMEIs as phones come in, adds one to a sale, and finds who bought it", async ({ page, request }) => {
  const { email, headers } = await shop(request);
  const created = await request.post("/api/v1/products", { headers, data: { name: "Tecno Spark 20", baseUnit: "piece", priceMinor: "12000000" } });
  const productId = (await created.json()).data.product.id as string;

  await signIn(page, email);
  await page.goto(`/app/stock/${productId}`);
  await page.getByLabel("Keep a serial number or IMEI for each unit").check();
  await page.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByText("Product updated.")).toBeVisible();

  await page.getByLabel("Quantity", { exact: true }).first().fill("2");
  await page.getByLabel("Paid from").selectOption("cash");
  await page.getByLabel("Serial numbers or IMEIs").fill("356789104455661\n356789104455662");
  await page.getByRole("button", { name: "Record stock in" }).click();
  await expect(page.getByTestId("product-serials")).toContainText("2 units here by serial number");
  await expect(page.getByTestId("product-serials")).toContainText("356789104455662");

  const sold = await request.post("/api/v1/sales", { headers, data: { lines: [{ productId, quantity: "1", unit: "piece" }], payments: [{ method: "cash", amountMinor: "12000000" }] } });
  const sale = (await sold.json()).data.sale as { id: string; number: string };
  await page.goto(`/app/sales/${sale.id}`);
  await page.getByLabel("Add the serial number").fill("356789104455661");
  await page.getByRole("button", { name: "Save serial numbers" }).click();
  await expect(page.getByTestId("line-serials")).toContainText("Serial no.: 356789104455661");

  await page.goto("/app/stock");
  await page.getByRole("link", { name: "Find a serial number" }).first().click();
  await page.getByLabel("Serial number or IMEI").fill("35678910445566");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("serial-result")).toHaveCount(2);
  const first = page.getByTestId("serial-result").filter({ hasText: "356789104455661" });
  await expect(first).toContainText("Sold");
  await expect(first).toContainText(`Sold on ${sale.number}`);
  await expect(page.getByTestId("serial-result").filter({ hasText: "356789104455662" })).toContainText("In stock");
});
