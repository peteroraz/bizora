import { expect, test } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test("every main screen works under the content security policy, with nothing blocked", async ({ page, request }) => {
  test.setTimeout(120_000);
  const blocked: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to (load|execute|apply)/i.test(message.text())) blocked.push(message.text());
  });
  page.on("pageerror", (error) => blocked.push(`Page error: ${error.message}`));

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `csp.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { email, password, displayName: "Ada Owner", organizationName: `Ada CSP ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  const headers = { authorization: `Bearer ${(await registered.json()).data.accessToken as string}` };
  await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "NG", industryCode: "general-retail", businessType: "shop", staffCountBand: "2-5", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ada Stores", branchName: "Main" } });
  await request.post("/api/v1/products", { headers, data: { name: "Peak Milk", baseUnit: "tin", priceMinor: "45000", openingQuantity: "10", openingCostMinor: "350000" } });

  const home = await page.goto("/");
  const policy = home?.headers()["content-security-policy"] ?? "";
  expect(policy).toContain("'strict-dynamic'");
  expect(policy).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
  await expect(page.locator("body")).toBeVisible();

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);
  // Each page gets its own nonce.
  const again = await page.goto("/app");
  expect(again?.headers()["content-security-policy"]).not.toBe(policy);

  for (const path of ["/app/sales/new", "/app/sales", "/app/stock", "/app/customers", "/app/debtors", "/app/money", "/app/settings", "/app/jobs/new"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  // A lazily loaded part (the voice panel) loads too.
  await page.goto("/app/sales/new");
  await page.getByTestId("say-sale").click();
  await expect(page.getByTestId("voice-sale")).toBeVisible();
  expect(blocked).toEqual([]);
});
