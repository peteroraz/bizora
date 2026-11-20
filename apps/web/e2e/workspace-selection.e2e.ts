import { expect, test, type APIRequestContext } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

type Registered = {
  accessToken: string;
  tenant: { businessId: string; branchId: string };
};

async function registerOwner(
  api: APIRequestContext,
  email: string,
  displayName: string,
  organizationName: string,
  businessName: string,
  branchName: string,
): Promise<Registered> {
  const registered = await api.post("/api/v1/auth/register", {
    data: { acceptTerms: true,
      email,
      password,
      displayName,
      organizationName,
      countryCode: "NG",
      baseCurrencyCode: "NGN",
      timezone: "Africa/Lagos",
    },
  });
  if (!registered.ok()) throw new Error(await registered.text());
  const body = (await registered.json()) as { data: Registered };
  const onboarded = await api.patch("/api/v1/onboarding", {
    headers: { authorization: `Bearer ${body.data.accessToken}` },
    data: {
      countryCode: "NG",
      industryCode: "general-retail",
      baseCurrencyCode: "NGN",
      timezone: "Africa/Lagos",
      businessName,
      branchName,
    },
  });
  if (!onboarded.ok()) throw new Error(await onboarded.text());
  return body.data;
}

async function giveSecondWorkspace(api: APIRequestContext, email: string, displayName: string) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const harbor = `Harbor Goods ${suffix}`;
  const atelier = `Lagos Atelier ${suffix}`;
  await registerOwner(api, email, displayName, harbor, "Harbor Shop", "Marina");
  const host = await registerOwner(
    api,
    `host.${suffix}@bizora.test`,
    "Host Owner",
    atelier,
    "Atelier Shop",
    "Ikeja",
  );
  const invited = await api.post("/api/v1/invitations", {
    headers: { authorization: `Bearer ${host.accessToken}` },
    data: {
      email,
      role: "EMPLOYEE",
      businessId: host.tenant.businessId,
      branchId: host.tenant.branchId,
    },
  });
  if (!invited.ok()) throw new Error(await invited.text());
  const token = (await invited.json()).data.invitation.token as string;
  const accepted = await api.post("/api/v1/invitations/accept", {
    data: { token, displayName },
  });
  if (!accepted.ok()) throw new Error(await accepted.text());
  return { harbor, atelier };
}

test("password login lists both workspaces and the menu switches between them", async ({ page, request }) => {
  const email = `nia.${Date.now()}@bizora.test`;
  const { harbor, atelier } = await giveSecondWorkspace(request, email, "Nia Okonkwo");

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Choose a business" })).toBeVisible();
  const harborCard = page.getByRole("button", { name: new RegExp(harbor) });
  const atelierCard = page.getByRole("button", { name: new RegExp(atelier) });
  await expect(harborCard).toContainText("Owner");
  await expect(atelierCard).toContainText("Employee");
  await expect(atelierCard).toContainText("Atelier Shop");
  await expect(atelierCard).toContainText("Ikeja");
  expect(await page.evaluate(() => sessionStorage.getItem("bizora.workspaces"))).toBeNull();

  await harborCard.click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: /Welcome, Nia Okonkwo/ })).toBeVisible();
  await expect(page.locator("header").first()).toContainText(harbor);

  await page.getByRole("button", { name: "Account menu" }).click();
  await expect(page.getByText("Switch business")).toBeVisible();
  await page.getByRole("menuitem", { name: new RegExp(atelier) }).click();

  await expect(page).toHaveURL(/\/app$/);
  await expect(page.locator("header").first()).toContainText(atelier);
  await expect(page.locator("header").first()).not.toContainText(harbor);
});

test("select-workspace renders workspaces without sessionStorage", async ({ page, request }) => {
  const email = `ada.${Date.now()}@bizora.test`;
  const { harbor, atelier } = await giveSecondWorkspace(request, email, "Ada Okonkwo");

  await page.goto("/login");
  await page.evaluate(
    async ({ email: loginEmail, password: loginPassword }) => {
      sessionStorage.clear();
      const response = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      });
      if (!response.ok) throw new Error(`login failed ${response.status}`);
      sessionStorage.removeItem("bizora.workspaces");
    },
    { email, password },
  );

  const listed = page.waitForResponse((response) => response.url().includes("/api/v1/auth/workspaces") && response.ok());
  await page.goto("/select-workspace");
  await listed;

  await expect(page.getByRole("button", { name: new RegExp(harbor) })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(atelier) })).toBeVisible();
  await expect(page.getByRole("button", { name: /Atelier Shop/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Ikeja/ })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("bizora.workspaces"))).toBeNull();
});
