#!/usr/bin/env node
/**
 * Real OrgX e2e verifier for artifact loop closure across all supported entity types.
 *
 * Safety:
 * - Requires ORGX_E2E_ALLOW_WRITE=1 (this script performs writes).
 *
 * Auth:
 * - Uses ORGX_E2E_API_KEY if provided, otherwise attempts to read persisted auth.json.
 *
 * Required env:
 * - ORGX_E2E_PROJECT_ID
 * - ORGX_E2E_INITIATIVE_ID
 * - ORGX_E2E_MILESTONE_ID
 * - ORGX_E2E_TASK_ID
 * - ORGX_E2E_DECISION_ID
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

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (process.env.ORGX_E2E_ALLOW_WRITE !== "1") {
    throw new Error("Refusing to write: set ORGX_E2E_ALLOW_WRITE=1 to run this verifier.");
  }

  const apiKey = resolveApiKey();
  const baseUrl = (process.env.ORGX_E2E_BASE_URL || "https://www.useorgx.com").trim();
  const artifactType = (process.env.ORGX_E2E_ARTIFACT_TYPE || "shared.project_handbook").trim();

  const targets = [
    { entity_type: "project", entity_id: requiredEnv("ORGX_E2E_PROJECT_ID") },
    { entity_type: "initiative", entity_id: requiredEnv("ORGX_E2E_INITIATIVE_ID") },
    { entity_type: "milestone", entity_id: requiredEnv("ORGX_E2E_MILESTONE_ID") },
    { entity_type: "task", entity_id: requiredEnv("ORGX_E2E_TASK_ID") },
    { entity_type: "decision", entity_id: requiredEnv("ORGX_E2E_DECISION_ID") },
  ];

  const client = new OrgXClient(apiKey, baseUrl, process.env.ORGX_E2E_USER_ID || "");

  const stamp = new Date().toISOString();
  const results = [];

  for (const target of targets) {
    const runStamp = new Date().toISOString();
    try {
      const result = await registerArtifact(client, baseUrl, {
        entity_type: target.entity_type,
        entity_id: target.entity_id,
        name: `Artifact Loop E2E Matrix (${target.entity_type}) (${runStamp})`,
        artifact_type: artifactType,
        description: "Real e2e write + read-after-write validation for artifact loop closure.",
        preview_markdown: `Created at ${runStamp}\nEntity: ${target.entity_type}/${target.entity_id}\nRun: ${stamp}`,
        external_url: null,
        status: "draft",
        metadata: { source: "verify-matrix", e2e: true, run: stamp, entity_type: target.entity_type },
        validate_persistence: true,
      });

      const line = [
        target.entity_type.padEnd(9),
        `ok=${String(result.ok).padEnd(5)}`,
        `created=${String(result.created).padEnd(5)}`,
        `detail=${String(result.persistence?.artifact_detail_ok).padEnd(5)}`,
        `linked=${String(result.persistence?.linked_ok).padEnd(5)}`,
        `id=${result.artifact_id || "null"}`,
      ].join(" ");
      process.stdout.write(`${line}\n`);

      results.push({ target, result });
      if (!result.ok || !result.persistence?.artifact_detail_ok || !result.persistence?.linked_ok) {
        process.exitCode = 1;
      }
    } catch (err) {
      process.stdout.write(
        `${target.entity_type.padEnd(9)} ok=false created=false detail=false linked=false error=${String(
          err?.message || err
        )}\n`
      );
      results.push({ target, error: String(err?.stack || err?.message || err) });
      process.exitCode = 1;
    }

    await sleep(250);
  }

  process.stdout.write(`${JSON.stringify({ baseUrl, stamp, results }, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
  process.exitCode = 1;
});

