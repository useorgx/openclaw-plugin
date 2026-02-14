#!/usr/bin/env node
/**
 * Verification matrix runner for scripts/verify-autopilot-e2e-local.mjs.
 *
 * This keeps the worker deterministic (mock) while verifying that the autopilot
 * pipeline correctly attributes runtime + activity to both codex and claude-code
 * executors (source_client routing).
 *
 * Optional real-agent runs can be enabled explicitly:
 * - ORGX_E2E_ENABLE_REAL_CODEX=1
 * - ORGX_E2E_ENABLE_REAL_CLAUDE=1 (requires ORGX_CLAUDE_CODE_ARGS to be set)
 */

import { spawn } from "node:child_process";

const TASKS = Number.isFinite(Number(process.env.ORGX_E2E_TASKS))
  ? Math.max(1, Math.floor(Number(process.env.ORGX_E2E_TASKS)))
  : 3;

function runScenario({ name, env }) {
  return new Promise((resolve) => {
    const child = spawn("node", ["scripts/verify-autopilot-e2e-local.mjs"], {
      stdio: "inherit",
      env: { ...process.env, ...env, ORGX_E2E_TASKS: String(env.ORGX_E2E_TASKS ?? TASKS) },
    });
    child.on("exit", (code) => resolve({ name, ok: code === 0, code: code ?? 1 }));
    child.on("error", () => resolve({ name, ok: false, code: 1 }));
  });
}

async function main() {
  const scenarios = [
    {
      name: "mock+codex",
      env: {
        ORGX_AUTOPILOT_WORKER_KIND: "mock",
        ORGX_AUTOPILOT_EXECUTOR: "codex",
      },
    },
    {
      name: "mock+claude-code",
      env: {
        ORGX_AUTOPILOT_WORKER_KIND: "mock",
        ORGX_AUTOPILOT_EXECUTOR: "claude-code",
      },
    },
  ];

  if (String(process.env.ORGX_E2E_ENABLE_REAL_CODEX ?? "").trim() === "1") {
    scenarios.push({
      name: "real+codex",
      env: {
        ORGX_AUTOPILOT_WORKER_KIND: "codex",
        ORGX_AUTOPILOT_EXECUTOR: "codex",
        // Keep the run minimal. `normalizeCodexArgs` will ensure `exec` is used.
        ORGX_CODEX_ARGS: "--ephemeral --full-auto",
        ORGX_E2E_TIMEOUT_MS: "360000",
        ORGX_E2E_TASKS: "1",
      },
    });
  }

  if (String(process.env.ORGX_E2E_ENABLE_REAL_CLAUDE ?? "").trim() === "1") {
    scenarios.push({
      name: "real+claude-code",
      env: {
        ORGX_AUTOPILOT_WORKER_KIND: "claude-code",
        ORGX_AUTOPILOT_EXECUTOR: "claude-code",
        ORGX_E2E_TASKS: "1",
      },
    });
  }

  const results = [];
  for (const scenario of scenarios) {
    const result = await runScenario(scenario);
    results.push(result);
    if (!result.ok) break;
  }

  const ok = results.every((r) => r.ok);
  console.log(JSON.stringify({ ok, results }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
