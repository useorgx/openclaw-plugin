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

test("e2e: registerArtifact persists and links to entity (real OrgX)", { timeout: 60_000 }, async (t) => {
  if (!isEnabled()) {
    t.skip("Set ORGX_E2E=1 and ORGX_E2E_ALLOW_WRITE=1 to run real OrgX e2e.");
    return;
  }

  const apiKey = resolveApiKey();
  const baseUrl = (process.env.ORGX_E2E_BASE_URL || "https://www.useorgx.com").trim();
  const entityType = requiredEnv("ORGX_E2E_ENTITY_TYPE");
  const entityId = requiredEnv("ORGX_E2E_ENTITY_ID");
  const artifactType = (process.env.ORGX_E2E_ARTIFACT_TYPE || "shared.project_handbook").trim();

  const client = new OrgXClient(apiKey, baseUrl, process.env.ORGX_E2E_USER_ID || "");

  const runStamp = new Date().toISOString();
  const result = await registerArtifact(client, baseUrl, {
    entity_type: entityType,
    entity_id: entityId,
    name: `E2E Artifact Persistence (${runStamp})`,
    artifact_type: artifactType,
    description: "Automated e2e write + read-after-write validation for artifact loop closure.",
    external_url: null,
    preview_markdown: `Created by plugin e2e at ${runStamp}\n\nEntity: ${entityType}/${entityId}`,
    status: "draft",
    metadata: {
      source: "e2e",
      e2e: true,
      created_at: runStamp,
    },
    validate_persistence: true,
  });

  assert.equal(result.ok, true);
  assert.ok(result.artifact_id);
  assert.ok(result.artifact_url);
  assert.equal(result.persistence.checked, true);
  assert.equal(result.persistence.artifact_detail_ok, true);
  assert.equal(result.persistence.linked_ok, true);
});
