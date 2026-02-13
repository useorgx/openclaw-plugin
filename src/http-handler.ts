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
 *   /orgx/api/delegation/preflight → delegation preflight
 *   /orgx/api/runs/:id/checkpoints → list/create checkpoints
 *   /orgx/api/runs/:id/checkpoints/:checkpointId/restore → restore checkpoint
 *   /orgx/api/runs/:id/actions/:action → run control action
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, extname, normalize, resolve, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import { backupCorruptFileSync, writeFileAtomicSync } from "./fs-utils.js";
import { getOrgxPluginConfigDir } from "./paths.js";
import {
  readNextUpQueuePins,
  removeNextUpQueuePin,
  setNextUpQueuePinOrder,
  upsertNextUpQueuePin,
} from "./next-up-queue-store.js";

import type { OrgXClient } from "./api.js";
import type {
  OnboardingState,
  OrgXConfig,
  OrgSnapshot,
  Entity,
  LiveActivityItem,
  SessionTreeResponse,
  HandoffSummary,
  BillingStatus,
  BillingCheckoutRequest,
} from "./types.js";
import {
  formatStatus,
  formatAgents,
  formatActivity,
  formatInitiatives,
  getOnboardingState,
} from "./dashboard-api.js";
import {
  loadLocalOpenClawSnapshot,
  loadLocalTurnDetail,
  toLocalLiveActivity,
  toLocalLiveAgents,
  toLocalLiveInitiatives,
  toLocalSessionTree,
} from "./local-openclaw.js";
import { appendToOutbox } from "./outbox.js";
import { defaultOutboxAdapter, type OutboxAdapter } from "./adapters/outbox.js";
import { readAgentContexts, upsertAgentContext } from "./agent-context-store.js";
import type { AgentLaunchContext } from "./agent-context-store.js";
import {
  getAgentRun,
  markAgentRunStopped,
  readAgentRuns,
  upsertAgentRun,
} from "./agent-run-store.js";
import { readByokKeys, writeByokKeys } from "./byok-store.js";
import {
  computeMilestoneRollup,
  computeWorkstreamRollup,
} from "./reporting/rollups.js";
import {
  listRuntimeInstances,
  resolveRuntimeHookToken,
  upsertRuntimeInstanceFromHook,
  type RuntimeHookPayload,
  type RuntimeInstanceRecord,
  type RuntimeSourceClient,
} from "./runtime-instance-store.js";
import {
  readOpenClawGatewayPort,
  readOpenClawSettingsSnapshot,
  resolvePreferredOpenClawProvider,
} from "./openclaw-settings.js";

// =============================================================================
// Helpers
// =============================================================================

function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unexpected error";
}

function isUnauthorizedOrgxError(err: unknown): boolean {
  const message = safeErrorMessage(err).toLowerCase();
  return message.includes("401") || message.includes("unauthorized");
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

function maskSecret(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 8) return `${trimmed[0]}…${trimmed.slice(-1)}`;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

type RuntimeStreamSubscriber = {
  id: string;
  write: (chunk: Buffer) => boolean;
  end: () => void;
};

const runtimeStreamSubscribers = new Map<string, RuntimeStreamSubscriber>();
let runtimeStreamKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
let runtimeStreamStalenessTimer: ReturnType<typeof setInterval> | null = null;
let runtimeStreamFingerprintById: Map<string, string> = new Map();

function runtimeStreamFingerprint(instance: RuntimeInstanceRecord): string {
  return [
    instance.state,
    instance.lastHeartbeatAt ?? "",
    instance.lastEventAt ?? "",
    instance.progressPct ?? "",
    instance.phase ?? "",
  ].join("|");
}

function writeRuntimeSseEvent(
  subscriber: RuntimeStreamSubscriber,
  event: string,
  payload: unknown
): void {
  const data = JSON.stringify(payload ?? null);
  subscriber.write(Buffer.from(`event: ${event}
data: ${data}

`, "utf8"));
}

function stopRuntimeStreamTimers(): void {
  if (runtimeStreamKeepaliveTimer) {
    clearInterval(runtimeStreamKeepaliveTimer);
    runtimeStreamKeepaliveTimer = null;
  }
  if (runtimeStreamStalenessTimer) {
    clearInterval(runtimeStreamStalenessTimer);
    runtimeStreamStalenessTimer = null;
  }
  runtimeStreamFingerprintById = new Map();
}

function broadcastRuntimeSse(event: string, payload: unknown): void {
  if (runtimeStreamSubscribers.size === 0) return;

  for (const subscriber of runtimeStreamSubscribers.values()) {
    try {
      writeRuntimeSseEvent(subscriber, event, payload);
    } catch {
      try {
        subscriber.end();
      } catch {
        // ignore
      }
      runtimeStreamSubscribers.delete(subscriber.id);
    }
  }

  if (runtimeStreamSubscribers.size === 0) {
    stopRuntimeStreamTimers();
  }
}

function ensureRuntimeStreamTimers(): void {
  if (runtimeStreamKeepaliveTimer || runtimeStreamStalenessTimer) return;

  runtimeStreamKeepaliveTimer = setInterval(() => {
    if (runtimeStreamSubscribers.size === 0) {
      stopRuntimeStreamTimers();
      return;
    }

    const payload = Buffer.from(`: ping ${Date.now()}
`, "utf8");
    for (const subscriber of runtimeStreamSubscribers.values()) {
      try {
        subscriber.write(payload);
      } catch {
        try {
          subscriber.end();
        } catch {
          // ignore
        }
        runtimeStreamSubscribers.delete(subscriber.id);
      }
    }
  }, 20_000);
  runtimeStreamKeepaliveTimer.unref?.();

  runtimeStreamStalenessTimer = setInterval(() => {
    if (runtimeStreamSubscribers.size === 0) {
      stopRuntimeStreamTimers();
      return;
    }

    // listRuntimeInstances applies staleness before returning.
    const instances = listRuntimeInstances({ limit: 600 });
    const nextFingerprintById = new Map<string, string>();

    for (const instance of instances) {
      const fingerprint = runtimeStreamFingerprint(instance);
      nextFingerprintById.set(instance.id, fingerprint);

      const previous = runtimeStreamFingerprintById.get(instance.id);
      if (previous && previous === fingerprint) {
        continue;
      }

      runtimeStreamFingerprintById.set(instance.id, fingerprint);
      broadcastRuntimeSse("runtime.updated", instance);
    }

    runtimeStreamFingerprintById = nextFingerprintById;
  }, 15_000);
  runtimeStreamStalenessTimer.unref?.();
}

function modelImpliesByok(model: string | null): boolean {
  const lower = (model ?? "").trim().toLowerCase();
  if (!lower) return false;
  return (
    lower.includes("openrouter") ||
    lower.includes("anthropic") ||
    lower.includes("openai")
  );
}

async function fetchBillingStatusSafe(client: OrgXClient): Promise<BillingStatus | null> {
  try {
    return await client.getBillingStatus();
  } catch {
    return null;
  }
}

function resolveByokEnvOverrides(): Record<string, string> {
  const stored = readByokKeys();
  const env: Record<string, string> = {};
  const openai = stored?.openaiApiKey?.trim() ?? "";
  const anthropic = stored?.anthropicApiKey?.trim() ?? "";
  const openrouter = stored?.openrouterApiKey?.trim() ?? "";

  if (openai) env.OPENAI_API_KEY = openai;
  if (anthropic) env.ANTHROPIC_API_KEY = anthropic;
  if (openrouter) env.OPENROUTER_API_KEY = openrouter;

  return env;
}

async function runCommandCollect(input: {
  command: string;
  args: string[];
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  return await new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      env: input.env ? { ...process.env, ...input.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = timeoutMs
      ? setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // best effort
          }
          reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: typeof code === "number" ? code : null });
    });
  });
}

async function listOpenClawAgents(): Promise<Array<Record<string, unknown>>> {
  const result = await runCommandCollect({
    command: "openclaw",
    args: ["agents", "list", "--json"],
    timeoutMs: 5_000,
    env: resolveByokEnvOverrides(),
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "openclaw agents list failed");
  }
  const parsed = parseJsonSafe<unknown>(result.stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("openclaw agents list returned invalid JSON");
  }
  return parsed.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
}

function spawnOpenClawAgentTurn(input: {
  agentId: string;
  sessionId: string;
  message: string;
  thinking?: string | null;
}): { pid: number | null } {
  const args = [
    "agent",
    "--agent",
    input.agentId,
    "--session-id",
    input.sessionId,
    "--message",
    input.message,
  ];
  if (input.thinking) {
    args.push("--thinking", input.thinking);
  }

  const child = spawn("openclaw", args, {
    env: { ...process.env, ...resolveByokEnvOverrides() },
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return { pid: child.pid ?? null };
}

type OpenClawProvider = "anthropic" | "openrouter" | "openai";

function normalizeOpenClawProvider(value: string | null): OpenClawProvider | null {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "auto") return null;
  if (raw === "claude") return "anthropic";
  if (raw === "anthropic") return "anthropic";
  if (raw === "openrouter" || raw === "open-router") return "openrouter";
  if (raw === "openai") return "openai";
  return null;
}

async function setOpenClawAgentModel(input: { agentId: string; model: string }): Promise<void> {
  const agentId = input.agentId.trim();
  const model = input.model.trim();
  if (!agentId || !model) {
    throw new Error("agentId and model are required");
  }

  const result = await runCommandCollect({
    command: "openclaw",
    args: ["models", "--agent", agentId, "set", model],
    timeoutMs: 10_000,
    env: resolveByokEnvOverrides(),
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `openclaw models set failed for ${agentId}`);
  }
}

async function listOpenClawProviderModels(input: {
  agentId: string;
  provider: OpenClawProvider;
}): Promise<Array<{ key: string; tags: string[] }>> {
  const providerArgs = input.provider === "openai" ? ["openai-codex", "openai"] : [input.provider];
  let lastError: Error | null = null;

  for (const providerArg of providerArgs) {
    const result = await runCommandCollect({
      command: "openclaw",
      args: [
        "models",
        "--agent",
        input.agentId,
        "list",
        "--provider",
        providerArg,
        "--json",
      ],
      timeoutMs: 10_000,
      env: resolveByokEnvOverrides(),
    });
    if (result.exitCode !== 0) {
      lastError = new Error(result.stderr.trim() || "openclaw models list failed");
      continue;
    }

    const parsed = parseJsonSafe<unknown>(result.stdout);
    if (!parsed || typeof parsed !== "object") {
      const trimmed = result.stdout.trim();
      if (!trimmed || /no models found/i.test(trimmed)) {
        if (providerArg === providerArgs[providerArgs.length - 1]) return [];
        continue;
      }
      lastError = new Error("openclaw models list returned invalid JSON");
      continue;
    }

    const modelsRaw =
      "models" in parsed && Array.isArray((parsed as Record<string, unknown>).models)
        ? ((parsed as Record<string, unknown>).models as unknown[])
        : [];

    const models = modelsRaw
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const row = entry as Record<string, unknown>;
        const key = typeof row.key === "string" ? row.key.trim() : "";
        const tags = Array.isArray(row.tags)
          ? row.tags.filter((t): t is string => typeof t === "string")
          : [];
        if (!key) return null;
        return { key, tags };
      })
      .filter((entry): entry is { key: string; tags: string[] } => Boolean(entry));

    if (models.length > 0 || providerArg === providerArgs[providerArgs.length - 1]) {
      return models;
    }
  }

  throw lastError ?? new Error("openclaw models list failed");
}

function pickPreferredModel(models: Array<{ key: string; tags: string[] }>): string | null {
  if (models.length === 0) return null;
  const preferred = models.find((m) => m.tags.some((t) => t === "default"));
  return preferred?.key ?? models[0]?.key ?? null;
}

async function configureOpenClawProviderRouting(input: {
  agentId: string;
  provider: OpenClawProvider;
  requestedModel?: string | null;
}): Promise<{ provider: OpenClawProvider; model: string }> {
  const requestedModel = (input.requestedModel ?? "").trim() || null;

  // Fast path: use known aliases where possible.
  const aliasByProvider: Record<OpenClawProvider, string | null> = {
    anthropic: "sonnet",
    openrouter: "sonnet",
    openai: null,
  };

  const candidate = requestedModel ?? aliasByProvider[input.provider];
  if (candidate) {
    try {
      await setOpenClawAgentModel({ agentId: input.agentId, model: candidate });
      return { provider: input.provider, model: candidate };
    } catch {
      // Fall through to discovery-based selection.
    }
  }

  const models = await listOpenClawProviderModels({
    agentId: input.agentId,
    provider: input.provider,
  });
  const selected = pickPreferredModel(models);
  if (!selected) {
    throw new Error(
      `No ${input.provider} models configured for agent ${input.agentId}. Add a model in OpenClaw and retry.`
    );
  }

  await setOpenClawAgentModel({ agentId: input.agentId, model: selected });
  return { provider: input.provider, model: selected };
}

function resolveAutoOpenClawProvider(): OpenClawProvider | null {
  try {
    const settings = readOpenClawSettingsSnapshot();
    const provider = resolvePreferredOpenClawProvider(settings.raw);
    if (!provider) return null;
    return provider;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopDetachedProcess(pid: number): Promise<{ stopped: boolean; wasRunning: boolean }> {
  const alive = isPidAlive(pid);
  if (!alive) {
    return { stopped: true, wasRunning: false };
  }

  const tryKill = (signal: NodeJS.Signals) => {
    try {
      // Detached child becomes its own process group (pgid = pid) on Unix.
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to direct pid kill.
    }
    try {
      process.kill(pid, signal);
    } catch {
      // ignore
    }
  };

  tryKill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 450));
  if (isPidAlive(pid)) {
    tryKill("SIGKILL");
  }

  return { stopped: !isPidAlive(pid), wasRunning: true };
}

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

function applyAgentContextsToSessionTree(
  input: SessionTreeResponse,
  contexts: Record<string, AgentLaunchContext>
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
    const agentId = node.agentId?.trim() ?? "";
    if (!agentId) return node;
    const ctx = contexts[agentId];
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
  contexts: Record<string, AgentLaunchContext>
): LiveActivityItem[] {
  if (!Array.isArray(input)) return [];
  return input.map((item) => {
    const agentId = item.agentId?.trim() ?? "";
    if (!agentId) return item;
    const ctx = contexts[agentId];
    const initiativeId = ctx?.initiativeId?.trim() ?? "";
    if (!initiativeId) return item;

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

    return {
      ...item,
      initiativeId,
      metadata,
    };
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
  const merged = [...(base ?? []), ...(extra ?? [])].sort(
    (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
  );
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

    return {
      ...node,
      runtimeClient: normalizeRuntimeSource(match.sourceClient),
      runtimeLabel: match.displayName,
      runtimeProvider: match.providerLogo,
      instanceId: match.id,
      lastHeartbeatAt: match.lastHeartbeatAt ?? null,
    };
  });

  return { ...input, nodes };
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

const ACTIVITY_HEADLINE_TIMEOUT_MS = 4_000;
const ACTIVITY_HEADLINE_CACHE_TTL_MS = 12 * 60 * 60_000;
const ACTIVITY_HEADLINE_CACHE_MAX = 1_000;
const ACTIVITY_HEADLINE_MAX_INPUT_CHARS = 8_000;
const DEFAULT_ACTIVITY_HEADLINE_MODEL = "openai/gpt-4.1-nano";

type ActivityHeadlineSource = "llm" | "heuristic";

interface ActivityHeadlineCacheEntry {
  headline: string;
  source: ActivityHeadlineSource;
  expiresAt: number;
}

const activityHeadlineCache = new Map<string, ActivityHeadlineCacheEntry>();
let resolvedActivitySummaryApiKey: string | null | undefined;

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripMarkdownLite(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function cleanActivityHeadline(value: string): string {
  const lines = stripMarkdownLite(value)
    .split("\n")
    .map((line) => normalizeSpaces(line))
    .filter((line) => line.length > 0 && !/^\|?[:\-| ]+\|?$/.test(line));
  const headline = lines[0] ?? "";
  if (!headline) return "";
  if (headline.length <= 108) return headline;
  return `${headline.slice(0, 107).trimEnd()}…`;
}

function heuristicActivityHeadline(text: string, title?: string | null): string {
  const cleanedText = cleanActivityHeadline(text);
  if (cleanedText.length > 0) return cleanedText;
  const cleanedTitle = cleanActivityHeadline(title ?? "");
  if (cleanedTitle.length > 0) return cleanedTitle;
  return "Activity update";
}

function resolveActivitySummaryApiKey(): string | null {
  if (resolvedActivitySummaryApiKey !== undefined) {
    return resolvedActivitySummaryApiKey;
  }

  const candidates = [
    process.env.ORGX_ACTIVITY_SUMMARY_API_KEY ?? "",
    process.env.OPENROUTER_API_KEY ?? "",
  ];

  const key = candidates.find((candidate) => candidate.trim().length > 0)?.trim() ?? "";
  resolvedActivitySummaryApiKey = key || null;
  return resolvedActivitySummaryApiKey;
}

function trimActivityHeadlineCache(): void {
  while (activityHeadlineCache.size > ACTIVITY_HEADLINE_CACHE_MAX) {
    const firstKey = activityHeadlineCache.keys().next().value;
    if (!firstKey) break;
    activityHeadlineCache.delete(firstKey);
  }
}

function extractCompletionText(payload: Record<string, unknown>): string | null {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;

  const firstRecord = first as Record<string, unknown>;
  const message = firstRecord.message;
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      const textParts = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (!part || typeof part !== "object") return "";
          const record = part as Record<string, unknown>;
          return typeof record.text === "string" ? record.text : "";
        })
        .filter((part) => part.length > 0);
      if (textParts.length > 0) {
        return textParts.join(" ");
      }
    }
  }

  return pickString(firstRecord, ["text", "content"]);
}

async function summarizeActivityHeadline(
  input: {
    text: string;
    title?: string | null;
    type?: string | null;
  }
): Promise<{ headline: string; source: ActivityHeadlineSource; model: string | null }> {
  const normalizedText = normalizeSpaces(input.text).slice(0, ACTIVITY_HEADLINE_MAX_INPUT_CHARS);
  const normalizedTitle = normalizeSpaces(input.title ?? "");
  const normalizedType = normalizeSpaces(input.type ?? "");
  const heuristic = heuristicActivityHeadline(normalizedText, normalizedTitle);

  const cacheKey = createHash("sha256")
    .update(`${normalizedType}\n${normalizedTitle}\n${normalizedText}`)
    .digest("hex");

  const cached = activityHeadlineCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { headline: cached.headline, source: cached.source, model: null };
  }

  const apiKey = resolveActivitySummaryApiKey();
  if (!apiKey) {
    activityHeadlineCache.set(cacheKey, {
      headline: heuristic,
      source: "heuristic",
      expiresAt: Date.now() + ACTIVITY_HEADLINE_CACHE_TTL_MS,
    });
    trimActivityHeadlineCache();
    return { headline: heuristic, source: "heuristic", model: null };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ACTIVITY_HEADLINE_TIMEOUT_MS);

  const model = process.env.ORGX_ACTIVITY_SUMMARY_MODEL?.trim() || DEFAULT_ACTIVITY_HEADLINE_MODEL;
  const prompt = [
    "Create one short activity title for a dashboard header.",
    "Rules:",
    "- Max 96 characters.",
    "- Keep key numbers/status markers (for example: 15 tasks, 0 blocked).",
    "- No markdown, no quotes, no trailing period unless needed.",
    "- Prefer plain language over jargon.",
    "",
    `Type: ${normalizedType || "activity"}`,
    normalizedTitle ? `Current title: ${normalizedTitle}` : "",
    "Full detail:",
    normalizedText,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 48,
        messages: [
          {
            role: "system",
            content:
              "You write concise activity headers for operational dashboards. Return only the header text.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`headline model request failed (${response.status})`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const generated = cleanActivityHeadline(extractCompletionText(payload) ?? "");
    const headline = generated || heuristic;
    const source: ActivityHeadlineSource = generated ? "llm" : "heuristic";
    activityHeadlineCache.set(cacheKey, {
      headline,
      source,
      expiresAt: Date.now() + ACTIVITY_HEADLINE_CACHE_TTL_MS,
    });
    trimActivityHeadlineCache();
    return { headline, source, model };
  } catch {
    activityHeadlineCache.set(cacheKey, {
      headline: heuristic,
      source: "heuristic",
      expiresAt: Date.now() + ACTIVITY_HEADLINE_CACHE_TTL_MS,
    });
    trimActivityHeadlineCache();
    return { headline: heuristic, source: "heuristic", model: null };
  } finally {
    clearTimeout(timeout);
  }
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

type MissionControlNodeType = "initiative" | "workstream" | "milestone" | "task";

interface MissionControlAssignedAgent {
  id: string;
  name: string;
  domain: string | null;
}

interface MissionControlNode {
  id: string;
  type: MissionControlNodeType;
  title: string;
  status: string;
  parentId: string | null;
  initiativeId: string | null;
  workstreamId: string | null;
  milestoneId: string | null;
  priorityNum: number;
  priorityLabel: string | null;
  dependencyIds: string[];
  dueDate: string | null;
  etaEndAt: string | null;
  expectedDurationHours: number;
  expectedBudgetUsd: number;
  assignedAgents: MissionControlAssignedAgent[];
  updatedAt: string | null;
}

const ORGX_SKILL_BY_DOMAIN: Record<string, string> = {
  engineering: "orgx-engineering-agent",
  product: "orgx-product-agent",
  marketing: "orgx-marketing-agent",
  sales: "orgx-sales-agent",
  operations: "orgx-operations-agent",
  design: "orgx-design-agent",
  orchestration: "orgx-orchestrator-agent",
};

function normalizeExecutionDomain(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "orchestrator") return "orchestration";
  if (raw === "ops") return "operations";
  return Object.prototype.hasOwnProperty.call(ORGX_SKILL_BY_DOMAIN, raw)
    ? raw
    : null;
}

function inferExecutionDomainFromText(...values: Array<string | null | undefined>): string {
  const text = values
    .map((value) => (value ?? "").trim().toLowerCase())
    .filter((value) => value.length > 0)
    .join(" ");
  if (!text) return "engineering";
  if (/\b(marketing|campaign|copy|ad|content)\b/.test(text)) return "marketing";
  if (/\b(sales|meddic|pipeline|deal|outreach)\b/.test(text)) return "sales";
  if (/\b(design|ui|ux|brand|wcag)\b/.test(text)) return "design";
  if (/\b(product|prd|roadmap|prioritization)\b/.test(text)) return "product";
  if (/\b(ops|operations|incident|reliability|oncall|slo)\b/.test(text)) return "operations";
  if (/\b(orchestration|dispatch|handoff)\b/.test(text)) return "orchestration";
  return "engineering";
}

function deriveExecutionPolicy(
  taskNode: MissionControlNode,
  workstreamNode: MissionControlNode | null
): { domain: string; requiredSkills: string[] } {
  const domainCandidate =
    taskNode.assignedAgents
      .map((agent) => normalizeExecutionDomain(agent.domain))
      .find((domain): domain is string => Boolean(domain)) ??
    (workstreamNode
      ? workstreamNode.assignedAgents
          .map((agent) => normalizeExecutionDomain(agent.domain))
          .find((domain): domain is string => Boolean(domain))
      : null) ??
    inferExecutionDomainFromText(taskNode.title, workstreamNode?.title ?? null);

  const domain = normalizeExecutionDomain(domainCandidate) ?? "engineering";
  const requiredSkill = ORGX_SKILL_BY_DOMAIN[domain] ?? ORGX_SKILL_BY_DOMAIN.engineering;
  return { domain, requiredSkills: [requiredSkill] };
}

function spawnGuardIsRateLimited(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const record = result as Record<string, unknown>;
  const checks = record.checks;
  if (!checks || typeof checks !== "object") return false;
  const rateLimit = (checks as Record<string, unknown>).rateLimit;
  if (!rateLimit || typeof rateLimit !== "object") return false;
  return (rateLimit as Record<string, unknown>).passed === false;
}

function summarizeSpawnGuardBlockReason(result: unknown): string {
  if (!result || typeof result !== "object") return "Spawn guard denied dispatch.";
  const record = result as Record<string, unknown>;
  const blockedReason = pickString(record, ["blockedReason", "blocked_reason"]);
  if (blockedReason) return blockedReason;
  if (spawnGuardIsRateLimited(result)) {
    return "Spawn guard rate limit reached.";
  }
  return "Spawn guard denied dispatch.";
}

interface MissionControlEdge {
  from: string;
  to: string;
  kind: "depends_on";
}

const DEFAULT_DURATION_HOURS: Record<MissionControlNodeType, number> = {
  initiative: 40,
  workstream: 16,
  milestone: 6,
  task: 2,
};

interface BudgetEnvBounds {
  min?: number;
  max?: number;
}

function readBudgetEnvNumber(name: string, fallback: number, bounds: BudgetEnvBounds = {}): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (typeof bounds.min === "number" && parsed < bounds.min) return fallback;
  if (typeof bounds.max === "number" && parsed > bounds.max) return fallback;
  return parsed;
}

const DEFAULT_TOKEN_MODEL_PRICING_USD_PER_1M = {
  // GPT-5.3 Codex API pricing is not published yet; use GPT-5.2 Codex pricing as proxy.
  gpt53CodexProxy: {
    input: readBudgetEnvNumber("ORGX_BUDGET_GPT53_CODEX_INPUT_PER_1M", 1.75, { min: 0 }),
    cachedInput: readBudgetEnvNumber("ORGX_BUDGET_GPT53_CODEX_CACHED_INPUT_PER_1M", 0.175, {
      min: 0,
    }),
    output: readBudgetEnvNumber("ORGX_BUDGET_GPT53_CODEX_OUTPUT_PER_1M", 14, { min: 0 }),
  },
  opus46: {
    input: readBudgetEnvNumber("ORGX_BUDGET_OPUS46_INPUT_PER_1M", 5, { min: 0 }),
    // Anthropic does not publish a fixed cached-input rate on the model page.
    cachedInput: readBudgetEnvNumber("ORGX_BUDGET_OPUS46_CACHED_INPUT_PER_1M", 5, { min: 0 }),
    output: readBudgetEnvNumber("ORGX_BUDGET_OPUS46_OUTPUT_PER_1M", 25, { min: 0 }),
  },
};

const DEFAULT_TOKEN_BUDGET_ASSUMPTIONS = {
  tokensPerHour: readBudgetEnvNumber("ORGX_BUDGET_TOKENS_PER_HOUR", 1_200_000, { min: 1 }),
  inputShare: readBudgetEnvNumber("ORGX_BUDGET_INPUT_TOKEN_SHARE", 0.86, { min: 0, max: 1 }),
  cachedInputShare: readBudgetEnvNumber("ORGX_BUDGET_CACHED_INPUT_SHARE", 0.15, {
    min: 0,
    max: 1,
  }),
  contingencyMultiplier: readBudgetEnvNumber("ORGX_BUDGET_CONTINGENCY_MULTIPLIER", 1.3, {
    min: 0.1,
  }),
  roundingStepUsd: readBudgetEnvNumber("ORGX_BUDGET_ROUNDING_STEP_USD", 5, { min: 0.01 }),
};

const DEFAULT_TOKEN_MODEL_MIX = {
  gpt53CodexProxy: 0.7,
  opus46: 0.3,
};

function modelCostPerMillionTokensUsd(pricing: {
  input: number;
  cachedInput: number;
  output: number;
}): number {
  const inputShare = DEFAULT_TOKEN_BUDGET_ASSUMPTIONS.inputShare;
  const outputShare = Math.max(0, 1 - inputShare);
  const cachedShare = DEFAULT_TOKEN_BUDGET_ASSUMPTIONS.cachedInputShare;
  const uncachedShare = Math.max(0, 1 - cachedShare);
  const effectiveInputRate = pricing.input * uncachedShare + pricing.cachedInput * cachedShare;
  return inputShare * effectiveInputRate + outputShare * pricing.output;
}

function estimateBudgetUsdFromDurationHours(durationHours: number): number {
  if (!Number.isFinite(durationHours) || durationHours <= 0) return 0;
  const blendedPerMillionUsd =
    DEFAULT_TOKEN_MODEL_MIX.gpt53CodexProxy *
      modelCostPerMillionTokensUsd(DEFAULT_TOKEN_MODEL_PRICING_USD_PER_1M.gpt53CodexProxy) +
    DEFAULT_TOKEN_MODEL_MIX.opus46 *
      modelCostPerMillionTokensUsd(DEFAULT_TOKEN_MODEL_PRICING_USD_PER_1M.opus46);
  const tokenMillions =
    (durationHours * DEFAULT_TOKEN_BUDGET_ASSUMPTIONS.tokensPerHour) / 1_000_000;
  const rawBudgetUsd =
    tokenMillions *
    blendedPerMillionUsd *
    DEFAULT_TOKEN_BUDGET_ASSUMPTIONS.contingencyMultiplier;
  const roundedBudgetUsd =
    Math.round(rawBudgetUsd / DEFAULT_TOKEN_BUDGET_ASSUMPTIONS.roundingStepUsd) *
    DEFAULT_TOKEN_BUDGET_ASSUMPTIONS.roundingStepUsd;
  return Math.max(0, roundedBudgetUsd);
}

function isLegacyHourlyBudget(budgetUsd: number, durationHours: number): boolean {
  if (!Number.isFinite(budgetUsd) || !Number.isFinite(durationHours) || durationHours <= 0) {
    return false;
  }
  const legacyHourlyBudget = durationHours * 40;
  return Math.abs(budgetUsd - legacyHourlyBudget) <= 0.5;
}

const DEFAULT_BUDGET_USD: Record<MissionControlNodeType, number> = {
  initiative: estimateBudgetUsdFromDurationHours(DEFAULT_DURATION_HOURS.initiative),
  workstream: estimateBudgetUsdFromDurationHours(DEFAULT_DURATION_HOURS.workstream),
  milestone: estimateBudgetUsdFromDurationHours(DEFAULT_DURATION_HOURS.milestone),
  task: estimateBudgetUsdFromDurationHours(DEFAULT_DURATION_HOURS.task),
};

const PRIORITY_LABEL_TO_NUM: Record<string, number> = {
  urgent: 10,
  high: 25,
  medium: 50,
  low: 75,
};

function clampPriority(value: number): number {
  if (!Number.isFinite(value)) return 60;
  return Math.max(1, Math.min(100, Math.round(value)));
}

function mapPriorityNumToLabel(priorityNum: number): string {
  if (priorityNum <= 12) return "urgent";
  if (priorityNum <= 30) return "high";
  if (priorityNum <= 60) return "medium";
  return "low";
}

function getRecordMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const metadata = record.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  return {};
}

function extractBudgetUsdFromText(...texts: Array<string | null | undefined>): number | null {
  for (const text of texts) {
    if (typeof text !== "string" || text.trim().length === 0) continue;
    const moneyMatch = /(?:expected\s+budget|budget)[^0-9$]{0,24}\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i.exec(
      text
    );
    if (!moneyMatch) continue;
    const numeric = Number(moneyMatch[1].replace(/,/g, ""));
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return null;
}

function extractDurationHoursFromText(
  ...texts: Array<string | null | undefined>
): number | null {
  for (const text of texts) {
    if (typeof text !== "string" || text.trim().length === 0) continue;
    const durationMatch = /(?:expected\s+duration|duration)[^0-9]{0,24}([0-9]+(?:\.[0-9]+)?)\s*h/i.exec(
      text
    );
    if (!durationMatch) continue;
    const numeric = Number(durationMatch[1]);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return null;
}

function pickStringArray(
  record: Record<string, unknown>,
  keys: string[]
): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      const items = value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (items.length > 0) return items;
    }
    if (typeof value === "string") {
      const items = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (items.length > 0) return items;
    }
  }
  return [];
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function normalizePriorityForEntity(record: Record<string, unknown>): {
  priorityNum: number;
  priorityLabel: string | null;
} {
  const explicitPriorityNum = pickNumber(record, [
    "priority_num",
    "priorityNum",
    "priority_number",
  ]);
  const priorityLabelRaw = pickString(record, ["priority", "priority_label"]);

  if (explicitPriorityNum !== null) {
    const clamped = clampPriority(explicitPriorityNum);
    return {
      priorityNum: clamped,
      priorityLabel: priorityLabelRaw ?? mapPriorityNumToLabel(clamped),
    };
  }

  if (priorityLabelRaw) {
    const mapped = PRIORITY_LABEL_TO_NUM[priorityLabelRaw.toLowerCase()] ?? 60;
    return {
      priorityNum: mapped,
      priorityLabel: priorityLabelRaw.toLowerCase(),
    };
  }

  return {
    priorityNum: 60,
    priorityLabel: null,
  };
}

function normalizeDependencies(record: Record<string, unknown>): string[] {
  const metadata = getRecordMetadata(record);
  const direct = pickStringArray(record, [
    "depends_on",
    "dependsOn",
    "dependency_ids",
    "dependencyIds",
    "dependencies",
  ]);
  const nested = pickStringArray(metadata, [
    "depends_on",
    "dependsOn",
    "dependency_ids",
    "dependencyIds",
    "dependencies",
  ]);
  return dedupeStrings([...direct, ...nested]);
}

function normalizeAssignedAgents(
  record: Record<string, unknown>
): MissionControlAssignedAgent[] {
  const metadata = getRecordMetadata(record);
  const ids = dedupeStrings([
    ...pickStringArray(record, ["assigned_agent_ids", "assignedAgentIds"]),
    ...pickStringArray(metadata, ["assigned_agent_ids", "assignedAgentIds"]),
  ]);
  const names = dedupeStrings([
    ...pickStringArray(record, ["assigned_agent_names", "assignedAgentNames"]),
    ...pickStringArray(metadata, ["assigned_agent_names", "assignedAgentNames"]),
  ]);

  const objectCandidates = [
    record.assigned_agents,
    record.assignedAgents,
    metadata.assigned_agents,
    metadata.assignedAgents,
  ];
  const fromObjects: MissionControlAssignedAgent[] = [];
  for (const candidate of objectCandidates) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      const id = pickString(item, ["id", "agent_id", "agentId"]) ?? "";
      const name = pickString(item, ["name", "agent_name", "agentName"]) ?? id;
      if (!name) continue;
      fromObjects.push({
        id: id || `name:${name}`,
        name,
        domain: pickString(item, ["domain", "role"]),
      });
    }
  }

  const merged: MissionControlAssignedAgent[] = [...fromObjects];
  if (merged.length === 0 && (names.length > 0 || ids.length > 0)) {
    const maxLen = Math.max(names.length, ids.length);
    for (let i = 0; i < maxLen; i += 1) {
      const id = ids[i] ?? `name:${names[i] ?? `agent-${i + 1}`}`;
      const name = names[i] ?? ids[i] ?? `Agent ${i + 1}`;
      merged.push({ id, name, domain: null });
    }
  }

  const seen = new Set<string>();
  const deduped: MissionControlAssignedAgent[] = [];
  for (const item of merged) {
    const key = `${item.id}:${item.name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function toMissionControlNode(
  type: MissionControlNodeType,
  entity: Entity,
  fallbackInitiativeId: string
): MissionControlNode {
  const record = entity as Record<string, unknown>;
  const metadata = getRecordMetadata(record);
  const initiativeId =
    pickString(record, ["initiative_id", "initiativeId"]) ??
    pickString(metadata, ["initiative_id", "initiativeId"]) ??
    (type === "initiative" ? String(record.id ?? fallbackInitiativeId) : fallbackInitiativeId);

  const workstreamId =
    type === "workstream"
      ? String(record.id ?? "")
      : pickString(record, ["workstream_id", "workstreamId"]) ??
        pickString(metadata, ["workstream_id", "workstreamId"]);

  const milestoneId =
    type === "milestone"
      ? String(record.id ?? "")
      : pickString(record, ["milestone_id", "milestoneId"]) ??
        pickString(metadata, ["milestone_id", "milestoneId"]);

  const parentIdRaw =
    pickString(record, ["parentId", "parent_id"]) ??
    pickString(metadata, ["parentId", "parent_id"]);

  const parentId =
    parentIdRaw ??
    (type === "initiative"
      ? null
      : type === "workstream"
        ? initiativeId
        : type === "milestone"
          ? workstreamId ?? initiativeId
          : milestoneId ?? workstreamId ?? initiativeId);

  const status =
    pickString(record, ["status"]) ??
    (type === "task" ? "todo" : "planned");

  const dueDate = toIsoString(
    pickString(record, ["due_date", "dueDate", "target_date", "targetDate"])
  );
  const etaEndAt = toIsoString(
    pickString(record, ["eta_end_at", "etaEndAt"])
  );
  const expectedDuration =
    pickNumber(record, [
      "expected_duration_hours",
      "expectedDurationHours",
      "duration_hours",
      "durationHours",
    ]) ??
    pickNumber(metadata, [
      "expected_duration_hours",
      "expectedDurationHours",
      "duration_hours",
      "durationHours",
    ]) ??
    extractDurationHoursFromText(
      pickString(record, ["description", "summary", "context"]),
      pickString(metadata, ["description", "summary", "context"])
    ) ??
    DEFAULT_DURATION_HOURS[type];

  const explicitBudget =
    pickNumber(record, [
      "expected_budget_usd",
      "expectedBudgetUsd",
      "budget_usd",
      "budgetUsd",
    ]) ??
    pickNumber(metadata, [
      "expected_budget_usd",
      "expectedBudgetUsd",
      "budget_usd",
      "budgetUsd",
    ]);
  const extractedBudget =
    extractBudgetUsdFromText(
      pickString(record, ["description", "summary", "context"]),
      pickString(metadata, ["description", "summary", "context"])
    ) ?? null;
  const tokenModeledBudget =
    estimateBudgetUsdFromDurationHours(
      expectedDuration > 0 ? expectedDuration : DEFAULT_DURATION_HOURS[type]
    ) || DEFAULT_BUDGET_USD[type];
  const expectedBudget =
    explicitBudget ??
    (typeof extractedBudget === "number"
      ? isLegacyHourlyBudget(extractedBudget, expectedDuration)
        ? tokenModeledBudget
        : extractedBudget
      : DEFAULT_BUDGET_USD[type]);

  const priority = normalizePriorityForEntity(record);

  return {
    id: String(record.id ?? ""),
    type,
    title:
      pickString(record, ["title", "name"]) ??
      `${type[0].toUpperCase()}${type.slice(1)} ${String(record.id ?? "")}`,
    status,
    parentId: parentId ?? null,
    initiativeId: initiativeId ?? null,
    workstreamId: workstreamId ?? null,
    milestoneId: milestoneId ?? null,
    priorityNum: priority.priorityNum,
    priorityLabel: priority.priorityLabel,
    dependencyIds: normalizeDependencies(record),
    dueDate,
    etaEndAt,
    expectedDurationHours:
      expectedDuration > 0 ? expectedDuration : DEFAULT_DURATION_HOURS[type],
    expectedBudgetUsd:
      expectedBudget >= 0 ? expectedBudget : DEFAULT_BUDGET_USD[type],
    assignedAgents: normalizeAssignedAgents(record),
    updatedAt: toIsoString(
      pickString(record, [
        "updated_at",
        "updatedAt",
        "created_at",
        "createdAt",
      ])
    ),
  };
}

function isTodoStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return (
    normalized === "todo" ||
    normalized === "not_started" ||
    normalized === "planned" ||
    normalized === "backlog" ||
    normalized === "pending"
  );
}

function isInProgressStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return (
    normalized === "in_progress" ||
    normalized === "active" ||
    normalized === "running" ||
    normalized === "queued"
  );
}

function isDispatchableWorkstreamStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  if (!normalized) return true;
  return !(
    normalized === "blocked" ||
    normalized === "done" ||
    normalized === "completed" ||
    normalized === "cancelled" ||
    normalized === "archived" ||
    normalized === "deleted"
  );
}

function isDoneStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return (
    normalized === "done" ||
    normalized === "completed" ||
    normalized === "cancelled" ||
    normalized === "archived" ||
    normalized === "deleted"
  );
}

function detectCycleEdgeKeys(edges: MissionControlEdge[]): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleEdgeKeys = new Set<string>();

  function dfs(nodeId: string) {
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    const next = adjacency.get(nodeId) ?? [];
    for (const childId of next) {
      if (visiting.has(childId)) {
        cycleEdgeKeys.add(`${nodeId}->${childId}`);
        continue;
      }
      dfs(childId);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  }

  for (const key of adjacency.keys()) {
    if (!visited.has(key)) dfs(key);
  }
  return cycleEdgeKeys;
}

async function listEntitiesSafe(
  client: OrgXClient,
  type: MissionControlNodeType,
  filters: Record<string, unknown>
): Promise<{ items: Entity[]; warning: string | null }> {
  try {
    const response = await client.listEntities(type, filters);
    const items = Array.isArray(response.data) ? response.data : [];
    return { items, warning: null };
  } catch (err: unknown) {
    return {
      items: [],
      warning: `${type} unavailable (${safeErrorMessage(err)})`,
    };
  }
}

async function buildMissionControlGraph(
  client: OrgXClient,
  initiativeId: string
): Promise<{
  initiative: {
    id: string;
    title: string;
    status: string;
    summary: string | null;
    assignedAgents: MissionControlAssignedAgent[];
  };
  nodes: MissionControlNode[];
  edges: MissionControlEdge[];
  recentTodos: string[];
  degraded: string[];
}> {
  const degraded: string[] = [];

  const [initiativeResult, workstreamResult, milestoneResult, taskResult] =
    await Promise.all([
      listEntitiesSafe(client, "initiative", { limit: 300 }),
      listEntitiesSafe(client, "workstream", {
        initiative_id: initiativeId,
        limit: 500,
      }),
      listEntitiesSafe(client, "milestone", {
        initiative_id: initiativeId,
        limit: 700,
      }),
      listEntitiesSafe(client, "task", {
        initiative_id: initiativeId,
        limit: 1200,
      }),
    ]);

  for (const warning of [
    initiativeResult.warning,
    workstreamResult.warning,
    milestoneResult.warning,
    taskResult.warning,
  ]) {
    if (warning) degraded.push(warning);
  }

  const initiativeEntity = initiativeResult.items.find(
    (item) => String((item as Record<string, unknown>).id ?? "") === initiativeId
  );
  const initiativeNode = initiativeEntity
    ? toMissionControlNode("initiative", initiativeEntity, initiativeId)
    : {
        id: initiativeId,
        type: "initiative" as const,
        title: `Initiative ${initiativeId.slice(0, 8)}`,
        status: "active",
        parentId: null,
        initiativeId,
        workstreamId: null,
        milestoneId: null,
        priorityNum: 60,
        priorityLabel: null,
        dependencyIds: [],
        dueDate: null,
        etaEndAt: null,
        expectedDurationHours: DEFAULT_DURATION_HOURS.initiative,
        expectedBudgetUsd: DEFAULT_BUDGET_USD.initiative,
        assignedAgents: [],
        updatedAt: null,
      };

  const workstreamNodes = workstreamResult.items.map((item) =>
    toMissionControlNode("workstream", item, initiativeId)
  );
  const milestoneNodes = milestoneResult.items.map((item) =>
    toMissionControlNode("milestone", item, initiativeId)
  );
  const taskNodes = taskResult.items.map((item) =>
    toMissionControlNode("task", item, initiativeId)
  );

  const nodes: MissionControlNode[] = [
    initiativeNode,
    ...workstreamNodes,
    ...milestoneNodes,
    ...taskNodes,
  ];

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const validDependencies = dedupeStrings(
      node.dependencyIds.filter((depId) => depId !== node.id && nodeMap.has(depId))
    );
    node.dependencyIds = validDependencies;
  }

  let edges: MissionControlEdge[] = [];
  for (const node of nodes) {
    if (node.type === "initiative") continue;
    for (const depId of node.dependencyIds) {
      edges.push({
        from: depId,
        to: node.id,
        kind: "depends_on",
      });
    }
  }
  edges = edges.filter(
    (edge, index, arr) =>
      arr.findIndex(
        (candidate) =>
          candidate.from === edge.from &&
          candidate.to === edge.to &&
          candidate.kind === edge.kind
      ) === index
  );

  const cyclicEdgeKeys = detectCycleEdgeKeys(edges);
  if (cyclicEdgeKeys.size > 0) {
    degraded.push(
      `Detected ${cyclicEdgeKeys.size} cyclic dependency edge(s); excluded from ETA graph.`
    );
    edges = edges.filter((edge) => !cyclicEdgeKeys.has(`${edge.from}->${edge.to}`));
    for (const node of nodes) {
      node.dependencyIds = node.dependencyIds.filter(
        (depId) => !cyclicEdgeKeys.has(`${depId}->${node.id}`)
      );
    }
  }

  const etaMemo = new Map<string, number>();
  const etaVisiting = new Set<string>();

  const computeEtaEpoch = (nodeId: string): number => {
    const node = nodeMap.get(nodeId);
    if (!node) return Date.now();
    const cached = etaMemo.get(nodeId);
    if (cached !== undefined) return cached;

    const parsedEtaOverride = node.etaEndAt ? Date.parse(node.etaEndAt) : Number.NaN;
    if (Number.isFinite(parsedEtaOverride)) {
      etaMemo.set(nodeId, parsedEtaOverride);
      return parsedEtaOverride;
    }

    const parsedDueDate = node.dueDate ? Date.parse(node.dueDate) : Number.NaN;
    if (Number.isFinite(parsedDueDate)) {
      etaMemo.set(nodeId, parsedDueDate);
      return parsedDueDate;
    }

    if (etaVisiting.has(nodeId)) {
      degraded.push(`ETA cycle fallback on node ${nodeId}.`);
      const fallback = Date.now();
      etaMemo.set(nodeId, fallback);
      return fallback;
    }

    etaVisiting.add(nodeId);
    let dependencyMax = 0;
    for (const depId of node.dependencyIds) {
      dependencyMax = Math.max(dependencyMax, computeEtaEpoch(depId));
    }
    etaVisiting.delete(nodeId);

    const durationMs =
      (node.expectedDurationHours > 0
        ? node.expectedDurationHours
        : DEFAULT_DURATION_HOURS[node.type]) * 60 * 60 * 1000;
    const eta = Math.max(Date.now(), dependencyMax) + durationMs;
    etaMemo.set(nodeId, eta);
    return eta;
  };

  for (const node of nodes) {
    const eta = computeEtaEpoch(node.id);
    if (Number.isFinite(eta)) {
      node.etaEndAt = new Date(eta).toISOString();
    }
  }

  const taskNodesOnly = nodes.filter((node) => node.type === "task");
  const hasActiveTasks = taskNodesOnly.some((node) => isInProgressStatus(node.status));
  const hasTodoTasks = taskNodesOnly.some((node) => isTodoStatus(node.status));
  if (
    initiativeNode.status.toLowerCase() === "active" &&
    !hasActiveTasks &&
    hasTodoTasks
  ) {
    initiativeNode.status = "paused";
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
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

  const recentTodos = nodes
    .filter((node) => node.type === "task" && isTodoStatus(node.status))
    .sort((a, b) => {
      const aReady = taskIsReady(a);
      const bReady = taskIsReady(b);
      if (aReady !== bReady) return aReady ? -1 : 1;

      const aBlocked = taskHasBlockedParent(a);
      const bBlocked = taskHasBlockedParent(b);
      if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;

      const priorityDelta = a.priorityNum - b.priorityNum;
      if (priorityDelta !== 0) return priorityDelta;

      const aDue = a.dueDate ? Date.parse(a.dueDate) : Number.POSITIVE_INFINITY;
      const bDue = b.dueDate ? Date.parse(b.dueDate) : Number.POSITIVE_INFINITY;
      if (aDue !== bDue) return aDue - bDue;

      const aEta = a.etaEndAt ? Date.parse(a.etaEndAt) : Number.POSITIVE_INFINITY;
      const bEta = b.etaEndAt ? Date.parse(b.etaEndAt) : Number.POSITIVE_INFINITY;
      if (aEta !== bEta) return aEta - bEta;

      const aEpoch = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const bEpoch = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return aEpoch - bEpoch;
    })
    .map((node) => node.id);

  return {
    initiative: {
      id: initiativeNode.id,
      title: initiativeNode.title,
      status: initiativeNode.status,
      summary:
        initiativeEntity
          ? pickString(initiativeEntity as Record<string, unknown>, [
              "summary",
              "description",
              "context",
            ])
          : null,
      assignedAgents: initiativeNode.assignedAgents,
    },
    nodes,
    edges,
    recentTodos,
    degraded,
  };
}

function normalizeEntityMutationPayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...payload };
  const priorityNumRaw = pickNumber(next, ["priority_num", "priorityNum"]);
  const priorityLabelRaw = pickString(next, ["priority", "priority_label"]);

  if (priorityNumRaw !== null) {
    const clamped = clampPriority(priorityNumRaw);
    next.priority_num = clamped;
    if (!priorityLabelRaw) {
      next.priority = mapPriorityNumToLabel(clamped);
    }
  } else if (priorityLabelRaw) {
    next.priority_num = PRIORITY_LABEL_TO_NUM[priorityLabelRaw.toLowerCase()] ?? 60;
    next.priority = priorityLabelRaw.toLowerCase();
  }

  const dependsOnArray = pickStringArray(next, ["depends_on", "dependsOn", "dependencies"]);
  if (dependsOnArray.length > 0) {
    next.depends_on = dedupeStrings(dependsOnArray);
  } else if ("depends_on" in next) {
    next.depends_on = [];
  }

  const expectedDuration = pickNumber(next, [
    "expected_duration_hours",
    "expectedDurationHours",
  ]);
  if (expectedDuration !== null) {
    next.expected_duration_hours = Math.max(0, expectedDuration);
  }

  const expectedBudget = pickNumber(next, [
    "expected_budget_usd",
    "expectedBudgetUsd",
    "budget_usd",
    "budgetUsd",
  ]);
  if (expectedBudget !== null) {
    next.expected_budget_usd = Math.max(0, expectedBudget);
  }

  const etaEndAt = pickString(next, ["eta_end_at", "etaEndAt"]);
  if (etaEndAt !== null) {
    next.eta_end_at = toIsoString(etaEndAt) ?? null;
  }

  const assignedIds = pickStringArray(next, [
    "assigned_agent_ids",
    "assignedAgentIds",
  ]);
  const assignedNames = pickStringArray(next, [
    "assigned_agent_names",
    "assignedAgentNames",
  ]);
  if (assignedIds.length > 0) {
    next.assigned_agent_ids = dedupeStrings(assignedIds);
  }
  if (assignedNames.length > 0) {
    next.assigned_agent_names = dedupeStrings(assignedNames);
  }

  return next;
}

async function resolveAutoAssignments(input: {
  client: OrgXClient;
  entityId: string;
  entityType: string;
  initiativeId: string | null;
  title: string;
  summary: string | null;
}): Promise<{
  ok: boolean;
  assignment_source: "orchestrator" | "fallback" | "manual";
  assigned_agents: MissionControlAssignedAgent[];
  warnings: string[];
  updated_entity?: Entity;
}> {
  const warnings: string[] = [];
  const assignedById = new Map<string, MissionControlAssignedAgent>();

  const addAgent = (agent: MissionControlAssignedAgent) => {
    const key = agent.id || `name:${agent.name}`;
    if (!assignedById.has(key)) assignedById.set(key, agent);
  };

  type LiveAgent = MissionControlAssignedAgent & { status: string | null };
  let liveAgents: LiveAgent[] = [];

  try {
    const data = await input.client.getLiveAgents({
      initiative: input.initiativeId,
      includeIdle: true,
    });
    liveAgents = (Array.isArray(data.agents) ? data.agents : [])
      .map((raw): LiveAgent | null => {
        if (!raw || typeof raw !== "object") return null;
        const record = raw as Record<string, unknown>;
        const id = pickString(record, ["id", "agentId"]) ?? "";
        const name =
          pickString(record, ["name", "agentName"]) ?? (id ? `Agent ${id}` : "");
        if (!name) return null;
        return {
          id: id || `name:${name}`,
          name,
          domain: pickString(record, ["domain", "role"]),
          status: pickString(record, ["status"]),
        };
      })
      .filter((item): item is LiveAgent => item !== null);
  } catch (err: unknown) {
    warnings.push(`live agent lookup failed (${safeErrorMessage(err)})`);
  }

  const orchestrator = liveAgents.find(
    (agent) =>
      /holt|orchestrator/i.test(agent.name) ||
      /orchestrator/i.test(agent.domain ?? "")
  );
  if (orchestrator) addAgent(orchestrator);

  let assignmentSource: "orchestrator" | "fallback" | "manual" = "fallback";

  try {
    const preflight = await input.client.delegationPreflight({
      intent: `${input.title}${input.summary ? `: ${input.summary}` : ""}`,
    });
    const recommendations = preflight.data?.recommended_split ?? [];
    const recommendedDomains = dedupeStrings(
      recommendations
        .map((entry) => String(entry.owner_domain ?? "").trim().toLowerCase())
        .filter(Boolean)
    );

    for (const domain of recommendedDomains) {
      const matched = liveAgents.find((agent) =>
        (agent.domain ?? "").toLowerCase().includes(domain)
      );
      if (matched) addAgent(matched);
    }

    if (recommendedDomains.length > 0) {
      assignmentSource = "orchestrator";
    }
  } catch (err: unknown) {
    warnings.push(`delegation preflight failed (${safeErrorMessage(err)})`);
  }

  if (assignedById.size === 0) {
    const text = `${input.title} ${input.summary ?? ""}`.toLowerCase();
    const fallbackDomains: string[] = [];
    if (/market|campaign|thread|article|tweet|copy/.test(text)) {
      fallbackDomains.push("marketing");
    } else if (/design|ux|ui|a11y|accessibility/.test(text)) {
      fallbackDomains.push("design");
    } else if (/ops|incident|runbook|reliability/.test(text)) {
      fallbackDomains.push("operations");
    } else if (/sales|deal|pipeline|mrr/.test(text)) {
      fallbackDomains.push("sales");
    } else {
      fallbackDomains.push("engineering", "product");
    }

    for (const domain of fallbackDomains) {
      const matched = liveAgents.find((agent) =>
        (agent.domain ?? "").toLowerCase().includes(domain)
      );
      if (matched) addAgent(matched);
    }
  }

  if (assignedById.size === 0 && liveAgents.length > 0) {
    addAgent(liveAgents[0]);
    warnings.push("using first available live agent as fallback");
  }

  const assignedAgents = Array.from(assignedById.values());
  const updatePayload = normalizeEntityMutationPayload({
    assigned_agent_ids: assignedAgents.map((agent) => agent.id),
    assigned_agent_names: assignedAgents.map((agent) => agent.name),
    assignment_source: assignmentSource,
  });

  let updatedEntity: Entity | undefined;
  try {
    updatedEntity = await input.client.updateEntity(
      input.entityType,
      input.entityId,
      updatePayload
    );
  } catch (err: unknown) {
    warnings.push(`assignment patch failed (${safeErrorMessage(err)})`);
  }

  return {
    ok: true,
    assignment_source: assignmentSource,
    assigned_agents: assignedAgents,
    warnings,
    ...(updatedEntity ? { updated_entity: updatedEntity } : {}),
  };
}

// =============================================================================
// Factory
// =============================================================================

export function createHttpHandler(
  config: OrgXConfig,
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

  async function emitActivitySafe(input: {
    initiativeId: string | null;
    runId?: string | null;
    correlationId?: string | null;
    phase: "intent" | "execution" | "blocked" | "review" | "handoff" | "completed";
    message: string;
    level?: "info" | "warn" | "error";
    progressPct?: number;
    nextStep?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const initiativeId = input.initiativeId?.trim() ?? "";
    if (!initiativeId) return;
    const message = input.message.trim();
    if (!message) return;

    try {
      await client.emitActivity({
        initiative_id: initiativeId,
        run_id: input.runId ?? undefined,
        correlation_id: input.runId
          ? undefined
          : (input.correlationId?.trim() || `openclaw-${Date.now()}`),
        source_client: "openclaw",
        message,
        phase: input.phase,
        progress_pct:
          typeof input.progressPct === "number" && Number.isFinite(input.progressPct)
            ? Math.max(0, Math.min(100, Math.round(input.progressPct)))
            : undefined,
        level: input.level,
        next_step: input.nextStep,
        metadata: input.metadata,
      });
    } catch {
      // Fall back to local outbox so activity is still visible in Mission Control/Activity.
      try {
        const timestamp = new Date().toISOString();
        const runId =
          input.runId?.trim() ||
          input.correlationId?.trim() ||
          null;
        const activityItem: LiveActivityItem = {
          id: randomUUID(),
          type:
            input.phase === "completed"
              ? "run_completed"
              : input.phase === "blocked"
                ? "run_failed"
                : "run_started",
          title: message,
          description: input.nextStep ?? null,
          agentId:
            (typeof input.metadata?.agent_id === "string"
              ? input.metadata.agent_id
              : null) ?? null,
          agentName:
            (typeof input.metadata?.agent_name === "string"
              ? input.metadata.agent_name
              : null) ?? null,
          runId,
          initiativeId,
          timestamp,
          phase: input.phase,
          summary: message,
          metadata: {
            ...(input.metadata ?? {}),
            source: "openclaw_local_fallback",
          },
        };
        await appendToOutbox(initiativeId, {
          id: randomUUID(),
          type: "progress",
          timestamp,
          payload: {
            // Keep this payload aligned with OrgXClient.emitActivity input
            // so outbox replay can forward it without shape translation.
            initiative_id: initiativeId,
            run_id: input.runId?.trim() || undefined,
            correlation_id: input.runId
              ? undefined
              : (input.correlationId?.trim() || `openclaw-${Date.now()}`),
            source_client: "openclaw",
            message,
            phase: input.phase,
            progress_pct:
              typeof input.progressPct === "number" && Number.isFinite(input.progressPct)
                ? Math.max(0, Math.min(100, Math.round(input.progressPct)))
                : undefined,
            level: input.level ?? "info",
            next_step: input.nextStep ?? undefined,
            metadata: input.metadata ?? undefined,
          },
          activityItem,
        });
      } catch {
        // best effort
      }
    }
  }

  async function requestDecisionSafe(input: {
    initiativeId: string | null;
    correlationId?: string | null;
    title: string;
    summary?: string | null;
    urgency?: "low" | "medium" | "high" | "urgent";
    options?: string[];
    blocking?: boolean;
  }): Promise<void> {
    const initiativeId = input.initiativeId?.trim() ?? "";
    const title = input.title.trim();
    if (!initiativeId || !title) return;

    try {
      await client.applyChangeset({
        initiative_id: initiativeId,
        correlation_id: input.correlationId?.trim() || undefined,
        source_client: "openclaw",
        idempotency_key: idempotencyKey([
          "openclaw",
          "decision",
          initiativeId,
          title,
          input.correlationId ?? null,
        ]),
        operations: [
          {
            op: "decision.create",
            title,
            summary: input.summary ?? undefined,
            urgency: input.urgency ?? "high",
            options: input.options ?? [],
            blocking: input.blocking ?? true,
          },
        ],
      });
    } catch {
      // best effort
    }
  }

  async function checkSpawnGuardSafe(input: {
    domain: string;
    taskId?: string | null;
    initiativeId: string | null;
    correlationId: string;
    targetLabel?: string | null;
  }): Promise<unknown | null> {
    const scopedClient = client as OrgXClient & {
      checkSpawnGuard?: (domain: string, taskId?: string) => Promise<unknown>;
    };
    if (typeof scopedClient.checkSpawnGuard !== "function") {
      return null;
    }

    const taskId = input.taskId?.trim() ?? "";
    const targetLabel =
      input.targetLabel?.trim() ||
      (taskId ? `task ${taskId}` : "dispatch target");

    try {
      return await scopedClient.checkSpawnGuard(
        input.domain,
        taskId || undefined
      );
    } catch (err: unknown) {
      await emitActivitySafe({
        initiativeId: input.initiativeId,
        correlationId: input.correlationId,
        phase: "blocked",
        level: "warn",
        message: `Spawn guard check degraded for ${targetLabel}; continuing with local policy.`,
        metadata: {
          event: "spawn_guard_degraded",
          task_id: taskId || null,
          domain: input.domain,
          error: safeErrorMessage(err),
        },
      });
      return null;
    }
  }

  function extractSpawnGuardModelTier(result: unknown): string | null {
    if (!result || typeof result !== "object") return null;
    return (
      pickString(result as Record<string, unknown>, ["modelTier", "model_tier"]) ??
      null
    );
  }

  function formatRequiredSkills(requiredSkills: string[]): string {
    const normalized = requiredSkills
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => (entry.startsWith("$") ? entry : `$${entry}`));
    return normalized.length > 0
      ? normalized.join(", ")
      : "$orgx-engineering-agent";
  }

  function buildPolicyEnforcedMessage(input: {
    baseMessage: string;
    executionPolicy: { domain: string; requiredSkills: string[] };
    spawnGuardResult?: unknown | null;
  }): string {
    const modelTier = extractSpawnGuardModelTier(input.spawnGuardResult ?? null);
    return [
      `Execution policy: ${input.executionPolicy.domain}`,
      `Required skills: ${formatRequiredSkills(input.executionPolicy.requiredSkills)}`,
      modelTier ? `Spawn guard model tier: ${modelTier}` : null,
      "",
      input.baseMessage,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join("\n");
  }

  async function resolveDispatchExecutionPolicy(input: {
    initiativeId: string | null;
    initiativeTitle?: string | null;
    workstreamId?: string | null;
    workstreamTitle?: string | null;
    taskId?: string | null;
    taskTitle?: string | null;
    message?: string | null;
  }): Promise<{
    executionPolicy: { domain: string; requiredSkills: string[] };
    taskTitle: string | null;
    workstreamTitle: string | null;
  }> {
    const initiativeId = input.initiativeId?.trim() ?? "";
    const taskId = input.taskId?.trim() ?? "";
    const workstreamId = input.workstreamId?.trim() ?? "";
    let resolvedTaskTitle = input.taskTitle?.trim() || null;
    let resolvedWorkstreamTitle = input.workstreamTitle?.trim() || null;

    if (initiativeId && (taskId || workstreamId)) {
      try {
        const graph = await buildMissionControlGraph(client, initiativeId);
        const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
        const taskNode = taskId ? nodeById.get(taskId) ?? null : null;
        const workstreamNode = workstreamId ? nodeById.get(workstreamId) ?? null : null;

        if (taskNode && taskNode.type === "task") {
          resolvedTaskTitle = resolvedTaskTitle ?? taskNode.title;
          const relatedWorkstream =
            (taskNode.workstreamId ? nodeById.get(taskNode.workstreamId) ?? null : null) ??
            workstreamNode;
          const normalizedWorkstream =
            relatedWorkstream && relatedWorkstream.type === "workstream"
              ? relatedWorkstream
              : null;
          resolvedWorkstreamTitle =
            resolvedWorkstreamTitle ?? normalizedWorkstream?.title ?? null;
          return {
            executionPolicy: deriveExecutionPolicy(taskNode, normalizedWorkstream),
            taskTitle: resolvedTaskTitle,
            workstreamTitle: resolvedWorkstreamTitle,
          };
        }

        if (workstreamNode && workstreamNode.type === "workstream") {
          resolvedWorkstreamTitle = resolvedWorkstreamTitle ?? workstreamNode.title;
          const assignedDomain = workstreamNode.assignedAgents
            .map((agent) => normalizeExecutionDomain(agent.domain))
            .find((entry): entry is string => Boolean(entry));
          const domain =
            assignedDomain ??
            inferExecutionDomainFromText(
              workstreamNode.title,
              input.initiativeTitle,
              input.message
            );
          const normalizedDomain = normalizeExecutionDomain(domain) ?? "engineering";
          return {
            executionPolicy: {
              domain: normalizedDomain,
              requiredSkills: [
                ORGX_SKILL_BY_DOMAIN[normalizedDomain] ??
                  ORGX_SKILL_BY_DOMAIN.engineering,
              ],
            },
            taskTitle: resolvedTaskTitle,
            workstreamTitle: resolvedWorkstreamTitle,
          };
        }
      } catch {
        // best effort
      }
    }

    const inferredDomain =
      normalizeExecutionDomain(
        inferExecutionDomainFromText(
          resolvedTaskTitle,
          resolvedWorkstreamTitle,
          input.initiativeTitle,
          input.message
        )
      ) ?? "engineering";
    return {
      executionPolicy: {
        domain: inferredDomain,
        requiredSkills: [
          ORGX_SKILL_BY_DOMAIN[inferredDomain] ?? ORGX_SKILL_BY_DOMAIN.engineering,
        ],
      },
      taskTitle: resolvedTaskTitle,
      workstreamTitle: resolvedWorkstreamTitle,
    };
  }

  async function enforceSpawnGuardForDispatch(input: {
    sourceEventPrefix: string;
    initiativeId: string | null;
    correlationId: string;
    executionPolicy: { domain: string; requiredSkills: string[] };
    agentId?: string | null;
    taskId?: string | null;
    taskTitle?: string | null;
    workstreamId?: string | null;
    workstreamTitle?: string | null;
    milestoneId?: string | null;
  }): Promise<{
    allowed: boolean;
    retryable: boolean;
    blockedReason: string | null;
    spawnGuardResult: unknown | null;
  }> {
    const taskId = input.taskId?.trim() ?? "";
    const workstreamId = input.workstreamId?.trim() ?? "";
    const taskTitle = input.taskTitle?.trim() || null;
    const workstreamTitle = input.workstreamTitle?.trim() || null;
    const targetLabel = taskId
      ? `task ${taskTitle ?? taskId}`
      : workstreamId
        ? `workstream ${workstreamTitle ?? workstreamId}`
        : "dispatch target";

    const spawnGuardResult = await checkSpawnGuardSafe({
      domain: input.executionPolicy.domain,
      taskId: taskId || workstreamId || null,
      initiativeId: input.initiativeId,
      correlationId: input.correlationId,
      targetLabel,
    });

    if (!spawnGuardResult || typeof spawnGuardResult !== "object") {
      return {
        allowed: true,
        retryable: false,
        blockedReason: null,
        spawnGuardResult,
      };
    }

    const allowed = (spawnGuardResult as Record<string, unknown>).allowed;
    if (allowed !== false) {
      return {
        allowed: true,
        retryable: false,
        blockedReason: null,
        spawnGuardResult,
      };
    }

    const blockedReason = summarizeSpawnGuardBlockReason(spawnGuardResult);
    const retryable = spawnGuardIsRateLimited(spawnGuardResult);
    const blockedEvent = retryable
      ? `${input.sourceEventPrefix}_spawn_guard_rate_limited`
      : `${input.sourceEventPrefix}_spawn_guard_blocked`;

    await emitActivitySafe({
      initiativeId: input.initiativeId,
      correlationId: input.correlationId,
      phase: "blocked",
      level: retryable ? "warn" : "error",
      message: retryable
        ? `Spawn guard rate-limited ${targetLabel}; deferring launch.`
        : `Spawn guard blocked ${targetLabel}.`,
      metadata: {
        event: blockedEvent,
        agent_id: input.agentId ?? null,
        task_id: taskId || null,
        task_title: taskTitle,
        workstream_id: workstreamId || null,
        workstream_title: workstreamTitle,
        domain: input.executionPolicy.domain,
        required_skills: input.executionPolicy.requiredSkills,
        blocked_reason: blockedReason,
        spawn_guard: spawnGuardResult,
      },
      nextStep: retryable
        ? "Retry dispatch when spawn rate limits recover."
        : "Review decision and unblock guard checks before retry.",
    });

    if (!retryable && input.initiativeId && taskId) {
      try {
        await client.updateEntity("task", taskId, { status: "blocked" });
      } catch {
        // best effort
      }
      await syncParentRollupsForTask({
        initiativeId: input.initiativeId,
        taskId,
        workstreamId: workstreamId || null,
        milestoneId: input.milestoneId ?? null,
        correlationId: input.correlationId,
      });
    }

    if (!retryable) {
      await requestDecisionSafe({
        initiativeId: input.initiativeId,
        correlationId: input.correlationId,
        title: `Unblock ${targetLabel}`,
        summary: [
          `${targetLabel} failed spawn guard checks.`,
          `Reason: ${blockedReason}`,
          `Domain: ${input.executionPolicy.domain}`,
          `Required skills: ${input.executionPolicy.requiredSkills.join(", ")}`,
        ].join(" "),
        urgency: "high",
        options: [
          "Approve exception and continue",
          "Reassign task/domain",
          "Pause and investigate quality gate",
        ],
        blocking: true,
      });
    }

    return {
      allowed: false,
      retryable,
      blockedReason,
      spawnGuardResult,
    };
  }

  async function syncParentRollupsForTask(input: {
    initiativeId: string | null;
    taskId: string | null;
    workstreamId?: string | null;
    milestoneId?: string | null;
    correlationId?: string | null;
  }): Promise<void> {
    const initiativeId = input.initiativeId?.trim() ?? "";
    const taskId = input.taskId?.trim() ?? "";
    if (!initiativeId || !taskId) return;

    let tasks: Array<Record<string, unknown>> = [];
    try {
      const response = await client.listEntities("task", {
        initiative_id: initiativeId,
        limit: 4000,
      });
      tasks = Array.isArray((response as any)?.data)
        ? ((response as any).data as Array<Record<string, unknown>>)
        : [];
    } catch {
      return;
    }

    const task = tasks.find((row) => String(row.id ?? "").trim() === taskId) ?? null;
    const resolvedMilestoneId =
      (input.milestoneId?.trim() || "") ||
      (task ? pickString(task, ["milestone_id", "milestoneId"]) ?? "" : "");
    const resolvedWorkstreamId =
      (input.workstreamId?.trim() || "") ||
      (task ? pickString(task, ["workstream_id", "workstreamId"]) ?? "" : "");

    if (resolvedMilestoneId) {
      const milestoneTaskStatuses = tasks
        .filter(
          (row) =>
            pickString(row, ["milestone_id", "milestoneId"]) === resolvedMilestoneId
        )
        .map((row) => pickString(row, ["status"]) ?? "todo");
      const rollup = computeMilestoneRollup(milestoneTaskStatuses);

      try {
        await client.applyChangeset({
          initiative_id: initiativeId,
          correlation_id: input.correlationId?.trim() || undefined,
          source_client: "openclaw",
          idempotency_key: idempotencyKey([
            "openclaw",
            "rollup",
            "milestone",
            resolvedMilestoneId,
            rollup.status,
            String(rollup.progressPct),
            String(rollup.done),
            String(rollup.total),
          ]),
          operations: [
            {
              op: "milestone.update",
              milestone_id: resolvedMilestoneId,
              status: rollup.status,
            },
          ],
        });
      } catch {
        // best effort
      }
    }

    if (resolvedWorkstreamId) {
      const workstreamTaskStatuses = tasks
        .filter(
          (row) =>
            pickString(row, ["workstream_id", "workstreamId"]) === resolvedWorkstreamId
        )
        .map((row) => pickString(row, ["status"]) ?? "todo");
      const rollup = computeWorkstreamRollup(workstreamTaskStatuses);

      try {
        await client.updateEntity("workstream", resolvedWorkstreamId, {
          status: rollup.status,
        });
      } catch {
        // best effort
      }
    }
  }

  // ---------------------------------------------------------------------------
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
    includeVerification: boolean;
    allowedWorkstreamIds: string[] | null;
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
  let autoContinueTickInFlight = false;
  const AUTO_CONTINUE_TICK_MS = 2_500;

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

  function isSafePathSegment(value: string): boolean {
    const normalized = value.trim();
    if (!normalized || normalized === "." || normalized === "..") return false;
    if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("\0")) {
      return false;
    }
    if (normalized.includes("..")) return false;
    return true;
  }

  function toFiniteNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  function readOpenClawSessionSummary(input: {
    agentId: string;
    sessionId: string;
  }): {
    tokens: number;
    costUsd: number;
    hadError: boolean;
    errorMessage: string | null;
  } {
    const agentId = input.agentId.trim();
    const sessionId = input.sessionId.trim();
    if (!agentId || !sessionId) {
      return { tokens: 0, costUsd: 0, hadError: false, errorMessage: null };
    }
    if (!isSafePathSegment(agentId) || !isSafePathSegment(sessionId)) {
      return { tokens: 0, costUsd: 0, hadError: false, errorMessage: null };
    }

    const jsonlPath = join(
      homedir(),
      ".openclaw",
      "agents",
      agentId,
      "sessions",
      `${sessionId}.jsonl`
    );

    try {
      if (!existsSync(jsonlPath)) {
        return { tokens: 0, costUsd: 0, hadError: false, errorMessage: null };
      }
      const raw = readFileSync(jsonlPath, "utf8");
      const lines = raw.split("\n");

      let tokens = 0;
      let costUsd = 0;
      let hadError = false;
      let errorMessage: string | null = null;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed) as Record<string, unknown>;
          if (evt.type !== "message") continue;
          const msg = evt.message as Record<string, unknown> | undefined;
          if (!msg || typeof msg !== "object") continue;

          const usage = msg.usage as Record<string, unknown> | undefined;
          if (usage && typeof usage === "object") {
            const totalTokens =
              toFiniteNumber(usage.totalTokens) ??
              toFiniteNumber(usage.total_tokens) ??
              null;
            const inputTokens = toFiniteNumber(usage.input) ?? 0;
            const outputTokens = toFiniteNumber(usage.output) ?? 0;
            const cacheReadTokens = toFiniteNumber(usage.cacheRead) ?? 0;
            const cacheWriteTokens = toFiniteNumber(usage.cacheWrite) ?? 0;

            tokens += Math.max(
              0,
              Math.round(
                totalTokens ??
                  inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
              )
            );

            const cost = usage.cost as Record<string, unknown> | undefined;
            const costTotal = cost ? toFiniteNumber(cost.total) : null;
            if (costTotal !== null) {
              costUsd += Math.max(0, costTotal);
            }
          }

          const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : "";
          const msgError =
            typeof msg.errorMessage === "string" && msg.errorMessage.trim().length > 0
              ? msg.errorMessage.trim()
              : null;
          if (stopReason === "error" || msgError) {
            hadError = true;
            errorMessage = msgError ?? errorMessage;
          }
        } catch {
          // Ignore malformed lines.
        }
      }

      return {
        tokens,
        costUsd: Math.round(costUsd * 10_000) / 10_000,
        hadError,
        errorMessage,
      };
    } catch {
      return { tokens: 0, costUsd: 0, hadError: false, errorMessage: null };
    }
  }

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
    const existingMeta =
      existing && typeof existing === "object"
        ? getRecordMetadata(existing as Record<string, unknown>)
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
      auto_continue_enabled: true,
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
    input.run.status = "stopped";
    input.run.stopReason = input.reason;
    input.run.stoppedAt = now;
    input.run.updatedAt = now;
    input.run.stopRequested = false;
    input.run.activeRunId = null;
    input.run.activeTaskId = null;
    if (input.error) input.run.lastError = input.error;

    try {
      if (input.reason === "completed") {
        await client.updateEntity("initiative", input.run.initiativeId, {
          status: "completed",
        });
      } else {
        await client.updateEntity("initiative", input.run.initiativeId, {
          status: "paused",
        });
      }
    } catch {
      // best effort; UI still derives paused state locally
    }

    try {
      await updateInitiativeAutoContinueState({
        initiativeId: input.run.initiativeId,
        run: input.run,
      });
    } catch {
      // best effort
    }
  }

  async function dispatchFallbackWorkstreamTurn(input: {
    initiativeId: string;
    initiativeTitle: string;
    workstreamId: string;
    workstreamTitle: string;
    agentId: string;
  }): Promise<{
    sessionId: string | null;
    pid: number | null;
    blockedReason: string | null;
    retryable: boolean;
    executionPolicy: { domain: string; requiredSkills: string[] };
    spawnGuardResult: unknown | null;
  }> {
    const now = new Date().toISOString();
    const sessionId = randomUUID();
    const policyResolution = await resolveDispatchExecutionPolicy({
      initiativeId: input.initiativeId,
      initiativeTitle: input.initiativeTitle,
      workstreamId: input.workstreamId,
      workstreamTitle: input.workstreamTitle,
      message:
        "Continue this workstream from the latest context. Identify and execute the next concrete task.",
    });
    const executionPolicy = policyResolution.executionPolicy;
    const resolvedWorkstreamTitle =
      policyResolution.workstreamTitle ?? input.workstreamTitle;

    const guard = await enforceSpawnGuardForDispatch({
      sourceEventPrefix: "next_up_fallback",
      initiativeId: input.initiativeId,
      correlationId: sessionId,
      executionPolicy,
      agentId: input.agentId,
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
      "",
      "Continue this workstream from the latest context.",
      "Identify and execute the next concrete task, then provide a concise progress summary.",
    ].join("\n");
    const message = buildPolicyEnforcedMessage({
      baseMessage,
      executionPolicy,
      spawnGuardResult: guard.spawnGuardResult,
    });

    await emitActivitySafe({
      initiativeId: input.initiativeId,
      correlationId: sessionId,
      phase: "execution",
      level: "info",
      message: `Next Up dispatched ${resolvedWorkstreamTitle}.`,
      metadata: {
        event: "next_up_manual_dispatch_started",
        agent_id: input.agentId,
        session_id: sessionId,
        workstream_id: input.workstreamId,
        workstream_title: resolvedWorkstreamTitle,
        domain: executionPolicy.domain,
        required_skills: executionPolicy.requiredSkills,
        spawn_guard_model_tier: extractSpawnGuardModelTier(guard.spawnGuardResult),
        fallback: true,
      },
    });

    upsertAgentContext({
      agentId: input.agentId,
      initiativeId: input.initiativeId,
      initiativeTitle: input.initiativeTitle,
      workstreamId: input.workstreamId,
      taskId: null,
    });

    const spawned = spawnAgentTurn({
      agentId: input.agentId,
      sessionId,
      message,
    });

    upsertAgentRun({
      runId: sessionId,
      agentId: input.agentId,
      pid: spawned.pid,
      message,
      provider: null,
      model: null,
      initiativeId: input.initiativeId,
      initiativeTitle: input.initiativeTitle,
      workstreamId: input.workstreamId,
      taskId: null,
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

  async function tickAutoContinueRun(run: AutoContinueRun): Promise<void> {
    if (run.status !== "running" && run.status !== "stopping") return;

    const now = new Date().toISOString();

    // 1) If we have an active run, wait for it to finish.
    if (run.activeRunId) {
      const record = getAgentRun(run.activeRunId);
      const pid = record?.pid ?? null;
      if (pid && pidAlive(pid)) {
        return;
      }

      // Run finished (or pid missing). Mark stopped and auto-complete the task.
      if (record) {
        try {
          markAgentRunStopped(record.runId);
        } catch {
          // ignore
        }

      const summary = readOpenClawSessionSummary({
          agentId: record.agentId,
          sessionId: record.runId,
        });

        const modeledTokens = run.activeTaskTokenEstimate ?? 0;
        const consumedTokens = summary.tokens > 0 ? summary.tokens : modeledTokens;
        run.tokensUsed += Math.max(0, consumedTokens);
        run.activeTaskTokenEstimate = null;

        if (record.taskId) {
          try {
            await client.updateEntity("task", record.taskId, {
              status: summary.hadError ? "blocked" : "done",
            });
          } catch (err: unknown) {
            run.lastError = safeErrorMessage(err);
          }
        }

        if (record.taskId) {
          await syncParentRollupsForTask({
            initiativeId: run.initiativeId,
            taskId: record.taskId,
            workstreamId: record.workstreamId,
            correlationId: record.runId,
          });
        }

        await emitActivitySafe({
          initiativeId: run.initiativeId,
          correlationId: record.runId,
          phase: summary.hadError ? "blocked" : "completed",
          level: summary.hadError ? "warn" : "info",
          message: record.taskId
            ? `Auto-continue ${summary.hadError ? "blocked" : "completed"} task ${record.taskId}.`
            : `Auto-continue run finished (${summary.hadError ? "blocked" : "completed"}).`,
          metadata: {
            event: "auto_continue_task_finished",
            agent_id: record.agentId,
            session_id: record.runId,
            task_id: record.taskId,
            workstream_id: record.workstreamId,
            tokens: summary.tokens,
            cost_usd: summary.costUsd,
            had_error: summary.hadError,
            error_message: summary.errorMessage,
          },
        });

        if (summary.hadError && record.taskId) {
          await requestDecisionSafe({
            initiativeId: run.initiativeId,
            correlationId: record.runId,
            title: `Unblock auto-continue task ${record.taskId}`,
            summary: [
              `Task ${record.taskId} finished with runtime error in session ${record.runId}.`,
              summary.errorMessage ? `Error: ${summary.errorMessage}` : null,
              `Workstream: ${record.workstreamId ?? "unknown"}.`,
            ]
              .filter((line): line is string => Boolean(line))
              .join(" "),
            urgency: "high",
            options: [
              "Retry task in auto-continue",
              "Assign manual recovery owner",
              "Pause initiative until fixed",
            ],
            blocking: true,
          });
        }

        run.lastRunId = record.runId;
        run.lastTaskId = record.taskId ?? run.lastTaskId;
        run.activeRunId = null;
        run.activeTaskId = null;
        run.updatedAt = now;
        if (summary.hadError && summary.errorMessage) {
          run.lastError = summary.errorMessage;
        }

        try {
          await updateInitiativeAutoContinueState({
            initiativeId: run.initiativeId,
            run,
          });
        } catch {
          // best effort
        }
      } else {
        // No record; clear active pointers so we can continue.
        run.activeRunId = null;
        run.activeTaskId = null;
      }

      // If a stop was requested, finalize after the active run completes.
      if (run.stopRequested) {
        await stopAutoContinueRun({ run, reason: "stopped" });
        return;
      }
    }

    if (run.stopRequested) {
      run.status = "stopping";
      run.updatedAt = now;
      await stopAutoContinueRun({ run, reason: "stopped" });
      return;
    }

    // 2) Enforce token guardrail before starting a new task.
    if (run.tokensUsed >= run.tokenBudget) {
      await stopAutoContinueRun({ run, reason: "budget_exhausted" });
      return;
    }

    // 3) Pick next-up task and dispatch.
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

    let nextTaskNode: MissionControlNode | null = null;
    for (const taskId of graph.recentTodos) {
      const node = nodeById.get(taskId);
      if (!node || node.type !== "task") continue;
      if (!isTodoStatus(node.status)) continue;
      if (
        !run.includeVerification &&
        typeof node.title === "string" &&
        /^verification\s+scenario/i.test(node.title)
      ) {
        continue;
      }
      if (
        run.allowedWorkstreamIds &&
        node.workstreamId &&
        !run.allowedWorkstreamIds.includes(node.workstreamId)
      ) {
        continue;
      }
      if (node.workstreamId) {
        const ws = nodeById.get(node.workstreamId);
        if (ws && !isDispatchableWorkstreamStatus(ws.status)) {
          continue;
        }
      }
      if (!taskIsReady(node)) continue;
      if (taskHasBlockedParent(node)) continue;
      nextTaskNode = node;
      break;
    }

    if (!nextTaskNode) {
      await stopAutoContinueRun({ run, reason: "blocked" });
      return;
    }

    const nextTaskTokenEstimate = estimateTokensForDurationHours(
      typeof nextTaskNode.expectedDurationHours === "number"
        ? nextTaskNode.expectedDurationHours
        : 0
    );
    if (
      nextTaskTokenEstimate > 0 &&
      run.tokensUsed + nextTaskTokenEstimate > run.tokenBudget
    ) {
      await stopAutoContinueRun({ run, reason: "budget_exhausted" });
      return;
    }

    const agentId = run.agentId || "main";
    const sessionId = randomUUID();
    const initiativeNode = nodes.find((node) => node.type === "initiative") ?? null;
    const workstreamTitle =
      nextTaskNode.workstreamId
        ? nodeById.get(nextTaskNode.workstreamId)?.title ?? null
        : null;
    const milestoneTitle =
      nextTaskNode.milestoneId
        ? nodeById.get(nextTaskNode.milestoneId)?.title ?? null
        : null;
    const workstreamNode =
      nextTaskNode.workstreamId
        ? nodeById.get(nextTaskNode.workstreamId) ?? null
        : null;
    const executionPolicy = deriveExecutionPolicy(nextTaskNode, workstreamNode);
    const spawnGuardResult = await checkSpawnGuardSafe({
      domain: executionPolicy.domain,
      taskId: nextTaskNode.id,
      initiativeId: run.initiativeId,
      correlationId: sessionId,
    });
    if (spawnGuardResult && typeof spawnGuardResult === "object") {
      const allowed = (spawnGuardResult as Record<string, unknown>).allowed;
      if (allowed === false) {
        const blockedReason = summarizeSpawnGuardBlockReason(spawnGuardResult);
        if (spawnGuardIsRateLimited(spawnGuardResult)) {
          run.lastError = blockedReason;
          run.updatedAt = now;
          await emitActivitySafe({
            initiativeId: run.initiativeId,
            correlationId: sessionId,
            phase: "blocked",
            level: "warn",
            message: `Spawn guard rate-limited task ${nextTaskNode.id}; waiting to retry.`,
            metadata: {
              event: "auto_continue_spawn_guard_rate_limited",
              task_id: nextTaskNode.id,
              task_title: nextTaskNode.title,
              domain: executionPolicy.domain,
              required_skills: executionPolicy.requiredSkills,
              spawn_guard: spawnGuardResult,
            },
          });
          return;
        }

        try {
          await client.updateEntity("task", nextTaskNode.id, {
            status: "blocked",
          });
        } catch {
          // best effort
        }

        await syncParentRollupsForTask({
          initiativeId: run.initiativeId,
          taskId: nextTaskNode.id,
          workstreamId: nextTaskNode.workstreamId,
          milestoneId: nextTaskNode.milestoneId,
          correlationId: sessionId,
        });

        await emitActivitySafe({
          initiativeId: run.initiativeId,
          correlationId: sessionId,
          phase: "blocked",
          level: "error",
          message: `Auto-continue blocked by spawn guard on task ${nextTaskNode.id}.`,
          metadata: {
            event: "auto_continue_spawn_guard_blocked",
            task_id: nextTaskNode.id,
            task_title: nextTaskNode.title,
            domain: executionPolicy.domain,
            required_skills: executionPolicy.requiredSkills,
            blocked_reason: blockedReason,
            spawn_guard: spawnGuardResult,
          },
        });

        await requestDecisionSafe({
          initiativeId: run.initiativeId,
          correlationId: sessionId,
          title: `Unblock auto-continue task ${nextTaskNode.title}`,
          summary: [
            `Task ${nextTaskNode.id} failed spawn guard checks.`,
            `Reason: ${blockedReason}`,
            `Domain: ${executionPolicy.domain}`,
            `Required skills: ${executionPolicy.requiredSkills.join(", ")}`,
          ].join(" "),
          urgency: "high",
          options: [
            "Approve exception and continue",
            "Reassign task/domain",
            "Pause and investigate quality gate",
          ],
          blocking: true,
        });

        await stopAutoContinueRun({
          run,
          reason: "blocked",
          error: blockedReason,
        });
        return;
      }
    }

    const message = [
      initiativeNode ? `Initiative: ${initiativeNode.title}` : null,
      workstreamTitle ? `Workstream: ${workstreamTitle}` : null,
      milestoneTitle ? `Milestone: ${milestoneTitle}` : null,
      "",
      `Task: ${nextTaskNode.title}`,
      `Execution policy: ${executionPolicy.domain}`,
      `Required skills: ${executionPolicy.requiredSkills.map((skill) => `$${skill}`).join(", ")}`,
      "",
      "Execute this task. When finished, provide a concise completion summary and any relevant commands/notes.",
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n");

    if (
      workstreamNode &&
      !isInProgressStatus(workstreamNode.status) &&
      isDispatchableWorkstreamStatus(workstreamNode.status)
    ) {
      try {
        await client.updateEntity("workstream", workstreamNode.id, {
          status: "active",
        });
      } catch {
        // best effort
      }
    }

    try {
      await client.updateEntity("task", nextTaskNode.id, {
        status: "in_progress",
      });
    } catch (err: unknown) {
      await stopAutoContinueRun({
        run,
        reason: "error",
        error: safeErrorMessage(err),
      });
      return;
    }

    await syncParentRollupsForTask({
      initiativeId: run.initiativeId,
      taskId: nextTaskNode.id,
      workstreamId: nextTaskNode.workstreamId,
      milestoneId: nextTaskNode.milestoneId,
      correlationId: sessionId,
    });

    await emitActivitySafe({
      initiativeId: run.initiativeId,
      correlationId: sessionId,
      phase: "execution",
      level: "info",
      message: `Auto-continue started task ${nextTaskNode.id}.`,
      metadata: {
        event: "auto_continue_task_started",
        agent_id: agentId,
        session_id: sessionId,
        task_id: nextTaskNode.id,
        task_title: nextTaskNode.title,
        workstream_id: nextTaskNode.workstreamId,
        workstream_title: workstreamTitle,
        milestone_id: nextTaskNode.milestoneId,
        milestone_title: milestoneTitle,
        domain: executionPolicy.domain,
        required_skills: executionPolicy.requiredSkills,
        spawn_guard_model_tier:
          spawnGuardResult && typeof spawnGuardResult === "object"
            ? pickString(
                spawnGuardResult as Record<string, unknown>,
                ["modelTier", "model_tier"]
              ) ?? null
            : null,
      },
    });

    upsertAgentContext({
      agentId,
      initiativeId: run.initiativeId,
      initiativeTitle: initiativeNode?.title ?? null,
      workstreamId: nextTaskNode.workstreamId,
      taskId: nextTaskNode.id,
    });

    const spawned = spawnAgentTurn({
      agentId,
      sessionId,
      message,
    });

    upsertAgentRun({
      runId: sessionId,
      agentId,
      pid: spawned.pid,
      message,
      provider: null,
      model: null,
      initiativeId: run.initiativeId,
      initiativeTitle: initiativeNode?.title ?? null,
      workstreamId: nextTaskNode.workstreamId,
      taskId: nextTaskNode.id,
      startedAt: now,
      status: "running",
    });

    run.lastTaskId = nextTaskNode.id;
    run.lastRunId = sessionId;
    run.activeTaskId = nextTaskNode.id;
    run.activeRunId = sessionId;
    run.activeTaskTokenEstimate = nextTaskTokenEstimate > 0 ? nextTaskTokenEstimate : null;
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
    if (autoContinueTickInFlight) return;
    autoContinueTickInFlight = true;
    try {
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
    } finally {
      autoContinueTickInFlight = false;
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

  async function resolveAutoContinueUpgradeGate(
    agentId: string
  ): Promise<{
    error: string;
    code: "upgrade_required";
    currentPlan: string;
    requiredPlan: "starter";
    actions: { checkout: string; portal: string; pricing: string };
  } | null> {
    let requiresPremiumAutoContinue = false;
    try {
      const agents = await listAgents();
      const agentEntry =
        agents.find((entry) => String(entry.id ?? "").trim() === agentId) ??
        null;
      const agentModel =
        agentEntry && typeof agentEntry.model === "string"
          ? agentEntry.model
          : null;
      requiresPremiumAutoContinue = modelImpliesByok(agentModel);
    } catch {
      // ignore
    }

    if (!requiresPremiumAutoContinue) return null;

    const billingStatus = await fetchBillingStatusSafe(client);
    if (!billingStatus || billingStatus.plan !== "free") return null;

    const pricingUrl = `${client.getBaseUrl().replace(/\/+$/, "")}/pricing`;
    return {
      code: "upgrade_required",
      error:
        "Auto-continue for BYOK agents requires a paid OrgX plan. Upgrade, then retry.",
      currentPlan: billingStatus.plan,
      requiredPlan: "starter",
      actions: {
        checkout: "/orgx/api/billing/checkout",
        portal: "/orgx/api/billing/portal",
        pricing: pricingUrl,
      },
    };
  }

  async function startAutoContinueRun(input: {
    initiativeId: string;
    agentId: string;
    tokenBudget: unknown;
    includeVerification: boolean;
    allowedWorkstreamIds: string[] | null;
  }): Promise<AutoContinueRun> {
    const now = new Date().toISOString();
    const existing = autoContinueRuns.get(input.initiativeId) ?? null;

    const run: AutoContinueRun =
      existing ??
      ({
        initiativeId: input.initiativeId,
        agentId: input.agentId,
        includeVerification: false,
        allowedWorkstreamIds: null,
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
    run.includeVerification = input.includeVerification;
    run.allowedWorkstreamIds = input.allowedWorkstreamIds;
    run.tokenBudget = normalizeTokenBudget(
      input.tokenBudget,
      run.tokenBudget || defaultAutoContinueTokenBudget()
    );
    run.status = "running";
    run.stopReason = null;
    run.stopRequested = false;
    run.startedAt = now;
    run.stoppedAt = null;
    run.updatedAt = now;
    run.lastError = null;

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

      if (!sessionTree) {
        try {
          const localTree = toLocalSessionTree(
            await loadLocalOpenClawSnapshot(400),
            400
          );
          sessionTree = applyAgentContextsToSessionTree(
            localTree,
            readAgentContexts().agents
          );
        } catch (err: unknown) {
          degraded.push(`local sessions fallback unavailable (${safeErrorMessage(err)})`);
          return [];
        }
      }

      sessionTree = applyAgentContextsToSessionTree(
        sessionTree,
        readAgentContexts().agents
      );

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

    const scopedInitiatives = initiatives.filter((entity) => {
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
      const decisionApproveMatch = route.match(
        /^live\/decisions\/([^/]+)\/approve$/
      );
      const runActionMatch = route.match(/^runs\/([^/]+)\/actions\/([^/]+)$/);
      const runCheckpointsMatch = route.match(/^runs\/([^/]+)\/checkpoints$/);
      const runCheckpointRestoreMatch = route.match(
        /^runs\/([^/]+)\/checkpoints\/([^/]+)\/restore$/
      );
      const isDelegationPreflight = route === "delegation/preflight";
      const isMissionControlAutoAssignmentRoute =
        route === "mission-control/assignments/auto";
      const isMissionControlNextUpPlayRoute =
        route === "mission-control/next-up/play";
      const isMissionControlNextUpPinRoute =
        route === "mission-control/next-up/pin";
      const isMissionControlNextUpUnpinRoute =
        route === "mission-control/next-up/unpin";
      const isMissionControlNextUpReorderRoute =
        route === "mission-control/next-up/reorder";
      const isMissionControlAutoContinueStartRoute =
        route === "mission-control/auto-continue/start";
      const isMissionControlAutoContinueStopRoute =
        route === "mission-control/auto-continue/stop";
      const isEntitiesRoute = route === "entities";
      const entityActionMatch = route.match(
        /^entities\/([^/]+)\/([^/]+)\/([^/]+)$/
      );
      const isOnboardingStartRoute = route === "onboarding/start";
      const isOnboardingStatusRoute = route === "onboarding/status";
      const isOnboardingManualKeyRoute = route === "onboarding/manual-key";
      const isOnboardingDisconnectRoute = route === "onboarding/disconnect";
      const isLiveActivityHeadlineRoute = route === "live/activity/headline";
      const isAgentLaunchRoute = route === "agents/launch";
      const isAgentStopRoute = route === "agents/stop";
      const isAgentRestartRoute = route === "agents/restart";
      const isByokSettingsRoute = route === "settings/byok";

      if (method === "POST" && isOnboardingStartRoute) {
        try {
          const payload = await parseJsonRequest(req);
          const started = await onboarding.startPairing({
            openclawVersion:
              pickString(payload, ["openclawVersion", "openclaw_version"]) ??
              undefined,
            platform: pickString(payload, ["platform"]) ?? undefined,
            deviceName: pickString(payload, ["deviceName", "device_name"]) ?? undefined,
          });
          sendJson(res, 200, {
            ok: true,
            data: {
              pairingId: started.pairingId,
              connectUrl: started.connectUrl,
              expiresAt: started.expiresAt,
              pollIntervalMs: started.pollIntervalMs,
              state: getOnboardingState(started.state),
            },
          });
        } catch (err: unknown) {
          sendJson(res, 400, {
            ok: false,
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (method === "GET" && isOnboardingStatusRoute) {
        try {
          const state = await onboarding.getStatus();
          sendJson(res, 200, {
            ok: true,
            data: getOnboardingState(state),
          });
        } catch (err: unknown) {
          sendJson(res, 500, {
            ok: false,
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (method === "POST" && isOnboardingManualKeyRoute) {
        try {
          const payload = await parseJsonRequest(req);
          const authHeader = pickHeaderString(req.headers, ["authorization"]);
          const bearerApiKey =
            authHeader && authHeader.toLowerCase().startsWith("bearer ")
              ? authHeader.slice("bearer ".length).trim()
              : null;
          const headerApiKey = pickHeaderString(req.headers, [
            "x-orgx-api-key",
            "x-api-key",
          ]);
          const apiKey =
            pickString(payload, ["apiKey", "api_key"]) ??
            headerApiKey ??
            bearerApiKey;
          if (!apiKey) {
            sendJson(res, 400, {
              ok: false,
              error: "apiKey is required",
            });
            return true;
          }

          const requestedUserId =
            pickString(payload, ["userId", "user_id"]) ??
            pickHeaderString(req.headers, ["x-orgx-user-id", "x-user-id"]) ??
            undefined;
          const userId = isUserScopedApiKey(apiKey) ? undefined : requestedUserId;
          const state = await onboarding.submitManualKey({
            apiKey,
            userId,
          });

          sendJson(res, 200, {
            ok: true,
            data: getOnboardingState(state),
          });
        } catch (err: unknown) {
          sendJson(res, 400, {
            ok: false,
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (method === "POST" && isOnboardingDisconnectRoute) {
        try {
          const state = await onboarding.disconnect();
          sendJson(res, 200, {
            ok: true,
            data: getOnboardingState(state),
          });
        } catch (err: unknown) {
          sendJson(res, 500, {
            ok: false,
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (method === "POST" && isAgentLaunchRoute) {
        try {
          const payload = await parseJsonRequest(req);
          const agentId =
            (pickString(payload, ["agentId", "agent_id", "id"]) ??
              searchParams.get("agentId") ??
              searchParams.get("agent_id") ??
              searchParams.get("id") ??
              "")
              .trim();
          if (!agentId) {
            sendJson(res, 400, { ok: false, error: "agentId is required" });
            return true;
          }
          if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
            sendJson(res, 400, {
              ok: false,
              error: "agentId must be a simple identifier (letters, numbers, _ or -).",
            });
            return true;
          }

          const sessionId =
            (pickString(payload, ["sessionId", "session_id"]) ??
              searchParams.get("sessionId") ??
              searchParams.get("session_id") ??
              "")
              .trim() ||
            randomUUID();
          const initiativeId =
            pickString(payload, ["initiativeId", "initiative_id"]) ??
            searchParams.get("initiativeId") ??
            searchParams.get("initiative_id") ??
            null;
          const initiativeTitle =
            pickString(payload, [
              "initiativeTitle",
              "initiative_title",
              "initiativeName",
              "initiative_name",
            ]) ??
            searchParams.get("initiativeTitle") ??
            searchParams.get("initiative_title") ??
            searchParams.get("initiativeName") ??
            searchParams.get("initiative_name") ??
            null;
          const workstreamId =
            pickString(payload, ["workstreamId", "workstream_id"]) ??
            searchParams.get("workstreamId") ??
            searchParams.get("workstream_id") ??
            null;
          const taskId =
            pickString(payload, ["taskId", "task_id"]) ??
            searchParams.get("taskId") ??
            searchParams.get("task_id") ??
            null;
          const thinking =
            (pickString(payload, ["thinking"]) ??
              searchParams.get("thinking") ??
              "")
              .trim() || null;
          const provider = normalizeOpenClawProvider(
            pickString(payload, ["provider", "modelProvider", "model_provider"]) ??
              searchParams.get("provider") ??
              searchParams.get("modelProvider") ??
              searchParams.get("model_provider") ??
              null
          );
          const requestedModel =
            (pickString(payload, ["model", "modelId", "model_id"]) ??
              searchParams.get("model") ??
              searchParams.get("modelId") ??
              searchParams.get("model_id") ??
              "")
              .trim() || null;
          const routingProvider =
            provider ?? (!provider && !requestedModel ? resolveAutoOpenClawProvider() : null);
          const dryRunRaw =
            payload.dryRun ??
            (payload as Record<string, unknown>).dry_run ??
            searchParams.get("dryRun") ??
            searchParams.get("dry_run") ??
            null;
          const dryRun =
            typeof dryRunRaw === "boolean"
              ? dryRunRaw
              : parseBooleanQuery(typeof dryRunRaw === "string" ? dryRunRaw : null);

          let requiresPremiumLaunch =
            Boolean(routingProvider) || modelImpliesByok(requestedModel);
          if (!requiresPremiumLaunch) {
            try {
              const agents = await listAgents();
              const agentEntry =
                agents.find((entry) => String(entry.id ?? "").trim() === agentId) ??
                null;
              const agentModel =
                agentEntry && typeof agentEntry.model === "string"
                  ? agentEntry.model
                  : null;
              requiresPremiumLaunch = modelImpliesByok(agentModel);
            } catch {
              // ignore
            }
          }

          if (requiresPremiumLaunch) {
            const billingStatus = await fetchBillingStatusSafe(client);
            if (billingStatus && billingStatus.plan === "free") {
              const pricingUrl = `${client.getBaseUrl().replace(/\/+$/, "")}/pricing`;
              sendJson(res, 402, {
                ok: false,
                code: "upgrade_required",
                error:
                  "BYOK agent launch requires a paid OrgX plan. Upgrade, then retry.",
                currentPlan: billingStatus.plan,
                requiredPlan: "starter",
                actions: {
                  checkout: "/orgx/api/billing/checkout",
                  portal: "/orgx/api/billing/portal",
                  pricing: pricingUrl,
                },
              });
              return true;
            }
          }

          const messageInput =
            (pickString(payload, ["message", "prompt", "text"]) ??
              searchParams.get("message") ??
              searchParams.get("prompt") ??
              searchParams.get("text") ??
              "")
              .trim();
          const baseMessage =
            messageInput ||
            (initiativeTitle
              ? `Kick off: ${initiativeTitle}`
              : initiativeId
                ? `Kick off initiative ${initiativeId}`
                : `Kick off agent ${agentId}`);
          const policyResolution = await resolveDispatchExecutionPolicy({
            initiativeId,
            initiativeTitle,
            workstreamId,
            taskId,
            message: baseMessage,
          });
          const executionPolicy = policyResolution.executionPolicy;
          const resolvedTaskTitle = policyResolution.taskTitle;
          const resolvedWorkstreamTitle =
            policyResolution.workstreamTitle ??
            (workstreamId ? `Workstream ${workstreamId}` : null);

          if (dryRun) {
            sendJson(res, 200, {
              ok: true,
              dryRun: true,
              agentId,
              initiativeId,
              workstreamId,
              taskId,
              requiresPremiumLaunch,
              provider: routingProvider,
              model: requestedModel,
              startedAt: new Date().toISOString(),
              message: baseMessage,
              domain: executionPolicy.domain,
              requiredSkills: executionPolicy.requiredSkills,
            });
            return true;
          }

          const guard = await enforceSpawnGuardForDispatch({
            sourceEventPrefix: "agent_launch",
            initiativeId,
            correlationId: sessionId,
            executionPolicy,
            agentId,
            taskId,
            taskTitle: resolvedTaskTitle,
            workstreamId,
            workstreamTitle: resolvedWorkstreamTitle,
          });
          if (!guard.allowed) {
            sendJson(res, guard.retryable ? 429 : 409, {
              ok: false,
              code: guard.retryable
                ? "spawn_guard_rate_limited"
                : "spawn_guard_blocked",
              error:
                guard.blockedReason ??
                "Spawn guard denied this agent launch.",
              retryable: guard.retryable,
              initiativeId,
              workstreamId,
              taskId,
              domain: executionPolicy.domain,
              requiredSkills: executionPolicy.requiredSkills,
            });
            return true;
          }
          const message = buildPolicyEnforcedMessage({
            baseMessage,
            executionPolicy,
            spawnGuardResult: guard.spawnGuardResult,
          });

          if (initiativeId) {
            try {
              await client.updateEntity("initiative", initiativeId, { status: "active" });
            } catch {
              // best effort
            }
          }

          if (taskId) {
            try {
              await client.updateEntity("task", taskId, { status: "in_progress" });
            } catch {
              // best effort
            }

            await syncParentRollupsForTask({
              initiativeId,
              taskId,
              workstreamId,
              correlationId: sessionId,
            });
          }

          await emitActivitySafe({
            initiativeId,
            correlationId: sessionId,
            phase: "execution",
            message: taskId
              ? `Launched agent ${agentId} for task ${taskId}.`
              : `Launched agent ${agentId}.`,
            level: "info",
            metadata: {
              event: "agent_launch",
              agent_id: agentId,
              session_id: sessionId,
              workstream_id: workstreamId,
              task_id: taskId,
              provider: routingProvider,
              model: requestedModel,
              domain: executionPolicy.domain,
              required_skills: executionPolicy.requiredSkills,
              spawn_guard_model_tier: extractSpawnGuardModelTier(
                guard.spawnGuardResult
              ),
            },
          });

          let routedProvider: string | null = null;
          let routedModel: string | null = null;
          if (routingProvider) {
            const routed = await configureOpenClawProviderRouting({
              agentId,
              provider: routingProvider,
              requestedModel,
            });
            routedProvider = routed.provider;
            routedModel = routed.model;
          }

          upsertAgentContext({
            agentId,
            initiativeId,
            initiativeTitle,
            workstreamId,
            taskId,
          });

          const spawned = spawnAgentTurn({
            agentId,
            sessionId,
            message,
            thinking,
          });

          upsertAgentRun({
            runId: sessionId,
            agentId,
            pid: spawned.pid,
            message,
            provider: routedProvider,
            model: routedModel,
            initiativeId,
            initiativeTitle,
            workstreamId,
            taskId,
            startedAt: new Date().toISOString(),
            status: "running",
          });

          sendJson(res, 202, {
            ok: true,
            agentId,
            sessionId,
            pid: spawned.pid,
            provider: routedProvider,
            model: routedModel,
            initiativeId,
            workstreamId,
            taskId,
            startedAt: new Date().toISOString(),
            domain: executionPolicy.domain,
            requiredSkills: executionPolicy.requiredSkills,
          });
        } catch (err: unknown) {
          sendJson(res, 500, {
            ok: false,
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (method === "POST" && isAgentStopRoute) {
        try {
          const payload = await parseJsonRequest(req);
          const runId =
            (pickString(payload, ["runId", "run_id", "sessionId", "session_id"]) ??
              searchParams.get("runId") ??
              searchParams.get("run_id") ??
              searchParams.get("sessionId") ??
              searchParams.get("session_id") ??
              "")
              .trim();
          if (!runId) {
            sendJson(res, 400, { ok: false, error: "runId is required" });
            return true;
          }

          const record = getAgentRun(runId);
          if (!record) {
            sendJson(res, 404, { ok: false, error: "Run not found" });
            return true;
          }
          if (!record.pid) {
            sendJson(res, 409, { ok: false, error: "Run has no tracked pid" });
            return true;
          }

          const result = await stopProcess(record.pid);
          const updated = markAgentRunStopped(runId);

          sendJson(res, 200, {
            ok: true,
            runId,
            agentId: record.agentId,
            pid: record.pid,
            stopped: result.stopped,
            wasRunning: result.wasRunning,
            record: updated,
          });
        } catch (err: unknown) {
          sendJson(res, 500, { ok: false, error: safeErrorMessage(err) });
        }
        return true;
      }

      if (method === "POST" && isAgentRestartRoute) {
        try {
          const payload = await parseJsonRequest(req);
          const previousRunId =
            (pickString(payload, ["runId", "run_id", "sessionId", "session_id"]) ??
              searchParams.get("runId") ??
              searchParams.get("run_id") ??
              searchParams.get("sessionId") ??
              searchParams.get("session_id") ??
              "")
              .trim();
          if (!previousRunId) {
            sendJson(res, 400, { ok: false, error: "runId is required" });
            return true;
          }

          const record = getAgentRun(previousRunId);
          if (!record) {
            sendJson(res, 404, { ok: false, error: "Run not found" });
            return true;
          }

          const messageOverride =
            (pickString(payload, ["message", "prompt", "text"]) ??
              searchParams.get("message") ??
              searchParams.get("prompt") ??
              searchParams.get("text") ??
              "")
              .trim() || null;

          const providerOverride = normalizeOpenClawProvider(
            pickString(payload, ["provider", "modelProvider", "model_provider"]) ??
              searchParams.get("provider") ??
              searchParams.get("modelProvider") ??
              searchParams.get("model_provider") ??
              record.provider ??
              null
          );
          const requestedModel =
            (pickString(payload, ["model", "modelId", "model_id"]) ??
              searchParams.get("model") ??
              searchParams.get("modelId") ??
              searchParams.get("model_id") ??
              record.model ??
              "")
              .trim() || null;
          const routingProvider =
            providerOverride ??
            (!providerOverride && !requestedModel ? resolveAutoOpenClawProvider() : null);

          let requiresPremiumRestart =
            Boolean(routingProvider) ||
            modelImpliesByok(requestedModel) ||
            modelImpliesByok(record.model ?? null);
          if (!requiresPremiumRestart) {
            try {
              const agents = await listAgents();
              const agentEntry =
                agents.find(
                  (entry) => String(entry.id ?? "").trim() === record.agentId
                ) ?? null;
              const agentModel =
                agentEntry && typeof agentEntry.model === "string"
                  ? agentEntry.model
                  : null;
              requiresPremiumRestart = modelImpliesByok(agentModel);
            } catch {
              // ignore
            }
          }

          if (requiresPremiumRestart) {
            const billingStatus = await fetchBillingStatusSafe(client);
            if (billingStatus && billingStatus.plan === "free") {
              const pricingUrl = `${client.getBaseUrl().replace(/\/+$/, "")}/pricing`;
              sendJson(res, 402, {
                ok: false,
                code: "upgrade_required",
                error:
                  "BYOK agent launch requires a paid OrgX plan. Upgrade, then retry.",
                currentPlan: billingStatus.plan,
                requiredPlan: "starter",
                actions: {
                  checkout: "/orgx/api/billing/checkout",
                  portal: "/orgx/api/billing/portal",
                  pricing: pricingUrl,
                },
              });
              return true;
            }
          }

          const sessionId = randomUUID();
          const baseMessage =
            messageOverride ?? record.message ?? `Restart agent ${record.agentId}`;
          const policyResolution = await resolveDispatchExecutionPolicy({
            initiativeId: record.initiativeId,
            initiativeTitle: record.initiativeTitle,
            workstreamId: record.workstreamId,
            taskId: record.taskId,
            message: baseMessage,
          });
          const executionPolicy = policyResolution.executionPolicy;
          const guard = await enforceSpawnGuardForDispatch({
            sourceEventPrefix: "agent_restart",
            initiativeId: record.initiativeId,
            correlationId: sessionId,
            executionPolicy,
            agentId: record.agentId,
            taskId: record.taskId,
            taskTitle: policyResolution.taskTitle,
            workstreamId: record.workstreamId,
            workstreamTitle: policyResolution.workstreamTitle,
          });
          if (!guard.allowed) {
            sendJson(res, guard.retryable ? 429 : 409, {
              ok: false,
              code: guard.retryable
                ? "spawn_guard_rate_limited"
                : "spawn_guard_blocked",
              error:
                guard.blockedReason ??
                "Spawn guard denied this restart.",
              retryable: guard.retryable,
              previousRunId,
              domain: executionPolicy.domain,
              requiredSkills: executionPolicy.requiredSkills,
            });
            return true;
          }
          const message = buildPolicyEnforcedMessage({
            baseMessage,
            executionPolicy,
            spawnGuardResult: guard.spawnGuardResult,
          });

          let routedProvider: string | null = routingProvider ?? null;
          let routedModel: string | null = requestedModel ?? null;
          if (routingProvider) {
            const routed = await configureOpenClawProviderRouting({
              agentId: record.agentId,
              provider: routingProvider,
              requestedModel,
            });
            routedProvider = routed.provider;
            routedModel = routed.model;
          }

          upsertAgentContext({
            agentId: record.agentId,
            initiativeId: record.initiativeId,
            initiativeTitle: record.initiativeTitle,
            workstreamId: record.workstreamId,
            taskId: record.taskId,
          });

          const spawned = spawnAgentTurn({
            agentId: record.agentId,
            sessionId,
            message,
          });

          upsertAgentRun({
            runId: sessionId,
            agentId: record.agentId,
            pid: spawned.pid,
            message,
            provider: routedProvider,
            model: routedModel,
            initiativeId: record.initiativeId,
            initiativeTitle: record.initiativeTitle,
            workstreamId: record.workstreamId,
            taskId: record.taskId,
            startedAt: new Date().toISOString(),
            status: "running",
          });

          sendJson(res, 202, {
            ok: true,
            previousRunId,
            sessionId,
            agentId: record.agentId,
            pid: spawned.pid,
            provider: routedProvider,
            model: routedModel,
            domain: executionPolicy.domain,
            requiredSkills: executionPolicy.requiredSkills,
          });
        } catch (err: unknown) {
          sendJson(res, 500, { ok: false, error: safeErrorMessage(err) });
        }
        return true;
      }

      if (method === "POST" && isMissionControlNextUpPlayRoute) {
        try {
          const payload = await parseJsonRequest(req);
          const initiativeId =
            (pickString(payload, ["initiativeId", "initiative_id"]) ??
              searchParams.get("initiativeId") ??
              searchParams.get("initiative_id") ??
              "")
              .trim();
          const workstreamId =
            (pickString(payload, ["workstreamId", "workstream_id"]) ??
              searchParams.get("workstreamId") ??
              searchParams.get("workstream_id") ??
              "")
              .trim();

          if (!initiativeId || !workstreamId) {
            sendJson(res, 400, {
              ok: false,
              error: "initiativeId and workstreamId are required",
            });
            return true;
          }

          let agentIdRaw =
            (pickString(payload, ["agentId", "agent_id"]) ??
              searchParams.get("agentId") ??
              searchParams.get("agent_id") ??
              "")
              .trim();

          const queue = await buildNextUpQueue({ initiativeId });
          const matchedQueueItem =
            queue.items.find((item) => item.workstreamId === workstreamId) ?? null;

          if (!agentIdRaw && matchedQueueItem?.runnerAgentId) {
            agentIdRaw = matchedQueueItem.runnerAgentId;
          }

          const agentId = agentIdRaw || "main";
          if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
            sendJson(res, 400, {
              ok: false,
              error: "agentId must be a simple identifier (letters, numbers, _ or -).",
            });
            return true;
          }

          const upgradeGate = await resolveAutoContinueUpgradeGate(agentId);
          if (upgradeGate) {
            sendJson(res, 402, {
              ok: false,
              ...upgradeGate,
            });
            return true;
          }

          const tokenBudget =
            pickNumber(payload, [
              "tokenBudget",
              "token_budget",
              "tokenBudgetTokens",
              "token_budget_tokens",
              "maxTokens",
              "max_tokens",
            ]) ??
            searchParams.get("tokenBudget") ??
            searchParams.get("token_budget") ??
            searchParams.get("tokenBudgetTokens") ??
            searchParams.get("token_budget_tokens") ??
            searchParams.get("maxTokens") ??
            searchParams.get("max_tokens") ??
            null;

          const includeVerificationRaw =
            payload.includeVerification ??
            (payload as Record<string, unknown>).include_verification ??
            searchParams.get("includeVerification") ??
            searchParams.get("include_verification") ??
            null;
          const includeVerification =
            typeof includeVerificationRaw === "boolean"
              ? includeVerificationRaw
              : parseBooleanQuery(
                  typeof includeVerificationRaw === "string"
                    ? includeVerificationRaw
                    : null
                );

          const run = await startAutoContinueRun({
            initiativeId,
            agentId,
            tokenBudget,
            includeVerification,
            allowedWorkstreamIds: [workstreamId],
          });

          // Play should feel immediate. Run one dispatch tick synchronously so the
          // user gets an actual launch (or a concrete error) in this response.
          await tickAutoContinueRun(run);

          let fallbackDispatch:
            | {
                sessionId: string | null;
                pid: number | null;
                blockedReason: string | null;
                retryable: boolean;
                executionPolicy: { domain: string; requiredSkills: string[] };
                spawnGuardResult: unknown | null;
              }
            | null = null;
          if (
            !run.activeRunId &&
            matchedQueueItem &&
            matchedQueueItem.runnerSource === "fallback"
          ) {
            fallbackDispatch = await dispatchFallbackWorkstreamTurn({
              initiativeId,
              initiativeTitle: matchedQueueItem.initiativeTitle,
              workstreamId,
              workstreamTitle: matchedQueueItem.workstreamTitle,
              agentId,
            });
          }

          const fallbackStarted = Boolean(fallbackDispatch?.sessionId);
          const dispatchMode = run.activeRunId
            ? "task"
            : fallbackStarted
              ? "fallback"
              : "none";
          if (dispatchMode === "none") {
            const fallbackBlockedReason = fallbackDispatch?.blockedReason ?? null;
            const reason =
              fallbackBlockedReason ??
              (run.stopReason === "blocked"
                ? "No dispatchable task is ready for this workstream yet."
                : run.stopReason === "completed"
                  ? "No queued task is available for this workstream."
                  : "Unable to dispatch this workstream right now.");
            sendJson(
              res,
              fallbackDispatch?.retryable ? 429 : 409,
              {
              ok: false,
              code: fallbackBlockedReason
                ? fallbackDispatch?.retryable
                  ? "spawn_guard_rate_limited"
                  : "spawn_guard_blocked"
                : undefined,
              error: reason,
              run,
              initiativeId,
              workstreamId,
              agentId,
              fallbackDispatch,
            }
            );
            return true;
          }

          sendJson(res, 200, {
            ok: true,
            run,
            initiativeId,
            workstreamId,
            agentId,
            dispatchMode,
            sessionId: run.activeRunId ?? fallbackDispatch?.sessionId ?? null,
          });
        } catch (err: unknown) {
          sendJson(res, 500, { ok: false, error: safeErrorMessage(err) });
        }
        return true;
      }

      if (method === "POST" && isMissionControlNextUpPinRoute) {
        try {
          const payload = await parseJsonRequest(req);
          const initiativeId =
            (pickString(payload, ["initiativeId", "initiative_id"]) ??
              searchParams.get("initiativeId") ??
              searchParams.get("initiative_id") ??
              "")
              .trim();
          const workstreamId =
            (pickString(payload, ["workstreamId", "workstream_id"]) ??
              searchParams.get("workstreamId") ??
              searchParams.get("workstream_id") ??
              "")
              .trim();
          const preferredTaskId =
            (pickString(payload, ["taskId", "task_id", "preferredTaskId", "preferred_task_id"]) ??
              "")
              .trim() || null;
          const preferredMilestoneId =
            (pickString(payload, ["milestoneId", "milestone_id", "preferredMilestoneId", "preferred_milestone_id"]) ??
              "")
              .trim() || null;

          if (!initiativeId || !workstreamId) {
            sendJson(res, 400, { ok: false, error: "initiativeId and workstreamId are required" });
            return true;
          }

          const next = upsertNextUpQueuePin({
            initiativeId,
            workstreamId,
            preferredTaskId,
            preferredMilestoneId,
          });

          sendJson(res, 200, { ok: true, pins: next.pins, updatedAt: next.updatedAt });
        } catch (err: unknown) {
          sendJson(res, 500, { ok: false, error: safeErrorMessage(err) });
        }
        return true;
      }

      if (method === "POST" && isMissionControlNextUpUnpinRoute) {
        try {
          const payload = await parseJsonRequest(req);
          const initiativeId =
            (pickString(payload, ["initiativeId", "initiative_id"]) ??
              searchParams.get("initiativeId") ??
              searchParams.get("initiative_id") ??
              "")
              .trim();
          const workstreamId =
            (pickString(payload, ["workstreamId", "workstream_id"]) ??
              searchParams.get("workstreamId") ??
              searchParams.get("workstream_id") ??
              "")
              .trim();

          if (!initiativeId || !workstreamId) {
            sendJson(res, 400, { ok: false, error: "initiativeId and workstreamId are required" });
            return true;
          }

          const next = removeNextUpQueuePin({ initiativeId, workstreamId });
          sendJson(res, 200, { ok: true, pins: next.pins, updatedAt: next.updatedAt });
        } catch (err: unknown) {
          sendJson(res, 500, { ok: false, error: safeErrorMessage(err) });
        }
        return true;
      }

      if (method === "POST" && isMissionControlNextUpReorderRoute) {
        try {
          const payload = await parseJsonRequest(req);
          const rawOrder = Array.isArray((payload as any)?.order) ? ((payload as any).order as unknown[]) : [];
          const order: Array<{ initiativeId: string; workstreamId: string }> = [];

          for (const entry of rawOrder) {
            if (!entry) continue;
            if (typeof entry === "string") {
              const [initiativeId, workstreamId] = entry.split(":", 2).map((s) => s.trim());
              if (initiativeId && workstreamId) order.push({ initiativeId, workstreamId });
              continue;
            }
            if (typeof entry === "object") {
              const record = entry as Record<string, unknown>;
              const initiativeId = (pickString(record, ["initiativeId", "initiative_id"]) ?? "").trim();
              const workstreamId = (pickString(record, ["workstreamId", "workstream_id"]) ?? "").trim();
              if (initiativeId && workstreamId) order.push({ initiativeId, workstreamId });
            }
          }

          const next = setNextUpQueuePinOrder({ order });
          sendJson(res, 200, { ok: true, pins: next.pins, updatedAt: next.updatedAt });
        } catch (err: unknown) {
          sendJson(res, 500, { ok: false, error: safeErrorMessage(err) });
        }
        return true;
      }

      if (method === "POST" && isMissionControlAutoContinueStartRoute) {
        try {
          const payload = await parseJsonRequest(req);
          const initiativeId =
            (pickString(payload, ["initiativeId", "initiative_id"]) ??
              searchParams.get("initiativeId") ??
              searchParams.get("initiative_id") ??
              "")
              .trim();

          if (!initiativeId) {
            sendJson(res, 400, { ok: false, error: "initiativeId is required" });
            return true;
          }

          const agentIdRaw =
            (pickString(payload, ["agentId", "agent_id"]) ??
              searchParams.get("agentId") ??
              searchParams.get("agent_id") ??
              "main")
              .trim();
          const agentId = agentIdRaw || "main";
          if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
            sendJson(res, 400, {
              ok: false,
              error: "agentId must be a simple identifier (letters, numbers, _ or -).",
            });
            return true;
          }

          const upgradeGate = await resolveAutoContinueUpgradeGate(agentId);
          if (upgradeGate) {
            sendJson(res, 402, {
              ok: false,
              ...upgradeGate,
            });
            return true;
          }

          const tokenBudget =
            pickNumber(payload, [
              "tokenBudget",
              "token_budget",
              "tokenBudgetTokens",
              "token_budget_tokens",
              "maxTokens",
              "max_tokens",
            ]) ??
            searchParams.get("tokenBudget") ??
            searchParams.get("token_budget") ??
            searchParams.get("tokenBudgetTokens") ??
            searchParams.get("token_budget_tokens") ??
            searchParams.get("maxTokens") ??
            searchParams.get("max_tokens") ??
            null;

          const includeVerificationRaw =
            payload.includeVerification ??
            (payload as Record<string, unknown>).include_verification ??
            searchParams.get("includeVerification") ??
            searchParams.get("include_verification") ??
            null;
          const includeVerification =
            typeof includeVerificationRaw === "boolean"
              ? includeVerificationRaw
              : parseBooleanQuery(
                  typeof includeVerificationRaw === "string"
                    ? includeVerificationRaw
                    : null
                );

          const workstreamFilter = dedupeStrings([
            ...pickStringArray(payload, [
              "workstreamIds",
              "workstream_ids",
              "workstreamId",
              "workstream_id",
            ]),
            ...(searchParams.get("workstreamIds") ??
            searchParams.get("workstream_ids") ??
            searchParams.get("workstreamId") ??
            searchParams.get("workstream_id") ??
            "")
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean),
          ]);
          const allowedWorkstreamIds =
            workstreamFilter.length > 0 ? workstreamFilter : null;

          const run = await startAutoContinueRun({
            initiativeId,
            agentId,
            tokenBudget,
            includeVerification,
            allowedWorkstreamIds,
          });

          sendJson(res, 200, { ok: true, run });
        } catch (err: unknown) {
          sendJson(res, 500, { ok: false, error: safeErrorMessage(err) });
        }
        return true;
      }

      if (method === "POST" && isMissionControlAutoContinueStopRoute) {
        try {
          const payload = await parseJsonRequest(req);
          const initiativeId =
            (pickString(payload, ["initiativeId", "initiative_id"]) ??
              searchParams.get("initiativeId") ??
              searchParams.get("initiative_id") ??
              "")
              .trim();

          if (!initiativeId) {
            sendJson(res, 400, { ok: false, error: "initiativeId is required" });
            return true;
          }

          const run = autoContinueRuns.get(initiativeId) ?? null;
          if (!run) {
            sendJson(res, 404, { ok: false, error: "No auto-continue run found" });
            return true;
          }

          const now = new Date().toISOString();
          run.stopRequested = true;
          run.status = run.activeRunId ? "stopping" : "stopped";
          run.updatedAt = now;

          if (!run.activeRunId) {
            await stopAutoContinueRun({ run, reason: "stopped" });
          } else {
            try {
              await updateInitiativeAutoContinueState({ initiativeId, run });
            } catch {
              // best effort
            }
          }

          sendJson(res, 200, { ok: true, run });
        } catch (err: unknown) {
          sendJson(res, 500, { ok: false, error: safeErrorMessage(err) });
        }
        return true;
      }

      if (
        method === "POST" &&
        (route === "live/decisions/approve" || decisionApproveMatch)
      ) {
        try {
          const payload = await parseJsonRequest(req);
          const action = payload.action === "reject" ? "reject" : "approve";
          const note =
            typeof payload.note === "string" && payload.note.trim().length > 0
              ? payload.note.trim()
              : undefined;

          const ids = decisionApproveMatch
            ? [decodeURIComponent(decisionApproveMatch[1])]
            : Array.isArray(payload.ids)
              ? payload.ids
                  .filter((id): id is string => typeof id === "string")
                  .map((id) => id.trim())
                  .filter(Boolean)
              : [];

          if (ids.length === 0) {
            sendJson(res, 400, {
              error: "Decision IDs are required.",
              expected: {
                route: "/orgx/api/live/decisions/approve",
                body: { ids: ["decision-id"], action: "approve|reject" },
              },
            });
            return true;
          }

          const results = await client.bulkDecideDecisions(ids, action, note);
          const updated = results.filter((result) => result.ok).length;
          const failed = results.length - updated;

          sendJson(res, failed > 0 ? 207 : 200, {
            action,
            requested: ids.length,
            updated,
            failed,
            results,
          });
        } catch (err: unknown) {
          sendJson(res, 500, {
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (method === "POST" && isDelegationPreflight) {
        try {
          const payload = await parseJsonRequest(req);
          const intent = pickString(payload, ["intent"]);
          if (!intent) {
            sendJson(res, 400, { error: "intent is required" });
            return true;
          }

          const toStringArray = (value: unknown): string[] | undefined =>
            Array.isArray(value)
              ? value.filter((entry): entry is string => typeof entry === "string")
              : undefined;

          const data = await client.delegationPreflight({
            intent,
            acceptanceCriteria: toStringArray(payload.acceptanceCriteria),
            constraints: toStringArray(payload.constraints),
            domains: toStringArray(payload.domains),
          });

          sendJson(res, 200, data);
        } catch (err: unknown) {
          sendJson(res, 500, {
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (method === "POST" && isMissionControlAutoAssignmentRoute) {
        try {
          const payload = await parseJsonRequest(req);
          const entityId = pickString(payload, ["entity_id", "entityId"]);
          const entityType = pickString(payload, ["entity_type", "entityType"]);
          const initiativeId =
            pickString(payload, ["initiative_id", "initiativeId"]) ?? null;
          const title = pickString(payload, ["title", "name"]) ?? "Untitled";
          const summary =
            pickString(payload, ["summary", "description", "context"]) ?? null;

          if (!entityId || !entityType) {
            sendJson(res, 400, {
              ok: false,
              error: "entity_id and entity_type are required.",
            });
            return true;
          }

          const assignment = await resolveAutoAssignments({
            client,
            entityId,
            entityType,
            initiativeId,
            title,
            summary,
          });

          sendJson(res, 200, assignment);
        } catch (err: unknown) {
          sendJson(res, 500, {
            ok: false,
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (runCheckpointsMatch && method === "POST") {
        try {
          const runId = decodeURIComponent(runCheckpointsMatch[1]);
          const payload = await parseJsonRequest(req);
          const reason = pickString(payload, ["reason"]) ?? undefined;
          const rawPayload = payload.payload;
          const checkpointPayload =
            rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
              ? (rawPayload as Record<string, unknown>)
              : undefined;

          const data = await client.createRunCheckpoint(runId, {
            reason,
            payload: checkpointPayload,
          });
          sendJson(res, 200, data);
        } catch (err: unknown) {
          sendJson(res, 500, {
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (runCheckpointRestoreMatch && method === "POST") {
        try {
          const runId = decodeURIComponent(runCheckpointRestoreMatch[1]);
          const checkpointId = decodeURIComponent(runCheckpointRestoreMatch[2]);
          const payload = await parseJsonRequest(req);
          const reason = pickString(payload, ["reason"]) ?? undefined;
          const data = await client.restoreRunCheckpoint(runId, {
            checkpointId,
            reason,
          });
          sendJson(res, 200, data);
        } catch (err: unknown) {
          sendJson(res, 500, {
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (runActionMatch && method === "POST") {
        try {
          const runId = decodeURIComponent(runActionMatch[1]);
          const action = decodeURIComponent(runActionMatch[2]) as
            | "pause"
            | "resume"
            | "cancel"
            | "rollback";
          const payload = await parseJsonRequest(req);
          const checkpointId = pickString(payload, ["checkpointId", "checkpoint_id"]);
          const reason = pickString(payload, ["reason"]);

          const data = await client.runAction(runId, action, {
            checkpointId: checkpointId ?? undefined,
            reason: reason ?? undefined,
          });
          sendJson(res, 200, data);
        } catch (err: unknown) {
          sendJson(res, 500, {
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      // Entity action / delete route: POST /orgx/api/entities/{type}/{id}/{action}
      if (entityActionMatch && method === "POST") {
        try {
          const entityType = decodeURIComponent(entityActionMatch[1]);
          const entityId = decodeURIComponent(entityActionMatch[2]);
          const entityAction = decodeURIComponent(entityActionMatch[3]);
          const payload = await parseJsonRequest(req);

          if (entityAction === "delete") {
            // Delete via status update. Initiatives use `archived` in OrgX.
            const deleteStatus =
              entityType.trim().toLowerCase() === "initiative"
                ? "archived"
                : "deleted";
            try {
              const entity = await client.updateEntity(entityType, entityId, {
                status: deleteStatus,
              });
              if (entityType.trim().toLowerCase() === "initiative") {
                clearLocalInitiativeStatusOverride(entityId);
              }
              sendJson(res, 200, { ok: true, entity, deletedAsStatus: deleteStatus });
            } catch (err: unknown) {
              if (
                entityType.trim().toLowerCase() === "initiative" &&
                isUnauthorizedOrgxError(err)
              ) {
                setLocalInitiativeStatusOverride(entityId, deleteStatus);
                sendJson(res, 200, {
                  ok: true,
                  localFallback: true,
                  warning: safeErrorMessage(err),
                  entity: {
                    id: entityId,
                    type: entityType,
                    status: deleteStatus,
                  },
                  deletedAsStatus: deleteStatus,
                });
                return true;
              }
              throw err;
            }
          } else {
            // Map action to status update
            const statusMap: Record<string, string> = {
              start: "in_progress",
              complete: "done",
              block: "blocked",
              unblock: "in_progress",
              pause: "paused",
              resume: "active",
            };
            const newStatus = statusMap[entityAction];
            if (!newStatus) {
              sendJson(res, 400, {
                error: `Unknown entity action: ${entityAction}`,
              });
              return true;
            }
            try {
              const entity = await client.updateEntity(entityType, entityId, {
                status: newStatus,
                ...(payload.force ? { force: true } : {}),
              });
              if (entityType.trim().toLowerCase() === "initiative") {
                clearLocalInitiativeStatusOverride(entityId);
              }
              sendJson(res, 200, { ok: true, entity });
            } catch (err: unknown) {
              if (
                entityType.trim().toLowerCase() === "initiative" &&
                isUnauthorizedOrgxError(err)
              ) {
                setLocalInitiativeStatusOverride(entityId, newStatus);
                sendJson(res, 200, {
                  ok: true,
                  localFallback: true,
                  warning: safeErrorMessage(err),
                  entity: {
                    id: entityId,
                    type: entityType,
                    status: newStatus,
                  },
                });
                return true;
              }
              throw err;
            }
          }
        } catch (err: unknown) {
          sendJson(res, 500, {
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (
        method !== "GET" &&
        method !== "HEAD" &&
        !(runCheckpointsMatch && method === "POST") &&
        !(runCheckpointRestoreMatch && method === "POST") &&
        !(runActionMatch && method === "POST") &&
        !(isDelegationPreflight && method === "POST") &&
        !(isMissionControlAutoAssignmentRoute && method === "POST") &&
        !(isMissionControlNextUpPlayRoute && method === "POST") &&
        !(isMissionControlNextUpPinRoute && method === "POST") &&
        !(isMissionControlNextUpUnpinRoute && method === "POST") &&
        !(isMissionControlNextUpReorderRoute && method === "POST") &&
        !(isEntitiesRoute && method === "POST") &&
        !(isEntitiesRoute && method === "PATCH") &&
        !(entityActionMatch && method === "POST") &&
        !(isOnboardingStartRoute && method === "POST") &&
        !(isOnboardingManualKeyRoute && method === "POST") &&
        !(isOnboardingDisconnectRoute && method === "POST") &&
        !(isByokSettingsRoute && method === "POST") &&
        !(isLiveActivityHeadlineRoute && method === "POST") &&
        !(route === "hooks/runtime" && method === "POST") &&
        !(route === "hooks/runtime/setup" && method === "POST")
      ) {
        res.writeHead(405, {
          "Content-Type": "text/plain",
          ...SECURITY_HEADERS,
          ...CORS_HEADERS,
        });
        res.end("Method Not Allowed");
        return true;
      }

      switch (route) {
        case "status": {
          // Proxy-style: try live fetch, fall back to cache
          let snapshot = getSnapshot();
          if (!snapshot) {
            try {
              snapshot = await client.getOrgSnapshot();
            } catch {
              // use null snapshot
            }
          }
          if (method === "HEAD") {
            // The dashboard uses a HEAD probe to determine connection state.
            // Mirror the GET semantics (connected vs not) via status code,
            // but omit a response body.
            res.writeHead(snapshot ? 200 : 503, {
              ...SECURITY_HEADERS,
              ...CORS_HEADERS,
            });
            res.end();
            return true;
          }

          sendJson(res, 200, formatStatus(snapshot));
          return true;
        }

        case "health": {
          const probeRemote = parseBooleanQuery(
            searchParams.get("probe") ?? searchParams.get("probe_remote")
          );
          try {
            if (diagnostics?.getHealth) {
              const health = await diagnostics.getHealth({ probeRemote });
              sendJson(res, 200, health);
              return true;
            }

            const outbox = await outboxAdapter.readSummary();
            sendJson(res, 200, {
              ok: true,
              status: "ok",
              generatedAt: new Date().toISOString(),
              checks: [],
              plugin: {
                baseUrl: config.baseUrl,
              },
              auth: {
                hasApiKey: Boolean(config.apiKey),
              },
              outbox: {
                pendingTotal: outbox.pendingTotal,
                pendingByQueue: outbox.pendingByQueue,
                oldestEventAt: outbox.oldestEventAt,
                newestEventAt: outbox.newestEventAt,
                replayStatus: "idle",
                lastReplayAttemptAt: null,
                lastReplaySuccessAt: null,
                lastReplayFailureAt: null,
                lastReplayError: null,
              },
              remote: {
                enabled: false,
                reachable: null,
                latencyMs: null,
                error: null,
              },
            });
          } catch (err: unknown) {
            sendJson(res, 500, {
              error: safeErrorMessage(err),
            });
          }
          return true;
        }

        case "agents":
          sendJson(res, 200, formatAgents(getSnapshot()));
          return true;

        case "agents/catalog": {
          try {
            const [openclawAgents, localSnapshot] = await Promise.all([
              listAgents(),
              loadLocalOpenClawSnapshot(240).catch(() => null),
            ]);

            const localById = new Map<
              string,
              {
                status: string;
                currentTask: string | null;
                runId: string | null;
                startedAt: string | null;
                blockers: string[];
              }
            >();
            if (localSnapshot) {
              for (const agent of localSnapshot.agents) {
                localById.set(agent.id, {
                  status: agent.status,
                  currentTask: agent.currentTask,
                  runId: agent.runId,
                  startedAt: agent.startedAt,
                  blockers: agent.blockers,
                });
              }
            }

            const contexts = readAgentContexts().agents;
            const runs = readAgentRuns().runs;
            const latestRunByAgent = new Map<string, (typeof runs)[string]>();

            for (const run of Object.values(runs)) {
              if (!run || typeof run !== "object") continue;
              const agentId = typeof run.agentId === "string" ? run.agentId.trim() : "";
              if (!agentId) continue;
              const existing = latestRunByAgent.get(agentId);
              const nextTs = Date.parse(run.startedAt ?? "");
              const existingTs = existing ? Date.parse(existing.startedAt ?? "") : 0;

              // Prefer latest running record; fall back to latest overall if none running.
              if (!existing) {
                latestRunByAgent.set(agentId, run);
                continue;
              }

              const existingRunning = existing.status === "running";
              const nextRunning = run.status === "running";
              if (nextRunning && !existingRunning) {
                latestRunByAgent.set(agentId, run);
                continue;
              }
              if (nextRunning === existingRunning && nextTs > existingTs) {
                latestRunByAgent.set(agentId, run);
              }
            }

            const agents = openclawAgents.map((entry) => {
              const id = typeof entry.id === "string" ? entry.id.trim() : "";
              const name =
                typeof entry.name === "string" && entry.name.trim().length > 0
                  ? entry.name.trim()
                  : id || "unknown";
              const local = id ? localById.get(id) ?? null : null;
              const context = id ? contexts[id] ?? null : null;
              const runFromSession = id && local?.runId ? runs[local.runId] ?? null : null;
              const run = runFromSession ?? (id ? latestRunByAgent.get(id) ?? null : null);
              return {
                id,
                name,
                workspace: typeof entry.workspace === "string" ? entry.workspace : null,
                model: typeof entry.model === "string" ? entry.model : null,
                isDefault: Boolean(entry.isDefault),
                status: local?.status ?? null,
                currentTask: local?.currentTask ?? null,
                runId: local?.runId ?? null,
                startedAt: local?.startedAt ?? null,
                blockers: local?.blockers ?? [],
                context,
                run,
              };
            });

            sendJson(res, 200, {
              generatedAt: new Date().toISOString(),
              agents,
            });
          } catch (err: unknown) {
            sendJson(res, 500, {
              error: safeErrorMessage(err),
            });
          }
          return true;
        }

        case "activity":
          sendJson(res, 200, formatActivity(getSnapshot()));
          return true;

        case "initiatives":
          sendJson(res, 200, formatInitiatives(getSnapshot()));
          return true;

        case "onboarding":
          sendJson(res, 200, getOnboardingState(await onboarding.getStatus()));
          return true;

        case "hooks/runtime/config": {
          try {
            const snapshot = readOpenClawSettingsSnapshot();
            const port = readOpenClawGatewayPort(snapshot.raw);
            const runtimeHookUrl = `http://127.0.0.1:${port}/orgx/api/hooks/runtime`;
            const hookToken = resolveRuntimeHookToken();

            const hooksDir = join(getOrgxPluginConfigDir(), "hooks");
            const hookScriptPath = join(hooksDir, "post-reporting-event.mjs");
            const hookScriptInstalled = existsSync(hookScriptPath);

            const codexHome = (process.env.CODEX_HOME ?? "").trim();
            const codexCandidates = [
              codexHome ? join(codexHome, "config.toml") : null,
              join(homedir(), ".codex", "config.toml"),
              join(homedir(), ".config", "codex", "config.toml"),
            ].filter(Boolean) as string[];
            const codexConfigPath =
              codexCandidates.find((candidate) => existsSync(candidate)) ??
              (codexCandidates[0] ?? null);

            let codexInstalled = false;
            let codexHasNotify = false;
            if (codexConfigPath && existsSync(codexConfigPath)) {
              const raw = readFileSync(codexConfigPath, "utf8");
              codexHasNotify = /^\s*notify\s*=/m.test(raw);
              codexInstalled =
                raw.includes("post-reporting-event.mjs") &&
                raw.includes("--source_client=codex");
            }
            const codexNotifyConflict = Boolean(codexHasNotify && !codexInstalled);

            const claudeCandidates = [
              join(homedir(), ".claude", "settings.json"),
              join(homedir(), ".config", "claude", "settings.json"),
            ];
            const claudeSettingsPath =
              claudeCandidates.find((candidate) => existsSync(candidate)) ??
              claudeCandidates[0];

            let claudeInstalled = false;
            if (claudeSettingsPath && existsSync(claudeSettingsPath)) {
              const raw = readFileSync(claudeSettingsPath, "utf8");
              claudeInstalled =
                raw.includes("post-reporting-event.mjs") &&
                raw.includes("--source_client=claude-code");
            }

            sendJson(res, 200, {
              ok: true,
              runtimeHookUrl,
              hookToken,
              hookTokenHint: maskSecret(hookToken),
              paths: {
                hookScriptPath,
                codexConfigPath,
                claudeSettingsPath,
              },
              installed: {
                hookScript: hookScriptInstalled,
                codex: codexInstalled,
                claudeCode: claudeInstalled,
              },
              conflicts: {
                codexNotify: codexNotifyConflict,
              },
            });
          } catch (err: unknown) {
            sendJson(res, 500, {
              ok: false,
              error: safeErrorMessage(err),
            });
          }
          return true;
        }

        case "hooks/runtime/setup": {
          if (method !== "POST") {
            sendJson(res, 405, {
              ok: false,
              error: "Use POST /orgx/api/hooks/runtime/setup",
            });
            return true;
          }

          try {
            const payloadRecord = await parseJsonRequest(req);
            const requestedTargets = Array.isArray(payloadRecord.targets)
              ? payloadRecord.targets
              : [];
            const requested = requestedTargets
              .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
              .filter((value) => value.length > 0);

            const targets = new Set<string>();
            for (const value of requested) {
              if (value === "codex") targets.add("codex");
              if (
                value === "claude" ||
                value === "claude-code" ||
                value === "claude_code"
              ) {
                targets.add("claude-code");
              }
            }
            if (targets.size === 0) {
              targets.add("codex");
              targets.add("claude-code");
            }

            const snapshot = readOpenClawSettingsSnapshot();
            const port = readOpenClawGatewayPort(snapshot.raw);
            const runtimeHookUrl = `http://127.0.0.1:${port}/orgx/api/hooks/runtime`;
            const hookToken = resolveRuntimeHookToken();

            const hooksDir = join(getOrgxPluginConfigDir(), "hooks");
            mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
            const hookScriptPath = join(hooksDir, "post-reporting-event.mjs");

            const handlerFilename = fileURLToPath(import.meta.url);
            const distDir = resolve(join(handlerFilename, ".."));
            const bundledScriptPath = resolve(distDir, "hooks", "post-reporting-event.mjs");
            const fallbackScriptPath = resolve(
              distDir,
              "..",
              "templates",
              "hooks",
              "scripts",
              "post-reporting-event.mjs"
            );

            let scriptContent = "";
            let hookScriptSourcePath = bundledScriptPath;
            try {
              scriptContent = readFileSync(bundledScriptPath, "utf8");
            } catch {
              hookScriptSourcePath = fallbackScriptPath;
              scriptContent = readFileSync(fallbackScriptPath, "utf8");
            }

            writeFileAtomicSync(hookScriptPath, scriptContent, {
              mode: 0o700,
              encoding: "utf8",
            });

            const result = {
              ok: true,
              runtimeHookUrl,
              hookTokenHint: maskSecret(hookToken),
              hookScriptPath,
              hookScriptSourcePath,
              targets: {
                codex: targets.has("codex"),
                claudeCode: targets.has("claude-code"),
              },
              codex: {
                path: null as string | null,
                installed: false,
                conflict: false,
              },
              claudeCode: {
                path: null as string | null,
                installed: false,
              },
            };

            if (targets.has("codex")) {
              const codexHome = (process.env.CODEX_HOME ?? "").trim();
              const codexCandidates = [
                codexHome ? join(codexHome, "config.toml") : null,
                join(homedir(), ".codex", "config.toml"),
                join(homedir(), ".config", "codex", "config.toml"),
              ].filter(Boolean) as string[];
              const codexConfigPath =
                codexCandidates.find((candidate) => existsSync(candidate)) ??
                codexCandidates[0];

              result.codex.path = codexConfigPath;

              const notifySnippet = [
                "",
                "# OrgX runtime telemetry (installed by OpenClaw plugin)",
                "notify = [",
                '  "node",',
                `  "${hookScriptPath}",`,
                '  "--event=heartbeat",',
                '  "--source_client=codex",',
                '  "--phase=execution",',
                '  "--message=Codex heartbeat",',
                `  "--runtime_hook_url=${runtimeHookUrl}",`,
                `  "--hook_token=${hookToken}",`,
                "]",
                "",
              ].join("\n");

              if (!existsSync(codexConfigPath)) {
                mkdirSync(dirname(codexConfigPath), { recursive: true, mode: 0o700 });
                const initial = [
                  "# Codex config.toml",
                  "# Auto-generated OrgX hook wiring (safe to edit).",
                  notifySnippet.trimEnd(),
                  "",
                ].join("\n");
                writeFileAtomicSync(codexConfigPath, initial, {
                  mode: 0o600,
                  encoding: "utf8",
                });
                result.codex.installed = true;
              } else {
                const raw = readFileSync(codexConfigPath, "utf8");
                const alreadyInstalled =
                  raw.includes("post-reporting-event.mjs") &&
                  raw.includes("--source_client=codex");
                const hasNotify = /^\s*notify\s*=/m.test(raw);

                if (alreadyInstalled) {
                  result.codex.installed = true;
                } else if (hasNotify) {
                  result.codex.conflict = true;
                } else {
                  const next = raw.replace(/\s*$/, "") + notifySnippet;
                  writeFileAtomicSync(codexConfigPath, next, {
                    mode: 0o600,
                    encoding: "utf8",
                  });
                  result.codex.installed = true;
                }
              }
            }

            if (targets.has("claude-code")) {
              const claudeCandidates = [
                join(homedir(), ".claude", "settings.json"),
                join(homedir(), ".config", "claude", "settings.json"),
              ];
              const claudeSettingsPath =
                claudeCandidates.find((candidate) => existsSync(candidate)) ??
                claudeCandidates[0];

              result.claudeCode.path = claudeSettingsPath;

              mkdirSync(dirname(claudeSettingsPath), { recursive: true, mode: 0o700 });

              let settings: Record<string, unknown> = {};
              if (existsSync(claudeSettingsPath)) {
                const raw = readFileSync(claudeSettingsPath, "utf8");
                const parsed = parseJsonSafe<Record<string, unknown>>(raw);
                if (!parsed) {
                  backupCorruptFileSync(claudeSettingsPath);
                } else {
                  settings = parsed;
                }
              }

              const hooksRoot =
                settings.hooks &&
                typeof settings.hooks === "object" &&
                !Array.isArray(settings.hooks)
                  ? (settings.hooks as Record<string, unknown>)
                  : {};
              settings.hooks = hooksRoot;

              const ensureClaudeHook = (hookName: string, matcher: string, command: string) => {
                const list = Array.isArray(hooksRoot[hookName])
                  ? (hooksRoot[hookName] as Array<Record<string, unknown>>)
                  : [];

                let rule = list.find(
                  (entry) => entry && (entry as any).matcher === matcher
                ) as any;
                if (!rule) {
                  rule = { matcher, hooks: [] };
                  list.push(rule);
                }
                if (!Array.isArray(rule.hooks)) {
                  rule.hooks = [];
                }

                const already = rule.hooks.some(
                  (entry: any) =>
                    entry &&
                    entry.type === "command" &&
                    typeof entry.command === "string" &&
                    entry.command.includes("post-reporting-event.mjs") &&
                    entry.command.includes(command)
                );

                if (!already) {
                  rule.hooks.push({ type: "command", command });
                }

                hooksRoot[hookName] = list;
              };

              const baseArgs = `--runtime_hook_url=${runtimeHookUrl} --hook_token=${hookToken}`;
              const startCmd = `node ${hookScriptPath} --event=session_start --source_client=claude-code --phase=intent --message=\"Claude session started\" ${baseArgs}`;
              const toolCmd = `node ${hookScriptPath} --event=task_update --source_client=claude-code --phase=execution --message=\"Claude tool completed\" ${baseArgs}`;
              const stopCmd = `node ${hookScriptPath} --event=session_stop --source_client=claude-code --phase=completed --message=\"Claude session completed\" ${baseArgs}`;

              ensureClaudeHook("SessionStart", "", startCmd);
              ensureClaudeHook("PostToolUse", "Write|Edit|Bash", toolCmd);
              ensureClaudeHook("Stop", "", stopCmd);

              writeFileAtomicSync(
                claudeSettingsPath,
                `${JSON.stringify(settings, null, 2)}\n`,
                {
                  mode: 0o600,
                  encoding: "utf8",
                }
              );

              result.claudeCode.installed = true;
            }

            sendJson(res, 200, result);
          } catch (err: unknown) {
            sendJson(res, 500, {
              ok: false,
              error: safeErrorMessage(err),
            });
          }
          return true;
        }

        case "hooks/runtime/stream": {
          const write = res.write?.bind(res);
          if (!write) {
            sendJson(res, 501, { ok: false, error: "Streaming not supported" });
            return true;
          }

          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            ...SECURITY_HEADERS,
            ...CORS_HEADERS,
          });

          const subscriberId = randomUUID();
          const subscriber: RuntimeStreamSubscriber = {
            id: subscriberId,
            write: (chunk: Buffer) => write(chunk) !== false,
            end: () => {
              if (!res.writableEnded) {
                res.end();
              }
            },
          };

          runtimeStreamSubscribers.set(subscriberId, subscriber);
          ensureRuntimeStreamTimers();

          try {
            const initial = listRuntimeInstances({ limit: 320 });
            writeRuntimeSseEvent(subscriber, "runtime.updated", initial);
          } catch {
            // ignore
          }

          const close = () => {
            runtimeStreamSubscribers.delete(subscriberId);
            try {
              subscriber.end();
            } catch {
              // ignore
            }
            if (runtimeStreamSubscribers.size === 0) {
              stopRuntimeStreamTimers();
            }
          };

          req.on?.("close", close);
          req.on?.("aborted", close);
          res.on?.("close", close);
          res.on?.("finish", close);

          return true;
        }

        case "hooks/runtime": {
          if (method !== "POST") {
            sendJson(res, 405, { ok: false, error: "Use POST /orgx/api/hooks/runtime" });
            return true;
          }

          const expectedHookToken = resolveRuntimeHookToken();
          const providedHookToken =
            pickHeaderString(req.headers, ["x-orgx-hook-token", "x-hook-token"]) ??
            searchParams.get("hook_token") ??
            searchParams.get("token");

          if (!providedHookToken || providedHookToken.trim() !== expectedHookToken) {
            sendJson(res, 401, {
              ok: false,
              error: "Invalid hook token",
            });
            return true;
          }

          try {
            const payloadRecord = await parseJsonRequest(req);
            const payload: RuntimeHookPayload = {
              source_client:
                pickString(payloadRecord, ["source_client", "sourceClient"]) ??
                "unknown",
              event: pickString(payloadRecord, ["event", "hook_event"]) ?? "heartbeat",
              run_id: pickString(payloadRecord, ["run_id", "runId", "session_id", "sessionId"]),
              correlation_id: pickString(payloadRecord, ["correlation_id", "correlationId"]),
              initiative_id: pickString(payloadRecord, ["initiative_id", "initiativeId"]),
              workstream_id: pickString(payloadRecord, ["workstream_id", "workstreamId"]),
              task_id: pickString(payloadRecord, ["task_id", "taskId"]),
              agent_id: pickString(payloadRecord, ["agent_id", "agentId"]),
              agent_name: pickString(payloadRecord, ["agent_name", "agentName"]),
              phase: pickString(payloadRecord, ["phase"]),
              progress_pct:
                pickNumber(payloadRecord, ["progress_pct", "progressPct"]) ??
                null,
              message: pickString(payloadRecord, ["message", "summary"]),
              metadata:
                payloadRecord.metadata && typeof payloadRecord.metadata === "object"
                  ? (payloadRecord.metadata as Record<string, unknown>)
                  : null,
              timestamp: pickString(payloadRecord, ["timestamp", "time", "ts"]),
            };

            const instance = upsertRuntimeInstanceFromHook(payload);
            broadcastRuntimeSse("runtime.updated", instance);


            const fallbackPhaseByEvent: Record<string, string> = {
              session_start: "intent",
              heartbeat: "execution",
              progress: "execution",
              task_update: "execution",
              session_stop: "completed",
              error: "blocked",
            };
            const phase = normalizeHookPhase(
              payload.phase ??
                fallbackPhaseByEvent[instance.event] ??
                "execution"
            );
            const level: "info" | "warn" | "error" =
              instance.event === "error" ? "error" : phase === "blocked" ? "warn" : "info";
            const message =
              payload.message ??
              `${instance.displayName} ${instance.event.replace(/_/g, " ")}`;

            let forwarded = false;
            let forwardError: string | null = null;
            if (instance.initiativeId) {
              try {
                await client.emitActivity({
                  initiative_id: instance.initiativeId,
                  run_id: instance.runId ?? undefined,
                  correlation_id: instance.runId
                    ? undefined
                    : (instance.correlationId ?? undefined),
                  source_client: normalizeRuntimeSourceForReporting(
                    instance.sourceClient
                  ),
                  message,
                  phase,
                  progress_pct: instance.progressPct ?? undefined,
                  level,
                  metadata: {
                    source: "runtime_hook_relay",
                    hook_event: instance.event,
                    instance_id: instance.id,
                    runtime_client: instance.sourceClient,
                    task_id: instance.taskId,
                    workstream_id: instance.workstreamId,
                    ...(instance.metadata ?? {}),
                  },
                });
                forwarded = true;
              } catch (err: unknown) {
                forwardError = safeErrorMessage(err);
              }
            }

            sendJson(res, 200, {
              ok: true,
              instance_id: instance.id,
              state: instance.state,
              last_seen_at: instance.lastHeartbeatAt ?? instance.lastEventAt,
              run_id: instance.runId ?? null,
              forwarded,
              forward_error: forwardError,
            });
          } catch (err: unknown) {
            sendJson(res, 500, {
              ok: false,
              error: safeErrorMessage(err),
            });
          }
          return true;
        }

        case "mission-control/auto-continue/status": {
          const initiativeId =
            searchParams.get("initiative_id") ??
            searchParams.get("initiativeId") ??
            "";
          const id = initiativeId.trim();
          if (!id) {
            sendJson(res, 400, {
              ok: false,
              error: "Query parameter 'initiative_id' is required.",
            });
            return true;
          }

          const run = autoContinueRuns.get(id) ?? null;
          sendJson(res, 200, {
            ok: true,
            initiativeId: id,
            run,
            defaults: {
              tokenBudget: defaultAutoContinueTokenBudget(),
              tickMs: AUTO_CONTINUE_TICK_MS,
            },
          });
          return true;
        }

        case "billing/status": {
          if (method !== "GET") {
            sendJson(res, 405, { ok: false, error: "Method not allowed" });
            return true;
          }

          try {
            const status = await client.getBillingStatus();
            sendJson(res, 200, { ok: true, data: status });
          } catch (err: unknown) {
            sendJson(res, 200, { ok: false, error: safeErrorMessage(err) });
          }
          return true;
        }

        case "billing/checkout": {
          if (method !== "POST") {
            sendJson(res, 405, { ok: false, error: "Method not allowed" });
            return true;
          }

          const basePricingUrl = `${client.getBaseUrl().replace(/\/+$/, "")}/pricing`;
          try {
            const payload = await parseJsonRequest(req);
            const planIdRaw =
              (pickString(payload, ["planId", "plan_id", "plan"]) ?? "starter").trim().toLowerCase();
            const billingCycleRaw =
              (pickString(payload, ["billingCycle", "billing_cycle"]) ?? "monthly").trim().toLowerCase();

            const planId =
              planIdRaw === "team" || planIdRaw === "enterprise" ? planIdRaw : "starter";
            const billingCycle = billingCycleRaw === "annual" ? "annual" : "monthly";

            const result = await client.createBillingCheckout({
              planId,
              billingCycle,
            } satisfies BillingCheckoutRequest);

            const url = result?.url ?? result?.checkout_url ?? null;
            sendJson(res, 200, { ok: true, data: { url: url ?? basePricingUrl } });
          } catch (err: unknown) {
            // If the remote billing endpoints are not deployed yet, degrade gracefully.
            sendJson(res, 200, { ok: true, data: { url: basePricingUrl } });
          }
          return true;
        }

        case "billing/portal": {
          if (method !== "POST") {
            sendJson(res, 405, { ok: false, error: "Method not allowed" });
            return true;
          }

          const basePricingUrl = `${client.getBaseUrl().replace(/\/+$/, "")}/pricing`;
          try {
            const result = await client.createBillingPortal();
            const url = result?.url ?? null;
            sendJson(res, 200, { ok: true, data: { url: url ?? basePricingUrl } });
          } catch (err: unknown) {
            sendJson(res, 200, { ok: true, data: { url: basePricingUrl } });
          }
          return true;
        }

        case "settings/byok": {
          const stored = readByokKeys();
          const effectiveOpenai = stored?.openaiApiKey ?? process.env.OPENAI_API_KEY ?? null;
          const effectiveAnthropic =
            stored?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? null;
          const effectiveOpenrouter =
            stored?.openrouterApiKey ?? process.env.OPENROUTER_API_KEY ?? null;

          const toProvider = (input: {
            storedValue: string | null | undefined;
            envValue: string | undefined;
            effective: string | null;
          }) => {
            const hasStored = typeof input.storedValue === "string" && input.storedValue.trim().length > 0;
            const hasEnv = typeof input.envValue === "string" && input.envValue.trim().length > 0;
            const source = hasStored ? "stored" : hasEnv ? "env" : "none";
            return {
              configured: Boolean(input.effective && input.effective.trim().length > 0),
              source,
              masked: maskSecret(input.effective),
            };
          };

          if (method === "POST") {
            try {
              const payload = await parseJsonRequest(req);
              const updates: Record<string, unknown> = {};

              const setIfPresent = (key: string, aliases: string[]) => {
                for (const alias of aliases) {
                  if (!Object.prototype.hasOwnProperty.call(payload, alias)) continue;
                  const raw = (payload as Record<string, unknown>)[alias];
                  if (raw === null) {
                    updates[key] = null;
                    return;
                  }
                  if (typeof raw === "string") {
                    updates[key] = raw;
                    return;
                  }
                }
              };

              setIfPresent("openaiApiKey", ["openaiApiKey", "openai_api_key", "openaiKey", "openai_key"]);
              setIfPresent("anthropicApiKey", [
                "anthropicApiKey",
                "anthropic_api_key",
                "anthropicKey",
                "anthropic_key",
              ]);
              setIfPresent("openrouterApiKey", [
                "openrouterApiKey",
                "openrouter_api_key",
                "openrouterKey",
                "openrouter_key",
              ]);

              const saved = writeByokKeys(updates as any);
              const nextEffectiveOpenai = saved.openaiApiKey ?? process.env.OPENAI_API_KEY ?? null;
              const nextEffectiveAnthropic =
                saved.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? null;
              const nextEffectiveOpenrouter =
                saved.openrouterApiKey ?? process.env.OPENROUTER_API_KEY ?? null;

              sendJson(res, 200, {
                ok: true,
                updatedAt: saved.updatedAt,
                providers: {
                  openai: toProvider({
                    storedValue: saved.openaiApiKey,
                    envValue: process.env.OPENAI_API_KEY,
                    effective: nextEffectiveOpenai,
                  }),
                  anthropic: toProvider({
                    storedValue: saved.anthropicApiKey,
                    envValue: process.env.ANTHROPIC_API_KEY,
                    effective: nextEffectiveAnthropic,
                  }),
                  openrouter: toProvider({
                    storedValue: saved.openrouterApiKey,
                    envValue: process.env.OPENROUTER_API_KEY,
                    effective: nextEffectiveOpenrouter,
                  }),
                },
              });
            } catch (err: unknown) {
              sendJson(res, 500, { ok: false, error: safeErrorMessage(err) });
            }
            return true;
          }

          sendJson(res, 200, {
            ok: true,
            updatedAt: stored?.updatedAt ?? null,
            providers: {
              openai: toProvider({
                storedValue: stored?.openaiApiKey,
                envValue: process.env.OPENAI_API_KEY,
                effective: effectiveOpenai,
              }),
              anthropic: toProvider({
                storedValue: stored?.anthropicApiKey,
                envValue: process.env.ANTHROPIC_API_KEY,
                effective: effectiveAnthropic,
              }),
              openrouter: toProvider({
                storedValue: stored?.openrouterApiKey,
                envValue: process.env.OPENROUTER_API_KEY,
                effective: effectiveOpenrouter,
              }),
            },
          });
          return true;
        }

        case "settings/byok/health": {
          let agentId =
            searchParams.get("agentId") ??
            searchParams.get("agent_id") ??
            "";
          agentId = agentId.trim();

          if (!agentId) {
            try {
              const agents = await listAgents();
              const defaultAgent =
                agents.find((entry) => Boolean(entry.isDefault)) ?? agents[0] ?? null;
              const candidate =
                defaultAgent && typeof defaultAgent.id === "string" ? defaultAgent.id.trim() : "";
              if (candidate) agentId = candidate;
            } catch {
              // ignore
            }
          }
          if (!agentId) agentId = "main";

          const providers: Record<string, unknown> = {};
          for (const provider of ["openai", "anthropic", "openrouter"] as const) {
            try {
              const models = await listOpenClawProviderModels({ agentId, provider });
              providers[provider] = {
                ok: true,
                modelCount: models.length,
                sample: models.slice(0, 4).map((model) => model.key),
              };
            } catch (err: unknown) {
              providers[provider] = {
                ok: false,
                error: safeErrorMessage(err),
              };
            }
          }

          sendJson(res, 200, {
            ok: true,
            agentId,
            providers,
          });
          return true;
        }

        case "mission-control/graph": {
          const initiativeId =
            searchParams.get("initiative_id") ??
            searchParams.get("initiativeId");
          if (!initiativeId || initiativeId.trim().length === 0) {
            sendJson(res, 400, {
              error: "Query parameter 'initiative_id' is required.",
            });
            return true;
          }

          try {
            const graph = applyLocalInitiativeOverrideToGraph(
              await buildMissionControlGraph(client, initiativeId.trim())
            );
            sendJson(res, 200, graph);
          } catch (err: unknown) {
            sendJson(res, 500, {
              error: safeErrorMessage(err),
            });
          }
          return true;
        }

        case "mission-control/next-up": {
          const initiativeIdRaw =
            searchParams.get("initiative_id") ??
            searchParams.get("initiativeId") ??
            "";
          const initiativeId = initiativeIdRaw.trim() || null;

          try {
            const queue = await buildNextUpQueue({ initiativeId });
            sendJson(res, 200, {
              ok: true,
              generatedAt: new Date().toISOString(),
              total: queue.items.length,
              items: queue.items,
              degraded: queue.degraded,
            });
          } catch (err: unknown) {
            sendJson(res, 500, {
              ok: false,
              error: safeErrorMessage(err),
            });
          }
          return true;
        }

        case "entities": {
          if (method === "POST") {
            try {
              const payload = await parseJsonRequest(req);
              const type = pickString(payload, ["type"]);
              const title = pickString(payload, ["title", "name"]);

              if (!type || !title) {
                sendJson(res, 400, {
                  error: "Both 'type' and 'title' are required.",
                });
                return true;
              }

              const data = normalizeEntityMutationPayload({ ...payload, title });
              delete (data as Record<string, unknown>).type;

              let entity = await client.createEntity(type, data);
              let autoAssignment:
                | {
                    ok: boolean;
                    assignment_source: "orchestrator" | "fallback" | "manual";
                    assigned_agents: MissionControlAssignedAgent[];
                    warnings: string[];
                    updated_entity?: Entity;
                  }
                | null = null;

              if (type === "initiative" || type === "workstream") {
                const entityRecord = entity as Record<string, unknown>;
                autoAssignment = await resolveAutoAssignments({
                  client,
                  entityId: String(entityRecord.id ?? ""),
                  entityType: type,
                  initiativeId:
                    type === "initiative"
                      ? String(entityRecord.id ?? "")
                      : pickString(data, ["initiative_id", "initiativeId"]),
                  title:
                    pickString(entityRecord, ["title", "name"]) ??
                    title ??
                    "Untitled",
                  summary:
                    pickString(entityRecord, [
                      "summary",
                      "description",
                      "context",
                    ]) ?? null,
                });
                if (autoAssignment.updated_entity) {
                  entity = autoAssignment.updated_entity;
                }
              }

              sendJson(res, 201, { ok: true, entity, auto_assignment: autoAssignment });
            } catch (err: unknown) {
              sendJson(res, 500, {
                error: safeErrorMessage(err),
              });
            }
            return true;
          }

          if (method === "PATCH") {
            let payload: Record<string, unknown> = {};
            let type: string | null = null;
            let id: string | null = null;
            let requestedStatus: string | null = null;
            try {
              payload = await parseJsonRequest(req);
              type = pickString(payload, ["type"]);
              id = pickString(payload, ["id"]);
              requestedStatus = pickString(payload, ["status"]);

              if (!type || !id) {
                sendJson(res, 400, {
                  error: "Both 'type' and 'id' are required for PATCH.",
                });
                return true;
              }

              const updates = { ...payload };
              delete (updates as Record<string, unknown>).type;
              delete (updates as Record<string, unknown>).id;

              const normalizedType = type.trim().toLowerCase();
              const normalizedUpdates = normalizeEntityMutationPayload(updates);
              const entity = await client.updateEntity(
                type,
                id,
                normalizedUpdates
              );
              if (normalizedType === "initiative") {
                clearLocalInitiativeStatusOverride(id);
              }
              sendJson(res, 200, { ok: true, entity });
            } catch (err: unknown) {
              if (
                type?.trim().toLowerCase() === "initiative" &&
                id &&
                requestedStatus &&
                isUnauthorizedOrgxError(err)
              ) {
                setLocalInitiativeStatusOverride(id, requestedStatus);
                sendJson(res, 200, {
                  ok: true,
                  localFallback: true,
                  warning: safeErrorMessage(err),
                  entity: {
                    id,
                    type,
                    status: requestedStatus,
                  },
                });
                return true;
              }
              sendJson(res, 500, {
                error: safeErrorMessage(err),
              });
            }
            return true;
          }

          const type = searchParams.get("type");
          if (!type) {
            sendJson(res, 400, {
              error: "Query parameter 'type' is required for GET /entities.",
            });
            return true;
          }

          const status = searchParams.get("status") ?? undefined;
          const initiativeId = searchParams.get("initiative_id") ?? undefined;
          const limit = searchParams.get("limit")
            ? Number(searchParams.get("limit"))
            : undefined;

          try {
            const data = await client.listEntities(type, {
              status,
              initiative_id: initiativeId,
              limit: Number.isFinite(limit) ? limit : undefined,
            });
            if (type.trim().toLowerCase() === "initiative") {
              const payload = data as Record<string, unknown>;
              const rows = Array.isArray(payload.data)
                ? payload.data.filter(
                    (row): row is Record<string, unknown> =>
                      Boolean(row && typeof row === "object")
                  )
                : [];
              sendJson(res, 200, {
                ...payload,
                data: applyLocalInitiativeOverrides(rows),
              });
              return true;
            }
            sendJson(res, 200, data);
          } catch (err: unknown) {
            if (
              type.trim().toLowerCase() === "initiative" &&
              isUnauthorizedOrgxError(err)
            ) {
              const snapshotInitiatives = formatInitiatives(getSnapshot())
                .map((item) => ({
                  id: item.id,
                  title: item.title,
                  name: item.title,
                  summary: null,
                  status: item.status,
                  progress_pct: item.progress ?? null,
                  created_at: null,
                  updated_at: null,
                }))
                .filter((item) =>
                  initiativeId ? item.id === initiativeId : true
                );
              sendJson(res, 200, {
                data: applyLocalInitiativeOverrides(snapshotInitiatives),
                localFallback: true,
                warning: safeErrorMessage(err),
              });
              return true;
            }
            sendJson(res, 500, {
              error: safeErrorMessage(err),
            });
          }
          return true;
        }

        case "dashboard-bundle":
        case "live/snapshot": {
          const sessionsLimit = parsePositiveInt(
            searchParams.get("sessionsLimit") ?? searchParams.get("sessions_limit"),
            320
          );
          const activityLimit = parsePositiveInt(
            searchParams.get("activityLimit") ?? searchParams.get("activity_limit"),
            600
          );
          const decisionsLimit = parsePositiveInt(
            searchParams.get("decisionsLimit") ?? searchParams.get("decisions_limit"),
            120
          );
          const initiative = searchParams.get("initiative");
          const run = searchParams.get("run");
          const since = searchParams.get("since");
          const decisionStatus = searchParams.get("status") ?? "pending";
          const includeIdleRaw = searchParams.get("include_idle");
          const includeIdle =
            includeIdleRaw === null ? undefined : includeIdleRaw !== "false";
          const degraded: string[] = [];
          const agentContexts = readAgentContexts().agents;
          const scopedAgentIds = getScopedAgentIds(agentContexts);

          let outboxStatus: Record<string, unknown> | null = null;
          try {
            if (diagnostics?.getHealth) {
              const health = await diagnostics.getHealth({ probeRemote: false });
              if (health && typeof health === "object") {
                const maybeOutbox = (health as Record<string, unknown>).outbox;
                if (maybeOutbox && typeof maybeOutbox === "object") {
                  outboxStatus = maybeOutbox as Record<string, unknown>;
                }
              }
            }
            if (!outboxStatus) {
              const outbox = await outboxAdapter.readSummary();
              outboxStatus = {
                pendingTotal: outbox.pendingTotal,
                pendingByQueue: outbox.pendingByQueue,
                oldestEventAt: outbox.oldestEventAt,
                newestEventAt: outbox.newestEventAt,
                replayStatus: "idle",
                lastReplayAttemptAt: null,
                lastReplaySuccessAt: null,
                lastReplayFailureAt: null,
                lastReplayError: null,
              };
            }
          } catch (err: unknown) {
            degraded.push(`outbox status unavailable (${safeErrorMessage(err)})`);
            outboxStatus = {
              pendingTotal: 0,
              pendingByQueue: {},
              oldestEventAt: null,
              newestEventAt: null,
              replayStatus: "idle",
              lastReplayAttemptAt: null,
              lastReplaySuccessAt: null,
              lastReplayFailureAt: null,
              lastReplayError: null,
            };
          }

          let localSnapshot:
            | Awaited<ReturnType<typeof loadLocalOpenClawSnapshot>>
            | null = null;
          const ensureLocalSnapshot = async (minimumLimit: number) => {
            if (!localSnapshot || localSnapshot.sessions.length < minimumLimit) {
              localSnapshot = await loadLocalOpenClawSnapshot(minimumLimit);
            }
            return localSnapshot;
          };

          const settled = await Promise.allSettled([
            client.getLiveSessions({
              initiative,
              limit: sessionsLimit,
            }),
            client.getLiveActivity({
              run,
              since,
              limit: activityLimit,
            }),
            client.getHandoffs(),
            client.getLiveDecisions({
              status: decisionStatus,
              limit: decisionsLimit,
            }),
            client.getLiveAgents({
              initiative,
              includeIdle,
            }),
          ]);

          // sessions
          let sessions: SessionTreeResponse = {
            nodes: [],
            edges: [],
            groups: [],
          };
          const sessionsResult = settled[0];
          if (sessionsResult.status === "fulfilled") {
            sessions = sessionsResult.value;
          } else {
            degraded.push(`sessions unavailable (${safeErrorMessage(sessionsResult.reason)})`);
            try {
              let local = toLocalSessionTree(
                await ensureLocalSnapshot(Math.max(sessionsLimit, 200)),
                sessionsLimit
              );

              local = applyAgentContextsToSessionTree(local, agentContexts);

              if (initiative && initiative.trim().length > 0) {
                const filteredNodes = local.nodes.filter(
                  (node) => node.initiativeId === initiative || node.groupId === initiative
                );
                const filteredIds = new Set(filteredNodes.map((node) => node.id));
                const filteredGroupIds = new Set(filteredNodes.map((node) => node.groupId));

                local = {
                  nodes: filteredNodes,
                  edges: local.edges.filter(
                    (edge) => filteredIds.has(edge.parentId) && filteredIds.has(edge.childId)
                  ),
                  groups: local.groups.filter((group) => filteredGroupIds.has(group.id)),
                };
              }

              sessions = local;
            } catch (localErr: unknown) {
              degraded.push(`sessions local fallback failed (${safeErrorMessage(localErr)})`);
            }
          }

          // activity
          let activity: LiveActivityItem[] = [];
          const activityResult = settled[1];
          if (activityResult.status === "fulfilled") {
            activity = Array.isArray(activityResult.value.activities)
              ? activityResult.value.activities
              : [];
          } else {
            degraded.push(`activity unavailable (${safeErrorMessage(activityResult.reason)})`);
            try {
              const local = await toLocalLiveActivity(
                await ensureLocalSnapshot(Math.max(activityLimit, 240)),
                Math.max(activityLimit, 240)
              );
              let filtered = local.activities;

              if (run && run.trim().length > 0) {
                filtered = filtered.filter((item) => item.runId === run);
              }

              if (since && since.trim().length > 0) {
                const sinceEpoch = Date.parse(since);
                if (Number.isFinite(sinceEpoch)) {
                  filtered = filtered.filter(
                    (item) => Date.parse(item.timestamp) >= sinceEpoch
                  );
                }
              }

              filtered = applyAgentContextsToActivity(filtered, agentContexts);
              activity = filtered.slice(0, activityLimit);
            } catch (localErr: unknown) {
              degraded.push(`activity local fallback failed (${safeErrorMessage(localErr)})`);
            }
          }

          // handoffs
          let handoffs: HandoffSummary[] = [];
          const handoffsResult = settled[2];
          if (handoffsResult.status === "fulfilled") {
            handoffs = Array.isArray(handoffsResult.value.handoffs)
              ? handoffsResult.value.handoffs
              : [];
          } else {
            degraded.push(`handoffs unavailable (${safeErrorMessage(handoffsResult.reason)})`);
          }

          // decisions
          let decisions: Array<Record<string, unknown>> = [];
          const decisionsResult = settled[3];
          if (decisionsResult.status === "fulfilled") {
            decisions = decisionsResult.value.decisions
              .map(mapDecisionEntity)
              .sort((a, b) => b.waitingMinutes - a.waitingMinutes) as Array<
              Record<string, unknown>
            >;
          } else {
            degraded.push(`decisions unavailable (${safeErrorMessage(decisionsResult.reason)})`);
          }

          // agents
          let agents: Array<Record<string, unknown>> = [];
          const agentsResult = settled[4];
          if (agentsResult.status === "fulfilled") {
            agents = Array.isArray(agentsResult.value.agents)
              ? (agentsResult.value.agents as Array<Record<string, unknown>>)
              : [];
          } else {
            degraded.push(`agents unavailable (${safeErrorMessage(agentsResult.reason)})`);
            try {
              const local = toLocalLiveAgents(
                await ensureLocalSnapshot(Math.max(sessionsLimit, 240))
              );
              let localAgents = local.agents;
              if (initiative && initiative.trim().length > 0) {
                localAgents = localAgents.filter(
                  (agent) => agent.initiativeId === initiative
                );
              }
              if (includeIdle === false) {
                localAgents = localAgents.filter((agent) => agent.status !== "idle");
              }
              agents = localAgents as Array<Record<string, unknown>>;
            } catch (localErr: unknown) {
              degraded.push(`agents local fallback failed (${safeErrorMessage(localErr)})`);
            }
          }

          // Merge locally-launched OpenClaw agent sessions/activity into the snapshot so
          // the UI reflects one-click launches even when the cloud reporting plane is reachable.
          if (scopedAgentIds.size > 0) {
            try {
              const minimum = Math.max(Math.max(sessionsLimit, activityLimit), 240);
              const snapshot = await ensureLocalSnapshot(minimum);
              const scopedSnapshot = {
                ...snapshot,
                sessions: snapshot.sessions.filter(
                  (session) => Boolean(session.agentId && scopedAgentIds.has(session.agentId))
                ),
                agents: snapshot.agents.filter((agent) => scopedAgentIds.has(agent.id)),
              };

              // Sessions
              let localSessions = applyAgentContextsToSessionTree(
                toLocalSessionTree(scopedSnapshot, sessionsLimit),
                agentContexts
              );
              if (initiative && initiative.trim().length > 0) {
                const filteredNodes = localSessions.nodes.filter(
                  (node) => node.initiativeId === initiative || node.groupId === initiative
                );
                const filteredIds = new Set(filteredNodes.map((node) => node.id));
                const filteredGroupIds = new Set(filteredNodes.map((node) => node.groupId));

                localSessions = {
                  nodes: filteredNodes,
                  edges: localSessions.edges.filter(
                    (edge) => filteredIds.has(edge.parentId) && filteredIds.has(edge.childId)
                  ),
                  groups: localSessions.groups.filter((group) => filteredGroupIds.has(group.id)),
                };
              }
              sessions = mergeSessionTrees(sessions, localSessions);

              // Activity
              const localActivity = await toLocalLiveActivity(
                scopedSnapshot,
                Math.max(activityLimit, 240)
              );
              let localItems = applyAgentContextsToActivity(
                localActivity.activities,
                agentContexts
              );
              if (run && run.trim().length > 0) {
                localItems = localItems.filter((item) => item.runId === run);
              }
              if (since && since.trim().length > 0) {
                const sinceEpoch = Date.parse(since);
                if (Number.isFinite(sinceEpoch)) {
                  localItems = localItems.filter(
                    (item) => Date.parse(item.timestamp) >= sinceEpoch
                  );
                }
              }
              activity = mergeActivities(activity, localItems, activityLimit);
            } catch (err: unknown) {
              degraded.push(`local agent merge failed (${safeErrorMessage(err)})`);
            }
          }

          // include locally buffered events so offline-generated actions are visible
          try {
            const buffered = await outboxAdapter.readAllItems();
            if (buffered.length > 0) {
              const merged = [...activity, ...buffered]
                .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
                .slice(0, activityLimit);
              const deduped: LiveActivityItem[] = [];
              const seen = new Set<string>();
              for (const item of merged) {
                if (seen.has(item.id)) continue;
                seen.add(item.id);
                deduped.push(item);
              }
              activity = deduped;
            }
          } catch (err: unknown) {
            degraded.push(`outbox unavailable (${safeErrorMessage(err)})`);
          }

          let runtimeInstances = listRuntimeInstances({ limit: 320 });
          if (initiative && initiative.trim().length > 0) {
            runtimeInstances = runtimeInstances.filter(
              (instance) => instance.initiativeId === initiative
            );
          }
          if (run && run.trim().length > 0) {
            runtimeInstances = runtimeInstances.filter(
              (instance) => instance.runId === run || instance.correlationId === run
            );
          }
          sessions = enrichSessionsWithRuntime(sessions, runtimeInstances);
          activity = enrichActivityWithRuntime(activity, runtimeInstances);

          sendJson(res, 200, {
            sessions,
            activity,
            handoffs,
            decisions,
            agents,
            runtimeInstances,
            outbox: outboxStatus,
            generatedAt: new Date().toISOString(),
            degraded: degraded.length > 0 ? degraded : undefined,
          });
          return true;
        }

        // Legacy endpoints retained for backwards compatibility.
        case "live/sessions": {
          try {
            const initiative = searchParams.get("initiative");
            const limit = searchParams.get("limit")
              ? Number(searchParams.get("limit"))
              : undefined;
            const data = await client.getLiveSessions({
              initiative,
              limit: Number.isFinite(limit) ? limit : undefined,
            });
            sendJson(res, 200, data);
          } catch (err: unknown) {
            try {
              const initiative = searchParams.get("initiative");
              const limitRaw = searchParams.get("limit")
                ? Number(searchParams.get("limit"))
                : undefined;
              const limit = Number.isFinite(limitRaw) ? Math.max(1, Number(limitRaw)) : 100;

              let local = toLocalSessionTree(
                await loadLocalOpenClawSnapshot(Math.max(limit, 200)),
                limit
              );

              local = applyAgentContextsToSessionTree(local, readAgentContexts().agents);

              if (initiative && initiative.trim().length > 0) {
                const filteredNodes = local.nodes.filter(
                  (node) => node.initiativeId === initiative || node.groupId === initiative
                );
                const filteredIds = new Set(filteredNodes.map((node) => node.id));
                const filteredGroupIds = new Set(filteredNodes.map((node) => node.groupId));

                local = {
                  nodes: filteredNodes,
                  edges: local.edges.filter(
                    (edge) => filteredIds.has(edge.parentId) && filteredIds.has(edge.childId)
                  ),
                  groups: local.groups.filter((group) => filteredGroupIds.has(group.id)),
                };
              }

              sendJson(res, 200, local);
            } catch (localErr: unknown) {
              sendJson(res, 500, {
                error: safeErrorMessage(err),
                localFallbackError: safeErrorMessage(localErr),
              });
            }
          }
          return true;
        }

        case "live/activity": {
          try {
            const run = searchParams.get("run");
            const limit = searchParams.get("limit")
              ? Number(searchParams.get("limit"))
              : undefined;
            const since = searchParams.get("since");
            const data = await client.getLiveActivity({
              run,
              since,
              limit: Number.isFinite(limit) ? limit : undefined,
            });
            sendJson(res, 200, data);
          } catch (err: unknown) {
            try {
              const run = searchParams.get("run");
              const limitRaw = searchParams.get("limit")
                ? Number(searchParams.get("limit"))
                : undefined;
              const since = searchParams.get("since");
              const limit = Number.isFinite(limitRaw) ? Math.max(1, Number(limitRaw)) : 240;

              const localSnapshot = await loadLocalOpenClawSnapshot(Math.max(limit, 240));
              let local = await toLocalLiveActivity(localSnapshot, Math.max(limit, 240));

              if (run && run.trim().length > 0) {
                local = {
                  activities: local.activities.filter((item) => item.runId === run),
                  total: local.activities.filter((item) => item.runId === run).length,
                };
              }

              if (since && since.trim().length > 0) {
                const sinceEpoch = Date.parse(since);
                if (Number.isFinite(sinceEpoch)) {
                  const filtered = local.activities.filter(
                    (item) => Date.parse(item.timestamp) >= sinceEpoch
                  );
                  local = {
                    activities: filtered,
                    total: filtered.length,
                  };
                }
              }

              const activitiesWithContexts = applyAgentContextsToActivity(
                local.activities,
                readAgentContexts().agents
              );
              sendJson(res, 200, {
                activities: activitiesWithContexts.slice(0, limit),
                total: local.total,
              });
            } catch (localErr: unknown) {
              sendJson(res, 500, {
                error: safeErrorMessage(err),
                localFallbackError: safeErrorMessage(localErr),
              });
            }
          }
          return true;
        }

        case "live/activity/detail": {
          const turnId =
            searchParams.get("turnId") ?? searchParams.get("turn_id");
          const sessionKey =
            searchParams.get("sessionKey") ?? searchParams.get("session_key");
          const run = searchParams.get("run");

          if (!turnId || turnId.trim().length === 0) {
            sendJson(res, 400, { error: "turnId is required" });
            return true;
          }

          try {
            const detail = await loadLocalTurnDetail({
              turnId,
              sessionKey,
              runId: run,
            });
            if (!detail) {
              sendJson(res, 404, {
                error: "Turn detail unavailable",
                turnId,
              });
              return true;
            }
            sendJson(res, 200, { detail });
          } catch (err: unknown) {
            sendJson(res, 500, { error: safeErrorMessage(err), turnId });
          }
          return true;
        }

        case "live/activity/headline": {
          if (method !== "POST") {
            sendJson(res, 405, { error: "Use POST /orgx/api/live/activity/headline" });
            return true;
          }

          try {
            const payload = await parseJsonRequest(req);
            const text = pickString(payload, ["text", "summary", "detail", "content"]);
            if (!text) {
              sendJson(res, 400, { error: "text is required" });
              return true;
            }

            const title = pickString(payload, ["title", "name"]);
            const type = pickString(payload, ["type", "kind"]);
            const result = await summarizeActivityHeadline(
              {
                text,
                title,
                type,
              }
            );

            sendJson(res, 200, {
              headline: result.headline,
              source: result.source,
              model: result.model,
            });
          } catch (err: unknown) {
            sendJson(res, 500, {
              error: safeErrorMessage(err),
            });
          }
          return true;
        }

        case "live/agents": {
          try {
            const initiative = searchParams.get("initiative");
            const includeIdleRaw = searchParams.get("include_idle");
            const includeIdle =
              includeIdleRaw === null ? undefined : includeIdleRaw !== "false";
            const data = await client.getLiveAgents({
              initiative,
              includeIdle,
            });
            sendJson(res, 200, data);
          } catch (err: unknown) {
            try {
              const initiative = searchParams.get("initiative");
              const includeIdleRaw = searchParams.get("include_idle");
              const includeIdle =
                includeIdleRaw === null ? undefined : includeIdleRaw !== "false";

              const localSnapshot = await loadLocalOpenClawSnapshot(240);
              const local = toLocalLiveAgents(localSnapshot);

              let agents = local.agents;
              if (initiative && initiative.trim().length > 0) {
                agents = agents.filter((agent) => agent.initiativeId === initiative);
              }
              if (includeIdle === false) {
                agents = agents.filter((agent) => agent.status !== "idle");
              }

              const summary = agents.reduce<Record<string, number>>((acc, agent) => {
                acc[agent.status] = (acc[agent.status] ?? 0) + 1;
                return acc;
              }, {});

              sendJson(res, 200, { agents, summary });
            } catch (localErr: unknown) {
              sendJson(res, 500, {
                error: safeErrorMessage(err),
                localFallbackError: safeErrorMessage(localErr),
              });
            }
          }
          return true;
        }

        case "live/initiatives": {
          try {
            const id = searchParams.get("id");
            const limit = searchParams.get("limit")
              ? Number(searchParams.get("limit"))
              : undefined;
            const data = await client.getLiveInitiatives({
              id,
              limit: Number.isFinite(limit) ? limit : undefined,
            });
            const payload = data as Record<string, unknown>;
            const initiatives = Array.isArray(payload.initiatives)
              ? payload.initiatives.map((entry) => {
                  if (!entry || typeof entry !== "object") return entry;
                  const row = entry as Record<string, unknown>;
                  const initiativeId = pickString(row, ["id"]);
                  if (!initiativeId) return entry;
                  const override =
                    localInitiativeStatusOverrides.get(initiativeId) ?? null;
                  if (!override) return entry;
                  return {
                    ...row,
                    status: override.status,
                    updatedAt:
                      pickString(row, ["updatedAt", "updated_at"]) ??
                      override.updatedAt,
                  };
                })
              : payload.initiatives;
            sendJson(res, 200, {
              ...payload,
              initiatives,
            });
          } catch (err: unknown) {
            try {
              const id = searchParams.get("id");
              const limitRaw = searchParams.get("limit")
                ? Number(searchParams.get("limit"))
                : undefined;
              const limit = Number.isFinite(limitRaw) ? Math.max(1, Number(limitRaw)) : 100;

              const local = toLocalLiveInitiatives(await loadLocalOpenClawSnapshot(240));
              let initiatives = local.initiatives;
              if (id && id.trim().length > 0) {
                initiatives = initiatives.filter((item) => item.id === id);
              }

              initiatives = initiatives.map((item) => {
                const override =
                  localInitiativeStatusOverrides.get(item.id) ?? null;
                if (!override) return item;
                return {
                  ...item,
                  status: override.status,
                  updatedAt: item.updatedAt ?? override.updatedAt,
                };
              });

              const requestedId = id?.trim() ?? "";
              if (requestedId.length > 0) {
                const override = localInitiativeStatusOverrides.get(requestedId) ?? null;
                if (override && !initiatives.some((item) => item.id === requestedId)) {
                  initiatives.push({
                    id: requestedId,
                    title: `Initiative ${requestedId.slice(0, 8)}`,
                    status: override.status,
                    updatedAt: override.updatedAt,
                    sessionCount: 0,
                    activeAgents: 0,
                  });
                }
              } else {
                for (const [initiativeId, override] of localInitiativeStatusOverrides.entries()) {
                  if (initiatives.some((item) => item.id === initiativeId)) continue;
                  initiatives.push({
                    id: initiativeId,
                    title: `Initiative ${initiativeId.slice(0, 8)}`,
                    status: override.status,
                    updatedAt: override.updatedAt,
                    sessionCount: 0,
                    activeAgents: 0,
                  });
                }
              }

              sendJson(res, 200, {
                initiatives: initiatives.slice(0, limit),
                total: initiatives.length,
                localFallback: true,
                warning: safeErrorMessage(err),
              });
            } catch (localErr: unknown) {
              sendJson(res, 500, {
                error: safeErrorMessage(err),
                localFallbackError: safeErrorMessage(localErr),
              });
            }
          }
          return true;
        }

        case "live/decisions": {
          try {
            const status = searchParams.get("status") ?? "pending";
            const limit = searchParams.get("limit")
              ? Number(searchParams.get("limit"))
              : 100;
            const data = await client.getLiveDecisions({
              status,
              limit: Number.isFinite(limit) ? limit : 100,
            });
            const decisions = data.decisions
              .map(mapDecisionEntity)
              .sort((a, b) => b.waitingMinutes - a.waitingMinutes);

            sendJson(res, 200, {
              decisions,
              total: data.total,
            });
          } catch {
            sendJson(res, 200, {
              decisions: [],
              total: 0,
            });
          }
          return true;
        }

        case "handoffs": {
          try {
            const data = await client.getHandoffs();
            sendJson(res, 200, data);
          } catch {
            sendJson(res, 200, { handoffs: [] });
          }
          return true;
        }

        case "live/stream": {
          const write = res.write?.bind(res);
          if (!write) {
            sendJson(res, 501, { error: "Streaming not supported" });
            return true;
          }
	          const target = `${config.baseUrl.replace(/\/+$/, "")}/api/client/live/stream${queryString ? `?${queryString}` : ""}`;
	          const streamAbortController = new AbortController();
	          let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	          let closed = false;
	          let streamOpened = false;
	          let idleTimer: ReturnType<typeof setTimeout> | null = null;
	          let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	          let heartbeatBackpressure = false;

	          const clearIdleTimer = () => {
	            if (idleTimer) {
	              clearTimeout(idleTimer);
	              idleTimer = null;
	            }
	          };

	          const clearHeartbeatTimer = () => {
	            if (heartbeatTimer) {
	              clearInterval(heartbeatTimer);
	              heartbeatTimer = null;
	            }
	          };

	          const closeStream = () => {
	            if (closed) return;
	            closed = true;
	            clearIdleTimer();
	            clearHeartbeatTimer();
	            streamAbortController.abort();
	            if (reader) {
	              void reader.cancel().catch(() => undefined);
	            }
            if (streamOpened && !res.writableEnded) {
              res.end();
            }
          };

          const resetIdleTimer = () => {
            clearIdleTimer();
            idleTimer = setTimeout(() => {
              closeStream();
            }, STREAM_IDLE_TIMEOUT_MS);
          };

          try {
            const includeUserHeader =
              Boolean(config.userId && config.userId.trim().length > 0) &&
              !isUserScopedApiKey(config.apiKey);
            const upstream = await fetch(target, {
              method: "GET",
              headers: {
                Authorization: `Bearer ${config.apiKey}`,
                Accept: "text/event-stream",
                ...(includeUserHeader
                  ? { "X-Orgx-User-Id": config.userId }
                  : {}),
              },
              signal: streamAbortController.signal,
            });

            const contentType =
              upstream.headers.get("content-type")?.toLowerCase() ?? "";
            if (!upstream.ok || !contentType.includes("text/event-stream")) {
              const bodyPreview = (await upstream.text().catch(() => ""))
                .replace(/\s+/g, " ")
                .slice(0, 300);
              sendJson(res, upstream.ok ? 502 : upstream.status, {
                error: "Live stream endpoint unavailable",
                status: upstream.status,
                contentType,
                preview: bodyPreview || null,
              });
              return true;
            }

	            res.writeHead(200, {
	              "Content-Type": "text/event-stream; charset=utf-8",
	              "Cache-Control": "no-cache, no-transform",
	              Connection: "keep-alive",
	              ...SECURITY_HEADERS,
	              ...CORS_HEADERS,
	            });
	            streamOpened = true;

	            // Heartbeat comments keep intermediary proxies from timing out idle SSE.
	            // They also prevent the dashboard from flickering into reconnect mode
	            // during long quiet periods.
	            heartbeatTimer = setInterval(() => {
	              if (closed || heartbeatBackpressure) return;
	              try {
	                // Keepalive comment line (single newline to avoid terminating an upstream event mid-chunk).
	                const accepted = write(Buffer.from(`: ping ${Date.now()}\n`, "utf8"));
	                resetIdleTimer();
	                if (accepted === false) {
	                  heartbeatBackpressure = true;
	                  if (typeof res.once === "function") {
	                    res.once("drain", () => {
	                      heartbeatBackpressure = false;
	                      if (!closed) resetIdleTimer();
	                    });
	                  }
	                }
	              } catch {
	                closeStream();
	              }
	            }, 20_000);
	            heartbeatTimer.unref?.();

	            if (!upstream.body) {
	              closeStream();
	              return true;
	            }

            req.on?.("close", closeStream);
            req.on?.("aborted", closeStream);
            res.on?.("close", closeStream);
            res.on?.("finish", closeStream);

            reader = upstream.body.getReader();
            const streamReader = reader;
            resetIdleTimer();

            const waitForDrain = async (): Promise<void> => {
              if (typeof res.once === "function") {
                await new Promise<void>((resolve) => {
                  res.once?.("drain", () => resolve());
                });
              }
            };

            const pump = async () => {
              try {
                while (!closed) {
                  const { done, value } = await streamReader.read();
                  if (done) break;
                  if (!value || value.byteLength === 0) continue;

                  resetIdleTimer();
                  const accepted = write(Buffer.from(value));
                  if (accepted === false) {
                    await waitForDrain();
                  }
                }
              } catch {
                // Swallow pump errors; client disconnects are expected.
              } finally {
                closeStream();
              }
            };

            void pump();
          } catch (err: unknown) {
            closeStream();
            if (!streamOpened && !res.writableEnded) {
              sendJson(res, 500, {
                error: safeErrorMessage(err),
              });
            }
          }
          return true;
        }

        case "delegation/preflight": {
          sendJson(res, 405, { error: "Use POST /orgx/api/delegation/preflight" });
          return true;
        }

        default: {
          if (runCheckpointsMatch) {
            try {
              const runId = decodeURIComponent(runCheckpointsMatch[1]);
              const data = await client.listRunCheckpoints(runId);
              sendJson(res, 200, data);
            } catch (err: unknown) {
              sendJson(res, 500, {
                error: safeErrorMessage(err),
              });
            }
            return true;
          }

          if (runActionMatch || runCheckpointRestoreMatch) {
            sendJson(res, 405, { error: "Use POST for this endpoint" });
            return true;
          }

          sendJson(res, 404, { error: "Unknown API endpoint" });
          return true;
        }
      }
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
          sendFile(
            res,
            assetPath,
            "public, max-age=31536000, immutable"
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
