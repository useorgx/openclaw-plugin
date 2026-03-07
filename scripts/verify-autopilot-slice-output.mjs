#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

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

function canonicalizeSkillId(value) {
  return String(value || "")
    .trim()
    .replace(/^\$/, "")
    .toLowerCase();
}
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const SKILL_PARSE_STOPWORDS = new Set([
  "and",
  "context",
  "execution",
  "guidance",
  "initiative",
  "or",
  "optional",
  "optionally",
  "policy",
  "required",
  "reporting",
  "run",
  "slice",
  "skill",
  "skills",
  "workstream",
]);

function parseRequiredSkills(value) {
  const addSkill = (target, entry) => {
    const skill = String(entry || "")
      .trim()
      .replace(/^[-*•\s]+/, "")
      .replace(/["'`()[\]{}]/g, "")
      .replace(/^[A-Za-z]+\s*:\s*/, "")
      .replace(/[,:;.\s]+$/, "")
      .replace(/^\$/, "")
      .trim();
    if (!skill) return;
    if (SKILL_PARSE_STOPWORDS.has(skill.toLowerCase())) return;
    const canonical = canonicalizeSkillId(skill);
    if (canonical) target.add(canonical);
  };

  const unique = new Set();
  const raw = String(value || "").trim();
  if (!raw) return [];

  const multilineSegments = raw.split(/\r?\n/);
  const relevantMultilineSegments =
    multilineSegments.length > 1
      ? multilineSegments.filter((segment) => {
          const trimmed = segment.trim();
          if (!trimmed) return false;
          return (
            trimmed.includes("$") ||
            /^[-*•]\s*/.test(trimmed) ||
            /^required skills?\s*:/i.test(trimmed) ||
            /^skills?\s*:/i.test(trimmed)
          );
        })
      : [];
  const parseSource =
    relevantMultilineSegments.length > 0 ? relevantMultilineSegments.join("\n") : raw;

  const explicitSkillTokens = parseSource.match(/\$[A-Za-z0-9][A-Za-z0-9_-]*/g) ?? [];
  if (explicitSkillTokens.length > 0) {
    for (const token of explicitSkillTokens) {
      addSkill(unique, token);
    }
  }

  if (parseSource.startsWith("[") && parseSource.endsWith("]")) {
    try {
      const parsed = JSON.parse(parseSource);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          addSkill(unique, entry);
        }
        return [...unique];
      }
    } catch {
      // Fall back to whitespace/comma parsing below.
    }
  }

  for (const entry of parseSource.split(/[\s,;|]+/)) {
    addSkill(unique, entry);
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

function assertOptionalNonEmptyString(value, label) {
  if (value != null) {
    assert(
      typeof value === "string" && value.trim().length > 0,
      `${label} must be a non-empty string or null`
    );
  }
}

function assertMatchesEnv(expected, value, fieldName, envName) {
  if (!expected) return;
  assert(
    typeof value === "string" && value.trim().length > 0,
    `${fieldName} is required when ${envName} is set`
  );
  assert(
    value.trim() === expected,
    `${fieldName} must match ${envName} (${expected})`
  );
}

function matchOptionalContextFromEnv(value, fieldName, envNames) {
  for (const envName of envNames) {
    const expected = String(process.env[envName] || "").trim();
    assertMatchesEnv(expected, value, fieldName, envName);
  }
}

function assertStringArrayOrNull(value, label) {
  if (value == null) return;
  assert(Array.isArray(value), `${label} must be an array or null`);
  for (const item of value) {
    assert(
      typeof item === "string" && item.trim().length > 0,
      `${label} entries must be non-empty strings`
    );
  }
}

function assertNonEmptyStringArrayOrNull(value, label) {
  assertStringArrayOrNull(value, label);
  if (value != null) {
    assert(value.length > 0, `${label} must be a non-empty array or null`);
  }
}

function assertDecisionOptionsOrNull(value, label) {
  if (value == null) return;
  assert(Array.isArray(value), `${label} must be an array or null`);
  assert(value.length > 0, `${label} must be a non-empty array or null`);
  for (const entry of value) {
    if (typeof entry === "string") {
      assert(entry.trim().length > 0, `${label} entries must be non-empty strings`);
      continue;
    }
    assert(isObject(entry), `${label} entries must be non-empty strings or option objects`);
    assertKnownFields(
      entry,
      ["id", "label", "description", "consequences", "implied_status", "action_type", "requires_note"],
      "decision.options object"
    );
    assert(
      typeof entry.label === "string" && entry.label.trim().length > 0,
      "decision.options object.label is required"
    );
    assertOptionalNonEmptyString(entry.id, "decision.options object.id");
    assertOptionalNonEmptyString(entry.description, "decision.options object.description");
    assertOptionalNonEmptyString(entry.consequences, "decision.options object.consequences");
    assert(
      ["approved", "declined", "cancelled", "rejected", null].includes(entry.implied_status ?? null),
      "decision.options object.implied_status must be approved|declined|cancelled|rejected|null"
    );
    assertOptionalNonEmptyString(entry.action_type, "decision.options object.action_type");
    if (entry.requires_note != null) {
      assert(
        typeof entry.requires_note === "boolean",
        "decision.options object.requires_note must be boolean or null"
      );
    }
  }
}

function sha256File(pathname) {
  try {
    const stat = statSync(pathname);
    assert(stat.isFile(), `skill_evidence.skill_file must point to a readable file: ${pathname}`);
    const content = readFileSync(pathname);
    return createHash("sha256").update(content).digest("hex");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`cannot read skill file for verification at ${pathname}: ${message}`);
  }
}

function extractSkillHeading(pathname) {
  try {
    const content = readFileSync(pathname, "utf8").replace(/^\uFEFF/, "");
    const lines = content.split(/\r?\n/);
    // Ignore YAML frontmatter so heading/non-empty matching stays stable for skill files.
    let startIndex = 0;
    if (lines[0]?.trim() === "---") {
      startIndex = 1;
      let foundClosingFence = false;
      for (let index = 1; index < lines.length; index += 1) {
        const fence = lines[index].trim();
        if (fence === "---" || fence === "...") {
          startIndex = index + 1;
          foundClosingFence = true;
          break;
        }
      }
      // If frontmatter is malformed/unclosed, treat the opening fence as metadata.
      if (!foundClosingFence) startIndex = 1;
    }
    for (let index = startIndex; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) return trimmed;
    }
    for (let index = startIndex; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      if (trimmed.length > 0) return trimmed;
    }
    return "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`cannot read skill file heading at ${pathname}: ${message}`);
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
  matchOptionalContextFromEnv(output.workstream_id, "workstream_id", ["ORGX_WORKSTREAM_ID"]);
  assertOptionalNonEmptyString(output.workstream_title, "workstream_title");
  assertOptionalNonEmptyString(output.slice_id, "slice_id");
  matchOptionalContextFromEnv(output.slice_id, "slice_id", ["ORGX_SLICE_RUN_ID", "ORGX_SLICE_ID"]);

  assert(
    output.decisions_needed == null || Array.isArray(output.decisions_needed),
    "decisions_needed must be an array or null"
  );
  const decisions = Array.isArray(output.decisions_needed) ? output.decisions_needed : [];
  const blockingDecisions = decisions.filter(
    (decision) => isObject(decision) && decision.blocking === true
  );
  for (const decision of decisions) {
    assert(isObject(decision), "decisions_needed entries must be objects");
    assertKnownFields(decision, ["question", "summary", "options", "urgency", "blocking"], "decision");
    assert(typeof decision.question === "string" && decision.question.trim().length > 0, "decision.question is required");
    assertOptionalNonEmptyString(decision.summary, "decision.summary");
    assertDecisionOptionsOrNull(decision.options, "decision.options");
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
  if (blockingDecisions.length > 0) {
    assert(
      status === "blocked" || status === "needs_decision" || status === "error",
      "blocking decisions are only valid with blocked, needs_decision, or error status"
    );
  }

  assert(output.artifacts == null || Array.isArray(output.artifacts), "artifacts must be an array or null");
  assert(
    output.task_updates == null || Array.isArray(output.task_updates),
    "task_updates must be an array or null"
  );
  assert(
    output.milestone_updates == null || Array.isArray(output.milestone_updates),
    "milestone_updates must be an array or null"
  );
  const artifacts = Array.isArray(output.artifacts) ? output.artifacts : [];
  const taskUpdates = Array.isArray(output.task_updates) ? output.task_updates : [];
  const milestoneUpdates = Array.isArray(output.milestone_updates) ? output.milestone_updates : [];
  const taskUpdateIds = new Set();
  const milestoneUpdateIds = new Set();
  assertNonEmptyStringArrayOrNull(output.next_actions, "next_actions");
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
    assertOptionalNonEmptyString(artifact.description, "artifact.description");
    assert(
      typeof artifact.url === "string" && artifact.url.trim().length > 0,
      "artifact.url is required for verifiable artifacts"
    );
    assertOptionalNonEmptyString(artifact.milestone_id, "artifact.milestone_id");
    assertStringArrayOrNull(artifact.task_ids, "artifact.task_ids");
    assert(
      Array.isArray(artifact.verification_steps) && artifact.verification_steps.length > 0,
      "artifact.verification_steps must be a non-empty array for verifiable artifacts"
    );
    for (const step of artifact.verification_steps) {
      assert(
        typeof step === "string" && step.trim().length > 0,
        "artifact.verification_steps must contain non-empty strings"
      );
    }
  }

  assert(Array.isArray(output.skill_evidence), "skill_evidence must be an array");
  const skillEvidence = output.skill_evidence;
  assert(skillEvidence.length > 0, "skill_evidence must include at least one entry");
  const normalizedSkillCounts = new Map();
  for (const item of skillEvidence) {
    assert(isObject(item), "skill_evidence entries must be objects");
    assertKnownFields(item, ["skill", "skill_file", "skill_sha256", "skill_heading"], "skill_evidence");
    assert(typeof item.skill === "string" && item.skill.trim().length > 0, "skill_evidence.skill is required");
    assert(
      !item.skill.trim().startsWith("$"),
      "skill_evidence.skill must be the bare skill id without a leading \"$\""
    );
    const normalizedSkill = canonicalizeSkillId(item.skill);
    assert(
      SKILL_ID_PATTERN.test(normalizedSkill),
      "skill_evidence.skill must match ^[a-z0-9][a-z0-9_-]*$ (lowercase letters, numbers, underscores, hyphens)"
    );
    assert(
      typeof item.skill_file === "string" && item.skill_file.trim().length > 0,
      "skill_evidence.skill_file is required"
    );
    assert(
      isAbsolute(item.skill_file),
      "skill_evidence.skill_file must be an absolute path"
    );
    assert(
      typeof item.skill_sha256 === "string" && /^[a-f0-9]{64}$/.test(item.skill_sha256),
      "skill_evidence.skill_sha256 must be a lowercase sha256 hex string"
    );
    assert(
      typeof item.skill_heading === "string" && item.skill_heading.trim().length > 0,
      "skill_evidence.skill_heading is required"
    );
    const skillFilePath = resolve(item.skill_file);
    const actualDigest = sha256File(skillFilePath);
    assert(
      actualDigest === item.skill_sha256,
      `skill_evidence.skill_sha256 does not match file digest for ${skillFilePath}`
    );
    const expectedHeading = extractSkillHeading(skillFilePath);
    assert(expectedHeading.length > 0, `skill_evidence.skill_file has no readable heading content: ${skillFilePath}`);
    assert(
      item.skill_heading.trim() === expectedHeading,
      `skill_evidence.skill_heading must match the first heading/non-empty line in ${skillFilePath}`
    );
    normalizedSkillCounts.set(normalizedSkill, (normalizedSkillCounts.get(normalizedSkill) || 0) + 1);
  }

  for (const [skill, count] of normalizedSkillCounts.entries()) {
    assert(count === 1, `skill_evidence contains duplicate entries for skill "${skill}"`);
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
    assertOptionalNonEmptyString(taskUpdate.reason, "task_updates[].reason");
    const taskId = taskUpdate.task_id.trim();
    assert(
      !taskUpdateIds.has(taskId),
      `task_updates contains duplicate task_id "${taskId}"`
    );
    taskUpdateIds.add(taskId);
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
    assertOptionalNonEmptyString(milestoneUpdate.reason, "milestone_updates[].reason");
    const milestoneId = milestoneUpdate.milestone_id.trim();
    assert(
      !milestoneUpdateIds.has(milestoneId),
      `milestone_updates contains duplicate milestone_id "${milestoneId}"`
    );
    milestoneUpdateIds.add(milestoneId);
  }

  if (requiredSkills.length > 0) {
    for (const requiredSkill of requiredSkills) {
      const count = normalizedSkillCounts.get(requiredSkill) || 0;
      assert(count === 1, `skill_evidence must include exactly one entry for required skill "${requiredSkill}"`);
    }
  }

  console.log("[verify] ok: autopilot slice output passed validation checks.");
  console.log(`[verify] output: ${resolve(outputPath)}`);
  console.log(`[verify] schema: ${schemaPath}`);
}

main();
