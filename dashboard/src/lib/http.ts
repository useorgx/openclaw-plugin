export function buildOrgxHeaders(opts: {
  authToken?: string | null;
  embedMode?: boolean;
  contentTypeJson?: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (opts.contentTypeJson) headers['Content-Type'] = 'application/json';
  if (opts.embedMode) headers['X-Orgx-Embed'] = 'true';
  if (opts.authToken) headers.Authorization = `Bearer ${opts.authToken}`;
  return headers;
}

