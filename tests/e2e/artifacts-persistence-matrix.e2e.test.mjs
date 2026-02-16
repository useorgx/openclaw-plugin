import test from "node:test";
import assert from "node:assert/strict";

import { OrgXClient } from "../../dist/api.js";
import { getAuthFilePath, readPersistedAuth } from "../../dist/auth-store.js";
import { registerArtifact } from "../../dist/artifacts/register-artifact.js";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return String(value).trim();
}

function resolveApiKey() {
  const fromEnv = (process.env.ORGX_E2E_API_KEY || "").trim();
  if (fromEnv) return fromEnv;

  const persisted = readPersistedAuth();
  const fromStore = (persisted?.apiKey || "").trim();
  if (fromStore) return fromStore;

  throw new Error(
    `Missing ORGX_E2E_API_KEY and no persisted auth found at ${getAuthFilePath()}`
  );
}

function isEnabled() {
  return process.env.ORGX_E2E === "1" && process.env.ORGX_E2E_ALLOW_WRITE === "1";
}

async function runOne(client, baseUrl, { entity_type, entity_id, artifact_type }) {
  const stamp = new Date().toISOString();
  const result = await registerArtifact(client, baseUrl, {
    entity_type,
    entity_id,
    name: `E2E Artifact Persistence Matrix (${entity_type}) (${stamp})`,
    artifact_type,
    description: "Automated e2e matrix write + read-after-write validation for artifact loop closure.",
    external_url: null,
    preview_markdown: `Created by plugin e2e matrix at ${stamp}\n\nEntity: ${entity_type}/${entity_id}`,
    status: "draft",
    metadata: { source: "e2e-matrix", e2e: true, stamp, entity_type },
    validate_persistence: true,
  });

  assert.equal(result.ok, true);
  assert.ok(result.artifact_id);
  assert.ok(result.artifact_url);
  assert.equal(result.persistence.checked, true);
  assert.equal(result.persistence.artifact_detail_ok, true);
  assert.equal(result.persistence.linked_ok, true);
}

for (const [entity_type, envName] of [
  ["project", "ORGX_E2E_PROJECT_ID"],
  ["initiative", "ORGX_E2E_INITIATIVE_ID"],
  ["milestone", "ORGX_E2E_MILESTONE_ID"],
  ["task", "ORGX_E2E_TASK_ID"],
  ["decision", "ORGX_E2E_DECISION_ID"],
]) {
  test(`e2e: registerArtifact persists and links (${entity_type})`, { timeout: 60_000 }, async (t) => {
    if (!isEnabled()) {
      t.skip("Set ORGX_E2E=1 and ORGX_E2E_ALLOW_WRITE=1 to run real OrgX e2e.");
      return;
    }

    const apiKey = resolveApiKey();
    const baseUrl = (process.env.ORGX_E2E_BASE_URL || "https://www.useorgx.com").trim();
    const artifactType = (process.env.ORGX_E2E_ARTIFACT_TYPE || "shared.project_handbook").trim();
    const entityId = requiredEnv(envName);

    const client = new OrgXClient(apiKey, baseUrl, process.env.ORGX_E2E_USER_ID || "");
    await runOne(client, baseUrl, { entity_type, entity_id: entityId, artifact_type: artifactType });
  });
}

