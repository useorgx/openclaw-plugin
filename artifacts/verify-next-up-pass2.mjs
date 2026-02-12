import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const PORT = 4183;
const repoRoot = '/Users/hopeatina/Code/orgx-openclaw-plugin';
const appBaseUrl = `http://127.0.0.1:${PORT}/orgx/live`;
const screenshotDir = path.join(repoRoot, 'artifacts');

function chromeExecutablePath() {
  if (process.env.PLAYWRIGHT_CHROME_PATH) return process.env.PLAYWRIGHT_CHROME_PATH;
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  return null;
}

async function waitForHttpOk(url, timeoutMs = 12_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 220));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function mockMissionControlGraph(initiativeId) {
  const now = new Date().toISOString();
  const title = initiativeId === 'init-2' ? 'Black Friday Email' : 'Q4 Feature Ship';
  const wsPrimary = initiativeId === 'init-2' ? 'ws-2' : 'ws-4';
  const wsSecondary = initiativeId === 'init-2' ? 'ws-3' : 'ws-5';
  const ms1 = `${initiativeId}-ms-1`;
  const taskReady = `${initiativeId}-task-ready`;
  const taskTodo = `${initiativeId}-task-todo`;

  return {
    initiative: {
      id: initiativeId,
      title,
      status: 'active',
      summary: 'Mock Mission Control graph for UX verification.',
      assignedAgents: [{ id: 'dana', name: 'Dana', domain: 'design' }],
    },
    nodes: [
      {
        id: initiativeId,
        type: 'initiative',
        title,
        status: 'active',
        parentId: null,
        initiativeId,
        workstreamId: null,
        milestoneId: null,
        priorityNum: 50,
        priorityLabel: null,
        dependencyIds: [],
        dueDate: null,
        etaEndAt: null,
        expectedDurationHours: 24,
        expectedBudgetUsd: 900,
        assignedAgents: [{ id: 'dana', name: 'Dana', domain: 'design' }],
        updatedAt: now,
      },
      {
        id: wsPrimary,
        type: 'workstream',
        title: initiativeId === 'init-2' ? 'Audience targeting' : 'Dashboard UI pass',
        status: 'in_progress',
        parentId: initiativeId,
        initiativeId,
        workstreamId: wsPrimary,
        milestoneId: null,
        priorityNum: 20,
        priorityLabel: 'high',
        dependencyIds: [],
        dueDate: null,
        etaEndAt: null,
        expectedDurationHours: 10,
        expectedBudgetUsd: 220,
        assignedAgents: [{ id: 'dana', name: 'Dana', domain: 'design' }],
        updatedAt: now,
      },
      {
        id: wsSecondary,
        type: 'workstream',
        title: initiativeId === 'init-2' ? 'Creative approvals' : 'Usage tracking instrumentation',
        status: 'todo',
        parentId: initiativeId,
        initiativeId,
        workstreamId: wsSecondary,
        milestoneId: null,
        priorityNum: 35,
        priorityLabel: 'medium',
        dependencyIds: [],
        dueDate: null,
        etaEndAt: null,
        expectedDurationHours: 8,
        expectedBudgetUsd: 160,
        assignedAgents: [{ id: 'eli', name: 'Eli', domain: 'engineering' }],
        updatedAt: now,
      },
      {
        id: ms1,
        type: 'milestone',
        title: initiativeId === 'init-2' ? 'Launch prep' : 'QA + polish',
        status: 'todo',
        parentId: wsPrimary,
        initiativeId,
        workstreamId: wsPrimary,
        milestoneId: ms1,
        priorityNum: 25,
        priorityLabel: 'high',
        dependencyIds: [],
        dueDate: null,
        etaEndAt: null,
        expectedDurationHours: 4,
        expectedBudgetUsd: 90,
        assignedAgents: [],
        updatedAt: now,
      },
      {
        id: taskReady,
        type: 'task',
        title: initiativeId === 'init-2' ? 'Define targeting cohorts' : 'Improve initiative title readability',
        status: 'done',
        parentId: ms1,
        initiativeId,
        workstreamId: wsPrimary,
        milestoneId: ms1,
        priorityNum: 10,
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
        id: taskTodo,
        type: 'task',
        title: initiativeId === 'init-2' ? 'Prepare campaign launch checklist' : 'Verify row spacing and motion',
        status: 'todo',
        parentId: ms1,
        initiativeId,
        workstreamId: wsPrimary,
        milestoneId: ms1,
        priorityNum: 14,
        priorityLabel: 'high',
        dependencyIds: [taskReady],
        dueDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        etaEndAt: null,
        expectedDurationHours: 3,
        expectedBudgetUsd: 50,
        assignedAgents: [{ id: 'eli', name: 'Eli', domain: 'engineering' }],
        updatedAt: now,
      },
    ],
    edges: [{ from: taskReady, to: taskTodo, kind: 'depends_on' }],
    recentTodos: [taskTodo],
    degraded: [],
  };
}

function entityRows(type, initiativeId) {
  const graph = mockMissionControlGraph(initiativeId);
  if (type === 'initiative') {
    return [
      {
        id: initiativeId,
        title: graph.initiative.title,
        name: graph.initiative.title,
        status: 'active',
        summary: graph.initiative.summary,
      },
    ];
  }
  if (type === 'workstream') {
    return graph.nodes
      .filter((node) => node.type === 'workstream')
      .map((node) => ({
        id: node.id,
        title: node.title,
        name: node.title,
        status: node.status,
        initiative_id: initiativeId,
      }));
  }
  if (type === 'milestone') {
    return graph.nodes
      .filter((node) => node.type === 'milestone')
      .map((node) => ({
        id: node.id,
        title: node.title,
        status: node.status,
        initiative_id: initiativeId,
        workstream_id: node.workstreamId,
      }));
  }
  if (type === 'task') {
    return graph.nodes
      .filter((node) => node.type === 'task')
      .map((node) => ({
        id: node.id,
        title: node.title,
        status: node.status,
        priority: node.priorityLabel ?? 'medium',
        due_date: node.dueDate,
        initiative_id: initiativeId,
        milestone_id: node.milestoneId,
        workstream_id: node.workstreamId,
      }));
  }
  return [];
}

const baseQueueItems = [
  {
    initiativeId: 'init-1',
    initiativeTitle: 'Q4 Feature Ship',
    initiativeStatus: 'active',
    workstreamId: 'ws-4',
    workstreamTitle: 'Dashboard UI pass',
    workstreamStatus: 'in_progress',
    nextTaskId: 'task-dash-1',
    nextTaskTitle: 'Verify row spacing and motion',
    nextTaskPriority: 12,
    nextTaskDueAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    runnerAgentId: 'dana',
    runnerAgentName: 'Dana',
    runnerSource: 'assigned',
    queueState: 'queued',
    blockReason: null,
  },
  {
    initiativeId: 'init-2',
    initiativeTitle: 'Black Friday Email',
    initiativeStatus: 'active',
    workstreamId: 'ws-2',
    workstreamTitle: 'Audience targeting',
    workstreamStatus: 'in_progress',
    nextTaskId: 'task-bf-1',
    nextTaskTitle: 'Define targeting cohorts',
    nextTaskPriority: 18,
    nextTaskDueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    runnerAgentId: 'eli',
    runnerAgentName: 'Eli',
    runnerSource: 'assigned',
    queueState: 'queued',
    blockReason: null,
  },
];

function queueForRequest(initiativeId, autoRuns) {
  return baseQueueItems
    .filter((item) => !initiativeId || item.initiativeId === initiativeId)
    .map((item) => {
      const run = autoRuns.get(item.initiativeId) ?? null;
      const runningForWorkstream =
        run && (!run.workstreamId || run.workstreamId === item.workstreamId) && run.status === 'running';
      return {
        ...item,
        queueState: runningForWorkstream ? 'running' : item.queueState,
        autoContinue: runningForWorkstream
          ? {
              status: run.status,
              activeTaskId: item.nextTaskId,
              activeRunId: run.activeRunId,
              stopReason: null,
              updatedAt: run.updatedAt,
            }
          : null,
      };
    });
}

async function main() {
  await mkdir(screenshotDir, { recursive: true });

  const serveRoot = await mkdtemp(path.join(os.tmpdir(), 'orgx-nextup-verify-'));
  const liveRoot = path.join(serveRoot, 'orgx', 'live');
  await mkdir(liveRoot, { recursive: true });
  await cp(path.join(repoRoot, 'dashboard', 'dist'), liveRoot, { recursive: true });
  await cp(path.join(repoRoot, 'dashboard', 'public', 'brand'), path.join(liveRoot, 'brand'), { recursive: true });

  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: serveRoot,
    stdio: 'ignore',
  });

  const checks = [];
  const interactionStats = [];
  const consoleProblems = [];
  const autoRuns = new Map();
  let browser;

  const check = (name, pass, detail) => {
    checks.push({ name, pass: Boolean(pass), detail });
  };

  try {
    await waitForHttpOk(`${appBaseUrl}/`, 14_000);
    const executablePath = chromeExecutablePath();
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const context = await browser.newContext({
      viewport: { width: 1512, height: 960 },
      reducedMotion: 'no-preference',
    });

    await context.addInitScript(() => {
      try {
        window.localStorage.setItem('orgx.onboarding.skip', '1');
        window.localStorage.setItem('orgx.first_run_guide.dismissed', '1');
        window.localStorage.setItem('orgx-dashboard-view', 'mission-control');
      } catch {}
    });

    await context.route('**/orgx/api/mission-control/graph*', async (route) => {
      const url = new URL(route.request().url());
      const initiativeId = url.searchParams.get('initiative_id') || 'init-1';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockMissionControlGraph(initiativeId)),
      });
    });

    await context.route('**/orgx/api/mission-control/next-up*', async (route) => {
      const url = new URL(route.request().url());
      const initiativeId = url.searchParams.get('initiative_id');
      const items = queueForRequest(initiativeId, autoRuns);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          generatedAt: new Date().toISOString(),
          total: items.length,
          items,
          degraded: [],
        }),
      });
    });

    await context.route('**/orgx/api/mission-control/next-up/play', async (route) => {
      const payload = route.request().postDataJSON?.() ?? {};
      const now = new Date().toISOString();
      autoRuns.set(payload.initiativeId ?? 'init-1', {
        initiativeId: payload.initiativeId ?? 'init-1',
        workstreamId: payload.workstreamId ?? null,
        status: 'running',
        activeRunId: `run-${Date.now()}`,
        updatedAt: now,
      });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await context.route('**/orgx/api/mission-control/auto-continue/status*', async (route) => {
      const url = new URL(route.request().url());
      const initiativeId = url.searchParams.get('initiative_id');
      const run = initiativeId ? autoRuns.get(initiativeId) ?? null : null;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, initiativeId, run, defaults: { tokenBudget: 12000, tickMs: 2500 } }),
      });
    });

    await context.route('**/orgx/api/mission-control/auto-continue/start', async (route) => {
      const payload = route.request().postDataJSON?.() ?? {};
      const initiativeId = payload.initiativeId ?? 'init-1';
      const workstreamId = Array.isArray(payload.workstreamIds) ? payload.workstreamIds[0] : null;
      const now = new Date().toISOString();
      const run = {
        initiativeId,
        workstreamId,
        status: 'running',
        activeRunId: `run-${Date.now()}`,
        updatedAt: now,
      };
      autoRuns.set(initiativeId, run);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, run }) });
    });

    await context.route('**/orgx/api/mission-control/auto-continue/stop', async (route) => {
      const payload = route.request().postDataJSON?.() ?? {};
      const initiativeId = payload.initiativeId ?? 'init-1';
      const run = autoRuns.get(initiativeId);
      if (run) {
        run.status = 'stopped';
        run.updatedAt = new Date().toISOString();
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, run }) });
    });

    await context.route('**/orgx/api/entities*', async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        const url = new URL(req.url());
        const type = (url.searchParams.get('type') || '').toLowerCase();
        const initiativeId = url.searchParams.get('initiative_id') || 'init-1';
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: entityRows(type, initiativeId) }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'warning' || msg.type() === 'error') {
        consoleProblems.push(`${msg.type()}: ${msg.text()}`);
      }
    });

    await page.goto(`${appBaseUrl}/?demo=1&view=mission-control`, { waitUntil: 'load' });
    await page.waitForSelector('input[placeholder="Search initiatives..."]', { timeout: 15000 });

    await page.evaluate(() => {
      window.__perf = { cls: 0, probe: null };
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.hadRecentInput) continue;
          window.__perf.cls += entry.value;
        }
      });
      observer.observe({ type: 'layout-shift', buffered: true });
      window.__probeStart = (duration = 900) => {
        const state = { running: true, until: performance.now() + duration, times: [] };
        window.__perf.probe = state;
        const tick = (t) => {
          if (!state.running) return;
          state.times.push(t);
          if (t < state.until) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      };
      window.__probeStop = () => {
        const state = window.__perf.probe;
        if (!state) return null;
        state.running = false;
        const deltas = [];
        for (let i = 1; i < state.times.length; i += 1) deltas.push(state.times[i] - state.times[i - 1]);
        return {
          frames: deltas.length,
          maxDelta: deltas.length ? Math.max(...deltas) : 0,
          over24: deltas.filter((d) => d > 24).length,
          over50: deltas.filter((d) => d > 50).length,
        };
      };
    });

    const probe = async (name, action, settleMs = 500) => {
      await page.evaluate(() => window.__probeStart(950));
      await action();
      await page.waitForTimeout(settleMs);
      const stats = await page.evaluate(() => window.__probeStop());
      interactionStats.push({ name, ...stats });
      return stats;
    };

    const selectionBar = page.locator('[data-mc-selection-bar="true"]');
    await selectionBar.waitFor({ state: 'visible', timeout: 10000 });
    check('next_up_summary_is_inline_with_selection_bar', await selectionBar.locator('text=Next Up').first().isVisible(), null);
    check(
      'next_up_inline_controls_present',
      (await selectionBar.locator('button:has-text("▶ Play")').count()) > 0 &&
        (await selectionBar.locator('button[title*="Next Up rail"]').count()) > 0,
      null
    );

    const collapsedHeadingCount = await page.locator('h2:has-text("Next Up"):visible').count();
    check('mission_control_starts_without_expanded_next_up_rail', collapsedHeadingCount === 0, { collapsedHeadingCount });

    const heroText = await page.locator('.surface-hero').first().innerText();
    check(
      'next_action_copy_matches_queued_state',
      /Ready to dispatch|Play next workstream/i.test(heroText) && !/Blocked work needs a decision/i.test(heroText),
      { heroText: heroText.slice(0, 220) }
    );

    const initiativeHeaderBefore = await page.locator('div[id^="initiative-"] > div[role="button"]').first().boundingBox();
    const openRailButton = selectionBar.locator('button[title*="Expand Next Up rail"]').first();
    const openDesktopStats = await probe('expand_next_up_rail_desktop', async () => {
      await openRailButton.click();
    }, 680);
    check('desktop_rail_expand_animation_no_jank', Boolean(openDesktopStats && openDesktopStats.over50 === 0), openDesktopStats);

    const nextUpHeading = page.locator('h2:has-text("Next Up"):visible').first();
    await nextUpHeading.waitFor({ state: 'visible', timeout: 7000 });
    const nextUpBox = await nextUpHeading.boundingBox();
    const initiativeHeaderAfter = await page.locator('div[id^="initiative-"] > div[role="button"]').first().boundingBox();
    check(
      'mission_control_next_up_rail_opens_right_side_desktop',
      Boolean(nextUpBox && nextUpBox.x > 860),
      { nextUpBox }
    );
    check(
      'initiative_area_shrinks_when_rail_expands',
      Boolean(
        initiativeHeaderBefore &&
          initiativeHeaderAfter &&
          initiativeHeaderBefore.width - initiativeHeaderAfter.width > 180
      ),
      { before: initiativeHeaderBefore, after: initiativeHeaderAfter }
    );

    const desktopAvatarCount = await page.locator('article .w-8.h-8').count();
    check('next_up_shows_runner_avatars_desktop', desktopAvatarCount > 0, { desktopAvatarCount });

    await probe('play_workstream_from_inline_next_up', async () => {
      await selectionBar.locator('button:has-text("▶ Play")').first().click();
    }, 720);
    check(
      'inline_play_dispatch_notice_visible',
      await page.locator('text=/Dispatched/i').first().isVisible(),
      null
    );

    const followNextActionButton = page.locator('.surface-hero button:has-text("Follow workstream")').first();
    if (await followNextActionButton.isVisible().catch(() => false)) {
      await probe('follow_from_next_action_hero', async () => {
        await followNextActionButton.click();
      }, 680);
      await page.getByRole('heading', { name: 'Activity' }).first().waitFor({ timeout: 7000 });
      check(
        'follow_from_next_action_switches_to_activity',
        await page.locator('button[aria-label="Clear workstream filter"]').first().isVisible(),
        null
      );

      const missionControlButton = page.locator('button:has-text("Mission Control")').first();
      await probe('return_to_mission_control_after_follow', async () => {
        await missionControlButton.click();
      }, 520);
      await page.waitForSelector('input[placeholder="Search initiatives..."]', { timeout: 8000 });
    } else {
      check('follow_button_visible_after_inline_play', false, 'Follow workstream button not visible after dispatch');
    }

    await page.screenshot({ path: path.join(screenshotDir, 'ux-verify-pass3-mission-desktop-expanded.png'), fullPage: true });

    await page.setViewportSize({ width: 1180, height: 900 });
    await page.waitForTimeout(280);

    const mediumSelectionBar = page.locator('[data-mc-selection-bar="true"]');
    const drawerButton = mediumSelectionBar.locator('button[title*="Expand Next Up rail"], button[title*="Collapse Next Up rail"]').first();
    check('mission_control_has_inline_next_up_trigger_medium', await drawerButton.isVisible(), null);
    const openStats = await probe('open_next_up_drawer_medium', async () => {
      await drawerButton.click();
    }, 620);
    check('drawer_open_animation_no_jank', Boolean(openStats && openStats.over50 === 0), openStats);

    const drawerClose = page.locator('button[aria-label="Close next up panel"]');
    await drawerClose.waitFor({ state: 'visible', timeout: 5000 });
    const drawerHeadingBox = await page.locator('h2:has-text("Next Up"):visible').first().boundingBox();
    check(
      'next_up_drawer_from_right_medium',
      Boolean(drawerHeadingBox && drawerHeadingBox.x > 640),
      { drawerHeadingBox }
    );

    await page.screenshot({ path: path.join(screenshotDir, 'ux-verify-pass3-mission-drawer-open.png'), fullPage: true });

    await probe('close_next_up_drawer_medium', async () => {
      await drawerClose.click();
    }, 360);

    await page.screenshot({ path: path.join(screenshotDir, 'ux-verify-pass3-mission-drawer-closed.png'), fullPage: true });

    const finalCls = await page.evaluate(() => Number((window.__perf.cls || 0).toFixed(6)));
    check('cls_below_threshold', finalCls <= 0.02, { finalCls, threshold: 0.02 });

    await context.close();
  } finally {
    try {
      if (browser) await browser.close();
    } catch {}
    server.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      await rm(serveRoot, { recursive: true, force: true });
    } catch {}
  }

  const failed = checks.filter((entry) => !entry.pass);
  const result = {
    generatedAt: new Date().toISOString(),
    baseUrl: appBaseUrl,
    checks,
    failedChecks: failed.length,
    interactionStats,
    consoleProblems,
  };

  console.log(JSON.stringify(result, null, 2));
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
