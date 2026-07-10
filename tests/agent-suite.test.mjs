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
  const engineering = plan.agents.find((agent) => agent.id === "orgx-engineering");
  assert.ok(engineering, "expected engineering suite agent");
  assert.equal(engineering.configHealth.status, "needs_apply");
  assert.equal(engineering.configHealth.totalChecks > 0, true);
  assert.equal(engineering.configHealth.evalPassRate, 0);
  assert.equal(engineering.configHealth.lastChangedAt, null);
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
  const engineeringConfig = list.find((entry) => entry.id === "orgx-engineering");
  const orchestratorConfig = list.find((entry) => entry.id === "orgx-orchestrator");
  assert.ok(engineeringConfig?.tools?.alsoAllow?.includes("orgx_status"));
  assert.ok(engineeringConfig?.tools?.alsoAllow?.includes("orgx_recommend_next_action"));
  assert.ok(!engineeringConfig?.tools?.alsoAllow?.includes("orgx_apply_changeset"));
  assert.ok(orchestratorConfig?.tools?.alsoAllow?.includes("orgx_apply_changeset"));

  const managedPath = join(engineering.workspace, ".orgx", "managed", "AGENTS.md");
  const compositePath = join(engineering.workspace, "AGENTS.md");
  assert.ok(existsSync(managedPath), "expected managed file to exist");
  assert.ok(existsSync(compositePath), "expected composite file to exist");

  const composite = readFileSync(compositePath, "utf8");
  assert.ok(composite.includes("# === ORGX MANAGED"), "expected managed header in composite");
  assert.ok(composite.includes("# === ORGX LOCAL OVERRIDES"), "expected local overrides header in composite");
  assert.ok(composite.includes("Local note: keep commits small."), "expected local override appended to composite");
});

test("applyOrgxAgentSuitePlan adds scoped OrgX tools to existing agents without replacing user policy", async () => {
  const mod = await importFreshModule();

  const openclawDir = mkdtempSync(join(tmpdir(), "orgx-openclaw-suite-tools-"));
  const workspacesDir = join(openclawDir, "workspaces");
  mkdirSync(workspacesDir, { recursive: true });
  const engineeringWorkspace = join(workspacesDir, "orgx", "agents", "orgx-engineering");
  writeJson(join(openclawDir, "openclaw.json"), {
    agents: {
      list: [
        { id: "orgx", name: "OrgX", workspace: join(workspacesDir, "orgx") },
        {
          id: "orgx-engineering",
          name: "OrgX Engineering",
          workspace: engineeringWorkspace,
          tools: { profile: "coding", alsoAllow: ["custom_tool"], deny: ["message"] },
        },
      ],
    },
  });

  const plan = mod.computeOrgxAgentSuitePlan({ packVersion: "3.0.0", openclawDir });
  assert.equal(plan.openclawConfigWouldUpdate, true);
  mod.applyOrgxAgentSuitePlan({ plan, dryRun: false, openclawDir });

  const updated = JSON.parse(readFileSync(join(openclawDir, "openclaw.json"), "utf8"));
  const engineering = updated.agents.list.find((entry) => entry.id === "orgx-engineering");
  assert.equal(engineering.tools.profile, "coding");
  assert.deepEqual(engineering.tools.deny, ["message"]);
  assert.ok(engineering.tools.alsoAllow.includes("custom_tool"));
  assert.ok(engineering.tools.alsoAllow.includes("orgx_status"));
  assert.ok(engineering.tools.alsoAllow.includes("orgx_register_artifact"));
  assert.ok(!engineering.tools.alsoAllow.includes("orgx_apply_changeset"));
});

test("SKILL.md includes Team Awareness section for all suite agents", async () => {
  const mod = await importFreshModule();

  const openclawDir = mkdtempSync(join(tmpdir(), "orgx-openclaw-suite-"));
  const workspacesDir = join(openclawDir, "workspaces");
  mkdirSync(workspacesDir, { recursive: true });

  const openclawConfigPath = join(openclawDir, "openclaw.json");
  writeJson(openclawConfigPath, {
    agents: {
      list: [
        { id: "orgx", name: "OrgX", workspace: join(workspacesDir, "orgx") },
      ],
    },
  });

  const plan = mod.computeOrgxAgentSuitePlan({ packVersion: "3.0.0", openclawDir });
  mod.applyOrgxAgentSuitePlan({ plan, dryRun: false, openclawDir });

  for (const agent of plan.agents) {
    const skillPath = join(agent.workspace, "SKILL.md");
    assert.ok(existsSync(skillPath), `expected SKILL.md for ${agent.id}`);
    const content = readFileSync(skillPath, "utf8");
    assert.ok(
      content.includes("## Team Awareness"),
      `expected Team Awareness section in ${agent.id} SKILL.md`
    );
    assert.ok(
      content.includes("Do not duplicate work another agent has completed"),
      `expected team awareness guidance in ${agent.id} SKILL.md`
    );
  }
});

test("HEARTBEAT.md advances one canonical task without regressing completed work", async () => {
  const mod = await importFreshModule();

  const openclawDir = mkdtempSync(join(tmpdir(), "orgx-openclaw-suite-"));
  const workspacesDir = join(openclawDir, "workspaces");
  mkdirSync(workspacesDir, { recursive: true });
  writeJson(join(openclawDir, "openclaw.json"), {
    agents: {
      list: [{ id: "orgx", name: "OrgX", workspace: join(workspacesDir, "orgx") }],
    },
  });

  const plan = mod.computeOrgxAgentSuitePlan({ packVersion: "3.0.0", openclawDir });
  mod.applyOrgxAgentSuitePlan({ plan, dryRun: false, openclawDir });

  for (const agent of plan.agents) {
    const content = readFileSync(join(agent.workspace, "HEARTBEAT.md"), "utf8");
    assert.match(content, /Select exactly one active, goal-linked task/);
    assert.match(content, /canonical_only=true/);
    assert.match(content, /orgx_recommend_next_action.*canonical_only=true/);
    assert.match(content, /agent_id=/);
    assert.match(content, /A status message alone is not progress/);
    assert.match(content, /entity_type=task/);
    assert.match(content, /successful tool output was observed/);
    assert.match(content, /orgx_verify_completion/);
    assert.match(content, /ready=true.*verified=true/);
    assert.match(content, /blocker_code=missing_execution_context/);
    assert.match(content, /at most 5 execution tool calls/);
    assert.match(content, /Never use `find`/);
    assert.match(content, /Never reopen or downgrade a done\/completed task/);
    assert.match(content, /heartbeat_respond.*notify=false/);
  }
});

test("managed suite files upgrade when their header hash still matches", async () => {
  const mod = await importFreshModule();

  const openclawDir = mkdtempSync(join(tmpdir(), "orgx-openclaw-suite-upgrade-"));
  const workspacesDir = join(openclawDir, "workspaces");
  mkdirSync(workspacesDir, { recursive: true });
  writeJson(join(openclawDir, "openclaw.json"), {
    agents: {
      list: [{ id: "orgx", name: "OrgX", workspace: join(workspacesDir, "orgx") }],
    },
  });

  const initialPlan = mod.computeOrgxAgentSuitePlan({ packVersion: "1.0.0", openclawDir });
  mod.applyOrgxAgentSuitePlan({ plan: initialPlan, dryRun: false, openclawDir });

  const upgradePlan = mod.computeOrgxAgentSuitePlan({ packVersion: "1.1.0", openclawDir });
  assert.ok(upgradePlan.workspaceFiles.every((entry) => entry.action === "update"));
  mod.applyOrgxAgentSuitePlan({ plan: upgradePlan, dryRun: false, openclawDir });

  const heartbeatPath = join(
    upgradePlan.suiteWorkspaceRoot,
    "orgx-engineering",
    "HEARTBEAT.md"
  );
  assert.match(readFileSync(heartbeatPath, "utf8"), /orgx-agent-suite@1\.1\.0/);
});

test("managed suite files still protect out-of-band edits", async () => {
  const mod = await importFreshModule();

  const openclawDir = mkdtempSync(join(tmpdir(), "orgx-openclaw-suite-conflict-"));
  const workspacesDir = join(openclawDir, "workspaces");
  mkdirSync(workspacesDir, { recursive: true });
  writeJson(join(openclawDir, "openclaw.json"), {
    agents: {
      list: [{ id: "orgx", name: "OrgX", workspace: join(workspacesDir, "orgx") }],
    },
  });

  const initialPlan = mod.computeOrgxAgentSuitePlan({ packVersion: "1.0.0", openclawDir });
  mod.applyOrgxAgentSuitePlan({ plan: initialPlan, dryRun: false, openclawDir });
  const heartbeatPath = join(
    initialPlan.suiteWorkspaceRoot,
    "orgx-engineering",
    "HEARTBEAT.md"
  );
  writeFileSync(heartbeatPath, `${readFileSync(heartbeatPath, "utf8")}Manual edit.\n`, "utf8");

  const upgradePlan = mod.computeOrgxAgentSuitePlan({ packVersion: "1.1.0", openclawDir });
  const heartbeat = upgradePlan.workspaceFiles.find(
    (entry) => entry.agentId === "orgx-engineering" && entry.file === "HEARTBEAT.md"
  );
  assert.equal(heartbeat?.action, "conflict");
});
