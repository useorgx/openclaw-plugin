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
  ChangesetOperation,
} from "./types.js";
import { createHttpHandler } from "./http-handler.js";
import { applyOrgxAgentSuitePlan, computeOrgxAgentSuitePlan } from "./agent-suite.js";
import { registerArtifact } from "./artifacts/register-artifact.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import {
  clearPersistedApiKey,
  loadAuthStore,
  resolveInstallationId,
  saveAuthStore,
} from "./auth-store.js";
import {
  clearPersistedSnapshot,
  readPersistedSnapshot,
  writePersistedSnapshot,
} from "./snapshot-store.js";
import {
  appendToOutbox,
  readOutbox,
  readOutboxSummary,
  replaceOutbox,
} from "./outbox.js";
import type { OutboxEvent } from "./outbox.js";
import { getAgentContext, readAgentContexts } from "./agent-context-store.js";
import { readAgentRuns, markAgentRunStopped } from "./agent-run-store.js";
import { extractProgressOutboxMessage } from "./reporting/outbox-replay.js";
import { ensureGatewayWatchdog } from "./gateway-watchdog.js";
import {
  createMcpHttpHandler,
  type RegisteredPrompt,
  type RegisteredTool,
} from "./mcp-http-handler.js";
import { autoConfigureDetectedMcpClients } from "./mcp-client-setup.js";
import { readOpenClawGatewayPort, readOpenClawSettingsSnapshot } from "./openclaw-settings.js";
import { posthogCapture } from "./telemetry/posthog.js";
import { readSkillPackState, refreshSkillPackState } from "./skill-pack-state.js";

// Re-export types for consumers
export type { OrgXConfig, OrgSnapshot } from "./types.js";
export { OrgXClient } from "./api.js";

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
  registerHttpHandler: (handler: unknown) => void;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

// =============================================================================
// HELPERS
// =============================================================================

interface ResolvedConfig extends OrgXConfig {
  dashboardEnabled: boolean;
  installationId: string;
  pluginVersion: string;
  docsUrl: string;
  apiKeySource:
    | "config"
    | "environment"
    | "persisted"
    | "openclaw-config-file"
    | "legacy-dev"
    | "none";
}

interface ResolvedApiKey {
  value: string;
  source:
    | "config"
    | "environment"
    | "persisted"
    | "openclaw-config-file"
    | "legacy-dev"
    | "none";
}

const DEFAULT_BASE_URL = "https://www.useorgx.com";
const DEFAULT_DOCS_URL = "https://orgx.mintlify.site/guides/openclaw-plugin-setup";

function isUserScopedApiKey(apiKey: string): boolean {
  return apiKey.trim().toLowerCase().startsWith("oxk_");
}

function resolveRuntimeUserId(
  apiKey: string,
  candidates: Array<string | null | undefined>
): string {
  if (isUserScopedApiKey(apiKey)) {
    // For oxk_ keys, the OrgX API ignores X-Orgx-User-Id, but we still keep a UUID
    // around for created_by_id on certain entity writes (e.g., work_artifacts).
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      const trimmed = candidate.trim();
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          trimmed
        )
      ) {
        return trimmed;
      }
    }
    return "";
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return "";
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHost(hostname);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function normalizeBaseUrl(raw: string | undefined): string {
  const candidate = raw?.trim() ?? "";
  if (!candidate) {
    return DEFAULT_BASE_URL;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return DEFAULT_BASE_URL;
    }

    // Do not allow credential-bearing URLs.
    if (parsed.username || parsed.password) {
      return DEFAULT_BASE_URL;
    }

    // Plain HTTP is only allowed for local loopback development.
    if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
      return DEFAULT_BASE_URL;
    }

    parsed.search = "";
    parsed.hash = "";

    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = normalizedPath;

    const normalized = parsed.toString().replace(/\/+$/, "");
    return normalized.length > 0 ? normalized : DEFAULT_BASE_URL;
  } catch {
    return DEFAULT_BASE_URL;
  }
}

function readLegacyEnvValue(keyPattern: RegExp): string {
  try {
    const envPath = join(homedir(), "Code", "orgx", "orgx", ".env.local");
    const envContent = readFileSync(envPath, "utf-8");
    const match = envContent.match(keyPattern);
    return match?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

function readOpenClawOrgxConfig(): {
  apiKey: string;
  userId: string;
  baseUrl: string;
} {
  try {
    const configPath = join(homedir(), ".openclaw", "openclaw.json");
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const plugins =
      parsed.plugins && typeof parsed.plugins === "object"
        ? (parsed.plugins as Record<string, unknown>)
        : {};
    const entries =
      plugins.entries && typeof plugins.entries === "object"
        ? (plugins.entries as Record<string, unknown>)
        : {};
    const orgx =
      entries.orgx && typeof entries.orgx === "object"
        ? (entries.orgx as Record<string, unknown>)
        : {};
    const config =
      orgx.config && typeof orgx.config === "object"
        ? (orgx.config as Record<string, unknown>)
        : {};
    const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
    const userId = typeof config.userId === "string" ? config.userId.trim() : "";
    const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl.trim() : "";
    return { apiKey, userId, baseUrl };
  } catch {
    return { apiKey: "", userId: "", baseUrl: "" };
  }
}

function resolveApiKey(
  pluginConf: Partial<OrgXConfig>,
  persistedApiKey: string | null
): ResolvedApiKey {
  if (pluginConf.apiKey && pluginConf.apiKey.trim().length > 0) {
    return { value: pluginConf.apiKey.trim(), source: "config" };
  }

  if (process.env.ORGX_API_KEY && process.env.ORGX_API_KEY.trim().length > 0) {
    return { value: process.env.ORGX_API_KEY.trim(), source: "environment" };
  }

  if (persistedApiKey && persistedApiKey.trim().length > 0) {
    return { value: persistedApiKey.trim(), source: "persisted" };
  }

  const openclaw = readOpenClawOrgxConfig();
  if (openclaw.apiKey) {
    return { value: openclaw.apiKey, source: "openclaw-config-file" };
  }

  // For local dev convenience we read `ORGX_API_KEY` from `~/Code/orgx/orgx/.env.local`.
  // Do not auto-consume `ORGX_SERVICE_KEY` because service keys often require `X-Orgx-User-Id`,
  // and the dashboard/client flows are intended to run on user-scoped keys (`oxk_...`).
  const legacy = readLegacyEnvValue(/^ORGX_API_KEY=["']?([^"'\n]+)["']?$/m);
  if (legacy) {
    return { value: legacy, source: "legacy-dev" };
  }

  return { value: "", source: "none" };
}

function resolvePluginVersion(): string {
  try {
    const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as {
      version?: string;
    };
    return parsed.version && parsed.version.trim().length > 0
      ? parsed.version
      : "dev";
  } catch {
    return "dev";
  }
}

function resolveDocsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  try {
    const parsed = new URL(normalized);
    if (isLoopbackHostname(parsed.hostname)) {
      return `${normalized}/docs/mintlify/guides/openclaw-plugin-setup`;
    }
  } catch {
    return DEFAULT_DOCS_URL;
  }
  return DEFAULT_DOCS_URL;
}

function resolveConfig(
  api: PluginAPI,
  input: { installationId: string; persistedApiKey: string | null; persistedUserId: string | null }
): ResolvedConfig {
  const pluginConf = api.config?.plugins?.entries?.orgx?.config ?? {};
  const openclaw = readOpenClawOrgxConfig();

  const apiKeyResolution = resolveApiKey(pluginConf, input.persistedApiKey);
  const apiKey = apiKeyResolution.value;

  // Resolve user ID for X-Orgx-User-Id header
  const userId = resolveRuntimeUserId(apiKey, [
    pluginConf.userId,
    process.env.ORGX_USER_ID,
    input.persistedUserId,
    openclaw.userId,
    readLegacyEnvValue(/^ORGX_USER_ID=["']?([^"'\n]+)["']?$/m),
  ]);

  const baseUrl = normalizeBaseUrl(
    pluginConf.baseUrl || process.env.ORGX_BASE_URL || openclaw.baseUrl || DEFAULT_BASE_URL
  );

  return {
    apiKey,
    userId,
    baseUrl,
    syncIntervalMs: pluginConf.syncIntervalMs ?? 300_000,
    enabled: pluginConf.enabled ?? true,
    autoInstallAgentSuiteOnConnect: pluginConf.autoInstallAgentSuiteOnConnect ?? true,
    dashboardEnabled: pluginConf.dashboardEnabled ?? true,
    installationId: input.installationId,
    pluginVersion: resolvePluginVersion(),
    docsUrl: resolveDocsUrl(baseUrl),
    apiKeySource: apiKeyResolution.source,
  };
}

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
    lastSnapshotAt: string | null;
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
      "[orgx] No API key. Set plugins.entries.orgx.config.apiKey, ORGX_API_KEY env, or ~/Code/orgx/orgx/.env.local"
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
    const allowApiKeyChanges = input?.allowApiKeyChanges !== false;
    const previousApiKey = config.apiKey;
    const previousBaseUrl = config.baseUrl;
    const previousUserId = config.userId;
    const previousDocsUrl = config.docsUrl;
    const previousKeySource = config.apiKeySource;

    const latestPersisted = loadAuthStore();
    const next = resolveConfig(api, {
      installationId: config.installationId,
      persistedApiKey: latestPersisted?.apiKey ?? null,
      persistedUserId: latestPersisted?.userId ?? null,
    });

    const nextApiKey = allowApiKeyChanges ? next.apiKey : previousApiKey;
    const nextUserId = allowApiKeyChanges ? next.userId : previousUserId;

    const changed =
      nextApiKey !== previousApiKey ||
      next.baseUrl !== previousBaseUrl ||
      nextUserId !== previousUserId ||
      next.docsUrl !== previousDocsUrl ||
      next.apiKeySource !== previousKeySource;

    if (!changed) {
      return false;
    }

    if (allowApiKeyChanges) {
      config.apiKey = nextApiKey;
      config.userId = nextUserId;
      config.apiKeySource = next.apiKeySource;
    }
    config.baseUrl = next.baseUrl;
    config.docsUrl = next.docsUrl;
    baseApiUrl = config.baseUrl.replace(/\/+$/, "");

    client.setCredentials({
      apiKey: config.apiKey,
      userId: config.userId,
      baseUrl: config.baseUrl,
    });

    // Keep onboarding state aligned with what's actually configured (without forcing a status transition).
    updateOnboardingState({
      hasApiKey: Boolean(config.apiKey),
      keySource: config.apiKeySource,
      docsUrl: config.docsUrl,
      installationId: config.installationId,
    });

    api.log?.info?.("[orgx] Config refreshed", {
      reason: input?.reason ?? "runtime_refresh",
      baseUrl: config.baseUrl,
      hasApiKey: Boolean(config.apiKey),
      apiKeySource: config.apiKeySource,
    });

    return true;
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

  function stableHash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
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

  const registerTool = api.registerTool.bind(api);
  api.registerTool = (tool, options) => {
    const toolName = tool.name;
    const optional = Boolean(options?.optional);

    registerTool(
      {
        ...tool,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (callId: string, params?: any) => {
          const startedAt = Date.now();

          void posthogCapture({
            event: "openclaw_tool_called",
            distinctId: config.installationId,
            properties: {
              tool_name: toolName,
              tool_optional: optional,
              call_id: callId,
              plugin_version: config.pluginVersion,
            },
          }).catch(() => {
            // best effort
          });

          try {
            const result = await tool.execute(callId, params);
            const durationMs = Date.now() - startedAt;

            void posthogCapture({
              event: "openclaw_tool_succeeded",
              distinctId: config.installationId,
              properties: {
                tool_name: toolName,
                tool_optional: optional,
                call_id: callId,
                duration_ms: durationMs,
                plugin_version: config.pluginVersion,
              },
            }).catch(() => {
              // best effort
            });

            return result;
          } catch (err) {
            const durationMs = Date.now() - startedAt;

            void posthogCapture({
              event: "openclaw_tool_failed",
              distinctId: config.installationId,
              properties: {
                tool_name: toolName,
                tool_optional: optional,
                call_id: callId,
                duration_ms: durationMs,
                plugin_version: config.pluginVersion,
                error: toErrorMessage(err),
              },
            }).catch(() => {
              // best effort
            });

            throw err;
          }
        },
      },
      options
    );
  };

  const registerService = api.registerService.bind(api);
  api.registerService = (service) => {
    registerService({
      ...service,
      start: async () => {
        const startedAt = Date.now();
        try {
          await service.start();
          const durationMs = Date.now() - startedAt;
          void posthogCapture({
            event: "openclaw_service_started",
            distinctId: config.installationId,
            properties: {
              service_id: service.id,
              duration_ms: durationMs,
              plugin_version: config.pluginVersion,
            },
          }).catch(() => {
            // best effort
          });
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          void posthogCapture({
            event: "openclaw_service_start_failed",
            distinctId: config.installationId,
            properties: {
              service_id: service.id,
              duration_ms: durationMs,
              plugin_version: config.pluginVersion,
              error: toErrorMessage(err),
            },
          }).catch(() => {
            // best effort
          });
          throw err;
        }
      },
      stop: async () => {
        const startedAt = Date.now();
        try {
          await service.stop();
          const durationMs = Date.now() - startedAt;
          void posthogCapture({
            event: "openclaw_service_stopped",
            distinctId: config.installationId,
            properties: {
              service_id: service.id,
              duration_ms: durationMs,
              plugin_version: config.pluginVersion,
            },
          }).catch(() => {
            // best effort
          });
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          void posthogCapture({
            event: "openclaw_service_stop_failed",
            distinctId: config.installationId,
            properties: {
              service_id: service.id,
              duration_ms: durationMs,
              plugin_version: config.pluginVersion,
              error: toErrorMessage(err),
            },
          }).catch(() => {
            // best effort
          });
          throw err;
        }
      },
    });
  };

  function clearPairingState() {
    activePairing = null;
    updateOnboardingState({
      connectUrl: null,
      pairingId: null,
      expiresAt: null,
      pollIntervalMs: null,
    });
  }

  function isAuthRequiredError(result: { status: number; error: string }): boolean {
    if (result.status !== 401) {
      return false;
    }
    return /auth|unauthorized|token/i.test(result.error);
  }

  function buildManualKeyConnectUrl(): string {
    try {
      // Deep-link into the Security section where API keys live.
      return new URL("/settings#security", baseApiUrl).toString();
    } catch {
      return "https://www.useorgx.com/settings#security";
    }
  }

  async function fetchOrgxJson<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
    try {
      const controller = new AbortController();
      const timeoutMs =
        typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
          ? Math.max(1_000, Math.floor(options.timeoutMs))
          : 12_000;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      let rawText = "";
      try {
        response = await fetch(`${baseApiUrl}${path}`, {
          method,
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        rawText = await response.text().catch(() => "");
      } finally {
        clearTimeout(timeout);
      }

      const payload = ((): { ok?: boolean; data?: T; error?: unknown; message?: string } | null => {
        if (!rawText) return null;
        try {
          return JSON.parse(rawText) as { ok?: boolean; data?: T; error?: unknown; message?: string };
        } catch {
          return null;
        }
      })();

      if (!response.ok) {
        const rawError = payload?.error ?? payload?.message;
        let errorMessage: string;
        if (typeof rawError === "string") {
          errorMessage = rawError;
        } else if (
          rawError &&
          typeof rawError === "object" &&
          "message" in rawError &&
          typeof (rawError as Record<string, unknown>).message === "string"
        ) {
          errorMessage = (rawError as Record<string, unknown>).message as string;
        } else if (rawText && rawText.trim().length > 0) {
          // Avoid dumping HTML (Cloudflare / Next.js error pages) into UI; keep it short.
          const sanitized = rawText
            .replace(/\s+/g, " ")
            .replace(/<[^>]+>/g, "")
            .trim();
          errorMessage = sanitized.length > 0 ? sanitized.slice(0, 180) : `OrgX request failed (${response.status})`;
        } else {
          errorMessage = `OrgX request failed (${response.status})`;
        }

        const statusToken = `HTTP ${response.status}`;
        if (
          response.status &&
          !errorMessage.toLowerCase().includes(statusToken.toLowerCase()) &&
          !errorMessage.includes(`(${response.status})`)
        ) {
          errorMessage = `${errorMessage} (HTTP ${response.status})`;
        }


        const debugParts: string[] = [];
        const requestId = response.headers.get("x-request-id");
        const vercelId = response.headers.get("x-vercel-id");
        const cfRay = response.headers.get("cf-ray");
        const clerkStatus = response.headers.get("x-clerk-auth-status");
        const clerkReason = response.headers.get("x-clerk-auth-reason");

        if (requestId) debugParts.push(`req=${requestId}`);
        if (vercelId && vercelId !== requestId) debugParts.push(`vercel=${vercelId}`);
        if (cfRay) debugParts.push(`cf-ray=${cfRay}`);
        if (clerkStatus) debugParts.push(`clerk=${clerkStatus}`);
        if (clerkReason) debugParts.push(`clerk_reason=${clerkReason}`);

        const debugSuffix =
          debugParts.length > 0 ? ` (${debugParts.join(", ")})` : "";

        return {
          ok: false,
          status: response.status,
          error: `${errorMessage}${debugSuffix}`,
        };
      }

      if (payload?.data !== undefined) {
        return { ok: true, data: payload.data };
      }

      if (payload !== null) {
        return { ok: true, data: payload as unknown as T };
      }

      return { ok: true, data: rawText as unknown as T };
    } catch (err: unknown) {
      const message =
        err &&
        typeof err === "object" &&
        "name" in err &&
        (err as any).name === "AbortError"
          ? `OrgX request timed out (method=${method}, path=${path})`
          : toErrorMessage(err);
      return { ok: false, status: 0, error: message };
    }
  }

  function setRuntimeApiKey(input: {
    apiKey: string;
    source: "manual" | "browser_pairing";
    workspaceName?: string | null;
    keyPrefix?: string | null;
    userId?: string | null;
  }) {
    const nextApiKey = input.apiKey.trim();
    config.apiKey = nextApiKey;
    config.apiKeySource = "persisted";
    config.userId = resolveRuntimeUserId(nextApiKey, [input.userId, config.userId]);

    client.setCredentials({
      apiKey: config.apiKey,
      userId: config.userId,
      baseUrl: config.baseUrl,
    });

    saveAuthStore({
      installationId: config.installationId,
      apiKey: nextApiKey,
      userId: config.userId || null,
      workspaceName: input.workspaceName ?? null,
      keyPrefix: input.keyPrefix ?? null,
      source: input.source,
    });

    updateOnboardingState({
      hasApiKey: true,
      keySource: "persisted",
      installationId: config.installationId,
      workspaceName: input.workspaceName ?? onboardingState.workspaceName,
    });

    if (
      input.source === "browser_pairing" &&
      process.env.ORGX_DISABLE_MCP_CLIENT_AUTOCONFIG !== "1"
    ) {
      try {
        const snapshot = readOpenClawSettingsSnapshot();
        const port = readOpenClawGatewayPort(snapshot.raw);
        const localMcpUrl = `http://127.0.0.1:${port}/orgx/mcp`;
        void autoConfigureDetectedMcpClients({
          localMcpUrl,
          logger: api.log ?? {},
        }).catch(() => {
          // best effort
        });
      } catch {
        // best effort
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Background Sync Service
  // ---------------------------------------------------------------------------

  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  let syncInFlight: Promise<void> | null = null;
  let syncServiceRunning = false;
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
        lastSnapshotAt: lastSnapshotAt > 0 ? new Date(lastSnapshotAt).toISOString() : null,
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
        const retroSummary = stopped.taskId
          ? `OpenClaw ${success ? "completed" : "blocked"} task ${stopped.taskId}.`
          : `OpenClaw run ${success ? "completed" : "blocked"} (session ${stopped.runId}).`;

        const retroPayload = {
          initiative_id: initiativeId,
          correlation_id: correlationId,
          source_client: "openclaw" as const,
          entity_type: retroEntityType,
          entity_id: retroEntityId,
          title: stopped.taskId ?? stopped.runId,
          idempotency_key: `retro:${stopped.runId}`,
          retro: {
            summary: retroSummary,
            what_went_well: success ? ["Completed without runtime error."] : [],
            what_went_wrong: success
              ? []
              : [summary.errorMessage ?? "Session ended with error."],
            decisions: [],
            follow_ups: success
              ? []
              : [
                  {
                    title: "Investigate OpenClaw session failure and unblock task",
                    priority: "p0" as const,
                    reason: summary.errorMessage ?? "Session ended with error.",
                  },
                ],
            signals: {
              tokens: summary.tokens,
              cost_usd: summary.costUsd,
              had_error: summary.hadError,
              error_message: summary.errorMessage,
              session_id: stopped.runId,
              task_id: stopped.taskId,
              workstream_id: stopped.workstreamId,
              provider: stopped.provider,
              model: stopped.model,
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

  async function replayOutboxEvent(event: OutboxEvent): Promise<void> {
    const payload = event.payload ?? {};

    function normalizeRunFields(context: { runId?: string | null; correlationId?: string | null }): {
      run_id: string | undefined;
      correlation_id: string | undefined;
    } {
      // We prefer correlation IDs for replay because many local adapters use UUID-like
      // session IDs that do *not* exist as server-side run IDs.
      if (context.correlationId) {
        return { run_id: undefined, correlation_id: context.correlationId };
      }
      if (context.runId) {
        return {
          run_id: undefined,
          correlation_id: `openclaw_run_${stableHash(context.runId).slice(0, 24)}`,
        };
      }
      return { run_id: undefined, correlation_id: undefined };
    }

    if (event.type === "progress") {
      const message = extractProgressOutboxMessage(payload);
      if (!message) {
        api.log?.warn?.("[orgx] Dropping invalid progress outbox event", {
          eventId: event.id,
        });
        return;
      }
      const context = resolveReportingContext(payload as ReportingContextInput);
      if (!context.ok) {
        throw new Error(context.error);
      }
      const rawPhase = pickStringField(payload, "phase") ?? "implementing";
      const progressPct =
        typeof payload.progress_pct === "number"
          ? payload.progress_pct
          : typeof (payload as Record<string, unknown>).progressPct === "number"
            ? ((payload as Record<string, unknown>).progressPct as number)
            : undefined;
      const phase =
        rawPhase === "intent" ||
        rawPhase === "execution" ||
        rawPhase === "blocked" ||
        rawPhase === "review" ||
        rawPhase === "handoff" ||
        rawPhase === "completed"
          ? (rawPhase as ReportingPhase)
          : toReportingPhase(rawPhase, progressPct);

      const metaRaw = payload.metadata;
      const meta =
        metaRaw && typeof metaRaw === "object" && !Array.isArray(metaRaw)
          ? (metaRaw as Record<string, unknown>)
          : {};

      const baseMetadata: Record<string, unknown> = {
        ...meta,
        source: "orgx_openclaw_outbox_replay",
        outbox_event_id: event.id,
      };

      let emitPayload = {
        initiative_id: context.value.initiativeId,
        run_id: context.value.runId,
        correlation_id: context.value.correlationId,
        source_client: context.value.sourceClient,
        message,
        phase,
        progress_pct: progressPct,
        level: pickStringField(payload, "level") as "info" | "warn" | "error" | undefined,
        next_step:
          pickStringField(payload, "next_step") ??
          pickStringField(payload, "nextStep") ??
          undefined,
        metadata: baseMetadata,
      } satisfies Parameters<typeof client.emitActivity>[0];

      // Locally-buffered progress events often store a local UUID in run_id. OrgX may reject
      // unknown run IDs on replay; prefer a deterministic non-UUID correlation key instead.
      if (emitPayload.run_id && !emitPayload.correlation_id) {
        const replayCorrelationId = `openclaw_run_${stableHash(emitPayload.run_id).slice(0, 24)}`;
        emitPayload = {
          ...emitPayload,
          run_id: undefined,
          correlation_id: replayCorrelationId,
          metadata: {
            ...(emitPayload.metadata ?? {}),
            replay_run_id_as_correlation: true,
          },
        };
      }

      try {
        await client.emitActivity(emitPayload);
      } catch (err: unknown) {
        // Some locally-buffered events carry a UUID that *looks* like an OrgX run_id
        // but was only ever used as a local correlation/grouping key. If OrgX
        // doesn't recognize it, retry by treating it as correlation_id so OrgX can
        // create/attach a run deterministically.
        const msg = toErrorMessage(err);
        if (
          emitPayload.run_id &&
          /^404\\b/.test(msg) &&
          /\\brun\\b/i.test(msg) &&
          /not found/i.test(msg)
        ) {
          const replayCorrelationId = `openclaw_run_${stableHash(emitPayload.run_id).slice(0, 24)}`;
          await client.emitActivity({
            ...emitPayload,
            run_id: undefined,
            correlation_id: replayCorrelationId,
            metadata: {
              ...(emitPayload.metadata ?? {}),
              replay_run_id_as_correlation: true,
            },
          });
        } else {
          throw err;
        }
      }
      return;
    }

    if (event.type === "decision") {
      const question = pickStringField(payload, "question");
      if (!question) {
        api.log?.warn?.("[orgx] Dropping invalid decision outbox event", {
          eventId: event.id,
        });
        return;
      }
      const context = resolveReportingContext(payload as ReportingContextInput);
      if (!context.ok) {
        throw new Error(context.error);
      }
      const runFields = normalizeRunFields({
        runId: context.value.runId,
        correlationId: context.value.correlationId,
      });

      // Payloads should include a stable idempotency_key when enqueued, but older
      // events may not. Derive a deterministic fallback so outbox replay won't
      // double-create the same remote decision.
      const fallbackKey = stableHash(
        JSON.stringify({
          t: "decision",
          initiative_id: context.value.initiativeId,
          run_id: context.value.runId ?? null,
          correlation_id: context.value.correlationId ?? null,
          question,
        })
      ).slice(0, 24);

      const resolvedIdempotencyKey =
        pickStringField(payload, "idempotency_key") ??
        pickStringField(payload, "idempotencyKey") ??
        `openclaw:decision:${fallbackKey}`;

      await client.applyChangeset({
        initiative_id: context.value.initiativeId,
        run_id: runFields.run_id,
        correlation_id: runFields.correlation_id,
        source_client: context.value.sourceClient,
        idempotency_key: resolvedIdempotencyKey,
        operations: [
          {
            op: "decision.create",
            title: question,
            summary: pickStringField(payload, "context") ?? undefined,
            urgency:
              (pickStringField(payload, "urgency") as
                | "low"
                | "medium"
                | "high"
                | "urgent"
                | undefined) ?? "medium",
            options: pickStringArrayField(payload, "options"),
            blocking:
              typeof payload.blocking === "boolean" ? payload.blocking : true,
          },
        ],
      });
      return;
    }

    if (event.type === "changeset") {
      const context = resolveReportingContext(payload as ReportingContextInput);
      if (!context.ok) {
        throw new Error(context.error);
      }
      const runFields = normalizeRunFields({
        runId: context.value.runId,
        correlationId: context.value.correlationId,
      });
      const operations = Array.isArray(payload.operations)
        ? (payload.operations as ChangesetOperation[])
        : [];
      if (operations.length === 0) {
        api.log?.warn?.("[orgx] Dropping invalid changeset outbox event", {
          eventId: event.id,
        });
        return;
      }

      // Status updates are the most common offline replay payload, and `updateEntity`
      // is the most widely supported primitive across OrgX deployments. Prefer it
      // when the changeset contains only simple status mutations.
      const statusOps = operations
        .map((op) => {
          if (!op || typeof op !== "object") return null;
          const record = op as Record<string, unknown>;
          const kind = typeof record.op === "string" ? record.op.trim() : "";
          if (kind === "task.update") {
            const taskId = typeof record.task_id === "string" ? record.task_id.trim() : "";
            const statusRaw = typeof record.status === "string" ? record.status.trim() : "";
            const normalized = statusRaw.toLowerCase().replace(/\s+/g, "_");
            const status =
              normalized === "completed" || normalized === "complete" || normalized === "finished"
                ? "done"
                : normalized === "inprogress"
                  ? "in_progress"
                  : normalized;
            if (!taskId || !status) return null;
            return { type: "task" as const, id: taskId, status };
          }
          if (kind === "milestone.update") {
            const milestoneId =
              typeof record.milestone_id === "string" ? record.milestone_id.trim() : "";
            const statusRaw = typeof record.status === "string" ? record.status.trim() : "";
            const normalized = statusRaw.toLowerCase().replace(/\s+/g, "_");
            const status =
              normalized === "done" || normalized === "complete" || normalized === "finished"
                ? "completed"
                : normalized === "inprogress"
                  ? "in_progress"
                  : normalized === "todo" || normalized === "not_started" || normalized === "pending"
                    ? "planned"
                    : normalized === "blocked" || normalized === "stuck"
                      ? "at_risk"
                      : normalized;
            if (!milestoneId || !status) return null;
            return { type: "milestone" as const, id: milestoneId, status };
          }
          return null;
        })
        .filter((item): item is { type: "task" | "milestone"; id: string; status: string } =>
          Boolean(item)
        );

      if (statusOps.length === operations.length) {
        for (const op of statusOps) {
          await client.updateEntity(op.type, op.id, { status: op.status });
        }
        return;
      }

      // Payloads should include a stable idempotency_key when enqueued, but older
      // events may not. Derive a deterministic fallback so outbox replay won't
      // double-create the same remote change.
      const fallbackKey = stableHash(
        JSON.stringify({
          t: "changeset",
          initiative_id: context.value.initiativeId,
          run_id: context.value.runId ?? null,
          correlation_id: context.value.correlationId ?? null,
          operations,
        })
      ).slice(0, 24);

      const resolvedIdempotencyKey =
        pickStringField(payload, "idempotency_key") ??
        pickStringField(payload, "idempotencyKey") ??
        `openclaw:changeset:${fallbackKey}`;

      await client.applyChangeset({
        initiative_id: context.value.initiativeId,
        run_id: runFields.run_id,
        correlation_id: runFields.correlation_id,
        source_client: context.value.sourceClient,
        idempotency_key: resolvedIdempotencyKey,
        operations,
      });
      return;
    }

    if (event.type === "outcome") {
      const context = resolveReportingContext(payload as ReportingContextInput);
      if (!context.ok) {
        throw new Error(context.error);
      }
      const runFields = normalizeRunFields({
        runId: context.value.runId,
        correlationId: context.value.correlationId,
      });

      const executionId =
        pickStringField(payload, "execution_id") ??
        pickStringField(payload, "executionId");
      const executionType =
        pickStringField(payload, "execution_type") ??
        pickStringField(payload, "executionType");
      const agentId =
        pickStringField(payload, "agent_id") ??
        pickStringField(payload, "agentId");
      const success =
        typeof (payload as Record<string, unknown>).success === "boolean"
          ? ((payload as Record<string, unknown>).success as boolean)
          : null;

      if (!executionId || !executionType || !agentId || success === null) {
        api.log?.warn?.("[orgx] Dropping invalid outcome outbox event", {
          eventId: event.id,
        });
        return;
      }

      const metaRaw = payload.metadata;
      const meta =
        metaRaw && typeof metaRaw === "object" && !Array.isArray(metaRaw)
          ? (metaRaw as Record<string, unknown>)
          : {};

      await client.recordRunOutcome({
        initiative_id: context.value.initiativeId,
        run_id: runFields.run_id,
        correlation_id: runFields.correlation_id,
        source_client: context.value.sourceClient,
        execution_id: executionId,
        execution_type: executionType,
        agent_id: agentId,
        task_type:
          pickStringField(payload, "task_type") ??
          pickStringField(payload, "taskType") ??
          undefined,
        domain: pickStringField(payload, "domain") ?? undefined,
        started_at:
          pickStringField(payload, "started_at") ??
          pickStringField(payload, "startedAt") ??
          undefined,
        completed_at:
          pickStringField(payload, "completed_at") ??
          pickStringField(payload, "completedAt") ??
          undefined,
        inputs:
          payload.inputs && typeof payload.inputs === "object"
            ? (payload.inputs as Record<string, unknown>)
            : undefined,
        outputs:
          payload.outputs && typeof payload.outputs === "object"
            ? (payload.outputs as Record<string, unknown>)
            : undefined,
        steps: Array.isArray(payload.steps)
          ? (payload.steps as Array<Record<string, unknown>>)
          : undefined,
        success,
        quality_score:
          typeof payload.quality_score === "number"
            ? payload.quality_score
            : typeof (payload as any).qualityScore === "number"
              ? (payload as any).qualityScore
              : undefined,
        duration_vs_estimate:
          typeof payload.duration_vs_estimate === "number"
            ? payload.duration_vs_estimate
            : typeof (payload as any).durationVsEstimate === "number"
              ? (payload as any).durationVsEstimate
              : undefined,
        cost_vs_budget:
          typeof payload.cost_vs_budget === "number"
            ? payload.cost_vs_budget
            : typeof (payload as any).costVsBudget === "number"
              ? (payload as any).costVsBudget
              : undefined,
        human_interventions:
          typeof payload.human_interventions === "number"
            ? payload.human_interventions
            : typeof (payload as any).humanInterventions === "number"
              ? (payload as any).humanInterventions
              : undefined,
        user_satisfaction:
          typeof payload.user_satisfaction === "number"
            ? payload.user_satisfaction
            : typeof (payload as any).userSatisfaction === "number"
              ? (payload as any).userSatisfaction
              : undefined,
        errors: Array.isArray(payload.errors)
          ? (payload.errors as unknown[]).filter((e): e is string => typeof e === "string")
          : undefined,
        metadata: {
          ...meta,
          source: "orgx_openclaw_outbox_replay",
          outbox_event_id: event.id,
        },
      });
      return;
    }

    if (event.type === "retro") {
      const context = resolveReportingContext(payload as ReportingContextInput);
      if (!context.ok) {
        throw new Error(context.error);
      }
      const runFields = normalizeRunFields({
        runId: context.value.runId,
        correlationId: context.value.correlationId,
      });

      const retro =
        payload.retro && typeof payload.retro === "object" && !Array.isArray(payload.retro)
          ? (payload.retro as Record<string, unknown>)
          : null;
      const summary =
        retro && typeof retro.summary === "string" ? retro.summary.trim() : "";
      if (!retro || !summary) {
        api.log?.warn?.("[orgx] Dropping invalid retro outbox event", {
          eventId: event.id,
        });
        return;
      }

      const entityTypeRaw =
        pickStringField(payload, "entity_type") ??
        pickStringField(payload, "entityType");
      const parsedEntityType = parseRetroEntityType(entityTypeRaw) ?? null;
      // Server-side enum parity can lag behind local clients. Only attach to the
      // entity types that are guaranteed to exist today.
      const entityType =
        parsedEntityType === "initiative" || parsedEntityType === "task"
          ? parsedEntityType
          : null;

      const entityIdRaw =
        pickStringField(payload, "entity_id") ??
        pickStringField(payload, "entityId") ??
        null;
      const entityId = isUuid(entityIdRaw ?? undefined) ? entityIdRaw : null;

      await client.recordRunRetro({
        initiative_id: context.value.initiativeId,
        run_id: runFields.run_id,
        correlation_id: runFields.correlation_id,
        source_client: context.value.sourceClient,
        entity_type: entityType && entityId ? entityType : undefined,
        entity_id: entityType && entityId ? entityId : undefined,
        title: pickStringField(payload, "title") ?? undefined,
        idempotency_key:
          pickStringField(payload, "idempotency_key") ??
          pickStringField(payload, "idempotencyKey") ??
          undefined,
        retro: retro as any,
        markdown: pickStringField(payload, "markdown") ?? undefined,
      });
      return;
    }

    if (event.type === "artifact") {
      // Artifacts are first-class UX loop closure (activity stream + entity modals).
      // Try to persist upstream; if this fails, keep the event queued for retry.
      const payload =
        event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : {};

      const name = pickStringField(payload, "name") ?? pickStringField(payload, "title") ?? "";
      const artifactType = pickStringField(payload, "artifact_type") ?? "other";
      const entityType = pickStringField(payload, "entity_type") ?? "";
      const entityId = pickStringField(payload, "entity_id") ?? "";
      const artifactId = pickStringField(payload, "artifact_id") ?? null;
      const description = pickStringField(payload, "description") ?? undefined;
      const externalUrl = pickStringField(payload, "url") ?? pickStringField(payload, "artifact_url") ?? null;
      const content = pickStringField(payload, "content") ?? pickStringField(payload, "preview_markdown") ?? null;

      const allowedEntityType =
        entityType === "initiative" ||
        entityType === "milestone" ||
        entityType === "task" ||
        entityType === "decision" ||
        entityType === "project"
          ? (entityType as any)
          : null;

      if (!allowedEntityType || !entityId.trim() || !name.trim()) {
        api.log?.warn?.("[orgx] Dropping invalid artifact outbox event", {
          eventId: event.id,
          entityType,
          entityId,
        });
        return;
      }

      const result = await registerArtifact(client as any, client.getBaseUrl(), {
        artifact_id: artifactId,
        entity_type: allowedEntityType,
        entity_id: entityId,
        name: name.trim(),
        artifact_type: artifactType.trim() || "other",
        description,
        external_url: externalUrl,
        preview_markdown: content,
        status: "draft",
        metadata: {
          source: "outbox_replay",
          outbox_event_id: event.id,
          ...(payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
            ? (payload.metadata as Record<string, unknown>)
            : {}),
        },
        validate_persistence: process.env.ORGX_VALIDATE_ARTIFACT_PERSISTENCE === "1",
      });

      if (!result.ok) {
        throw new Error(result.persistence.last_error ?? "artifact registration failed");
      }

      return;
    }
  }

  async function flushOutboxQueues(): Promise<void> {
    const attemptAt = new Date().toISOString();
    outboxReplayState = {
      ...outboxReplayState,
      status: "running",
      lastReplayAttemptAt: attemptAt,
      lastReplayError: null,
    };

    let hadReplayFailure = false;
    let lastReplayError: string | null = null;

    // Outbox files are keyed by *session id* (e.g. initiative/run correlation),
    // not by event type.
    const outboxSummary = await readOutboxSummary();
    const queues = Object.entries(outboxSummary.pendingByQueue)
      .filter(([, count]) => typeof count === "number" && count > 0)
      .map(([queueId]) => queueId)
      .sort();

    for (const queue of queues) {
      const pending = await readOutbox(queue);
      if (pending.length === 0) {
        continue;
      }

      const remaining: OutboxEvent[] = [];
      for (const event of pending) {
        try {
          await replayOutboxEvent(event);
        } catch (err: unknown) {
          hadReplayFailure = true;
          lastReplayError = toErrorMessage(err);
          remaining.push(event);
          api.log?.warn?.("[orgx] Outbox replay failed", {
            queue,
            eventId: event.id,
            error: lastReplayError,
          });
        }
      }

      await replaceOutbox(queue, remaining);

      const replayedCount = pending.length - remaining.length;
      if (replayedCount > 0) {
        api.log?.info?.("[orgx] Replayed buffered outbox events", {
          queue,
          replayed: replayedCount,
          remaining: remaining.length,
        });
      }
    }

    if (hadReplayFailure) {
      outboxReplayState = {
        ...outboxReplayState,
        status: "error",
        lastReplayFailureAt: new Date().toISOString(),
        lastReplayError,
      };
    } else {
      outboxReplayState = {
        ...outboxReplayState,
        status: "success",
        lastReplaySuccessAt: new Date().toISOString(),
        lastReplayError: null,
      };
    }
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
        await reconcileStoppedAgentRuns();
        let snapshotError: string | null = null;
        try {
          updateCachedSnapshot(await client.getOrgSnapshot());
        } catch (err: unknown) {
          if (isAuthFailure(err)) {
            throw err;
          }
          snapshotError = toErrorMessage(err);
          api.log?.warn?.("[orgx] Snapshot sync failed (continuing)", {
            error: snapshotError,
          });
        }

        // Best-effort: poll the canonical OrgX SkillPack so the dashboard/install path
        // can apply it without blocking on an on-demand fetch.
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

        // Best-effort: provision/update the OrgX agent suite after we've verified a working connection.
        // This makes domain agents available immediately for launches without requiring a manual install.
        try {
          if (config.autoInstallAgentSuiteOnConnect !== false) {
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

            if (hasWork && !hasConflicts) {
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
            }
          }
        } catch (err: unknown) {
          api.log?.debug?.("[orgx] Agent suite auto-provision skipped/failed (best effort)", {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        updateOnboardingState({
          status: "connected",
          hasApiKey: true,
          connectionVerified: snapshotError === null,
          lastError: snapshotError,
          nextAction: "open_dashboard",
        });
        await flushOutboxQueues();
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

    const started = await fetchOrgxJson<{
      pairingId: string;
      pollToken: string;
      connectUrl: string;
      expiresAt: string;
      pollIntervalMs: number;
    }>(
      "POST",
      "/api/plugin/openclaw/pairings",
      {
        installationId: config.installationId,
        pluginVersion: config.pluginVersion,
        openclawVersion: input.openclawVersion,
        platform: input.platform || process.platform,
        deviceName: input.deviceName,
      },
      // Pairing can hit a cold serverless boot + supabase insert + rate-limit checks.
      // Give it more headroom than typical lightweight API calls.
      { timeoutMs: 30_000 }
    );

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
      const message = `Pairing start failed${statusLabel}: ${started.error}`;
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
      status: "awaiting_browser_auth",
      hasApiKey: false,
      connectionVerified: false,
      lastError: null,
      nextAction: "wait_for_browser",
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
        status: "pairing",
        hasApiKey: false,
        connectionVerified: false,
        lastError: null,
        nextAction: "wait_for_browser",
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

  api.registerService({
    id: "orgx-sync",
    start: async () => {
      syncServiceRunning = true;
      const watchdog = ensureGatewayWatchdog(api.log ?? {});
      if (watchdog.started) {
        api.log?.info?.("[orgx] Gateway watchdog started", {
          pid: watchdog.pid,
        });
      }
      api.log?.info?.("[orgx] Starting sync service", {
        interval: config.syncIntervalMs,
      });
      await doSync();
      scheduleNextSync();
    },
    stop: async () => {
      syncServiceRunning = false;
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = null;
    },
  });

  type AutoAssignedAgent = {
    id: string;
    name: string;
    domain: string | null;
  };

  async function autoAssignEntityForCreate(input: {
    entityType: string;
    entityId: string;
    initiativeId: string | null;
    title: string;
    summary: string | null;
  }): Promise<{
    assignmentSource: "orchestrator" | "fallback" | "manual";
    assignedAgents: AutoAssignedAgent[];
    warnings: string[];
    updatedEntity: Record<string, unknown> | null;
  }> {
    const warnings: string[] = [];
    const byKey = new Map<string, AutoAssignedAgent>();
    const addAgent = (agent: AutoAssignedAgent) => {
      const key = `${agent.id}:${agent.name}`.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, agent);
    };

    type LiveAgent = AutoAssignedAgent & { status: string | null };
    let liveAgents: LiveAgent[] = [];
    try {
      const agentResp = await client.getLiveAgents({
        initiative: input.initiativeId,
        includeIdle: true,
      });
      liveAgents = (Array.isArray(agentResp.agents) ? agentResp.agents : [])
        .map((raw): LiveAgent | null => {
          if (!raw || typeof raw !== "object") return null;
          const record = raw as Record<string, unknown>;
          const id =
            (typeof record.id === "string" && record.id.trim()) ||
            (typeof record.agentId === "string" && record.agentId.trim()) ||
            "";
          const name =
            (typeof record.name === "string" && record.name.trim()) ||
            (typeof record.agentName === "string" && record.agentName.trim()) ||
            id;
          if (!name) return null;
          return {
            id: id || `name:${name}`,
            name,
            domain:
              (typeof record.domain === "string" && record.domain.trim()) ||
              (typeof record.role === "string" && record.role.trim()) ||
              null,
            status:
              (typeof record.status === "string" && record.status.trim()) || null,
          };
        })
        .filter((item): item is LiveAgent => item !== null);
    } catch (err: unknown) {
      warnings.push(`live agents unavailable (${toErrorMessage(err)})`);
    }

    const orchestrator = liveAgents.find(
      (agent) =>
        /holt|orchestrator/i.test(agent.name) ||
        /orchestrator/i.test(agent.domain ?? "")
    );
    if (orchestrator) addAgent(orchestrator);

    let assignmentSource: "orchestrator" | "fallback" | "manual" = "fallback";
    try {
      const preflight = await client.delegationPreflight({
        intent: `${input.title}${input.summary ? `: ${input.summary}` : ""}`,
      });
      const recommendations = preflight.data?.recommended_split ?? [];
      const recommendedDomains = [
        ...new Set(
          recommendations
            .map((entry) => String(entry.owner_domain ?? "").trim().toLowerCase())
            .filter(Boolean)
        ),
      ];
      for (const domain of recommendedDomains) {
        const match = liveAgents.find((agent) =>
          (agent.domain ?? "").toLowerCase().includes(domain)
        );
        if (match) addAgent(match);
      }
      if (recommendedDomains.length > 0) {
        assignmentSource = "orchestrator";
      }
    } catch (err: unknown) {
      warnings.push(`delegation preflight failed (${toErrorMessage(err)})`);
    }

    if (byKey.size === 0) {
      const haystack = `${input.title} ${input.summary ?? ""}`.toLowerCase();
      const domainHints: string[] = [];
      if (/market|campaign|thread|article|tweet|copy/.test(haystack)) {
        domainHints.push("marketing");
      } else if (/design|ux|ui|a11y/.test(haystack)) {
        domainHints.push("design");
      } else if (/ops|runbook|incident|reliability/.test(haystack)) {
        domainHints.push("operations");
      } else if (/sales|deal|pipeline/.test(haystack)) {
        domainHints.push("sales");
      } else {
        domainHints.push("engineering", "product");
      }

      for (const domain of domainHints) {
        const match = liveAgents.find((agent) =>
          (agent.domain ?? "").toLowerCase().includes(domain)
        );
        if (match) addAgent(match);
      }
    }

    if (byKey.size === 0 && liveAgents.length > 0) {
      addAgent(liveAgents[0]);
      warnings.push("fallback selected first available live agent");
    }

    const assignedAgents = Array.from(byKey.values());
    let updatedEntity: Record<string, unknown> | null = null;
    try {
      updatedEntity = (await client.updateEntity(input.entityType, input.entityId, {
        assigned_agent_ids: assignedAgents.map((agent) => agent.id),
        assigned_agent_names: assignedAgents.map((agent) => agent.name),
        assignment_source: assignmentSource,
      })) as Record<string, unknown>;
    } catch (err: unknown) {
      warnings.push(`assignment update failed (${toErrorMessage(err)})`);
    }

    return {
      assignmentSource,
      assignedAgents,
      warnings,
      updatedEntity,
    };
  }

  // ---------------------------------------------------------------------------
  // 2. MCP Tools (Model Context Protocol compatible)
  // ---------------------------------------------------------------------------

  const mcpToolRegistry = new Map<string, RegisteredTool>();
  const registerMcpTool: PluginAPI["registerTool"] = (tool, options) => {
    mcpToolRegistry.set(tool.name, tool as unknown as RegisteredTool);
    api.registerTool(tool, options);
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
        if (
          !cachedSnapshot ||
          Date.now() - lastSnapshotAt > config.syncIntervalMs
        ) {
          await doSync();
        }
        if (!cachedSnapshot) {
          return text(
            "❌ Failed to fetch OrgX status. Check API key and connectivity."
          );
        }
        return text(formatSnapshot(cachedSnapshot));
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

  // ---------------------------------------------------------------------------
  // 3. CLI Command
  // ---------------------------------------------------------------------------

  api.registerCli(
    ({ program }: { program: any }) => {
      const cmd = program.command("orgx").description("OrgX integration commands");

      cmd
        .command("status")
        .description("Show current OrgX org status")
        .action(async () => {
          try {
            const snap = await client.getOrgSnapshot();
            console.log(formatSnapshot(snap));
          } catch (err: unknown) {
            console.error(`Error: ${err instanceof Error ? err.message : err}`);
            process.exit(1);
          }
        });

      cmd
        .command("sync")
        .description("Trigger manual memory sync")
        .option("--memory <text>", "Memory to push")
        .option("--daily-log <text>", "Daily log to push")
        .action(async (opts: { memory?: string; dailyLog?: string } = {}) => {
          try {
            const resp = await client.syncMemory({
              memory: opts.memory,
              dailyLog: opts.dailyLog,
            });
            console.log("Sync complete:");
            console.log(`  Initiatives: ${resp.initiatives?.length ?? 0}`);
            console.log(`  Active tasks: ${resp.activeTasks?.length ?? 0}`);
            console.log(
              `  Pending decisions: ${resp.pendingDecisions?.length ?? 0}`
            );
          } catch (err: unknown) {
            console.error(
              `Sync failed: ${err instanceof Error ? err.message : err}`
            );
            process.exit(1);
          }
        });

      cmd
        .command("doctor")
        .description("Run plugin diagnostics and connectivity checks")
        .option("--json", "Print the report as JSON")
        .option("--no-remote", "Skip remote OrgX API reachability probe")
        .action(async (opts: { json?: boolean; remote?: boolean } = {}) => {
          try {
            const report = await buildHealthReport({
              probeRemote: opts.remote !== false,
            });

            if (opts.json) {
              console.log(JSON.stringify(report, null, 2));
              if (!report.ok) process.exit(1);
              return;
            }

            console.log("OrgX Doctor");
            console.log(`  Status: ${report.status.toUpperCase()}`);
            console.log(`  Plugin: v${report.plugin.version}`);
            console.log(`  Base URL: ${report.plugin.baseUrl}`);
            console.log(
              `  API Key Source: ${apiKeySourceLabel(report.auth.keySource)}`
            );
            console.log(`  Outbox Pending: ${report.outbox.pendingTotal}`);
            console.log("");
            console.log("Checks:");
            for (const check of report.checks) {
              const prefix =
                check.status === "pass"
                  ? "[PASS]"
                  : check.status === "warn"
                    ? "[WARN]"
                    : "[FAIL]";
              console.log(`  ${prefix} ${check.message}`);
            }

            if (report.remote.enabled) {
              if (report.remote.reachable === true) {
                console.log(
                  `  Remote probe latency: ${report.remote.latencyMs ?? "?"}ms`
                );
              } else if (report.remote.reachable === false) {
                console.log(
                  `  Remote probe error: ${report.remote.error ?? "Unknown error"}`
                );
              } else {
                console.log("  Remote probe: skipped");
              }
            }

            if (!report.ok) {
              process.exit(1);
            }
          } catch (err: unknown) {
            console.error(
              `Doctor failed: ${err instanceof Error ? err.message : err}`
            );
            process.exit(1);
          }
        });
    },
    { commands: ["orgx"] }
  );

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
  api.registerHttpHandler(compositeHttpHandler);

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
