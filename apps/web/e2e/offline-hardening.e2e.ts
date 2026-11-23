import { expect, test, type Page } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// Offline hardening for the pilot (ADR-044): nothing saved on the phone is lost, sent twice, or moved to another shop.

test.use({ viewport: { width: 360, height: 780 } });

async function sellOffline(page: Page, context: import("@playwright/test").BrowserContext, tins = "1") {
  await page.goto("/app/sales/new");
  await expect(page.getByTestId("say-sale")).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.getByLabel("Find a product").fill("rice");
  await page.getByRole("button", { name: /Rice 50kg/ }).click();
  await page.getByLabel("How many").fill(tins);
  await page.getByRole("button", { name: "Record sale", exact: true }).click();
  await expect(page.getByText(/saved on this phone as/)).toBeVisible();
}

test("a sync that fails is shown, kept, and sent once when tried again", async ({ page, context, request }) => {
  test.setTimeout(240_000);
  const { email, headers, productId } = await shop(request);
  await signIn(page, email);
  await sellOffline(page, context);

  // The network comes back but the server cannot be reached (dropped mid-sync, or down): nothing is lost.
  let blocked = true;
  await page.route("**/api/v1/sync/push", async (route) => (blocked ? route.abort("connectionreset") : route.continue()));
  await context.setOffline(false);
  await expect(page.getByTestId("sync-now")).toContainText("Last try failed", { timeout: 20_000 });
  // A refresh, and even closing the tab, keeps it waiting.
  await page.reload();
  await expect(page.getByTestId("sync-now")).toBeVisible();
  const second = await context.newPage();
  await page.close();
  await second.goto("/app");
  await expect(second.getByTestId("sync-now")).toBeVisible();

  // Tapping tries at once; it is sent once even when two tabs try together.
  blocked = false;
  await second.route("**/api/v1/sync/push", (route) => route.continue());
  const third = await context.newPage();
  await third.goto("/app");
  // Either tab may send it first (on opening, or on the tap); the tap may find it already gone.
  await Promise.all([second.getByTestId("sync-now").click({ timeout: 3000 }).catch(() => undefined), third.getByTestId("sync-now").click({ timeout: 3000 }).catch(() => undefined)]);
  // Both tabs show it synced, whichever one sent it.
  await expect(third.getByTestId("sync-now")).toHaveCount(0, { timeout: 20_000 });
  await expect(second.getByTestId("sync-now")).toHaveCount(0, { timeout: 20_000 });
  const sales = (await (await request.get("/api/v1/sales", { headers })).json()).data.items as unknown[];
  expect(sales).toHaveLength(1);
  const rice = (await (await request.get(`/api/v1/products/${productId}`, { headers })).json()).data.product;
  expect(rice.stock.quantity).toBe("9000");
});

test("a sale the server refuses is named on screen, not dropped, while others sync", async ({ page, context, request }) => {
  const { email, headers, customerId } = await shop(request);
  await signIn(page, email);
  await page.goto("/app/sales/new");
  await expect(page.getByTestId("say-sale")).toBeVisible();
  // Online once, the customer names are saved on the phone.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const db: IDBDatabase = await new Promise((resolve, reject) => {
          const opened = indexedDB.open("bizora-offline");
          opened.onsuccess = () => resolve(opened.result);
          opened.onerror = () => reject(opened.error);
        });
        const keys: IDBValidKey[] = await new Promise((resolve) => {
          const all = db.transaction("cache").objectStore("cache").getAllKeys();
          all.onsuccess = () => resolve(all.result);
        });
        db.close();
        return keys.some((key) => String(key).startsWith("customers:"));
      }),
    )
    .toBe(true);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // Opened again now the offline helper is running, as on any later visit, so every part is kept on the phone.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await context.setOffline(true);
  // On credit to Emeka, then a plain cash sale.
  await page.getByLabel("Find a product").fill("rice");
  await page.getByRole("button", { name: /Rice 50kg/ }).click();
  await page.getByRole("button", { name: "Owing (credit)", exact: true }).click();
  // No network: the search uses the customer names saved on this phone.
  await page.getByLabel("Phone number or name").fill("Emeka");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.getByText("No network: showing customers saved on this phone.")).toBeVisible();
  await page.getByRole("button", { name: "Emeka Obi" }).click();
  await page.locator("#sale-due").fill("2099-01-31");
  await page.locator("#sale-credit-comment").fill("Balance on Friday");
  await page.getByRole("button", { name: "Record sale", exact: true }).click();
  await expect(page.getByText(/saved on this phone as/)).toBeVisible();
  await page.getByLabel("Find a product").fill("rice");
  await page.getByRole("button", { name: /Rice 50kg/ }).click();
  await page.getByRole("button", { name: "Record sale", exact: true }).click();
  // Meanwhile the owner stops credit for Emeka on another phone.
  await request.patch(`/api/v1/customers/${customerId}/credit`, { headers, data: { creditAllowed: false, reason: "Owes too much" } });
  await context.setOffline(false);
  await expect(page.getByText(/could not be saved/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("alert").filter({ hasText: /could not be saved/ })).toContainText("Rice 50kg");
  const sales = (await (await request.get("/api/v1/sales", { headers })).json()).data.items as unknown[];
  expect(sales).toHaveLength(1);
});

test("a sale saved offline stays in its shop even if the owner switches shop before it syncs", async ({ page, context, request }) => {
  const { email, headers } = await shop(request);
  const businesses = (await (await request.get("/api/v1/businesses", { headers })).json()).data;
  const businessId = (businesses.businesses ?? businesses.items ?? businesses)[0].id as string;
  const market = (await (await request.post("/api/v1/branches", { headers, data: { name: "Market Stall", businessId } })).json()).data.branch.id as string;
  await signIn(page, email);
  // With two shops the owner starts in "All shops"; sell from Main.
  await page.getByTestId("place-chip").click();
  await Promise.all([page.waitForEvent("framenavigated"), page.getByRole("combobox").last().selectOption({ label: "Main" })]);
  await page.waitForLoadState("load");
  await page.route("**/api/v1/sync/push", (route) => route.abort("connectionreset"));
  await sellOffline(page, context);
  await context.setOffline(false);
  // Switch to the market stall while the sale still waits.
  await page.goto("/app");
  await page.getByTestId("place-chip").click();
  await Promise.all([page.waitForEvent("framenavigated"), page.getByRole("combobox").last().selectOption(market)]);
  await page.waitForLoadState("load");
  await page.unroute("**/api/v1/sync/push");
  await page.getByTestId("sync-now").click({ timeout: 3000 }).catch(() => undefined);
  await expect(page.getByTestId("sync-now")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByText(/could not be saved/)).toHaveCount(0);
  let sales: { id: string }[] = [];
  await expect
    .poll(async () => {
      sales = (await (await request.get("/api/v1/sales", { headers })).json()).data.items as { id: string }[];
      return sales.length;
    })
    .toBe(1);
  const sale = (await (await request.get(`/api/v1/sales/${sales[0]!.id}`, { headers })).json()).data.sale as { branchName: string };
  expect(sale.branchName).toBe("Main");
});
