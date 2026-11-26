import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// Hold a sale (ADR-070): "Let me get cash from the ATM". The cart waits on the phone; nothing reaches the server.

test.use({ viewport: { width: 360, height: 780 } });

test("a cashier holds a sale, serves the next customer, then resumes and records it", async ({ page, request }) => {
  const { email, headers } = await shop(request);
  await signIn(page, email);
  await page.goto("/app/sales/new");

  // First customer: two bags of rice, then goes to the ATM.
  await page.getByLabel("Find a product").fill("rice");
  await page.getByRole("button", { name: /^Rice 50kg/ }).click();
  await page.getByRole("button", { name: /^Rice 50kg/ }).click();
  await expect(page.getByTestId("sale-total")).toHaveText("₦150,000.00");
  await page.getByTestId("hold-sale").click();
  const holdPanel = page.getByTestId("hold-panel");
  await holdPanel.getByLabel("Who is it for?").fill("Man in blue cap");
  await holdPanel.getByRole("button", { name: "Hold" }).click();
  await expect(page.getByTestId("held-note")).toHaveText("Man in blue cap is held. Serve the next customer.");
  await expect(page.getByTestId("sale-total")).toHaveText("₦0.00");

  // Nothing was recorded: no sale, no stock taken.
  const before = (await (await request.get("/api/v1/sales/summary", { headers })).json()).data;
  expect(before.count).toBe(0);

  // Held sales survive the app closing.
  await page.reload();
  await expect(page.getByTestId("held-open")).toHaveText("Held sales (1)");

  // Next customer, one bag, recorded straight away.
  await page.getByLabel("Find a product").fill("rice");
  await page.getByRole("button", { name: /^Rice 50kg/ }).click();
  // While a sale is on screen, a held one cannot be resumed over it.
  await page.getByTestId("held-open").click();
  await expect(page.getByTestId("held-list").getByRole("button", { name: "Resume" })).toBeDisabled();
  await page.getByTestId("held-list").getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Record sale", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/sales\/[0-9a-f-]{36}$/);

  // The first customer is back: resume, everything is as it was, and record it.
  await page.goto("/app/sales/new");
  await page.getByTestId("held-open").click();
  const list = page.getByTestId("held-list");
  await expect(list.getByTestId("held-sale")).toContainText("Man in blue cap");
  await expect(list.getByTestId("held-sale")).toContainText("1 item · ₦150,000.00");
  await list.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByTestId("resumed-note")).toContainText("Man in blue cap");
  await expect(page.getByTestId("sale-total")).toHaveText("₦150,000.00");
  await page.getByRole("button", { name: "Record sale", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/sales\/[0-9a-f-]{36}$/);

  const after = (await (await request.get("/api/v1/sales/summary", { headers })).json()).data;
  expect(after.count).toBe(2);
  expect(after.totalMinor).toBe("22500000");

  // Recorded, so it is no longer held.
  await page.goto("/app/sales/new");
  await expect(page.getByTestId("sale-total")).toHaveText("₦0.00");
  await expect(page.getByTestId("held-open")).toHaveCount(0);
});

test("a held sale can be deleted, with a second tap to make sure", async ({ page, request }) => {
  const { email } = await shop(request);
  await signIn(page, email);
  await page.goto("/app/sales/new");
  await page.getByLabel("Find a product").fill("rice");
  await page.getByRole("button", { name: /^Rice 50kg/ }).click();
  await page.getByTestId("hold-sale").click();
  await page.getByTestId("hold-panel").getByRole("button", { name: "Hold" }).click();
  await expect(page.getByTestId("held-note")).toHaveText("Customer is held. Serve the next customer.");

  await page.getByTestId("held-open").click();
  const list = page.getByTestId("held-list");
  await list.getByRole("button", { name: "Delete" }).click();
  await expect(list.getByTestId("held-sale")).toHaveCount(1);
  await list.getByRole("button", { name: "Yes, delete" }).click();
  await expect(list.getByTestId("held-sale")).toHaveCount(0);
  await expect(list).toContainText("Nothing is held.");
});
