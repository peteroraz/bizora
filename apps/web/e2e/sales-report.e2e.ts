import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// Sales by week, month and year (ADR-058).

test.use({ viewport: { width: 360, height: 780 } });

test("the owner sees this month's sales, the week, a table of days and a download", async ({ page, request }) => {
  const { email, headers } = await shop(request);
  const products = (await (await request.get("/api/v1/products", { headers })).json()).data.items as { id: string; name: string }[];
  const rice = products.find((item) => item.name === "Rice 50kg")!;
  for (const method of ["cash", "transfer"]) {
    expect((await request.post("/api/v1/sales", { headers, data: { lines: [{ productId: rice.id, quantity: "1", unit: "bag" }], payments: [{ method, amountMinor: "7500000" }] } })).ok()).toBeTruthy();
  }

  await signIn(page, email);
  await page.goto("/app/sales");
  await page.getByTestId("sales-report-link").click();
  await expect(page.getByRole("heading", { name: "Sales report" })).toBeVisible();
  await expect(page.getByTestId("report-net")).toHaveText("₦150,000.00");
  await expect(page.getByTestId("report-count")).toHaveText("2");
  await expect(page.getByTestId("report-top-items")).toContainText("Rice 50kg");

  await page.getByRole("button", { name: "Show as a table" }).click();
  await expect(page.getByTestId("report-table")).toContainText("₦150,000.00");

  await page.getByRole("tab", { name: "Week" }).click();
  await expect(page.getByTestId("report-net")).toHaveText("₦150,000.00");
  await page.getByRole("tab", { name: "Year" }).click();
  await expect(page.getByTestId("report-period")).toHaveText(String(new Date().getFullYear()));
  await expect(page.getByTestId("report-net")).toHaveText("₦150,000.00");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download as a spreadsheet (CSV)" }).click();
  expect((await download).suggestedFilename()).toMatch(/^bizora-sales-year-\d{4}-01-01\.csv$/);
});
