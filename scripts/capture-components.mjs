#!/usr/bin/env node

import { cpus } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { chromium } from 'playwright-core';

import {
  REGISTRY_PATH,
  RUNS_ROOT,
  VIEWPORTS,
  ensureDir,
  findLatestManifest,
  gitChangedPaths,
  hashFileSha1,
  loadJson,
  matchesTags,
  parseCliArgs,
  resolveChromeExecutable,
  toRelative,
  writeJson,
} from './qa-components-lib.mjs';
import { ACTIONS } from './qa-actions.mjs';

function createBaselineMap(manifest) {
  const rows = new Map();
  for (const entry of Array.isArray(manifest?.captures) ? manifest.captures : []) {
    const key = `${entry.componentId}::${entry.scenario}::${entry.viewport}::${entry.kind || 'component'}`;
    rows.set(key, entry);
  }
  return rows;
}

function toTasks(components) {
  const tasks = [];
  for (const component of components) {
    const viewports = Array.isArray(component.viewports) ? component.viewports : ['desktop'];
    const scenarios = Array.isArray(component.scenarios) ? component.scenarios : [{ id: 'default' }];
    for (const viewportId of viewports) {
      const viewport = VIEWPORTS[viewportId];
      if (!viewport) continue;
      for (const scenario of scenarios) {
        tasks.push({
          component,
          scenario,
          viewport,
        });
      }
    }
  }
  return tasks;
}

function filterTasksByViewport(tasks, args) {
  if (!args.desktopOnly) return tasks;
  return tasks.filter((task) => task.viewport.id === 'desktop');
}

function inferOwnersFromChangedPaths(changedPaths) {
  const owners = new Set();
  for (const changedPath of changedPaths) {
    const normalized = changedPath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const idx = parts.indexOf('components');
    if (idx >= 0 && parts[idx + 1]) owners.add(parts[idx + 1]);
  }
  return owners;
}

function selectComponents(registry, args, changedPaths) {
  const mapped = registry.components.filter((entry) => entry.status === 'mapped');

  let selected = mapped.filter((entry) => matchesTags(entry, args.tags.length ? args.tags : args.tag ? [args.tag] : []));

  if (args.changed && !args.all) {
    const changedSet = new Set(changedPaths.map((row) => row.replace(/\\/g, '/')));
    const owners = inferOwnersFromChangedPaths(changedPaths);
    const directlyTouched = selected.filter((entry) => changedSet.has(String(entry.componentPath).replace(/\\/g, '/')));

    const touchedIds = new Set(directlyTouched.map((entry) => entry.id));
    const withDependents = new Set(touchedIds);
    let advanced = true;
    while (advanced) {
      advanced = false;
      for (const entry of selected) {
        const dependsOn = Array.isArray(entry.dependsOn) ? entry.dependsOn : [];
        if (dependsOn.some((id) => withDependents.has(id)) && !withDependents.has(entry.id)) {
          withDependents.add(entry.id);
          advanced = true;
        }
      }
    }

    const ownerMatches = selected.filter((entry) => owners.has(entry.owner));
    const criticalFallback = selected.filter((entry) => Array.isArray(entry.tags) && entry.tags.includes('critical'));

    selected = selected.filter((entry) =>
      withDependents.has(entry.id) || ownerMatches.includes(entry) || criticalFallback.includes(entry)
    );
  }

  if (args.limit > 0) selected = selected.slice(0, args.limit);
  return selected;
}

function buildOutputPaths(runRoot, componentId, scenarioId, viewportId) {
  const componentDir = path.join(runRoot, 'components', componentId);
  const base = `${scenarioId}-${viewportId}`;
  return {
    componentDir,
    componentShot: path.join(componentDir, `${base}.png`),
    contextShot: path.join(componentDir, `${base}-context.png`),
    failureShot: path.join(componentDir, `${base}-failure.png`),
  };
}

function selectorCandidates(selectorExpression) {
  return String(selectorExpression || '')
    .split('||')
    .map((part) => part.trim())
    .filter(Boolean);
}

async function waitForTarget(page, selectorExpression, timeoutMs = 12000) {
  const selectors = selectorCandidates(selectorExpression);
  if (!selectors.length) throw new Error('Missing selector');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        if (await locator.isVisible()) {
          return { locator, selector };
        }
      } catch {
        // Ignore transient selector errors and keep probing.
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`No visible target for selectors: ${selectors.join(' || ')}`);
}

async function captureTask(task, runtime) {
  const { component, scenario, viewport } = task;
  const startedAt = Date.now();
  const result = {
    componentId: component.id,
    componentPath: component.componentPath,
    scenario: scenario.id,
    viewport: viewport.id,
    status: 'ok',
    error: null,
    warning: null,
    kind: 'component',
    imagePath: null,
    contextPath: null,
    failurePath: null,
    hash: null,
    baselinePath: null,
    baselineHash: null,
    diffStatus: 'new',
    ms: 0,
  };

  const context = await runtime.browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    reducedMotion: 'reduce',
    colorScheme: 'dark',
    ...(viewport.id === 'mobile'
      ? {
          isMobile: true,
          hasTouch: true,
        }
      : {}),
  });
  const page = await context.newPage();

  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (
      url.includes('google-analytics') ||
      url.includes('segment.io') ||
      url.includes('sentry.io') ||
      url.includes('intercom') ||
      url.includes('mixpanel')
    ) {
      return route.abort();
    }
    return route.continue();
  });

  const paths = buildOutputPaths(runtime.outputDir, component.id, scenario.id, viewport.id);
  try {
    await ensureDir(paths.componentDir);
    const actionName = scenario.openAction || 'openActivityDefault';
    const action = ACTIONS[actionName];
    if (!action) {
      throw new Error(`Unknown openAction "${actionName}" for ${component.id}/${scenario.id}`);
    }
    try {
      await action(page, runtime.scope);
    } catch (actionError) {
      result.warning = `openAction "${actionName}" failed: ${actionError?.message ?? String(actionError)}`;
      const fallbackAction = ACTIONS.openActivityDefault;
      if (fallbackAction) {
        await fallbackAction(page, runtime.scope).catch(() => {});
      }
    }

    const selector = scenario.selector || component.selector;
    let target;
    let resolvedSelector;
    try {
      const found = await waitForTarget(page, selector, 12000);
      target = found.locator;
      resolvedSelector = found.selector;
    } catch (selectorError) {
      resolvedSelector = 'body';
      target = page.locator('body').first();
      await target.waitFor({ state: 'visible', timeout: 5000 });
      result.warning = result.warning
        ? `${result.warning}; selector fallback to body: ${selectorError?.message ?? String(selectorError)}`
        : `selector fallback to body: ${selectorError?.message ?? String(selectorError)}`;
    }
    let componentShotTaken = false;
    let screenshotError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await target.screenshot({ path: paths.componentShot });
        componentShotTaken = true;
        break;
      } catch (shotError) {
        screenshotError = shotError;
        if (attempt === 0) {
          try {
            const retriedTarget = await waitForTarget(page, resolvedSelector, 5000);
            target = retriedTarget.locator;
          } catch {
            // Fall through to viewport fallback after retry attempts.
          }
        }
      }
    }
    if (!componentShotTaken) {
      try {
        await page.screenshot({ path: paths.componentShot, fullPage: false });
        const shotMsg = screenshotError?.message ?? String(screenshotError ?? 'unknown screenshot error');
        result.warning = result.warning
          ? `${result.warning}; component screenshot fallback to viewport: ${shotMsg}`
          : `component screenshot fallback to viewport: ${shotMsg}`;
      } catch (viewportError) {
        throw screenshotError ?? viewportError;
      }
    }
    result.selector = resolvedSelector;

    if (scenario.withContext || component.withContext) {
      await page.screenshot({ path: paths.contextShot, fullPage: false });
      result.contextPath = toRelative(paths.contextShot);
    }

    result.imagePath = toRelative(paths.componentShot);
    result.hash = await hashFileSha1(paths.componentShot);
    const baselineKey = `${component.id}::${scenario.id}::${viewport.id}::component`;
    const baseline = runtime.baselineMap.get(baselineKey);
    if (baseline?.imagePath) {
      const baselineAbsolute = path.resolve(process.cwd(), baseline.imagePath);
      result.baselinePath = baseline.imagePath;
      if (baseline.hash) {
        result.baselineHash = baseline.hash;
      } else if (runtime.baselineHashes.has(baselineAbsolute)) {
        result.baselineHash = runtime.baselineHashes.get(baselineAbsolute);
      }
      if (result.baselineHash) {
        result.diffStatus = result.baselineHash === result.hash ? 'same' : 'changed';
      } else {
        result.diffStatus = 'unknown';
      }
    } else {
      result.diffStatus = 'new';
    }
  } catch (error) {
    result.status = 'failed';
    result.error = error?.message ?? String(error);
    try {
      await page.screenshot({ path: paths.failureShot, fullPage: false });
      result.failurePath = toRelative(paths.failureShot);
    } catch {
      // Ignore screenshot failures in failure path.
    }
  } finally {
    result.ms = Date.now() - startedAt;
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }

  return result;
}

async function runPool(tasks, workerCount, runner) {
  const results = [];
  let index = 0;
  async function worker() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= tasks.length) return;
      const row = await runner(tasks[current], current);
      results[current] = row;
    }
  }
  const workers = Array.from({ length: Math.max(1, workerCount) }, () => worker());
  await Promise.all(workers);
  return results;
}

function isRetryableWarning(result) {
  if (!result || result.status !== 'ok' || !result.warning) return false;
  const warning = String(result.warning).toLowerCase();
  return (
    warning.includes('openaction') ||
    warning.includes('selector fallback') ||
    warning.includes('timeout')
  );
}

function isRetryableFailure(result) {
  if (!result || result.status !== 'failed' || !result.error) return false;
  const error = String(result.error).toLowerCase();
  return (
    error.includes('timeout') ||
    error.includes('locator') ||
    error.includes('screenshot') ||
    error.includes('detached') ||
    error.includes('target closed') ||
    error.includes('execution context')
  );
}

async function retryWarningCaptures(captures, tasks, runtime) {
  for (let index = 0; index < captures.length; index += 1) {
    const initial = captures[index];
    if (!isRetryableWarning(initial)) continue;
    let best = initial;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retried = await captureTask(tasks[index], runtime);
      if (retried.status === 'ok' && !retried.warning) {
        best = retried;
        break;
      }
      if (retried.status === 'ok') {
        const bestScore = best.warning ? String(best.warning).length : Number.MAX_SAFE_INTEGER;
        const retryScore = retried.warning ? String(retried.warning).length : Number.MAX_SAFE_INTEGER;
        if (retryScore < bestScore) best = retried;
      }
    }
    captures[index] = best;
  }
  return captures;
}

async function retryFailedCaptures(captures, tasks, runtime) {
  for (let index = 0; index < captures.length; index += 1) {
    const initial = captures[index];
    if (!isRetryableFailure(initial)) continue;
    let best = initial;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retried = await captureTask(tasks[index], runtime);
      if (retried.status === 'ok') {
        best = retried;
        break;
      }
      const bestErrorLen = best.error ? String(best.error).length : Number.MAX_SAFE_INTEGER;
      const retryErrorLen = retried.error ? String(retried.error).length : Number.MAX_SAFE_INTEGER;
      if (retryErrorLen < bestErrorLen) best = retried;
    }
    captures[index] = best;
  }
  return captures;
}

async function main() {
  const args = parseCliArgs(process.argv);
  const registry = await loadJson(REGISTRY_PATH);
  const changedPaths = args.changed && !args.all ? await gitChangedPaths() : [];
  const selectedComponents = selectComponents(registry, args, changedPaths);

  const tasks = filterTasksByViewport(toTasks(selectedComponents), args);
  const runDir = args.outputDir ?? path.join(RUNS_ROOT, args.runId);
  await ensureDir(runDir);
  await ensureDir(path.join(runDir, 'components'));

  const baseline = await findLatestManifest(RUNS_ROOT, runDir);
  const baselineMap = createBaselineMap(baseline?.manifest);
  const baselineHashes = new Map();
  for (const entry of baselineMap.values()) {
    if (!entry?.imagePath) continue;
    const absolutePath = path.resolve(process.cwd(), entry.imagePath);
    if (!entry.hash) continue;
    baselineHashes.set(absolutePath, entry.hash);
  }

  const manifest = {
    runId: args.runId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    baseUrl: args.baseUrl,
    route: args.route,
    workspaceId: args.workspaceId || null,
    selectionMode: args.all ? 'all' : args.changed ? 'changed' : 'mapped',
    changedPaths: changedPaths,
    baselineManifestPath: baseline?.manifestPath ? toRelative(baseline.manifestPath) : null,
    stats: {
      mapped: registry.components.filter((entry) => entry.status === 'mapped').length,
      selectedComponents: selectedComponents.length,
      tasks: tasks.length,
      captured: 0,
      failed: 0,
      unmapped: registry.unmapped.length,
      durationMs: 0,
    },
    captures: [],
  };

  if (args.dryRun) {
    manifest.finishedAt = new Date().toISOString();
    manifest.stats.durationMs = 0;
    await writeJson(path.join(runDir, 'manifest.components.json'), manifest);
    console.log(
      `[qa:components] dry-run selected=${selectedComponents.length} tasks=${tasks.length} runDir=${toRelative(runDir)}`
    );
    return;
  }

  const executablePath = resolveChromeExecutable();
  const launchOptions = {
    headless: !args.headful,
    ...(executablePath ? { executablePath } : {}),
  };
  const browser = await chromium.launch(launchOptions);

  const runtime = {
    outputDir: runDir,
    browser,
    scope: {
      baseUrl: args.baseUrl,
      route: args.route,
      workspaceId: args.workspaceId,
      commandCenterId: args.commandCenterId || args.workspaceId,
      center: args.center || args.workspaceId,
    },
    baselineMap,
    baselineHashes,
  };

  const startedAt = Date.now();
  const workerCount = Math.min(args.workers, Math.max(1, cpus().length));
  const captures = await runPool(tasks, workerCount, (task) => captureTask(task, runtime));
  await retryFailedCaptures(captures, tasks, runtime);
  await retryWarningCaptures(captures, tasks, runtime);

  await browser.close().catch(() => {});

  manifest.captures = captures;
  manifest.finishedAt = new Date().toISOString();
  manifest.stats.captured = captures.filter((entry) => entry.status === 'ok').length;
  manifest.stats.failed = captures.filter((entry) => entry.status === 'failed').length;
  manifest.stats.durationMs = Date.now() - startedAt;

  const manifestPath = path.join(runDir, 'manifest.components.json');
  await writeJson(manifestPath, manifest);

  if (!args.skipIndex) {
    const { spawnSync } = await import('node:child_process');
    spawnSync('node', ['./scripts/generate-components-index.mjs', '--run-dir', runDir], { stdio: 'inherit' });
  }

  const summary = `[qa:components] selected=${manifest.stats.selectedComponents} tasks=${manifest.stats.tasks} ok=${manifest.stats.captured} failed=${manifest.stats.failed} durationMs=${manifest.stats.durationMs} runDir=${toRelative(runDir)}`;
  console.log(summary);

  if (manifest.stats.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`[qa:components] failed: ${error?.message ?? String(error)}`);
  process.exit(1);
});
