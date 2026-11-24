import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// Attributes and making variants (ADR-060).

test.use({ viewport: { width: 360, height: 780 } });

test("the owner adds Colour and Size, then makes a shirt's variants from them", async ({ page, request }) => {
  const { email, headers } = await shop(request);
  const item = await request.post("/api/v1/catalog/items", { headers, data: { name: "Polo shirt", variants: [{ baseUnit: "piece", priceMinor: "800000" }] } });
  const productId = (await item.json()).data.item.variants[0].id as string;

  await signIn(page, email);
  await page.goto("/app/stock");
  await page.getByRole("link", { name: "Attributes" }).click();
  await page.getByLabel("Attribute", { exact: true }).fill("Colour");
  await page.getByLabel("Choices", { exact: true }).fill("Red, Black");
  await page.getByRole("button", { name: "Add attribute" }).click();
  await expect(page.getByText("Colour added.")).toBeVisible();
  await page.getByLabel("Attribute", { exact: true }).fill("Size");
  await page.getByLabel("Choices", { exact: true }).fill("S, M");
  await page.getByRole("button", { name: "Add attribute" }).click();
  await expect(page.getByTestId("attribute-list")).toContainText("S, M");
  await page.getByLabel("More choices for Size").fill("L");
  await page.getByLabel("More choices for Size").press("Enter");
  await expect(page.getByTestId("attribute-list")).toContainText("S, M, L");

  await page.goto(`/app/stock/${productId}`);
  const maker = page.getByTestId("variant-maker");
  await maker.getByLabel("Red").check();
  await maker.getByLabel("Black").check();
  await maker.getByLabel("M", { exact: true }).check();
  await maker.getByLabel("L", { exact: true }).check();
  await maker.getByLabel("Price for each new variant").pressSequentially("8500");
  await maker.getByRole("button", { name: "See what will be made" }).click();
  await expect(page.getByTestId("variant-preview")).toContainText("4 variants will be made:");
  await expect(page.getByTestId("variant-preview")).toContainText("Polo shirt Black / L");
  await maker.getByRole("button", { name: "Make 4 variants" }).click();
  await expect(maker.getByText("4 variants made.")).toBeVisible();
  await expect(page.getByTestId("product-variants")).toContainText("Red / M");
  await page.getByTestId("product-variants").getByRole("link", { name: "Black / L" }).click();
  await expect(page.getByRole("heading", { name: "Polo shirt Black / L" })).toBeVisible();
});
