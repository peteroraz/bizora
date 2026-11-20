import { expect, type APIRequestContext, type Page } from "@playwright/test";

// A shop with rice and a customer allowed credit, for the offline voice tests (ADR-040).
const password = "LocalOnly!Passw0rd";

export async function shop(request: APIRequestContext) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `voice.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: {
      acceptTerms: true,
      email,
      password,
      displayName: "Ngozi Owner",
      organizationName: `Ngozi Foods ${suffix}`,
      countryCode: "NG",
      baseCurrencyCode: "NGN",
      timezone: "Africa/Lagos",
    },
  });
  expect(registered.ok()).toBeTruthy();
  const token = (await registered.json()).data.accessToken as string;
  const headers = { authorization: `Bearer ${token}` };
  const onboarded = await request.patch("/api/v1/onboarding", {
    headers,
    data: { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ngozi Foods", branchName: "Main" },
  });
  expect(onboarded.ok()).toBeTruthy();
  const product = await request.post("/api/v1/products", {
    headers,
    data: { name: "Rice 50kg", baseUnit: "bag", priceMinor: "7500000", openingQuantity: "10", openingCostMinor: "60000000" },
  });
  expect(product.ok()).toBeTruthy();
  const customer = await request.post("/api/v1/customers", { headers, data: { name: "Emeka Obi", phone: "08031112222", creditAllowed: true } });
  expect(customer.ok()).toBeTruthy();
  return {
    email,
    headers,
    productId: (await product.json()).data.product.id as string,
    customerId: (await customer.json()).data.customer.id as string,
  };
}

export async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);
}
