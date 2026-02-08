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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  clearPersistedApiKey,
  loadAuthStore,
  resolveInstallationId,
  saveAuthStore,
} from "./auth-store.js";
import { appendToOutbox, readOutbox, replaceOutbox } from "./outbox.js";
import type { OutboxEvent } from "./outbox.js";

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

  const legacy = readLegacyEnvValue(
    /^ORGX_(?:API_KEY|SERVICE_KEY)=["']?([^"'\n]+)["']?$/m
  );
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
  const userId =
    pluginConf.userId?.trim() ||
    process.env.ORGX_USER_ID?.trim() ||
    input.persistedUserId?.trim() ||
    openclaw.userId ||
    readLegacyEnvValue(/^ORGX_USER_ID=["']?([^"'\n]+)["']?$/m);

  const baseUrl = normalizeBaseUrl(
    pluginConf.baseUrl || process.env.ORGX_BASE_URL || openclaw.baseUrl || DEFAULT_BASE_URL
  );

  return {
    apiKey,
    userId,
    baseUrl,
    syncIntervalMs: pluginConf.syncIntervalMs ?? 300_000,
    enabled: pluginConf.enabled ?? true,
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

interface ReportingContextInput {
  initiative_id?: unknown;
  run_id?: unknown;
  correlation_id?: unknown;
  source_client?: unknown;
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

  if (!config.apiKey) {
    api.log?.warn?.(
      "[orgx] No API key. Set plugins.entries.orgx.config.apiKey, ORGX_API_KEY env, or ~/Code/orgx/orgx/.env.local"
    );
  }

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

  const baseApiUrl = config.baseUrl.replace(/\/+$/, "");
  const defaultReportingCorrelationId =
    pickNonEmptyString(process.env.ORGX_CORRELATION_ID) ??
    `openclaw-${config.installationId}`;

  function resolveReportingContext(
    input: ReportingContextInput
  ): { ok: true; value: ResolvedReportingContext } | { ok: false; error: string } {
    const initiativeId = pickNonEmptyString(
      input.initiative_id,
      process.env.ORGX_INITIATIVE_ID
    );

    if (!initiativeId || !isUuid(initiativeId)) {
      return {
        ok: false,
        error:
          "initiative_id is required (set ORGX_INITIATIVE_ID or pass initiative_id).",
      };
    }

    const sourceCandidate = pickNonEmptyString(
      input.source_client,
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
      return new URL("/settings", baseApiUrl).toString();
    } catch {
      return "https://www.useorgx.com/settings";
    }
  }

  async function fetchOrgxJson<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
    try {
      const response = await fetch(`${baseApiUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; data?: T; error?: unknown; message?: string }
        | null;

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
        } else {
          errorMessage = `OrgX request failed (${response.status})`;
        }
        return { ok: false, status: response.status, error: errorMessage };
      }

      if (payload?.data !== undefined) {
        return { ok: true, data: payload.data };
      }

      return { ok: true, data: payload as unknown as T };
    } catch (err: unknown) {
      return { ok: false, status: 0, error: toErrorMessage(err) };
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
    if (typeof input.userId === "string" && input.userId.trim().length > 0) {
      config.userId = input.userId.trim();
    }

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
  }

  // ---------------------------------------------------------------------------
  // 1. Background Sync Service
  // ---------------------------------------------------------------------------

  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  let syncInFlight: Promise<void> | null = null;
  let syncServiceRunning = false;
  const outboxQueues = ["progress", "decisions", "artifacts"] as const;

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

  async function replayOutboxEvent(event: OutboxEvent): Promise<void> {
    const payload = event.payload ?? {};

    if (event.type === "progress") {
      const summary = pickStringField(payload, "summary");
      if (!summary) {
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
        typeof payload.progress_pct === "number" ? payload.progress_pct : undefined;
      const phase =
        rawPhase === "intent" ||
        rawPhase === "execution" ||
        rawPhase === "blocked" ||
        rawPhase === "review" ||
        rawPhase === "handoff" ||
        rawPhase === "completed"
          ? (rawPhase as ReportingPhase)
          : toReportingPhase(rawPhase, progressPct);
      await client.emitActivity({
        initiative_id: context.value.initiativeId,
        run_id: context.value.runId,
        correlation_id: context.value.correlationId,
        source_client: context.value.sourceClient,
        message: summary,
        phase,
        progress_pct: progressPct,
        level: pickStringField(payload, "level") as "info" | "warn" | "error" | undefined,
        next_step: pickStringField(payload, "next_step") ?? undefined,
        metadata: {
          source: "orgx_openclaw_outbox_replay",
          outbox_event_id: event.id,
        },
      });
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
      await client.applyChangeset({
        initiative_id: context.value.initiativeId,
        run_id: context.value.runId,
        correlation_id: context.value.correlationId,
        source_client: context.value.sourceClient,
        idempotency_key:
          pickStringField(payload, "idempotency_key") ?? `decision:${event.id}`,
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
      const operations = Array.isArray(payload.operations)
        ? (payload.operations as ChangesetOperation[])
        : [];
      if (operations.length === 0) {
        api.log?.warn?.("[orgx] Dropping invalid changeset outbox event", {
          eventId: event.id,
        });
        return;
      }

      await client.applyChangeset({
        initiative_id: context.value.initiativeId,
        run_id: context.value.runId,
        correlation_id: context.value.correlationId,
        source_client: context.value.sourceClient,
        idempotency_key:
          pickStringField(payload, "idempotency_key") ?? `changeset:${event.id}`,
        operations,
      });
      return;
    }

    if (event.type === "artifact") {
      const name = pickStringField(payload, "name");
      if (!name) {
        api.log?.warn?.("[orgx] Dropping invalid artifact outbox event", {
          eventId: event.id,
        });
        return;
      }
      await client.createEntity("artifact", {
        name,
        artifact_type: pickStringField(payload, "artifact_type") ?? "other",
        description: pickStringField(payload, "description"),
        artifact_url: pickStringField(payload, "url"),
        status: "active",
      });
      return;
    }
  }

  async function flushOutboxQueues(): Promise<void> {
    for (const queue of outboxQueues) {
      const pending = await readOutbox(queue);
      if (pending.length === 0) {
        continue;
      }

      const remaining: OutboxEvent[] = [];
      for (const event of pending) {
        try {
          await replayOutboxEvent(event);
        } catch (err: unknown) {
          remaining.push(event);
          api.log?.warn?.("[orgx] Outbox replay failed", {
            queue,
            eventId: event.id,
            error: toErrorMessage(err),
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
  }

  async function doSync(): Promise<void> {
    if (syncInFlight) {
      return syncInFlight;
    }

    syncInFlight = (async () => {
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
        cachedSnapshot = await client.getOrgSnapshot();
        lastSnapshotAt = Date.now();
        updateOnboardingState({
          status: "connected",
          hasApiKey: true,
          connectionVerified: true,
          lastError: null,
          nextAction: "open_dashboard",
        });
        await flushOutboxQueues();
        api.log?.debug?.("[orgx] Sync OK");
      } catch (err: unknown) {
        updateOnboardingState({
          status: "error",
          hasApiKey: true,
          connectionVerified: false,
          lastError: toErrorMessage(err),
          nextAction: "reconnect",
        });
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
    }>("POST", "/api/plugin/openclaw/pairings", {
      installationId: config.installationId,
      pluginVersion: config.pluginVersion,
      openclawVersion: input.openclawVersion,
      platform: input.platform || process.platform,
      deviceName: input.deviceName,
    });

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

      const message = `Pairing start failed: ${started.error}`;
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

      setRuntimeApiKey({
        apiKey: key,
        source: "browser_pairing",
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
      input.userId?.trim() || config.userId
    );
    const snapshot = await probeClient.getOrgSnapshot();

    setRuntimeApiKey({
      apiKey: nextKey,
      source: "manual",
      userId: input.userId?.trim() || null,
      workspaceName: onboardingState.workspaceName,
      keyPrefix: null,
    });

    cachedSnapshot = snapshot;
    lastSnapshotAt = Date.now();

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
    config.apiKey = "";
    client.setCredentials({ apiKey: "" });
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

  // --- orgx_status ---
  api.registerTool(
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
  api.registerTool(
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
  api.registerTool(
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
  api.registerTool(
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
  api.registerTool(
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
  api.registerTool(
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
  api.registerTool(
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
  api.registerTool(
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
  api.registerTool(
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
  api.registerTool(
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
  api.registerTool(
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
      metadata: {
        ...(payload.metadata ?? {}),
        source,
      },
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
      metadata: {
        source,
        idempotency_key: idempotencyKey,
      },
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
  api.registerTool(
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
  api.registerTool(
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
  api.registerTool(
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
  api.registerTool(
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
  api.registerTool(
    {
      name: "orgx_register_artifact",
      description:
        "Register a work output (PR, document, config change, report, etc.) with OrgX. Makes it visible in the dashboard.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Human-readable artifact name (e.g., 'PR #107: Fix build size')",
          },
          artifact_type: {
            type: "string",
            enum: ["pr", "commit", "document", "config", "report", "design", "other"],
            description: "Type of artifact",
          },
          description: {
            type: "string",
            description: "What this artifact is and why it matters",
          },
          url: {
            type: "string",
            description: "Link to the artifact (PR URL, file path, etc.)",
          },
        },
        required: ["name", "artifact_type"],
        additionalProperties: false,
      },
      async execute(
        _callId: string,
        params: {
          name: string;
          artifact_type: string;
          description?: string;
          url?: string;
        } = { name: "", artifact_type: "other" }
      ) {
        const now = new Date().toISOString();
        const id = `artifact:${randomUUID().slice(0, 8)}`;

        const activityItem: LiveActivityItem = {
          id,
          type: "artifact_created",
          title: params.name,
          description: params.description ?? null,
          agentId: null,
          agentName: null,
          runId: null,
          initiativeId: null,
          timestamp: now,
          summary: params.url ?? null,
          metadata: {
            source: "orgx_register_artifact",
            artifact_type: params.artifact_type,
            url: params.url,
          },
        };

        try {
          const entity = await client.createEntity("artifact", {
            name: params.name,
            artifact_type: params.artifact_type,
            description: params.description,
            artifact_url: params.url,
            status: "active",
          });
          return json(
            `Artifact registered: ${params.name} [${params.artifact_type}]`,
            entity
          );
        } catch {
          await appendToOutbox("artifacts", {
            id,
            type: "artifact",
            timestamp: now,
            payload: params as Record<string, unknown>,
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
    }
  );
  api.registerHttpHandler(httpHandler);

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
