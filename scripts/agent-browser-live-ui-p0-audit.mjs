#!/usr/bin/env node
/**
 * Agent-browser style P0 audit for /orgx/live.
 *
 * Verifies minimum UX + API contracts:
 * - Core panes render (agents/activity/right rail)
 * - Autopilot state/control is visible
 * - Active sessions surface under agents when sessions exist
 * - Decisions API count is reflected in UI
 * - Next-up rows expose execution controls
 * - Next-up initiative IDs are a subset of live initiatives for the same scope
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadChromium, resolveQaRunDir, shouldDryRun } from "./qa-output-paths.mjs";

const BASE_URL = String(process.env.ORGX_LIVE_BASE_URL || "http://127.0.0.1:18789")
  .trim()
  .replace(/\/+$/, "");
const LIVE_URL_BASE = String(process.env.ORGX_LIVE_URL || `${BASE_URL}/orgx/live`).trim();
const WORKSPACE_ID_ENV = String(process.env.ORGX_LIVE_AUDIT_WORKSPACE_ID || "").trim();
const REQUEST_TIMEOUT_MS = Number.isFinite(Number(process.env.ORGX_LIVE_AUDIT_REQUEST_TIMEOUT_MS))
  ? Math.max(5_000, Math.floor(Number(process.env.ORGX_LIVE_AUDIT_REQUEST_TIMEOUT_MS)))
  : 20_000;
const RESULT_DIR = resolveQaRunDir({
  argv: process.argv,
  suite: "live-ui-p0-audit",
  envOutputDirVar: "ORGX_LIVE_AUDIT_RESULT_DIR",
});
const DRY_RUN = shouldDryRun(process.argv);

const SNAPSHOT_LIMITS = {
  sessions: Number.isFinite(Number(process.env.ORGX_LIVE_AUDIT_SESSIONS_LIMIT))
    ? Math.max(40, Math.floor(Number(process.env.ORGX_LIVE_AUDIT_SESSIONS_LIMIT)))
    : 180,
  activity: Number.isFinite(Number(process.env.ORGX_LIVE_AUDIT_ACTIVITY_LIMIT))
    ? Math.max(80, Math.floor(Number(process.env.ORGX_LIVE_AUDIT_ACTIVITY_LIMIT)))
    : 280,
  decisions: Number.isFinite(Number(process.env.ORGX_LIVE_AUDIT_DECISIONS_LIMIT))
    ? Math.max(20, Math.floor(Number(process.env.ORGX_LIVE_AUDIT_DECISIONS_LIMIT)))
    : 120,
};

function nowIso() {
  return new Date().toISOString();
}

function parseLiveUrl(input) {
  const parsed = new URL(input);
  return parsed;
}

function resolveWorkspaceId(liveUrl) {
  const fromQuery = String(liveUrl.searchParams.get("workspace_id") || "").trim();
  if (WORKSPACE_ID_ENV) return WORKSPACE_ID_ENV;
  if (fromQuery) return fromQuery;
  return "";
}

function applyWorkspaceScope(url, workspaceId) {
  if (!workspaceId) return url;
  const scoped = new URL(url.toString());
  scoped.searchParams.set("workspace_id", workspaceId);
  scoped.searchParams.set("command_center_id", workspaceId);
  scoped.searchParams.set("center", workspaceId);
  scoped.searchParams.delete("project_id");
  return scoped;
}

async function fetchJson(url, init = {}) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err && typeof err === "object" && (err.name === "AbortError" || err.code === "ABORT_ERR")) {
      throw new Error(`${init.method || "GET"} ${url} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }

  const text = await response.text().catch(() => "");
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 300);
    }
  }
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${url} failed (${response.status}): ${text.slice(0, 260)}`);
  }
  return body;
}

async function dismissFirstRunChecklist(page) {
  const notNow = page.getByRole("button", { name: /Not now/i });
  if (await notNow.count()) {
    await notNow.first().click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
  const dontShow = page.getByRole("button", { name: /Don't show again/i });
  if (await dontShow.count()) {
    await dontShow.first().click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

function collectInitiativeIds(rows, keys) {
  const ids = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    for (const key of keys) {
      const value = String(row[key] || "").trim();
      if (value) {
        ids.add(value);
        break;
      }
    }
  }
  return ids;
}

function hasPositiveDecisionBadge(values) {
  for (const entry of values) {
    const match = String(entry || "").match(/decisions?\s*(\d+)/i);
    if (match && Number(match[1]) > 0) return true;
  }
  return false;
}

async function run() {
  if (DRY_RUN) {
    process.stdout.write(`[live-ui-p0] dry-run output dir: ${RESULT_DIR}\n`);
    return;
  }

  mkdirSync(RESULT_DIR, { recursive: true });
  const chromium = await loadChromium();

  const startedAt = nowIso();
  const liveUrl = parseLiveUrl(LIVE_URL_BASE);
  const workspaceId = resolveWorkspaceId(liveUrl);
  const scopedLiveUrl = applyWorkspaceScope(liveUrl, workspaceId);

  const snapshotUrl = applyWorkspaceScope(
    new URL(
      `${BASE_URL}/orgx/api/live/snapshot?sessionsLimit=${SNAPSHOT_LIMITS.sessions}&activityLimit=${SNAPSHOT_LIMITS.activity}&decisionsLimit=${SNAPSHOT_LIMITS.decisions}`
    ),
    workspaceId
  ).toString();
  const initiativesUrl = applyWorkspaceScope(
    new URL(`${BASE_URL}/orgx/api/live/initiatives?limit=400&offset=0`),
    workspaceId
  ).toString();
  const decisionsUrl = applyWorkspaceScope(
    new URL(`${BASE_URL}/orgx/api/live/decisions?status=pending&limit=200`),
    workspaceId
  ).toString();
  const nextUpUrl = applyWorkspaceScope(
    new URL(`${BASE_URL}/orgx/api/mission-control/next-up?limit=120`),
    workspaceId
  ).toString();

  const report = {
    startedAt,
    finishedAt: null,
    baseUrl: BASE_URL,
    liveUrl: scopedLiveUrl.toString(),
    workspaceId: workspaceId || null,
    urls: {
      snapshot: snapshotUrl,
      initiatives: initiativesUrl,
      decisions: decisionsUrl,
      nextUp: nextUpUrl,
    },
    api: {
      snapshotSessions: 0,
      snapshotActivity: 0,
      liveInitiatives: 0,
      pendingDecisions: 0,
      nextUpItems: 0,
      nextUpMissingInitiativeIds: [],
    },
    ui: {
      panes: {
        agents: false,
        activity: false,
        rightRail: false,
      },
      autopilotControlVisible: false,
      sessionRowVisible: false,
      decisionsLabelVisible: false,
      decisionsPositiveBadgeVisible: false,
      needsInputSignalVisible: false,
      nextUpActionVisible: false,
    },
    checks: [],
    screenshots: {},
    errors: [],
    passed: false,
    resultPath: null,
  };

  const [snapshot, initiatives, decisions, nextUp] = await Promise.all([
    fetchJson(snapshotUrl),
    fetchJson(initiativesUrl),
    fetchJson(decisionsUrl),
    fetchJson(nextUpUrl),
  ]);

  const snapshotSessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  const snapshotActivity = Array.isArray(snapshot?.activity) ? snapshot.activity : [];
  const initiativesRows = Array.isArray(initiatives?.initiatives) ? initiatives.initiatives : [];
  const decisionRows = Array.isArray(decisions?.decisions) ? decisions.decisions : [];
  const nextUpItems = Array.isArray(nextUp?.items) ? nextUp.items : [];

  report.api.snapshotSessions = snapshotSessions.length;
  report.api.snapshotActivity = snapshotActivity.length;
  report.api.liveInitiatives = initiativesRows.length;
  report.api.pendingDecisions = decisionRows.length;
  report.api.nextUpItems = nextUpItems.length;

  const liveInitiativeIds = collectInitiativeIds(initiativesRows, ["id", "initiativeId"]);
  const nextUpInitiativeIds = collectInitiativeIds(nextUpItems, ["initiativeId", "initiative_id"]);
  const missingIds = Array.from(nextUpInitiativeIds).filter((id) => !liveInitiativeIds.has(id));
  report.api.nextUpMissingInitiativeIds = missingIds;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(scopedLiveUrl.toString(), { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(1_200);
    await dismissFirstRunChecklist(page);
    await page.waitForTimeout(600);

    report.ui.panes.agents = await page.getByText(/^Agents\b/i).first().isVisible().catch(() => false);
    report.ui.panes.activity = await page.getByText(/^Activity\b/i).first().isVisible().catch(() => false);
    const inProgressVisible = await page.getByRole("button", { name: /^In Progress\b/i }).first().isVisible().catch(() => false);
    const nextUpVisible = await page.getByRole("button", { name: /^Next Up\b/i }).first().isVisible().catch(() => false);
    report.ui.panes.rightRail = inProgressVisible || nextUpVisible;

    const autopilotControl = page
      .locator("button:visible")
      .filter({ hasText: /Auto|Autopilot|∞/i })
      .first();
    report.ui.autopilotControlVisible = await autopilotControl.isVisible().catch(() => false);

    const sessionRowLocator = page.locator("text=/AGENT\\s+(RUNNING|BLOCKED|QUEUED)/i");
    report.ui.sessionRowVisible = (await sessionRowLocator.count().catch(() => 0)) > 0;

    report.ui.decisionsLabelVisible = await page.getByText(/Decisions/i).first().isVisible().catch(() => false);
    if (!report.ui.decisionsLabelVisible) {
      const activityTab = page.getByRole("button", { name: /^Activity\b/i }).first();
      if (await activityTab.count()) {
        await activityTab.click({ timeout: 4_000 }).catch(() => {});
        await page.waitForTimeout(450);
      }
      report.ui.decisionsLabelVisible = await page.getByText(/Decisions/i).first().isVisible().catch(() => false);
    }
    const decisionTexts = await page
      .locator("text=/Decisions?/i")
      .allTextContents()
      .catch(() => []);
    report.ui.decisionsPositiveBadgeVisible = hasPositiveDecisionBadge(decisionTexts);
    if (report.api.pendingDecisions > 0 && !report.ui.decisionsPositiveBadgeVisible) {
      const approveButtons = await page.getByRole("button", { name: /Approve/i }).count().catch(() => 0);
      if (approveButtons > 0) report.ui.decisionsPositiveBadgeVisible = true;
    }
    report.ui.needsInputSignalVisible = await page
      .locator("text=/need(?:s)?\\s+your\\s+input/i")
      .first()
      .isVisible()
      .catch(() => false);

    const nextUpTab = page.getByRole("button", { name: /^Next Up\b/i }).first();
    if (await nextUpTab.count()) {
      await nextUpTab.click({ timeout: 4_000 }).catch(() => {});
      await page.waitForTimeout(400);
    }
    const nextUpActionButtons = page.getByRole("button", { name: /^(Start|Pause|Resume)$/i });
    report.ui.nextUpActionVisible = (await nextUpActionButtons.count().catch(() => 0)) > 0;
    if (!report.ui.nextUpActionVisible && report.api.nextUpItems > 0) {
      const missionControlTab = page.getByRole("button", { name: /Mission Control/i }).first();
      if (await missionControlTab.count()) {
        await missionControlTab.click({ timeout: 4_000 }).catch(() => {});
        await page.waitForTimeout(450);
      }
      const openQueueButton = page.getByRole("button", { name: /Open Queue/i }).first();
      if (await openQueueButton.count()) {
        await openQueueButton.click({ timeout: 4_000 }).catch(() => {});
        await page.waitForTimeout(600);
      }
      if (await nextUpTab.count()) {
        await nextUpTab.click({ timeout: 4_000 }).catch(() => {});
        await page.waitForTimeout(500);
      }
      report.ui.nextUpActionVisible = (await nextUpActionButtons.count().catch(() => 0)) > 0;
    }

    const screenshotPath = join(RESULT_DIR, `live-ui-p0-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    report.screenshots.main = screenshotPath;
  } finally {
    await browser.close().catch(() => {});
  }

  const checks = [
    {
      id: "P0-1",
      ok: report.ui.panes.agents && report.ui.panes.activity && report.ui.panes.rightRail,
      detail: `agents=${report.ui.panes.agents} activity=${report.ui.panes.activity} rightRail=${report.ui.panes.rightRail}`,
    },
    {
      id: "P0-2",
      ok: report.ui.autopilotControlVisible,
      detail: `autopilotControlVisible=${report.ui.autopilotControlVisible}`,
    },
    {
      id: "P0-3",
      ok: report.api.snapshotSessions === 0 ? true : report.ui.sessionRowVisible,
      detail: `apiSessions=${report.api.snapshotSessions} sessionRowVisible=${report.ui.sessionRowVisible}`,
    },
    {
      id: "P0-4",
      ok: report.api.nextUpItems === 0 ? true : report.ui.nextUpActionVisible,
      detail: `apiNextUpItems=${report.api.nextUpItems} nextUpActionVisible=${report.ui.nextUpActionVisible}`,
    },
    {
      id: "P0-5",
      ok:
        report.api.pendingDecisions === 0
          ? report.ui.decisionsLabelVisible
          : report.ui.decisionsPositiveBadgeVisible ||
            report.ui.needsInputSignalVisible ||
            (report.ui.decisionsLabelVisible && report.ui.decisionsPositiveBadgeVisible),
      detail: `apiPending=${report.api.pendingDecisions} decisionsLabelVisible=${report.ui.decisionsLabelVisible} decisionsPositiveBadgeVisible=${report.ui.decisionsPositiveBadgeVisible} needsInputSignalVisible=${report.ui.needsInputSignalVisible}`,
    },
    {
      id: "P0-6",
      ok: report.api.nextUpMissingInitiativeIds.length === 0,
      detail:
        report.api.nextUpMissingInitiativeIds.length === 0
          ? "next-up initiatives are scoped correctly"
          : `missing initiativeIds: ${report.api.nextUpMissingInitiativeIds.join(", ")}`,
    },
  ];

  report.checks = checks;
  for (const check of checks) {
    if (!check.ok) report.errors.push(`${check.id} failed: ${check.detail}`);
  }
  report.passed = report.errors.length === 0;
  report.finishedAt = nowIso();

  const resultPath = join(RESULT_DIR, `live-ui-p0-audit-${Date.now()}.json`);
  report.resultPath = resultPath;
  writeFileSync(resultPath, JSON.stringify(report, null, 2), "utf8");

  process.stdout.write(`[live-ui-p0] report: ${resultPath}\n`);
  process.stdout.write(
    `[live-ui-p0] checks: ${checks.filter((entry) => entry.ok).length}/${checks.length} passed\n`
  );
  if (report.errors.length > 0) {
    for (const entry of report.errors) {
      process.stderr.write(`[live-ui-p0] ${entry}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write("[live-ui-p0] PASS\n");
  }
}

run().catch((err) => {
  process.stderr.write(`[live-ui-p0] fatal: ${err?.message || String(err)}\n`);
  process.exitCode = 1;
});
