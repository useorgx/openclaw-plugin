import test from "node:test";
import assert from "node:assert/strict";

import { registerArtifact } from "../../dist/artifacts/register-artifact.js";

test("registerArtifact uses /api/client/artifacts contract and validates persistence", async () => {
  const artifactId = "11111111-1111-4111-8111-111111111111";
  const entityId = "22222222-2222-4222-8222-222222222222";
  const creatorId = "33333333-3333-4333-8333-333333333333";
  const baseUrl = "https://www.useorgx.com";
  const calls = [];

  const client = {
    getUserId: () => creatorId,
    rawRequest: async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/api/client/artifacts") {
        return {
          ok: true,
          artifact: {
            id: artifactId,
            artifact_url: `${baseUrl}/artifacts/${artifactId}`,
            entity_type: "initiative",
            entity_id: entityId,
          },
        };
      }
      if (method === "GET" && path === `/api/client/artifacts/${artifactId}`) {
        return {
          ok: true,
          artifact: {
            id: artifactId,
            entity_type: "initiative",
            entity_id: entityId,
          },
        };
      }
      if (method === "GET" && path.startsWith("/api/client/artifacts/by-entity?")) {
        return {
          ok: true,
          artifacts: [
            {
              id: artifactId,
              entity_type: "initiative",
              entity_id: entityId,
            },
          ],
        };
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
    createEntity: async () => {
      throw new Error("createEntity should not be called");
    },
    updateEntity: async () => {
      throw new Error("updateEntity should not be called");
    },
  };

  const result = await registerArtifact(client, baseUrl, {
    entity_type: "initiative",
    entity_id: entityId,
    name: "Artifact Loop Report",
    artifact_type: "shared.project_handbook",
    description: "Contract-path create and read-after-write validation.",
    external_url: "https://example.com/artifacts/report",
    validate_persistence: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.artifact_id, artifactId);
  assert.equal(result.created, true);
  assert.equal(result.persistence.checked, true);
  assert.equal(result.persistence.artifact_detail_ok, true);
  assert.equal(result.persistence.linked_ok, true);
  assert.equal(result.warnings.length, 0);

  const createCall = calls.find((call) => call.method === "POST");
  assert.ok(createCall);
  assert.equal(createCall.path, "/api/client/artifacts");
  assert.equal(createCall.body.created_by_id, creatorId);
});

test("registerArtifact falls back to legacy /api/entities path when client route is unavailable", async () => {
  const artifactId = "44444444-4444-4444-8444-444444444444";
  const entityId = "55555555-5555-4555-8555-555555555555";
  const baseUrl = "https://www.useorgx.com";
  const calls = [];
  let createEntityCalls = 0;
  let updateEntityCalls = 0;

  const client = {
    getUserId: () => "",
    rawRequest: async (method, path) => {
      calls.push({ method, path });
      if (method === "POST" && path === "/api/client/artifacts") {
        throw new Error("404 Not Found");
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
    createEntity: async (_type, payload) => {
      createEntityCalls += 1;
      return {
        id: artifactId,
        artifact_url: payload.artifact_url,
      };
    },
    updateEntity: async () => {
      updateEntityCalls += 1;
      return { ok: true };
    },
  };

  const result = await registerArtifact(client, baseUrl, {
    entity_type: "initiative",
    entity_id: entityId,
    name: "Legacy Fallback Artifact",
    artifact_type: "shared.project_handbook",
    description: "Fallback behavior check.",
    external_url: "https://example.com/artifacts/legacy",
    validate_persistence: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.artifact_id, artifactId);
  assert.equal(result.created, true);
  assert.equal(createEntityCalls, 1);
  assert.equal(updateEntityCalls, 1);
  assert.ok(
    result.warnings.some((warning) => warning.includes("falling back to legacy entities route"))
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/client/artifacts");
});
