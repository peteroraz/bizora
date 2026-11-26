import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

test.use({ serviceWorkers: "block", viewport: { width: 360, height: 780 } });

// The sale screen fetches some parts after it opens. If the network goes before the item lines arrive and a product
// is tapped, the screen waits for them instead of crashing with "Application error". Service workers are blocked so
// the part cannot come from the phone's copy.
test("a part that could not load yet waits instead of crashing the screen", async ({ page, request }) => {
  const { email } = await shop(request);
  await signIn(page, email);
  let released = false;
  await page.route("**/_next/static/chunks/**", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    // The item lines part (the only one using this text): held back as if the network went before it arrived.
    if (body.includes('"changePrice"') && !released) {
      return route.abort("internetdisconnected");
    }
    return route.fulfill({ response, body });
  });
  await page.goto("/app/sales/new");
  await expect(page.getByTestId("say-sale")).toBeVisible();
  await page.getByLabel("Find a product").fill("rice");
  await page.getByRole("button", { name: /Rice 50kg/ }).click();
  await expect(page.getByText("Loading")).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByText(/Application error/)).toHaveCount(0);
  // The network is back: the part arrives and the sale carries on with the item tapped.
  released = true;
  await expect(page.getByLabel("How many")).toBeVisible({ timeout: 15_000 });
});
