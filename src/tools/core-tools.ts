import { randomUUID as randomUuidFn } from "node:crypto";

import type { OrgXClient } from "../api.js";
import { registerArtifact } from "../artifacts/register-artifact.js";
import { validateOpenClawSkillPackManifest } from "../contracts/skill-pack-schema.js";
import type { AutoAssignedAgent } from "../entities/auto-assignment.js";
import { listBuiltInSentinels } from "../http/helpers/sentinel-catalog.js";
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
  readSkillPackState: () => import("../skill-pack-state.js").SkillPackState;
  updateSkillPackPolicy: (input: {
    frozen?: boolean;
    pinnedChecksum?: string | null;
    pinToCurrent?: boolean;
    clearPin?: boolean;
  }) => import("../skill-pack-state.js").SkillPackState;
  rollbackSkillPackPolicy: (input?: {
    auditId?: string;
  }) => import("../skill-pack-state.js").SkillPackState;
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
    updateSkillPackPolicy,
    rollbackSkillPackPolicy,
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
      name: "orgx_sentinel_catalog",
      description:
        "List built-in proactive sentinel templates. Supports optional domain filter.",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "Optional domain filter (engineering, sales, operations, product).",
          },
        },
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: { domain?: string } = {}
      ) {
        try {
          const sentinels = listBuiltInSentinels({ domain: params.domain });
          return json("Sentinel catalog:", {
            generatedAt: new Date().toISOString(),
            domain: params.domain ?? null,
            count: sentinels.length,
            sentinels,
          });
        } catch (err: unknown) {
          return text(
            `❌ Failed to load sentinel catalog: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

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
          agents: {
            type: "array",
            description: "Optional local agent states to sync into OrgX",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                domain: { type: "string" },
                status: {
                  type: "string",
                  enum: ["active", "idle", "throttled"],
                },
                currentTask: { type: "string" },
                lastActive: { type: "string" },
              },
              required: ["id", "name", "domain", "status"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: {
          memory?: string;
          dailyLog?: string;
          agents?: Array<{
            id: string;
            name: string;
            domain: string;
            status: "active" | "idle" | "throttled";
            currentTask?: string;
            lastActive?: string;
          }>;
        } = {}
      ) {
        try {
          const resp = await client.syncMemory({
            memory: params.memory,
            dailyLog: params.dailyLog,
            agents: params.agents,
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
          const result = await client.updateEntityDetailed(
            type as string,
            id as string,
            updates
          );
          const payload =
            result.reassignment || result.initiative_reassignment
              ? {
                  entity: result.entity,
                  reassignment: result.reassignment ?? null,
                  initiative_reassignment: result.initiative_reassignment ?? null,
                }
              : result.entity;
          return json(
            `✅ Updated ${type} ${(id as string).slice(0, 8)}`,
            payload
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

  // --- orgx_reassign_stream ---
  registerMcpTool(
    {
      name: "orgx_reassign_stream",
      description:
        "Reassign a workstream's stream ownership/agents and return reassignment scheduling details.",
      parameters: {
        type: "object",
        properties: {
          workstream_id: {
            type: "string",
            description: "Workstream UUID to reassign",
            minLength: 1,
          },
          initiative_id: {
            type: "string",
            description: "Parent initiative UUID",
            minLength: 1,
          },
          status: {
            type: "string",
            description: "Optional workstream status override (active, in_progress, pending, etc.)",
            minLength: 1,
          },
          domain: {
            type: "string",
            description: "Optional target domain for the reassigned stream",
            minLength: 1,
          },
          role: {
            type: "string",
            description: "Optional role hint for assignment routing",
            minLength: 1,
          },
          assigned_agent_ids: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description: "Optional assigned agent IDs",
          },
          assignedAgentIds: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description: "Alias for assigned_agent_ids",
          },
          assigned_agent_names: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description: "Optional assigned agent display names",
          },
          assignedAgentNames: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description: "Alias for assigned_agent_names",
          },
          assigned_agents: {
            type: "array",
            description: "Optional structured assigned agent list",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                domain: { type: "string" },
                role: { type: "string" },
              },
              additionalProperties: false,
            },
          },
        },
        required: ["workstream_id", "initiative_id"],
        additionalProperties: false,
      },
      async execute(_callId: string, params: Record<string, unknown> = {}) {
        try {
          const workstreamId = pickNonEmptyString(params.workstream_id);
          const initiativeId = pickNonEmptyString(params.initiative_id);
          if (!workstreamId || !initiativeId) {
            return text("❌ workstream_id and initiative_id are required.");
          }
          if (!isUuid(workstreamId)) {
            return text("❌ workstream_id must be a valid UUID.");
          }
          if (!isUuid(initiativeId)) {
            return text("❌ initiative_id must be a valid UUID.");
          }

          const normalizeOptionalString = (
            value: unknown,
            field: string
          ): { ok: true; value: string | undefined } | { ok: false; error: string } => {
            if (value === undefined) return { ok: true, value: undefined };
            if (typeof value !== "string") {
              return { ok: false, error: `❌ ${field} must be a string when provided.` };
            }
            const trimmed = value.trim();
            return { ok: true, value: trimmed || undefined };
          };
          const normalizeStringArray = (
            value: unknown,
            field: string
          ): { ok: true; value: string[] | undefined } | { ok: false; error: string } => {
            if (value === undefined) return { ok: true, value: undefined };
            if (!Array.isArray(value)) {
              return { ok: false, error: `❌ ${field} must be an array of strings.` };
            }
            const normalized: string[] = [];
            for (const entry of value) {
              if (typeof entry !== "string" || !entry.trim()) {
                return { ok: false, error: `❌ ${field} entries must be non-empty strings.` };
              }
              normalized.push(entry.trim());
            }
            return { ok: true, value: normalized };
          };
          const normalizeAssignedAgents = (
            value: unknown
          ):
            | {
                ok: true;
                value:
                  | Array<{
                      id?: string;
                      name?: string;
                      domain?: string;
                      role?: string;
                    }>
                  | undefined;
              }
            | { ok: false; error: string } => {
            if (value === undefined) return { ok: true, value: undefined };
            if (!Array.isArray(value)) {
              return { ok: false, error: "❌ assigned_agents must be an array when provided." };
            }
            const normalized: Array<{
              id?: string;
              name?: string;
              domain?: string;
              role?: string;
            }> = [];
            for (const entry of value) {
              if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                return {
                  ok: false,
                  error: "❌ assigned_agents entries must be objects with id, name, domain, or role.",
                };
              }

              const candidate = entry as Record<string, unknown>;
              const normalizedEntry: {
                id?: string;
                name?: string;
                domain?: string;
                role?: string;
              } = {};

              for (const key of ["id", "name", "domain", "role"] as const) {
                if (!(key in candidate) || candidate[key] === undefined || candidate[key] === null) continue;
                const valueAtKey = candidate[key];
                if (typeof valueAtKey !== "string" || !valueAtKey.trim()) {
                  return {
                    ok: false,
                    error: `❌ assigned_agents.${key} must be a non-empty string when provided.`,
                  };
                }
                normalizedEntry[key] = valueAtKey.trim();
              }

              if (
                normalizedEntry.id === undefined &&
                normalizedEntry.name === undefined &&
                normalizedEntry.domain === undefined &&
                normalizedEntry.role === undefined
              ) {
                return {
                  ok: false,
                  error: "❌ assigned_agents entries must include at least one of id, name, domain, or role.",
                };
              }

              normalized.push(normalizedEntry);
            }
            return { ok: true, value: normalized };
          };
          const arraysEqual = (left: string[], right: string[]): boolean =>
            left.length === right.length && left.every((value, idx) => value === right[idx]);

          const statusInput = normalizeOptionalString(params.status, "status");
          if (!statusInput.ok) return text(statusInput.error);
          const domainInput = normalizeOptionalString(params.domain, "domain");
          if (!domainInput.ok) return text(domainInput.error);
          const roleInput = normalizeOptionalString(params.role, "role");
          if (!roleInput.ok) return text(roleInput.error);

          const assignedAgentIdsSnake = normalizeStringArray(
            params.assigned_agent_ids,
            "assigned_agent_ids"
          );
          if (!assignedAgentIdsSnake.ok) return text(assignedAgentIdsSnake.error);
          const assignedAgentIdsCamel = normalizeStringArray(
            params.assignedAgentIds,
            "assignedAgentIds"
          );
          if (!assignedAgentIdsCamel.ok) return text(assignedAgentIdsCamel.error);
          const assignedAgentNamesSnake = normalizeStringArray(
            params.assigned_agent_names,
            "assigned_agent_names"
          );
          if (!assignedAgentNamesSnake.ok) return text(assignedAgentNamesSnake.error);
          const assignedAgentNamesCamel = normalizeStringArray(
            params.assignedAgentNames,
            "assignedAgentNames"
          );
          if (!assignedAgentNamesCamel.ok) return text(assignedAgentNamesCamel.error);
          const assignedAgentsInput = normalizeAssignedAgents(params.assigned_agents);
          if (!assignedAgentsInput.ok) return text(assignedAgentsInput.error);

          if (
            assignedAgentIdsSnake.value &&
            assignedAgentIdsCamel.value &&
            !arraysEqual(assignedAgentIdsSnake.value, assignedAgentIdsCamel.value)
          ) {
            return text(
              "❌ assigned_agent_ids and assignedAgentIds must match when both are provided."
            );
          }
          if (
            assignedAgentNamesSnake.value &&
            assignedAgentNamesCamel.value &&
            !arraysEqual(assignedAgentNamesSnake.value, assignedAgentNamesCamel.value)
          ) {
            return text(
              "❌ assigned_agent_names and assignedAgentNames must match when both are provided."
            );
          }

          const normalizedAssignedAgentIds =
            assignedAgentIdsSnake.value ?? assignedAgentIdsCamel.value;
          const normalizedAssignedAgentNames =
            assignedAgentNamesSnake.value ?? assignedAgentNamesCamel.value;

          const hasReassignmentMutation =
            domainInput.value !== undefined ||
            roleInput.value !== undefined ||
            assignedAgentsInput.value !== undefined ||
            normalizedAssignedAgentIds !== undefined ||
            normalizedAssignedAgentNames !== undefined;
          if (!hasReassignmentMutation) {
            return text(
              "❌ Include at least one reassignment field: domain, role, assigned_agents, assigned_agent_ids, or assigned_agent_names."
            );
          }

          const updates: Record<string, unknown> = {
            initiative_id: initiativeId,
          };
          if (statusInput.value !== undefined) updates.status = statusInput.value;
          if (domainInput.value !== undefined) updates.domain = domainInput.value;
          if (roleInput.value !== undefined) updates.role = roleInput.value;
          if (assignedAgentsInput.value !== undefined) updates.assigned_agents = assignedAgentsInput.value;
          if (normalizedAssignedAgentIds !== undefined) {
            updates.assigned_agent_ids = normalizedAssignedAgentIds;
          }
          if (normalizedAssignedAgentNames !== undefined) {
            updates.assigned_agent_names = normalizedAssignedAgentNames;
          }

          let beforeDomainFromSnapshot: string | null = null;
          if (typeof client.listEntities === "function") {
            try {
              const currentWorkstreams = await client.listEntities("workstream", {
                initiative_id: initiativeId,
                limit: 200,
              });
              const rows =
                currentWorkstreams &&
                typeof currentWorkstreams === "object" &&
                Array.isArray((currentWorkstreams as { data?: unknown }).data)
                  ? ((currentWorkstreams as { data: unknown[] }).data as unknown[])
                  : [];
              for (const row of rows) {
                if (!row || typeof row !== "object" || Array.isArray(row)) continue;
                const record = row as Record<string, unknown>;
                const id = pickNonEmptyString(record.id);
                if (id !== workstreamId) continue;
                beforeDomainFromSnapshot = pickNonEmptyString(record.domain) ?? null;
                break;
              }
            } catch {
              // Best effort snapshot for before/after confirmation.
            }
          }

          const result = await client.updateEntityDetailed(
            "workstream",
            workstreamId,
            updates
          );
          const entityRecord =
            result.entity && typeof result.entity === "object" && !Array.isArray(result.entity)
              ? (result.entity as Record<string, unknown>)
              : null;
          const reassignmentRecord =
            result.reassignment &&
            typeof result.reassignment === "object" &&
            !Array.isArray(result.reassignment)
              ? (result.reassignment as unknown as Record<string, unknown>)
              : null;
          const beforeDomain =
            pickNonEmptyString(
              beforeDomainFromSnapshot,
              reassignmentRecord?.before_domain,
              reassignmentRecord?.previous_domain,
              reassignmentRecord?.from_domain,
              entityRecord?.before_domain,
              entityRecord?.previous_domain,
              entityRecord?.from_domain
            ) ?? null;
          const afterDomain =
            pickNonEmptyString(
              reassignmentRecord?.after_domain,
              reassignmentRecord?.new_domain,
              reassignmentRecord?.to_domain,
              entityRecord?.after_domain,
              entityRecord?.new_domain,
              entityRecord?.to_domain,
              entityRecord?.domain,
              domainInput.value
            ) ?? null;

          return json(`✅ Reassigned workstream ${workstreamId.slice(0, 8)}`, {
            workstream_id: workstreamId,
            before_domain: beforeDomain,
            after_domain: afterDomain,
            entity: result.entity,
            reassignment: result.reassignment ?? null,
            initiative_reassignment: result.initiative_reassignment ?? null,
          });
        } catch (err: unknown) {
          return text(
            `❌ Stream reassignment failed: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  // --- orgx_reassign_streams ---
  registerMcpTool(
    {
      name: "orgx_reassign_streams",
      description:
        "Convenience batch reassignment tool. Takes initiative_id and a workstream-to-domain mapping, then updates all listed workstreams.",
      parameters: {
        type: "object",
        properties: {
          initiative_id: {
            type: "string",
            description: "Parent initiative UUID for all workstream updates",
            minLength: 1,
          },
          workstream_domains: {
            type: "object",
            description: "Mapping of workstream UUID -> target domain",
            additionalProperties: {
              type: "string",
              minLength: 1,
            },
          },
          mapping: {
            type: "object",
            description:
              "Alias for workstream_domains: mapping of workstream UUID -> target domain",
            additionalProperties: {
              type: "string",
              minLength: 1,
            },
          },
          mappings: {
            type: "array",
            description:
              "Optional array mapping for advanced routing fields (workstream_id, domain, role, status).",
            items: {
              type: "object",
              properties: {
                workstream_id: {
                  type: "string",
                  description: "Workstream UUID to reassign",
                  minLength: 1,
                },
                domain: {
                  type: "string",
                  description: "Target domain for reassignment",
                  minLength: 1,
                },
                role: {
                  type: "string",
                  description: "Optional role hint for assignment routing",
                  minLength: 1,
                },
                status: {
                  type: "string",
                  description:
                    "Optional workstream status override (active, in_progress, pending, etc.)",
                  minLength: 1,
                },
              },
              required: ["workstream_id", "domain"],
              additionalProperties: false,
            },
          },
          status: {
            type: "string",
            description:
              "Optional workstream status override applied to each reassigned stream",
            minLength: 1,
          },
        },
        required: ["initiative_id"],
        additionalProperties: false,
      },
      async execute(_callId: string, params: Record<string, unknown> = {}) {
        try {
          const initiativeId = pickNonEmptyString(params.initiative_id);
          if (!initiativeId) {
            return text("❌ initiative_id is required.");
          }
          if (!isUuid(initiativeId)) {
            return text("❌ initiative_id must be a valid UUID.");
          }
          const statusInput = params.status;
          if (statusInput !== undefined && typeof statusInput !== "string") {
            return text("❌ status must be a string when provided.");
          }
          const normalizedStatus =
            typeof statusInput === "string" && statusInput.trim().length > 0
              ? statusInput.trim()
              : undefined;

          const normalizedMappings: Array<{
            workstreamId: string;
            domain: string;
            role?: string;
            status?: string;
          }> = [];
          const seenWorkstreams = new Set<string>();
          const addMapping = (
            workstreamIdRaw: string,
            domainRaw: string,
            options?: { role?: string; status?: string }
          ): string | null => {
            const workstreamId = workstreamIdRaw.trim();
            if (!workstreamId || !isUuid(workstreamId)) {
              return `❌ workstream identifier '${workstreamIdRaw}' must be a valid UUID.`;
            }
            const domain = domainRaw.trim();
            if (!domain) {
              return `❌ workstream '${workstreamIdRaw}' must map to a non-empty domain string.`;
            }
            if (seenWorkstreams.has(workstreamId)) {
              return "❌ Duplicate workstream mapping detected.";
            }
            seenWorkstreams.add(workstreamId);
            normalizedMappings.push({
              workstreamId,
              domain,
              ...(options?.role?.trim() ? { role: options.role.trim() } : {}),
              ...(options?.status?.trim() ? { status: options.status.trim() } : {}),
            });
            return null;
          };

          if (params.workstream_domains !== undefined) {
            if (
              !params.workstream_domains ||
              typeof params.workstream_domains !== "object" ||
              Array.isArray(params.workstream_domains)
            ) {
              return text(
                "❌ workstream_domains must be an object mapping workstream_id to domain."
              );
            }
            const mappingEntries = Object.entries(
              params.workstream_domains as Record<string, unknown>
            );
            for (const [workstreamId, domainValue] of mappingEntries) {
              if (typeof domainValue !== "string") {
                return text(
                  `❌ workstream_domains['${workstreamId}'] must be a non-empty domain string.`
                );
              }
              const error = addMapping(workstreamId, domainValue);
              if (error) return text(error);
            }
          }

          if (params.mapping !== undefined) {
            if (
              !params.mapping ||
              typeof params.mapping !== "object" ||
              Array.isArray(params.mapping)
            ) {
              return text("❌ mapping must be an object of workstream_id -> domain.");
            }
            const mappingEntries = Object.entries(params.mapping as Record<string, unknown>);
            for (const [workstreamId, domainValue] of mappingEntries) {
              if (typeof domainValue !== "string") {
                return text(`❌ mapping['${workstreamId}'] must be a non-empty domain string.`);
              }
              const error = addMapping(workstreamId, domainValue);
              if (error) return text(error);
            }
          }

          if (params.mappings !== undefined) {
            if (!Array.isArray(params.mappings)) {
              return text("❌ mappings must be an array when provided.");
            }
            for (const entry of params.mappings) {
              if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                return text(
                  "❌ mappings entries must be objects with workstream_id and domain."
                );
              }
              const candidate = entry as Record<string, unknown>;
              const workstreamId = pickNonEmptyString(candidate.workstream_id);
              const domain = pickNonEmptyString(candidate.domain);
              const role = pickNonEmptyString(candidate.role);
              const status = pickNonEmptyString(candidate.status);
              if (!workstreamId || !domain) {
                return text("❌ Each mappings entry requires workstream_id and domain.");
              }
              const error = addMapping(workstreamId, domain, { role, status });
              if (error) return text(error);
            }
          }

          if (normalizedMappings.length === 0) {
            return text(
              "❌ Include workstream_domains, mapping, or mappings with at least one workstream reassignment."
            );
          }

          const updates: Array<{
            workstream_id: string;
            domain: string | null;
            before_domain: string | null;
            after_domain: string | null;
            ok: boolean;
            entity?: unknown;
            reassignment?: unknown;
            initiative_reassignment?: unknown;
            error?: string;
          }> = [];
          const domainBeforeByWorkstreamId = new Map<string, string | null>();
          if (typeof client.listEntities === "function") {
            try {
              const currentWorkstreams = await client.listEntities("workstream", {
                initiative_id: initiativeId,
                limit: 200,
              });
              const rows =
                currentWorkstreams &&
                typeof currentWorkstreams === "object" &&
                Array.isArray((currentWorkstreams as { data?: unknown }).data)
                  ? ((currentWorkstreams as { data: unknown[] }).data as unknown[])
                  : [];
              for (const row of rows) {
                if (!row || typeof row !== "object" || Array.isArray(row)) continue;
                const record = row as Record<string, unknown>;
                const id = pickNonEmptyString(record.id);
                if (!id) continue;
                domainBeforeByWorkstreamId.set(id, pickNonEmptyString(record.domain) ?? null);
              }
            } catch {
              // Best effort snapshot for before/after confirmation.
            }
          }

          for (const mapping of normalizedMappings) {
            const workstreamId = mapping.workstreamId;
            const domain = mapping.domain;
            const beforeDomain = domainBeforeByWorkstreamId.get(workstreamId) ?? null;

            const payload: Record<string, unknown> = {
              initiative_id: initiativeId,
              domain,
            };
            if (mapping.role !== undefined) payload.role = mapping.role;
            if (mapping.status !== undefined) {
              payload.status = mapping.status;
            } else if (normalizedStatus !== undefined) {
              payload.status = normalizedStatus;
            }

            try {
              const result = await client.updateEntityDetailed("workstream", workstreamId, payload);
              const entityRecord =
                result.entity && typeof result.entity === "object" && !Array.isArray(result.entity)
                  ? (result.entity as Record<string, unknown>)
                  : null;
              const reassignmentRecord =
                result.reassignment &&
                typeof result.reassignment === "object" &&
                !Array.isArray(result.reassignment)
                  ? (result.reassignment as unknown as Record<string, unknown>)
                  : null;
              const resolvedBeforeDomain =
                pickNonEmptyString(
                  beforeDomain,
                  reassignmentRecord?.before_domain,
                  reassignmentRecord?.previous_domain,
                  reassignmentRecord?.from_domain,
                  entityRecord?.before_domain,
                  entityRecord?.previous_domain,
                  entityRecord?.from_domain
                ) ?? null;
              const afterDomain =
                pickNonEmptyString(
                  reassignmentRecord?.after_domain,
                  reassignmentRecord?.new_domain,
                  reassignmentRecord?.to_domain,
                  entityRecord?.after_domain,
                  entityRecord?.new_domain,
                  entityRecord?.to_domain,
                  entityRecord?.domain,
                  domain
                ) ?? null;
              updates.push({
                workstream_id: workstreamId,
                domain,
                before_domain: resolvedBeforeDomain,
                after_domain: afterDomain,
                ok: true,
                entity: result.entity,
                reassignment: result.reassignment ?? null,
                initiative_reassignment: result.initiative_reassignment ?? null,
              });
            } catch (updateErr: unknown) {
              updates.push({
                workstream_id: workstreamId,
                domain,
                before_domain: beforeDomain,
                after_domain: null,
                ok: false,
                error: updateErr instanceof Error ? updateErr.message : String(updateErr),
              });
            }
          }

          const succeeded = updates.filter((entry) => entry.ok).length;
          const failed = updates.length - succeeded;
          return json(`✅ Reassigned ${succeeded}/${updates.length} workstream(s)`, {
            initiative_id: initiativeId,
            updated_count: succeeded,
            failed_count: failed,
            updates,
          });
        } catch (err: unknown) {
          return text(
            `❌ Batch stream reassignment failed: ${err instanceof Error ? err.message : err}`
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

  type AgentConfigId = "default";
  type AgentConfigTemplateId = "startup-speed";

  function evalGateErrorForPackStatus(status: unknown): string | null {
    if (typeof status !== "string") return null;
    const normalized = status.trim().toLowerCase();
    if (!normalized || normalized === "approved") return null;
    return `SkillPack eval gate blocked activation: status '${status}' is not approved`;
  }

  function manifestValidationErrorForPackManifest(manifest: unknown): string | null {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return null;
    }
    const validation = validateOpenClawSkillPackManifest(manifest as Record<string, unknown>);
    if (validation.errors.length === 0) return null;
    return `SkillPack manifest validation errors: ${validation.errors.join("; ")}`;
  }

  function computeSkillPackUpdateAvailable(state: {
    pack?: { checksum?: string | null } | null;
    remote?: { checksum?: string | null } | null;
  }): boolean {
    return Boolean(
      state.remote?.checksum &&
        state.pack?.checksum &&
        state.remote.checksum !== state.pack.checksum
    );
  }

  function resolveAgentConfigId(input: unknown): AgentConfigId | null {
    const value = typeof input === "string" ? input.trim() : "";
    if (!value || value === "default") {
      return "default";
    }
    return null;
  }

  function resolveAgentConfigTemplateId(input: unknown): AgentConfigTemplateId | null {
    const value = typeof input === "string" ? input.trim().toLowerCase() : "";
    if (value === "startup-speed") {
      return "startup-speed";
    }
    return null;
  }

  function buildAgentConfigSnapshot(state: ReturnType<RegisterCoreToolsDeps["readSkillPackState"]>) {
    return {
      config_id: "default",
      config_type: "skill_pack_policy",
      policy: state.policy,
      pack: state.pack,
      remote: state.remote,
      update_available: computeSkillPackUpdateAvailable(state),
      last_checked_at: state.lastCheckedAt,
      last_error: state.lastError,
      updated_at: state.updatedAt,
    };
  }

  async function readAgentConfigState(input?: {
    refreshRemote?: boolean;
  }): Promise<ReturnType<RegisterCoreToolsDeps["readSkillPackState"]>> {
    const state = readSkillPackState();
    if (!input?.refreshRemote) {
      return state;
    }

    const getSkillPack = (client as { getSkillPack?: unknown }).getSkillPack;
    if (typeof getSkillPack !== "function") {
      return state;
    }

    try {
      const response = await (
        getSkillPack as (args?: { name?: string; ifNoneMatch?: string | null }) => Promise<{
          ok: boolean;
          notModified?: boolean;
          etag?: string | null;
          pack?: {
            name: string;
            version: string;
            checksum: string;
            status?: string;
            manifest?: Record<string, unknown>;
            updated_at?: string | null;
          } | null;
          error?: string;
        }>
      )({
        name: state.pack?.name ?? state.remote?.name ?? "orgx-agent-suite",
        ifNoneMatch: null,
      });

      const checkedAt = new Date().toISOString();

      if (!response.ok) {
        return {
          ...state,
          updatedAt: checkedAt,
          lastCheckedAt: checkedAt,
          lastError: response.error ?? state.lastError,
        };
      }

      if (response.notModified || !response.pack) {
        return {
          ...state,
          updatedAt: checkedAt,
          lastCheckedAt: checkedAt,
          lastError: null,
          etag: response.etag ?? state.etag,
        };
      }

      const remote = {
        name: response.pack.name,
        version: response.pack.version,
        checksum: response.pack.checksum,
        updated_at: response.pack.updated_at ?? null,
      };
      const evalGateError = evalGateErrorForPackStatus(response.pack.status);
      const manifestValidationError = manifestValidationErrorForPackManifest(response.pack.manifest);
      const activationValidationError = evalGateError ?? manifestValidationError;
      const shouldApplyPack =
        !activationValidationError &&
        (!state.policy.pinnedChecksum || state.policy.pinnedChecksum === response.pack.checksum);

      return {
        ...state,
        updatedAt: checkedAt,
        lastCheckedAt: checkedAt,
        lastError: activationValidationError,
        etag: response.etag ?? state.etag,
        remote,
        pack: shouldApplyPack ? remote : state.pack,
      };
    } catch {
      return state;
    }
  }

  // --- list_agent_configs ---
  registerMcpTool(
    {
      name: "list_agent_configs",
      description:
        "List available agent behavior configs managed by this plugin.",
      parameters: {
        type: "object",
        properties: {
          refresh_remote: {
            type: "boolean",
            description:
              "When true, re-fetch behavior config policy from OrgX before returning data.",
          },
        },
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: { refresh_remote?: boolean } = {}
      ) {
        try {
          const state = await readAgentConfigState({
            refreshRemote: params.refresh_remote === true,
          });
          return json("Agent configs:", {
            total: 1,
            configs: [buildAgentConfigSnapshot(state)],
          });
        } catch (err: unknown) {
          return text(
            `❌ Failed to list agent configs: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  // --- get_agent_config ---
  registerMcpTool(
    {
      name: "get_agent_config",
      description:
        "Get a single agent behavior config by id (default only).",
      parameters: {
        type: "object",
        properties: {
          config_id: {
            type: "string",
            description: "Agent config identifier. Use 'default'.",
          },
          refresh_remote: {
            type: "boolean",
            description:
              "When true, re-fetch behavior config policy from OrgX before returning data.",
          },
        },
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: { config_id?: string; refresh_remote?: boolean } = {}
      ) {
        const configId = resolveAgentConfigId(params.config_id);
        if (!configId) {
          return text("❌ config_id must be 'default'.");
        }
        try {
          const state = await readAgentConfigState({
            refreshRemote: params.refresh_remote === true,
          });
          return json("Agent config:", buildAgentConfigSnapshot(state));
        } catch (err: unknown) {
          return text(
            `❌ Failed to read agent config: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  // --- update_agent_config ---
  registerMcpTool(
    {
      name: "update_agent_config",
      description:
        "Update plugin-managed agent behavior config policy (default config only).",
      parameters: {
        type: "object",
        properties: {
          config_id: {
            type: "string",
            description: "Agent config identifier. Use 'default'.",
          },
          frozen: {
            type: "boolean",
            description: "Freeze remote skill-pack refresh when true.",
          },
          pinned_checksum: {
            type: ["string", "null"],
            description: "Pin behavior policy to this exact checksum.",
          },
          pin_to_current: {
            type: "boolean",
            description: "Pin to current local/remote checksum.",
          },
          clear_pin: {
            type: "boolean",
            description: "Clear any pinned checksum.",
          },
          action: {
            type: "string",
            description: "Use 'rollback' to revert to the previous config version.",
          },
          rollback_to_audit_id: {
            type: "string",
            description:
              "Optional audit entry id to rollback to. When omitted with action='rollback', uses the most recent audit entry.",
          },
          template_id: {
            type: "string",
            description:
              "Optional preset template id. Currently supports 'startup-speed'.",
          },
        },
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: {
          config_id?: string;
          frozen?: boolean;
          pinned_checksum?: string | null;
          pin_to_current?: boolean;
          clear_pin?: boolean;
          action?: string;
          rollback_to_audit_id?: string;
          template_id?: string;
        } = {}
      ) {
        const configId = resolveAgentConfigId(params.config_id);
        if (!configId) {
          return text("❌ config_id must be 'default'.");
        }

        const templateId = resolveAgentConfigTemplateId(params.template_id);
        if (typeof params.template_id === "string" && !templateId) {
          return text("❌ template_id must be 'startup-speed' when provided.");
        }

        let hasFrozen = typeof params.frozen === "boolean";
        let hasPinnedChecksum =
          typeof params.pinned_checksum === "string" || params.pinned_checksum === null;
        let hasPinToCurrent = params.pin_to_current === true;
        let hasClearPin = params.clear_pin === true;
        const action = typeof params.action === "string" ? params.action.trim().toLowerCase() : "";
        const rollbackToAuditId =
          typeof params.rollback_to_audit_id === "string" && params.rollback_to_audit_id.trim()
            ? params.rollback_to_audit_id.trim()
            : undefined;
        const isRollback = action === "rollback" || typeof rollbackToAuditId === "string";

        if (action.length > 0 && action !== "rollback") {
          return text("❌ action must be 'rollback' when provided.");
        }

        if (templateId === "startup-speed") {
          // Shared default config fans out to all OrgX agent domains.
          params.frozen = false;
          params.clear_pin = true;
          params.pin_to_current = false;
          params.pinned_checksum = undefined;
          hasFrozen = true;
          hasPinnedChecksum = false;
          hasPinToCurrent = false;
          hasClearPin = true;
        }

        if (isRollback) {
          if (hasFrozen || hasPinnedChecksum || hasPinToCurrent || hasClearPin || templateId) {
            return text(
              "❌ Rollback requests cannot include update fields (frozen, pinned_checksum, pin_to_current, clear_pin, template_id)."
            );
          }
        } else if (!hasFrozen && !hasPinnedChecksum && !hasPinToCurrent && !hasClearPin) {
          return text(
            "❌ Include at least one mutable field: frozen, pinned_checksum, pin_to_current, clear_pin, or template_id."
          );
        }
        if (hasPinToCurrent && hasClearPin) {
          return text("❌ pin_to_current and clear_pin cannot both be true.");
        }
        if (typeof params.pinned_checksum === "string" && !params.pinned_checksum.trim()) {
          return text("❌ pinned_checksum must be a non-empty string when provided.");
        }

        try {
          const state = isRollback
            ? rollbackSkillPackPolicy({
                auditId: rollbackToAuditId,
              })
            : updateSkillPackPolicy({
                frozen: hasFrozen ? params.frozen : undefined,
                pinnedChecksum:
                  typeof params.pinned_checksum === "string"
                    ? params.pinned_checksum.trim()
                    : params.pinned_checksum === null
                      ? null
                      : undefined,
                pinToCurrent: hasPinToCurrent,
                clearPin: hasClearPin,
              });
          return json(
            isRollback ? "Agent config rolled back:" : "Agent config updated:",
            buildAgentConfigSnapshot(state)
          );
        } catch (err: unknown) {
          return text(
            `❌ Failed to ${isRollback ? "rollback" : "update"} agent config: ${err instanceof Error ? err.message : err}`
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
    const envWorkstreamId = pickNonEmptyString(process.env.ORGX_WORKSTREAM_ID);
    const envTaskId = pickNonEmptyString(process.env.ORGX_TASK_ID);
    const envAgentId = pickNonEmptyString(process.env.ORGX_AGENT_ID);
    const envAgentName = pickNonEmptyString(process.env.ORGX_AGENT_NAME);
    const canonicalMetadata: Record<string, unknown> = {
      initiative_id: context.value.initiativeId,
      run_id: context.value.runId ?? null,
      slice_run_id: context.value.runId ?? null,
      correlation_id: context.value.correlationId ?? null,
      source_client: context.value.sourceClient ?? null,
      ...(envWorkstreamId ? { workstream_id: envWorkstreamId } : {}),
      ...(envTaskId ? { task_id: envTaskId } : {}),
      ...(envAgentId ? { agent_id: envAgentId } : {}),
      ...(envAgentName ? { agent_name: envAgentName } : {}),
    };
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
        ...canonicalMetadata,
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
          confidence_score: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Self-assessed confidence for this artifact in [0,1].",
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
          confidence_score?: number;
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
        if (
          typeof params.confidence_score !== "undefined" &&
          (!Number.isFinite(params.confidence_score) ||
            params.confidence_score < 0 ||
            params.confidence_score > 1)
        ) {
          return text("❌ Cannot register artifact: confidence_score must be a number between 0 and 1.");
        }
        const confidenceScore =
          typeof params.confidence_score === "number" ? params.confidence_score : null;

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
            confidence_score: confidenceScore,
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
            confidence_score: confidenceScore,
            description: params.description ?? null,
            external_url: params.url ?? null,
            preview_markdown: params.content ?? null,
            status: "draft",
            metadata: {
              source: "orgx_register_artifact",
              artifact_id: artifactId,
              confidence_score: confidenceScore,
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
              confidence_score: confidenceScore,
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
