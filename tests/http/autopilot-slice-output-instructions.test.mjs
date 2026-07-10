import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSliceOutputInstructions,
  buildWorkstreamSlicePrompt,
} from "../../dist/http/helpers/autopilot-slice-utils.js";

// ---------------------------------------------------------------------------
// 1. Basic content – run ID and schema path
// ---------------------------------------------------------------------------
test("buildSliceOutputInstructions includes run ID and schema path", () => {
  const output = buildSliceOutputInstructions({
    runId: "run-abc",
    schemaPath: "/tmp/schema.json",
    requiredSkills: ["$orgx-engineering-agent"],
  });

  assert.ok(output.includes("Slice run: run-abc"), "expected run ID in output");
  assert.ok(
    output.includes("/tmp/schema.json"),
    "expected schema path in output",
  );
});

// ---------------------------------------------------------------------------
// 2. Reporting and output requirements
// ---------------------------------------------------------------------------
test("buildSliceOutputInstructions includes reporting and output requirements", () => {
  const output = buildSliceOutputInstructions({
    runId: "run-abc",
    schemaPath: "/tmp/schema.json",
    requiredSkills: ["$orgx-engineering-agent"],
  });

  assert.ok(
    output.includes("You MUST emit progress at least twice"),
    "expected progress reporting requirement",
  );
  assert.ok(
    output.includes("Print ONLY a single JSON object"),
    "expected single-JSON output requirement",
  );
  assert.ok(
    output.includes("confidence_score"),
    "expected confidence_score mention",
  );
  assert.ok(
    output.includes("skill_evidence is mandatory"),
    "expected skill_evidence mandate",
  );
});

test("buildSliceOutputInstructions can make progress reporting optional for local verification", () => {
  const output = buildSliceOutputInstructions({
    runId: "run-abc",
    schemaPath: "/tmp/schema.json",
    requiredSkills: ["$orgx-engineering-agent"],
    progressReportingRequired: false,
  });

  assert.ok(
    output.includes("OrgX progress tool calls are optional for this local verification run"),
    "expected optional progress reporting language",
  );
  assert.ok(
    !output.includes("You MUST emit progress at least twice"),
    "expected mandatory progress language to be omitted",
  );
});

test("buildWorkstreamSlicePrompt can make progress reporting optional for local verification", () => {
  const prompt = buildWorkstreamSlicePrompt({
    initiativeTitle: "Agent Confidence Signals",
    initiativeId: "init-1",
    workstreamId: "ws-1",
    workstreamTitle: "Confidence Metadata Pipeline",
    milestoneSummaries: [{ id: "m-1", title: "Seed", status: "planned" }],
    taskSummaries: [
      {
        id: "t-1",
        title: "Add confidence_score to save_artifact tool input schema",
        status: "todo",
        milestoneId: "m-1",
      },
    ],
    executionPolicy: {
      domain: "engineering",
      requiredSkills: ["$orgx-engineering-agent"],
    },
    runId: "run-1",
    schemaPath: "/tmp/autopilot-slice-schema.json",
    progressReportingRequired: false,
  });

  assert.ok(
    prompt.includes("OrgX progress tool calls are optional for this local verification run"),
    "expected optional progress reporting language",
  );
  assert.ok(
    !prompt.includes("You MUST emit progress at least twice"),
    "expected mandatory progress language to be omitted",
  );
});

// ---------------------------------------------------------------------------
// 3. Output sections match between buildSliceOutputInstructions and
//    buildWorkstreamSlicePrompt
// ---------------------------------------------------------------------------
test("buildSliceOutputInstructions produces same output sections as buildWorkstreamSlicePrompt", () => {
  const instructions = buildSliceOutputInstructions({
    runId: "run-1",
    schemaPath: "/tmp/autopilot-slice-schema.json",
    requiredSkills: ["$orgx-engineering-agent"],
  });

  const prompt = buildWorkstreamSlicePrompt({
    initiativeTitle: "Agent Confidence Signals",
    initiativeId: "init-1",
    workstreamId: "ws-1",
    workstreamTitle: "Confidence Metadata Pipeline",
    milestoneSummaries: [{ id: "m-1", title: "Seed", status: "planned" }],
    taskSummaries: [
      {
        id: "t-1",
        title: "Add confidence_score to save_artifact tool input schema",
        status: "todo",
        milestoneId: "m-1",
      },
    ],
    executionPolicy: {
      domain: "engineering",
      requiredSkills: ["$orgx-engineering-agent"],
    },
    behaviorConfig: {
      configId: "cfg-123",
      version: "v7",
      hash: "sha256:abc123",
      policySource: "task",
      context:
        "Always include concrete verification commands and expected outputs.",
    },
    runId: "run-1",
    schemaPath: "/tmp/autopilot-slice-schema.json",
  });

  const sharedPhrases = [
    "You MUST emit progress at least twice",
    "Execution budget:",
    "Print ONLY a single JSON object",
    "skill_evidence is mandatory",
    "task_updates.task_id MUST exactly match one of the candidate task IDs shown in square brackets",
  ];

  for (const phrase of sharedPhrases) {
    assert.ok(
      instructions.includes(phrase),
      `buildSliceOutputInstructions missing: "${phrase}"`,
    );
    assert.ok(
      prompt.includes(phrase),
      `buildWorkstreamSlicePrompt missing: "${phrase}"`,
    );
  }
});
