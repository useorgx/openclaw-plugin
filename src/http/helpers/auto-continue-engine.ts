import type { ChildProcess } from "node:child_process";
import { randomUUID as randomUuidFn } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { OrgXClient } from "../../api.js";
import type { Entity } from "../../types.js";
import { upsertAgentContext } from "../../agent-context-store.js";
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
  deriveExecutionPolicy,
  isDispatchableWorkstreamStatus,
  isDoneStatus,
  isTodoStatus,
  readBudgetEnvNumber,
  spawnGuardIsRateLimited,
  summarizeSpawnGuardBlockReason,
  type MissionControlNode,
} from "./mission-control.js";
import { createAutopilotRuntime } from "./autopilot-runtime.js";
import {
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
    options?: string[];
    blocking?: boolean;
  }) => Promise<boolean>;
  registerArtifactSafe: (input: {
    initiativeId: string;
    runId: string;
    agentId: string;
    agentName?: string | null;
    workstreamId: string;
    artifact: {
      name: string;
      artifact_type?: string | null;
      description?: string | null;
      url?: string | null;
      milestone_id?: string | null;
      task_ids?: string[] | null;
    };
  }) => Promise<{ ok: boolean; id: string | null }>;
  applyAgentStatusUpdatesSafe: (input: {
    initiativeId: string;
    runId: string;
    correlationId: string;
    taskUpdates: Array<{ task_id: string; status: string; reason?: string | null }>;
    milestoneUpdates: Array<{ milestone_id: string; status: string; reason?: string | null }>;
  }) => Promise<{ applied: number; buffered: boolean }>;
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
  const __filename = deps.filename;
  type AutoContinueStopReason =
    | "budget_exhausted"
    | "blocked"
    | "completed"
    | "stopped"
    | "error";

  type AutoContinueStatus = "running" | "stopping" | "stopped";

		  type AutoContinueRun = {
		    initiativeId: string;
		    agentId: string;
		    agentName: string | null;
		    includeVerification: boolean;
	    allowedWorkstreamIds: string[] | null;
	    // When true, stop the run after the next slice completes (used for one-shot "Play").
	    stopAfterSlice: boolean;
	    tokenBudget: number;
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
    activeTaskId: string | null;
    activeRunId: string | null;
    activeTaskTokenEstimate: number | null;
  };

  const autoContinueRuns = new Map<string, AutoContinueRun>();
  const localInitiativeStatusOverrides = new Map<
    string,
    { status: string; updatedAt: string }
  >();
  let autoContinueTickInFlight: Promise<void> | null = null;
  const AUTO_CONTINUE_TICK_MS = readBudgetEnvNumber("ORGX_AUTO_CONTINUE_TICK_MS", 2_500, {
    min: 250,
    max: 60_000,
  });

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
  type AutoContinueSliceArtifact = {
    name: string;
    artifact_type?: string | null;
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
    lastError: string | null;
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
  const AUTO_CONTINUE_SLICE_MAX_TASKS = 6;
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

  function normalizeTokenBudget(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(1_000, Math.round(value));
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return Math.max(1_000, Math.round(parsed));
      }
    }
    return Math.max(1_000, Math.round(fallback));
  }

  function defaultAutoContinueTokenBudget(): number {
    const hours = readBudgetEnvNumber("ORGX_AUTO_CONTINUE_BUDGET_HOURS", 4, {
      min: 0.05,
      max: 24,
    });
    const fallback =
      DEFAULT_TOKEN_BUDGET_ASSUMPTIONS.tokensPerHour *
      hours *
      DEFAULT_TOKEN_BUDGET_ASSUMPTIONS.contingencyMultiplier;
    return normalizeTokenBudget(
      process.env.ORGX_AUTO_CONTINUE_TOKEN_BUDGET,
      fallback
    );
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
  // Autopilot v2 dispatches workstream slices via codex and does not rely on OpenClaw session JSONL.

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
    const now = new Date().toISOString();
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
      auto_continue_active_task_token_estimate: input.run.activeTaskTokenEstimate,
      auto_continue_last_task_id: input.run.lastTaskId,
      auto_continue_last_run_id: input.run.lastRunId,
      auto_continue_include_verification: input.run.includeVerification,
      auto_continue_workstream_filter: input.run.allowedWorkstreamIds,
      ...(input.run.lastError ? { auto_continue_last_error: input.run.lastError } : {}),
    };
    await updateInitiativeMetadata(input.initiativeId, patch);
  }

  async function stopAutoContinueRun(input: {
    run: AutoContinueRun;
    reason: AutoContinueStopReason;
    error?: string | null;
    decisionRequired?: boolean;
  }): Promise<void> {
    const now = new Date().toISOString();
    const activeRunId = input.run.activeRunId;
    input.run.status = "stopped";
    input.run.stopReason = input.reason;
    input.run.stoppedAt = now;
    input.run.updatedAt = now;
    input.run.stopRequested = false;
    input.run.activeRunId = null;
    input.run.activeTaskId = null;
    input.run.activeTaskTokenEstimate = null;
    if (input.error) input.run.lastError = input.error;
    clearSpawnGuardRetryStateForInitiative(input.run.initiativeId);
    clearAutoContinueSliceTransientState(activeRunId);

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

    const scopedWorkstreamId =
      Array.isArray(input.run.allowedWorkstreamIds) && input.run.allowedWorkstreamIds.length === 1
        ? input.run.allowedWorkstreamIds[0]
        : null;
    const scopeSuffix = scopedWorkstreamId ? ` [workstream ${scopedWorkstreamId}]` : "";
    const decisionRequired = input.reason === "blocked" && input.decisionRequired === true;
    const message =
      input.reason === "completed"
        ? `Autopilot stopped: current dispatch scope completed${scopeSuffix}.`
        : input.reason === "budget_exhausted"
          ? `Autopilot stopped: token budget exhausted (${input.run.tokensUsed}/${input.run.tokenBudget}).`
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

    await emitActivitySafe({
      initiativeId: input.run.initiativeId,
      runId: activeRunId ?? input.run.lastRunId ?? undefined,
      correlationId: activeRunId ?? input.run.lastRunId ?? undefined,
      phase,
      level,
      message,
      metadata: {
        event: "auto_continue_stopped",
        stop_reason: input.reason,
        requested_by_agent_id: input.run.agentId,
        requested_by_agent_name: input.run.agentName,
        active_run_id: activeRunId,
        last_run_id: input.run.lastRunId,
        token_budget: input.run.tokenBudget,
        tokens_used: input.run.tokensUsed,
        allowed_workstream_ids: input.run.allowedWorkstreamIds,
        scope_workstream_id: scopedWorkstreamId,
        decision_required: decisionRequired,
        last_error: input.run.lastError,
      },
    });
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

    // 1) If we have an active slice, wait for it to finish and then register outcomes.
    if (run.activeRunId) {
      const slice = autoContinueSliceRuns.get(run.activeRunId) ?? null;
      if (!slice) {
        // Legacy/unknown pointer; clear so we can continue.
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
		                  workstream_id: slice.workstreamId,
	                    workstream_title: slice.workstreamTitle ?? null,
	                    task_ids: slice.taskIds,
	                    milestone_ids: slice.milestoneIds,
	                    log_path: slice.logPath,
	                    output_path: slice.outputPath,
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
	          // Treat stdout/output freshness as progress; stderr noise should not prevent stall detection.
	          const stallUpdatedAtEpochMs = outputUpdatedAtEpochMs;

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
	                message: `Autopilot slice MCP failed: ${slice.workstreamTitle ?? slice.workstreamId}.`,
		                metadata: {
		                  event: "autopilot_slice_mcp_handshake_failed",
		                  requested_by_agent_id: run.agentId,
		                  requested_by_agent_name: run.agentName,
		                  mcp_server: mcpHandshake.server,
		                  mcp_line: mcpHandshake.line,
	                  workstream_id: slice.workstreamId,
	                  task_ids: slice.taskIds,
	                  milestone_ids: slice.milestoneIds,
	                  log_path: slice.logPath,
	                  output_path: slice.outputPath,
	                },
	              });

	              const decisionQueued = await requestDecisionSafe({
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
	              });

	              await stopAutoContinueRun({
	                run,
	                reason: "blocked",
	                error: slice.lastError,
                  decisionRequired: decisionQueued,
	              });
	              return;
	            }

	          const killDecision = shouldKillWorker(
	            {
	              nowEpochMs: nowMs,
	              startedAtEpochMs: fallbackEpochMs,
	              logUpdatedAtEpochMs: stallUpdatedAtEpochMs,
	            },
	            { timeoutMs: AUTO_CONTINUE_SLICE_TIMEOUT_MS, stallMs: AUTO_CONTINUE_SLICE_LOG_STALL_MS }
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
	                  ? `Autopilot slice timed out after ${Math.round(AUTO_CONTINUE_SLICE_TIMEOUT_MS / 60_000)} minutes.`
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
	                message: `Autopilot slice ${humanLabel}: ${slice.workstreamTitle ?? slice.workstreamId}.`,
		                metadata: {
		                  event,
		                  requested_by_agent_id: run.agentId,
		                  requested_by_agent_name: run.agentName,
		                  workstream_id: slice.workstreamId,
		                  task_ids: slice.taskIds,
	                  milestone_ids: slice.milestoneIds,
	                  log_path: slice.logPath,
	                  output_path: slice.outputPath,
	                  reason: killDecision.reason,
	                  elapsed_ms: killDecision.elapsedMs,
	                  idle_ms: killDecision.idleMs,
	                },
	              });

	              const decisionQueued = await requestDecisionSafe({
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
	              });

	              await stopAutoContinueRun({
	                run,
	                reason: "blocked",
	                error: slice.lastError,
                  decisionRequired: decisionQueued,
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

	            if (!outputComplete) return;
	          }
	        }

	        // Slice finished.
	        const raw = readSliceOutputFile(slice.outputPath);
        const parsed = raw ? parseSliceResult<AutoContinueSliceResult>(raw) : null;
        const parsedStatus = parsed?.status ?? "error";
        const defaultDecisionBlocking = parsedStatus === "completed" ? false : true;

        const decisions = Array.isArray(parsed?.decisions_needed)
          ? (parsed?.decisions_needed ?? [])
              .filter(
                (item: AutoContinueSliceDecision): item is AutoContinueSliceDecision =>
                  Boolean(item && typeof item.question === "string" && item.question.trim())
              )
          : [];
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
        const modeledTokens = slice.tokenEstimate ?? run.activeTaskTokenEstimate ?? 0;
        run.tokensUsed += Math.max(0, modeledTokens);
        run.activeTaskTokenEstimate = null;

        const artifacts = Array.isArray(parsed?.artifacts)
          ? (parsed?.artifacts ?? [])
              .filter(
                (item: AutoContinueSliceArtifact): item is AutoContinueSliceArtifact =>
                  Boolean(item && typeof item.name === "string" && item.name.trim())
              )
          : [];

        const taskUpdates = Array.isArray((parsed as any)?.task_updates)
          ? ((parsed as any).task_updates as Array<{ task_id: string; status: string; reason?: string | null }>)
          : [];
        const milestoneUpdates = Array.isArray((parsed as any)?.milestone_updates)
          ? ((parsed as any).milestone_updates as Array<{ milestone_id: string; status: string; reason?: string | null }>)
          : [];

        let blockingDecisionQueued = false;
        for (const decision of decisions) {
          const isBlocking =
            typeof decision.blocking === "boolean" ? decision.blocking : defaultDecisionBlocking;
          const decisionQueued = await requestDecisionSafe({
            initiativeId: run.initiativeId,
            correlationId: slice.runId,
            title: decision.question.trim(),
            summary: decision.summary ?? parsed?.summary ?? null,
            urgency: decision.urgency ?? "high",
            options: Array.isArray(decision.options)
              ? decision.options.filter((opt: string) => typeof opt === "string" && opt.trim())
              : [],
            blocking: isBlocking,
          });
          if (decisionQueued && isBlocking) blockingDecisionQueued = true;
        }

        for (const artifact of artifacts) {
          await registerArtifactSafe({
            initiativeId: run.initiativeId,
            runId: slice.runId,
            agentId: slice.agentId,
            agentName: slice.agentName,
            workstreamId: slice.workstreamId,
            artifact,
          });
        }

        const statusUpdateResult = await applyAgentStatusUpdatesSafe({
          initiativeId: run.initiativeId,
          runId: slice.runId,
          correlationId: slice.runId,
          taskUpdates,
          milestoneUpdates,
        });

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
            message: parsed?.summary ?? slice.lastError ?? "Autopilot slice finished.",
	              metadata: {
	                event: "autopilot_slice_finished",
	                requested_by_agent_id: run.agentId,
	                requested_by_agent_name: run.agentName,
	                status: effectiveParsedStatus,
	                artifacts: artifacts.length,
              decisions: decisions.length,
              blocking_decisions: blockingDecisionCount,
              non_blocking_decisions: nonBlockingDecisionCount,
              status_updates: statusUpdateResult.applied,
              status_updates_buffered: statusUpdateResult.buffered,
            },
          });
        } catch {
          // best effort
        }

	        await emitActivitySafe({
	          initiativeId: run.initiativeId,
	          runId: slice.runId,
	          correlationId: slice.runId,
	          phase: slice.status === "completed" ? "completed" : "blocked",
	          level: slice.status === "completed" ? "info" : "warn",
	          message:
	            slice.status === "completed"
	              ? `Autopilot slice completed for ${slice.workstreamTitle ?? slice.workstreamId} (${slice.taskIds.length} task${slice.taskIds.length === 1 ? "" : "s"}).`
	              : `Autopilot slice blocked: ${slice.workstreamTitle ?? slice.workstreamId}.`,
	          metadata: {
	            event: "autopilot_slice_result",
	            requested_by_agent_id: run.agentId,
	            requested_by_agent_name: run.agentName,
	            agent_id: slice.agentId,
	            agent_name: slice.agentName,
	            domain: slice.domain,
	            required_skills: slice.requiredSkills,
            workstream_id: slice.workstreamId,
            task_ids: slice.taskIds,
            milestone_ids: slice.milestoneIds,
            parsed_status: effectiveParsedStatus,
            has_output: Boolean(parsed),
            artifacts: artifacts.length,
            decisions: decisions.length,
            blocking_decisions: blockingDecisionCount,
            non_blocking_decisions: nonBlockingDecisionCount,
            decision_required: blockingDecisionQueued,
            status_updates_applied: statusUpdateResult.applied,
            status_updates_buffered: statusUpdateResult.buffered,
            output_path: slice.outputPath,
            log_path: slice.logPath,
            error: slice.lastError,
          },
	        });

	        if (slice.status !== "completed") {
          let fallbackDecisionQueued = false;
	          if (slice.status === "error" && decisions.length === 0) {
	            fallbackDecisionQueued = await requestDecisionSafe({
	              initiativeId: run.initiativeId,
	              correlationId: slice.runId,
	              title: `Autopilot slice failed: ${slice.workstreamTitle ?? slice.workstreamId}`,
	              summary:
	                parsed?.summary ??
	                slice.lastError ??
	                "The slice failed without producing a valid output contract. Review logs/output and decide whether to retry or pause autopilot.",
	              urgency: "high",
	              options: [
	                "Retry this workstream slice",
	                "Pause autopilot and investigate",
	                "Skip this workstream for now",
	              ],
	              blocking: true,
	            });
	          }

	          await stopAutoContinueRun({
	            run,
	            reason: slice.status === "error" ? "error" : "blocked",
	            error:
	              parsed?.summary ??
              slice.lastError ??
              `Slice returned status: ${effectiveParsedStatus}`,
              decisionRequired: blockingDecisionQueued || fallbackDecisionQueued,
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

          const decisionQueued = await requestDecisionSafe({
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
          });

          await stopAutoContinueRun({
            run,
            reason: completionHadNoOutcome ? "blocked" : "error",
            error:
              slice.lastError ??
              (completionHadNoOutcome
                ? "Slice completed without verifiable outcomes."
                : "Slice failed or returned invalid output."),
            decisionRequired: completionHadNoOutcome && decisionQueued,
          });
          return;
        }

        run.lastRunId = slice.runId;
        run.lastTaskId = run.activeTaskId ?? run.lastTaskId;
        run.activeRunId = null;
        run.activeTaskId = null;
        run.updatedAt = now;

	        try {
	          await updateInitiativeAutoContinueState({
	            initiativeId: run.initiativeId,
	            run,
	          });
	        } catch {
	          // best effort
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

    if (run.stopRequested) {
      run.status = "stopping";
      run.updatedAt = now;
      await stopAutoContinueRun({ run, reason: "stopped" });
      return;
    }

    // 2) Enforce token guardrail before starting a new slice.
    if (run.tokensUsed >= run.tokenBudget) {
      await stopAutoContinueRun({ run, reason: "budget_exhausted" });
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
      if (deferredBySpawnGuardRateLimit > 0) {
        run.updatedAt = now;
        return;
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

    const sliceTaskNodes = graph.recentTodos
      .map((taskId) => nodeById.get(taskId))
      .filter(
        (node): node is MissionControlNode =>
          Boolean(
            node &&
              node.type === "task" &&
              node.workstreamId === selectedWorkstreamId &&
              isTodoStatus(node.status) &&
              taskIsReady(node) &&
              !taskHasBlockedParent(node) &&
              (run.includeVerification ||
                !/^verification[ \t]+scenario/i.test(String(node.title ?? "")))
          )
      )
      .slice(0, AUTO_CONTINUE_SLICE_MAX_TASKS);

    const primaryTask = sliceTaskNodes[0] ?? null;
    if (!primaryTask) {
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
    const remainingTokens = run.tokenBudget - run.tokensUsed;
    if (remainingTokens <= 0) {
      await stopAutoContinueRun({ run, reason: "budget_exhausted" });
      return;
    }

    // If the modeled slice exceeds the remaining budget, shrink the slice to fit rather than
    // stopping immediately (Play should still dispatch at least the primary task when possible).
    if (tokenEstimate > 0 && tokenEstimate > remainingTokens) {
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

    if (tokenEstimate > 0 && tokenEstimate > remainingTokens) {
      await stopAutoContinueRun({ run, reason: "budget_exhausted" });
      return;
    }

    const executionPolicy = deriveExecutionPolicy(primaryTask, workstreamNode);
    const sliceRunId = randomUUID();

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
        if (retryable) {
          const retryAtMs = Date.now() + AUTO_CONTINUE_SPAWN_GUARD_RETRY_MS;
          autoContinueSpawnGuardRetryByTask.set(primaryTask.id, {
            initiativeId: run.initiativeId,
            retryAtMs,
          });
          await emitActivitySafe({
            initiativeId: run.initiativeId,
            runId: sliceRunId,
            correlationId: sliceRunId,
            phase: "blocked",
            level: "warn",
            message: `Autopilot spawn guard rate-limited ${workstreamTitle ?? selectedWorkstreamId}; retrying shortly.`,
            metadata: {
              event: "auto_continue_spawn_guard_rate_limited",
              task_id: primaryTask.id,
              workstream_id: selectedWorkstreamId,
              blocked_reason: blockedReason,
              next_retry_at: new Date(retryAtMs).toISOString(),
              next_retry_in_ms: AUTO_CONTINUE_SPAWN_GUARD_RETRY_MS,
              spawn_guard: spawnGuardResult,
            },
            nextStep: "Retry dispatch when spawn rate limits recover.",
          });
          run.lastError = blockedReason;
          run.updatedAt = now;
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
	          message: `Autopilot blocked by spawn guard for ${workstreamTitle ?? selectedWorkstreamId}.`,
	          metadata: {
	            event: "auto_continue_spawn_guard_blocked",
            task_id: primaryTask.id,
            workstream_id: selectedWorkstreamId,
            blocked_reason: blockedReason,
            spawn_guard: spawnGuardResult,
          },
        });
        const decisionQueued = await requestDecisionSafe({
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
        });
        await stopAutoContinueRun({
          run,
          reason: "blocked",
          error: blockedReason,
          decisionRequired: decisionQueued,
        });
        return;
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
    const prompt = buildWorkstreamSlicePrompt({
      initiativeTitle,
      initiativeId: run.initiativeId,
      workstreamId: selectedWorkstreamId,
      workstreamTitle: workstreamTitle ?? `Workstream ${selectedWorkstreamId.slice(0, 8)}`,
      milestoneSummaries,
      taskSummaries,
      executionPolicy,
      runId: sliceRunId,
      schemaPath,
    });

    const logsDir = join(getOrgxPluginConfigDir(), AUTO_CONTINUE_SLICE_LOG_DIRNAME);
    const logPath = join(logsDir, `${sliceRunId}.log`);
    const outputPath = join(logsDir, `${sliceRunId}.output.json`);

    let workerCwd = (process.env.ORGX_AUTOPILOT_CWD ?? "").trim() || process.cwd();
    // LaunchAgents often start with cwd="/". Prefer a stable, user-owned directory
    // so relative paths and codex sandboxing behave consistently.
    if (!workerCwd || workerCwd === "/") {
      workerCwd = homedir();
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
	          env: {
	            ORGX_SOURCE_CLIENT: executorSourceClient,
	            ORGX_RUN_ID: sliceRunId,
	            ORGX_CORRELATION_ID: sliceRunId,
	            ORGX_INITIATIVE_ID: run.initiativeId,
	            ORGX_WORKSTREAM_ID: selectedWorkstreamId,
	            ORGX_WORKSTREAM_TITLE: workstreamTitle ?? undefined,
	            ORGX_TASK_ID: primaryTask.id,
	            ORGX_AGENT_ID: sliceAgent.id,
	            ORGX_AGENT_NAME: sliceAgent.name,
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
      lastError: null,
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
		          requested_by_agent_id: run.agentId,
		          requested_by_agent_name: run.agentName,
		          domain: executionPolicy.domain,
	          required_skills: executionPolicy.requiredSkills,
          task_ids: slice.taskIds,
          initiative_title: initiativeTitle ?? null,
          workstream_title: workstreamTitle ?? null,
          log_path: logPath,
          output_path: outputPath,
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
	      phase: "execution",
	      level: "info",
	      message: `Autopilot dispatched slice for ${workstreamTitle ?? selectedWorkstreamId}.`,
	      metadata: {
	        event: "autopilot_slice_dispatched",
	        requested_by_agent_id: run.agentId,
	        requested_by_agent_name: run.agentName,
	        agent_id: slice.agentId,
	        agent_name: sliceAgent.name,
	        domain: executionPolicy.domain,
	        required_skills: executionPolicy.requiredSkills,
	        initiative_title: initiativeTitle ?? null,
	        workstream_id: selectedWorkstreamId,
        workstream_title: workstreamTitle ?? null,
        task_ids: slice.taskIds,
        milestone_ids: milestoneIds,
        log_path: logPath,
        output_path: outputPath,
      },
    });

    upsertAgentContext({
      agentId: slice.agentId,
      initiativeId: run.initiativeId,
      initiativeTitle: initiativeTitle ?? null,
      workstreamId: selectedWorkstreamId,
      taskId: primaryTask.id,
    });

    run.lastTaskId = primaryTask.id;
    run.lastRunId = sliceRunId;
    run.activeTaskId = primaryTask.id;
    run.activeRunId = sliceRunId;
    run.activeTaskTokenEstimate = tokenEstimate > 0 ? tokenEstimate : null;
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
          run.lastError = safeErrorMessage(err);
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
    if (run.status !== "running" && run.status !== "stopping") return null;
    if (!Array.isArray(run.allowedWorkstreamIds) || run.allowedWorkstreamIds.length === 0) {
      return run;
    }
    return run.allowedWorkstreamIds.includes(workstreamId) ? run : null;
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
          event: "autopilot_autofix_skipped",
          reason,
          initiative_id: initiativeId,
          workstream_id: workstreamId,
          requested_by_agent_id: requestedByAgentId,
          requested_by_agent_name: requestedByAgentName,
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
        existingRun.activeRunId
      ) {
        await emitSkip("already_running", {
          active_run_id: existingRun.activeRunId,
          run_status: existingRun.status,
        });
        return;
      }

      let optionalDecisionsApproved = 0;
      try {
        const decisionResult = await client.listEntities("decision", {
          initiative_id: initiativeId,
          status: "pending",
          limit: 500,
        });
        const decisionRows = Array.isArray(decisionResult?.data) ? decisionResult.data : [];
        const resolvedAt = new Date().toISOString();
        for (const row of decisionRows) {
          if (!row || typeof row !== "object") continue;
          const record = row as Record<string, unknown>;
          const decisionId = pickString(record, ["id"])?.trim() ?? "";
          if (!decisionId) continue;
          if (!isPendingDecisionStatus(record.status ?? record.decision_status)) continue;
          if (!decisionMatchesWorkstream(record, workstreamId, runId)) continue;
          if (decisionIsBlocking(record)) continue;
          await client.updateEntity("decision", decisionId, {
            status: "approved",
            resolution: "approved",
            resolved_at: resolvedAt,
            decided_at: resolvedAt,
            note:
              "Auto-approved by OrgX auto-fix (non-blocking follow-up decision).",
          });
          optionalDecisionsApproved += 1;
        }
      } catch {
        // best effort
      }

      let resetTaskCount = 0;
      try {
        const taskResult = await client.listEntities("task", {
          initiative_id: initiativeId,
          workstream_id: workstreamId,
          limit: 1000,
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
        tokenBudget: latestRun?.tokenBudget ?? defaultAutoContinueTokenBudget(),
        includeVerification: latestRun?.includeVerification ?? false,
        allowedWorkstreamIds: [workstreamId],
        stopAfterSlice: true,
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
          event: "autopilot_autofix_executed",
          initiative_id: initiativeId,
          workstream_id: workstreamId,
          requested_by_agent_id: requestedByAgentId,
          requested_by_agent_name: requestedByAgentName,
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
        event: "autopilot_autofix_scheduled",
        initiative_id: initiativeId,
        workstream_id: workstreamId,
        requested_by_agent_id: requestedByAgentId,
        requested_by_agent_name: requestedByAgentName,
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
	    stopAfterSlice?: boolean;
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
        activeTaskId: null,
        activeRunId: null,
        activeTaskTokenEstimate: null,
      } as AutoContinueRun);

		    run.agentId = input.agentId;
		    run.agentName =
		      typeof input.agentName === "string" && input.agentName.trim().length > 0
		        ? input.agentName.trim()
		        : null;
	    run.includeVerification = input.includeVerification;
	    run.allowedWorkstreamIds = input.allowedWorkstreamIds;
	    run.stopAfterSlice = Boolean(input.stopAfterSlice);
	    run.tokenBudget = normalizeTokenBudget(
	      input.tokenBudget,
	      run.tokenBudget || defaultAutoContinueTokenBudget()
	    );
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
      run.activeTaskId = null;
      run.activeRunId = null;
      run.activeTaskTokenEstimate = null;
    }

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

    return run;
  }

  return {
    autoContinueRuns,
    autoContinueSliceRuns,
    localInitiativeStatusOverrides,
    writeRuntimeEvent,
    autoContinueTickMs: AUTO_CONTINUE_TICK_MS,
    defaultAutoContinueTokenBudget,
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
    scheduleAutoFixForWorkstream,
    startAutoContinueRun,
  };
}
