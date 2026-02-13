import test from "node:test";
import assert from "node:assert/strict";

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

test("agents/launch dry-run renders deterministic kickoff message when kickoff context is available", async () => {
  const config = {
    apiKey: "oxk_test",
    userId: "",
    baseUrl: "https://www.useorgx.com",
    syncIntervalMs: 300_000,
    enabled: true,
    dashboardEnabled: true,
    pluginVersion: "9.9.9-test",
  };

  const kickoff = {
    context_hash: "ctx_abc123",
    schema_version: "2026-02-13",
    overview: "Build the kickoff renderer and include provenance.",
    acceptance_criteria: ["Deterministic sections", "Includes context hash"],
    constraints: ["No secrets in output"],
    tool_scope: { allow: ["orgx_sync", "orgx_emit_activity"], deny: ["rm -rf"], notes: "Prefer read-only when unsure." },
    reporting_expectations: ["Post progress when tests pass", "Ask for decisions when blocked"],
    task: { id: "task-1", title: "Implement kickoff context", status: "todo" },
    decisions: [{ id: "dec-1", title: "Kickoff schema approved", status: "approved" }],
    artifacts: [{ id: "art-1", title: "Plan doc", status: "ready" }],
  };

  const client = {
    getBaseUrl: () => config.baseUrl,
    getBillingStatus: async () => ({ plan: "starter", hasSubscription: true, subscriptionStatus: "active", subscriptionCurrentPeriodEnd: null }),
    emitActivity: async () => ({ ok: true }),
    updateEntity: async () => ({ ok: true }),
    listEntities: async () => ({ ok: true, data: [] }),
    applyChangeset: async () => ({ ok: true, results: [] }),
    rawRequest: async (method, path, body) => {
      assert.equal(method, "POST");
      assert.equal(path, "/api/client/kickoff-context");
      assert.equal(body?.task_id, "task-1");
      return { ok: true, data: kickoff };
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
  await handler(
    {
      method: "POST",
      url: "/orgx/api/agents/launch?agentId=agent-1&initiativeId=init-1&workstreamId=ws-1&taskId=task-1&dryRun=true",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
    res
  );

  assert.equal(res.status, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed?.ok, true);
  assert.equal(parsed?.dryRun, true);
  assert.equal(parsed?.kickoffContextHash, "ctx_abc123");
  assert.ok(typeof parsed?.message === "string");
  assert.ok(parsed.message.includes("# Kickoff"));
  assert.ok(parsed.message.includes("## Provenance"));
  assert.ok(parsed.message.includes("kickoff_context_hash: ctx_abc123"));
  assert.ok(parsed.message.includes("## Tool Scope"));
});

