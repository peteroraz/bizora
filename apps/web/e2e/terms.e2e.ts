import { expect, test } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test("an owner who has not accepted the Terms of use accepts them before using the app (ADR-039)", async ({ page, request }) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `terms.${suffix}@bizora.test`;
  // Signed up without the box, as with Google sign-up or after the terms change.
  const registered = await request.post("/api/v1/auth/register", {
    data: { email, password, displayName: "Efua Owner", organizationName: `Efua Stores ${suffix}`, countryCode: "GH", baseCurrencyCode: "GHS", timezone: "Africa/Accra" },
  });
  expect(registered.status()).toBe(201);

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/accept-terms$/);
  await expect(page.getByRole("heading", { name: "Accept the Terms of use" })).toBeVisible();
  await expect(page.getByText("Bizora staff may see your records, read-only")).toBeVisible();

  // Nothing in the app opens until they accept.
  await page.goto("/app/sales");
  await expect(page).toHaveURL(/\/accept-terms$/);
  // The box must be ticked.
  await page.getByRole("button", { name: "Accept and continue" }).click();
  await expect(page).toHaveURL(/\/accept-terms$/);
  await page.getByRole("checkbox", { name: /I agree to the Terms of use/ }).check();
  await page.getByRole("button", { name: "Accept and continue" }).click();
  await expect(page).toHaveURL(/\/app(\/onboarding)?$/);

  // The terms, with the section on Bizora staff access.
  await page.goto("/terms#bizora-access");
  await expect(page.getByRole("heading", { name: "Terms of use", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "5. When Bizora staff can see your business" })).toBeVisible();

  // The owner can see what Bizora staff did: nothing yet.
  await page.goto("/app/settings?tab=support");
  await expect(page.getByTestId("support-activity")).toContainText("Bizora staff have not looked at or changed anything in your business.");
});
