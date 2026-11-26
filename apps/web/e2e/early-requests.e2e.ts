import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

// A screen's first requests start from its HTML and are used, not repeated (ADR-072).

test("opening customers or stock asks for the list once, before the scripts have started", async ({ page, request }) => {
  const { email } = await shop(request);
  await signIn(page, email);

  for (const [screen, list] of [
    ["/app/customers", "/api/v1/customers?page=1"],
    ["/app/stock", "/api/v1/products?page=1"],
  ] as const) {
    const asked: string[] = [];
    const listen = (req: { url(): string }) => {
      const url = new URL(req.url());
      if (`${url.pathname}${url.search}` === list) asked.push(url.pathname);
    };
    page.on("request", listen);
    await page.goto(screen, { waitUntil: "networkidle" });
    page.off("request", listen);
    expect(asked, `${screen} asked for its list ${asked.length} times`).toHaveLength(1);
    // Started from the HTML: before the page's scripts had all loaded, which is when the screen itself would ask.
    const timing = await page.evaluate((path) => {
      const entry = performance.getEntriesByType("resource").find((item) => item.name.endsWith(path));
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      return { asked: entry?.startTime ?? Number.POSITIVE_INFINITY, loaded: navigation?.loadEventStart ?? 0 };
    }, list);
    expect(timing.asked, `${screen} asked at ${Math.round(timing.asked)} ms, page loaded at ${Math.round(timing.loaded)} ms`).toBeLessThan(timing.loaded);
    // The early answer is what the screen shows.
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
  await page.goto("/app/customers");
  await expect(page.getByText("Emeka Obi")).toBeVisible();
});

test("the email check banner is drawn with the page, and hiding it lasts across visits", async ({ page, request }) => {
  const { email } = await shop(request);
  await signIn(page, email);
  // In the page as sent, before any script runs.
  const html = await (await page.request.get("/app")).text();
  expect(html).toContain('data-testid="verify-banner"');
  await page.goto("/app");
  await page.getByTestId("verify-banner").getByRole("button", { name: "Hide for a week" }).click();
  await expect(page.getByTestId("verify-banner")).toHaveCount(0);
  expect((await page.context().cookies()).some((cookie) => cookie.name === "bizora_verify_banner_hidden")).toBe(true);
  expect(await (await page.request.get("/app")).text()).not.toContain('data-testid="verify-banner"');
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("verify-banner")).toHaveCount(0);
});
