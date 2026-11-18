import { expect, test } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test.use({ viewport: { width: 360, height: 780 } });

test("receipts and statements open at the business's own link, old links move there, and shares show the business", async ({ page, request }) => {
  test.setTimeout(120_000);
  const suffix = `${Date.now()}`;
  const email = `links.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { email, password, displayName: "Ama Owner", organizationName: `Ama Studio ${suffix}`, countryCode: "GH", baseCurrencyCode: "GHS", timezone: "Africa/Accra" },
  });
  const headers = { authorization: `Bearer ${(await registered.json()).data.accessToken}` };
  expect((await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "GH", industryCode: "general-retail", baseCurrencyCode: "GHS", timezone: "Africa/Accra", businessName: "Ama Studio", branchName: "Osu" } })).ok()).toBeTruthy();
  const product = await request.post("/api/v1/products", { headers, data: { name: "Hair cream", baseUnit: "piece", priceMinor: "4500", openingQuantity: "20", openingCostMinor: "60000" } });
  const sale = await request.post("/api/v1/sales", { headers, data: { lines: [{ productId: (await product.json()).data.product.id, quantity: "1", unit: "piece" }], payments: [{ method: "cash", amountMinor: "4500" }] } });
  const created = (await sale.json()).data.sale;

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);

  // The owner chooses the link name and a line about the business.
  const handle = `ama-${suffix.slice(-6)}`;
  await page.goto("/app/settings?tab=brand");
  await page.getByLabel("Link name").fill("app");
  await expect(page.getByText("That name is kept for Bizora. Try another.")).toBeVisible();
  await page.getByLabel("Link name").fill(handle);
  await expect(page.getByText("This name is free.")).toBeVisible();
  await page.getByLabel("About your business").fill("Braids, wigs and hair care in Osu.");
  await page.getByRole("button", { name: "Save link" }).click();
  await expect(page.getByText("Saved. New links use this name.")).toBeVisible();

  // The receipt link now carries the name, and the page names the business.
  const detail = (await (await request.get(`/api/v1/sales/${created.id}`, { headers })).json()).data.sale;
  expect(detail.receiptPath).toMatch(new RegExp(`^/${handle}/r/`));
  const token = detail.receiptPath.split("/").pop();
  const customer = await page.context().browser()!.newContext({ viewport: { width: 360, height: 780 } });
  const receipt = await customer.newPage();
  await receipt.goto(`/r/${token}`);
  await expect(receipt).toHaveURL(new RegExp(`/${handle}/r/${token}$`));
  await expect(receipt.getByRole("heading", { name: /Ama Studio/ })).toBeVisible();
  expect(await receipt.title()).toContain("from Ama Studio");
  // A wrong name in the address moves to the right one.
  await receipt.goto(`/someone-else/r/${token}`);
  await expect(receipt).toHaveURL(new RegExp(`/${handle}/r/${token}$`));

  // The business page and the picture WhatsApp shows when the link is shared.
  await receipt.getByRole("link", { name: /Ama Studio/ }).click();
  await expect(receipt).toHaveURL(new RegExp(`/${handle}$`));
  await expect(receipt.getByTestId("business-profile")).toContainText("Braids, wigs and hair care in Osu.");
  const card = await request.get(`/${handle}/opengraph-image`);
  expect(card.headers()["content-type"]).toContain("image/png");
  const ogImage = await receipt.locator('meta[property="og:image"]').first().getAttribute("content");
  expect(ogImage).toContain(`/${handle}/opengraph-image`);
  await receipt.goto("/no-such-business-here");
  await expect(receipt.getByText(/404|could not be found|not found/i).first()).toBeVisible();
});
