import test from "node:test";
import assert from "node:assert/strict";

import { registerCoreTools } from "../../dist/tools/core-tools.js";

const INITIATIVE_ID = "11111111-1111-4111-8111-111111111111";
const WORKSTREAM_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const ARTIFACT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function createDeps(overrides = {}) {
  const requests = [];

  const deps = {
    registerTool: () => {},
    client: {
      getBaseUrl: () => "https://www.useorgx.com",
      rawRequest: async (method, path, body) => {
        requests.push({ method, path, body });

        if (method === "POST" && path === "/api/client/artifacts") {
          return {
            artifact: {
              id: body.artifact_id,
              artifact_url: body.artifact_url,
              entity_type: body.entity_type,
              entity_id: body.entity_id,
            },
          };
        }

        if (method === "GET" && path === `/api/client/artifacts/${ARTIFACT_ID}`) {
          return { artifact: { id: ARTIFACT_ID } };
        }

        if (method === "GET" && path.startsWith("/api/client/artifacts/by-entity?")) {
          return {
            artifacts: [
              {
                id: ARTIFACT_ID,
                entity_type: "task",
                entity_id: TASK_ID,
              },
            ],
          };
        }

        throw new Error(`Unexpected request: ${method} ${path}`);
      },
      createEntity: async () => {
        throw new Error("legacy artifact create should not be used");
      },
      updateEntity: async () => ({}),
      updateEntityDetailed: async () => ({ entity: {} }),
      listEntities: async () => ({ data: [] }),
      emitActivity: async () => ({}),
      applyChangeset: async () => ({ applied_count: 1, replayed: false, run_id: "run" }),
    },
    config: { syncIntervalMs: 10_000, pluginVersion: "test" },
    getCachedSnapshot: () => null,
    getLastSnapshotAt: () => 0,
    doSync: async () => {},
    text: (value) => ({ content: [{ type: "text", text: value }] }),
    json: (label, data) => ({ content: [{ type: "text", text: `${label}\n${JSON.stringify(data)}` }] }),
    formatSnapshot: () => "snapshot",
    autoAssignEntityForCreate: async () => ({ assignmentSource: "manual", assignedAgents: [], warnings: [] }),
    toReportingPhase: () => "execution",
    inferReportingInitiativeId: () => undefined,
    isUuid: (value) =>
      typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
    pickNonEmptyString: (...values) => {
      for (const value of values) {
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      return undefined;
    },
    resolveReportingContext: () => ({ ok: false, error: "unused" }),
    readSkillPackState: () => ({}),
    randomUUID: () => ARTIFACT_ID,
    ...overrides,
  };

  return { deps, requests };
}

test("orgx_register_artifact exposes proof metadata fields in a strict schema", () => {
  const { deps } = createDeps();
  const tool = registerCoreTools(deps).get("orgx_register_artifact");

  assert.ok(tool, "expected orgx_register_artifact to be registered");
  assert.equal(tool.parameters.type, "object");
  assert.equal(tool.parameters.additionalProperties, false);
  assert.ok(tool.parameters.properties.metadata, "metadata should be accepted");
  assert.ok(tool.parameters.properties.queue_ref, "queue_ref should be accepted");
  assert.ok(tool.parameters.properties.run_ref, "run_ref should be accepted");
  assert.equal(tool.parameters.properties.queue_ref.additionalProperties, false);
  assert.equal(tool.parameters.properties.run_ref.additionalProperties, false);
});

test("orgx_register_artifact forwards caller proof metadata to durable artifacts", async () => {
  const { deps, requests } = createDeps();
  const tool = registerCoreTools(deps).get("orgx_register_artifact");

  const result = await tool.execute("call-register-artifact", {
    entity_type: "task",
    entity_id: TASK_ID,
    name: "Public live data exposure hardening",
    artifact_type: "engineering.commit",
    confidence_score: 1,
    description: "Commit and verification proof for public /live sanitization hardening.",
    url: "https://github.com/hopeatina/orgx/commit/a329648b",
    content: "Verified with focused Vitest suites, typecheck, and git diff --check.",
    metadata: {
      commit_sha: "a329648b",
      branch: "codex/content-queue-live",
      repo: "hopeatina/orgx",
      quality_gate: "passed",
    },
    queue_ref: {
      initiative_id: INITIATIVE_ID,
      workstream_id: WORKSTREAM_ID,
      task_id: TASK_ID,
    },
    run_ref: {
      correlation_id: "audit-public-live-data-exposure-a329648b",
    },
  });

  assert.match(result.content[0].text, /Artifact registered: Public live data exposure hardening/);

  const createRequest = requests.find(
    (request) => request.method === "POST" && request.path === "/api/client/artifacts"
  );
  assert.ok(createRequest, "expected canonical artifact create request");

  assert.equal(createRequest.body.entity_type, "task");
  assert.equal(createRequest.body.entity_id, TASK_ID);
  assert.equal(createRequest.body.artifact_id, ARTIFACT_ID);
  assert.equal(createRequest.body.artifact_type, "engineering.commit");
  assert.equal(createRequest.body.metadata.commit_sha, "a329648b");
  assert.equal(createRequest.body.metadata.branch, "codex/content-queue-live");
  assert.equal(createRequest.body.metadata.repo, "hopeatina/orgx");
  assert.equal(createRequest.body.metadata.quality_gate, "passed");
  assert.equal(createRequest.body.metadata.source, "orgx_register_artifact");
  assert.equal(createRequest.body.metadata.artifact_id, ARTIFACT_ID);
  assert.equal(createRequest.body.metadata.confidence_score, 1);
  assert.deepEqual(createRequest.body.metadata.queue_ref, {
    initiative_id: INITIATIVE_ID,
    workstream_id: WORKSTREAM_ID,
    task_id: TASK_ID,
  });
  assert.deepEqual(createRequest.body.metadata.run_ref, {
    correlation_id: "audit-public-live-data-exposure-a329648b",
  });
  assert.ok(createRequest.body.metadata.artifact_hash, "expected artifact hash to be generated");
});
