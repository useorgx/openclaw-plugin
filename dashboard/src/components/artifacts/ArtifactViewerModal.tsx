import { useQuery } from '@tanstack/react-query';
import { Modal } from '@/components/shared/Modal';
import { colors } from '@/lib/tokens';
import { queryKeys } from '@/lib/queryKeys';
import { buildOrgxHeaders } from '@/lib/http';
import { useArtifactViewer } from './ArtifactViewerContext';
import { useMissionControl } from '@/components/mission-control/MissionControlContext';
import { MarkdownText } from '@/components/shared/MarkdownText';
import { Skeleton } from '@/components/shared/Skeleton';

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
  const { authToken, embedMode } = useMissionControl();

  const { data, isLoading, error } = useQuery<ArtifactDetailResponse>({
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
        throw new Error(`Failed to fetch artifact: ${response.status}`);
      }
      return response.json();
    },
  });

  const artifact = data?.artifact;
  const previewMarkdown =
    (artifact?.metadata?.preview_markdown as string) ?? null;
  const externalUrl =
    (artifact?.metadata?.external_url as string) ?? artifact?.artifact_url;

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
        <div className="p-6">
          <p className="text-body text-red-400">
            Failed to load artifact: {error.message}
          </p>
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
                  <span className="rounded-full border border-white/[0.1] bg-white/[0.04] px-2 py-0.5 text-micro uppercase tracking-wider text-secondary">
                    {artifact.catalog?.label ?? artifact.artifact_type}
                  </span>
                  {/* Status badge */}
                  <span
                    className="rounded-full px-2 py-0.5 text-micro font-medium uppercase tracking-wider"
                    style={{
                      color: statusColors[artifact.status] ?? colors.textMuted,
                      backgroundColor: `${statusColors[artifact.status] ?? colors.textMuted}15`,
                    }}
                  >
                    {statusLabels[artifact.status] ?? artifact.status}
                  </span>
                  {artifact.catalog?.domain && (
                    <span className="text-micro text-faint">
                      {artifact.catalog.domain} / {artifact.catalog.stage}
                    </span>
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
