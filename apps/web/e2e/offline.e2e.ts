import { expect, test } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test.use({ viewport: { width: 360, height: 780 } });

test("a customer added with no network waits on the phone, then syncs once when the network is back", async ({
  page,
  context,
  request,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `offline.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { acceptTerms: true,
      email,
      password,
      displayName: "Amaka Owner",
      organizationName: `Amaka Stores ${suffix}`,
      countryCode: "NG",
      baseCurrencyCode: "NGN",
      timezone: "Africa/Lagos",
    },
  });
  expect(registered.ok()).toBeTruthy();
  const token = (await registered.json()).data.accessToken as string;
  const onboarded = await request.patch("/api/v1/onboarding", {
    headers: { authorization: `Bearer ${token}` },
    data: {
      countryCode: "NG",
      industryCode: "general-retail",
      baseCurrencyCode: "NGN",
      timezone: "Africa/Lagos",
      businessName: "Amaka Stores",
      branchName: "Main",
    },
  });
  expect(onboarded.ok()).toBeTruthy();

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.goto("/app/customers/new");
  await expect(page.getByRole("heading", { name: "Add a customer" })).toBeVisible();

  // The network drops.
  await context.setOffline(true);
  await page.getByLabel("Name", { exact: true }).fill("Offline Okoro");
  await page.getByLabel("Phone", { exact: true }).fill("08035551234");
  await page.getByRole("button", { name: "Save customer" }).click();
  await expect(page.getByRole("status").filter({ hasText: "saved on this phone" })).toBeVisible();
  await expect(page.getByText("1 change waiting to sync")).toBeVisible();

  // The network comes back: the change is sent and the badge goes away.
  await context.setOffline(false);
  await expect(page.getByText("1 change waiting to sync")).toHaveCount(0, { timeout: 15_000 });

  const list = await request.get("/api/v1/customers?q=Okoro", { headers: { authorization: `Bearer ${token}` } });
  const items = (await list.json()).data.items as { name: string }[];
  expect(items.map((item) => item.name)).toEqual(["Offline Okoro"]);

  await page.goto("/app/customers");
  await expect(page.getByText("Offline Okoro")).toBeVisible();
});
