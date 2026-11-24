import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// Stock work with no network (ADR-064): a new product, and a line of a count, wait on the phone and are sent later.

test.use({ viewport: { width: 360, height: 780 } });

test("a product made offline waits on the phone, and is added when the network is back", async ({ page, context, request }) => {
  test.setTimeout(180_000);
  const { email, headers } = await shop(request);
  await signIn(page, email);
  // The sale screen downloads the products to the phone first.
  await page.goto("/app/sales/new");
  await expect(page.getByTestId("say-sale")).toBeVisible();
  await page.goto("/app/stock/new");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.getByLabel("Item name").fill("Indomie chicken");
  await page.getByLabel(/^Selling price per/).pressSequentially("250");
  await page.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByTestId("product-saved-offline")).toContainText("Indomie chicken is saved on this phone.");

  await context.setOffline(false);
  await expect
    .poll(async () => {
      const found = await request.get("/api/v1/products?q=Indomie", { headers });
      return ((await found.json()).data.items as { name: string }[]).map((item) => item.name);
    }, { timeout: 60_000 })
    .toContain("Indomie chicken");
});

test("a count line made offline waits, then is counted against the stock at that time", async ({ page, context, request }) => {
  test.setTimeout(180_000);
  const { email, headers, productId } = await shop(request);
  const started = await request.post("/api/v1/inventory/counts", { headers, data: { name: "Evening count" } });
  const countId = (await started.json()).data.count.id as string;
  const product = (await (await request.get(`/api/v1/products/${productId}`, { headers })).json()).data.product as { name: string; baseUnit: string; stock: { quantity: string } };

  await signIn(page, email);
  await page.goto("/app/stock/counts");
  await page.getByRole("button", { name: /Evening count/ }).click();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.getByLabel("Find a product").fill(product.name.slice(0, 4));
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(product.name) }).first().click();
  await context.setOffline(true);
  const counted = (BigInt(product.stock.quantity) / 1000n).toString();
  await page.getByLabel("How many you counted").fill(counted);
  await page.getByRole("button", { name: "Save this count" }).click();
  await expect(page.getByTestId("count-line-waiting")).toContainText("Waiting to send");

  await context.setOffline(false);
  await expect
    .poll(async () => {
      const count = (await (await request.get(`/api/v1/inventory/counts/${countId}`, { headers })).json()).data.count as { lines?: { difference: string }[] };
      return count.lines?.map((line) => line.difference) ?? [];
    }, { timeout: 60_000 })
    .toEqual(["0"]);
});
