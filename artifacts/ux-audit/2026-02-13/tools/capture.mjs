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
    out: get('--out') ?? path.resolve('artifacts/ux-audit/2026-02-13/run-latest'),
    maxSessions: Number(get('--sessions') ?? '20'),
    loadOlderLimit: Number(get('--load-older-limit') ?? '40'),
    expandClusterPasses: Number(get('--expand-clusters') ?? '6'),
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
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  if (await dialog.count()) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
  }

  const closeSession = page.locator('button[aria-label="Close session inspector"]');
  if (await closeSession.count()) {
    await closeSession.click({ force: true }).catch(() => {});
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

async function resolvePanelSection(anchor) {
  // Find nearest ancestor <section> for stable screenshots.
  try {
    const section = anchor.locator('xpath=ancestor::section[1]');
    if (await section.count()) return section.first();
  } catch {
    // ignore
  }
  return anchor.first();
}

async function ensureDashboardActivityView(page, shotsDir) {
  // If onboarding, enter offline mode so the dashboard loads.
  const onboardingHeading = page.getByRole('heading', { name: 'Connect your workspace' });
  if (await onboardingHeading.count()) {
    const offlineBtn = page.getByRole('button', { name: 'Continue offline' });
    const demoBtn = page.getByRole('button', { name: 'Explore demo dashboard' });
    if (await offlineBtn.count()) {
      await offlineBtn.click({ force: true }).catch(() => {});
    } else if (await demoBtn.count()) {
      await demoBtn.click({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(shotsDir, '01-after-offline-click.png') });
  }

  // Force dashboard view = Activity.
  const viewToggle = page.getByRole('group', { name: 'Dashboard view' }).first();
  if (await viewToggle.count()) {
    await viewToggle.getByRole('button', { name: 'Activity' }).click({ force: true }).catch(() => {});
    await page.waitForTimeout(250);
  }

  // Wait for Activity heading.
  await page.getByRole('heading', { name: 'Activity' }).waitFor({ timeout: 60_000 });
}

async function expandAllClusters(activityPanel, seenKeys) {
  const toggles = activityPanel.locator('button').filter({ hasText: 'first seen' });
  const n = await toggles.count();
  for (let i = 0; i < n; i += 1) {
    const btn = toggles.nth(i);
    const label = (await safeText(btn)) || (await btn.getAttribute('aria-label')) || '';
    const key = label.replace(/\s+/g, ' ').trim();
    if (!key) continue;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    await btn.click({ force: true }).catch(() => {});
    await activityPanel.page().waitForTimeout(80);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = path.resolve(args.out);
  const shotsDir = path.join(outDir, 'shots');
  const cardsDir = path.join(shotsDir, 'activity-cards');
  const detailsDir = path.join(shotsDir, 'activity-details');
  const sessionsDir = path.join(shotsDir, 'sessions');

  await mkdir(cardsDir, { recursive: true });
  await mkdir(detailsDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });

  const execPath = chromeExecutablePath();
  const browser = await chromium.launch({
    headless: true,
    ...(execPath ? { executablePath: execPath } : null),
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(60_000);

  // /orgx/live keeps SSE open; avoid waiting for networkidle.
  await page.goto(args.url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await disableAnimations(page);
  await closeAnyOverlays(page);

  await page.screenshot({ path: path.join(shotsDir, '00-initial.png') });

  await ensureDashboardActivityView(page, shotsDir);
  await closeAnyOverlays(page);

  const agentsHeading = page.getByRole('heading', { name: 'Agents / Chats' });
  const activityHeading = page.getByRole('heading', { name: 'Activity' });

  const agentsPanel = await resolvePanelSection(agentsHeading);
  const activityPanel = await resolvePanelSection(activityHeading);

  // Expand all agent groups (best effort).
  const expandAll = agentsPanel.getByRole('button', { name: 'Expand all' });
  if (await expandAll.count()) {
    await expandAll.click({ force: true }).catch(() => {});
  }

  // Prefer History = All (max coverage).
  const historyAll = agentsPanel.getByRole('button', { name: 'All' });
  if (await historyAll.count()) {
    await historyAll.click({ force: true }).catch(() => {});
    await page.waitForTimeout(250);
  }

  // Load older activity pages.
  const clusterSeen = new Set();
  for (let pass = 0; pass < args.expandClusterPasses; pass += 1) {
    await expandAllClusters(activityPanel, clusterSeen);
  }

  for (let iter = 0; iter < args.loadOlderLimit; iter += 1) {
    await closeAnyOverlays(page);

    // Expand clusters before deciding whether to load older again.
    for (let pass = 0; pass < args.expandClusterPasses; pass += 1) {
      await expandAllClusters(activityPanel, clusterSeen);
    }

    const loadOlder = activityPanel.getByRole('button', { name: /Load older/i });
    if (!(await loadOlder.count())) break;

    let disabled = true;
    try {
      disabled = await loadOlder.isDisabled();
    } catch {
      disabled = true;
    }
    if (disabled) break;

    await loadOlder.click({ force: true }).catch(() => {});
    await page.waitForTimeout(900);
  }

  // Final cluster expansion after last load.
  for (let pass = 0; pass < args.expandClusterPasses; pass += 1) {
    await expandAllClusters(activityPanel, clusterSeen);
  }

  await page.screenshot({ path: path.join(shotsDir, '02-ready.png') });

  const activitySelector = 'button[aria-label^="Open activity details for "]';
  const activityButtons = activityPanel.locator(activitySelector);
  const totalActivities = await activityButtons.count();

  const activities = [];

  for (let i = 0; i < totalActivities; i += 1) {
    await closeAnyOverlays(page);

    const btn = activityPanel.locator(activitySelector).nth(i);
    await btn.scrollIntoViewIfNeeded();

    const ariaLabel = (await btn.getAttribute('aria-label')) ?? '';

    const cardShotRel = path.join('shots', 'activity-cards', `card-${pad(i + 1, 4)}.png`);
    const cardShotAbs = path.join(outDir, cardShotRel);
    await btn.screenshot({ path: cardShotAbs }).catch(async () => {
      await page.screenshot({ path: cardShotAbs }).catch(() => {});
    });

    await btn.click({ force: true }).catch(() => {});

    const modal = page.locator('[role="dialog"][aria-modal="true"]').first();
    const header = modal.getByText('Activity Detail', { exact: false });
    const detailShotRel = path.join('shots', 'activity-details', `detail-${pad(i + 1, 4)}.png`);
    const detailShotAbs = path.join(outDir, detailShotRel);

    const opened = await header
      .waitFor({ timeout: 12_000 })
      .then(() => true)
      .catch(() => false);

    let headline = '';
    let meta = '';

    if (opened) {
      headline = await safeText(modal.locator('h3').first());
      meta = await safeText(modal.locator('p').first());
      await modal.screenshot({ path: detailShotAbs }).catch(async () => {
        await page.screenshot({ path: detailShotAbs }).catch(() => {});
      });

      const close = modal.locator('button[aria-label="Close activity detail"]');
      if (await close.count()) {
        await close.click({ force: true }).catch(() => page.keyboard.press('Escape'));
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
      await modal.waitFor({ state: 'detached', timeout: 3_000 }).catch(() => {});
    } else {
      await page.screenshot({ path: detailShotAbs }).catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      await modal.waitFor({ state: 'detached', timeout: 1_000 }).catch(() => {});
    }

    activities.push({
      index: i + 1,
      ariaLabel,
      cardScreenshot: cardShotRel,
      detail: opened
        ? { headline, meta, screenshot: detailShotRel }
        : { error: 'detail_open_timeout', screenshot: detailShotRel },
    });
  }

  // Sessions: attempt to click through up to N sessions.
  const sessions = [];
  const visited = new Set();

  const agentInfoButtons = agentsPanel
    .locator('button[aria-label^="View "]')
    .filter({ hasText: '' });

  const agentCount = await agentInfoButtons.count();

  for (let a = 0; a < agentCount; a += 1) {
    if (sessions.length >= args.maxSessions) break;

    await closeAnyOverlays(page);

    const infoBtn = agentInfoButtons.nth(a);
    const infoLabel = (await infoBtn.getAttribute('aria-label')) ?? '';
    await infoBtn.scrollIntoViewIfNeeded();
    await infoBtn.click({ force: true }).catch(() => {});

    const modal = page.locator('[role="dialog"][aria-modal="true"]').first();
    await modal.waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {});

    // In AgentDetailModal, the sessions list buttons have a border and contain a status dot.
    const sessionButtons = modal.locator('button.w-full.rounded-lg').filter({ has: modal.locator('span.h-2.w-2') });

    // Expand "show more" if present.
    const showMore = modal.getByRole('button', { name: /Show \d+ more/i });
    if (await showMore.count()) {
      await showMore.click({ force: true }).catch(() => {});
      await page.waitForTimeout(250);
    }

    const n = await sessionButtons.count();
    for (let s = 0; s < n; s += 1) {
      if (sessions.length >= args.maxSessions) break;

      await closeAnyOverlays(page);

      // Modal may have been closed by a prior session click; re-open if needed.
      if (!(await modal.count())) break;

      const btn = sessionButtons.nth(s);
      await btn.scrollIntoViewIfNeeded();
      const pickText = await safeText(btn);
      const key = `${infoLabel}::${pickText}`.slice(0, 280);
      if (visited.has(key)) continue;
      visited.add(key);

      const pickShotRel = path.join('shots', 'sessions', `picker-${pad(sessions.length + 1, 3)}.png`);
      const pickShotAbs = path.join(outDir, pickShotRel);
      await btn.screenshot({ path: pickShotAbs }).catch(async () => {
        await page.screenshot({ path: pickShotAbs }).catch(() => {});
      });

      await btn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(250);

      // Thread view in the activity panel.
      const backToTimeline = page.getByRole('button', { name: /Back to timeline/i });
      const threadReady = await backToTimeline
        .waitFor({ timeout: 12_000 })
        .then(() => true)
        .catch(() => false);

      const threadShotRel = path.join('shots', 'sessions', `thread-${pad(sessions.length + 1, 3)}.png`);
      const threadShotAbs = path.join(outDir, threadShotRel);
      if (threadReady) {
        const threadPanel = await resolvePanelSection(backToTimeline);
        await threadPanel.screenshot({ path: threadShotAbs }).catch(async () => {
          await page.screenshot({ path: threadShotAbs }).catch(() => {});
        });
      } else {
        await page.screenshot({ path: threadShotAbs }).catch(() => {});
      }

      // Session drawer (desktop right panel).
      const closeDrawer = page.locator('button[aria-label="Close session inspector"]');
      await closeDrawer.waitFor({ timeout: 12_000 }).catch(() => {});
      const drawer = page.locator('div.fixed.inset-y-0.right-0').first();
      const drawerText = await safeText(drawer);

      const drawerShotRel = path.join('shots', 'sessions', `drawer-${pad(sessions.length + 1, 3)}.png`);
      const drawerShotAbs = path.join(outDir, drawerShotRel);
      await drawer.screenshot({ path: drawerShotAbs }).catch(async () => {
        await page.screenshot({ path: drawerShotAbs }).catch(() => {});
      });

      if (await closeDrawer.count()) {
        await closeDrawer.click({ force: true }).catch(() => {});
      }

      // Back out of thread view.
      if (await backToTimeline.count()) {
        await backToTimeline.click({ force: true }).catch(() => {});
      }
      await page.waitForTimeout(200);

      sessions.push({
        index: sessions.length + 1,
        agentPicker: { label: infoLabel, text: pickText, screenshot: pickShotRel },
        threadScreenshot: threadShotRel,
        drawerScreenshot: drawerShotRel,
        drawerText,
      });

      // Re-open agent modal for additional sessions if it was closed.
      if (!(await modal.count())) {
        await infoBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(250);
      }
    }

    // Close modal if still open.
    const close = page.getByRole('button', { name: 'Close detail' });
    if (await close.count()) {
      await close.click({ force: true }).catch(() => page.keyboard.press('Escape'));
      await page.waitForTimeout(200);
    } else {
      await page.keyboard.press('Escape').catch(() => {});
    }
  }

  const data = {
    generatedAt: new Date().toISOString(),
    url: args.url,
    totals: {
      activityItems: totalActivities,
      clusterTogglesClicked: clusterSeen.size,
      sessionsAudited: sessions.length,
      sessionsTarget: args.maxSessions,
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
