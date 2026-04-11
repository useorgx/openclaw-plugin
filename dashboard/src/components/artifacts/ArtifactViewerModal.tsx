import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Modal } from '@/components/shared/Modal';
import { colors } from '@/lib/tokens';
import { queryKeys } from '@/lib/queryKeys';
import { buildOrgxHeaders } from '@/lib/http';
import { useArtifactViewer } from './ArtifactViewerContext';
import { MarkdownText } from '@/components/shared/MarkdownText';
import { Skeleton } from '@/components/shared/Skeleton';
import { Pill } from '@/components/shared/Pill';

interface ArtifactData {
  id: string;
  name: string;
  description: string | null;
  artifact_url: string;
  artifact_type: string;
  status: string;
  version: number;
  entity_type: string;
  entity_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  catalog?: {
    label: string;
    domain: string;
    stage: string;
  } | null;
  cached_metadata?: {
    title?: string;
    description?: string;
    thumbnail_url?: string;
  } | null;
}

interface ArtifactDetailResponse {
  artifact: ArtifactData;
  relationships: Array<{
    id: string;
    to_artifact_id: string;
    relationship_type: string;
  }>;
  localFallback?: boolean;
  warning?: string | null;
}

const statusColors: Record<string, string> = {
  draft: colors.textMuted,
  in_review: colors.amber,
  approved: colors.lime,
  changes_requested: colors.red,
  superseded: colors.textMuted,
  archived: colors.textMuted,
};

const statusLabels: Record<string, string> = {
  draft: 'Draft',
  in_review: 'In Review',
  approved: 'Approved',
  changes_requested: 'Changes Requested',
  superseded: 'Superseded',
  archived: 'Archived',
};

function normalizeArtifactLink(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('file://')) {
    try {
      const fileUrl = new URL(trimmed);
      return `/orgx/api/live/filesystem/open?path=${encodeURIComponent(
        decodeURIComponent(fileUrl.pathname)
      )}`;
    } catch {
      return trimmed;
    }
  }
  if (trimmed.startsWith('/')) {
    return `/orgx/api/live/filesystem/open?path=${encodeURIComponent(trimmed)}`;
  }
  return trimmed;
}

function ArtifactIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.cyan}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </svg>
  );
}

export function ArtifactViewerModal() {
  const { state, close } = useArtifactViewer();
  // The artifact viewer is mounted globally (outside MissionControlProvider),
  // so it must not depend on Mission Control context.
  const authToken: string | null = null;
  const embedMode = false;
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  const { data, isLoading, isFetching, error, refetch } = useQuery<ArtifactDetailResponse>({
    queryKey: queryKeys.artifactDetail({
      artifactId: state.artifactId ?? '',
      authToken,
      embedMode,
    }),
    enabled: Boolean(state.artifactId),
    queryFn: async () => {
      const headers = buildOrgxHeaders({ authToken, embedMode });
      const response = await fetch(
        `/orgx/api/artifacts/${encodeURIComponent(state.artifactId!)}`,
        { headers }
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | {
              error?: string | { code?: string; message?: string };
              message?: string;
            }
          | null;
        const errorText =
          (typeof payload?.error === 'string' ? payload.error : null) ??
          (payload?.error &&
          typeof payload.error === 'object' &&
          typeof payload.error.message === 'string'
            ? payload.error.message
            : null) ??
          (typeof payload?.message === 'string' ? payload.message : null);
        const fallback =
          response.status === 401
            ? 'Authentication required to view this artifact.'
            : `Failed to fetch artifact (${response.status}).`;
        throw new Error(errorText?.trim().length ? errorText.trim() : fallback);
      }
      return response.json();
    },
  });

  const artifact = data?.artifact;
  const isLocalFallback =
    data?.localFallback === true ||
    (artifact?.metadata?.local_fallback as boolean | undefined) === true;
  const localFallbackWarning =
    (typeof data?.warning === 'string' && data.warning.trim().length > 0
      ? data.warning
      : (artifact?.metadata?.local_warning as string | undefined)) ?? null;
  const previewMarkdown =
    (artifact?.metadata?.preview_markdown as string) ?? null;
  const fallbackSourcePath = useMemo(() => {
    if (!artifact?.metadata) return null;
    const candidates = [
      artifact.metadata.local_source_path,
      artifact.metadata.url,
      artifact.metadata.path,
      artifact.metadata.file_path,
      artifact.metadata.filepath,
      artifact.metadata.artifact_path,
      artifact.metadata.output_path,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    return null;
  }, [artifact?.metadata]);
  const fallbackSourceHref = useMemo(() => {
    if (!fallbackSourcePath) return null;
    if (/^https?:\/\//i.test(fallbackSourcePath)) return fallbackSourcePath;
    return `/orgx/api/live/filesystem/open?path=${encodeURIComponent(fallbackSourcePath)}`;
  }, [fallbackSourcePath]);
  const externalUrl = useMemo(
    () =>
      normalizeArtifactLink(
        ((artifact?.metadata?.external_url as string | undefined) ??
          artifact?.artifact_url) as string | null | undefined
      ),
    [artifact?.artifact_url, artifact?.metadata]
  );

  useEffect(() => {
    if (!copyNotice) return undefined;
    const timer = window.setTimeout(() => setCopyNotice(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copyNotice]);

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyNotice(`${label} copied`);
    } catch {
      setCopyNotice('Copy failed');
    }
  };

  return (
    <Modal open={Boolean(state.artifactId)} onClose={close} maxWidth="max-w-3xl">
      {isLoading && (
        <div className="p-6 space-y-4">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {error && (
        <div className="space-y-4 p-6">
          <div className="rounded-xl border border-red-300/22 bg-red-500/[0.08] p-4">
            <p className="text-body font-semibold text-red-200">Failed to load artifact</p>
            <p className="mt-1 text-caption leading-relaxed text-red-100/80">{error.message}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={close}
              className="rounded-full border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.08]"
            >
              Back to activity
            </button>
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="rounded-full border border-red-300/22 bg-red-500/[0.08] px-3 py-1.5 text-caption font-semibold text-red-100 transition-colors hover:bg-red-500/[0.14] disabled:opacity-45"
            >
              {isFetching ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        </div>
      )}

      {artifact && (
        <>
          {/* Header */}
          <div className="flex items-center justify-between border-b border-subtle px-5 py-4 sm:px-6">
            <div className="flex items-center gap-3 min-w-0">
              <ArtifactIcon />
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium text-white">
                  {artifact.name}
                </h3>
                <div className="flex items-center gap-2 mt-0.5">
                  {/* Type badge */}
                  <Pill tone="muted" className="text-micro uppercase tracking-[0.06em]">
                    {artifact.catalog?.label ?? artifact.artifact_type}
                  </Pill>
                  {/* Status badge */}
                  <Pill
                    tone="neutral"
                    className="text-micro font-semibold uppercase tracking-[0.06em]"
                    style={{
                      color: statusColors[artifact.status] ?? colors.textMuted,
                      backgroundColor: `${statusColors[artifact.status] ?? colors.textMuted}20`,
                      borderColor: `${statusColors[artifact.status] ?? colors.textMuted}44`,
                    }}
                  >
                    {statusLabels[artifact.status] ?? artifact.status}
                  </Pill>
                  {artifact.catalog?.domain && (
                    <span className="text-micro text-faint">
                      {artifact.catalog.domain} / {artifact.catalog.stage}
                    </span>
                  )}
                  {copyNotice && (
                    <Pill tone="neutral" className="text-micro text-secondary">
                      {copyNotice}
                    </Pill>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {externalUrl && (
                <a
                  href={externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg p-2 text-secondary transition-colors hover:bg-white/[0.08] hover:text-white"
                  title="Open source"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M15 3h6v6" />
                    <path d="M10 14 21 3" />
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  </svg>
                </a>
              )}
              <button
                onClick={close}
                className="p-2 rounded-lg hover:bg-white/[0.06] text-secondary hover:text-white transition-colors"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="max-h-[65vh] overflow-y-auto px-5 py-4 sm:px-6 space-y-4">
            {isLocalFallback && (
              <div className="rounded-xl border border-amber-300/25 bg-amber-500/[0.09] p-4">
                <p className="text-caption font-semibold uppercase tracking-[0.08em] text-amber-100/90">
                  Local fallback artifact
                </p>
                <p className="mt-1 text-body text-amber-50/90">
                  This artifact is buffered locally because OrgX registration is currently unavailable.
                </p>
                {localFallbackWarning && (
                  <p className="mt-1.5 text-caption text-amber-100/70">
                    Upstream error: {localFallbackWarning}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {fallbackSourceHref && (
                    <a
                      href={fallbackSourceHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-full border border-amber-200/25 bg-black/25 px-3 py-1 text-caption font-semibold text-amber-100 transition-colors hover:bg-black/35"
                    >
                      Open local artifact
                    </a>
                  )}
                  {fallbackSourcePath && (
                    <button
                      type="button"
                      onClick={() => void copyText(fallbackSourcePath, 'Artifact path')}
                      className="rounded-full border border-amber-200/25 bg-black/20 px-3 py-1 text-caption font-semibold text-amber-100 transition-colors hover:bg-black/35"
                    >
                      Copy path
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Description */}
            {artifact.description && (
              <div>
                <p className="text-body leading-relaxed text-primary">
                  {artifact.description}
                </p>
              </div>
            )}

            {/* Preview markdown */}
            {previewMarkdown && (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <MarkdownText
                  mode="block"
                  text={previewMarkdown}
                  className="text-body leading-relaxed text-primary"
                />
              </div>
            )}

            {/* No preview */}
            {!artifact.description && !previewMarkdown && (
              <div className="py-12 text-center text-muted">
                <svg
                  className="mx-auto mb-3 opacity-50"
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                  <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                </svg>
                <p className="text-sm">No preview available</p>
              </div>
            )}

            {/* Metadata details */}
            <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-micro text-faint">
              <span>Entity: {artifact.entity_type}/{artifact.entity_id.slice(0, 8)}</span>
              <span>Version: {artifact.version}</span>
              <span>
                Updated:{' '}
                {new Date(artifact.updated_at).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </span>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
