import type { ChildProcess } from "node:child_process";
import { randomUUID as randomUuidFn } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

import type { OrgXClient } from "../../api.js";
import type { Entity } from "../../types.js";
import {
  normalizeActivityActionPhase,
  normalizeActivityActionType,
  normalizeDecisionActionType,
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
import { resolveCapacityRuntime } from "../../runtime-capacity-routing.js";
import { humanizeSliceFailure, humanizeSliceFailureSummary } from "./humanize-slice-failure.js";
import { getOrgxPluginConfigDir } from "../../paths.js";
import {
  buildMissionControlGraph,
  DEFAULT_TOKEN_BUDGET_ASSUMPTIONS,
  dedupeStrings,
  detectBehaviorConfigDrift,
  deriveBehaviorAutomationLevel,
  deriveBehaviorConfigContext,
  deriveInitiativeLifecycleStatus,
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
  extractSessionIdFromLog,
  extractSessionIdFromOutput,
  fileUpdatedAtEpochMs,
  parseSliceResult,
  readFileTailSafe,
  readSliceOutputFile,
  type CodexBinInfo,
} from "./autopilot-slice-utils.js";
import { pickString } from "./value-utils.js";
import {
  LaneState,
  RunStatus,
} from "./queue-constants.js";
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

function getMachineId(): string {
  try {
    return hostname();
  } catch {
    return "unknown";
  }
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

function captureAutopilotWorkerEnv(): Record<string, string | undefined> {
  return {
    ORGX_AUTOPILOT_CWD: (process.env.ORGX_AUTOPILOT_CWD ?? "").trim() || undefined,
    ORGX_AUTOPILOT_EXECUTOR: (process.env.ORGX_AUTOPILOT_EXECUTOR ?? "").trim() || undefined,
    ORGX_AUTOPILOT_WORKER_KIND:
      (process.env.ORGX_AUTOPILOT_WORKER_KIND ?? "").trim() || undefined,
    ORGX_AUTOPILOT_MOCK_SCENARIO:
      (process.env.ORGX_AUTOPILOT_MOCK_SCENARIO ?? "").trim() || undefined,
    ORGX_AUTOPILOT_MOCK_SLEEP_MS:
      (process.env.ORGX_AUTOPILOT_MOCK_SLEEP_MS ?? "").trim() || undefined,
    ORGX_AUTOPILOT_SESSION_RESUME:
      (process.env.ORGX_AUTOPILOT_SESSION_RESUME ?? "").trim() || undefined,
  };
}

export function createAutoContinueEngine(deps: CreateAutoContinueEngineDeps) {
  const defaultWorkerEnvOverrides = captureAutopilotWorkerEnv();
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
  const queryDispatchPreflightFn =
    typeof deps.client.queryDispatchPreflight === "function"
      ? deps.client.queryDispatchPreflight.bind(deps.client)
      : null;
  const createAgentJobFn =
    typeof deps.client.createAgentJob === "function"
      ? deps.client.createAgentJob.bind(deps.client)
      : null;
  const updateAgentJobFn =
    typeof deps.client.updateAgentJob === "function"
      ? deps.client.updateAgentJob.bind(deps.client)
      : null;
  const decisionAutoResolveGuardedEnabled =
    String(process.env.DECISION_AUTO_RESOLVE_GUARDED_ENABLED ?? "true")
      .trim()
      .toLowerCase() !== "false";
  type QuestionAutoAnswerAction = "approve" | "reject";
  type QuestionAutoAnswerPolicyMode =
    | "contextual"
    | "approve_non_blocking"
    | "defer_non_blocking";
  type QuestionBlockingBehavior =
    | "require_human"
    | "guarded_auto_resolve_then_human";
  type QuestionAutoAnswerPolicy = {
    enabled: boolean;
    timeoutSeconds: number;
    mode: QuestionAutoAnswerPolicyMode;
    action: QuestionAutoAnswerAction;
    blockingBehavior: QuestionBlockingBehavior;
    policyVersion: number;
  };
  type PendingQuestionAutoAnswer = {
    key: string;
    initiativeId: string;
    workstreamId: string | null;
    sourceRunId: string | null;
    sourceClient: RuntimeSourceClient;
    action: QuestionAutoAnswerAction;
    mode: QuestionAutoAnswerPolicyMode;
    policyVersion: number;
    timeoutSeconds: number;
    dueAt: string;
    timer: NodeJS.Timeout | null;
    decisionIds: string[];
    eventMetadata?: Record<string, unknown> | null;
  };
  const questionAutoAnswerPolicyByScope = new Map<string, QuestionAutoAnswerPolicy>();
  const pendingQuestionAutoAnswerByScope = new Map<string, PendingQuestionAutoAnswer>();

  const QUESTION_AUTO_ANSWER_DEFAULT_TIMEOUT_SECONDS = readBudgetEnvNumber(
    "ORGX_QUESTION_AUTO_ANSWER_TIMEOUT_SEC",
    readBudgetEnvNumber("ORGX_QUESTION_AUTO_ANSWER_DELAY_SECONDS", 60, {
      min: 1,
      max: 900,
    }),
    { min: 1, max: 3600 }
  );
  const QUESTION_AUTO_ANSWER_DEFAULT_ENABLED =
    String(process.env.ORGX_QUESTION_AUTO_ANSWER_ENABLED ?? "true")
      .trim()
      .toLowerCase() !== "false";
  const QUESTION_AUTO_ANSWER_DEFAULT_MODE: QuestionAutoAnswerPolicyMode =
    String(process.env.ORGX_QUESTION_AUTO_ANSWER_POLICY ?? "contextual")
      .trim()
      .toLowerCase() === "approve_non_blocking"
      ? "approve_non_blocking"
      : String(process.env.ORGX_QUESTION_AUTO_ANSWER_POLICY ?? "contextual")
            .trim()
            .toLowerCase() === "defer_non_blocking"
        ? "defer_non_blocking"
        : "contextual";
  const QUESTION_BLOCKING_BEHAVIOR_DEFAULT: QuestionBlockingBehavior =
    String(process.env.ORGX_QUESTION_BLOCKING_BEHAVIOR ?? "require_human")
      .trim()
      .toLowerCase() === "guarded_auto_resolve_then_human"
      ? "guarded_auto_resolve_then_human"
      : "require_human";
  const QUESTION_AUTO_ANSWER_DEFAULT_ACTION: QuestionAutoAnswerAction =
    String(process.env.ORGX_QUESTION_AUTO_ANSWER_ACTION ?? "approve")
      .trim()
      .toLowerCase() === "reject"
      ? "reject"
      : "approve";
  const autoContinueSliceRuns = new Map<string, AutoContinueSliceRun>();

  // ---------------------------------------------------------------------------
  // Session store – maps workstream IDs to CLI session IDs for resume support
  // ---------------------------------------------------------------------------
  type WorkstreamSessionEntry = {
    sessionId: string;
    workstreamId: string;
    initiativeId: string;
    sourceClient: RuntimeSourceClient;
    capturedAt: string;
    fromRunId: string;
  };
  const workstreamSessionStore = new Map<string, WorkstreamSessionEntry>();

  function sessionResumeEnabled(): boolean {
    const raw = (process.env.ORGX_AUTOPILOT_SESSION_RESUME ?? "").trim().toLowerCase();
    if (!raw) return false;
    return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
  }

  function setWorkstreamSession(workstreamId: string, entry: WorkstreamSessionEntry): void {
    workstreamSessionStore.set(workstreamId, entry);
  }
  function getWorkstreamSession(workstreamId: string): WorkstreamSessionEntry | null {
    return workstreamSessionStore.get(workstreamId) ?? null;
  }
  function clearWorkstreamSession(initiativeId: string): void {
    for (const [key, entry] of workstreamSessionStore.entries()) {
      if (entry.initiativeId === initiativeId) {
        workstreamSessionStore.delete(key);
      }
    }
  }

  function listWorkstreamSessions(initiativeId?: string): WorkstreamSessionEntry[] {
    const results: WorkstreamSessionEntry[] = [];
    for (const entry of workstreamSessionStore.values()) {
      if (!initiativeId || entry.initiativeId === initiativeId) {
        results.push(entry);
      }
    }
    return results;
  }

  /** Spread into any metadata object to flag mock-worker activity. */
  function mockMeta(slice: { isMockWorker: boolean }): Record<string, unknown> {
    return slice.isMockWorker ? { mock: true } : {};
  }
  function normalizeRuntimeSourceClient(value: unknown): RuntimeSourceClient {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!normalized) return "unknown";
    if (normalized === "codex") return "codex";
    if (normalized === "claude-code" || normalized === "claude_code") return "claude-code";
    if (normalized === "openclaw") return "openclaw";
    if (normalized === "api") return "api";
    return "unknown";
  }

  const normalizeQuestionAutoAnswerPolicy = (
    runtimeSettings: KickoffContext["runtime_settings"] | null | undefined
  ): QuestionAutoAnswerPolicy => {
    const workspaceDefaults =
      runtimeSettings?.workspace_question_defaults &&
      typeof runtimeSettings.workspace_question_defaults === "object"
        ? runtimeSettings.workspace_question_defaults
        : null;
    const enabledRaw = runtimeSettings?.question_auto_answer_enabled;
    const timeoutRaw =
      runtimeSettings?.question_auto_answer_timeout_sec ??
      runtimeSettings?.question_auto_answer_delay_seconds;
    const workspaceTimeoutRaw =
      workspaceDefaults?.question_auto_answer_timeout_sec ??
      (workspaceDefaults as { question_auto_answer_delay_seconds?: unknown } | null)
        ?.question_auto_answer_delay_seconds;
    const actionRaw = runtimeSettings?.question_auto_answer_action;
    const modeRaw = runtimeSettings?.question_auto_answer_policy;
    const workspaceModeRaw = workspaceDefaults?.question_auto_answer_policy;
    const blockingBehaviorRaw = runtimeSettings?.question_blocking_behavior;
    const workspaceBlockingBehaviorRaw = workspaceDefaults?.question_blocking_behavior;
    const policyVersionRaw = runtimeSettings?.question_policy_version;
    const timeoutSeconds =
      typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw)
        ? Math.max(1, Math.min(3600, Math.floor(timeoutRaw)))
        : typeof workspaceTimeoutRaw === "number" && Number.isFinite(workspaceTimeoutRaw)
          ? Math.max(1, Math.min(3600, Math.floor(workspaceTimeoutRaw)))
          : QUESTION_AUTO_ANSWER_DEFAULT_TIMEOUT_SECONDS;
    const mode: QuestionAutoAnswerPolicyMode =
      modeRaw === "approve_non_blocking" ||
      modeRaw === "defer_non_blocking" ||
      modeRaw === "contextual"
        ? modeRaw
        : workspaceModeRaw === "approve_non_blocking" ||
            workspaceModeRaw === "defer_non_blocking" ||
            workspaceModeRaw === "contextual"
          ? workspaceModeRaw
          : QUESTION_AUTO_ANSWER_DEFAULT_MODE;
    const action: QuestionAutoAnswerAction =
      actionRaw === "reject" || actionRaw === "approve"
        ? actionRaw
        : mode === "defer_non_blocking"
          ? "reject"
          : QUESTION_AUTO_ANSWER_DEFAULT_ACTION;
    const blockingBehavior: QuestionBlockingBehavior =
      blockingBehaviorRaw === "guarded_auto_resolve_then_human" ||
      blockingBehaviorRaw === "require_human"
        ? blockingBehaviorRaw
        : workspaceBlockingBehaviorRaw === "guarded_auto_resolve_then_human" ||
            workspaceBlockingBehaviorRaw === "require_human"
          ? workspaceBlockingBehaviorRaw
          : QUESTION_BLOCKING_BEHAVIOR_DEFAULT;
    const enabled =
      typeof enabledRaw === "boolean"
        ? enabledRaw
        : typeof workspaceDefaults?.question_auto_answer_enabled === "boolean"
          ? workspaceDefaults.question_auto_answer_enabled
        : QUESTION_AUTO_ANSWER_DEFAULT_ENABLED;
    const policyVersion =
      typeof policyVersionRaw === "number" && Number.isFinite(policyVersionRaw)
        ? Math.max(1, Math.min(10, Math.floor(policyVersionRaw)))
        : 1;
    return {
      enabled,
      timeoutSeconds,
      mode,
      action,
      blockingBehavior,
      policyVersion,
    };
  };

  const questionScopeKey = (
    initiativeId: string | null | undefined,
    workstreamId: string | null | undefined
  ): string => {
    const normalizedInitiativeId = (initiativeId ?? "").trim() || "unknown_initiative";
    const normalizedWorkstreamId = (workstreamId ?? "").trim() || "all_workstreams";
    return `${normalizedInitiativeId}::${normalizedWorkstreamId}`;
  };

  const resolveQuestionPolicy = (
    initiativeId: string | null | undefined,
    workstreamId: string | null | undefined
  ): QuestionAutoAnswerPolicy => {
    const scoped = questionAutoAnswerPolicyByScope.get(
      questionScopeKey(initiativeId, workstreamId)
    );
    if (scoped) return scoped;
    const initiativeWide = questionAutoAnswerPolicyByScope.get(
      questionScopeKey(initiativeId, null)
    );
    if (initiativeWide) return initiativeWide;
    return {
      enabled: QUESTION_AUTO_ANSWER_DEFAULT_ENABLED,
      timeoutSeconds: QUESTION_AUTO_ANSWER_DEFAULT_TIMEOUT_SECONDS,
      mode: QUESTION_AUTO_ANSWER_DEFAULT_MODE,
      action: QUESTION_AUTO_ANSWER_DEFAULT_ACTION,
      blockingBehavior: QUESTION_BLOCKING_BEHAVIOR_DEFAULT,
      policyVersion: 1,
    };
  };

  const clearQuestionAutoAnswerStateForInitiative = (
    initiativeId: string | null | undefined
  ): void => {
    const normalizedInitiativeId = (initiativeId ?? "").trim();
    if (!normalizedInitiativeId) return;
    for (const [key, pending] of pendingQuestionAutoAnswerByScope.entries()) {
      if ((pending.initiativeId ?? "").trim() !== normalizedInitiativeId) continue;
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pendingQuestionAutoAnswerByScope.delete(key);
    }
  };

  const hasPendingQuestionAutoAnswerStateForInitiative = (
    initiativeId: string | null | undefined
  ): boolean => {
    const normalizedInitiativeId = (initiativeId ?? "").trim();
    if (!normalizedInitiativeId) return false;
    for (const pending of pendingQuestionAutoAnswerByScope.values()) {
      if ((pending.initiativeId ?? "").trim() === normalizedInitiativeId) {
        return true;
      }
    }
    return false;
  };

  const processQuestionAutoAnswer = async (
    key: string,
    pending: PendingQuestionAutoAnswer
  ): Promise<void> => {
    pendingQuestionAutoAnswerByScope.delete(key);
    const note =
      pending.action === "approve"
        ? "Auto-approved after timeout: no human answer received within configured delay."
        : "Auto-rejected after timeout: no human answer received within configured delay.";
    const decisionIds = pending.decisionIds;
    if (decisionIds.length === 0) {
      return;
    }
    await emitActivitySafe({
      initiativeId: pending.initiativeId,
      runId: pending.sourceRunId,
      correlationId: pending.sourceRunId,
      phase: "review",
      level: "info",
      progressPct: 0,
      nextStep: "Applying question answer policy to unresolved items.",
      message: "Question auto-answered after timeout; applying decision updates.",
      metadata: {
        event: "question_auto_answered",
        action_type: normalizeActivityActionType("question_auto_answered"),
        action_phase: normalizeActivityActionPhase("review"),
        initiative_id: pending.initiativeId,
        workstream_id: pending.workstreamId,
        source_run_id: pending.sourceRunId,
        source_client: pending.sourceClient,
        decision_ids: decisionIds,
        decision_count: decisionIds.length,
        decision_action: pending.action,
        timeout_seconds_applied: pending.timeoutSeconds,
      },
    });
    let applied = 0;
    let failed = 0;
    const failures: Array<{ id: string; error: string }> = [];
    for (const decisionId of decisionIds) {
      try {
        await client.decideDecision(decisionId, pending.action, { note });
        applied += 1;
      } catch (err: unknown) {
        failed += 1;
        failures.push({
          id: decisionId,
          error: safeErrorMessage(err),
        });
      }
    }
    await emitActivitySafe({
      initiativeId: pending.initiativeId,
      runId: pending.sourceRunId,
      correlationId: pending.sourceRunId,
      phase: failed > 0 ? "blocked" : "review",
      level: failed > 0 ? "warn" : "info",
      progressPct: 100,
      nextStep:
        failed > 0
          ? "Review failed auto-answer decisions and resolve manually."
          : "Decision queue was auto-resolved; run can continue.",
      message:
        failed > 0
          ? `Question answers processed (${applied} applied, ${failed} failed).`
          : `Question answer ${pending.action} applied to ${applied} queued items.`,
      metadata: {
        event: failed > 0 ? "question_answer_failed" : "question_answer_applied",
        action_type: normalizeActivityActionType(
          failed > 0 ? "question_answer_failed" : "question_answer_applied"
        ),
        action_phase: normalizeActivityActionPhase(
          failed > 0 ? "blocked" : "review"
        ),
        initiative_id: pending.initiativeId,
        workstream_id: pending.workstreamId,
        source_run_id: pending.sourceRunId,
        source_client: pending.sourceClient,
        question_policy_mode: pending.mode,
        question_policy_version: pending.policyVersion,
        decision_action: pending.action,
        decision_ids: decisionIds,
        decision_count: decisionIds.length,
        applied_count: applied,
        failed_count: failed,
        resolution_source: "policy_timeout",
        timeout_seconds_applied: pending.timeoutSeconds,
        failures,
      },
    });
  };

  const armQuestionAutoAnswerTimer = (
    key: string,
    pending: PendingQuestionAutoAnswer,
    delaySeconds: number
  ): void => {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pending.timer = setTimeout(() => {
      void (async () => {
        try {
          await emitActivitySafe({
            initiativeId: pending.initiativeId,
            runId: pending.sourceRunId,
            correlationId: pending.sourceRunId,
            phase: "review",
            level: "info",
            progressPct: 100,
            nextStep: "Applying configured decision action sequentially.",
            message: "Question timeout reached; applying auto-answer policy.",
            metadata: {
              event: "question_timeout_started",
              action_type: normalizeActivityActionType("question_timeout_started"),
              action_phase: normalizeActivityActionPhase("review"),
              ...(pending.eventMetadata ?? {}),
              decision_ids: pending.decisionIds,
              decision_count: pending.decisionIds.length,
              decision_action: pending.action,
              question_policy_mode: pending.mode,
              question_policy_version: pending.policyVersion,
              timeout_seconds_applied: pending.timeoutSeconds,
            },
          });
          await processQuestionAutoAnswer(key, pending);
        } catch (err: unknown) {
          await emitActivitySafe({
            initiativeId: pending.initiativeId,
            runId: pending.sourceRunId,
            correlationId: pending.sourceRunId,
            phase: "blocked",
            level: "warn",
            progressPct: 100,
            nextStep: "Review and resolve the queued question manually.",
            message: "Question auto-answer failed before apply.",
            metadata: {
              event: "question_answer_failed",
              action_type: normalizeActivityActionType("question_answer_failed"),
              action_phase: normalizeActivityActionPhase("blocked"),
              initiative_id: pending.initiativeId,
              workstream_id: pending.workstreamId,
              source_run_id: pending.sourceRunId,
              source_client: pending.sourceClient,
              decision_ids: pending.decisionIds,
              decision_count: pending.decisionIds.length,
              decision_action: pending.action,
              failed_count: pending.decisionIds.length,
              resolution_source: "policy_timeout",
              timeout_seconds_applied: pending.timeoutSeconds,
              question_policy_mode: pending.mode,
              question_policy_version: pending.policyVersion,
              error: safeErrorMessage(err),
            },
          });
        }
      })();
    }, delaySeconds * 1_000);
    pending.timer.unref?.();
  };

  type QueuedDecisionOptionSummary = {
    id?: string | null;
    label: string;
    description?: string | null;
    consequences?: string | null;
    action_type?: string | null;
    implied_status?: string | null;
    requires_note?: boolean;
    recommended?: boolean;
  };

  type QueuedDecisionEvidenceSummary = {
    title: string;
    summary?: string | null;
    source_url?: string | null;
    source_pointer?: string | null;
    evidence_type?: string | null;
    confidence?: number | null;
  };

  const pickMetadataString = (
    record: Record<string, unknown> | null | undefined,
    keys: string[]
  ): string | null => {
    if (!record) return null;
    for (const key of keys) {
      const value = record[key];
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
    return null;
  };

  const pickMetadataStringArray = (
    record: Record<string, unknown> | null | undefined,
    keys: string[]
  ): string[] => {
    if (!record) return [];
    for (const key of keys) {
      const raw = record[key];
      if (!Array.isArray(raw)) continue;
      const values = raw
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (values.length > 0) return values;
    }
    return [];
  };

  const normalizeQueuedDecisionOptions = (
    value: Array<string | Record<string, unknown>> | null | undefined,
    recommendedAction: string | null
  ): QueuedDecisionOptionSummary[] => {
    if (!Array.isArray(value)) return [];
    const normalized: QueuedDecisionOptionSummary[] = [];
    const seen = new Set<string>();
    const recommendedLower = recommendedAction?.trim().toLowerCase() ?? null;
    for (const rawOption of value) {
      if (typeof rawOption === "string") {
        const label = rawOption.trim();
        if (!label) continue;
        const key = label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push({
          label,
          recommended: recommendedLower !== null && label.toLowerCase() === recommendedLower,
        });
        continue;
      }
      if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) continue;
      const optionRecord = rawOption as Record<string, unknown>;
      const label =
        pickMetadataString(optionRecord, ["label", "title", "name"]) ??
        pickMetadataString(optionRecord, ["action", "action_type", "actionType"]);
      if (!label) continue;
      const id = pickMetadataString(optionRecord, ["id", "option_id", "optionId"]);
      const description = pickMetadataString(optionRecord, ["description", "summary"]);
      const consequences = pickMetadataString(optionRecord, ["consequences", "impact"]);
      const actionType = pickMetadataString(optionRecord, ["action_type", "actionType", "action"]);
      const impliedStatus = pickMetadataString(optionRecord, ["implied_status", "impliedStatus", "status"]);
      const requiresNote =
        optionRecord.requires_note === true ||
        optionRecord.requiresNote === true ||
        optionRecord.note_required === true;
      const recommended =
        optionRecord.recommended === true ||
        optionRecord.is_recommended === true ||
        optionRecord.isRecommended === true ||
        (recommendedLower !== null && label.toLowerCase() === recommendedLower);
      const key = `${(id ?? "").toLowerCase()}|${label.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push({
        ...(id ? { id } : {}),
        label,
        ...(description ? { description } : {}),
        ...(consequences ? { consequences } : {}),
        ...(actionType ? { action_type: actionType } : {}),
        ...(impliedStatus ? { implied_status: impliedStatus } : {}),
        ...(requiresNote ? { requires_note: true } : {}),
        ...(recommended ? { recommended: true } : {}),
      });
    }
    return normalized.slice(0, 8);
  };

  const normalizeQueuedDecisionEvidence = (
    value: Array<Record<string, unknown>> | null | undefined
  ): QueuedDecisionEvidenceSummary[] => {
    if (!Array.isArray(value)) return [];
    const normalized: QueuedDecisionEvidenceSummary[] = [];
    const seen = new Set<string>();
    for (const rawEvidence of value) {
      if (!rawEvidence || typeof rawEvidence !== "object" || Array.isArray(rawEvidence)) continue;
      const record = rawEvidence as Record<string, unknown>;
      const title =
        pickMetadataString(record, ["title", "label", "name"]) ??
        pickMetadataString(record, ["source_pointer", "sourcePointer", "source_url", "sourceUrl"]) ??
        "Evidence";
      const summary = pickMetadataString(record, ["summary", "description"]);
      const sourceUrl = pickMetadataString(record, ["source_url", "sourceUrl", "url"]);
      const sourcePointer = pickMetadataString(record, ["source_pointer", "sourcePointer", "path"]);
      const evidenceType = pickMetadataString(record, ["evidence_type", "evidenceType", "type"]);
      const confidenceRaw = record.confidence ?? record.confidence_score;
      const confidence =
        typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
          ? Math.max(0, Math.min(1, confidenceRaw))
          : null;
      const key = `${title.toLowerCase()}|${sourceUrl ?? ""}|${sourcePointer ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push({
        title,
        ...(summary ? { summary } : {}),
        ...(sourceUrl ? { source_url: sourceUrl } : {}),
        ...(sourcePointer ? { source_pointer: sourcePointer } : {}),
        ...(evidenceType ? { evidence_type: evidenceType } : {}),
        ...(confidence !== null ? { confidence } : {}),
      });
    }
    return normalized.slice(0, 8);
  };

  const buildQuestionEventMetadata = (input: {
    initiativeId: string | null;
    workstreamId: string | null;
    sourceRunId: string | null;
    sourceClient: RuntimeSourceClient;
    decisionIds: string[];
    blocking: boolean;
    title: string;
    summary: string | null;
    decisionType: string | null;
    options: QueuedDecisionOptionSummary[];
    recommendedAction: string | null;
    evidenceRefs: QueuedDecisionEvidenceSummary[];
    scopeHierarchy: string[];
    initiativeTitle: string | null;
    workstreamTitle: string | null;
    taskTitle: string | null;
    nextActions: string[];
    currentRunState: string | null;
    impactIfDelayed: string | null;
    reason: string | null;
  }): Record<string, unknown> => {
    const metadata: Record<string, unknown> = {
      initiative_id: input.initiativeId,
      workstream_id: input.workstreamId,
      source_run_id: input.sourceRunId,
      source_client: input.sourceClient,
      decision_ids: input.decisionIds,
      decision_count: input.decisionIds.length,
      blocking: input.blocking,
      decision_title: input.title,
      decision_prompt: input.title,
      question: input.title,
      required_action: input.recommendedAction,
      recommended_action: input.recommendedAction,
      current_run_state: input.currentRunState,
      impact_if_delayed: input.impactIfDelayed,
      reason: input.reason,
      decision_type: input.decisionType,
    };
    if (input.summary) metadata.decision_summary = input.summary;
    if (input.options.length > 0) {
      metadata.decision_options = input.options;
      metadata.decision_option_labels = input.options.map((option) => option.label);
    }
    if (input.evidenceRefs.length > 0) metadata.evidence_refs = input.evidenceRefs;
    if (input.scopeHierarchy.length > 0) metadata.scope_hierarchy = input.scopeHierarchy;
    if (input.initiativeTitle) metadata.initiative_title = input.initiativeTitle;
    if (input.workstreamTitle) metadata.workstream_title = input.workstreamTitle;
    if (input.taskTitle) metadata.task_title = input.taskTitle;
    if (input.nextActions.length > 0) metadata.next_actions = input.nextActions;
    return metadata;
  };

  const scheduleQuestionAutoAnswer = async (input: {
    initiativeId: string | null;
    workstreamId: string | null;
    sourceRunId: string | null;
    sourceClient: RuntimeSourceClient;
    decisionIds: string[];
    blocking: boolean;
    reason: string | null;
    title: string;
    summary: string | null;
    decisionType: string | null;
    options: QueuedDecisionOptionSummary[];
    recommendedAction: string | null;
    evidenceRefs: QueuedDecisionEvidenceSummary[];
    scopeHierarchy: string[];
    initiativeTitle: string | null;
    workstreamTitle: string | null;
    taskTitle: string | null;
    nextActions: string[];
    currentRunState: string | null;
    impactIfDelayed: string | null;
  }): Promise<void> => {
    const decisionIds = dedupeStrings(
      input.decisionIds
        .map((entry) => (entry ?? "").trim())
        .filter(Boolean)
    );
    if (decisionIds.length === 0) return;
    const policy = resolveQuestionPolicy(input.initiativeId, input.workstreamId);
    const questionMetadata = buildQuestionEventMetadata({
      initiativeId: input.initiativeId,
      workstreamId: input.workstreamId,
      sourceRunId: input.sourceRunId,
      sourceClient: input.sourceClient,
      decisionIds,
      blocking: input.blocking,
      title: input.title,
      summary: input.summary,
      decisionType: input.decisionType,
      options: input.options,
      recommendedAction: input.recommendedAction,
      evidenceRefs: input.evidenceRefs,
      scopeHierarchy: input.scopeHierarchy,
      initiativeTitle: input.initiativeTitle,
      workstreamTitle: input.workstreamTitle,
      taskTitle: input.taskTitle,
      nextActions: input.nextActions,
      currentRunState: input.currentRunState,
      impactIfDelayed: input.impactIfDelayed,
      reason: input.reason,
    });
    await emitActivitySafe({
      initiativeId: input.initiativeId,
      runId: input.sourceRunId,
      correlationId: input.sourceRunId,
      phase: "review",
      level: "info",
      progressPct: 0,
      nextStep: input.blocking
        ? "Blocking question requires human review."
        : `Auto-answer in ${policy.timeoutSeconds}s unless human responds.`,
      message: input.blocking
        ? "Blocking question surfaced for human decision."
        : "Question surfaced and queued for timeout policy.",
      metadata: {
        event: "question_asked",
        action_type: normalizeActivityActionType("question_asked"),
        action_phase: normalizeActivityActionPhase("review"),
        ...questionMetadata,
        question_policy_mode: policy.mode,
        question_policy_version: policy.policyVersion,
        timeout_seconds_applied: policy.timeoutSeconds,
      },
    });
    if (input.blocking) {
      await emitActivitySafe({
        initiativeId: input.initiativeId,
        runId: input.sourceRunId,
        correlationId: input.sourceRunId,
        phase: "blocked",
        level: "info",
        progressPct: 0,
        nextStep:
          policy.blockingBehavior === "guarded_auto_resolve_then_human" &&
          decisionAutoResolveGuardedEnabled
            ? "Awaiting guarded remediation and/or human decision."
            : "Awaiting human decision response.",
        message:
          policy.blockingBehavior === "guarded_auto_resolve_then_human" &&
          decisionAutoResolveGuardedEnabled
            ? "Blocking question requires human decision after guarded remediation."
            : "Blocking question requires human decision.",
        metadata: {
          event: "review_item_created",
          action_type: normalizeActivityActionType("review_item_created"),
          action_phase: normalizeActivityActionPhase("blocked"),
          ...questionMetadata,
          blocking: true,
          reason: "blocking_question_requires_human",
          question_policy_mode: policy.mode,
          question_policy_version: policy.policyVersion,
          question_blocking_behavior: policy.blockingBehavior,
        },
      });
      return;
    }
    if (!policy.enabled) {
      await emitActivitySafe({
        initiativeId: input.initiativeId,
        runId: input.sourceRunId,
        correlationId: input.sourceRunId,
        phase: "review",
        level: "info",
        progressPct: 0,
        nextStep: "Awaiting human decision response.",
        message: "Question auto-answer is disabled for this agent policy.",
        metadata: {
          event: "review_item_created",
          action_type: normalizeActivityActionType("review_item_created"),
          action_phase: normalizeActivityActionPhase("review"),
          ...questionMetadata,
          reason: "policy_disabled",
          question_policy_mode: policy.mode,
          question_policy_version: policy.policyVersion,
        },
      });
      return;
    }
    const key = questionScopeKey(input.initiativeId, input.workstreamId);
    const dueAtEpoch = Date.now() + policy.timeoutSeconds * 1_000;
    const existing = pendingQuestionAutoAnswerByScope.get(key);
    if (existing) {
      existing.decisionIds = dedupeStrings([...existing.decisionIds, ...decisionIds]);
      existing.sourceRunId = input.sourceRunId ?? existing.sourceRunId;
      existing.sourceClient = input.sourceClient || existing.sourceClient;
      existing.action = policy.action;
      existing.mode = policy.mode;
      existing.policyVersion = policy.policyVersion;
      existing.timeoutSeconds = policy.timeoutSeconds;
      existing.dueAt = new Date(dueAtEpoch).toISOString();
      existing.eventMetadata = questionMetadata;
      armQuestionAutoAnswerTimer(key, existing, policy.timeoutSeconds);
      await emitActivitySafe({
        initiativeId: input.initiativeId,
        runId: input.sourceRunId,
        correlationId: input.sourceRunId,
        phase: "review",
        level: "info",
        progressPct: 0,
        nextStep: `Auto-answer in ${policy.timeoutSeconds}s unless human responds.`,
        message: "Extended timeout for queued unanswered decision(s).",
        metadata: {
          event: "question_timeout_started",
          action_type: normalizeActivityActionType("question_timeout_started"),
          action_phase: normalizeActivityActionPhase("review"),
          ...questionMetadata,
          decision_ids: existing.decisionIds,
          decision_count: existing.decisionIds.length,
          decision_action: existing.action,
          timeout_seconds_applied: policy.timeoutSeconds,
          question_policy_mode: policy.mode,
          question_policy_version: policy.policyVersion,
          due_at: existing.dueAt,
          reason: input.reason,
        },
      });
      return;
    }
    const pending: PendingQuestionAutoAnswer = {
      key,
      initiativeId: input.initiativeId ?? "",
      workstreamId: input.workstreamId ?? null,
      sourceRunId: input.sourceRunId ?? null,
      sourceClient: input.sourceClient,
      action: policy.action,
      mode: policy.mode,
      policyVersion: policy.policyVersion,
      timeoutSeconds: policy.timeoutSeconds,
      dueAt: new Date(dueAtEpoch).toISOString(),
      timer: null,
      decisionIds,
      eventMetadata: questionMetadata,
    };
    armQuestionAutoAnswerTimer(key, pending, policy.timeoutSeconds);
    pendingQuestionAutoAnswerByScope.set(key, pending);
    await emitActivitySafe({
      initiativeId: input.initiativeId,
      runId: input.sourceRunId,
      correlationId: input.sourceRunId,
      phase: "review",
      level: "info",
      progressPct: 0,
      nextStep: `Auto-answer in ${policy.timeoutSeconds}s unless human responds.`,
      message: "Queued unanswered decision(s) for timeout auto-answer.",
      metadata: {
        event: "question_timeout_started",
        action_type: normalizeActivityActionType("question_timeout_started"),
        action_phase: normalizeActivityActionPhase("review"),
        ...questionMetadata,
        decision_action: policy.action,
        timeout_seconds_applied: policy.timeoutSeconds,
        question_policy_mode: policy.mode,
        question_policy_version: policy.policyVersion,
        due_at: pending.dueAt,
        reason: input.reason,
      },
    });
  };

  type DecisionRequestOutcome = { queued: boolean; decisionIds: string[] };
  const requestDecisionQueued = async (
    input: Parameters<CreateAutoContinueEngineDeps["requestDecisionSafe"]>[0]
  ): Promise<DecisionRequestOutcome> => {
    const asRecord = (value: unknown): Record<string, unknown> | null => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      return value as Record<string, unknown>;
    };
    const normalizeId = (value: unknown): string | null => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    };
    const normalizeLower = (value: unknown): string => {
      if (typeof value !== "string") return "";
      return value.trim().toLowerCase();
    };
    const recoverQueuedDecisionIds = async (recoverInput: {
      title: string;
      sourceRunId: string | null;
      workstreamId: string | null;
    }): Promise<string[]> => {
      try {
        const pending = await client.getLiveDecisions({ status: "pending", limit: 100 });
        const rows = Array.isArray(pending?.decisions) ? pending.decisions : [];
        const wantedTitle = normalizeLower(recoverInput.title);
        const wantedRunId = normalizeLower(recoverInput.sourceRunId ?? "");
        const wantedWorkstreamId = normalizeLower(recoverInput.workstreamId ?? "");
        const recentThreshold = Date.now() - 10 * 60 * 1_000;
        const ids: string[] = [];
        const seen = new Set<string>();
        for (const row of rows) {
          const record = asRecord(row);
          if (!record) continue;
          const id =
            normalizeId(record.id) ??
            normalizeId(record.entity_id) ??
            normalizeId(record.decision_id);
          if (!id || seen.has(id)) continue;
          const metadata = asRecord(record.metadata);
          const sourceRef =
            asRecord(record.source_ref) ?? asRecord(metadata?.source_ref);
          const rowWorkstreamId =
            normalizeLower(record.workstream_id) ||
            normalizeLower(record.workstreamId) ||
            normalizeLower(metadata?.source_stream_id) ||
            normalizeLower(sourceRef?.workstream_id) ||
            normalizeLower(sourceRef?.stream_id);
          const rowRunId =
            normalizeLower(record.source_run_id) ||
            normalizeLower(record.sourceRunId) ||
            normalizeLower(metadata?.run_id) ||
            normalizeLower(metadata?.correlation_id) ||
            normalizeLower(sourceRef?.run_id);
          const rowTitle =
            normalizeLower(record.title) || normalizeLower(metadata?.title);
          const updatedAtRaw =
            normalizeId(record.updated_at) ?? normalizeId(record.created_at);
          const updatedAtEpoch = updatedAtRaw ? Date.parse(updatedAtRaw) : NaN;
          const recentEnough =
            !Number.isFinite(updatedAtEpoch) || updatedAtEpoch >= recentThreshold;
          const workstreamMatches =
            !wantedWorkstreamId || rowWorkstreamId === wantedWorkstreamId;
          const runMatches = Boolean(wantedRunId) && rowRunId === wantedRunId;
          const titleMatches = Boolean(wantedTitle) && rowTitle === wantedTitle;
          if (!workstreamMatches) continue;
          if (!(runMatches || (titleMatches && recentEnough))) continue;
          seen.add(id);
          ids.push(id);
        }
        return ids;
      } catch {
        return [];
      }
    };
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
    const metadataBase =
      input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
        ? (input.metadata as Record<string, unknown>)
        : {};
    const metadataSourceClient =
      (typeof metadataBase.source_client === "string" && metadataBase.source_client.trim().length > 0
        ? metadataBase.source_client.trim()
        : null) ??
      (typeof metadataBase.sourceClient === "string" && metadataBase.sourceClient.trim().length > 0
        ? metadataBase.sourceClient.trim()
        : null);
    const inferredSourceClient = normalizeRuntimeSourceClient(
      metadataSourceClient ??
        process.env.ORGX_AUTOPILOT_EXECUTOR ??
        process.env.ORGX_AUTOPILOT_WORKER_KIND
    );
    const sourceRefSourceClient =
      (typeof sourceRefBase.source_client === "string" &&
      sourceRefBase.source_client.trim().length > 0
        ? sourceRefBase.source_client.trim()
        : null) ??
      (typeof sourceRefBase.sourceClient === "string" &&
      sourceRefBase.sourceClient.trim().length > 0
        ? sourceRefBase.sourceClient.trim()
        : null);
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
        source_client: sourceRefSourceClient ?? inferredSourceClient,
      },
      metadata: {
        ...metadataBase,
        source_system: input.sourceSystem ?? null,
        conflict_source: input.conflictSource ?? null,
        source_client: metadataSourceClient ?? inferredSourceClient,
      },
    };
    const linkedSlice = inferredRunId ? autoContinueSliceRuns.get(inferredRunId) ?? null : null;
    const sourceClientFromInput =
      typeof normalizedInput.metadata?.source_client === "string" &&
      normalizedInput.metadata.source_client.trim().length > 0
        ? (normalizedInput.metadata.source_client.trim() as RuntimeSourceClient)
        : null;
    const sourceClient = normalizeRuntimeSourceClient(
      sourceClientFromInput ??
        linkedSlice?.sourceClient ??
        process.env.ORGX_AUTOPILOT_EXECUTOR ??
        process.env.ORGX_AUTOPILOT_WORKER_KIND
    );
    const scopedWorkstreamId =
      ((typeof normalizedInput.workstreamId === "string" &&
        normalizedInput.workstreamId.trim().length > 0
        ? normalizedInput.workstreamId.trim()
        : null) ??
        inferredStreamId ??
        linkedSlice?.workstreamId ??
        null);
    const initiativeTitle =
      pickMetadataString(metadataBase, ["initiative_title", "initiativeTitle"]) ??
      pickMetadataString(sourceRefBase, ["initiative_title", "initiativeTitle"]) ??
      null;
    const workstreamTitle =
      pickMetadataString(metadataBase, ["workstream_title", "workstreamTitle"]) ??
      pickMetadataString(sourceRefBase, ["workstream_title", "workstreamTitle"]) ??
      linkedSlice?.workstreamTitle ??
      null;
    const taskTitle =
      pickMetadataString(metadataBase, ["task_title", "taskTitle", "dispatch_task_title"]) ??
      null;
    const recommendedAction =
      typeof normalizedInput.recommendedAction === "string" && normalizedInput.recommendedAction.trim().length > 0
        ? normalizedInput.recommendedAction.trim()
        : pickMetadataString(metadataBase, ["recommended_action", "recommendedAction"]);
    const decisionOptions = normalizeQueuedDecisionOptions(normalizedInput.options ?? [], recommendedAction);
    const decisionEvidenceRefs = normalizeQueuedDecisionEvidence(normalizedInput.evidenceRefs ?? []);
    const scopeHierarchy = [
      ...pickMetadataStringArray(metadataBase, ["scope_hierarchy", "scopeHierarchy"]),
      ...pickMetadataStringArray(sourceRefBase, ["scope_hierarchy", "scopeHierarchy"]),
      ...[initiativeTitle, workstreamTitle, taskTitle].filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0
      ),
    ].filter((entry, index, source) => source.indexOf(entry) === index);
    const nextActions = [
      ...pickMetadataStringArray(metadataBase, ["next_actions", "nextActions"]),
      ...(recommendedAction ? [recommendedAction] : []),
    ].filter((entry, index, source) => source.indexOf(entry) === index);
    const currentRunState =
      pickMetadataString(metadataBase, ["current_run_state", "currentRunState", "runtime_state", "runtimeState", "parsed_status", "parsedStatus"]) ??
      linkedSlice?.status ??
      null;
    const impactIfDelayed =
      pickMetadataString(metadataBase, ["impact_if_delayed", "impactIfDelayed"]) ??
      null;
    const result = await requestDecisionSafe(normalizedInput);
    if (typeof result === "boolean") {
      return { queued: result, decisionIds: [] };
    }
    if (result && typeof result === "object" && "queued" in result) {
      const record = result as { queued?: unknown; decisionIds?: unknown };
      let decisionIds = Array.isArray(record.decisionIds)
        ? record.decisionIds
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : [];
      if (Boolean(record.queued) && decisionIds.length === 0) {
        decisionIds = await recoverQueuedDecisionIds({
          title: normalizedInput.title,
          sourceRunId: inferredRunId,
          workstreamId: scopedWorkstreamId,
        });
      }
      if (Boolean(record.queued) && decisionIds.length > 0) {
        await scheduleQuestionAutoAnswer({
          initiativeId: normalizedInput.initiativeId,
          workstreamId: scopedWorkstreamId,
          sourceRunId: inferredRunId,
          sourceClient,
          decisionIds,
          blocking: Boolean(normalizedInput.blocking),
          title: normalizedInput.title,
          summary:
            typeof normalizedInput.summary === "string" && normalizedInput.summary.trim().length > 0
              ? normalizedInput.summary.trim()
              : null,
          decisionType:
            typeof normalizedInput.decisionType === "string" && normalizedInput.decisionType.trim().length > 0
              ? normalizedInput.decisionType.trim()
              : null,
          options: decisionOptions,
          recommendedAction,
          evidenceRefs: decisionEvidenceRefs,
          scopeHierarchy,
          initiativeTitle,
          workstreamTitle,
          taskTitle,
          nextActions,
          currentRunState,
          impactIfDelayed,
          reason:
            typeof normalizedInput.conflictSource === "string"
              ? normalizedInput.conflictSource
              : null,
        });
      }
      return {
        queued: Boolean(record.queued),
        decisionIds,
      };
    }
    return { queued: false, decisionIds: [] };
  };
  const defaultInterventionDecisionOptions = (): Array<Record<string, unknown>> => [
    {
      id: "retry_slice",
      label: "Retry this workstream slice",
      description: "Retry once with the latest context and logs.",
      consequences: "Autopilot retries this workstream slice immediately.",
      implied_status: "approved",
      action_type: "retry",
      requires_note: false,
    },
    {
      id: "pause_and_investigate",
      label: "Pause autopilot and investigate",
      description: "Pause orchestration and capture operator notes for handoff.",
      consequences: "Autopilot pauses and waits for new operator guidance.",
      implied_status: "declined",
      action_type: "pause",
      requires_note: true,
    },
    {
      id: "skip_for_now",
      label: "Skip this workstream for now",
      description: "Defer this lane and keep other workstreams moving.",
      consequences: "This lane is deferred while the rest of the queue continues.",
      implied_status: "declined",
      action_type: "defer",
      requires_note: true,
    },
  ];
  const __filename = deps.filename;
  type AutoContinueStopReason =
    | "budget_exhausted"
    | "blocked"
    | "completed"
    | "stopped"
    | "error";

  type AutoContinueStatus = typeof RunStatus[keyof typeof RunStatus];
  type AutoContinueParallelMode = "iwmt";
  type AutoContinueLaneState = typeof LaneState[keyof typeof LaneState];

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
    workspaceId: string | null;
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
    workerEnvOverrides: Record<string, string | undefined> | null;
    lastInitiativeStatus: string | null;
  };

  const autoContinueRuns = new Map<string, AutoContinueRun>();

  /**
   * Rehydrate an AutoContinueRun from persisted initiative metadata.
   * Called when the in-memory Map is empty (e.g. after server restart) to
   * restore the last-known autopilot state so the dashboard toggle stays
   * accurate.
   */
  async function restoreAutoContinueRun(
    initiativeId: string
  ): Promise<AutoContinueRun | null> {
    // Already in memory — nothing to restore.
    if (autoContinueRuns.has(initiativeId)) {
      return autoContinueRuns.get(initiativeId) ?? null;
    }
    try {
      const entity = await fetchInitiativeEntity(initiativeId);
      if (!entity) return null;
      const meta =
        entity && typeof entity === "object"
          ? ((entity as Record<string, unknown>).metadata as Record<string, unknown> | undefined) ?? {}
          : {};
      const enabled = meta.auto_continue_enabled;
      const status = meta.auto_continue_status as string | undefined;
      if (!enabled || !status) return null;

      // Reconstruct lane objects from persisted array.
      const rawLanes = Array.isArray(meta.auto_continue_lane_states)
        ? (meta.auto_continue_lane_states as Array<Record<string, unknown>>)
        : [];
      const laneByWorkstreamId: Record<string, AutoContinueLane> = {};
      for (const raw of rawLanes) {
        const wsId = String(raw.workstream_id ?? "").trim();
        if (!wsId) continue;
        laneByWorkstreamId[wsId] = {
          workstreamId: wsId,
          state: (raw.state as AutoContinueLaneState) ?? LaneState.IDLE,
          activeRunId: (raw.active_run_id as string) ?? null,
          activeTaskIds: Array.isArray(raw.active_task_ids) ? (raw.active_task_ids as string[]) : [],
          blockedReason: (raw.blocked_reason as string) ?? null,
          waitingOnWorkstreamIds: Array.isArray(raw.waiting_on_workstream_ids)
            ? (raw.waiting_on_workstream_ids as string[])
            : [],
          retryAt: (raw.retry_at as string) ?? null,
          updatedAt: (raw.updated_at as string) ?? new Date().toISOString(),
        };
      }

      const now = new Date().toISOString();
      const run: AutoContinueRun = {
        initiativeId,
        workspaceId:
          typeof meta.workspace_id === "string" && meta.workspace_id.trim().length > 0
            ? meta.workspace_id.trim()
            : null,
        agentId: "",
        agentName: null,
        includeVerification: Boolean(meta.auto_continue_include_verification),
        allowedWorkstreamIds: Array.isArray(meta.auto_continue_workstream_filter)
          ? (meta.auto_continue_workstream_filter as string[])
          : null,
        stopAfterSlice: false,
        ignoreSpawnGuardRateLimit: Boolean(meta.auto_continue_ignore_spawn_guard_rate_limit),
        maxParallelSlices: normalizeMaxParallelSlices(
          meta.auto_continue_max_parallel,
          AUTO_CONTINUE_MAX_PARALLEL_DEFAULT
        ),
        parallelMode: normalizeParallelMode(meta.auto_continue_parallel_mode),
        scope: "task" as SliceScope,
        tokenBudget: normalizeTokenBudget(
          meta.auto_continue_token_budget,
          defaultAutoContinueTokenBudget()
        ),
        tokensUsed: typeof meta.auto_continue_tokens_used === "number" ? meta.auto_continue_tokens_used : 0,
        status: status as AutoContinueStatus,
        stopReason: (meta.auto_continue_stop_reason as AutoContinueStopReason) ?? null,
        stopRequested: false,
        startedAt: (meta.auto_continue_started_at as string) ?? now,
        stoppedAt: (meta.auto_continue_stopped_at as string | null) ?? null,
        updatedAt: (meta.auto_continue_updated_at as string) ?? now,
        lastError: (meta.auto_continue_last_error as string) ?? null,
        lastTaskId: (meta.auto_continue_last_task_id as string) ?? null,
        lastRunId: (meta.auto_continue_last_run_id as string) ?? null,
        activeSliceRunIds: Array.isArray(meta.auto_continue_active_run_ids)
          ? (meta.auto_continue_active_run_ids as string[])
          : [],
        activeTaskIds: Array.isArray(meta.auto_continue_active_task_ids)
          ? (meta.auto_continue_active_task_ids as string[])
          : [],
        laneByWorkstreamId,
        blockedWorkstreamIds: Array.isArray(meta.auto_continue_blocked_workstream_ids)
          ? (meta.auto_continue_blocked_workstream_ids as string[])
          : [],
        activeTaskId: (meta.auto_continue_active_task_id as string) ?? null,
        activeRunId: (meta.auto_continue_active_run_id as string) ?? null,
        activeTaskTokenEstimate:
          typeof meta.auto_continue_active_task_token_estimate === "number"
            ? meta.auto_continue_active_task_token_estimate
            : null,
        workerEnvOverrides: null,
        lastInitiativeStatus:
          typeof meta.status === "string" && meta.status.trim().length > 0
            ? meta.status.trim()
            : null,
      };
      ensureRunInternals(run);
      syncLegacyRunPointers(run);

      // Insert into in-memory map so subsequent lookups are fast.
      autoContinueRuns.set(initiativeId, run);
      return run;
    } catch {
      return null;
    }
  }

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
    options?: Array<string | Record<string, unknown>> | null;
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
    cliSessionId: string | null;
    resumedFromSessionId: string | null;
    agentJobId?: string | null;
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
      if (eventName.includes("question_asked")) return "question_asked";
      if (eventName.includes("question_timeout_started")) return "question_timeout_started";
      if (eventName.includes("question_auto_answered")) return "question_auto_answered";
      if (eventName.includes("question_answer_applied")) return "question_answer_applied";
      if (eventName.includes("question_answer_failed")) return "question_answer_failed";
      if (eventName.includes("review_item_created")) return "review_item_created";
      if (eventName.includes("review_item_resolved")) return "review_item_resolved";
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
      source_client: input.slice?.sourceClient ?? "unknown",
      runtime_client: input.slice?.sourceClient ?? "unknown",
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

  const stopActiveSliceProcesses = async (sliceRunIds: string[]): Promise<void> => {
    for (const rawRunId of sliceRunIds) {
      const sliceRunId = rawRunId.trim();
      if (!sliceRunId) continue;
      const child = autoContinueSliceChildren.get(sliceRunId) ?? null;
      try {
        if (child && child.exitCode === null && !child.killed) {
          child.kill("SIGTERM");
        }
      } catch {
        // best effort
      }

      const slice = autoContinueSliceRuns.get(sliceRunId) ?? null;
      const pid = slice?.pid ?? child?.pid ?? null;
      if (pid && pidAlive(pid)) {
        try {
          await stopProcess(pid);
        } catch {
          // best effort
        }
      }

      if (slice) {
        slice.pid = null;
        slice.updatedAt = new Date().toISOString();
        autoContinueSliceRuns.set(sliceRunId, slice);
      }
      clearAutoContinueSliceTransientState(sliceRunId);
    }
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
      state: LaneState.IDLE as AutoContinueLaneState,
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
          state: lane.state === LaneState.BLOCKED ? "blocked" : "idle",
          activeRunId: null,
          activeTaskIds: [],
          retryAt: lane.retryAt ?? null,
          waitingOnWorkstreamIds: lane.waitingOnWorkstreamIds ?? [],
          blockedReason: lane.state === LaneState.BLOCKED ? lane.blockedReason : null,
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
    if (!run.workerEnvOverrides || typeof run.workerEnvOverrides !== "object") {
      run.workerEnvOverrides = null;
    }
    run.workspaceId =
      typeof run.workspaceId === "string" && run.workspaceId.trim().length > 0
        ? run.workspaceId.trim()
        : null;
    run.lastInitiativeStatus =
      typeof run.lastInitiativeStatus === "string" && run.lastInitiativeStatus.trim().length > 0
        ? run.lastInitiativeStatus.trim()
        : null;
  };

  const laneStateToChildStatus = (laneState: AutoContinueLaneState): string => {
    if (laneState === LaneState.RUNNING) return "in_progress";
    if (laneState === LaneState.BLOCKED) return "blocked";
    if (laneState === LaneState.WAITING_DEPENDENCY || laneState === LaneState.RATE_LIMITED) {
      return "paused";
    }
    if (laneState === LaneState.COMPLETED) return "completed";
    return "todo";
  };

  const deriveInitiativeStatusFromRun = (run: AutoContinueRun): string => {
    ensureRunInternals(run);
    const childStatuses = Object.values(run.laneByWorkstreamId ?? {}).map((lane) =>
      laneStateToChildStatus(lane.state)
    );

    if (run.status === RunStatus.RUNNING || run.status === RunStatus.STOPPING) {
      return deriveInitiativeLifecycleStatus(
        "active",
        childStatuses.length > 0 ? childStatuses : ["in_progress"]
      );
    }

    if (run.stopReason === "blocked" || run.stopReason === "error") {
      return "blocked";
    }

    if (run.stopReason === "completed") {
      const scopedRun =
        run.stopAfterSlice ||
        (Array.isArray(run.allowedWorkstreamIds) && run.allowedWorkstreamIds.length > 0);
      return scopedRun ? "paused" : "completed";
    }

    if (run.stopReason === "budget_exhausted" || run.stopReason === "stopped") {
      return "paused";
    }

    return childStatuses.length > 0
      ? deriveInitiativeLifecycleStatus("paused", childStatuses)
      : "paused";
  };

  const syncInitiativeLifecycleStatus = async (run: AutoContinueRun): Promise<void> => {
    const nextStatus = deriveInitiativeStatusFromRun(run);
    if (run.lastInitiativeStatus === nextStatus) return;
    await client.updateEntity("initiative", run.initiativeId, { status: nextStatus });
    run.lastInitiativeStatus = nextStatus;
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

  function estimateTokensForTask(task: MissionControlNode): number {
    if (
      typeof task.expectedTokens === "number" &&
      Number.isFinite(task.expectedTokens) &&
      task.expectedTokens > 0
    ) {
      return Math.round(task.expectedTokens);
    }
    return estimateTokensForDurationHours(task.expectedDurationHours);
  }

  function estimateTokensForTasks(tasks: MissionControlNode[]): number {
    return tasks.reduce((total, task) => total + estimateTokensForTask(task), 0);
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
      ...(input.run.workspaceId ? { workspace_id: input.run.workspaceId } : {}),
      auto_continue_enabled: input.run.status === RunStatus.RUNNING || input.run.status === RunStatus.STOPPING,
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
    await syncInitiativeLifecycleStatus(input.run);
  }

  async function stopAutoContinueRun(input: {
    run: AutoContinueRun;
    reason: AutoContinueStopReason;
    error?: string | null;
    decisionRequired?: boolean;
    decisionIds?: string[];
  }): Promise<void> {
    const decisionRequired = input.reason === "blocked" && input.decisionRequired === true;
    const decisionIds = Array.isArray(input.decisionIds)
      ? input.decisionIds
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
    const preserveQuestionAutoAnswerState =
      (input.reason === "blocked" && decisionRequired && decisionIds.length > 0) ||
      hasPendingQuestionAutoAnswerStateForInitiative(input.run.initiativeId);
    const now = new Date().toISOString();
    ensureRunInternals(input.run);
    const activeRunIds = listActiveSliceRunIds(input.run);
    await stopActiveSliceProcesses(activeRunIds);
    input.run.status = RunStatus.STOPPED;
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
          state: lane.state === LaneState.BLOCKED ? "blocked" : "idle",
          activeRunId: null,
          activeTaskIds: [],
        });
      }
    }
    if (input.error) input.run.lastError = input.error;
    clearSpawnGuardRetryStateForInitiative(input.run.initiativeId);
    if (!preserveQuestionAutoAnswerState) {
      clearQuestionAutoAnswerStateForInitiative(input.run.initiativeId);
    }
    for (const runId of activeRunIds) {
      clearAutoContinueSliceTransientState(runId);
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
        ...(input.reason === "blocked" || input.reason === "error"
          ? {
              blocker: {
                kind: decisionRequired ? "decision_required" as const : "error" as const,
                summary: input.error ?? input.run.lastError ?? "Execution blocked",
                required_actor: decisionRequired ? "user" as const : "system" as const,
                required_action: decisionRequired
                  ? "Resolve the pending decision in Decisions panel"
                  : "Review the error and retry",
                can_skip: true,
                skip_route: "/orgx/api/autopilot/skip",
              },
            }
          : {}),
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
          old_state: LaneState.RUNNING,
          new_state: input.reason === "completed" || input.reason === "stopped" ? "idle" : input.reason === "blocked" ? "blocked" : input.reason === "error" ? "error" : "idle",
          reason: input.reason,
          workspace_id: input.run.workspaceId ?? null,
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
        const child = autoContinueSliceChildren.get(slice.runId) ?? null;
        const childClosed = Boolean(child && (child.exitCode !== null || child.signalCode !== null));
        if (childClosed && slice.pid !== null) {
          slice.pid = null;
          autoContinueSliceRuns.set(slice.runId, slice);
        }
        if (pid && !childClosed && pidAlive(pid)) {
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
	                title: `Agent couldn't connect to tools: ${slice.workstreamTitle ?? slice.workstreamId}`,
	                summary:
	                  humanizeSliceFailureSummary(`MCP handshake failed${mcpHandshake.server ? ` for ${mcpHandshake.server}` : ""}.`),
	                urgency: "high",
	                options: defaultInterventionDecisionOptions(),
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
                    state: LaneState.BLOCKED,
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
                const stallDecisionTitle =
                  killDecision.kind === "timeout"
                    ? `Autopilot slice timed out: ${slice.workstreamTitle ?? slice.workstreamId}`
                    : `Autopilot slice stalled: ${slice.workstreamTitle ?? slice.workstreamId}`;

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
	                title: stallDecisionTitle,
	                summary:
	                  humanizeSliceFailureSummary(slice.lastError ?? `Autopilot slice ${humanLabel}`),
	                urgency: "high",
	                options: defaultInterventionDecisionOptions(),
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
                    state: LaneState.BLOCKED,
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

        // Session capture: extract CLI session ID from output or log for future resume.
        if (sessionResumeEnabled()) {
          const outputSessionId = raw ? extractSessionIdFromOutput(raw, slice.sourceClient) : null;
          const logSessionId = outputSessionId
            ? null
            : extractSessionIdFromLog(readFileTailSafe(slice.logPath, 32_000), slice.sourceClient);
          const capturedSessionId = outputSessionId ?? logSessionId ?? null;
          if (capturedSessionId) {
            slice.cliSessionId = capturedSessionId;
            setWorkstreamSession(slice.workstreamId, {
              sessionId: capturedSessionId,
              workstreamId: slice.workstreamId,
              initiativeId: slice.initiativeId,
              sourceClient: slice.sourceClient,
              capturedAt: new Date().toISOString(),
              fromRunId: slice.runId,
            });
          }
        }

        const defaultDecisionBlocking = parsedStatus === "completed" ? false : true;
        const normalizeDecisionOptions = (
          value: AutoContinueSliceDecision["options"]
        ): Array<string | Record<string, unknown>> => {
          if (!Array.isArray(value)) return [];
          const normalized: Array<string | Record<string, unknown>> = [];
          for (const rawOption of value) {
            if (typeof rawOption === "string") {
              const label = rawOption.trim();
              if (label.length > 0) normalized.push(label);
              continue;
            }
            if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) {
              continue;
            }
            const optionRecord = rawOption as Record<string, unknown>;
            const label =
              (typeof optionRecord.label === "string" && optionRecord.label.trim()) ||
              (typeof optionRecord.title === "string" && optionRecord.title.trim()) ||
              (typeof optionRecord.name === "string" && optionRecord.name.trim()) ||
              null;
            if (!label) continue;
            const normalizedRecord: Record<string, unknown> = { label };
            const id =
              (typeof optionRecord.id === "string" && optionRecord.id.trim()) ||
              (typeof optionRecord.option_id === "string" && optionRecord.option_id.trim()) ||
              null;
            if (id) normalizedRecord.id = id;
            const description =
              (typeof optionRecord.description === "string" && optionRecord.description.trim()) ||
              null;
            if (description) normalizedRecord.description = description;
            const consequences =
              (typeof optionRecord.consequences === "string" && optionRecord.consequences.trim()) ||
              (typeof optionRecord.impact === "string" && optionRecord.impact.trim()) ||
              null;
            if (consequences) normalizedRecord.consequences = consequences;
            const impliedStatusRaw =
              typeof optionRecord.implied_status === "string"
                ? optionRecord.implied_status
                : typeof optionRecord.status === "string"
                  ? optionRecord.status
                  : null;
            if (impliedStatusRaw) {
              const implied = impliedStatusRaw.trim().toLowerCase();
              if (
                implied === "approved" ||
                implied === "declined" ||
                implied === "cancelled" ||
                implied === "rejected"
              ) {
                normalizedRecord.implied_status = implied;
              }
            }
            const actionType = normalizeDecisionActionType(
              optionRecord.action_type ?? optionRecord.type ?? optionRecord.verb ?? optionRecord.action
            );
            if (actionType) normalizedRecord.action_type = actionType;
            if (
              optionRecord.requires_note === true ||
              optionRecord.requiresNote === true ||
              optionRecord.note_required === true
            ) {
              normalizedRecord.requires_note = true;
            }
            normalized.push(normalizedRecord);
          }
          return normalized.slice(0, 8);
        };

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
        const normalizedBlockingDecisionCount = allDecisions.filter(
          (item) => typeof item.blocking === "boolean" ? item.blocking : defaultDecisionBlocking
        ).length;
        const normalizedNonBlockingDecisionCount = Math.max(
          0,
          allDecisions.length - normalizedBlockingDecisionCount
        );
        const operationalParsedStatus =
          parsedStatus === "completed" && normalizedBlockingDecisionCount > 0
            ? "needs_decision"
            : parsedStatus;
        const parsedSummarySignal = String(parsed?.summary ?? "").toLowerCase();
        const parsedLooksLikeNoOutcomeCompletion =
          operationalParsedStatus === "error" &&
          (parsedSummarySignal.includes("without verifiable outcomes") ||
            parsedSummarySignal.includes("without output") ||
            parsedSummarySignal.includes("without artifacts") ||
            parsedSummarySignal.includes("did not report artifacts") ||
            (parsedSummarySignal.includes("did not report") &&
              parsedSummarySignal.includes("status updates")) ||
            parsedSummarySignal.includes("produced nothing"));
        const reportedParsedStatus = parsedLooksLikeNoOutcomeCompletion
          ? "completed"
          : operationalParsedStatus;

        slice.status =
          operationalParsedStatus === "completed"
            ? "completed"
            : operationalParsedStatus === "blocked" || operationalParsedStatus === "needs_decision"
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
          parsed_status: reportedParsedStatus,
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
            options: normalizeDecisionOptions(decision.options),
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

        // --- Proof ladder gate: check completion tasks for proof readiness ---
        // Phase 1: warn-only. Does not block status transitions but creates
        // a decision request when proof is missing for done/completed tasks.
        const doneTaskUpdates = taskUpdates.filter(
          (tu: { task_id: string; status: string }) =>
            tu.status === "done" || tu.status === "completed"
        );
        if (doneTaskUpdates.length > 0 && !slice.isMockWorker) {
          const proofStrictness = process.env.ORGX_PROOF_STRICTNESS ?? "warn";
          for (const dtu of doneTaskUpdates) {
            try {
              const qp = new URLSearchParams({ task_id: dtu.task_id });
              const proofResult = await client.rawRequest<Record<string, unknown>>(
                "GET",
                `/api/flywheel/proof-status?${qp.toString()}`
              ).catch(() => null);

              // If proof API unavailable, skip gracefully (phase 1)
              if (!proofResult) continue;

              const overallPassed = proofResult?.overall_passed === true;
              if (!overallPassed && proofStrictness === "block") {
                // Hard block: downgrade to needs_review
                dtu.status = "needs_review";
                const reasonCodes = Array.isArray(proofResult?.reason_codes)
                  ? (proofResult.reason_codes as string[]).join(", ")
                  : "incomplete_proof";
                await requestDecisionSafe({
                  initiativeId: run.initiativeId,
                  correlationId: slice.runId,
                  title: `Task ${dtu.task_id} missing proof for completion`,
                  summary: `Proof chain incomplete (${reasonCodes}). Task held in needs_review until proof is resolved.`,
                  urgency: "high",
                  blocking: true,
                  decisionType: "proof_incomplete",
                  workstreamId: slice.workstreamId,
                  agentId: slice.agentId,
                  sourceRunId: slice.runId,
                  dedupeKey: `proof-gate:${dtu.task_id}:${slice.runId}`,
                  metadata: { proof_result: proofResult },
                });
              } else if (!overallPassed) {
                // Warn-only: emit activity but allow transition
                await emitActivitySafe({
                  initiativeId: run.initiativeId,
                  runId: slice.runId,
                  correlationId: slice.runId,
                  phase: "review",
                  level: "warn",
                  message: `Task ${dtu.task_id} completing with incomplete proof chain.`,
                  metadata: {
                    event: "proof_gate_warning",
                    task_id: dtu.task_id,
                    proof_result: proofResult,
                  },
                });
              }
            } catch {
              // Best-effort proof check; don't block on transient failures
            }
          }
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
              status: reportedParsedStatus,
              artifacts: artifacts.length,
              decisions: allDecisions.length,
              blocking_decisions: normalizedBlockingDecisionCount,
              non_blocking_decisions: normalizedNonBlockingDecisionCount,
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
              outcomes: {
                pr_url: typeof (parsed as any)?.pr_url === "string" ? (parsed as any).pr_url : null,
                pr_number: typeof (parsed as any)?.pr_number === "number" ? (parsed as any).pr_number : null,
                commit_sha: typeof (parsed as any)?.commit_sha === "string" ? (parsed as any).commit_sha : null,
                commit_url: typeof (parsed as any)?.commit_url === "string" ? (parsed as any).commit_url : null,
                tests: null,
                artifact_ids: artifacts.map((a) => a.name).filter(Boolean),
                task_updates: taskUpdates?.length ?? 0,
              },
          },
        });
      } catch {
        // best effort
      }

        // Emit explicit session completion event for canonical agent panel state
        if (slice.status === "completed" || reportedParsedStatus === "completed") {
          await emitActivitySafe({
            initiativeId: run.initiativeId,
            runId: slice.runId,
            correlationId: slice.runId,
            phase: "completed",
            level: "info",
            message: userSummary ?? `Completed work on ${slice.workstreamTitle ?? "task"}`,
            metadata: {
              ...buildSliceEnrichment({
                run,
                slice,
                workstreamId: slice.workstreamId,
                workstreamTitle: slice.workstreamTitle ?? null,
                domain: slice.domain,
                requiredSkills: slice.requiredSkills,
                userSummary,
                event: "session_completed",
              }),
              session_id: slice.cliSessionId ?? null,
              source_client: slice.sourceClient,
              workstream_title: slice.workstreamTitle ?? null,
              task_title: slice.workstreamTitle ?? slice.workstreamId,
              duration_ms: slice.finishedAt
                ? new Date(slice.finishedAt).getTime() - new Date(slice.startedAt).getTime()
                : null,
              outcome: reportedParsedStatus ?? slice.status,
              artifacts_produced: artifacts.length,
            },
          });
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
                parsed_status: reportedParsedStatus,
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
            parsed_status: reportedParsedStatus,
            has_output: Boolean(parsed),
            artifacts: artifacts.length,
            decisions: allDecisions.length,
            blocking_decisions: normalizedBlockingDecisionCount,
            non_blocking_decisions: normalizedNonBlockingDecisionCount,
            decision_ids: decisionIds,
            blocking_decision_ids: Array.from(new Set(blockingDecisionIds)),
            non_blocking_decision_ids: Array.from(new Set(nonBlockingDecisionIds)),
            decision_required:
              blockingDecisionQueued || operationalParsedStatus === "needs_decision",
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

        // ── Update job status on server ─────────────────────────────
        if ((slice as any).agentJobId) {
          if (updateAgentJobFn) {
            updateAgentJobFn({
              job_id: (slice as any).agentJobId,
              status: slice.status === "completed" ? "completed" : "failed",
            }).catch(() => {});
          }
        }

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
          const fallbackRawError =
            parsed?.summary ??
            slice.lastError ??
            (slice.status === "blocked"
              ? "Execution is blocked and needs intervention."
              : "Agent process exited without a valid output contract.");
          const fallbackHumanized = humanizeSliceFailure(fallbackRawError);
          const fallbackErrorSignal = [
            parsed?.summary ?? null,
            slice.lastError ?? null,
            fallbackRawError,
          ]
            .filter(
              (entry): entry is string =>
                typeof entry === "string" && entry.trim().length > 0
            )
            .join(" ")
            .toLowerCase();
          const looksLikeNoOutcome =
            fallbackErrorSignal.includes("without verifiable outcomes") ||
            fallbackErrorSignal.includes("without output") ||
            fallbackErrorSignal.includes("without artifacts") ||
            fallbackErrorSignal.includes("did not report artifacts") ||
            (fallbackErrorSignal.includes("did not report") &&
              fallbackErrorSignal.includes("status updates")) ||
            fallbackErrorSignal.includes("produced nothing");
          const looksLikeStall =
            fallbackErrorSignal.includes("stall") ||
            fallbackErrorSignal.includes("stopped making progress");
          const looksLikeTimeout =
            fallbackErrorSignal.includes("timeout") ||
            fallbackErrorSignal.includes("timed out") ||
            fallbackErrorSignal.includes("ran out of time");
          const blockedLike =
            slice.status === "blocked" ||
            looksLikeNoOutcome ||
            looksLikeStall ||
            looksLikeTimeout;
          const decisionConflictSource = looksLikeNoOutcome
            ? "slice_completed_without_outcome"
            : looksLikeTimeout
              ? "slice_timeout"
              : looksLikeStall
                ? "slice_stall_no_output"
            : blockedLike
              ? "slice_missing_blocking_decision"
              : "slice_invalid_output";
          const fallbackDecisionTitle = looksLikeNoOutcome
            ? `Autopilot slice needs verification: ${slice.workstreamTitle ?? slice.workstreamId}`
            : looksLikeStall
              ? `Autopilot slice stalled: ${slice.workstreamTitle ?? slice.workstreamId}`
              : looksLikeTimeout
                ? `Autopilot slice timed out: ${slice.workstreamTitle ?? slice.workstreamId}`
                : blockedLike
                  ? `Autopilot slice blocked: ${slice.workstreamTitle ?? slice.workstreamId}`
              : `Autopilot slice failed: ${slice.workstreamTitle ?? slice.workstreamId}`;
          const fallbackDecisionSummary = looksLikeNoOutcome
            ? "The slice reported completion but did not produce artifacts or status updates. Decide whether to retry, request stronger output, or mark tasks manually."
            : fallbackHumanized.explanation;
          if (!blockingDecisionQueued) {
            fallbackDecisionResult = await requestDecisionQueued({
              initiativeId: run.initiativeId,
              correlationId: slice.runId,
              title: fallbackDecisionTitle,
              summary: fallbackDecisionSummary,
              urgency: "high",
              options: defaultInterventionDecisionOptions(),
              blocking: true,
              decisionType: looksLikeNoOutcome
                ? "autopilot_completed_without_outcome"
                : blockedLike
                  ? "autopilot_blocked_without_decision"
                  : "autopilot_failure",
              workstreamId: slice.workstreamId,
              agentId: slice.agentId,
              sourceSystem: "orgx-autopilot",
              conflictSource: decisionConflictSource,
              dedupeKey: [
                "autopilot",
                run.initiativeId,
                slice.workstreamId,
                decisionConflictSource,
              ].join(":"),
	              recommendedAction:
                nextActions[0] ??
	                "Review the output contract and logs, then retry or pause autopilot until the blocker is resolved.",
              sourceRunId: slice.runId,
                sourceRef: {
                  run_id: slice.runId,
                  workstream_id: slice.workstreamId,
                  parsed_status: reportedParsedStatus,
                },
	              evidenceRefs: [
	                {
                  evidence_type: "slice_output_validation",
                  title: "Slice output requires fallback decision",
                  summary:
                    fallbackDecisionSummary,
                  source_pointer: slice.outputPath,
	                  payload: {
	                    log_path: slice.logPath,
	                    parsed_status: reportedParsedStatus,
	                  },
	                },
                  ...artifactEvidenceRefs,
	              ],
	            });
          }

            setLaneState(run, {
              workstreamId: slice.workstreamId,
              state: LaneState.BLOCKED,
              activeRunId: null,
              activeTaskIds: [],
              blockedReason:
                parsed?.summary ??
                slice.lastError ??
                `Slice returned status: ${reportedParsedStatus}`,
              waitingOnWorkstreamIds: [],
              retryAt: null,
            });
            if (!run.blockedWorkstreamIds.includes(slice.workstreamId)) {
              run.blockedWorkstreamIds.push(slice.workstreamId);
            }

          await stopAutoContinueRun({
	            run,
	            reason: blockedLike ? "blocked" : "error",
	            error:
	              fallbackRawError,
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
          const rawError = slice.lastError ?? (completionHadNoOutcome
            ? "Completed without verifiable outcomes or artifacts."
            : "Agent process exited without a valid output contract.");
          const humanized = humanizeSliceFailure(rawError);
          const attentionTitle =
            completionHadNoOutcome
              ? `Agent finished but produced nothing: ${slice.workstreamTitle ?? slice.workstreamId}`
              : `${humanized.headline}: ${slice.workstreamTitle ?? slice.workstreamId}`;
          const attentionSummary = humanized.explanation;

          const decisionResult = await requestDecisionQueued({
            initiativeId: run.initiativeId,
            correlationId: slice.runId,
            title: attentionTitle,
            summary: attentionSummary,
            urgency: "high",
            options: defaultInterventionDecisionOptions(),
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
              state: LaneState.BLOCKED,
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
          state: LaneState.COMPLETED,
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
      run.status = RunStatus.STOPPING;
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
    let selectedQueueRank = 0;
    let deferredBySpawnGuardRateLimit = 0;
    let queueScanIndex = 0;
    for (const taskId of graph.recentTodos) {
      queueScanIndex++;
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
      selectedQueueRank = queueScanIndex + 1;
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
          .filter((dependencyWorkstreamId) =>
            Boolean(dependencyWorkstreamId && dependencyWorkstreamId !== workstreamId)
          );
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
          state: LaneState.WAITING_DEPENDENCY,
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
    let tokenEstimate = estimateTokensForTasks(cappedSliceTaskNodes);
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

      for (const task of sliceTaskNodes) {
        if (nextSlice.length === 0) {
          nextSlice.push(task);
          continue;
        }

        const nextEstimate = estimateTokensForTasks([...nextSlice, task]);
        if (nextEstimate > remainingTokens) continue;
        nextSlice.push(task);
      }

      cappedSliceTaskNodes = nextSlice;
      tokenEstimate = estimateTokensForTasks(cappedSliceTaskNodes);
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
        state: LaneState.BLOCKED,
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
        state: LaneState.BLOCKED,
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
            state: LaneState.RATE_LIMITED,
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
            state: LaneState.IDLE,
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
            state: LaneState.BLOCKED,
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
    const progressReportingRequired = !["0", "false", "no", "off"].includes(
      String(process.env.ORGX_AUTOPILOT_PROGRESS_REQUIRED ?? "true")
        .trim()
        .toLowerCase()
    );

    // Try server KickoffContext (includes team context, acceptance criteria, etc.)
    let prompt: string;
    let kickoffContextHash: string | null = null;
    let kickoffRuntimeSettings: KickoffContext["runtime_settings"] | null = null;
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
        kickoffRuntimeSettings = kickoff.runtime_settings ?? null;
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
          progressReportingRequired,
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
          progressReportingRequired,
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
        progressReportingRequired,
      });
    }

    questionAutoAnswerPolicyByScope.set(
      questionScopeKey(run.initiativeId, selectedWorkstreamId),
      normalizeQuestionAutoAnswerPolicy(kickoffRuntimeSettings)
    );

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

    const workerEnvOverrides = run.workerEnvOverrides ?? defaultWorkerEnvOverrides;
    const configuredWorkerCwd = (
      workerEnvOverrides?.ORGX_AUTOPILOT_CWD ??
      process.env.ORGX_AUTOPILOT_CWD ??
      ""
    ).trim();
    let workerCwd = configuredWorkerCwd || resolveAutopilotDefaultCwd(__filename);
    // LaunchAgents sometimes start with cwd="/". Fall back to plugin root (or home if unresolved).
    if (!workerCwd || workerCwd === "/") {
      workerCwd = resolveAutopilotDefaultCwd(__filename);
    }
    const sliceAgent = resolveOrgxAgentForDomain(executionPolicy.domain);
    const configuredWorkerKind = (
      workerEnvOverrides?.ORGX_AUTOPILOT_WORKER_KIND ??
      process.env.ORGX_AUTOPILOT_WORKER_KIND ??
      ""
    )
      .trim()
      .toLowerCase();
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
    // Session resume: check if a previous session exists for this workstream.
    const priorSession = sessionResumeEnabled() ? getWorkstreamSession(selectedWorkstreamId) : null;
    const resumedFromSessionId = priorSession?.sessionId ?? null;

    // ── Dispatch preflight: check planner before spawn ──────────────────
    let preflightResult: Awaited<ReturnType<OrgXClient["queryDispatchPreflight"]>> | null = null;
    try {
      preflightResult = queryDispatchPreflightFn
        ? await queryDispatchPreflightFn({
            initiative_id: run.initiativeId,
            workstream_id: selectedWorkstreamId,
            task_id: primaryTask.id,
            domain: executionPolicy.domain,
            launch_mode: "autopilot",
          })
        : null;
    } catch {
      // Non-fatal: planner unavailable should not block local dispatch
    }

    if (preflightResult?.dispatch_status === "blocked") {
      const hasFatal = preflightResult.block_reasons.some(
        (r) => r.severity === "fatal"
      );
      if (hasFatal) {
        emitActivitySafe({
          initiativeId: run.initiativeId,
          runId: null,
          correlationId: sliceRunId,
          phase: "blocked",
          level: "warn",
          message: `Dispatch planner blocked workstream ${workstreamTitle ?? selectedWorkstreamId}: ${preflightResult.block_reasons.map((r) => r.message).join("; ")}`,
          metadata: {
            event: "dispatch_planner_blocked",
            workstream_id: selectedWorkstreamId,
            block_reasons: preflightResult.block_reasons,
          },
        }).catch(() => {});
        return;
      }
    }

    const resolvedRuntime = resolveCapacityRuntime({
      configuredWorkerKind,
      recommendation: preflightResult?.recommended_runtime ?? null,
    });
    if (resolvedRuntime.requiresServerDispatch) {
      emitActivitySafe({
        initiativeId: run.initiativeId,
        runId: null,
        correlationId: sliceRunId,
        phase: "blocked",
        level: "warn",
        message: `Local execution paused for ${workstreamTitle ?? selectedWorkstreamId}: OrgX selected ${resolvedRuntime.channelId ?? "a server runtime"}, but no server dispatch was acknowledged.`,
        metadata: {
          event: "capacity_router_server_dispatch_required",
          workstream_id: selectedWorkstreamId,
          task_id: primaryTask.id,
          capacity_channel_id: resolvedRuntime.channelId,
          routing_reason: resolvedRuntime.reason,
          next_goal: preflightResult?.next_goal ?? null,
        },
      }).catch(() => {});
      return;
    }

    const workerKind = resolvedRuntime.workerKind;
    const inferredExecutor =
      workerKind === "claude-code" || workerKind === "claude_code" ? "claude-code" : "codex";
    const executorRaw =
      (
        workerEnvOverrides?.ORGX_AUTOPILOT_EXECUTOR ??
        process.env.ORGX_AUTOPILOT_EXECUTOR ??
        ""
      )
        .trim()
        .toLowerCase() || inferredExecutor;
    const executorSourceClient: RuntimeSourceClient =
      executorRaw === "claude-code" || executorRaw === "claude_code" ? "claude-code" : "codex";

    const spawned = spawnCodexSliceWorker({
      runId: sliceRunId,
      prompt,
      cwd: workerCwd,
      logPath,
      outputPath,
      outputSchemaPath: schemaPath,
      resumeSessionId: resumedFromSessionId,
      env: {
        ...(workerEnvOverrides ?? {}),
        ORGX_AUTOPILOT_WORKER_KIND: workerKind,
        ORGX_SOURCE_CLIENT: executorSourceClient,
        ORGX_CAPACITY_CHANNEL_ID: resolvedRuntime.channelId ?? undefined,
        ORGX_ROUTING_REASON: resolvedRuntime.reason ?? undefined,
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
      status: RunStatus.RUNNING,
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
      cliSessionId: null,
      resumedFromSessionId,
      agentJobId: null,
    };
    autoContinueSliceRuns.set(sliceRunId, slice);

    // ── Report job to server (non-blocking) ─────────────────────────────
    const machineId = getMachineId();
    if (createAgentJobFn) {
      createAgentJobFn({
        initiative_id: run.initiativeId,
        workstream_id: selectedWorkstreamId,
        task_id: primaryTask.id,
        run_id: sliceRunId,
        agent_type: executionPolicy.domain,
        execution_target: "local",
        worker_name: machineId,
        machine_id: machineId,
        slice_scope: run.scope ?? null,
        metadata: {
          capacity_channel_id: resolvedRuntime.channelId,
          routing_source: resolvedRuntime.source,
          routing_reason: resolvedRuntime.reason,
          goal_id: preflightResult?.next_goal?.id ?? null,
          goal_title: preflightResult?.next_goal?.title ?? null,
        },
      })
      .then((result) => {
        if (result?.job_id) {
          slice.agentJobId = result.job_id;
          autoContinueSliceRuns.set(sliceRunId, slice);
        }
      })
      .catch(() => {
        // Non-blocking: server unavailable should not affect local execution
      });
    }

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
          dispatch_queue_rank: selectedQueueRank > 0 ? selectedQueueRank : null,
          dispatch_workstream_title: workstreamTitle ?? null,
          dispatch_task_title: primaryTask.title ?? null,
          dispatch_selection_reason: "top_of_queue",
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
        dispatch_queue_rank: selectedQueueRank > 0 ? selectedQueueRank : null,
        dispatch_workstream_title: workstreamTitle ?? null,
        dispatch_task_title: primaryTask.title ?? null,
        dispatch_selection_reason: "top_of_queue",
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
      state: LaneState.RUNNING,
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
      (lane.state === LaneState.RUNNING ||
        lane.state === LaneState.BLOCKED ||
        lane.state === LaneState.WAITING_DEPENDENCY ||
        lane.state === LaneState.RATE_LIMITED)
    ) {
      return run;
    }
    if (
      Array.isArray(run.allowedWorkstreamIds) &&
      run.allowedWorkstreamIds.length > 0 &&
      run.allowedWorkstreamIds.includes(workstreamId) &&
      (run.status === RunStatus.RUNNING || run.status === RunStatus.STOPPING)
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
    const autoFixWorkerEnv = captureAutopilotWorkerEnv();

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
          existingRun.status === RunStatus.STOPPING ||
          existingRun.stopReason === "stopped")
      ) {
        await emitSkip("paused_by_user");
        return;
      }
	      if (
	        existingRun &&
	        (existingRun.status === RunStatus.RUNNING || existingRun.status === RunStatus.STOPPING) &&
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
            const autoApprovalSourceClient = normalizeRuntimeSourceClient(
              process.env.ORGX_AUTOPILOT_EXECUTOR ?? process.env.ORGX_AUTOPILOT_WORKER_KIND
            );
            if (typeof (client as { decideDecision?: unknown }).decideDecision === "function") {
              await (client as {
                decideDecision: (
                  id: string,
                  action: "approve" | "reject",
                  input?: { note?: string; source_client?: string; sourceClient?: string }
                ) => Promise<unknown>;
              }).decideDecision(decisionId, "approve", {
                note: autoApprovalNote,
                source_client: autoApprovalSourceClient,
                sourceClient: autoApprovalSourceClient,
              });
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
        workspaceId: latestRun?.workspaceId ?? null,
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
        workerEnvOverrides: autoFixWorkerEnv,
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
    workspaceId?: string | null;
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
    workerEnvOverrides?: Record<string, string | undefined> | null;
  }): Promise<AutoContinueRun> {
    const now = new Date().toISOString();
    const nextWorkerEnvOverrides =
      input.workerEnvOverrides && typeof input.workerEnvOverrides === "object"
        ? { ...input.workerEnvOverrides }
        : { ...defaultWorkerEnvOverrides };
    const existing = autoContinueRuns.get(input.initiativeId) ?? null;
    const existingIsLive =
      existing?.status === RunStatus.RUNNING || existing?.status === RunStatus.STOPPING;

    const run: AutoContinueRun =
      existing ??
      ({
        initiativeId: input.initiativeId,
        workspaceId: null,
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
        status: RunStatus.RUNNING,
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
        workerEnvOverrides: null,
        lastInitiativeStatus: null,
      } as AutoContinueRun);
    ensureRunInternals(run);

    run.workspaceId =
      typeof input.workspaceId === "string" && input.workspaceId.trim().length > 0
        ? input.workspaceId.trim()
        : run.workspaceId;
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
    run.workerEnvOverrides = nextWorkerEnvOverrides;
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
    run.status = RunStatus.RUNNING;
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
      clearWorkstreamSession(input.initiativeId);
    }
    syncLegacyRunPointers(run);

    autoContinueRuns.set(input.initiativeId, run);

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
            old_state: LaneState.IDLE,
            new_state: LaneState.RUNNING,
            reason: "started",
            workspace_id: run.workspaceId ?? null,
          },
        });
      } catch {
        // best effort
      }
    }

    return run;
  }

  async function skipCurrentWorkstream(
    initiativeId: string,
    workstreamId: string,
    reason?: string
  ): Promise<{
    ok: boolean;
    skippedWorkstreamId: string;
    nextWorkstreamId?: string;
    nextWorkstreamTitle?: string;
  }> {
    const run = autoContinueRuns.get(initiativeId) ?? null;
    if (!run) {
      return { ok: false, skippedWorkstreamId: workstreamId };
    }
    ensureRunInternals(run);

    if (!run.blockedWorkstreamIds.includes(workstreamId)) {
      run.blockedWorkstreamIds.push(workstreamId);
    }
    setLaneState(run, {
      workstreamId,
      state: LaneState.BLOCKED,
      activeRunId: null,
      activeTaskIds: [],
      blockedReason: reason ?? "Skipped by user",
      waitingOnWorkstreamIds: [],
      retryAt: null,
    });
    run.updatedAt = new Date().toISOString();

    try {
      await emitActivitySafe({
        initiativeId,
        runId: run.lastRunId ?? undefined,
        correlationId: run.lastRunId ?? undefined,
        phase: "review",
        level: "info",
        message: `Workstream ${workstreamId} skipped${reason ? `: ${reason}` : ""}.`,
        metadata: {
          ...buildSliceEnrichment({
            run,
            workstreamId,
            event: "autopilot_item_skipped",
          }),
          skipped_workstream_id: workstreamId,
          skip_reason: reason ?? null,
        },
      });
    } catch {
      // best effort
    }

    // Re-enable the run if it was stopped due to the blocked workstream.
    if (run.status === RunStatus.STOPPED && run.stopReason === "blocked") {
      run.status = RunStatus.RUNNING;
      run.stopReason = null;
      run.stoppedAt = null;
      run.stopRequested = false;
      run.lastError = null;
    }

    // Trigger the next tick to pick up a different workstream.
    try {
      await tickAutoContinueRun(run);
    } catch {
      // best effort
    }

    // Determine what the next workstream is, if any.
    const nextLane = Object.values(run.laneByWorkstreamId ?? {}).find(
      (lane) => lane.state === LaneState.RUNNING && lane.workstreamId !== workstreamId
    ) ?? null;

    return {
      ok: true,
      skippedWorkstreamId: workstreamId,
      nextWorkstreamId: nextLane?.workstreamId ?? undefined,
      nextWorkstreamTitle: undefined,
    };
  }

  function getCanonicalAutopilotState(initiativeId: string): {
    state: "idle" | "running" | "blocked" | "stopping";
    reason: string | null;
    activeRunId: string | null;
    activeWorkstreamId: string | null;
    activeWorkstreamTitle: string | null;
    queueHeadTitle: string | null;
    lastTransitionAt: string;
  } | null {
    const run = autoContinueRuns.get(initiativeId) ?? null;
    if (!run) return null;

    const canonicalState: "idle" | "running" | "blocked" | "stopping" =
      run.status === RunStatus.RUNNING
        ? "running"
        : run.status === RunStatus.STOPPING
          ? "stopping"
          : run.stopReason === "blocked" || run.stopReason === "error"
            ? "blocked"
            : "idle";

    const reason =
      canonicalState === "blocked"
        ? run.lastError ?? run.stopReason ?? null
        : canonicalState === "stopping"
          ? "stop_requested"
          : null;

    // Find the first active slice to identify the current workstream.
    const activeSliceRunId = (run.activeSliceRunIds ?? [])[0] ?? run.activeRunId ?? null;
    const activeSlice = activeSliceRunId
      ? autoContinueSliceRuns.get(activeSliceRunId) ?? null
      : null;

    return {
      state: canonicalState,
      reason,
      activeRunId: activeSliceRunId,
      activeWorkstreamId: activeSlice?.workstreamId ?? null,
      activeWorkstreamTitle: activeSlice?.workstreamTitle ?? null,
      queueHeadTitle: activeSlice?.workstreamTitle ?? null,
      lastTransitionAt: run.updatedAt ?? run.startedAt,
    };
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
    restoreAutoContinueRun,
    skipCurrentWorkstream,
    getCanonicalAutopilotState,
    // Session store (for resume support)
    workstreamSessionStore,
    getWorkstreamSession,
    setWorkstreamSession,
    clearWorkstreamSession,
    listWorkstreamSessions,
    sessionResumeEnabled,
  };
}
