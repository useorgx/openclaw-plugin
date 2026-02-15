#!/usr/bin/env node
/**
 * Verification matrix runner for scripts/verify-autopilot-e2e-entities.mjs.
 *
 * Default: deterministic mock worker while verifying executor attribution for
 * codex + claude-code (source_client routing) and multi-domain execution policy
 * (domain + required_skills).
 *
 * Optional real-agent run can be enabled explicitly:
 * - ORGX_E2E_ENABLE_REAL_CODEX=1
 */

import { spawn } from "node:child_process";

const DOMAINS = String(process.env.ORGX_E2E_DOMAINS ?? "").trim() || "engineering,product,design,marketing,operations,sales";
const TASKS_PER_DOMAIN = String(process.env.ORGX_E2E_TASKS_PER_DOMAIN ?? "").trim() || "1";

function runScenario({ name, env }) {
  return new Promise((resolve) => {
    const child = spawn("node", ["scripts/verify-autopilot-e2e-entities.mjs"], {
      stdio: "inherit",
      env: {
        ...process.env,
        ORGX_E2E_DOMAINS: String(env.ORGX_E2E_DOMAINS ?? DOMAINS),
        ORGX_E2E_TASKS_PER_DOMAIN: String(env.ORGX_E2E_TASKS_PER_DOMAIN ?? TASKS_PER_DOMAIN),
        ...env,
      },
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
    const realDomains =
      String(process.env.ORGX_E2E_REAL_DOMAINS ?? "").trim() || "engineering";
    scenarios.push({
      name: "real+codex",
      env: {
        ORGX_AUTOPILOT_WORKER_KIND: "codex",
        ORGX_AUTOPILOT_EXECUTOR: "codex",
        ORGX_CODEX_ARGS: "--ephemeral --full-auto",
        ORGX_E2E_TIMEOUT_MS: "420000",
        ORGX_E2E_DOMAINS: realDomains,
        ORGX_E2E_TASKS_PER_DOMAIN: "1",
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

