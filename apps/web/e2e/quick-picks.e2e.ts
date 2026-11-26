import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// Review, 26 Nov: the saved and recent items were a grid of up to 12 tiles that pushed the sale down the screen.
// They are now one row that opens into a short list, and the phone remembers whether it was left open.

test.use({ viewport: { width: 360, height: 780 } });

test("saved and recent items open as a short list, add an item, and stay open next time", async ({ page, request }) => {
  const { email } = await shop(request);
  await signIn(page, email);
  await page.goto("/app/sales/new");

  const toggle = page.getByTestId("quick-picks-toggle");
  await expect(toggle).toHaveText(/^Saved and recent items \(\d+\)$/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const list = page.getByRole("list", { name: "Quick picks" });
  await expect(list).toHaveCount(0);
  // Closed, the payment choices are close to the top, not below a wall of tiles.
  const paidWith = await page.getByText("Paid with", { exact: true }).boundingBox();
  expect(paidWith?.y ?? 9999).toBeLessThan(780);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await list.getByRole("button", { name: /^Rice 50kg/ }).click();
  await expect(page.getByTestId("sale-total")).toHaveText("₦75,000.00");

  // Typing a name still shows the search results instead of the list.
  await page.getByLabel("Find a product").fill("rice");
  await expect(toggle).toHaveCount(0);
  await page.getByLabel("Find a product").fill("");

  await page.reload();
  await expect(page.getByTestId("quick-picks-toggle")).toHaveAttribute("aria-expanded", "true");
  await page.getByTestId("quick-picks-toggle").click();
  await page.reload();
  await expect(page.getByTestId("quick-picks-toggle")).toHaveAttribute("aria-expanded", "false");
});
