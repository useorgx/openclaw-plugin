import { appendToOutbox } from "../../outbox.js";
import { registerArtifact } from "../../artifacts/register-artifact.js";
import type { OrgXClient } from "../../api.js";
import type { LiveActivityItem } from "../../types.js";
import type { upsertAgentRun as upsertAgentRunType } from "../../agent-run-store.js";

type AutopilotSliceArtifact = {
  name: string;
  artifact_type?: string | null;
  confidence_score?: number | null;
  description?: string | null;
  url?: string | null;
  verification_steps?: string[] | null;
  milestone_id?: string | null;
  task_ids?: string[] | null;
};

type CreateAutopilotOperationsDeps = {
  client: OrgXClient;
  randomUUID: () => string;
  safeErrorMessage: (err: unknown) => string;
  idempotencyKey: (parts: Array<string | null | undefined>) => string;
  resolveDispatchExecutionPolicy: (input: {
    initiativeId: string | null;
    initiativeTitle?: string | null;
    workstreamId?: string | null;
    workstreamTitle?: string | null;
    taskId?: string | null;
    taskTitle?: string | null;
    message?: string | null;
  }) => Promise<{
    executionPolicy: { domain: string; requiredSkills: string[] };
    taskTitle: string | null;
    workstreamTitle: string | null;
  }>;
  enforceSpawnGuardForDispatch: (input: {
    sourceEventPrefix: string;
    initiativeId: string | null;
    correlationId: string;
    runId?: string | null;
    executionPolicy: { domain: string; requiredSkills: string[] };
    agentId?: string | null;
    taskId?: string | null;
    taskTitle?: string | null;
    workstreamId?: string | null;
    workstreamTitle?: string | null;
    milestoneId?: string | null;
  }) => Promise<{
    allowed: boolean;
    retryable: boolean;
    blockedReason: string | null;
    spawnGuardResult: unknown | null;
  }>;
  buildPolicyEnforcedMessage: (input: {
    baseMessage: string;
    executionPolicy: { domain: string; requiredSkills: string[] };
    spawnGuardResult?: unknown | null;
  }) => string;
  syncParentRollupsForTask: (input: {
    initiativeId: string | null;
    taskId: string | null;
    workstreamId?: string | null;
    milestoneId?: string | null;
    correlationId?: string | null;
  }) => Promise<void>;
  emitActivitySafe: (input: {
    initiativeId: string | null;
    runId?: string | null;
    correlationId?: string | null;
    phase: "intent" | "execution" | "blocked" | "review" | "handoff" | "completed";
    message: string;
    level?: "info" | "warn" | "error";
    progressPct?: number;
    nextStep?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  extractSpawnGuardModelTier: (result: unknown) => string | null;
  upsertAgentContext: (input: {
    agentId: string;
    initiativeId: string | null;
    initiativeTitle?: string | null;
    workstreamId?: string | null;
    taskId?: string | null;
  }) => unknown;
  upsertRunContext: (input: {
    runId: string;
    agentId: string;
    initiativeId: string | null;
    initiativeTitle?: string | null;
    workstreamId?: string | null;
    taskId?: string | null;
  }) => unknown;
  spawnAgentTurn: (input: {
    agentId: string;
    sessionId: string;
    message: string;
  }) => { pid: number | null };
  upsertAgentRun: typeof upsertAgentRunType;
};

export function createAutopilotOperations(deps: CreateAutopilotOperationsDeps) {
  async function registerArtifactSafe(input: {
    initiativeId: string;
    runId: string;
    agentId: string;
    agentName?: string | null;
    workstreamId: string;
    artifact: AutopilotSliceArtifact;
  }): Promise<{ ok: boolean; id: string | null }> {
    const now = new Date().toISOString();
    const name = (input.artifact.name ?? "").trim();
    if (!name) return { ok: false, id: null };
    const artifactType = (input.artifact.artifact_type ?? "other").trim() || "other";
    const confidenceScore =
      typeof input.artifact.confidence_score === "number" &&
      Number.isFinite(input.artifact.confidence_score) &&
      input.artifact.confidence_score >= 0 &&
      input.artifact.confidence_score <= 1
        ? input.artifact.confidence_score
        : null;
    const artifactId = deps.randomUUID();

    const verificationSteps = Array.isArray(input.artifact.verification_steps)
      ? input.artifact.verification_steps
          .filter((step) => typeof step === "string")
          .map((step) => step.trim())
          .filter(Boolean)
      : [];

    const descriptionParts: string[] = [];
    if (typeof input.artifact.description === "string" && input.artifact.description.trim()) {
      descriptionParts.push(input.artifact.description.trim());
    }
    if (verificationSteps.length > 0) {
      descriptionParts.push(
        `Verification:\n${verificationSteps.map((step) => `- ${step}`).join("\n")}`
      );
    }
    const description = descriptionParts.length > 0 ? descriptionParts.join("\n\n") : undefined;

    const hasUuidAgent =
      typeof input.agentId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.agentId
      );
    const createdByType = hasUuidAgent ? "agent" : "human";
    const createdById = hasUuidAgent ? input.agentId : null;

    try {
      const entityType = input.artifact.milestone_id ? "milestone" : "initiative";
      const entityId = input.artifact.milestone_id ? input.artifact.milestone_id : input.initiativeId;
      const result = await registerArtifact(deps.client as any, deps.client.getBaseUrl(), {
        artifact_id: artifactId,
        entity_type: entityType as any,
        entity_id: entityId,
        name,
        artifact_type: artifactType,
        confidence_score: confidenceScore,
        created_by_type: createdByType,
        created_by_id: createdById,
        description,
        external_url: input.artifact.url ?? null,
        preview_markdown: null,
        status: "draft",
        metadata: {
          source: "autopilot_slice",
          artifact_id: artifactId,
          run_id: input.runId,
          initiative_id: input.initiativeId,
          workstream_id: input.workstreamId,
          milestone_id: input.artifact.milestone_id ?? null,
          task_ids: input.artifact.task_ids ?? null,
          confidence_score: confidenceScore,
        },
        // Make persistence validation opt-in to avoid adding latency to every slice by default.
        validate_persistence: process.env.ORGX_VALIDATE_ARTIFACT_PERSISTENCE === "1",
      });

      return { ok: result.ok, id: result.artifact_id };
    } catch (err: unknown) {
      try {
        await appendToOutbox(input.initiativeId, {
          id: deps.randomUUID(),
          type: "artifact",
          timestamp: now,
          payload: {
            artifact_id: artifactId,
            entity_type: input.artifact.milestone_id ? "milestone" : "initiative",
            entity_id: input.artifact.milestone_id ?? input.initiativeId,
            name,
            artifact_type: artifactType,
            confidence_score: confidenceScore,
            created_by_type: createdByType,
            created_by_id: createdById,
            description,
            url: input.artifact.url ?? undefined,
            run_id: input.runId,
          },
          activityItem: {
            id: deps.randomUUID(),
            type: "artifact_created",
            title: name,
            description: description ?? null,
            agentId: input.agentId,
            agentName: input.agentName ?? null,
            requesterAgentId: input.agentId,
            requesterAgentName: input.agentName ?? null,
            executorAgentId: input.agentId,
            executorAgentName: input.agentName ?? null,
            runId: input.runId,
            initiativeId: input.initiativeId,
            timestamp: now,
            phase: "handoff",
            summary: input.artifact.url ?? null,
            metadata: {
              source: "openclaw_local_fallback",
              event: "autopilot_slice_artifact_buffered",
              artifact_type: artifactType,
              confidence_score: confidenceScore,
              artifact_id: artifactId,
              url: input.artifact.url ?? null,
              error: deps.safeErrorMessage(err),
            },
          } satisfies LiveActivityItem,
        });
      } catch {
        // best effort
      }
      return { ok: false, id: null };
    }
  }

  async function applyAgentStatusUpdatesSafe(input: {
    initiativeId: string;
    runId: string;
    correlationId: string;
    taskUpdates: Array<{ task_id: string; status: string; reason?: string | null }>;
    milestoneUpdates: Array<{ milestone_id: string; status: string; reason?: string | null }>;
  }): Promise<{
    applied: number;
    buffered: boolean;
    taskUpdates: Array<{ taskId: string; status: string; reason: string | null }>;
    milestoneUpdates: Array<{ milestoneId: string; status: string; reason: string | null }>;
  }> {
    const normalizeTaskStatus = (raw: string): string | null => {
      const normalized = raw.trim().toLowerCase().replace(/\s+/g, "_");
      if (!normalized) return null;
      if (normalized === "done") return "done";
      if (normalized === "todo") return "todo";
      if (normalized === "blocked") return "blocked";
      if (normalized === "in_progress") return "in_progress";
      // Common synonyms from LMs.
      if (normalized === "completed" || normalized === "complete" || normalized === "finished") {
        return "done";
      }
      if (normalized === "inprogress" || normalized === "running" || normalized === "working") {
        return "in_progress";
      }
      if (normalized === "not_started" || normalized === "planned" || normalized === "pending") {
        return "todo";
      }
      return null;
    };

    const normalizeMilestoneStatus = (raw: string): string | null => {
      const normalized = raw.trim().toLowerCase().replace(/\s+/g, "_");
      if (!normalized) return null;
      if (normalized === "planned") return "planned";
      if (normalized === "in_progress") return "in_progress";
      if (normalized === "completed") return "completed";
      if (normalized === "at_risk") return "at_risk";
      if (normalized === "cancelled") return "cancelled";
      // Common synonyms from LMs.
      if (normalized === "done" || normalized === "complete" || normalized === "finished") {
        return "completed";
      }
      if (normalized === "inprogress" || normalized === "running" || normalized === "working") {
        return "in_progress";
      }
      if (normalized === "todo" || normalized === "not_started" || normalized === "pending") {
        return "planned";
      }
      if (normalized === "blocked" || normalized === "stuck") {
        return "at_risk";
      }
      return null;
    };

    const operations: Array<Record<string, unknown>> = [];
    const normalizedTaskUpdates: Array<{ taskId: string; status: string; reason: string | null }> = [];
    const normalizedMilestoneUpdates: Array<{
      milestoneId: string;
      status: string;
      reason: string | null;
    }> = [];

    for (const update of input.taskUpdates) {
      const taskId = (update?.task_id ?? "").trim();
      const status = normalizeTaskStatus(update?.status ?? "");
      if (!taskId || !status) continue;
      normalizedTaskUpdates.push({
        taskId,
        status,
        reason: typeof update?.reason === "string" && update.reason.trim().length > 0 ? update.reason.trim() : null,
      });
      operations.push({ op: "task.update", task_id: taskId, status });
    }
    for (const update of input.milestoneUpdates) {
      const milestoneId = (update?.milestone_id ?? "").trim();
      const status = normalizeMilestoneStatus(update?.status ?? "");
      if (!milestoneId || !status) continue;
      normalizedMilestoneUpdates.push({
        milestoneId,
        status,
        reason:
          typeof update?.reason === "string" && update.reason.trim().length > 0
            ? update.reason.trim()
            : null,
      });
      operations.push({ op: "milestone.update", milestone_id: milestoneId, status });
    }

    if (operations.length === 0) {
      return {
        applied: 0,
        buffered: false,
        taskUpdates: [],
        milestoneUpdates: [],
      };
    }

    try {
      await deps.client.applyChangeset({
        initiative_id: input.initiativeId,
        run_id: input.runId,
        correlation_id: input.correlationId,
        source_client: "openclaw",
        idempotency_key: deps.idempotencyKey([
          "openclaw",
          "autopilot",
          "slice_status",
          input.initiativeId,
          input.correlationId,
        ]),
        operations: operations as any,
      });
      return {
        applied: operations.length,
        buffered: false,
        taskUpdates: normalizedTaskUpdates,
        milestoneUpdates: normalizedMilestoneUpdates,
      };
    } catch (err: unknown) {
      const timestamp = new Date().toISOString();
      try {
        await appendToOutbox(input.initiativeId, {
          id: deps.randomUUID(),
          type: "changeset",
          timestamp,
          payload: {
            initiative_id: input.initiativeId,
            correlation_id: input.correlationId,
            source_client: "openclaw",
            idempotency_key: deps.idempotencyKey([
              "openclaw",
              "autopilot",
              "slice_status",
              input.initiativeId,
              input.correlationId,
              "outbox",
            ]),
            operations,
          },
          activityItem: {
            id: deps.randomUUID(),
            type: "run_started",
            title: `Buffered status updates for slice ${input.runId}`,
            description: null,
            agentId: null,
            agentName: null,
            requesterAgentId: null,
            requesterAgentName: null,
            executorAgentId: null,
            executorAgentName: null,
            runId: input.runId,
            initiativeId: input.initiativeId,
            timestamp,
            phase: "review",
            summary: `Will apply ${operations.length} status update(s) when connected.`,
            metadata: {
              source: "openclaw_local_fallback",
              event: "autopilot_slice_status_updates_buffered",
              error: deps.safeErrorMessage(err),
            },
          } satisfies LiveActivityItem,
        });
      } catch {
        // best effort
      }
      return {
        applied: operations.length,
        buffered: true,
        taskUpdates: normalizedTaskUpdates,
        milestoneUpdates: normalizedMilestoneUpdates,
      };
    }
  }

  async function resolveAgentDisplayName(
    agentId: string,
    fallbackName?: string | null
  ): Promise<string | null> {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) return null;

    const normalizedFallback =
      typeof fallbackName === "string" && fallbackName.trim().length > 0
        ? fallbackName.trim()
        : null;
    return normalizedFallback ?? normalizedAgentId;
  }

  async function dispatchFallbackWorkstreamTurn(input: {
    initiativeId: string;
    initiativeTitle: string;
    workstreamId: string;
    workstreamTitle: string;
    agentId: string;
    agentName?: string | null;
    taskId?: string | null;
    taskTitle?: string | null;
  }): Promise<{
    sessionId: string | null;
    pid: number | null;
    blockedReason: string | null;
    retryable: boolean;
    executionPolicy: { domain: string; requiredSkills: string[] };
    spawnGuardResult: unknown | null;
  }> {
    const now = new Date().toISOString();
    const sessionId = deps.randomUUID();
    const taskId = input.taskId?.trim() || null;
    const taskTitle = input.taskTitle?.trim() || null;

    const policyResolution = await deps.resolveDispatchExecutionPolicy({
      initiativeId: input.initiativeId,
      initiativeTitle: input.initiativeTitle,
      workstreamId: input.workstreamId,
      workstreamTitle: input.workstreamTitle,
      taskId,
      taskTitle,
      message:
        "Continue this workstream from the latest context. Identify and execute the next concrete task.",
    });
    const executionPolicy = policyResolution.executionPolicy;
    const resolvedWorkstreamTitle =
      policyResolution.workstreamTitle ?? input.workstreamTitle;
    const resolvedTaskTitle = policyResolution.taskTitle ?? taskTitle;

    const guard = await deps.enforceSpawnGuardForDispatch({
      sourceEventPrefix: "next_up_fallback",
      initiativeId: input.initiativeId,
      correlationId: sessionId,
      runId: sessionId,
      executionPolicy,
      agentId: input.agentId,
      taskId,
      taskTitle: resolvedTaskTitle,
      workstreamId: input.workstreamId,
      workstreamTitle: resolvedWorkstreamTitle,
    });
    if (!guard.allowed) {
      return {
        sessionId: null,
        pid: null,
        blockedReason: guard.blockedReason,
        retryable: guard.retryable,
        executionPolicy,
        spawnGuardResult: guard.spawnGuardResult,
      };
    }

    const baseMessage = [
      `Initiative: ${input.initiativeTitle}`,
      `Workstream: ${resolvedWorkstreamTitle}`,
      taskId ? `Task: ${resolvedTaskTitle ?? taskId}` : null,
      "",
      "Continue this workstream from the latest context.",
      "Identify and execute the next concrete task, then provide a concise progress summary.",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    const message = deps.buildPolicyEnforcedMessage({
      baseMessage,
      executionPolicy,
      spawnGuardResult: guard.spawnGuardResult,
    });

    if (taskId) {
      try {
        await deps.client.updateEntity("task", taskId, { status: "in_progress" });
      } catch {
        // best effort
      }
      try {
        await deps.syncParentRollupsForTask({
          initiativeId: input.initiativeId,
          taskId,
          workstreamId: input.workstreamId,
          correlationId: sessionId,
        });
      } catch {
        // best effort
      }
    }

    await deps.emitActivitySafe({
      initiativeId: input.initiativeId,
      runId: sessionId,
      correlationId: sessionId,
      phase: "execution",
      level: "info",
      message: `Next Up dispatched ${resolvedWorkstreamTitle}.`,
      metadata: {
        event: "next_up_manual_dispatch_started",
        agent_id: input.agentId,
        agent_name: input.agentName ?? input.agentId,
        requested_by_agent_id: input.agentId,
        requested_by_agent_name: input.agentName ?? input.agentId,
        session_id: sessionId,
        workstream_id: input.workstreamId,
        workstream_title: resolvedWorkstreamTitle,
        task_id: taskId,
        task_title: resolvedTaskTitle,
        domain: executionPolicy.domain,
        required_skills: executionPolicy.requiredSkills,
        spawn_guard_model_tier: deps.extractSpawnGuardModelTier(guard.spawnGuardResult),
        fallback: true,
      },
    });

    deps.upsertAgentContext({
      agentId: input.agentId,
      initiativeId: input.initiativeId,
      initiativeTitle: input.initiativeTitle,
      workstreamId: input.workstreamId,
      taskId,
    });
    deps.upsertRunContext({
      runId: sessionId,
      agentId: input.agentId,
      initiativeId: input.initiativeId,
      initiativeTitle: input.initiativeTitle,
      workstreamId: input.workstreamId,
      taskId,
    });

    const spawned = deps.spawnAgentTurn({
      agentId: input.agentId,
      sessionId,
      message,
    });

    deps.upsertAgentRun({
      runId: sessionId,
      agentId: input.agentId,
      pid: spawned.pid,
      message,
      provider: null,
      model: null,
      initiativeId: input.initiativeId,
      initiativeTitle: input.initiativeTitle,
      workstreamId: input.workstreamId,
      taskId,
      startedAt: now,
      status: "running",
    });

    return {
      sessionId,
      pid: spawned.pid,
      blockedReason: null,
      retryable: false,
      executionPolicy,
      spawnGuardResult: guard.spawnGuardResult,
    };
  }

  return {
    registerArtifactSafe,
    applyAgentStatusUpdatesSafe,
    resolveAgentDisplayName,
    dispatchFallbackWorkstreamTurn,
  };
}
