import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// The stock screens on a 360 px phone (inventory phase 6, item 6).

test.use({ viewport: { width: 360, height: 780 } });

test("stock screens fit a small phone, with the main action and the search near the top", async ({ page, request }) => {
  const { email, productId } = await shop(request);
  await signIn(page, email);
  await page.goto("/app/stock");
  // The actions stay on one line that scrolls sideways; Add item comes first and the search is not pushed down.
  const add = page.getByRole("link", { name: "Add item" });
  await expect(add).toBeInViewport();
  await expect(page.getByLabel("Search stock")).toBeInViewport();
  await expect(page.getByRole("link", { name: "Transfers" })).toBeVisible();

  for (const path of ["/app/stock", `/app/stock/${productId}`, "/app/stock/new", "/app/stock/counts", "/app/stock/transfers", "/app/stock/import", "/app/stock/delivery"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width, `${path} is wider than the phone`).toBeLessThanOrEqual(360);
  }
});

test("with All shops chosen, the stock list asks for a shop instead of saying there are no products", async ({ page, request }) => {
  const { email, headers } = await shop(request);
  const second = await request.post("/api/v1/branches", { headers, data: { name: "Market stall" } });
  expect(second.ok()).toBeTruthy();
  await signIn(page, email);
  await page.goto("/app/stock");
  const place = page.getByTestId("place-chip");
  if (!(await place.textContent())?.includes("All shops")) {
    await place.click();
    await page.getByRole("button", { name: /All shops/ }).click();
  }
  await expect(page.getByText("Choose a shop to see its stock")).toBeVisible();
  await expect(page.getByText("No products yet")).toHaveCount(0);
});
