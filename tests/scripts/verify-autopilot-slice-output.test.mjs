import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
        skill_file: "/tmp/SKILL.md",
        skill_sha256: "a".repeat(64),
        skill_heading: "# OrgX Engineering Agent",
      },
    ],
    task_updates: [{ task_id: "task-1", status: "done", reason: "Verified" }],
    milestone_updates: null,
    next_actions: null,
  };
}

function runVerifier(output, schema, requiredSkills = "") {
  const root = mkdtempSync(join(tmpdir(), "orgx-verify-slice-"));
  const outputPath = join(root, "output.json");
  const schemaPath = join(root, "schema.json");
  writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");
  writeFileSync(schemaPath, JSON.stringify(schema, null, 2), "utf8");
  return spawnSync(
    process.execPath,
    [resolve("scripts/verify-autopilot-slice-output.mjs"), outputPath, schemaPath],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ORGX_REQUIRED_SKILLS: requiredSkills,
      },
    }
  );
}

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
  assert.match(combined, /must include exactly one entry for required skill "orgx-engineering-agent"/i);
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
    skill_file: "/tmp/duplicate-skill.md",
  });
  const result = runVerifier(output, makeSchema(), "orgx-engineering-agent");
  assert.notEqual(result.status, 0);
  const combined = `${result.stderr}\n${result.stdout}`;
  assert.match(combined, /must include exactly one entry for required skill "orgx-engineering-agent"/i);
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
  assert.match(
    combined,
    /error status requires at least one decisions_needed entry with blocking=true/i
  );
});
