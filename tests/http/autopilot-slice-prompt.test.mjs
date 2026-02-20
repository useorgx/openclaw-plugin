import test from "node:test";
import assert from "node:assert/strict";

import { buildWorkstreamSlicePrompt } from "../../dist/http/helpers/autopilot-slice-utils.js";

function buildPrompt(requiredSkills = ["$orgx-sales-agent"]) {
  return buildWorkstreamSlicePrompt({
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
    executionPolicy: { domain: "sales", requiredSkills },
    behaviorConfig: {
      configId: "cfg-123",
      version: "v7",
      hash: "sha256:abc123",
      policySource: "task",
      context: "Always include concrete verification commands and expected outputs.",
    },
    runId: "run-1",
    schemaPath: "/tmp/autopilot-slice-schema.json",
  });
}

test("buildWorkstreamSlicePrompt requires confidence when saving artifacts", () => {
  const prompt = buildPrompt();
  assert.match(
    prompt,
    /Self-assess confidence when saving artifacts and include `confidence_score` in \[0,1\]\./
  );
  assert.match(
    prompt,
    /Include `confidence_score` for each artifact \(`0` to `1`; use `null` when unknown\)\./
  );
  assert.match(
    prompt,
    /You MUST emit progress at least twice \(start \+ completion\) using an OrgX progress tool\./
  );
});

test("buildWorkstreamSlicePrompt emits skill hints for orgx-sales-agent aliases", () => {
  const prompt = buildPrompt(["$orgx-sales-agent"]);
  assert.match(prompt, /Skill file hints:/);
  assert.match(prompt, /- orgx-sales-agent:/);
  assert.match(prompt, /\.codex\/skills\/orgx-sales-agent\/SKILL\.md/);
  assert.match(prompt, /\.codex\/skills\/sales-agent\/SKILL\.md/);
  assert.match(prompt, /\.codex\/skills\/orgx-sales\/SKILL\.md/);
});

test("buildWorkstreamSlicePrompt injects behavior config context when provided", () => {
  const prompt = buildPrompt();
  assert.match(prompt, /Behavior config \(plugin-injected context\):/);
  assert.match(prompt, /- behavior_config_id: cfg-123/);
  assert.match(prompt, /- behavior_config_version: v7/);
  assert.match(prompt, /- behavior_config_hash: sha256:abc123/);
  assert.match(prompt, /- policy_source: task/);
  assert.match(prompt, /- behavior_context: Always include concrete verification commands and expected outputs\./);
});
