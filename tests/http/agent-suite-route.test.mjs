import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

function baseConfig() {
  return {
    apiKey: "oxk_test",
    userId: "",
    baseUrl: "https://www.useorgx.com",
    syncIntervalMs: 300_000,
    enabled: true,
    dashboardEnabled: true,
    pluginVersion: "0.0.0-test",
  };
}

test("Agent suite status + install endpoints return structured plan (dry-run)", async () => {
  const openclawHome = mkdtempSync(join(tmpdir(), "orgx-openclaw-suite-http-"));
  const prevOpenclawHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = openclawHome;

  try {
    const workspacesDir = join(openclawHome, "workspaces");
    mkdirSync(workspacesDir, { recursive: true });

    const openclawConfigPath = join(openclawHome, "openclaw.json");
    writeFileSync(
      openclawConfigPath,
      JSON.stringify(
        {
          agents: {
            list: [{ id: "orgx", name: "OrgX", workspace: join(workspacesDir, "orgx") }],
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const config = baseConfig();
    const client = { getBaseUrl: () => config.baseUrl };
    const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

    const statusRes = createStubResponse();
    await handler(
      { method: "GET", url: "/orgx/api/agent-suite/status", headers: {} },
      statusRes
    );
    assert.equal(statusRes.status, 200);
    const statusBody = JSON.parse(statusRes.body);
    assert.equal(statusBody?.ok, true);
    assert.equal(statusBody?.data?.packId, "orgx-agent-suite");
    assert.equal(statusBody?.data?.openclawConfigPath, openclawConfigPath);

    const installRes = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/agent-suite/install",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      },
      installRes
    );
    assert.equal(installRes.status, 200);
    const installBody = JSON.parse(installRes.body);
    assert.equal(installBody?.ok, true);
    assert.equal(installBody?.dryRun, true);
    assert.equal(installBody?.applied, false);
    assert.equal(installBody?.data?.packId, "orgx-agent-suite");
  } finally {
    if (prevOpenclawHome == null) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = prevOpenclawHome;
    }
  }
});

test("Skill-pack policy endpoint returns diff audit and supports rollback", async () => {
  const openclawHome = mkdtempSync(join(tmpdir(), "orgx-openclaw-skill-pack-policy-http-"));
  const prevOpenclawHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = openclawHome;

  try {
    const config = baseConfig();
    const client = { getBaseUrl: () => config.baseUrl };
    const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

    const updateRes = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/skill-pack/policy",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          frozen: true,
          changedBy: "qa-user@useorgx.com",
          reason: "pin rollout behavior",
        }),
      },
      updateRes
    );
    assert.equal(updateRes.status, 200);
    const updateBody = JSON.parse(updateRes.body);
    assert.equal(updateBody?.ok, true);
    assert.equal(updateBody?.data?.policy?.frozen, true);
    assert.equal(updateBody?.data?.audit?.entries?.length, 1);
    assert.equal(updateBody?.data?.audit?.entries?.[0]?.action, "policy.update");
    assert.equal(updateBody?.data?.audit?.entries?.[0]?.changedBy, "qa-user@useorgx.com");
    const targetAuditId = updateBody?.data?.audit?.entries?.[0]?.id;
    assert.ok(typeof targetAuditId === "string" && targetAuditId.length > 0);

    const rollbackRes = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/skill-pack/policy",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "rollback",
          rollbackToAuditId: targetAuditId,
          changedBy: "release-manager@useorgx.com",
          reason: "revert temporary freeze",
        }),
      },
      rollbackRes
    );
    assert.equal(rollbackRes.status, 200);
    const rollbackBody = JSON.parse(rollbackRes.body);
    assert.equal(rollbackBody?.ok, true);
    assert.equal(rollbackBody?.data?.policy?.frozen, false);
    assert.equal(rollbackBody?.data?.audit?.entries?.[0]?.action, "policy.rollback");
    assert.equal(
      rollbackBody?.data?.audit?.entries?.[0]?.rollbackOfAuditId,
      targetAuditId
    );
    assert.equal(
      rollbackBody?.data?.audit?.entries?.[0]?.changedBy,
      "release-manager@useorgx.com"
    );

    const readRes = createStubResponse();
    await handler(
      { method: "GET", url: "/orgx/api/skill-pack/policy", headers: {} },
      readRes
    );
    assert.equal(readRes.status, 200);
    const readBody = JSON.parse(readRes.body);
    assert.equal(readBody?.ok, true);
    assert.equal(readBody?.data?.policy?.frozen, false);
    assert.equal(readBody?.data?.audit?.entries?.length, 2);
    assert.equal(readBody?.data?.audit?.entries?.[0]?.action, "policy.rollback");
    assert.equal(readBody?.data?.audit?.entries?.[1]?.action, "policy.update");
  } finally {
    if (prevOpenclawHome == null) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = prevOpenclawHome;
    }
  }
});

test("Skill-pack policy endpoint supports one-click rollback to previous version", async () => {
  const openclawHome = mkdtempSync(join(tmpdir(), "orgx-openclaw-skill-pack-policy-one-click-http-"));
  const prevOpenclawHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = openclawHome;

  try {
    const config = baseConfig();
    const client = { getBaseUrl: () => config.baseUrl };
    const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

    const updateRes = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/skill-pack/policy",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ frozen: true }),
      },
      updateRes
    );
    assert.equal(updateRes.status, 200);
    const updateBody = JSON.parse(updateRes.body);
    assert.equal(updateBody?.data?.policy?.frozen, true);

    const rollbackRes = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/skill-pack/policy",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rollback" }),
      },
      rollbackRes
    );
    assert.equal(rollbackRes.status, 200);
    const rollbackBody = JSON.parse(rollbackRes.body);
    assert.equal(rollbackBody?.ok, true);
    assert.equal(rollbackBody?.data?.policy?.frozen, false);
    assert.equal(rollbackBody?.data?.audit?.entries?.[0]?.action, "policy.rollback");
    assert.equal(rollbackBody?.data?.audit?.entries?.[0]?.rollbackOfAuditId, updateBody?.data?.audit?.entries?.[0]?.id);
  } finally {
    if (prevOpenclawHome == null) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = prevOpenclawHome;
    }
  }
});

test("Skill-pack policy endpoint validates update payloads", async () => {
  const openclawHome = mkdtempSync(join(tmpdir(), "orgx-openclaw-skill-pack-policy-validation-http-"));
  const prevOpenclawHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = openclawHome;

  try {
    const config = baseConfig();
    const client = { getBaseUrl: () => config.baseUrl };
    const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

    const emptyUpdateRes = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/skill-pack/policy",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      emptyUpdateRes
    );
    assert.equal(emptyUpdateRes.status, 400);
    const emptyUpdateBody = JSON.parse(emptyUpdateRes.body);
    assert.match(emptyUpdateBody?.error ?? "", /Include at least one mutable field/);

    const conflictRes = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/skill-pack/policy",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinToCurrent: true, clearPin: true }),
      },
      conflictRes
    );
    assert.equal(conflictRes.status, 400);
    const conflictBody = JSON.parse(conflictRes.body);
    assert.match(conflictBody?.error ?? "", /cannot both be true/);

    const blankChecksumRes = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/skill-pack/policy",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinnedChecksum: "   " }),
      },
      blankChecksumRes
    );
    assert.equal(blankChecksumRes.status, 400);
    const blankChecksumBody = JSON.parse(blankChecksumRes.body);
    assert.match(blankChecksumBody?.error ?? "", /non-empty string/);

    const badActionRes = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/skill-pack/policy",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rotate" }),
      },
      badActionRes
    );
    assert.equal(badActionRes.status, 400);
    const badActionBody = JSON.parse(badActionRes.body);
    assert.match(badActionBody?.error ?? "", /action must be 'rollback'/);

    const rollbackConflictRes = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/skill-pack/policy",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rollback", clearPin: true }),
      },
      rollbackConflictRes
    );
    assert.equal(rollbackConflictRes.status, 400);
    const rollbackConflictBody = JSON.parse(rollbackConflictRes.body);
    assert.match(rollbackConflictBody?.error ?? "", /cannot include update fields/);

    const rollbackWithoutTargetRes = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/skill-pack/policy",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rollback" }),
      },
      rollbackWithoutTargetRes
    );
    assert.equal(rollbackWithoutTargetRes.status, 400);
    const rollbackWithoutTargetBody = JSON.parse(rollbackWithoutTargetRes.body);
    assert.match(
      rollbackWithoutTargetBody?.error ?? "",
      /No policy audit entry available for rollback/
    );

    const snakeCaseChecksumRes = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/skill-pack/policy",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned_checksum: "sha-snake-case" }),
      },
      snakeCaseChecksumRes
    );
    assert.equal(snakeCaseChecksumRes.status, 200);
    const snakeCaseChecksumBody = JSON.parse(snakeCaseChecksumRes.body);
    assert.equal(snakeCaseChecksumBody?.ok, true);
    assert.equal(snakeCaseChecksumBody?.data?.policy?.pinnedChecksum, "sha-snake-case");
  } finally {
    if (prevOpenclawHome == null) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = prevOpenclawHome;
    }
  }
});

test("Agent suite runtime settings endpoints proxy read/write", async () => {
  const openclawHome = mkdtempSync(join(tmpdir(), "orgx-openclaw-runtime-settings-http-"));
  const prevOpenclawHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = openclawHome;

  try {
    const config = baseConfig();
    let patchPayload = null;
    const client = {
      getBaseUrl: () => config.baseUrl,
      getClientAgentRuntimeSettings: async () => ({
        ok: true,
        project_id: "proj_test",
        agents: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            name: "OrgX Engineering",
            type: "workflow_optimizer",
            status: "active",
            model: "gpt-5.1",
            runtime_settings: {
              decision_v2_enabled: true,
              decision_dedupe_enabled: true,
              decision_evidence_required_for_blocking: false,
              decision_auto_resolve_guarded_enabled: true,
              custom_run_instructions: "Keep diffs minimal.",
            },
          },
        ],
      }),
      updateClientAgentRuntimeSettings: async (input) => {
        patchPayload = input;
        return {
          ok: true,
          project_id: input.project_id ?? "proj_test",
          agent: {
            id: input.agent_id,
            name: "OrgX Engineering",
            type: "workflow_optimizer",
            status: "active",
            model: "gpt-5.1",
            runtime_settings: input.runtime_settings,
          },
        };
      },
    };
    const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

    const getRes = createStubResponse();
    await handler(
      { method: "GET", url: "/orgx/api/agent-suite/runtime-settings", headers: {} },
      getRes
    );
    assert.equal(getRes.status, 200);
    const getBody = JSON.parse(getRes.body);
    assert.equal(getBody?.ok, true);
    assert.equal(getBody?.data?.project_id, "proj_test");
    assert.equal(getBody?.data?.agents?.length, 1);
    assert.equal(
      getBody?.data?.agents?.[0]?.runtime_settings?.decision_v2_enabled,
      true
    );

    const patchRes = createStubResponse();
    await handler(
      {
        method: "PATCH",
        url: "/orgx/api/agent-suite/runtime-settings",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: "proj_test",
          agent_id: "11111111-1111-1111-1111-111111111111",
          runtime_settings: {
            decision_v2_enabled: false,
            decision_dedupe_enabled: true,
            decision_evidence_required_for_blocking: true,
            decision_auto_resolve_guarded_enabled: false,
            custom_run_instructions: "Always include verification output.",
          },
        }),
      },
      patchRes
    );
    assert.equal(patchRes.status, 200);
    const patchBody = JSON.parse(patchRes.body);
    assert.equal(patchBody?.ok, true);
    assert.equal(
      patchBody?.data?.agent?.runtime_settings?.decision_evidence_required_for_blocking,
      true
    );
    assert.deepEqual(patchPayload, {
      project_id: "proj_test",
      agent_id: "11111111-1111-1111-1111-111111111111",
      runtime_settings: {
        decision_v2_enabled: false,
        decision_dedupe_enabled: true,
        decision_evidence_required_for_blocking: true,
        decision_auto_resolve_guarded_enabled: false,
        custom_run_instructions: "Always include verification output.",
      },
    });
  } finally {
    if (prevOpenclawHome == null) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = prevOpenclawHome;
    }
  }
});
