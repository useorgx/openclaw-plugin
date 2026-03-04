#!/usr/bin/env node
/**
 * Live UI audit using Playwright ("agent-browser" workflow).
 *
 * Executes real actions on /orgx/live:
 * - Mission Control -> Open Queue
 * - Start first queued workstream row
 * - Enable Auto on the same row
 *
 * Then validates from live snapshot data that:
 * - A slice was dispatched after the click window.
 * - A slice completed after the click window.
 * - Queue continuation happened (dispatch after a completion).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadChromium, resolveQaRunDir, shouldDryRun } from "./qa-output-paths.mjs";

const BASE_URL = String(process.env.ORGX_LIVE_BASE_URL || "http://127.0.0.1:18789").trim().replace(/\/+$/, "");
const LIVE_URL = `${BASE_URL}/orgx/live`;
const SNAPSHOT_ACTIVITY_LIMIT = Number.isFinite(Number(process.env.ORGX_LIVE_AUDIT_ACTIVITY_LIMIT))
  ? Math.max(120, Math.floor(Number(process.env.ORGX_LIVE_AUDIT_ACTIVITY_LIMIT)))
  : 500;
const SNAPSHOT_SESSIONS_LIMIT = Number.isFinite(Number(process.env.ORGX_LIVE_AUDIT_SESSIONS_LIMIT))
  ? Math.max(80, Math.floor(Number(process.env.ORGX_LIVE_AUDIT_SESSIONS_LIMIT)))
  : 260;
const SNAPSHOT_DECISIONS_LIMIT = Number.isFinite(Number(process.env.ORGX_LIVE_AUDIT_DECISIONS_LIMIT))
  ? Math.max(20, Math.floor(Number(process.env.ORGX_LIVE_AUDIT_DECISIONS_LIMIT)))
  : 120;
const SNAPSHOT_URL = `${BASE_URL}/orgx/api/live/snapshot?activityLimit=${SNAPSHOT_ACTIVITY_LIMIT}&sessionsLimit=${SNAPSHOT_SESSIONS_LIMIT}&decisionsLimit=${SNAPSHOT_DECISIONS_LIMIT}`;
const NEXT_UP_URL = `${BASE_URL}/orgx/api/mission-control/next-up?limit=100`;
const RESULT_DIR = resolveQaRunDir({
  argv: process.argv,
  suite: "live-autopilot-audit",
  envOutputDirVar: "ORGX_LIVE_AUDIT_RESULT_DIR",
});
const DRY_RUN = shouldDryRun(process.argv);
const TARGET_INITIATIVE_OVERRIDE = String(process.env.ORGX_LIVE_AUDIT_TARGET_INITIATIVE_ID || "").trim();
const TARGET_WORKSTREAM_OVERRIDE = String(process.env.ORGX_LIVE_AUDIT_TARGET_WORKSTREAM_ID || "").trim();
const TIMEOUT_MS = Number.isFinite(Number(process.env.ORGX_LIVE_AUDIT_TIMEOUT_MS))
  ? Math.max(60_000, Math.floor(Number(process.env.ORGX_LIVE_AUDIT_TIMEOUT_MS)))
  : 8 * 60_000;
const REQUEST_TIMEOUT_MS = Number.isFinite(Number(process.env.ORGX_LIVE_AUDIT_REQUEST_TIMEOUT_MS))
  ? Math.max(5_000, Math.floor(Number(process.env.ORGX_LIVE_AUDIT_REQUEST_TIMEOUT_MS)))
  : 20_000;
const POLL_MS = 4_000;

function nowIso() {
  return new Date().toISOString();
}

async function fetchJson(url, init = {}) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err && typeof err === "object" && (err.name === "AbortError" || err.code === "ABORT_ERR")) {
      throw new Error(`${init.method || "GET"} ${url} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
  const text = await res.text().catch(() => "");
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    throw new Error(`${init.method || "GET"} ${url} failed (${res.status}): ${text.slice(0, 240)}`);
  }
  return json;
}

async function fetchJsonWithRetry(url, init = {}, attempts = 3, backoffMs = 750) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await fetchJson(url, init);
    } catch (err) {
      lastError = err;
      const message = String(err?.message || err);
      const retryable =
        /timed out|ECONNRESET|EPIPE|network|socket|fetch failed/i.test(message);
      if (!retryable || index >= attempts - 1) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs * (index + 1)));
    }
  }
  throw lastError ?? new Error(`Request failed after ${attempts} attempts: ${url}`);
}

function parseTs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function clickWithApiCapture(input) {
  const { page, button, matcher, timeoutMs = 10_000 } = input;
  const responsePromise = page
    .waitForResponse((response) => {
      try {
        return matcher(response);
      } catch {
        return false;
      }
    }, { timeout: timeoutMs })
    .catch(() => null);

  await button.click({ timeout: 8_000 });
  const response = await responsePromise;
  if (!response) return null;

  const text = await response.text().catch(() => "");
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 300);
    }
  }

  return {
    url: response.url(),
    status: response.status(),
    ok: response.ok(),
    body,
  };
}

function summarizeEvents(snapshot, initiativeId, startMs) {
  const activity = Array.isArray(snapshot?.activity) ? snapshot.activity : [];
  const filtered = activity
    .filter((row) => String(row?.initiativeId || "") === initiativeId)
    .filter((row) => parseTs(row?.timestamp) >= startMs)
    .map((row) => ({
      timestamp: row?.timestamp || null,
      tsMs: parseTs(row?.timestamp),
      title: normalizeText(row?.title),
      runId: String(row?.runId || "").trim() || null,
      event: String(row?.metadata?.event || "").trim() || null,
    }))
    .sort((a, b) => a.tsMs - b.tsMs);

  const dispatched = filtered.filter((row) =>
    row.title.toLowerCase().startsWith("autopilot dispatched slice for")
  );
  const completed = filtered.filter((row) =>
    row.title.toLowerCase().startsWith("autopilot slice completed for")
  );
  const rateLimited = filtered.filter((row) =>
    /rate[- ]limited|spawn guard rate-limited/i.test(row.title)
  );
  const stopped = filtered.filter((row) =>
    /autopilot stopped/i.test(row.title)
  );
  const errors = filtered.filter((row) =>
    /error[: ]|failed/i.test(row.title)
  );

  let continuationAfterCompletion = false;
  if (completed.length > 0) {
    const firstCompletedAt = completed[0].tsMs;
    continuationAfterCompletion = dispatched.some((row) => row.tsMs > firstCompletedAt);
  }

  return {
    filtered,
    dispatched,
    completed,
    rateLimited,
    stopped,
    errors,
    continuationAfterCompletion,
  };
}

function buildInitiativeRecencyMap(snapshot) {
  const activity = Array.isArray(snapshot?.activity) ? snapshot.activity : [];
  const recency = new Map();
  for (const row of activity) {
    const initiativeId = String(row?.initiativeId || "").trim();
    if (!initiativeId) continue;
    const title = String(row?.title || "");
    const event = String(row?.metadata?.event || "");
    const autopilotRelated =
      /autopilot/i.test(title) ||
      /auto[_ -]?continue/i.test(title) ||
      /autopilot/i.test(event) ||
      /auto[_ -]?continue/i.test(event);
    if (!autopilotRelated) continue;
    const ts = parseTs(row?.timestamp);
    if (!ts) continue;
    const existing = recency.get(initiativeId) || 0;
    if (ts > existing) recency.set(initiativeId, ts);
  }
  return recency;
}

function pickQueuedTarget(items, initiativeRecency) {
  const queued = items.filter((item) => String(item?.queueState || "").toLowerCase() === "queued");
  if (queued.length === 0) return null;

  if (TARGET_WORKSTREAM_OVERRIDE) {
    const match = queued.find((item) => String(item?.workstreamId || "").trim() === TARGET_WORKSTREAM_OVERRIDE);
    if (match) return match;
  }
  if (TARGET_INITIATIVE_OVERRIDE) {
    const match = queued.find((item) => String(item?.initiativeId || "").trim() === TARGET_INITIATIVE_OVERRIDE);
    if (match) return match;
  }

  const byInitiative = new Map();
  for (const item of queued) {
    const initiativeId = String(item?.initiativeId || "").trim();
    if (!initiativeId) continue;
    const list = byInitiative.get(initiativeId) || [];
    list.push(item);
    byInitiative.set(initiativeId, list);
  }

  // Prefer deterministic, quick verification initiatives (version-harness-style),
  // and prefer initiatives with multiple queued rows so continuation is observable.
  let best = null;
  for (const [initiativeId, list] of byInitiative.entries()) {
    const first = list[0];
    const title = String(first?.initiativeTitle || "");
    const wsTitles = list.map((entry) => String(entry?.workstreamTitle || ""));
    const hasVersionHarness =
      /\[version harness\]/i.test(title) || wsTitles.some((entry) => /\[version harness\]/i.test(entry));
    const recentTs = Number(initiativeRecency?.get(initiativeId) || 0);
    const score =
      (hasVersionHarness ? 10_000 : 0) +
      Math.min(200, list.length * 100) +
      Math.min(5_000, Math.floor(recentTs / 1_000_000)) +
      (String(first?.queueState || "").toLowerCase() === "queued" ? 1 : 0);
    if (!best || score > best.score) {
      best = {
        score,
        initiativeId,
        item: first,
      };
    }
  }

  return best?.item || queued[0];
}

async function dismissFirstRunChecklist(page) {
  const notNow = page.getByRole("button", { name: /Not now/i });
  if (await notNow.count()) {
    await notNow.first().click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  const dontShow = page.getByRole("button", { name: /Don't show again/i });
  if (await dontShow.count()) {
    await dontShow.first().click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  const close = page.getByRole("button", { name: /Close/i });
  if (await close.count()) {
    await close.first().click({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(250);
  }
}

async function waitForInteractiveShell(page, timeoutMs = 45_000) {
  await page
    .waitForFunction(
      () => {
        const buttons = Array.from(document.querySelectorAll("button"));
        return buttons.some((button) =>
          /mission control/i.test((button.textContent || "").trim())
        );
      },
      { timeout: timeoutMs }
    )
    .catch(() => null);
}

async function main() {
  if (DRY_RUN) {
    process.stdout.write(`[live-audit] dry-run output dir: ${RESULT_DIR}\n`);
    return;
  }

  mkdirSync(RESULT_DIR, { recursive: true });
  const chromium = await loadChromium();

  const report = {
    startedAt: nowIso(),
    baseUrl: BASE_URL,
    liveUrl: LIVE_URL,
    timeoutMs: TIMEOUT_MS,
    target: null,
    actions: {
      missionControlOpened: false,
      queueOpened: false,
      startClicked: false,
      autoClicked: false,
      autoOnVisible: false,
      startApi: null,
      autoApi: null,
    },
    baseline: {
      snapshotAt: null,
      dispatchedCount: 0,
      completedCount: 0,
    },
    validation: {
      dispatchedAfterAction: false,
      completedAfterAction: false,
      continuationAfterCompletion: false,
      continuationRequired: true,
      blockedByRateLimit: false,
      stoppedWithoutDispatch: false,
      passed: false,
    },
    observed: {
      actionAt: null,
      snapshotAt: null,
      dispatchedCount: 0,
      completedCount: 0,
      dispatchedSample: [],
      completedSample: [],
      rateLimitedSample: [],
      stoppedSample: [],
      errorSample: [],
      continuationEvidenceTitle: null,
    },
    screenshots: {},
    errors: [],
    finishedAt: null,
    resultPath: null,
  };

  process.stdout.write(`[live-audit] loading next-up queue from ${NEXT_UP_URL}\n`);
  const nextUp = await fetchJsonWithRetry(NEXT_UP_URL, {}, 4, 500);
  const items = Array.isArray(nextUp?.items) ? nextUp.items : [];
  const queuedCountByInitiative = new Map();
  for (const item of items) {
    const initiativeId = String(item?.initiativeId || "").trim();
    if (!initiativeId) continue;
    if (String(item?.queueState || "").toLowerCase() !== "queued") continue;
    queuedCountByInitiative.set(initiativeId, Number(queuedCountByInitiative.get(initiativeId) || 0) + 1);
  }
  process.stdout.write(`[live-audit] capturing baseline snapshot\n`);
  const baselineSnapshot = await fetchJsonWithRetry(SNAPSHOT_URL, {}, 4, 500);
  const initiativeRecency = buildInitiativeRecencyMap(baselineSnapshot);
  const target = pickQueuedTarget(items, initiativeRecency);
  if (!target) {
    throw new Error("No queued workstream available in mission-control next-up.");
  }

  const targetInitiativeId = String(target.initiativeId || "").trim();
  const targetInitiativeTitle = String(target.initiativeTitle || "").trim();
  const targetWorkstreamTitle = String(target.workstreamTitle || "").trim();
  if (!targetInitiativeId || !targetWorkstreamTitle) {
    throw new Error("Next-up target missing required initiativeId/workstreamTitle.");
  }

  report.target = {
    initiativeId: targetInitiativeId,
    workstreamId: String(target.workstreamId || "").trim(),
    workstreamTitle: targetWorkstreamTitle,
    initiativeTitle: String(target.initiativeTitle || "").trim(),
  };
  const targetRecency = Number(initiativeRecency.get(targetInitiativeId) || 0);
  process.stdout.write(
    `[live-audit] target initiative="${report.target.initiativeTitle}" workstream="${targetWorkstreamTitle}"\n`
  );
  if (targetRecency > 0) {
    process.stdout.write(
      `[live-audit] target initiative last autopilot activity at ${new Date(targetRecency).toISOString()}\n`
    );
  }
  const baselineSummary = summarizeEvents(baselineSnapshot, targetInitiativeId, 0);
  report.baseline.snapshotAt = nowIso();
  report.baseline.dispatchedCount = baselineSummary.dispatched.length;
  report.baseline.completedCount = baselineSummary.completed.length;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const missionApiRequests = [];
  const missionApiResponses = [];

  page.on("request", (request) => {
    const url = request.url();
    if (!/\/orgx\/api\/mission-control\//i.test(url)) return;
    missionApiRequests.push({
      at: nowIso(),
      method: request.method(),
      url,
    });
    if (missionApiRequests.length > 80) {
      missionApiRequests.shift();
    }
  });
  page.on("response", (response) => {
    const url = response.url();
    if (!/\/orgx\/api\/mission-control\//i.test(url)) return;
    missionApiResponses.push({
      at: nowIso(),
      status: response.status(),
      ok: response.ok(),
      method: response.request().method(),
      url,
    });
    if (missionApiResponses.length > 80) {
      missionApiResponses.shift();
    }
  });

  try {
    process.stdout.write(`[live-audit] opening ${LIVE_URL}\n`);
    try {
      await page.goto(LIVE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch {
      // Live plugin can be busy while replaying outbox; retry once with a wider timeout.
      await page.goto(LIVE_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
    }
    await page.waitForTimeout(1_500);
    await waitForInteractiveShell(page);
    await dismissFirstRunChecklist(page);
    await waitForInteractiveShell(page);

    process.stdout.write(`[live-audit] opening Mission Control\n`);
    const missionControlTab =
      page.getByRole("button", { name: /Mission Control/i }).first();
    if (await missionControlTab.count()) {
      await missionControlTab.click({ timeout: 8_000 });
    } else {
      const fallbackMissionControlTab = page
        .locator("button:visible, a:visible, [role='button']:visible")
        .filter({ hasText: /Mission Control/i })
        .first();
      if (!(await fallbackMissionControlTab.count())) {
        throw new Error("Could not find Mission Control tab/button on /orgx/live.");
      }
      await fallbackMissionControlTab.click({ timeout: 8_000 });
    }
    report.actions.missionControlOpened = true;
    await page.waitForTimeout(1_000);

    const openQueueButton = page.getByRole("button", { name: /Open Queue/i });
    if (await openQueueButton.count()) {
      process.stdout.write(`[live-audit] opening queue panel\n`);
      await openQueueButton.first().click({ timeout: 8_000 });
      report.actions.queueOpened = true;
      await page.waitForTimeout(1_000);
    }

    report.screenshots.beforeAction = join(RESULT_DIR, `live-audit-before-${Date.now()}.png`);
    await page.screenshot({ path: report.screenshots.beforeAction, fullPage: false });

    const baseQueueRows = page
      .locator("article")
      .filter({ hasText: targetWorkstreamTitle })
      .filter({ has: page.locator("button:has-text('Follow')") })
      .filter({ has: page.locator("button:has-text('Remove')") })
      .filter({ has: page.locator("button:has-text('Auto'), button:has-text('Auto on')") });

    let queueRow = baseQueueRows.first();
    if (targetInitiativeTitle) {
      const escapedInitiativeTitle = targetInitiativeTitle.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const titleMatchedRows = baseQueueRows.filter({
        has: page.locator(`button[title="${escapedInitiativeTitle}"]`),
      });
      if ((await titleMatchedRows.count()) > 0) {
        queueRow = titleMatchedRows.first();
      }
    }

    if ((await queueRow.count()) === 0) {
      const baseListRows = page
        .locator("li")
        .filter({ hasText: targetWorkstreamTitle })
        .filter({ has: page.locator("button:has-text('Follow')") })
        .filter({ has: page.locator("button:has-text('Remove')") })
        .filter({ has: page.locator("button:has-text('Auto'), button:has-text('Auto on')") });
      queueRow = baseListRows.first();
      if (targetInitiativeTitle) {
        const escapedInitiativeTitle = targetInitiativeTitle.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const titleMatchedRows = baseListRows.filter({
          has: page.locator(`button[title="${escapedInitiativeTitle}"]`),
        });
        if ((await titleMatchedRows.count()) > 0) {
          queueRow = titleMatchedRows.first();
        }
      }
    }

    if ((await queueRow.count()) === 0) {
      throw new Error(`Could not locate queue row for "${targetWorkstreamTitle}".`);
    }

    await queueRow.scrollIntoViewIfNeeded().catch(() => {});

    const startButton = queueRow.getByRole("button", { name: /^(Start|Pause)$/i }).first();
    if ((await startButton.count()) === 0) {
      throw new Error(`No Start button found in queue row "${targetWorkstreamTitle}".`);
    }
    const startApi = await clickWithApiCapture({
      page,
      button: startButton,
      matcher: (response) =>
        response.request().method() === "POST" &&
        /\/orgx\/api\/mission-control\/(?:next-up\/play|next-up\/triage\/stop)(?:\?|$)/i.test(
          response.url()
        ),
    });
    process.stdout.write(`[live-audit] clicked Start on "${targetWorkstreamTitle}"\n`);
    report.actions.startClicked = true;
    report.actions.startApi = startApi;
    if (!startApi) {
      report.errors.push("No API response observed for Start click (expected /mission-control/next-up/play).");
    }
    await page.waitForTimeout(1_500);

    const autoButton = queueRow.getByRole("button", { name: /^Auto(?: on)?$/i }).first();
    if ((await autoButton.count()) === 0) {
      throw new Error(`No Auto button found in queue row "${targetWorkstreamTitle}".`);
    }
    const autoApi = await clickWithApiCapture({
      page,
      button: autoButton,
      matcher: (response) =>
        response.request().method() === "POST" &&
        /\/orgx\/api\/mission-control\/auto-continue\/(?:start|stop)(?:\?|$)/i.test(response.url()),
    });
    process.stdout.write(`[live-audit] clicked Auto on "${targetWorkstreamTitle}"\n`);
    report.actions.autoClicked = true;
    report.actions.autoApi = autoApi;
    if (!autoApi) {
      report.errors.push("No API response observed for Auto click (expected /mission-control/auto-continue/start).");
    }
    report.observed.actionAt = nowIso();
    await page.waitForTimeout(1_500);

    const autoOn = queueRow.locator("button:has-text('Auto on')").first();
    const autoOnVisible = await autoOn.isVisible({ timeout: 15_000 }).catch(() => false);
    report.actions.autoOnVisible = autoOnVisible;

    report.screenshots.afterAction = join(RESULT_DIR, `live-audit-after-${Date.now()}.png`);
    await page.screenshot({ path: report.screenshots.afterAction, fullPage: false });
  } finally {
    await browser.close().catch(() => {});
  }

  const actionMs = parseTs(report.observed.actionAt || nowIso());
  let validationInitiativeId = targetInitiativeId;
  let validationWorkstreamId = String(report.target?.workstreamId || "").trim();
  const startApiBody =
    report.actions.startApi &&
    report.actions.startApi.body &&
    typeof report.actions.startApi.body === "object" &&
    !Array.isArray(report.actions.startApi.body)
      ? report.actions.startApi.body
      : null;
  if (startApiBody) {
    const responseInitiativeId = String(startApiBody.initiativeId || "").trim();
    const responseWorkstreamId = String(startApiBody.workstreamId || "").trim();
    if (responseInitiativeId) {
      validationInitiativeId = responseInitiativeId;
      report.target.actualInitiativeId = responseInitiativeId;
    }
    if (responseWorkstreamId) {
      validationWorkstreamId = responseWorkstreamId;
      report.target.actualWorkstreamId = responseWorkstreamId;
    }
    if (validationInitiativeId !== targetInitiativeId || validationWorkstreamId !== String(report.target?.workstreamId || "").trim()) {
      report.errors.push(
        `UI action targeted ${validationInitiativeId}:${validationWorkstreamId || "unknown"} instead of requested ${targetInitiativeId}:${String(report.target?.workstreamId || "").trim()}.`
      );
    }
  }
  report.validation.continuationRequired =
    Number(queuedCountByInitiative.get(validationInitiativeId) || 0) > 1;
  const deadline = Date.now() + TIMEOUT_MS;
  let lastSummary = null;
  let pollCount = 0;
  process.stdout.write(`[live-audit] polling live snapshot for dispatch/completion/continuation evidence\n`);

  while (Date.now() < deadline) {
    pollCount += 1;
    let snapshot = null;
    try {
      snapshot = await fetchJsonWithRetry(SNAPSHOT_URL, {}, 3, 600);
    } catch (err) {
      const msg = String(err?.message || err);
      report.errors.push(`poll ${pollCount}: ${msg}`);
      if (pollCount === 1 || pollCount % 5 === 0) {
        process.stdout.write(`[live-audit] poll ${pollCount}: snapshot error: ${msg}\n`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      continue;
    }
    const summary = summarizeEvents(snapshot, validationInitiativeId, actionMs);
    lastSummary = summary;

    report.validation.dispatchedAfterAction = summary.dispatched.length > 0;
    report.validation.completedAfterAction = summary.completed.length > 0;
    report.validation.continuationAfterCompletion = summary.continuationAfterCompletion;
    report.validation.blockedByRateLimit = summary.rateLimited.length > 0;
    report.validation.stoppedWithoutDispatch =
      summary.stopped.length > 0 && summary.dispatched.length === 0;

    if (
      report.validation.dispatchedAfterAction &&
      report.validation.completedAfterAction &&
      report.validation.continuationAfterCompletion
    ) {
      process.stdout.write(
        `[live-audit] evidence complete after ${pollCount} polls (dispatch=${summary.dispatched.length}, completed=${summary.completed.length})\n`
      );
      break;
    }
    if (pollCount === 1 || pollCount % 5 === 0) {
      process.stdout.write(
        `[live-audit] poll ${pollCount}: dispatch=${summary.dispatched.length}, completed=${summary.completed.length}, continuation=${summary.continuationAfterCompletion}, rate_limited=${summary.rateLimited.length}, stopped=${summary.stopped.length}\n`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  if (lastSummary) {
    report.observed.snapshotAt = nowIso();
    report.observed.dispatchedCount = lastSummary.dispatched.length;
    report.observed.completedCount = lastSummary.completed.length;
    report.observed.dispatchedSample = lastSummary.dispatched.slice(-3).map((entry) => ({
      timestamp: entry.timestamp,
      title: entry.title,
      runId: entry.runId,
    }));
    report.observed.completedSample = lastSummary.completed.slice(-3).map((entry) => ({
      timestamp: entry.timestamp,
      title: entry.title,
      runId: entry.runId,
    }));
    report.observed.rateLimitedSample = lastSummary.rateLimited.slice(-3).map((entry) => ({
      timestamp: entry.timestamp,
      title: entry.title,
      runId: entry.runId,
    }));
    report.observed.stoppedSample = lastSummary.stopped.slice(-3).map((entry) => ({
      timestamp: entry.timestamp,
      title: entry.title,
      runId: entry.runId,
    }));
    report.observed.errorSample = lastSummary.errors.slice(-3).map((entry) => ({
      timestamp: entry.timestamp,
      title: entry.title,
      runId: entry.runId,
    }));
    if (report.validation.continuationAfterCompletion && lastSummary.completed.length > 0) {
      const firstCompletedAt = lastSummary.completed[0].tsMs;
      const continuation = lastSummary.dispatched.find((entry) => entry.tsMs > firstCompletedAt) || null;
      report.observed.continuationEvidenceTitle = continuation?.title || null;
    }
  }

  report.observed.missionApiRequests = missionApiRequests.slice(-40);
  report.observed.missionApiResponses = missionApiResponses.slice(-40);

  report.validation.passed =
    report.actions.startClicked &&
    report.actions.autoClicked &&
    report.validation.dispatchedAfterAction &&
    report.validation.completedAfterAction &&
    (!report.validation.continuationRequired || report.validation.continuationAfterCompletion);

  report.finishedAt = nowIso();
  const resultPath = join(RESULT_DIR, `live-audit-${Date.now()}.json`);
  report.resultPath = resultPath;
  writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.validation.passed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  const payload = {
    ok: false,
    error: String(err?.message || err),
    stack: String(err?.stack || ""),
    at: nowIso(),
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(1);
});
