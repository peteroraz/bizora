import { expect, test } from "@playwright/test";
import { crc32, deflateSync } from "node:zlib";

const password = "LocalOnly!Passw0rd";

test.use({ viewport: { width: 360, height: 780 } });

/** A 120 × 60 PNG drawn in code. */
function png(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, index) => [11, 110, 79][index % 3] ?? 0)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

test("the owner adds a logo, colour and messages, and receipts carry them with the Bizora line", async ({ page, request }) => {
  test.setTimeout(120_000);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `brand.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { email, password, displayName: "Ada Owner", organizationName: `Ada Brand ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  const token = (await registered.json()).data.accessToken as string;
  const headers = { authorization: `Bearer ${token}` };
  expect((await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ada Brand", branchName: "Main" } })).ok()).toBeTruthy();
  const product = await request.post("/api/v1/products", { headers, data: { name: "Rice 50kg", baseUnit: "bag", priceMinor: "1000000", openingQuantity: "20", openingCostMinor: "16000000" } });
  const sale = await request.post("/api/v1/sales", { headers, data: { lines: [{ productId: (await product.json()).data.product.id, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "1000000" }] } });
  const saleId = (await sale.json()).data.sale.id as string;

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.goto("/app/settings?tab=brand");
  await expect(page.getByText("No logo yet.")).toBeVisible();
  await page.locator('input[type="file"][accept^="image/png"]').setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: png(120, 60) });
  await expect(page.getByText("Logo saved. Your documents now show it.")).toBeVisible();
  await expect(page.getByTestId("brand-logo")).toBeVisible();
  await expect(page.getByTestId("shell-logo")).toBeVisible();

  // Too light for paper: refused before saving.
  await page.getByLabel("Brand colour").fill("#FFFF66");
  await expect(page.getByText("This colour is too light to read on white paper. Choose a darker one.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.getByLabel("Brand colour").fill("#0B6E4F");
  await page.getByLabel("Message on receipts").fill("Thank you for buying from Ada Brand. Come again!");
  await page.getByLabel("Message on invoices and statements").fill("Pay to GTBank 0123456789, Ada Brand.");
  await page.getByLabel("Terms").fill("Goods sold in good condition are not returnable.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved. New documents use this straight away.")).toBeVisible();

  const branding = (await (await request.get("/api/v1/organizations/current/branding", { headers })).json()).data.branding;
  expect(branding).toMatchObject({ primaryColor: "#0B6E4F", receiptMessage: "Thank you for buying from Ada Brand. Come again!", documentTerms: "Goods sold in good condition are not returnable." });
  expect(branding.logo).toMatchObject({ width: 120, height: 60 });

  // The sample and a real receipt both carry the logo.
  const sampleHref = await page.getByRole("link", { name: "See a sample receipt" }).getAttribute("href");
  const sample = await page.request.get(sampleHref ?? "/missing");
  expect(sample.headers()["content-type"]).toContain("application/pdf");
  expect((await sample.body()).toString("latin1")).toContain("/Subtype /Image");
  const receipt = await request.get(`/api/v1/sales/${saleId}/documents/receipt`, { headers });
  expect((await receipt.body()).toString("latin1")).toContain("/Subtype /Image");

  await page.getByRole("button", { name: "Remove logo" }).click();
  await expect(page.getByText("Logo removed.")).toBeVisible();
  await expect(page.getByTestId("shell-logo")).toHaveCount(0);
});
