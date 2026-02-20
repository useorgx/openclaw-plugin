import test from "node:test";
import assert from "node:assert/strict";

async function importFreshModule(modulePath) {
  const url = new URL(modulePath, import.meta.url);
  url.searchParams.set("cacheBust", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("computeRetroQualityRubricScore gives high score to clean successful runs", async () => {
  const { computeRetroQualityRubricScore } = await importFreshModule(
    "../../dist/retro/quality-rubric.js"
  );

  const result = computeRetroQualityRubricScore({
    success: true,
    hadError: false,
    errorMessage: null,
    tokens: 1200,
    costUsd: 0.87,
    followUpsCount: 1,
    whatWentWrongCount: 0,
  });

  assert.equal(result.score, 5);
  assert.equal(Array.isArray(result.reasons), true);
  assert.equal(result.reasons.length >= 1, true);
});

test("computeRetroQualityRubricScore penalizes errored runs with missing follow-up", async () => {
  const { computeRetroQualityRubricScore } = await importFreshModule(
    "../../dist/retro/quality-rubric.js"
  );

  const result = computeRetroQualityRubricScore({
    success: false,
    hadError: true,
    errorMessage: "timeout",
    tokens: 0,
    costUsd: 14.2,
    followUpsCount: 0,
    whatWentWrongCount: 1,
  });

  assert.equal(result.score, 1);
  assert.equal(result.reasons.some((reason) => /error/i.test(reason)), true);
});

test("computeRetroQualityRubricScore treats negative follow-up counts as missing", async () => {
  const { computeRetroQualityRubricScore } = await importFreshModule(
    "../../dist/retro/quality-rubric.js"
  );

  const result = computeRetroQualityRubricScore({
    success: false,
    hadError: false,
    errorMessage: null,
    tokens: 200,
    costUsd: 0.2,
    followUpsCount: -3,
    whatWentWrongCount: 0,
  });

  assert.equal(result.score, 1);
  assert.equal(
    result.reasons.some((reason) => /missing actionable follow-up/i.test(reason)),
    true
  );
});

test("computeRetroQualityRubricScore penalizes missing token telemetry even on success", async () => {
  const { computeRetroQualityRubricScore } = await importFreshModule(
    "../../dist/retro/quality-rubric.js"
  );

  const result = computeRetroQualityRubricScore({
    success: true,
    hadError: false,
    errorMessage: null,
    tokens: undefined,
    costUsd: 0.25,
    followUpsCount: 1,
    whatWentWrongCount: 0,
  });

  assert.equal(result.score, 4);
  assert.equal(result.reasons.some((reason) => /token telemetry/i.test(reason)), true);
});

test("computeRetroQualityRubricScore penalizes failed runs missing decision signal", async () => {
  const { computeRetroQualityRubricScore } = await importFreshModule(
    "../../dist/retro/quality-rubric.js"
  );

  const result = computeRetroQualityRubricScore({
    success: false,
    hadError: false,
    errorMessage: null,
    tokens: 150,
    costUsd: 0.1,
    decisionsCount: 0,
    followUpsCount: 1,
    whatWentWrongCount: 1,
  });

  assert.equal(result.score, 1);
  assert.equal(result.reasons.some((reason) => /decision signal/i.test(reason)), true);
});
