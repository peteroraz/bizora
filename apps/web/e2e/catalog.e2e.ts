import { deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// ADR-046: a small trader adds an item in under a minute with four fields; everything else waits behind More options.

test.use({ viewport: { width: 360, height: 780 } });

/** A plain 64×64 PNG, so the photo step uses a real picture. */
function png() {
  const crc = (buffer: Buffer) => {
    let c = ~0;
    for (const byte of buffer) {
      c ^= byte;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0);
  header.writeUInt32BE(64, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: 64 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(64 * 3, 0xc0)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

test("add an item with name, price, quantity, unit and a photo; then group items into categories and brands", async ({ page, request }) => {
  const { email } = await shop(request);
  await signIn(page, email);

  await page.goto("/app/stock/new");
  await expect(page.getByRole("heading", { name: "Add an item" })).toBeVisible();
  // The simple form: nothing technical shows until asked for.
  for (const hidden of ["Your own code (SKU)", "Barcode", "Brand", "What is it?"]) await expect(page.getByLabel(hidden)).toHaveCount(0);
  await page.getByLabel("Item name").fill("Peak Milk 400g");
  await page.getByLabel("How you count it").selectOption("tin");
  await page.getByLabel("Selling price per tin").fill("7,500");
  await page.getByLabel("How many tins you have").fill("12");
  await page.getByLabel("Photo").setInputFiles({ name: "milk.png", mimeType: "image/png", buffer: png() });
  await page.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByRole("heading", { name: "Peak Milk 400g" })).toBeVisible();
  await expect(page.getByText("12 tins").first()).toBeVisible();
  await expect(page.getByTestId("product-photos").getByRole("img")).toHaveCount(1);

  // Categories inside categories, and a brand.
  await page.goto("/app/stock/categories");
  await page.getByLabel("New category").fill("Food & Beverages");
  await page.getByRole("button", { name: "Add category" }).click();
  await expect(page.getByTestId("category-list")).toContainText("Food & Beverages");
  await page.getByLabel("New category").fill("Drinks");
  await page.getByLabel("Inside").selectOption({ label: "Food & Beverages" });
  await page.getByRole("button", { name: "Add category" }).click();
  await expect(page.getByTestId("category-list")).toContainText("Drinks");
  await page.getByLabel("New brand").fill("Coca-Cola");
  await page.getByRole("button", { name: "Add brand" }).click();
  await expect(page.getByTestId("brand-list")).toContainText("Coca-Cola");

  // More options: a category, a brand and the business's own code.
  await page.goto("/app/stock/new");
  await page.getByLabel("Item name").fill("Coke 50cl");
  await page.getByLabel("How you count it").selectOption("bottle");
  await page.getByLabel("Selling price per bottle").fill("300");
  await page.getByRole("button", { name: "More options" }).click();
  await expect(page.getByLabel("Category", { exact: true })).toBeEnabled();
  await page.getByLabel("Category", { exact: true }).selectOption({ label: "Food & Beverages › Drinks" });
  await page.getByLabel("Brand", { exact: true }).selectOption({ label: "Coca-Cola" });
  await page.getByLabel("Your own code (SKU)").fill("COKE-50");
  await page.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByRole("heading", { name: "Coke 50cl" })).toBeVisible();
  await expect(page.getByText("Food & Beverages › Drinks · Coca-Cola · Code COKE-50")).toBeVisible();

  // A service keeps no stock: the quantity question goes away.
  await page.goto("/app/stock/new");
  await page.getByRole("button", { name: "More options" }).click();
  await page.getByLabel("What is it?").selectOption("service");
  await expect(page.getByLabel("How many pieces you have")).toHaveCount(0);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(360);
});
