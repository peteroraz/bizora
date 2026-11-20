import { expect, test } from "@playwright/test";

const password = "LocalOnly!Passw0rd";

test.use({
  viewport: { width: 390, height: 844 },
  permissions: ["microphone"],
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
});

test("a mechanic says a job, checks the lines, saves it with a deposit, finishes it and takes the balance", async ({ page, request }) => {
  test.setTimeout(150_000);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `mechanic.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { email, password, displayName: "Emeka Owner", organizationName: `Emeka Motors ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  const headers = { authorization: `Bearer ${(await registered.json()).data.accessToken as string}` };
  expect(
    (await request.patch("/api/v1/onboarding", { headers, data: { countryCode: "NG", industryCode: "professional-services", businessType: "services", staffCountBand: "2-5", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Emeka Motors", branchName: "Workshop" } })).ok(),
  ).toBeTruthy();

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);
  // A service business sees Jobs in the bottom bar.
  await page.getByRole("link", { name: "Jobs" }).first().click();
  await expect(page.getByText("No jobs going on.")).toBeVisible();
  await page.getByRole("link", { name: "New job" }).click();

  // Say the job: the summary first, then the lines to check.
  await page.getByRole("button", { name: "Record voice note" }).click();
  await page.waitForTimeout(1_200);
  await page.getByRole("button", { name: /Stop/ }).click();
  await expect(page.getByTestId("job-summary")).toContainText("Mr Okeke's Toyota Camry had noisy brakes.");
  await expect(page.getByLabel("Customer name")).toHaveValue("Mr Okeke");
  await expect(page.getByLabel("What you are working on")).toHaveValue("Toyota Camry, LND 123 AB");
  await expect(page.getByTestId("job-line")).toHaveCount(3);
  await expect(page.getByLabel("Charge, line 1")).toHaveValue("15,000");
  await expect(page.getByLabel("What you paid, line 2")).toHaveValue("12,000");
  await expect(page.getByLabel("Deposit paid")).toHaveValue("10,000");

  // Take off the helper, add wheel alignment by hand, and save the brake pads as a regular job.
  await page.getByRole("button", { name: "Take off line 3" }).click();
  await page.getByRole("button", { name: "Add work done" }).click();
  await page.getByLabel("Description, line 3").fill("Wheel alignment");
  await page.getByLabel("Charge, line 3").fill("5000");
  await page.getByLabel("Save as a regular job, to pick it quickly next time").first().check();
  await expect(page.getByTestId("job-total")).toContainText("₦32,000.00");
  await page.getByRole("button", { name: "Save job" }).click();

  await expect(page.getByText("Job saved.")).toBeVisible();
  await expect(page.getByRole("heading", { name: /JOB-000001/ })).toBeVisible();
  await expect(page.getByTestId("job-left")).toHaveText("₦22,000.00");
  await expect(page.getByTestId("job-saved-lines")).toContainText("Engine oil");

  // Finish: the bill is made, the deposit taken off.
  await page.getByLabel("When the rest will be paid").fill(new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date(Date.now() + 7 * 86_400_000)));
  await page.getByRole("button", { name: "Finish and bill" }).click();
  await expect(page.getByText("Job finished and billed.")).toBeVisible();
  await expect(page.getByRole("link", { name: /Open the bill INV-/ })).toBeVisible();

  // The customer pays the rest later.
  await page.getByLabel("Payment", { exact: true }).fill("22000");
  await page.getByRole("button", { name: "Take payment" }).click();
  await expect(page.getByText("₦22,000.00 recorded.")).toBeVisible();
  await expect(page.getByTestId("job-left")).toHaveText("₦0.00");

  // The customer's record shows the job.
  await page.getByRole("link", { name: "Open the customer's record" }).click();
  await expect(page.getByTestId("customer-jobs")).toContainText("JOB-000001");
  await page.goto("/app/jobs?x=1");
  await page.getByRole("button", { name: "Finished" }).click();
  await expect(page.getByTestId("job-card")).toContainText("Mr Okeke");
});
