import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureAutopilotSliceSchemaPath } from "../../dist/http/helpers/autopilot-slice-utils.js";

function withEnv(patch, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = String(v);
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

test("autopilot slice schema is strict-format compatible for codex output-schema", async () => {
  const root = mkdtempSync(join(tmpdir(), "orgx-autopilot-schema-"));
  const pluginConfigDir = join(root, "plugin-config");
  mkdirSync(pluginConfigDir, { recursive: true });

  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: pluginConfigDir,
    },
    async () => {
      const schemaPath = ensureAutopilotSliceSchemaPath("autopilot-slice-schema.json");
      const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

      const topKeys = Object.keys(schema.properties ?? {});
      assert.deepEqual(
        [...(schema.required ?? [])].sort(),
        topKeys.sort(),
        "top-level required keys should include every property"
      );

      const artifactItem = schema.properties?.artifacts?.items;
      const artifactKeys = Object.keys(artifactItem?.properties ?? {});
      assert.deepEqual(
        [...(artifactItem?.required ?? [])].sort(),
        artifactKeys.sort(),
        "artifact object required keys should include every property"
      );
      assert.ok(
        (artifactItem?.required ?? []).includes("description"),
        "artifact.description should be required (nullable)"
      );
      assert.deepEqual(
        artifactItem?.properties?.confidence_score,
        { type: ["number", "null"], minimum: 0, maximum: 1 },
        "artifact.confidence_score should be constrained to [0,1] (nullable)"
      );

      const decisionItem = schema.properties?.decisions_needed?.items;
      assert.equal(
        decisionItem?.properties?.blocking?.type,
        "boolean",
        "decisions_needed[].blocking should require explicit boolean"
      );

      const taskStatusEnum = schema.properties?.task_updates?.items?.properties?.status?.enum ?? [];
      assert.deepEqual(
        taskStatusEnum,
        ["todo", "in_progress", "done", "blocked"],
        "task_updates[].status should be constrained to allowed statuses"
      );

      const milestoneStatusEnum =
        schema.properties?.milestone_updates?.items?.properties?.status?.enum ?? [];
      assert.deepEqual(
        milestoneStatusEnum,
        ["planned", "in_progress", "completed", "at_risk", "cancelled"],
        "milestone_updates[].status should be constrained to allowed statuses"
      );

      assert.equal(
        Array.isArray(schema.allOf),
        false,
        "schema should avoid allOf to remain codex response-format compatible"
      );
    }
  );
});

test("autopilot slice schema rewrites stale schema files", async () => {
  const root = mkdtempSync(join(tmpdir(), "orgx-autopilot-schema-refresh-"));
  const pluginConfigDir = join(root, "plugin-config");
  mkdirSync(pluginConfigDir, { recursive: true });
  const stalePath = join(pluginConfigDir, "autopilot-slice-schema.json");
  writeFileSync(
    stalePath,
    JSON.stringify(
      {
        type: "object",
        additionalProperties: false,
        required: ["status", "summary", "workstream_id"],
        properties: {
          status: { type: "string" },
          summary: { type: "string" },
          workstream_id: { type: "string" },
          artifacts: {
            type: ["array", "null"],
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "artifact_type"],
              properties: {
                name: { type: "string" },
                artifact_type: { type: "string" },
                description: { type: ["string", "null"] },
              },
            },
          },
        },
      },
      null,
      2
    ),
    "utf8"
  );

  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: pluginConfigDir,
    },
    async () => {
      const schemaPath = ensureAutopilotSliceSchemaPath("autopilot-slice-schema.json");
      assert.equal(schemaPath, stalePath);
      const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
      const artifactRequired = schema.properties?.artifacts?.items?.required ?? [];
      assert.ok(
        artifactRequired.includes("description"),
        "stale schema should be replaced with strict required keys"
      );
      assert.ok(
        (schema.required ?? []).includes("task_updates"),
        "stale top-level required list should be replaced"
      );
    }
  );
});
