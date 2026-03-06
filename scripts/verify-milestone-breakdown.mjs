#!/usr/bin/env node
/**
 * Screenshot capture to verify milestone breakdown changes.
 * Captures API data and targeted screenshots.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadChromium } from "./qa-output-paths.mjs";

const LIVE_URL =
  "http://127.0.0.1:18789/orgx/live?workspace_id=7af01a51-49b1-47d8-98b9-91a198debca8&command_center_id=7af01a51-49b1-47d8-98b9-91a198debca8&center=7af01a51-49b1-47d8-98b9-91a198debca8&cachebust=202603050900";

const OUT_DIR = join(
  import.meta.dirname,
  "..",
  "qa-artifacts",
  "milestone-breakdown-verify"
);

mkdirSync(OUT_DIR, { recursive: true });

async function run() {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // Intercept API responses
  const apiCaptures = {};
  page.on("response", async (resp) => {
    const url = resp.url();
    if (resp.status() === 200) {
      try {
        if (url.includes("next-up")) {
          apiCaptures.nextUp = await resp.json();
        }
        if (url.includes("mission-control/graph")) {
          apiCaptures.graph = await resp.json();
        }
      } catch {}
    }
  });

  console.log("1. Loading dashboard...");
  await page.goto(LIVE_URL, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForTimeout(4000);

  // Full page overview
  await page.screenshot({
    path: join(OUT_DIR, "01-full-dashboard.png"),
    fullPage: false,
  });
  console.log("  → 01-full-dashboard.png");

  // Click Next Up tab
  const nextUpTab = await page.$('button:has-text("Next Up")');
  if (nextUpTab) {
    await nextUpTab.click();
    await page.waitForTimeout(2000);
  }

  // Click "Queued" filter if available to see queued items
  await page.screenshot({
    path: join(OUT_DIR, "02-next-up-view.png"),
    fullPage: false,
  });
  console.log("  → 02-next-up-view.png");

  // Click first card in right panel
  const articles = await page.$$('article');
  let rightPanelCard = null;
  for (const el of articles) {
    const box = await el.boundingBox();
    if (box && box.x > 700 && box.width > 100 && box.width < 500 && box.height > 50) {
      rightPanelCard = el;
      break;
    }
  }
  if (rightPanelCard) {
    await rightPanelCard.click();
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: join(OUT_DIR, "03-modal-top.png"),
      fullPage: false,
    });
    console.log("  → 03-modal-top.png");

    // Scroll modal
    const scrollable = await page.$('[class*="overflow-y-auto"]');
    if (scrollable) {
      await scrollable.evaluate((el) => el.scrollBy(0, 400));
      await page.waitForTimeout(500);
      await page.screenshot({
        path: join(OUT_DIR, "04-modal-scope.png"),
        fullPage: false,
      });
      console.log("  → 04-modal-scope.png");
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }

  // Now check graph data for milestones
  console.log("\n2. Checking graph for milestone data...");
  // Trigger a graph load by clicking an initiative
  const mcTab = await page.$('button:has-text("Mission Control")');
  if (mcTab) {
    await mcTab.click();
    await page.waitForTimeout(2000);

    // Click first initiative to load its graph
    const initRow = await page.$('div:has-text("OrgX OpenClaw Plugin")');
    if (initRow) {
      const expandBtns = await page.$$('button[aria-label*="expand"], button[aria-label*="Expand"]');
      for (const btn of expandBtns.slice(0, 1)) {
        await btn.click();
        await page.waitForTimeout(1000);
      }
    }
  }

  // Wait for graph API
  await page.waitForTimeout(3000);

  // Check next-up API data
  console.log("\n3. API Data Analysis:");
  if (apiCaptures.nextUp) {
    const items = apiCaptures.nextUp.items ?? [];
    const withBreakdown = items.filter((i) => i.milestoneBreakdown?.length > 0);
    console.log(`  Next Up items: ${items.length}`);
    console.log(`  Source: ${apiCaptures.nextUp.source}`);
    console.log(`  Items with milestoneBreakdown: ${withBreakdown.length}`);

    if (withBreakdown.length > 0) {
      for (const item of withBreakdown.slice(0, 5)) {
        console.log(`\n  → ${item.workstreamTitle}:`);
        for (const ms of item.milestoneBreakdown) {
          console.log(`      ${ms.title}: ${ms.doneTasks}/${ms.totalTasks} tasks done`);
        }
      }
    } else {
      console.log("  (No items have milestoneBreakdown - checking source...)");
      console.log(`  Source is: ${apiCaptures.nextUp.source}`);
      // Check sample item structure
      if (items.length > 0) {
        const sample = items[0];
        console.log(`  Sample item fields: ${Object.keys(sample).join(', ')}`);
        console.log(`  Sample milestoneBreakdown: ${JSON.stringify(sample.milestoneBreakdown)}`);
      }
    }

    writeFileSync(
      join(OUT_DIR, "api-data.json"),
      JSON.stringify(apiCaptures.nextUp, null, 2)
    );
    console.log("\n  → api-data.json");
  }

  // Check graph data
  if (apiCaptures.graph) {
    const nodes = apiCaptures.graph?.nodes ?? [];
    const milestones = nodes.filter((n) => n.type === 'milestone');
    const tasks = nodes.filter((n) => n.type === 'task');
    console.log(`\n  Graph nodes: ${nodes.length} (${milestones.length} milestones, ${tasks.length} tasks)`);
    if (milestones.length > 0) {
      for (const ms of milestones.slice(0, 5)) {
        const childTasks = tasks.filter((t) => t.milestoneId === ms.id || t.parentId === ms.id);
        console.log(`  → Milestone "${ms.title}": workstreamId=${ms.workstreamId ?? ms.parentId}, ${childTasks.length} tasks`);
      }
    } else {
      console.log("  No milestones found in graph.");
    }
  }

  // Final check: manually call the next-up API with fetch inside the page
  console.log("\n4. Direct API probe...");
  const probeResult = await page.evaluate(async () => {
    try {
      // Try multiple URL patterns
      const urls = [
        '/orgx/api/mission-control/next-up?workspace_id=7af01a51-49b1-47d8-98b9-91a198debca8',
        '/api/mission-control/next-up?workspace_id=7af01a51-49b1-47d8-98b9-91a198debca8&command_center_id=7af01a51-49b1-47d8-98b9-91a198debca8',
        '/orgx/api/client/mission-control/next-up?workspace_id=7af01a51-49b1-47d8-98b9-91a198debca8',
      ];
      const results = {};
      for (const url of urls) {
        try {
          const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
          if (resp.ok) {
            const data = await resp.json();
            const items = data?.items ?? [];
            const withMB = items.filter((i) => i.milestoneBreakdown?.length > 0);
            results[url] = {
              status: resp.status,
              total: items.length,
              withBreakdown: withMB.length,
              source: data?.source,
              sample: items.slice(0, 1).map(i => ({
                ws: i.workstreamTitle,
                mb: i.milestoneBreakdown,
                keys: Object.keys(i),
              })),
            };
          } else {
            results[url] = { status: resp.status, body: (await resp.text()).slice(0, 100) };
          }
        } catch (e) {
          results[url] = { error: e.message };
        }
      }
      return results;
    } catch (e) {
      return { error: e.message };
    }
  });
  console.log(JSON.stringify(probeResult, null, 2));

  await browser.close();
  console.log(`\nDone. Screenshots in: ${OUT_DIR}`);
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
