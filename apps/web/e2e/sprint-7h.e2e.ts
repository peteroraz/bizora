import { expect, test, type Browser } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test.use({ viewport: { width: 390, height: 844 } });

async function signIn(browser: Browser, email: string) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);
  return { context, page };
}

/** A clock time in Lagos, `offset` hours from now. */
const lagosHour = (offset: number) => {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  return `${String((hour + offset + 24) % 24).padStart(2, "0")}:00`;
};

test("owner sets opening hours and lets a cashier work late; a store keeper's delivery waits for approval", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `rules.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { email, password, displayName: "Kemi Owner", organizationName: `Kemi Stores ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  const headers = { authorization: `Bearer ${(await registered.json()).data.accessToken as string}` };
  expect((await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Kemi Stores", branchName: "Main" } })).ok()).toBeTruthy();
  const me = (await (await request.get("/api/v1/auth/me", { headers })).json()).data.tenant;
  const product = await request.post("/api/v1/products", { headers, data: { name: "Peak Milk", baseUnit: "tin", priceMinor: "45000", openingQuantity: "20", openingCostMinor: "700000" } });
  const productId = (await product.json()).data.product.id as string;
  const stock = async () => (await (await request.get(`/api/v1/products/${productId}`, { headers })).json()).data.product.stock.quantity as string;
  const staff: Record<string, string> = {};
  for (const [role, name] of [["CASHIER", "Ngozi Cashier"], ["INVENTORY", "Tunde Store"]] as const) {
    const staffEmail = `${role.toLowerCase()}.${suffix}@bizora.test`;
    const invited = await request.post("/api/v1/invitations", { headers, data: { email: staffEmail, role, businessId: me.businessId, branchId: me.branchId } });
    await request.post("/api/v1/invitations/accept", { data: { token: (await invited.json()).data.invitation.token, displayName: name, password } });
    staff[role] = staffEmail;
  }

  // The owner sets hours that do not include now.
  const owner = await signIn(browser, email);
  await owner.page.goto("/app/settings?tab=hours");
  await owner.page.getByRole("tab", { name: "Hours and locks" }).click();
  await owner.page.getByLabel("Set opening hours").check();
  await owner.page.getByLabel("Monday opens at").fill(lagosHour(5));
  await owner.page.getByLabel("Monday closes at").fill(lagosHour(6));
  await owner.page.getByRole("button", { name: "Use Monday's hours Monday to Saturday" }).click();
  await owner.page.getByRole("button", { name: "Save opening hours" }).click();
  await expect(owner.page.getByText("Opening hours saved.")).toBeVisible();

  // The cashier is told, and cannot record a sale.
  const cashier = await signIn(browser, staff.CASHIER as string);
  await expect(cashier.page.getByTestId("work-banner")).toContainText(/The business is closed/);
  await cashier.page.goto("/app/sales/new");
  await cashier.page.getByLabel("Find a product").fill("peak");
  await cashier.page.getByRole("button", { name: /Peak Milk/ }).click();
  await cashier.page.getByRole("button", { name: "Record sale" }).click();
  await expect(cashier.page.getByText(/Outside opening hours only the owner can make changes/)).toBeVisible();

  // The owner lets the cashier work for two hours.
  await owner.page.getByLabel("Who").selectOption({ label: "Ngozi Cashier" });
  await owner.page.getByRole("button", { name: "Let them work" }).click();
  await expect(owner.page.getByText("Ngozi Cashier can work outside opening hours now.")).toBeVisible();
  await expect(owner.page.getByTestId("work-permits")).toContainText("Ngozi Cashier can work until");
  await cashier.page.goto("/app/sales/new");
  await expect(cashier.page.getByTestId("work-banner")).toContainText("The owner has let you work outside opening hours until");
  await cashier.page.getByLabel("Find a product").fill("peak");
  await cashier.page.getByRole("button", { name: /Peak Milk/ }).click();
  await cashier.page.getByRole("button", { name: "Record sale" }).click();
  await expect(cashier.page.getByRole("heading", { name: "R-000001" })).toBeVisible();
  expect(await stock()).toBe("19000");

  // Hours off again, then the store keeper records a delivery: it waits for the owner.
  await owner.page.getByLabel("Set opening hours").uncheck();
  await owner.page.getByRole("button", { name: "Save opening hours" }).click();
  await expect(owner.page.getByText("Opening hours turned off. Staff can work at any time.")).toBeVisible();
  const store = await signIn(browser, staff.INVENTORY as string);
  await store.page.goto(`/app/stock/${productId}`);
  await store.page.locator("#receive-quantity").fill("6");
  await store.page.locator("#receive-supplier").fill("Dangote Distributors");
  await store.page.getByRole("button", { name: "Record stock in" }).click();
  await expect(store.page.getByText("Sent to a manager or the owner. Stock changes when they approve it.")).toBeVisible();
  expect(await stock()).toBe("19000");

  await owner.page.goto("/app/stock");
  await expect(owner.page.getByTestId("stock-requests")).toContainText("1 stock change waits for you");
  await expect(owner.page.getByTestId("stock-request")).toContainText("Receive 6 tin of Peak Milk from Dangote Distributors (owed)");
  await owner.page.getByRole("button", { name: "Approve and complete" }).click();
  await expect(owner.page.getByTestId("stock-requests")).toHaveCount(0);
  expect(await stock()).toBe("25000");

  // The owner locks the shop: the store keeper is told.
  await owner.page.goto("/app/settings?tab=hours");
  await owner.page.getByRole("tab", { name: "Hours and locks" }).click();
  await owner.page.getByLabel("Why (staff will see this)").fill("Stock check");
  await owner.page.getByRole("button", { name: "Lock Main" }).click();
  await expect(owner.page.getByText("Main is locked.")).toBeVisible();
  await store.page.goto("/app/stock");
  await expect(store.page.getByTestId("work-banner")).toContainText("The owner has locked Main: Stock check.");
  await expect(store.page.getByTestId("stock-requests")).toContainText("Approved");

  await Promise.all([owner.context.close(), cashier.context.close(), store.context.close()]);
});
