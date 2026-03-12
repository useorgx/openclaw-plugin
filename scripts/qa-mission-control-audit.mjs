#!/usr/bin/env node
/**
 * Mission Control comprehensive QA audit.
 * Walks every tab, sub-tab, button, and card state.
 * Captures screenshots + timing data + issues.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadChromium } from './qa-output-paths.mjs';

const BASE_URL = 'http://127.0.0.1:18789/orgx/live';
const WORKSPACE_ID = '7af01a51-49b1-47d8-98b9-91a198debca8';
const LIVE_URL = `${BASE_URL}?workspace_id=${WORKSPACE_ID}&command_center_id=${WORKSPACE_ID}&center=${WORKSPACE_ID}&cachebust=${Date.now()}`;

const OUT_DIR = join(import.meta.dirname, '..', 'qa-artifacts', 'mission-control-audit-2026-03-10');
mkdirSync(OUT_DIR, { recursive: true });

const issues = [];
const timings = [];
let screenshotIndex = 0;

function issue(severity, area, description, screenshot = null) {
  issues.push({ severity, area, description, screenshot, timestamp: new Date().toISOString() });
}

async function snap(page, label) {
  screenshotIndex++;
  const filename = `${String(screenshotIndex).padStart(2, '0')}-${label}.png`;
  await page.screenshot({ path: join(OUT_DIR, filename), fullPage: false });
  console.log(`  📸 ${filename}`);
  return filename;
}

async function timedAction(label, fn) {
  const start = Date.now();
  await fn();
  const ms = Date.now() - start;
  timings.push({ action: label, durationMs: ms });
  console.log(`  ⏱  ${label}: ${ms}ms`);
  return ms;
}

async function clickText(page, text, options = {}) {
  const el = await page.locator(`text="${text}"`).first();
  if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
    await el.click(options);
    return true;
  }
  return false;
}

async function run() {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // Track API responses
  const apiData = {};
  page.on('response', async (resp) => {
    const url = resp.url();
    if (resp.status() === 200) {
      try {
        if (url.includes('next-up')) apiData.nextUp = await resp.json();
        if (url.includes('mission-control/graph')) apiData.graph = await resp.json();
        if (url.includes('decisions') || url.includes('pending-decisions')) apiData.decisions = await resp.json();
        if (url.includes('sessions') || url.includes('active-sessions')) apiData.sessions = await resp.json();
      } catch { /* non-json */ }
    }
  });

  // ─── 1. Initial Load ─────────────────────────────────────────────
  console.log('\n═══ 1. INITIAL LOAD ═══');
  await timedAction('Page load', async () => {
    await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(6000);
  });
  const f01 = await snap(page, 'initial-load');

  // Check for loading dots / skeleton states
  const hasLoadingDots = await page.locator('.animate-pulse, [class*="skeleton"], [class*="shimmer"]').count();
  if (hasLoadingDots > 0) {
    issue('info', 'loading', `Found ${hasLoadingDots} loading/skeleton elements on initial load`, f01);
  }

  // ─── 2. Mission Control — In Progress Tab ─────────────────────────
  console.log('\n═══ 2. IN PROGRESS TAB ═══');

  // 2a. "All active" sub-filter
  console.log('  --- All active ---');
  await clickText(page, 'In Progress');
  await page.waitForTimeout(1500);
  await clickText(page, 'All active');
  await page.waitForTimeout(1500);
  const f02 = await snap(page, 'in-progress-all-active');

  // Check "All clear" empty state
  const allClear = await page.locator('text="All clear"').isVisible().catch(() => false);
  if (allClear) {
    issue('info', 'in-progress/all-active', 'Shows "All clear" empty state — 0 actively running workstreams', f02);
  }

  // Check "Review needs attention" button
  const reviewBtn = await page.locator('text="Review needs attention"').isVisible().catch(() => false);
  if (reviewBtn) {
    await clickText(page, 'Review needs attention');
    await page.waitForTimeout(1000);
    await snap(page, 'in-progress-review-needs-attention-clicked');
  }

  // 2b. "Needs attention" sub-filter
  console.log('  --- Needs attention ---');
  await clickText(page, 'Needs attention');
  await page.waitForTimeout(1500);
  const f04 = await snap(page, 'in-progress-needs-attention');

  // Look for decisions section
  const decisionsSection = await page.locator('text="DECISIONS"').isVisible().catch(() => false);
  if (decisionsSection) {
    const decisionsCount = await page.locator('text="DECISIONS"').locator('..').locator('..').textContent().catch(() => '');
    issue('info', 'in-progress/needs-attention', `Decisions section visible: ${decisionsCount.trim().slice(0, 80)}`, f04);
  }

  // Look for blocked & review-required slices
  const blockedSlices = await page.locator('text="BLOCKED & REVIEW-REQUIRED SLICES"').isVisible().catch(() => false);
  if (blockedSlices) {
    issue('info', 'in-progress/needs-attention', 'Blocked & Review-Required Slices section visible', f04);
  }

  // Click first decision card (Approve/Reject)
  const approveBtn = await page.locator('button:has-text("Approve")').first();
  if (await approveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    // Get the decision card text first
    const decisionCard = await approveBtn.locator('..').locator('..').textContent().catch(() => '');
    console.log(`  Found decision card: ${decisionCard.slice(0, 100)}`);

    // Click to open decision modal
    const decisionTitle = await page.locator('[class*="decision"] p, [class*="decision"] span').first().textContent().catch(() => null);
    // Try clicking the card area (not the approve button itself)
    const cardEl = await page.locator('div:has(button:has-text("Approve"))').first();
    if (await cardEl.isVisible().catch(() => false)) {
      // Click the title text to open modal
      const titleEl = await cardEl.locator('p').first();
      if (await titleEl.isVisible().catch(() => false)) {
        await titleEl.click();
        await page.waitForTimeout(1500);
        await snap(page, 'decision-modal-opened');

        // Check modal structure
        const signalIncomplete = await page.locator('text="SIGNAL INCOMPLETE"').isVisible().catch(() => false);
        if (signalIncomplete) {
          issue('medium', 'decisions', 'Decision modal shows SIGNAL INCOMPLETE — missing context for operator decision', null);
        }

        const waitingDays = await page.locator('text=/waiting.*days/i').textContent().catch(() => null);
        if (waitingDays) {
          issue('high', 'decisions', `Decision stale: ${waitingDays}`, null);
        }

        await snap(page, 'decision-modal-detail');

        // Check for notes section
        const noNotes = await page.locator('text="No notes yet"').isVisible().catch(() => false);
        if (noNotes) {
          issue('info', 'decisions', 'Decision has no notes — "No notes yet" empty state', null);
        }

        // Navigate with arrows if available
        const nextArrow = await page.locator('button[aria-label*="next"], button:has(svg) >> nth=1').first();
        if (await nextArrow.isVisible().catch(() => false)) {
          await nextArrow.click();
          await page.waitForTimeout(1000);
          await snap(page, 'decision-modal-next');
        }

        // Close modal
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
      }
    }
  }

  // Dismiss any lingering glass-panel overlays
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Click "Details" button on a blocked slice
  try {
    const detailsBtn = await page.locator('button:has-text("Details")').first();
    if (await detailsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await detailsBtn.click({ force: true, timeout: 5000 });
      await page.waitForTimeout(1500);
      await snap(page, 'blocked-slice-details-modal');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
  } catch (e) { console.log(`  ⚠ Details button blocked: ${e.message.slice(0, 80)}`); }

  // Click "Review choices" button on a blocked slice
  try {
    const reviewChoicesBtn = await page.locator('button:has-text("Review choices")').first();
    if (await reviewChoicesBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await reviewChoicesBtn.click({ force: true, timeout: 5000 });
      await page.waitForTimeout(1500);
      await snap(page, 'review-choices-modal');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
  } catch (e) { console.log(`  ⚠ Review choices blocked: ${e.message.slice(0, 80)}`); }

  // 2c. "Completed" sub-filter
  console.log('  --- Completed ---');
  await clickText(page, 'Completed');
  await page.waitForTimeout(1500);
  const f09 = await snap(page, 'in-progress-completed');

  const noCompleted = await page.locator('text="No completed work in this scope yet"').isVisible().catch(() => false);
  if (noCompleted) {
    issue('medium', 'in-progress/completed', 'Empty state: "No completed work in this scope yet." — 0 completed despite 52 needs-attention items', f09);
  }

  // ─── 3. Mission Control — Next Up Tab ─────────────────────────────
  console.log('\n═══ 3. NEXT UP TAB ═══');
  await clickText(page, 'Next Up');
  await page.waitForTimeout(2000);
  const f10 = await snap(page, 'next-up-queue');

  // Count cards
  const nextUpCards = await page.locator('article').count();
  console.log(`  Found ${nextUpCards} article cards`);

  // Check for "Queue" button
  const queueBtn = await page.locator('button:has-text("Queue")').first();
  if (await queueBtn.isVisible().catch(() => false)) {
    issue('info', 'next-up', 'Queue sort button visible', f10);
  }

  // Click first Next Up card to open modal
  const firstCard = await page.locator('article').first();
  if (await firstCard.isVisible().catch(() => false)) {
    const cardTitle = await firstCard.textContent().catch(() => '');
    console.log(`  First card: ${cardTitle.slice(0, 100)}`);

    await firstCard.click();
    await page.waitForTimeout(1500);
    const f11 = await snap(page, 'next-up-card-modal');

    // Check modal sections
    const nextWork = await page.locator('text="NEXT WORK"').isVisible().catch(() => false);
    const scopeSection = await page.locator('text=/COMPLETED|UPCOMING|IN PROGRESS|BLOCKED/').first().isVisible().catch(() => false);
    if (nextWork || scopeSection) {
      issue('info', 'next-up/modal', 'ScopeGroupedView rendering in modal (milestone breakdown)', f11);
    }

    // Check for Start/Drag/More buttons
    const startBtn = await page.locator('button:has-text("Start")').isVisible().catch(() => false);
    const dragBtn = await page.locator('button:has-text("Drag")').isVisible().catch(() => false);
    const moreBtn = await page.locator('button:has-text("More")').isVisible().catch(() => false);
    console.log(`  Modal buttons — Start: ${startBtn}, Drag: ${dragBtn}, More: ${moreBtn}`);

    // Scroll modal to see all content
    const scrollable = await page.locator('[class*="overflow-y-auto"]').first();
    if (await scrollable.isVisible().catch(() => false)) {
      await scrollable.evaluate((el) => el.scrollBy(0, 400));
      await page.waitForTimeout(500);
      await snap(page, 'next-up-card-modal-scrolled');
    }

    // Click "More" button if visible
    if (moreBtn) {
      const moreBtnEl = await page.locator('button:has-text("More")').first();
      await moreBtnEl.click();
      await page.waitForTimeout(800);
      await snap(page, 'next-up-card-more-menu');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    // Close modal
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  // Click second card if available
  const secondCard = await page.locator('article').nth(1);
  if (await secondCard.isVisible().catch(() => false)) {
    await secondCard.click();
    await page.waitForTimeout(1500);
    await snap(page, 'next-up-card-2-modal');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  // ─── 4. Activity Panel ────────────────────────────────────────────
  console.log('\n═══ 4. ACTIVITY TAB ═══');
  await clickText(page, 'Activity');
  await page.waitForTimeout(2000);
  const f15 = await snap(page, 'activity-tab');

  // Click first activity item
  const activityItem = await page.locator('[class*="activity"] article, [class*="Activity"] div[role="button"]').first();
  if (await activityItem.isVisible().catch(() => false)) {
    await activityItem.click();
    await page.waitForTimeout(1500);
    await snap(page, 'activity-item-expanded');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  // ─── 5. Agents Panel ──────────────────────────────────────────────
  console.log('\n═══ 5. AGENTS PANEL ═══');
  const collapseBtn = await page.locator('button:has-text("Collapse")').first();
  if (await collapseBtn.isVisible().catch(() => false)) {
    await snap(page, 'agents-panel-expanded');
    await collapseBtn.click();
    await page.waitForTimeout(800);
    await snap(page, 'agents-panel-collapsed');

    // Expand again
    const expandBtn = await page.locator('button:has-text("Expand")').first();
    if (await expandBtn.isVisible().catch(() => false)) {
      await expandBtn.click();
      await page.waitForTimeout(800);
    }
  }

  // Click "Launch" button
  const launchBtn = await page.locator('button:has-text("Launch")').first();
  if (await launchBtn.isVisible().catch(() => false)) {
    await launchBtn.click();
    await page.waitForTimeout(1500);
    await snap(page, 'agents-launch-modal');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  // ─── 6. AUTO toggle ───────────────────────────────────────────────
  console.log('\n═══ 6. AUTO TOGGLE ═══');
  await clickText(page, 'In Progress');
  await page.waitForTimeout(500);
  const autoToggle = await page.locator('text="AUTO"').locator('..').first();
  if (await autoToggle.isVisible().catch(() => false)) {
    const autoState = await autoToggle.textContent().catch(() => '');
    issue('info', 'auto-toggle', `AUTO toggle state: "${autoState.trim()}"`, null);
    await snap(page, 'auto-toggle-state');
  }

  // ─── 7. Loading state checks ──────────────────────────────────────
  console.log('\n═══ 7. LOADING STATE AUDIT ═══');

  // Check for any remaining loading indicators
  const spinners = await page.locator('.animate-spin').count();
  const pulses = await page.locator('.animate-pulse').count();
  const skeletons = await page.locator('[class*="skeleton"]').count();
  const loadingText = await page.locator('text=/Loading|loading/').count();
  console.log(`  Spinners: ${spinners}, Pulses: ${pulses}, Skeletons: ${skeletons}, Loading text: ${loadingText}`);

  if (spinners === 0 && pulses === 0 && skeletons === 0) {
    issue('medium', 'loading', 'No loading dot animation found anywhere — user sees abrupt state transitions with no feedback', null);
  }

  // ─── 8. Refresh button timing ─────────────────────────────────────
  console.log('\n═══ 8. REFRESH TIMING ═══');
  const refreshBtn = await page.locator('button:has-text("Refresh")').first();
  if (await refreshBtn.isVisible().catch(() => false)) {
    await timedAction('Refresh click → data loaded', async () => {
      await refreshBtn.click();
      await page.waitForTimeout(4000);
    });
    await snap(page, 'after-refresh');
  }

  // ─── 9. Notification bell ─────────────────────────────────────────
  console.log('\n═══ 9. NOTIFICATION BELL ═══');
  const notifBell = await page.locator('[aria-label*="notification"], button:has(text="1")').first();
  if (await notifBell.isVisible().catch(() => false)) {
    await notifBell.click();
    await page.waitForTimeout(1000);
    await snap(page, 'notification-panel');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // ─── 10. Settings gear ────────────────────────────────────────────
  console.log('\n═══ 10. SETTINGS ═══');
  const settingsBtn = await page.locator('[aria-label*="settings"], [aria-label*="Settings"], button:has(svg[class*="gear"])').first();
  if (await settingsBtn.isVisible().catch(() => false)) {
    await settingsBtn.click();
    await page.waitForTimeout(1000);
    await snap(page, 'settings-panel');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // ─── REPORT ───────────────────────────────────────────────────────
  console.log('\n═══ REPORT ═══');
  console.log(`\nScreenshots: ${screenshotIndex}`);
  console.log(`Timings: ${timings.length}`);
  console.log(`Issues: ${issues.length}`);

  const report = {
    generatedAt: new Date().toISOString(),
    screenshotCount: screenshotIndex,
    timings,
    issues,
    apiDataSummary: {
      nextUpItems: apiData.nextUp?.items?.length ?? null,
      nextUpSource: apiData.nextUp?.source ?? null,
      decisionsCount: Array.isArray(apiData.decisions) ? apiData.decisions.length : apiData.decisions?.items?.length ?? null,
      sessionsCount: Array.isArray(apiData.sessions) ? apiData.sessions.length : apiData.sessions?.items?.length ?? null,
    },
  };

  writeFileSync(join(OUT_DIR, 'audit-report.json'), JSON.stringify(report, null, 2));

  // Write markdown summary
  let md = `# Mission Control QA Audit — ${new Date().toISOString().split('T')[0]}\n\n`;
  md += `## Summary\n- **Screenshots**: ${screenshotIndex}\n- **Timings**: ${timings.length} actions measured\n- **Issues**: ${issues.length} found\n\n`;

  md += `## Timings\n`;
  for (const t of timings) {
    md += `| ${t.action} | ${t.durationMs}ms |\n`;
  }

  md += `\n## Issues\n`;
  for (const i of issues) {
    md += `### [${i.severity.toUpperCase()}] ${i.area}\n${i.description}\n`;
    if (i.screenshot) md += `Screenshot: ${i.screenshot}\n`;
    md += `\n`;
  }

  md += `## API Data\n`;
  md += `- Next Up items: ${report.apiDataSummary.nextUpItems}\n`;
  md += `- Next Up source: ${report.apiDataSummary.nextUpSource}\n`;
  md += `- Decisions: ${report.apiDataSummary.decisionsCount}\n`;
  md += `- Sessions: ${report.apiDataSummary.sessionsCount}\n`;

  writeFileSync(join(OUT_DIR, 'audit-report.md'), md);

  console.log(`\nIssues found:`);
  for (const i of issues) {
    const icon = i.severity === 'high' ? '🔴' : i.severity === 'medium' ? '🟡' : '🔵';
    console.log(`  ${icon} [${i.severity}] ${i.area}: ${i.description}`);
  }

  await browser.close();
  console.log(`\nDone. Artifacts in: ${OUT_DIR}`);
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
