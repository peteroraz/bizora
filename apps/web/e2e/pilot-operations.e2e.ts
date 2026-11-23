import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// Running the pilot (ADR-045): the owner can download every record of the business.

test.use({ viewport: { width: 360, height: 780 } });

test("the owner downloads the business's records as spreadsheet files", async ({ page, request }) => {
  const { email } = await shop(request);
  await signIn(page, email);
  await page.goto("/app/settings");
  await page.waitForLoadState("networkidle");
  const card = page.getByTestId("export-records");
  await expect(card).toContainText("Download your records");
  const [download] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: "Download records" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^bizora-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.zip$/);
  const bytes = await readFile((await download.path())!);
  // A ZIP starts with PK and lists its files at the end.
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  expect(bytes.includes(Buffer.from("products.csv"))).toBe(true);
  expect(bytes.includes(Buffer.from("README.txt"))).toBe(true);
});
