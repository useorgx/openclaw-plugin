type ScopeLike = URLSearchParams | Record<string, unknown> | null | undefined;

type ResolveOptions = {
  allowProjectScope?: boolean;
};

type ScopeResolution = {
  workspaceId: string | null;
  error?: string;
  usedLegacyProjectScope?: boolean;
  isAll?: boolean;
};

const ALL_SCOPE_TOKENS = new Set(["all", "__all__", "*"]);

function normalizeScopeId(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalized = normalizeScopeId(entry);
      if (normalized) return normalized;
    }
    return null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readScopeValue(input: ScopeLike, keys: string[]): string | null {
  if (!input) return null;
  if (input instanceof URLSearchParams) {
    for (const key of keys) {
      const value = normalizeScopeId(input.get(key));
      if (value) return value;
    }
    return null;
  }

  for (const key of keys) {
    const value = normalizeScopeId((input as Record<string, unknown>)[key]);
    if (value) return value;
  }
  return null;
}

function isAllScopeToken(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return ALL_SCOPE_TOKENS.has(normalized);
}

function readWorkspaceCandidates(input: ScopeLike): {
  workspaceId: string | null;
  commandCenterId: string | null;
  centerId: string | null;
  projectId: string | null;
} {
  return {
    workspaceId: readScopeValue(input, [
      "workspace_id",
      "workspaceId",
      "x-orgx-workspace-id",
      "x_orgx_workspace_id",
    ]),
    commandCenterId: readScopeValue(input, [
      "command_center_id",
      "commandCenterId",
      "x-orgx-command-center-id",
      "x_orgx_command_center_id",
    ]),
    centerId: readScopeValue(input, ["center"]),
    projectId: readScopeValue(input, ["project_id", "projectId"]),
  };
}

export function workspaceScopeFromHeaders(
  headers: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!headers || typeof headers !== "object") return null;
  const workspaceId = readScopeValue(headers, [
    "workspace_id",
    "workspaceId",
    "x-orgx-workspace-id",
    "x_orgx_workspace_id",
  ]);
  const commandCenterId = readScopeValue(headers, [
    "command_center_id",
    "commandCenterId",
    "x-orgx-command-center-id",
    "x_orgx_command_center_id",
  ]);
  const centerId = readScopeValue(headers, ["center"]);
  if (workspaceId && commandCenterId && workspaceId !== commandCenterId) {
    return {
      workspace_id: workspaceId,
      command_center_id: commandCenterId,
      center: centerId ?? workspaceId,
    };
  }

  const canonical = workspaceId ?? commandCenterId ?? centerId;
  if (!canonical) return null;
  return {
    workspace_id: canonical,
    command_center_id: canonical,
    center: centerId ?? canonical,
  };
}

function mergeCandidates(
  payloadCandidates: ReturnType<typeof readWorkspaceCandidates>,
  queryCandidates: ReturnType<typeof readWorkspaceCandidates>
): ReturnType<typeof readWorkspaceCandidates> {
  return {
    workspaceId: payloadCandidates.workspaceId ?? queryCandidates.workspaceId,
    commandCenterId:
      payloadCandidates.commandCenterId ?? queryCandidates.commandCenterId,
    centerId: payloadCandidates.centerId ?? queryCandidates.centerId,
    projectId: payloadCandidates.projectId ?? queryCandidates.projectId,
  };
}

export function resolveWorkspaceScope(
  query: URLSearchParams,
  payload?: Record<string, unknown> | null,
  options?: ResolveOptions
): ScopeResolution {
  const merged = mergeCandidates(
    readWorkspaceCandidates(payload ?? null),
    readWorkspaceCandidates(query)
  );

  const allowProjectScope = Boolean(options?.allowProjectScope);

  const canonical = merged.workspaceId ?? merged.commandCenterId ?? merged.centerId;

  if (
    merged.workspaceId &&
    merged.commandCenterId &&
    merged.workspaceId !== merged.commandCenterId
  ) {
    return {
      workspaceId: null,
      error:
        "workspace_id and command_center_id must match when both are provided",
    };
  }

  if (canonical && merged.centerId && canonical !== merged.centerId) {
    return {
      workspaceId: null,
      error: "center must match workspace_id/command_center_id when combined",
    };
  }

  if (canonical && merged.projectId && canonical !== merged.projectId) {
    return {
      workspaceId: null,
      error:
        "project_id cannot be combined with a different workspace scope identifier",
    };
  }

  if (canonical && isAllScopeToken(canonical)) {
    return {
      workspaceId: null,
      isAll: true,
    };
  }

  if (canonical) {
    return { workspaceId: canonical };
  }

  if (merged.projectId) {
    if (isAllScopeToken(merged.projectId)) {
      return {
        workspaceId: null,
        isAll: true,
      };
    }
    if (!allowProjectScope) {
      return {
        workspaceId: null,
        error:
          "project_id is no longer accepted for workspace scope; use workspace_id (or command_center_id alias)",
      };
    }
    return {
      workspaceId: merged.projectId,
      usedLegacyProjectScope: true,
    };
  }

  return { workspaceId: null };
}

export function setCanonicalWorkspaceScopeParams(
  params: URLSearchParams,
  workspaceId: string | null | undefined,
  options?: {
    allTokenWhenMissing?: boolean;
  }
): void {
  params.delete("project_id");
  params.delete("projectId");
  const normalized = normalizeScopeId(workspaceId);
  if (!normalized) {
    if (options?.allTokenWhenMissing) {
      params.set("workspace_id", "all");
      params.set("command_center_id", "all");
      params.set("center", "all");
    } else {
      params.delete("workspace_id");
      params.delete("command_center_id");
      params.delete("center");
    }
    return;
  }
  params.set("workspace_id", normalized);
  params.set("command_center_id", normalized);
  params.set("center", normalized);
}
