import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { chromium } from 'playwright-core';

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (flag) => {
    const idx = args.indexOf(flag);
    if (idx === -1) return null;
    return args[idx + 1] ?? null;
  };
  return {
    url: get('--url') ?? 'http://127.0.0.1:18789/orgx/live',
    out: get('--out') ?? path.resolve('artifacts/ux-audit/2026-02-13'),
    maxSessions: Number(get('--sessions') ?? '20'),
    maxActivities: Number(get('--activities') ?? '0'), // 0 = all loaded
    loadOlderLimit: Number(get('--load-older-limit') ?? '80'),
  };
}

function chromeExecutablePath() {
  if (process.env.PLAYWRIGHT_CHROME_PATH) return process.env.PLAYWRIGHT_CHROME_PATH;
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  return null;
}

async function disableAnimations(page) {
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation: none !important;
        transition: none !important;
        scroll-behavior: auto !important;
      }
    `,
  });
}

async function closeAnyOverlays(page) {
  // Best-effort: close any modal overlays that can intercept pointer events.
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  if (await dialog.count()) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
  }

  const closeSession = page.locator('button[aria-label="Close session inspector"]');
  if (await closeSession.count()) {
    await closeSession.click().catch(() => {});
    await page.waitForTimeout(250);
  }
}

function pad(n, width) {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

async function safeText(locator) {
  try {
    const t = await locator.innerText();
    return String(t ?? '').trim();
  } catch {
    return '';
  }
}

async function resolvePanelSection(page, anchorLocator) {
  // Find a stable panel root for screenshots by walking up to the nearest <section>.
  // If the UI changes and no section exists, fall back to the anchor itself.
  try {
    const section = anchorLocator.locator('xpath=ancestor::section[1]');
    if (await section.count()) return section.first();
  } catch {
    // ignore
  }
  return anchorLocator.first();
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = path.resolve(args.out);
  await mkdir(outDir, { recursive: true });

  const execPath = chromeExecutablePath();
  const browser = await chromium.launch({
    headless: true,
    ...(execPath ? { executablePath: execPath } : null),
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.setDefaultTimeout(60_000);

  // /orgx/live keeps SSE connections open; waiting for networkidle can hang.
  await page.goto(args.url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await disableAnimations(page);
  await closeAnyOverlays(page);

  const shotsDir = path.join(outDir, 'shots');
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: path.join(shotsDir, '00-dashboard.png') });

  // If we're on the onboarding screen, enter demo/offline mode so the dashboard loads.
  const onboardingHeading = page.getByRole('heading', { name: 'Connect your workspace' });
  if (await onboardingHeading.count()) {
    const demoBtn = page.getByRole('button', { name: 'Explore demo dashboard' });
    const offlineBtn = page.getByRole('button', { name: 'Continue offline' });
    // Prefer offline first (uses local snapshot), then demo.
    if (await offlineBtn.count()) {
      await offlineBtn.click({ force: true }).catch(() => {});
    } else if (await demoBtn.count()) {
      await demoBtn.click({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(shotsDir, '01-after-demo-click.png') });
  }

  // Force the Activity dashboard view (user preference can persist as Mission Control).
  const dashboardViewToggle = page.getByRole('group', { name: 'Dashboard view' }).first();
  try {
    await dashboardViewToggle.waitFor({ timeout: 60_000 });
    await dashboardViewToggle.getByRole('button', { name: 'Activity' }).click({ force: true });
    await page.waitForTimeout(250);
  } catch {
    // Continue; the Activity panel wait below will fail with a useful screenshot.
  }

  // Anchor points (best effort; the dashboard may render slowly depending on gateway state).
  try {
    await page.getByRole('heading', { name: 'Activity' }).waitFor({ timeout: 60_000 });
  } catch {
    await page.screenshot({ path: path.join(shotsDir, '00-dashboard-not-ready.png') });
    throw new Error('Timed out waiting for Activity panel to render.');
  }

  const agentsPanel = await resolvePanelSection(
    page,
    page.getByRole('heading', { name: 'Agents / Chats' })
  );

  const activityPanel = await resolvePanelSection(
    page,
    page.getByRole('heading', { name: 'Activity' })
  );

  // Ensure agent groups expanded (best effort).
  const expandAll = agentsPanel.getByRole('button', { name: 'Expand all' });
  if (await expandAll.count()) {
    try {
      await expandAll.click();
    } catch {
      // ignore
    }
  }

  const activityButtons = activityPanel.locator('button[aria-label^="Open activity details for "]');

  // Load older until no longer available or no growth.
  for (let iter = 0; iter < args.loadOlderLimit; iter += 1) {
    await closeAnyOverlays(page);
    const loadOlder = activityPanel.getByRole('button', { name: /Load older/i });
    if (!(await loadOlder.count())) break;

    let disabled = true;
    try {
      disabled = await loadOlder.isDisabled();
    } catch {
      disabled = true;
    }
    if (disabled) break;

    const before = await activityButtons.count();
    try {
      await loadOlder.click({ timeout: 8_000, force: true });
    } catch {
      await closeAnyOverlays(page);
      break;
    }

    // Wait a bit for rendering.
    await page.waitForTimeout(900);

    const after = await activityButtons.count();
    if (after <= before) break;

    if (args.maxActivities > 0 && after >= args.maxActivities) break;
  }

  const totalActivities = await activityButtons.count();

  const cardsDir = path.join(shotsDir, 'activity-cards');
  const detailsDir = path.join(shotsDir, 'activity-details');
  await mkdir(cardsDir, { recursive: true });
  await mkdir(detailsDir, { recursive: true });

  const activities = [];

  for (let i = 0; i < totalActivities; i += 1) {
    const btn = activityButtons.nth(i);
    await btn.scrollIntoViewIfNeeded();

    const ariaLabel = (await btn.getAttribute('aria-label')) ?? '';
    const cardText = await safeText(btn);

    const cardShotRel = path.join('shots', 'activity-cards', `card-${pad(i + 1, 4)}.png`);
    const cardShotAbs = path.join(outDir, cardShotRel);
    try {
      await btn.screenshot({ path: cardShotAbs });
    } catch {
      await page.screenshot({ path: cardShotAbs });
    }

    activities.push({
      index: i + 1,
      ariaLabel,
      cardText,
      cardScreenshot: cardShotRel,
    });
  }

  // Open each activity item and capture its detail modal (more stable than Next/Prev navigation).
  if (totalActivities > 0) {
    const modal = page.locator('[role="dialog"][aria-modal="true"]').first();
    const closeModal = modal.locator('button[aria-label="Close activity detail"]');

    for (let i = 0; i < totalActivities; i += 1) {
      await closeAnyOverlays(page);
      const btn = activityPanel.locator('button[aria-label^="Open activity details for "]').nth(i);
      await btn.scrollIntoViewIfNeeded();
      await btn.click({ force: true }).catch(() => {});

      const detailHeader = modal.getByText('Activity Detail', { exact: false });
      try {
        await detailHeader.waitFor({ timeout: 12_000 });
      } catch (err) {
        const missingShotRel = path.join('shots', 'activity-details', `detail-missing-${pad(i + 1, 4)}.png`);
        const missingShotAbs = path.join(outDir, missingShotRel);
        await page.screenshot({ path: missingShotAbs }).catch(() => {});
        activities[i].detailError = err instanceof Error ? err.message : String(err);
        activities[i].detailMissingScreenshot = missingShotRel;
        // Best-effort: ensure we don't leave a half-open overlay around.
        await page.keyboard.press('Escape').catch(() => {});
        await modal.waitFor({ state: 'detached', timeout: 1_000 }).catch(() => {});
        continue;
      }

      const headline = await safeText(modal.locator('h3').first());
      const meta = await safeText(modal.locator('p').first());

      const detailShotRel = path.join('shots', 'activity-details', `detail-${pad(i + 1, 4)}.png`);
      const detailShotAbs = path.join(outDir, detailShotRel);
      try {
        await modal.screenshot({ path: detailShotAbs });
      } catch {
        await page.screenshot({ path: detailShotAbs });
      }

      activities[i].detail = { headline, meta, screenshot: detailShotRel };

      if (await closeModal.count()) {
        await closeModal.click({ force: true }).catch(() => page.keyboard.press('Escape'));
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }

      await modal.waitFor({ state: 'detached', timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(150);
    }
  }

  // Sessions: click through first N session rows.
  // Child session rows include a status dot span with aria-label={node.status}; use that as our anchor
  // to avoid clicking unrelated w-full buttons (e.g. "Load more").
  const sessionRowButtons = agentsPanel
    .locator('span[aria-label]')
    .locator('xpath=ancestor::button[1]');
  const sessionRowCount = await sessionRowButtons.count();
  const maxSessions = Math.min(args.maxSessions, sessionRowCount);

  const sessionsDir = path.join(shotsDir, 'sessions');
  await mkdir(sessionsDir, { recursive: true });

  const sessions = [];

  for (let i = 0; i < maxSessions; i += 1) {
    const row = sessionRowButtons.nth(i);
    await row.scrollIntoViewIfNeeded();

    const rowText = await safeText(row);

    const rowShotRel = path.join('shots', 'sessions', `session-row-${pad(i + 1, 3)}.png`);
    const rowShotAbs = path.join(outDir, rowShotRel);
    try {
      await row.screenshot({ path: rowShotAbs });
    } catch {
      await page.screenshot({ path: rowShotAbs });
    }

    await row.click({ force: true }).catch(() => {});

    // ThreadView shows a Back to timeline button.
    const backToTimeline = page.getByRole('button', { name: /Back to timeline/i });
    const threadReady = await backToTimeline
      .waitFor({ timeout: 12_000 })
      .then(() => true)
      .catch(() => false);

    const threadShotRel = path.join('shots', 'sessions', `thread-${pad(i + 1, 3)}.png`);
    const threadShotAbs = path.join(outDir, threadShotRel);
    if (threadReady) {
      const threadPanel = await resolvePanelSection(page, backToTimeline);
      await threadPanel.screenshot({ path: threadShotAbs });
    } else {
      await page.screenshot({ path: threadShotAbs }).catch(() => {});
    }

    // Session drawer (desktop) is a fixed panel with a close button.
    const closeDrawer = page.locator('button[aria-label="Close session inspector"]');
    await closeDrawer.waitFor({ timeout: 12_000 }).catch(() => {});

    const drawer = page.locator('div.fixed.inset-y-0.right-0').first();
    const drawerText = await safeText(drawer);

    const drawerShotRel = path.join('shots', 'sessions', `drawer-${pad(i + 1, 3)}.png`);
    const drawerShotAbs = path.join(outDir, drawerShotRel);
    try {
      await drawer.screenshot({ path: drawerShotAbs });
    } catch {
      // If the drawer isn't visible (e.g., narrow viewport), still capture full page.
      await page.screenshot({ path: drawerShotAbs });
    }

    // Close drawer to keep state stable.
    if (await closeDrawer.count()) {
      try {
        await closeDrawer.click();
      } catch {
        // ignore
      }
    }

    sessions.push({
      index: i + 1,
      rowText,
      rowScreenshot: rowShotRel,
      threadScreenshot: threadShotRel,
      drawerScreenshot: drawerShotRel,
      drawerText,
    });

    // Leave thread view so the next session click isn't fighting the activity panel state.
    if (await backToTimeline.count()) {
      try {
        await backToTimeline.click();
        await page.waitForTimeout(200);
      } catch {
        // ignore
      }
    }
  }

  const data = {
    generatedAt: new Date().toISOString(),
    url: args.url,
    totals: {
      activityItems: totalActivities,
      sessionRowsFound: sessionRowCount,
      sessionsAudited: maxSessions,
    },
    activities,
    sessions,
  };

  await writeFile(path.join(outDir, 'data.json'), JSON.stringify(data, null, 2));

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
