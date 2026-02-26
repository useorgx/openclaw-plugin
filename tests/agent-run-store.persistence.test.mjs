import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function importFreshAgentRunStore() {
  const url = new URL("../dist/agent-run-store.js", import.meta.url);
  url.searchParams.set("t", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("readAgentRuns normalizes persisted records and drops invalid entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-runs-"));
  const prevDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "agent-runs.json"),
      JSON.stringify({
        updatedAt: "not-a-date",
        runs: {
          "run-1": {
            runId: " run-1 ",
            agentId: " orgx-engineering ",
            pid: 123,
            message: " hello ",
            provider: " openai ",
            model: " gpt-5 ",
            initiativeId: " init-1 ",
            initiativeTitle: " Initiative 1 ",
            workstreamId: " ws-1 ",
            taskId: " task-1 ",
            startedAt: "2026-02-20T00:00:00.000Z",
            stoppedAt: "invalid-stop",
            status: "running",
          },
          broken: {
            runId: "broken",
            startedAt: "2026-02-20T00:00:00.000Z",
            status: "running",
          },
        },
      }),
      "utf8"
    );

    const mod = await importFreshAgentRunStore();
    const store = mod.readAgentRuns();

    assert.equal(Object.keys(store.runs).length, 1);
    assert.deepEqual(store.runs["run-1"], {
      runId: "run-1",
      agentId: "orgx-engineering",
      pid: 123,
      message: "hello",
      provider: "openai",
      model: "gpt-5",
      initiativeId: "init-1",
      initiativeTitle: "Initiative 1",
      workstreamId: "ws-1",
      taskId: "task-1",
      startedAt: "2026-02-20T00:00:00.000Z",
      stoppedAt: null,
      status: "running",
    });
  } finally {
    if (prevDir === undefined) {
      delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    } else {
      process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = prevDir;
    }
  }
});
