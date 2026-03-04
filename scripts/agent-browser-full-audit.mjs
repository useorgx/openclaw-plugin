#!/usr/bin/env node
/**
 * Full visual audit of /orgx/live — captures screenshots of every key view
 * and interaction surface for design analysis.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadChromium } from "./qa-output-paths.mjs";

const BASE_URL = "http://127.0.0.1:18789";
const LIVE_URL = `${BASE_URL}/orgx/live`;
const OUT_DIR = join(process.cwd(), "docs", "qa", "full-audit-" + Date.now());
mkdirSync(OUT_DIR, { recursive: true });

let shotIndex = 0;
async function snap(page, label) {
  const filename = `${String(++shotIndex).padStart(2, "0")}-${label}.png`;
  const filepath = join(OUT_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: false });
  console.log(`  📸 ${filename}`);
  return filepath;
}

async function dismissOverlays(page) {
  for (const name of [/Not now/i, /Don't show again/i, /Got it/i, /Dismiss/i, /Close/i]) {
    const btn = page.getByRole("button", { name }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
  }
}

async function run() {
  const chromium = await loadChromium();

  // Desktop viewport
  const browser = await chromium.launch({ headless: true });

  // ─── DESKTOP (1440×900) ─────────────────────────────────────────
  console.log("\n=== DESKTOP (1440×900) ===");
  const desktopPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await desktopPage.goto(LIVE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await desktopPage.waitForTimeout(2500);
  await dismissOverlays(desktopPage);
  await desktopPage.waitForTimeout(500);

  // 1. Default landing view
  await snap(desktopPage, "desktop-landing");

  // 2. Try clicking Activity tab
  const activityTab = desktopPage.getByRole("button", { name: /^Activity\b/i }).first();
  if (await activityTab.isVisible().catch(() => false)) {
    await activityTab.click({ timeout: 3000 }).catch(() => {});
    await desktopPage.waitForTimeout(1000);
    await snap(desktopPage, "desktop-activity-tab");
  }

  // 3. Try clicking Mission Control tab
  const mcTab = desktopPage.getByRole("button", { name: /Mission Control/i }).first();
  if (await mcTab.isVisible().catch(() => false)) {
    await mcTab.click({ timeout: 3000 }).catch(() => {});
    await desktopPage.waitForTimeout(1000);
    await snap(desktopPage, "desktop-mission-control");
  }

  // 4. Click Next Up if visible
  const nextUpBtn = desktopPage.getByRole("button", { name: /^Next Up\b/i }).first();
  if (await nextUpBtn.isVisible().catch(() => false)) {
    await nextUpBtn.click({ timeout: 3000 }).catch(() => {});
    await desktopPage.waitForTimeout(800);
    await snap(desktopPage, "desktop-next-up-panel");
  }

  // 5. Click In Progress if visible
  const inProgressBtn = desktopPage.getByRole("button", { name: /^In Progress\b/i }).first();
  if (await inProgressBtn.isVisible().catch(() => false)) {
    await inProgressBtn.click({ timeout: 3000 }).catch(() => {});
    await desktopPage.waitForTimeout(800);
    await snap(desktopPage, "desktop-in-progress-panel");
  }

  // 6. Try to expand first initiative
  const initiativeCards = desktopPage.locator("[data-testid*='initiative'], [class*='initiative']").first();
  if (await initiativeCards.isVisible().catch(() => false)) {
    await initiativeCards.click({ timeout: 3000 }).catch(() => {});
    await desktopPage.waitForTimeout(1000);
    await snap(desktopPage, "desktop-initiative-expanded");
  }

  // 7. Look for any clickable card/row and click it for detail view
  const anyCard = desktopPage.locator("button, [role='button'], a").filter({ hasText: /workstream|task|milestone/i }).first();
  if (await anyCard.isVisible().catch(() => false)) {
    await anyCard.click({ timeout: 3000 }).catch(() => {});
    await desktopPage.waitForTimeout(1000);
    await snap(desktopPage, "desktop-entity-detail");
    // Close modal if open
    const closeBtn = desktopPage.getByRole("button", { name: /close|×/i }).first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ timeout: 2000 }).catch(() => {});
      await desktopPage.waitForTimeout(500);
    }
  }

  // 8. Try Decisions tab/view
  const decisionsBtn = desktopPage.getByRole("button", { name: /Decisions/i }).first();
  if (await decisionsBtn.isVisible().catch(() => false)) {
    await decisionsBtn.click({ timeout: 3000 }).catch(() => {});
    await desktopPage.waitForTimeout(1000);
    await snap(desktopPage, "desktop-decisions");
  }

  // 9. Go back to Activity, try to click a timeline item
  if (await activityTab.isVisible().catch(() => false)) {
    await activityTab.click({ timeout: 3000 }).catch(() => {});
    await desktopPage.waitForTimeout(1000);
  }
  const timelineItem = desktopPage.locator("[data-testid*='activity'], [data-testid*='timeline']").first();
  if (await timelineItem.isVisible().catch(() => false)) {
    await timelineItem.click({ timeout: 3000 }).catch(() => {});
    await desktopPage.waitForTimeout(1000);
    await snap(desktopPage, "desktop-activity-detail");
  }

  // 10. Check for chat dock
  const chatToggle = desktopPage.locator("button").filter({ hasText: /chat|message|compose/i }).first();
  if (await chatToggle.isVisible().catch(() => false)) {
    await chatToggle.click({ timeout: 3000 }).catch(() => {});
    await desktopPage.waitForTimeout(800);
    await snap(desktopPage, "desktop-chat-dock");
  }

  // 11. Full page screenshot
  await desktopPage.screenshot({ path: join(OUT_DIR, "desktop-fullpage.png"), fullPage: true });
  console.log("  📸 desktop-fullpage.png");

  await desktopPage.close();

  // ─── MOBILE (375×812, iPhone-ish) ──────────────────────────────
  console.log("\n=== MOBILE (375×812) ===");
  const mobilePage = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await mobilePage.goto(LIVE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await mobilePage.waitForTimeout(2500);
  await dismissOverlays(mobilePage);
  await mobilePage.waitForTimeout(500);

  await snap(mobilePage, "mobile-landing");

  // Try Activity tab on mobile
  const mobileActivityTab = mobilePage.getByRole("button", { name: /Activity/i }).first();
  if (await mobileActivityTab.isVisible().catch(() => false)) {
    await mobileActivityTab.click({ timeout: 3000 }).catch(() => {});
    await mobilePage.waitForTimeout(1000);
    await snap(mobilePage, "mobile-activity");
  }

  // Try Mission Control on mobile
  const mobileMcTab = mobilePage.getByRole("button", { name: /Mission|Initiatives/i }).first();
  if (await mobileMcTab.isVisible().catch(() => false)) {
    await mobileMcTab.click({ timeout: 3000 }).catch(() => {});
    await mobilePage.waitForTimeout(1000);
    await snap(mobilePage, "mobile-mission-control");
  }

  // Decisions on mobile
  const mobileDecisionsBtn = mobilePage.getByRole("button", { name: /Decisions/i }).first();
  if (await mobileDecisionsBtn.isVisible().catch(() => false)) {
    await mobileDecisionsBtn.click({ timeout: 3000 }).catch(() => {});
    await mobilePage.waitForTimeout(1000);
    await snap(mobilePage, "mobile-decisions");
  }

  // Agents tab on mobile
  const mobileAgentsBtn = mobilePage.getByRole("button", { name: /Agents/i }).first();
  if (await mobileAgentsBtn.isVisible().catch(() => false)) {
    await mobileAgentsBtn.click({ timeout: 3000 }).catch(() => {});
    await mobilePage.waitForTimeout(1000);
    await snap(mobilePage, "mobile-agents");
  }

  await mobilePage.screenshot({ path: join(OUT_DIR, "mobile-fullpage.png"), fullPage: true });
  console.log("  📸 mobile-fullpage.png");

  await mobilePage.close();

  // ─── TABLET (768×1024, iPad-ish) ───────────────────────────────
  console.log("\n=== TABLET (768×1024) ===");
  const tabletPage = await browser.newPage({ viewport: { width: 768, height: 1024 } });
  await tabletPage.goto(LIVE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await tabletPage.waitForTimeout(2500);
  await dismissOverlays(tabletPage);
  await tabletPage.waitForTimeout(500);

  await snap(tabletPage, "tablet-landing");
  await tabletPage.close();

  await browser.close();

  console.log(`\n✅ All screenshots saved to: ${OUT_DIR}\n`);
}

run().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exitCode = 1;
});
