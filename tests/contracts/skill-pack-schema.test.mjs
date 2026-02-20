import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OPENCLAW_SKILL_PACK_SCHEMA_VERSION,
  OPENCLAW_SKILL_PACK_MANIFEST_JSON_SCHEMA,
  validateOpenClawSkillPackManifest,
} from "../../dist/contracts/skill-pack-schema.js";
import {
  readSkillPackState,
  refreshSkillPackState,
  rollbackSkillPackPolicy,
  updateSkillPackPolicy,
} from "../../dist/skill-pack-state.js";

test("skill-pack schema exports strict oneOf shapes for known config variants", () => {
  assert.equal(OPENCLAW_SKILL_PACK_MANIFEST_JSON_SCHEMA.type, "object");
  assert.equal(OPENCLAW_SKILL_PACK_MANIFEST_JSON_SCHEMA.additionalProperties, true);
  assert.equal(Array.isArray(OPENCLAW_SKILL_PACK_MANIFEST_JSON_SCHEMA.oneOf), true);
  assert.equal(OPENCLAW_SKILL_PACK_MANIFEST_JSON_SCHEMA.oneOf.length, 3);
  for (const variant of OPENCLAW_SKILL_PACK_MANIFEST_JSON_SCHEMA.oneOf) {
    assert.equal(
      variant.properties.schema_version.const,
      OPENCLAW_SKILL_PACK_SCHEMA_VERSION
    );
  }
});

test("validateOpenClawSkillPackManifest accepts canonical config and trims values", () => {
  const result = validateOpenClawSkillPackManifest({
    schema_version: "openclaw-skill-pack.v1",
    openclaw_skills: {
      engineering: "  # engineering skill body  ",
      product: "# product skill body",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.configType, "openclaw_skills");
  assert.deepEqual(result.errors, []);
  assert.equal(result.openclaw_skills.engineering, "# engineering skill body");
  assert.equal(result.openclaw_skills.product, "# product skill body");
});

test("validateOpenClawSkillPackManifest rejects non-string schema_version", () => {
  const result = validateOpenClawSkillPackManifest({
    schema_version: 1,
    openclaw_skills: {
      engineering: "# engineering skill",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.configType, "openclaw_skills");
  assert.ok(
    result.errors.some((msg) => msg.includes("manifest.schema_version must be a string"))
  );
});

test("validateOpenClawSkillPackManifest rejects unknown domains and non-string values", () => {
  const result = validateOpenClawSkillPackManifest({
    openclawSkills: {
      engineering: "ok",
      unknown: "nope",
      sales: 42,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.configType, "openclawSkills");
  assert.equal(result.openclaw_skills.engineering, "ok");
  assert.ok(result.errors.some((msg) => msg.includes('unknown domain key "unknown"')));
  assert.ok(result.errors.some((msg) => msg.includes("must be a string")));
});

test("validateOpenClawSkillPackManifest rejects mismatched schema_version", () => {
  const result = validateOpenClawSkillPackManifest({
    schema_version: "openclaw-skill-pack.v0",
    openclaw_skills: {
      engineering: "ok",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.configType, "openclaw_skills");
  assert.ok(
    result.errors.some((msg) =>
      msg.includes('manifest.schema_version must equal "openclaw-skill-pack.v1"')
    )
  );
});

test("validateOpenClawSkillPackManifest rejects ambiguous config containers", () => {
  const result = validateOpenClawSkillPackManifest({
    openclaw_skills: {
      engineering: "canonical",
    },
    openclawSkills: {
      product: "duplicate",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.configType, "openclaw_skills");
  assert.equal(result.openclaw_skills.engineering, "canonical");
  assert.ok(
    result.errors.some((msg) =>
      msg.includes("manifest must define only one config container")
    )
  );
});

test("refreshSkillPackState blocks activation when manifest validation fails", async () => {
  const openclawDir = mkdtempSync(join(tmpdir(), "orgx-skill-pack-schema-"));
  mkdirSync(openclawDir, { recursive: true });

  const { state } = await refreshSkillPackState({
    openclawDir,
    getSkillPack: async () => ({
      ok: true,
      notModified: false,
      etag: "etag-1",
      pack: {
        name: "orgx-agent-suite",
        version: "1.0.0",
        checksum: "abc123",
        manifest: {
          eval_framework: {
            passed: true,
          },
          openclaw_skills: {
            engineering: "# valid override",
            invalid_domain: "# should fail",
          },
        },
      },
    }),
  });

  assert.equal(state.overrides, null);
  assert.equal(state.pack, null);
  assert.equal(state.remote?.checksum, "abc123");
  assert.ok(state.lastError?.includes("SkillPack manifest validation errors"));
  assert.ok(state.lastError?.includes("unknown domain key"));
});

test("refreshSkillPackState blocks activation when eval framework checks fail", async () => {
  const openclawDir = mkdtempSync(join(tmpdir(), "orgx-skill-pack-eval-gate-"));
  mkdirSync(openclawDir, { recursive: true });

  const { state } = await refreshSkillPackState({
    openclawDir,
    getSkillPack: async () => ({
      ok: true,
      notModified: false,
      etag: "etag-1",
      pack: {
        name: "orgx-agent-suite",
        version: "1.0.0",
        checksum: "abc123",
        manifest: {
          eval_framework: {
            passed: false,
          },
          openclaw_skills: {
            engineering: "# valid override",
          },
        },
      },
    }),
  });

  assert.equal(state.overrides, null);
  assert.equal(state.pack, null);
  assert.equal(state.remote?.checksum, "abc123");
  assert.match(state.lastError ?? "", /eval framework checks did not pass/i);
});

test("refreshSkillPackState activates when eval framework checks pass", async () => {
  const openclawDir = mkdtempSync(join(tmpdir(), "orgx-skill-pack-eval-pass-"));
  mkdirSync(openclawDir, { recursive: true });

  const { state, changed } = await refreshSkillPackState({
    openclawDir,
    getSkillPack: async () => ({
      ok: true,
      notModified: false,
      etag: "etag-2",
      pack: {
        name: "orgx-agent-suite",
        version: "1.1.0",
        checksum: "def456",
        manifest: {
          eval_framework: {
            status: "passed",
          },
          openclaw_skills: {
            engineering: "# valid override",
          },
        },
      },
    }),
  });

  assert.equal(changed, true);
  assert.equal(state.pack?.checksum, "def456");
  assert.equal(state.overrides?.openclaw_skills?.engineering, "# valid override");
  assert.equal(state.lastError, null);
});

test("updateSkillPackPolicy blocks pinToCurrent when staged remote failed eval checks", async () => {
  const openclawDir = mkdtempSync(join(tmpdir(), "orgx-skill-pack-policy-pin-current-block-"));
  mkdirSync(openclawDir, { recursive: true });

  await refreshSkillPackState({
    openclawDir,
    getSkillPack: async () => ({
      ok: true,
      notModified: false,
      etag: "etag-block-pin-current",
      pack: {
        name: "orgx-agent-suite",
        version: "1.2.0",
        checksum: "sha-bad-remote",
        manifest: {
          eval_framework: {
            passed: false,
          },
          openclaw_skills: {
            engineering: "# valid override",
          },
        },
      },
    }),
  });

  assert.throws(
    () =>
      updateSkillPackPolicy({
        openclawDir,
        pinToCurrent: true,
      }),
    /failed eval\/manifest checks/i
  );
});

test("updateSkillPackPolicy blocks pinning failed staged remote checksum", async () => {
  const openclawDir = mkdtempSync(join(tmpdir(), "orgx-skill-pack-policy-pin-remote-block-"));
  mkdirSync(openclawDir, { recursive: true });

  await refreshSkillPackState({
    openclawDir,
    getSkillPack: async () => ({
      ok: true,
      notModified: false,
      etag: "etag-block-pin-remote",
      pack: {
        name: "orgx-agent-suite",
        version: "1.2.0",
        checksum: "sha-bad-remote",
        manifest: {
          eval_framework: {
            status: "failed",
          },
          openclaw_skills: {
            engineering: "# valid override",
          },
        },
      },
    }),
  });

  assert.throws(
    () =>
      updateSkillPackPolicy({
        openclawDir,
        pinnedChecksum: "sha-bad-remote",
      }),
    /eval\/manifest checks are failing/i
  );
});

test("updateSkillPackPolicy records policy diff audit metadata", () => {
  const openclawDir = mkdtempSync(join(tmpdir(), "orgx-skill-pack-policy-audit-"));
  mkdirSync(openclawDir, { recursive: true });

  const updated = updateSkillPackPolicy({
    openclawDir,
    frozen: true,
    changedBy: "qa-user@useorgx.com",
    reason: "freeze for investigation",
  });

  assert.equal(updated.policy.frozen, true);
  assert.equal(updated.audit.entries.length, 1);
  const [entry] = updated.audit.entries;
  assert.equal(entry.action, "policy.update");
  assert.equal(entry.changedBy, "qa-user@useorgx.com");
  assert.equal(entry.reason, "freeze for investigation");
  assert.ok(
    entry.diff.some(
      (part) => part.field === "policy.frozen" && part.before === false && part.after === true
    )
  );
});

test("rollbackSkillPackPolicy restores prior policy and writes rollback audit record", () => {
  const openclawDir = mkdtempSync(join(tmpdir(), "orgx-skill-pack-policy-rollback-"));
  mkdirSync(openclawDir, { recursive: true });

  const updated = updateSkillPackPolicy({
    openclawDir,
    frozen: true,
    changedBy: "qa-user@useorgx.com",
    reason: "temporary freeze",
  });
  const targetAuditId = updated.audit.entries[0]?.id;
  assert.equal(typeof targetAuditId, "string");

  const rolledBack = rollbackSkillPackPolicy({
    openclawDir,
    auditId: targetAuditId,
    changedBy: "release-manager@useorgx.com",
  });

  assert.equal(rolledBack.policy.frozen, false);
  assert.equal(rolledBack.audit.entries[0]?.action, "policy.rollback");
  assert.equal(rolledBack.audit.entries[0]?.rollbackOfAuditId, targetAuditId);
  assert.equal(rolledBack.audit.entries[0]?.changedBy, "release-manager@useorgx.com");

  const persisted = readSkillPackState({ openclawDir });
  assert.equal(persisted.policy.frozen, false);
  assert.equal(persisted.audit.entries[0]?.action, "policy.rollback");
});
