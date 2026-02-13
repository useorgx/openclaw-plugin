import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://127.0.0.1:18789/orgx/live';

function chromeExecutablePath() {
  if (process.env.PLAYWRIGHT_CHROME_PATH) return process.env.PLAYWRIGHT_CHROME_PATH;
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return null;
}

async function main() {
  const execPath = chromeExecutablePath();
  const browser = await chromium.launch({ headless: true, ...(execPath ? { executablePath: execPath } : null) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(60_000);

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const offlineBtn = page.getByRole('button', { name: 'Continue offline' });
  if (await offlineBtn.count()) {
    await offlineBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1200);
  }

  const agentsHeading = page.getByRole('heading', { name: 'Agents / Chats' });
  const agentsPanel = agentsHeading.locator('xpath=ancestor::section[1]');

  const expandAll = agentsPanel.getByRole('button', { name: 'Expand all' });
  if (await expandAll.count()) await expandAll.click({ force: true }).catch(() => {});

  const infoButtons = agentsPanel.locator('button[aria-label^="View "]');
  const infoCount = await infoButtons.count();

  console.log(JSON.stringify({ infoCount }, null, 2));
  if (!infoCount) {
    await browser.close();
    return;
  }

  await infoButtons.nth(0).click({ force: true });

  const modal = page.locator('[role="dialog"][aria-modal="true"]').first();
  await modal.waitFor({ state: 'visible', timeout: 12_000 });

  const sessionButtons = modal
    .locator('button')
    .filter({ has: modal.locator('span.h-2.w-2') })
    .filter({ has: modal.locator('p') });

  const sessionCount = await sessionButtons.count();
  const firstText = sessionCount ? (await sessionButtons.nth(0).innerText()).replace(/\s+/g, ' ').trim() : null;

  console.log(JSON.stringify({ sessionCount, firstText }, null, 2));

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
