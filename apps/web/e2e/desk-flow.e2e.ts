import { expect, test, type Browser } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test.use({ viewport: { width: 360, height: 780 } });

async function signIn(browser: Browser, email: string) {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);
  return { context, page };
}

test("sales desk sends a credit sale to the cashier, the store keeper gives out the goods, and everyone comments", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `desk.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { email, password, displayName: "Ada Owner", organizationName: `Ada Wholesale ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  expect(registered.ok()).toBeTruthy();
  const token = (await registered.json()).data.accessToken as string;
  const headers = { authorization: `Bearer ${token}` };
  expect((await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Ada Wholesale", branchName: "Main" } })).ok()).toBeTruthy();
  const me = (await (await request.get("/api/v1/auth/me", { headers })).json()).data.tenant;
  expect((await request.patch(`/api/v1/businesses/${me.businessId}`, { headers, data: { salesFlow: "desk" } })).ok()).toBeTruthy();
  const product = await request.post("/api/v1/products", { headers, data: { name: "Peak Milk", baseUnit: "tin", priceMinor: "45000", openingQuantity: "96", openingCostMinor: "3360000" } });
  const productId = (await product.json()).data.product.id as string;
  expect((await request.post("/api/v1/customers", { headers, data: { name: "Alhaji Musa", phone: "08039876543", creditAllowed: true, creditLimitMinor: "5000000" } })).ok()).toBeTruthy();
  const staff: Record<string, string> = {};
  for (const [role, name] of [["CASHIER", "Ngozi Cashier"], ["INVENTORY", "Tunde Store"]] as const) {
    const staffEmail = `${role.toLowerCase()}.${suffix}@bizora.test`;
    const invited = await request.post("/api/v1/invitations", { headers, data: { email: staffEmail, role, businessId: me.businessId, branchId: me.branchId } });
    expect(invited.ok()).toBeTruthy();
    const accepted = await request.post("/api/v1/invitations/accept", { data: { token: (await invited.json()).data.invitation.token, displayName: name, password } });
    expect(accepted.ok()).toBeTruthy();
    staff[role] = staffEmail;
  }

  // The sales desk (the owner here) records the sale and sends it to the cashier.
  const owner = await signIn(browser, email);
  await owner.page.goto("/app/sales/new");
  await expect(owner.page.getByRole("button", { name: "Send to cashier" })).toBeVisible();
  await owner.page.getByLabel("Find a product").fill("peak");
  await owner.page.getByRole("button", { name: /Peak Milk/ }).click();
  await owner.page.getByLabel("How many").fill("3");
  await owner.page.getByRole("button", { name: "Owing (credit)" }).click();
  await owner.page.getByLabel("Phone number or name").fill("Musa");
  await owner.page.getByRole("button", { name: "Find", exact: true }).click();
  await owner.page.getByRole("button", { name: "Alhaji Musa" }).click();
  await owner.page.getByLabel("Comment for the cashier and store").fill("Regular customer, pays every Friday");
  await owner.page.getByRole("button", { name: "Send to cashier" }).click();
  await expect(owner.page.getByRole("heading", { name: "R-000001" })).toBeVisible();
  await expect(owner.page.getByText("Waiting for payment").first()).toBeVisible();
  await expect(owner.page.getByText(/Recorded by Ada Owner/)).toBeVisible();

  // The cashier sees it waiting, takes part payment and gives credit for the rest.
  const cashier = await signIn(browser, staff.CASHIER as string);
  await expect(cashier.page.getByTestId("home-toCollect")).toContainText("1");
  await cashier.page.getByTestId("home-toCollect").click();
  await cashier.page.getByRole("link", { name: /R-000001/ }).click();
  await expect(cashier.page.getByText("Take payment: ₦1,350.00")).toBeVisible();
  await expect(cashier.page.getByText("Credit limit ₦50,000.00. Owes ₦0.00 now.")).toBeVisible();
  await cashier.page.getByLabel("Cash paid now").fill("500");
  await expect(cashier.page.getByText("₦850.00 will be owed on credit.")).toBeVisible();
  await cashier.page.getByLabel("Date they will pay").fill("2099-01-31");
  await cashier.page.getByLabel("Comment: why credit, and how they will pay").fill("Paid part in cash, balance on Friday");
  await cashier.page.getByRole("button", { name: "Give credit" }).click();
  await expect(cashier.page.getByText("Waiting for goods").first()).toBeVisible();
  await expect(cashier.page.getByText(/Credit given by Ngozi Cashier/)).toBeVisible();

  // The store keeper is told, sees what to give out without amounts, and marks it done.
  const store = await signIn(browser, staff.INVENTORY as string);
  await expect(store.page.getByTestId("notification-count")).toHaveText("1");
  await store.page.getByRole("link", { name: /Notifications/ }).click();
  await store.page.getByRole("link", { name: /R-000001 was given credit by Ngozi Cashier/ }).click();
  await expect(store.page.getByText("3 tins")).toBeVisible();
  await expect(store.page.getByText(/₦\d/)).toHaveCount(0);
  await expect(store.page.getByText("Paid part in cash, balance on Friday")).toBeVisible();
  await store.page.getByLabel("Comment from the store").fill("Loaded into the customer's bus");
  await store.page.getByRole("button", { name: "Goods given out" }).click();
  await expect(store.page.getByText("Completed").first()).toBeVisible();

  // Back at the sales desk: everything is on the sale, and stock went down only when the goods left.
  await owner.page.reload();
  await expect(owner.page.getByText("Completed").first()).toBeVisible();
  await expect(owner.page.getByText(/Goods given out by Tunde Store/)).toBeVisible();
  await expect(owner.page.getByText("Loaded into the customer's bus")).toBeVisible();
  await expect(owner.page.getByText("Regular customer, pays every Friday")).toBeVisible();
  await owner.page.getByLabel("Add a comment").fill("Thanks, team");
  await owner.page.getByRole("button", { name: "Post" }).click();
  await expect(owner.page.getByText("Thanks, team")).toBeVisible();
  const stock = (await (await request.get(`/api/v1/products/${productId}`, { headers })).json()).data.product.stock.quantity;
  expect(stock).toBe("93000");
  for (const person of [owner, cashier, store]) await person.context.close();
});
