import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const PORT = 4181;
const repoRoot = '/Users/hopeatina/Code/orgx-openclaw-plugin';
const appBaseUrl = `http://127.0.0.1:${PORT}/orgx/live`;
const outDir = path.join(repoRoot, 'artifacts', 'ux-audit');

function chromeExecutablePath() {
  if (process.env.PLAYWRIGHT_CHROME_PATH) return process.env.PLAYWRIGHT_CHROME_PATH;
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  return null;
}

async function waitForHttpOk(url, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function mockMissionControlGraph(initiativeId) {
  const now = new Date().toISOString();
  const title =
    initiativeId === 'init-1'
      ? 'Q4 Feature Ship'
      : initiativeId === 'init-2'
        ? 'Black Friday Email'
        : 'Initiative';

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
      summary: 'Mock graph for UX audit.',
      assignedAgents: [],
    },
    nodes,
    edges,
    recentTodos: [t2Id],
  };
}

function parseInitiativeIdFromGraphRequest(urlString) {
  const url = new URL(urlString);
  return url.searchParams.get('initiative_id') || 'init-1';
}

function entitiesForType(type, initiativeId) {
  const graph = mockMissionControlGraph(initiativeId);
  if (type === 'workstream') {
    return graph.nodes
      .filter((n) => n.type === 'workstream')
      .map((n) => ({
        id: n.id,
        name: n.title,
        status: n.status,
        progress: null,
        summary: null,
        initiative_id: initiativeId,
        created_at: n.updatedAt,
      }));
  }
  if (type === 'milestone') {
    return graph.nodes
      .filter((n) => n.type === 'milestone')
      .map((n) => ({
        id: n.id,
        title: n.title,
        status: n.status,
        description: null,
        due_date: n.dueDate,
        initiative_id: initiativeId,
        workstream_id: n.workstreamId,
        created_at: n.updatedAt,
      }));
  }
  if (type === 'task') {
    return graph.nodes
      .filter((n) => n.type === 'task')
      .map((n) => ({
        id: n.id,
        title: n.title,
        status: n.status,
        description: null,
        priority: n.priorityLabel ?? `p${n.priorityNum}`,
        due_date: n.dueDate,
        initiative_id: initiativeId,
        milestone_id: n.milestoneId,
        workstream_id: n.workstreamId,
        created_at: n.updatedAt,
      }));
  }
  return [];
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const serveRoot = await mkdtemp(path.join(os.tmpdir(), 'orgx-ux-serve-'));
  const liveRoot = path.join(serveRoot, 'orgx', 'live');
  await mkdir(liveRoot, { recursive: true });
  await cp(path.join(repoRoot, 'dashboard', 'dist'), liveRoot, { recursive: true });

  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: serveRoot,
    stdio: 'ignore',
  });

  let browser;
  try {
    await waitForHttpOk(`${appBaseUrl}/`, 12_000);

    const executablePath = chromeExecutablePath();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });

    const context = await browser.newContext({
      viewport: { width: 1512, height: 980 },
      reducedMotion: 'no-preference',
    });

    let autoRun = null;
    let nextUpUpgradeGateOnce = true;

    await context.addInitScript(() => {
      try {
        window.localStorage.setItem('orgx.onboarding.skip', '1');
        window.localStorage.setItem('orgx.first_run_guide.dismissed', '1');
        window.localStorage.setItem('orgx-dashboard-view', 'mission-control');
      } catch {}
    });

    await context.route('**/orgx/api/mission-control/graph?*', async (route) => {
      const id = parseInitiativeIdFromGraphRequest(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockMissionControlGraph(id)),
      });
    });

    await context.route('**/orgx/api/mission-control/auto-continue/status?*', async (route) => {
      const url = new URL(route.request().url());
      const initiativeId = url.searchParams.get('initiative_id');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          initiativeId,
          run: autoRun,
          defaults: { tokenBudget: 12000, tickMs: 2500 },
        }),
      });
    });

    await context.route('**/orgx/api/mission-control/next-up?*', async (route) => {
      const now = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          generatedAt: now,
          total: 1,
          items: [
            {
              initiativeId: 'init-1',
              initiativeTitle: 'Q4 Feature Ship',
              initiativeStatus: 'active',
              workstreamId: 'ws-4',
              workstreamTitle: 'Dashboard UI pass',
              workstreamStatus: 'in_progress',
              nextTaskId: 'init-1-task-2',
              nextTaskTitle: 'Screenshot grid evidence',
              nextTaskPriority: null,
              nextTaskDueAt: null,
              runnerAgentId: 'engineering-agent',
              runnerAgentName: 'Eli',
              runnerSource: 'assigned',
              queueState: autoRun?.status === 'running' ? 'running' : 'queued',
              blockReason: null,
              autoContinue: autoRun
                ? {
                    status: autoRun.status,
                    activeTaskId: autoRun.activeTaskId,
                    activeRunId: autoRun.activeRunId,
                    stopReason: autoRun.stopReason,
                    updatedAt: autoRun.updatedAt,
                  }
                : null,
            },
          ],
          degraded: [],
        }),
      });
    });

    await context.route('**/orgx/api/mission-control/auto-continue/start', async (route) => {
      const now = new Date().toISOString();
      const payload = route.request().postDataJSON?.() ?? {};

      if (
        nextUpUpgradeGateOnce &&
        Array.isArray(payload.workstreamIds) &&
        payload.workstreamIds.length > 0
      ) {
        nextUpUpgradeGateOnce = false;
        await route.fulfill({
          status: 402,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: false,
            code: 'upgrade_required',
            error:
              'Auto-continue for BYOK agents requires a paid OrgX plan. Upgrade, then retry.',
            currentPlan: 'free',
            requiredPlan: 'starter',
            actions: {
              checkout: '/orgx/api/billing/checkout',
              portal: '/orgx/api/billing/portal',
              pricing: 'https://useorgx.com/pricing',
            },
          }),
        });
        return;
      }

      autoRun = {
        initiativeId: payload.initiativeId ?? 'init-1',
        agentId: 'engineering-agent',
        tokenBudget: 12000,
        tokensUsed: 0,
        status: 'running',
        stopReason: null,
        stopRequested: false,
        startedAt: now,
        stoppedAt: null,
        updatedAt: now,
        lastError: null,
        lastTaskId: 'task-1',
        lastRunId: 'run-1',
        activeTaskId: 'task-1',
        activeRunId: 'run-1',
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, run: autoRun }),
      });
    });

    await context.route('**/orgx/api/billing/checkout', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { url: 'https://useorgx.com/pricing' } }),
      });
    });

    await context.route('**/orgx/api/billing/portal', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { url: 'https://useorgx.com/pricing' } }),
      });
    });

    await context.route('**/orgx/api/mission-control/auto-continue/stop', async (route) => {
      if (autoRun) {
        const now = new Date().toISOString();
        autoRun = {
          ...autoRun,
          status: 'stopped',
          stopReason: 'stopped',
          stopRequested: true,
          stoppedAt: now,
          updatedAt: now,
          activeTaskId: null,
          activeRunId: null,
        };
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, run: autoRun }),
      });
    });

    await context.route('**/orgx/api/entities?*', async (route) => {
      const request = route.request();
      const method = request.method();
      if (method === 'GET') {
        const url = new URL(request.url());
        const type = (url.searchParams.get('type') || '').toLowerCase();
        const initiativeId = url.searchParams.get('initiative_id') || 'init-1';
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: entitiesForType(type, initiativeId) }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await context.route('**/orgx/api/entities/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    const page = await context.newPage();
    const consoleWarnings = [];
    page.on('console', (msg) => {
      if (['warning', 'error'].includes(msg.type())) {
        consoleWarnings.push(`${msg.type()}: ${msg.text()}`);
      }
    });

    await page.goto(`${appBaseUrl}/?demo=1&view=mission-control`, { waitUntil: 'load' });
    await page.waitForSelector('input[placeholder="Search initiatives..."]', { timeout: 15000 });

    await page.evaluate(() => {
      window.__ux = {
        cls: 0,
        entries: [],
        rafState: null,
      };

      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.hadRecentInput) continue;
          window.__ux.cls += entry.value;
          window.__ux.entries.push({
            value: entry.value,
            startTime: entry.startTime,
          });
        }
      });
      po.observe({ type: 'layout-shift', buffered: true });

      window.__startProbe = (duration = 900) => {
        const state = {
          running: true,
          until: performance.now() + duration,
          times: [],
        };
        window.__ux.rafState = state;
        const tick = (t) => {
          if (!state.running) return;
          state.times.push(t);
          if (t < state.until) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      };

      window.__stopProbe = () => {
        const state = window.__ux.rafState;
        if (!state) return null;
        state.running = false;
        const deltas = [];
        for (let i = 1; i < state.times.length; i += 1) {
          deltas.push(state.times[i] - state.times[i - 1]);
        }
        const maxDelta = deltas.length ? Math.max(...deltas) : 0;
        const avgDelta = deltas.length
          ? deltas.reduce((sum, v) => sum + v, 0) / deltas.length
          : 0;
        const over24 = deltas.filter((v) => v > 24).length;
        const over50 = deltas.filter((v) => v > 50).length;
        return {
          frameCount: deltas.length,
          maxDelta,
          avgDelta,
          over24,
          over50,
        };
      };
    });

    const interactions = [];

    const runInteraction = async (name, fn, settleMs = 450) => {
      const clsBefore = await page.evaluate(() => window.__ux.cls || 0);
      await page.evaluate(() => window.__startProbe(950));
      await fn();
      await page.waitForTimeout(settleMs);
      const probe = await page.evaluate(() => window.__stopProbe());
      const clsAfter = await page.evaluate(() => window.__ux.cls || 0);
      interactions.push({
        name,
        clsDelta: Number((clsAfter - clsBefore).toFixed(4)),
        probe,
      });
    };

    await page.screenshot({ path: path.join(outDir, '00-initial.png'), fullPage: true });

    const expandAllButton = page.locator('button[title="Expand all"], button[title="Collapse all"]').first();
    if (await expandAllButton.isVisible().catch(() => false)) {
      const title = await expandAllButton.getAttribute('title');
      if (title === 'Expand all') {
        await runInteraction('expand_all_initiatives', async () => {
          await expandAllButton.click();
        });
      }
    }

    const firstHeader = page.locator('div[id^="initiative-"] > div[role="button"]').first();
    if (await firstHeader.isVisible().catch(() => false)) {
      const expanded = await firstHeader.getAttribute('aria-expanded');
      if (expanded !== 'true') {
        await runInteraction('expand_first_initiative', async () => {
          await firstHeader.click();
        });
      }
    }

    const autoButton = page.getByRole('button', { name: /Start Autopilot|Stop Autopilot/i }).first();
    if (await autoButton.isVisible().catch(() => false)) {
      await runInteraction('autopilot_start', async () => {
        await autoButton.click();
      }, 650);
      await runInteraction('autopilot_stop', async () => {
        await autoButton.click();
      }, 650);
    }

    const nextUpOpenButton = page.locator('button[title="Expand Next Up rail"]').first();
    if (await nextUpOpenButton.isVisible().catch(() => false)) {
      await runInteraction('next_up_open_rail', async () => {
        await nextUpOpenButton.click();
      }, 650);
    }

    const nextUpCard = page.locator('section').filter({
      has: page.getByRole('heading', { name: /^Next Up$/i }),
    }).first();
    const nextUpAutoButton = nextUpCard.getByRole('button', { name: /^Auto$/i }).first();
    if (await nextUpAutoButton.isVisible().catch(() => false)) {
      await runInteraction('next_up_auto_upgrade_gate', async () => {
        await nextUpAutoButton.click();
      }, 720);
      await page.waitForSelector('text=Upgrade required', { timeout: 2500 }).catch(() => {});
    }

    const initiativeCheckboxes = page.locator('input[aria-label^="Select initiative "]');
    const checkboxCount = await initiativeCheckboxes.count();
    if (checkboxCount > 0) {
      await runInteraction('select_first_initiative_row', async () => {
        await initiativeCheckboxes.nth(0).click();
      });
      if (checkboxCount > 1) {
        await runInteraction('select_second_initiative_row', async () => {
          await initiativeCheckboxes.nth(1).click();
        });
      }
    }

    const topSelectVisible = page
      .locator('[data-mc-selection-bar="true"] button:has-text("Select visible"), [data-mc-selection-bar="true"] button:has-text("Clear visible")')
      .first();
    if (await topSelectVisible.isVisible().catch(() => false)) {
      await runInteraction('initiative_bulk_select_visible_toggle', async () => {
        await topSelectVisible.click();
      });
    }

    const topClearSelection = page.locator('[data-mc-selection-bar="true"] button:has-text("Clear")').first();
    if (await topClearSelection.isVisible().catch(() => false)) {
      await runInteraction('initiative_bulk_clear_selection', async () => {
        await topClearSelection.click();
      });
    }

    const hierarchyToggle = page.getByRole('button', { name: /^Hierarchy$/i }).first();
    if (await hierarchyToggle.isVisible().catch(() => false)) {
      await hierarchyToggle.scrollIntoViewIfNeeded();
      await page.mouse.wheel(0, 320);
      await page.waitForTimeout(220);
    }

    await page.evaluate(() => {
      const scroller = document.querySelector('.h-full.overflow-y-auto.overflow-x-hidden');
      const initiativeHeader = document.querySelector(
        'div[id^="initiative-"] > div[role="button"][aria-expanded="true"]'
      );
      if (scroller && initiativeHeader) {
        const absoluteTop =
          initiativeHeader.getBoundingClientRect().top + scroller.scrollTop;
        scroller.scrollTo({ top: Math.max(0, absoluteTop - 28), behavior: 'auto' });
      }
    });
    await page.waitForTimeout(260);

    const stickyAlignment = await page.evaluate(() => {
      const toolbar = document.querySelector('.sticky.top-0.z-40');
      const initiativeHeader = document.querySelector('div[id^="initiative-"] > div[role="button"][aria-expanded="true"]');
      const hierarchyHeader = Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return text === 'hierarchy';
      });

      const toolbarRect = toolbar?.getBoundingClientRect();
      const initiativeRect = initiativeHeader?.getBoundingClientRect();
      const hierarchyRect = hierarchyHeader?.getBoundingClientRect();

      return {
        toolbarBottom: toolbarRect ? Number(toolbarRect.bottom.toFixed(2)) : null,
        initiativeTop: initiativeRect ? Number(initiativeRect.top.toFixed(2)) : null,
        hierarchyTop: hierarchyRect ? Number(hierarchyRect.top.toFixed(2)) : null,
        initiativeComputedTop: initiativeHeader
          ? getComputedStyle(initiativeHeader).top
          : null,
        hierarchyComputedTop: hierarchyHeader
          ? getComputedStyle(hierarchyHeader).top
          : null,
        initiativeBelowToolbar:
          toolbarRect && initiativeRect ? initiativeRect.top >= toolbarRect.bottom - 2 : null,
        hierarchyBelowToolbar:
          toolbarRect && hierarchyRect ? hierarchyRect.top >= toolbarRect.bottom - 2 : null,
      };
    });

    const hierarchySection = page.locator('section').filter({
      has: page.locator('input[placeholder="Search items or agents..."]'),
    }).first();

    if (await hierarchySection.isVisible().catch(() => false)) {
      const hierarchySelectVisible = hierarchySection.locator('button:has-text("Select visible"), button:has-text("Clear visible")').first();
      if (await hierarchySelectVisible.isVisible().catch(() => false)) {
        await runInteraction('hierarchy_bulk_select_visible_toggle', async () => {
          await hierarchySelectVisible.click();
        });
      }

      const statusButton = hierarchySection.locator('button:has-text("Status")').first();
      if (await statusButton.isVisible().catch(() => false)) {
        await runInteraction('hierarchy_toggle_advanced_status_open', async () => {
          await statusButton.click();
        }, 520);
        await runInteraction('hierarchy_toggle_advanced_status_close', async () => {
          await statusButton.click();
        }, 520);
      }

      const planButton = hierarchySection.locator('button:has-text("Plan")').first();
      if (await planButton.isVisible().catch(() => false)) {
        await runInteraction('hierarchy_bulk_plan_action', async () => {
          await planButton.click();
        }, 520);
      }

      const startButton = hierarchySection.locator('button:has-text("Start")').first();
      if (await startButton.isVisible().catch(() => false)) {
        await runInteraction('hierarchy_bulk_start_action', async () => {
          await startButton.click();
        }, 520);
      }
    }

    await page.screenshot({ path: path.join(outDir, '01-final-state.png'), fullPage: true });

    const finalCls = await page.evaluate(() => Number((window.__ux.cls || 0).toFixed(4)));
    const worstProbe = interactions.reduce(
      (acc, item) => {
        if (!item.probe) return acc;
        if (!acc || item.probe.maxDelta > acc.maxDelta) {
          return { name: item.name, ...item.probe };
        }
        return acc;
      },
      null
    );

    const report = {
      generatedAt: new Date().toISOString(),
      baseUrl: appBaseUrl,
      finalCls,
      stickyAlignment,
      interactionCount: interactions.length,
      interactions,
      worstProbe,
      consoleWarnings,
      thresholds: {
        clsWarningAt: 0.1,
        frameDropWarningMs: 50,
      },
    };

    await writeFile(path.join(outDir, 'mission-control-ux-audit.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));

    await page.close();
    await context.close();
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    server.kill('SIGTERM');
    await rm(serveRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
