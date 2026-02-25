const ALL_WORKSPACE_SCOPE_TOKEN = 'all';

function normalizeWorkspaceScopeId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readWorkspaceScopeIdFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    return (
      normalizeWorkspaceScopeId(params.get('workspace_id')) ??
      normalizeWorkspaceScopeId(params.get('workspaceId')) ??
      normalizeWorkspaceScopeId(params.get('command_center_id')) ??
      normalizeWorkspaceScopeId(params.get('commandCenterId')) ??
      normalizeWorkspaceScopeId(params.get('center')) ??
      normalizeWorkspaceScopeId(params.get('project_id')) ??
      normalizeWorkspaceScopeId(params.get('projectId'))
    );
  } catch {
    return null;
  }
}

export function appendWorkspaceScopeParams(
  params: URLSearchParams,
  workspaceId: string | null | undefined,
  options?: { allTokenWhenMissing?: boolean },
): void {
  const normalized = normalizeWorkspaceScopeId(workspaceId);
  if (!normalized) {
    if (options?.allTokenWhenMissing) {
      params.set('workspace_id', ALL_WORKSPACE_SCOPE_TOKEN);
      params.set('command_center_id', ALL_WORKSPACE_SCOPE_TOKEN);
      params.set('center', ALL_WORKSPACE_SCOPE_TOKEN);
    }
    return;
  }
  params.set('workspace_id', normalized);
  params.set('command_center_id', normalized);
  params.set('center', normalized);
}

export function buildWorkspaceScopeHeaders(
  workspaceId: string | null | undefined
): Record<string, string> {
  const normalized = normalizeWorkspaceScopeId(workspaceId);
  if (!normalized) return {};
  return {
    'x-orgx-workspace-id': normalized,
  };
}
