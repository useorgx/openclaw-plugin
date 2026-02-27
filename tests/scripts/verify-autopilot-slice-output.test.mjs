import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function makeSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "status",
      "summary",
      "workstream_id",
      "workstream_title",
      "slice_id",
      "artifacts",
      "decisions_needed",
      "skill_evidence",
      "task_updates",
      "milestone_updates",
      "next_actions",
    ],
    properties: {
      status: { type: "string" },
      summary: { type: "string" },
      workstream_id: { type: "string" },
      workstream_title: { type: ["string", "null"] },
      slice_id: { type: ["string", "null"] },
      artifacts: { type: ["array", "null"] },
      decisions_needed: { type: ["array", "null"] },
      skill_evidence: { type: ["array", "null"] },
      task_updates: { type: ["array", "null"] },
      milestone_updates: { type: ["array", "null"] },
      next_actions: { type: ["array", "null"] },
    },
  };
}

function makeValidOutput() {
  return {
    status: "completed",
    summary: "Completed one bounded slice.",
    workstream_id: "ws-1",
    workstream_title: "Workstream 1",
    slice_id: "slice-1",
    artifacts: [
      {
        name: "Artifact A",
        artifact_type: "document",
        confidence_score: 0.9,
        description: "doc",
        url: "/tmp/a.md",
        verification_steps: ["inspect file"],
        milestone_id: null,
        task_ids: ["task-1"],
      },
    ],
    decisions_needed: null,
    skill_evidence: [
      {
        skill: "orgx-engineering-agent",
        skill_file: "__SKILL_FILE__",
        skill_sha256: "__SKILL_SHA__",
        skill_heading: "# OrgX Engineering Agent",
      },
    ],
    task_updates: [{ task_id: "task-1", status: "done", reason: "Verified" }],
    milestone_updates: null,
    next_actions: null,
  };
}

function runVerifier(output, schema, requiredSkills = "", options = {}) {
  const root = mkdtempSync(join(tmpdir(), "orgx-verify-slice-"));
  const skillPath = join(root, "SKILL.md");
  const skillContent =
    options.skillContent ??
    "# OrgX Engineering Agent\n\nDeliver technically rigorous artifacts.\n";
  writeFileSync(skillPath, skillContent, "utf8");
  const skillSha = createHash("sha256").update(skillContent).digest("hex");

  const hydratedOutput = JSON.parse(JSON.stringify(output));
  if (Array.isArray(hydratedOutput.skill_evidence)) {
    for (const entry of hydratedOutput.skill_evidence) {
      if (entry?.skill_file === "__SKILL_FILE__") entry.skill_file = skillPath;
      if (entry?.skill_sha256 === "__SKILL_SHA__") entry.skill_sha256 = skillSha;
    }
  }

  const outputPath = join(root, "output.json");
  const schemaPath = join(root, "schema.json");
  writeFileSync(outputPath, JSON.stringify(hydratedOutput, null, 2), "utf8");
  writeFileSync(schemaPath, JSON.stringify(schema, null, 2), "utf8");
  const env = { ...process.env, ORGX_REQUIRED_SKILLS: requiredSkills };
  delete env.NODE_OPTIONS;
  return spawnSync(
    process.execPath,
    [resolve("scripts/verify-autopilot-slice-output.mjs"), outputPath, schemaPath],
    {
      encoding: "utf8",
      env,
    }
  );
}

test("verifier accepts skill heading derived from markdown heading after YAML frontmatter", () => {
  const output = makeValidOutput();
  output.skill_evidence[0].skill_heading = "# OrgX Engineering Agent";
  const skillContent = [
    "---",
    "name: orgx-engineering-agent",
    "description: Test skill file",
    "---",
    "",
    "# OrgX Engineering Agent",
    "",
    "Deliver technically rigorous artifacts.",
    "",
  ].join("\n");
  const result = runVerifier(output, makeSchema(), "", { skillContent });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[verify\] ok/i);
});

test("verifier accepts skill heading derived from first non-empty line after YAML frontmatter", () => {
  const output = makeValidOutput();
  output.skill_evidence[0].skill_heading = "deliver engineering outputs";
  const skillContent = [
    "---",
    "name: orgx-engineering-agent",
    "description: Test skill file",
    "---",
    "",
    "deliver engineering outputs",
    "",
  ].join("\n");
  const result = runVerifier(output, makeSchema(), "", { skillContent });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[verify\] ok/i);
});

test("verifier accepts a schema-compliant completed output", () => {
  const result = runVerifier(makeValidOutput(), makeSchema());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[verify\] ok/);
});

test("verifier rejects skill evidence missing required authenticity fields", () => {
  const output = makeValidOutput();
  output.skill_evidence[0].skill_sha256 = null;
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /skill_evidence\.skill_sha256/);
});

test("verifier rejects null skill_evidence", () => {
  const output = makeValidOutput();
  output.skill_evidence = null;
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(combined, /skill_evidence must be an array/i);
});

test("verifier rejects empty skill_evidence arrays", () => {
  const output = makeValidOutput();
  output.skill_evidence = [];
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(combined, /skill_evidence must include at least one entry/i);
});

test("verifier rejects skill evidence when declared digest does not match skill file", () => {
  const output = makeValidOutput();
  output.skill_evidence[0].skill_sha256 = "b".repeat(64);
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(combined, /does not match file digest/i);
});

test("verifier rejects skill evidence when heading does not match the skill file", () => {
  const output = makeValidOutput();
  output.skill_evidence[0].skill_heading = "# Different Heading";
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(combined, /skill_evidence\.skill_heading must match the first heading\/non-empty line/i);
});

test("verifier rejects invalid task update status", () => {
  const output = makeValidOutput();
  output.task_updates[0].status = "complete";
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /task_updates\[\]\.status/);
});

test("verifier rejects missing required skill evidence when ORGX_REQUIRED_SKILLS is set", () => {
  const output = makeValidOutput();
  output.skill_evidence = [];
  const result = runVerifier(output, makeSchema(), "orgx-engineering-agent");
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(combined, /skill_evidence must include at least one entry/i);
});

test("verifier accepts required skill evidence when present exactly once", () => {
  const result = runVerifier(
    makeValidOutput(),
    makeSchema(),
    "orgx-engineering-agent"
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /passed validation checks/i);
});

test("verifier rejects duplicate required skill evidence entries", () => {
  const output = makeValidOutput();
  output.skill_evidence.push({
    ...output.skill_evidence[0],
    skill_file: "__SKILL_FILE__",
  });
  const result = runVerifier(output, makeSchema(), "orgx-engineering-agent");
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(combined, /skill_evidence contains duplicate entries for skill "orgx-engineering-agent"/i);
});

test("verifier rejects duplicate non-required skill evidence entries", () => {
  const output = makeValidOutput();
  output.skill_evidence.push({
    ...output.skill_evidence[0],
    skill: "qa-agent",
    skill_file: "__SKILL_FILE__",
    skill_sha256: "__SKILL_SHA__",
  });
  output.skill_evidence.push({
    ...output.skill_evidence[0],
    skill: "qa-agent",
    skill_file: "__SKILL_FILE__",
    skill_sha256: "__SKILL_SHA__",
  });
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(combined, /skill_evidence contains duplicate entries for skill "qa-agent"/i);
});

test("verifier accepts distinct non-required skill evidence entries", () => {
  const output = makeValidOutput();
  output.skill_evidence.push({
    ...output.skill_evidence[0],
    skill: "qa-agent",
    skill_file: "__SKILL_FILE__",
    skill_sha256: "__SKILL_SHA__",
  });
  const result = runVerifier(output, makeSchema());
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[verify\] ok/i);
});

test("verifier tolerates duplicate required skill ids in ORGX_REQUIRED_SKILLS", () => {
  const result = runVerifier(
    makeValidOutput(),
    makeSchema(),
    "orgx-engineering-agent,orgx-engineering-agent"
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[verify\] ok/i);
});

test("verifier accepts required skills provided as whitespace-delimited values", () => {
  const result = runVerifier(
    makeValidOutput(),
    makeSchema(),
    "  $orgx-engineering-agent\norgx-engineering-agent  "
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[verify\] ok/i);
});

test("verifier accepts required skills provided as a JSON array string", () => {
  const result = runVerifier(
    makeValidOutput(),
    makeSchema(),
    '["$orgx-engineering-agent","orgx-engineering-agent"]'
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[verify\] ok/i);
});

test("verifier rejects completed status when any decision is blocking", () => {
  const output = makeValidOutput();
  output.decisions_needed = [
    {
      question: "Need human decision",
      summary: null,
      options: ["Yes", "No"],
      urgency: "medium",
      blocking: true,
    },
  ];
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(
    combined,
    /completed status is invalid when any decisions_needed entry is blocking=true/i
  );
});

test("verifier rejects blocked status without any blocking decisions", () => {
  const output = makeValidOutput();
  output.status = "blocked";
  output.artifacts = null;
  output.task_updates = null;
  output.decisions_needed = [
    {
      question: "Need human decision",
      summary: null,
      options: ["Yes", "No"],
      urgency: "medium",
      blocking: false,
    },
  ];
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(
    combined,
    /blocked status requires at least one decisions_needed entry with blocking=true/i
  );
});

test("verifier rejects non-array decisions_needed values", () => {
  const output = makeValidOutput();
  output.decisions_needed = { question: "bad type" };
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(combined, /decisions_needed must be an array or null/i);
});

test("verifier rejects decisions_needed options containing blank entries", () => {
  const output = makeValidOutput();
  output.status = "needs_decision";
  output.artifacts = null;
  output.task_updates = null;
  output.decisions_needed = [
    {
      question: "Choose rollout strategy",
      summary: null,
      options: ["ship now", "   "],
      urgency: "high",
      blocking: true,
    },
  ];
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(combined, /decision\.options entries must be non-empty strings/i);
});

test("verifier rejects blank optional decision summary values", () => {
  const output = makeValidOutput();
  output.status = "needs_decision";
  output.artifacts = null;
  output.task_updates = null;
  output.decisions_needed = [
    {
      question: "Choose rollout strategy",
      summary: "   ",
      options: ["ship now", "wait"],
      urgency: "high",
      blocking: true,
    },
  ];
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(combined, /decision\.summary must be a non-empty string or null/i);
});

test("verifier rejects needs_decision status without a blocking decision", () => {
  const output = makeValidOutput();
  output.status = "needs_decision";
  output.artifacts = null;
  output.task_updates = null;
  output.decisions_needed = [
    {
      question: "Need input",
      summary: null,
      options: ["A", "B"],
      urgency: "high",
      blocking: false,
    },
  ];
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(
    combined,
    /needs_decision status requires at least one decisions_needed entry with blocking=true/i
  );
});

test("verifier rejects error status without a blocking decision", () => {
  const output = makeValidOutput();
  output.status = "error";
  output.artifacts = null;
  output.task_updates = null;
  output.decisions_needed = [
    {
      question: "Confirm recovery",
      summary: null,
      options: ["retry", "abort"],
      urgency: "urgent",
      blocking: false,
    },
  ];
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(combined, /error status is not allowed for autonomous slice outputs/i);
});

test("verifier rejects error status when any decision is blocking", () => {
  const output = makeValidOutput();
  output.status = "error";
  output.artifacts = null;
  output.task_updates = null;
  output.decisions_needed = [
    {
      question: "Confirm recovery",
      summary: null,
      options: ["retry", "abort"],
      urgency: "urgent",
      blocking: true,
    },
  ];
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(
    combined,
    /error status is not allowed for autonomous slice outputs/i
  );
});

test("verifier rejects blank optional task update reason values", () => {
  const output = makeValidOutput();
  output.task_updates[0].reason = "  ";
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(combined, /task_updates\[\]\.reason must be a non-empty string or null/i);
});

test("verifier rejects duplicate task_updates task_id entries", () => {
  const output = makeValidOutput();
  output.task_updates = [
    { task_id: "task-1", status: "in_progress", reason: "started" },
    { task_id: "task-1", status: "done", reason: "completed" },
  ];
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(combined, /task_updates contains duplicate task_id "task-1"/i);
});

test("verifier rejects duplicate milestone_updates milestone_id entries", () => {
  const output = makeValidOutput();
  output.milestone_updates = [
    { milestone_id: "ms-1", status: "planned", reason: "queued" },
    { milestone_id: "ms-1", status: "completed", reason: "done" },
  ];
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(combined, /milestone_updates contains duplicate milestone_id "ms-1"/i);
});

test("verifier rejects completed status when no artifacts or status updates are reported", () => {
  const output = makeValidOutput();
  output.artifacts = [];
  output.task_updates = [];
  output.milestone_updates = [];
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(
    combined,
    /completed status requires artifacts\/task_updates\/milestone_updates/i
  );
});

test("verifier rejects non-array artifacts values", () => {
  const output = makeValidOutput();
  output.artifacts = { name: "bad type" };
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(combined, /artifacts must be an array or null/i);
});

test("verifier rejects artifact task_ids containing blank strings", () => {
  const output = makeValidOutput();
  output.artifacts[0].task_ids = ["task-1", "   "];
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(combined, /artifact\.task_ids entries must be non-empty strings/i);
});

test("verifier rejects artifacts missing url", () => {
  const output = makeValidOutput();
  output.artifacts[0].url = null;
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(combined, /artifact\.url is required for verifiable artifacts/i);
});

test("verifier rejects artifacts missing verification steps", () => {
  const output = makeValidOutput();
  output.artifacts[0].verification_steps = null;
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(
    combined,
    /artifact\.verification_steps must be a non-empty array for verifiable artifacts/i
  );
});

test("verifier rejects next_actions entries that are blank strings", () => {
  const output = makeValidOutput();
  output.next_actions = ["", "   "];
  const result = runVerifier(output, makeSchema());
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(combined, /next_actions entries must be non-empty strings/i);
});

test("verifier accepts next_actions entries that are non-empty strings", () => {
  const output = makeValidOutput();
  output.next_actions = ["Open PR", "Monitor CI"];
  const result = runVerifier(output, makeSchema());
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[verify\] ok/i);
});
