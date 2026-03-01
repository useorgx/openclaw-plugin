import { spawn } from "node:child_process";

import type { OrgXClient } from "../../api.js";
import { readByokKeys } from "../../byok-store.js";
import { parseJsonSafe } from "../../json-utils.js";
import {
  readOpenClawSettingsSnapshot,
  resolvePreferredOpenClawProvider,
} from "../../openclaw-settings.js";
import type { BillingStatus } from "../../types.js";

export type OpenClawProvider = "anthropic" | "openrouter" | "openai";

export function resolveByokEnvOverrides(): Record<string, string> {
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

export function modelImpliesByok(model: string | null): boolean {
  const lower = (model ?? "").trim().toLowerCase();
  if (!lower) return false;
  return (
    lower.includes("openrouter") ||
    lower.includes("anthropic") ||
    lower.includes("openai")
  );
}

export async function fetchBillingStatusSafe(
  client: OrgXClient
): Promise<BillingStatus | null> {
  try {
    return await client.getBillingStatus();
  } catch {
    return null;
  }
}

export async function listOpenClawAgents(): Promise<Array<Record<string, unknown>>> {
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
  return parsed.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === "object")
  );
}

export function spawnOpenClawAgentTurn(input: {
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

export function normalizeOpenClawProvider(value: string | null): OpenClawProvider | null {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "auto") return null;
  if (raw === "claude") return "anthropic";
  if (raw === "anthropic") return "anthropic";
  if (raw === "openrouter" || raw === "open-router") return "openrouter";
  if (raw === "openai" || raw === "openai-codex") return "openai";
  return null;
}

async function setOpenClawAgentModel(input: {
  agentId: string;
  model: string;
}): Promise<void> {
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

export async function listOpenClawProviderModels(input: {
  agentId: string;
  provider: OpenClawProvider;
}): Promise<Array<{ key: string; tags: string[] }>> {
  const providerArgs =
    input.provider === "openai" ? ["openai-codex", "openai"] : [input.provider];
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

function pickPreferredModel(
  models: Array<{ key: string; tags: string[] }>
): string | null {
  if (models.length === 0) return null;
  const preferred = models.find((m) => m.tags.some((t) => t === "default"));
  return preferred?.key ?? models[0]?.key ?? null;
}

export async function configureOpenClawProviderRouting(input: {
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

export function resolveAutoOpenClawProvider(): OpenClawProvider | null {
  try {
    const settings = readOpenClawSettingsSnapshot();
    const provider = resolvePreferredOpenClawProvider(settings.raw);
    if (!provider) return null;
    return provider;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopDetachedProcess(
  pid: number
): Promise<{ stopped: boolean; wasRunning: boolean }> {
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
