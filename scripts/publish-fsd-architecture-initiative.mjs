#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { OrgXClient } from "../dist/api.js";
import { readPersistedAuth } from "../dist/auth-store.js";
import { registerArtifact } from "../dist/artifacts/register-artifact.js";

const DEFAULT_BASE_URL = "https://www.useorgx.com";
const DEFAULT_WORKSPACE_ID = "7af01a51-49b1-47d8-98b9-91a198debca8";
const PLAN_VERSION = "fsd-orchestrator-architecture-v1";

const INITIATIVE = {
  title: "OrgX FSD Orchestrator Re-Architecture (Single Authority v1)",
  summary:
    "Single-authority orchestration migration: Code/orgx kernel + Postgres event ledger + deterministic projections. See docs: docs/adr/adr-0002-orchestrator-single-authority-control-plane.json, docs/product/orgx-fsd-orchestrator-architecture-v1.md, docs/product/orgx-fsd-orchestrator-verification-matrix-v1.md",
  status: "draft",
};

const WORKSTREAMS = [
  {
    title: "W1 Experience Surface (Projection-Only UI)",
    summary:
      "Render canonical projection rows only and remove lifecycle derivation from client presentation paths.",
  },
  {
    title: "W2 Public APIs (Command/Query Split + Idempotency)",
    summary:
      "Introduce strict command/query API split with idempotency semantics and projection envelopes.",
  },
  {
    title: "W3 Orchestration Kernel (Reconciliation + State Machine)",
    summary:
      "Implement single-authority orchestration loop with explicit run/slice state machine and retry scheduler.",
  },
  {
    title: "W4 Event Ledger and Projections (Postgres Authoritative State)",
    summary:
      "Persist orchestration events in append-only ledger and build deterministic Next Up/In Progress/Activity/Completed projections.",
  },
  {
    title: "W5 Execution Fabric (Executor Adapters + Lifecycle Contract)",
    summary:
      "Normalize executor integration behind adapter contract with heartbeat, status, and termination guarantees.",
  },
  {
    title: "W6 Observability and Verification (SLOs + Shadow Cutover Gates)",
    summary:
      "Enforce invariants, latency SLOs, shadow comparator thresholds, and rollback drills before cutover.",
  },
];

const MILESTONES = [
  { title: "M1 Spec and Contracts", summary: "Lock interface, state, and acceptance contracts." },
  { title: "M2 Build and Integrate", summary: "Implement canonical runtime path for this layer." },
  {
    title: "M3 Verify and Cutover Readiness",
    summary: "Run verification gates and produce evidence for cutover.",
  },
];

const TASKS = [
  {
    title: "T1 Define interface/state contract",
    summary: "Write concrete schema/interface and lifecycle contracts for this milestone.",
    priority: "high",
  },
  {
    title: "T2 Implement canonical path",
    summary: "Build and integrate the canonical implementation path for this milestone.",
    priority: "high",
  },
  {
    title: "T3 Add invariant/contract tests",
    summary: "Add automated tests that enforce invariants and API contracts.",
    priority: "high",
  },
  {
    title: "T4 Produce verification evidence + gate result",
    summary: "Attach evidence artifacts and record gate pass/fail outcome.",
    priority: "medium",
  },
];

const DOC_ARTIFACTS = [
  {
    name: "ADR-0002 Single Authority Control Plane",
    path: "docs/adr/adr-0002-orchestrator-single-authority-control-plane.json",
    description:
      "Accepted architectural decision for control-plane ownership, event ledger strategy, and rollout mode.",
  },
  {
    name: "FSD Orchestrator Architecture v1",
    path: "docs/product/orgx-fsd-orchestrator-architecture-v1.md",
    description:
      "Decision-complete architecture blueprint, state machines, APIs, migration phases, and SLO targets.",
  },
  {
    name: "FSD Orchestrator Verification Matrix v1",
    path: "docs/product/orgx-fsd-orchestrator-verification-matrix-v1.md",
    description:
      "Invariant, contract, chaos, e2e, shadow comparator, and rollback verification matrix.",
  },
];

function normalize(input) {
  return String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function asString(record, ...keys) {
  if (!record || typeof record !== "object") return "";
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function readCredentials() {
  const envApiKey = String(process.env.ORGX_API_KEY || "").trim();
  const envBaseUrl = String(process.env.ORGX_BASE_URL || "").trim();
  const envUserId = String(process.env.ORGX_USER_ID || "").trim();
  if (envApiKey) {
    return {
      apiKey: envApiKey,
      baseUrl: envBaseUrl || DEFAULT_BASE_URL,
      userId: envUserId || "",
      source: "env",
    };
  }

  const persisted = readPersistedAuth();
  if (!persisted?.apiKey) {
    throw new Error("No OrgX API key found. Set ORGX_API_KEY or connect plugin onboarding.");
  }
  return {
    apiKey: persisted.apiKey,
    baseUrl: DEFAULT_BASE_URL,
    userId: String(persisted.userId || ""),
    source: "persisted_auth",
  };
}

async function listScopedEntities(client, type, initiativeId, workspaceId) {
  const response = await client.listEntities(type, {
    initiative_id: initiativeId,
    workspace_id: workspaceId,
    command_center_id: workspaceId,
    limit: 2000,
  });
  return Array.isArray(response?.data) ? response.data : [];
}

async function main() {
  const dryRun = String(process.env.ORGX_DRY_RUN || "").trim() === "1";
  const allowWrite = String(process.env.ORGX_E2E_ALLOW_WRITE || "").trim() === "1";
  if (!dryRun && !allowWrite) {
    throw new Error("Refusing to write. Set ORGX_E2E_ALLOW_WRITE=1 or ORGX_DRY_RUN=1.");
  }

  const workspaceId = String(process.env.ORGX_WORKSPACE_ID || DEFAULT_WORKSPACE_ID).trim();
  if (!workspaceId) throw new Error("workspace_id is required.");

  const credentials = readCredentials();
  const client = new OrgXClient(credentials.apiKey, credentials.baseUrl, credentials.userId);
  const createdAt = new Date().toISOString();
  const dateStamp = createdAt.slice(0, 10);

  const existingInitiatives = await listScopedEntities(client, "initiative", undefined, workspaceId);
  let initiative =
    existingInitiatives.find((row) => normalize(asString(row, "title", "name")) === normalize(INITIATIVE.title)) ||
    null;

  if (!initiative && !dryRun) {
    initiative = await client.createEntity("initiative", {
      title: INITIATIVE.title,
      summary: INITIATIVE.summary,
      status: INITIATIVE.status,
      workspace_id: workspaceId,
      command_center_id: workspaceId,
      sequence: 1,
      metadata: {
        plan_version: PLAN_VERSION,
        source: "docs-publication",
        sequence: 1,
      },
    });
  }
  if (!initiative) {
    initiative = {
      id: "dry-run-initiative",
      title: INITIATIVE.title,
      status: INITIATIVE.status,
    };
  }

  const initiativeId = asString(initiative, "id");
  if (!initiativeId) throw new Error("Failed to resolve initiative ID.");
  const canQueryScoped = isUuid(initiativeId);

  let existingWorkstreams = canQueryScoped
    ? await listScopedEntities(client, "workstream", initiativeId, workspaceId)
    : [];
  let existingMilestones = canQueryScoped
    ? await listScopedEntities(client, "milestone", initiativeId, workspaceId)
    : [];
  let existingTasks = canQueryScoped
    ? await listScopedEntities(client, "task", initiativeId, workspaceId)
    : [];
  let existingArtifacts = canQueryScoped
    ? await listScopedEntities(client, "artifact", initiativeId, workspaceId)
    : [];

  const workstreamRows = [];
  const milestoneRows = [];
  const taskRows = [];
  const artifactRows = [];

  for (const [wsIndex, wsSpec] of WORKSTREAMS.entries()) {
    const wsSequence = wsIndex + 1;
    const wsExisting =
      existingWorkstreams.find(
        (row) => normalize(asString(row, "title", "name")) === normalize(wsSpec.title)
      ) || null;

    let workstream = wsExisting;
    if (!workstream && !dryRun) {
      workstream = await client.createEntity("workstream", {
        title: wsSpec.title,
        summary: wsSpec.summary,
        status: "not_started",
        initiative_id: initiativeId,
        workspace_id: workspaceId,
        command_center_id: workspaceId,
        sequence: wsSequence,
        metadata: {
          sequence: wsSequence,
          layer: `L${wsSequence}`,
          plan_version: PLAN_VERSION,
        },
      });
      existingWorkstreams.push(workstream);
    }
    if (!workstream) {
      workstream = { id: `dry-run-ws-${wsSequence}`, title: wsSpec.title };
    }

    const workstreamId = asString(workstream, "id");
    workstreamRows.push({
      id: workstreamId,
      title: asString(workstream, "title", "name") || wsSpec.title,
      sequence: wsSequence,
    });

    for (const [msIndex, msSpec] of MILESTONES.entries()) {
      const msSequence = msIndex + 1;
      const msExisting =
        existingMilestones.find(
          (row) =>
            asString(row, "workstream_id", "workstreamId") === workstreamId &&
            normalize(asString(row, "title", "name")) === normalize(msSpec.title)
        ) || null;

      let milestone = msExisting;
      if (!milestone && !dryRun) {
        milestone = await client.createEntity("milestone", {
          title: msSpec.title,
          summary: `${msSpec.summary} (${wsSpec.title})`,
          status: "planned",
          initiative_id: initiativeId,
          workstream_id: workstreamId,
          workspace_id: workspaceId,
          command_center_id: workspaceId,
          sequence: msSequence,
          metadata: {
            sequence: msSequence,
            plan_version: PLAN_VERSION,
          },
        });
        existingMilestones.push(milestone);
      }
      if (!milestone) {
        milestone = { id: `dry-run-ms-${wsSequence}-${msSequence}`, title: msSpec.title };
      }

      const milestoneId = asString(milestone, "id");
      milestoneRows.push({
        id: milestoneId,
        title: asString(milestone, "title", "name") || msSpec.title,
        workstream_id: workstreamId,
        sequence: msSequence,
      });

      for (const [taskIndex, taskSpec] of TASKS.entries()) {
        const taskSequence = taskIndex + 1;
        const taskExisting =
          existingTasks.find(
            (row) =>
              asString(row, "workstream_id", "workstreamId") === workstreamId &&
              asString(row, "milestone_id", "milestoneId") === milestoneId &&
              normalize(asString(row, "title", "name")) === normalize(taskSpec.title)
          ) || null;

        let task = taskExisting;
        if (!task && !dryRun) {
          task = await client.createEntity("task", {
            title: taskSpec.title,
            summary: `${taskSpec.summary} (${wsSpec.title} / ${msSpec.title})`,
            status: "todo",
            priority: taskSpec.priority,
            initiative_id: initiativeId,
            workstream_id: workstreamId,
            milestone_id: milestoneId,
            workspace_id: workspaceId,
            command_center_id: workspaceId,
            sequence: taskSequence,
            metadata: {
              sequence: taskSequence,
              plan_version: PLAN_VERSION,
              verification_gate: taskIndex === 3,
            },
          });
          existingTasks.push(task);
        }
        if (!task) {
          task = { id: `dry-run-task-${wsSequence}-${msSequence}-${taskSequence}`, title: taskSpec.title };
        }

        taskRows.push({
          id: asString(task, "id"),
          title: asString(task, "title", "name") || taskSpec.title,
          workstream_id: workstreamId,
          milestone_id: milestoneId,
          sequence: taskSequence,
        });
      }
    }
  }

  for (const artifactSpec of DOC_ARTIFACTS) {
    const artifactExisting =
      existingArtifacts.find((row) => {
        const name = asString(row, "name", "title");
        const entityType = asString(row, "entity_type", "entityType");
        const entityId = asString(row, "entity_id", "entityId");
        return (
          normalize(name) === normalize(artifactSpec.name) &&
          entityType === "initiative" &&
          entityId === initiativeId
        );
      }) || null;

    if (artifactExisting || dryRun) {
      artifactRows.push({
        id: asString(artifactExisting ?? {}, "id"),
        name: artifactSpec.name,
        status: artifactExisting ? "existing" : "dry-run",
      });
      continue;
    }

    const artifactResult = await registerArtifact(client, credentials.baseUrl, {
      entity_type: "initiative",
      entity_id: initiativeId,
      name: artifactSpec.name,
      artifact_type: "shared.project_handbook",
      description: artifactSpec.description,
      preview_markdown: `Path: ${artifactSpec.path}\n\nPlan version: ${PLAN_VERSION}`,
      status: "approved",
      confidence_score: 0.99,
      metadata: {
        plan_version: PLAN_VERSION,
        source_doc_path: artifactSpec.path,
        workspace_id: workspaceId,
      },
      validate_persistence: true,
    });

    artifactRows.push({
      id: artifactResult.artifact_id,
      name: artifactSpec.name,
      status: artifactResult.ok ? "created" : "failed",
      warnings: artifactResult.warnings,
    });
  }

  const verifyWorkstreams = canQueryScoped
    ? await listScopedEntities(client, "workstream", initiativeId, workspaceId)
    : [];
  const verifyMilestones = canQueryScoped
    ? await listScopedEntities(client, "milestone", initiativeId, workspaceId)
    : [];
  const verifyTasks = canQueryScoped
    ? await listScopedEntities(client, "task", initiativeId, workspaceId)
    : [];
  const verifyArtifacts = canQueryScoped
    ? await listScopedEntities(client, "artifact", initiativeId, workspaceId)
    : [];

  const milestoneCountByWorkstream = new Map();
  for (const row of verifyMilestones) {
    const wsId = asString(row, "workstream_id", "workstreamId");
    if (!wsId) continue;
    milestoneCountByWorkstream.set(wsId, (milestoneCountByWorkstream.get(wsId) || 0) + 1);
  }

  const taskCountByMilestone = new Map();
  for (const row of verifyTasks) {
    const msId = asString(row, "milestone_id", "milestoneId");
    if (!msId) continue;
    taskCountByMilestone.set(msId, (taskCountByMilestone.get(msId) || 0) + 1);
  }

  const pass = {
    workstream_count: verifyWorkstreams.length === 6,
    milestone_count: verifyMilestones.length === 18,
    task_count: verifyTasks.length === 72,
    docs_artifacts_present:
      DOC_ARTIFACTS.every((spec) =>
        verifyArtifacts.some(
          (row) =>
            normalize(asString(row, "name", "title")) === normalize(spec.name) &&
            asString(row, "entity_type", "entityType") === "initiative" &&
            asString(row, "entity_id", "entityId") === initiativeId
        )
      ),
  };

  const entityMap = {
    generated_at: createdAt,
    dry_run: dryRun,
    workspace_id: workspaceId,
    initiative_id: initiativeId,
    initiative_title: INITIATIVE.title,
    workstreams: workstreamRows,
    milestones: milestoneRows,
    tasks: taskRows,
    artifacts: artifactRows,
    verification: {
      counts: {
        workstreams: verifyWorkstreams.length,
        milestones: verifyMilestones.length,
        tasks: verifyTasks.length,
      },
      expected: {
        workstreams: 6,
        milestones: 18,
        tasks: 72,
      },
      pass,
      milestone_count_by_workstream: Object.fromEntries(milestoneCountByWorkstream),
      task_count_by_milestone: Object.fromEntries(taskCountByMilestone),
    },
  };

  const reportJsonPath = resolve(
    `docs/reports/fsd-architecture-orgx-entity-map-${dateStamp}.json`
  );
  const reportMdPath = resolve(
    `docs/reports/fsd-architecture-publication-verification-${dateStamp}.md`
  );

  await mkdir(dirname(reportJsonPath), { recursive: true });
  await writeFile(reportJsonPath, `${JSON.stringify(entityMap, null, 2)}\n`, "utf8");

  const md = [
    "# FSD Architecture Publication Verification",
    "",
    `Generated at: ${createdAt}`,
    `Workspace: ${workspaceId}`,
    `Initiative: ${INITIATIVE.title} (${initiativeId})`,
    `Dry run: ${dryRun ? "yes" : "no"}`,
    "",
    "## Verification Results",
    "",
    `- Workstreams: ${verifyWorkstreams.length} (expected 6)`,
    `- Milestones: ${verifyMilestones.length} (expected 18)`,
    `- Tasks: ${verifyTasks.length} (expected 72)`,
    `- Docs artifacts attached: ${pass.docs_artifacts_present ? "yes" : "no"}`,
    "",
    "## Pass/Fail",
    "",
    `- workstream_count: ${pass.workstream_count ? "PASS" : "FAIL"}`,
    `- milestone_count: ${pass.milestone_count ? "PASS" : "FAIL"}`,
    `- task_count: ${pass.task_count ? "PASS" : "FAIL"}`,
    `- docs_artifacts_present: ${pass.docs_artifacts_present ? "PASS" : "FAIL"}`,
    "",
    "## Evidence",
    "",
    `- Entity map: docs/reports/fsd-architecture-orgx-entity-map-${dateStamp}.json`,
    `- Architecture ADR: docs/adr/adr-0002-orchestrator-single-authority-control-plane.json`,
    `- Architecture spec: docs/product/orgx-fsd-orchestrator-architecture-v1.md`,
    `- Verification matrix: docs/product/orgx-fsd-orchestrator-verification-matrix-v1.md`,
    "",
  ].join("\n");
  await writeFile(reportMdPath, md, "utf8");

  console.log(JSON.stringify(entityMap.verification, null, 2));
  console.log(`Report JSON: ${reportJsonPath}`);
  console.log(`Report MD: ${reportMdPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
