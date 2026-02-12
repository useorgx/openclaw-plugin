import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getOpenClawDir } from "./paths.js";

export type OpenClawProvider = "anthropic" | "openrouter" | "openai";

export interface OpenClawSettingsSnapshot {
  path: string;
  raw: Record<string, unknown> | null;
}

export interface OpenClawProviderModelStats {
  provider: OpenClawProvider;
  total: number;
  sonnetCount: number;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function readOpenClawSettingsSnapshot(): OpenClawSettingsSnapshot {
  const path = join(getOpenClawDir(), "openclaw.json");
  if (!existsSync(path)) {
    return { path, raw: null };
  }

  try {
    const rawText = readFileSync(path, "utf8");
    return { path, raw: parseJsonObject(rawText) };
  } catch {
    return { path, raw: null };
  }
}

export function listOpenClawConfiguredModelKeys(raw: Record<string, unknown> | null): string[] {
  if (!raw) return [];
  const agents = readObject(raw.agents);
  const defaults = readObject(agents.defaults);
  const models = readObject(defaults.models);
  const keys = Object.keys(models)
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  keys.sort((a, b) => a.localeCompare(b));
  return keys;
}

export function classifyProviderFromModelKey(modelKey: string): OpenClawProvider | null {
  const normalized = modelKey.trim().toLowerCase();
  if (!normalized) return null;

  if (normalized.startsWith("openrouter/")) return "openrouter";
  if (normalized.startsWith("anthropic/") || normalized.startsWith("claude/")) {
    return "anthropic";
  }
  if (
    normalized.startsWith("openai/") ||
    normalized.startsWith("openai-") ||
    normalized.startsWith("gpt")
  ) {
    return "openai";
  }

  return null;
}

export function summarizeOpenClawProviderModels(raw: Record<string, unknown> | null): Record<
  OpenClawProvider,
  OpenClawProviderModelStats
> {
  const summary: Record<OpenClawProvider, OpenClawProviderModelStats> = {
    anthropic: { provider: "anthropic", total: 0, sonnetCount: 0 },
    openrouter: { provider: "openrouter", total: 0, sonnetCount: 0 },
    openai: { provider: "openai", total: 0, sonnetCount: 0 },
  };

  for (const key of listOpenClawConfiguredModelKeys(raw)) {
    const provider = classifyProviderFromModelKey(key);
    if (!provider) continue;
    const bucket = summary[provider];
    bucket.total += 1;
    if (key.toLowerCase().includes("sonnet")) {
      bucket.sonnetCount += 1;
    }
  }

  return summary;
}

export function resolvePreferredOpenClawProvider(raw: Record<string, unknown> | null): OpenClawProvider | null {
  const summary = summarizeOpenClawProviderModels(raw);

  const order: OpenClawProvider[] = ["openrouter", "anthropic", "openai"];
  for (const provider of order) {
    if (summary[provider].sonnetCount > 0) {
      return provider;
    }
  }

  for (const provider of order) {
    if (summary[provider].total > 0) {
      return provider;
    }
  }

  return null;
}

export function readOpenClawPrimaryModel(raw: Record<string, unknown> | null): string | null {
  if (!raw) return null;
  const agents = readObject(raw.agents);
  const defaults = readObject(agents.defaults);
  const model = readObject(defaults.model);
  const primary = typeof model.primary === "string" ? model.primary.trim() : "";
  return primary || null;
}

export function readOpenClawGatewayPort(raw: Record<string, unknown> | null): number {
  if (!raw) return 18789;
  const gateway = readObject(raw.gateway);
  const port = gateway.port;
  if (typeof port === "number" && Number.isFinite(port) && port > 0) {
    return Math.floor(port);
  }
  if (typeof port === "string") {
    const parsed = Number.parseInt(port, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 18789;
}
