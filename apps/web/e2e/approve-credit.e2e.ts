import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// App review, 26 Nov: the owner sells on credit to a customer nobody has approved yet, without leaving the sale.

test.use({ viewport: { width: 360, height: 780 } });

test("the owner approves a new customer for credit inside the sale", async ({ page, request }) => {
  const { email, headers } = await shop(request);
  const created = await request.post("/api/v1/customers", { headers, data: { name: "Kelechi Ade", phone: "08039876543" } });
  expect(created.ok()).toBeTruthy();
  const customerId = (await created.json()).data.customer.id as string;

  await signIn(page, email);
  await page.goto("/app/sales/new");
  await page.getByLabel("Find a product").fill("rice");
  await page.getByRole("button", { name: /^Rice 50kg/ }).click();
  await page.getByRole("button", { name: "Owing (credit)", exact: true }).click();
  await page.getByLabel("Phone number or name").fill("Kelechi");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await page.getByRole("button", { name: "Kelechi Ade" }).click();
  await page.locator("#sale-due").fill("2099-01-31");

  // Not approved yet: the sale says so and offers the approval right here.
  const approve = page.getByTestId("sale-approve-credit");
  await expect(approve).toContainText("Kelechi Ade is not approved for credit yet.");
  await page.getByRole("button", { name: "Record sale", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Tick" })).toContainText('Tick "Approve Kelechi Ade for credit" to give credit.');

  // One tick, no comment needed.
  await approve.getByLabel("Approve Kelechi Ade for credit").check();
  await page.getByRole("button", { name: "Record sale", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/sales\/[0-9a-f-]{36}$/);

  const customer = (await (await request.get(`/api/v1/customers/${customerId}`, { headers })).json()).data.customer;
  expect(customer.credit.allowed).toBe(true);
  expect(BigInt(customer.owingMinor)).toBeGreaterThan(0n);
});
