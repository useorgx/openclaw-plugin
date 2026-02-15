#!/usr/bin/env node
/**
 * Real OrgX e2e verifier for artifact loop closure.
 *
 * Required env:
 * - ORGX_E2E_API_KEY
 * - ORGX_E2E_ENTITY_TYPE (initiative|milestone|task|decision|project)
 * - ORGX_E2E_ENTITY_ID (uuid)
 *
 * Optional:
 * - ORGX_E2E_BASE_URL (default https://www.useorgx.com)
 * - ORGX_E2E_USER_ID
 * - ORGX_E2E_ARTIFACT_TYPE (default shared.project_handbook)
 */

import { OrgXClient } from "../dist/api.js";
import { getAuthFilePath, readPersistedAuth } from "../dist/auth-store.js";
import { registerArtifact } from "../dist/artifacts/register-artifact.js";

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

async function main() {
  if (process.env.ORGX_E2E_ALLOW_WRITE !== "1") {
    throw new Error("Refusing to write: set ORGX_E2E_ALLOW_WRITE=1 to run this verifier.");
  }

  const apiKey = resolveApiKey();
  const baseUrl = (process.env.ORGX_E2E_BASE_URL || "https://www.useorgx.com").trim();
  const entityType = requiredEnv("ORGX_E2E_ENTITY_TYPE");
  const entityId = requiredEnv("ORGX_E2E_ENTITY_ID");
  const artifactType = (process.env.ORGX_E2E_ARTIFACT_TYPE || "shared.project_handbook").trim();

  const client = new OrgXClient(apiKey, baseUrl, process.env.ORGX_E2E_USER_ID || "");

  const stamp = new Date().toISOString();
  const result = await registerArtifact(client, baseUrl, {
    entity_type: entityType,
    entity_id: entityId,
    name: `Artifact Loop E2E (${stamp})`,
    artifact_type: artifactType,
    description: "Manual e2e verifier for artifact registration + persistence checks.",
    preview_markdown: `Created at ${stamp}\nEntity: ${entityType}/${entityId}`,
    external_url: null,
    status: "draft",
    metadata: { source: "verify-script", e2e: true, stamp },
    validate_persistence: true,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok || !result.persistence.artifact_detail_ok || !result.persistence.linked_ok) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
  process.exitCode = 1;
});
