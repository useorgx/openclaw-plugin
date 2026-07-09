import type { OnboardingState } from "../types.js";
import type { PluginApiLike, ResolvedConfig } from "./resolution.js";

type AuthStoreState = {
  apiKey?: string | null;
  userId?: string | null;
  workspaceId?: string | null;
} | null;

type RefreshInput = {
  reason?: string;
  allowApiKeyChanges?: boolean;
};

type RefreshDeps = {
  api: PluginApiLike;
  config: ResolvedConfig;
  loadAuthStore: () => AuthStoreState;
  resolveConfig: (
    api: PluginApiLike,
    input: {
      installationId: string;
      persistedApiKey: string | null;
      persistedUserId: string | null;
      persistedWorkspaceId?: string | null;
    }
  ) => ResolvedConfig;
  updateOnboardingState: (updates: Partial<OnboardingState>) => unknown;
  setCredentials: (input: {
    apiKey: string;
    userId: string;
    baseUrl: string;
    apiFallbackUrl?: string;
  }) => void;
  logInfo?: (message: string, meta?: Record<string, unknown>) => void;
};

export function refreshResolvedConfig(
  deps: RefreshDeps,
  input?: RefreshInput
): { changed: boolean; baseApiUrl: string } {
  const allowApiKeyChanges = input?.allowApiKeyChanges !== false;
  const previousApiKey = deps.config.apiKey;
  const previousBaseUrl = deps.config.baseUrl;
  const previousApiFallbackUrl = deps.config.apiFallbackUrl;
  const previousUserId = deps.config.userId;
  const previousWorkspaceId = deps.config.workspaceId;
  const previousDocsUrl = deps.config.docsUrl;
  const previousKeySource = deps.config.apiKeySource;

  const latestPersisted = deps.loadAuthStore();
  const next = deps.resolveConfig(deps.api, {
    installationId: deps.config.installationId,
    persistedApiKey: latestPersisted?.apiKey ?? null,
    persistedUserId: latestPersisted?.userId ?? null,
    persistedWorkspaceId: latestPersisted?.workspaceId ?? null,
  });

  const nextApiKey = allowApiKeyChanges ? next.apiKey : previousApiKey;
  const nextUserId = allowApiKeyChanges ? next.userId : previousUserId;

  const changed =
    nextApiKey !== previousApiKey ||
    next.baseUrl !== previousBaseUrl ||
    next.apiFallbackUrl !== previousApiFallbackUrl ||
    nextUserId !== previousUserId ||
    next.workspaceId !== previousWorkspaceId ||
    next.docsUrl !== previousDocsUrl ||
    next.apiKeySource !== previousKeySource;

  if (!changed) {
    return {
      changed: false,
      baseApiUrl: deps.config.baseUrl.replace(/\/+$/, ""),
    };
  }

  if (allowApiKeyChanges) {
    deps.config.apiKey = nextApiKey;
    deps.config.userId = nextUserId;
    deps.config.apiKeySource = next.apiKeySource;
    deps.config.workspaceId = next.workspaceId;
  }
  deps.config.baseUrl = next.baseUrl;
  deps.config.apiFallbackUrl = next.apiFallbackUrl;
  deps.config.docsUrl = next.docsUrl;

  deps.setCredentials({
    apiKey: deps.config.apiKey,
    userId: deps.config.userId,
    baseUrl: deps.config.baseUrl,
    apiFallbackUrl: deps.config.apiFallbackUrl,
  });

  deps.updateOnboardingState({
    hasApiKey: Boolean(deps.config.apiKey),
    keySource: deps.config.apiKeySource,
    docsUrl: deps.config.docsUrl,
    installationId: deps.config.installationId,
  });

  deps.logInfo?.("[orgx] Config refreshed", {
    reason: input?.reason ?? "runtime_refresh",
    baseUrl: deps.config.baseUrl,
    hasApiKey: Boolean(deps.config.apiKey),
    apiKeySource: deps.config.apiKeySource,
  });

  return {
    changed: true,
    baseApiUrl: deps.config.baseUrl.replace(/\/+$/, ""),
  };
}
