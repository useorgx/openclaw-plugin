import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHttpHandler } from "../../dist/http-handler.js";

function createStubResponse() {
  const res = {
    status: null,
    headers: null,
    body: "",
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? null;
    },
    end(body) {
      if (body) {
        this.body += Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
      }
      this.writableEnded = true;
    },
  };
  return res;
}

function createNoopOnboarding() {
  return {
    getState: () => ({
      status: "idle",
      hasApiKey: false,
      connectionVerified: false,
      workspaceName: null,
      lastError: null,
      nextAction: "connect",
      docsUrl: "https://example.com",
      keySource: "none",
      installationId: null,
      connectUrl: null,
      pairingId: null,
      expiresAt: null,
      pollIntervalMs: null,
    }),
    startPairing: async () => {
      throw new Error("not implemented");
    },
    getStatus: async () => {
      throw new Error("not implemented");
    },
    submitManualKey: async () => {
      throw new Error("not implemented");
    },
    disconnect: async () => {
      throw new Error("not implemented");
    },
  };
}

test("Agent launch marks task in_progress, syncs rollups, and emits activity", async () => {
  const originalHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "orgx-agent-launch-test-"));
  process.env.HOME = home;

  try {
    const config = {
      apiKey: "oxk_test",
      userId: "",
      baseUrl: "https://www.useorgx.com",
      syncIntervalMs: 300_000,
      enabled: true,
      dashboardEnabled: true,
    };

    const calls = {
      updateEntity: [],
      listEntities: [],
      applyChangeset: [],
      emitActivity: [],
    };

    const tasks = [
      {
        id: "task-1",
        status: "in_progress",
        workstream_id: "ws-1",
        milestone_id: "ms-1",
      },
      {
        id: "task-2",
        status: "todo",
        workstream_id: "ws-1",
        milestone_id: "ms-1",
      },
    ];

    const client = {
      getBaseUrl: () => config.baseUrl,
      updateEntity: async (type, id, updates) => {
        calls.updateEntity.push({ type, id, updates });
        return { ok: true, id };
      },
      listEntities: async (type, filters) => {
        calls.listEntities.push({ type, filters });
        if (type === "task") {
          return { ok: true, data: tasks };
        }
        return { ok: true, data: [] };
      },
      applyChangeset: async (payload) => {
        calls.applyChangeset.push(payload);
        return { ok: true, changeset_id: "cs_1", replayed: false, run_id: "run_1", applied_count: 1, results: [], event_id: null };
      },
      emitActivity: async (payload) => {
        calls.emitActivity.push(payload);
        return { ok: true, run_id: "run_1", event_id: null, reused_run: false };
      },
    };

    const handler = createHttpHandler(
      config,
      client,
      () => null,
      createNoopOnboarding(),
      undefined,
      {
        openclaw: {
          listAgents: async () => [{ id: "agent-1", model: "gpt-4.1" }],
          spawnAgentTurn: () => ({ pid: 123 }),
        },
      }
    );

    const res = createStubResponse();
    const req = {
      method: "POST",
      url: "/orgx/api/agents/launch?agentId=agent-1&sessionId=00000000-0000-0000-0000-000000000001&initiativeId=init-1&workstreamId=ws-1&taskId=task-1",
      headers: {},
    };

    await handler(req, res);
    assert.equal(res.status, 202);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed?.ok, true);

    // Task marked in progress.
    assert.ok(
      calls.updateEntity.some(
        (c) => c.type === "task" && c.id === "task-1" && c.updates?.status === "in_progress"
      ),
      "expected task status update"
    );

    // Workstream rollup updated.
    assert.ok(
      calls.updateEntity.some(
        (c) => c.type === "workstream" && c.id === "ws-1" && c.updates?.status === "active"
      ),
      "expected workstream rollup update"
    );

    // Milestone rollup updated via changeset.
    assert.ok(
      calls.applyChangeset.some((c) =>
        Array.isArray(c.operations) &&
        c.operations.some(
          (op) => op.op === "milestone.update" && op.milestone_id === "ms-1"
        )
      ),
      "expected milestone rollup changeset"
    );

    // Activity emitted.
    assert.ok(calls.emitActivity.length >= 1, "expected launch activity emit");
  } finally {
    process.env.HOME = originalHome;
  }
});

