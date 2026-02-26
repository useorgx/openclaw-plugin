/**
 * HTTP Handler — Serves the React dashboard SPA and API proxy endpoints.
 *
 * Registered at the `/orgx` prefix. Handles:
 *   /orgx/live           → dashboard SPA (index.html)
 *   /orgx/live/assets/*  → static assets (JS, CSS, images)
 *   /orgx/api/status     → org status summary
 *   /orgx/api/agents     → agent states
 *   /orgx/api/activity   → activity feed
 *   /orgx/api/initiatives → initiative data
 *   /orgx/api/health     → plugin diagnostics + outbox/sync status
 *   /orgx/api/onboarding → onboarding / config state
 *   /orgx/api/agent-suite/status → suite provisioning plan (OpenClaw-local)
 *   /orgx/api/agent-suite/install → install/update suite (OpenClaw-local)
 *   /orgx/api/delegation/preflight → delegation preflight
 *   /orgx/api/runs/:id/checkpoints → list/create checkpoints
 *   /orgx/api/runs/:id/checkpoints/:checkpointId/restore → restore checkpoint
 *   /orgx/api/runs/:id/actions/:action → run control action
 */

import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname, extname, normalize, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import {
  readNextUpQueuePins,
  removeNextUpQueuePin,
  setNextUpQueuePinOrder,
  suppressNextUpQueueItem,
  upsertNextUpQueuePin,
} from "../next-up-queue-store.js";

import type { OrgXClient } from "../api.js";
import type {
  OnboardingState,
  OrgXConfig,
  OrgSnapshot,
  Entity,
  LiveActivityItem,
  SessionTreeNode,
  SessionTreeResponse,
} from "../types.js";
import {
  formatStatus,
  formatAgents,
  formatActivity,
  formatInitiatives,
  getOnboardingState,
} from "../dashboard-api.js";
import {
  loadLocalOpenClawSnapshot,
  loadLocalTurnDetail,
  toLocalLiveActivity,
  toLocalLiveAgents,
  toLocalLiveInitiatives,
  toLocalSessionTree,
} from "../local-openclaw.js";
import { defaultOutboxAdapter, type OutboxAdapter } from "../adapters/outbox.js";
import { readAgentContexts, upsertAgentContext, upsertRunContext } from "../agent-context-store.js";
import type { AgentLaunchContext, RunLaunchContext } from "../agent-context-store.js";
import {
  getAgentRun,
  markAgentRunStopped,
  readAgentRuns,
  upsertAgentRun,
} from "../agent-run-store.js";
import {
  appendEntityComment,
  listEntityComments,
  mergeEntityComments,
} from "../entity-comment-store.js";
import { listChatThreads } from "../chat-store.js";
import {
  appendActivityItems,
  listActivityPage,
} from "../activity-store.js";
import { enrichActivityActorFields } from "../activity-actor-fields.js";
import { readByokKeys, writeByokKeys } from "../byok-store.js";
import {
  applyOrgxAgentSuitePlan,
  computeOrgxAgentSuitePlan,
  generateAgentSuiteOperationId,
  type OrgxSkillPackOverrides,
} from "../agent-suite.js";
import {
  listRuntimeInstances,
  resolveRuntimeHookToken,
  upsertRuntimeInstanceFromHook,
  type RuntimeInstanceRecord,
  type RuntimeSourceClient,
} from "../runtime-instance-store.js";
import { parseJsonSafe } from "../json-utils.js";
import {
  readSkillPackState,
  refreshSkillPackState,
  rollbackSkillPackPolicy,
  updateSkillPackPolicy,
} from "../skill-pack-state.js";
import { posthogCapture } from "../telemetry/posthog.js";
import { createRouter } from "./router.js";
import { summarizeActivityHeadline } from "./helpers/activity-headline.js";
import {
  createAutoContinueEngine,
} from "./helpers/auto-continue-engine.js";
import {
  createAutopilotOperations,
} from "./helpers/autopilot-operations.js";
import { mapDecisionEntity } from "./helpers/decision-mapper.js";
import { idempotencyKey, stableHash } from "./helpers/hash-utils.js";
import {
  createCodexBinResolver,
  type CodexBinInfo,
} from "./helpers/autopilot-slice-utils.js";
import { createLocalArtifactDetailFallbackBuilder } from "./helpers/artifact-fallback.js";
import {
  buildMissionControlGraph,
  deriveExecutionPolicy,
  dedupeStrings,
  isDispatchableWorkstreamStatus,
  isDoneStatus,
  isInProgressStatus,
  isTodoStatus,
  listEntitiesSafe,
  normalizeEntityMutationPayload,
  pickStringArray,
  resolveAutoAssignments,
  selectSliceTasksByScope,
  type MissionControlExecutionPolicy,
  type MissionControlAssignedAgent,
  type MissionControlNode,
  type SliceScope,
} from "./helpers/mission-control.js";
import {
  configureOpenClawProviderRouting,
  fetchBillingStatusSafe,
  isPidAlive,
  listOpenClawAgents,
  listOpenClawProviderModels,
  modelImpliesByok,
  normalizeOpenClawProvider,
  resolveAutoOpenClawProvider,
  resolveByokEnvOverrides,
  spawnOpenClawAgentTurn,
  stopDetachedProcess,
} from "./helpers/openclaw-cli.js";
import { fetchKickoffContextSafe, renderKickoffMessage } from "./helpers/kickoff-context.js";
import { createDispatchLifecycle } from "./helpers/dispatch-lifecycle.js";
import { createRuntimeSseHub } from "./helpers/runtime-sse.js";
import {
  parseBooleanQuery,
  parsePositiveInt,
  pickHeaderString,
  pickNumber,
  pickString,
} from "./helpers/value-utils.js";
import { registerAgentControlRoutes } from "./routes/agent-control.js";
import { registerAgentSuiteRoutes } from "./routes/agent-suite.js";
import { registerAgentsCatalogRoutes } from "./routes/agents-catalog.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerDecisionActionsRoutes } from "./routes/decision-actions.js";
import { registerDelegationRoutes } from "./routes/delegation.js";
import { registerDebugRoutes } from "./routes/debug.js";
import { registerEntityDynamicRoutes } from "./routes/entity-dynamic.js";
import { registerEntitiesRoutes } from "./routes/entities.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerLiveLegacyRoutes } from "./routes/live-legacy.js";
import { registerLiveMiscRoutes } from "./routes/live-misc.js";
import { registerLiveSnapshotRoutes } from "./routes/live-snapshot.js";
import { registerMissionControlActionsRoutes } from "./routes/mission-control-actions.js";
import { registerMissionControlReadRoutes } from "./routes/mission-control-read.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerRunControlRoutes } from "./routes/run-control.js";
import { registerRuntimeHookRoutes } from "./routes/runtime-hooks.js";
import { registerSentinelsCatalogRoutes } from "./routes/sentinels-catalog.js";
import { registerSettingsByokRoutes } from "./routes/settings-byok.js";
import { registerSummaryRoutes } from "./routes/summary.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { registerWorkArtifactsRoutes } from "./routes/work-artifacts.js";
import { registerLiveTriageRoutes } from "./routes/live-triage.js";
import { registerRealtimeOrchestratorRoutes } from "./routes/realtime-orchestrator.js";

// =============================================================================
// Helpers
// =============================================================================

async function resolveSkillPackOverrides(input: {
  client: { getSkillPack?: (...args: any[]) => Promise<any> };
  force?: boolean;
}): Promise<OrgxSkillPackOverrides | null> {
  const state = readSkillPackState();
  const force = Boolean(input.force);

  if (!force && state.overrides) return state.overrides;
  const getSkillPack = input.client.getSkillPack;
  if (typeof getSkillPack !== "function") return state.overrides;

  try {
    const refreshed = await refreshSkillPackState({
      getSkillPack: (args) => getSkillPack(args),
      force,
    });
    return refreshed.state.overrides;
  } catch {
    // If refresh fails (network, disk, etc.), fall back to cached overrides.
    return state.overrides;
  }
}

function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const normalized = raw.trim().toLowerCase();
  if (normalized.length > 0) {
    if (
      normalized.includes("signal is aborted") ||
      normalized.includes("aborterror") ||
      normalized.includes("request cancelled") ||
      normalized.includes("request canceled")
    ) {
      return "request timed out before upstream completed";
    }
    if (normalized.includes("timed out") || normalized.includes("timeout")) {
      return "request timed out before upstream completed";
    }
    if (normalized.includes("failed to fetch") || normalized.includes("network")) {
      return "network request failed";
    }
    return raw;
  }
  return "Unexpected error";
}

function titleCaseFromSlug(value: string): string {
  const parts = value
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return value;
  return parts
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function resolveOrgxAgentForDomain(domain: string): { id: string; name: string } {
  const normalized = domain.trim().toLowerCase();
  if (!normalized) return { id: "orgx", name: "OrgX" };

  // Execution policies sometimes call this "orchestration" but the agent id is "orgx-orchestrator".
  const slug = normalized === "orchestration" ? "orchestrator" : normalized;

  // If the domain already looks like an OrgX agent id, keep it stable.
  if (slug === "orgx") return { id: "orgx", name: "OrgX" };
  if (slug.startsWith("orgx-")) return { id: slug, name: `OrgX ${titleCaseFromSlug(slug.slice(5))}` };

  return { id: `orgx-${slug}`, name: `OrgX ${titleCaseFromSlug(slug)}` };
}

function isUnauthorizedOrgxError(err: unknown): boolean {
  const message = safeErrorMessage(err).toLowerCase();
  return message.includes("401") || message.includes("unauthorized");
}

function readPositiveIntEnv(
  name: string,
  fallback: number,
  bounds?: { min?: number; max?: number }
): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const clamped = Math.floor(parsed);
  if (typeof bounds?.min === "number" && clamped < bounds.min) return fallback;
  if (typeof bounds?.max === "number" && clamped > bounds.max) return fallback;
  return clamped;
}

async function withSoftTimeout<T>(
  label: string,
  timeoutMs: number,
  work: Promise<T>
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

const ACTIVITY_WARM_THROTTLE_MS = 30_000;
const activityWarmByKey = new Map<string, number>();
const SNAPSHOT_RESPONSE_CACHE_TTL_MS = 1_500;
const SNAPSHOT_RESPONSE_CACHE_MAX_ENTRIES = 16;
const SNAPSHOT_ACTIVITY_PERSIST_MIN_INTERVAL_MS = 15_000;
const SNAPSHOT_ACTIVITY_FINGERPRINT_DEPTH = 8;
const NEXT_UP_QUEUE_CACHE_TTL_MS = readPositiveIntEnv(
  "ORGX_NEXT_UP_QUEUE_CACHE_TTL_MS",
  30_000,
  { min: 250, max: 120_000 }
);
const NEXT_UP_QUEUE_STALE_TTL_MS = readPositiveIntEnv(
  "ORGX_NEXT_UP_QUEUE_STALE_TTL_MS",
  45_000,
  { min: 1_000, max: 600_000 }
);
const NEXT_UP_GRAPH_CONCURRENCY = readPositiveIntEnv(
  "ORGX_NEXT_UP_GRAPH_CONCURRENCY",
  20,
  { min: 1, max: 32 }
);
const NEXT_UP_LIVE_AGENTS_TIMEOUT_MS = readPositiveIntEnv(
  "ORGX_NEXT_UP_LIVE_AGENTS_TIMEOUT_MS",
  1_500,
  { min: 200, max: 20_000 }
);
const NEXT_UP_AGENT_CATALOG_TIMEOUT_MS = readPositiveIntEnv(
  "ORGX_NEXT_UP_AGENT_CATALOG_TIMEOUT_MS",
  900,
  { min: 100, max: 20_000 }
);
const NEXT_UP_LIVE_SESSIONS_TIMEOUT_MS = readPositiveIntEnv(
  "ORGX_NEXT_UP_LIVE_SESSIONS_TIMEOUT_MS",
  2_500,
  { min: 250, max: 30_000 }
);
const PROJECT_SCOPE_LOOKUP_TIMEOUT_MS = readPositiveIntEnv(
  "ORGX_PROJECT_SCOPE_LOOKUP_TIMEOUT_MS",
  2_500,
  { min: 250, max: 20_000 }
);
const PROJECT_SCOPE_MAX_INITIATIVE_PAGES = readPositiveIntEnv(
  "ORGX_PROJECT_SCOPE_MAX_INITIATIVE_PAGES",
  12,
  { min: 1, max: 100 }
);
const LIVE_WORKSPACE_INITIATIVE_STATUSES = [
  "active",
  "planning",
  "paused",
  "draft",
  "in_progress",
] as const;
let lastSnapshotActivityPersistAt = 0;
let lastSnapshotActivityFingerprint = "";
const snapshotResponseCache = new Map<
  string,
  { expiresAt: number; payload: Record<string, unknown> }
>();

type ActivityBucket = "message" | "artifact" | "decision";

const ACTIVITY_DECISION_EVENT_HINTS = new Set<string>([
  "decision_buffered",
  "auto_continue_spawn_guard_blocked",
  "autopilot_slice_mcp_handshake_failed",
  "autopilot_slice_timeout",
  "autopilot_slice_log_stall",
]);

const ACTIVITY_ARTIFACT_EVENT_HINTS = new Set<string>([
  "autopilot_slice_artifact_buffered",
]);

function normalizeActivityBucket(value: unknown): ActivityBucket | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "artifact") return "artifact";
  if (normalized === "decision") return "decision";
  if (normalized === "message") return "message";
  return null;
}

function activityMetadataBoolean(metadata: Record<string, unknown> | undefined, keys: string[]): boolean | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
    }
  }
  return null;
}

function activityMetadataNumber(metadata: Record<string, unknown> | undefined, keys: string[]): number | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, value);
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return Math.max(0, parsed);
      }
    }
  }
  return null;
}

function activityMetadataEventName(metadata: Record<string, unknown> | undefined): string | null {
  if (!metadata) return null;
  const raw = metadata.event;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function deriveStructuredActivityBucket(input: {
  phase: "intent" | "execution" | "blocked" | "review" | "handoff" | "completed";
  metadata?: Record<string, unknown>;
  explicitBucket?: ActivityBucket | null;
}): ActivityBucket {
  const metadata = input.metadata;

  const explicit =
    normalizeActivityBucket(input.explicitBucket) ??
    normalizeActivityBucket(metadata?.activity_bucket) ??
    normalizeActivityBucket(metadata?.activityBucket) ??
    normalizeActivityBucket(metadata?.bucket) ??
    null;
  if (explicit) return explicit;

  const event = activityMetadataEventName(metadata);
  const decisionRequired =
    activityMetadataBoolean(metadata, ["decision_required", "decisionRequired"]) === true;
  const artifacts =
    activityMetadataNumber(metadata, ["artifacts", "artifact_count", "artifactCount"]) ?? 0;
  const decisions =
    activityMetadataNumber(metadata, ["decisions", "decision_count", "decisionCount"]) ?? 0;
  const blockingDecisions =
    activityMetadataNumber(metadata, [
      "blocking_decisions",
      "blockingDecisions",
      "blocking_decision_count",
      "blockingDecisionCount",
    ]) ?? 0;
  const nonBlockingDecisions =
    activityMetadataNumber(metadata, [
      "non_blocking_decisions",
      "nonBlockingDecisions",
      "non_blocking_decision_count",
      "nonBlockingDecisionCount",
    ]) ?? 0;

  if (event === "autopilot_slice_result") {
    // Any blocked slice result needs decision-first surfacing in the Activity UX.
    if (input.phase === "blocked") return "decision";
    if (decisionRequired || blockingDecisions > 0) return "decision";
    if (artifacts > 0) return "artifact";
    if (decisions > 0 || nonBlockingDecisions > 0) return "decision";
    return "message";
  }

  if (event === "auto_continue_stopped") {
    const stopReason =
      typeof metadata?.stop_reason === "string"
        ? metadata.stop_reason.trim().toLowerCase()
        : "";
    if (stopReason === "blocked" || stopReason === "error") return "decision";
  }

  if (event && ACTIVITY_ARTIFACT_EVENT_HINTS.has(event)) return "artifact";
  if (event && ACTIVITY_DECISION_EVENT_HINTS.has(event)) return "decision";

  const hasArtifactReference =
    typeof metadata?.artifact_id === "string" ||
    typeof metadata?.artifactId === "string" ||
    typeof metadata?.work_artifact_id === "string";
  if (hasArtifactReference || artifacts > 0) return "artifact";
  if (decisionRequired || blockingDecisions > 0 || decisions > 0 || nonBlockingDecisions > 0) {
    return "decision";
  }

  return "message";
}

function snapshotActivityFingerprint(items: LiveActivityItem[]): string {
  if (!Array.isArray(items) || items.length === 0) return "0";
  const sample = items
    .slice(0, SNAPSHOT_ACTIVITY_FINGERPRINT_DEPTH)
    .map((item) => `${item.id}|${item.timestamp}`)
    .join(";");
  return `${items.length}:${sample}`;
}

function readSnapshotResponseCache(key: string): Record<string, unknown> | null {
  const entry = snapshotResponseCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    snapshotResponseCache.delete(key);
    return null;
  }
  return entry.payload;
}

function writeSnapshotResponseCache(
  key: string,
  payload: Record<string, unknown>
): void {
  const now = Date.now();
  snapshotResponseCache.set(key, {
    expiresAt: now + SNAPSHOT_RESPONSE_CACHE_TTL_MS,
    payload,
  });

  if (snapshotResponseCache.size <= SNAPSHOT_RESPONSE_CACHE_MAX_ENTRIES) return;

  for (const [cachedKey, entry] of snapshotResponseCache.entries()) {
    if (entry.expiresAt <= now) snapshotResponseCache.delete(cachedKey);
  }

  while (snapshotResponseCache.size > SNAPSHOT_RESPONSE_CACHE_MAX_ENTRIES) {
    const oldestKey = snapshotResponseCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    snapshotResponseCache.delete(oldestKey);
  }
}

function clearSnapshotResponseCache(): void {
  snapshotResponseCache.clear();
}

function isUserScopedApiKey(apiKey: string): boolean {
  return apiKey.trim().toLowerCase().startsWith("oxk_");
}

const buildLocalArtifactDetailFallback = createLocalArtifactDetailFallbackBuilder({
  listActivityPage: ({ limit, cursor }) => listActivityPage({ limit, cursor }),
});

function maskSecret(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 8) return `${trimmed[0]}…${trimmed.slice(-1)}`;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

const {
  runtimeStreamSubscribers,
  writeRuntimeSseEvent,
  stopRuntimeStreamTimers,
  broadcastRuntimeSse,
  ensureRuntimeStreamTimers,
} = createRuntimeSseHub({
  listRuntimeInstances: ({ limit }) => listRuntimeInstances({ limit }),
});

type OpenClawAdapter = {
  listAgents?: () => Promise<Array<Record<string, unknown>>>;
  spawnAgentTurn?: (input: {
    agentId: string;
    sessionId: string;
    message: string;
    thinking?: string | null;
  }) => { pid: number | null };
  stopDetachedProcess?: (pid: number) => Promise<{ stopped: boolean; wasRunning: boolean }>;
  isPidAlive?: (pid: number) => boolean;
};

function getScopedAgentIds(contexts: Record<string, AgentLaunchContext>): Set<string> {
  const scoped = new Set<string>();
  for (const [key, ctx] of Object.entries(contexts)) {
    if (!ctx || typeof ctx !== "object") continue;
    const agentId = (ctx.agentId ?? key).trim();
    if (!agentId) continue;
    const initiativeId = ctx.initiativeId?.trim() ?? "";
    if (initiativeId) {
      scoped.add(agentId);
    }
  }
  return scoped;
}

function isUuidLike(value: string | null | undefined): boolean {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return false;
  // Accept any RFC 4122 UUID (v1-v5). We use this to distinguish real OrgX
  // initiative ids from local placeholder group ids like "agent:main".
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    trimmed
  );
}

function applyAgentContextsToSessionTree(
  input: SessionTreeResponse,
  contexts: { agents: Record<string, AgentLaunchContext>; runs: Record<string, RunLaunchContext> }
): SessionTreeResponse {
  if (!input || !Array.isArray(input.nodes)) return input;

  const groupsById = new Map<string, { id: string; label: string; status: string | null }>();
  for (const group of input.groups ?? []) {
    if (!group) continue;
    groupsById.set(group.id, {
      id: group.id,
      label: group.label,
      status: group.status ?? null,
    });
  }

		  const nodes = input.nodes.map((node) => {
		    const existingInitiativeId = (node.initiativeId ?? "").trim();
		    if (isUuidLike(existingInitiativeId)) return node;

		    const runCtx = node.runId ? contexts.runs[node.runId] : null;
		    if (runCtx && runCtx.initiativeId && runCtx.initiativeId.trim().length > 0) {
		      const initiativeId = runCtx.initiativeId.trim();
		      const groupId = initiativeId;
	      const ctxTitle = (runCtx.initiativeTitle ?? "").trim();
      const groupLabel = ctxTitle || node.groupLabel || initiativeId;

      const existing = groupsById.get(groupId);
      if (!existing) {
        groupsById.set(groupId, {
          id: groupId,
          label: groupLabel,
          status: node.status ?? null,
        });
      } else if (ctxTitle && (existing.label === groupId || existing.label.startsWith("Agent "))) {
        groupsById.set(groupId, { ...existing, label: groupLabel });
      }

      return {
        ...node,
        initiativeId,
        workstreamId: runCtx.workstreamId ?? node.workstreamId ?? null,
        groupId,
        groupLabel,
      };
    }

    const agentId = node.agentId?.trim() ?? "";
    if (!agentId) return node;
    const ctx = contexts.agents[agentId];
    const initiativeId = ctx?.initiativeId?.trim() ?? "";
    if (!initiativeId) return node;

    const groupId = initiativeId;
    const ctxTitle = (ctx as AgentLaunchContext).initiativeTitle?.trim() ?? "";
    const groupLabel = ctxTitle || node.groupLabel || initiativeId;

    const existing = groupsById.get(groupId);
    if (!existing) {
      groupsById.set(groupId, {
        id: groupId,
        label: groupLabel,
        status: node.status ?? null,
      });
    } else if (ctxTitle && (existing.label === groupId || existing.label.startsWith("Agent "))) {
      groupsById.set(groupId, { ...existing, label: groupLabel });
    }

    return {
      ...node,
      initiativeId,
      workstreamId: ctx.workstreamId ?? node.workstreamId ?? null,
      groupId,
      groupLabel,
    };
  });

  // Ensure every node's group exists.
  for (const node of nodes) {
    if (!groupsById.has(node.groupId)) {
      groupsById.set(node.groupId, {
        id: node.groupId,
        label: node.groupLabel || node.groupId,
        status: node.status ?? null,
      });
    }
  }

  return {
    ...input,
    nodes,
    groups: Array.from(groupsById.values()),
  };
}

function applyAgentContextsToActivity(
  input: LiveActivityItem[],
  contexts: { agents: Record<string, AgentLaunchContext>; runs: Record<string, RunLaunchContext> }
): LiveActivityItem[] {
  if (!Array.isArray(input)) return [];
  return input.map((item) => {
    let nextItem = item;
    const existingInitiativeId = (item.initiativeId ?? "").trim();

    if (!isUuidLike(existingInitiativeId)) {
      const runCtx = item.runId ? contexts.runs[item.runId] : null;
      if (runCtx && runCtx.initiativeId && runCtx.initiativeId.trim().length > 0) {
        const initiativeId = runCtx.initiativeId.trim();
        const metadata =
          item.metadata && typeof item.metadata === "object"
            ? { ...(item.metadata as Record<string, unknown>) }
            : {};
        metadata.orgx_context = {
          initiativeId,
          workstreamId: runCtx.workstreamId ?? null,
          taskId: runCtx.taskId ?? null,
          updatedAt: runCtx.updatedAt,
        };

        nextItem = {
          ...item,
          initiativeId,
          metadata,
        };
      } else {
        const agentId = item.agentId?.trim() ?? "";
        if (agentId) {
          const ctx = contexts.agents[agentId];
          const initiativeId = ctx?.initiativeId?.trim() ?? "";
          if (initiativeId) {
            const metadata =
              item.metadata && typeof item.metadata === "object"
                ? { ...(item.metadata as Record<string, unknown>) }
                : {};
            metadata.orgx_context = {
              initiativeId,
              workstreamId: ctx.workstreamId ?? null,
              taskId: ctx.taskId ?? null,
              updatedAt: ctx.updatedAt,
            };

            nextItem = {
              ...item,
              initiativeId,
              metadata,
            };
          }
        }
      }
    }

    return enrichActivityActorFields(nextItem);
  });
}

function mergeSessionTrees(
  base: SessionTreeResponse,
  extra: SessionTreeResponse
): SessionTreeResponse {
  const seenNodes = new Set<string>();
  const nodes: SessionTreeResponse["nodes"] = [];

  for (const node of base.nodes ?? []) {
    seenNodes.add(node.id);
    nodes.push(node);
  }
  for (const node of extra.nodes ?? []) {
    if (seenNodes.has(node.id)) continue;
    seenNodes.add(node.id);
    nodes.push(node);
  }

  const seenEdges = new Set<string>();
  const edges: SessionTreeResponse["edges"] = [];
  for (const edge of base.edges ?? []) {
    const key = `${edge.parentId}→${edge.childId}`;
    seenEdges.add(key);
    edges.push(edge);
  }
  for (const edge of extra.edges ?? []) {
    const key = `${edge.parentId}→${edge.childId}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push(edge);
  }

  const groupsById = new Map<string, { id: string; label: string; status: string | null }>();
  for (const group of base.groups ?? []) {
    groupsById.set(group.id, group);
  }
  for (const group of extra.groups ?? []) {
    const existing = groupsById.get(group.id);
    if (!existing) {
      groupsById.set(group.id, group);
      continue;
    }
    const nextLabel =
      existing.label === existing.id && group.label && group.label !== group.id
        ? group.label
        : existing.label;
    groupsById.set(group.id, { ...existing, label: nextLabel });
  }

  return {
    nodes,
    edges,
    groups: Array.from(groupsById.values()),
  };
}

function mergeActivities(
  base: LiveActivityItem[],
  extra: LiveActivityItem[],
  limit: number
): LiveActivityItem[] {
  const asMetadataRecord = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  };

  const metadataString = (
    metadata: Record<string, unknown> | null,
    keys: string[]
  ): string | null => {
    if (!metadata) return null;
    for (const key of keys) {
      const value = metadata[key];
      if (typeof value !== "string") continue;
      const normalized = value.trim();
      if (normalized.length > 0) return normalized;
    }
    return null;
  };

  const semanticEvents = new Set([
    "autopilot_slice_result",
    "auto_continue_started",
    "auto_continue_stopped",
    "next_up_manual_dispatch_started",
    "autopilot_slice_mcp_handshake_failed",
    "autopilot_slice_timeout",
    "autopilot_slice_log_stall",
    "auto_continue_spawn_guard_blocked",
    "auto_continue_spawn_guard_rate_limited",
    "autopilot_autofix_scheduled",
    "autopilot_autofix_executed",
    "autopilot_autofix_skipped",
  ]);

  const semanticActivityKey = (item: LiveActivityItem): string | null => {
    const metadata = asMetadataRecord(item.metadata);
    const eventRaw = metadata?.event;
    const event =
      typeof eventRaw === "string" ? eventRaw.trim().toLowerCase() : "";
    if (!event || !semanticEvents.has(event)) return null;

    const runLike =
      (typeof item.runId === "string" && item.runId.trim().length > 0
        ? item.runId.trim()
        : null) ??
      metadataString(metadata, [
        "run_id",
        "runId",
        "slice_run_id",
        "sliceRunId",
        "active_run_id",
        "activeRunId",
        "last_run_id",
        "lastRunId",
      ]);
    const correlationId = metadataString(metadata, ["correlation_id", "correlationId"]);
    const initiativeId =
      (typeof item.initiativeId === "string" && item.initiativeId.trim().length > 0
        ? item.initiativeId.trim()
        : null) ??
      metadataString(metadata, ["initiative_id", "initiativeId"]);
    const workstreamId = metadataString(metadata, ["workstream_id", "workstreamId"]);
    const taskId = metadataString(metadata, ["task_id", "taskId"]);
    const stopReason = metadataString(metadata, ["stop_reason", "stopReason"]);
    const parsedStatus = metadataString(metadata, ["parsed_status", "parsedStatus"]);
    const title = (item.title ?? "").trim().toLowerCase();

    if (!runLike && !correlationId && !workstreamId && !taskId) return null;

    return [
      event,
      initiativeId ?? "",
      workstreamId ?? "",
      taskId ?? "",
      runLike ?? "",
      correlationId ?? "",
      stopReason ?? "",
      parsedStatus ?? "",
      title,
    ].join("|");
  };

  const merged = [...(base ?? []), ...(extra ?? [])].sort((a, b) => {
    const timestampDelta = Date.parse(b.timestamp) - Date.parse(a.timestamp);
    if (timestampDelta !== 0) return timestampDelta;
    return b.id.localeCompare(a.id);
  });
  const deduped: LiveActivityItem[] = [];
  const seenIds = new Set<string>();
  const seenSemantic = new Set<string>();
  for (const item of merged) {
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    const semanticKey = semanticActivityKey(item);
    if (semanticKey && seenSemantic.has(semanticKey)) continue;
    if (semanticKey) seenSemantic.add(semanticKey);
    deduped.push(item);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

function normalizeRuntimeSourceForReporting(
  value: RuntimeSourceClient
): "openclaw" | "codex" | "claude-code" | "api" {
  if (value === "codex") return "codex";
  if (value === "claude-code") return "claude-code";
  if (value === "api") return "api";
  return "openclaw";
}

function normalizeHookPhase(value: string | null): "intent" | "execution" | "blocked" | "review" | "handoff" | "completed" {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "intent") return "intent";
  if (normalized === "execution") return "execution";
  if (normalized === "blocked") return "blocked";
  if (normalized === "review") return "review";
  if (normalized === "handoff") return "handoff";
  if (normalized === "completed") return "completed";
  return "execution";
}

function normalizeRuntimeSource(value: unknown): RuntimeSourceClient {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "openclaw") return "openclaw";
  if (normalized === "codex") return "codex";
  if (normalized === "claude-code") return "claude-code";
  if (normalized === "api") return "api";
  return "unknown";
}

function runtimeSourceDefaultAgentLabel(sourceClient: RuntimeSourceClient): string | null {
  if (sourceClient === "codex") return "Codex";
  if (sourceClient === "claude-code") return "Claude Code";
  if (sourceClient === "openclaw") return "OpenClaw";
  if (sourceClient === "api") return "OrgX API";
  return null;
}

function runtimeSourceDefaultAgentId(sourceClient: RuntimeSourceClient): string | null {
  if (sourceClient === "codex") return "runtime:codex";
  if (sourceClient === "claude-code") return "runtime:claude-code";
  if (sourceClient === "openclaw") return "runtime:openclaw";
  if (sourceClient === "api") return "runtime:api";
  return null;
}

function deriveRuntimeFallbackAgent(
  instance: RuntimeInstanceRecord
): { agentId: string | null; agentName: string | null } {
  const sourceClient = normalizeRuntimeSource(instance.sourceClient);
  const agentId = (instance.agentId ?? "").trim() || runtimeSourceDefaultAgentId(sourceClient);
  const agentName =
    (instance.agentName ?? "").trim() ||
    (instance.displayName ?? "").trim() ||
    runtimeSourceDefaultAgentLabel(sourceClient);
  return {
    agentId: agentId || null,
    agentName: agentName || null,
  };
}

function deriveRuntimeSessionStatus(instance: RuntimeInstanceRecord): SessionTreeNode["status"] {
  const state = (instance.state ?? "").trim().toLowerCase();
  const phase = (instance.phase ?? "").trim().toLowerCase();
  if (phase === "blocked" || state === "error") return "blocked";
  if (phase === "completed") return "completed";
  if (phase === "handoff") return "handoff";
  if (phase === "review") return "review";
  if (state === "stopped") return "paused";
  if (state === "stale") return "queued";
  return "running";
}

function runtimeMatchMaps(instances: RuntimeInstanceRecord[]) {
  const byRunId = new Map<string, RuntimeInstanceRecord>();
  const byAgentInitiative = new Map<string, RuntimeInstanceRecord>();

  for (const instance of instances) {
    if (instance.runId && !byRunId.has(instance.runId)) {
      byRunId.set(instance.runId, instance);
    }
    const agentId = instance.agentId?.trim() ?? "";
    const initiativeId = instance.initiativeId?.trim() ?? "";
    if (!agentId || !initiativeId) continue;
    const key = `${agentId}:${initiativeId}`;
    if (!byAgentInitiative.has(key)) {
      byAgentInitiative.set(key, instance);
    }
  }

  return { byRunId, byAgentInitiative };
}

function enrichSessionsWithRuntime(
  input: SessionTreeResponse,
  instances: RuntimeInstanceRecord[]
): SessionTreeResponse {
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) return input;
  if (instances.length === 0) return input;
  const { byRunId, byAgentInitiative } = runtimeMatchMaps(instances);

  const nodes = input.nodes.map((node) => {
    const byRun = node.runId ? byRunId.get(node.runId) ?? null : null;
    const byAgent =
      !byRun && node.agentId && node.initiativeId
        ? byAgentInitiative.get(`${node.agentId}:${node.initiativeId}`) ?? null
        : null;
    const match = byRun ?? byAgent;
    if (!match) return node;
    const runtimeStatus = deriveRuntimeSessionStatus(match);
    const fallbackAgent = deriveRuntimeFallbackAgent(match);
    const agentId = (node.agentId ?? "").trim() || fallbackAgent.agentId;
    const agentName = (node.agentName ?? "").trim() || fallbackAgent.agentName;
    const nodeStatus = (node.status ?? "").trim().toLowerCase();
    const isTerminalNodeStatus =
      nodeStatus === "completed" ||
      nodeStatus === "cancelled" ||
      nodeStatus === "archived";
    const isLiveLikeNodeStatus =
      nodeStatus === "running" ||
      nodeStatus === "active" ||
      nodeStatus === "in_progress" ||
      nodeStatus === "working" ||
      nodeStatus === "planning" ||
      nodeStatus === "dispatching";
    const shouldDowngradeStatusFromRuntime =
      isLiveLikeNodeStatus && (runtimeStatus === "queued" || runtimeStatus === "paused");
    const shouldPromoteStatusFromRuntime =
      runtimeStatus === "completed" ||
      runtimeStatus === "blocked" ||
      runtimeStatus === "review" ||
      runtimeStatus === "handoff" ||
      (runtimeStatus === "running" &&
        (nodeStatus === "blocked" ||
          nodeStatus === "failed" ||
          nodeStatus === "queued" ||
          nodeStatus === "paused"));
    const nextStatus =
      shouldDowngradeStatusFromRuntime ||
      (!isTerminalNodeStatus && shouldPromoteStatusFromRuntime)
        ? runtimeStatus
        : node.status;
    const runtimeExplicitlyBlocked =
      runtimeStatus === "blocked" || match.phase?.toLowerCase() === "blocked";
    const runtimeExplicitlyUnblocked =
      !runtimeExplicitlyBlocked && typeof match.phase === "string" && match.phase.trim().length > 0;
    const runtimeBlockedReason = (match.lastMessage ?? "").trim();
    const nextBlockerReason = runtimeExplicitlyBlocked
      ? runtimeBlockedReason || (node.blockerReason ?? "").trim() || null
      : runtimeExplicitlyUnblocked
        ? null
        : node.blockerReason ?? null;
    const nextBlockers = runtimeExplicitlyBlocked
      ? runtimeBlockedReason
        ? [runtimeBlockedReason]
        : Array.isArray(node.blockers)
          ? node.blockers
          : []
      : runtimeExplicitlyUnblocked
        ? []
        : Array.isArray(node.blockers)
          ? node.blockers
          : [];

    return {
      ...node,
      agentId: agentId || null,
      agentName: agentName || null,
      status: nextStatus,
      state: node.state ?? match.state ?? null,
      lastEventSummary:
        shouldDowngradeStatusFromRuntime && runtimeStatus === "queued"
          ? node.lastEventSummary ?? "Recovered stale runtime; awaiting next dispatch."
          : node.lastEventSummary,
      blockers: nextBlockers,
      blockerReason: nextBlockerReason,
      runtimeClient: normalizeRuntimeSource(match.sourceClient),
      runtimeLabel: match.displayName,
      runtimeProvider: match.providerLogo,
      instanceId: match.id,
      lastHeartbeatAt: match.lastHeartbeatAt ?? null,
    };
  });

  return { ...input, nodes };
}

function metadataHasStructuredScope(meta: Record<string, unknown>): boolean {
  const scalarScope =
    pickString(meta, [
      "initiative_id",
      "initiativeId",
      "workstream_id",
      "workstreamId",
      "workstream_title",
      "workstreamTitle",
      "task_id",
      "taskId",
      "task_title",
      "taskTitle",
      "slice_run_id",
      "sliceRunId",
      "iwmt_id",
      "iwmtId",
      "milestone_id",
      "milestoneId",
      "milestone_title",
      "milestoneTitle",
    ]) ?? null;
  if (scalarScope) return true;

  const listScopeKeys = [
    "initiative_ids",
    "initiativeIds",
    "workstream_ids",
    "workstreamIds",
    "task_ids",
    "taskIds",
    "milestone_ids",
    "milestoneIds",
    "iwmt_ids",
    "iwmtIds",
  ];
  for (const key of listScopeKeys) {
    const value = meta[key];
    if (!Array.isArray(value)) continue;
    if (
      value.some((entry) => typeof entry === "string" && entry.trim().length > 0)
    ) {
      return true;
    }
  }
  return false;
}

function shouldInjectRuntimeInstanceAsSession(
  instance: RuntimeInstanceRecord,
  runId: string,
  meta: Record<string, unknown>
): boolean {
  if (instance.state !== "active") return false;
  // Synthetic hook correlation ids are telemetry-only and should never render as user-facing sessions.
  if (runId.toLowerCase().startsWith("hook-")) return false;

  const workstreamId = instance.workstreamId?.trim() ?? "";
  const taskId = instance.taskId?.trim() ?? "";
  if (workstreamId.length > 0 || taskId.length > 0) return true;

  // Keep only runtime records that include structured execution scope.
  return metadataHasStructuredScope(meta);
}

function injectRuntimeInstancesAsSessions(
  input: SessionTreeResponse,
  instances: RuntimeInstanceRecord[]
): SessionTreeResponse {
  if (!Array.isArray(input.nodes)) return input;
  if (!Array.isArray(instances) || instances.length === 0) return input;

  const nodes = [...input.nodes];
  const edges = Array.isArray(input.edges) ? input.edges : [];
  const groups = [...(input.groups ?? [])];

  const existingRunIds = new Set<string>();
  const existingNodeIds = new Set<string>();
  for (const node of nodes) {
    existingNodeIds.add(node.id);
    if (node.runId) existingRunIds.add(node.runId);
  }

  const groupsById = new Map(groups.map((group) => [group.id, group]));

  for (const instance of instances) {
    if (!instance || typeof instance !== "object") continue;
    const runId = instance.runId?.trim() || instance.correlationId?.trim() || "";
    if (!runId) continue;
    if (existingRunIds.has(runId)) continue;

    const initiativeId = instance.initiativeId?.trim() || null;
    const workstreamId = instance.workstreamId?.trim() || null;
    const runtimeClient = normalizeRuntimeSource(instance.sourceClient);
    const fallbackAgent = deriveRuntimeFallbackAgent(instance);
    const groupId = initiativeId ?? fallbackAgent.agentId ?? `runtime:${runtimeClient}`;

    const meta =
      instance.metadata && typeof instance.metadata === "object"
        ? (instance.metadata as Record<string, unknown>)
        : {};
    if (!shouldInjectRuntimeInstanceAsSession(instance, runId, meta)) continue;
    const titleHint =
      pickString(meta, ["workstream_title", "workstreamTitle"]) ??
      (workstreamId ? `Workstream ${workstreamId.slice(0, 8)}` : null);
    const initiativeHint =
      pickString(meta, ["initiative_title", "initiativeTitle"]) ??
      (initiativeId ? `Initiative ${initiativeId.slice(0, 8)}` : null);
    const groupLabel =
      (initiativeHint ?? fallbackAgent.agentName ?? groupId).trim();

    if (!groupsById.has(groupId)) {
      const group = { id: groupId, label: groupLabel, status: null };
      groupsById.set(groupId, group);
      groups.push(group);
    }

    const nodeId = `runtime:${instance.id}`;
    if (existingNodeIds.has(nodeId)) continue;
    existingNodeIds.add(nodeId);
    existingRunIds.add(runId);
    const status = deriveRuntimeSessionStatus(instance);
    const blockerReason = status === "blocked" ? (instance.lastMessage ?? null) : null;
    const blockers =
      status === "blocked" && typeof blockerReason === "string" && blockerReason.trim().length > 0
        ? [blockerReason.trim()]
        : [];

    const node: SessionTreeNode = {
      id: nodeId,
      parentId: null,
      runId,
      title: titleHint ?? instance.lastMessage ?? `Runtime ${runId.slice(0, 8)}`,
      agentId: fallbackAgent.agentId,
      agentName: fallbackAgent.agentName,
      status,
      progress: instance.progressPct ?? null,
      initiativeId,
      workstreamId,
      groupId,
      groupLabel,
      startedAt: instance.createdAt ?? instance.lastEventAt ?? null,
      updatedAt: instance.updatedAt ?? null,
      lastEventAt: instance.lastEventAt ?? null,
      lastEventSummary: instance.lastMessage ?? null,
      blockers,
      blockerReason,
      phase: (instance.phase as any) ?? null,
      state: instance.state ?? null,
      runtimeClient,
      runtimeLabel: instance.displayName,
      runtimeProvider: instance.providerLogo,
      instanceId: instance.id,
      lastHeartbeatAt: instance.lastHeartbeatAt ?? null,
    };
    nodes.push(node);
  }

  return { nodes, edges, groups };
}

function enrichActivityWithRuntime(
  input: LiveActivityItem[],
  instances: RuntimeInstanceRecord[]
): LiveActivityItem[] {
  if (!Array.isArray(input) || input.length === 0) return [];
  if (instances.length === 0) return input;
  const { byRunId, byAgentInitiative } = runtimeMatchMaps(instances);

  return input.map((item) => {
    const byRun = item.runId ? byRunId.get(item.runId) ?? null : null;
    const byAgent =
      !byRun && item.agentId && item.initiativeId
        ? byAgentInitiative.get(`${item.agentId}:${item.initiativeId}`) ?? null
        : null;
    const match = byRun ?? byAgent;
    if (!match) return item;

    return {
      ...item,
      runtimeClient: normalizeRuntimeSource(match.sourceClient),
      runtimeLabel: match.displayName,
      runtimeProvider: match.providerLogo,
      instanceId: match.id,
      lastHeartbeatAt: match.lastHeartbeatAt ?? null,
    };
  });
}

// =============================================================================
// Types — mirrors the Node http.IncomingMessage / http.ServerResponse pattern
// that Clawdbot provides to plugin HTTP handlers.
// =============================================================================

interface PluginRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  once?: (event: string, listener: (...args: unknown[]) => void) => void;
}

interface PluginResponse {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string | Buffer): void;
  write?(chunk: string | Buffer): boolean | void;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  once?: (event: string, listener: (...args: unknown[]) => void) => void;
  writableEnded?: boolean;
}

interface OnboardingController {
  getState: () => OnboardingState;
  startPairing: (input: {
    openclawVersion?: string;
    platform?: string;
    deviceName?: string;
  }) => Promise<{
    pairingId: string;
    connectUrl: string;
    expiresAt: string;
    pollIntervalMs: number;
    state: OnboardingState;
  }>;
  getStatus: () => Promise<OnboardingState>;
  submitManualKey: (input: {
    apiKey: string;
    userId?: string;
  }) => Promise<OnboardingState>;
  disconnect: () => Promise<OnboardingState>;
}

interface DiagnosticsProvider {
  getHealth?: (input?: { probeRemote?: boolean }) => Promise<unknown>;
}

// =============================================================================
// Content-Type mapping
// =============================================================================

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

function contentType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

// =============================================================================
// CORS + response hardening
// =============================================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-OrgX-Api-Key, X-API-Key, X-OrgX-User-Id, X-OrgX-Hook-Token, X-Hook-Token",
  Vary: "Origin",
};

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "media-src 'self'",
  "connect-src 'self' https://*.useorgx.com https://*.openclaw.ai https://api.openai.com https://*.openai.com http://127.0.0.1:* http://localhost:*",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet, noimageindex",
  "Permissions-Policy": "camera=(), microphone=(self), geolocation=(), payment=(), usb=(), midi=(), magnetometer=(), gyroscope=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Origin-Agent-Cluster": "?1",
  "X-Permitted-Cross-Domain-Policies": "none",
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
};

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isTrustedOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function isTrustedRequestSource(
  headers: Record<string, string | string[] | undefined>
): boolean {
  const fetchSite = pickHeaderString(headers, ["sec-fetch-site"]);
  if (fetchSite) {
    const normalizedFetchSite = fetchSite.trim().toLowerCase();
    if (
      normalizedFetchSite !== "same-origin" &&
      normalizedFetchSite !== "same-site" &&
      normalizedFetchSite !== "none"
    ) {
      return false;
    }
  }

  const origin = pickHeaderString(headers, ["origin"]);
  if (origin) {
    return isTrustedOrigin(origin);
  }

  const referer = pickHeaderString(headers, ["referer"]);
  if (referer) {
    try {
      return isTrustedOrigin(new URL(referer).origin);
    } catch {
      return false;
    }
  }

  return true;
}

const STREAM_IDLE_TIMEOUT_MS = 60_000;

// =============================================================================
// Resolve the dashboard/dist/ directory relative to this file
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DIST_DIR = resolve(__dirname, "..", "..", "dashboard", "dist");
const RESOLVED_DIST_DIR = resolve(DIST_DIR);
const RESOLVED_DIST_ASSETS_DIR = resolve(DIST_DIR, "assets");

function resolveSafeDistPath(subPath: string): string | null {
  if (!subPath || subPath.includes("\0")) return null;

  const normalized = normalize(subPath).replace(/^([/\\])+/, "");
  if (!normalized || normalized === ".") return null;

  const candidate = resolve(DIST_DIR, normalized);
  const rel = relative(RESOLVED_DIST_DIR, candidate);
  if (!rel || rel === "." || rel.startsWith("..") || rel.includes(`..${sep}`)) {
    return null;
  }

  return candidate;
}

// =============================================================================
// Helpers
// =============================================================================

type StaticCompressionEncoding = "br" | "gzip";

type ImmutableFileCacheEntry = {
  content: Buffer;
  contentType: string;
  contentEncoding: StaticCompressionEncoding | null;
  varyAcceptEncoding: boolean;
};

const PRECOMPRESSED_FILE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".svg",
  ".txt",
  ".xml",
]);

const IMMUTABLE_FILE_CACHE = new Map<string, ImmutableFileCacheEntry>();
const IMMUTABLE_FILE_CACHE_MAX = 128;
const FILE_PREVIEW_MAX_BYTES = 1_000_000;
const FILE_PREVIEW_MAX_DIR_ENTRIES = 300;
const AUTOPILOT_LOGS_DIR = join(
  homedir(),
  ".config",
  "useorgx",
  "openclaw-plugin",
  "autopilot-logs"
);
const execFileAsync = promisify(execFile);

function sendJson(
  res: PluginResponse,
  status: number,
  data: unknown
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    // Avoid browser/proxy caching for live dashboards.
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...CORS_HEADERS,
  });
  res.end(body);
}

function sendHtml(res: PluginResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...CORS_HEADERS,
  });
  res.end(html);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function resolveFilesystemOpenPath(rawPath: string): string {
  let value = rawPath.trim();
  if (value.toLowerCase().startsWith("file://")) {
    value = value.replace(/^file:\/\//i, "");
    try {
      value = decodeURIComponent(value);
    } catch {
      // best effort
    }
    if (process.platform === "win32" && value.startsWith("/")) {
      value = value.slice(1);
    }
  }

  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }

  const looksWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(value);
  if (value.startsWith("/") || looksWindowsAbsolute) {
    return resolve(value);
  }

  return resolve(process.cwd(), value);
}

function resolveAutopilotLogCandidates(runId: string): string[] {
  const sanitizedRunId = runId.trim().replaceAll(/[\\/]/g, "");
  if (!sanitizedRunId) return [];

  const directCandidates = [
    join(AUTOPILOT_LOGS_DIR, `${sanitizedRunId}.log`),
    join(AUTOPILOT_LOGS_DIR, `${sanitizedRunId}.output.json`),
  ];

  if (!existsSync(AUTOPILOT_LOGS_DIR)) {
    return directCandidates;
  }

  const discovered = readdirSync(AUTOPILOT_LOGS_DIR)
    .filter((entry) => entry.startsWith(`${sanitizedRunId}.`))
    .map((entry) => join(AUTOPILOT_LOGS_DIR, entry))
    .filter((entry) => entry.endsWith(".log") || entry.endsWith(".output.json"));

  return dedupeStrings([...directCandidates, ...discovered]);
}

async function openPathInTerminal(pathname: string): Promise<void> {
  const resolvedPath = resolve(pathname);
  if (process.platform === "darwin") {
    const escapedPath = resolvedPath
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"');
    await execFileAsync("osascript", [
      "-e",
      'tell application "Terminal" to activate',
      "-e",
      `tell application "Terminal" to do script "tail -f \\"${escapedPath}\\""`,
    ]);
    return;
  }

  if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", resolvedPath]);
    return;
  }

  try {
    await execFileAsync("gnome-terminal", ["--", "tail", "-f", resolvedPath]);
    return;
  } catch {
    // Fallback to generic opener when no terminal app is available.
  }

  await execFileAsync("xdg-open", [resolvedPath]);
}

function readFilePreview(pathname: string, totalBytes: number): {
  previewBuffer: Buffer;
  truncated: boolean;
} {
  if (totalBytes <= 0) {
    return { previewBuffer: Buffer.alloc(0), truncated: false };
  }

  const previewBytes = Math.min(totalBytes, FILE_PREVIEW_MAX_BYTES);
  const previewBuffer = Buffer.alloc(previewBytes);
  const fd = openSync(pathname, "r");
  try {
    const bytesRead = readSync(fd, previewBuffer, 0, previewBytes, 0);
    if (bytesRead < previewBytes) {
      return {
        previewBuffer: previewBuffer.subarray(0, bytesRead),
        truncated: totalBytes > bytesRead,
      };
    }
    return {
      previewBuffer,
      truncated: totalBytes > previewBytes,
    };
  } finally {
    closeSync(fd);
  }
}

function parseAcceptedEncodings(
  rawHeader: string | null | undefined
): Map<string, number> {
  const parsed = new Map<string, number>();
  if (!rawHeader || rawHeader.trim().length === 0) return parsed;

  const parts = rawHeader.split(",");
  for (const part of parts) {
    const [nameRaw, ...params] = part.split(";");
    const name = nameRaw?.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const [keyRaw, valueRaw] = param.split("=");
      const key = keyRaw?.trim().toLowerCase();
      if (key !== "q") continue;
      const candidate = Number.parseFloat((valueRaw ?? "").trim());
      if (Number.isFinite(candidate)) {
        q = candidate;
      }
    }
    if (q <= 0) continue;
    const existing = parsed.get(name);
    if (existing == null || q > existing) {
      parsed.set(name, q);
    }
  }
  return parsed;
}

function resolveEncodingQuality(
  accepted: Map<string, number>,
  encoding: StaticCompressionEncoding
): number {
  if (accepted.has(encoding)) return accepted.get(encoding) ?? 0;
  if (accepted.has("*")) return accepted.get("*") ?? 0;
  return 0;
}

function resolvePrecompressedVariant(
  req: PluginRequest,
  filePath: string
): { path: string; encoding: StaticCompressionEncoding } | null {
  const ext = extname(filePath).toLowerCase();
  if (!PRECOMPRESSED_FILE_EXTENSIONS.has(ext)) return null;

  const accepted = parseAcceptedEncodings(
    pickHeaderString(req.headers, ["accept-encoding"])
  );
  if (accepted.size === 0) return null;

  const candidates: Array<{
    encoding: StaticCompressionEncoding;
    path: string;
    quality: number;
    priority: number;
  }> = [
    {
      encoding: "br",
      path: `${filePath}.br`,
      quality: resolveEncodingQuality(accepted, "br"),
      priority: 2,
    },
    {
      encoding: "gzip",
      path: `${filePath}.gz`,
      quality: resolveEncodingQuality(accepted, "gzip"),
      priority: 1,
    },
  ];

  candidates.sort((left, right) => {
    if (right.quality !== left.quality) return right.quality - left.quality;
    return right.priority - left.priority;
  });

  for (const candidate of candidates) {
    if (candidate.quality <= 0) continue;
    if (existsSync(candidate.path)) {
      return { path: candidate.path, encoding: candidate.encoding };
    }
  }
  return null;
}

function sendFile(
  req: PluginRequest,
  res: PluginResponse,
  filePath: string,
  cacheControl: string
): void {
  try {
    const shouldCacheImmutable = cacheControl.includes("immutable");
    const shouldVaryByEncoding = PRECOMPRESSED_FILE_EXTENSIONS.has(
      extname(filePath).toLowerCase()
    );
    const precompressed = resolvePrecompressedVariant(req, filePath);
    const responsePath = precompressed?.path ?? filePath;
    const responseEncoding = precompressed?.encoding ?? null;
    const cacheKey = `${responsePath}|${cacheControl}`;
    if (shouldCacheImmutable) {
      const cached = IMMUTABLE_FILE_CACHE.get(cacheKey);
      if (cached) {
        const headers: Record<string, string> = {
          "Content-Type": cached.contentType,
          "Cache-Control": cacheControl,
          ...SECURITY_HEADERS,
          ...CORS_HEADERS,
        };
        if (cached.contentEncoding === "br") headers["Content-Encoding"] = "br";
        if (cached.contentEncoding === "gzip") headers["Content-Encoding"] = "gzip";
        if (cached.varyAcceptEncoding) headers["Vary"] = "Accept-Encoding";
        res.writeHead(200, {
          ...headers,
        });
        res.end(cached.content);
        return;
      }
    }

    const content = readFileSync(responsePath);
    const type = contentType(filePath);
    if (shouldCacheImmutable) {
      if (IMMUTABLE_FILE_CACHE.size >= IMMUTABLE_FILE_CACHE_MAX) {
        const firstKey = IMMUTABLE_FILE_CACHE.keys().next().value as string | undefined;
        if (firstKey) IMMUTABLE_FILE_CACHE.delete(firstKey);
      }
      IMMUTABLE_FILE_CACHE.set(cacheKey, {
        content,
        contentType: type,
        contentEncoding: responseEncoding,
        varyAcceptEncoding: shouldVaryByEncoding,
      });
    }

    const headers: Record<string, string> = {
      "Content-Type": type,
      "Cache-Control": cacheControl,
      ...SECURITY_HEADERS,
      ...CORS_HEADERS,
    };
    if (responseEncoding === "br") headers["Content-Encoding"] = "br";
    if (responseEncoding === "gzip") headers["Content-Encoding"] = "gzip";
    if (shouldVaryByEncoding) headers["Vary"] = "Accept-Encoding";

    res.writeHead(200, headers);
    res.end(content);
  } catch {
    send404(res);
  }
}

function send404(res: PluginResponse): void {
  res.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    ...SECURITY_HEADERS,
    ...CORS_HEADERS,
  });
  res.end("Not Found");
}

function sendStaleChunkRecovery(res: PluginResponse): void {
  const body = [
    "// Recover from stale chunk references after dashboard/plugin upgrades.",
    "window.location.replace('/orgx/live' + window.location.search);",
    "export {};"
  ].join("\n");
  res.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    ...SECURITY_HEADERS,
    ...CORS_HEADERS,
  });
  res.end(body);
}

function sendIndexHtml(req: PluginRequest, res: PluginResponse): void {
  const indexPath = join(DIST_DIR, "index.html");
  if (existsSync(indexPath)) {
    sendFile(req, res, indexPath, "no-cache, no-store, must-revalidate");
  } else {
    res.writeHead(503, {
      "Content-Type": "text/html; charset=utf-8",
      ...SECURITY_HEADERS,
      ...CORS_HEADERS,
    });
    res.end(
      "<html><body><h1>Dashboard not built</h1>" +
        "<p>Run <code>cd dashboard &amp;&amp; npm run build</code> to build the SPA.</p>" +
        "</body></html>"
    );
  }
}

function parseJsonBody(body: unknown): Record<string, unknown> {
  if (!body) return {};
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (Buffer.isBuffer(body)) {
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (body instanceof Uint8Array) {
    try {
      const parsed = JSON.parse(Buffer.from(body).toString("utf8"));
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (body instanceof ArrayBuffer) {
    try {
      const parsed = JSON.parse(Buffer.from(body).toString("utf8"));
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof body === "object") {
    return body as Record<string, unknown>;
  }
  return {};
}

const MAX_JSON_BODY_BYTES = 1_000_000;
const JSON_BODY_TIMEOUT_MS = 2_000;

function chunkToBuffer(chunk: unknown): Buffer {
  if (!chunk) return Buffer.alloc(0);
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  try {
    return Buffer.from(JSON.stringify(chunk), "utf8");
  } catch {
    return Buffer.from(String(chunk), "utf8");
  }
}

async function readRequestBodyBuffer(req: PluginRequest): Promise<Buffer | null> {
  const on = req.on ? req.on.bind(req) : null;
  if (!on) return null;

  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let finished = false;

    const finish = (buffer: Buffer | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(buffer);
    };

    const timer = setTimeout(() => finish(null), JSON_BODY_TIMEOUT_MS);

    on("data", (chunk: unknown) => {
      const buf = chunkToBuffer(chunk);
      if (buf.length === 0) return;
      totalBytes += buf.length;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        finish(null);
        return;
      }
      chunks.push(buf);
    });

    const onDone = () => {
      if (chunks.length === 0) {
        finish(Buffer.alloc(0));
      } else {
        finish(Buffer.concat(chunks, totalBytes));
      }
    };

    const once = (req.once ?? req.on)?.bind(req) ?? null;
    if (once) {
      once("end", onDone);
      once("error", () => finish(null));
    } else {
      on("end", onDone);
      on("error", () => finish(null));
    }
  });
}

async function parseJsonRequest(req: PluginRequest): Promise<Record<string, unknown>> {
  const body = req.body;

  if (typeof body === "string" && body.length > 0) {
    return parseJsonBody(body);
  }
  if (Buffer.isBuffer(body) && body.length > 0) {
    return parseJsonBody(body);
  }
  if (body instanceof Uint8Array && body.byteLength > 0) {
    return parseJsonBody(body);
  }
  if (body instanceof ArrayBuffer && body.byteLength > 0) {
    return parseJsonBody(body);
  }
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
    return parseJsonBody(body);
  }

  const streamed = await readRequestBodyBuffer(req);
  if (!streamed || streamed.length === 0) {
    return {};
  }
  return parseJsonBody(streamed);
}

// =============================================================================
// Factory
// =============================================================================

export function createHttpHandler(
  config: OrgXConfig & { dashboardEnabled?: boolean; pluginVersion?: string; installationId?: string | null },
  client: OrgXClient,
  getSnapshot: () => OrgSnapshot | null,
  onboarding: OnboardingController,
  diagnostics?: DiagnosticsProvider,
  adapters?: { outbox?: OutboxAdapter; openclaw?: OpenClawAdapter }
) {
  const dashboardEnabled =
    (config as OrgXConfig & { dashboardEnabled?: boolean }).dashboardEnabled ??
    true;
  const outboxAdapter = adapters?.outbox ?? defaultOutboxAdapter;
  const openclawAdapter = adapters?.openclaw ?? {};

  const listAgents = openclawAdapter.listAgents ?? listOpenClawAgents;
  const spawnAgentTurn = openclawAdapter.spawnAgentTurn ?? spawnOpenClawAgentTurn;
  const stopProcess = openclawAdapter.stopDetachedProcess ?? stopDetachedProcess;
  const pidAlive = openclawAdapter.isPidAlive ?? isPidAlive;

  const telemetryDistinctId =
    (typeof (config as any).installationId === "string" &&
    String((config as any).installationId).trim().length > 0
      ? String((config as any).installationId).trim()
      : null) ?? "orgx-openclaw-plugin";

  const {
    emitActivitySafe,
    requestDecisionSafe,
    checkSpawnGuardSafe,
    extractSpawnGuardModelTier,
    buildPolicyEnforcedMessage,
    resolveDispatchExecutionPolicy,
    enforceSpawnGuardForDispatch,
    syncParentRollupsForTask,
  } = createDispatchLifecycle({
    client,
    pluginVersion: config.pluginVersion,
    randomUUID,
    safeErrorMessage,
    stableHash,
    idempotencyKey,
    pickString,
    deriveStructuredActivityBucket,
  });

  const {
    registerArtifactSafe,
    applyAgentStatusUpdatesSafe,
    resolveAgentDisplayName,
    dispatchFallbackWorkstreamTurn,
  } = createAutopilotOperations({
    client,
    randomUUID,
    safeErrorMessage,
    idempotencyKey,
    resolveDispatchExecutionPolicy,
    enforceSpawnGuardForDispatch,
    buildPolicyEnforcedMessage,
    syncParentRollupsForTask,
    emitActivitySafe,
    extractSpawnGuardModelTier,
    upsertAgentContext,
    upsertRunContext,
    spawnAgentTurn,
    upsertAgentRun,
  });

  // Initiative Auto-Continue (Continuous Execution & Auto-Completion)
  //
  // Keeps dispatching next-up tasks (based on Mission Control readiness) until:
  // - all tasks complete (stop_reason = completed)
  // - tasks are blocked (stop_reason = blocked)
  // - token budget is exhausted (stop_reason = budget_exhausted)
  //
  // This is intentionally conservative:
  // - It never starts a new task if a task run is still active.
  // - It only auto-marks tasks done when the OpenClaw session finishes without
  type NextUpRunnerSource = "assigned" | "inferred" | "fallback";
  type NextUpQueueState = "queued" | "running" | "blocked" | "idle";
  type NextUpExecutionPolicy = MissionControlExecutionPolicy;
  type NextUpRunnerAgent = {
    id: string;
    name: string;
  };

  type NextUpQueueItem = {
    initiativeId: string;
    initiativeTitle: string;
    initiativeStatus: string;
    workstreamId: string;
    workstreamTitle: string;
    workstreamStatus: string;
    nextTaskId: string | null;
    nextTaskTitle: string | null;
    nextTaskPriority: number | null;
    nextTaskDueAt: string | null;
    runnerAgentId: string;
    runnerAgentName: string;
    runnerAgents?: NextUpRunnerAgent[];
    runnerSource: NextUpRunnerSource;
    queueState: NextUpQueueState;
    blockReason: string | null;
    isPinned: boolean;
    pinnedRank: number | null;
    sliceScope?: SliceScope | null;
    sliceTaskIds?: string[];
    sliceTaskCount?: number | null;
    sliceMilestoneId?: string | null;
    executionPolicy?: NextUpExecutionPolicy | null;
    autoContinue: {
      status: "running" | "stopping" | "stopped";
      activeTaskId: string | null;
      activeRunId: string | null;
      activeTaskIds: string[];
      activeRunIds: string[];
      laneState:
        | "idle"
        | "running"
        | "blocked"
        | "waiting_dependency"
        | "rate_limited"
        | "completed"
        | null;
      laneBlockedReason: string | null;
      laneWaitingOnWorkstreamIds: string[];
      laneRetryAt: string | null;
      maxParallelSlices: number;
      parallelMode: "iwmt";
      stopReason:
        | "budget_exhausted"
        | "blocked"
        | "completed"
        | "stopped"
        | "error"
        | null;
      updatedAt: string;
    } | null;
  };

  const normalizeRunnerAgentToken = (value: string | null | undefined): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const normalized = trimmed.toLowerCase();
    if (
      normalized === "main" ||
      normalized === "undefined" ||
      normalized === "null" ||
      normalized === "n/a" ||
      normalized === "na"
    ) {
      return null;
    }
    return trimmed;
  };

  const pushRunnerAgent = (
    target: NextUpRunnerAgent[],
    seen: Set<string>,
    input: { id?: string | null; name?: string | null }
  ) => {
    const agentId = normalizeRunnerAgentToken(input.id ?? null);
    const agentName = normalizeRunnerAgentToken(input.name ?? null);
    if (!agentId && !agentName) return;
    const resolvedId = agentId ?? (agentName as string);
    const dedupeKey = resolvedId.toLowerCase();
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    target.push({
      id: resolvedId,
      name: agentName ?? resolvedId,
    });
  };

  const dedupeWithPrimary = (
    primary: NextUpRunnerAgent[],
    extras: NextUpRunnerAgent[]
  ): NextUpRunnerAgent[] => {
    const merged: NextUpRunnerAgent[] = [];
    const seen = new Set<string>();
    for (const candidate of [...primary, ...extras]) {
      const id = normalizeRunnerAgentToken(candidate.id);
      const name = normalizeRunnerAgentToken(candidate.name);
      if (!id && !name) continue;
      const resolvedId = id ?? (name as string);
      const key = resolvedId.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        id: resolvedId,
        name: name ?? resolvedId,
      });
    }
    return merged;
  };

  const codexBinResolver = createCodexBinResolver();
  const resolveCodexBinInfo = (): CodexBinInfo => codexBinResolver.resolveCodexBinInfo();

  const {
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
  } = createAutoContinueEngine({
    client,
    filename: __filename,
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
    randomUUID,
    fetchKickoffContextSafe,
    renderKickoffMessage,
  });

  const nextUpQueueCache = new Map<
    string,
    {
      expiresAt: number;
      staleUntil: number;
      payload: { items: NextUpQueueItem[]; degraded: string[] };
    }
  >();
  const nextUpQueueInFlight = new Map<
    string,
    Promise<{ items: NextUpQueueItem[]; degraded: string[] }>
  >();

  const PROJECT_INITIATIVE_IDS_CACHE_TTL_MS = 20_000;
  const projectInitiativeIdsCache = new Map<
    string,
    { expiresAt: number; ids: string[] }
  >();
  const commandCenterScopeCache = new Map<
    string,
    { expiresAt: number; exists: boolean }
  >();

  const nextUpQueueCacheKeyFor = (
    initiativeId: string | null,
    projectId?: string | null
  ): string => {
    const normalizedInitiative = initiativeId?.trim() || "__all__";
    const normalizedProject = projectId?.trim() || "__all__";
    return `${normalizedProject}::${normalizedInitiative}`;
  };

  async function listInitiativeIdsForProject(input: {
    projectId: string;
  }): Promise<string[]> {
    const projectId = input.projectId.trim();
    if (!projectId) return [];
    const cached = projectInitiativeIdsCache.get(projectId);
    if (cached && cached.expiresAt > Date.now()) {
      return [...cached.ids];
    }

    const mapInitiativeIds = (
      rows: unknown[],
      opts?: { projectId?: string | null; commandCenterId?: string | null }
    ): string[] => {
      const projectScopeId = opts?.projectId?.trim() ?? "";
      const commandCenterId = opts?.commandCenterId?.trim() ?? "";
      return rows
        .map((entry) => {
          const record = entry as Record<string, unknown>;
          if (projectScopeId) {
            const rowProjectId = pickString(record, ["project_id", "projectId"]) ?? "";
            if (rowProjectId !== projectScopeId) return null;
          }
          if (commandCenterId) {
            const rowCommandCenterId =
              pickString(record, [
                "workspace_id",
                "workspaceId",
                "command_center_id",
                "commandCenterId",
              ]) ?? "";
            if (rowCommandCenterId !== commandCenterId) return null;
          }
          return pickString(record, ["id"]);
        })
        .filter((id): id is string => Boolean(id && id.trim().length > 0));
    };

    const cacheAndReturn = (ids: string[]): string[] => {
      const normalized = dedupeStrings(
        ids
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      );
      projectInitiativeIdsCache.set(projectId, {
        expiresAt: Date.now() + PROJECT_INITIATIVE_IDS_CACHE_TTL_MS,
        ids: normalized,
      });
      return normalized;
    };

    const isKnownCommandCenterScope = async (): Promise<boolean> => {
      const cachedScope = commandCenterScopeCache.get(projectId);
      if (cachedScope && cachedScope.expiresAt > Date.now()) {
        return cachedScope.exists;
      }

      const cacheScope = (exists: boolean): boolean => {
        commandCenterScopeCache.set(projectId, {
          expiresAt: Date.now() + PROJECT_INITIATIVE_IDS_CACHE_TTL_MS,
          exists,
        });
        return exists;
      };

      const hasId = (rows: unknown[]): boolean =>
        rows.some((entry) => {
          const record = entry as Record<string, unknown>;
          const id = pickString(record, ["id"]) ?? "";
          return id === projectId;
        });

      try {
        const byId = await withSoftTimeout(
          "command center scope lookup",
          PROJECT_SCOPE_LOOKUP_TIMEOUT_MS,
          client.listEntities("command_center", {
            id: projectId,
            limit: 1,
          })
        );
        const byIdRows = Array.isArray(byId.data) ? byId.data : [];
        if (hasId(byIdRows)) return cacheScope(true);
      } catch {
        // continue to all-command-center fallback
      }

      try {
        const all = await withSoftTimeout(
          "command center catalog lookup",
          PROJECT_SCOPE_LOOKUP_TIMEOUT_MS,
          client.listEntities("command_center", {
            limit: 100,
          })
        );
        const allRows = Array.isArray(all.data) ? all.data : [];
        return cacheScope(hasId(allRows));
      } catch {
        return cacheScope(false);
      }
    };

    const listInitiativesWithFilters = async (
      filters: Record<string, unknown>
    ): Promise<unknown[]> => {
      const rows: unknown[] = [];
      const pageSize = 100;
      const seenIds = new Set<string>();
      let offset = 0;
      let page = 0;

      while (page < PROJECT_SCOPE_MAX_INITIATIVE_PAGES) {
        const result = await withSoftTimeout(
          "initiative scope lookup",
          PROJECT_SCOPE_LOOKUP_TIMEOUT_MS,
          client.listEntities("initiative", {
            ...filters,
            limit: pageSize,
            offset,
          })
        );
        const pageRows = Array.isArray(result.data) ? result.data : [];
        let addedCount = 0;
        for (const entry of pageRows) {
          const record = entry as Record<string, unknown>;
          const id = pickString(record, ["id"]);
          if (id && seenIds.has(id)) continue;
          if (id) seenIds.add(id);
          rows.push(entry);
          addedCount += 1;
        }

        const hasMoreFlag = Boolean(
          (result as { pagination?: { has_more?: boolean } }).pagination?.has_more
        );
        const likelyMore = hasMoreFlag || pageRows.length >= pageSize;
        if (!likelyMore) break;
        if (addedCount === 0) break;

        offset += pageRows.length;
        page += 1;
      }

      return rows;
    };

    const listLiveInitiativesWithFilters = async (
      filters: Record<string, unknown>
    ): Promise<unknown[]> => {
      // Fast path: request once without status fan-out. Upstream often returns
      // all relevant rows and this avoids 5x paginated round-trips.
      const broadRows = await listInitiativesWithFilters(filters);
      if (broadRows.length > 0) return broadRows;

      // Backward-compat fallback for upstreams that require explicit status.
      const rows: unknown[] = [];
      for (const status of LIVE_WORKSPACE_INITIATIVE_STATUSES) {
        const statusRows = await listInitiativesWithFilters({
          ...filters,
          status,
        });
        rows.push(...statusRows);
      }
      return rows;
    };

    try {
      // Workspace selection in the plugin uses command-center IDs.
      // Resolve that scope first so broad project queries never leak cross-workspace items.
      const byCommandCenterIds = mapInitiativeIds(
        await listLiveInitiativesWithFilters({
          workspace_id: projectId,
          command_center_id: projectId,
        }),
        { commandCenterId: projectId }
      );
      if (byCommandCenterIds.length > 0) return cacheAndReturn(byCommandCenterIds);
    } catch {
      // continue to project-id fallback
    }

    try {
      // Do not hard-return empty for known command-center scopes here.
      // Some tenants only populate project_id links, so we continue through
      // project-id fallbacks before concluding the scope is empty.
      await isKnownCommandCenterScope();
    } catch {
      // continue to project-id fallback
    }

    try {
      const byWorkspaceFallback = mapInitiativeIds(
        await listLiveInitiativesWithFilters({
          workspace_id: projectId,
          command_center_id: projectId,
        }),
        { projectId }
      );
      if (byWorkspaceFallback.length > 0) return cacheAndReturn(byWorkspaceFallback);
    } catch {
      // continue to empty fallback
    }

    try {
      return cacheAndReturn([]);
    } catch {
      return [];
    }
  }

  const readNextUpQueueCache = (
    key: string,
    opts?: { allowStale?: boolean }
  ): { items: NextUpQueueItem[]; degraded: string[] } | null => {
    const entry = nextUpQueueCache.get(key);
    if (!entry) return null;
    const now = Date.now();
    const allowStale = Boolean(opts?.allowStale);
    const stillFresh = entry.expiresAt > now;
    const stillStale = entry.staleUntil > now;
    if (!stillFresh && !stillStale) {
      nextUpQueueCache.delete(key);
      return null;
    }
    if (!stillFresh && !allowStale) return null;
    return {
      items: entry.payload.items,
      degraded: [...entry.payload.degraded],
    };
  };

  const writeNextUpQueueCache = (
    key: string,
    payload: { items: NextUpQueueItem[]; degraded: string[] }
  ): void => {
    const now = Date.now();
    nextUpQueueCache.set(key, {
      expiresAt: now + NEXT_UP_QUEUE_CACHE_TTL_MS,
      staleUntil: now + NEXT_UP_QUEUE_STALE_TTL_MS,
      payload: {
        items: payload.items,
        degraded: [...payload.degraded],
      },
    });
  };

  const clearNextUpQueueCache = (initiativeId?: string | null): void => {
    const normalized = initiativeId?.trim() || null;
    if (!normalized) {
      nextUpQueueCache.clear();
      nextUpQueueInFlight.clear();
      return;
    }
    for (const key of Array.from(nextUpQueueCache.keys())) {
      if (key.endsWith(`::${normalized}`) || key.endsWith("::__all__")) {
        nextUpQueueCache.delete(key);
      }
    }
    for (const key of Array.from(nextUpQueueInFlight.keys())) {
      if (key.endsWith(`::${normalized}`) || key.endsWith("::__all__")) {
        nextUpQueueInFlight.delete(key);
      }
    }
  };

  async function buildNextUpQueueUncached(input?: {
    initiativeId?: string | null;
    projectId?: string | null;
  }): Promise<{ items: NextUpQueueItem[]; degraded: string[] }> {
    const degraded: string[] = [];
    const requestedInitiativeId = input?.initiativeId?.trim() || null;
    const requestedProjectId = input?.projectId?.trim() || null;
    let allowedInitiativeIds: Set<string> | null = null;
    if (requestedProjectId && requestedProjectId.length > 0) {
      const scopedIds = await listInitiativeIdsForProject({
        projectId: requestedProjectId,
      });
      if (scopedIds.length > 0) {
        allowedInitiativeIds = new Set(scopedIds);
      }
    }

    const pinnedQueue = readNextUpQueuePins();
    const pinnedRankByKey = new Map<string, number>();
    const pinnedByKey = new Map<string, { preferredTaskId: string | null; preferredMilestoneId: string | null }>();
    for (let idx = 0; idx < pinnedQueue.pins.length; idx += 1) {
      const pin = pinnedQueue.pins[idx];
      const key = `${pin.initiativeId}:${pin.workstreamId}`;
      if (!pinnedRankByKey.has(key)) pinnedRankByKey.set(key, idx);
      pinnedByKey.set(key, {
        preferredTaskId: pin.preferredTaskId ?? null,
        preferredMilestoneId: pin.preferredMilestoneId ?? null,
      });
    }
    const suppressedKeySet = new Set<string>();
    for (const suppression of pinnedQueue.suppressions ?? []) {
      const initiativeId = suppression.initiativeId?.trim();
      const workstreamId = suppression.workstreamId?.trim();
      if (!initiativeId || !workstreamId) continue;
      if (requestedInitiativeId && initiativeId !== requestedInitiativeId) continue;
      suppressedKeySet.add(`${initiativeId}:${workstreamId}`);
    }
    const isSuppressed = (initiativeId: string, workstreamId: string): boolean =>
      suppressedKeySet.has(`${initiativeId}:${workstreamId}`);

    const initiativeTitleById = new Map<string, string>();
    const initiativeStatusById = new Map<string, string>();
    const initiativePriorityById = new Map<string, string>();

    const snapshotInitiatives = formatInitiatives(getSnapshot());
    for (const initiative of snapshotInitiatives) {
      const id = initiative.id?.trim();
      if (!id) continue;
      initiativeTitleById.set(id, initiative.title);
      initiativeStatusById.set(id, initiative.status || "active");
    }

    const initiativeResult = await withSoftTimeout(
      "initiative list",
      PROJECT_SCOPE_LOOKUP_TIMEOUT_MS,
      listEntitiesSafe(client, "initiative", { limit: 500 })
    ).catch((err: unknown) => ({
      items: [] as Entity[],
      warning: `initiative unavailable (${safeErrorMessage(err)})`,
    }));
    if (initiativeResult.warning) degraded.push(initiativeResult.warning);
    const initiatives = initiativeResult.items;
    for (const entity of initiatives) {
      const record = entity as Record<string, unknown>;
      const id = pickString(record, ["id"]);
      if (!id) continue;
      const title = pickString(record, ["title", "name"]);
      const status = pickString(record, ["status"]);
      const priority = pickString(record, ["priority", "priority_label", "priorityLabel"]);
      if (title) initiativeTitleById.set(id, title);
      if (status) initiativeStatusById.set(id, status);
      if (priority) initiativePriorityById.set(id, priority);
    }

    const initiativeMatchesRequestedProject = (
      record: Record<string, unknown>
    ): boolean => {
      if (!requestedProjectId) return true;
      const scopedValue =
        pickString(record, [
          "workspace_id",
          "workspaceId",
          "command_center_id",
          "commandCenterId",
          "project_id",
          "projectId",
        ]) ?? null;
      if (!scopedValue) return false;
      return scopedValue === requestedProjectId;
    };

    if (requestedProjectId && !allowedInitiativeIds) {
      const metadataScopedIds = initiatives
        .map((entity) => {
          const record = entity as Record<string, unknown>;
          const id = pickString(record, ["id"]);
          if (!id) return null;
          return initiativeMatchesRequestedProject(record) ? id : null;
        })
        .filter((value): value is string => Boolean(value));
      if (metadataScopedIds.length > 0) {
        allowedInitiativeIds = new Set(metadataScopedIds);
        degraded.push(
          "workspace initiative scope lookup returned no rows; using metadata scoped initiatives."
        );
      } else {
        degraded.push(
          "workspace initiative scope lookup returned no rows; local queue may be incomplete."
        );
      }
    }

    for (const [initiativeId, override] of localInitiativeStatusOverrides.entries()) {
      initiativeStatusById.set(initiativeId, override.status);
    }

    const queueRank = (state: NextUpQueueState): number => {
      if (state === "running") return 0;
      if (state === "queued") return 1;
      if (state === "blocked") return 2;
      return 3;
    };

    const sortQueueItems = (a: NextUpQueueItem, b: NextUpQueueItem): number => {
      const queueDelta = queueRank(a.queueState) - queueRank(b.queueState);
      if (queueDelta !== 0) return queueDelta;

      const aPinnedRank = pinnedRankByKey.get(`${a.initiativeId}:${a.workstreamId}`);
      const bPinnedRank = pinnedRankByKey.get(`${b.initiativeId}:${b.workstreamId}`);
      if (aPinnedRank !== undefined || bPinnedRank !== undefined) {
        const aRank = aPinnedRank ?? Number.POSITIVE_INFINITY;
        const bRank = bPinnedRank ?? Number.POSITIVE_INFINITY;
        if (aRank !== bRank) return aRank - bRank;
      }

      const priorityRank = (value: string | null | undefined): number => {
        const normalized = (value ?? "").trim().toLowerCase();
        if (!normalized) return 4;
        if (normalized === "critical" || normalized === "p0" || normalized === "urgent") return 0;
        if (normalized === "high" || normalized === "p1") return 1;
        if (normalized === "medium" || normalized === "normal" || normalized === "p2") return 2;
        if (normalized === "low" || normalized === "p3") return 3;
        return 4;
      };
      const aInitiativePriority = priorityRank(initiativePriorityById.get(a.initiativeId));
      const bInitiativePriority = priorityRank(initiativePriorityById.get(b.initiativeId));
      if (aInitiativePriority !== bInitiativePriority) {
        return aInitiativePriority - bInitiativePriority;
      }

      const aPriority = typeof a.nextTaskPriority === "number" ? a.nextTaskPriority : 999;
      const bPriority = typeof b.nextTaskPriority === "number" ? b.nextTaskPriority : 999;
      if (aPriority !== bPriority) return aPriority - bPriority;

      const aDue = a.nextTaskDueAt ? Date.parse(a.nextTaskDueAt) : Number.POSITIVE_INFINITY;
      const bDue = b.nextTaskDueAt ? Date.parse(b.nextTaskDueAt) : Number.POSITIVE_INFINITY;
      if (aDue !== bDue) return aDue - bDue;

      const init = a.initiativeTitle.localeCompare(b.initiativeTitle);
      if (init !== 0) return init;
      return a.workstreamTitle.localeCompare(b.workstreamTitle);
    };

    const buildSessionFallbackQueue = async (): Promise<NextUpQueueItem[]> => {
      let sessionTree: SessionTreeResponse | null = null;
      try {
        sessionTree = await withSoftTimeout(
          "live sessions",
          NEXT_UP_LIVE_SESSIONS_TIMEOUT_MS,
          client.getLiveSessions({
            initiative: requestedInitiativeId,
            projectId: requestedProjectId,
            limit: 500,
          })
        );
      } catch (err: unknown) {
        degraded.push(`live sessions fallback unavailable (${safeErrorMessage(err)})`);
      }

      const contextStore = readAgentContexts();
      const contextBundle = {
        agents: contextStore.agents,
        runs: contextStore.runs ?? {},
      };

      if (!sessionTree) {
        try {
          sessionTree = toLocalSessionTree(await loadLocalOpenClawSnapshot(400), 400);
        } catch (err: unknown) {
          degraded.push(`local sessions fallback unavailable (${safeErrorMessage(err)})`);
          return [];
        }
      }

      sessionTree = applyAgentContextsToSessionTree(sessionTree, contextBundle);

      const grouped = new Map<
        string,
        {
          initiativeId: string;
          workstreamId: string;
          initiativeTitle: string;
          initiativeStatus: string;
          workstreamTitle: string;
          statuses: Set<string>;
          blockers: string[];
          runnerAgents: NextUpRunnerAgent[];
          runnerAgentSeen: Set<string>;
          latest: SessionTreeResponse["nodes"][number];
          latestEpoch: number;
        }
      >();

      const parseEpoch = (value: string | null | undefined): number => {
        const parsed = value ? Date.parse(value) : Number.NaN;
        return Number.isFinite(parsed) ? parsed : 0;
      };

      for (const node of sessionTree.nodes ?? []) {
        const initiativeId = (node.initiativeId ?? "").trim();
        const workstreamId = (node.workstreamId ?? "").trim();
        if (!initiativeId || !workstreamId) continue;
        if (requestedInitiativeId && initiativeId !== requestedInitiativeId) continue;
        if (allowedInitiativeIds && !allowedInitiativeIds.has(initiativeId)) continue;
        const initiativeStatus = initiativeStatusById.get(initiativeId) ?? "active";
        if (!isInitiativeActiveStatus(initiativeStatus)) continue;

        const key = `${initiativeId}:${workstreamId}`;
        const epoch = parseEpoch(node.updatedAt ?? node.lastEventAt ?? node.startedAt);
        const existing = grouped.get(key);
        if (!existing) {
          const runnerAgents: NextUpRunnerAgent[] = [];
          const runnerAgentSeen = new Set<string>();
          pushRunnerAgent(runnerAgents, runnerAgentSeen, {
            id: node.agentId,
            name: node.agentName,
          });
          grouped.set(key, {
            initiativeId,
            workstreamId,
            initiativeTitle:
              initiativeTitleById.get(initiativeId) ??
              node.groupLabel ??
              initiativeId,
            initiativeStatus,
            workstreamTitle: `Workstream ${workstreamId.slice(0, 8)}`,
            statuses: new Set([node.status]),
            blockers: Array.isArray(node.blockers) ? [...node.blockers] : [],
            runnerAgents,
            runnerAgentSeen,
            latest: node,
            latestEpoch: epoch,
          });
          continue;
        }

        existing.statuses.add(node.status);
        if (Array.isArray(node.blockers)) {
          for (const blocker of node.blockers) {
            if (typeof blocker !== "string" || blocker.trim().length === 0) continue;
            if (!existing.blockers.includes(blocker)) existing.blockers.push(blocker);
          }
        }
        pushRunnerAgent(existing.runnerAgents, existing.runnerAgentSeen, {
          id: node.agentId,
          name: node.agentName,
        });
        if (epoch >= existing.latestEpoch) {
          existing.latest = node;
          existing.latestEpoch = epoch;
        }
      }

      const fallbackItems: NextUpQueueItem[] = [];
      for (const entry of grouped.values()) {
        const statusValues = Array.from(entry.statuses).map((status) =>
          status.toLowerCase()
        );
        const hasBlocked =
          statusValues.some((status) => status === "blocked" || status === "failed") ||
          entry.blockers.length > 0;
        const hasRunning = statusValues.some((status) => isInProgressStatus(status));
        const hasQueued = statusValues.some(
          (status) => status === "queued" || status === "pending"
        );
        const queueState: NextUpQueueState = hasRunning
          ? "running"
          : hasBlocked
            ? "blocked"
            : hasQueued
              ? "queued"
              : "idle";

        const latestRunner: NextUpRunnerAgent[] = [];
        const latestRunnerSeen = new Set<string>();
        pushRunnerAgent(latestRunner, latestRunnerSeen, {
          id: entry.latest.agentId,
          name: entry.latest.agentName,
        });
        const runnerAgents =
          latestRunner.length > 0
            ? dedupeWithPrimary(latestRunner, entry.runnerAgents)
            : [...entry.runnerAgents];
        const primaryRunner = runnerAgents[0] ?? null;
        const runnerAgentId = primaryRunner?.id ?? "unassigned";
        const runnerAgentName = primaryRunner?.name ?? "Unassigned";

        const pinKey = `${entry.initiativeId}:${entry.workstreamId}`;
        if (isSuppressed(entry.initiativeId, entry.workstreamId) && queueState !== "running") {
          continue;
        }
        fallbackItems.push({
          initiativeId: entry.initiativeId,
          initiativeTitle: entry.initiativeTitle,
          initiativeStatus: entry.initiativeStatus,
          workstreamId: entry.workstreamId,
          workstreamTitle: entry.workstreamTitle,
          workstreamStatus:
            hasBlocked ? "blocked" : hasRunning ? "active" : hasQueued ? "queued" : "idle",
          nextTaskId: entry.latest.id ?? null,
          nextTaskTitle:
            (entry.latest.lastEventSummary ?? "").trim() ||
            (entry.latest.title ?? "").trim() ||
            null,
          nextTaskPriority: null,
          nextTaskDueAt: null,
          runnerAgentId,
          runnerAgentName,
          runnerAgents,
          runnerSource: "fallback",
          queueState,
          blockReason: hasBlocked
            ? entry.blockers[0] ??
              (statusValues.includes("failed") ? "Latest run failed" : "Workstream blocked")
            : null,
          isPinned: pinnedRankByKey.has(pinKey),
          pinnedRank: pinnedRankByKey.get(pinKey) ?? null,
          autoContinue: null,
        });
      }

      fallbackItems.sort(sortQueueItems);
      return fallbackItems;
    };

    const scopedInitiatives = initiatives.filter((entity: Entity) => {
      const record = entity as Record<string, unknown>;
      const id = pickString(record, ["id"]);
      if (!id) return false;
      if (requestedInitiativeId && id !== requestedInitiativeId) return false;
      if (!initiativeMatchesRequestedProject(record)) return false;
      if (allowedInitiativeIds && !allowedInitiativeIds.has(id)) return false;
      const status = pickString(record, ["status"]);
      return isInitiativeActiveStatus(status);
    });

    const agentCatalogById = new Map<string, { id: string; name: string }>();
    try {
      const catalog = await withSoftTimeout(
        "listAgents",
        NEXT_UP_AGENT_CATALOG_TIMEOUT_MS,
        listAgents()
      );
      for (const entry of catalog) {
        if (!entry || typeof entry !== "object") continue;
        const id = typeof entry.id === "string" ? entry.id.trim() : "";
        if (!id) continue;
        const name =
          typeof entry.name === "string" && entry.name.trim().length > 0
            ? entry.name.trim()
            : id;
        agentCatalogById.set(id, { id, name });
      }
    } catch (err: unknown) {
      degraded.push(`agent catalog unavailable (${safeErrorMessage(err)})`);
    }

    const liveAgentsByInitiative = new Map<string, MissionControlAssignedAgent[]>();
    try {
      const data = await withSoftTimeout(
        "live agents",
        NEXT_UP_LIVE_AGENTS_TIMEOUT_MS,
        client.getLiveAgents({
          initiative: requestedInitiativeId,
          projectId: requestedProjectId,
          includeIdle: true,
        })
      );
      for (const raw of Array.isArray(data.agents) ? data.agents : []) {
        if (!raw || typeof raw !== "object") continue;
        const row = raw as Record<string, unknown>;
        const initiativeId = pickString(row, ["initiativeId", "initiative_id"]);
        if (!initiativeId) continue;
        const id =
          pickString(row, ["id", "agentId", "agent_id"]) ??
          pickString(row, ["name", "agentName", "agent_name"]) ??
          "";
        const name =
          pickString(row, ["name", "agentName", "agent_name"]) ??
          id;
        if (!id || !name) continue;
        const list = liveAgentsByInitiative.get(initiativeId) ?? [];
        list.push({
          id,
          name,
          domain: pickString(row, ["domain", "role"]),
        });
        liveAgentsByInitiative.set(initiativeId, list);
      }
    } catch (err: unknown) {
      degraded.push(`live agents unavailable (${safeErrorMessage(err)})`);
    }

    const processInitiative = async (initiativeEntity: Entity): Promise<NextUpQueueItem[]> => {
      const initiativeRecord = initiativeEntity as Record<string, unknown>;
      const initiativeId = pickString(initiativeRecord, ["id"]);
      if (!initiativeId) return [];
      const initiativeTitle =
        pickString(initiativeRecord, ["title", "name"]) ?? initiativeId;
      const initiativeStatus = pickString(initiativeRecord, ["status"]) ?? "active";

      let graph: Awaited<ReturnType<typeof buildMissionControlGraph>>;
      try {
        graph = applyLocalInitiativeOverrideToGraph(
          await buildMissionControlGraph(client, initiativeId, { initiativeEntity })
        );
      } catch (err: unknown) {
        degraded.push(
          `graph unavailable for ${initiativeId} (${safeErrorMessage(err)})`
        );
        return [];
      }

      const itemsForInitiative: NextUpQueueItem[] = [];
      const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
      const workstreamNodes = graph.nodes.filter((node) => node.type === "workstream");
      const runningWorkstreams = new Set<string>();
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
      const normalizeSliceScope = (value: unknown): SliceScope | null => {
        if (value === "task" || value === "milestone" || value === "workstream") {
          return value;
        }
        return null;
      };
      const resolveExecutionPolicyFromActiveRuns = (
        activeRunIds: string[],
        workstreamId: string
      ): NextUpExecutionPolicy | null => {
        for (const runId of activeRunIds) {
          const slice = autoContinueSliceRuns.get(runId) as
            | {
                domain?: string | null;
                requiredSkills?: string[] | null;
                behaviorConfigId?: string | null;
                scope?: SliceScope | null;
                workstreamId?: string | null;
              }
            | undefined;
          if (!slice) continue;
          if (typeof slice.workstreamId === "string" && slice.workstreamId.trim()) {
            if (slice.workstreamId.trim() !== workstreamId) continue;
          }
          const domain = (slice.domain ?? "").trim();
          const requiredSkills = Array.isArray(slice.requiredSkills)
            ? slice.requiredSkills.filter(
                (skill): skill is string => typeof skill === "string" && skill.trim().length > 0
              )
            : [];
          if (!domain || requiredSkills.length === 0) continue;
          const executionPolicy: NextUpExecutionPolicy = {
            domain,
            requiredSkills,
          };
          if (typeof slice.behaviorConfigId === "string" && slice.behaviorConfigId.trim()) {
            executionPolicy.profile = slice.behaviorConfigId.trim();
          }
          const scope = normalizeSliceScope(slice.scope ?? null);
          if (scope) {
            executionPolicy.sliceScopePreference = scope;
          }
          return executionPolicy;
        }
        return null;
      };

      for (const workstream of workstreamNodes) {
        const workstreamKey = `${initiativeId}:${workstream.id}`;
        const todoTasks = graph.recentTodos
          .map((taskId) => nodeById.get(taskId))
          .filter(
            (node) =>
              node?.type === "task" &&
              node.workstreamId === workstream.id &&
              isTodoStatus(node.status)
          ) as MissionControlNode[];

        const pinKey = workstreamKey;
        const pin = pinnedByKey.get(pinKey) ?? null;
        const preferredTask =
          pin?.preferredTaskId && nodeById.get(pin.preferredTaskId)
            ? nodeById.get(pin.preferredTaskId) ?? null
            : null;
        const preferredMilestone =
          pin?.preferredMilestoneId && nodeById.get(pin.preferredMilestoneId)
            ? nodeById.get(pin.preferredMilestoneId) ?? null
            : null;
        const preferredCandidates: MissionControlNode[] = [];
        if (
          preferredTask &&
          preferredTask.type === "task" &&
          preferredTask.workstreamId === workstream.id &&
          isTodoStatus(preferredTask.status)
        ) {
          preferredCandidates.push(preferredTask);
        }
        if (preferredMilestone && preferredMilestone.type === "milestone") {
          for (const node of todoTasks) {
            if (node.milestoneId === preferredMilestone.id) preferredCandidates.push(node);
          }
        }

        const readyTask = todoTasks.find(
          (task) => taskIsReady(task) && !taskHasBlockedParent(task)
        );
        const preferredReadyTask = preferredCandidates.find(
          (task) => taskIsReady(task) && !taskHasBlockedParent(task)
        );
        const candidateTask = preferredReadyTask ?? readyTask ?? todoTasks[0] ?? null;

        const autoContinueRun = runningAutoContinueForWorkstream(
          initiativeId,
          workstream.id
        );
        const autoContinueLane = getAutoContinueLaneForWorkstream(
          initiativeId,
          workstream.id
        );
        const laneState = autoContinueLane?.state ?? null;
        const scopedAllowedWorkstreams = Array.isArray(
          (autoContinueRun as Record<string, unknown> | null)?.allowedWorkstreamIds
        )
          ? (((autoContinueRun as Record<string, unknown>).allowedWorkstreamIds as Array<unknown>)
              .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
              .map((id) => id.trim()))
          : [];
        const runScopedToCurrentWorkstream =
          scopedAllowedWorkstreams.length === 1 &&
          scopedAllowedWorkstreams[0] === workstream.id &&
          autoContinueRun?.status === "running";
        const activeRunIds = Array.isArray((autoContinueRun as any)?.activeSliceRunIds)
          ? ((autoContinueRun as any).activeSliceRunIds as Array<unknown>)
              .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
              .map((id) => id.trim())
          : [];
        const activeTaskId =
          (autoContinueLane?.activeTaskIds?.[0]?.trim() ||
            autoContinueRun?.activeTaskId?.trim() ||
            null) ??
          null;
        const activeTaskNode = activeTaskId ? nodeById.get(activeTaskId) ?? null : null;
        const policyTask =
          candidateTask ??
          activeTaskNode ??
          todoTasks.find((task) => task.workstreamId === workstream.id) ??
          null;
        const derivedExecutionPolicy = policyTask
          ? deriveExecutionPolicy(policyTask, workstream)
          : null;
        const activeExecutionPolicy = resolveExecutionPolicyFromActiveRuns(
          activeRunIds,
          workstream.id
        );
        const executionPolicy: NextUpExecutionPolicy | null =
          derivedExecutionPolicy ?? activeExecutionPolicy;
        const runScope = normalizeSliceScope((autoContinueRun as any)?.scope ?? null);
        const preferredPolicyScope = normalizeSliceScope(
          executionPolicy?.sliceScopePreference ?? null
        );
        const defaultScope: SliceScope =
          runScope ??
          (preferredPolicyScope && preferredPolicyScope !== "task"
            ? preferredPolicyScope
            : pin?.preferredMilestoneId
              ? "milestone"
              : "task");
        const scopeSelection = selectSliceTasksByScope({
          scope: defaultScope,
          workstreamId: workstream.id,
          milestoneId: pin?.preferredMilestoneId ?? null,
          recentTodos: graph.recentTodos,
          nodeById,
          includeVerification: autoContinueRun?.includeVerification ?? false,
        });
        const cappedSliceTasks =
          typeof executionPolicy?.maxSliceTasks === "number" &&
          executionPolicy.maxSliceTasks > 0
            ? scopeSelection.tasks.slice(0, executionPolicy.maxSliceTasks)
            : scopeSelection.tasks;
        const sliceTaskIds =
          cappedSliceTasks.length > 0
            ? cappedSliceTasks.map((task) => task.id)
            : candidateTask?.id
              ? [candidateTask.id]
              : activeTaskId
                ? [activeTaskId]
                : [];
        const sliceMilestoneId =
          defaultScope === "milestone"
            ? scopeSelection.milestoneIds[0] ?? pin?.preferredMilestoneId ?? null
            : null;
        let queueState: NextUpQueueState =
          laneState === "running"
            ? "running"
            : runScopedToCurrentWorkstream
              ? "running"
              : candidateTask
                ? "queued"
                : "idle";
        let blockReason: string | null = null;

        if (laneState === "blocked") {
          queueState = "blocked";
          blockReason = autoContinueLane?.blockedReason ?? "Blocked";
        } else if (laneState === "waiting_dependency") {
          queueState = "blocked";
          if (
            Array.isArray(autoContinueLane?.waitingOnWorkstreamIds) &&
            autoContinueLane!.waitingOnWorkstreamIds.length > 0
          ) {
            const waitingTitles = autoContinueLane!.waitingOnWorkstreamIds
              .map((id) => {
                const node = nodeById.get(id);
                return node?.type === "workstream" ? node.title : id;
              })
              .filter(Boolean);
            blockReason =
              waitingTitles.length > 0
                ? `Waiting on ${waitingTitles.slice(0, 2).join(", ")}${waitingTitles.length > 2 ? "…" : ""}`
                : "Waiting on dependency workstreams";
          } else {
            blockReason = "Waiting on dependency workstreams";
          }
        } else if (laneState === "rate_limited") {
          queueState = "blocked";
          blockReason = autoContinueLane?.blockedReason ?? "Rate-limited";
        }

        if (!autoContinueRun && !readyTask && candidateTask) {
          queueState = "blocked";
          const blockedDeps = candidateTask.dependencyIds
            .map((depId) => nodeById.get(depId))
            .filter(
              (dependency): dependency is MissionControlNode =>
                Boolean(dependency && !isDoneStatus(dependency.status))
            )
            .map((dependency) => dependency.title);

          if (blockedDeps.length > 0) {
            blockReason = `Waiting on ${blockedDeps.slice(0, 2).join(", ")}${
              blockedDeps.length > 2 ? "…" : ""
            }`;
          } else if (taskHasBlockedParent(candidateTask)) {
            blockReason = "Parent milestone or workstream is blocked";
          } else if (!taskIsReady(candidateTask)) {
            blockReason = "Task prerequisites are not complete";
          }
        }

        if (!candidateTask && !autoContinueRun && !pin) {
          continue;
        }
        if (isSuppressed(initiativeId, workstream.id) && queueState !== "running") {
          continue;
        }

        runningWorkstreams.add(workstream.id);

        const assignedRunnerAgents: NextUpRunnerAgent[] = [];
        const assignedRunnerSeen = new Set<string>();
        for (const agent of workstream.assignedAgents) {
          pushRunnerAgent(assignedRunnerAgents, assignedRunnerSeen, {
            id: agent.id,
            name: agent.name,
          });
        }

        const inferredRunnerAgents: NextUpRunnerAgent[] = [];
        const inferredRunnerSeen = new Set<string>();
        for (const agent of graph.initiative.assignedAgents) {
          pushRunnerAgent(inferredRunnerAgents, inferredRunnerSeen, {
            id: agent.id,
            name: agent.name,
          });
        }
        for (const agent of liveAgentsByInitiative.get(initiativeId) ?? []) {
          pushRunnerAgent(inferredRunnerAgents, inferredRunnerSeen, {
            id: agent.id,
            name: agent.name,
          });
        }
        if (autoContinueRun?.agentId) {
          pushRunnerAgent(inferredRunnerAgents, inferredRunnerSeen, {
            id: autoContinueRun.agentId,
            name:
              agentCatalogById.get(autoContinueRun.agentId)?.name ??
              autoContinueRun.agentId,
          });
        }

        const runnerAgents =
          assignedRunnerAgents.length > 0 ? assignedRunnerAgents : inferredRunnerAgents;
        const runnerSource: NextUpRunnerSource =
          assignedRunnerAgents.length > 0
            ? "assigned"
            : runnerAgents.length > 0
              ? "inferred"
              : "fallback";
        const primaryRunner = runnerAgents[0] ?? null;
        const runnerAgentId = primaryRunner?.id ?? "unassigned";
        const runnerAgentName = primaryRunner?.name ?? "Unassigned";

        itemsForInitiative.push({
          initiativeId,
          initiativeTitle,
          initiativeStatus,
          workstreamId: workstream.id,
          workstreamTitle: workstream.title,
          workstreamStatus: workstream.status,
          nextTaskId:
            candidateTask?.id ??
            activeTaskId,
          nextTaskTitle:
            candidateTask?.title ??
            ((activeTaskId)
              ? nodeById.get(
                  activeTaskId as string
                )?.title ?? null
              : null),
          nextTaskPriority: candidateTask?.priorityNum ?? null,
          nextTaskDueAt: candidateTask?.dueDate ?? null,
          runnerAgentId,
          runnerAgentName,
          runnerAgents,
          runnerSource,
          queueState,
          blockReason,
          isPinned: Boolean(pin),
          pinnedRank: pin ? (pinnedRankByKey.get(pinKey) ?? null) : null,
          sliceScope: defaultScope,
          sliceTaskIds,
          sliceTaskCount: sliceTaskIds.length,
          sliceMilestoneId,
          executionPolicy,
          autoContinue: autoContinueRun
            ? {
                status: autoContinueRun.status,
                activeTaskId: autoContinueRun.activeTaskId,
                activeRunId: autoContinueRun.activeRunId,
                  activeTaskIds: Array.isArray((autoContinueRun as any).activeTaskIds)
                    ? ((autoContinueRun as any).activeTaskIds as string[])
                    : [],
                  activeRunIds: Array.isArray((autoContinueRun as any).activeSliceRunIds)
                    ? ((autoContinueRun as any).activeSliceRunIds as string[])
                    : [],
                  laneState,
                  laneBlockedReason: autoContinueLane?.blockedReason ?? null,
                  laneWaitingOnWorkstreamIds: Array.isArray(
                    autoContinueLane?.waitingOnWorkstreamIds
                  )
                    ? autoContinueLane!.waitingOnWorkstreamIds
                    : [],
                  laneRetryAt: autoContinueLane?.retryAt ?? null,
                  maxParallelSlices:
                    typeof (autoContinueRun as any).maxParallelSlices === "number"
                      ? (autoContinueRun as any).maxParallelSlices
                      : 1,
                  parallelMode:
                    (typeof (autoContinueRun as any).parallelMode === "string" &&
                    (autoContinueRun as any).parallelMode.toLowerCase() === "iwmt"
                      ? "iwmt"
                      : "iwmt"),
                stopReason: autoContinueRun.stopReason,
                updatedAt: autoContinueRun.updatedAt,
              }
            : null,
        });
      }

      const run = autoContinueRuns.get(initiativeId);
      if (
        run &&
        (run.status === "running" || run.status === "stopping") &&
        Array.isArray(run.allowedWorkstreamIds) &&
        run.allowedWorkstreamIds.length > 0
      ) {
        for (const workstreamId of run.allowedWorkstreamIds) {
          if (runningWorkstreams.has(workstreamId)) continue;
          const workstream = nodeById.get(workstreamId);
          if (!workstream || workstream.type !== "workstream") continue;
          const lane = getAutoContinueLaneForWorkstream(initiativeId, workstream.id);
          if (
            !lane &&
            !(typeof run.activeRunId === "string" && run.activeRunId.trim().length > 0)
          ) {
            continue;
          }
          const laneState = lane?.state ?? null;
          const activeRunIds = Array.isArray((run as any).activeSliceRunIds)
            ? ((run as any).activeSliceRunIds as Array<unknown>)
                .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
                .map((id) => id.trim())
            : [];
          const activeTaskId = lane?.activeTaskIds?.[0] ?? run.activeTaskId;
          const activeTaskNode = activeTaskId ? nodeById.get(activeTaskId) ?? null : null;
          const executionPolicy =
            (activeTaskNode ? deriveExecutionPolicy(activeTaskNode, workstream) : null) ??
            resolveExecutionPolicyFromActiveRuns(activeRunIds, workstream.id);
          const sliceScope = normalizeSliceScope((run as any).scope ?? null) ?? "task";
          const sliceTaskIds =
            lane?.activeTaskIds?.length
              ? lane.activeTaskIds
              : activeTaskId
                ? [activeTaskId]
                : [];
          const queueState: NextUpQueueState =
            laneState === "running"
              ? "running"
              : laneState === "blocked" ||
                  laneState === "waiting_dependency" ||
                  laneState === "rate_limited"
                ? "blocked"
                : "queued";
          if (isSuppressed(initiativeId, workstream.id) && queueState !== "running") {
            continue;
          }
          const runRunnerAgents: NextUpRunnerAgent[] = [];
          const runRunnerSeen = new Set<string>();
          pushRunnerAgent(runRunnerAgents, runRunnerSeen, {
            id: run.agentId,
            name: agentCatalogById.get(run.agentId)?.name ?? run.agentId,
          });
          const runPrimaryRunner = runRunnerAgents[0] ?? null;
          itemsForInitiative.push({
            initiativeId,
            initiativeTitle,
            initiativeStatus,
            workstreamId: workstream.id,
            workstreamTitle: workstream.title,
            workstreamStatus: workstream.status,
            nextTaskId: activeTaskId ?? null,
            nextTaskTitle:
                activeTaskId
                  ? nodeById.get(activeTaskId)?.title ?? null
                  : null,
            nextTaskPriority: null,
            nextTaskDueAt: null,
            runnerAgentId: runPrimaryRunner?.id ?? "unassigned",
            runnerAgentName: runPrimaryRunner?.name ?? "Unassigned",
            runnerAgents: runRunnerAgents,
            runnerSource: runPrimaryRunner ? "inferred" : "fallback",
            queueState,
            blockReason:
                queueState === "blocked"
                  ? lane?.blockedReason ?? "Blocked"
                  : null,
            isPinned: Boolean(pinnedByKey.get(`${initiativeId}:${workstream.id}`)),
            pinnedRank: pinnedRankByKey.get(`${initiativeId}:${workstream.id}`) ?? null,
            sliceScope,
            sliceTaskIds,
            sliceTaskCount: sliceTaskIds.length,
            sliceMilestoneId:
              sliceScope === "milestone"
                ? activeTaskNode?.milestoneId ?? null
                : null,
            executionPolicy,
            autoContinue: {
              status: run.status,
              activeTaskId: run.activeTaskId,
              activeRunId: run.activeRunId,
                activeTaskIds: Array.isArray((run as any).activeTaskIds)
                  ? ((run as any).activeTaskIds as string[])
                  : [],
                activeRunIds: Array.isArray((run as any).activeSliceRunIds)
                  ? ((run as any).activeSliceRunIds as string[])
                  : [],
                laneState,
                laneBlockedReason: lane?.blockedReason ?? null,
                laneWaitingOnWorkstreamIds: Array.isArray(lane?.waitingOnWorkstreamIds)
                  ? lane!.waitingOnWorkstreamIds
                  : [],
                laneRetryAt: lane?.retryAt ?? null,
                maxParallelSlices:
                  typeof (run as any).maxParallelSlices === "number"
                    ? (run as any).maxParallelSlices
                    : 1,
                parallelMode:
                  typeof (run as any).parallelMode === "string" &&
                  (run as any).parallelMode.toLowerCase() === "iwmt"
                    ? "iwmt"
                    : "iwmt",
              stopReason: run.stopReason,
              updatedAt: run.updatedAt,
            },
          });
        }
      }

      return itemsForInitiative;
    };

    const byInitiative = await mapWithConcurrency(
      scopedInitiatives,
      NEXT_UP_GRAPH_CONCURRENCY,
      processInitiative
    );
    const items: NextUpQueueItem[] = byInitiative.flat();

    if (items.length === 0) {
      const fallbackItems = await buildSessionFallbackQueue();
      if (fallbackItems.length > 0) {
        degraded.push("Using session-derived Next Up fallback.");
        items.push(...fallbackItems);
      }
    }

    items.sort(sortQueueItems);

    return { items, degraded };
  }

  async function buildNextUpQueue(input?: {
    initiativeId?: string | null;
    projectId?: string | null;
  }): Promise<{ items: NextUpQueueItem[]; degraded: string[] }> {
    const key = nextUpQueueCacheKeyFor(
      input?.initiativeId?.trim() || null,
      input?.projectId?.trim() || null
    );
    const fresh = readNextUpQueueCache(key, { allowStale: false });
    if (fresh) return fresh;

    const inFlight = nextUpQueueInFlight.get(key) ?? null;
    if (inFlight) {
      const stale = readNextUpQueueCache(key, { allowStale: true });
      if (stale) {
        return {
          ...stale,
          degraded: dedupeStrings([
            ...stale.degraded,
            "Refreshing Next Up queue in background.",
          ]),
        };
      }
      return await inFlight;
    }

    const work = (async () => {
      const result = await buildNextUpQueueUncached(input);
      writeNextUpQueueCache(key, result);
      return result;
    })();

    nextUpQueueInFlight.set(key, work);
    try {
      const stale = readNextUpQueueCache(key, { allowStale: true });
      if (stale) {
        void work.catch(() => {
          // best effort refresh
        });
        return {
          ...stale,
          degraded: dedupeStrings([
            ...stale.degraded,
            "Using recent Next Up queue while refreshing.",
          ]),
        };
      }
      return await work;
    } finally {
      nextUpQueueInFlight.delete(key);
    }
  }

  // Prime queue cache shortly after boot so first dashboard paint is not cold.
  const prewarmNextUpQueue = () => {
    void buildNextUpQueue({ initiativeId: null, projectId: null }).catch(() => {
      // best effort prewarm only
    });
  };
  const nextUpPrewarmTimer = setTimeout(prewarmNextUpQueue, 75);
  nextUpPrewarmTimer.unref?.();

  const autoContinueTimer = setInterval(() => {
    void tickAllAutoContinue();
  }, AUTO_CONTINUE_TICK_MS);
  autoContinueTimer.unref?.();

  const apiRouter = createRouter<Record<string, never>, PluginRequest, PluginResponse>();
  registerOnboardingRoutes(apiRouter, {
    onboarding,
    parseJsonRequest,
    pickString: (input, keys) =>
      pickString(
        input && typeof input === "object"
          ? (input as Record<string, unknown>)
          : {},
        keys
      ),
    pickHeaderString: (headers, names) =>
      pickHeaderString(
        headers && typeof headers === "object"
          ? (headers as Record<string, string | string[] | undefined>)
          : {},
        names
      ),
    isUserScopedApiKey,
    sendJson,
    safeErrorMessage,
    getOnboardingState,
  });
  registerSummaryRoutes(apiRouter, {
    getSnapshot,
    getOrgSnapshot: () => client.getOrgSnapshot(),
    sendJson,
    writeHead: (response, status, headers) => response.writeHead(status, headers),
    end: (response) => response.end(),
    securityHeaders: SECURITY_HEADERS,
    corsHeaders: CORS_HEADERS,
    formatStatus,
    formatAgents,
    formatActivity,
    formatInitiatives,
    getOnboardingState: async () => getOnboardingState(await onboarding.getStatus()),
  });
  registerUsageRoutes(apiRouter, {
    client,
    listActivityPage: ({ limit, runId, since, until, cursor }) =>
      listActivityPage({ limit, runId, since, until, cursor }),
    sendJson,
    safeErrorMessage,
  });
  registerAgentSuiteRoutes(apiRouter, {
    pluginVersion: config.pluginVersion,
    telemetryDistinctId,
    parseJsonRequest,
    resolveSkillPackOverrides: ({ force }) => resolveSkillPackOverrides({ client, force }),
    readSkillPackState,
    computeOrgxAgentSuitePlan,
    applyOrgxAgentSuitePlan,
    generateAgentSuiteOperationId,
    updateSkillPackPolicy,
    rollbackSkillPackPolicy,
    fetchAgentRuntimeSettings: ({ workspaceId, projectId } = {}) =>
      client.getClientAgentRuntimeSettings({
        workspaceId: workspaceId ?? projectId ?? null,
      }),
    updateAgentRuntimeSettings: (payload) =>
      client.updateClientAgentRuntimeSettings(payload),
    posthogCapture,
    sendJson,
    safeErrorMessage,
  });
  registerDebugRoutes(apiRouter, {
    sendJson,
    safeErrorMessage,
    resolveCodexBinInfo,
    getCachedCodexProbeSummary: () => codexBinResolver.getCachedCodexProbeSummary(),
  });
  registerAgentsCatalogRoutes(apiRouter, {
    listAgents,
    loadLocalSnapshot: () => loadLocalOpenClawSnapshot(240).catch(() => null),
    readAgentContexts,
    readAgentRuns,
    sendJson,
    safeErrorMessage,
  });
  registerSentinelsCatalogRoutes(apiRouter, {
    sendJson,
    safeErrorMessage,
  });
  registerMissionControlReadRoutes(apiRouter, {
    autoContinueRuns,
    defaultAutoContinueTokenBudget,
    defaultAutoContinueMaxParallelSlices,
    autoContinueTickMs: AUTO_CONTINUE_TICK_MS,
    buildMissionControlGraph: (initiativeId) => buildMissionControlGraph(client, initiativeId),
    applyLocalInitiativeOverrideToGraph: (graph) =>
      applyLocalInitiativeOverrideToGraph(
        graph as {
          initiative: { id: string; status: string };
          nodes: MissionControlNode[];
        }
      ),
    listInitiativeIdsForProject: ({ projectId }) =>
      listInitiativeIdsForProject({ projectId }),
    buildNextUpQueue,
    rawRequest: (requestMethod, requestPath, body) =>
      client.rawRequest(requestMethod, requestPath, body),
    sendJson,
    safeErrorMessage,
  });
  registerSettingsByokRoutes(apiRouter, {
    parseJsonRequest,
    readByokKeys,
    writeByokKeys,
    maskSecret,
    listAgents,
    listOpenClawProviderModels,
    sendJson,
    safeErrorMessage,
  });
  registerBillingRoutes(apiRouter, {
    client,
    parseJsonRequest,
    pickString,
    sendJson,
    safeErrorMessage,
  });
  registerDelegationRoutes(apiRouter, {
    client,
    parseJsonRequest,
    pickString,
    sendJson,
    safeErrorMessage,
  });
  registerEntitiesRoutes(apiRouter, {
    client,
    parseJsonRequest,
    pickString,
    normalizeEntityMutationPayload,
    resolveAutoAssignments: (input) =>
      resolveAutoAssignments({
        client,
        ...input,
      }),
    setLocalInitiativeStatusOverride,
    clearLocalInitiativeStatusOverride,
    isUnauthorizedOrgxError,
    applyLocalInitiativeOverrides,
    formatInitiatives,
    getSnapshot,
    scheduleWorkstreamReassignment: async (input) => {
      const initiativeId = input.initiativeId.trim();
      const workstreamId = input.workstreamId.trim();
      if (!initiativeId || !workstreamId) return null;
      const normalizedStatus = (input.status ?? "").trim().toLowerCase();
      const shouldRedispatch =
        normalizedStatus === "active" ||
        normalizedStatus === "ready" ||
        normalizedStatus === "queued" ||
        normalizedStatus === "running" ||
        normalizedStatus === "in_progress" ||
        normalizedStatus === "pending";
      if (!shouldRedispatch) return null;
      if (!isDispatchableWorkstreamStatus(normalizedStatus)) return null;
      const liveRun = runningAutoContinueForWorkstream(initiativeId, workstreamId);
      return await scheduleAutoFixForWorkstream({
        initiativeId,
        workstreamId,
        runId: liveRun?.activeRunId ?? null,
        event: input.event,
        requestedByAgentId: "system",
        requestedByAgentName: "System",
        graceMs: 5_000,
      });
    },
    sendJson,
    safeErrorMessage,
  });
  registerDecisionActionsRoutes(apiRouter, {
    parseJsonRequest,
    bulkDecideDecisions: (ids, action, input) =>
      client.bulkDecideDecisions(ids, action, input),
    sendJson,
    safeErrorMessage,
  });
  registerRunControlRoutes(apiRouter, {
    parseJsonRequest,
    pickString,
    listRunCheckpoints: (runId) => client.listRunCheckpoints(runId),
    createRunCheckpoint: (runId, input) => client.createRunCheckpoint(runId, input),
    restoreRunCheckpoint: (runId, input) => client.restoreRunCheckpoint(runId, input),
    runAction: (runId, action, input) => client.runAction(runId, action, input),
    markRunCompleted: async (runId, input) => {
      const normalizedRunId = runId.trim();
      if (!normalizedRunId) {
        throw new Error("runId is required");
      }

      const nowIso = new Date().toISOString();
      const reason = input.reason?.trim() || null;
      const message = reason
        ? `Marked completed from dashboard (${reason}).`
        : "Marked completed from dashboard.";
      const existingRun = getAgentRun(normalizedRunId);

      // ── Try OrgX-side completion first (for remote sessions) ────────────
      let remoteOk = false;
      try {
        await client.updateEntity("run", normalizedRunId, {
          status: "completed",
          phase: "completed",
        });
        remoteOk = true;
      } catch {
        // OrgX may not support updating runs directly — fall through to local
      }

      // ── Local operations (defensive — partial failures don't block) ─────
      let runtimeRecord: ReturnType<typeof upsertRuntimeInstanceFromHook> | null = null;
      try {
        runtimeRecord = upsertRuntimeInstanceFromHook({
          source_client: "api",
          event: "session_stop",
          run_id: normalizedRunId,
          correlation_id: normalizedRunId,
          initiative_id: existingRun?.initiativeId ?? null,
          workstream_id: existingRun?.workstreamId ?? null,
          task_id: existingRun?.taskId ?? null,
          agent_id: existingRun?.agentId ?? null,
          phase: "completed",
          message,
          timestamp: nowIso,
          metadata: {
            source: "dashboard_manual_complete",
            reason,
          },
        });
      } catch (err: unknown) {
        console.error(`[markRunCompleted] upsertRuntime failed for ${normalizedRunId}:`, err);
      }

      try {
        markAgentRunStopped(normalizedRunId);
      } catch (err: unknown) {
        console.error(`[markRunCompleted] markAgentRunStopped failed for ${normalizedRunId}:`, err);
      }

      if (runtimeRecord) {
        broadcastRuntimeSse("runtime.updated", runtimeRecord);
      }
      clearSnapshotResponseCache();

      try {
        appendActivityItems([
          {
            id: randomUUID(),
            type: "run_completed",
            title: message,
            description: reason,
            agentId: runtimeRecord?.agentId ?? existingRun?.agentId ?? null,
            agentName: runtimeRecord?.agentName ?? null,
            requesterAgentId: runtimeRecord?.agentId ?? existingRun?.agentId ?? null,
            requesterAgentName: runtimeRecord?.agentName ?? null,
            executorAgentId: runtimeRecord?.agentId ?? existingRun?.agentId ?? null,
            executorAgentName: runtimeRecord?.agentName ?? null,
            runId: normalizedRunId,
            initiativeId: runtimeRecord?.initiativeId ?? existingRun?.initiativeId ?? null,
            timestamp: nowIso,
            phase: "completed",
            state: "done",
            summary: message,
            metadata: {
              source: "dashboard_manual_complete",
              reason,
              remoteOk,
              event: "dashboard_run_mark_completed",
            },
          } satisfies LiveActivityItem,
        ]);
      } catch (err: unknown) {
        console.error(`[markRunCompleted] appendActivity failed for ${normalizedRunId}:`, err);
      }

      return {
        ok: true,
        data: {
          runId: normalizedRunId,
          action: "complete",
          status: "completed",
          remoteOk,
        },
      };
    },
    sendJson,
    safeErrorMessage,
  });
  registerWorkArtifactsRoutes(apiRouter, {
    rawRequest: (requestMethod, requestPath, body) =>
      client.rawRequest(requestMethod, requestPath, body),
    buildLocalArtifactDetailFallback,
    sendJson,
    safeErrorMessage,
  });
  registerEntityDynamicRoutes(apiRouter, {
    parseJsonRequest,
    pickString,
    rawRequest: (requestMethod, requestPath, body) =>
      client.rawRequest(requestMethod, requestPath, body),
    listEntityComments,
    mergeEntityComments: (remote, local) => mergeEntityComments(remote, local as any),
    appendEntityComment,
    updateEntity: (type, id, updates) => client.updateEntity(type, id, updates),
    setLocalInitiativeStatusOverride,
    clearLocalInitiativeStatusOverride,
    isUnauthorizedOrgxError,
    sendJson,
    safeErrorMessage,
  });
  registerChatRoutes(apiRouter, {
    parseJsonRequest,
    pickString,
    parsePositiveInt,
    emitActivitySafe,
    sendJson,
    safeErrorMessage,
  });
  registerRealtimeOrchestratorRoutes(apiRouter, {
    parseJsonRequest,
    rawRequest: (requestMethod, requestPath, body) =>
      client.rawRequest(requestMethod, requestPath, body),
    sendJson,
    safeErrorMessage,
  });
  registerMissionControlActionsRoutes(apiRouter, {
    parseJsonRequest,
    pickString,
    pickNumber,
    parseBooleanQuery,
    pickStringArray,
    dedupeStrings,
    resolveAgentDisplayName,
    buildNextUpQueue,
    startAutoContinueRun,
    autoContinueRuns,
    autoContinueSliceRuns,
    dispatchFallbackWorkstreamTurn,
    tickAutoContinueRun,
    stopAutoContinueRun,
    updateInitiativeAutoContinueState,
    tickAllAutoContinue,
    scheduleAutoFixForWorkstream,
    upsertNextUpQueuePin,
    removeNextUpQueuePin,
    suppressNextUpQueueItem,
    setNextUpQueuePinOrder,
    clearNextUpQueueCache,
    resolveAutoAssignments,
    buildMissionControlGraph: (initiativeId) =>
      buildMissionControlGraph(client, initiativeId),
    applyLocalInitiativeOverrideToGraph: (graph) =>
      applyLocalInitiativeOverrideToGraph(
        graph as Awaited<ReturnType<typeof buildMissionControlGraph>>
      ),
    client,
    rawRequest: (requestMethod, requestPath, body) =>
      client.rawRequest(requestMethod, requestPath, body),
    sendJson,
    safeErrorMessage,
  });
  registerAgentControlRoutes(apiRouter, {
    parseJsonRequest,
    pickString,
    parseBooleanQuery,
    randomUUID,
    normalizeOpenClawProvider,
    resolveAutoOpenClawProvider,
    modelImpliesByok,
    listAgents,
    fetchBillingStatusSafe,
    client,
    resolveDispatchExecutionPolicy,
    fetchKickoffContextSafe,
    renderKickoffMessage,
    posthogCapture: (input) => posthogCapture(input),
    telemetryDistinctId,
    pluginVersion: (config.pluginVersion ?? "").trim() || null,
    enforceSpawnGuardForDispatch,
    extractSpawnGuardModelTier,
    buildPolicyEnforcedMessage,
    syncParentRollupsForTask,
    emitActivitySafe,
    configureOpenClawProviderRouting,
    upsertAgentContext,
    upsertRunContext,
    spawnAgentTurn,
    upsertAgentRun,
    getAgentRun,
    stopProcess,
    markAgentRunStopped,
    writeRuntimeEvent,
    sendJson,
    safeErrorMessage,
  });
  registerLiveMiscRoutes(apiRouter, {
    parseJsonRequest,
    pickString,
    summarizeActivityHeadline,
    getLiveAgents: ({ initiative, projectId, includeIdle }) =>
      client.getLiveAgents({ initiative, projectId, includeIdle }),
    getLiveInitiatives: ({ id, projectId, limit, offset }) =>
      client.getLiveInitiatives({ id, projectId, limit, offset }),
    getLiveDecisions: ({ status, projectId, limit }) =>
      client.getLiveDecisions({ status, projectId, limit }),
    getHandoffs: () => client.getHandoffs(),
    listInitiativeIdsForProject: ({ projectId }) =>
      listInitiativeIdsForProject({ projectId }),
    loadLocalOpenClawSnapshot,
    toLocalLiveAgents,
    toLocalLiveInitiatives,
    localInitiativeStatusOverrides,
    mapDecisionEntity,
    sendJson,
    safeErrorMessage,
  });
  registerLiveLegacyRoutes(apiRouter, {
    getLiveSessions: ({ initiative, projectId, limit }) =>
      client.getLiveSessions({ initiative, projectId, limit }),
    getLiveActivity: ({ run, since, projectId, limit }) =>
      client.getLiveActivity({ run, since, projectId, limit }),
    listInitiativeIdsForProject: ({ projectId }) =>
      listInitiativeIdsForProject({ projectId }),
    listRuntimeInstances,
    injectRuntimeInstancesAsSessions,
    enrichSessionsWithRuntime,
    loadLocalOpenClawSnapshot,
    toLocalSessionTree,
    readAgentContexts,
    applyAgentContextsToSessionTree,
    listActivityPage,
    applyAgentContextsToActivity,
    appendActivityItems,
    activityWarmByKey,
    activityWarmThrottleMs: ACTIVITY_WARM_THROTTLE_MS,
    outboxReadAllItems: () => outboxAdapter.readAllItems(),
    toLocalLiveActivity,
    loadLocalTurnDetail,
    sendJson,
    safeErrorMessage,
    sendHtml,
    resolveFilesystemOpenPath,
    escapeHtml,
    statSync,
    readdirSync,
    existsSync,
    resolvePath: resolve,
    readFilePreview,
    filePreviewMaxBytes: FILE_PREVIEW_MAX_BYTES,
    filePreviewMaxDirEntries: FILE_PREVIEW_MAX_DIR_ENTRIES,
    resolveAutopilotLogCandidates,
    openPathInTerminal,
    securityHeaders: SECURITY_HEADERS,
    corsHeaders: CORS_HEADERS,
    config: {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      userId: config.userId,
    },
    isUserScopedApiKey,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
  });
  registerLiveSnapshotRoutes(apiRouter, {
    parsePositiveInt,
    readSnapshotResponseCache,
    writeSnapshotResponseCache,
    safeErrorMessage,
    readAgentContexts,
    getScopedAgentIds,
    readDiagnosticsOutboxStatus: async () => {
      if (!diagnostics?.getHealth) return null;
      const health = await diagnostics.getHealth({ probeRemote: false });
      if (!health || typeof health !== "object") return null;
      const maybeOutbox = (health as Record<string, unknown>).outbox;
      if (!maybeOutbox || typeof maybeOutbox !== "object") return null;
      return maybeOutbox as Record<string, unknown>;
    },
    readOutboxSummary: () => outboxAdapter.readSummary(),
    readOutboxItems: () => outboxAdapter.readAllItems(),
    loadLocalOpenClawSnapshot,
    toLocalSessionTree,
    toLocalLiveActivity,
    toLocalLiveAgents,
    getLiveSessions: ({ initiative, projectId, limit }) =>
      client.getLiveSessions({ initiative, projectId, limit }),
    getLiveActivity: ({ run, since, projectId, limit }) =>
      client.getLiveActivity({ run, since, projectId, limit }),
    getHandoffs: () => client.getHandoffs(),
    getLiveDecisions: ({ status, projectId, limit }) =>
      client.getLiveDecisions({ status, projectId, limit }),
    getLiveAgents: ({ initiative, projectId, includeIdle }) =>
      client.getLiveAgents({ initiative, projectId, includeIdle }),
    listInitiativeIdsForProject: ({ projectId }) =>
      listInitiativeIdsForProject({ projectId }),
    mapDecisionEntity: (entry) => mapDecisionEntity(entry as Entity),
    applyAgentContextsToSessionTree,
    applyAgentContextsToActivity,
    mergeSessionTrees,
    mergeActivities,
    listRuntimeInstances,
    injectRuntimeInstancesAsSessions,
    enrichSessionsWithRuntime,
    enrichActivityWithRuntime,
    snapshotActivityFingerprint,
    appendActivityItems,
    snapshotActivityPersistMinIntervalMs: SNAPSHOT_ACTIVITY_PERSIST_MIN_INTERVAL_MS,
    readSnapshotPersistState: () => ({
      lastFingerprint: lastSnapshotActivityFingerprint,
      lastPersistAt: lastSnapshotActivityPersistAt,
    }),
    writeSnapshotPersistState: (state) => {
      lastSnapshotActivityFingerprint = state.lastFingerprint;
      lastSnapshotActivityPersistAt = state.lastPersistAt;
    },
    parseJsonRequest,
    buildNextUpQueue: ({ initiativeId, projectId }) =>
      buildNextUpQueue({ initiativeId, projectId }),
    bulkDecideDecisions: (ids, action, input) =>
      client.bulkDecideDecisions(ids, action, input),
    runAction: (runId, action, input) => client.runAction(runId, action, input),
    listChatThreads: ({ commandCenterId, initiativeId, limit, offset }) =>
      listChatThreads({ commandCenterId, initiativeId, limit, offset }),
    sendJson,
  });
  registerRuntimeHookRoutes(apiRouter, {
    parseJsonRequest,
    pickString,
    pickNumber,
    pickHeaderString,
    resolveRuntimeHookToken,
    maskSecret,
    parseJsonSafe,
    sendJson,
    safeErrorMessage,
    randomUUID,
    listRuntimeInstances,
    writeRuntimeSseEvent,
    runtimeStreamSubscribers,
    ensureRuntimeStreamTimers,
    stopRuntimeStreamTimers,
    upsertRuntimeInstanceFromHook,
    broadcastRuntimeSse,
    clearSnapshotResponseCache,
    normalizeHookPhase,
    normalizeRuntimeSourceForReporting: (value) =>
      normalizeRuntimeSourceForReporting(value as RuntimeSourceClient),
    emitActivity: (input) =>
      client.emitActivity(input as Parameters<typeof client.emitActivity>[0]),
    securityHeaders: SECURITY_HEADERS,
    corsHeaders: CORS_HEADERS,
  });
  registerHealthRoutes(apiRouter, {
    diagnostics,
    readOutboxSummary: () => outboxAdapter.readSummary(),
    parseBooleanQuery,
    baseUrl: config.baseUrl,
    hasApiKey: Boolean(config.apiKey),
    sendJson,
    safeErrorMessage,
  });
  registerLiveTriageRoutes(apiRouter, {
    parseJsonRequest,
    sendJson,
    getDecisions: (_workspaceId) => {
      // Return cached decisions from latest snapshot, or empty array
      try {
        const cached = readSnapshotResponseCache("live-snapshot");
        if (cached && typeof cached === "object" && "decisions" in cached) {
          const decisions = (cached as Record<string, unknown>).decisions;
          if (Array.isArray(decisions)) return decisions;
        }
      } catch {
        // best effort
      }
      return [];
    },
    getBlockerEvents: () => {
      // Extract blocker events from recent activity
      // In future, this will read from a dedicated blocker store
      return [];
    },
    resolveDecisionAction: async (decisionId, action, note, optionId) => {
      try {
        await client.bulkDecideDecisions(
          [decisionId],
          action as "approve" | "reject",
          { note: note ?? undefined, optionId: optionId ?? undefined }
        );
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Decision action failed",
        };
      }
    },
  });

  return async function handler(
    req: PluginRequest,
    res: PluginResponse
  ): Promise<boolean> {
    const method = (req.method ?? "GET").toUpperCase();
    const rawUrl = req.url ?? "/";
    const [path, queryString] = rawUrl.split("?", 2);
    const url = path;
    const searchParams = new URLSearchParams(queryString ?? "");

    // Legacy deep-link compatibility:
    // Older launch paths still point at /workspace-hub. Route those into
    // the current dashboard entrypoint while preserving query params.
    if (url === "/workspace-hub" || url === "/workspace-hub/") {
      const suffix = queryString && queryString.trim().length > 0 ? `?${queryString}` : "";
      res.writeHead(302, {
        Location: `/orgx/live${suffix}`,
        ...SECURITY_HEADERS,
        ...CORS_HEADERS,
      });
      res.end();
      return true;
    }

    // Only handle /orgx paths — return false for everything else
    if (!url.startsWith("/orgx")) {
      return false;
    }

    // Handle CORS preflight
    if (method === "OPTIONS") {
      if (url.startsWith("/orgx/api/") && !isTrustedRequestSource(req.headers)) {
        sendJson(res, 403, {
          error: "Cross-origin browser requests are blocked for /orgx/api endpoints.",
        });
        return true;
      }

      res.writeHead(204, {
        ...SECURITY_HEADERS,
        ...CORS_HEADERS,
      });
      res.end();
      return true;
    }

    // ── API endpoints ──────────────────────────────────────────────────────
    if (url.startsWith("/orgx/api/")) {
      if (!isTrustedRequestSource(req.headers)) {
        sendJson(res, 403, {
          error: "Cross-origin browser requests are blocked for /orgx/api endpoints.",
        });
        return true;
      }

      const route = url.replace("/orgx/api/", "").replace(/\/+$/, "");
      const routed = apiRouter.match(method, route);
      if (routed) {
        await routed.handler({
          req,
          res,
          path: route,
          query: searchParams,
          body: undefined,
          state: {},
        });
        return true;
      }

      sendJson(res, 404, { error: "Unknown API endpoint" });
      return true;
    }

    // ── Dashboard SPA + static assets ──────────────────────────────────────
    if (!dashboardEnabled) {
      res.writeHead(404, {
        "Content-Type": "text/plain",
        ...SECURITY_HEADERS,
        ...CORS_HEADERS,
      });
      res.end("Dashboard is disabled");
      return true;
    }

    // Requests under /orgx/live
    if (url === "/orgx/live" || url.startsWith("/orgx/live/")) {
      const subPath = url.replace(/^\/orgx\/live\/?/, "");

      // Never expose source maps in shipped plugin dashboards.
      if (/\.map$/i.test(subPath)) {
        send404(res);
        return true;
      }

      // Static assets: /orgx/live/assets/* → dashboard/dist/assets/*
      // Hashed filenames get long-lived cache
      if (subPath.startsWith("assets/")) {
        const assetPath = resolveSafeDistPath(subPath);
        let isWithinAssetsDir = false;
        if (assetPath) {
          isWithinAssetsDir =
            assetPath === RESOLVED_DIST_ASSETS_DIR ||
            assetPath.startsWith(`${RESOLVED_DIST_ASSETS_DIR}${sep}`);
        }
        if (assetPath && isWithinAssetsDir && existsSync(assetPath)) {
          const assetExt = extname(assetPath).toLowerCase();
          // JS/CSS chunks can be invalidated by dashboard rebuilds while browsers retain
          // immutable cached entry chunks in local plugin environments.
          // Revalidate executable assets to avoid stale chunk graph 404s.
          const cacheControl =
            assetExt === ".js" || assetExt === ".css"
              ? "no-cache"
              : "public, max-age=31536000, immutable";
          sendFile(
            req,
            res,
            assetPath,
            cacheControl
          );
        } else {
          if (/^assets\/[A-Za-z0-9_-]+\.js$/i.test(subPath)) {
            sendStaleChunkRecovery(res);
            return true;
          }
          send404(res);
        }
        return true;
      }

      // Check for an exact file match (e.g. favicon, manifest)
      if (subPath) {
        const filePath = resolveSafeDistPath(subPath);
        if (filePath && existsSync(filePath)) {
          sendFile(req, res, filePath, "no-cache");
          return true;
        }
      }

      // SPA fallback: serve index.html for all other routes under /orgx/live
      sendIndexHtml(req, res);
      return true;
    }

    // Catch-all for /orgx but not /orgx/live or /orgx/api
    if (url === "/orgx" || url === "/orgx/") {
      // Redirect to dashboard
      res.writeHead(302, {
        Location: "/orgx/live",
        ...SECURITY_HEADERS,
        ...CORS_HEADERS,
      });
      res.end();
      return true;
    }

    send404(res);
    return true;
  };
}
