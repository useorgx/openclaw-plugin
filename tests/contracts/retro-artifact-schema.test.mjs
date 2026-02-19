import test from "node:test";
import assert from "node:assert/strict";

async function importFreshModule(modulePath) {
  const url = new URL(modulePath, import.meta.url);
  url.searchParams.set("cacheBust", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("retro schema exports stable versioned contract", async () => {
  const {
    RETRO_ARTIFACT_SCHEMA_VERSION,
    RETRO_ARTIFACT_JSON_SCHEMA,
  } = await importFreshModule("../../dist/contracts/retro-schema.js");

  assert.equal(RETRO_ARTIFACT_SCHEMA_VERSION, "retro.v1");
  assert.equal(RETRO_ARTIFACT_JSON_SCHEMA.type, "object");
  assert.equal(RETRO_ARTIFACT_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(RETRO_ARTIFACT_JSON_SCHEMA.required, [
    "schema_version",
    "summary",
  ]);
  assert.equal(
    RETRO_ARTIFACT_JSON_SCHEMA.properties.schema_version.const,
    RETRO_ARTIFACT_SCHEMA_VERSION
  );
  assert.equal(
    RETRO_ARTIFACT_JSON_SCHEMA.properties.follow_ups.items.additionalProperties,
    false
  );
});
