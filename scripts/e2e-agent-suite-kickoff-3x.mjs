#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHttpHandler } from "../dist/http-handler.js";
import { computeOrgxAgentSuitePlan, applyOrgxAgentSuitePlan } from "../dist/agent-suite.js";

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

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runOnce(runIndex) {
  // 1) Clean OpenClaw sandbox: suite plan + apply.
  const openclawHome = mkdtempSync(join(tmpdir(), `orgx-openclaw-e2e-${runIndex}-`));
  const workspacesDir = join(openclawHome, "workspaces");
  mkdirSync(workspacesDir, { recursive: true });
  const orgxWorkspace = join(workspacesDir, "orgx");

  const openclawConfigPath = join(openclawHome, "openclaw.json");
  writeJson(openclawConfigPath, {
    agents: {
      list: [{ id: "orgx", name: "OrgX", workspace: orgxWorkspace }],
    },
  });

  const plan = computeOrgxAgentSuitePlan({ packVersion: `0.0.0-e2e-${runIndex}`, openclawDir: openclawHome });
  const applied = applyOrgxAgentSuitePlan({ plan, dryRun: false, openclawDir: openclawHome });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);

  // 2) Handler: deterministic kickoff context dry-run launch.
  const config = {
    apiKey: "oxk_test",
    userId: "",
    baseUrl: "https://www.useorgx.com",
    syncIntervalMs: 300_000,
    enabled: true,
    dashboardEnabled: true,
    pluginVersion: `0.0.0-e2e-${runIndex}`,
  };

  const kickoff = {
    context_hash: "ctx_e2e_fixed",
    schema_version: "2026-02-13",
    overview: "E2E kickoff verification.",
    acceptance_criteria: ["Message contains sections", "Context hash present"],
    constraints: ["No secrets in output"],
    tool_scope: { allow: ["orgx_sync"], deny: ["rm -rf"] },
  };

  const client = {
    getBaseUrl: () => config.baseUrl,
    getBillingStatus: async () => ({ plan: "starter", hasSubscription: true, subscriptionStatus: "active", subscriptionCurrentPeriodEnd: null }),
    emitActivity: async () => ({ ok: true }),
    updateEntity: async () => ({ ok: true }),
    listEntities: async () => ({ ok: true, data: [] }),
    applyChangeset: async () => ({ ok: true, results: [] }),
    rawRequest: async (method, path) => {
      assert.equal(method, "POST");
      assert.equal(path, "/api/client/kickoff-context");
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
        listAgents: async () => [{ id: "orgx-engineering", model: "gpt-4.1" }],
        spawnAgentTurn: () => ({ pid: 123 }),
      },
    }
  );

  const res = createStubResponse();
  await handler(
    {
      method: "POST",
      url: "/orgx/api/agents/launch?agentId=orgx-engineering&sessionId=00000000-0000-0000-0000-000000000001&initiativeId=init-1&workstreamId=ws-1&taskId=task-1&dryRun=true",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
    res
  );

  assert.equal(res.status, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed?.ok, true);
  assert.equal(parsed?.dryRun, true);
  assert.equal(parsed?.kickoffContextHash, "ctx_e2e_fixed");
  assert.ok(typeof parsed?.message === "string");
  assert.ok(parsed.message.includes("# Kickoff"));
  assert.ok(parsed.message.includes("## Provenance"));
  assert.ok(parsed.message.includes("kickoff_context_hash: ctx_e2e_fixed"));
}

async function main() {
  for (let i = 1; i <= 3; i += 1) {
    await runOnce(i);
    console.log(`[e2e] pass ${i}/3`);
  }
  console.log("[e2e] ok: 3/3 runs passed without errors");
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[e2e] failed: ${message}`);
  process.exit(1);
});

