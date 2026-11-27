import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

function lagosToday() {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).split("-");
  return `${day}/${month}/${year}`;
}

// ADR-074: scanned or imported sales of items that are not in your products add them as products or services.

test("imported sales add new items as a product and a service, at their latest price", async ({ page, request }) => {
  const { email, headers } = await shop(request);
  await signIn(page, email);
  await page.goto("/app/sales/import");
  await page.locator('input[accept=".csv,text/csv"]').setInputFiles({
    name: "sales.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      `Date,Item,Qty,Rate,Paid by,Receipt No\n${lagosToday()},DDR4 Laptop RAM,1,60000,cash,0681\n${lagosToday()},HP ProBook laptop Motherboard repair,1,57800,transfer,0683\n${lagosToday()},DDR4 Laptop RAM,1,65000,cash,0682\n`,
    ),
  });
  await page.getByRole("button", { name: "Check rows" }).click();
  await expect(page.getByText("All rows look right: 3 new, 0 updates.")).toBeVisible();

  const box = page.getByTestId("import-new-items");
  await expect(box).toContainText("2 items are not in your products");
  const ram = box.getByTestId("import-new-item").filter({ hasText: "DDR4 Laptop RAM" });
  await expect(ram).toContainText("Last sold at ₦65,000.00 per piece · rows 1, 3");
  await expect(page.getByLabel("How to add DDR4 Laptop RAM")).toHaveValue("product");
  await expect(page.getByLabel("How to add HP ProBook laptop Motherboard repair")).toHaveValue("service");

  await page.getByRole("button", { name: "Save 3 rows" }).click();
  await expect(page.getByText("Saved: 3 new, 0 updated.")).toBeVisible();

  const found = (await (await request.get("/api/v1/products?q=ddr4", { headers })).json()).data.items[0];
  expect(found).toMatchObject({ name: "DDR4 Laptop RAM", priceMinor: "6500000", trackStock: false });
  const repair = (await (await request.get("/api/v1/products?q=motherboard", { headers })).json()).data.items[0];
  expect(repair).toMatchObject({ priceMinor: "5780000", trackStock: false });
});
