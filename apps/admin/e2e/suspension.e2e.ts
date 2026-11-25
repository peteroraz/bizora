import { expect, request as apiRequest, test, type Page } from "@playwright/test";

// Suspending and reinstating a business from the portal (ADR-071).

const API = "http://localhost:3021";
const password = "LocalOnly!Passw0rd";

async function signInWithGoogle(page: Page, email: string) {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with Google" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
}

test("Bizora staff suspend a business with a reason, the business can only read, and staff reinstate it", async ({ page }) => {
  const stamp = Date.now();
  const shopName = `Harbour Phones ${stamp}`;
  const api = await apiRequest.newContext({ baseURL: API });
  const registered = await api.post("/api/v1/auth/register", {
    data: { acceptTerms: true, email: `owner-${stamp}@harbour.test`, password, displayName: "Tunde Owner", organizationName: shopName, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail" },
  });
  expect(registered.status()).toBe(201);
  const { accessToken } = (await registered.json()).data as { accessToken: string };
  const bearer = { authorization: `Bearer ${accessToken}` };
  const sale = { lines: [{ description: "Phone case", quantity: "1", unitPriceMinor: "250000", saved: true }], payments: [{ method: "cash", amountMinor: "250000" }] };

  await signInWithGoogle(page, "lead@bizora.test");
  await page.getByPlaceholder("Business name, link name, owner email or phone").fill(`owner-${stamp}@harbour`);
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("link", { name: shopName }).click();
  await expect(page.getByRole("heading", { name: shopName })).toBeVisible();
  await expect(page.getByTestId("lifecycle-state")).toContainText("Working normally");

  await page.getByRole("button", { name: "Suspend business" }).click();
  const suspend = page.getByRole("dialog", { name: "Suspend this business?" });
  await suspend.getByLabel("Reason", { exact: true }).selectOption("payment_dispute");
  await suspend.getByLabel("Case reference").fill("PD-204");
  await suspend.getByLabel("Why are you doing this?").fill("Bank flagged transfers to this shop for checking");
  await suspend.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Business suspended.")).toBeVisible();
  await expect(page.getByTestId("lifecycle-state")).toContainText("Suspended");
  await expect(page.getByTestId("lifecycle-state")).toContainText("Payment dispute");
  await expect(page.getByTestId("lifecycle-event").first()).toContainText("Bank flagged transfers to this shop for checking");
  await expect(page.getByTestId("lifecycle-event").first()).toContainText("Case PD-204");

  // The business can read, not record; the owner is told the category, not the note.
  expect((await api.get("/api/v1/sales", { headers: bearer })).status()).toBe(200);
  const refused = await api.post("/api/v1/sales", { headers: bearer, data: sale });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error.code).toBe("BUSINESS_SUSPENDED");
  const me = await (await api.get("/api/v1/auth/me", { headers: bearer })).json();
  expect(me.data.organization).toMatchObject({ bizoraHold: "suspended", holdReasonCode: "payment_dispute" });
  expect(JSON.stringify(me)).not.toContain("Bank flagged");

  await page.getByRole("button", { name: "Reinstate" }).click();
  const reinstate = page.getByRole("dialog", { name: "Reinstate this business?" });
  await reinstate.getByLabel("Why are you doing this?").fill("Bank finished checking, all fine");
  await reinstate.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Business reinstated.")).toBeVisible();
  await expect(page.getByTestId("lifecycle-state")).toContainText("Working normally");
  await expect(page.getByTestId("lifecycle-event")).toHaveCount(2);
  expect((await api.post("/api/v1/sales", { headers: bearer, data: sale })).status()).toBe(201);
});
