import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// ADR-047: stock sent to a warehouse is on the way until received there; a count changes stock only when approved.

test.use({ viewport: { width: 360, height: 780 } });

test("send stock to a warehouse, receive less than sent, and count with approval", async ({ page, request }) => {
  const { email, headers, productId } = await shop(request);
  const warehouse = await request.post("/api/v1/branches", { headers, data: { name: "Back store", kind: "warehouse" } });
  expect(warehouse.ok()).toBeTruthy();
  await signIn(page, email);

  // Main has 10 bags of rice: send 4 to the back store.
  // With two places the owner starts in "All shops", so the transfer says where it leaves from.
  await page.goto("/app/stock/transfers");
  await page.getByLabel("From", { exact: true }).selectOption({ label: "Main" });
  await page.getByLabel("To", { exact: true }).selectOption({ label: "Back store" });
  await page.getByLabel("Find a product").fill("Rice");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await page.getByRole("button", { name: /Rice 50kg/ }).click();
  await page.getByLabel("Quantity").fill("4");
  await page.getByRole("button", { name: "Make transfer" }).click();
  await expect(page.getByText("Transfer made.")).toBeVisible();
  const card = page.locator("[data-testid^='transfer-TR-']").first();
  await expect(card).toContainText("On the way");

  // On the way: gone from Main, not yet in the back store.
  await page.goto(`/app/stock/${productId}`);
  await expect(page.getByText("4 bags on the way here")).toBeVisible();
  await expect(page.getByText("6 bags").first()).toBeVisible();

  // Three arrive.
  await page.goto("/app/stock/transfers");
  await card.getByLabel(/How many arrived/).fill("3");
  await card.getByRole("button", { name: "Receive" }).click();
  await expect(page.getByText("Received. The stock is now here.")).toBeVisible();
  await expect(card).toContainText("3 bags arrived");

  // A count of Main: 5 bags counted against 6 expected, approved by the owner.
  await page.goto("/app/stock/counts");
  await page.getByLabel("Where are you counting?").selectOption({ label: "Main" });
  await page.getByLabel("Name this count").fill("Friday count");
  await page.getByRole("button", { name: "Start counting" }).click();
  await page.getByLabel("Find a product").fill("Rice");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await page.getByRole("button", { name: /Rice 50kg/ }).click();
  await page.getByLabel("How many you counted").fill("5");
  await page.getByLabel("If it is different, why?").selectOption("missing");
  await page.getByRole("button", { name: "Save this count" }).click();
  await expect(page.getByTestId("count-lines")).toContainText("1 bag short");
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByText("Waiting for approval").first()).toBeVisible();
  await page.getByRole("button", { name: "Approve and update stock" }).click();
  await expect(page.getByText("Approved. Stock is updated.")).toBeVisible();

  await page.goto(`/app/stock/${productId}`);
  await expect(page.getByText("5 bags").first()).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(360);
});
