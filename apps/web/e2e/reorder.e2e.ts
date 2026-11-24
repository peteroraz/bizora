import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// Reorder rules and the To buy list (ADR-063).

test.use({ viewport: { width: 360, height: 780 } });

test("the owner sets when to buy more cement, then sees how much to buy and from whom", async ({ page, request }) => {
  const { email, headers } = await shop(request);
  const created = await request.post("/api/v1/products", { headers, data: { name: "Dangote cement", baseUnit: "bag", priceMinor: "1100000", openingQuantity: "3", openingCostMinor: "2850000" } });
  const productId = (await created.json()).data.product.id as string;
  await request.post("/api/v1/stock/receive", { headers, data: { productId, quantity: "5", unit: "bag", paidFrom: "credit", supplier: "Dangote depot", totalCostMinor: "4750000" } });

  await signIn(page, email);
  await page.goto(`/app/stock/${productId}`);
  const rules = page.getByTestId("reorder-rules");
  await rules.getByLabel("Reorder point (bags)").fill("10");
  await rules.getByLabel("Fill up to (bags)").fill("40");
  await rules.getByLabel("Usual supplier").selectOption({ label: "Dangote depot" });
  await rules.getByLabel("Days the supplier takes").fill("3");
  await rules.getByRole("button", { name: "Save" }).click();
  await expect(rules.getByText("Saved.")).toBeVisible();

  await page.goto("/app/stock");
  await page.getByRole("link", { name: "To buy" }).click();
  const group = page.getByTestId("to-buy-group").filter({ hasText: "Dangote depot" });
  await expect(group).toContainText("About ₦304,000.00 at the last prices");
  await expect(group.getByTestId("to-buy-row")).toContainText("Buy 32 bags");
  await expect(group.getByTestId("to-buy-row")).toContainText("8 bags left · reorder at 10 bags · usually 3 days");
});
