import test from "node:test";
import assert from "node:assert/strict";

async function importFreshModule(modulePath) {
  const url = new URL(modulePath, import.meta.url);
  url.searchParams.set("cacheBust", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function buildValidTemplate() {
  return {
    schema_version: "practice-exercise-template.v1",
    id: "exercise.debug.retry-loop.v1",
    title: "Retry loop debugging drill",
    summary:
      "Diagnose and fix a retry loop that floods an API by using given logs, rate limits, and guardrail constraints.",
    task_type: "debugging",
    scenarios: [
      {
        id: "scenario.primary",
        title: "Primary throttling incident",
        input: {
          logs: ["429 on /sync", "retry_count=9", "backoff_ms=50"],
          rate_limit_per_minute: 60,
        },
        success_criteria: [
          "Identifies retry bug source",
          "Proposes bounded backoff",
          "Includes verification plan",
        ],
      },
    ],
    constraints: [
      {
        id: "constraint.no-provider-switch",
        title: "No provider migration",
        description: "Do not introduce a new external provider in the fix.",
        severity: "hard",
      },
    ],
    expected_output_shape: {
      format: "json_object",
      fields: [
        {
          path: "diagnosis.root_cause",
          type: "string",
          required: true,
          description: "Most likely root cause based on provided evidence.",
        },
        {
          path: "fix_plan",
          type: "array",
          required: true,
          description: "Ordered implementation steps for the fix.",
        },
      ],
      example: {
        diagnosis: { root_cause: "retry policy ignores terminal 429 responses" },
      },
    },
    tags: ["debugging", "reliability", "practice-loop"],
  };
}

test("validatePracticeExerciseTemplate accepts a valid template", async () => {
  const { validatePracticeExerciseTemplate } = await importFreshModule(
    "../../dist/contracts/practice-exercise-schema.js"
  );

  const result = validatePracticeExerciseTemplate(buildValidTemplate());
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.template?.id, "exercise.debug.retry-loop.v1");
  assert.equal(result.template?.expected_output_shape.format, "json_object");
});

test("validatePracticeExerciseTemplate rejects missing scenario criteria", async () => {
  const { validatePracticeExerciseTemplate } = await importFreshModule(
    "../../dist/contracts/practice-exercise-schema.js"
  );
  const invalid = buildValidTemplate();
  invalid.scenarios[0].success_criteria = [];

  const result = validatePracticeExerciseTemplate(invalid);
  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some((error) => /success_criteria must include at least 1 item/i.test(error)),
    true
  );
  assert.equal(result.template, null);
});

test("validatePracticeExerciseTemplate rejects unsupported task type", async () => {
  const { validatePracticeExerciseTemplate } = await importFreshModule(
    "../../dist/contracts/practice-exercise-schema.js"
  );
  const invalid = buildValidTemplate();
  invalid.task_type = "brainstorm";

  const result = validatePracticeExerciseTemplate(invalid);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => /task_type must be one of/i.test(error)), true);
});

test("validatePracticeExerciseTemplate rejects malformed output fields", async () => {
  const { validatePracticeExerciseTemplate } = await importFreshModule(
    "../../dist/contracts/practice-exercise-schema.js"
  );
  const invalid = buildValidTemplate();
  invalid.expected_output_shape.fields = [{ path: "", type: "string", required: "yes" }];

  const result = validatePracticeExerciseTemplate(invalid);
  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some((error) => /expected_output_shape\.fields\[0\]\.required must be boolean/i.test(error)),
    true
  );
});
