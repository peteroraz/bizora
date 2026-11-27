import { expect, test } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test.use({ viewport: { width: 360, height: 780 } });

function lagosToday() {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).split("-");
  return `${day}/${month}/${year}`;
}

test("records a sale, shares the receipt, sells with no network, and imports products and sales", async ({ page, context, request, browser }) => {
  test.setTimeout(180_000);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `sales.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { acceptTerms: true, email, password, displayName: "Ada Owner", organizationName: `Ada Stores ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  expect(registered.ok()).toBeTruthy();
  const token = (await registered.json()).data.accessToken as string;
  const headers = { authorization: `Bearer ${token}` };
  expect((await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ada Stores", branchName: "Main" } })).ok()).toBeTruthy();
  const product = await request.post("/api/v1/products", {
    headers,
    data: { name: "Peak Milk", baseUnit: "tin", priceMinor: "45000", packs: [{ unitCode: "carton", baseQuantity: "48", priceMinor: "2000000" }], openingQuantity: "96", openingCostMinor: "3360000" },
  });
  expect(product.ok()).toBeTruthy();

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText("No sales yet today.")).toBeVisible();

  // A quick sale: two tins, paid in cash.
  await page.goto("/app/sales/new");
  await page.getByLabel("Find a product").fill("peak");
  await page.getByRole("button", { name: /Peak Milk/ }).click();
  // Tapping + adds one more; the cash given shows the change.
  await page.getByRole("button", { name: "One more Peak Milk" }).click();
  await expect(page.getByTestId("sale-total")).toHaveText("₦900.00");
  await page.getByLabel("Cash given").fill("1000");
  await expect(page.getByTestId("sale-change")).toHaveText("Change: ₦100.00");
  await page.getByRole("button", { name: "Record sale", exact: true }).click();
  await expect(page.getByRole("heading", { name: "R-000001" })).toBeVisible();
  await expect(page.getByTestId("next-sale")).toBeVisible();
  await page.getByText("More ways to share").click();
  await expect(page.getByRole("link", { name: "Share receipt on WhatsApp" })).toHaveAttribute("href", /^https:\/\/wa\.me\/\?text=.*%2Fr%2F/);

  // Anyone with the link sees the receipt, without signing in.
  const receiptPath = await page.getByRole("link", { name: "See what the customer sees" }).getAttribute("href");
  const stranger = await browser.newContext();
  const receipt = await stranger.newPage();
  await receipt.goto(receiptPath ?? "/r/missing");
  await expect(receipt.getByRole("heading", { name: "Ada Stores" })).toBeVisible();
  await expect(receipt.getByText("Receipt R-000001")).toBeVisible();
  const pdfLink = await receipt.getByRole("link", { name: "Download receipt (PDF)" }).getAttribute("href");
  const pdf = await request.get(pdfLink ?? "/missing");
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  await stranger.close();

  // Home shows today's sales.
  await page.goto("/app");
  await expect(page.getByTestId("home-sales-total")).toHaveText("₦900.00");

  // The sale screen opens with no network once it has been used, and sales are kept on the phone until they sync.
  await page.goto("/app/sales/new");
  await page.waitForFunction(async () => Boolean(navigator.serviceWorker?.controller));
  await page.goto("/app/sales/new");
  await page.waitForFunction(async () => {
    const names = await caches.keys();
    for (const name of names.filter((key) => key.startsWith("bizora-pages-"))) {
      if (await (await caches.open(name)).match("/app/sales/new")) return true;
    }
    return false;
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "New sale" })).toBeVisible();
  await page.getByLabel("Find a product").fill("peak");
  await page.getByRole("button", { name: /Peak Milk/ }).click();
  await page.getByRole("button", { name: "Transfer" }).click();
  await page.getByRole("button", { name: "Record sale", exact: true }).click();
  await expect(page.getByText(/saved on this phone as DEV\d+-\d{6}/)).toBeVisible();
  await context.setOffline(false);
  await expect
    .poll(async () => (await (await request.get("/api/v1/sales", { headers })).json()).data.total, { timeout: 60_000 })
    .toBe(2);

  // Import products and opening stock from a CSV file, checking every row first.
  await page.goto("/app/stock/import");
  await page.locator('input[accept=".csv,text/csv"]').setInputFiles({
    name: "products.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Item Name,Selling Price,Cost Price,Qty,UOM\nGolden Penny Semovita,\"4,500\",3800,20,bag\nPeak Milk,470,,,\n"),
  });
  await expect(page.getByText("products.csv: 2 rows read.")).toBeVisible();
  await page.getByRole("button", { name: "Check rows" }).click();
  await expect(page.getByText("All rows look right: 1 new, 1 updates.")).toBeVisible();
  await page.getByRole("button", { name: "Save 2 rows" }).click();
  await expect(page.getByText("Saved: 1 new, 1 updated.")).toBeVisible();

  // Import sales: a row with a mistake is fixed in the table before anything is saved.
  await page.goto("/app/sales/import");
  await page.locator('input[accept=".csv,text/csv"]').setInputFiles({
    name: "sales.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`Date,Item,Qty,Rate,Paid by,Receipt No\n${lagosToday()},Semovita,1,4500,cash,B7\n01/11/2026,Old stock item,3,1000,cash,OLD-1\n`),
  });
  await page.getByRole("button", { name: "Check rows" }).click();
  // "Semovita" is not a product: it is offered as a new item (ADR-074). Here it was a short name for one we have.
  await expect(page.getByTestId("import-new-items")).toContainText("2 items are not in your products");
  await page.getByLabel("Product, row 1").fill("Golden Penny Semovita");
  await page.getByRole("button", { name: "Check rows" }).click();
  await expect(page.getByText("All rows look right: 2 new, 0 updates.")).toBeVisible();
  await expect(page.getByTestId("import-row-2").getByText("History only", { exact: true })).toBeVisible();
  await page.getByLabel("How to add Old stock item").selectOption("typed");
  await page.getByRole("button", { name: "Save 2 rows" }).click();
  await expect(page.getByText("Saved: 2 new, 0 updated.")).toBeVisible();
  const semovita = (await (await request.get("/api/v1/products?q=semovita", { headers })).json()).data.items[0];
  expect(semovita.stock.quantity).toBe("19000");
});
