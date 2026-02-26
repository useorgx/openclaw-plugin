import type { ChildProcess } from "node:child_process";
import { randomUUID as randomUuidFn } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { OrgXClient } from "../../api.js";
import type { Entity } from "../../types.js";
import {
  normalizeActivityActionPhase,
  normalizeActivityActionType,
} from "../../contracts/shared-types.js";
import { upsertAgentContext, upsertRunContext } from "../../agent-context-store.js";
import { appendTeamCompletion } from "../../team-context-store.js";
import {
  readOpenClawGatewayPort,
  readOpenClawSettingsSnapshot,
} from "../../openclaw-settings.js";
import {
  resolveRuntimeHookToken,
  type RuntimeHookPayload,
  type RuntimeInstanceRecord,
  type RuntimeSourceClient,
} from "../../runtime-instance-store.js";
import { detectMcpHandshakeFailure, shouldKillWorker } from "../../worker-supervisor.js";
import { getOrgxPluginConfigDir } from "../../paths.js";
import {
  buildMissionControlGraph,
  DEFAULT_TOKEN_BUDGET_ASSUMPTIONS,
  dedupeStrings,
  detectBehaviorConfigDrift,
  deriveBehaviorAutomationLevel,
  deriveBehaviorConfigContext,
  deriveExecutionPolicy,
  evaluateScopeCompletion,
  isDispatchableWorkstreamStatus,
  isDoneStatus,
  isTodoStatus,
  readBudgetEnvNumber,
  selectSliceTasksByScope,
  SLICE_SCOPE_TIMEOUT_MULTIPLIER,
  spawnGuardIsRateLimited,
  summarizeSpawnGuardBlockReason,
  type MissionControlNode,
  type SliceScope,
} from "./mission-control.js";
import { createAutopilotRuntime } from "./autopilot-runtime.js";
import {
  buildScopeDirective,
  buildSliceOutputInstructions,
  buildWorkstreamSlicePrompt,
  createCodexBinResolver,
  ensureAutopilotSliceSchemaPath,
  fileUpdatedAtEpochMs,
  parseSliceResult,
  readFileTailSafe,
  readSliceOutputFile,
  type CodexBinInfo,
} from "./autopilot-slice-utils.js";
import { pickString } from "./value-utils.js";
import type { KickoffContext, KickoffContextRequest } from "../../types.js";

export interface CreateAutoContinueEngineDeps {
  client: OrgXClient;
  filename: string;
  safeErrorMessage: (err: unknown) => string;
  pidAlive: (pid: number) => boolean;
  stopProcess: (pid: number) => Promise<{ stopped: boolean; wasRunning: boolean }>;
  resolveOrgxAgentForDomain: (domain: string) => { id: string; name: string };
  checkSpawnGuardSafe: (input: {
    domain: string;
    taskId?: string | null;
    initiativeId: string | null;
    correlationId: string;
    runId?: string | null;
    targetLabel?: string | null;
  }) => Promise<unknown | null>;
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
    level?: "info" | "warn" | "error";
    message: string;
    progressPct?: number;
    nextStep?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  requestDecisionSafe: (input: {
    initiativeId: string | null;
    correlationId?: string | null;
    title: string;
    summary?: string | null;
    urgency?: "low" | "medium" | "high" | "urgent";
    options?: Array<string | Record<string, unknown>>;
    blocking?: boolean;
    decisionType?: string | null;
    workstreamId?: string | null;
    agentId?: string | null;
    dueAt?: string | null;
    sourceSystem?: string | null;
    conflictSource?: string | null;
    dedupeKey?: string | null;
    recommendedAction?: string | null;
    sourceRunId?: string | null;
    sourceSessionId?: string | null;
    sourceStreamId?: string | null;
    sourceRef?: Record<string, unknown> | null;
    evidenceRefs?: Array<Record<string, unknown>> | null;
    metadata?: Record<string, unknown> | null;
  }) => Promise<boolean | { queued: boolean; decisionIds?: string[] }>;
  registerArtifactSafe: (input: {
    initiativeId: string;
    runId: string;
    agentId: string;
    agentName?: string | null;
    workstreamId: string;
    fallbackMilestoneId?: string | null;
    fallbackTaskIds?: string[] | null;
    artifact: {
      name: string;
      artifact_type?: string | null;
      confidence_score?: number | null;
      description?: string | null;
      url?: string | null;
      milestone_id?: string | null;
      task_ids?: string[] | null;
    };
    isMockWorker?: boolean;
  }) => Promise<{ ok: boolean; id: string | null }>;
  applyAgentStatusUpdatesSafe: (input: {
    initiativeId: string;
    runId: string;
    correlationId: string;
    taskUpdates: Array<{ task_id: string; status: string; reason?: string | null }>;
    milestoneUpdates: Array<{ milestone_id: string; status: string; reason?: string | null }>;
    isMockWorker?: boolean;
  }) => Promise<{
    applied: number;
    buffered: boolean;
    taskUpdates: Array<{ taskId: string; status: string; reason: string | null }>;
    milestoneUpdates: Array<{ milestoneId: string; status: string; reason: string | null }>;
  }>;
  upsertRuntimeInstanceFromHook: (
    payload: RuntimeHookPayload
  ) => RuntimeInstanceRecord;
  broadcastRuntimeSse: (
    event: string,
    payload: RuntimeInstanceRecord
  ) => void;
  clearSnapshotResponseCache: () => void;
  resolveByokEnvOverrides: () => Record<string, string | undefined>;
  randomUUID?: () => string;
  fetchKickoffContextSafe?: (
    client: OrgXClient,
    payload: KickoffContextRequest,
  ) => Promise<KickoffContext | null>;
  renderKickoffMessage?: (input: {
    baseMessage: string;
    kickoff: KickoffContext | null;
    domain: string | null;
    requiredSkills: string[];
  }) => { message: string; contextHash: string | null };
}

function resolveAutopilotDefaultCwd(filename: string): string {
  let cursor = dirname(filename);
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(cursor, "package.json"))) return cursor;
    const parent = dirname(cursor);
    if (!parent || parent === cursor) break;
    cursor = parent;
  }
  return homedir();
}

export function createAutoContinueEngine(deps: CreateAutoContinueEngineDeps) {
  const {
    client,
    safeErrorMessage,
    pidAlive,
    stopProcess,
    resolveOrgxAgentForDomain,
    checkSpawnGuardSafe,
    syncParentRollupsForTask,
    emitActivitySafe,
    requestDecisionSafe,
    registerArtifactSafe,
    applyAgentStatusUpdatesSafe,
    upsertRuntimeInstanceFromHook,
    broadcastRuntimeSse,
    clearSnapshotResponseCache,
    resolveByokEnvOverrides,
  } = deps;
  const randomUUID = deps.randomUUID ?? randomUuidFn;
  const fetchKickoffContextSafeFn = deps.fetchKickoffContextSafe ?? null;
  const renderKickoffMessageFn = deps.renderKickoffMessage ?? null;
  const decisionAutoResolveGuardedEnabled =
    String(process.env.DECISION_AUTO_RESOLVE_GUARDED_ENABLED ?? "true")
      .trim()
      .toLowerCase() !== "false";
  /** Spread into any metadata object to flag mock-worker activity. */
  function mockMeta(slice: { isMockWorker: boolean }): Record<string, unknown> {
    return slice.isMockWorker ? { mock: true } : {};
  }
  type DecisionRequestOutcome = { queued: boolean; decisionIds: string[] };
  const requestDecisionQueued = async (
    input: Parameters<CreateAutoContinueEngineDeps["requestDecisionSafe"]>[0]
  ): Promise<DecisionRequestOutcome> => {
    const inferredRunId =
      (typeof input.sourceRunId === "string" && input.sourceRunId.trim().length > 0
        ? input.sourceRunId.trim()
        : null) ??
      (typeof input.correlationId === "string" && input.correlationId.trim().length > 0
        ? input.correlationId.trim()
        : null);
    const inferredSessionId =
      (typeof input.sourceSessionId === "string" && input.sourceSessionId.trim().length > 0
        ? input.sourceSessionId.trim()
        : null) ?? inferredRunId;
    const inferredStreamId =
      (typeof input.sourceStreamId === "string" && input.sourceStreamId.trim().length > 0
        ? input.sourceStreamId.trim()
        : null) ??
      (typeof input.workstreamId === "string" && input.workstreamId.trim().length > 0
        ? input.workstreamId.trim()
        : null);
    const sourceRefBase =
      input.sourceRef && typeof input.sourceRef === "object" && !Array.isArray(input.sourceRef)
        ? (input.sourceRef as Record<string, unknown>)
        : {};
    const normalizedInput: Parameters<CreateAutoContinueEngineDeps["requestDecisionSafe"]>[0] = {
      ...input,
      sourceRunId: inferredRunId,
      sourceSessionId: inferredSessionId,
      sourceStreamId: inferredStreamId,
      sourceRef: {
        ...sourceRefBase,
        run_id: sourceRefBase.run_id ?? inferredRunId,
        session_id: sourceRefBase.session_id ?? inferredSessionId,
        stream_id: sourceRefBase.stream_id ?? inferredStreamId,
        workstream_id: sourceRefBase.workstream_id ?? input.workstreamId ?? null,
      },
      metadata: {
        ...(input.metadata ?? {}),
        source_system: input.sourceSystem ?? null,
        conflict_source: input.conflictSource ?? null,
      },
    };
    const result = await requestDecisionSafe(normalizedInput);
    if (typeof result === "boolean") {
      return { queued: result, decisionIds: [] };
    }
    if (result && typeof result === "object" && "queued" in result) {
      const record = result as { queued?: unknown; decisionIds?: unknown };
      const decisionIds = Array.isArray(record.decisionIds)
        ? record.decisionIds
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : [];
      return {
        queued: Boolean(record.queued),
        decisionIds,
      };
    }
    return { queued: false, decisionIds: [] };
  };
  const __filename = deps.filename;
  type AutoContinueStopReason =
    | "budget_exhausted"
    | "blocked"
    | "completed"
    | "stopped"
    | "error";

  type AutoContinueStatus = "running" | "stopping" | "stopped";
  type AutoContinueParallelMode = "iwmt";
  type AutoContinueLaneState =
    | "idle"
    | "running"
    | "blocked"
    | "waiting_dependency"
    | "rate_limited"
    | "completed";

  type AutoContinueLane = {
    workstreamId: string;
    state: AutoContinueLaneState;
    activeRunId: string | null;
    activeTaskIds: string[];
    blockedReason: string | null;
    waitingOnWorkstreamIds: string[];
    retryAt: string | null;
    updatedAt: string;
  };

  type AutoContinueRun = {
    initiativeId: string;
    agentId: string;
    agentName: string | null;
    includeVerification: boolean;
    allowedWorkstreamIds: string[] | null;
    // When true, stop the run after the next slice completes (used for one-shot "Play").
    stopAfterSlice: boolean;
    // Explicit operator override for one-shot Play when spawn guard is only rate-limited.
    ignoreSpawnGuardRateLimit: boolean;
    maxParallelSlices: number;
    parallelMode: AutoContinueParallelMode;
    scope: SliceScope;
    tokenBudget: number | null;
    tokensUsed: number;
    status: AutoContinueStatus;
    stopReason: AutoContinueStopReason | null;
    stopRequested: boolean;
    startedAt: string;
    stoppedAt: string | null;
    updatedAt: string;
    lastError: string | null;
    lastTaskId: string | null;
    lastRunId: string | null;
    activeSliceRunIds: string[];
    activeTaskIds: string[];
    laneByWorkstreamId: Record<string, AutoContinueLane>;
    blockedWorkstreamIds: string[];
    activeTaskId: string | null;
    activeRunId: string | null;
    activeTaskTokenEstimate: number | null;
  };

  const autoContinueRuns = new Map<string, AutoContinueRun>();
  const localInitiativeStatusOverrides = new Map<
    string,
    { status: string; updatedAt: string }
  >();
  const localTaskStatusOverrides = new Map<
    string,
    Map<string, { status: string; updatedAt: string; reason: string | null }>
  >();
  const localMilestoneStatusOverrides = new Map<
    string,
    Map<string, { status: string; updatedAt: string; reason: string | null }>
  >();
  let autoContinueTickInFlight: Promise<void> | null = null;
  const AUTO_CONTINUE_TICK_MS = readBudgetEnvNumber("ORGX_AUTO_CONTINUE_TICK_MS", 2_500, {
    min: 250,
    max: 60_000,
  });
  const AUTO_CONTINUE_PARALLEL_MIN = 1;
  const AUTO_CONTINUE_PARALLEL_MAX = 5;
  const AUTO_CONTINUE_MAX_PARALLEL_DEFAULT = Math.max(
    AUTO_CONTINUE_PARALLEL_MIN,
    Math.min(
      AUTO_CONTINUE_PARALLEL_MAX,
      Math.round(
        readBudgetEnvNumber(
          "ORGX_AUTO_CONTINUE_MAX_PARALLEL_DEFAULT",
          5,
          { min: AUTO_CONTINUE_PARALLEL_MIN, max: AUTO_CONTINUE_PARALLEL_MAX }
        )
      )
    )
  );

  const normalizeParallelMode = (_value: unknown): AutoContinueParallelMode => "iwmt";
  const normalizeMaxParallelSlices = (value: unknown, fallback: number): number => {
    const normalizedFallback = Math.max(
      AUTO_CONTINUE_PARALLEL_MIN,
      Math.min(AUTO_CONTINUE_PARALLEL_MAX, Math.round(fallback || AUTO_CONTINUE_PARALLEL_MIN))
    );
    if (typeof value === "number" && Number.isFinite(value)) {
      const parsed = Math.round(value);
      return Math.max(
        AUTO_CONTINUE_PARALLEL_MIN,
        Math.min(AUTO_CONTINUE_PARALLEL_MAX, parsed)
      );
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        const rounded = Math.round(parsed);
        return Math.max(
          AUTO_CONTINUE_PARALLEL_MIN,
          Math.min(AUTO_CONTINUE_PARALLEL_MAX, rounded)
        );
      }
    }
    return normalizedFallback;
  };

  // ---------------------------------------------------------------------------
  // Auto-continue v2 (Workstream Slices)
  //
  // Dispatches sets of work (a "slice") for a workstream and expects verifiable
  // outcomes that can be registered as OrgX artifacts + decisions.
  //
  // Important: we do NOT auto-mark OrgX tasks/initiatives as done.
  // ---------------------------------------------------------------------------

  type AutoContinueSliceStatus = "running" | "completed" | "blocked" | "error";
  type AutoContinueSliceDecision = {
    question: string;
    summary?: string | null;
    options?: string[] | null;
    urgency?: "low" | "medium" | "high" | "urgent";
    blocking?: boolean | null;
  };
  type AutoContinueSliceSkillEvidence = {
    skill: string;
    skill_file?: string | null;
    skill_sha256?: string | null;
    skill_heading?: string | null;
  };
  type AutoContinueSliceArtifact = {
    name: string;
    artifact_type?: string | null;
    confidence_score?: number | null;
    description?: string | null;
    url?: string | null;
    verification_steps?: string[] | null;
    milestone_id?: string | null;
    task_ids?: string[] | null;
  };
  type AutoContinueSliceResult = {
    status: "completed" | "blocked" | "needs_decision" | "error";
    summary: string;
    artifacts?: AutoContinueSliceArtifact[] | null;
    decisions_needed?: AutoContinueSliceDecision[] | null;
    skill_evidence?: AutoContinueSliceSkillEvidence[] | null;
    task_updates?: Array<{ task_id: string; status: string; reason?: string | null }> | null;
    milestone_updates?: Array<{ milestone_id: string; status: string; reason?: string | null }> | null;
    next_actions?: string[] | null;
  };
  type AutoContinueSliceRun = {
    runId: string;
    initiativeId: string;
    initiativeTitle: string | null;
    workstreamId: string;
    workstreamTitle: string | null;
    agentId: string;
    agentName: string | null;
    domain: string;
    requiredSkills: string[];
    behaviorConfigId: string | null;
    behaviorConfigVersion: string | null;
    behaviorConfigHash: string | null;
    behaviorPolicySource: string | null;
    behaviorAutomationLevel: "auto" | "supervised" | "manual";
    sourceClient: RuntimeSourceClient;
    pid: number | null;
    status: AutoContinueSliceStatus;
    startedAt: string;
    finishedAt: string | null;
    updatedAt: string;
    tokenEstimate: number | null;
    outputPath: string;
    logPath: string;
    taskIds: string[];
    milestoneIds: string[];
    scope: SliceScope;
    scopeMilestoneIds: string[];
    lastError: string | null;
    isMockWorker: boolean;
  };
  type AutoFixSkipReason =
    | "paused_by_user"
    | "already_running"
    | "missing_workstream"
    | "missing_scope"
    | "error";
  type PendingAutoFix = {
    requestId: string;
    key: string;
    initiativeId: string;
    workstreamId: string;
    runId: string | null;
    sourceEvent: string | null;
    requestedByAgentId: string | null;
    requestedByAgentName: string | null;
    graceMs: number;
    scheduledAt: string;
    dueAt: string;
    timer: NodeJS.Timeout | null;
  };

  type AutoContinueRunContext = Pick<
    AutoContinueRun,
    "initiativeId" | "agentId" | "agentName" | "scope"
  >;

  const buildSliceEnrichment = (input: {
    run: AutoContinueRunContext;
    slice?: AutoContinueSliceRun | null;
    taskId?: string | null;
    taskTitle?: string | null;
    workstreamId?: string | null;
    workstreamTitle?: string | null;
    domain?: string | null;
    requiredSkills?: string[] | null;
    modelTier?: string | null;
    nextActions?: string[] | null;
    userSummary?: string | null;
    event?: string | null;
    actionType?: string | null;
    actionPhase?: string | null;
    extra?: Record<string, unknown>;
  }): Record<string, unknown> => {
    const eventName =
      typeof input.event === "string" && input.event.trim().length > 0
        ? input.event.trim().toLowerCase()
        : null;
    const inferredActionType = (() => {
      if (!eventName) return "execute_task";
      if (eventName === "orchestrator_dispatch") return "orchestrator_dispatch";
      if (eventName.includes("slice_dispatched")) return "dispatch_slice";
      if (eventName.includes("slice_started") || eventName === "session_start") {
        return "run_started";
      }
      if (eventName.includes("slice_heartbeat") || eventName === "heartbeat") {
        return "run_heartbeat";
      }
      if (eventName.includes("slice_handoff")) return "slice_handoff";
      if (eventName.includes("spawn_guard_rate_limited")) return "spawn_guard_rate_limited";
      if (eventName.includes("spawn_guard_blocked")) return "spawn_guard_blocked";
      if (eventName.includes("status_updates_buffered")) return "status_updates_buffered";
      if (eventName.includes("status_updates")) return "status_updates_applied";
      if (eventName.includes("artifact_registered")) return "artifact_registered";
      if (eventName.includes("decision_requested")) return "decision_requested";
      if (eventName.includes("decision_resolved")) return "decision_resolved";
      if (eventName === "auto_continue_started") return "auto_continue_started";
      if (eventName === "auto_continue_stopped") return "auto_continue_stopped";
      if (eventName.includes("behavior_config") || eventName.includes("behavior_automation")) {
        return "behavior_config_review";
      }
      if (eventName.includes("transition")) return "run_state_transition";
      if (eventName.includes("auto_fix")) return "auto_fix";
      if (eventName.includes("milestone_completed")) return "milestone_completed";
      if (eventName.includes("error") || eventName.includes("failed")) return "run_failed";
      if (eventName.includes("result") || eventName.includes("completed")) return "run_completed";
      return eventName.replace(/[^a-z0-9]+/g, "_");
    })();
    const actionType =
      normalizeActivityActionType(input.actionType ?? inferredActionType) ?? inferredActionType;
    const inferredActionPhase = (() => {
      if (!eventName) return "execution";
      if (eventName === "orchestrator_dispatch" || eventName.includes("slice_dispatched")) {
        return "dispatch";
      }
      if (eventName.includes("handoff")) return "handoff";
      if (eventName.includes("heartbeat")) return "execution";
      if (eventName.includes("decision_")) return "review";
      if (
        eventName.includes("blocked") ||
        eventName.includes("rate_limited") ||
        eventName.includes("stall") ||
        eventName.includes("timeout")
      ) {
        return "blocked";
      }
      if (eventName.includes("error") || eventName.includes("failed")) return "error";
      if (eventName.includes("result") || eventName.includes("completed") || eventName === "auto_continue_stopped") {
        return "completed";
      }
      if (eventName === "auto_continue_started") return "intent";
      return "execution";
    })();
    const actionPhase =
      normalizeActivityActionPhase(input.actionPhase ?? inferredActionPhase) ??
      inferredActionPhase;
    const workstreamId =
      (input.workstreamId ?? input.slice?.workstreamId ?? "").trim() || null;
    const taskId = (input.taskId ?? input.slice?.taskIds?.[0] ?? "").trim() || null;
    const requiredSkills = Array.isArray(input.requiredSkills)
      ? input.requiredSkills
      : input.slice?.requiredSkills ?? null;
    return {
      event: input.event ?? null,
      action_type: actionType,
      action_phase: actionPhase,
      initiative_id: input.run.initiativeId,
      requested_by_agent_id: input.run.agentId,
      requested_by_agent_name: input.run.agentName,
      requester_agent_id: input.run.agentId,
      requester_agent_name: input.run.agentName,
      agent_id: input.slice?.agentId ?? null,
      agent_name: input.slice?.agentName ?? null,
      executor_agent_id: input.slice?.agentId ?? null,
      executor_agent_name: input.slice?.agentName ?? null,
      source_run_id: input.slice?.runId ?? null,
      source_session_id: input.slice?.runId ?? null,
      source_stream_id: workstreamId,
      run_id: input.slice?.runId ?? null,
      slice_run_id: input.slice?.runId ?? null,
      correlation_id: input.slice?.runId ?? null,
      workstream_id: workstreamId,
      workstream_title: input.workstreamTitle ?? input.slice?.workstreamTitle ?? null,
      task_id: taskId,
      task_title: input.taskTitle ?? null,
      milestone_ids: input.slice?.milestoneIds ?? null,
      task_ids: input.slice?.taskIds ?? null,
      domain: input.domain ?? input.slice?.domain ?? null,
      required_skills: requiredSkills,
      skill_pack: requiredSkills,
      model_tier: input.modelTier ?? null,
      scope: input.slice?.scope ?? input.run.scope,
      actors: {
        requester: {
          agent_id: input.run.agentId ?? null,
          agent_name: input.run.agentName ?? null,
        },
        dispatcher: {
          agent_id: input.run.agentId ?? null,
          agent_name: input.run.agentName ?? null,
        },
        executor: {
          agent_id: input.slice?.agentId ?? null,
          agent_name: input.slice?.agentName ?? null,
        },
      },
      scope_context: {
        initiative_id: input.run.initiativeId,
        workstream_id: workstreamId,
        task_id: taskId,
        task_ids: input.slice?.taskIds ?? null,
        milestone_ids: input.slice?.milestoneIds ?? null,
      },
      next_actions: input.nextActions ?? null,
      user_summary: input.userSummary ?? null,
      ...(input.extra ?? {}),
    };
  };

	  const autoContinueSliceRuns = new Map<string, AutoContinueSliceRun>();
	  // Keep child handles alive so stdout/stderr capture remains reliable even when the process is detached.
	  const autoContinueSliceChildren = new Map<string, ChildProcess>();
	  const autoContinueSliceLastHeartbeatMs = new Map<string, number>();
  const clearAutoContinueSliceTransientState = (
    sliceRunId: string | null | undefined
  ): void => {
    const id = (sliceRunId ?? "").trim();
    if (!id) return;
    autoContinueSliceChildren.delete(id);
    autoContinueSliceLastHeartbeatMs.delete(id);
  };
  const AUTO_CONTINUE_SLICE_TIMEOUT_MS = readBudgetEnvNumber(
    "ORGX_AUTOPILOT_SLICE_TIMEOUT_MS",
    55 * 60_000,
    // Keep test runs fast; real-world defaults are still ~1h unless overridden.
    { min: 250, max: 6 * 60 * 60_000 }
  );
  const AUTO_CONTINUE_SLICE_LOG_STALL_MS = readBudgetEnvNumber(
    "ORGX_AUTOPILOT_SLICE_LOG_STALL_MS",
    6 * 60_000,
    // Stall detection is only enforced when explicitly overridden; keep lower bound permissive for tests.
    { min: 20, max: 60 * 60_000 }
  );
  const AUTO_CONTINUE_SLICE_HEARTBEAT_MS = 12_000;
  const AUTO_CONTINUE_SLICE_SCHEMA_FILENAME = "autopilot-slice-schema.json";
  const AUTO_CONTINUE_SLICE_LOG_DIRNAME = "autopilot-logs";

  // Prune old autopilot logs on engine init (7-day TTL, 50 MB cap).
  const AUTOPILOT_LOG_TTL_MS = 7 * 24 * 60 * 60_000;
  const AUTOPILOT_LOG_MAX_BYTES = 50 * 1024 * 1024;
  (async () => {
    try {
      const logsDir = join(getOrgxPluginConfigDir(), AUTO_CONTINUE_SLICE_LOG_DIRNAME);
      if (!existsSync(logsDir)) return;
      const entries = await readdir(logsDir);
      const now = Date.now();
      const fileStats: { name: string; path: string; mtimeMs: number; size: number }[] = [];
      for (const name of entries) {
        if (!name.endsWith(".log") && !name.endsWith(".output.json")) continue;
        const filePath = join(logsDir, name);
        try {
          const s = await stat(filePath);
          if (s.mtimeMs < now - AUTOPILOT_LOG_TTL_MS) {
            await unlink(filePath);
          } else {
            fileStats.push({ name, path: filePath, mtimeMs: s.mtimeMs, size: s.size });
          }
        } catch { /* skip */ }
      }
      // Enforce total size cap by deleting oldest first.
      fileStats.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let totalSize = fileStats.reduce((sum, f) => sum + f.size, 0);
      for (const f of fileStats) {
        if (totalSize <= AUTOPILOT_LOG_MAX_BYTES) break;
        try { await unlink(f.path); } catch { /* skip */ }
        totalSize -= f.size;
      }
    } catch { /* best effort */ }
  })();

  const AUTO_FIX_DEFAULT_GRACE_MS = readBudgetEnvNumber(
    "ORGX_AUTOPILOT_AUTOFIX_GRACE_MS",
    10_000,
    { min: 1_000, max: 120_000 }
  );
  const AUTO_CONTINUE_SPAWN_GUARD_RETRY_MS = readBudgetEnvNumber(
    "ORGX_AUTO_CONTINUE_SPAWN_GUARD_RETRY_MS",
    15_000,
    { min: 1_000, max: 15 * 60_000 }
  );
  const autoFixByScope = new Map<string, PendingAutoFix>();
  const autoContinueSpawnGuardRetryByTask = new Map<
    string,
    { initiativeId: string; retryAtMs: number }
  >();

  const getSpawnGuardRetryAtMs = (
    initiativeId: string,
    taskId: string
  ): number => {
    const taskKey = taskId.trim();
    if (!taskKey) return 0;
    const entry = autoContinueSpawnGuardRetryByTask.get(taskKey);
    if (!entry) return 0;
    if (entry.initiativeId !== initiativeId || entry.retryAtMs <= Date.now()) {
      autoContinueSpawnGuardRetryByTask.delete(taskKey);
      return 0;
    }
    return entry.retryAtMs;
  };

  const clearSpawnGuardRetryStateForInitiative = (initiativeId: string): void => {
    for (const [taskId, entry] of autoContinueSpawnGuardRetryByTask.entries()) {
      if (entry.initiativeId !== initiativeId) continue;
      autoContinueSpawnGuardRetryByTask.delete(taskId);
    }
  };

  const normalizeStatusValue = (value: unknown): string => {
    if (typeof value !== "string") return "";
    return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  };

  const listActiveSliceRunIds = (run: AutoContinueRun): string[] => {
    ensureRunInternals(run);
    const ids = new Set<string>();
    for (const id of run.activeSliceRunIds ?? []) {
      const normalized = (id ?? "").trim();
      if (normalized) ids.add(normalized);
    }
    for (const lane of Object.values(run.laneByWorkstreamId ?? {})) {
      const activeRunId = (lane.activeRunId ?? "").trim();
      if (activeRunId) ids.add(activeRunId);
    }
    return Array.from(ids);
  };

  const upsertLane = (
    run: AutoContinueRun,
    workstreamId: string,
    patch: Partial<Omit<AutoContinueLane, "workstreamId">>
  ): AutoContinueLane => {
    const normalizedWorkstreamId = workstreamId.trim();
    if (!normalizedWorkstreamId) {
      throw new Error("workstreamId is required");
    }
    const existing = run.laneByWorkstreamId[normalizedWorkstreamId] ?? {
      workstreamId: normalizedWorkstreamId,
      state: "idle" as AutoContinueLaneState,
      activeRunId: null,
      activeTaskIds: [],
      blockedReason: null,
      waitingOnWorkstreamIds: [],
      retryAt: null,
      updatedAt: new Date().toISOString(),
    };
    const next: AutoContinueLane = {
      ...existing,
      ...patch,
      workstreamId: normalizedWorkstreamId,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
      activeTaskIds: Array.isArray(patch.activeTaskIds)
        ? dedupeStrings(patch.activeTaskIds.map((id) => (id ?? "").trim()).filter(Boolean))
        : existing.activeTaskIds,
      waitingOnWorkstreamIds: Array.isArray(patch.waitingOnWorkstreamIds)
        ? dedupeStrings(
            patch.waitingOnWorkstreamIds.map((id) => (id ?? "").trim()).filter(Boolean)
          )
        : existing.waitingOnWorkstreamIds,
    };
    run.laneByWorkstreamId[normalizedWorkstreamId] = next;
    return next;
  };

  const setLaneState = (
    run: AutoContinueRun,
    input: {
      workstreamId: string;
      state: AutoContinueLaneState;
      activeRunId?: string | null;
      activeTaskIds?: string[];
      blockedReason?: string | null;
      waitingOnWorkstreamIds?: string[];
      retryAt?: string | null;
    }
  ): AutoContinueLane => {
    return upsertLane(run, input.workstreamId, {
      state: input.state,
      activeRunId:
        input.activeRunId === undefined ? undefined : (input.activeRunId ?? "").trim() || null,
      activeTaskIds: input.activeTaskIds,
      blockedReason:
        input.blockedReason === undefined
          ? undefined
          : (input.blockedReason ?? "").trim() || null,
      waitingOnWorkstreamIds: input.waitingOnWorkstreamIds,
      retryAt: input.retryAt === undefined ? undefined : input.retryAt,
    });
  };

  const removeActiveSliceFromRun = (
    run: AutoContinueRun,
    input: { sliceRunId: string; taskIds?: string[]; workstreamId?: string | null }
  ): void => {
    const sliceRunId = input.sliceRunId.trim();
    if (!sliceRunId) return;
    run.activeSliceRunIds = run.activeSliceRunIds.filter((id) => id !== sliceRunId);
    const taskIds = new Set(
      Array.isArray(input.taskIds)
        ? input.taskIds.map((id) => (id ?? "").trim()).filter(Boolean)
        : []
    );
    if (taskIds.size > 0) {
      run.activeTaskIds = run.activeTaskIds.filter((id) => !taskIds.has(id));
    }
    const normalizedWorkstreamId = (input.workstreamId ?? "").trim();
    if (normalizedWorkstreamId) {
      const lane = run.laneByWorkstreamId[normalizedWorkstreamId];
      if (lane && lane.activeRunId === sliceRunId) {
        setLaneState(run, {
          workstreamId: normalizedWorkstreamId,
          state: lane.state === "blocked" ? "blocked" : "idle",
          activeRunId: null,
          activeTaskIds: [],
          retryAt: lane.retryAt ?? null,
          waitingOnWorkstreamIds: lane.waitingOnWorkstreamIds ?? [],
          blockedReason: lane.state === "blocked" ? lane.blockedReason : null,
        });
      }
    }
  };

  const syncLegacyRunPointers = (run: AutoContinueRun): void => {
    ensureRunInternals(run);
    const activeIds = listActiveSliceRunIds(run);
    run.activeSliceRunIds = activeIds;
    run.activeTaskIds = dedupeStrings(
      (run.activeTaskIds ?? []).map((id) => (id ?? "").trim()).filter(Boolean)
    );
    run.activeRunId = activeIds[0] ?? null;
    run.activeTaskId = run.activeTaskIds[0] ?? null;
    if (!run.activeRunId) {
      run.activeTaskTokenEstimate = null;
    }
  };

  const ensureRunInternals = (run: AutoContinueRun): void => {
    if (!Array.isArray(run.activeSliceRunIds)) run.activeSliceRunIds = [];
    if (!Array.isArray(run.activeTaskIds)) run.activeTaskIds = [];
    if (!run.laneByWorkstreamId || typeof run.laneByWorkstreamId !== "object") {
      run.laneByWorkstreamId = {};
    }
    if (!Array.isArray(run.blockedWorkstreamIds)) run.blockedWorkstreamIds = [];
    run.maxParallelSlices = normalizeMaxParallelSlices(
      run.maxParallelSlices,
      AUTO_CONTINUE_MAX_PARALLEL_DEFAULT
    );
    run.parallelMode = normalizeParallelMode(run.parallelMode);
    run.tokenBudget = normalizeTokenBudget(
      run.tokenBudget,
      defaultAutoContinueTokenBudget()
    );
  };

  const recordLocalStatusOverrides = (input: {
    initiativeId: string;
    updatedAt: string;
    taskUpdates: Array<{ taskId: string; status: string; reason: string | null }>;
    milestoneUpdates: Array<{ milestoneId: string; status: string; reason: string | null }>;
  }): void => {
    const initiativeId = input.initiativeId.trim();
    if (!initiativeId) return;

    if (input.taskUpdates.length > 0) {
      const scoped = localTaskStatusOverrides.get(initiativeId) ?? new Map();
      for (const update of input.taskUpdates) {
        const taskId = update.taskId.trim();
        const status = normalizeStatusValue(update.status);
        if (!taskId || !status) continue;
        scoped.set(taskId, {
          status,
          updatedAt: input.updatedAt,
          reason: update.reason,
        });
      }
      if (scoped.size > 0) {
        localTaskStatusOverrides.set(initiativeId, scoped);
      }
    }

    if (input.milestoneUpdates.length > 0) {
      const scoped = localMilestoneStatusOverrides.get(initiativeId) ?? new Map();
      for (const update of input.milestoneUpdates) {
        const milestoneId = update.milestoneId.trim();
        const status = normalizeStatusValue(update.status);
        if (!milestoneId || !status) continue;
        scoped.set(milestoneId, {
          status,
          updatedAt: input.updatedAt,
          reason: update.reason,
        });
      }
      if (scoped.size > 0) {
        localMilestoneStatusOverrides.set(initiativeId, scoped);
      }
    }
  };

  const applyLocalStatusOverridesToGraph = (
    initiativeId: string,
    nodeById: Map<string, MissionControlNode>
  ): void => {
    const scopedTaskOverrides = localTaskStatusOverrides.get(initiativeId) ?? null;
    if (scopedTaskOverrides) {
      for (const [taskId, override] of scopedTaskOverrides.entries()) {
        const node = nodeById.get(taskId);
        if (!node || node.type !== "task") continue;
        const remoteStatus = normalizeStatusValue(node.status);
        node.status = override.status;
        if (remoteStatus === override.status) {
          scopedTaskOverrides.delete(taskId);
        }
      }
      if (scopedTaskOverrides.size === 0) {
        localTaskStatusOverrides.delete(initiativeId);
      }
    }

    const scopedMilestoneOverrides = localMilestoneStatusOverrides.get(initiativeId) ?? null;
    if (scopedMilestoneOverrides) {
      for (const [milestoneId, override] of scopedMilestoneOverrides.entries()) {
        const node = nodeById.get(milestoneId);
        if (!node || node.type !== "milestone") continue;
        const remoteStatus = normalizeStatusValue(node.status);
        node.status = override.status;
        if (remoteStatus === override.status) {
          scopedMilestoneOverrides.delete(milestoneId);
        }
      }
      if (scopedMilestoneOverrides.size === 0) {
        localMilestoneStatusOverrides.delete(initiativeId);
      }
    }
  };

  const isPendingDecisionStatus = (value: unknown): boolean => {
    const normalized = normalizeStatusValue(value);
    if (!normalized) return false;
    return (
      normalized === "pending" ||
      normalized === "open" ||
      normalized === "requested" ||
      normalized === "awaiting_review" ||
      normalized === "awaiting_approval" ||
      normalized === "queued"
    );
  };

  const decisionMatchesWorkstream = (
    record: Record<string, unknown>,
    workstreamId: string,
    runId: string | null
  ): boolean => {
    const directWorkstream =
      pickString(record, ["workstream_id", "workstreamId"])?.trim() ?? "";
    if (directWorkstream && directWorkstream === workstreamId) return true;
    const correlationId = pickString(record, ["correlation_id", "correlationId"])?.trim() ?? "";
    if (runId && correlationId && correlationId === runId) return true;

    const metadataRaw = record.metadata;
    const metadata =
      metadataRaw && typeof metadataRaw === "object" && !Array.isArray(metadataRaw)
        ? (metadataRaw as Record<string, unknown>)
        : null;
    if (!metadata) return false;

    const nestedWorkstream =
      pickString(metadata, ["workstream_id", "workstreamId"])?.trim() ?? "";
    if (nestedWorkstream && nestedWorkstream === workstreamId) return true;

    const nestedCorrelation =
      pickString(metadata, ["correlation_id", "correlationId"])?.trim() ?? "";
    if (runId && nestedCorrelation && nestedCorrelation === runId) return true;
    return false;
  };

  const decisionIsBlocking = (record: Record<string, unknown>): boolean => {
    const direct = record.blocking;
    if (typeof direct === "boolean") return direct;

    const metadataRaw = record.metadata;
    if (metadataRaw && typeof metadataRaw === "object" && !Array.isArray(metadataRaw)) {
      const nested = (metadataRaw as Record<string, unknown>).blocking;
      if (typeof nested === "boolean") return nested;
    }
    return true;
  };

  const setLocalInitiativeStatusOverride = (
    initiativeId: string,
    status: string
  ) => {
    const normalizedId = initiativeId.trim();
    if (!normalizedId) return;
    localInitiativeStatusOverrides.set(normalizedId, {
      status,
      updatedAt: new Date().toISOString(),
    });
  };

  const clearLocalInitiativeStatusOverride = (initiativeId: string) => {
    const normalizedId = initiativeId.trim();
    if (!normalizedId) return;
    localInitiativeStatusOverrides.delete(normalizedId);
  };

  const applyLocalInitiativeOverrides = (
    rows: Record<string, unknown>[]
  ): Record<string, unknown>[] => {
    const seenIds = new Set<string>();
    const next = rows.map((row) => {
      const id = pickString(row, ["id"]);
      if (!id) return row;
      seenIds.add(id);
      const override = localInitiativeStatusOverrides.get(id);
      if (!override) return row;
      return {
        ...row,
        status: override.status,
        updated_at:
          pickString(row, ["updated_at", "updatedAt"]) ?? override.updatedAt,
      };
    });

    for (const [id, override] of localInitiativeStatusOverrides.entries()) {
      if (seenIds.has(id)) continue;
      next.push({
        id,
        title: `Initiative ${id.slice(0, 8)}`,
        name: `Initiative ${id.slice(0, 8)}`,
        summary: null,
        status: override.status,
        progress_pct: null,
        created_at: override.updatedAt,
        updated_at: override.updatedAt,
      });
    }

    return next;
  };

  const applyLocalInitiativeOverrideToGraph = <
    T extends { initiative: { id: string; status: string }; nodes: MissionControlNode[] }
  >(
    graph: T
  ): T => {
    const override = localInitiativeStatusOverrides.get(graph.initiative.id) ?? null;
    if (!override) return graph;

    return {
      ...graph,
      initiative: {
        ...graph.initiative,
        status: override.status,
      },
      nodes: graph.nodes.map((node) =>
        node.type === "initiative" && node.id === graph.initiative.id
          ? { ...node, status: override.status }
          : node
      ),
    };
  };

  function parseTokenBudget(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      if (value <= 0) return null;
      return Math.max(1_000, Math.round(value));
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return null;
      const normalized = trimmed.toLowerCase();
      if (
        normalized === "0" ||
        normalized === "off" ||
        normalized === "none" ||
        normalized === "false" ||
        normalized === "unlimited" ||
        normalized === "null"
      ) {
        return null;
      }
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) {
        if (parsed <= 0) return null;
        return Math.max(1_000, Math.round(parsed));
      }
    }
    return null;
  }

  function normalizeTokenBudget(
    value: unknown,
    fallback: number | null
  ): number | null {
    const parsed = parseTokenBudget(value);
    if (parsed !== null) return parsed;
    return fallback;
  }

  function defaultAutoContinueTokenBudget(): number | null {
    const explicitBudget = parseTokenBudget(
      process.env.ORGX_AUTO_CONTINUE_TOKEN_BUDGET
    );
    if (explicitBudget !== null) return explicitBudget;
    // Token budget guardrails are now explicit-only: either pass a budget when starting
    // auto-continue or set ORGX_AUTO_CONTINUE_TOKEN_BUDGET directly.
    // Legacy fallback toggles (for example ORGX_AUTO_CONTINUE_ENFORCE_TOKEN_BUDGET)
    // are intentionally ignored to prevent hidden auto-stop behavior.
    return null;
  }

  function defaultAutoContinueMaxParallelSlices(): number {
    return AUTO_CONTINUE_MAX_PARALLEL_DEFAULT;
  }

  function estimateTokensForDurationHours(durationHours: number): number {
    if (!Number.isFinite(durationHours) || durationHours <= 0) return 0;
    const raw =
      durationHours *
      DEFAULT_TOKEN_BUDGET_ASSUMPTIONS.tokensPerHour *
      DEFAULT_TOKEN_BUDGET_ASSUMPTIONS.contingencyMultiplier;
    return Math.max(0, Math.round(raw));
  }

  // Helpers used by previous task-level auto-continue implementation were removed in v2.

  // readOpenClawSessionSummary was used by the previous task-level auto-continue implementation.
  // Autopilot v2 dispatches workstream slices via runtime workers (codex/claude-code)
  // and does not rely on OpenClaw session JSONL.

  async function fetchInitiativeEntity(initiativeId: string): Promise<Entity | null> {
    try {
      const list = await client.listEntities("initiative", { limit: 200 });
      const match = list.data.find((candidate) => String((candidate as any)?.id ?? "") === initiativeId);
      return match ?? null;
    } catch {
      return null;
    }
  }

  async function updateInitiativeMetadata(
    initiativeId: string,
    patch: Record<string, unknown>
  ): Promise<void> {
    const existing = await fetchInitiativeEntity(initiativeId);
    const existingMetaRaw =
      existing && typeof existing === "object"
        ? (existing as Record<string, unknown>).metadata
        : null;
    const existingMeta =
      existingMetaRaw && typeof existingMetaRaw === "object" && !Array.isArray(existingMetaRaw)
        ? (existingMetaRaw as Record<string, unknown>)
        : {};
    const nextMeta = { ...existingMeta, ...patch };
    await client.updateEntity("initiative", initiativeId, { metadata: nextMeta });
  }

  async function updateInitiativeAutoContinueState(input: {
    initiativeId: string;
    run: AutoContinueRun;
  }): Promise<void> {
    syncLegacyRunPointers(input.run);
    const now = new Date().toISOString();
    const laneStates = Object.values(input.run.laneByWorkstreamId ?? {}).map((lane) => ({
      workstream_id: lane.workstreamId,
      state: lane.state,
      active_run_id: lane.activeRunId,
      active_task_ids: lane.activeTaskIds,
      blocked_reason: lane.blockedReason,
      waiting_on_workstream_ids: lane.waitingOnWorkstreamIds,
      retry_at: lane.retryAt,
      updated_at: lane.updatedAt,
    }));
    const patch: Record<string, unknown> = {
      auto_continue_enabled: input.run.status === "running" || input.run.status === "stopping",
      auto_continue_status: input.run.status,
      auto_continue_stop_reason: input.run.stopReason,
      auto_continue_started_at: input.run.startedAt,
      auto_continue_stopped_at: input.run.stoppedAt,
      auto_continue_updated_at: now,
      auto_continue_token_budget: input.run.tokenBudget,
      auto_continue_tokens_used: input.run.tokensUsed,
      auto_continue_active_task_id: input.run.activeTaskId,
      auto_continue_active_run_id: input.run.activeRunId,
      auto_continue_active_task_ids: input.run.activeTaskIds,
      auto_continue_active_run_ids: input.run.activeSliceRunIds,
      auto_continue_active_task_token_estimate: input.run.activeTaskTokenEstimate,
      auto_continue_last_task_id: input.run.lastTaskId,
      auto_continue_last_run_id: input.run.lastRunId,
      auto_continue_include_verification: input.run.includeVerification,
      auto_continue_workstream_filter: input.run.allowedWorkstreamIds,
      auto_continue_parallel_mode: input.run.parallelMode,
      auto_continue_max_parallel: input.run.maxParallelSlices,
      auto_continue_lane_states: laneStates,
      auto_continue_blocked_workstream_ids: input.run.blockedWorkstreamIds,
      auto_continue_ignore_spawn_guard_rate_limit: input.run.ignoreSpawnGuardRateLimit,
      ...(input.run.lastError ? { auto_continue_last_error: input.run.lastError } : {}),
    };
    await updateInitiativeMetadata(input.initiativeId, patch);
  }

  async function stopAutoContinueRun(input: {
    run: AutoContinueRun;
    reason: AutoContinueStopReason;
    error?: string | null;
    decisionRequired?: boolean;
    decisionIds?: string[];
  }): Promise<void> {
    const now = new Date().toISOString();
    ensureRunInternals(input.run);
    const activeRunIds = listActiveSliceRunIds(input.run);
    input.run.status = "stopped";
    input.run.stopReason = input.reason;
    input.run.stoppedAt = now;
    input.run.updatedAt = now;
    input.run.stopRequested = false;
    input.run.activeSliceRunIds = [];
    input.run.activeTaskIds = [];
    input.run.activeRunId = null;
    input.run.activeTaskId = null;
    input.run.activeTaskTokenEstimate = null;
    for (const lane of Object.values(input.run.laneByWorkstreamId ?? {})) {
      if (lane.activeRunId || lane.activeTaskIds.length > 0) {
        setLaneState(input.run, {
          workstreamId: lane.workstreamId,
          state: lane.state === "blocked" ? "blocked" : "idle",
          activeRunId: null,
          activeTaskIds: [],
        });
      }
    }
    if (input.error) input.run.lastError = input.error;
    clearSpawnGuardRetryStateForInitiative(input.run.initiativeId);
    for (const runId of activeRunIds) {
      clearAutoContinueSliceTransientState(runId);
    }

    // Only pause the initiative on non-terminal stops (error, blocked, user-requested).
    // Completed / budget-exhausted runs should not override the initiative status.
    if (input.reason !== "completed" && input.reason !== "budget_exhausted") {
      try {
        await client.updateEntity("initiative", input.run.initiativeId, {
          status: "paused",
        });
      } catch {
        // best effort
      }
    }

    try {
      await updateInitiativeAutoContinueState({
        initiativeId: input.run.initiativeId,
        run: input.run,
      });
    } catch {
      // best effort
    }

    const primaryActiveRunId = activeRunIds[0] ?? null;
    const scopedWorkstreamId =
      Array.isArray(input.run.allowedWorkstreamIds) && input.run.allowedWorkstreamIds.length === 1
        ? input.run.allowedWorkstreamIds[0]
        : null;
    const scopeSuffix = scopedWorkstreamId ? ` [workstream ${scopedWorkstreamId}]` : "";
    const decisionRequired = input.reason === "blocked" && input.decisionRequired === true;
    const decisionIds = Array.isArray(input.decisionIds)
      ? input.decisionIds
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
    const budgetValue =
      typeof input.run.tokenBudget === "number" ? input.run.tokenBudget : "unbounded";
    const message =
      input.reason === "completed"
        ? `Autopilot stopped: current dispatch scope completed${scopeSuffix}.`
        : input.reason === "budget_exhausted"
          ? `Autopilot stopped: token budget exhausted (${input.run.tokensUsed}/${budgetValue}).`
          : input.reason === "stopped"
            ? `Autopilot stopped by user request${scopeSuffix}.`
            : input.reason === "blocked"
              ? decisionRequired
                ? `Autopilot stopped: blocked awaiting decision${scopeSuffix}.`
                : `Autopilot stopped: blocked${scopeSuffix}.`
              : `Autopilot stopped due to error${scopeSuffix}.`;
    const phase =
      input.reason === "completed"
        ? "completed"
        : input.reason === "blocked" || input.reason === "error"
          ? "blocked"
          : "review";
    const level =
      input.reason === "completed"
        ? "info"
        : input.reason === "budget_exhausted" || input.reason === "stopped"
          ? "warn"
          : "error";
    const errorLocation =
      input.reason === "blocked"
        ? "mission-control.auto-continue.engine.blocked"
        : input.reason === "error"
          ? "mission-control.auto-continue.engine.error"
          : null;
    const stopRunContext: AutoContinueRunContext = {
      initiativeId: input.run.initiativeId,
      agentId: input.run.agentId,
      agentName: input.run.agentName,
      scope: input.run.scope,
    };

    await emitActivitySafe({
      initiativeId: input.run.initiativeId,
      runId: primaryActiveRunId ?? input.run.lastRunId ?? undefined,
      correlationId: primaryActiveRunId ?? input.run.lastRunId ?? undefined,
      phase,
      level,
      progressPct: input.reason === "completed" ? 100 : input.reason === "blocked" ? 65 : 0,
      nextStep:
        input.reason === "completed"
          ? "Select the next queue item or enable autoplay for continuous dispatch."
          : input.reason === "blocked"
          ? "Resolve blocker decisions, then resume or restart autoplay."
          : input.reason === "budget_exhausted"
          ? "Increase token budget or scope down work before restarting autoplay."
          : input.reason === "stopped"
          ? "Restart autoplay when ready."
          : "Inspect error details and relaunch once fixed.",
      message,
      metadata: {
        ...buildSliceEnrichment({
          run: stopRunContext,
          workstreamId: scopedWorkstreamId,
          event: "auto_continue_stopped",
        }),
        stop_reason: input.reason,
        active_run_id: primaryActiveRunId,
        active_run_ids: activeRunIds,
        last_run_id: input.run.lastRunId,
        token_budget: input.run.tokenBudget,
        tokens_used: input.run.tokensUsed,
        allowed_workstream_ids: input.run.allowedWorkstreamIds,
        max_parallel_slices: input.run.maxParallelSlices,
        scope_workstream_id: scopedWorkstreamId,
        decision_required: decisionRequired,
        decision_ids: decisionIds,
        decision_count: decisionIds.length,
        last_error: input.run.lastError,
        error_location: errorLocation,
      },
    });

    // Emit autopilot_transition event for state observers.
    try {
      await emitActivitySafe({
        initiativeId: input.run.initiativeId,
        runId: primaryActiveRunId ?? input.run.lastRunId ?? undefined,
        correlationId: primaryActiveRunId ?? input.run.lastRunId ?? undefined,
        phase,
        level: "info",
        progressPct:
          input.reason === "completed" ? 100 : input.reason === "blocked" ? 65 : 0,
        message: `Autopilot state: running → ${input.reason === "completed" ? "idle" : input.reason === "stopped" ? "idle" : input.reason}.`,
        metadata: {
          ...buildSliceEnrichment({
            run: stopRunContext,
            workstreamId: scopedWorkstreamId,
            event: "autopilot_transition",
            actionType: "run_state_transition",
          }),
          old_state: "running",
          new_state: input.reason === "completed" || input.reason === "stopped" ? "idle" : input.reason === "blocked" ? "blocked" : input.reason === "error" ? "error" : "idle",
          reason: input.reason,
          workspace_id: input.run.allowedWorkstreamIds?.[0] ?? null,
        },
      });
    } catch {
      // best effort
    }
  }

  const codexBinResolver = createCodexBinResolver();
  const resolveCodexBinInfo = (): CodexBinInfo => codexBinResolver.resolveCodexBinInfo();

  const { spawnCodexSliceWorker, writeRuntimeEvent } = createAutopilotRuntime({
    filename: __filename,
    autoContinueSliceChildren,
    resolveByokEnvOverrides,
    safeErrorMessage,
    resolveCodexBinInfo,
    upsertRuntimeInstanceFromHook,
    broadcastRuntimeSse,
    clearSnapshotResponseCache,
  });

  async function tickAutoContinueRun(run: AutoContinueRun): Promise<void> {
    if (run.status !== "running" && run.status !== "stopping") return;

    const now = new Date().toISOString();
    syncLegacyRunPointers(run);

    // 1) Reconcile each active slice lane and register outcomes when complete.
    const activeRunIdsForTick = listActiveSliceRunIds(run);
    for (const activeRunIdForTick of activeRunIdsForTick) {
      run.activeRunId = activeRunIdForTick;
      const slice = autoContinueSliceRuns.get(activeRunIdForTick) ?? null;
      if (!slice) {
        // Legacy/unknown pointer; clear so we can continue.
        removeActiveSliceFromRun(run, { sliceRunId: activeRunIdForTick });
        run.activeRunId = null;
        run.activeTaskId = null;
        run.updatedAt = now;
      } else {
	        const pid = slice.pid;
	        if (pid && pidAlive(pid)) {
	          const nowMs = Date.now();
	          const outputTail = readFileTailSafe(slice.outputPath, 240_000);
	          const outputParsed = outputTail
              ? parseSliceResult<AutoContinueSliceResult>(outputTail)
              : null;
	          const outputComplete = Boolean(
	            outputParsed &&
	              typeof outputParsed.status === "string" &&
	              typeof outputParsed.summary === "string"
	          );

		          if (outputComplete) {
		            // Some platforms can report a just-finished detached process as still "alive" (zombie).
		            // Best-effort stop, then clear pid so we can proceed to parse the output contract below.
		            try {
		              await stopProcess(pid);
		            } catch {
		              // best effort
		            }
		            slice.pid = null;
		            autoContinueSliceRuns.set(slice.runId, slice);
		          } else {
	            const lastHeartbeat = autoContinueSliceLastHeartbeatMs.get(slice.runId) ?? 0;
	            if (nowMs - lastHeartbeat >= AUTO_CONTINUE_SLICE_HEARTBEAT_MS) {
	              try {
	                writeRuntimeEvent({
	                  sourceClient: slice.sourceClient,
	                  event: "heartbeat",
	                  runId: slice.runId,
	                  initiativeId: slice.initiativeId,
	                  workstreamId: slice.workstreamId,
	                  taskId: slice.taskIds[0] ?? null,
	                  agentId: slice.agentId,
	                  agentName: slice.agentName,
	                  phase: "execution",
	                  message: `Autopilot slice running: ${slice.workstreamTitle ?? slice.workstreamId}`,
		                metadata: {
		                  event: "autopilot_slice_heartbeat",
		                  requested_by_agent_id: run.agentId,
		                  requested_by_agent_name: run.agentName,
		                  domain: slice.domain,
		                  required_skills: slice.requiredSkills,
                      behavior_config_id: slice.behaviorConfigId,
                      behavior_config_version: slice.behaviorConfigVersion,
                      behavior_config_hash: slice.behaviorConfigHash,
                      policy_source: slice.behaviorPolicySource,
                      behavior_automation_level: slice.behaviorAutomationLevel,
		                  workstream_id: slice.workstreamId,
	                    workstream_title: slice.workstreamTitle ?? null,
	                    task_ids: slice.taskIds,
	                    milestone_ids: slice.milestoneIds,
	                    log_path: slice.logPath,
	                    output_path: slice.outputPath,
	                    ...mockMeta(slice),
	                  },
	                });
	              } catch {
	                // best effort
	              }
	              autoContinueSliceLastHeartbeatMs.set(slice.runId, nowMs);
	            }

	          const startedAtEpochMs = Date.parse(slice.startedAt);
	          const fallbackEpochMs = Number.isFinite(startedAtEpochMs) ? startedAtEpochMs : nowMs;
          const outputUpdatedAtEpochMs = fileUpdatedAtEpochMs(slice.outputPath, fallbackEpochMs);
          const logUpdatedAtEpochMs = fileUpdatedAtEpochMs(slice.logPath, fallbackEpochMs);
          // Some codex runs only materialize output.json at process exit. Treat recent log activity
          // as liveness signal so active slices are not falsely marked as stalled.
          const stallUpdatedAtEpochMs = Math.max(outputUpdatedAtEpochMs, logUpdatedAtEpochMs);

	            const logTail = readFileTailSafe(slice.logPath, 64_000);
	            const mcpHandshake = detectMcpHandshakeFailure(logTail);
	            if (mcpHandshake) {
	              try {
	                await stopProcess(pid);
	              } catch {
	                // best effort
	              }

	              slice.status = "error";
	              slice.finishedAt = now;
	              slice.updatedAt = now;
	              slice.lastError = `Autopilot slice failed to initialize MCP server${mcpHandshake.server ? ` (${mcpHandshake.server})` : ""}.`;
	              autoContinueSliceRuns.set(slice.runId, slice);

	              run.lastError = slice.lastError;
	              run.updatedAt = now;
                clearAutoContinueSliceTransientState(slice.runId);

	              await emitActivitySafe({
	                initiativeId: run.initiativeId,
	                runId: slice.runId,
	                correlationId: slice.runId,
	                phase: "blocked",
	                level: "error",
                  progressPct: 55,
                  nextStep:
                    "Review MCP diagnostics, then choose retry, skip, or pause for investigation.",
	                message: `Autopilot slice MCP failed: ${slice.workstreamTitle ?? slice.workstreamId}.`,
		                metadata: {
                    ...buildSliceEnrichment({
                      run,
                      slice,
                      workstreamId: slice.workstreamId,
                      workstreamTitle: slice.workstreamTitle ?? null,
                      domain: slice.domain,
                      requiredSkills: slice.requiredSkills,
                      event: "autopilot_slice_mcp_handshake_failed",
                    }),
		                  error_location: "mission-control.auto-continue.engine.slice.mcp-handshake",
		                  mcp_server: mcpHandshake.server,
		                  mcp_line: mcpHandshake.line,
	                  log_path: slice.logPath,
	                  output_path: slice.outputPath,
	                  ...mockMeta(slice),
	                },
	              });

	          const decisionResult = await requestDecisionQueued({
	                initiativeId: run.initiativeId,
	                correlationId: slice.runId,
	                title: `Autopilot slice MCP failed: ${slice.workstreamTitle ?? slice.workstreamId}`,
	                summary:
	                  `MCP handshake failed${mcpHandshake.server ? ` for ${mcpHandshake.server}` : ""}. Review logs/output and decide whether to retry or pause autopilot.`,
	                urgency: "high",
	                options: [
	                  "Retry this workstream slice",
	                  "Pause autopilot and investigate",
	                  "Skip this workstream for now",
	                ],
	                blocking: true,
                  decisionType: "autopilot_failure",
                  workstreamId: slice.workstreamId,
                  agentId: slice.agentId,
                  sourceSystem: "orgx-autopilot",
                  conflictSource: "mcp_handshake_failure",
                  dedupeKey: [
                    "autopilot",
                    run.initiativeId,
                    slice.workstreamId,
                    "mcp_handshake_failure",
                    mcpHandshake.server ?? "unknown",
                  ].join(":"),
                  recommendedAction: "Retry once. If it fails again, pause autopilot and inspect MCP server configuration.",
                  sourceRunId: slice.runId,
                  sourceRef: {
                    run_id: slice.runId,
                    workstream_id: slice.workstreamId,
                    mcp_server: mcpHandshake.server ?? null,
                  },
                  evidenceRefs: [
                    {
                      evidence_type: "mcp_diagnostic",
                      title: "MCP handshake failure",
                      summary: `MCP handshake failed${mcpHandshake.server ? ` for ${mcpHandshake.server}` : ""}.`,
                      source_pointer: slice.logPath,
                      payload: {
                        mcp_server: mcpHandshake.server ?? null,
                        mcp_line: mcpHandshake.line ?? null,
                        output_path: slice.outputPath,
                      },
                    },
                  ],
		              });

                  setLaneState(run, {
                    workstreamId: slice.workstreamId,
                    state: "blocked",
                    activeRunId: null,
                    activeTaskIds: [],
                    blockedReason: slice.lastError,
                    waitingOnWorkstreamIds: [],
                    retryAt: null,
                  });

		              await stopAutoContinueRun({
	                run,
	                reason: "blocked",
	                error: slice.lastError,
                  decisionRequired: decisionResult.queued,
                  decisionIds: decisionResult.decisionIds,
	              });
	              return;
	            }

	          const scopeTimeoutMs = AUTO_CONTINUE_SLICE_TIMEOUT_MS * SLICE_SCOPE_TIMEOUT_MULTIPLIER[slice.scope ?? "task"];
	          const killDecision = shouldKillWorker(
	            {
	              nowEpochMs: nowMs,
	              startedAtEpochMs: fallbackEpochMs,
	              logUpdatedAtEpochMs: stallUpdatedAtEpochMs,
	            },
	            { timeoutMs: scopeTimeoutMs, stallMs: AUTO_CONTINUE_SLICE_LOG_STALL_MS }
	          );

	            if (killDecision.kill) {
	              try {
	                await stopProcess(pid);
	              } catch {
	                // best effort
	              }

	              slice.status = "error";
	              slice.finishedAt = now;
	              slice.updatedAt = now;
	              slice.lastError =
	                killDecision.kind === "timeout"
	                  ? `Autopilot slice timed out after ${Math.round(scopeTimeoutMs / 60_000)} minutes.`
	                  : `Autopilot slice stalled (no output) for ${Math.round(AUTO_CONTINUE_SLICE_LOG_STALL_MS / 60_000)} minutes.`;
	              autoContinueSliceRuns.set(slice.runId, slice);

	              run.lastError = slice.lastError;
	              run.updatedAt = now;
                clearAutoContinueSliceTransientState(slice.runId);

	              const event =
	                killDecision.kind === "timeout" ? "autopilot_slice_timeout" : "autopilot_slice_log_stall";
	              const humanLabel = killDecision.kind === "timeout" ? "timed out" : "stalled";

	              await emitActivitySafe({
	                initiativeId: run.initiativeId,
	                runId: slice.runId,
	                correlationId: slice.runId,
	                phase: "blocked",
	                level: "error",
                  progressPct: 55,
                  nextStep:
                    "Open logs/output, decide retry or pause, and capture blocker context for handoff.",
	                message: `Autopilot slice ${humanLabel}: ${slice.workstreamTitle ?? slice.workstreamId}.`,
		                metadata: {
                    ...buildSliceEnrichment({
                      run,
                      slice,
                      workstreamId: slice.workstreamId,
                      workstreamTitle: slice.workstreamTitle ?? null,
                      domain: slice.domain,
                      requiredSkills: slice.requiredSkills,
                      event,
                    }),
		                  error_location:
		                    killDecision.kind === "timeout"
		                      ? "mission-control.auto-continue.engine.slice.timeout"
		                      : "mission-control.auto-continue.engine.slice.stall",
	                  log_path: slice.logPath,
	                  output_path: slice.outputPath,
	                  reason: killDecision.reason,
	                  elapsed_ms: killDecision.elapsedMs,
	                  idle_ms: killDecision.idleMs,
	                  ...mockMeta(slice),
	                },
	              });

		              const decisionResult = await requestDecisionQueued({
	                initiativeId: run.initiativeId,
	                correlationId: slice.runId,
	                title: `Autopilot slice ${humanLabel}: ${slice.workstreamTitle ?? slice.workstreamId}`,
	                summary:
	                  "The slice was terminated because it stopped making progress. Review logs/output and decide whether to retry or pause autopilot.",
	                urgency: "high",
	                options: [
	                  "Retry this workstream slice",
	                  "Pause autopilot and investigate",
	                  "Skip this workstream for now",
	                ],
	                blocking: true,
                  decisionType: "autopilot_failure",
                  workstreamId: slice.workstreamId,
                  agentId: slice.agentId,
                  sourceSystem: "orgx-autopilot",
                  conflictSource:
                    killDecision.kind === "timeout"
                      ? "slice_timeout"
                      : "slice_stall_no_output",
                  dedupeKey: [
                    "autopilot",
                    run.initiativeId,
                    slice.workstreamId,
                    killDecision.kind === "timeout"
                      ? "slice_timeout"
                      : "slice_stall_no_output",
                  ].join(":"),
                  recommendedAction:
                    "Review logs and output, then retry once. If repeated, pause autopilot and investigate worker/runtime health.",
                  sourceRunId: slice.runId,
                  sourceRef: {
                    run_id: slice.runId,
                    workstream_id: slice.workstreamId,
                    kill_kind: killDecision.kind,
                    elapsed_ms: killDecision.elapsedMs,
                    idle_ms: killDecision.idleMs,
                  },
                  evidenceRefs: [
                    {
                      evidence_type:
                        killDecision.kind === "timeout"
                          ? "timeout_diagnostic"
                          : "stall_diagnostic",
                      title:
                        killDecision.kind === "timeout"
                          ? "Slice timed out"
                          : "Slice stalled",
                      summary: killDecision.reason,
                      source_pointer: slice.logPath,
                      payload: {
                        elapsed_ms: killDecision.elapsedMs,
                        idle_ms: killDecision.idleMs,
                        output_path: slice.outputPath,
                      },
                    },
                  ],
		              });

                  setLaneState(run, {
                    workstreamId: slice.workstreamId,
                    state: "blocked",
                    activeRunId: null,
                    activeTaskIds: [],
                    blockedReason: slice.lastError,
                    waitingOnWorkstreamIds: [],
                    retryAt: null,
                  });

		              await stopAutoContinueRun({
	                run,
	                reason: "blocked",
	                error: slice.lastError,
                  decisionRequired: decisionResult.queued,
                  decisionIds: decisionResult.decisionIds,
	              });
	              return;
	            }

	            if (run.stopRequested) {
	              try {
	                await stopProcess(pid);
	              } catch {
	                // best effort
	              }
	            }

		            if (!outputComplete) continue;
		          }
		        }

	        // Slice finished.
	        const raw = readSliceOutputFile(slice.outputPath);
        const parsed = raw ? parseSliceResult<AutoContinueSliceResult>(raw) : null;
        const parsedStatus = parsed?.status ?? "error";
        const defaultDecisionBlocking = parsedStatus === "completed" ? false : true;

        const allDecisions = Array.isArray(parsed?.decisions_needed)
          ? (parsed?.decisions_needed ?? [])
              .filter(
                (item: AutoContinueSliceDecision): item is AutoContinueSliceDecision =>
                  Boolean(item && typeof item.question === "string" && item.question.trim())
              )
          : [];
        const isParserSyntheticFallbackDecision = (item: AutoContinueSliceDecision): boolean => {
          const question = String(item?.question ?? "").trim().toLowerCase();
          const summary = String(item?.summary ?? "").trim().toLowerCase();
          return (
            (question.includes("missing required blocking decision") ||
              summary.includes("parser inserted a blocking decision")) &&
            item?.blocking === true
          );
        };
        const decisions = allDecisions.filter((item) => !isParserSyntheticFallbackDecision(item));
        const blockingDecisionCount = decisions.filter(
          (item) => typeof item.blocking === "boolean" ? item.blocking : defaultDecisionBlocking
        ).length;
        const nonBlockingDecisionCount = Math.max(0, decisions.length - blockingDecisionCount);
        const effectiveParsedStatus =
          parsedStatus === "completed" && blockingDecisionCount > 0
            ? "needs_decision"
            : parsedStatus === "needs_decision" && blockingDecisionCount === 0
              ? "completed"
              : parsedStatus;

        slice.status =
          effectiveParsedStatus === "completed"
            ? "completed"
            : effectiveParsedStatus === "blocked" || effectiveParsedStatus === "needs_decision"
              ? "blocked"
              : "error";
        slice.finishedAt = now;
        slice.updatedAt = now;
        slice.lastError =
          slice.status === "error"
            ? slice.lastError ?? "Autopilot slice failed or returned invalid output."
            : null;
        autoContinueSliceRuns.set(slice.runId, slice);
        clearAutoContinueSliceTransientState(slice.runId);

        // Token accounting: codex CLI doesn't provide tokens here; use the modeled estimate.
        const modeledTokens = slice.tokenEstimate ?? 0;
        run.tokensUsed += Math.max(0, modeledTokens);
        run.activeTaskTokenEstimate = null;

	        const artifacts = Array.isArray(parsed?.artifacts)
	          ? (parsed?.artifacts ?? [])
	              .filter(
	                (item: AutoContinueSliceArtifact): item is AutoContinueSliceArtifact =>
	                  Boolean(item && typeof item.name === "string" && item.name.trim())
	              )
	          : [];
        const artifactEvidenceRefs = artifacts.map((artifact) => ({
          evidence_type: "artifact",
          title: artifact.name.trim(),
          summary: artifact.description?.trim() || "Slice artifact output",
          source_pointer: artifact.url ?? slice.outputPath,
          payload: {
            artifact_type: artifact.artifact_type ?? null,
            confidence_score: artifact.confidence_score ?? null,
            task_ids:
              Array.isArray(artifact.task_ids) && artifact.task_ids.length > 0
                ? artifact.task_ids
                : slice.taskIds,
            milestone_id: artifact.milestone_id ?? slice.milestoneIds[0] ?? null,
          },
        }));
        const nextActions = Array.isArray((parsed as any)?.next_actions)
          ? ((parsed as any).next_actions as unknown[])
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter(Boolean)
          : [];
        const userSummary =
          (typeof parsed?.summary === "string" && parsed.summary.trim().length > 0
            ? parsed.summary.trim()
            : null) ??
          nextActions[0] ??
          (slice.status === "completed"
            ? `Slice completed for ${slice.workstreamTitle ?? slice.workstreamId}.`
            : `Slice blocked for ${slice.workstreamTitle ?? slice.workstreamId}.`);
        const nextStepHint =
          nextActions[0] ??
          (slice.status === "completed"
            ? "No follow-up action returned by worker."
            : "Resolve blocker to continue execution.");
        const skillEvidence = Array.isArray((parsed as any)?.skill_evidence)
          ? ((parsed as any).skill_evidence as AutoContinueSliceSkillEvidence[])
              .map((item) => ({
                skill:
                  typeof item?.skill === "string"
                    ? item.skill.trim()
                    : "",
                skill_file:
                  typeof item?.skill_file === "string"
                    ? item.skill_file.trim()
                    : null,
                skill_sha256:
                  typeof item?.skill_sha256 === "string"
                    ? item.skill_sha256.trim().toLowerCase()
                    : null,
                skill_heading:
                  typeof item?.skill_heading === "string"
                    ? item.skill_heading.trim()
                    : null,
              }))
              .filter((item) => item.skill.length > 0)
          : [];
        const reportedSkillNames = Array.from(
          new Set(
            skillEvidence
              .map((entry) => entry.skill.replace(/^\$/, "").trim())
              .filter(Boolean)
          )
        );
        const reportedSkillSha256Count = skillEvidence.filter((entry) =>
          typeof entry.skill_sha256 === "string" && entry.skill_sha256.length > 0
        ).length;

        const taskUpdates = Array.isArray((parsed as any)?.task_updates)
          ? ((parsed as any).task_updates as Array<{ task_id: string; status: string; reason?: string | null }>)
          : [];
        const milestoneUpdates = Array.isArray((parsed as any)?.milestone_updates)
          ? ((parsed as any).milestone_updates as Array<{ milestone_id: string; status: string; reason?: string | null }>)
          : [];
        const resultEnvelope = {
          summary: userSummary,
          parsed_status: effectiveParsedStatus,
          task_updates: taskUpdates,
          milestone_updates: milestoneUpdates,
          next_actions: nextActions,
          artifacts: artifacts.map((artifact) => ({
            name: artifact.name,
            artifact_type: artifact.artifact_type ?? null,
            url: artifact.url ?? null,
          })),
        };
        const evidenceEnvelope = {
          artifacts: artifacts.map((artifact) => ({
            name: artifact.name,
            artifact_type: artifact.artifact_type ?? null,
            source_pointer: artifact.url ?? null,
          })),
          files: [slice.outputPath, slice.logPath].filter(Boolean),
          logs: [slice.logPath].filter(Boolean),
        };

        let blockingDecisionQueued = false;
        const blockingDecisionIds: string[] = [];
        const nonBlockingDecisionIds: string[] = [];
        for (const decision of decisions) {
          const isBlocking =
            typeof decision.blocking === "boolean" ? decision.blocking : defaultDecisionBlocking;
          const normalizedQuestion = decision.question.trim();
          const decisionResult = await requestDecisionQueued({
            initiativeId: run.initiativeId,
            correlationId: slice.runId,
            title: normalizedQuestion,
            summary: decision.summary ?? parsed?.summary ?? null,
            urgency: decision.urgency ?? "high",
            options: Array.isArray(decision.options)
              ? decision.options.filter((opt: string) => typeof opt === "string" && opt.trim())
              : [],
            blocking: isBlocking,
            decisionType: isBlocking
              ? "autopilot_blocking_decision"
              : "autopilot_followup_decision",
            workstreamId: slice.workstreamId,
            agentId: slice.agentId,
            sourceSystem: "orgx-autopilot",
            conflictSource:
              parsedStatus === "needs_decision"
                ? "slice_needs_decision"
                : "slice_reported_decision",
            dedupeKey: [
              "autopilot",
              run.initiativeId,
              slice.workstreamId,
              "slice_reported_decision",
              normalizedQuestion.toLowerCase(),
            ].join(":"),
	            recommendedAction:
              nextActions[0] ??
	              "Resolve this decision to continue the slice or safely defer workstream execution.",
            sourceRunId: slice.runId,
            sourceRef: {
              run_id: slice.runId,
              workstream_id: slice.workstreamId,
              parsed_status: parsedStatus,
            },
	            evidenceRefs: [
	              {
	                evidence_type: "slice_output_summary",
                title: "Slice requested a decision",
                summary: decision.summary ?? parsed?.summary ?? "Decision required by slice output.",
                source_pointer: slice.outputPath,
	                payload: {
	                  log_path: slice.logPath,
	                  blocking: isBlocking,
	                },
	              },
              ...artifactEvidenceRefs,
	            ],
	          });
          if (decisionResult.queued && isBlocking) blockingDecisionQueued = true;
          if (decisionResult.decisionIds.length > 0) {
            if (isBlocking) blockingDecisionIds.push(...decisionResult.decisionIds);
            else nonBlockingDecisionIds.push(...decisionResult.decisionIds);
          }
        }
        const decisionIds = Array.from(
          new Set([...blockingDecisionIds, ...nonBlockingDecisionIds])
        );

        for (const artifact of artifacts) {
          await registerArtifactSafe({
            initiativeId: run.initiativeId,
            runId: slice.runId,
            agentId: slice.agentId,
            agentName: slice.agentName,
            workstreamId: slice.workstreamId,
            fallbackMilestoneId: slice.milestoneIds[0] ?? null,
            fallbackTaskIds: slice.taskIds,
            artifact,
            isMockWorker: slice.isMockWorker,
          });
        }

        const statusUpdateResult = await applyAgentStatusUpdatesSafe({
          initiativeId: run.initiativeId,
          runId: slice.runId,
          correlationId: slice.runId,
          taskUpdates,
          milestoneUpdates,
          isMockWorker: slice.isMockWorker,
        });
        if (
          statusUpdateResult.taskUpdates.length > 0 ||
          statusUpdateResult.milestoneUpdates.length > 0
        ) {
          recordLocalStatusOverrides({
            initiativeId: run.initiativeId,
            updatedAt: now,
            taskUpdates: statusUpdateResult.taskUpdates,
            milestoneUpdates: statusUpdateResult.milestoneUpdates,
          });
        }

        try {
          writeRuntimeEvent({
            sourceClient: slice.sourceClient,
            event: slice.status === "error" ? "error" : "session_stop",
            runId: slice.runId,
            initiativeId: slice.initiativeId,
            workstreamId: slice.workstreamId,
            taskId: slice.taskIds[0] ?? null,
            agentId: slice.agentId,
            agentName: slice.agentName ?? null,
            phase: slice.status === "completed" ? "completed" : "blocked",
            message: userSummary ?? slice.lastError ?? "Autopilot slice finished.",
            metadata: {
              event: "autopilot_slice_finished",
              initiative_id: run.initiativeId,
              run_id: slice.runId,
              slice_run_id: slice.runId,
              workstream_id: slice.workstreamId,
              correlation_id: slice.runId,
              requested_by_agent_id: run.agentId,
              requested_by_agent_name: run.agentName,
              status: effectiveParsedStatus,
              artifacts: artifacts.length,
              decisions: decisions.length,
              blocking_decisions: blockingDecisionCount,
              non_blocking_decisions: nonBlockingDecisionCount,
              status_updates: statusUpdateResult.applied,
            status_updates_buffered: statusUpdateResult.buffered,
            reported_skill_evidence_count: skillEvidence.length,
            reported_skill_sha256_count: reportedSkillSha256Count,
            reported_skill_names: reportedSkillNames,
              action_type: normalizeActivityActionType("run_completed"),
              action_phase: normalizeActivityActionPhase(
                slice.status === "completed" ? "completed" : "blocked"
              ),
              result: resultEnvelope,
              evidence: evidenceEnvelope,
              ...mockMeta(slice),
              user_summary: userSummary,
              next_actions: nextActions,
          },
        });
      } catch {
        // best effort
      }

        if (slice.status === "completed") {
          await emitActivitySafe({
            initiativeId: run.initiativeId,
            runId: slice.runId,
            correlationId: slice.runId,
            phase: "handoff",
            level: "info",
            message: `Handoff ready for ${slice.workstreamTitle ?? slice.workstreamId}.`,
            progressPct: 80,
            nextStep: nextStepHint,
            metadata: buildSliceEnrichment({
              run,
              slice,
              workstreamId: slice.workstreamId,
              workstreamTitle: slice.workstreamTitle ?? null,
              domain: slice.domain,
              requiredSkills: slice.requiredSkills,
              nextActions,
              userSummary,
              event: "autopilot_slice_handoff",
              extra: {
                parsed_status: effectiveParsedStatus,
                artifacts: artifacts.length,
                decisions: decisions.length,
                decision_ids: decisionIds,
                output_path: slice.outputPath,
                log_path: slice.logPath,
                task_updates: taskUpdates,
                milestone_updates: milestoneUpdates,
                result: resultEnvelope,
                evidence: evidenceEnvelope,
                ...mockMeta(slice),
              },
            }),
          });
        }

        await emitActivitySafe({
          initiativeId: run.initiativeId,
          runId: slice.runId,
          correlationId: slice.runId,
          phase: slice.status === "completed" ? "completed" : "blocked",
          level: slice.status === "completed" ? "info" : "warn",
          progressPct: slice.status === "completed" ? 100 : 65,
          nextStep: nextStepHint,
          message:
            slice.status === "completed"
              ? `Autopilot slice completed for ${slice.workstreamTitle ?? slice.workstreamId} (${slice.taskIds.length} task${slice.taskIds.length === 1 ? "" : "s"}).`
              : `Autopilot slice blocked: ${slice.workstreamTitle ?? slice.workstreamId}.`,
          metadata: {
            ...buildSliceEnrichment({
              run,
              slice,
              workstreamId: slice.workstreamId,
              workstreamTitle: slice.workstreamTitle ?? null,
              domain: slice.domain,
              requiredSkills: slice.requiredSkills,
              nextActions,
              userSummary,
              event: "autopilot_slice_result",
            }),
            error_location:
              slice.status === "completed"
                ? null
                : "mission-control.auto-continue.engine.slice.result",
            behavior_config_id: slice.behaviorConfigId,
            behavior_config_version: slice.behaviorConfigVersion,
            behavior_config_hash: slice.behaviorConfigHash,
            policy_source: slice.behaviorPolicySource,
            behavior_automation_level: slice.behaviorAutomationLevel,
            parsed_status: effectiveParsedStatus,
            has_output: Boolean(parsed),
            artifacts: artifacts.length,
            decisions: decisions.length,
            blocking_decisions: blockingDecisionCount,
            non_blocking_decisions: nonBlockingDecisionCount,
            decision_ids: decisionIds,
            blocking_decision_ids: Array.from(new Set(blockingDecisionIds)),
            non_blocking_decision_ids: Array.from(new Set(nonBlockingDecisionIds)),
            decision_required: blockingDecisionQueued,
            status_updates_applied: statusUpdateResult.applied,
            status_updates_buffered: statusUpdateResult.buffered,
            reported_skill_evidence_count: skillEvidence.length,
            reported_skill_sha256_count: reportedSkillSha256Count,
            reported_skill_names: reportedSkillNames,
            output_path: slice.outputPath,
            log_path: slice.logPath,
            error: slice.lastError,
            next_actions: nextActions,
            task_updates: taskUpdates,
            milestone_updates: milestoneUpdates,
            result: resultEnvelope,
            evidence: evidenceEnvelope,
            ...mockMeta(slice),
            user_summary: userSummary,
          },
        });

        // Append to local team context for cross-agent awareness on subsequent slices.
        if (slice.status === "completed") {
          try {
            appendTeamCompletion(run.initiativeId, {
              domain: slice.domain ?? "unknown",
              task_title: slice.workstreamTitle ?? slice.workstreamId,
              summary: parsed?.summary ?? "Completed.",
              key_outputs: artifacts.map((a: { name?: string }) => a.name).filter(Boolean).slice(0, 5) as string[],
              completed_at: new Date().toISOString(),
            });
          } catch {
            // best effort: do not block the engine on store failure
          }
        }

	        if (slice.status !== "completed") {
          let fallbackDecisionResult: DecisionRequestOutcome = {
            queued: false,
            decisionIds: [],
          };
          if (!blockingDecisionQueued) {
            const blockedLike = slice.status === "blocked";
            fallbackDecisionResult = await requestDecisionQueued({
              initiativeId: run.initiativeId,
              correlationId: slice.runId,
              title: blockedLike
                ? `Autopilot slice blocked: ${slice.workstreamTitle ?? slice.workstreamId}`
                : `Autopilot slice failed: ${slice.workstreamTitle ?? slice.workstreamId}`,
              summary:
                parsed?.summary ??
                slice.lastError ??
                (blockedLike
                  ? "The slice reported a blocked/decision-required state without a blocking decision payload. Review logs/output and decide whether to retry, unblock, or skip."
                  : "The slice failed without producing a valid output contract. Review logs/output and decide whether to retry or pause autopilot."),
              urgency: "high",
              options: [
                "Retry this workstream slice",
                "Pause autopilot and investigate",
                "Skip this workstream for now",
              ],
              blocking: true,
              decisionType: blockedLike ? "autopilot_blocked_without_decision" : "autopilot_failure",
              workstreamId: slice.workstreamId,
              agentId: slice.agentId,
              sourceSystem: "orgx-autopilot",
              conflictSource: blockedLike
                ? "slice_missing_blocking_decision"
                : "slice_invalid_output",
              dedupeKey: [
                "autopilot",
                run.initiativeId,
                slice.workstreamId,
                blockedLike ? "slice_missing_blocking_decision" : "slice_invalid_output",
              ].join(":"),
	              recommendedAction:
                nextActions[0] ??
	                "Review the output contract and logs, then retry or pause autopilot until the blocker is resolved.",
              sourceRunId: slice.runId,
              sourceRef: {
                run_id: slice.runId,
                workstream_id: slice.workstreamId,
                parsed_status: effectiveParsedStatus,
              },
	              evidenceRefs: [
	                {
	                  evidence_type: "slice_output_validation",
                  title: "Slice output requires fallback decision",
                  summary:
                    parsed?.summary ??
                    slice.lastError ??
                    "Slice did not provide a blocking decision payload.",
                  source_pointer: slice.outputPath,
	                  payload: {
	                    log_path: slice.logPath,
	                    parsed_status: effectiveParsedStatus,
	                  },
	                },
                  ...artifactEvidenceRefs,
	              ],
	            });
          }

            setLaneState(run, {
              workstreamId: slice.workstreamId,
              state: "blocked",
              activeRunId: null,
              activeTaskIds: [],
              blockedReason:
                parsed?.summary ??
                slice.lastError ??
                `Slice returned status: ${effectiveParsedStatus}`,
              waitingOnWorkstreamIds: [],
              retryAt: null,
            });
            if (!run.blockedWorkstreamIds.includes(slice.workstreamId)) {
              run.blockedWorkstreamIds.push(slice.workstreamId);
            }

		          await stopAutoContinueRun({
	            run,
	            reason: slice.status === "error" ? "error" : "blocked",
	            error:
	              parsed?.summary ??
              slice.lastError ??
              `Slice returned status: ${effectiveParsedStatus}`,
	              decisionRequired:
                  blockingDecisionQueued || fallbackDecisionResult.queued,
                decisionIds: Array.from(
                  new Set([...decisionIds, ...fallbackDecisionResult.decisionIds])
                ),
          });
	          return;
	        }

        const completionHadNoOutcome =
          parsedStatus === "completed" &&
          artifacts.length === 0 &&
          decisions.length === 0 &&
          statusUpdateResult.applied === 0;

        if (!parsed || parsedStatus === "error" || completionHadNoOutcome) {
          const attentionTitle =
            completionHadNoOutcome
              ? `Autopilot slice needs verification: ${slice.workstreamTitle ?? slice.workstreamId}`
              : `Autopilot slice failed: ${slice.workstreamTitle ?? slice.workstreamId}`;
          const attentionSummary = completionHadNoOutcome
            ? "The slice reported completion but did not produce artifacts or status updates. Decide whether to retry, request stronger output, or mark tasks manually."
            : "The slice exited without a valid output contract. Review logs/output and decide whether to retry or pause autopilot.";

          const decisionResult = await requestDecisionQueued({
            initiativeId: run.initiativeId,
            correlationId: slice.runId,
            title: attentionTitle,
            summary: attentionSummary,
            urgency: "high",
            options: [
              "Retry this workstream slice",
              "Pause autopilot and investigate",
              "Skip this workstream for now",
            ],
	            blocking: true,
            decisionType: completionHadNoOutcome
              ? "autopilot_completed_without_outcome"
              : "autopilot_failure",
            workstreamId: slice.workstreamId,
            agentId: slice.agentId,
            sourceSystem: "orgx-autopilot",
            conflictSource: completionHadNoOutcome
              ? "slice_completed_without_outcome"
              : "slice_invalid_output",
            dedupeKey: [
              "autopilot",
              run.initiativeId,
              slice.workstreamId,
              completionHadNoOutcome
                ? "slice_completed_without_outcome"
                : "slice_invalid_output",
            ].join(":"),
	            recommendedAction:
              nextActions[0] ??
	              "Verify slice outputs and status updates, then retry once or pause for investigation.",
            sourceRunId: slice.runId,
            sourceRef: {
              run_id: slice.runId,
              workstream_id: slice.workstreamId,
              parsed_status: parsedStatus,
            },
	            evidenceRefs: [
	              {
	                evidence_type: "slice_output_validation",
                title: "Slice output needs verification",
                summary: attentionSummary,
                source_pointer: slice.outputPath,
                payload: {
                  log_path: slice.logPath,
                  parsed_status: parsedStatus,
	                  completion_had_no_outcome: completionHadNoOutcome,
	                },
	              },
                ...artifactEvidenceRefs,
	            ],
		          });

            setLaneState(run, {
              workstreamId: slice.workstreamId,
              state: "blocked",
              activeRunId: null,
              activeTaskIds: [],
              blockedReason:
                slice.lastError ??
                (completionHadNoOutcome
                  ? "Slice completed without verifiable outcomes."
                  : "Slice failed or returned invalid output."),
              waitingOnWorkstreamIds: [],
              retryAt: null,
            });
            if (!run.blockedWorkstreamIds.includes(slice.workstreamId)) {
              run.blockedWorkstreamIds.push(slice.workstreamId);
            }

	          await stopAutoContinueRun({
            run,
            reason: completionHadNoOutcome ? "blocked" : "error",
            error:
              slice.lastError ??
              (completionHadNoOutcome
                ? "Slice completed without verifiable outcomes."
                : "Slice failed or returned invalid output."),
            decisionRequired: completionHadNoOutcome && decisionResult.queued,
            decisionIds: decisionResult.decisionIds,
          });
          return;
        }

        run.lastRunId = slice.runId;
        run.lastTaskId = slice.taskIds[0] ?? run.lastTaskId;
        removeActiveSliceFromRun(run, {
          sliceRunId: slice.runId,
          taskIds: slice.taskIds,
          workstreamId: slice.workstreamId,
        });
        setLaneState(run, {
          workstreamId: slice.workstreamId,
          state: "completed",
          activeRunId: null,
          activeTaskIds: [],
          blockedReason: null,
          waitingOnWorkstreamIds: [],
          retryAt: null,
        });
        run.blockedWorkstreamIds = run.blockedWorkstreamIds.filter(
          (id) => id !== slice.workstreamId
        );
        syncLegacyRunPointers(run);
        // Do not keep prior rate-limit/runtime errors after a completed slice.
        run.lastError = null;
        run.updatedAt = now;

	        try {
	          await updateInitiativeAutoContinueState({
	            initiativeId: run.initiativeId,
	            run,
	          });
	        } catch {
	          // best effort
	        }

	        // Evaluate scope-level completion for milestone/workstream scopes.
	        if (slice.scope && slice.scope !== "task") {
	          try {
	            const scopeGraph = applyLocalInitiativeOverrideToGraph(
	              await buildMissionControlGraph(client, run.initiativeId)
	            );
	            const scopeNodeById = new Map(scopeGraph.nodes.map((n) => [n.id, n]));
	            const scopeResult = evaluateScopeCompletion({
	              scope: slice.scope,
	              milestoneIds: slice.scopeMilestoneIds ?? [],
	              workstreamId: slice.workstreamId,
	              nodeById: scopeNodeById,
	            });
	            if (scopeResult.scopeComplete) {
	              await emitActivitySafe({
	                initiativeId: run.initiativeId,
	                runId: slice.runId,
	                correlationId: slice.runId,
	                phase: "completed",
	                level: "info",
                  progressPct: 100,
                  nextStep:
                    slice.scope === "milestone"
                      ? "Queue the next milestone-ready slice."
                      : "Select the next dispatchable workstream from Next Up.",
	                message: `${slice.scope === "milestone" ? "Milestone" : "Workstream"} scope completed for ${slice.workstreamTitle ?? slice.workstreamId}.`,
	                metadata: {
                    ...buildSliceEnrichment({
                      run,
                      slice,
                      workstreamId: slice.workstreamId,
                      workstreamTitle: slice.workstreamTitle ?? null,
                      domain: slice.domain,
                      requiredSkills: slice.requiredSkills,
                      event: "scope_completed",
                    }),
	                  scope: slice.scope,
	                  milestone_ids: slice.scopeMilestoneIds,
	                  remaining_tasks: 0,
	                },
	              });
	            }
	          } catch {
	            // best-effort scope completion check
	          }
	        }

	        if (run.stopAfterSlice) {
	          run.stopAfterSlice = false;
	          await stopAutoContinueRun({ run, reason: "completed" });
	          return;
	        }

	        if (run.stopRequested) {
	          await stopAutoContinueRun({ run, reason: "stopped" });
	          return;
	        }
      }
    }
    syncLegacyRunPointers(run);

    if (run.stopRequested) {
      run.status = "stopping";
      run.updatedAt = now;
      await stopAutoContinueRun({ run, reason: "stopped" });
      return;
    }

    const tokenBudgetValue =
      typeof run.tokenBudget === "number" && Number.isFinite(run.tokenBudget)
        ? run.tokenBudget
        : null;

    // 2) Enforce token guardrail before starting a new slice.
    if (tokenBudgetValue !== null && run.tokensUsed >= tokenBudgetValue) {
      await stopAutoContinueRun({ run, reason: "budget_exhausted" });
      return;
    }

    const activeSliceCount = listActiveSliceRunIds(run).length;
    if (activeSliceCount >= run.maxParallelSlices) {
      run.updatedAt = now;
      return;
    }

    // 3) Pick next workstream slice and dispatch.
    let graph: Awaited<ReturnType<typeof buildMissionControlGraph>>;
    try {
      graph = applyLocalInitiativeOverrideToGraph(
        await buildMissionControlGraph(client, run.initiativeId)
      );
    } catch (err: unknown) {
      await stopAutoContinueRun({
        run,
        reason: "error",
        error: safeErrorMessage(err),
      });
      return;
    }

    const nodes = graph.nodes;
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    applyLocalStatusOverridesToGraph(run.initiativeId, nodeById);
    const taskNodes = nodes.filter((node) => node.type === "task");
    const todoTasks = taskNodes.filter((node) => isTodoStatus(node.status));
    if (todoTasks.length === 0) {
      await stopAutoContinueRun({ run, reason: "completed" });
      return;
    }

    const taskIsReady = (task: MissionControlNode): boolean =>
      task.dependencyIds.every((depId) => {
        const dependency = nodeById.get(depId);
        return dependency ? isDoneStatus(dependency.status) : true;
      });

    const taskHasBlockedParent = (task: MissionControlNode): boolean => {
      const milestone =
        task.milestoneId ? nodeById.get(task.milestoneId) ?? null : null;
      const workstream =
        task.workstreamId ? nodeById.get(task.workstreamId) ?? null : null;
      return (
        milestone?.status?.toLowerCase() === "blocked" ||
        workstream?.status?.toLowerCase() === "blocked"
      );
    };

    // Select the next eligible workstream by scanning ordered todos.
    let selectedWorkstreamId: string | null = null;
    let deferredBySpawnGuardRateLimit = 0;
    for (const taskId of graph.recentTodos) {
      const node = nodeById.get(taskId);
      if (!node || node.type !== "task") continue;
      if (!isTodoStatus(node.status)) continue;
      if (
        !run.includeVerification &&
        typeof node.title === "string" &&
        /^verification[ \t]+scenario/i.test(node.title)
      ) {
        continue;
      }
	      if (run.allowedWorkstreamIds && node.workstreamId) {
	        if (!run.allowedWorkstreamIds.includes(node.workstreamId)) continue;
	      }
	      if (!node.workstreamId) continue;
      if (run.blockedWorkstreamIds.includes(node.workstreamId)) continue;
      const lane = run.laneByWorkstreamId[node.workstreamId] ?? null;
      if (lane?.state === "running" && lane.activeRunId) continue;
      if (lane?.state === "rate_limited" && lane.retryAt) {
        const retryAtMs = Date.parse(lane.retryAt);
        if (Number.isFinite(retryAtMs) && retryAtMs > Date.now()) {
          deferredBySpawnGuardRateLimit += 1;
          continue;
        }
      }
	      const ws = nodeById.get(node.workstreamId);
      if (ws && !isDispatchableWorkstreamStatus(ws.status)) continue;
      if (!taskIsReady(node)) continue;
      if (taskHasBlockedParent(node)) continue;
      const retryAtMs = getSpawnGuardRetryAtMs(run.initiativeId, node.id);
      if (retryAtMs > 0) {
        deferredBySpawnGuardRateLimit += 1;
        continue;
      }
      selectedWorkstreamId = node.workstreamId;
      break;
    }

	    if (!selectedWorkstreamId) {
      const waitingByWorkstream = new Map<string, string[]>();
      for (const task of taskNodes) {
        if (!isTodoStatus(task.status)) continue;
        if (
          !run.includeVerification &&
          typeof task.title === "string" &&
          /^verification[ \t]+scenario/i.test(task.title)
        ) {
          continue;
        }
        const workstreamId = (task.workstreamId ?? "").trim();
        if (!workstreamId) continue;
        if (
          Array.isArray(run.allowedWorkstreamIds) &&
          run.allowedWorkstreamIds.length > 0 &&
          !run.allowedWorkstreamIds.includes(workstreamId)
        ) {
          continue;
        }
        if (run.blockedWorkstreamIds.includes(workstreamId)) {
          continue;
        }
        const blockedParents = taskHasBlockedParent(task);
        const unresolvedDepWorkstreamIds = task.dependencyIds
          .map((depId) => nodeById.get(depId))
          .filter(
            (dep): dep is MissionControlNode => Boolean(dep && !isDoneStatus(dep.status))
          )
          .map((dep) => (dep.workstreamId ?? "").trim())
          .filter(Boolean);
        if (blockedParents || unresolvedDepWorkstreamIds.length > 0) {
          const existing = waitingByWorkstream.get(workstreamId) ?? [];
          waitingByWorkstream.set(
            workstreamId,
            dedupeStrings([...existing, ...unresolvedDepWorkstreamIds])
          );
        }
      }
      for (const [workstreamId, waitingOnWorkstreamIds] of waitingByWorkstream.entries()) {
        setLaneState(run, {
          workstreamId,
          state: "waiting_dependency",
          activeRunId: null,
          activeTaskIds: [],
          blockedReason: null,
          waitingOnWorkstreamIds,
          retryAt: null,
        });
      }

      if (listActiveSliceRunIds(run).length > 0) {
        run.updatedAt = now;
        return;
      }

	      if (deferredBySpawnGuardRateLimit > 0) {
	        run.updatedAt = now;
	        return;
	      }
      if (run.allowedWorkstreamIds && run.allowedWorkstreamIds.length > 0) {
        const scopedTodoCount = taskNodes.filter((node) => {
          if (!isTodoStatus(node.status)) return false;
          if (
            !run.includeVerification &&
            typeof node.title === "string" &&
            /^verification[ \t]+scenario/i.test(node.title)
          ) {
            return false;
          }
          if (!node.workstreamId) return false;
          return run.allowedWorkstreamIds?.includes(node.workstreamId) ?? false;
        }).length;
        if (scopedTodoCount === 0) {
          await stopAutoContinueRun({ run, reason: "completed" });
          return;
        }
      }
      await stopAutoContinueRun({ run, reason: "blocked" });
      return;
    }

    const workstreamNode =
      (nodeById.get(selectedWorkstreamId) as MissionControlNode | undefined) ?? null;
    const workstreamTitle = workstreamNode?.title ?? null;
    const initiativeNode = nodes.find((node) => node.type === "initiative") ?? null;
    const initiativeTitle =
      initiativeNode?.title ?? `Initiative ${run.initiativeId.slice(0, 8)}`;

    const scopeSelection = selectSliceTasksByScope({
      scope: run.scope,
      workstreamId: selectedWorkstreamId,
      recentTodos: graph.recentTodos,
      nodeById,
      includeVerification: run.includeVerification,
    });
    const sliceTaskNodes = scopeSelection.tasks;
    const scopeMilestoneIds = scopeSelection.milestoneIds;

    const primaryTask = sliceTaskNodes[0] ?? null;
    if (!primaryTask) {
      if (listActiveSliceRunIds(run).length > 0) {
        run.updatedAt = now;
        return;
      }
      await stopAutoContinueRun({ run, reason: "blocked" });
      return;
    }

    let cappedSliceTaskNodes = sliceTaskNodes;
    let expectedDurationHours = cappedSliceTaskNodes.reduce(
      (acc, t) =>
        acc +
        (typeof t.expectedDurationHours === "number" && Number.isFinite(t.expectedDurationHours)
          ? Math.max(0, t.expectedDurationHours)
          : 0),
      0
    );
    let tokenEstimate = estimateTokensForDurationHours(expectedDurationHours);
    const remainingTokens =
      tokenBudgetValue !== null ? tokenBudgetValue - run.tokensUsed : null;
    if (remainingTokens !== null && remainingTokens <= 0) {
      await stopAutoContinueRun({ run, reason: "budget_exhausted" });
      return;
    }

    // If the modeled slice exceeds the remaining budget, shrink the slice to fit rather than
    // stopping immediately (Play should still dispatch at least the primary task when possible).
    if (remainingTokens !== null && tokenEstimate > 0 && tokenEstimate > remainingTokens) {
      const nextSlice: MissionControlNode[] = [];
      let hours = 0;

      for (const task of sliceTaskNodes) {
        const taskHours =
          typeof task.expectedDurationHours === "number" && Number.isFinite(task.expectedDurationHours)
            ? Math.max(0, task.expectedDurationHours)
            : 0;

        if (nextSlice.length === 0) {
          nextSlice.push(task);
          hours += taskHours;
          continue;
        }

        const nextEstimate = estimateTokensForDurationHours(hours + taskHours);
        if (nextEstimate > remainingTokens) continue;
        nextSlice.push(task);
        hours += taskHours;
      }

      cappedSliceTaskNodes = nextSlice;
      expectedDurationHours = hours;
      tokenEstimate = estimateTokensForDurationHours(expectedDurationHours);
    }

    if (remainingTokens !== null && tokenEstimate > 0 && tokenEstimate > remainingTokens) {
      await stopAutoContinueRun({ run, reason: "budget_exhausted" });
      return;
    }

    const executionPolicy = deriveExecutionPolicy(primaryTask, workstreamNode);
    const behaviorConfig = deriveBehaviorConfigContext(primaryTask, workstreamNode);
    const behaviorAutomationLevel = deriveBehaviorAutomationLevel(primaryTask, workstreamNode);
    const sliceRunId = randomUUID();

    await emitActivitySafe({
      initiativeId: run.initiativeId,
      runId: sliceRunId,
      correlationId: sliceRunId,
      phase: "intent",
      level: "info",
      progressPct: 5,
      message: `Orchestrator selected ${workstreamTitle ?? selectedWorkstreamId} for the next slice.`,
      nextStep: `Preparing dispatch checks before spawning ${executionPolicy.domain} execution.`,
      metadata: {
        ...buildSliceEnrichment({
          run,
          taskId: primaryTask.id,
          taskTitle: primaryTask.title ?? null,
          workstreamId: selectedWorkstreamId,
          workstreamTitle: workstreamTitle ?? null,
          domain: executionPolicy.domain,
          requiredSkills: executionPolicy.requiredSkills,
          event: "orchestrator_dispatch",
        }),
        scope: run.scope,
        candidate_task_count: sliceTaskNodes.length,
      },
    });
    const behaviorConfigDrift = detectBehaviorConfigDrift({
      taskNode: primaryTask,
      workstreamNode,
      behaviorConfig,
      behaviorAutomationLevel,
    });

    if (behaviorConfigDrift) {
      await emitActivitySafe({
        initiativeId: run.initiativeId,
        runId: sliceRunId,
        correlationId: sliceRunId,
        phase: "review",
        level: "warn",
        progressPct: 15,
        message:
          `Behavior config drift detected for ${workstreamTitle ?? selectedWorkstreamId}; ` +
          `runtime behavior differs from declared workstream config.`,
        metadata: {
          ...buildSliceEnrichment({
            run,
            taskId: primaryTask.id,
            taskTitle: primaryTask.title ?? null,
            workstreamId: selectedWorkstreamId,
            workstreamTitle: workstreamTitle ?? null,
            domain: executionPolicy.domain,
            requiredSkills: executionPolicy.requiredSkills,
            event: "auto_continue_behavior_config_drift_detected",
          }),
          drift_fields: behaviorConfigDrift.fields,
          declared_behavior_config_id: behaviorConfigDrift.declared.configId,
          declared_behavior_config_version: behaviorConfigDrift.declared.version,
          declared_behavior_config_hash: behaviorConfigDrift.declared.hash,
          declared_policy_source: behaviorConfigDrift.declared.policySource,
          declared_behavior_context: behaviorConfigDrift.declared.context,
          declared_behavior_automation_level: behaviorConfigDrift.declared.automationLevel,
          runtime_behavior_config_id: behaviorConfigDrift.runtime.configId,
          runtime_behavior_config_version: behaviorConfigDrift.runtime.version,
          runtime_behavior_config_hash: behaviorConfigDrift.runtime.hash,
          runtime_policy_source: behaviorConfigDrift.runtime.policySource,
          runtime_behavior_context: behaviorConfigDrift.runtime.context,
          runtime_behavior_automation_level: behaviorConfigDrift.runtime.automationLevel,
          error_location: "mission-control.auto-continue.engine.behavior-config.drift",
        },
        nextStep:
          "Review task/workstream behavior metadata and reconcile the declared config if override is unintended.",
      });
    }

    if (behaviorConfig.requiresApproval) {
      const blockedReason = `Behavior config approval required before dispatch for ${workstreamTitle ?? selectedWorkstreamId}.`;
      await emitActivitySafe({
        initiativeId: run.initiativeId,
        runId: sliceRunId,
        correlationId: sliceRunId,
        phase: "blocked",
        level: "warn",
        progressPct: 20,
        message: blockedReason,
        metadata: {
          ...buildSliceEnrichment({
            run,
            taskId: primaryTask.id,
            taskTitle: primaryTask.title ?? null,
            workstreamId: selectedWorkstreamId,
            workstreamTitle: workstreamTitle ?? null,
            domain: executionPolicy.domain,
            requiredSkills: executionPolicy.requiredSkills,
            event: "auto_continue_behavior_config_approval_required",
          }),
          behavior_config_id: behaviorConfig.configId,
          behavior_config_version: behaviorConfig.version,
          behavior_config_hash: behaviorConfig.hash,
          behavior_approval_status: behaviorConfig.approvalStatus,
          behavior_approval_decision_id: behaviorConfig.approvalDecisionId,
          blocked_reason: blockedReason,
          error_location: "mission-control.auto-continue.engine.behavior-config.approval",
        },
        nextStep: "Approve the behavior config, then rerun Play/auto-continue for this workstream.",
      });
      const decisionResult = await requestDecisionQueued({
        initiativeId: run.initiativeId,
        correlationId: sliceRunId,
        title: `Approve behavior config for ${workstreamTitle ?? selectedWorkstreamId}`,
        summary: [
          `Autopilot paused before dispatch because behavior config requires approval.`,
          `Task: ${primaryTask.id}.`,
          behaviorConfig.configId ? `Config: ${behaviorConfig.configId}.` : "",
          behaviorConfig.version ? `Version: ${behaviorConfig.version}.` : "",
          behaviorConfig.approvalStatus ? `Approval status: ${behaviorConfig.approvalStatus}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
        urgency: "high",
        options: [
          "Approve config and continue execution",
          "Reject config and revise policy",
          "Pause this workstream",
        ],
        blocking: true,
        decisionType: "autopilot_behavior_config_approval",
        workstreamId: selectedWorkstreamId,
        agentId: run.agentId,
        sourceSystem: "orgx-autopilot",
        conflictSource: "behavior_config_requires_approval",
        dedupeKey: [
          "autopilot",
          run.initiativeId,
          selectedWorkstreamId,
          "behavior_config_requires_approval",
          behaviorConfig.configId ?? "default",
          behaviorConfig.version ?? "unknown",
        ].join(":"),
        recommendedAction: "Resolve approval state before allowing autopilot to spawn a worker.",
        sourceRunId: sliceRunId,
        sourceRef: {
          run_id: sliceRunId,
          workstream_id: selectedWorkstreamId,
          task_id: primaryTask.id,
          behavior_config_id: behaviorConfig.configId,
          behavior_approval_status: behaviorConfig.approvalStatus,
          behavior_approval_decision_id: behaviorConfig.approvalDecisionId,
        },
      });
      if (!run.blockedWorkstreamIds.includes(selectedWorkstreamId)) {
        run.blockedWorkstreamIds.push(selectedWorkstreamId);
      }
      setLaneState(run, {
        workstreamId: selectedWorkstreamId,
        state: "blocked",
        activeRunId: null,
        activeTaskIds: [],
        blockedReason,
        waitingOnWorkstreamIds: [],
        retryAt: null,
      });
      await stopAutoContinueRun({
        run,
        reason: "blocked",
        error: blockedReason,
        decisionRequired: decisionResult.queued,
        decisionIds: decisionResult.decisionIds,
      });
      return;
    }

    const isManualPlayDispatch =
      run.stopAfterSlice &&
      Array.isArray(run.allowedWorkstreamIds) &&
      run.allowedWorkstreamIds.length === 1;
    if (behaviorAutomationLevel === "manual" && !isManualPlayDispatch) {
      const blockedReason =
        `Automation level manual prevents auto-continue dispatch for ${workstreamTitle ?? selectedWorkstreamId}.`;
      await emitActivitySafe({
        initiativeId: run.initiativeId,
        runId: sliceRunId,
        correlationId: sliceRunId,
        phase: "blocked",
        level: "warn",
        progressPct: 20,
        message: blockedReason,
        metadata: {
          ...buildSliceEnrichment({
            run,
            taskId: primaryTask.id,
            taskTitle: primaryTask.title ?? null,
            workstreamId: selectedWorkstreamId,
            workstreamTitle: workstreamTitle ?? null,
            domain: executionPolicy.domain,
            requiredSkills: executionPolicy.requiredSkills,
            event: "auto_continue_behavior_automation_manual_blocked",
          }),
          behavior_config_id: behaviorConfig.configId,
          behavior_config_version: behaviorConfig.version,
          behavior_automation_level: behaviorAutomationLevel,
          blocked_reason: blockedReason,
          error_location: "mission-control.auto-continue.engine.behavior.automation.manual",
        },
        nextStep: "Use manual Play to dispatch this workstream slice.",
      });
      const decisionResult = await requestDecisionQueued({
        initiativeId: run.initiativeId,
        correlationId: sliceRunId,
        title: `Manual dispatch required for ${workstreamTitle ?? selectedWorkstreamId}`,
        summary: [
          "Autopilot paused because behavior automation level is manual.",
          `Task: ${primaryTask.id}.`,
          behaviorConfig.configId ? `Config: ${behaviorConfig.configId}.` : "",
          behaviorConfig.version ? `Version: ${behaviorConfig.version}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
        urgency: "high",
        options: [
          "Dispatch this workstream manually now",
          "Switch automation level to supervised",
          "Switch automation level to auto",
        ],
        blocking: true,
        decisionType: "autopilot_behavior_manual_dispatch_required",
        workstreamId: selectedWorkstreamId,
        agentId: run.agentId,
        sourceSystem: "orgx-autopilot",
        conflictSource: "behavior_automation_level_manual",
        dedupeKey: [
          "autopilot",
          run.initiativeId,
          selectedWorkstreamId,
          "behavior_automation_level_manual",
          behaviorConfig.configId ?? "default",
          behaviorConfig.version ?? "unknown",
        ].join(":"),
        recommendedAction:
          "Dispatch manually for this workstream, or switch behavior automation level before rerunning auto-continue.",
        sourceRunId: sliceRunId,
        sourceRef: {
          run_id: sliceRunId,
          workstream_id: selectedWorkstreamId,
          task_id: primaryTask.id,
          behavior_config_id: behaviorConfig.configId,
          behavior_automation_level: behaviorAutomationLevel,
        },
      });
      if (!run.blockedWorkstreamIds.includes(selectedWorkstreamId)) {
        run.blockedWorkstreamIds.push(selectedWorkstreamId);
      }
      setLaneState(run, {
        workstreamId: selectedWorkstreamId,
        state: "blocked",
        activeRunId: null,
        activeTaskIds: [],
        blockedReason,
        waitingOnWorkstreamIds: [],
        retryAt: null,
      });
      await stopAutoContinueRun({
        run,
        reason: "blocked",
        error: blockedReason,
        decisionRequired: decisionResult.queued,
        decisionIds: decisionResult.decisionIds,
      });
      return;
    }

    if (behaviorAutomationLevel === "supervised" && !run.stopAfterSlice) {
      run.stopAfterSlice = true;
      await emitActivitySafe({
        initiativeId: run.initiativeId,
        runId: sliceRunId,
        correlationId: sliceRunId,
        phase: "execution",
        level: "info",
        progressPct: 25,
        message: `Supervised automation level: dispatching one slice for ${workstreamTitle ?? selectedWorkstreamId}.`,
        metadata: {
          ...buildSliceEnrichment({
            run,
            taskId: primaryTask.id,
            taskTitle: primaryTask.title ?? null,
            workstreamId: selectedWorkstreamId,
            workstreamTitle: workstreamTitle ?? null,
            domain: executionPolicy.domain,
            requiredSkills: executionPolicy.requiredSkills,
            event: "auto_continue_behavior_automation_supervised_one_shot",
          }),
          behavior_automation_level: behaviorAutomationLevel,
        },
        nextStep: "Resume to dispatch the next slice after this one completes.",
      });
    }

	    const spawnGuardResult = await checkSpawnGuardSafe({
	      domain: executionPolicy.domain,
	      taskId: primaryTask.id,
	      initiativeId: run.initiativeId,
	      correlationId: sliceRunId,
	      runId: sliceRunId,
	      targetLabel: "autopilot slice",
	    });
    if (spawnGuardResult && typeof spawnGuardResult === "object") {
      const allowed = (spawnGuardResult as Record<string, unknown>).allowed;
      if (allowed === false) {
        const blockedReason = summarizeSpawnGuardBlockReason(spawnGuardResult);
        const retryable = spawnGuardIsRateLimited(spawnGuardResult);
        const rateLimitOverrideRequested = retryable && run.ignoreSpawnGuardRateLimit;

	        if (retryable && !rateLimitOverrideRequested) {
	          const retryAtMs = Date.now() + AUTO_CONTINUE_SPAWN_GUARD_RETRY_MS;
          const retryAtIso = new Date(retryAtMs).toISOString();
	          autoContinueSpawnGuardRetryByTask.set(primaryTask.id, {
	            initiativeId: run.initiativeId,
	            retryAtMs,
	          });
          setLaneState(run, {
            workstreamId: selectedWorkstreamId,
            state: "rate_limited",
            activeRunId: null,
            activeTaskIds: [],
            blockedReason,
            waitingOnWorkstreamIds: [],
            retryAt: retryAtIso,
          });
	          await emitActivitySafe({
            initiativeId: run.initiativeId,
            runId: sliceRunId,
            correlationId: sliceRunId,
            phase: "blocked",
            level: "warn",
            progressPct: 25,
            message: `Autopilot spawn guard rate-limited ${workstreamTitle ?? selectedWorkstreamId}; retrying shortly.`,
            metadata: {
              ...buildSliceEnrichment({
                run,
                taskId: primaryTask.id,
                taskTitle: primaryTask.title ?? null,
                workstreamId: selectedWorkstreamId,
                workstreamTitle: workstreamTitle ?? null,
                domain: executionPolicy.domain,
                requiredSkills: executionPolicy.requiredSkills,
                event: "auto_continue_spawn_guard_rate_limited",
              }),
              blocked_reason: blockedReason,
              error_location: "mission-control.auto-continue.engine.spawn-guard.rate-limited",
		              next_retry_at: retryAtIso,
              next_retry_in_ms: AUTO_CONTINUE_SPAWN_GUARD_RETRY_MS,
              spawn_guard: spawnGuardResult,
            },
            nextStep: "Retry dispatch when spawn rate limits recover.",
          });
	          run.lastError = blockedReason;
	          run.updatedAt = now;
          syncLegacyRunPointers(run);
	          try {
	            await updateInitiativeAutoContinueState({
	              initiativeId: run.initiativeId,
              run,
            });
          } catch {
            // best effort
          }
          return;
        }

        if (rateLimitOverrideRequested) {
          const overrideMode =
            run.stopAfterSlice &&
            Array.isArray(run.allowedWorkstreamIds) &&
            run.allowedWorkstreamIds.length === 1
              ? "Play"
              : "Auto-continue";
	          await emitActivitySafe({
            initiativeId: run.initiativeId,
            runId: sliceRunId,
            correlationId: sliceRunId,
            phase: "execution",
            level: "warn",
            progressPct: 25,
            message: `${overrideMode} override: dispatching ${workstreamTitle ?? selectedWorkstreamId} despite spawn guard rate limit.`,
            metadata: {
              ...buildSliceEnrichment({
                run,
                taskId: primaryTask.id,
                taskTitle: primaryTask.title ?? null,
                workstreamId: selectedWorkstreamId,
                workstreamTitle: workstreamTitle ?? null,
                domain: executionPolicy.domain,
                requiredSkills: executionPolicy.requiredSkills,
                event: "auto_continue_spawn_guard_rate_limit_overridden",
              }),
              blocked_reason: blockedReason,
              error_location: "mission-control.auto-continue.engine.spawn-guard.override",
              spawn_guard: spawnGuardResult,
            },
            nextStep: "Manual Play requested immediate execution for this single workstream slice.",
	          });
	          run.lastError = null;
	          run.updatedAt = now;
          setLaneState(run, {
            workstreamId: selectedWorkstreamId,
            state: "idle",
            activeRunId: null,
            activeTaskIds: [],
            blockedReason: null,
            waitingOnWorkstreamIds: [],
            retryAt: null,
          });
	        } else {
          // Maintain existing behavior: mark the primary task blocked when a quality gate denies dispatch.
          try {
            await client.updateEntity("task", primaryTask.id, { status: "blocked" });
          } catch {
            // best effort
          }

          try {
            await syncParentRollupsForTask({
              initiativeId: run.initiativeId,
              taskId: primaryTask.id,
              workstreamId: selectedWorkstreamId,
              milestoneId: primaryTask.milestoneId,
              correlationId: sliceRunId,
            });
          } catch {
            // best effort
          }

          await emitActivitySafe({
            initiativeId: run.initiativeId,
            runId: sliceRunId,
            correlationId: sliceRunId,
            phase: "blocked",
            level: "error",
            progressPct: 25,
            message: `Autopilot blocked by spawn guard for ${workstreamTitle ?? selectedWorkstreamId}.`,
            metadata: {
              ...buildSliceEnrichment({
                run,
                taskId: primaryTask.id,
                taskTitle: primaryTask.title ?? null,
                workstreamId: selectedWorkstreamId,
                workstreamTitle: workstreamTitle ?? null,
                domain: executionPolicy.domain,
                requiredSkills: executionPolicy.requiredSkills,
                event: "auto_continue_spawn_guard_blocked",
              }),
              blocked_reason: blockedReason,
              error_location: "mission-control.auto-continue.engine.spawn-guard.blocked",
              spawn_guard: spawnGuardResult,
            },
          });
	          const decisionResult = await requestDecisionQueued({
            initiativeId: run.initiativeId,
            correlationId: sliceRunId,
            title: `Unblock autopilot for ${workstreamTitle ?? selectedWorkstreamId}`,
            summary: [
              `Spawn guard denied dispatch for primary task ${primaryTask.id}.`,
              `Reason: ${blockedReason}`,
              `Domain: ${executionPolicy.domain}`,
              `Required skills: ${executionPolicy.requiredSkills.join(", ")}`,
            ].join(" "),
            urgency: "high",
            options: [
              "Approve exception and continue",
              "Reassign slice/domain",
              "Pause and investigate quality gate",
            ],
	            blocking: true,
            decisionType: "autopilot_spawn_guard_block",
            workstreamId: selectedWorkstreamId,
            agentId: run.agentId,
            sourceSystem: "orgx-autopilot",
            conflictSource: "spawn_guard_blocked",
            dedupeKey: [
              "autopilot",
              run.initiativeId,
              selectedWorkstreamId,
              "spawn_guard_blocked",
              executionPolicy.domain,
            ].join(":"),
            recommendedAction:
              "Choose exception, reassignment, or pause so dispatch can proceed safely.",
            sourceRunId: sliceRunId,
            sourceRef: {
              run_id: sliceRunId,
              workstream_id: selectedWorkstreamId,
              task_id: primaryTask.id,
              domain: executionPolicy.domain,
            },
            evidenceRefs: [
              {
                evidence_type: "spawn_guard_result",
                title: "Spawn guard denied dispatch",
                summary: blockedReason,
                source_pointer: null,
                payload: {
                  spawn_guard: spawnGuardResult,
                  task_id: primaryTask.id,
                  domain: executionPolicy.domain,
                },
              },
            ],
	          });
          if (!run.blockedWorkstreamIds.includes(selectedWorkstreamId)) {
            run.blockedWorkstreamIds.push(selectedWorkstreamId);
          }
          setLaneState(run, {
            workstreamId: selectedWorkstreamId,
            state: "blocked",
            activeRunId: null,
            activeTaskIds: [],
            blockedReason,
            waitingOnWorkstreamIds: [],
            retryAt: null,
          });
	          await stopAutoContinueRun({
	            run,
            reason: "blocked",
            error: blockedReason,
            decisionRequired: decisionResult.queued,
            decisionIds: decisionResult.decisionIds,
          });
          return;
        }
      }
    }

    const milestoneIds = dedupeStrings(
      cappedSliceTaskNodes.map((t) => (t.milestoneId ?? "").trim()).filter(Boolean)
    );
    const milestoneSummaries = milestoneIds
      .map((id) => nodeById.get(id))
      .filter((node): node is MissionControlNode => Boolean(node && node.type === "milestone"))
      .map((m) => ({ id: m.id, title: m.title, status: m.status }));

    const taskSummaries = cappedSliceTaskNodes.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      milestoneId: t.milestoneId ?? null,
    }));

    const schemaPath = ensureAutopilotSliceSchemaPath(AUTO_CONTINUE_SLICE_SCHEMA_FILENAME);

    // Try server KickoffContext (includes team context, acceptance criteria, etc.)
    let prompt: string;
    let kickoffContextHash: string | null = null;
    if (fetchKickoffContextSafeFn && renderKickoffMessageFn) {
      let kickoff: KickoffContext | null = null;
      try {
        kickoff = await fetchKickoffContextSafeFn(client, {
          initiative_id: run.initiativeId,
          workstream_id: selectedWorkstreamId,
          task_id: primaryTask.id,
          domain: executionPolicy.domain,
          required_skills: executionPolicy.requiredSkills,
          agent_id: resolveOrgxAgentForDomain(executionPolicy.domain).id,
        });
      } catch {
        // best effort: fall back to local prompt
      }

      if (kickoff) {
        const rendered = renderKickoffMessageFn({
          baseMessage: `Execute workstream slice for ${workstreamTitle ?? selectedWorkstreamId}`,
          kickoff,
          domain: executionPolicy.domain,
          requiredSkills: executionPolicy.requiredSkills,
        });
        const sliceInstructions = buildSliceOutputInstructions({
          runId: sliceRunId,
          schemaPath,
          requiredSkills: executionPolicy.requiredSkills,
        });
        prompt = rendered.message + "\n\n" + sliceInstructions;
        kickoffContextHash = rendered.contextHash;
      } else {
        // Fallback: existing local prompt (offline/degraded mode)
        prompt = buildWorkstreamSlicePrompt({
          initiativeTitle,
          initiativeId: run.initiativeId,
          workstreamId: selectedWorkstreamId,
          workstreamTitle: workstreamTitle ?? `Workstream ${selectedWorkstreamId.slice(0, 8)}`,
          milestoneSummaries,
          taskSummaries,
          executionPolicy,
          behaviorConfig,
          runId: sliceRunId,
          schemaPath,
        });
      }
    } else {
      // No KickoffContext functions available: use local prompt
      prompt = buildWorkstreamSlicePrompt({
        initiativeTitle,
        initiativeId: run.initiativeId,
        workstreamId: selectedWorkstreamId,
        workstreamTitle: workstreamTitle ?? `Workstream ${selectedWorkstreamId.slice(0, 8)}`,
        milestoneSummaries,
        taskSummaries,
        executionPolicy,
        behaviorConfig,
        runId: sliceRunId,
        schemaPath,
      });
    }

    // Append per-scope directive for milestone/workstream scopes.
    if (run.scope !== "task") {
      const msNodes = scopeMilestoneIds
        .map((id) => nodeById.get(id))
        .filter((n): n is MissionControlNode => Boolean(n));
      const scopeDirective = buildScopeDirective(run.scope, {
        milestoneTitles: msNodes.map((n) => n.title),
        workstreamTitle: workstreamTitle ?? undefined,
        taskCount: cappedSliceTaskNodes.length,
      });
      if (scopeDirective) {
        prompt = prompt + "\n\n" + scopeDirective;
      }
    }

    const logsDir = join(getOrgxPluginConfigDir(), AUTO_CONTINUE_SLICE_LOG_DIRNAME);
    const logPath = join(logsDir, `${sliceRunId}.log`);
    const outputPath = join(logsDir, `${sliceRunId}.output.json`);

    const configuredWorkerCwd = (process.env.ORGX_AUTOPILOT_CWD ?? "").trim();
    let workerCwd = configuredWorkerCwd || resolveAutopilotDefaultCwd(__filename);
    // LaunchAgents sometimes start with cwd="/". Fall back to plugin root (or home if unresolved).
    if (!workerCwd || workerCwd === "/") {
      workerCwd = resolveAutopilotDefaultCwd(__filename);
    }
    const sliceAgent = resolveOrgxAgentForDomain(executionPolicy.domain);
    const workerKind = (process.env.ORGX_AUTOPILOT_WORKER_KIND ?? "").trim().toLowerCase();
    const inferredExecutor =
      workerKind === "claude-code" || workerKind === "claude_code" ? "claude-code" : "codex";
    const executorRaw =
      (process.env.ORGX_AUTOPILOT_EXECUTOR ?? "").trim().toLowerCase() || inferredExecutor;
    const executorSourceClient: RuntimeSourceClient =
      executorRaw === "claude-code" || executorRaw === "claude_code" ? "claude-code" : "codex";
    let runtimeHookUrl: string | null = null;
    let runtimeHookToken: string | null = null;
    try {
      const snapshot = readOpenClawSettingsSnapshot();
      const port = readOpenClawGatewayPort(snapshot.raw);
      runtimeHookUrl = `http://127.0.0.1:${port}/orgx/api/hooks/runtime`;
      runtimeHookToken = resolveRuntimeHookToken();
    } catch {
      // best effort
    }
	        const spawned = spawnCodexSliceWorker({
	          runId: sliceRunId,
	          prompt,
	          cwd: workerCwd,
	          logPath,
	          outputPath,
            outputSchemaPath: schemaPath,
	          env: {
	            ORGX_SOURCE_CLIENT: executorSourceClient,
	            ORGX_RUN_ID: sliceRunId,
	            ORGX_CORRELATION_ID: sliceRunId,
	            ORGX_INITIATIVE_ID: run.initiativeId,
	            ORGX_WORKSTREAM_ID: selectedWorkstreamId,
	            ORGX_WORKSTREAM_TITLE: workstreamTitle ?? undefined,
	            ORGX_TASK_ID: primaryTask.id,
              ORGX_REQUIRED_SKILLS: executionPolicy.requiredSkills.join(","),
              ORGX_BEHAVIOR_CONFIG_ID: behaviorConfig.configId ?? undefined,
              ORGX_BEHAVIOR_CONFIG_VERSION: behaviorConfig.version ?? undefined,
              ORGX_BEHAVIOR_CONFIG_HASH: behaviorConfig.hash ?? undefined,
              ORGX_POLICY_SOURCE: behaviorConfig.policySource ?? undefined,
              ORGX_AUTOMATION_LEVEL: behaviorAutomationLevel,
              ORGX_BEHAVIOR_CONTEXT: behaviorConfig.context ?? undefined,
	            ORGX_AGENT_ID: sliceAgent.id,
	            ORGX_AGENT_NAME: sliceAgent.name,
              ORGX_KICKOFF_CONTEXT_HASH: kickoffContextHash ?? undefined,
	            ORGX_OUTPUT_PATH: outputPath,
	            ORGX_RUNTIME_HOOK_URL: runtimeHookUrl ?? undefined,
	            ORGX_HOOK_TOKEN: runtimeHookToken ?? undefined,
	          },
	        });

	    const slice: AutoContinueSliceRun = {
	      runId: sliceRunId,
	      initiativeId: run.initiativeId,
	      initiativeTitle: initiativeTitle ?? null,
	      workstreamId: selectedWorkstreamId,
	      workstreamTitle,
	      agentId: sliceAgent.id,
	      agentName: sliceAgent.name,
	      domain: executionPolicy.domain,
	      requiredSkills: executionPolicy.requiredSkills,
        behaviorConfigId: behaviorConfig.configId,
        behaviorConfigVersion: behaviorConfig.version,
        behaviorConfigHash: behaviorConfig.hash,
        behaviorPolicySource: behaviorConfig.policySource,
        behaviorAutomationLevel,
	      sourceClient: executorSourceClient,
	      pid: spawned.pid,
	      status: "running",
      startedAt: now,
      finishedAt: null,
      updatedAt: now,
      tokenEstimate: tokenEstimate > 0 ? tokenEstimate : null,
      outputPath,
      logPath,
      taskIds: cappedSliceTaskNodes.map((t) => t.id),
      milestoneIds,
      scope: run.scope,
      scopeMilestoneIds: scopeMilestoneIds,
      lastError: null,
      isMockWorker: workerKind === "mock",
    };
    autoContinueSliceRuns.set(sliceRunId, slice);

    try {
      writeRuntimeEvent({
        sourceClient: executorSourceClient,
        event: "session_start",
        runId: sliceRunId,
        initiativeId: run.initiativeId,
        workstreamId: selectedWorkstreamId,
        taskId: primaryTask.id,
        agentId: slice.agentId,
        agentName: sliceAgent.name,
        phase: "execution",
        message: `Autopilot slice started: ${workstreamTitle ?? selectedWorkstreamId}`,
        metadata: {
          event: "autopilot_slice_started",
          initiative_id: run.initiativeId,
          run_id: sliceRunId,
          slice_run_id: sliceRunId,
          workstream_id: selectedWorkstreamId,
          correlation_id: sliceRunId,
          requested_by_agent_id: run.agentId,
          requested_by_agent_name: run.agentName,
          domain: executionPolicy.domain,
          required_skills: executionPolicy.requiredSkills,
          behavior_config_id: behaviorConfig.configId,
          behavior_config_version: behaviorConfig.version,
          behavior_config_hash: behaviorConfig.hash,
          policy_source: behaviorConfig.policySource,
          behavior_automation_level: behaviorAutomationLevel,
          task_ids: slice.taskIds,
          initiative_title: initiativeTitle ?? null,
          workstream_title: workstreamTitle ?? null,
          scope: slice.scope,
          scope_milestone_ids: slice.scopeMilestoneIds,
          log_path: logPath,
          output_path: outputPath,
          ...mockMeta(slice),
        },
      });
    } catch {
      // best effort
    }

    autoContinueSliceLastHeartbeatMs.set(sliceRunId, Date.now());

    await emitActivitySafe({
      initiativeId: run.initiativeId,
      runId: sliceRunId,
      correlationId: sliceRunId,
      progressPct: 10,
      nextStep: `Worker ${sliceAgent.name} is executing ${workstreamTitle ?? selectedWorkstreamId}.`,
      phase: "execution",
      level: "info",
      message: `Autopilot dispatched slice for ${workstreamTitle ?? selectedWorkstreamId}.`,
      metadata: {
        ...buildSliceEnrichment({
          run,
          slice,
          taskId: primaryTask.id,
          taskTitle: primaryTask.title ?? null,
          workstreamId: selectedWorkstreamId,
          workstreamTitle: workstreamTitle ?? null,
          domain: executionPolicy.domain,
          requiredSkills: executionPolicy.requiredSkills,
          event: "autopilot_slice_dispatched",
        }),
        behavior_config_id: behaviorConfig.configId,
        behavior_config_version: behaviorConfig.version,
        behavior_config_hash: behaviorConfig.hash,
        policy_source: behaviorConfig.policySource,
        behavior_automation_level: behaviorAutomationLevel,
        initiative_title: initiativeTitle ?? null,
        scope: slice.scope,
        scope_milestone_ids: slice.scopeMilestoneIds,
        log_path: logPath,
        output_path: outputPath,
        ...mockMeta(slice),
      },
    });

    upsertAgentContext({
      agentId: slice.agentId,
      initiativeId: run.initiativeId,
      initiativeTitle: initiativeTitle ?? null,
      workstreamId: selectedWorkstreamId,
      taskId: primaryTask.id,
    });
    upsertRunContext({
      runId: sliceRunId,
      agentId: slice.agentId,
      initiativeId: run.initiativeId,
      initiativeTitle: initiativeTitle ?? null,
      workstreamId: selectedWorkstreamId,
      taskId: primaryTask.id,
    });

    run.lastTaskId = primaryTask.id;
    run.lastRunId = sliceRunId;
    run.activeSliceRunIds = dedupeStrings([
      ...run.activeSliceRunIds,
      sliceRunId,
    ]);
    run.activeTaskIds = dedupeStrings([...run.activeTaskIds, ...slice.taskIds]);
    setLaneState(run, {
      workstreamId: selectedWorkstreamId,
      state: "running",
      activeRunId: sliceRunId,
      activeTaskIds: slice.taskIds,
      blockedReason: null,
      waitingOnWorkstreamIds: [],
      retryAt: null,
    });
    run.activeTaskTokenEstimate = tokenEstimate > 0 ? tokenEstimate : null;
    syncLegacyRunPointers(run);
    // Clear stale errors when a new slice dispatches successfully.
    run.lastError = null;
    run.updatedAt = now;

    try {
      await client.updateEntity("initiative", run.initiativeId, { status: "active" });
    } catch {
      // best effort
    }

    try {
      await updateInitiativeAutoContinueState({
        initiativeId: run.initiativeId,
        run,
      });
    } catch {
      // best effort
    }
  }

  async function tickAllAutoContinue(): Promise<void> {
    if (autoContinueTickInFlight) {
      // Wait for the in-flight tick to finish instead of silently dropping.
      await autoContinueTickInFlight.catch(() => {});
      return;
    }
    const work = (async () => {
      for (const run of autoContinueRuns.values()) {
        try {
          await tickAutoContinueRun(run);
        } catch (err: unknown) {
          // Never let one loop crash the whole handler.
          run.lastError = `[mission-control.auto-continue.engine.tick-all] ${safeErrorMessage(err)}`;
          run.updatedAt = new Date().toISOString();
          await stopAutoContinueRun({ run, reason: "error", error: run.lastError });
        }
      }
    })();
    autoContinueTickInFlight = work;
    try {
      await work;
    } finally {
      autoContinueTickInFlight = null;
    }
  }

  function isInitiativeActiveStatus(status: string | null | undefined): boolean {
    const normalized = (status ?? "").trim().toLowerCase();
    if (!normalized) return false;
    return !(
      normalized === "completed" ||
      normalized === "done" ||
      normalized === "archived" ||
      normalized === "deleted" ||
      normalized === "cancelled"
    );
  }

  function runningAutoContinueForWorkstream(
    initiativeId: string,
    workstreamId: string
  ): AutoContinueRun | null {
    const run = autoContinueRuns.get(initiativeId) ?? null;
    if (!run) return null;
    ensureRunInternals(run);
    if (run.status !== "running" && run.status !== "stopping") return null;
    if (
      Array.isArray(run.allowedWorkstreamIds) &&
      run.allowedWorkstreamIds.length > 0 &&
      !run.allowedWorkstreamIds.includes(workstreamId)
    ) {
      return null;
    }
    const lane = run.laneByWorkstreamId[workstreamId] ?? null;
    if (
      lane &&
      (lane.state === "running" ||
        lane.state === "blocked" ||
        lane.state === "waiting_dependency" ||
        lane.state === "rate_limited")
    ) {
      return run;
    }
    if (
      Array.isArray(run.allowedWorkstreamIds) &&
      run.allowedWorkstreamIds.length > 0 &&
      run.allowedWorkstreamIds.includes(workstreamId) &&
      (run.status === "running" || run.status === "stopping")
    ) {
      return run;
    }
    return null;
  }

  function getAutoContinueLaneForWorkstream(
    initiativeId: string,
    workstreamId: string
  ): AutoContinueLane | null {
    const run = autoContinueRuns.get(initiativeId) ?? null;
    if (!run) return null;
    ensureRunInternals(run);
    return run.laneByWorkstreamId[workstreamId] ?? null;
  }

  async function scheduleAutoFixForWorkstream(input: {
    initiativeId: string;
    workstreamId: string;
    runId?: string | null;
    event?: string | null;
    requestedByAgentId?: string | null;
    requestedByAgentName?: string | null;
    graceMs?: number | null;
  }): Promise<{
    requestId: string;
    initiativeId: string;
    workstreamId: string;
    runId: string | null;
    sourceEvent: string | null;
    graceMs: number;
    scheduledAt: string;
    dueAt: string;
  }> {
    const initiativeId = input.initiativeId.trim();
    const workstreamId = input.workstreamId.trim();
    if (!initiativeId || !workstreamId) {
      throw new Error("initiativeId and workstreamId are required");
    }

    const runId = (input.runId ?? "").trim() || null;
    const sourceEvent = (input.event ?? "").trim() || null;
    const requestedByAgentId = (input.requestedByAgentId ?? "").trim() || null;
    const requestedByAgentName = (input.requestedByAgentName ?? "").trim() || null;

    const providedGraceMs =
      typeof input.graceMs === "number" && Number.isFinite(input.graceMs)
        ? Math.floor(input.graceMs)
        : null;
    const graceMs = Math.max(
      1_000,
      Math.min(120_000, providedGraceMs ?? AUTO_FIX_DEFAULT_GRACE_MS)
    );

    const key = `${initiativeId}:${workstreamId}`;
    const existing = autoFixByScope.get(key);
    if (existing?.timer) clearTimeout(existing.timer);

    const scheduledAt = new Date().toISOString();
    const dueAt = new Date(Date.now() + graceMs).toISOString();
    const requestId = randomUUID();
    const resolveAutoFixRunContext = (): AutoContinueRunContext => {
      const activeRun = autoContinueRuns.get(initiativeId) ?? null;
      return {
        initiativeId,
        agentId: activeRun?.agentId ?? requestedByAgentId ?? "main",
        agentName: activeRun?.agentName ?? requestedByAgentName ?? null,
        scope: activeRun?.scope ?? "task",
      };
    };

    const emitSkip = async (reason: AutoFixSkipReason, details?: Record<string, unknown>) => {
      await emitActivitySafe({
        initiativeId,
        runId: runId ?? undefined,
        correlationId: runId ?? undefined,
        phase: "review",
        level: reason === "error" ? "error" : "warn",
        message:
          reason === "paused_by_user"
            ? `Auto-fix skipped for ${workstreamId}: paused during grace window.`
            : reason === "already_running"
              ? `Auto-fix skipped for ${workstreamId}: workstream already running.`
              : reason === "missing_workstream"
                ? `Auto-fix skipped for ${workstreamId}: workstream data unavailable.`
            : reason === "missing_scope"
                  ? `Auto-fix skipped: scope metadata was incomplete.`
                  : `Auto-fix failed for ${workstreamId}.`,
        metadata: {
          ...buildSliceEnrichment({
            run: resolveAutoFixRunContext(),
            workstreamId,
            event: "autopilot_autofix_skipped",
            actionType: "auto_fix",
          }),
          reason,
          run_id: runId,
          source_event: sourceEvent,
          grace_ms: graceMs,
          request_id: requestId,
          scheduled_at: scheduledAt,
          due_at: dueAt,
          ...(details ?? {}),
        },
      });
    };

    const executeScheduledAutoFix = async () => {
      const pending = autoFixByScope.get(key);
      if (!pending || pending.requestId !== requestId) return;
      autoFixByScope.delete(key);

      const existingRun = autoContinueRuns.get(initiativeId) ?? null;
      if (
        existingRun &&
        (existingRun.stopRequested ||
          existingRun.status === "stopping" ||
          existingRun.stopReason === "stopped")
      ) {
        await emitSkip("paused_by_user");
        return;
      }
	      if (
	        existingRun &&
	        (existingRun.status === "running" || existingRun.status === "stopping") &&
	        listActiveSliceRunIds(existingRun).length > 0
	      ) {
        const activeRunIds = listActiveSliceRunIds(existingRun);
	        await emitSkip("already_running", {
	          active_run_id: activeRunIds[0] ?? null,
            active_run_ids: activeRunIds,
	          run_status: existingRun.status,
	        });
	        return;
	      }

      let optionalDecisionsApproved = 0;
      if (decisionAutoResolveGuardedEnabled) {
        try {
          const decisionResult = await client.listEntities("decision", {
            initiative_id: initiativeId,
            status: "pending",
            limit: 500,
          });
          const decisionRows = Array.isArray(decisionResult?.data) ? decisionResult.data : [];
          for (const row of decisionRows) {
            if (!row || typeof row !== "object") continue;
            const record = row as Record<string, unknown>;
            const decisionId = pickString(record, ["id"])?.trim() ?? "";
            if (!decisionId) continue;
            if (!isPendingDecisionStatus(record.status ?? record.decision_status)) continue;
            if (!decisionMatchesWorkstream(record, workstreamId, runId)) continue;
            if (decisionIsBlocking(record)) continue;
            const autoApprovalNote =
              "Auto-approved by OrgX auto-fix (non-blocking follow-up decision).";
            if (typeof (client as { decideDecision?: unknown }).decideDecision === "function") {
              await (client as {
                decideDecision: (
                  id: string,
                  action: "approve" | "reject",
                  input?: { note?: string }
                ) => Promise<unknown>;
              }).decideDecision(decisionId, "approve", { note: autoApprovalNote });
            } else {
              await client.updateEntity("decision", decisionId, {
                status: "approved",
                resolution_summary: autoApprovalNote,
              });
            }
            optionalDecisionsApproved += 1;
          }
        } catch {
          // best effort
        }
      }

      let resetTaskCount = 0;
      try {
        const taskResult = await client.listEntities("task", {
          initiative_id: initiativeId,
          workstream_id: workstreamId,
          limit: 100,
        });
        const taskRows = Array.isArray(taskResult?.data) ? taskResult.data : [];
        if (taskRows.length === 0) {
          await emitSkip("missing_workstream");
          return;
        }
        for (const row of taskRows) {
          if (!row || typeof row !== "object") continue;
          const record = row as Record<string, unknown>;
          const taskId = pickString(record, ["id"])?.trim() ?? "";
          if (!taskId) continue;
          const status = normalizeStatusValue(record.status);
          if (!status || status === "todo" || status === "done" || status === "completed") {
            continue;
          }
          const shouldReset =
            status === "in_progress" ||
            status === "inprogress" ||
            status === "active" ||
            status === "running" ||
            status === "working" ||
            status === "planning" ||
            status === "dispatching" ||
            status === "pending" ||
            status === "blocked" ||
            status === "stalled" ||
            status === "failed" ||
            status === "error";
          if (!shouldReset) continue;
          await client.updateEntity("task", taskId, { status: "todo" });
          resetTaskCount += 1;
        }
      } catch {
        // best effort
      }

      const latestRun = autoContinueRuns.get(initiativeId) ?? null;
      const dispatchAgentId =
        latestRun?.agentId ??
        requestedByAgentId ??
        "main";
      const dispatchAgentName =
        latestRun?.agentName ??
        requestedByAgentName ??
        null;
      const dispatchRun = await startAutoContinueRun({
        initiativeId,
        agentId: dispatchAgentId,
        agentName: dispatchAgentName,
        // Auto-fix retries should follow current defaults unless an operator explicitly
        // starts a run with a budget override.
        tokenBudget: null,
        includeVerification: latestRun?.includeVerification ?? false,
        allowedWorkstreamIds: [workstreamId],
        maxParallelSlices: 1,
        parallelMode: latestRun?.parallelMode ?? "iwmt",
        stopAfterSlice: true,
        ignoreSpawnGuardRateLimit: latestRun?.ignoreSpawnGuardRateLimit ?? false,
      });
      await tickAutoContinueRun(dispatchRun);

      await emitActivitySafe({
        initiativeId,
        runId: dispatchRun.activeRunId ?? runId ?? undefined,
        correlationId: dispatchRun.activeRunId ?? runId ?? undefined,
        phase: "execution",
        level: "info",
        message: `Auto-fix dispatched for ${workstreamId}.`,
        metadata: {
          ...buildSliceEnrichment({
            run: {
              initiativeId,
              agentId: dispatchAgentId,
              agentName: dispatchAgentName,
              scope: dispatchRun.scope,
            },
            workstreamId,
            event: "autopilot_autofix_executed",
            actionType: "auto_fix",
          }),
          source_event: sourceEvent,
          run_id: runId,
          grace_ms: graceMs,
          request_id: requestId,
          scheduled_at: scheduledAt,
          due_at: dueAt,
          optional_decisions_auto_approved: optionalDecisionsApproved,
          reset_task_count: resetTaskCount,
          dispatched_run_id: dispatchRun.activeRunId,
          dispatch_agent_id: dispatchAgentId,
          dispatch_agent_name: dispatchAgentName,
        },
      });
    };

    const pending: PendingAutoFix = {
      requestId,
      key,
      initiativeId,
      workstreamId,
      runId,
      sourceEvent,
      requestedByAgentId,
      requestedByAgentName,
      graceMs,
      scheduledAt,
      dueAt,
      timer: null,
    };
    const timer = setTimeout(() => {
      void executeScheduledAutoFix().catch(async (err: unknown) => {
        autoFixByScope.delete(key);
        await emitSkip("error", {
          error: safeErrorMessage(err),
        });
      });
    }, graceMs);
    pending.timer = timer;
    autoFixByScope.set(key, pending);

    await emitActivitySafe({
      initiativeId,
      runId: runId ?? undefined,
      correlationId: runId ?? undefined,
      phase: "review",
      level: "info",
      message: `Auto-fix scheduled for ${workstreamId} in ${Math.round(graceMs / 1000)}s.`,
      metadata: {
        ...buildSliceEnrichment({
          run: resolveAutoFixRunContext(),
          workstreamId,
          event: "autopilot_autofix_scheduled",
          actionType: "auto_fix",
        }),
        source_event: sourceEvent,
        run_id: runId,
        grace_ms: graceMs,
        request_id: requestId,
        scheduled_at: scheduledAt,
        due_at: dueAt,
      },
    });

    return {
      requestId,
      initiativeId,
      workstreamId,
      runId,
      sourceEvent,
      graceMs,
      scheduledAt,
      dueAt,
    };
  }

  async function startAutoContinueRun(input: {
    initiativeId: string;
    agentId: string;
    agentName?: string | null;
    tokenBudget: unknown;
    includeVerification: boolean;
    allowedWorkstreamIds: string[] | null;
    maxParallelSlices?: unknown;
    parallelMode?: unknown;
    stopAfterSlice?: boolean;
    ignoreSpawnGuardRateLimit?: boolean;
    scope?: SliceScope;
  }): Promise<AutoContinueRun> {
    const now = new Date().toISOString();
    const existing = autoContinueRuns.get(input.initiativeId) ?? null;
    const existingIsLive =
      existing?.status === "running" || existing?.status === "stopping";

    const run: AutoContinueRun =
      existing ??
      ({
        initiativeId: input.initiativeId,
        agentId: input.agentId,
        agentName: input.agentName ?? null,
        includeVerification: false,
        allowedWorkstreamIds: null,
        stopAfterSlice: false,
        ignoreSpawnGuardRateLimit: false,
        maxParallelSlices: AUTO_CONTINUE_MAX_PARALLEL_DEFAULT,
        parallelMode: "iwmt",
        scope: "task" as SliceScope,
        tokenBudget: defaultAutoContinueTokenBudget(),
        tokensUsed: 0,
        status: "running",
        stopReason: null,
        stopRequested: false,
        startedAt: now,
        stoppedAt: null,
        updatedAt: now,
        lastError: null,
        lastTaskId: null,
        lastRunId: null,
        activeSliceRunIds: [],
        activeTaskIds: [],
        laneByWorkstreamId: {},
        blockedWorkstreamIds: [],
        activeTaskId: null,
        activeRunId: null,
        activeTaskTokenEstimate: null,
      } as AutoContinueRun);
    ensureRunInternals(run);

    run.agentId = input.agentId;
    run.agentName =
      typeof input.agentName === "string" && input.agentName.trim().length > 0
        ? input.agentName.trim()
        : null;
    run.includeVerification = input.includeVerification;
    run.allowedWorkstreamIds = input.allowedWorkstreamIds;
    run.maxParallelSlices = normalizeMaxParallelSlices(
      input.maxParallelSlices,
      run.maxParallelSlices || AUTO_CONTINUE_MAX_PARALLEL_DEFAULT
    );
    run.parallelMode = normalizeParallelMode(input.parallelMode ?? run.parallelMode);
    run.stopAfterSlice = Boolean(input.stopAfterSlice);
    run.ignoreSpawnGuardRateLimit = Boolean(input.ignoreSpawnGuardRateLimit);
    run.scope = input.scope ?? "task";
    const hasExplicitTokenBudgetInput =
      input.tokenBudget !== null &&
      input.tokenBudget !== undefined &&
      !(typeof input.tokenBudget === "string" && input.tokenBudget.trim().length === 0);
    if (hasExplicitTokenBudgetInput) {
      run.tokenBudget = normalizeTokenBudget(
        input.tokenBudget,
        defaultAutoContinueTokenBudget()
      );
    } else {
      // On fresh restarts, reset to current defaults instead of inheriting stale prior limits.
      // While a run is live, keep its active budget unless explicitly overridden.
      run.tokenBudget = existingIsLive
        ? normalizeTokenBudget(run.tokenBudget, defaultAutoContinueTokenBudget())
        : defaultAutoContinueTokenBudget();
    }
    run.status = "running";
    run.stopReason = null;
    run.stopRequested = false;
    run.stoppedAt = null;
    run.updatedAt = now;
    run.lastError = null;
    const forceFreshRun = Boolean(input.stopAfterSlice);
    if (!existingIsLive || forceFreshRun) {
      run.tokensUsed = 0;
      run.startedAt = now;
      run.lastTaskId = null;
      run.lastRunId = null;
      run.activeSliceRunIds = [];
      run.activeTaskIds = [];
      run.blockedWorkstreamIds = [];
      run.laneByWorkstreamId = {};
      run.activeTaskId = null;
      run.activeRunId = null;
      run.activeTaskTokenEstimate = null;
    }
    syncLegacyRunPointers(run);

    autoContinueRuns.set(input.initiativeId, run);

    void client
      .updateEntity("initiative", input.initiativeId, { status: "active" })
      .catch(() => {
        // best effort
      });

    void updateInitiativeAutoContinueState({
      initiativeId: input.initiativeId,
      run,
    }).catch(() => {
      // best effort
    });

    if (!existingIsLive || forceFreshRun) {
      const startRunContext: AutoContinueRunContext = {
        initiativeId: run.initiativeId,
        agentId: run.agentId,
        agentName: run.agentName,
        scope: run.scope,
      };
      try {
        await emitActivitySafe({
          initiativeId: input.initiativeId,
          runId: run.lastRunId ?? undefined,
          correlationId: run.lastRunId ?? undefined,
          phase: "intent",
          level: "info",
          message: "Autopilot enabled. Dispatch will continue from Next Up automatically.",
          metadata: {
            ...buildSliceEnrichment({
              run: startRunContext,
              event: "auto_continue_started",
            }),
            token_budget: run.tokenBudget,
            include_verification: run.includeVerification,
            allowed_workstream_ids: run.allowedWorkstreamIds,
            max_parallel_slices: run.maxParallelSlices,
            parallel_mode: run.parallelMode,
            scope: run.scope,
            ignore_spawn_guard_rate_limit: run.ignoreSpawnGuardRateLimit,
          },
          nextStep: "Watch Activity for dispatch and slice-complete updates.",
        });
      } catch {
        // best effort
      }

      // Emit transition: idle → running
      try {
        await emitActivitySafe({
          initiativeId: input.initiativeId,
          runId: run.lastRunId ?? undefined,
          correlationId: run.lastRunId ?? undefined,
          phase: "intent",
          level: "info",
          message: "Autopilot state: idle → running.",
          metadata: {
            ...buildSliceEnrichment({
              run: startRunContext,
              event: "autopilot_transition",
              actionType: "run_state_transition",
            }),
            old_state: "idle",
            new_state: "running",
            reason: "started",
            workspace_id: run.allowedWorkstreamIds?.[0] ?? null,
          },
        });
      } catch {
        // best effort
      }
    }

    return run;
  }

  return {
    autoContinueRuns,
    autoContinueSliceRuns,
    localInitiativeStatusOverrides,
    writeRuntimeEvent,
    autoContinueTickMs: AUTO_CONTINUE_TICK_MS,
    defaultAutoContinueTokenBudget,
    defaultAutoContinueMaxParallelSlices,
    setLocalInitiativeStatusOverride,
    clearLocalInitiativeStatusOverride,
    applyLocalInitiativeOverrides,
    applyLocalInitiativeOverrideToGraph,
    updateInitiativeAutoContinueState,
    stopAutoContinueRun,
    tickAutoContinueRun,
    tickAllAutoContinue,
    isInitiativeActiveStatus,
    runningAutoContinueForWorkstream,
    getAutoContinueLaneForWorkstream,
    scheduleAutoFixForWorkstream,
    startAutoContinueRun,
  };
}
