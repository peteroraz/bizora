import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { shop, signIn } from "./voice-helpers";

test.use({ viewport: { width: 360, height: 780 } });

// With the speech model downloaded (CI fetches it), a recorded sentence is turned into words on the phone with the
// network off. The fake microphone plays a recording made with espeak-ng, a robot voice, not a Nigerian accent.
const modelReady = existsSync(join(process.cwd(), "public/voice/models")) && existsSync(join(process.cwd(), "e2e/fixtures/voice-sale.wav"));
test.skip(!modelReady, "speech model or recording not present (run voice:models and make the recording)");
test.use({
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${join(process.cwd(), "e2e/fixtures/voice-sale.wav")}`],
  },
});

test("downloads once, then hears a sale with no network", async ({ page, context, request }) => {
  test.setTimeout(300_000);
  const { email } = await shop(request);
  await context.grantPermissions(["microphone"]);
  await signIn(page, email);
  await page.goto("/app/sales/new?voice=1");
  await page.getByTestId("voice-download").click();
  await expect(page.getByTestId("voice-model-status")).toHaveText(/ready/, { timeout: 240_000 });

  await context.setOffline(true);
  await page.getByTestId("voice-start").click();
  // The recording is about five seconds and repeats; stop before the second time round.
  await page.waitForTimeout(5_500);
  await page.getByTestId("voice-stop").click();
  await expect(page.getByTestId("voice-review")).toBeVisible({ timeout: 120_000 });
  const heard = (await page.getByTestId("voice-transcript").inputValue()).toLowerCase();
  expect(heard).toContain("rice");
  await expect(page.getByTestId("voice-line").first()).toBeVisible();
});
