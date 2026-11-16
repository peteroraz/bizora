import { expect, test, type Page } from "@playwright/test";

/**
 * Spec Addendum §8 budgets, checked in CI: initial JavaScript for core screens ≤ 170 KB gzipped, and Largest
 * Contentful Paint ≤ 2.5 s on a slow 4G connection with a mid-range phone CPU (Lighthouse "Slow 4G": 1.6 Mbps down,
 * 750 kbps up, 150 ms latency, CPU slowed 4x). Each screen is loaded in a fresh browser context, so nothing is cached.
 */
const JS_BUDGET_BYTES = 170 * 1024;
const LCP_BUDGET_MS = 2_500;
const password = "LocalOnly!Passw0rd";

test.use({ viewport: { width: 360, height: 780 } });

async function measure(page: Page, url: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.addInitScript(() => {
    (window as unknown as { __lcp: number }).__lcp = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) (window as unknown as { __lcp: number }).__lcp = entry.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  });
  await page.goto(url, { waitUntil: "networkidle" });
  // LCP is final once the page has settled; read it after a short pause.
  await page.waitForTimeout(500);
  const result = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const loaded = navigation?.loadEventStart || Number.POSITIVE_INFINITY;
    const scripts = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter(
      (entry) => entry.initiatorType === "script" || entry.name.endsWith(".js"),
    );
    // Initial JavaScript is what loads before the page's load event. Next.js then prefetches the code of linked
    // screens in the background; that is excluded here (reported separately as prefetchBytes).
    const initial = scripts.filter((entry) => entry.startTime < loaded);
    return {
      jsBytes: initial.reduce((sum, entry) => sum + (entry.encodedBodySize || entry.transferSize), 0),
      prefetchBytes: scripts.filter((entry) => entry.startTime >= loaded).reduce((sum, entry) => sum + (entry.encodedBodySize || entry.transferSize), 0),
      lcp: (window as unknown as { __lcp: number }).__lcp,
      path: location.pathname,
    };
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  return result;
}

test("core screens stay within the JavaScript and loading-speed budgets", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `budget.${suffix}@bizora.test`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { email, password, displayName: "Budget Owner", organizationName: `Budget ${suffix}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos" },
  });
  expect(registered.ok()).toBeTruthy();
  const token = (await registered.json()).data.accessToken as string;
  await request.patch("/api/v1/onboarding", {
    headers: { authorization: `Bearer ${token}` },
    data: { countryCode: "NG", industryCode: "general-retail", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", businessName: "Budget Shop", branchName: "Main" },
  });

  const results: { screen: string; jsKB: number; prefetchKB: number; lcpMs: number }[] = [];
  const check = async (screen: string, url: string, signIn: boolean) => {
    // Service workers are blocked so every file is downloaded and counted, as on a first visit.
    const context = await browser.newContext({ viewport: { width: 360, height: 780 }, serviceWorkers: "block" });
    const page = await context.newPage();
    if (signIn) {
      await page.goto("/login");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/app$/);
      // Measure the screen as a fresh visit: drop the cache that signing in warmed up.
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.clearBrowserCache");
    }
    const measured = await measure(page, url);
    results.push({
      screen,
      jsKB: Math.round(measured.jsBytes / 102.4) / 10,
      prefetchKB: Math.round(measured.prefetchBytes / 102.4) / 10,
      lcpMs: Math.round(measured.lcp),
    });
    await context.close();
  };

  await check("login", "/login", false);
  await check("shop PIN screen", "/shop", false);
  await check("home", "/app", true);
  await check("customers", "/app/customers", true);
  await check("stock", "/app/stock", true);
  await check("quick sale", "/app/sales/new", true);

  console.log(JSON.stringify(results, null, 2));
  for (const result of results) {
    expect.soft(result.jsKB * 1024, `${result.screen}: ${result.jsKB} KB of JavaScript`).toBeLessThanOrEqual(JS_BUDGET_BYTES);
    expect.soft(result.lcpMs, `${result.screen}: LCP ${result.lcpMs} ms`).toBeLessThanOrEqual(LCP_BUDGET_MS);
  }
});
