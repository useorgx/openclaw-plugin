#!/usr/bin/env node
/**
 * Local dashboard connectivity probe.
 *
 * Opens http://127.0.0.1:18789/orgx/live and prints the connection badge text
 * plus any console errors. Useful when the UI appears stuck in "Reconnecting".
 */

import process from "node:process";
import { chromium } from "playwright-core";

const URL = process.env.ORGX_LIVE_URL ?? "http://127.0.0.1:18789/orgx/live";

function chromeExecutablePath() {
  if (process.env.PLAYWRIGHT_CHROME_PATH) return process.env.PLAYWRIGHT_CHROME_PATH;
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  return null;
}

async function main() {
  const executablePath = chromeExecutablePath();
  if (!executablePath) {
    throw new Error("No Chrome executable detected (set PLAYWRIGHT_CHROME_PATH).");
  }

  const browser = await chromium.launch({
    executablePath,
    headless: true,
  });

  const page = await browser.newPage();
  const consoleErrors = [];
  const requestFailures = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });

  page.on("requestfailed", (req) => {
    requestFailures.push({
      url: req.url(),
      failure: req.failure()?.errorText ?? "unknown",
    });
  });

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2_000);

  // Badge shows: Live / Reconnecting / Offline
  const badgeText = await page
    .locator("header")
    .getByText(/Live|Reconnecting|Offline/, { exact: false })
    .first()
    .innerText()
    .catch(() => null);

  // Give SSE a moment to stabilize.
  await page.waitForTimeout(8_000);

  const badgeTextAfter = await page
    .locator("header")
    .getByText(/Live|Reconnecting|Offline/, { exact: false })
    .first()
    .innerText()
    .catch(() => null);

  await page.waitForTimeout(60_000);

  const badgeTextAfter70s = await page
    .locator("header")
    .getByText(/Live|Reconnecting|Offline/, { exact: false })
    .first()
    .innerText()
    .catch(() => null);

  console.log(
    JSON.stringify(
      {
        ok: true,
        url: URL,
        badgeTextInitial: badgeText,
        badgeTextAfter10s: badgeTextAfter,
        badgeTextAfter70s,
        consoleErrors,
        requestFailures,
      },
      null,
      2
    )
  );

  await browser.close();
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(message);
  process.exit(1);
});
