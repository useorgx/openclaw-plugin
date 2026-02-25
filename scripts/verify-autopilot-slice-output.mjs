#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

function fail(message) {
  console.error(`[verify] failed: ${message}`);
  process.exit(1);
}

function readJson(pathname, label) {
  try {
    return JSON.parse(readFileSync(pathname, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`cannot parse ${label} JSON at ${pathname}: ${message}`);
  }
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRequiredSkills(value) {
  const unique = new Set();
  for (const entry of String(value || "").split(/[\s,]+/)) {
    const skill = String(entry || "").replace(/^\$/, "").trim();
    if (skill) unique.add(skill);
  }
  return [...unique];
}

function assertKnownFields(record, requiredFields, label) {
  for (const field of requiredFields) {
    assert(field in record, `${label} missing required field "${field}"`);
  }
  for (const field of Object.keys(record)) {
    assert(requiredFields.includes(field), `${label} has unexpected field "${field}"`);
  }
}

function assertOptionalString(value, label) {
  if (value != null) {
    assert(typeof value === "string", `${label} must be a string or null`);
  }
}

function assertStringArrayOrNull(value, label) {
  if (value == null) return;
  assert(Array.isArray(value), `${label} must be an array or null`);
  for (const item of value) {
    assert(typeof item === "string", `${label} entries must be strings`);
  }
}

function main() {
  const outputPath = process.argv[2];
  if (!outputPath) {
    fail("usage: node scripts/verify-autopilot-slice-output.mjs <output.json> [schema.json]");
  }

  const defaultSchemaPath = resolve(
    homedir(),
    ".config/useorgx/openclaw-plugin/autopilot-slice-schema.json"
  );
  const schemaPath = process.argv[3] ? resolve(process.argv[3]) : defaultSchemaPath;

  const schema = readJson(schemaPath, "schema");
  const output = readJson(resolve(outputPath), "output");
  const requiredSkills = parseRequiredSkills(process.env.ORGX_REQUIRED_SKILLS);

  assert(isObject(schema), "schema root must be an object");
  assert(isObject(output), "output root must be an object");

  const requiredKeys = Array.isArray(schema.required) ? schema.required : [];
  const allowedKeys = Object.keys(isObject(schema.properties) ? schema.properties : {});
  const outputKeys = Object.keys(output);

  for (const key of requiredKeys) {
    assert(key in output, `missing required top-level field "${key}"`);
  }
  for (const key of outputKeys) {
    assert(allowedKeys.includes(key), `unexpected top-level field "${key}"`);
  }

  const status = output.status;
  assert(
    status === "completed" ||
      status === "blocked" ||
      status === "needs_decision" ||
      status === "error",
    "status must be one of completed|blocked|needs_decision|error"
  );
  assert(typeof output.summary === "string" && output.summary.trim().length > 0, "summary is required");
  assert(
    typeof output.workstream_id === "string" && output.workstream_id.trim().length > 0,
    "workstream_id is required"
  );

  const decisions = Array.isArray(output.decisions_needed) ? output.decisions_needed : [];
  const blockingDecisions = decisions.filter(
    (decision) => isObject(decision) && decision.blocking === true
  );
  for (const decision of decisions) {
    assert(isObject(decision), "decisions_needed entries must be objects");
    assertKnownFields(decision, ["question", "summary", "options", "urgency", "blocking"], "decision");
    assert(typeof decision.question === "string" && decision.question.trim().length > 0, "decision.question is required");
    assertOptionalString(decision.summary, "decision.summary");
    assertStringArrayOrNull(decision.options, "decision.options");
    assert(
      ["low", "medium", "high", "urgent", null].includes(decision.urgency ?? null),
      "decision.urgency must be low|medium|high|urgent|null"
    );
    assert(typeof decision.blocking === "boolean", "decision.blocking must be explicit true/false");
  }

  if (status === "completed") {
    assert(
      blockingDecisions.length === 0,
      "completed status is invalid when any decisions_needed entry is blocking=true"
    );
  }
  if (status === "blocked" || status === "needs_decision" || status === "error") {
    assert(
      blockingDecisions.length > 0,
      `${status} status requires at least one decisions_needed entry with blocking=true`
    );
  }

  const artifacts = Array.isArray(output.artifacts) ? output.artifacts : [];
  const taskUpdates = Array.isArray(output.task_updates) ? output.task_updates : [];
  const milestoneUpdates = Array.isArray(output.milestone_updates) ? output.milestone_updates : [];
  const hasOutcome = artifacts.length > 0 || taskUpdates.length > 0 || milestoneUpdates.length > 0;
  if (status === "completed") {
    assert(hasOutcome, "completed status requires artifacts/task_updates/milestone_updates");
  }

  for (const artifact of artifacts) {
    assert(isObject(artifact), "artifacts entries must be objects");
    assertKnownFields(
      artifact,
      [
        "name",
        "artifact_type",
        "confidence_score",
        "description",
        "url",
        "verification_steps",
        "milestone_id",
        "task_ids",
      ],
      "artifact"
    );
    assert(typeof artifact.name === "string" && artifact.name.trim().length > 0, "artifact.name is required");
    assert(
      [
        "pr",
        "commit",
        "document",
        "config",
        "report",
        "design",
        "retro",
        "other",
      ].includes(artifact.artifact_type),
      "artifact.artifact_type must be one of: pr|commit|document|config|report|design|retro|other"
    );
    const confidence = artifact.confidence_score;
    assert(
      confidence == null || (typeof confidence === "number" && confidence >= 0 && confidence <= 1),
      "artifact.confidence_score must be null or a number in [0,1]"
    );
    assertOptionalString(artifact.description, "artifact.description");
    assertOptionalString(artifact.url, "artifact.url");
    assertOptionalString(artifact.milestone_id, "artifact.milestone_id");
    assertStringArrayOrNull(artifact.task_ids, "artifact.task_ids");
    if (Array.isArray(artifact.verification_steps)) {
      for (const step of artifact.verification_steps) {
        assert(typeof step === "string" && step.trim().length > 0, "artifact.verification_steps must contain non-empty strings");
      }
    } else {
      assert(artifact.verification_steps == null, "artifact.verification_steps must be an array or null");
    }
  }

  const skillEvidence = Array.isArray(output.skill_evidence) ? output.skill_evidence : [];
  for (const item of skillEvidence) {
    assert(isObject(item), "skill_evidence entries must be objects");
    assertKnownFields(item, ["skill", "skill_file", "skill_sha256", "skill_heading"], "skill_evidence");
    assert(typeof item.skill === "string" && item.skill.trim().length > 0, "skill_evidence.skill is required");
    assert(
      !item.skill.trim().startsWith("$"),
      "skill_evidence.skill must be the bare skill id without a leading \"$\""
    );
    assert(
      typeof item.skill_file === "string" && item.skill_file.trim().length > 0,
      "skill_evidence.skill_file is required"
    );
    assert(
      typeof item.skill_sha256 === "string" && /^[a-f0-9]{64}$/.test(item.skill_sha256),
      "skill_evidence.skill_sha256 must be a lowercase sha256 hex string"
    );
    assert(
      typeof item.skill_heading === "string" && item.skill_heading.trim().length > 0,
      "skill_evidence.skill_heading is required"
    );
  }

  for (const taskUpdate of taskUpdates) {
    assert(isObject(taskUpdate), "task_updates entries must be objects");
    assertKnownFields(taskUpdate, ["task_id", "status", "reason"], "task_updates entry");
    assert(
      typeof taskUpdate.task_id === "string" && taskUpdate.task_id.trim().length > 0,
      "task_updates[].task_id is required"
    );
    assert(
      ["todo", "in_progress", "done", "blocked"].includes(taskUpdate.status),
      "task_updates[].status must be one of todo|in_progress|done|blocked"
    );
    assertOptionalString(taskUpdate.reason, "task_updates[].reason");
  }

  for (const milestoneUpdate of milestoneUpdates) {
    assert(isObject(milestoneUpdate), "milestone_updates entries must be objects");
    assertKnownFields(milestoneUpdate, ["milestone_id", "status", "reason"], "milestone_updates entry");
    assert(
      typeof milestoneUpdate.milestone_id === "string" &&
        milestoneUpdate.milestone_id.trim().length > 0,
      "milestone_updates[].milestone_id is required"
    );
    assert(
      ["planned", "in_progress", "completed", "at_risk", "cancelled"].includes(
        milestoneUpdate.status
      ),
      "milestone_updates[].status must be one of planned|in_progress|completed|at_risk|cancelled"
    );
    assertOptionalString(milestoneUpdate.reason, "milestone_updates[].reason");
  }

  if (requiredSkills.length > 0) {
    assert(Array.isArray(output.skill_evidence), "skill_evidence must be an array when ORGX_REQUIRED_SKILLS is set");
    const normalizedEvidence = skillEvidence.map((item) =>
      isObject(item) && typeof item.skill === "string" ? item.skill.replace(/^\$/, "").trim() : ""
    );
    const seen = new Map();
    for (const skill of normalizedEvidence) {
      if (!skill) continue;
      seen.set(skill, (seen.get(skill) || 0) + 1);
    }
    for (const requiredSkill of requiredSkills) {
      const count = seen.get(requiredSkill) || 0;
      assert(count === 1, `skill_evidence must include exactly one entry for required skill "${requiredSkill}"`);
    }
  }

  console.log("[verify] ok: autopilot slice output passed validation checks.");
  console.log(`[verify] output: ${resolve(outputPath)}`);
  console.log(`[verify] schema: ${schemaPath}`);
}

main();
