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
  sessionStore?: {
    workstreamSessionStore: Map<string, {
      sessionId: string;
      workstreamId: string;
      initiativeId: string;
      sourceClient: string;
      capturedAt: string;
      fromRunId: string;
    }>;
    getWorkstreamSession: (workstreamId: string) => {
      sessionId: string;
      workstreamId: string;
      initiativeId: string;
      sourceClient: string;
      capturedAt: string;
      fromRunId: string;
    } | null;
    setWorkstreamSession: (workstreamId: string, entry: {
      sessionId: string;
      workstreamId: string;
      initiativeId: string;
      sourceClient: string;
      capturedAt: string;
      fromRunId: string;
    }) => void;
    clearWorkstreamSession: (initiativeId: string) => void;
  };
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

  registerMcpTool(
    {
      name: "orgx_get_morning_brief",
      description:
        "Get the morning brief value surface: session summary, value signals, exceptions, trust events, and top receipts. Preferred replacement for ROI summary lookups.",
      parameters: {
        type: "object",
        properties: {
          workspace_id: {
            type: "string",
            description: "Workspace ID to load the brief for",
          },
          session_id: {
            type: "string",
            description: "Optional autonomous session ID",
          },
        },
        required: ["workspace_id"],
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: { workspace_id: string; session_id?: string } = {
          workspace_id: "",
        }
      ) {
        try {
          const result = await client.getMorningBrief({
            workspace_id: params.workspace_id,
            session_id: params.session_id,
          });
          return json("Morning brief:", result);
        } catch (err: unknown) {
          return text(
            `❌ Morning brief lookup failed: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  registerMcpTool(
    {
      name: "orgx_query_org_memory",
      description:
        "Search OrgX organizational memory (decisions, initiatives, artifacts). Preferred replacement for older decision-history lookups.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to search for",
          },
          scope: {
            type: "string",
            enum: ["all", "artifacts", "decisions", "initiatives"],
            description: "Optional memory scope",
          },
          limit: {
            type: "number",
            description: "Max results to return",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: {
          query: string;
          scope?: "all" | "artifacts" | "decisions" | "initiatives";
          limit?: number;
        } = { query: "" }
      ) {
        try {
          const result = await client.queryOrgMemory(params);
          const count = Array.isArray(result.results) ? result.results.length : 0;
          return json(
            count === 0
              ? "No matching results found."
              : `Found ${count} relevant item${count === 1 ? "" : "s"}.`,
            result
          );
        } catch (err: unknown) {
          return text(
            `❌ Org memory query failed: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  registerMcpTool(
    {
      name: "orgx_recommend_next_action",
      description:
        "Get the preferred next action for a workspace, initiative, workstream, or milestone. Preferred replacement for raw queue scoring in operator workflows.",
      parameters: {
        type: "object",
        properties: {
          entity_type: {
            type: "string",
            enum: ["workspace", "initiative", "workstream", "milestone"],
            description: "Entity type to recommend for (default: workspace)",
          },
          entity_id: {
            type: "string",
            description: "Entity ID. For workspace, use \"default\" or a workspace ID.",
          },
          workspace_id: {
            type: "string",
            description: "Optional canonical workspace scope",
          },
          command_center_id: {
            type: "string",
            description: "Deprecated alias for workspace_id",
          },
          limit: {
            type: "number",
            description: "Max recommendations to return",
          },
          cascade: {
            type: "boolean",
            description: "Refresh recommendations across the entity chain first",
          },
        },
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: {
          entity_type?: "workspace" | "initiative" | "workstream" | "milestone";
          entity_id?: string;
          workspace_id?: string;
          command_center_id?: string;
          limit?: number;
          cascade?: boolean;
        } = {}
      ) {
        try {
          const result = await client.recommendNextAction(params);
          const recommendations = Array.isArray(result.recommendations)
            ? result.recommendations
            : Array.isArray(result.items)
            ? result.items
            : [];
          return json(
            recommendations.length === 0
              ? "No recommendations available."
              : `Recommended ${recommendations.length} next action${
                  recommendations.length === 1 ? "" : "s"
                }.`,
            result
          );
        } catch (err: unknown) {
          return text(
            `❌ Recommendation lookup failed: ${err instanceof Error ? err.message : err}`
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
            description: "Legacy alias for agentDomain",
          },
          agentDomain: {
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
        required: ["taskId", "score"],
      },
      async execute(
        _callId: string,
        params: {
          taskId: string;
          domain?: string;
          agentDomain?: string;
          score: number;
          notes?: string;
        } = { taskId: "", score: 0 }
      ) {
        const agentDomain = pickNonEmptyString(
          params.agentDomain,
          params.domain
        );
        if (!agentDomain) {
          return text("❌ Provide domain or agentDomain.");
        }

        try {
          await client.recordQuality({
            ...params,
            agentDomain,
          });
          return text(
            `✅ Quality score recorded: ${params.score}/5 for task ${params.taskId} (${agentDomain})`
          );
        } catch (err: unknown) {
          const now = new Date().toISOString();
          const id = `quality:${randomUUID().slice(0, 8)}`;
          const { agentId, agentName } = deriveAgentIdentity(params);
          const activityItem: LiveActivityItem = {
            id,
            type: "artifact_created",
            title: "Quality score queued",
            description: `Task ${params.taskId} · ${agentDomain} · ${params.score}/5`,
            agentId,
            agentName,
            requesterAgentId: agentId,
            requesterAgentName: agentName,
            executorAgentId: agentId,
            executorAgentName: agentName,
            runId: null,
            initiativeId: null,
            timestamp: now,
            phase: "review",
            summary: `Quality ${params.score}/5 for ${agentDomain}`,
            metadata: {
              task_id: params.taskId,
              agent_domain: agentDomain,
              score: params.score,
            },
          };
          await appendToOutbox("quality", {
            id,
            type: "quality",
            timestamp: now,
            payload: {
              taskId: params.taskId,
              agentDomain,
              score: params.score,
              scoredAt: now,
              scoredBy: "auto",
              notes: params.notes,
            } as Record<string, unknown>,
            activityItem,
          });
          return text(
            `Quality score saved locally: ${params.score}/5 for task ${params.taskId} (${agentDomain}) (will sync when connected)`
          );
        }
      },
    },
    { optional: true }
  );

  // --- orgx_proof_status ---
  registerMcpTool(
    {
      name: "orgx_proof_status",
      description:
        "Check the proof chain status for a task or run. Returns a checklist of proof levels (L1-L7) with gaps highlighted. Use this to verify work is provably complete before marking done.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "ID of the task to check proof for",
          },
          run_id: {
            type: "string",
            description: "ID of the run to check proof for",
          },
        },
      },
      async execute(
        _callId: string,
        params: { task_id?: string; run_id?: string } = {}
      ) {
        const taskId = params.task_id || undefined;
        const runId = params.run_id || undefined;

        if (!taskId && !runId) {
          return text("❌ Provide at least one of task_id or run_id.");
        }

        try {
          const qp = new URLSearchParams();
          if (taskId) qp.set("task_id", taskId);
          if (runId) qp.set("run_id", runId);

          const result = await client.rawRequest<Record<string, unknown>>(
            "GET",
            `/api/flywheel/proof-status?${qp.toString()}`
          );

          // Format proof chain as readable checklist
          const levels = Array.isArray(result?.levels) ? result.levels : [];
          const overall = result?.overall_passed === true;
          const reasonCodes = Array.isArray(result?.reason_codes) ? result.reason_codes : [];

          if (levels.length === 0) {
            // Server may not have proof-status route yet (phase 1)
            return json("Proof status (local evaluation)", {
              task_id: taskId,
              run_id: runId,
              note: "Proof-status API not available. Register artifacts with atomic_unit_type metadata and use orgx_quality_score to build proof chain.",
              overall_passed: false,
              reason_codes: ["proof_api_not_available"],
            });
          }

          const lines: string[] = [];
          lines.push(overall ? "✅ Proof chain complete" : "⚠️ Proof chain incomplete");
          lines.push("");
          for (const lvl of levels as Array<Record<string, unknown>>) {
            const icon = lvl.passed ? "✅" : lvl.enforcement === "soft_warn" ? "⚠️" : "❌";
            lines.push(`${icon} ${lvl.label || lvl.level}: ${lvl.passed ? "passed" : "missing"}`);
            if (Array.isArray(lvl.missingFields) && lvl.missingFields.length > 0) {
              lines.push(`   Missing: ${(lvl.missingFields as string[]).join(", ")}`);
            }
          }
          if (reasonCodes.length > 0) {
            lines.push("");
            lines.push(`Reason codes: ${reasonCodes.join(", ")}`);
          }

          return json(lines.join("\n"), result);
        } catch (err: unknown) {
          // Graceful degradation: if proof API is not deployed, return helpful guidance
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("404") || msg.includes("not found") || msg.includes("Not Found")) {
            return json("Proof status (server not ready)", {
              task_id: taskId,
              run_id: runId,
              note: "Proof-status API not deployed yet. Ensure artifacts are registered with atomic_unit_type metadata to build the proof chain.",
              overall_passed: false,
              reason_codes: ["proof_api_not_deployed"],
            });
          }
          return text(`❌ Proof status check failed: ${msg}`);
        }
      },
    },
    { optional: true }
  );

  // --- orgx_verify_completion ---
  registerMcpTool(
    {
      name: "orgx_verify_completion",
      description:
        "Verify that an entity (task/milestone/workstream) meets completion requirements including proof chain. Returns structured result with any blocking issues.",
      parameters: {
        type: "object",
        properties: {
          entity_type: {
            type: "string",
            description: "Entity type: task, milestone, workstream",
          },
          entity_id: {
            type: "string",
            description: "ID of the entity to verify",
          },
        },
        required: ["entity_type", "entity_id"],
      },
      async execute(
        _callId: string,
        params: { entity_type: string; entity_id: string } = {
          entity_type: "",
          entity_id: "",
        }
      ) {
        try {
          const result = await client.rawRequest<Record<string, unknown>>(
            "POST",
            "/api/client/entities/verify-completion",
            {
              entity_type: params.entity_type,
              entity_id: params.entity_id,
            }
          );

          const ready = result?.ready === true;
          return json(
            ready
              ? `✅ ${params.entity_type} ${params.entity_id} is ready for completion.`
              : `⚠️ ${params.entity_type} ${params.entity_id} has blocking issues.`,
            result
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("404") || msg.includes("not found") || msg.includes("Not Found")) {
            return json("Completion verification (server not ready)", {
              entity_type: params.entity_type,
              entity_id: params.entity_id,
              ready: true,
              note: "Completion verification API not deployed. Proceeding with standard completion.",
            });
          }
          return text(`❌ Completion verification failed: ${msg}`);
        }
      },
    },
    { optional: true }
  );

  // --- orgx_record_outcome ---
  registerMcpTool(
    {
      name: "orgx_record_outcome",
      description:
        "Record an outcome event for a completed run, linking execution to business value. Required for L5 (Impact) proof level.",
      parameters: {
        type: "object",
        properties: {
          initiative_id: {
            type: "string",
            description: "Initiative ID this outcome belongs to",
          },
          execution_id: {
            type: "string",
            description: "Execution/run ID that produced this outcome",
          },
          execution_type: {
            type: "string",
            description:
              "Execution type label. Defaults to agent_run when omitted.",
          },
          run_id: {
            type: "string",
            description:
              "Existing OrgX run ID to attach the outcome to. If omitted, correlation_id and source_client are used.",
          },
          correlation_id: {
            type: "string",
            description:
              "Idempotency/correlation ID for this execution. Defaults to execution_id when run_id is omitted.",
          },
          source_client: {
            type: "string",
            enum: ["openclaw", "codex", "claude-code", "api"],
            description:
              "Client that produced the outcome. Defaults to openclaw when run_id is omitted.",
          },
          agent_id: {
            type: "string",
            description: "Agent that did the work",
          },
          success: {
            type: "boolean",
            description: "Whether the execution was successful",
          },
          quality_score: {
            type: "number",
            description: "Quality score 1-5",
          },
          domain: {
            type: "string",
            description: "Agent domain",
          },
          metadata: {
            type: "object",
            description: "Additional outcome metadata",
          },
        },
        required: ["initiative_id", "execution_id", "agent_id", "success"],
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: {
          initiative_id: string;
          execution_id: string;
          execution_type?: string;
          run_id?: string;
          correlation_id?: string;
          source_client?: ReportingSourceClient;
          agent_id: string;
          success: boolean;
          quality_score?: number;
          domain?: string;
          metadata?: Record<string, unknown>;
        } = {
          initiative_id: "",
          execution_id: "",
          agent_id: "",
          success: false,
        }
      ) {
        try {
          const runId = pickNonEmptyString(params.run_id);
          const correlationId = pickNonEmptyString(
            params.correlation_id,
            params.execution_id
          );
          const sourceClient = params.source_client ?? "openclaw";
          const result = await client.recordRunOutcome({
            initiative_id: params.initiative_id,
            execution_id: params.execution_id,
            execution_type:
              pickNonEmptyString(params.execution_type) ?? "agent_run",
            agent_id: params.agent_id,
            success: params.success,
            quality_score: params.quality_score,
            domain: params.domain,
            metadata: params.metadata,
            ...(runId
              ? { run_id: runId }
              : {
                  correlation_id: correlationId,
                  source_client: sourceClient,
                }),
          });
          return json(
            `✅ Outcome recorded for run ${result.run_id} (event: ${result.event_id})`,
            result
          );
        } catch (err: unknown) {
          return text(
            `❌ Outcome recording failed: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  // --- orgx_get_outcome_attribution ---
  registerMcpTool(
    {
      name: "orgx_get_outcome_attribution",
      description:
        "Get outcome attribution data for a task or run. Shows what value was attributed to the work and with what confidence. Required for L6 (Economics) proof level.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Task ID to get attribution for",
          },
          run_id: {
            type: "string",
            description: "Run ID to get attribution for",
          },
        },
      },
      async execute(
        _callId: string,
        params: { task_id?: string; run_id?: string } = {}
      ) {
        const taskId = params.task_id || undefined;
        const runId = params.run_id || undefined;

        if (!taskId && !runId) {
          return text("❌ Provide at least one of task_id or run_id.");
        }

        try {
          const qp = new URLSearchParams();
          if (taskId) qp.set("task_id", taskId);
          if (runId) qp.set("run_id", runId);

          const result = await client.rawRequest<Record<string, unknown>>(
            "GET",
            `/api/flywheel/outcome-attribution?${qp.toString()}`
          );
          return json("Outcome attribution", result);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("404") || msg.includes("not found") || msg.includes("Not Found")) {
            return json("Outcome attribution (not available)", {
              task_id: taskId,
              run_id: runId,
              note: "Attribution API not deployed yet.",
            });
          }
          return text(`❌ Attribution lookup failed: ${msg}`);
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
          workspace_id: {
            type: "string",
            description: "Workspace ID (canonical; preferred for new callers)",
          },
          command_center_id: {
            type: "string",
            description: "Deprecated alias for workspace_id",
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
          initiative_id: {
            type: "string",
            description: "Filter by initiative ID",
          },
          project_id: {
            type: "string",
            description: "Legacy project/workspace scope filter",
          },
          workspace_id: {
            type: "string",
            description: "Workspace ID (canonical scope)",
          },
          command_center_id: {
            type: "string",
            description: "Deprecated alias for workspace_id",
          },
        },
        required: ["type"],
      },
      async execute(
        _callId: string,
        params: {
          type: string;
          status?: string;
          limit?: number;
          initiative_id?: string;
          project_id?: string;
          workspace_id?: string;
          command_center_id?: string;
        } = { type: "" }
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

  function deriveAgentIdentity(payload?: unknown): {
    agentId: string | null;
    agentName: string | null;
  } {
    const envAgentId = pickNonEmptyString(process.env.ORGX_AGENT_ID) ?? null;
    const envAgentName = pickNonEmptyString(process.env.ORGX_AGENT_NAME) ?? null;
    const payloadRecord =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    const metadataRaw = payloadRecord?.metadata;
    const metadata =
      metadataRaw && typeof metadataRaw === "object" && !Array.isArray(metadataRaw)
        ? (metadataRaw as Record<string, unknown>)
        : {};
    const metadataAgentId =
      pickNonEmptyString(
        metadata.agent_id,
        metadata.agentId,
        metadata.executor_agent_id,
        metadata.executorAgentId,
        metadata.requested_by_agent_id,
        metadata.requestedByAgentId
      ) ?? null;
    const metadataAgentName =
      pickNonEmptyString(
        metadata.agent_name,
        metadata.agentName,
        metadata.executor_agent_name,
        metadata.executorAgentName,
        metadata.requested_by_agent_name,
        metadata.requestedByAgentName
      ) ?? null;
    return {
      agentId: envAgentId ?? metadataAgentId,
      agentName: envAgentName ?? metadataAgentName,
    };
  }

  function deriveCorrelationFromRun(runId: string): string {
    return `openclaw_run_${runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
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
    const { agentId, agentName } = deriveAgentIdentity(payload);
    const canonicalMetadata: Record<string, unknown> = {
      initiative_id: context.value.initiativeId,
      run_id: context.value.runId ?? null,
      slice_run_id: context.value.runId ?? null,
      correlation_id: context.value.correlationId ?? null,
      source_client: context.value.sourceClient ?? null,
      ...(envWorkstreamId ? { workstream_id: envWorkstreamId } : {}),
      ...(envTaskId ? { task_id: envTaskId } : {}),
      ...(agentId ? { agent_id: agentId } : {}),
      ...(agentName ? { agent_name: agentName } : {}),
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
      agentId,
      agentName,
      requesterAgentId: agentId,
      requesterAgentName: agentName,
      executorAgentId: agentId,
      executorAgentName: agentName,
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
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (
        normalizedPayload.run_id &&
        /^404\b/.test(errMsg) &&
        /\brun\b/i.test(errMsg) &&
        /not found/i.test(errMsg)
      ) {
        try {
          const retryCorrelation =
            normalizedPayload.correlation_id ?? deriveCorrelationFromRun(normalizedPayload.run_id);
          const retryResult = await client.emitActivity({
            ...normalizedPayload,
            run_id: undefined,
            correlation_id: retryCorrelation,
            metadata: withProvenanceMetadata({
              ...(normalizedPayload.metadata ?? {}),
              replay_run_id_as_correlation: true,
            }),
          });
          return text(
            `Activity emitted: ${payload.message} [${normalizedPayload.phase}${
              payload.progress_pct != null ? ` ${payload.progress_pct}%` : ""
            }] (run ${retryResult.run_id.slice(0, 8)}...)`
          );
        } catch {
          // Fall through to local outbox buffering.
        }
      }
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
    const { agentId, agentName } = deriveAgentIdentity();

    const activityItem: LiveActivityItem = {
      id,
      type: "milestone_completed",
      title: "Changeset queued",
      description: `${payload.operations.length} operation${
        payload.operations.length === 1 ? "" : "s"
      }`,
      agentId,
      agentName,
      requesterAgentId: agentId,
      requesterAgentName: agentName,
      executorAgentId: agentId,
      executorAgentName: agentName,
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
        run_id: context.value.runId ?? null,
        correlation_id: context.value.correlationId ?? null,
        ...(agentId ? { agent_id: agentId } : {}),
        ...(agentName ? { agent_name: agentName } : {}),
      }),
    };

    try {
      const result = await client.applyChangeset(requestPayload);
      return text(
        `Changeset ${result.replayed ? "replayed" : "applied"}: ${result.applied_count} op${
          result.applied_count === 1 ? "" : "s"
        } (run ${result.run_id.slice(0, 8)}...)`
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (
        requestPayload.run_id &&
        /^404\b/.test(errMsg) &&
        /\brun\b/i.test(errMsg) &&
        /not found/i.test(errMsg)
      ) {
        try {
          const retryResult = await client.applyChangeset({
            ...requestPayload,
            run_id: undefined,
            correlation_id:
              requestPayload.correlation_id ?? deriveCorrelationFromRun(requestPayload.run_id),
          });
          return text(
            `Changeset ${retryResult.replayed ? "replayed" : "applied"}: ${retryResult.applied_count} op${
              retryResult.applied_count === 1 ? "" : "s"
            } (run ${retryResult.run_id.slice(0, 8)}...)`
          );
        } catch {
          // Fall through to local outbox buffering.
        }
      }
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

  // --- update_stream_progress (legacy alias -> orgx_report_progress) ---
  registerMcpTool(
    {
      name: "update_stream_progress",
      description:
        "Legacy alias for orgx_report_progress. Report progress at key milestones so the team can track your work.",
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
        return emitActivityWithFallback("update_stream_progress", {
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
            description:
              "Durable proof source for the artifact: a public permalink (GitHub PR/commit/blob, published doc URL) or an absolute file path.",
          },
          content: {
            type: "string",
            description:
              "Inline preview content (markdown/text). Supplemental only; it does not replace a durable source URL or file path.",
          },
          metadata: {
            type: "object",
            description:
              "Optional artifact metadata. Use for proof fields such as commit_sha, branch, artifact_hash, quality_gate, or schema validation signals.",
          },
          queue_ref: {
            type: "object",
            description:
              "Optional proof-chain queue reference linking this artifact to the initiative/workstream/task queue item.",
            properties: {
              initiative_id: { type: "string" },
              workstream_id: { type: "string" },
              task_id: { type: "string" },
            },
            additionalProperties: false,
          },
          run_ref: {
            type: "object",
            description:
              "Optional proof-chain run reference linking this artifact to the producing run/session.",
            properties: {
              run_id: { type: "string" },
              correlation_id: { type: "string" },
              session_id: { type: "string" },
            },
            additionalProperties: false,
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
          metadata?: Record<string, unknown>;
          queue_ref?: {
            initiative_id?: string;
            workstream_id?: string;
            task_id?: string;
          };
          run_ref?: {
            run_id?: string;
            correlation_id?: string;
            session_id?: string;
          };
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

        if (!params.url) {
          return text(
            "❌ Cannot register artifact: provide a durable source URL or absolute file path."
          );
        }
        if (
          /^https?:\/\/(?:www\.)?useorgx\.com\/(?:orgx\/)?live\//i.test(params.url) ||
          /^https?:\/\/(?:www\.)?useorgx\.com\/(?:orgx\/)?artifacts\//i.test(params.url) ||
          /^https?:\/\/(?:www\.)?useorgx\.com\/(?:orgx\/)?console\//i.test(params.url)
        ) {
          return text(
            "❌ Cannot register artifact: OrgX live/artifact pages are wrappers, not durable proof sources. Use a GitHub permalink, published URL, or absolute file path."
          );
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
        const { agentId, agentName } = deriveAgentIdentity(params);
        const callerMetadata =
          params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
            ? params.metadata
            : {};
        const queueRef =
          params.queue_ref && typeof params.queue_ref === "object" && !Array.isArray(params.queue_ref)
            ? params.queue_ref
            : undefined;
        const runRef =
          params.run_ref && typeof params.run_ref === "object" && !Array.isArray(params.run_ref)
            ? params.run_ref
            : undefined;
        const proofMetadata = {
          ...callerMetadata,
          source: "orgx_register_artifact",
          artifact_id: artifactId,
          confidence_score: confidenceScore,
          ...(queueRef ? { queue_ref: queueRef } : {}),
          ...(runRef ? { run_ref: runRef } : {}),
        };

        const activityItem: LiveActivityItem = {
          id,
          type: "artifact_created",
          title: params.name,
          description: params.description ?? null,
          agentId,
          agentName,
          requesterAgentId: agentId,
          requesterAgentName: agentName,
          executorAgentId: agentId,
          executorAgentName: agentName,
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
            ...(queueRef ? { queue_ref: queueRef } : {}),
            ...(runRef ? { run_ref: runRef } : {}),
            ...(agentId ? { agent_id: agentId } : {}),
            ...(agentName ? { agent_name: agentName } : {}),
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
            metadata: proofMetadata,
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
              metadata: proofMetadata,
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

  // --- orgx_agent_sessions ---
  registerMcpTool(
    {
      name: "orgx_agent_sessions",
      description:
        "List active CLI session IDs stored for workstreams. Used for session resume support.",
      parameters: {
        type: "object",
        properties: {
          initiativeId: {
            type: "string",
            description: "Optional initiative ID filter.",
          },
        },
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: { initiativeId?: string } = {}
      ) {
        const store = deps.sessionStore;
        if (!store) {
          return text("Session store not available.");
        }
        const entries: Array<Record<string, unknown>> = [];
        for (const [, entry] of store.workstreamSessionStore.entries()) {
          if (params.initiativeId && entry.initiativeId !== params.initiativeId) continue;
          entries.push({ ...entry });
        }
        return json("Agent sessions:", {
          count: entries.length,
          sessions: entries,
        });
      },
    },
    { optional: true }
  );

  // --- orgx_resume_agent_session ---
  registerMcpTool(
    {
      name: "orgx_resume_agent_session",
      description:
        "Store or update a CLI session ID for a workstream so the next slice resumes it.",
      parameters: {
        type: "object",
        properties: {
          workstreamId: { type: "string", description: "Workstream UUID" },
          sessionId: { type: "string", description: "CLI session UUID to resume" },
          initiativeId: { type: "string", description: "Initiative UUID" },
          sourceClient: { type: "string", description: "Source client (codex, claude-code)" },
        },
        required: ["workstreamId", "sessionId", "initiativeId"],
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: {
          workstreamId: string;
          sessionId: string;
          initiativeId: string;
          sourceClient?: string;
        } = { workstreamId: "", sessionId: "", initiativeId: "" }
      ) {
        const store = deps.sessionStore;
        if (!store) {
          return text("Session store not available.");
        }
        if (!params.workstreamId || !params.sessionId || !params.initiativeId) {
          return text("Missing required parameters: workstreamId, sessionId, initiativeId.");
        }
        store.setWorkstreamSession(params.workstreamId, {
          sessionId: params.sessionId,
          workstreamId: params.workstreamId,
          initiativeId: params.initiativeId,
          sourceClient: params.sourceClient ?? "unknown",
          capturedAt: new Date().toISOString(),
          fromRunId: "manual",
        });
        return text(`Session ${params.sessionId} stored for workstream ${params.workstreamId}.`);
      },
    },
    { optional: true }
  );

  // --- orgx_clear_agent_session ---
  registerMcpTool(
    {
      name: "orgx_clear_agent_session",
      description:
        "Clear stored CLI session IDs for an initiative (forces fresh sessions on next dispatch).",
      parameters: {
        type: "object",
        properties: {
          initiativeId: { type: "string", description: "Initiative UUID" },
        },
        required: ["initiativeId"],
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: { initiativeId: string } = { initiativeId: "" }
      ) {
        const store = deps.sessionStore;
        if (!store) {
          return text("Session store not available.");
        }
        if (!params.initiativeId) {
          return text("Missing required parameter: initiativeId.");
        }
        store.clearWorkstreamSession(params.initiativeId);
        return text(`Sessions cleared for initiative ${params.initiativeId}.`);
      },
    },
    { optional: true }
  );

  return mcpToolRegistry;
}
