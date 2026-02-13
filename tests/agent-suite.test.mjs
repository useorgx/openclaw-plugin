import test from "node:test";
import assert from "node:assert/strict";

import { chmodSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function importFreshModule() {
  const url = new URL("../dist/agent-suite.js", import.meta.url);
  url.searchParams.set("t", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("computeOrgxAgentSuitePlan plans to add missing suite agents without clobbering existing agents", async () => {
  const mod = await importFreshModule();

  const openclawDir = mkdtempSync(join(tmpdir(), "orgx-openclaw-suite-"));
  const workspacesDir = join(openclawDir, "workspaces");
  mkdirSync(workspacesDir, { recursive: true });

  const openclawConfigPath = join(openclawDir, "openclaw.json");
  writeJson(openclawConfigPath, {
    agents: {
      list: [
        { id: "orgx", name: "OrgX", workspace: join(workspacesDir, "orgx") },
        { id: "custom", name: "Custom", workspace: join(workspacesDir, "custom") },
      ],
    },
  });

  const plan = mod.computeOrgxAgentSuitePlan({ packVersion: "9.9.9", openclawDir });

  assert.equal(plan.packId, "orgx-agent-suite");
  assert.equal(plan.packVersion, "9.9.9");
  assert.equal(plan.openclawConfigPath, openclawConfigPath);
  assert.ok(plan.suiteWorkspaceRoot.includes(join(workspacesDir, "orgx", "agents")));

  assert.equal(plan.openclawConfigWouldUpdate, true);
  assert.ok(plan.openclawConfigAddedAgents.length >= 6);
  assert.ok(plan.openclawConfigAddedAgents.includes("orgx-engineering"));
});

test("applyOrgxAgentSuitePlan dryRun does not mutate openclaw.json or create workspaces", async () => {
  const mod = await importFreshModule();

  const openclawDir = mkdtempSync(join(tmpdir(), "orgx-openclaw-suite-"));
  const workspacesDir = join(openclawDir, "workspaces");
  mkdirSync(workspacesDir, { recursive: true });

  const openclawConfigPath = join(openclawDir, "openclaw.json");
  writeJson(openclawConfigPath, {
    agents: { list: [{ id: "orgx", name: "OrgX", workspace: join(workspacesDir, "orgx") }] },
  });

  const before = readFileSync(openclawConfigPath, "utf8");
  const plan = mod.computeOrgxAgentSuitePlan({ packVersion: "1.2.3", openclawDir });
  const result = mod.applyOrgxAgentSuitePlan({ plan, dryRun: true, openclawDir });

  assert.equal(result.ok, true);
  assert.equal(result.applied, false);

  const after = readFileSync(openclawConfigPath, "utf8");
  assert.equal(after, before, "expected openclaw.json to be unchanged in dryRun");
  assert.equal(existsSync(plan.suiteWorkspaceRoot), false, "expected suite workspace root to not be created in dryRun");
});

test("applyOrgxAgentSuitePlan writes managed + composite files and appends local overrides", async () => {
  const mod = await importFreshModule();

  const openclawDir = mkdtempSync(join(tmpdir(), "orgx-openclaw-suite-"));
  const workspacesDir = join(openclawDir, "workspaces");
  mkdirSync(workspacesDir, { recursive: true });

  const openclawConfigPath = join(openclawDir, "openclaw.json");
  writeJson(openclawConfigPath, {
    agents: {
      list: [
        { id: "orgx", name: "OrgX", workspace: join(workspacesDir, "orgx") },
        { id: "custom", name: "Custom", workspace: join(workspacesDir, "custom") },
      ],
    },
  });
  chmodSync(openclawConfigPath, 0o640);

  const plan = mod.computeOrgxAgentSuitePlan({ packVersion: "2.0.0", openclawDir });

  const engineering = plan.agents.find((a) => a.id === "orgx-engineering");
  assert.ok(engineering);

  const localOverrideDir = join(engineering.workspace, ".orgx", "local");
  mkdirSync(localOverrideDir, { recursive: true });
  writeFileSync(join(localOverrideDir, "AGENTS.md"), "Local note: keep commits small.\n", "utf8");

  const result = mod.applyOrgxAgentSuitePlan({ plan, dryRun: false, openclawDir });
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);

  const updatedRaw = JSON.parse(readFileSync(openclawConfigPath, "utf8"));
  const list = updatedRaw?.agents?.list ?? [];
  const ids = new Set(list.map((e) => String(e?.id ?? "")));
  assert.ok(ids.has("custom"), "should preserve existing agent");
  assert.ok(ids.has("orgx-engineering"), "should add suite agent");
  assert.ok(ids.has("orgx-orchestrator"), "should add suite agent");

  const managedPath = join(engineering.workspace, ".orgx", "managed", "AGENTS.md");
  const compositePath = join(engineering.workspace, "AGENTS.md");
  assert.ok(existsSync(managedPath), "expected managed file to exist");
  assert.ok(existsSync(compositePath), "expected composite file to exist");

  const composite = readFileSync(compositePath, "utf8");
  assert.ok(composite.includes("# === ORGX MANAGED"), "expected managed header in composite");
  assert.ok(composite.includes("# === ORGX LOCAL OVERRIDES"), "expected local overrides header in composite");
  assert.ok(composite.includes("Local note: keep commits small."), "expected local override appended to composite");
});

