import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// Product files with codes, brands, category paths and variants, and the same file downloaded (ADR-065).

test.use({ viewport: { width: 360, height: 780 } });

test("a boutique brings in shirts as variants with codes and brands, then downloads the same file", async ({ page, request }) => {
  const { email, headers } = await shop(request);
  await signIn(page, email);
  await page.goto("/app/stock/import");
  await page.locator('input[accept=".csv,text/csv"]').setInputFiles({
    name: "shirts.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "Item group,Variant,SKU,Brand,Category,Unit,Price,Qty\n" +
        "Polo shirt,Red / M,POLO-RM,Ankara Co,Clothing > Shirts,piece,8000,4\n" +
        "Polo shirt,Black / L,POLO-BL,Ankara Co,Clothing > Shirts,piece,8500,2\n",
    ),
  });
  await expect(page.getByText("shirts.csv: 2 rows read.")).toBeVisible();
  await page.getByRole("button", { name: "Check rows" }).click();
  await expect(page.getByText("All rows look right: 2 new, 0 updates.")).toBeVisible();
  await expect(page.getByTestId("import-row-1")).toContainText("New variant Red / M of Polo shirt");
  await page.getByRole("button", { name: "Save 2 rows" }).click();
  await expect(page.getByText("Saved: 2 new, 0 updated.")).toBeVisible();

  const items = (await (await request.get("/api/v1/catalog/items?q=Polo", { headers })).json()).data.items as { variants: unknown[]; brandName: string }[];
  expect(items).toHaveLength(1);
  expect(items[0]?.variants).toHaveLength(2);

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-products").click()]);
  const text = await readFile((await download.path()) as string, "utf8");
  expect(text.split("\r\n")[0]).toContain("Name,Item group,Variant,SKU,GTIN,Barcode,Brand,Category,Unit,Price");
  expect(text).toContain("Polo shirt Black / L,Polo shirt,Black / L,POLO-BL,,,Ankara Co,Clothing > Shirts,piece,8500");
});
