import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { OrgXConfig } from "../types.js";

export interface ResolvedConfig extends OrgXConfig {
  dashboardEnabled: boolean;
  installationId: string;
  pluginVersion: string;
  docsUrl: string;
  apiKeySource:
    | "config"
    | "environment"
    | "persisted"
    | "openclaw-config-file"
    | "none";
}

interface ResolvedApiKey {
  value: string;
  source:
    | "config"
    | "environment"
    | "persisted"
    | "openclaw-config-file"
    | "none";
}

export interface PluginApiLike {
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
}

const DEFAULT_BASE_URL = "https://www.useorgx.com";
const DEFAULT_DOCS_URL = "https://orgx.mintlify.site/guides/openclaw-plugin-setup";

export function isUserScopedApiKey(apiKey: string): boolean {
  return apiKey.trim().toLowerCase().startsWith("oxk_");
}

export function resolveRuntimeUserId(
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

export function normalizeBaseUrl(raw: string | undefined): string {
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

function normalizeOptionalBaseUrl(raw: string | undefined): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  const normalized = normalizeBaseUrl(raw);
  return normalized === DEFAULT_BASE_URL && raw.trim() !== DEFAULT_BASE_URL
    ? undefined
    : normalized;
}

export function readOpenClawOrgxConfig(): {
  apiKey: string;
  userId: string;
  workspaceId?: string;
  baseUrl: string;
  apiFallbackUrl?: string;
  enabled?: boolean;
  dashboardEnabled?: boolean;
  autoInstallAgentSuiteOnConnect?: boolean;
  autoConfigureMcpClientsOnConnect?: boolean;
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
    const orgxEntry =
      entries.orgx && typeof entries.orgx === "object"
        ? (entries.orgx as Record<string, unknown>)
        : {};
    const openclawPluginEntry =
      entries["openclaw-plugin"] && typeof entries["openclaw-plugin"] === "object"
        ? (entries["openclaw-plugin"] as Record<string, unknown>)
        : {};
    const orgx = Object.keys(orgxEntry).length > 0 ? orgxEntry : openclawPluginEntry;
    const config =
      orgx.config && typeof orgx.config === "object"
        ? (orgx.config as Record<string, unknown>)
        : {};
    const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
    const userId = typeof config.userId === "string" ? config.userId.trim() : "";
    const workspaceId =
      typeof config.workspaceId === "string" ? config.workspaceId.trim() : "";
    const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl.trim() : "";
    const apiFallbackUrl =
      typeof config.apiFallbackUrl === "string"
        ? config.apiFallbackUrl.trim()
        : typeof config.fallbackBaseUrl === "string"
        ? config.fallbackBaseUrl.trim()
        : "";
    const enabled = typeof orgx.enabled === "boolean" ? orgx.enabled : undefined;
    const dashboardEnabled =
      typeof config.dashboardEnabled === "boolean" ? config.dashboardEnabled : undefined;
    const autoInstallAgentSuiteOnConnect =
      typeof config.autoInstallAgentSuiteOnConnect === "boolean"
        ? config.autoInstallAgentSuiteOnConnect
        : undefined;
    const autoConfigureMcpClientsOnConnect =
      typeof config.autoConfigureMcpClientsOnConnect === "boolean"
        ? config.autoConfigureMcpClientsOnConnect
        : undefined;
    return {
      apiKey,
      userId,
      workspaceId: workspaceId || undefined,
      baseUrl,
      apiFallbackUrl: apiFallbackUrl || undefined,
      enabled,
      dashboardEnabled,
      autoInstallAgentSuiteOnConnect,
      autoConfigureMcpClientsOnConnect,
    };
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

  return { value: "", source: "none" };
}

export function resolvePluginVersion(): string {
  try {
    const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as {
      version?: string;
    };
    return parsed.version && parsed.version.trim().length > 0 ? parsed.version : "dev";
  } catch {
    return "dev";
  }
}

export function resolveDocsUrl(baseUrl: string): string {
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

export function resolveConfig(
  api: PluginApiLike,
  input: {
    installationId: string;
    persistedApiKey: string | null;
    persistedUserId: string | null;
    persistedWorkspaceId?: string | null;
  }
): ResolvedConfig {
  const pluginConf =
    api.config?.plugins?.entries?.orgx?.config ??
    api.config?.plugins?.entries?.["openclaw-plugin"]?.config ??
    {};
  const openclaw = readOpenClawOrgxConfig();

  const apiKeyResolution = resolveApiKey(pluginConf, input.persistedApiKey);
  const apiKey = apiKeyResolution.value;

  const userId = resolveRuntimeUserId(apiKey, [
    pluginConf.userId,
    process.env.ORGX_USER_ID,
    input.persistedUserId,
    openclaw.userId,
  ]);
  const workspaceId =
    pluginConf.workspaceId?.trim() ||
    process.env.ORGX_WORKSPACE_ID?.trim() ||
    input.persistedWorkspaceId?.trim() ||
    openclaw.workspaceId?.trim() ||
    undefined;

  const baseUrl = normalizeBaseUrl(
    pluginConf.baseUrl || process.env.ORGX_BASE_URL || openclaw.baseUrl || DEFAULT_BASE_URL
  );
  const apiFallbackUrl = normalizeOptionalBaseUrl(
    pluginConf.apiFallbackUrl || process.env.ORGX_API_FALLBACK_URL || openclaw.apiFallbackUrl
  );

  return {
    apiKey,
    userId,
    workspaceId,
    baseUrl,
    apiFallbackUrl,
    syncIntervalMs: pluginConf.syncIntervalMs ?? 300_000,
    enabled: pluginConf.enabled ?? openclaw.enabled ?? true,
    autoInstallAgentSuiteOnConnect:
      pluginConf.autoInstallAgentSuiteOnConnect ??
      openclaw.autoInstallAgentSuiteOnConnect ??
      false,
    autoConfigureMcpClientsOnConnect:
      pluginConf.autoConfigureMcpClientsOnConnect ??
      openclaw.autoConfigureMcpClientsOnConnect ??
      false,
    dashboardEnabled: pluginConf.dashboardEnabled ?? openclaw.dashboardEnabled ?? true,
    installationId: input.installationId,
    pluginVersion: resolvePluginVersion(),
    docsUrl: resolveDocsUrl(baseUrl),
    apiKeySource: apiKeyResolution.source,
  };
}
