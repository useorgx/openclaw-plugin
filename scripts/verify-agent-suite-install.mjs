#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const distMod = await import("../dist/agent-suite.js");

  const openclawHome = mkdtempSync(join(tmpdir(), "orgx-openclaw-suite-verify-"));
  const workspacesDir = join(openclawHome, "workspaces");
  mkdirSync(workspacesDir, { recursive: true });

  const openclawConfigPath = join(openclawHome, "openclaw.json");
  const orgxWorkspace = join(workspacesDir, "orgx");

  writeJson(openclawConfigPath, {
    agents: {
      list: [{ id: "orgx", name: "OrgX", workspace: orgxWorkspace }],
    },
  });

  const plan = distMod.computeOrgxAgentSuitePlan({
    packVersion: "0.0.0-verify",
    openclawDir: openclawHome,
  });

  assert.equal(plan.packId, "orgx-agent-suite");
  assert.equal(plan.openclawConfigPath, openclawConfigPath);
  assert.ok(plan.suiteWorkspaceRoot.includes(join(orgxWorkspace, "agents")));

  const result = distMod.applyOrgxAgentSuitePlan({
    plan,
    dryRun: false,
    openclawDir: openclawHome,
  });

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);

  const updated = JSON.parse(readFileSync(openclawConfigPath, "utf8"));
  const ids = new Set((updated?.agents?.list ?? []).map((entry) => String(entry?.id ?? "")));
  assert.ok(ids.has("orgx"), "expected existing orgx agent preserved");
  assert.ok(ids.has("orgx-engineering"), "expected suite agent installed");
  assert.ok(ids.has("orgx-orchestrator"), "expected suite agent installed");

  const engineering = join(plan.suiteWorkspaceRoot, "orgx-engineering");
  assert.ok(existsSync(engineering), "expected orgx-engineering workspace created");
  assert.ok(existsSync(join(engineering, "AGENTS.md")), "expected composite AGENTS.md created");
  assert.ok(existsSync(join(engineering, ".orgx", "managed", "AGENTS.md")), "expected managed AGENTS.md created");
  assert.ok(existsSync(join(engineering, ".orgx", "local")), "expected local overlay directory created");

  console.log("[verify] ok: agent suite plan + apply succeeded");
  console.log(`[verify] openclaw home: ${openclawHome}`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[verify] failed: ${message}`);
  process.exit(1);
});

