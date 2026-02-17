import { randomUUID as randomUuidFn } from "node:crypto";

import type { OrgXClient } from "../api.js";
import { registerArtifact } from "../artifacts/register-artifact.js";
import type { AutoAssignedAgent } from "../entities/auto-assignment.js";
import type { RegisteredTool } from "../mcp-http-handler.js";
import { appendToOutbox } from "../outbox.js";
import type {
  ChangesetOperation,
  LiveActivityItem,
  OrgSnapshot,
  ReportingPhase,
  ReportingSourceClient,
} from "../types.js";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

export type RegisterToolFn = (
  tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (callId: string, params?: any) => Promise<ToolResult>;
  },
  options?: { optional?: boolean }
) => void;

export interface RegisterCoreToolsDeps {
  registerTool: RegisterToolFn;
  client: OrgXClient;
  config: {
    syncIntervalMs: number;
    pluginVersion?: string | null;
  };
  getCachedSnapshot: () => OrgSnapshot | null;
  getLastSnapshotAt: () => number;
  doSync: () => Promise<void>;
  text: (value: string) => ToolResult;
  json: (label: string, data: unknown) => ToolResult;
  formatSnapshot: (snapshot: OrgSnapshot) => string;
  autoAssignEntityForCreate: (input: {
    entityType: string;
    entityId: string;
    initiativeId: string | null;
    title: string;
    summary: string | null;
  }) => Promise<{
    updatedEntity?: unknown;
    assignmentSource: "orchestrator" | "fallback" | "manual";
    assignedAgents: AutoAssignedAgent[];
    warnings: string[];
  }>;
  toReportingPhase: (phase: string, progressPct?: number) => ReportingPhase;
  inferReportingInitiativeId: (input: Record<string, unknown>) => string | undefined;
  isUuid: (value: string | undefined) => value is string;
  pickNonEmptyString: (...values: Array<unknown>) => string | undefined;
  resolveReportingContext: (input: Record<string, unknown>) =>
    | {
        ok: true;
        value: {
          initiativeId: string;
          runId?: string;
          correlationId?: string;
          sourceClient?: ReportingSourceClient;
        };
      }
    | {
        ok: false;
        error: string;
      };
  readSkillPackState: () => {
    pack?: { name?: string | null; version?: string | null; checksum?: string | null } | null;
    overrides?: {
      source?: string | null;
      name?: string | null;
      version?: string | null;
      checksum?: string | null;
    } | null;
    etag?: string | null;
  };
  randomUUID?: () => string;
}

export function registerCoreTools(deps: RegisterCoreToolsDeps): Map<string, RegisteredTool> {
  const {
    registerTool,
    client,
    config,
    getCachedSnapshot,
    getLastSnapshotAt,
    doSync,
    text,
    json,
    formatSnapshot,
    autoAssignEntityForCreate,
    toReportingPhase,
    inferReportingInitiativeId,
    isUuid,
    pickNonEmptyString,
    resolveReportingContext,
    readSkillPackState,
  } = deps;
  const randomUUID = deps.randomUUID ?? randomUuidFn;
  const mcpToolRegistry = new Map<string, RegisteredTool>();
  const registerMcpTool: RegisterToolFn = (tool, options) => {
    mcpToolRegistry.set(tool.name, tool as unknown as RegisteredTool);
    registerTool(tool, options);
  };

  // --- orgx_status ---
  registerMcpTool(
    {
      name: "orgx_status",
      description:
        "Get current OrgX org status: active initiatives, agent states, pending decisions, active tasks.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute(_callId: string) {
        let snapshot = getCachedSnapshot();
        if (!snapshot || Date.now() - getLastSnapshotAt() > config.syncIntervalMs) {
          await doSync();
          snapshot = getCachedSnapshot();
        }
        if (!snapshot) {
          return text(
            "❌ Failed to fetch OrgX status. Check API key and connectivity."
          );
        }
        return text(formatSnapshot(snapshot));
      },
    },
    { optional: true }
  );

  // --- orgx_sync ---
  registerMcpTool(
    {
      name: "orgx_sync",
      description:
        "Push/pull memory sync with OrgX. Send local memory/daily log; receive initiatives, tasks, decisions, model routing policy.",
      parameters: {
        type: "object",
        properties: {
          memory: {
            type: "string",
            description: "Local memory snapshot to push",
          },
          dailyLog: {
            type: "string",
            description: "Today's session log to push",
          },
        },
      },
      async execute(
        _callId: string,
        params: { memory?: string; dailyLog?: string } = {}
      ) {
        try {
          const resp = await client.syncMemory({
            memory: params.memory,
            dailyLog: params.dailyLog,
          });
          return json("Sync complete:", resp);
        } catch (err: unknown) {
          return text(
            `❌ Sync failed: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  // --- orgx_delegation_preflight ---
  registerMcpTool(
    {
      name: "orgx_delegation_preflight",
      description:
        "Run delegation preflight to score scope quality, estimate ETA/cost, and suggest a split before autonomous execution.",
      parameters: {
        type: "object",
        properties: {
          intent: {
            type: "string",
            description: "Task intent in natural language",
          },
          acceptanceCriteria: {
            type: "array",
            items: { type: "string" },
            description: "Optional acceptance criteria to reduce ambiguity",
          },
          constraints: {
            type: "array",
            items: { type: "string" },
            description: "Optional constraints (deadline, stack, policy)",
          },
          domains: {
            type: "array",
            items: { type: "string" },
            description: "Optional preferred owner domains",
          },
        },
        required: ["intent"],
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: {
          intent: string;
          acceptanceCriteria?: string[];
          constraints?: string[];
          domains?: string[];
        } = { intent: "" }
      ) {
        try {
          const result = await client.delegationPreflight({
            intent: params.intent,
            acceptanceCriteria: Array.isArray(params.acceptanceCriteria)
              ? params.acceptanceCriteria.filter(
                  (item): item is string => typeof item === "string"
                )
              : undefined,
            constraints: Array.isArray(params.constraints)
              ? params.constraints.filter(
                  (item): item is string => typeof item === "string"
                )
              : undefined,
            domains: Array.isArray(params.domains)
              ? params.domains.filter(
                  (item): item is string => typeof item === "string"
                )
              : undefined,
          });
          return json("Delegation preflight:", result.data ?? result);
        } catch (err: unknown) {
          return text(
            `❌ Delegation preflight failed: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  // --- orgx_run_action ---
  registerMcpTool(
    {
      name: "orgx_run_action",
      description:
        "Apply a control action to a run: pause, resume, cancel, or rollback (rollback requires checkpointId).",
      parameters: {
        type: "object",
        properties: {
          runId: {
            type: "string",
            description: "Run UUID",
          },
          action: {
            type: "string",
            enum: ["pause", "resume", "cancel", "rollback"],
            description: "Control action",
          },
          checkpointId: {
            type: "string",
            description: "Checkpoint UUID (required for rollback)",
          },
          reason: {
            type: "string",
            description: "Optional reason for audit trail",
          },
        },
        required: ["runId", "action"],
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: {
          runId: string;
          action: "pause" | "resume" | "cancel" | "rollback";
          checkpointId?: string;
          reason?: string;
        } = { runId: "", action: "pause" }
      ) {
        try {
          if (params.action === "rollback" && !params.checkpointId) {
            return text("❌ rollback requires checkpointId");
          }
          const result = await client.runAction(params.runId, params.action, {
            checkpointId: params.checkpointId,
            reason: params.reason,
          });
          return json("Run action applied:", result.data ?? result);
        } catch (err: unknown) {
          return text(
            `❌ Run action failed: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  // --- orgx_checkpoints_list ---
  registerMcpTool(
    {
      name: "orgx_checkpoints_list",
      description: "List checkpoints for a run.",
      parameters: {
        type: "object",
        properties: {
          runId: {
            type: "string",
            description: "Run UUID",
          },
        },
        required: ["runId"],
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: { runId: string } = { runId: "" }
      ) {
        try {
          const result = await client.listRunCheckpoints(params.runId);
          return json("Run checkpoints:", result.data ?? result);
        } catch (err: unknown) {
          return text(
            `❌ Failed to list checkpoints: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  // --- orgx_checkpoint_restore ---
  registerMcpTool(
    {
      name: "orgx_checkpoint_restore",
      description: "Restore a run to a specific checkpoint.",
      parameters: {
        type: "object",
        properties: {
          runId: {
            type: "string",
            description: "Run UUID",
          },
          checkpointId: {
            type: "string",
            description: "Checkpoint UUID",
          },
          reason: {
            type: "string",
            description: "Optional restoration reason",
          },
        },
        required: ["runId", "checkpointId"],
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: { runId: string; checkpointId: string; reason?: string } = {
          runId: "",
          checkpointId: "",
        }
      ) {
        try {
          const result = await client.restoreRunCheckpoint(params.runId, {
            checkpointId: params.checkpointId,
            reason: params.reason,
          });
          return json("Checkpoint restored:", result.data ?? result);
        } catch (err: unknown) {
          return text(
            `❌ Checkpoint restore failed: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  // --- orgx_spawn_check ---
  registerMcpTool(
    {
      name: "orgx_spawn_check",
      description:
        "Check quality gate + get model routing before spawning a sub-agent. Returns allowed/denied, model tier, and check details.",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description:
              "Agent domain (engineering, product, marketing, data, operations, design)",
          },
          taskId: {
            type: "string",
            description: "OrgX task ID to check",
          },
        },
        required: ["domain"],
      },
      async execute(
        _callId: string,
        params: { domain: string; taskId?: string } = { domain: "" }
      ) {
        try {
          const result = await client.checkSpawnGuard(
            params.domain,
            params.taskId
          );
          const status = result.allowed ? "✅ Allowed" : "🚫 Blocked";
          return json(`${status} — model tier: ${result.modelTier}`, result);
        } catch (err: unknown) {
          return text(
            `❌ Spawn check failed: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  // --- orgx_quality_score ---
  registerMcpTool(
    {
      name: "orgx_quality_score",
      description:
        "Record a quality score (1-5) for completed agent work. Used to gate future spawns and track performance.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "ID of the completed task",
          },
          domain: {
            type: "string",
            description: "Agent domain that did the work",
          },
          score: {
            type: "number",
            description: "Quality 1 (poor) to 5 (excellent)",
            minimum: 1,
            maximum: 5,
          },
          notes: {
            type: "string",
            description: "Notes on the assessment",
          },
        },
        required: ["taskId", "domain", "score"],
      },
      async execute(
        _callId: string,
        params: {
          taskId: string;
          domain: string;
          score: number;
          notes?: string;
        } = { taskId: "", domain: "", score: 0 }
      ) {
        try {
          await client.recordQuality(params);
          return text(
            `✅ Quality score recorded: ${params.score}/5 for task ${params.taskId} (${params.domain})`
          );
        } catch (err: unknown) {
          return text(
            `❌ Quality recording failed: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  // --- orgx_create_entity ---
  registerMcpTool(
    {
      name: "orgx_create_entity",
      description:
        "Create an OrgX entity (initiative, workstream, task, decision, milestone, etc.).",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "Entity type: initiative, workstream, task, decision, milestone, artifact, agent, blocker",
          },
          title: {
            type: "string",
            description: "Entity title",
          },
          summary: {
            type: "string",
            description: "Description",
          },
          status: {
            type: "string",
            description: "Initial status (active, not_started, todo)",
          },
          initiative_id: {
            type: "string",
            description: "Parent initiative ID (for workstreams/tasks)",
          },
          workstream_id: {
            type: "string",
            description: "Parent workstream ID (for tasks)",
          },
          command_center_id: {
            type: "string",
            description: "Command center ID (for initiatives)",
          },
        },
        required: ["type", "title"],
      },
      async execute(_callId: string, params: Record<string, unknown> = {}) {
        try {
          const { type, ...data } = params;
          let entity = await client.createEntity(type as string, data);
          let assignmentSummary: {
            assignment_source: "orchestrator" | "fallback" | "manual";
            assigned_agents: AutoAssignedAgent[];
            warnings: string[];
          } | null = null;

          const entityType = String(type ?? "");
          if (entityType === "initiative" || entityType === "workstream") {
            const entityRecord = entity as Record<string, unknown>;
            const assignment = await autoAssignEntityForCreate({
              entityType,
              entityId: String(entityRecord.id ?? ""),
              initiativeId:
                entityType === "initiative"
                  ? String(entityRecord.id ?? "")
                  : (typeof data.initiative_id === "string"
                      ? data.initiative_id
                      : null),
              title:
                (typeof entityRecord.title === "string" && entityRecord.title) ||
                (typeof entityRecord.name === "string" && entityRecord.name) ||
                (typeof data.title === "string" && data.title) ||
                "Untitled",
              summary:
                (typeof entityRecord.summary === "string" && entityRecord.summary) ||
                (typeof data.summary === "string" && data.summary) ||
                null,
            });
            if (assignment.updatedEntity) {
              entity = assignment.updatedEntity as typeof entity;
            }
            assignmentSummary = {
              assignment_source: assignment.assignmentSource,
              assigned_agents: assignment.assignedAgents,
              warnings: assignment.warnings,
            };
          }

          return json(
            `✅ Created ${type}: ${entity.title ?? entity.id}`,
            {
              entity,
              ...(assignmentSummary
                ? {
                    auto_assignment: assignmentSummary,
                  }
                : {}),
            }
          );
        } catch (err: unknown) {
          return text(
            `❌ Creation failed: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  // --- orgx_update_entity ---
  registerMcpTool(
    {
      name: "orgx_update_entity",
      description: "Update an existing OrgX entity by type and ID.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "Entity type",
          },
          id: {
            type: "string",
            description: "Entity UUID",
          },
          status: {
            type: "string",
            description: "New status",
          },
          title: {
            type: "string",
            description: "New title",
          },
          summary: {
            type: "string",
            description: "New summary",
          },
        },
        required: ["type", "id"],
      },
      async execute(_callId: string, params: Record<string, unknown> = {}) {
        try {
          const { type, id, ...updates } = params;
          const entity = await client.updateEntity(
            type as string,
            id as string,
            updates
          );
          return json(
            `✅ Updated ${type} ${(id as string).slice(0, 8)}`,
            entity
          );
        } catch (err: unknown) {
          return text(
            `❌ Update failed: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  // --- orgx_list_entities ---
  registerMcpTool(
    {
      name: "orgx_list_entities",
      description:
        "List OrgX entities of a given type with optional status filter.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "Entity type: initiative, workstream, task, decision, agent",
          },
          status: {
            type: "string",
            description: "Filter by status",
          },
          limit: {
            type: "number",
            description: "Max results (default 20)",
            default: 20,
          },
        },
        required: ["type"],
      },
      async execute(
        _callId: string,
        params: { type: string; status?: string; limit?: number } = { type: "" }
      ) {
        try {
          const { type, ...filters } = params;
          const resp = await client.listEntities(type, filters);
          const entities = resp.data ?? resp;
          const count = Array.isArray(entities) ? entities.length : "?";
          return json(`${count} ${type}(s):`, entities);
        } catch (err: unknown) {
          return text(
            `❌ List failed: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  function withProvenanceMetadata(metadata?: Record<string, unknown>): Record<string, unknown> {
    const input = metadata ?? {};
    const out: Record<string, unknown> = { ...input };

    if (out.orgx_plugin_version === undefined) {
      out.orgx_plugin_version = (config.pluginVersion ?? "").trim() || null;
    }

    try {
      const state = readSkillPackState();
      const overrides = state.overrides;
      if (out.skill_pack_name === undefined) {
        out.skill_pack_name = overrides?.name ?? state.pack?.name ?? null;
      }
      if (out.skill_pack_version === undefined) {
        out.skill_pack_version = overrides?.version ?? state.pack?.version ?? null;
      }
      if (out.skill_pack_checksum === undefined) {
        out.skill_pack_checksum = overrides?.checksum ?? state.pack?.checksum ?? null;
      }
      if (out.skill_pack_source === undefined) {
        out.skill_pack_source = overrides?.source ?? null;
      }
      if (out.skill_pack_etag === undefined) {
        out.skill_pack_etag = state.etag ?? null;
      }
    } catch {
      // best effort
    }

    if (out.orgx_provenance === undefined) {
      out.orgx_provenance = {
        plugin_version: out.orgx_plugin_version ?? null,
        skill_pack: {
          name: out.skill_pack_name ?? null,
          version: out.skill_pack_version ?? null,
          checksum: out.skill_pack_checksum ?? null,
          source: out.skill_pack_source ?? null,
          etag: out.skill_pack_etag ?? null,
        },
      };
    }

    return out;
  }

  async function emitActivityWithFallback(
    source: string,
    payload: {
      initiative_id?: string;
      message: string;
      run_id?: string;
      correlation_id?: string;
      source_client?: ReportingSourceClient;
      phase?: ReportingPhase;
      progress_pct?: number;
      level?: "info" | "warn" | "error";
      next_step?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<ToolResult> {
    if (!payload.message || payload.message.trim().length === 0) {
      return text("❌ message is required");
    }

    const context = resolveReportingContext(payload);
    if (!context.ok) {
      return text(`❌ ${context.error}`);
    }

    const now = new Date().toISOString();
    const id = `progress:${randomUUID().slice(0, 8)}`;
    const normalizedPayload = {
      initiative_id: context.value.initiativeId,
      run_id: context.value.runId,
      correlation_id: context.value.correlationId,
      source_client: context.value.sourceClient,
      message: payload.message,
      phase: payload.phase ?? "execution",
      progress_pct: payload.progress_pct,
      level: payload.level ?? "info",
      next_step: payload.next_step,
      metadata: withProvenanceMetadata({
        ...(payload.metadata ?? {}),
        source,
      }),
    };

    const activityItem: LiveActivityItem = {
      id,
      type: "delegation",
      title: payload.message,
      description: payload.next_step ?? null,
      agentId: null,
      agentName: null,
      requesterAgentId: null,
      requesterAgentName: null,
      executorAgentId: null,
      executorAgentName: null,
      runId: context.value.runId ?? null,
      initiativeId: context.value.initiativeId,
      timestamp: now,
      phase: normalizedPayload.phase,
      summary: payload.next_step ? `Next: ${payload.next_step}` : payload.message,
      metadata: normalizedPayload.metadata,
    };

    try {
      const result = await client.emitActivity(normalizedPayload);
      return text(
        `Activity emitted: ${payload.message} [${normalizedPayload.phase}${
          payload.progress_pct != null ? ` ${payload.progress_pct}%` : ""
        }] (run ${result.run_id.slice(0, 8)}...)`
      );
    } catch {
      await appendToOutbox("progress", {
        id,
        type: "progress",
        timestamp: now,
        payload: normalizedPayload as Record<string, unknown>,
        activityItem,
      });
      return text(
        `Activity saved locally: ${payload.message} [${normalizedPayload.phase}${
          payload.progress_pct != null ? ` ${payload.progress_pct}%` : ""
        }] (will sync when connected)`
      );
    }
  }

  async function applyChangesetWithFallback(
    source: string,
    payload: {
      initiative_id?: string;
      idempotency_key?: string;
      operations: ChangesetOperation[];
      run_id?: string;
      correlation_id?: string;
      source_client?: ReportingSourceClient;
    }
  ): Promise<ToolResult> {
    const context = resolveReportingContext(payload);
    if (!context.ok) {
      return text(`❌ ${context.error}`);
    }

    if (!Array.isArray(payload.operations) || payload.operations.length === 0) {
      return text("❌ operations must contain at least one change");
    }

    const idempotencyKey =
      pickNonEmptyString(payload.idempotency_key) ??
      `${source}:${Date.now()}:${randomUUID().slice(0, 8)}`;

    const requestPayload = {
      initiative_id: context.value.initiativeId,
      run_id: context.value.runId,
      correlation_id: context.value.correlationId,
      source_client: context.value.sourceClient,
      idempotency_key: idempotencyKey,
      operations: payload.operations,
    };

    const now = new Date().toISOString();
    const id = `changeset:${randomUUID().slice(0, 8)}`;

    const activityItem: LiveActivityItem = {
      id,
      type: "milestone_completed",
      title: "Changeset queued",
      description: `${payload.operations.length} operation${
        payload.operations.length === 1 ? "" : "s"
      }`,
      agentId: null,
      agentName: null,
      requesterAgentId: null,
      requesterAgentName: null,
      executorAgentId: null,
      executorAgentName: null,
      runId: context.value.runId ?? null,
      initiativeId: context.value.initiativeId,
      timestamp: now,
      phase: "review",
      summary: `${payload.operations.length} operation${
        payload.operations.length === 1 ? "" : "s"
      }`,
      metadata: withProvenanceMetadata({
        source,
        idempotency_key: idempotencyKey,
      }),
    };

    try {
      const result = await client.applyChangeset(requestPayload);
      return text(
        `Changeset ${result.replayed ? "replayed" : "applied"}: ${result.applied_count} op${
          result.applied_count === 1 ? "" : "s"
        } (run ${result.run_id.slice(0, 8)}...)`
      );
    } catch {
      await appendToOutbox("decisions", {
        id,
        type: "changeset",
        timestamp: now,
        payload: requestPayload as Record<string, unknown>,
        activityItem,
      });
      return text(
        `Changeset saved locally (${payload.operations.length} op${
          payload.operations.length === 1 ? "" : "s"
        }) (will sync when connected)`
      );
    }
  }

  // --- orgx_emit_activity ---
  registerMcpTool(
    {
      name: "orgx_emit_activity",
      description:
        "Emit append-only OrgX activity telemetry (launch reporting contract primary write tool).",
      parameters: {
        type: "object",
        properties: {
          initiative_id: {
            type: "string",
            description: "Initiative UUID (required unless ORGX_INITIATIVE_ID is set)",
          },
          message: {
            type: "string",
            description: "Human-readable activity update",
          },
          run_id: {
            type: "string",
            description: "Optional run UUID",
          },
          correlation_id: {
            type: "string",
            description: "Required when run_id is omitted",
          },
          source_client: {
            type: "string",
            enum: ["openclaw", "codex", "claude-code", "api"],
            description: "Required when run_id is omitted",
          },
          phase: {
            type: "string",
            enum: ["intent", "execution", "blocked", "review", "handoff", "completed"],
            description: "Reporting phase",
          },
          progress_pct: {
            type: "number",
            minimum: 0,
            maximum: 100,
            description: "Optional progress percentage",
          },
          level: {
            type: "string",
            enum: ["info", "warn", "error"],
            description: "Optional level (default info)",
          },
          next_step: {
            type: "string",
            description: "Optional next step",
          },
          metadata: {
            type: "object",
            description: "Optional structured metadata",
          },
        },
        required: ["message"],
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: {
          initiative_id?: string;
          message: string;
          run_id?: string;
          correlation_id?: string;
          source_client?: ReportingSourceClient;
          phase?: ReportingPhase;
          progress_pct?: number;
          level?: "info" | "warn" | "error";
          next_step?: string;
          metadata?: Record<string, unknown>;
        } = { message: "" }
      ) {
        return emitActivityWithFallback("orgx_emit_activity", params);
      },
    },
    { optional: true }
  );

  // --- orgx_apply_changeset ---
  registerMcpTool(
    {
      name: "orgx_apply_changeset",
      description:
        "Apply an idempotent transactional OrgX changeset (launch reporting contract primary mutation tool).",
      parameters: {
        type: "object",
        properties: {
          initiative_id: {
            type: "string",
            description: "Initiative UUID (required unless ORGX_INITIATIVE_ID is set)",
          },
          idempotency_key: {
            type: "string",
            description: "Idempotency key (<=120 chars). Auto-generated if omitted.",
          },
          operations: {
            type: "array",
            minItems: 1,
            maxItems: 25,
            description: "Changeset operations (task.create, task.update, milestone.update, decision.create)",
            items: { type: "object" },
          },
          run_id: {
            type: "string",
            description: "Optional run UUID",
          },
          correlation_id: {
            type: "string",
            description: "Required when run_id is omitted",
          },
          source_client: {
            type: "string",
            enum: ["openclaw", "codex", "claude-code", "api"],
            description: "Required when run_id is omitted",
          },
        },
        required: ["operations"],
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: {
          initiative_id?: string;
          idempotency_key?: string;
          operations: ChangesetOperation[];
          run_id?: string;
          correlation_id?: string;
          source_client?: ReportingSourceClient;
        } = { operations: [] }
      ) {
        return applyChangesetWithFallback("orgx_apply_changeset", params);
      },
    },
    { optional: true }
  );

  // --- orgx_report_progress (alias -> orgx_emit_activity) ---
  registerMcpTool(
    {
      name: "orgx_report_progress",
      description:
        "Alias for orgx_emit_activity. Report progress at key milestones so the team can track your work.",
      parameters: {
        type: "object",
        properties: {
          initiative_id: {
            type: "string",
            description: "Initiative UUID (required unless ORGX_INITIATIVE_ID is set)",
          },
          run_id: {
            type: "string",
            description: "Optional run UUID",
          },
          correlation_id: {
            type: "string",
            description: "Required when run_id is omitted",
          },
          source_client: {
            type: "string",
            enum: ["openclaw", "codex", "claude-code", "api"],
          },
          summary: {
            type: "string",
            description: "What was accomplished (1-2 sentences, human-readable)",
          },
          phase: {
            type: "string",
            enum: ["researching", "implementing", "testing", "reviewing", "blocked"],
            description: "Current work phase",
          },
          progress_pct: {
            type: "number",
            description: "Progress percentage (0-100)",
            minimum: 0,
            maximum: 100,
          },
          next_step: {
            type: "string",
            description: "What you plan to do next",
          },
        },
        required: ["summary", "phase"],
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: {
          initiative_id?: string;
          run_id?: string;
          correlation_id?: string;
          source_client?: ReportingSourceClient;
          summary: string;
          phase: string;
          progress_pct?: number;
          next_step?: string;
        } = { summary: "", phase: "implementing" }
      ) {
        return emitActivityWithFallback("orgx_report_progress", {
          initiative_id: params.initiative_id,
          run_id: params.run_id,
          correlation_id: params.correlation_id,
          source_client: params.source_client,
          message: params.summary,
          phase: toReportingPhase(params.phase, params.progress_pct),
          progress_pct: params.progress_pct,
          next_step: params.next_step,
          level: params.phase === "blocked" ? "warn" : "info",
          metadata: {
            legacy_phase: params.phase,
          },
        });
      },
    },
    { optional: true }
  );

  // --- orgx_request_decision (alias -> orgx_apply_changeset decision.create) ---
  registerMcpTool(
    {
      name: "orgx_request_decision",
      description:
        "Alias for orgx_apply_changeset with decision.create. Request a human decision before proceeding.",
      parameters: {
        type: "object",
        properties: {
          initiative_id: {
            type: "string",
            description: "Initiative UUID (required unless ORGX_INITIATIVE_ID is set)",
          },
          run_id: {
            type: "string",
            description: "Optional run UUID",
          },
          correlation_id: {
            type: "string",
            description: "Required when run_id is omitted",
          },
          source_client: {
            type: "string",
            enum: ["openclaw", "codex", "claude-code", "api"],
          },
          question: {
            type: "string",
            description: "The decision question (e.g., 'Deploy to production?')",
          },
          context: {
            type: "string",
            description: "Background context to help the human decide",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description:
              "Available choices (e.g., ['Yes, deploy now', 'Wait for more testing', 'Cancel'])",
          },
          urgency: {
            type: "string",
            enum: ["low", "medium", "high", "urgent"],
            description: "How urgent this decision is",
          },
          blocking: {
            type: "boolean",
            description: "Whether work should pause until this is decided (default: true)",
          },
        },
        required: ["question", "urgency"],
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: {
          initiative_id?: string;
          run_id?: string;
          correlation_id?: string;
          source_client?: ReportingSourceClient;
          question: string;
          context?: string;
          options?: string[];
          urgency: "low" | "medium" | "high" | "urgent";
          blocking?: boolean;
        } = { question: "", urgency: "medium" }
      ) {
        const requestId = `decision:${randomUUID().slice(0, 8)}`;
        const changesetResult = await applyChangesetWithFallback(
          "orgx_request_decision",
          {
            initiative_id: params.initiative_id,
            run_id: params.run_id,
            correlation_id: params.correlation_id,
            source_client: params.source_client,
            idempotency_key: `decision:${requestId}`,
            operations: [
              {
                op: "decision.create",
                title: params.question,
                summary: params.context,
                urgency: params.urgency,
                options: params.options,
                blocking: params.blocking ?? true,
              },
            ],
          }
        );

        await emitActivityWithFallback("orgx_request_decision", {
          initiative_id: params.initiative_id,
          run_id: params.run_id,
          correlation_id: params.correlation_id,
          source_client: params.source_client,
          message: `Decision requested: ${params.question}`,
          phase: "review",
          level: "info",
          metadata: {
            urgency: params.urgency,
            blocking: params.blocking ?? true,
            options: params.options ?? [],
          },
        });

        return changesetResult;
      },
    },
    { optional: true }
  );

  // --- orgx_register_artifact ---
  registerMcpTool(
    {
      name: "orgx_register_artifact",
      description:
        "Register a work output (PR, document, config change, report, etc.) as a work_artifact in OrgX. Makes it visible in the dashboard activity timeline and entity detail modals.",
      parameters: {
        type: "object",
        properties: {
          initiative_id: {
            type: "string",
            description: "Convenience: initiative UUID. Used as entity_type='initiative', entity_id=<this> when entity_type/entity_id are not provided.",
          },
          entity_type: {
            type: "string",
            enum: ["initiative", "milestone", "task", "decision", "project"],
            description: "The type of entity this artifact is attached to",
          },
          entity_id: {
            type: "string",
            description: "UUID of the entity this artifact is attached to",
          },
          name: {
            type: "string",
            description: "Human-readable artifact name (e.g., 'PR #107: Fix build size')",
          },
          artifact_type: {
            type: "string",
            description: "Artifact type code (e.g., 'eng.diff_pack', 'pr', 'document'). Falls back to 'shared.project_handbook' if the type is not recognized by OrgX.",
          },
          description: {
            type: "string",
            description: "What this artifact is and why it matters",
          },
          url: {
            type: "string",
            description: "External link to the artifact (PR URL, file path, etc.)",
          },
          content: {
            type: "string",
            description: "Inline preview content (markdown/text). At least one of url or content is required.",
          },
        },
        required: ["name", "artifact_type"],
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: {
          initiative_id?: string;
          entity_type?: string;
          entity_id?: string;
          name: string;
          artifact_type: string;
          description?: string;
          url?: string;
          content?: string;
        } = { name: "", artifact_type: "other" }
      ) {
        const now = new Date().toISOString();
        const id = `artifact:${randomUUID().slice(0, 8)}`;

        // Resolve entity association: explicit entity_type+entity_id > initiative_id > inferred
        let resolvedEntityType: string | null = null;
        let resolvedEntityId: string | null = null;

        if (params.entity_type && isUuid(params.entity_id)) {
          resolvedEntityType = params.entity_type;
          resolvedEntityId = params.entity_id!;
        } else if (isUuid(params.initiative_id)) {
          resolvedEntityType = "initiative";
          resolvedEntityId = params.initiative_id!;
        } else {
          const inferred = inferReportingInitiativeId(params as unknown as Record<string, unknown>);
          if (inferred) {
            resolvedEntityType = "initiative";
            resolvedEntityId = inferred;
          }
        }

        if (!resolvedEntityType || !resolvedEntityId) {
          return text("❌ Cannot register artifact: provide entity_type + entity_id, or initiative_id, so the artifact can be attached to an entity.");
        }

        if (!params.url && !params.content) {
          return text("❌ Cannot register artifact: provide at least one of url or content.");
        }

        const baseUrl = client.getBaseUrl();
        const artifactId = randomUUID();

        const activityItem: LiveActivityItem = {
          id,
          type: "artifact_created",
          title: params.name,
          description: params.description ?? null,
          agentId: null,
          agentName: null,
          requesterAgentId: null,
          requesterAgentName: null,
          executorAgentId: null,
          executorAgentName: null,
          runId: null,
          initiativeId: resolvedEntityType === "initiative" ? resolvedEntityId : null,
          timestamp: now,
          summary: params.url ?? null,
          metadata: withProvenanceMetadata({
            source: "orgx_register_artifact",
            artifact_type: params.artifact_type,
            url: params.url,
            entity_type: resolvedEntityType,
            entity_id: resolvedEntityId,
          }),
        };

        try {
          const result = await registerArtifact(client as any, baseUrl, {
            artifact_id: artifactId,
            entity_type: resolvedEntityType as any,
            entity_id: resolvedEntityId,
            name: params.name,
            artifact_type: params.artifact_type,
            description: params.description ?? null,
            external_url: params.url ?? null,
            preview_markdown: params.content ?? null,
            status: "draft",
            metadata: {
              source: "orgx_register_artifact",
              artifact_id: artifactId,
            },
            validate_persistence: true,
          });

          if (!result.ok) {
            throw new Error(result.persistence.last_error ?? "Artifact registration failed");
          }

          activityItem.metadata = withProvenanceMetadata({
            ...activityItem.metadata,
            artifact_id: result.artifact_id,
            entity_type: resolvedEntityType,
            entity_id: resolvedEntityId,
          });

          return json(
            `Artifact registered: ${params.name} [${params.artifact_type}] → ${resolvedEntityType}/${resolvedEntityId} (id: ${result.artifact_id})`,
            result
          );
        } catch (firstError: unknown) {

          // Outbox fallback for offline/error scenarios
          await appendToOutbox("artifacts", {
            id,
            type: "artifact",
            timestamp: now,
            payload: {
              artifact_id: artifactId,
              name: params.name,
              artifact_type: params.artifact_type,
              description: params.description,
              url: params.url,
              content: params.content,
              entity_type: resolvedEntityType,
              entity_id: resolvedEntityId,
            } as Record<string, unknown>,
            activityItem,
          });
          return text(
            `Artifact saved locally: ${params.name} [${params.artifact_type}] (will sync when connected)`
          );
        }
      },
    },
    { optional: true }
  );

  return mcpToolRegistry;
}
