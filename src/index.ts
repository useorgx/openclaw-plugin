/**
 * OrgX Clawdbot Plugin — Main Entry Point
 *
 * This is the canonical entry point for the OrgX plugin.
 * It exports the plugin interface for Clawdbot consumption.
 *
 * Registers:
 *   - Background sync service ("orgx-sync")
 *   - MCP Tools (orgx_status, orgx_sync, orgx_spawn_check, etc.)
 *   - CLI command ("orgx" with status/sync subcommands)
 *   - HTTP handler for dashboard + API proxy
 */

import { OrgXClient } from "./api.js";
import type {
  OnboardingState,
  OrgXConfig,
  OrgSnapshot,
  LiveActivityItem,
  ReportingSourceClient,
  ReportingPhase,
} from "./types.js";
import { createHttpHandler } from "./http-handler.js";
import { applyOrgxAgentSuitePlan, computeOrgxAgentSuitePlan } from "./agent-suite.js";
import {
  autoAssignEntityForCreate as autoAssignEntityForCreateWithClient,
} from "./entities/auto-assignment.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  clearPersistedApiKey,
  loadAuthStore,
  resolveInstallationId,
} from "./auth-store.js";
import {
  clearPersistedSnapshot,
  readPersistedSnapshot,
  writePersistedSnapshot,
} from "./snapshot-store.js";
import {
  appendToOutbox,
  readOutboxSummary,
} from "./outbox.js";
import { getAgentContext, readAgentContexts } from "./agent-context-store.js";
import { readAgentRuns, markAgentRunStopped } from "./agent-run-store.js";
import { ensureGatewayWatchdog, stopGatewayWatchdog } from "./gateway-watchdog.js";
import {
  createMcpHttpHandler,
  type RegisteredPrompt,
} from "./mcp-http-handler.js";
import { posthogCapture } from "./telemetry/posthog.js";
import {
  readSkillPackState,
  refreshSkillPackState,
  rollbackSkillPackPolicy,
  updateSkillPackPolicy,
} from "./skill-pack-state.js";
import {
  resolveConfig,
  resolveDocsUrl,
  resolveRuntimeUserId,
  type ResolvedConfig,
} from "./config/resolution.js";
import { refreshResolvedConfig } from "./config/refresh.js";
import {
  applyRuntimeApiKey,
  buildManualKeyConnectUrl as buildManualKeyConnectUrlForBase,
  fetchOrgxJson as fetchOrgxJsonRequest,
  isAuthRequiredError,
} from "./auth/flows.js";
import { registerOrgxCli } from "./cli/orgx.js";
import { instrumentPluginApi } from "./services/instrumentation.js";
import { registerSyncService } from "./services/background.js";
import { stopDetachedProcess } from "./http/helpers/openclaw-cli.js";
import { createOutboxReplayer } from "./sync/outbox-replay.js";
import {
  buildLocalAgentMirrorsFromSnapshot,
  buildLocalSyncAgentsFromRuns,
} from "./sync/local-agent-telemetry.js";
import { registerCoreTools } from "./tools/core-tools.js";
import { stableHash } from "./hash-utils.js";
import { RETRO_ARTIFACT_SCHEMA_VERSION } from "./contracts/retro-schema.js";
import { buildRetroWithLlm } from "./retro/domain-templates.js";
import { computeRetroQualityRubricScore } from "./retro/quality-rubric.js";

// Re-export types for consumers
export type { OrgXConfig, OrgSnapshot } from "./types.js";
export { OrgXClient } from "./api.js";

const ORGX_CANONICAL_BASE_URL = "https://www.useorgx.com";

// =============================================================================
// PLUGIN INTERFACE TYPES
// =============================================================================

export interface PluginAPI {
  config?: {
    plugins?: {
      entries?: {
        orgx?: {
          config?: Partial<OrgXConfig & { dashboardEnabled: boolean }>;
        };
        "openclaw-plugin"?: {
          config?: Partial<OrgXConfig & { dashboardEnabled: boolean }>;
        };
      };
    };
  };
  log?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
    debug?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  registerService: (service: {
    id: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTool: (
    tool: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: (callId: string, params?: any) => Promise<ToolResult>;
    },
    options?: { optional?: boolean }
  ) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerCli: (
    fn: (ctx: { program: any }) => void,
    options?: { commands?: string[] }
  ) => void;
  registerHttpRoute?: (route: {
    path: string;
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
    handler: unknown;
    replaceExisting?: boolean;
  }) => void;
  registerHttpHandler?: (handler: unknown) => void;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

// =============================================================================
// HELPERS
// =============================================================================

function text(s: string): ToolResult {
  return { content: [{ type: "text" as const, text: s }] };
}

function json(label: string, data: unknown): ToolResult {
  return text(`${label}\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``);
}

function formatSnapshot(snap: OrgSnapshot): string {
  const lines: string[] = ["# OrgX Status\n"];

  if (snap.initiatives?.length) {
    lines.push("## Initiatives");
    for (const init of snap.initiatives) {
      const pct = init.progress != null ? ` (${init.progress}%)` : "";
      lines.push(`- **${init.title}** — ${init.status}${pct}`);
    }
    lines.push("");
  }

  if (snap.agents?.length) {
    lines.push("## Agents");
    for (const a of snap.agents) {
      const task = a.currentTask ? ` → ${a.currentTask}` : "";
      lines.push(`- **${a.name}** [${a.domain}]: ${a.status}${task}`);
    }
    lines.push("");
  }

  if (snap.activeTasks?.length) {
    lines.push("## Active Tasks");
    for (const t of snap.activeTasks) {
      const tier = t.modelTier ? ` (${t.modelTier})` : "";
      lines.push(`- ${t.title} — ${t.status}${tier}`);
    }
    lines.push("");
  }

  if (snap.pendingDecisions?.length) {
    lines.push("## Pending Decisions");
    for (const d of snap.pendingDecisions) {
      lines.push(`- [${d.urgency.toUpperCase()}] ${d.title}`);
    }
    lines.push("");
  }

  if (snap.syncedAt) lines.push(`_Last synced: ${snap.syncedAt}_`);
  return lines.join("\n");
}

type DoctorCheckStatus = "pass" | "warn" | "fail";
type ReplayStatus = "idle" | "running" | "success" | "error";

interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  message: string;
}

interface HealthReport {
  ok: boolean;
  status: "ok" | "degraded" | "error";
  generatedAt: string;
  checks: DoctorCheck[];
  plugin: {
    version: string;
    installationId: string;
    enabled: boolean;
    dashboardEnabled: boolean;
    baseUrl: string;
  };
  auth: {
    hasApiKey: boolean;
    keySource: ResolvedConfig["apiKeySource"];
    userIdConfigured: boolean;
    onboardingStatus: OnboardingState["status"];
  };
  sync: {
    serviceRunning: boolean;
    inFlight: boolean;
    backgroundInFlight: boolean;
    lastSnapshotAt: string | null;
    lastBackgroundSyncAt: string | null;
    lastBackgroundSyncError: string | null;
  };
  outbox: {
    pendingTotal: number;
    pendingByQueue: Record<string, number>;
    oldestEventAt: string | null;
    newestEventAt: string | null;
    replayStatus: ReplayStatus;
    lastReplayAttemptAt: string | null;
    lastReplaySuccessAt: string | null;
    lastReplayFailureAt: string | null;
    lastReplayError: string | null;
  };
  remote: {
    enabled: boolean;
    reachable: boolean | null;
    latencyMs: number | null;
    error: string | null;
  };
}

function apiKeySourceLabel(source: ResolvedConfig["apiKeySource"]): string {
  switch (source) {
    case "config":
      return "Plugin Config";
    case "environment":
      return "Environment";
    case "persisted":
      return "Persisted Store";
    case "openclaw-config-file":
      return "OpenClaw Config";
    case "legacy-dev":
      return "Legacy Dev Env";
    default:
      return "Not configured";
  }
}

interface ReportingContextInput {
  initiative_id?: unknown;
  run_id?: unknown;
  correlation_id?: unknown;
  source_client?: unknown;
  // Backward compatibility: older adapters/outbox payloads used camelCase.
  initiativeId?: unknown;
  runId?: unknown;
  correlationId?: unknown;
  sourceClient?: unknown;
}

interface ResolvedReportingContext {
  initiativeId: string;
  runId?: string;
  correlationId?: string;
  sourceClient?: ReportingSourceClient;
}

function pickNonEmptyString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function isUuid(value: string | undefined): value is string {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value
  );
}

function inferReportingInitiativeId(input: Record<string, unknown>): string | undefined {
  const env = pickNonEmptyString(process.env.ORGX_INITIATIVE_ID);
  if (isUuid(env)) return env;

  const agentId = pickNonEmptyString(input.agent_id, input.agentId);
  if (agentId) {
    const ctx = getAgentContext(agentId);
    const ctxInit = ctx?.initiativeId ?? undefined;
    if (isUuid(ctxInit ?? undefined)) return ctxInit ?? undefined;
  }

  // Fall back to the most recently updated agent context with a UUID initiative id.
  try {
    const store = readAgentContexts();
    const candidates = Object.values(store.agents ?? {}).filter((ctx) =>
      isUuid(ctx?.initiativeId ?? undefined)
    );
    candidates.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const picked = candidates[0]?.initiativeId ?? undefined;
    return isUuid(picked) ? picked : undefined;
  } catch {
    return undefined;
  }
}

function toReportingPhase(phase: string, progressPct?: number): ReportingPhase {
  if (progressPct === 100) return "completed";
  switch (phase) {
    case "researching":
      return "intent";
    case "implementing":
    case "testing":
      return "execution";
    case "reviewing":
      return "review";
    case "blocked":
      return "blocked";
    default:
      return "execution";
  }
}

// =============================================================================
// PLUGIN STATE
// =============================================================================

let cachedSnapshot: OrgSnapshot | null = null;
let lastSnapshotAt = 0;

function updateCachedSnapshot(snapshot: OrgSnapshot): void {
  cachedSnapshot = snapshot;
  lastSnapshotAt = Date.now();
  try {
    writePersistedSnapshot(snapshot);
  } catch {
    // best effort
  }
}

function hydrateCachedSnapshot(): void {
  const persisted = readPersistedSnapshot();
  if (!persisted?.snapshot) return;
  cachedSnapshot = persisted.snapshot;
  const ts = Date.parse(persisted.updatedAt);
  lastSnapshotAt = Number.isFinite(ts) ? ts : 0;
}

// =============================================================================
// PLUGIN ENTRY — DEFAULT EXPORT
// =============================================================================

/**
 * Plugin registration function.
 * Called by Clawdbot when the plugin is loaded.
 *
 * @param api - The Clawdbot plugin API
 */
export default function register(api: PluginAPI): void {
  const persistedAuth = loadAuthStore();
  const installationId = resolveInstallationId();
  const config = resolveConfig(api, {
    installationId,
    persistedApiKey: persistedAuth?.apiKey ?? null,
    persistedUserId: persistedAuth?.userId ?? null,
  });

  if (!config.enabled) {
    api.log?.info?.("[orgx] Plugin disabled");
    return;
  }

  void posthogCapture({
    event: "openclaw_plugin_loaded",
    distinctId: config.installationId,
    properties: {
      plugin_version: config.pluginVersion,
      dashboard_enabled: config.dashboardEnabled,
      has_api_key: Boolean(config.apiKey),
      api_key_source: config.apiKeySource,
      base_url: config.baseUrl,
    },
  }).catch(() => {
    // best effort
  });

  if (!config.apiKey) {
    api.log?.warn?.(
      "[orgx] No API key. Set plugins.entries.openclaw-plugin.config.apiKey (or plugins.entries.orgx.config.apiKey for legacy setups), ORGX_API_KEY env, or ~/Code/orgx/orgx/.env.local"
    );
  }

  hydrateCachedSnapshot();

  const client = new OrgXClient(config.apiKey, config.baseUrl, config.userId);
  let onboardingState: OnboardingState = {
    status: config.apiKey ? "connected" : "idle",
    hasApiKey: Boolean(config.apiKey),
    connectionVerified: Boolean(config.apiKey),
    workspaceName: persistedAuth?.workspaceName ?? null,
    lastError: null,
    nextAction: config.apiKey ? "open_dashboard" : "connect",
    docsUrl: config.docsUrl,
    keySource: config.apiKeySource,
    installationId: config.installationId,
    connectUrl: null,
    pairingId: null,
    expiresAt: null,
    pollIntervalMs: null,
  };

  interface ActivePairing {
    pairingId: string;
    pollToken: string;
    connectUrl: string;
    expiresAt: string;
    pollIntervalMs: number;
  }

  let activePairing: ActivePairing | null = null;

  // NOTE: base URL can be updated at runtime (e.g. user edits OpenClaw config). Keep it mutable.
  let baseApiUrl = config.baseUrl.replace(/\/+$/, "");
  const defaultReportingCorrelationId =
    pickNonEmptyString(process.env.ORGX_CORRELATION_ID) ??
    `openclaw-${config.installationId}`;

  function refreshConfigFromSources(input?: {
    reason?: string;
    allowApiKeyChanges?: boolean;
  }): boolean {
    const refreshed = refreshResolvedConfig(
      {
        api,
        config,
        loadAuthStore,
        resolveConfig,
        updateOnboardingState,
        setCredentials: (credentials) => client.setCredentials(credentials),
        logInfo: api.log?.info,
      },
      input
    );
    baseApiUrl = refreshed.baseApiUrl;
    return refreshed.changed;
  }

  function resolveReportingContext(
    input: ReportingContextInput
  ): { ok: true; value: ResolvedReportingContext } | { ok: false; error: string } {
    let initiativeId = pickNonEmptyString(
      input.initiative_id,
      input.initiativeId,
      process.env.ORGX_INITIATIVE_ID
    );

    if (!isUuid(initiativeId)) {
      initiativeId = inferReportingInitiativeId(input as unknown as Record<string, unknown>);
    }

    if (!initiativeId || !isUuid(initiativeId)) {
      return {
        ok: false,
        error:
          "initiative_id is required (set ORGX_INITIATIVE_ID or pass initiative_id).",
      };
    }

    const sourceCandidate = pickNonEmptyString(
      input.source_client,
      input.sourceClient,
      process.env.ORGX_SOURCE_CLIENT,
      "openclaw"
    );
    const sourceClient: ReportingSourceClient =
      sourceCandidate === "codex" ||
      sourceCandidate === "claude-code" ||
      sourceCandidate === "api" ||
      sourceCandidate === "openclaw"
        ? sourceCandidate
        : "openclaw";

    const runIdCandidate = pickNonEmptyString(
      input.run_id,
      process.env.ORGX_RUN_ID
    );
    const runId = isUuid(runIdCandidate) ? runIdCandidate : undefined;

    const correlationId = runId
      ? undefined
      : pickNonEmptyString(
          input.correlation_id,
          input.correlationId,
          // Legacy: some buffered payloads only stored a local `runId` which is
          // better treated as a correlation key than a server-backed run_id.
          input.runId,
          defaultReportingCorrelationId,
          `openclaw-${Date.now()}`
        );

    return {
      ok: true,
      value: {
        initiativeId,
        runId,
        correlationId,
        sourceClient,
      },
    };
  }

  function updateOnboardingState(
    updates: Partial<OnboardingState>
  ): OnboardingState {
    onboardingState = {
      ...onboardingState,
      ...updates,
    };
    return onboardingState;
  }

  function toErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return typeof err === "string" ? err : "Unexpected error";
  }

  function isAuthFailure(err: unknown): boolean {
    const message = toErrorMessage(err).toLowerCase();
    return (
      message.includes("401") ||
      message.includes("unauthorized") ||
      message.includes("invalid_token") ||
      message.includes("invalid api key")
    );
  }

  instrumentPluginApi({
    api,
    installationId: config.installationId,
    pluginVersion: config.pluginVersion,
    toErrorMessage,
  });

  function clearPairingState() {
    activePairing = null;
    updateOnboardingState({
      connectUrl: null,
      pairingId: null,
      expiresAt: null,
      pollIntervalMs: null,
    });
  }

  function buildManualKeyConnectUrl(): string {
    return buildManualKeyConnectUrlForBase(baseApiUrl);
  }

  async function fetchOrgxJson<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
    return fetchOrgxJsonRequest<T>({
      baseApiUrl,
      method,
      path,
      body,
      options,
      toErrorMessage,
    });
  }

  function looksLikeTransientFetchFailure(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("fetch failed") ||
      normalized.includes("networkerror") ||
      normalized.includes("econnrefused") ||
      normalized.includes("enotfound") ||
      normalized.includes("eai_again")
    );
  }

  function applyRuntimeBaseUrl(nextBaseUrl: string): void {
    const normalized = nextBaseUrl.trim().replace(/\/+$/, "");
    if (!normalized) return;
    if (config.baseUrl === normalized && baseApiUrl === normalized) return;

    config.baseUrl = normalized;
    baseApiUrl = normalized;
    client.setCredentials({
      apiKey: config.apiKey,
      userId: config.userId,
      baseUrl: config.baseUrl,
    });
    updateOnboardingState({ docsUrl: resolveDocsUrl(config.baseUrl) });
  }

  function setRuntimeApiKey(input: {
    apiKey: string;
    source: "manual" | "browser_pairing";
    workspaceName?: string | null;
    keyPrefix?: string | null;
    userId?: string | null;
  }) {
    applyRuntimeApiKey({
      config,
      apiKey: input.apiKey,
      source: input.source,
      workspaceName: input.workspaceName,
      keyPrefix: input.keyPrefix,
      userId: input.userId,
      currentWorkspaceName: onboardingState.workspaceName,
      updateOnboardingState,
      setCredentials: (credentials) => client.setCredentials(credentials),
      logger: api.log ?? {},
    });
  }

  // ---------------------------------------------------------------------------
  // 1. Background Sync Service
  // ---------------------------------------------------------------------------

  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  let syncInFlight: Promise<void> | null = null;
  let backgroundSyncInFlight: Promise<void> | null = null;
  let backgroundSyncQueued = false;
  let syncServiceRunning = false;
  let lastBackgroundSyncAt = 0;
  let lastBackgroundSyncError: string | null = null;
  let localAgentMirrors: OrgSnapshot["agents"] = [];
  let outboxReplayState: {
    status: ReplayStatus;
    lastReplayAttemptAt: string | null;
    lastReplaySuccessAt: string | null;
    lastReplayFailureAt: string | null;
    lastReplayError: string | null;
  } = {
    status: "idle",
    lastReplayAttemptAt: null,
    lastReplaySuccessAt: null,
    lastReplayFailureAt: null,
    lastReplayError: null,
  };

  async function buildHealthReport(
    input: { probeRemote?: boolean } = {}
  ): Promise<HealthReport> {
    const generatedAt = new Date().toISOString();
    const probeRemote = input.probeRemote === true;
    const outbox = await readOutboxSummary();
    const checks: DoctorCheck[] = [];

    refreshConfigFromSources({ reason: "health_check" });
    const hasApiKey = Boolean(config.apiKey);

    if (hasApiKey) {
      checks.push({
        id: "api_key",
        status: "pass",
        message: `API key detected (${apiKeySourceLabel(config.apiKeySource)}).`,
      });
    } else {
      checks.push({
        id: "api_key",
        status: "fail",
        message: "API key missing. Connect OrgX in onboarding or set ORGX_API_KEY.",
      });
    }

    if (syncServiceRunning) {
      checks.push({
        id: "sync_service",
        status: "pass",
        message: "Background sync service is running.",
      });
    } else {
      checks.push({
        id: "sync_service",
        status: "warn",
        message: "Background sync service is not running.",
      });
    }

    if (outbox.pendingTotal > 0) {
      checks.push({
        id: "outbox",
        status: "warn",
        message: `Outbox has ${outbox.pendingTotal} queued event(s).`,
      });
    } else {
      checks.push({
        id: "outbox",
        status: "pass",
        message: "Outbox is empty.",
      });
    }

    let remoteReachable: boolean | null = null;
    let remoteLatencyMs: number | null = null;
    let remoteError: string | null = null;

    if (probeRemote) {
      if (!hasApiKey) {
        checks.push({
          id: "remote_probe",
          status: "warn",
          message: "Skipped remote probe because API key is missing.",
        });
      } else {
        const startedAt = Date.now();
        try {
          // Avoid probing with /api/client/sync: it's heavier than necessary and can
          // create false negatives during transient server slowness.
          await client.getBillingStatus();
          remoteReachable = true;
          remoteLatencyMs = Date.now() - startedAt;
          checks.push({
            id: "remote_probe",
            status: "pass",
            message: `OrgX API reachable (${remoteLatencyMs}ms).`,
          });
        } catch (err: unknown) {
          remoteReachable = false;
          remoteLatencyMs = Date.now() - startedAt;
          remoteError = toErrorMessage(err);
          checks.push({
            id: "remote_probe",
            status: "fail",
            message: `OrgX API probe failed: ${remoteError}`,
          });
        }
      }
    }

    if (onboardingState.status === "error") {
      checks.push({
        id: "onboarding_state",
        status: "warn",
        message: onboardingState.lastError
          ? `Onboarding reports an error: ${onboardingState.lastError}`
          : "Onboarding reports an error state.",
      });
    }

    const hasFail = checks.some((check) => check.status === "fail");
    const hasWarn = checks.some((check) => check.status === "warn");
    const status: HealthReport["status"] = hasFail
      ? "error"
      : hasWarn
        ? "degraded"
        : "ok";

    return {
      ok: status !== "error",
      status,
      generatedAt,
      checks,
      plugin: {
        version: config.pluginVersion,
        installationId: config.installationId,
        enabled: config.enabled,
        dashboardEnabled: config.dashboardEnabled,
        baseUrl: config.baseUrl,
      },
      auth: {
        hasApiKey,
        keySource: config.apiKeySource,
        userIdConfigured: Boolean(config.userId && config.userId.trim().length > 0),
        onboardingStatus: onboardingState.status,
      },
      sync: {
        serviceRunning: syncServiceRunning,
        inFlight: syncInFlight !== null,
        backgroundInFlight: backgroundSyncInFlight !== null,
        lastSnapshotAt: lastSnapshotAt > 0 ? new Date(lastSnapshotAt).toISOString() : null,
        lastBackgroundSyncAt:
          lastBackgroundSyncAt > 0 ? new Date(lastBackgroundSyncAt).toISOString() : null,
        lastBackgroundSyncError,
      },
      outbox: {
        pendingTotal: outbox.pendingTotal,
        pendingByQueue: outbox.pendingByQueue,
        oldestEventAt: outbox.oldestEventAt,
        newestEventAt: outbox.newestEventAt,
        replayStatus: outboxReplayState.status,
        lastReplayAttemptAt: outboxReplayState.lastReplayAttemptAt,
        lastReplaySuccessAt: outboxReplayState.lastReplaySuccessAt,
        lastReplayFailureAt: outboxReplayState.lastReplayFailureAt,
        lastReplayError: outboxReplayState.lastReplayError,
      },
      remote: {
        enabled: probeRemote,
        reachable: remoteReachable,
        latencyMs: remoteLatencyMs,
        error: remoteError,
      },
    };
  }

  function pickStringField(
    payload: Record<string, unknown>,
    key: string
  ): string | null {
    const value = payload[key];
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  }

  function pickStringArrayField(
    payload: Record<string, unknown>,
    key: string
  ): string[] | undefined {
    const value = payload[key];
    if (!Array.isArray(value)) return undefined;
    const strings = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return strings.length > 0 ? strings : undefined;
  }

  function isPidAlive(pid: number | null): boolean {
    if (!Number.isFinite(pid) || !pid || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function toFiniteNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
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

  function parseRetroEntityType(
    value: string | null
  ): "initiative" | "workstream" | "milestone" | "task" | undefined {
    if (!value) return undefined;
    switch (value) {
      case "initiative":
      case "workstream":
      case "milestone":
      case "task":
        return value;
      default:
        return undefined;
    }
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

  async function reconcileStoppedAgentRuns(): Promise<void> {
    try {
      const store = readAgentRuns();
      const runs = Object.values(store.runs ?? {});
      for (const run of runs) {
        if (!run || typeof run !== "object") continue;
        if (run.status !== "running") continue;
        if (!run.pid || isPidAlive(run.pid)) continue;

        const stopped = markAgentRunStopped(run.runId);
        if (!stopped) continue;

        const initiativeId = stopped.initiativeId?.trim() ?? "";
        if (!initiativeId) continue;

        const summary = readOpenClawSessionSummary({
          agentId: stopped.agentId,
          sessionId: stopped.runId,
        });

        const completedAt = stopped.stoppedAt ?? new Date().toISOString();
        const success = !summary.hadError;
        const correlationId = stopped.runId;
        const retroTemplate = await buildRetroWithLlm({
          agentId: stopped.agentId,
          success,
          taskId: stopped.taskId,
          runId: stopped.runId,
          errorMessage: summary.errorMessage,
        });
        const retroSummary = retroTemplate.summary;
        const retroQuality = computeRetroQualityRubricScore({
          success,
          hadError: summary.hadError,
          errorMessage: summary.errorMessage,
          tokens: summary.tokens,
          costUsd: summary.costUsd,
          decisionsCount: retroTemplate.decisions.length,
          followUpsCount: retroTemplate.followUps.length,
          whatWentWrongCount: retroTemplate.whatWentWrong.length,
        });

        const outcomePayload = {
          initiative_id: initiativeId,
          correlation_id: correlationId,
          source_client: "openclaw" as const,
          execution_id: `openclaw:${stopped.runId}`,
          execution_type: "openclaw.session",
          agent_id: stopped.agentId,
          task_type: stopped.taskId ?? undefined,
          started_at: stopped.startedAt,
          completed_at: completedAt,
          inputs: {
            message: stopped.message,
            workstream_id: stopped.workstreamId,
            task_id: stopped.taskId,
          },
          outputs: {
            had_error: summary.hadError,
            error_message: summary.errorMessage,
          },
          steps: [],
          success,
          quality_score: retroQuality.score,
          human_interventions: 0,
          errors: summary.errorMessage ? [summary.errorMessage] : [],
          metadata: {
            provider: stopped.provider,
            model: stopped.model,
            tokens: summary.tokens,
            cost_usd: summary.costUsd,
            source: "openclaw_agent_run_reconcile",
          },
        };

        const retroEntityType = stopped.taskId
          ? ("task" as const)
          : ("initiative" as const);
        const retroEntityId = stopped.taskId ?? initiativeId;

        const retroPayload = {
          initiative_id: initiativeId,
          correlation_id: correlationId,
          source_client: "openclaw" as const,
          entity_type: retroEntityType,
          entity_id: retroEntityId,
          title: stopped.taskId ?? stopped.runId,
          idempotency_key: `retro:${stopped.runId}`,
          retro: {
            schema_version: RETRO_ARTIFACT_SCHEMA_VERSION,
            summary: retroSummary,
            what_went_well: retroTemplate.whatWentWell,
            what_went_wrong: retroTemplate.whatWentWrong,
            decisions: retroTemplate.decisions,
            follow_ups: retroTemplate.followUps,
            signals: {
              tokens: summary.tokens,
              cost_usd: summary.costUsd,
              had_error: summary.hadError,
              error_message: summary.errorMessage,
              session_id: stopped.runId,
              task_id: stopped.taskId,
              workstream_id: stopped.workstreamId,
              domain: retroTemplate.domain,
              provider: stopped.provider,
              model: stopped.model,
              quality_score: retroQuality.score,
              quality_rubric_reasons: retroQuality.reasons,
              source: "openclaw_agent_run_reconcile",
            },
          },
        };

        try {
          await client.recordRunOutcome(outcomePayload);
        } catch (err: unknown) {
          const timestamp = new Date().toISOString();
          const activityItem: LiveActivityItem = {
            id: randomUUID(),
            type: "run_completed",
            title: `Buffered outcome for session ${stopped.runId}`,
            description: null,
            agentId: stopped.agentId,
            agentName: null,
            requesterAgentId: stopped.agentId ?? null,
            requesterAgentName: null,
            executorAgentId: stopped.agentId ?? null,
            executorAgentName: null,
            runId: stopped.runId,
            initiativeId,
            timestamp,
            phase: success ? "completed" : "blocked",
            summary: retroSummary,
            metadata: {
              source: "openclaw_local_fallback",
              error: toErrorMessage(err),
            },
          };
          await appendToOutbox(initiativeId, {
            id: randomUUID(),
            type: "outcome",
            timestamp,
            payload: outcomePayload,
            activityItem,
          });
        }

        try {
          await client.recordRunRetro(retroPayload);
        } catch (err: unknown) {
          const timestamp = new Date().toISOString();
          const activityItem: LiveActivityItem = {
            id: randomUUID(),
            type: "artifact_created",
            title: `Buffered retro for session ${stopped.runId}`,
            description: null,
            agentId: stopped.agentId,
            agentName: null,
            requesterAgentId: stopped.agentId ?? null,
            requesterAgentName: null,
            executorAgentId: stopped.agentId ?? null,
            executorAgentName: null,
            runId: stopped.runId,
            initiativeId,
            timestamp,
            phase: success ? "completed" : "blocked",
            summary: retroSummary,
            metadata: {
              source: "openclaw_local_fallback",
              error: toErrorMessage(err),
            },
          };
          await appendToOutbox(initiativeId, {
            id: randomUUID(),
            type: "retro",
            timestamp,
            payload: retroPayload,
            activityItem,
          });
        }
      }
    } catch {
      // best effort
    }
  }

  const { flushOutboxQueues } = createOutboxReplayer({
    client,
    logger: api.log ?? {},
    toErrorMessage,
    stableHash,
    resolveReportingContext,
    pickStringField,
    pickStringArrayField,
    toReportingPhase,
    parseRetroEntityType,
    isUuid,
    readOutboxReplayState: () => outboxReplayState,
    writeOutboxReplayState: (next) => {
      outboxReplayState = next;
    },
  });

  async function syncSnapshotAndLocalTelemetry(): Promise<{ snapshotError: string | null }> {
    let snapshotError: string | null = null;
    try {
      const snapshot = await client.getOrgSnapshot();
      updateCachedSnapshot(snapshot);
      localAgentMirrors = buildLocalAgentMirrorsFromSnapshot({
        agents: snapshot.agents,
      });
    } catch (err: unknown) {
      if (isAuthFailure(err)) {
        throw err;
      }
      snapshotError = toErrorMessage(err);
      api.log?.warn?.("[orgx] Snapshot sync failed (continuing)", {
        error: snapshotError,
      });
    }

    const localAgents = buildLocalSyncAgentsFromRuns({
      ...readAgentRuns(),
      mirrors: localAgentMirrors,
    });
    if (localAgents.length > 0) {
      try {
        await client.syncMemory({ agents: localAgents });
      } catch (err: unknown) {
        if (isAuthFailure(err)) {
          throw err;
        }
        api.log?.warn?.("[orgx] Local agent telemetry sync failed (continuing)", {
          error: toErrorMessage(err),
          count: localAgents.length,
        });
      }
    }

    return { snapshotError };
  }

  async function refreshSkillPackCache(): Promise<void> {
    try {
      const refreshed = await refreshSkillPackState({
        getSkillPack: (args) => client.getSkillPack(args),
      });
      if (refreshed.changed) {
        void posthogCapture({
          event: "openclaw_skill_pack_updated",
          distinctId: config.installationId,
          properties: {
            plugin_version: config.pluginVersion,
            skill_pack_name: refreshed.state.pack?.name ?? null,
            skill_pack_version: refreshed.state.pack?.version ?? null,
            skill_pack_checksum: refreshed.state.pack?.checksum ?? null,
          },
        }).catch(() => {
          // best effort
        });
      }
    } catch {
      // best effort
    }
  }

  function maybeAutoInstallAgentSuite(): void {
    try {
      if (config.autoInstallAgentSuiteOnConnect === false) {
        return;
      }
      const state = readSkillPackState();
      const updateAvailable = Boolean(
        state.remote?.checksum &&
          state.pack?.checksum &&
          state.remote.checksum !== state.pack.checksum
      );
      const plan = computeOrgxAgentSuitePlan({
        packVersion: config.pluginVersion || "0.0.0",
        skillPack: state.overrides,
        skillPackRemote: state.remote,
        skillPackPolicy: state.policy,
        skillPackUpdateAvailable: updateAvailable,
      });
      const hasConflicts = (plan.workspaceFiles ?? []).some((f) => f.action === "conflict");
      const hasWork =
        Boolean(plan.openclawConfigWouldUpdate) ||
        (plan.workspaceFiles ?? []).some((f) => f.action !== "noop");

      if (!hasWork || hasConflicts) {
        return;
      }

      const applied = applyOrgxAgentSuitePlan({
        plan,
        dryRun: false,
        skillPack: state.overrides,
      });
      void applied;
      void posthogCapture({
        event: "openclaw_agent_suite_auto_install",
        distinctId: config.installationId,
        properties: {
          plugin_version: (config.pluginVersion ?? "").trim() || null,
          skill_pack_source: plan.skillPack?.source ?? null,
          skill_pack_checksum: plan.skillPack?.checksum ?? null,
          skill_pack_version: plan.skillPack?.version ?? null,
          openclaw_config_updated: Boolean(plan.openclawConfigWouldUpdate),
        },
      }).catch(() => {
        // best effort
      });
    } catch (err: unknown) {
      api.log?.debug?.("[orgx] Agent suite auto-provision skipped/failed (best effort)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function runCriticalSyncPass(): Promise<void> {
    const { snapshotError } = await syncSnapshotAndLocalTelemetry();
    updateOnboardingState({
      status: "connected",
      hasApiKey: true,
      connectionVerified: snapshotError === null,
      lastError: snapshotError,
      nextAction: "open_dashboard",
    });
    await flushOutboxQueues();
  }

  async function runBackgroundSyncPass(): Promise<void> {
    await reconcileStoppedAgentRuns();
    await refreshSkillPackCache();
    maybeAutoInstallAgentSuite();
  }

  function scheduleBackgroundSyncPass(): void {
    if (!config.apiKey) return;
    if (backgroundSyncInFlight) {
      backgroundSyncQueued = true;
      return;
    }

    backgroundSyncInFlight = (async () => {
      do {
        backgroundSyncQueued = false;
        try {
          await runBackgroundSyncPass();
          lastBackgroundSyncAt = Date.now();
          lastBackgroundSyncError = null;
        } catch (err: unknown) {
          lastBackgroundSyncError = toErrorMessage(err);
          api.log?.warn?.("[orgx] Background sync tasks failed (continuing)", {
            error: lastBackgroundSyncError,
          });
        }
      } while (backgroundSyncQueued && Boolean(config.apiKey));
    })().finally(() => {
      backgroundSyncInFlight = null;
    });
  }

  async function doSync(): Promise<void> {
    if (syncInFlight) {
      return syncInFlight;
    }

    syncInFlight = (async () => {
      if (!config.apiKey) {
        refreshConfigFromSources({ reason: "sync_no_api_key" });
      }
      if (!config.apiKey) {
        updateOnboardingState({
          status: "idle",
          hasApiKey: false,
          connectionVerified: false,
          nextAction: "connect",
        });
        return;
      }

      try {
        await runCriticalSyncPass();
        scheduleBackgroundSyncPass();
        api.log?.debug?.("[orgx] Sync OK");
      } catch (err: unknown) {
        const authFailure = isAuthFailure(err);
        const errorMessage = authFailure
          ? "Unauthorized. Your OrgX key may be revoked or expired. Reconnect in browser or use API key."
          : toErrorMessage(err);
        updateOnboardingState({
          status: "error",
          hasApiKey: true,
          connectionVerified: false,
          lastError: errorMessage,
          nextAction: "reconnect",
        });
        if (authFailure) {
          void posthogCapture({
            event: "openclaw_sync_auth_failed",
            distinctId: config.installationId,
            properties: {
              plugin_version: config.pluginVersion,
            },
          }).catch(() => {
            // best effort
          });
        }
        api.log?.warn?.(
          `[orgx] Sync failed: ${err instanceof Error ? err.message : err}`
        );
      }
    })();

    try {
      await syncInFlight;
    } finally {
      syncInFlight = null;
    }
  }

  function scheduleNextSync() {
    if (!syncServiceRunning) {
      return;
    }

    syncTimer = setTimeout(async () => {
      await doSync();
      scheduleNextSync();
    }, config.syncIntervalMs);
    syncTimer.unref?.();
  }

  async function startPairing(input: {
    openclawVersion?: string;
    platform?: string;
    deviceName?: string;
  }): Promise<{
    pairingId: string;
    connectUrl: string;
    expiresAt: string;
    pollIntervalMs: number;
    state: OnboardingState;
  }> {
    updateOnboardingState({
      status: "starting",
      lastError: null,
      nextAction: "connect",
    });
    const pairingPayload = {
      installationId: config.installationId,
      pluginVersion: config.pluginVersion,
      openclawVersion: input.openclawVersion,
      platform: input.platform || process.platform,
      deviceName: input.deviceName,
    };
    const requestPairing = (targetBaseApiUrl: string) =>
      fetchOrgxJsonRequest<{
        pairingId: string;
        pollToken: string;
        connectUrl: string;
        expiresAt: string;
        pollIntervalMs: number;
      }>({
        baseApiUrl: targetBaseApiUrl,
        method: "POST",
        path: "/api/plugin/openclaw/pairings",
        body: pairingPayload,
        // Pairing can hit a cold serverless boot + supabase insert + rate-limit checks.
        // Give it more headroom than typical lightweight API calls.
        options: { timeoutMs: 30_000 },
        toErrorMessage,
      });

    let started = await requestPairing(baseApiUrl);
    const shouldRetryAgainstCanonical =
      !started.ok &&
      started.status === 0 &&
      looksLikeTransientFetchFailure(started.error) &&
      baseApiUrl.replace(/\/+$/, "") !== ORGX_CANONICAL_BASE_URL;

    if (shouldRetryAgainstCanonical) {
      const initialStatus = started.ok ? 0 : started.status;
      const initialError = started.ok ? "Pairing request failed" : started.error;
      const fallbackStarted = await requestPairing(ORGX_CANONICAL_BASE_URL);
      if (fallbackStarted.ok) {
        api.log?.info?.("[orgx] Pairing start succeeded via canonical OrgX base URL", {
          previousBaseUrl: baseApiUrl,
          nextBaseUrl: ORGX_CANONICAL_BASE_URL,
        });
        applyRuntimeBaseUrl(ORGX_CANONICAL_BASE_URL);
        started = fallbackStarted;
      } else {
        started = {
          ok: false,
          status: fallbackStarted.status || initialStatus,
          error: `${initialError}; fallback via ${ORGX_CANONICAL_BASE_URL} failed: ${fallbackStarted.error}`,
        };
      }
    }

    if (!started.ok) {
      if (isAuthRequiredError(started)) {
        clearPairingState();
        const manualConnectUrl = buildManualKeyConnectUrl();
        const state = updateOnboardingState({
          status: "manual_key",
          hasApiKey: Boolean(config.apiKey),
          connectionVerified: false,
          lastError: null,
          nextAction: "enter_manual_key",
          connectUrl: manualConnectUrl,
          pairingId: null,
          expiresAt: null,
          pollIntervalMs: null,
        });
        return {
          pairingId: "manual_key",
          connectUrl: manualConnectUrl,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          pollIntervalMs: 1_500,
          state,
        };
      }

      const statusLabel = started.status ? ` (HTTP ${started.status})` : "";
      const networkHint =
        started.status === 0
          ? ` Could not reach OrgX at ${baseApiUrl}. Check network/VPN/firewall or update ORGX_BASE_URL.`
          : "";
      const message = `Pairing start failed${statusLabel}: ${started.error}${networkHint}`;
      updateOnboardingState({
        status: "error",
        hasApiKey: Boolean(config.apiKey),
        connectionVerified: false,
        lastError: message,
        nextAction: "enter_manual_key",
      });
      throw new Error(message);
    }

    activePairing = {
      pairingId: started.data.pairingId,
      pollToken: started.data.pollToken,
      connectUrl: started.data.connectUrl,
      expiresAt: started.data.expiresAt,
      pollIntervalMs: started.data.pollIntervalMs,
    };

    const state = updateOnboardingState({
      status: config.apiKey ? "connected" : "awaiting_browser_auth",
      hasApiKey: Boolean(config.apiKey),
      connectionVerified: Boolean(config.apiKey),
      workspaceName: onboardingState.workspaceName,
      lastError: null,
      nextAction: config.apiKey ? "reconnect" : "wait_for_browser",
      connectUrl: started.data.connectUrl,
      pairingId: started.data.pairingId,
      expiresAt: started.data.expiresAt,
      pollIntervalMs: started.data.pollIntervalMs,
    });

    return {
      pairingId: started.data.pairingId,
      connectUrl: started.data.connectUrl,
      expiresAt: started.data.expiresAt,
      pollIntervalMs: started.data.pollIntervalMs,
      state,
    };
  }

  async function getPairingStatus(): Promise<OnboardingState> {
    if (!activePairing) {
      return { ...onboardingState };
    }

    const polled = await fetchOrgxJson<{
      pairingId: string;
      status: string;
      expiresAt: string;
      workspaceName?: string | null;
      keyPrefix?: string | null;
      key?: string;
      errorCode?: string | null;
      errorMessage?: string | null;
    }>(
      "GET",
      `/api/plugin/openclaw/pairings/${encodeURIComponent(
        activePairing.pairingId
      )}?pollToken=${encodeURIComponent(activePairing.pollToken)}`
    );

    if (!polled.ok) {
      return updateOnboardingState({
        status: "error",
        hasApiKey: Boolean(config.apiKey),
        connectionVerified: false,
        lastError: polled.error,
        nextAction: "enter_manual_key",
      });
    }

    const status = polled.data.status;
    if (status === "pending" || status === "authorized") {
      return updateOnboardingState({
        status: config.apiKey ? "connected" : "pairing",
        hasApiKey: Boolean(config.apiKey),
        connectionVerified: Boolean(config.apiKey),
        workspaceName: onboardingState.workspaceName,
        lastError: null,
        nextAction: config.apiKey ? "reconnect" : "wait_for_browser",
        connectUrl: activePairing.connectUrl,
        pairingId: activePairing.pairingId,
        expiresAt: activePairing.expiresAt,
        pollIntervalMs: activePairing.pollIntervalMs,
      });
    }

    if (status === "ready") {
      const key = typeof polled.data.key === "string" ? polled.data.key : "";
      if (!key) {
        clearPairingState();
        return updateOnboardingState({
          status: "error",
          hasApiKey: false,
          connectionVerified: false,
          lastError: "Pairing completed without an API key payload.",
          nextAction: "retry",
        });
      }

      const pairingUserIdRaw =
        typeof (polled.data as any).supabaseUserId === "string"
          ? (polled.data as any).supabaseUserId
          : typeof (polled.data as any).userId === "string"
            ? (polled.data as any).userId
            : null;

      setRuntimeApiKey({
        apiKey: key,
        source: "browser_pairing",
        userId: resolveRuntimeUserId(key, [pairingUserIdRaw, config.userId]) || null,
        workspaceName: polled.data.workspaceName ?? null,
        keyPrefix: polled.data.keyPrefix ?? null,
      });

      await fetchOrgxJson(
        "POST",
        `/api/plugin/openclaw/pairings/${encodeURIComponent(
          activePairing.pairingId
        )}/ack`,
        {
          pollToken: activePairing.pollToken,
        }
      );

      clearPairingState();
      updateOnboardingState({
        status: "connected",
        hasApiKey: true,
        connectionVerified: false,
        workspaceName: polled.data.workspaceName ?? null,
        nextAction: "open_dashboard",
        lastError: null,
      });
      await doSync();
      return { ...onboardingState };
    }

    if (status === "consumed") {
      clearPairingState();
      return updateOnboardingState({
        status: config.apiKey ? "connected" : "error",
        hasApiKey: Boolean(config.apiKey),
        connectionVerified: false,
        lastError: config.apiKey ? null : "Pairing consumed but key is unavailable.",
        nextAction: config.apiKey ? "open_dashboard" : "retry",
      });
    }

    clearPairingState();
    return updateOnboardingState({
      status: status === "cancelled" ? "manual_key" : "error",
      hasApiKey: Boolean(config.apiKey),
      connectionVerified: false,
      lastError: polled.data.errorMessage ?? "Pairing failed or expired.",
      nextAction: "retry",
    });
  }

  async function cancelPairingOnboarding(): Promise<OnboardingState> {
    if (!activePairing) {
      return { ...onboardingState };
    }

    await fetchOrgxJson(
      "POST",
      `/api/plugin/openclaw/pairings/${encodeURIComponent(
        activePairing.pairingId
      )}/cancel`,
      {
        pollToken: activePairing.pollToken,
        reason: "user_cancelled",
      }
    );

    clearPairingState();
    return updateOnboardingState({
      status: config.apiKey ? "connected" : "idle",
      hasApiKey: Boolean(config.apiKey),
      connectionVerified: Boolean(config.apiKey),
      workspaceName: onboardingState.workspaceName,
      lastError: null,
      nextAction: config.apiKey ? "open_dashboard" : "connect",
    });
  }

  async function submitManualKey(input: {
    apiKey: string;
    userId?: string;
  }): Promise<OnboardingState> {
    const nextKey = input.apiKey.trim();
    if (!nextKey) {
      throw new Error("apiKey is required");
    }

    updateOnboardingState({
      status: "manual_key",
      hasApiKey: false,
      connectionVerified: false,
      lastError: null,
      nextAction: "enter_manual_key",
    });

    const probeClient = new OrgXClient(
      nextKey,
      config.baseUrl,
      resolveRuntimeUserId(nextKey, [input.userId, config.userId])
    );
    const snapshot = await probeClient.getOrgSnapshot();

    setRuntimeApiKey({
      apiKey: nextKey,
      source: "manual",
      userId: resolveRuntimeUserId(nextKey, [input.userId, config.userId]) || null,
      workspaceName: onboardingState.workspaceName,
      keyPrefix: null,
    });

    updateCachedSnapshot(snapshot);

    return updateOnboardingState({
      status: "connected",
      hasApiKey: true,
      connectionVerified: true,
      lastError: null,
      nextAction: "open_dashboard",
    });
  }

  async function disconnectOnboarding(): Promise<OnboardingState> {
    if (activePairing) {
      await fetchOrgxJson(
        "POST",
        `/api/plugin/openclaw/pairings/${encodeURIComponent(
          activePairing.pairingId
        )}/cancel`,
        {
          pollToken: activePairing.pollToken,
          reason: "disconnect",
        }
      );
    }

    clearPairingState();
    clearPersistedApiKey();
    clearPersistedSnapshot();
    config.apiKey = "";
    config.userId = "";
    client.setCredentials({ apiKey: "", userId: "" });
    cachedSnapshot = null;
    lastSnapshotAt = 0;
    lastBackgroundSyncAt = 0;
    lastBackgroundSyncError = null;
    backgroundSyncQueued = false;

    return updateOnboardingState({
      status: "idle",
      hasApiKey: false,
      connectionVerified: false,
      workspaceName: null,
      lastError: null,
      nextAction: "connect",
      keySource: "none",
    });
  }

  async function stopTrackedAgentRunsOnPluginStop(): Promise<{
    attempted: number;
    stopped: number;
    failed: number;
    markedStopped: number;
  }> {
    const runs = Object.values(readAgentRuns().runs ?? {}).filter(
      (run) => run?.status === "running"
    );
    let attempted = 0;
    let stopped = 0;
    let failed = 0;
    let markedStopped = 0;

    for (const run of runs) {
      if (!run || typeof run !== "object") continue;
      attempted += 1;

      let runStopped = false;
      if (typeof run.pid === "number" && Number.isFinite(run.pid) && run.pid > 0) {
        try {
          const result = await stopDetachedProcess(run.pid);
          runStopped = Boolean(result.stopped);
        } catch {
          runStopped = false;
        }
      } else {
        // No tracked PID means there is no local process to stop.
        runStopped = true;
      }

      if (runStopped) {
        stopped += 1;
      } else {
        failed += 1;
      }

      const marked = markAgentRunStopped(run.runId);
      if (marked) {
        markedStopped += 1;
      }
    }

    return { attempted, stopped, failed, markedStopped };
  }

  registerSyncService({
    api,
    syncIntervalMs: config.syncIntervalMs,
    ensureGatewayWatchdog: (logger) => ensureGatewayWatchdog(logger as any),
    stopGatewayWatchdog: () => stopGatewayWatchdog((api.log ?? {}) as any),
    stopTrackedAgentRuns: stopTrackedAgentRunsOnPluginStop,
    doSync,
    scheduleNextSync,
    setSyncServiceRunning: (running) => {
      syncServiceRunning = running;
    },
    clearSyncTimer: () => {
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = null;
    },
  });

  async function autoAssignEntityForCreate(input: {
    entityType: string;
    entityId: string;
    initiativeId: string | null;
    title: string;
    summary: string | null;
  }) {
    return autoAssignEntityForCreateWithClient({
      client,
      toErrorMessage,
      ...input,
    });
  }

  // ---------------------------------------------------------------------------
  // 2. MCP Tools (Model Context Protocol compatible)
  // ---------------------------------------------------------------------------

  const mcpToolRegistry = registerCoreTools({
    registerTool: api.registerTool.bind(api),
    client,
    config,
    getCachedSnapshot: () => cachedSnapshot,
    getLastSnapshotAt: () => lastSnapshotAt,
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
    randomUUID,
  });

  // ---------------------------------------------------------------------------
  // 3. CLI Command
  // ---------------------------------------------------------------------------

  registerOrgxCli({
    registerCli: api.registerCli.bind(api),
    client,
    formatSnapshot,
    buildHealthReport,
    apiKeySourceLabel,
  });

  // ---------------------------------------------------------------------------
  // 4. HTTP Handler — Dashboard + API proxy
  // ---------------------------------------------------------------------------

  const httpHandler = createHttpHandler(
    config,
    client,
    () => cachedSnapshot,
    {
      getState: () => ({ ...onboardingState }),
      startPairing,
      getStatus: getPairingStatus,
      submitManualKey,
      cancelPairing: cancelPairingOnboarding,
      disconnect: disconnectOnboarding,
    },
    {
      getHealth: async (input = {}) =>
        buildHealthReport({ probeRemote: input.probeRemote === true }),
    }
  );

  const mcpPromptRegistry = new Map<string, RegisteredPrompt>();
  mcpPromptRegistry.set("ship", {
    name: "ship",
    description: "Commit local changes, open a PR, and merge it (GitHub CLI required).",
    arguments: [],
    messages: [
      {
        role: "user",
        content: [
          "Ship the current work:",
          "- Inspect `git status -sb` and `git diff --stat` and summarize what will be shipped.",
          "- Run `npm run typecheck`, `npm run test:hooks`, and `npm run build` (fix failures).",
          "- Create a feature branch if on `main`.",
          "- Commit with a clear message (do not include secrets).",
          "- Push branch, open a PR (use `gh pr create`), then merge it (use `gh pr merge --merge --auto`).",
          "- If `gh` is not authenticated, stop and tell me what to run.",
        ].join("\n"),
      },
    ],
  });

  const mcpHttpHandler = createMcpHttpHandler({
    tools: mcpToolRegistry,
    prompts: mcpPromptRegistry,
    logger: api.log ?? {},
    serverName: "@useorgx/openclaw-plugin",
    serverVersion: config.pluginVersion,
  });

  const compositeHttpHandler: typeof httpHandler = async (req, res) => {
    if (await mcpHttpHandler(req, res)) return true;
    return await httpHandler(req, res);
  };
  if (typeof api.registerHttpRoute === "function") {
    api.registerHttpRoute({
      path: "/orgx",
      auth: "plugin",
      match: "prefix",
      handler: compositeHttpHandler,
    });
    api.registerHttpRoute({
      path: "/workspace-hub",
      auth: "plugin",
      match: "prefix",
      handler: compositeHttpHandler,
    });
  } else if (typeof api.registerHttpHandler === "function") {
    // Backward compatibility for OpenClaw builds before route-based plugin HTTP registration.
    api.registerHttpHandler(compositeHttpHandler);
  } else {
    throw new Error("OpenClaw plugin API does not expose an HTTP registration method.");
  }

  api.log?.info?.("[orgx] Plugin registered", {
    baseUrl: config.baseUrl,
    hasApiKey: !!config.apiKey,
    dashboardEnabled: config.dashboardEnabled,
    installationId: config.installationId,
    pluginVersion: config.pluginVersion,
  });
}

// =============================================================================
// NAMED EXPORT FOR FLEXIBILITY
// =============================================================================

export { register };
