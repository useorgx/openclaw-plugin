#!/usr/bin/env node
/**
 * Visual verification script — captures screenshots of all key dashboard surfaces.
 * Run: node scripts/visual-verify.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join } from 'path';

const BASE_URL = 'http://127.0.0.1:18789/orgx/live';
const OUT_DIR = join(import.meta.dirname, '..', 'docs', 'qa', '2026-02-19', 'phase2-audit');

mkdirSync(OUT_DIR, { recursive: true });

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  console.log('Navigating to dashboard...');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // ── Dismiss the first-run checklist if present ──
  const dismissBtn = page.locator('button:visible').filter({ hasText: /Don.t show again|Not now|Dismiss|Close/i });
  if (await dismissBtn.count() > 0) {
    console.log('Dismissing first-run checklist...');
    // Try "Not now" first (it stays on the page), then "Don't show again"
    const notNow = page.locator('button:visible').filter({ hasText: /Not now/i });
    if (await notNow.count() > 0) {
      await notNow.first().click({ timeout: 3000 }).catch(() => {});
    } else {
      await dismissBtn.first().click({ timeout: 3000 }).catch(() => {});
    }
    await page.waitForTimeout(1000);
  }

  // Also close any remaining modals/overlays by pressing Escape
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // ── 1. Activity view — baseline ──
  console.log('\n1. Activity view (after dismissing checklist)');
  await page.screenshot({ path: join(OUT_DIR, '01-activity-baseline.png'), fullPage: false });

  // ── 2. Jargon audit on full page text ──
  const bodyText = await page.textContent('body');
  console.log('\n2. Jargon audit:');
  const jargonChecks = [
    { pattern: /PLAYBACK CONTEXT/i, label: 'PLAYBACK CONTEXT' },
    { pattern: /Execution context/i, label: 'Execution context' },
    { pattern: /\bRUNNER\b/, label: 'RUNNER label' },
    { pattern: /Select all visible/i, label: 'Select all visible' },
    { pattern: /auto_continue_stopped/i, label: 'auto_continue_stopped' },
    { pattern: /dispatch_lifecycle/i, label: 'dispatch_lifecycle' },
    { pattern: /System \/ unknown/i, label: 'System / unknown' },
    { pattern: /Not assigned/i, label: '"Not assigned" (should be "Pending")' },
  ];
  let jargonPass = true;
  for (const { pattern, label } of jargonChecks) {
    const found = pattern.test(bodyText);
    if (found) jargonPass = false;
    console.log(`   ${found ? '❌' : '✅'} ${label}: ${found ? 'FOUND' : 'clean'}`);
  }

  // ── 3. Click into Mission Control ──
  console.log('\n3. Mission Control');
  const mcTab = page.locator('button:visible, a:visible').filter({ hasText: /Mission Control/i });
  if (await mcTab.count() > 0) {
    await mcTab.first().click({ timeout: 5000 });
    await page.waitForTimeout(2000);

    // Dismiss any modal that may appear
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    await page.screenshot({ path: join(OUT_DIR, '02-mission-control.png'), fullPage: false });
    console.log('   Screenshot captured');

    const mcText = await page.textContent('body');
    console.log(`   "Select all visible": ${/Select all visible/i.test(mcText) ? '❌ FOUND' : '✅ clean'}`);
    console.log(`   "Current context" (was "Playback context"): ${/Current context/i.test(mcText) ? '✅ YES' : '⚠️  not found'}`);
    console.log(`   "RUNNER": ${/\bRUNNER\b/.test(mcText) ? '❌ FOUND' : '✅ clean'}`);
  } else {
    console.log('   Tab not found');
  }

  // ── 4. Open Settings ──
  console.log('\n4. Settings');
  // Look for gear/settings icon button (usually in the top bar)
  const settingsGear = page.locator('[aria-label*="settings" i]:visible, [aria-label*="Settings" i]:visible, [title*="settings" i]:visible');
  let settingsOpened = false;
  if (await settingsGear.count() > 0) {
    await settingsGear.first().click({ timeout: 5000 });
    settingsOpened = true;
  } else {
    // Try clicking any button with a gear-like SVG
    const anyGear = page.locator('button:visible').filter({ has: page.locator('svg') });
    // Try the settings-looking ones
    const settingsTexts = page.locator('button:visible').filter({ hasText: /Settings/i });
    if (await settingsTexts.count() > 0) {
      await settingsTexts.first().click({ timeout: 5000 });
      settingsOpened = true;
    }
  }

  if (settingsOpened) {
    await page.waitForTimeout(1000);

    // Navigate to OrgX tab in settings if it exists
    const orgxTab = page.locator('button:visible').filter({ hasText: /OrgX/i });
    if (await orgxTab.count() > 0) {
      await orgxTab.first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
    }

    await page.screenshot({ path: join(OUT_DIR, '03-settings-orgx.png'), fullPage: false });

    const settingsText = await page.textContent('body');
    console.log(`   "Developer tools/mode": ${/Developer (tools|mode)/i.test(settingsText) ? '✅ YES' : '⚠️  not found'}`);
    console.log(`   "OpenClaw" visible: ${/OpenClaw/i.test(settingsText) ? '⚠️  FOUND' : '✅ clean'}`);

    // Navigate to Provider keys tab
    const providerTab = page.locator('button:visible').filter({ hasText: /Provider/i });
    if (await providerTab.count() > 0) {
      await providerTab.first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(OUT_DIR, '04-settings-providers.png'), fullPage: false });
    }

    // Close settings
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  } else {
    console.log('   Settings not opened');
  }

  // ── 5. Navigate to Activity and click a timeline item ──
  console.log('\n5. Session Inspector');
  const actTab = page.locator('button:visible, a:visible').filter({ hasText: /Activity/i });
  if (await actTab.count() > 0) {
    await actTab.first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  // Try clicking a timeline row
  const rows = page.locator('[role="button"]:visible').filter({ hasText: /.{20,}/ });
  if (await rows.count() > 0) {
    try {
      await rows.first().click({ timeout: 5000, force: true });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(OUT_DIR, '05-session-inspector.png'), fullPage: false });
      console.log('   Screenshot captured');

      const inspectorText = await page.textContent('body');
      const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      console.log(`   UUIDs visible: ${uuidPattern.test(inspectorText) ? '⚠️  FOUND (check if dev-gated)' : '✅ clean'}`);
    } catch (e) {
      console.log('   Could not click timeline item:', e.message.slice(0, 80));
    }
  } else {
    console.log('   No timeline items to inspect');
  }

  // ── 6. Full page ──
  console.log('\n6. Full page screenshot');
  await page.screenshot({ path: join(OUT_DIR, '06-full-page.png'), fullPage: true });

  // ── Summary ──
  console.log('\n══════════════════════════════════════');
  console.log('  VISUAL VERIFICATION SUMMARY');
  console.log('══════════════════════════════════════');
  console.log(`  Jargon audit: ${jargonPass ? '✅ ALL CLEAN' : '❌ ISSUES FOUND'}`);
  console.log(`  Screenshots: ${OUT_DIR}`);
  console.log('══════════════════════════════════════\n');

  await browser.close();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
