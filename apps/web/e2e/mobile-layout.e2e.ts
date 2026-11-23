import { expect, test, type Page } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

/**
 * Small Android screens (ADR-044). Every main screen is opened at 320 and 360 pixels wide, with real records, and
 * checked for sideways scrolling and for controls too small to tap. 320 px is the narrowest common Android width.
 */

const SCREENS = [
  "/app",
  "/app/sales/new",
  "/app/sales",
  "/app/stock",
  "/app/customers",
  "/app/debtors",
  "/app/money",
  "/app/money/cash",
  "/app/suppliers",
  "/app/jobs",
  "/app/settings",
  "/app/staff",
  "/app/notifications",
];

/** Controls the person taps: at least 40 px tall (44 is the target; 40 allows dense lists). Links inside text are left out. */
async function problems(page: Page) {
  return page.evaluate(() => {
    const issues: string[] = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) {
      const wide = [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((element) => element.getBoundingClientRect().right > doc.clientWidth + 1 && getComputedStyle(element).position !== "fixed")
        .filter((element) => !element.closest("[data-scroll-x]"))
        .slice(0, 3)
        .map((element) => `${element.tagName.toLowerCase()}${element.dataset.testid ? `[${element.dataset.testid}]` : ""}.${String(element.className).split(" ").slice(0, 3).join(".")}`);
      if (wide.length) issues.push(`scrolls sideways (${doc.scrollWidth}px): ${wide.join(", ")}`);
    }
    const controls = [...document.querySelectorAll<HTMLElement>("button, a[href], input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea, [role=button]")];
    for (const control of controls) {
      const box = control.getBoundingClientRect();
      // Visually hidden inputs (1 px) sit behind a visible control that is checked instead.
      if (box.width <= 2 || box.height <= 2) continue;
      const style = getComputedStyle(control);
      if (style.visibility === "hidden" || style.display === "none") continue;
      // A link inside a sentence is sized by the text around it.
      if (control.tagName === "A" && control.parentElement && ["P", "LI", "SPAN"].includes(control.parentElement.tagName) && (control.parentElement.textContent ?? "").trim().length > (control.textContent ?? "").trim().length + 3) continue;
      if (box.height < 40) issues.push(`small control (${Math.round(box.width)}×${Math.round(box.height)}): ${control.tagName.toLowerCase()} "${(control.getAttribute("aria-label") ?? control.textContent ?? "").trim().slice(0, 40)}"`);
    }
    return issues;
  });
}

for (const width of [320, 360]) {
  test(`main screens fit a ${width} px phone with controls big enough to tap`, async ({ page, request }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 720 });
    const { email } = await shop(request);
    await signIn(page, email);
    const found: string[] = [];
    for (const screen of SCREENS) {
      await page.goto(screen);
      await page.waitForLoadState("networkidle");
      for (const issue of await problems(page)) found.push(`${screen}: ${issue}`);
    }
    expect([...new Set(found)]).toEqual([]);
  });
}
