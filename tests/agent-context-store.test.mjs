import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function importFresh(configDir) {
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = configDir;
  const url = new URL("../dist/agent-context-store.js", import.meta.url);
  url.searchParams.set("t", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("readAgentContexts normalizes persisted maps and drops invalid entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-ctx-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agent-contexts.json"),
    JSON.stringify(
      {
        updatedAt: "2026-02-24T00:00:00.000Z",
        agents: {
          " agent-1 ": {
            agentId: "  agent-1  ",
            initiativeId: 101,
            initiativeTitle: "  Initiative A  ",
            workstreamId: " ws-1 ",
            taskId: " task-1 ",
            updatedAt: "2026-02-24T01:00:00.000Z",
          },
          "bad-agent": {
            agentId: "   ",
            updatedAt: "2026-02-24T01:00:00.000Z",
          },
        },
        runs: {
          " run-1 ": {
            runId: " run-1 ",
            agentId: " agent-1 ",
            initiativeId: "init-1",
            updatedAt: "2026-02-24T01:00:00.000Z",
          },
          "run-bad": {
            runId: "run-bad",
            agentId: " ",
            updatedAt: "2026-02-24T01:00:00.000Z",
          },
        },
      },
      null,
      2
    ),
    "utf8"
  );

  const { readAgentContexts, getAgentContext, getRunContext } = await importFresh(dir);

  const snapshot = readAgentContexts();
  assert.deepEqual(Object.keys(snapshot.agents), ["agent-1"]);
  assert.deepEqual(Object.keys(snapshot.runs ?? {}), ["run-1"]);

  const agent = getAgentContext("agent-1");
  assert.ok(agent, "expected normalized agent context");
  assert.equal(agent.initiativeId, null);
  assert.equal(agent.initiativeTitle, "Initiative A");
  assert.equal(agent.workstreamId, "ws-1");
  assert.equal(agent.taskId, "task-1");

  const run = getRunContext("run-1");
  assert.ok(run, "expected normalized run context");
  assert.equal(run.agentId, "agent-1");
  assert.equal(run.initiativeId, "init-1");
});

test("upsert helpers trim optional context fields before persisting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-ctx-upsert-"));
  mkdirSync(dir, { recursive: true });

  const {
    upsertAgentContext,
    upsertRunContext,
    getAgentContext,
    getRunContext,
  } = await importFresh(dir);

  upsertAgentContext({
    agentId: " agent-2 ",
    initiativeId: " init-2 ",
    initiativeTitle: "  Initiative B  ",
    workstreamId: " ws-2 ",
    taskId: " task-2 ",
  });

  upsertRunContext({
    runId: " run-2 ",
    agentId: " agent-2 ",
    initiativeId: " init-2 ",
    initiativeTitle: "  Initiative B  ",
    workstreamId: " ws-2 ",
    taskId: " task-2 ",
  });

  const agent = getAgentContext("agent-2");
  assert.ok(agent, "expected agent context");
  assert.equal(agent.initiativeId, "init-2");
  assert.equal(agent.initiativeTitle, "Initiative B");
  assert.equal(agent.workstreamId, "ws-2");
  assert.equal(agent.taskId, "task-2");

  const run = getRunContext("run-2");
  assert.ok(run, "expected run context");
  assert.equal(run.agentId, "agent-2");
  assert.equal(run.initiativeId, "init-2");
  assert.equal(run.initiativeTitle, "Initiative B");
  assert.equal(run.workstreamId, "ws-2");
  assert.equal(run.taskId, "task-2");
});

test("upsertAgentContext prunes invalid timestamp entries before recent valid ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-ctx-prune-"));
  mkdirSync(dir, { recursive: true });
  const base = new Date("2026-02-24T00:00:00.000Z");
  const agents = {};
  for (let i = 0; i < 120; i += 1) {
    agents[`agent-${i}`] = {
      agentId: `agent-${i}`,
      updatedAt: new Date(base.getTime() + i * 1000).toISOString(),
    };
  }
  agents["agent-invalid"] = {
    agentId: "agent-invalid",
    updatedAt: "invalid-date",
  };
  writeFileSync(
    join(dir, "agent-contexts.json"),
    JSON.stringify({ updatedAt: base.toISOString(), agents, runs: {} }, null, 2),
    "utf8"
  );

  const { upsertAgentContext, readAgentContexts } = await importFresh(dir);

  upsertAgentContext({ agentId: "agent-new", taskId: "task-new" });

  const snapshot = readAgentContexts();
  assert.equal(Object.keys(snapshot.agents).length, 120);
  assert.equal(snapshot.agents["agent-new"]?.taskId, "task-new");
  assert.equal(snapshot.agents["agent-invalid"], undefined);
});

test("upsertRunContext prunes invalid timestamp runs before recent valid runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run-ctx-prune-"));
  mkdirSync(dir, { recursive: true });
  const base = new Date("2026-02-24T00:00:00.000Z");
  const runs = {};
  for (let i = 0; i < 480; i += 1) {
    runs[`run-${i}`] = {
      runId: `run-${i}`,
      agentId: "agent-1",
      updatedAt: new Date(base.getTime() + i * 1000).toISOString(),
    };
  }
  runs["run-invalid"] = {
    runId: "run-invalid",
    agentId: "agent-1",
    updatedAt: "not-a-date",
  };
  writeFileSync(
    join(dir, "agent-contexts.json"),
    JSON.stringify({ updatedAt: base.toISOString(), agents: {}, runs }, null, 2),
    "utf8"
  );

  const { upsertRunContext, readAgentContexts } = await importFresh(dir);

  upsertRunContext({ runId: "run-new", agentId: "agent-2", taskId: "task-new" });

  const snapshot = readAgentContexts();
  assert.equal(Object.keys(snapshot.runs ?? {}).length, 480);
  assert.equal(snapshot.runs?.["run-new"]?.taskId, "task-new");
  assert.equal(snapshot.runs?.["run-invalid"], undefined);
});

test("readAgentContexts normalizes blank top-level updatedAt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-ctx-updated-at-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agent-contexts.json"),
    JSON.stringify({ updatedAt: "   ", agents: {}, runs: {} }, null, 2),
    "utf8"
  );

  const { readAgentContexts } = await importFresh(dir);
  const snapshot = readAgentContexts();
  assert.match(
    snapshot.updatedAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/,
    "expected updatedAt to be normalized to an ISO timestamp"
  );
});
