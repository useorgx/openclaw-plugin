#!/usr/bin/env node
/**
 * Non-happy-path E2E matrix for Play/Auto-Continue lifecycle.
 *
 * Runs scripts/verify-autopilot-e2e-local.mjs with deterministic mock scenarios
 * and validates blocked/error translation, decisions, and activity events.
 */

import { spawn } from "node:child_process";

function runScenario({ name, env }) {
  return new Promise((resolve) => {
    const child = spawn("node", ["scripts/verify-autopilot-e2e-local.mjs"], {
      stdio: "inherit",
      env: {
        ...process.env,
        ...env,
      },
    });
    child.on("exit", (code) => resolve({ name, ok: code === 0, code: code ?? 1 }));
    child.on("error", () => resolve({ name, ok: false, code: 1 }));
  });
}

async function main() {
  const scenarioTemplates = [
    {
      name: "no_updates->blocked",
      env: {
        ORGX_AUTOPILOT_WORKER_KIND: "mock",
        ORGX_AUTOPILOT_MOCK_SCENARIO: "no_updates",
        ORGX_E2E_INJECT_PROGRESS: "0",
        ORGX_E2E_EXPECT_STOP_REASON: "blocked",
        ORGX_E2E_EXPECT_SLICE_STATUSES: "completed",
        ORGX_E2E_EXPECT_DECISIONS_MIN: "1",
        ORGX_E2E_EXPECT_NON_DONE_TASKS_MIN: "1",
        ORGX_E2E_EXPECT_ARTIFACTS_MIN: "0",
      },
    },
    {
      name: "needs_decision->blocked",
      env: {
        ORGX_AUTOPILOT_WORKER_KIND: "mock",
        ORGX_AUTOPILOT_MOCK_SCENARIO: "needs_decision",
        ORGX_E2E_INJECT_PROGRESS: "0",
        ORGX_E2E_EXPECT_STOP_REASON: "blocked",
        ORGX_E2E_EXPECT_SLICE_STATUSES: "needs_decision",
        ORGX_E2E_EXPECT_DECISIONS_MIN: "1",
        ORGX_E2E_EXPECT_NON_DONE_TASKS_MIN: "1",
        ORGX_E2E_EXPECT_ARTIFACTS_MIN: "0",
      },
    },
    {
      name: "blocked_no_decision->fallback_decision",
      env: {
        ORGX_AUTOPILOT_WORKER_KIND: "mock",
        ORGX_AUTOPILOT_MOCK_SCENARIO: "blocked_no_decision",
        ORGX_E2E_INJECT_PROGRESS: "0",
        ORGX_E2E_EXPECT_STOP_REASON: "blocked",
        ORGX_E2E_EXPECT_SLICE_STATUSES: "blocked",
        ORGX_E2E_EXPECT_DECISIONS_MIN: "1",
        ORGX_E2E_EXPECT_NON_DONE_TASKS_MIN: "1",
        ORGX_E2E_EXPECT_ARTIFACTS_MIN: "0",
      },
    },
    {
      name: "worker_error->error",
      env: {
        ORGX_AUTOPILOT_WORKER_KIND: "mock",
        ORGX_AUTOPILOT_MOCK_SCENARIO: "error",
        ORGX_E2E_INJECT_PROGRESS: "0",
        ORGX_E2E_EXPECT_STOP_REASON: "error",
        ORGX_E2E_EXPECT_SLICE_STATUSES: "error",
        ORGX_E2E_EXPECT_DECISIONS_MIN: "1",
        ORGX_E2E_EXPECT_NON_DONE_TASKS_MIN: "1",
        ORGX_E2E_EXPECT_ARTIFACTS_MIN: "0",
      },
    },
    {
      name: "invalid_json->error",
      env: {
        ORGX_AUTOPILOT_WORKER_KIND: "mock",
        ORGX_AUTOPILOT_MOCK_SCENARIO: "invalid_json",
        ORGX_E2E_INJECT_PROGRESS: "0",
        ORGX_E2E_EXPECT_STOP_REASON: "error",
        ORGX_E2E_EXPECT_SLICE_STATUSES: "error",
        ORGX_E2E_EXPECT_DECISIONS_MIN: "1",
        ORGX_E2E_EXPECT_NON_DONE_TASKS_MIN: "1",
        ORGX_E2E_EXPECT_ARTIFACTS_MIN: "0",
      },
    },
    {
      name: "stall->blocked_with_stall_event",
      env: {
        ORGX_AUTOPILOT_WORKER_KIND: "mock",
        ORGX_AUTOPILOT_MOCK_SCENARIO: "stall",
        ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1000",
        ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "5000",
        ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "20",
        ORGX_E2E_INJECT_PROGRESS: "0",
        ORGX_E2E_EXPECT_STOP_REASON: "blocked",
        ORGX_E2E_EXPECT_SLICE_RESULTS_MIN: "0",
        ORGX_E2E_EXPECT_DECISIONS_MIN: "1",
        ORGX_E2E_EXPECT_NON_DONE_TASKS_MIN: "1",
        ORGX_E2E_EXPECT_ARTIFACTS_MIN: "0",
        ORGX_E2E_EXPECT_ACTIVITY_EVENT: "autopilot_slice_log_stall",
      },
    },
  ];
  const executors = ["codex", "claude-code"];
  const scenarios = executors.flatMap((executor) =>
    scenarioTemplates.map((scenario) => ({
      name: `${scenario.name}+${executor}`,
      env: {
        ...scenario.env,
        ORGX_AUTOPILOT_EXECUTOR: executor,
      },
    }))
  );

  const results = [];
  for (const scenario of scenarios) {
    const result = await runScenario(scenario);
    results.push(result);
  }

  const ok = results.every((result) => result.ok);
  process.stdout.write(`${JSON.stringify({ ok, results }, null, 2)}\n`);
  if (!ok) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
