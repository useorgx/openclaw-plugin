import test from "node:test";
import assert from "node:assert/strict";

async function importFreshModule() {
  const url = new URL("../../dist/reporting/rollups.js", import.meta.url);
  url.searchParams.set("cacheBust", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("ready when artifact is schema-validated and quality meets threshold", async () => {
  const { computeTaskCompletionReadiness } = await importFreshModule();
  const r = computeTaskCompletionReadiness({
    artifacts: [{ schema_validated: true, atomic_unit_type: "pr" }],
    qualityScore: 4,
    qualityThreshold: 4,
    hasOutcomeEvent: true,
  });
  assert.equal(r.ready, true);
  assert.equal(r.status, "ready");
  assert.equal(r.hasArtifact, true);
  assert.equal(r.hasSchemaValidatedArtifact, true);
  assert.equal(r.hasQualityScore, true);
  assert.equal(r.missingItems.length, 0);
});

test("needs_proof when no artifacts and no quality score", async () => {
  const { computeTaskCompletionReadiness } = await importFreshModule();
  const r = computeTaskCompletionReadiness({
    artifacts: [],
    qualityScore: null,
    hasOutcomeEvent: false,
  });
  assert.equal(r.ready, false);
  assert.equal(r.status, "needs_proof");
  assert.equal(r.hasArtifact, false);
  assert.match(r.missingItems.join(" "), /No artifact registered/);
  assert.match(r.missingItems.join(" "), /No quality score recorded/);
});

test("needs_proof when artifact present but no quality score", async () => {
  const { computeTaskCompletionReadiness } = await importFreshModule();
  const r = computeTaskCompletionReadiness({
    artifacts: [{ schema_validated: true, atomic_unit_type: "doc" }],
  });
  assert.equal(r.ready, false);
  assert.equal(r.status, "needs_proof");
  assert.equal(r.hasArtifact, true);
  assert.equal(r.hasQualityScore, false);
});

test("needs_review when quality score is below threshold", async () => {
  const { computeTaskCompletionReadiness } = await importFreshModule();
  const r = computeTaskCompletionReadiness({
    artifacts: [{ schema_validated: true, atomic_unit_type: "report" }],
    qualityScore: 3,
    qualityThreshold: 4,
  });
  assert.equal(r.ready, false);
  assert.equal(r.status, "needs_review");
  assert.equal(r.hasQualityScore, true);
  assert.equal(r.qualityScore, 3);
  assert.match(r.missingItems.join(" "), /below threshold 4/);
});

test("freeform artifact without schema_validated is ready with warning", async () => {
  const { computeTaskCompletionReadiness } = await importFreshModule();
  const r = computeTaskCompletionReadiness({
    artifacts: [{ atomic_unit_type: "note" }],
    qualityScore: 5,
    qualityThreshold: 4,
    hasOutcomeEvent: true,
  });
  assert.equal(r.ready, true);
  assert.equal(r.status, "ready");
  assert.equal(r.hasSchemaValidatedArtifact, false);
  assert.match(r.warnings.join(" "), /none pass domain schema validation/);
});

test("custom threshold allows lower quality score to pass", async () => {
  const { computeTaskCompletionReadiness } = await importFreshModule();
  const r = computeTaskCompletionReadiness({
    artifacts: [{ schema_validated: true, atomic_unit_type: "pr" }],
    qualityScore: 3,
    qualityThreshold: 3,
  });
  assert.equal(r.ready, true);
  assert.equal(r.status, "ready");
  assert.equal(r.qualityThreshold, 3);
});

test("default threshold is 4 when qualityThreshold omitted", async () => {
  const { computeTaskCompletionReadiness } = await importFreshModule();
  const r = computeTaskCompletionReadiness({
    artifacts: [{ schema_validated: true, atomic_unit_type: "pr" }],
    qualityScore: 4,
  });
  assert.equal(r.qualityThreshold, 4);
  assert.equal(r.ready, true);
});

test("warns about L5 impact when hasOutcomeEvent is false", async () => {
  const { computeTaskCompletionReadiness } = await importFreshModule();
  const r = computeTaskCompletionReadiness({
    artifacts: [{ schema_validated: true, atomic_unit_type: "pr" }],
    qualityScore: 5,
    hasOutcomeEvent: false,
  });
  assert.equal(r.ready, true);
  assert.match(r.warnings.join(" "), /L5/);
});

test("empty input returns needs_proof", async () => {
  const { computeTaskCompletionReadiness } = await importFreshModule();
  const r = computeTaskCompletionReadiness({});
  assert.equal(r.ready, false);
  assert.equal(r.status, "needs_proof");
  assert.equal(r.hasArtifact, false);
  assert.equal(r.hasQualityScore, false);
  assert.equal(r.qualityScore, null);
});

test("multiple artifacts: hasSchemaValidatedArtifact true if any validated", async () => {
  const { computeTaskCompletionReadiness } = await importFreshModule();
  const r = computeTaskCompletionReadiness({
    artifacts: [
      { atomic_unit_type: "note" },
      { schema_validated: true, atomic_unit_type: "pr" },
    ],
    qualityScore: 4,
  });
  assert.equal(r.hasArtifact, true);
  assert.equal(r.hasSchemaValidatedArtifact, true);
  assert.equal(r.ready, true);
});
