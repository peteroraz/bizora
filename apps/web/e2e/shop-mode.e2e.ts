import { expect, test } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test.use({ viewport: { width: 360, height: 780 } });

test("owner turns on Shop mode, staff sign in with a PIN, the device auto-locks, and revoking it signs staff out", async ({
  page,
  request,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `owner.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: {
      email,
      password,
      displayName: "Ngozi Owner",
      organizationName: `Ngozi Provisions ${suffix}`,
      countryCode: "NG",
      baseCurrencyCode: "NGN",
      timezone: "Africa/Lagos",
    },
  });
  expect(registered.ok()).toBeTruthy();
  const ownerToken = (await registered.json()).data.accessToken as string;
  const onboarded = await request.patch("/api/v1/onboarding", {
    headers: { authorization: `Bearer ${ownerToken}` },
    data: {
      countryCode: "NG",
      industryCode: "general-retail",
      baseCurrencyCode: "NGN",
      timezone: "Africa/Lagos",
      businessName: "Ngozi Provisions",
      branchName: "Main Market",
    },
  });
  expect(onboarded.ok()).toBeTruthy();

  // Owner signs in on the shop phone and adds a staff member.
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.goto("/app/staff");
  await expect(page.getByRole("heading", { name: "Staff", exact: true })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Chika");
  await page.getByLabel("PIN (4 to 6 digits)").fill("4821");
  await page.getByLabel("Type the PIN again").fill("4821");
  await page.getByRole("button", { name: "Add staff" }).click();
  await expect(page.getByText("Staff added.")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Chika" })).toContainText("Sales staff");

  // Turn on Shop mode on this device.
  await page.getByLabel("Device name").fill("Counter phone");
  await page.getByRole("button", { name: "Turn on Shop mode here" }).click();
  await expect(page).toHaveURL(/\/shop$/);

  // Staff picks their name and types the PIN on the pad.
  await expect(page.getByRole("heading", { name: "Who is selling?" })).toBeVisible();
  await page.getByRole("button", { name: /Chika/ }).click();
  await expect(page.getByRole("heading", { name: "Hello, Chika" })).toBeVisible();
  for (const digit of ["4", "8", "2", "2"]) await page.getByRole("button", { name: `Digit ${digit}` }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("That PIN is not correct.")).toBeVisible();
  for (const digit of ["4", "8", "2", "1"]) await page.getByRole("button", { name: `Digit ${digit}` }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("button", { name: "Lock this device and return to the staff list" })).toBeVisible();

  // Lock returns to the staff list.
  await page.getByRole("button", { name: "Lock this device and return to the staff list" }).click();
  await expect(page).toHaveURL(/\/shop$/);

  // Sign in again, then let the device sit idle: it locks itself.
  await page.clock.install();
  await page.getByRole("button", { name: /Chika/ }).click();
  for (const digit of ["4", "8", "2", "1"]) await page.getByRole("button", { name: `Digit ${digit}` }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await page.clock.fastForward("06:00");
  await expect(page).toHaveURL(/\/shop$/);

  // Staff signs in once more; the owner then removes the device from another phone.
  await page.getByRole("button", { name: /Chika/ }).click();
  for (const digit of ["4", "8", "2", "1"]) await page.getByRole("button", { name: `Digit ${digit}` }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);

  const devices = await request.get("/api/v1/shop-devices", { headers: { authorization: `Bearer ${ownerToken}` } });
  const deviceId = ((await devices.json()).data.items as { id: string }[])[0]?.id;
  const revoked = await request.post(`/api/v1/shop-devices/${deviceId}/revoke`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  expect(revoked.ok()).toBeTruthy();

  await page.reload();
  await expect(page).toHaveURL(/\/shop$/);
  await expect(page.getByRole("heading", { name: "Shop mode is off on this device" })).toBeVisible();
});
