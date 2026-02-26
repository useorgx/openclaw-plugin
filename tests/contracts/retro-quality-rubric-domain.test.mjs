import test from "node:test";
import assert from "node:assert/strict";

async function importFreshModule() {
  const url = new URL("../../dist/retro/quality-rubric.js", import.meta.url);
  url.searchParams.set("cacheBust", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

// -- computeDomainQualityModifier per-domain checks --

test("engineering: +1 for verification.tests_passed, -1 for missing commit_sha", async () => {
  const { computeDomainQualityModifier: m } = await importFreshModule();
  assert.equal(m("engineering", { verification: { tests_passed: true }, commit_sha: "abc" }).delta, 1);
  const p = m("engineering", {});
  assert.equal(p.delta, -1);
  assert.ok(p.reasons.some((r) => /commit_sha/i.test(r)));
});

test("product: +1 for acceptance_criteria, -1 for missing success_metric", async () => {
  const { computeDomainQualityModifier: m } = await importFreshModule();
  assert.equal(m("product", { acceptance_criteria: "AC1", success_metric: "DAU" }).delta, 1);
  assert.equal(m("product", {}).delta, -1);
});

test("design: +1 for evidence_url, -1 for missing tokens_referenced", async () => {
  const { computeDomainQualityModifier: m } = await importFreshModule();
  assert.equal(m("design", { evidence_url: "https://x.com", tokens_referenced: ["c1"] }).delta, 1);
  assert.equal(m("design", {}).delta, -1);
});

test("marketing: +1 for measurement_hook, -1 for missing audience", async () => {
  const { computeDomainQualityModifier: m } = await importFreshModule();
  assert.equal(m("marketing", { measurement_hook: "utm=x", audience: "devs" }).delta, 1);
  const p = m("marketing", {});
  assert.equal(p.delta, -1);
  assert.ok(p.reasons.some((r) => /audience/i.test(r)));
});

test("sales: +1 for next_action, -1 for missing buyer_stage", async () => {
  const { computeDomainQualityModifier: m } = await importFreshModule();
  assert.equal(m("sales", { next_action: "demo", buyer_stage: "eval" }).delta, 1);
  assert.equal(m("sales", { next_action: "call" }).delta, 0); // +1 and -1 cancel
});

test("operations: +1 for rollback_path, -1 for missing affected_systems", async () => {
  const { computeDomainQualityModifier: m } = await importFreshModule();
  assert.equal(m("operations", { rollback_path: "/rb.sh", affected_systems: ["db"] }).delta, 1);
  const p = m("operations", {});
  assert.equal(p.delta, -1);
  assert.ok(p.reasons.some((r) => /affected systems/i.test(r)));
});

test("orchestration: +1 for unblocked_work (array), -1 for missing rationale", async () => {
  const { computeDomainQualityModifier: m } = await importFreshModule();
  assert.equal(m("orchestration", { unblocked_work: ["t-1"], rationale: "shift" }).delta, 1);
  assert.equal(m("orchestration", { unblocked_work: [], rationale: "r" }).delta, 0); // empty array = absent
});

test("null domain returns delta 0", async () => {
  const { computeDomainQualityModifier: m } = await importFreshModule();
  const r = m(null, { verification: { tests_passed: true } });
  assert.equal(r.delta, 0);
  assert.equal(r.reasons.length, 0);
});

test("null metadata returns delta 0", async () => {
  const { computeDomainQualityModifier: m } = await importFreshModule();
  const r = m("engineering", null);
  assert.equal(r.delta, 0);
  assert.equal(r.reasons.length, 0);
});

// -- computeRetroQualityRubricScore with domain modifiers --

const cleanSuccess = {
  success: true, hadError: false, errorMessage: null,
  tokens: 1200, costUsd: 0.5, followUpsCount: 1, whatWentWrongCount: 0,
};

test("success + good engineering metadata caps at 5", async () => {
  const { computeRetroQualityRubricScore: score } = await importFreshModule();
  const r = score({ ...cleanSuccess, domain: "engineering",
    artifactMetadata: { verification: { tests_passed: true }, commit_sha: "abc" } });
  assert.equal(r.score, 5); // base 5 + 1 bonus, clamped to 5
});

test("success + missing commit_sha yields 4", async () => {
  const { computeRetroQualityRubricScore: score } = await importFreshModule();
  const r = score({ ...cleanSuccess, domain: "engineering", artifactMetadata: {} });
  assert.equal(r.score, 4); // base 5 - 1 penalty
  assert.ok(r.reasons.some((s) => /commit_sha/i.test(s)));
});

test("score is bounded between 1 and 5 even with stacking penalties", async () => {
  const { computeRetroQualityRubricScore: score } = await importFreshModule();
  const r = score({
    success: false, hadError: true, errorMessage: "crash",
    tokens: 0, costUsd: 15, followUpsCount: 0, whatWentWrongCount: 0,
    decisionsCount: 0, domain: "engineering", artifactMetadata: {},
  });
  assert.ok(r.score >= 1, `score ${r.score} should be >= 1`);
  assert.ok(r.score <= 5, `score ${r.score} should be <= 5`);
});

test("no domain = same behavior as generic scoring", async () => {
  const { computeRetroQualityRubricScore: score } = await importFreshModule();
  assert.equal(score({ ...cleanSuccess }).score, 5);
});

// -- +1 and -1 can stack to net zero --

test("engineering: tests_passed AND missing commit_sha yields net delta 0", async () => {
  const { computeDomainQualityModifier: m } = await importFreshModule();
  const r = m("engineering", { verification: { tests_passed: true } }); // no commit_sha
  assert.equal(r.delta, 0);
  assert.equal(r.reasons.length, 2); // both bonus and penalty reasons present
});
