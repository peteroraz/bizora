import { expect, request as apiRequest, test, type Page } from "@playwright/test";

const API = "http://localhost:3021";
const password = "LocalOnly!Passw0rd";

async function signInWithGoogle(page: Page, email: string) {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with Google" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
}

test("Bizora staff sign in with Google, find a business and help it, and every step is logged", async ({ page }) => {
  const stamp = Date.now();
  const shopName = `Lagoon Fabrics ${stamp}`;
  const api = await apiRequest.newContext({ baseURL: API });
  const registered = await api.post("/api/v1/auth/register", {
    data: { email: `owner-${stamp}@lagoon.test`, password, displayName: "Bola Owner", organizationName: shopName, countryCode: "GH", baseCurrencyCode: "GHS", timezone: "Africa/Accra", industryCode: "general-retail" },
  });
  expect(registered.status()).toBe(201);
  const { accessToken, tenant } = (await registered.json()).data as { accessToken: string; tenant: { businessId: string; branchId: string } };
  const bearer = { authorization: `Bearer ${accessToken}` };
  expect((await api.post("/api/v1/invitations", { headers: bearer, data: { email: `kofi-${stamp}@lagoon.test`, role: "CASHIER", businessId: tenant.businessId, branchId: tenant.branchId } })).status()).toBe(201);
  expect((await api.post("/api/v1/shop-devices", { headers: bearer, data: { name: "Front counter tablet" } })).status()).toBe(201);

  // The portal is never indexed and runs only its own scripts.
  const first = await page.goto("/");
  expect(first?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(first?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  await expect(page.getByText("E2e — test data, not real shops")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bizora staff only" })).toBeVisible();

  // Someone not on the staff list is turned away.
  await signInWithGoogle(page, `stranger-${stamp}@gmail.test`);
  await expect(page.getByText("That Google account is not on the staff list.")).toBeVisible();

  await signInWithGoogle(page, "lead@bizora.test");
  await expect(page.getByRole("heading", { name: "Find a business or a person" })).toBeVisible();
  await expect(page.getByText("Signed in as lead@bizora.test")).toBeVisible();

  await page.getByRole("searchbox").or(page.getByPlaceholder("Business name, link name, owner email or phone")).fill(`owner-${stamp}@lagoon`);
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("link", { name: shopName }).click();
  await expect(page.getByRole("heading", { name: shopName })).toBeVisible();
  await expect(page.getByText("Sales, money and customers stay private.")).toBeVisible();
  await expect(page.getByRole("cell", { name: `kofi-${stamp}@lagoon.test` })).toBeVisible();

  // Resend the invitation: a reason is needed, and it shows in the business's support history.
  await page.getByRole("button", { name: "Send again" }).click();
  const resend = page.getByRole("dialog", { name: "Send the invitation again" });
  await expect(resend.getByRole("button", { name: "Confirm" })).toBeDisabled();
  await resend.getByLabel("Why are you doing this?").fill("Kofi lost the first email");
  await resend.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Invitation sent again")).toBeVisible();

  await page.getByRole("button", { name: "Stop phone" }).click();
  const stop = page.getByRole("dialog", { name: "Stop this shop phone" });
  await stop.getByLabel("Why are you doing this?").fill("Owner called: tablet stolen");
  await stop.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Phone stopped")).toBeVisible();
  await expect(page.getByRole("row", { name: /Front counter tablet/ }).getByText("Stopped")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Owner called: tablet stolen" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Kofi lost the first email" })).toBeVisible();

  // Super admins keep the staff list.
  await page.getByRole("link", { name: "Staff", exact: true }).click();
  await page.getByLabel("Google email").fill(`helper-${stamp}@bizora.test`);
  await page.getByLabel("Name").fill("Ama Support");
  await page.getByRole("button", { name: "Add to staff" }).click();
  await expect(page.getByText("Added to staff")).toBeVisible();
  await expect(page.getByRole("cell", { name: new RegExp(`helper-${stamp}@bizora.test`) })).toBeVisible();

  await page.getByRole("link", { name: "Staff log" }).click();
  await expect(page.getByRole("link", { name: "Stopped a shop phone" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "Owner called: tablet stolen" }).first()).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Bizora staff only" })).toBeVisible();
  await api.dispose();
});

test("the portal's API refuses requests from other sites", async () => {
  const api = await apiRequest.newContext({ baseURL: "http://localhost:3002" });
  const foreign = await api.get("/api/admin/v1/businesses", { headers: { origin: "http://localhost:3000" } });
  expect(foreign.status()).toBe(403);
  const signedOut = await api.get("/api/admin/v1/businesses");
  expect(signedOut.status()).toBe(401);
  await api.dispose();
});
