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
import { homedir } from "node:os";
import { join, extname, normalize, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import { getOrgxPluginConfigDir } from "../paths.js";
import {
  readNextUpQueuePins,
  removeNextUpQueuePin,
  setNextUpQueuePinOrder,
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
import { detectMcpHandshakeFailure, shouldKillWorker } from "../worker-supervisor.js";
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
import {
  readOpenClawGatewayPort,
  readOpenClawSettingsSnapshot,
} from "../openclaw-settings.js";
import { readSkillPackState, refreshSkillPackState, updateSkillPackPolicy } from "../skill-pack-state.js";
import { posthogCapture } from "../telemetry/posthog.js";
import { createRouter } from "./router.js";
import { summarizeActivityHeadline } from "./helpers/activity-headline.js";
import {
  createAutopilotOperations,
} from "./helpers/autopilot-operations.js";
import { createAutopilotRuntime } from "./helpers/autopilot-runtime.js";
import {
  buildWorkstreamSlicePrompt,
  createCodexBinResolver,
  ensureAutopilotSliceSchemaPath,
  fileUpdatedAtEpochMs,
  parseSliceResult,
  readFileTailSafe,
  readSliceOutputFile,
  type CodexBinInfo,
} from "./helpers/autopilot-slice-utils.js";
import { createLocalArtifactDetailFallbackBuilder } from "./helpers/artifact-fallback.js";
import {
  buildMissionControlGraph,
  DEFAULT_TOKEN_BUDGET_ASSUMPTIONS,
  dedupeStrings,
  deriveExecutionPolicy,
  isDispatchableWorkstreamStatus,
  isDoneStatus,
  isInProgressStatus,
  isTodoStatus,
  listEntitiesSafe,
  normalizeEntityMutationPayload,
  pickStringArray,
  readBudgetEnvNumber,
  resolveAutoAssignments,
  summarizeSpawnGuardBlockReason,
  type MissionControlAssignedAgent,
  type MissionControlNode,
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
import { registerLiveLegacyRoutes } from "./routes/live-legacy.js";
import { registerLiveMiscRoutes } from "./routes/live-misc.js";
import { registerLiveSnapshotRoutes } from "./routes/live-snapshot.js";
import { registerMissionControlActionsRoutes } from "./routes/mission-control-actions.js";
import { registerMissionControlReadRoutes } from "./routes/mission-control-read.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerRunControlRoutes } from "./routes/run-control.js";
import { registerRuntimeHookRoutes } from "./routes/runtime-hooks.js";
import { registerSettingsByokRoutes } from "./routes/settings-byok.js";
import { registerSummaryRoutes } from "./routes/summary.js";
import { registerWorkArtifactsRoutes } from "./routes/work-artifacts.js";

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
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
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

const ACTIVITY_WARM_THROTTLE_MS = 30_000;
const activityWarmByKey = new Map<string, number>();
const SNAPSHOT_RESPONSE_CACHE_TTL_MS = 1_500;
const SNAPSHOT_RESPONSE_CACHE_MAX_ENTRIES = 16;
const SNAPSHOT_ACTIVITY_PERSIST_MIN_INTERVAL_MS = 15_000;
const SNAPSHOT_ACTIVITY_FINGERPRINT_DEPTH = 8;
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
    if (decisionRequired || blockingDecisions > 0) return "decision";
    if (artifacts > 0) return "artifact";
    if (decisions > 0 || nonBlockingDecisions > 0) return "decision";
    return "message";
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

function parseJsonSafe<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
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
  const merged = [...(base ?? []), ...(extra ?? [])].sort((a, b) => {
    const timestampDelta = Date.parse(b.timestamp) - Date.parse(a.timestamp);
    if (timestampDelta !== 0) return timestampDelta;
    return b.id.localeCompare(a.id);
  });
  const deduped: LiveActivityItem[] = [];
  const seen = new Set<string>();
  for (const item of merged) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
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
    const isLiveLikeNodeStatus =
      nodeStatus === "running" ||
      nodeStatus === "active" ||
      nodeStatus === "in_progress" ||
      nodeStatus === "working" ||
      nodeStatus === "planning" ||
      nodeStatus === "dispatching";
    const shouldDowngradeStatusFromRuntime =
      isLiveLikeNodeStatus && (runtimeStatus === "queued" || runtimeStatus === "paused");
    const blockerReason =
      (node.blockerReason ?? "").trim() ||
      (node.status?.toLowerCase() === "blocked" || match.phase?.toLowerCase() === "blocked"
        ? (match.lastMessage ?? "").trim()
        : "");

    return {
      ...node,
      agentId: agentId || null,
      agentName: agentName || null,
      status: shouldDowngradeStatusFromRuntime ? runtimeStatus : node.status,
      state: node.state ?? match.state ?? null,
      lastEventSummary:
        shouldDowngradeStatusFromRuntime && runtimeStatus === "queued"
          ? node.lastEventSummary ?? "Recovered stale runtime; awaiting next dispatch."
          : node.lastEventSummary,
      blockerReason: blockerReason || node.blockerReason || null,
      runtimeClient: normalizeRuntimeSource(match.sourceClient),
      runtimeLabel: match.displayName,
      runtimeProvider: match.providerLogo,
      instanceId: match.id,
      lastHeartbeatAt: match.lastHeartbeatAt ?? null,
    };
  });

  return { ...input, nodes };
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

    // Only surface active runtime instances as synthetic sessions.
    // Stale instances are reconciled onto existing sessions but shouldn't appear as fresh work.
    if (instance.state !== "active") continue;

    const initiativeId = instance.initiativeId?.trim() || null;
    const workstreamId = instance.workstreamId?.trim() || null;
    const runtimeClient = normalizeRuntimeSource(instance.sourceClient);
    const fallbackAgent = deriveRuntimeFallbackAgent(instance);
    const groupId = initiativeId ?? fallbackAgent.agentId ?? `runtime:${runtimeClient}`;

    const meta =
      instance.metadata && typeof instance.metadata === "object"
        ? (instance.metadata as Record<string, unknown>)
        : {};
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
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self' https://*.useorgx.com https://*.openclaw.ai http://127.0.0.1:* http://localhost:*",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet, noimageindex",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), midi=(), magnetometer=(), gyroscope=()",
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
// src/http-handler.ts → up to plugin root → dashboard/dist
const DIST_DIR = join(__filename, "..", "..", "dashboard", "dist");
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

const IMMUTABLE_FILE_CACHE = new Map<
  string,
  { content: Buffer; contentType: string }
>();
const IMMUTABLE_FILE_CACHE_MAX = 128;
const FILE_PREVIEW_MAX_BYTES = 1_000_000;
const FILE_PREVIEW_MAX_DIR_ENTRIES = 300;

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

function sendFile(
  res: PluginResponse,
  filePath: string,
  cacheControl: string
): void {
  try {
    const shouldCacheImmutable = cacheControl.includes("immutable");
    if (shouldCacheImmutable) {
      const cached = IMMUTABLE_FILE_CACHE.get(filePath);
      if (cached) {
        res.writeHead(200, {
          "Content-Type": cached.contentType,
          "Cache-Control": cacheControl,
          ...SECURITY_HEADERS,
          ...CORS_HEADERS,
        });
        res.end(cached.content);
        return;
      }
    }

    const content = readFileSync(filePath);
    const type = contentType(filePath);
    if (shouldCacheImmutable) {
      if (IMMUTABLE_FILE_CACHE.size >= IMMUTABLE_FILE_CACHE_MAX) {
        const firstKey = IMMUTABLE_FILE_CACHE.keys().next().value as string | undefined;
        if (firstKey) IMMUTABLE_FILE_CACHE.delete(firstKey);
      }
      IMMUTABLE_FILE_CACHE.set(filePath, { content, contentType: type });
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": cacheControl,
      ...SECURITY_HEADERS,
      ...CORS_HEADERS,
    });
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

function sendIndexHtml(res: PluginResponse): void {
  const indexPath = join(DIST_DIR, "index.html");
  if (existsSync(indexPath)) {
    sendFile(res, indexPath, "no-cache, no-store, must-revalidate");
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

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function pickHeaderString(
  headers: Record<string, string | string[] | undefined>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const candidates = [key, key.toLowerCase(), key.toUpperCase()];
    for (const candidate of candidates) {
      const raw = headers[candidate];
      if (typeof raw === "string" && raw.trim().length > 0) {
        return raw.trim();
      }
      if (Array.isArray(raw)) {
        const first = raw.find(
          (value) => typeof value === "string" && value.trim().length > 0
        );
        if (first) return first.trim();
      }
    }
  }
  return null;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function toIsoString(value: string | null): string | null {
  if (!value) return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch).toISOString();
}

function mapDecisionEntity(entity: Entity) {
  const record = entity as Record<string, unknown>;
  const requestedAt = toIsoString(
    pickString(record, [
      "requestedAt",
      "requested_at",
      "createdAt",
      "created_at",
      "updatedAt",
      "updated_at",
    ])
  );
  const updatedAt = toIsoString(
    pickString(record, ["updatedAt", "updated_at", "createdAt", "created_at"])
  );

  const waitingMinutesFromEntity = pickNumber(record, [
    "waitingMinutes",
    "waiting_minutes",
    "ageMinutes",
    "age_minutes",
  ]);
  const waitingMinutes =
    waitingMinutesFromEntity ??
    (requestedAt
      ? Math.max(0, Math.floor((Date.now() - Date.parse(requestedAt)) / 60_000))
      : 0);

  return {
    id: String(record.id ?? ""),
    title: pickString(record, ["title", "name"]) ?? "Decision",
    context: pickString(record, ["context", "summary", "description", "details"]),
    status: pickString(record, ["status", "decision_status"]) ?? "pending",
    agentName: pickString(record, [
      "agentName",
      "agent_name",
      "requestedBy",
      "requested_by",
      "ownerName",
      "owner_name",
      "assignee",
      "createdBy",
      "created_by",
    ]),
    requestedAt,
    updatedAt,
    waitingMinutes,
    metadata: record,
  };
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function parseBooleanQuery(raw: string | null): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function idempotencyKey(parts: Array<string | null | undefined>): string {
  const raw = parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(":");
  const cleaned = raw.replace(/[^a-zA-Z0-9:_-]/g, "-").slice(0, 84);
  const suffix = stableHash(raw).slice(0, 20);
  return `${cleaned}:${suffix}`.slice(0, 120);
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
  //   an error stop reason.
  // ---------------------------------------------------------------------------

  type AutoContinueStopReason =
    | "budget_exhausted"
    | "blocked"
    | "completed"
    | "stopped"
    | "error";

  type AutoContinueStatus = "running" | "stopping" | "stopped";

  type NextUpRunnerSource = "assigned" | "inferred" | "fallback";
  type NextUpQueueState = "queued" | "running" | "blocked" | "idle";

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
    runnerSource: NextUpRunnerSource;
    queueState: NextUpQueueState;
    blockReason: string | null;
    isPinned: boolean;
    pinnedRank: number | null;
    autoContinue: {
      status: AutoContinueStatus;
      activeTaskId: string | null;
      activeRunId: string | null;
      stopReason: AutoContinueStopReason | null;
      updatedAt: string;
    } | null;
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

    const scopeSuffix =
      Array.isArray(input.run.allowedWorkstreamIds) && input.run.allowedWorkstreamIds.length === 1
        ? ` (${input.run.allowedWorkstreamIds[0]})`
        : "";
    const message =
      input.reason === "completed"
        ? `Autopilot stopped: current dispatch scope completed${scopeSuffix}.`
        : input.reason === "budget_exhausted"
          ? `Autopilot stopped: token budget exhausted (${input.run.tokensUsed}/${input.run.tokenBudget}).`
          : input.reason === "stopped"
            ? `Autopilot stopped by user request${scopeSuffix}.`
            : input.reason === "blocked"
              ? `Autopilot stopped: blocked pending decision${scopeSuffix}.`
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

	              await requestDecisionSafe({
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

	              await requestDecisionSafe({
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

        for (const decision of decisions) {
          await requestDecisionSafe({
            initiativeId: run.initiativeId,
            correlationId: slice.runId,
            title: decision.question.trim(),
            summary: decision.summary ?? parsed?.summary ?? null,
            urgency: decision.urgency ?? "high",
            options: Array.isArray(decision.options)
              ? decision.options.filter((opt: string) => typeof opt === "string" && opt.trim())
              : [],
            blocking:
              typeof decision.blocking === "boolean" ? decision.blocking : defaultDecisionBlocking,
          });
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
            decision_required: blockingDecisionCount > 0,
            status_updates_applied: statusUpdateResult.applied,
            status_updates_buffered: statusUpdateResult.buffered,
            output_path: slice.outputPath,
            log_path: slice.logPath,
            error: slice.lastError,
          },
	        });

	        if (slice.status !== "completed") {
	          if (slice.status === "error" && decisions.length === 0) {
	            await requestDecisionSafe({
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

          await requestDecisionSafe({
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
      selectedWorkstreamId = node.workstreamId;
      break;
    }

    if (!selectedWorkstreamId) {
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
        await requestDecisionSafe({
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
        await stopAutoContinueRun({ run, reason: "blocked", error: blockedReason });
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

    try {
      await client.updateEntity("initiative", input.initiativeId, { status: "active" });
    } catch {
      // best effort
    }

    try {
      await updateInitiativeAutoContinueState({
        initiativeId: input.initiativeId,
        run,
      });
    } catch {
      // best effort
    }

    return run;
  }

  async function buildNextUpQueue(input?: {
    initiativeId?: string | null;
  }): Promise<{ items: NextUpQueueItem[]; degraded: string[] }> {
    const degraded: string[] = [];
    const requestedInitiativeId = input?.initiativeId?.trim() || null;

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

    const initiativeResult = await listEntitiesSafe(client, "initiative", { limit: 500 });
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
        sessionTree = await client.getLiveSessions({
          initiative: requestedInitiativeId,
          limit: 500,
        });
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
        const initiativeStatus = initiativeStatusById.get(initiativeId) ?? "active";
        if (!isInitiativeActiveStatus(initiativeStatus)) continue;

        const key = `${initiativeId}:${workstreamId}`;
        const epoch = parseEpoch(node.updatedAt ?? node.lastEventAt ?? node.startedAt);
        const existing = grouped.get(key);
        if (!existing) {
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

        const runnerAgentId = (entry.latest.agentId ?? "").trim() || "main";
        const runnerAgentName =
          (entry.latest.agentName ?? "").trim() ||
          initiativeTitleById.get(`agent:${runnerAgentId}`) ||
          runnerAgentId;

          const pinKey = `${entry.initiativeId}:${entry.workstreamId}`;
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
	          runnerSource: "fallback",
	          queueState,
	          blockReason: hasBlocked
	            ? entry.blockers[0] ?? (statusValues.includes("failed") ? "Latest run failed" : "Workstream blocked")
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
      const status = pickString(record, ["status"]);
      return isInitiativeActiveStatus(status);
    });

    const agentCatalogById = new Map<string, { id: string; name: string }>();
    try {
      const catalog = await listAgents();
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
      const data = await client.getLiveAgents({
        initiative: requestedInitiativeId,
        includeIdle: true,
      });
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

    const items: NextUpQueueItem[] = [];

    for (const initiativeEntity of scopedInitiatives) {
      const initiativeRecord = initiativeEntity as Record<string, unknown>;
      const initiativeId = pickString(initiativeRecord, ["id"]);
      if (!initiativeId) continue;
      const initiativeTitle =
        pickString(initiativeRecord, ["title", "name"]) ?? initiativeId;
      const initiativeStatus = pickString(initiativeRecord, ["status"]) ?? "active";

      let graph: Awaited<ReturnType<typeof buildMissionControlGraph>>;
      try {
        graph = applyLocalInitiativeOverrideToGraph(
          await buildMissionControlGraph(client, initiativeId)
        );
      } catch (err: unknown) {
        degraded.push(
          `graph unavailable for ${initiativeId} (${safeErrorMessage(err)})`
        );
        continue;
      }

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

      for (const workstream of workstreamNodes) {
        const todoTasks = graph.recentTodos
          .map((taskId) => nodeById.get(taskId))
          .filter(
            (node) =>
              node?.type === "task" &&
              node.workstreamId === workstream.id &&
              isTodoStatus(node.status)
          ) as MissionControlNode[];

        const pinKey = `${initiativeId}:${workstream.id}`;
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
        if (preferredTask && preferredTask.type === "task" && preferredTask.workstreamId === workstream.id && isTodoStatus(preferredTask.status)) {
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
        let queueState: NextUpQueueState = autoContinueRun
          ? "running"
          : candidateTask
            ? "queued"
            : "idle";
        let blockReason: string | null = null;

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

        runningWorkstreams.add(workstream.id);

        const assignedAgent = workstream.assignedAgents[0] ?? null;
        const inferredAgent =
          graph.initiative.assignedAgents[0] ??
          liveAgentsByInitiative.get(initiativeId)?.[0] ??
          (autoContinueRun?.agentId
            ? ({
                id: autoContinueRun.agentId,
                name: agentCatalogById.get(autoContinueRun.agentId)?.name ?? autoContinueRun.agentId,
                domain: null,
              } as MissionControlAssignedAgent)
            : null);
        const runnerSource: NextUpRunnerSource = assignedAgent
          ? "assigned"
          : inferredAgent
            ? "inferred"
            : "fallback";
        const resolvedRunner = assignedAgent ?? inferredAgent;
        const runnerAgentId = resolvedRunner?.id ?? autoContinueRun?.agentId ?? "main";
        const runnerAgentName =
          resolvedRunner?.name ??
          agentCatalogById.get(runnerAgentId)?.name ??
          runnerAgentId;

        items.push({
          initiativeId,
          initiativeTitle,
          initiativeStatus,
          workstreamId: workstream.id,
          workstreamTitle: workstream.title,
          workstreamStatus: workstream.status,
          nextTaskId:
            candidateTask?.id ??
            (autoContinueRun?.activeTaskId?.trim() || null),
          nextTaskTitle:
            candidateTask?.title ??
            (autoContinueRun?.activeTaskId
              ? nodeById.get(autoContinueRun.activeTaskId)?.title ?? null
              : null),
          nextTaskPriority: candidateTask?.priorityNum ?? null,
          nextTaskDueAt: candidateTask?.dueDate ?? null,
          runnerAgentId,
          runnerAgentName,
          runnerSource,
          queueState,
          blockReason,
          isPinned: Boolean(pin),
          pinnedRank: pin ? (pinnedRankByKey.get(pinKey) ?? null) : null,
          autoContinue: autoContinueRun
            ? {
                status: autoContinueRun.status,
                activeTaskId: autoContinueRun.activeTaskId,
                activeRunId: autoContinueRun.activeRunId,
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
          items.push({
            initiativeId,
            initiativeTitle,
            initiativeStatus,
            workstreamId: workstream.id,
            workstreamTitle: workstream.title,
            workstreamStatus: workstream.status,
            nextTaskId: run.activeTaskId,
            nextTaskTitle: run.activeTaskId
              ? nodeById.get(run.activeTaskId)?.title ?? null
              : null,
            nextTaskPriority: null,
            nextTaskDueAt: null,
            runnerAgentId: run.agentId,
            runnerAgentName:
              agentCatalogById.get(run.agentId)?.name ?? run.agentId,
            runnerSource: "inferred",
            queueState: "running",
            blockReason: null,
            isPinned: Boolean(pinnedByKey.get(`${initiativeId}:${workstream.id}`)),
            pinnedRank: pinnedRankByKey.get(`${initiativeId}:${workstream.id}`) ?? null,
            autoContinue: {
              status: run.status,
              activeTaskId: run.activeTaskId,
              activeRunId: run.activeRunId,
              stopReason: run.stopReason,
              updatedAt: run.updatedAt,
            },
          });
        }
      }
    }

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
  registerMissionControlReadRoutes(apiRouter, {
    autoContinueRuns,
    defaultAutoContinueTokenBudget,
    autoContinueTickMs: AUTO_CONTINUE_TICK_MS,
    buildMissionControlGraph: (initiativeId) => buildMissionControlGraph(client, initiativeId),
    applyLocalInitiativeOverrideToGraph: (graph) =>
      applyLocalInitiativeOverrideToGraph(
        graph as {
          initiative: { id: string; status: string };
          nodes: MissionControlNode[];
        }
      ),
    buildNextUpQueue,
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
    sendJson,
    safeErrorMessage,
  });
  registerDecisionActionsRoutes(apiRouter, {
    parseJsonRequest,
    bulkDecideDecisions: (ids, action, note) => client.bulkDecideDecisions(ids, action, note),
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
    upsertNextUpQueuePin,
    removeNextUpQueuePin,
    setNextUpQueuePinOrder,
    resolveAutoAssignments,
    client,
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
    getLiveAgents: ({ initiative, includeIdle }) =>
      client.getLiveAgents({ initiative, includeIdle }),
    getLiveInitiatives: ({ id, limit }) => client.getLiveInitiatives({ id, limit }),
    getLiveDecisions: ({ status, limit }) => client.getLiveDecisions({ status, limit }),
    getHandoffs: () => client.getHandoffs(),
    loadLocalOpenClawSnapshot,
    toLocalLiveAgents,
    toLocalLiveInitiatives,
    localInitiativeStatusOverrides,
    mapDecisionEntity,
    sendJson,
    safeErrorMessage,
  });
  registerLiveLegacyRoutes(apiRouter, {
    getLiveSessions: ({ initiative, limit }) => client.getLiveSessions({ initiative, limit }),
    getLiveActivity: ({ run, since, limit }) => client.getLiveActivity({ run, since, limit }),
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
    getLiveSessions: ({ initiative, limit }) => client.getLiveSessions({ initiative, limit }),
    getLiveActivity: ({ run, since, limit }) => client.getLiveActivity({ run, since, limit }),
    getHandoffs: () => client.getHandoffs(),
    getLiveDecisions: ({ status, limit }) => client.getLiveDecisions({ status, limit }),
    getLiveAgents: ({ initiative, includeIdle }) =>
      client.getLiveAgents({ initiative, includeIdle }),
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

  return async function handler(
    req: PluginRequest,
    res: PluginResponse
  ): Promise<boolean> {
    const method = (req.method ?? "GET").toUpperCase();
    const rawUrl = req.url ?? "/";
    const [path, queryString] = rawUrl.split("?", 2);
    const url = path;
    const searchParams = new URLSearchParams(queryString ?? "");

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
            res,
            assetPath,
            cacheControl
          );
        } else {
          send404(res);
        }
        return true;
      }

      // Check for an exact file match (e.g. favicon, manifest)
      if (subPath) {
        const filePath = resolveSafeDistPath(subPath);
        if (filePath && existsSync(filePath)) {
          sendFile(res, filePath, "no-cache");
          return true;
        }
      }

      // SPA fallback: serve index.html for all other routes under /orgx/live
      sendIndexHtml(res);
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
