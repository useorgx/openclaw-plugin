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
import { registerArtifact } from "../dist/artifacts/register-artifact.js";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return String(value).trim();
}

async function main() {
  const apiKey = requiredEnv("ORGX_E2E_API_KEY");
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

