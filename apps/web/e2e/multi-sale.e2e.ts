import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// Several sales in one go (ADR-057): typed in the search box, read as sales, each checked and confirmed on its own.

test.use({ viewport: { width: 360, height: 780 } });

test("three sales typed in one go: two confirmed and saved, one left out", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { email, headers } = await shop(request);
  await signIn(page, email);
  await page.goto("/app/sales/new");

  await page
    .getByLabel("Find a product")
    .fill("3 cups of ogiri 5,500 for all, cash. Next customer: 2 bags of rice 75k each, cash. Next customer: 4 pieces of agege bread 500 each, cash");
  // A whole sale is never offered as one item's name.
  await expect(page.getByTestId("sell-typed")).toHaveCount(0);
  await page.getByTestId("read-as-sale").click();

  await expect(page.getByTestId("voice-sale-of")).toHaveText("Sale 1 of 3");
  await expect(page.getByTestId("voice-total")).toContainText("₦5,500.00");
  await page.getByTestId("voice-confirm").click();

  await expect(page.getByTestId("saved-next")).toBeVisible();
  await expect(page.getByTestId("voice-sale-of")).toHaveText("Sale 2 of 3");
  await expect(page.getByTestId("voice-total")).toContainText("₦150,000.00");
  await page.getByTestId("voice-skip").click();

  await expect(page.getByTestId("voice-sale-of")).toHaveText("Sale 3 of 3");
  await expect(page.getByTestId("voice-total")).toContainText("₦2,000.00");
  await expect(page.getByTestId("voice-skip")).toHaveCount(0);
  await page.getByTestId("voice-confirm").click();
  // The last sale of the go opens its receipt as usual.
  await expect(page).toHaveURL(/\/app\/sales\/[0-9a-f-]{36}$/);

  const today = (await (await request.get("/api/v1/sales", { headers })).json()).data.items as { totalMinor: string }[];
  expect(today.map((sale) => sale.totalMinor).sort()).toEqual(["200000", "550000"]);
  // Rice was left out, so no rice left the shelf.
  const products = (await (await request.get("/api/v1/products", { headers })).json()).data.items as { name: string; stock: { quantity: string } }[];
  expect(products.find((item) => item.name === "Rice 50kg")?.stock.quantity).toBe("10000");
});
