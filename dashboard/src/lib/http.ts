import {
  buildWorkspaceScopeHeaders,
  readWorkspaceScopeIdFromLocation,
} from '@/lib/workspaceScope';

export function buildOrgxHeaders(opts: {
  authToken?: string | null;
  embedMode?: boolean;
  contentTypeJson?: boolean;
  workspaceId?: string | null;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (opts.contentTypeJson) headers['Content-Type'] = 'application/json';
  if (opts.embedMode) headers['X-Orgx-Embed'] = 'true';
  if (opts.authToken) headers.Authorization = `Bearer ${opts.authToken}`;
  const workspaceId = opts.workspaceId ?? readWorkspaceScopeIdFromLocation();
  Object.assign(headers, buildWorkspaceScopeHeaders(workspaceId));
  return headers;
}
