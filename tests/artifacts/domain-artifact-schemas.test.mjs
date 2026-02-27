import test from "node:test";
import assert from "node:assert/strict";

async function importFreshModule() {
  const url = new URL("../../dist/artifacts/artifact-domain-schemas.js", import.meta.url);
  url.searchParams.set("cacheBust", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

// ---------------------------------------------------------------------------
// validateArtifactMetadata — all 14 atomic unit types
// ---------------------------------------------------------------------------

test("validateArtifactMetadata: engineering.commit valid with required fields", async () => {
  const { validateArtifactMetadata } = await importFreshModule();
  const result = validateArtifactMetadata("engineering.commit", {
    commit_sha: "abc123",
    branch: "main",
  });
  assert.equal(result.valid, true);
  assert.equal(result.atomicUnitType, "engineering.commit");
  assert.deepEqual(result.missingRequired, []);
  assert.equal(result.warnings.length, 0);
});

test("validateArtifactMetadata: engineering.commit reports missing required fields", async () => {
  const { validateArtifactMetadata } = await importFreshModule();
  const result = validateArtifactMetadata("engineering.commit", {});
  assert.equal(result.valid, false);
  assert.ok(result.missingRequired.includes("commit_sha"));
  assert.ok(result.missingRequired.includes("branch"));
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Missing required field/);
});

test("validateArtifactMetadata: engineering.pr valid with pr_url + branch", async () => {
  const { validateArtifactMetadata } = await importFreshModule();
  const result = validateArtifactMetadata("engineering.pr", {
    pr_url: "https://github.com/org/repo/pull/42",
    branch: "feat/thing",
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.missingRequired, []);
});

test("validateArtifactMetadata: product.spec valid with acceptance_criteria + success_metric", async () => {
  const { validateArtifactMetadata } = await importFreshModule();
  const result = validateArtifactMetadata("product.spec", {
    acceptance_criteria: "Users can log in",
    success_metric: "95% success rate",
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.missingRequired, []);
});

test("validateArtifactMetadata: product.decision valid with decision_context + recommendation", async () => {
  const { validateArtifactMetadata } = await importFreshModule();
  const result = validateArtifactMetadata("product.decision", {
    decision_context: "DB migration strategy",
    recommendation: "Use blue-green deploy",
  });
  assert.equal(result.valid, true);
});

test("validateArtifactMetadata: design.component valid with evidence_url", async () => {
  const { validateArtifactMetadata } = await importFreshModule();
  const result = validateArtifactMetadata("design.component", {
    evidence_url: "https://figma.com/file/abc",
  });
  assert.equal(result.valid, true);
});

test("validateArtifactMetadata: design.a11y valid with audit_results", async () => {
  const { validateArtifactMetadata } = await importFreshModule();
  const result = validateArtifactMetadata("design.a11y", {
    audit_results: "WCAG 2.1 AA pass",
  });
  assert.equal(result.valid, true);
});

test("validateArtifactMetadata: marketing.asset valid with audience + channel + measurement_hook", async () => {
  const { validateArtifactMetadata } = await importFreshModule();
  const result = validateArtifactMetadata("marketing.asset", {
    audience: "developers",
    channel: "twitter",
    measurement_hook: "utm_campaign=launch",
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.missingRequired, []);
});

test("validateArtifactMetadata: marketing.experiment valid with variant_id + hypothesis", async () => {
  const { validateArtifactMetadata } = await importFreshModule();
  const result = validateArtifactMetadata("marketing.experiment", {
    variant_id: "v2-blue-cta",
    hypothesis: "Blue CTA increases click rate by 10%",
  });
  assert.equal(result.valid, true);
});

test("validateArtifactMetadata: sales.qualification valid with buyer_stage + next_action", async () => {
  const { validateArtifactMetadata } = await importFreshModule();
  const result = validateArtifactMetadata("sales.qualification", {
    buyer_stage: "evaluation",
    next_action: "Send technical deep-dive deck",
  });
  assert.equal(result.valid, true);
});

test("validateArtifactMetadata: sales.proposal valid with recipient", async () => {
  const { validateArtifactMetadata } = await importFreshModule();
  const result = validateArtifactMetadata("sales.proposal", {
    recipient: "Acme Corp CTO",
  });
  assert.equal(result.valid, true);
});

test("validateArtifactMetadata: operations.runbook valid with all three required fields", async () => {
  const { validateArtifactMetadata } = await importFreshModule();
  const result = validateArtifactMetadata("operations.runbook", {
    change_description: "Rotate DB creds",
    rollback_path: "Restore from vault snapshot",
    affected_systems: ["auth-service", "api-gateway"],
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.missingRequired, []);
});

test("validateArtifactMetadata: operations.incident valid with incident_id + severity", async () => {
  const { validateArtifactMetadata } = await importFreshModule();
  const result = validateArtifactMetadata("operations.incident", {
    incident_id: "INC-2026-0042",
    severity: "P1",
  });
  assert.equal(result.valid, true);
});

test("validateArtifactMetadata: orchestration.routing valid with action_type + target_entity_ids + rationale", async () => {
  const { validateArtifactMetadata } = await importFreshModule();
  const result = validateArtifactMetadata("orchestration.routing", {
    action_type: "delegate",
    target_entity_ids: ["ws-1", "ws-2"],
    rationale: "Parallelizable sub-tasks",
  });
  assert.equal(result.valid, true);
});

test("validateArtifactMetadata: orchestration.decomp valid with parent_entity_id + child_tasks", async () => {
  const { validateArtifactMetadata } = await importFreshModule();
  const result = validateArtifactMetadata("orchestration.decomp", {
    parent_entity_id: "init-99",
    child_tasks: ["task-a", "task-b"],
  });
  assert.equal(result.valid, true);
});

test("validateArtifactMetadata: unknown type passes through with valid=true and warning", async () => {
  const { validateArtifactMetadata } = await importFreshModule();
  const result = validateArtifactMetadata("custom.widget", { foo: "bar" });
  assert.equal(result.valid, true);
  assert.equal(result.atomicUnitType, "custom.widget");
  assert.deepEqual(result.missingRequired, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Unknown atomic_unit_type/);
});

// ---------------------------------------------------------------------------
// normalizeArtifactType — alias resolution
// ---------------------------------------------------------------------------

test("normalizeArtifactType: direct canonical match returns as-is", async () => {
  const { normalizeArtifactType } = await importFreshModule();
  assert.equal(normalizeArtifactType("engineering.commit"), "engineering.commit");
  assert.equal(normalizeArtifactType("operations.incident"), "operations.incident");
});

test("normalizeArtifactType: engineering aliases resolve correctly", async () => {
  const { normalizeArtifactType } = await importFreshModule();
  assert.equal(normalizeArtifactType("eng.diff_pack"), "engineering.commit");
  assert.equal(normalizeArtifactType("pull_request"), "engineering.pr");
});

test("normalizeArtifactType: product aliases resolve correctly", async () => {
  const { normalizeArtifactType } = await importFreshModule();
  assert.equal(normalizeArtifactType("spec"), "product.spec");
  assert.equal(normalizeArtifactType("feature_spec"), "product.spec");
  assert.equal(normalizeArtifactType("decision"), "product.decision");
});

test("normalizeArtifactType: unknown type returns null", async () => {
  const { normalizeArtifactType } = await importFreshModule();
  assert.equal(normalizeArtifactType("totally.unknown.thing"), null);
});

test("normalizeArtifactType: case insensitive matching", async () => {
  const { normalizeArtifactType } = await importFreshModule();
  assert.equal(normalizeArtifactType("Engineering.Commit"), "engineering.commit");
  assert.equal(normalizeArtifactType("ENG.DIFF_PACK"), "engineering.commit");
  assert.equal(normalizeArtifactType("SPEC"), "product.spec");
});

// ---------------------------------------------------------------------------
// DOMAIN_QUALITY_THRESHOLDS — defaults per domain
// ---------------------------------------------------------------------------

test("DOMAIN_QUALITY_THRESHOLDS has expected defaults per domain", async () => {
  const { DOMAIN_QUALITY_THRESHOLDS } = await importFreshModule();
  assert.equal(DOMAIN_QUALITY_THRESHOLDS.engineering, 4);
  assert.equal(DOMAIN_QUALITY_THRESHOLDS.product, 4);
  assert.equal(DOMAIN_QUALITY_THRESHOLDS.design, 4);
  assert.equal(DOMAIN_QUALITY_THRESHOLDS.operations, 4);
  assert.equal(DOMAIN_QUALITY_THRESHOLDS.marketing, 3);
  assert.equal(DOMAIN_QUALITY_THRESHOLDS.sales, 3);
  assert.equal(DOMAIN_QUALITY_THRESHOLDS.orchestration, 3);
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

test("validateArtifactMetadata: empty metadata does not crash", async () => {
  const { validateArtifactMetadata } = await importFreshModule();
  const result = validateArtifactMetadata("engineering.commit", {});
  assert.equal(result.valid, false);
  assert.ok(result.missingRequired.length > 0);
  // should not throw
});

test("validateArtifactMetadata: unknown type with empty metadata passes through", async () => {
  const { validateArtifactMetadata } = await importFreshModule();
  const result = validateArtifactMetadata("future.type", {});
  assert.equal(result.valid, true);
  assert.deepEqual(result.missingRequired, []);
  assert.ok(result.warnings.length > 0);
});

test("ATOMIC_UNIT_TYPES contains exactly 14 canonical types", async () => {
  const { ATOMIC_UNIT_TYPES } = await importFreshModule();
  assert.equal(ATOMIC_UNIT_TYPES.length, 14);
});

test("DOMAIN_ARTIFACT_SCHEMAS keys match ATOMIC_UNIT_TYPES", async () => {
  const { DOMAIN_ARTIFACT_SCHEMAS, ATOMIC_UNIT_TYPES } = await importFreshModule();
  const schemaKeys = Object.keys(DOMAIN_ARTIFACT_SCHEMAS).sort();
  const types = [...ATOMIC_UNIT_TYPES].sort();
  assert.deepEqual(schemaKeys, types);
});
