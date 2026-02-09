import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { chromium } from 'playwright-core';

const DEFAULT_PORT = 4173;
const DEFAULT_DATE = new Date().toISOString().slice(0, 10);

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (flag) => {
    const idx = args.indexOf(flag);
    if (idx === -1) return null;
    return args[idx + 1] ?? null;
  };
  const has = (flag) => args.includes(flag);

  return {
    date: get('--date') ?? DEFAULT_DATE,
    port: Number(get('--port') ?? DEFAULT_PORT),
    skipBuild: has('--skip-build'),
    verbose: has('--verbose'),
  };
}

function chromeExecutablePath() {
  if (process.env.PLAYWRIGHT_CHROME_PATH) return process.env.PLAYWRIGHT_CHROME_PATH;
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  return null;
}

async function run(cmd, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      ...options,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed: ${cmd} ${args.join(' ')} (exit ${code})`));
    });
  });
}

async function waitForHttpOk(url, timeoutMs = 10_000) {
  const start = Date.now();
  // Node 18+ has global fetch.
  // eslint-disable-next-line no-undef
  while (Date.now() - start < timeoutMs) {
    try {
      // eslint-disable-next-line no-undef
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
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

function snapshotEmpty(generatedAt) {
  return {
    sessions: { nodes: [], edges: [], groups: [] },
    activity: [],
    handoffs: [],
    decisions: [],
    agents: [],
    outbox: {
      pendingTotal: 0,
      pendingByQueue: {},
      oldestEventAt: null,
      newestEventAt: null,
      replayStatus: 'idle',
      lastReplayAttemptAt: null,
      lastReplaySuccessAt: null,
      lastReplayFailureAt: null,
      lastReplayError: null,
    },
    generatedAt,
  };
}

function mockMissionControlGraph(initiativeId) {
  const now = new Date().toISOString();
  const title =
    initiativeId === 'init-1'
      ? 'Q4 Feature Ship'
      : initiativeId === 'init-2'
        ? 'Black Friday Email'
        : 'Initiative';

  // Keep IDs stable and human-scannable for screenshots.
  const ws1Id = initiativeId === 'init-1' ? 'ws-4' : `${initiativeId}-ws-1`;
  const ws2Id = initiativeId === 'init-1' ? 'ws-5' : `${initiativeId}-ws-2`;
  const ms1Id = `${initiativeId}-ms-1`;
  const ms2Id = `${initiativeId}-ms-2`;
  const t1Id = `${initiativeId}-task-1`;
  const t2Id = `${initiativeId}-task-2`;
  const t3Id = `${initiativeId}-task-3`;

  const nodes = [
    {
      id: initiativeId,
      type: 'initiative',
      title,
      status: 'active',
      parentId: null,
      initiativeId,
      workstreamId: null,
      milestoneId: null,
      priorityNum: 60,
      priorityLabel: null,
      dependencyIds: [],
      dueDate: null,
      etaEndAt: null,
      expectedDurationHours: 40,
      expectedBudgetUsd: 1500,
      assignedAgents: [
        { id: 'eli', name: 'Eli', domain: 'product' },
        { id: 'dana', name: 'Dana', domain: 'design' },
      ],
      updatedAt: now,
    },
    {
      id: ws1Id,
      type: 'workstream',
      title: initiativeId === 'init-1' ? 'Dashboard UI pass' : 'Audience targeting',
      status: 'in_progress',
      parentId: initiativeId,
      initiativeId,
      workstreamId: ws1Id,
      milestoneId: null,
      priorityNum: 30,
      priorityLabel: 'high',
      dependencyIds: [],
      dueDate: null,
      etaEndAt: null,
      expectedDurationHours: 12,
      expectedBudgetUsd: 240,
      assignedAgents: [{ id: 'dana', name: 'Dana', domain: 'design' }],
      updatedAt: now,
    },
    {
      id: ws2Id,
      type: 'workstream',
      title: initiativeId === 'init-1' ? 'Usage tracking instrumentation' : 'Creative approvals',
      status: 'todo',
      parentId: initiativeId,
      initiativeId,
      workstreamId: ws2Id,
      milestoneId: null,
      priorityNum: 40,
      priorityLabel: 'medium',
      dependencyIds: [],
      dueDate: null,
      etaEndAt: null,
      expectedDurationHours: 10,
      expectedBudgetUsd: 180,
      assignedAgents: [{ id: 'pace', name: 'Pace', domain: 'engineering' }],
      updatedAt: now,
    },
    {
      id: ms1Id,
      type: 'milestone',
      title: initiativeId === 'init-1' ? 'QA + polish' : 'Launch prep',
      status: 'todo',
      parentId: ws1Id,
      initiativeId,
      workstreamId: ws1Id,
      milestoneId: ms1Id,
      priorityNum: 40,
      priorityLabel: 'medium',
      dependencyIds: [],
      dueDate: null,
      etaEndAt: null,
      expectedDurationHours: 6,
      expectedBudgetUsd: 120,
      assignedAgents: [],
      updatedAt: now,
    },
    {
      id: ms2Id,
      type: 'milestone',
      title: initiativeId === 'init-1' ? 'Release + docs' : 'Campaign launch',
      status: 'planned',
      parentId: ws2Id,
      initiativeId,
      workstreamId: ws2Id,
      milestoneId: ms2Id,
      priorityNum: 50,
      priorityLabel: 'low',
      dependencyIds: [],
      dueDate: null,
      etaEndAt: null,
      expectedDurationHours: 5,
      expectedBudgetUsd: 90,
      assignedAgents: [],
      updatedAt: now,
    },
    {
      id: t1Id,
      type: 'task',
      title: initiativeId === 'init-1' ? 'Timeline row readability' : 'Define audience targeting',
      status: 'done',
      parentId: ms1Id,
      initiativeId,
      workstreamId: ws1Id,
      milestoneId: ms1Id,
      priorityNum: 20,
      priorityLabel: 'high',
      dependencyIds: [],
      dueDate: null,
      etaEndAt: null,
      expectedDurationHours: 2,
      expectedBudgetUsd: 40,
      assignedAgents: [{ id: 'dana', name: 'Dana', domain: 'design' }],
      updatedAt: now,
    },
    {
      id: t2Id,
      type: 'task',
      title: initiativeId === 'init-1' ? 'Screenshot grid evidence' : 'Set up ads account',
      status: 'todo',
      parentId: ms1Id,
      initiativeId,
      workstreamId: ws1Id,
      milestoneId: ms1Id,
      priorityNum: 25,
      priorityLabel: 'high',
      dependencyIds: [t1Id],
      dueDate: null,
      etaEndAt: null,
      expectedDurationHours: 2,
      expectedBudgetUsd: 40,
      assignedAgents: [{ id: 'eli', name: 'Eli', domain: 'product' }],
      updatedAt: now,
    },
    {
      id: t3Id,
      type: 'task',
      title: initiativeId === 'init-1' ? 'Replay instrumentation smoke test' : 'Launch campaign with budget',
      status: 'planned',
      parentId: ws2Id,
      initiativeId,
      workstreamId: ws2Id,
      milestoneId: null,
      priorityNum: 35,
      priorityLabel: 'medium',
      dependencyIds: [t2Id],
      dueDate: null,
      etaEndAt: null,
      expectedDurationHours: 3,
      expectedBudgetUsd: 60,
      assignedAgents: [{ id: 'pace', name: 'Pace', domain: 'engineering' }],
      updatedAt: now,
    },
  ];

  const edges = [
    { from: t1Id, to: t2Id, kind: 'depends_on' },
    { from: t2Id, to: t3Id, kind: 'depends_on' },
  ];

  return {
    initiative: {
      id: initiativeId,
      title,
      status: 'active',
      summary: 'Mock graph for QA capture (headless).',
      assignedAgents: [],
    },
    nodes,
    edges,
    recentTodos: [t2Id],
  };
}

async function writeGridIndexHtml(dir, title) {
  const entries = (await readdir(dir)).filter((file) => /\.(png|gif|mp4)$/i.test(file));
  entries.sort();

  const cards = entries
    .map((file) => {
      const escaped = file.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const media = /\.mp4$/i.test(file)
        ? `<video src="./${escaped}" controls muted playsinline style="width: 100%; border-radius: 12px;"></video>`
        : `<img src="./${escaped}" alt="${escaped}" loading="lazy" style="width: 100%; border-radius: 12px;" />`;
      return `<figure style="margin:0; display:flex; flex-direction:column; gap:8px;">
        ${media}
        <figcaption style="font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; color: rgba(255,255,255,0.7);">${escaped}</figcaption>
      </figure>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background: #02040a; color: #e2e8f0; }
      header { padding: 20px 20px 0; }
      h1 { margin: 0; font-size: 18px; letter-spacing: -0.02em; }
      p { margin: 8px 0 0; color: rgba(226,232,240,0.7); font-size: 13px; }
      main { padding: 20px; display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
      figure { border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.03); padding: 12px; border-radius: 16px; }
    </style>
  </head>
  <body>
    <header>
      <h1>${title}</h1>
      <p>Generated by scripts/capture-qa-evidence.mjs</p>
    </header>
    <main>
      ${cards}
    </main>
  </body>
</html>
`;

  await writeFile(path.join(dir, 'index.html'), html, 'utf8');
}

async function captureActivityEvidence(browser, baseUrl, outDir, { verbose } = {}) {
  const desktopDir = path.join(outDir, 'activity-view');
  await mkdir(desktopDir, { recursive: true });

  // 1) Desktop: baseline + detail + inspector (demo mode).
  {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    await context.addInitScript(() => {
      window.localStorage.setItem('orgx.onboarding.skip', '1');
      window.localStorage.setItem('orgx.first_run_guide.dismissed', '1');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${baseUrl}/?demo=1`, { waitUntil: 'load' });
    await page.getByRole('heading', { name: /OrgX.*Live/i }).waitFor();
    await disableAnimations(page);
    await page.screenshot({ path: path.join(desktopDir, 'desktop-01-baseline.png') });

    const detailButton = page.locator('button[aria-label^="Open activity details"]').first();
    await detailButton.click();
    await page.locator('button[aria-label="Close activity detail"]').waitFor();
    await page.screenshot({ path: path.join(desktopDir, 'desktop-02-detail-modal.png') });
    await page.keyboard.press('Escape');

    // Select a session so the right-panel inspector populates.
    const sessionButton = page.getByRole('button', { name: /Eli|Dana|Pace|Mark/ }).first();
    await sessionButton.click();
    await page.getByText('Session Detail').first().waitFor();
    await page.screenshot({ path: path.join(desktopDir, 'desktop-03-session-inspector.png') });

    // Frames for a lightweight flow recording (demo mode).
    const flowFrames = path.join(desktopDir, 'flow-desktop-frames');
    await mkdir(flowFrames, { recursive: true });
    await page.goto(`${baseUrl}/?demo=1`, { waitUntil: 'load' });
    await page.getByRole('heading', { name: /OrgX.*Live/i }).waitFor();
    await disableAnimations(page);
    await page.screenshot({ path: path.join(flowFrames, 'frame-01.png') });
    await page.locator('button[aria-label^="Open activity details"]').first().click();
    await page.locator('button[aria-label="Close activity detail"]').waitFor();
    await page.screenshot({ path: path.join(flowFrames, 'frame-02.png') });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Eli|Dana|Pace|Mark/ }).first().click();
    await page.screenshot({ path: path.join(flowFrames, 'frame-03.png') });

    // MP4 + GIF from frames.
    await run('ffmpeg', [
      '-y',
      '-framerate',
      '1',
      '-start_number',
      '1',
      '-i',
      path.join(flowFrames, 'frame-%02d.png'),
      '-vf',
      'scale=1280:-2:flags=lanczos,format=yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      path.join(desktopDir, 'flow-desktop.mp4'),
    ]);
    await run('ffmpeg', [
      '-y',
      '-framerate',
      '1',
      '-start_number',
      '1',
      '-i',
      path.join(flowFrames, 'frame-%02d.png'),
      '-vf',
      'fps=10,scale=960:-2:flags=lanczos',
      path.join(desktopDir, 'flow-desktop.gif'),
    ]);

    await page.close();
    await context.close();
  }

  // 2) Mobile: activity tab + detail (demo mode).
  {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: 'reduce',
    });
    await context.addInitScript(() => {
      window.localStorage.setItem('orgx.onboarding.skip', '1');
      window.localStorage.setItem('orgx.first_run_guide.dismissed', '1');
    });

    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${baseUrl}/?demo=1`, { waitUntil: 'load' });
    await page.getByRole('heading', { name: /OrgX.*Live/i }).waitFor();
    await disableAnimations(page);
    // Default mobile tab is Agents; switch to Activity tab for evidence.
    await page
      .getByLabel('Mobile sections')
      .getByRole('button', { name: /^Activity$/ })
      .click({ force: true });
    // Wait for the timeline controls to render (avoid matching the view-toggle label).
    await page.getByRole('group', { name: 'Activity filters' }).waitFor();
    await page.screenshot({ path: path.join(desktopDir, 'mobile-01-activity.png') });

    const detailButton = page.locator('button[aria-label^="Open activity details"]').first();
    await detailButton.click();
    await page.locator('button[aria-label="Close activity detail"]').waitFor();
    await page.screenshot({ path: path.join(desktopDir, 'mobile-02-detail-modal.png') });

    await page.close();
    await context.close();
  }

  // 3) Failure states (at least 2).
  // 3a) Onboarding gate shown (no skip) with backend unavailable.
  {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${baseUrl}/`, { waitUntil: 'load' });
    await disableAnimations(page);
    await page
      .getByRole('heading', { name: /Connect OrgX|OrgX.*Setup|Setup/i })
      .first()
      .waitFor()
      .catch(() => {});
    await page.screenshot({ path: path.join(desktopDir, 'desktop-90-onboarding-gate.png') });
    await page.close();
    await context.close();
  }

  // 3b) Empty dashboard snapshot (skip gate; snapshot returns empty arrays).
  {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    await context.addInitScript(() => {
      window.localStorage.setItem('orgx.onboarding.skip', '1');
      window.localStorage.setItem('orgx.first_run_guide.dismissed', '1');
    });
    await context.route('**/orgx/api/dashboard-bundle?*', async (route) => {
      const generatedAt = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshotEmpty(generatedAt)),
      });
    });
    await context.route('**/orgx/api/live/snapshot?*', async (route) => {
      const generatedAt = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshotEmpty(generatedAt)),
      });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${baseUrl}/`, { waitUntil: 'load' });
    await page.getByRole('heading', { name: /OrgX.*Live/i }).waitFor();
    await disableAnimations(page);
    await page.screenshot({ path: path.join(desktopDir, 'desktop-91-empty-dashboard.png') });

    await page.close();
    await context.close();
  }

  await writeGridIndexHtml(desktopDir, 'Activity View QA Evidence');
  if (verbose) console.log(`[qa] activity evidence: ${desktopDir}`);
}

async function captureMissionControlEvidence(browser, baseUrl, outDir, { verbose } = {}) {
  const mcDir = path.join(outDir, 'mission-control');
  await mkdir(mcDir, { recursive: true });

  // 1) Desktop: table + dependency map + modals (demo mode + mocked graph).
  {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    await context.addInitScript(() => {
      window.localStorage.setItem('orgx.onboarding.skip', '1');
      window.localStorage.setItem('orgx.first_run_guide.dismissed', '1');
    });

    await context.route('**/orgx/api/mission-control/graph?*', async (route) => {
      const url = new URL(route.request().url());
      const id = url.searchParams.get('initiative_id');
      const payload = mockMissionControlGraph(id ?? 'init-1');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${baseUrl}/?demo=1&view=mission-control`, { waitUntil: 'load' });
    await page.getByPlaceholder('Search initiatives, status, or category...').waitFor();
    await disableAnimations(page);

    // Expand initiatives so the graph/table panels render.
    const expandAll = page.getByRole('button', { name: 'Expand All' });
    if (await expandAll.isVisible().catch(() => false)) {
      await expandAll.click();
    }

    // Wait for any graph-backed row to appear.
    await page.locator('button[aria-label^="Open workstream details"]').first().waitFor();
    await page.screenshot({ path: path.join(mcDir, 'desktop-01-hierarchy-table.png') });

    // Scroll to the dependency map panel for a dedicated capture.
    await page.getByText('Dependency map').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(mcDir, 'desktop-02-dependency-map.png') });

    // Capture a workstream modal.
    await page.locator('button[aria-label^="Open workstream details"]').first().click();
    await page.getByRole('dialog').waitFor();
    await page.screenshot({ path: path.join(mcDir, 'desktop-03-modal-workstream.png') });
    await page.keyboard.press('Escape');

    // Capture a task modal.
    await page.locator('button[aria-label^="Open task details"]').first().click();
    await page.getByRole('dialog').waitFor();
    await page.screenshot({ path: path.join(mcDir, 'desktop-04-modal-task.png') });
    await page.keyboard.press('Escape');

    // Lightweight flow recording frames.
    const flowFrames = path.join(mcDir, 'flow-desktop-frames');
    await mkdir(flowFrames, { recursive: true });
    await page.goto(`${baseUrl}/?demo=1&view=mission-control`, { waitUntil: 'load' });
    await page.getByPlaceholder('Search initiatives, status, or category...').waitFor();
    await disableAnimations(page);
    if (await expandAll.isVisible().catch(() => false)) {
      await expandAll.click();
    }
    await page.locator('button[aria-label^="Open workstream details"]').first().waitFor();
    await page.screenshot({ path: path.join(flowFrames, 'frame-01.png') });
    await page.getByText('Dependency map').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(flowFrames, 'frame-02.png') });
    await page.locator('button[aria-label^="Open workstream details"]').first().click();
    await page.getByRole('dialog').waitFor();
    await page.screenshot({ path: path.join(flowFrames, 'frame-03.png') });
    await page.keyboard.press('Escape');

    await run('ffmpeg', [
      '-y',
      '-framerate',
      '1',
      '-start_number',
      '1',
      '-i',
      path.join(flowFrames, 'frame-%02d.png'),
      '-vf',
      'scale=1280:-2:flags=lanczos,format=yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      path.join(mcDir, 'flow-desktop.mp4'),
    ]);
    await run('ffmpeg', [
      '-y',
      '-framerate',
      '1',
      '-start_number',
      '1',
      '-i',
      path.join(flowFrames, 'frame-%02d.png'),
      '-vf',
      'fps=10,scale=960:-2:flags=lanczos',
      path.join(mcDir, 'flow-desktop.gif'),
    ]);

    await page.close();
    await context.close();
  }

  // 2) Mobile: narrow-width validation (demo mode + mocked graph).
  {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: 'reduce',
    });
    await context.addInitScript(() => {
      window.localStorage.setItem('orgx.onboarding.skip', '1');
      window.localStorage.setItem('orgx.first_run_guide.dismissed', '1');
    });
    await context.route('**/orgx/api/mission-control/graph?*', async (route) => {
      const url = new URL(route.request().url());
      const id = url.searchParams.get('initiative_id');
      const payload = mockMissionControlGraph(id ?? 'init-1');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${baseUrl}/?demo=1&view=mission-control`, { waitUntil: 'load' });
    await page.getByPlaceholder('Search initiatives, status, or category...').waitFor();
    await disableAnimations(page);
    await page.screenshot({ path: path.join(mcDir, 'mobile-01-mission-control.png') });
    await page.close();
    await context.close();
  }

  // 3) Disconnected banner state (skip gate; backend unavailable).
  {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    await context.addInitScript(() => {
      window.localStorage.setItem('orgx.onboarding.skip', '1');
      window.localStorage.setItem('orgx.first_run_guide.dismissed', '1');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${baseUrl}/?view=mission-control`, { waitUntil: 'load' });
    await page.getByPlaceholder('Search initiatives, status, or category...').waitFor();
    await disableAnimations(page);
    await page.screenshot({ path: path.join(mcDir, 'desktop-90-disconnected.png') });
    await page.close();
    await context.close();
  }

  // 4) Empty state (skip gate; snapshot returns empty sessions/activity).
  {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    await context.addInitScript(() => {
      window.localStorage.setItem('orgx.onboarding.skip', '1');
      window.localStorage.setItem('orgx.first_run_guide.dismissed', '1');
    });
    await context.route('**/orgx/api/dashboard-bundle?*', async (route) => {
      const generatedAt = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshotEmpty(generatedAt)),
      });
    });
    await context.route('**/orgx/api/live/snapshot?*', async (route) => {
      const generatedAt = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshotEmpty(generatedAt)),
      });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${baseUrl}/?view=mission-control`, { waitUntil: 'load' });
    await page.getByPlaceholder('Search initiatives, status, or category...').waitFor();
    await disableAnimations(page);
    await page.screenshot({ path: path.join(mcDir, 'desktop-91-empty.png') });
    await page.close();
    await context.close();
  }

  await writeGridIndexHtml(mcDir, 'Mission Control QA Evidence');
  if (verbose) console.log(`[qa] mission-control evidence: ${mcDir}`);
}

async function main() {
  const { date, port, skipBuild, verbose } = parseArgs(process.argv);
  const repoRoot = process.cwd();
  const outDir = path.join(repoRoot, 'docs', 'qa', date);
  const baseUrl = `http://127.0.0.1:${port}`;
  const appBaseUrl = `${baseUrl}/orgx/live`;

  await mkdir(outDir, { recursive: true });

  if (!skipBuild) {
    await run('npm', ['--prefix', 'dashboard', 'run', 'build'], { cwd: repoRoot });
  }

  // The dashboard build expects to be hosted under `/orgx/live/` (absolute asset paths).
  // Create a temp directory with that path shape so a simple static server can host it.
  const serveRoot = await mkdtemp(path.join(os.tmpdir(), 'orgx-openclaw-dashboard-serve-'));
  const liveRoot = path.join(serveRoot, 'orgx', 'live');
  await mkdir(path.join(liveRoot, 'assets'), { recursive: true });
  await mkdir(path.join(liveRoot, 'brand'), { recursive: true });
  await cp(path.join(repoRoot, 'dashboard', 'dist', 'index.html'), path.join(liveRoot, 'index.html'));
  await cp(path.join(repoRoot, 'dashboard', 'dist', 'assets'), path.join(liveRoot, 'assets'), {
    recursive: true,
  });
  await cp(path.join(repoRoot, 'dashboard', 'dist', 'brand'), path.join(liveRoot, 'brand'), {
    recursive: true,
  });

  const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
    cwd: serveRoot,
    stdio: verbose ? 'inherit' : 'ignore',
  });

  try {
    await waitForHttpOk(`${appBaseUrl}/`, 12_000);

    const executablePath = chromeExecutablePath();
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });

    try {
      await captureActivityEvidence(browser, appBaseUrl, outDir, { verbose });
      await captureMissionControlEvidence(browser, appBaseUrl, outDir, { verbose });
    } finally {
      await browser.close();
    }

    await writeFile(
      path.join(outDir, 'README.md'),
      `# QA Evidence (${date})\n\n- Activity View: \`./activity-view/index.html\`\n- Mission Control: \`./mission-control/index.html\`\n\nGenerated via \`npm run qa:capture -- --date ${date}\`.\n`,
      'utf8'
    );
  } finally {
    server.kill('SIGTERM');
    await rm(serveRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
