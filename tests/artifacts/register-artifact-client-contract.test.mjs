import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  registerArtifact,
  validateRegisterArtifactInput,
} from "../../dist/artifacts/register-artifact.js";

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
  assert.equal(
    result.warnings.some((warning) =>
      warning.includes("falling back to legacy entities route")
    ),
    false
  );

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

test("registerArtifact uses the durable source URL when legacy create response omits artifact_url", async () => {
  const artifactId = "10101010-1010-4010-8010-101010101010";
  const entityId = "20202020-2020-4020-8020-202020202020";
  const baseUrl = "https://www.useorgx.com";
  const updateCalls = [];

  const client = {
    getUserId: () => "",
    rawRequest: async (method, path) => {
      if (method === "POST" && path === "/api/client/artifacts") {
        throw new Error("404 Not Found");
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
    createEntity: async () => ({ id: artifactId }),
    updateEntity: async (_type, id, payload) => {
      updateCalls.push({ id, payload });
      return { ok: true };
    },
  };

  const result = await registerArtifact(client, baseUrl, {
    entity_type: "initiative",
    entity_id: entityId,
    name: "Legacy durable proof",
    artifact_type: "shared.project_handbook",
    external_url: "https://github.com/useorgx/orgx/pull/509",
  });

  assert.equal(result.ok, true);
  assert.equal(result.artifact_url, "https://github.com/useorgx/orgx/pull/509");
  assert.equal(updateCalls.length, 1);
  assert.equal(
    updateCalls[0].payload.artifact_url,
    "https://github.com/useorgx/orgx/pull/509"
  );
});

test("registerArtifact rejects OrgX wrapper URLs as proof sources", async () => {
  const errors = validateRegisterArtifactInput({
    entity_type: "initiative",
    entity_id: "22222222-2222-4222-8222-222222222222",
    name: "Wrapper proof",
    artifact_type: "shared.project_handbook",
    external_url: "https://useorgx.com/live/16aaaf48-bc33-489d-bf4d-c25ea80cd8b9",
  });

  assert.ok(
    errors.includes("external_url cannot be an OrgX live/artifact wrapper page")
  );

  const client = {
    getUserId: () => "",
    rawRequest: async () => {
      throw new Error("rawRequest should not be called");
    },
    createEntity: async () => {
      throw new Error("createEntity should not be called");
    },
    updateEntity: async () => {
      throw new Error("updateEntity should not be called");
    },
  };

  const result = await registerArtifact(client, "https://www.useorgx.com", {
    entity_type: "initiative",
    entity_id: "22222222-2222-4222-8222-222222222222",
    name: "Wrapper proof",
    artifact_type: "shared.project_handbook",
    external_url: "https://useorgx.com/live/16aaaf48-bc33-489d-bf4d-c25ea80cd8b9",
  });

  assert.equal(result.ok, false);
  assert.match(
    result.persistence.last_error ?? "",
    /cannot be an OrgX live\/artifact wrapper page/i
  );
});

test("registerArtifact canonicalizes absolute file paths to filesystem-open URLs", async (t) => {
  const artifactId = "30303030-3030-4030-8030-303030303030";
  const entityId = "40404040-4040-4040-8040-404040404040";
  const baseUrl = "https://www.useorgx.com";
  const calls = [];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orgx-artifact-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const proofPath = path.join(tempDir, "proof.md");
  await writeFile(proofPath, "# Proof\n", "utf8");

  const client = {
    getUserId: () => "",
    rawRequest: async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/api/client/artifacts") {
        return {
          ok: true,
          artifact: {
            id: artifactId,
            artifact_url: body.artifact_url,
            entity_type: "initiative",
            entity_id: entityId,
          },
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
    name: "Filesystem proof",
    artifact_type: "shared.project_handbook",
    external_url: proofPath,
  });

  const createCall = calls.find((call) => call.method === "POST");
  assert.ok(createCall);
  assert.equal(
    createCall.body.artifact_url,
    `${baseUrl}/orgx/api/live/filesystem/open?path=${encodeURIComponent(proofPath)}`
  );
  assert.equal(createCall.body.metadata.external_url, proofPath);
  assert.equal(createCall.body.metadata.local_source_path, proofPath);
  assert.equal(createCall.body.metadata.file_path, proofPath);
  assert.equal(
    result.artifact_url,
    `${baseUrl}/orgx/api/live/filesystem/open?path=${encodeURIComponent(proofPath)}`
  );
});

test("registerArtifact sends confidence_score via metadata for client contract compatibility", async () => {
  const artifactId = "66666666-6666-4666-8666-666666666666";
  const entityId = "77777777-7777-4777-8777-777777777777";
  const baseUrl = "https://www.useorgx.com";
  const calls = [];

  const client = {
    getUserId: () => "",
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
    name: "Confidence Metadata Contract",
    artifact_type: "shared.project_handbook",
    description: "Ensure client contract remains compatible with confidence metadata.",
    confidence_score: 0.67,
    external_url: "https://example.com/artifacts/confidence",
    validate_persistence: true,
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.warnings.some((warning) =>
      warning.includes("falling back to legacy entities route")
    ),
    false
  );

  const createCall = calls.find((call) => call.method === "POST" && call.path === "/api/client/artifacts");
  assert.ok(createCall);
  assert.equal(createCall.body.confidence_score, undefined);
  assert.equal(createCall.body.metadata.confidence_score, 0.67);
});

test("registerArtifact keeps initiative context in metadata and off the top-level artifact payload", async () => {
  const artifactId = "12121212-1212-4212-8212-121212121212";
  const entityId = "34343434-3434-4434-8434-343434343434";
  const baseUrl = "https://www.useorgx.com";
  const calls = [];

  const client = {
    getUserId: () => "",
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
    name: "Initiative Scoped Artifact",
    artifact_type: "shared.project_handbook",
    description: "Ensure initiative scope stays in metadata only.",
    external_url: "https://example.com/artifacts/init-scope",
    metadata: {
      initiative_id: entityId,
      workstream_id: "ws-1",
    },
  });

  assert.equal(result.ok, true);
  const createCall = calls.find((call) => call.method === "POST" && call.path === "/api/client/artifacts");
  assert.ok(createCall);
  assert.equal(Object.hasOwn(createCall.body, "initiative_id"), false);
  assert.equal(createCall.body.metadata.initiative_id, entityId);
  assert.equal(createCall.body.metadata.workstream_id, "ws-1");
});

test("validateRegisterArtifactInput rejects unknown entity_type values", () => {
  const errors = validateRegisterArtifactInput({
    entity_type: "artifact",
    entity_id: "77777777-7777-4777-8777-777777777777",
    name: "Invalid Entity Type",
    artifact_type: "shared.project_handbook",
    external_url: "https://example.com/invalid",
  });

  assert.ok(errors.includes("entity_type must be one of: initiative, workstream, milestone, task, decision, project"));
});

test("validateRegisterArtifactInput accepts an explicitly unknown confidence score", () => {
  const errors = validateRegisterArtifactInput({
    entity_type: "task",
    entity_id: "task-1",
    name: "Artifact",
    artifact_type: "document",
    external_url: "/tmp/artifact.md",
    confidence_score: null,
  });

  assert.deepEqual(errors, []);
});

// --- Proof Ladder metadata injection tests ---

test("registerArtifact injects atomic_unit_type from artifact_type normalization", async () => {
  const artifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const entityId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const baseUrl = "https://www.useorgx.com";
  const calls = [];

  const client = {
    getUserId: () => "",
    rawRequest: async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/api/client/artifacts") {
        return { ok: true, artifact: { id: artifactId } };
      }
      throw new Error(`Unexpected: ${method} ${path}`);
    },
    createEntity: async () => { throw new Error("should not be called"); },
    updateEntity: async () => { throw new Error("should not be called"); },
  };

  await registerArtifact(client, baseUrl, {
    entity_type: "task",
    entity_id: entityId,
    name: "Engineering Commit",
    artifact_type: "engineering.commit",
    external_url: "https://example.com/commit",
    metadata: { commit_sha: "abc123", branch: "main" },
  });

  const createCall = calls.find((c) => c.method === "POST");
  assert.ok(createCall);
  assert.equal(createCall.body.metadata.atomic_unit_type, "engineering.commit");
  assert.equal(createCall.body.metadata.schema_validated, true);
  assert.ok(typeof createCall.body.metadata.artifact_hash === "string");
  assert.ok(createCall.body.metadata.artifact_hash.length > 0);
});

test("registerArtifact sets schema_validated false when required fields are missing", async () => {
  const artifactId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const entityId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const baseUrl = "https://www.useorgx.com";
  const calls = [];

  const client = {
    getUserId: () => "",
    rawRequest: async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/api/client/artifacts") {
        return { ok: true, artifact: { id: artifactId } };
      }
      throw new Error(`Unexpected: ${method} ${path}`);
    },
    createEntity: async () => { throw new Error("should not be called"); },
    updateEntity: async () => { throw new Error("should not be called"); },
  };

  const result = await registerArtifact(client, baseUrl, {
    entity_type: "task",
    entity_id: entityId,
    name: "Missing Commit SHA",
    artifact_type: "engineering.commit",
    external_url: "https://example.com/commit",
    metadata: { branch: "main" }, // missing commit_sha
  });

  assert.equal(result.ok, true);
  const createCall = calls.find((c) => c.method === "POST");
  assert.ok(createCall);
  assert.equal(createCall.body.metadata.schema_validated, false);
  assert.ok(result.warnings.some((w) => w.includes("commit_sha")));
});

test("registerArtifact injects queue_ref and run_ref from environment", async () => {
  const artifactId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const entityId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const baseUrl = "https://www.useorgx.com";
  const calls = [];

  const prevEnv = {
    ORGX_INITIATIVE_ID: process.env.ORGX_INITIATIVE_ID,
    ORGX_WORKSTREAM_ID: process.env.ORGX_WORKSTREAM_ID,
    ORGX_TASK_ID: process.env.ORGX_TASK_ID,
    ORGX_RUN_ID: process.env.ORGX_RUN_ID,
    ORGX_CORRELATION_ID: process.env.ORGX_CORRELATION_ID,
  };

  try {
    process.env.ORGX_INITIATIVE_ID = "init-proof";
    process.env.ORGX_WORKSTREAM_ID = "ws-proof";
    process.env.ORGX_TASK_ID = "task-proof";
    process.env.ORGX_RUN_ID = "run-proof";
    process.env.ORGX_CORRELATION_ID = "corr-proof";

    const client = {
      getUserId: () => "",
      rawRequest: async (method, path, body) => {
        calls.push({ method, path, body });
        if (method === "POST" && path === "/api/client/artifacts") {
          return { ok: true, artifact: { id: artifactId } };
        }
        throw new Error(`Unexpected: ${method} ${path}`);
      },
      createEntity: async () => { throw new Error("should not be called"); },
      updateEntity: async () => { throw new Error("should not be called"); },
    };

    await registerArtifact(client, baseUrl, {
      entity_type: "task",
      entity_id: entityId,
      name: "Proof Refs Test",
      artifact_type: "product.spec",
      external_url: "https://example.com/spec",
      metadata: { acceptance_criteria: ["AC1"], success_metric: "metric1" },
    });

    const createCall = calls.find((c) => c.method === "POST");
    assert.ok(createCall);
    const meta = createCall.body.metadata;
    assert.deepEqual(meta.queue_ref, {
      initiative_id: "init-proof",
      workstream_id: "ws-proof",
      task_id: "task-proof",
    });
    assert.deepEqual(meta.run_ref, {
      run_id: "run-proof",
      correlation_id: "corr-proof",
    });
  } finally {
    for (const [key, val] of Object.entries(prevEnv)) {
      if (val == null) delete process.env[key];
      else process.env[key] = val;
    }
  }
});
