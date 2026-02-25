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
): void {
  const normalized = normalizeWorkspaceScopeId(workspaceId);
  if (!normalized) return;
  params.set('workspace_id', normalized);
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
