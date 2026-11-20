import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// Offline voice sales (ADR-040). The words are read on the phone with no network, the trader checks them, and the
// sale waits on the phone until it syncs once.

const brief = "I sold five bags of rice at seventy-five thousand naira each to Emeka. He paid three hundred thousand and will balance seventy-five thousand.";

test.use({ viewport: { width: 360, height: 780 } });

test("a sale said in words with no network is checked, waits on the phone, and syncs once", async ({ page, context, request }) => {
  const { email, headers, productId, customerId } = await shop(request);
  await signIn(page, email);

  // Online once: the product list and customer names are saved on the phone, and the offline pages are ready.
  await page.goto("/app/sales/new");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.getByTestId("say-sale").click();
  await expect(page.getByTestId("voice-network")).toHaveText("Online");
  await page.getByRole("button", { name: "Close" }).click();
  // The sales list opens offline too; visit it once so it is ready.
  await page.goto("/app/sales");
  await page.goto("/app/sales/new?voice=1");
  await expect(page.getByTestId("voice-sale")).toBeVisible();

  // The network drops. No speech is sent anywhere.
  await context.setOffline(true);
  await expect(page.getByTestId("voice-network")).toHaveText("Offline");
  await page.getByTestId("voice-type-instead").click();
  await page.getByLabel("Say the sale in words").fill(brief);
  await page.getByRole("button", { name: "Read it" }).click();

  // The review shows what was understood; nothing is saved yet.
  const review = page.getByTestId("voice-review");
  await expect(review).toBeVisible();
  await expect(page.getByTestId("voice-line")).toHaveCount(1);
  await expect(page.getByTestId("voice-line").getByLabel("Product")).toHaveValue(productId);
  await expect(page.getByTestId("voice-customer")).toHaveValue(customerId);
  await expect(page.getByTestId("voice-total")).toContainText("₦375,000.00");
  await expect(page.getByTestId("voice-balance")).toContainText("₦75,000.00");
  // Money is still owed, so the date and a note are needed first.
  await expect(page.getByTestId("voice-confirm")).toBeDisabled();
  await page.getByLabel("Pay the rest by").fill("2099-01-31");
  await page.getByLabel("Why, and how they will pay").fill("Will balance on Friday");
  await page.getByTestId("voice-confirm").click();

  await expect(page.getByText(/saved on this phone as/)).toBeVisible();
  await expect(page.getByText("1 change waiting to sync")).toBeVisible();

  // Still offline: the sales list shows the sale as waiting, not as a finished sale, even after a reload.
  await page.goto("/app/sales");
  const waiting = page.getByTestId("waiting-sales");
  await expect(waiting).toContainText("Rice 50kg");
  await expect(waiting).toContainText("Emeka Obi");
  await expect(waiting).toContainText("by voice");
  await expect(waiting).toContainText("Waiting to sync");
  await page.reload();
  await expect(page.getByTestId("waiting-sales")).toContainText("₦375,000.00");

  // The network comes back: the sale is sent once and leaves the waiting list.
  await context.setOffline(false);
  await expect(page.getByTestId("waiting-sales")).toHaveCount(0, { timeout: 20_000 });

  const debtor = await request.get(`/api/v1/debtors/${customerId}`, { headers });
  expect((await debtor.json()).data.account.owingMinor).toBe("7500000");
  const product = await request.get(`/api/v1/products/${productId}`, { headers });
  expect((await product.json()).data.product.stock.quantity).toBe("5000");
});

test("nothing is saved from the words until the trader confirms", async ({ page, context, request }) => {
  const { email, headers } = await shop(request);
  await signIn(page, email);
  await page.goto("/app/sales/new?voice=1");
  await expect(page.getByTestId("voice-network")).toHaveText("Online");
  await context.setOffline(true);
  await page.getByTestId("voice-type-instead").click();
  await page.getByLabel("Say the sale in words").fill("Sold two bags of rice, cash.");
  await page.getByRole("button", { name: "Read it" }).click();
  await expect(page.getByTestId("voice-review")).toBeVisible();
  // Fix a misheard word, read again, then cancel.
  await page.getByTestId("voice-transcript").fill("Sold three bags of rice, cash.");
  await page.getByRole("button", { name: "Read again" }).click();
  await expect(page.getByTestId("voice-line").getByLabel("Quantity")).toHaveValue("3");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("1 change waiting to sync")).toHaveCount(0);
  await context.setOffline(false);
  const sales = await request.get("/api/v1/sales", { headers });
  expect((await sales.json()).data.items).toEqual([]);
});
