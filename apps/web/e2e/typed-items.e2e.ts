import { expect, test, type Page } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// What staff can sell (ADR-041): products from the list, any typed item (remembered for next time), or both.

test.use({ viewport: { width: 360, height: 780 } });

async function allowTypedItems(page: Page, option: "Both" | "Only products in my list" | "Any item, typed in") {
  await page.goto("/app/settings");
  await page.waitForLoadState("networkidle");
  await page.getByRole("tab", { name: "Setup" }).click();
  const setting = page.getByTestId("sales-items-setting");
  await setting.getByRole("radio", { name: new RegExp(`^${option}`) }).check();
  // Changing what staff can sell loads the app again.
  await Promise.all([page.waitForEvent("framenavigated"), page.getByRole("button", { name: "Save", exact: true }).click()]);
  await page.waitForLoadState("load");
  await page.getByRole("tab", { name: "Setup" }).click();
  await expect(page.getByTestId("sales-items-setting").getByRole("radio", { name: new RegExp(`^${option}`) })).toBeChecked();
}

test("typed items are sold, remembered and picked next time, also with no network", async ({ page, context, request }) => {
  const { email, headers } = await shop(request);
  await signIn(page, email);

  // A new shop can type an item straight away. Products only is a choice the owner turns on.
  await allowTypedItems(page, "Only products in my list");
  await page.goto("/app/sales/new");
  await page.getByLabel("Find a product").fill("Agege bread");
  await expect(page.getByText("No product matches that.")).toBeVisible();
  await expect(page.getByTestId("sell-typed")).toHaveCount(0);

  await allowTypedItems(page, "Both");

  // Type an item that is not in the products, with its unit and price.
  await page.goto("/app/sales/new");
  await page.getByLabel("Find a product").fill("agege bread");
  await page.getByTestId("sell-typed").click();
  await page.getByLabel("How many").fill("3");
  await page.getByLabel("Unit").selectOption("piece");
  await page.getByLabel("Price").fill("1500");
  await expect(page.getByTestId("sale-total")).toHaveText("₦4,500.00");
  await page.getByRole("button", { name: "Record sale", exact: true }).click();
  await expect(page.getByRole("heading", { name: /R-/ })).toBeVisible();
  await expect(page.getByText("Agege bread")).toBeVisible();

  // Next time it is in the list with its last price; products are still there too.
  await page.goto("/app/sales/new");
  await page.getByLabel("Find a product").fill("agege");
  await page.getByRole("button", { name: /Agege bread/ }).click();
  await expect(page.getByTestId("sale-total")).toHaveText("₦1,500.00");
  await page.getByLabel("Find a product").fill("rice");
  await page.getByRole("button", { name: /Rice 50kg/ }).click();
  await expect(page.getByTestId("sale-total")).toHaveText("₦76,500.00");
  await page.getByRole("button", { name: "Record sale", exact: true }).click();
  await expect(page.getByRole("heading", { name: /R-/ })).toBeVisible();

  // No network: a new typed item is saved on the phone and can be picked again straight away.
  await page.goto("/app/sales/new");
  await expect(page.getByTestId("say-sale")).toBeVisible();
  await context.setOffline(true);
  await page.getByLabel("Find a product").fill("Pure water");
  await page.getByTestId("sell-typed").click();
  await page.getByLabel("How many").fill("20");
  await page.getByLabel("Unit").selectOption("sachet");
  await page.getByLabel("Price").fill("50");
  await page.getByRole("button", { name: "Record sale", exact: true }).click();
  await expect(page.getByText(/saved on this phone as/)).toBeVisible();
  await page.getByLabel("Find a product").fill("pure");
  await expect(page.getByRole("button", { name: /Pure water/ })).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByText("1 change waiting to sync")).toHaveCount(0, { timeout: 20_000 });
  const saved = (await (await request.get("/api/v1/saved-items", { headers })).json()).data.items as { name: string; timesSold: number; unit: string }[];
  expect(saved).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "Agege bread", timesSold: 2 }), expect.objectContaining({ name: "Pure water", unit: "sachet", timesSold: 1 })]),
  );
  // Rice left stock once; typed items never touch stock.
  const products = (await (await request.get("/api/v1/products", { headers })).json()).data.items as { name: string; stock: { quantity: string } }[];
  expect(products.find((item) => item.name === "Rice 50kg")?.stock.quantity).toBe("9000");

  // The owner sees what was remembered and can remove one.
  await page.goto("/app/settings");
  await page.getByRole("tab", { name: "Setup" }).click();
  const list = page.getByTestId("saved-items");
  await expect(list).toContainText("Agege bread");
  await list.getByRole("button", { name: "Remove Pure water" }).click();
  await expect(list).not.toContainText("Pure water");
});

test("a spoken sale with an item not in the products is sold as a typed item when allowed", async ({ page, context, request }) => {
  const { email } = await shop(request);
  page.on("pageerror", (error) => console.log("PAGEERROR", error.message, error.stack?.split("\n").slice(0, 4).join(" | ")));
  await signIn(page, email);
  await allowTypedItems(page, "Both");
  await page.goto("/app/sales/new?voice=1");
  await expect(page.getByTestId("voice-network")).toHaveText("Online");
  await context.setOffline(true);
  await page.getByTestId("voice-type-instead").click();
  await page.getByLabel("Say the sale in words").fill("Sold two bags of beans at forty thousand naira each and one bag of rice, cash.");
  await page.getByRole("button", { name: "Read it" }).click();
  await expect(page.getByTestId("voice-line")).toHaveCount(2);
  await expect(page.getByTestId("voice-warnings")).toContainText("Beans is not in your products");
  await expect(page.getByTestId("voice-total")).toContainText("₦155,000.00");
  await page.getByTestId("voice-confirm").click();
  await expect(page.getByText(/saved on this phone as/)).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText("1 change waiting to sync")).toHaveCount(0, { timeout: 20_000 });
});
