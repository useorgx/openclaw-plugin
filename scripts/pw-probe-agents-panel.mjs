import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://127.0.0.1:18789/orgx/live';

function chromeExecutablePath() {
  if (process.env.PLAYWRIGHT_CHROME_PATH) return process.env.PLAYWRIGHT_CHROME_PATH;
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  return null;
}

async function main() {
  const execPath = chromeExecutablePath();
  const browser = await chromium.launch({
    headless: true,
    ...(execPath ? { executablePath: execPath } : null),
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(60_000);

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const onboarding = page.getByRole('heading', { name: 'Connect your workspace' });
  if (await onboarding.count()) {
    const offline = page.getByRole('button', { name: 'Continue offline' });
    if (await offline.count()) {
      await offline.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1200);
    }
  }

  const agentsHeading = page.getByRole('heading', { name: 'Agents / Chats' });
  const activityHeading = page.getByRole('heading', { name: 'Activity' });

  const agentsPanel = agentsHeading.locator('xpath=ancestor::section[1]');

  const infoButtons = agentsPanel.locator('button[aria-label^="View "]');
  const dots = agentsPanel.locator('span[aria-label]');

  const expandAll = agentsPanel.getByRole('button', { name: 'Expand all' });
  if (await expandAll.count()) await expandAll.click({ force: true }).catch(() => {});
  await page.waitForTimeout(300);

  console.log(
    JSON.stringify(
      {
        hasAgentsHeading: (await agentsHeading.count()) > 0,
        hasActivityHeading: (await activityHeading.count()) > 0,
        infoButtons: await infoButtons.count(),
        sampleInfoLabel: (await infoButtons.count()) ? await infoButtons.nth(0).getAttribute('aria-label') : null,
        dots: await dots.count(),
        sampleDotLabel: (await dots.count()) ? await dots.nth(0).getAttribute('aria-label') : null,
      },
      null,
      2
    )
  );

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
