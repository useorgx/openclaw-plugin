#!/usr/bin/env node
/**
 * Deep audit — captures specific interaction states for design review.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadChromium } from "./qa-output-paths.mjs";

const BASE_URL = "http://127.0.0.1:18789";
const LIVE_URL = `${BASE_URL}/orgx/live`;
const OUT_DIR = join(process.cwd(), "docs", "qa", "deep-audit-" + Date.now());
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
  for (const name of [/Not now/i, /Don't show again/i, /Got it/i, /Dismiss/i]) {
    const btn = page.getByRole("button", { name }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
  }
}

async function run() {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // ─── ACTIVITY VIEW DEEP DIVE ───────────────────────────────────
  console.log("\n=== ACTIVITY VIEW DEEP DIVE ===");
  await page.goto(LIVE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  await dismissOverlays(page);

  // Close any degraded notice
  const closeNotice = page.locator("button").filter({ hasText: /×|close/i }).first();
  if (await closeNotice.isVisible().catch(() => false)) {
    await closeNotice.click().catch(() => {});
    await page.waitForTimeout(300);
  }

  // Make sure we're on Activity tab
  const actTab = page.getByRole("button", { name: /^Activity\b/i }).first();
  if (await actTab.isVisible().catch(() => false)) {
    await actTab.click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  await snap(page, "activity-default-view");

  // Click "Needs attention" filter
  const needsAttnBtn = page.getByRole("button", { name: /Needs attention/i }).first();
  if (await needsAttnBtn.isVisible().catch(() => false)) {
    await needsAttnBtn.click().catch(() => {});
    await page.waitForTimeout(800);
    await snap(page, "activity-needs-attention-filter");
    // Reset
    const allBtn = page.getByRole("button", { name: /^All$/i }).first();
    if (await allBtn.isVisible().catch(() => false)) {
      await allBtn.click().catch(() => {});
      await page.waitForTimeout(500);
    }
  }

  // Click "Completed" filter
  const completedBtn = page.getByRole("button", { name: /^Completed$/i }).first();
  if (await completedBtn.isVisible().catch(() => false)) {
    await completedBtn.click().catch(() => {});
    await page.waitForTimeout(800);
    await snap(page, "activity-completed-filter");
    const allBtn = page.getByRole("button", { name: /^All$/i }).first();
    if (await allBtn.isVisible().catch(() => false)) {
      await allBtn.click().catch(() => {});
      await page.waitForTimeout(500);
    }
  }

  // Click on first activity card to see detail
  const firstActivityCard = page.locator("[class*='cursor-pointer']").first();
  if (await firstActivityCard.isVisible().catch(() => false)) {
    await firstActivityCard.click().catch(() => {});
    await page.waitForTimeout(1000);
    await snap(page, "activity-item-detail");
    // Try to close
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }

  // Click on an agent in the left sidebar
  const agentRow = page.locator("text=Engineering").first();
  if (await agentRow.isVisible().catch(() => false)) {
    await agentRow.click().catch(() => {});
    await page.waitForTimeout(1000);
    await snap(page, "activity-agent-selected");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }

  // ─── MISSION CONTROL DEEP DIVE ─────────────────────────────────
  console.log("\n=== MISSION CONTROL DEEP DIVE ===");
  const mcTab = page.getByRole("button", { name: /Mission Control/i }).first();
  if (await mcTab.isVisible().catch(() => false)) {
    await mcTab.click().catch(() => {});
    await page.waitForTimeout(1500);
  }
  await dismissOverlays(page);

  // Close degraded notice if any
  const xBtn = page.locator("[aria-label='Close'], button:has-text('×')").first();
  if (await xBtn.isVisible().catch(() => false)) {
    await xBtn.click().catch(() => {});
    await page.waitForTimeout(300);
  }

  await snap(page, "mc-overview");

  // Click on first initiative expand arrow
  const expandArrow = page.locator("button[aria-expanded], [data-testid*='expand'], svg").filter({ hasText: /▸|▾|►|▼/ }).first();
  // Try clicking the first initiative row instead
  const firstInitiativeRow = page.locator("text=/Live View UX Redesign/i").first();
  if (await firstInitiativeRow.isVisible().catch(() => false)) {
    await firstInitiativeRow.click().catch(() => {});
    await page.waitForTimeout(1200);
    await snap(page, "mc-initiative-expanded");
  }

  // Click a different initiative
  const secondInitiative = page.locator("text=/Agent-Native Account/i").first();
  if (await secondInitiative.isVisible().catch(() => false)) {
    await secondInitiative.click().catch(() => {});
    await page.waitForTimeout(1200);
    await snap(page, "mc-initiative-2-expanded");
  }

  // Try to open Filters
  const filtersBtn = page.getByRole("button", { name: /Filters/i }).first();
  if (await filtersBtn.isVisible().catch(() => false)) {
    await filtersBtn.click().catch(() => {});
    await page.waitForTimeout(800);
    await snap(page, "mc-filters-open");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }

  // Try "Open queue" button
  const openQueueBtn = page.getByRole("button", { name: /Open queue/i }).first();
  if (await openQueueBtn.isVisible().catch(() => false)) {
    await openQueueBtn.click().catch(() => {});
    await page.waitForTimeout(1000);
    await snap(page, "mc-queue-open");
  }

  // Try clicking the "Paused" section
  const pausedSection = page.locator("text=/Paused/i").first();
  if (await pausedSection.isVisible().catch(() => false)) {
    await pausedSection.click().catch(() => {});
    await page.waitForTimeout(800);
    await snap(page, "mc-paused-section");
  }

  // Scroll down to see more initiatives
  await page.evaluate(() => {
    const main = document.querySelector("main") || document.querySelector("[class*='overflow']");
    if (main) main.scrollTop = main.scrollHeight;
    else window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(800);
  await snap(page, "mc-scrolled-bottom");

  // Scroll back up
  await page.evaluate(() => {
    const main = document.querySelector("main") || document.querySelector("[class*='overflow']");
    if (main) main.scrollTop = 0;
    else window.scrollTo(0, 0);
  });
  await page.waitForTimeout(500);

  // Try Now Working card interactions
  const pauseBtn = page.getByRole("button", { name: /^Pause$/i }).first();
  if (await pauseBtn.isVisible().catch(() => false)) {
    await snap(page, "mc-now-working-card");
  }

  // ─── STATUS BAR CLOSE-UP ──────────────────────────────────────
  console.log("\n=== STATUS BAR ===");
  // The top bar with LIVE badge, running/blocked counts
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await snap(page, "status-bar-top");

  // ─── AGENT DETAIL ─────────────────────────────────────────────
  console.log("\n=== AGENT INTERACTIONS ===");
  // Go back to Activity
  if (await actTab.isVisible().catch(() => false)) {
    await actTab.click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  // Click an agent's info button (the (i) icon)
  const infoIcon = page.locator("[aria-label*='info'], [title*='info'], button:has(svg)").filter({ hasText: /ⓘ|info/i }).first();
  if (await infoIcon.isVisible().catch(() => false)) {
    await infoIcon.click().catch(() => {});
    await page.waitForTimeout(800);
    await snap(page, "agent-detail-panel");
  }

  // Click on OrgX or Holt (active agents)
  const orgxAgent = page.locator("text=OrgX").first();
  if (await orgxAgent.isVisible().catch(() => false)) {
    await orgxAgent.click().catch(() => {});
    await page.waitForTimeout(1000);
    await snap(page, "agent-orgx-expanded");
  }

  // Click OpenClaw agent (has sessions)
  const openclawAgent = page.locator("text=OpenClaw").first();
  if (await openclawAgent.isVisible().catch(() => false)) {
    await openclawAgent.click().catch(() => {});
    await page.waitForTimeout(1000);
    await snap(page, "agent-openclaw-sessions");
  }

  await browser.close();
  console.log(`\n✅ Deep audit screenshots: ${OUT_DIR}\n`);
}

run().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exitCode = 1;
});
