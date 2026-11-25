import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// Just the amount (ADR-069): a sale recorded as ₦3,500 cash, with no item, on a phone.

test.use({ viewport: { width: 360, height: 780 } });

test("a kiosk records amounts only, online and offline, and the day adds up by payment", async ({ page, context, request }) => {
  const { email, headers } = await shop(request);
  await signIn(page, email);
  await page.goto("/app/sales/new");

  await page.getByTestId("just-amount").click();
  const pad = page.getByTestId("amount-sale");
  await expect(pad.getByRole("heading", { name: "Just the amount" })).toBeVisible();
  await expect(pad.getByLabel("Amount")).toBeFocused();

  // Nothing typed: it asks for the amount.
  await pad.getByRole("button", { name: "Record" }).click();
  await expect(pad.getByRole("alert")).toHaveText("Enter the amount.");

  await pad.getByLabel("Amount").fill("3500");
  await pad.getByRole("button", { name: "Record ₦3,500.00" }).click();
  await expect(pad.getByTestId("amount-recorded")).toContainText("₦3,500.00 Cash recorded.");

  // The pad stays open for the next one: a transfer with what it was for.
  await expect(pad.getByLabel("Amount")).toHaveValue("");
  await pad.getByLabel("Amount").fill("8200");
  await pad.getByRole("button", { name: "Transfer" }).click();
  await pad.getByLabel("What was it for?").fill("Bread and drinks");
  await pad.getByRole("button", { name: "Record ₦8,200.00" }).click();
  await expect(pad.getByTestId("amount-recorded")).toContainText("₦8,200.00 Transfer recorded.");

  // No network: kept on the phone, sent when it comes back.
  await context.setOffline(true);
  await pad.getByLabel("Amount").fill("1800");
  await pad.getByRole("button", { name: "Record ₦1,800.00" }).click();
  await expect(pad.getByTestId("amount-recorded")).toContainText("saved on this phone");
  await context.setOffline(false);
  await expect
    .poll(async () => (await (await request.get("/api/v1/sales/summary", { headers })).json()).data.count, { timeout: 20_000 })
    .toBe(3);
  const day = (await (await request.get("/api/v1/sales/summary", { headers })).json()).data;
  expect(day.totalMinor).toBe("1350000");
  expect(day.byMethod).toMatchObject({ cash: "530000", transfer: "820000" });

  // Back to items returns to the normal sale screen.
  await pad.getByRole("button", { name: "Back to items" }).click();
  await expect(page.getByTestId("just-amount")).toBeVisible();
});

test("the owner can switch it off, and the button goes away", async ({ page, request }) => {
  const { email } = await shop(request);
  await signIn(page, email);
  await page.goto("/app/settings");
  await page.waitForLoadState("networkidle");
  await page.getByRole("tab", { name: "Setup" }).click();
  const setting = page.getByTestId("amount-sales-setting");
  await expect(setting).toBeChecked();
  await setting.uncheck();
  // Changing it loads the app again, so the sale screen follows.
  await Promise.all([page.waitForEvent("framenavigated"), page.getByRole("button", { name: "Save", exact: true }).click()]);
  await page.waitForLoadState("load");
  await page.goto("/app/sales/new");
  await expect(page.getByRole("heading", { name: "New sale" })).toBeVisible();
  await expect(page.getByTestId("just-amount")).toHaveCount(0);
});
