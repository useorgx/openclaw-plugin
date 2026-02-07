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
import type { OnboardingState, OrgXConfig, OrgSnapshot } from "./types.js";
import { createHttpHandler } from "./http-handler.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  clearPersistedApiKey,
  loadAuthStore,
  resolveInstallationId,
  saveAuthStore,
} from "./auth-store.js";

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
  apiKeySource: "config" | "environment" | "persisted" | "legacy-dev" | "none";
}

interface ResolvedApiKey {
  value: string;
  source: "config" | "environment" | "persisted" | "legacy-dev" | "none";
}

const DEFAULT_DOCS_URL = "https://orgx.mintlify.site/guides/openclaw-plugin-setup";

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
  if (normalized.includes("localhost") || normalized.includes("127.0.0.1")) {
    return `${normalized}/docs/mintlify/guides/openclaw-plugin-setup`;
  }
  return DEFAULT_DOCS_URL;
}

function resolveConfig(
  api: PluginAPI,
  input: { installationId: string; persistedApiKey: string | null; persistedUserId: string | null }
): ResolvedConfig {
  const pluginConf = api.config?.plugins?.entries?.orgx?.config ?? {};

  const apiKeyResolution = resolveApiKey(pluginConf, input.persistedApiKey);
  const apiKey = apiKeyResolution.value;

  // Resolve user ID for X-Orgx-User-Id header
  const userId =
    pluginConf.userId?.trim() ||
    process.env.ORGX_USER_ID?.trim() ||
    input.persistedUserId?.trim() ||
    readLegacyEnvValue(/^ORGX_USER_ID=["']?([^"'\n]+)["']?$/m);

  const baseUrl =
    pluginConf.baseUrl ||
    process.env.ORGX_BASE_URL ||
    "https://www.useorgx.com";

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
        | { ok?: boolean; data?: T; error?: string }
        | null;

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          error:
            payload?.error ||
            `OrgX request failed (${response.status})`,
        };
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

  let syncTimer: ReturnType<typeof setInterval> | null = null;

  async function doSync(): Promise<void> {
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
      api.log?.info?.("[orgx] Starting sync service", {
        interval: config.syncIntervalMs,
      });
      await doSync();
      syncTimer = setInterval(doSync, config.syncIntervalMs);
    },
    stop: async () => {
      if (syncTimer) clearInterval(syncTimer);
      syncTimer = null;
    },
  });

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
          const entity = await client.createEntity(type as string, data);
          return json(
            `✅ Created ${type}: ${entity.title ?? entity.id}`,
            entity
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
