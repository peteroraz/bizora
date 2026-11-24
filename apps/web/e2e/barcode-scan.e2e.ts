import { expect, test, type Page } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// Camera barcode scanning (ADR-066). The browser's barcode reader and the camera are stood in for, so the test
// runs anywhere; the screens use them exactly as a phone's would.

test.use({ viewport: { width: 360, height: 780 } });

async function fakeCamera(page: Page, code: string) {
  await page.addInitScript((value) => {
    class FakeDetector {
      static async getSupportedFormats() {
        return ["ean_13", "code_128"];
      }
      async detect() {
        return [{ rawValue: value, format: "ean_13" }];
      }
    }
    (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = FakeDetector;
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => canvas.captureStream(5) },
    });
  }, code);
}

test("scanning a barcode adds the product to the sale, and finds it when counting", async ({ page, request }) => {
  const { email, headers } = await shop(request);
  await request.post("/api/v1/products", { headers, data: { name: "Peak milk 400g", baseUnit: "tin", priceMinor: "450000", barcode: "4006381333931", openingQuantity: "12" } });
  await fakeCamera(page, "4006381333931");
  await signIn(page, email);

  await page.goto("/app/sales/new");
  await expect(page.getByTestId("say-sale")).toBeVisible();
  await page.getByTestId("scan-button").click();
  await expect(page.getByTestId("barcode-scanner")).toHaveCount(0);
  await expect(page.getByText("Peak milk 400g").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Record sale", exact: true })).toBeEnabled();

  const started = await request.post("/api/v1/inventory/counts", { headers, data: { name: "Shelf count" } });
  expect(started.ok()).toBeTruthy();
  await page.goto("/app/stock/counts");
  await page.getByRole("button", { name: /Shelf count/ }).click();
  await page.getByTestId("scan-button").click();
  await expect(page.getByLabel("How many you counted")).toBeVisible();
  await expect(page.getByTestId("barcode-scanner")).toHaveCount(0);
});

test("the Scan button is not shown where the browser cannot read barcodes", async ({ page, request }) => {
  const { email } = await shop(request);
  await page.addInitScript(() => {
    delete (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
  });
  await signIn(page, email);
  await page.goto("/app/sales/new");
  await expect(page.getByLabel("Find a product")).toBeVisible();
  await expect(page.getByTestId("scan-button")).toHaveCount(0);
});
