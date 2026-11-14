import { expect, request, test } from "@playwright/test";

test("registers, finishes setup, toggles theme, and chooses a workspace", async ({ page }) => {
  const email = `alice.${Date.now()}@bizora.test`;
  const password = "LocalOnly!Passw0rd";
  const organization = `Adeyemi ${Date.now()}`;

  await page.goto("/register");
  await page.getByLabel("Your name").fill("Alice Adeyemi");
  await page.getByLabel("Business name").fill(organization);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByLabel("Country").selectOption("NG");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("heading", { name: "Set up your business" })).toBeVisible();

  const country = page.getByRole("combobox", { name: "Country" });
  await country.click();
  await country.fill("Nigeria");
  await page.getByRole("option", { name: "Nigeria" }).click();
  await page.getByLabel("Address line 1").fill("12 Broad Street");
  await page.getByLabel("City").fill("Lagos");
  const state = page.getByRole("combobox", { name: "State" });
  await state.click();
  await state.fill("Lagos");
  await page.getByRole("option", { name: "Lagos", exact: true }).click();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("heading", { name: /Welcome, Alice Adeyemi/ })).toBeVisible();

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: /^Dark/ }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Bizora" })).toBeVisible();

  const bob = await request.newContext({ baseURL: "http://localhost:3000" });
  const registered = await bob.post("/api/v1/auth/register", {
    data: {
      email: `bob.${Date.now()}@bizora.test`,
      password,
      displayName: "Bob Adeyemi",
      organizationName: "Second Studio",
      countryCode: "GB",
      baseCurrencyCode: "GBP",
      timezone: "Europe/London",
    },
  });
  expect(registered.ok()).toBeTruthy();
  const invited = await bob.post("/api/v1/invitations", { data: { email, role: "EMPLOYEE" } });
  expect(invited.ok()).toBeTruthy();
  const token = (await invited.json()).data.invitation.token as string;
  const accepted = await bob.post("/api/v1/invitations/accept", { data: { token, displayName: "Alice Adeyemi" } });
  expect(accepted.ok()).toBeTruthy();
  await bob.dispose();

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: new RegExp(organization) }).click();
  await expect(page.getByRole("heading", { name: /Welcome, Alice Adeyemi/ })).toBeVisible();
});
