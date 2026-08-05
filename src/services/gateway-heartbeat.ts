import { spawnSync } from "node:child_process";
import { hostname } from "node:os";

import type { OrgXClient } from "../api.js";
import { sanitizedChildProcessEnv } from "../child-process-env.js";

const HEARTBEAT_INTERVAL_MS = 45_000;
const DETECTION_CACHE_MS = 30_000;

type LoggerLike = {
  info?: (message: string, metadata?: Record<string, unknown>) => void;
  warn?: (message: string, metadata?: Record<string, unknown>) => void;
  debug?: (message: string, metadata?: Record<string, unknown>) => void;
};

type ServiceApi = {
  registerService: (service: {
    id: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }) => void;
  log?: LoggerLike;
};

export type SubscriptionRuntime = {
  pluginId: "orgx-codex-plugin" | "orgx-claude-code-plugin";
  driver: "codex" | "claude_code";
  runtime: "codex" | "claude-code";
  planTier: string;
  subscriptionType: string;
  version: string | null;
};

function commandResult(command: string, args: string[]) {
  const { ANTHROPIC_API_KEY: _anthropic, OPENAI_API_KEY: _openai, ...env } =
    process.env;
  return spawnSync(command, args, {
    encoding: "utf8",
    env: sanitizedChildProcessEnv(env),
    timeout: 5_000,
  });
}

function commandVersion(command: string): string | null {
  const result = commandResult(command, ["--version"]);
  if (result.status !== 0) return null;
  const value = String(result.stdout || result.stderr || "").trim();
  return value ? value.slice(0, 120) : null;
}

export function detectSubscriptionRuntimes(): SubscriptionRuntime[] {
  const runtimes: SubscriptionRuntime[] = [];
  const codex = commandResult("codex", ["login", "status"]);
  const codexStatus = `${codex.stdout ?? ""}\n${codex.stderr ?? ""}`;
  if (codex.status === 0 && /logged in using chatgpt/i.test(codexStatus)) {
    runtimes.push({
      pluginId: "orgx-codex-plugin",
      driver: "codex",
      runtime: "codex",
      planTier: "chatgpt",
      subscriptionType: "chatgpt",
      version: commandVersion("codex"),
    });
  }

  const claude = commandResult("claude", ["auth", "status"]);
  if (claude.status === 0) {
    try {
      const status = JSON.parse(String(claude.stdout || "{}")) as {
        loggedIn?: unknown;
        authMethod?: unknown;
        subscriptionType?: unknown;
      };
      if (status.loggedIn === true && status.authMethod === "claude.ai") {
        const subscriptionType =
          typeof status.subscriptionType === "string"
            ? status.subscriptionType
            : "claude.ai";
        runtimes.push({
          pluginId: "orgx-claude-code-plugin",
          driver: "claude_code",
          runtime: "claude-code",
          planTier: subscriptionType,
          subscriptionType,
          version: commandVersion("claude"),
        });
      }
    } catch {
      // Invalid status output means the runtime is not trusted for routing.
    }
  }

  return runtimes;
}

export function buildGatewayHeartbeatPayloads(input: {
  workspaceId: string;
  installationId: string;
  pluginVersion: string;
  gatewayVersion: string;
  runtimes: SubscriptionRuntime[];
}) {
  const machine = hostname();
  return input.runtimes.map((runtime) => ({
    workspace_id: input.workspaceId,
    plugin_id: runtime.pluginId,
    installation_id: `${input.installationId}:${runtime.pluginId}`,
    host_platform: process.platform,
    drivers_installed: [runtime.driver],
    gateway_version: input.gatewayVersion,
    plan_tier: runtime.planTier,
    subscription_type: runtime.subscriptionType,
    subscription_active: true,
    capacity_windows: [],
    metadata: {
      sourcePlugin: "orgx-openclaw-plugin",
      pluginVersion: input.pluginVersion,
      runtime: runtime.runtime,
      runtimeVersion: runtime.version,
      machine,
    },
  }));
}

export function registerGatewayHeartbeatService(input: {
  api: ServiceApi;
  client: OrgXClient;
  installationId: string;
  pluginVersion: string;
  gatewayVersion: string;
  getWorkspaceId: () => string | null;
  hasApiKey: () => boolean;
}): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let cachedRuntimes: SubscriptionRuntime[] = [];
  let detectedAt = 0;

  const schedule = () => {
    if (!running) return;
    timer = setTimeout(async () => {
      try {
        await heartbeat();
      } finally {
        schedule();
      }
    }, HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
  };

  const heartbeat = async () => {
    const workspaceId = input.getWorkspaceId();
    if (!workspaceId || !input.hasApiKey()) return;
    if (Date.now() - detectedAt >= DETECTION_CACHE_MS) {
      cachedRuntimes = detectSubscriptionRuntimes();
      detectedAt = Date.now();
    }
    const payloads = buildGatewayHeartbeatPayloads({
      workspaceId,
      installationId: input.installationId,
      pluginVersion: input.pluginVersion,
      gatewayVersion: input.gatewayVersion,
      runtimes: cachedRuntimes,
    });
    if (!payloads.length) {
      input.api.log?.debug?.("[orgx] No authenticated subscription runtimes detected");
      return;
    }

    const settled = await Promise.allSettled(
      payloads.map((payload) => input.client.sendGatewayHeartbeat(payload))
    );
    const failures = settled.filter((result) => result.status === "rejected");
    if (failures.length) {
      input.api.log?.warn?.("[orgx] Gateway heartbeat failed", {
        failed: failures.length,
        total: settled.length,
      });
    }
  };

  input.api.registerService({
    id: "orgx-gateway-heartbeat",
    start: async () => {
      running = true;
      await heartbeat();
      schedule();
    },
    stop: async () => {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  });
}
