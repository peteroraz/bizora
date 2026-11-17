import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const shots = "/opt/cursor/artifacts/sprint-3b";

test.use({ viewport: { width: 360, height: 800 } });

async function shot(page: import("@playwright/test").Page, name: string) {
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
}

test("public pages render for a logged-out visitor", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Know your money/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Privacy" })).toBeVisible();
  await shot(page, "public-home-360");
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, "public-home-desktop");
  await page.setViewportSize({ width: 360, height: 800 });

  await page.goto("/privacy");
  await expect(page.getByText("Draft — to be reviewed by counsel")).toBeVisible();
  await expect(page.getByText("Nigeria Data Protection Act 2023").first()).toBeVisible();
  await page.goto("/terms");
  await expect(page.getByRole("heading", { name: "Terms" })).toBeVisible();
  await expect(page.getByText("Nigeria Data Protection Act 2023").first()).toBeVisible();
});

test("onboarding, customers, follow-ups, and csv import", async ({ page }) => {
  const email = `ngozi.${Date.now()}@bizora.test`;
  const password = "LocalOnly!Passw0rd";
  const organization = `Okafor ${Date.now()}`;

  await page.goto("/register");
  await page.getByLabel("Your name").fill("Ngozi Okafor");
  await page.getByLabel("Business name").fill(organization);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create your business" }).click();

  await expect(page.getByRole("heading", { name: "What kind of business do you run?" })).toBeVisible();
  await shot(page, "onboarding-360");
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, "onboarding-desktop");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Shop number").fill("B12");
  await page.getByLabel("Line or block").fill("4");
  await page.getByLabel("Market or plaza").fill("Main Market");
  await page.getByLabel("City").fill("Onitsha");
  const state = page.getByRole("combobox", { name: "State" });
  await state.click();
  await state.fill("Anambra");
  await page.getByRole("option", { name: "Anambra", exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Provisions" }).click();
  await page.getByLabel("Anything else?").fill("Rice");
  await page.getByRole("button", { name: "Finish setup" }).click();

  await expect(page.getByRole("heading", { name: /Welcome, Ngozi Okafor/ })).toBeVisible();
  await expect(page.getByTestId("home-checklist")).toContainText("Add your products");
  await expect(page.getByText("Follow-ups due today", { exact: true })).toBeVisible();
  await shot(page, "home-360");

  await page.goto("/");
  await expect(page).toHaveURL(/\/app$/);

  // Customers sits under More for owners (the bottom bar keeps Sales, Stock and Debtors).
  await page.goto("/app/customers");
  await page.getByRole("link", { name: "Add customer" }).click();
  await page.getByLabel("Name").fill("Ada Okeke");
  await page.getByRole("textbox", { name: "Phone", exact: true }).fill("08031234567");
  await page.getByRole("button", { name: "+ Email, notes and address" }).click();
  await page.getByLabel("Shop number").fill("B12");
  await page.getByLabel("Line or block").fill("4");
  await page.getByLabel("Market or plaza").fill("Main Market");
  await page.getByLabel("City").fill("Onitsha");
  const customerState = page.getByRole("combobox", { name: "State" });
  await customerState.click();
  await customerState.fill("Anambra");
  await page.getByRole("option", { name: "Anambra", exact: true }).click();
  await page.getByRole("button", { name: "Save customer" }).click();
  await expect(page.getByRole("heading", { name: "Ada Okeke" })).toBeVisible();
  await expect(page.getByText("Shop B12, Line 4, Main Market, Onitsha, Anambra")).toBeVisible();

  await page.getByRole("textbox", { name: "Note", exact: true }).fill("Called about rice");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByText("Called about rice")).toBeVisible();

  await page.getByRole("tab", { name: "Follow-ups" }).click();
  await page.getByRole("textbox", { name: "Reason", exact: true }).fill("Check the rice order");
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  await page.getByLabel("Day").fill(today);
  await page.getByRole("button", { name: "Add follow-up" }).click();
  await expect(page.getByText("Check the rice order")).toBeVisible();
  const whatsapp = page.getByRole("link", { name: "Chat on WhatsApp" });
  await expect(whatsapp).toHaveAttribute("href", /wa\.me\/2348031234567/);
  await expect(whatsapp).toHaveAttribute("href", /text=/);
  await shot(page, "customer-360");

  await page.goto("/app");
  await expect(page.getByRole("link", { name: "Ada Okeke" })).toBeVisible();
  await expect(page.getByText("Check the rice order")).toBeVisible();
  await shot(page, "home-followups-360");

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/app");
  await expect(page.getByRole("link", { name: "Ada Okeke" })).toBeVisible();
  await shot(page, "home-desktop");
  await page.goto("/app/customers");
  await expect(page.getByRole("link", { name: "Ada Okeke" })).toBeVisible();
  await shot(page, "customers-desktop");
  await page.setViewportSize({ width: 360, height: 800 });
  await shot(page, "customers-360");
  await page.getByRole("link", { name: "Ada Okeke" }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, "customer-desktop");
  await page.setViewportSize({ width: 360, height: 800 });

  await page.goto("/app/customers/import");
  await page.getByLabel("CSV file").setInputFiles({
    name: "customers.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "name,phone,email,notes\nBola,08032345678,bola@shop.test,Beans\nChidi,08033456789,chidi@shop.test,Oil\nIfe,08035551111,ife@shop.test,Yam\n",
    ),
  });
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText("Will add")).toHaveCount(3);
  await page.getByRole("button", { name: "Import valid rows" }).click();
  await expect(page.getByText("Added 3 and updated 0.")).toBeVisible();
  await page.goto("/app/customers");
  await expect(page.getByRole("link", { name: "Bola" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Chidi" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ife" })).toBeVisible();
});
