import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { colors } from '@/lib/tokens';
import { queryKeys } from '@/lib/queryKeys';
import { buildOrgxHeaders } from '@/lib/http';
import { useArtifactViewer } from './ArtifactViewerContext';

interface ArtifactSummary {
  id: string;
  name: string;
  description: string | null;
  artifact_url: string;
  artifact_type: string;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface ArtifactsByEntityResponse {
  artifacts: ArtifactSummary[];
}

interface EntityArtifactsPanelProps {
  entityType: string;
  entityId: string;
  title?: string;
  authToken?: string | null;
  embedMode?: boolean;
  /** When true, only show approved/final artifacts by default */
  finalOnly?: boolean;
  /** For workstream: fetch artifacts for multiple milestone IDs in parallel */
  milestoneIds?: string[];
}

const statusColors: Record<string, string> = {
  draft: colors.textMuted,
  in_review: colors.amber,
  approved: colors.lime,
  changes_requested: colors.red,
  superseded: colors.textMuted,
  archived: colors.textMuted,
};

function ArtifactListIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0 opacity-80"
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  );
}

async function fetchArtifactsByEntity(
  entityType: string,
  entityId: string,
  opts: { authToken?: string | null; embedMode?: boolean }
): Promise<ArtifactSummary[]> {
  try {
    const headers = buildOrgxHeaders(opts);
    const params = new URLSearchParams({
      entity_type: entityType,
      entity_id: entityId,
      limit: '20',
    });
    const res = await fetch(`/orgx/api/work-artifacts/by-entity?${params.toString()}`, { headers });
    if (!res.ok) return [];
    const data = (await res.json()) as ArtifactsByEntityResponse;
    return data?.artifacts ?? [];
  } catch {
    return [];
  }
}

export function EntityArtifactsPanel({
  entityType,
  entityId,
  title = 'Artifacts',
  authToken = null,
  embedMode = false,
  finalOnly = false,
  milestoneIds,
}: EntityArtifactsPanelProps) {
  const { open: openViewer } = useArtifactViewer();
  const [showAll, setShowAll] = useState(!finalOnly);

  // For workstreams: aggregate milestone artifacts
  const isWorkstreamMode = Boolean(milestoneIds?.length);

  // Single-entity query
  const singleQuery = useQuery<ArtifactSummary[]>({
    queryKey: queryKeys.artifactsByEntity({ entityType, entityId, authToken, embedMode }),
    enabled: !isWorkstreamMode && Boolean(entityId),
    queryFn: () => fetchArtifactsByEntity(entityType, entityId, { authToken, embedMode }),
  });

  // Workstream multi-milestone query
  const multiQuery = useQuery<ArtifactSummary[]>({
    queryKey: ['artifacts-by-milestones', milestoneIds, authToken, embedMode],
    enabled: isWorkstreamMode,
    queryFn: async () => {
      if (!milestoneIds?.length) return [];
      const results = await Promise.all(
        milestoneIds.map((mid) =>
          fetchArtifactsByEntity('milestone', mid, { authToken, embedMode })
        )
      );
      // Merge, deduplicate by id, sort by updated_at desc
      const map = new Map<string, ArtifactSummary>();
      for (const batch of results) {
        for (const a of batch) {
          if (!map.has(a.id)) map.set(a.id, a);
        }
      }
      return [...map.values()].sort(
        (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)
      );
    },
  });

  const query = isWorkstreamMode ? multiQuery : singleQuery;
  const allArtifacts = query.data ?? [];

  // Apply final-only filter
  const artifacts = showAll
    ? allArtifacts
    : allArtifacts.filter((a) => a.status === 'approved');

  if (query.isLoading) {
    return (
      <div className="space-y-2">
        <h4 className="text-caption font-medium text-secondary">{title}</h4>
        <div className="shimmer-skeleton h-10 w-full rounded-lg" />
      </div>
    );
  }

  if (allArtifacts.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-caption font-medium text-secondary">
          {title} ({artifacts.length})
        </h4>
        {finalOnly && (
          <button
            type="button"
            onClick={() => setShowAll((prev) => !prev)}
            className="text-micro text-faint transition-colors hover:text-secondary"
          >
            {showAll ? 'Final only' : 'Show all'}
          </button>
        )}
      </div>
      <div className="space-y-1.5">
        {artifacts.slice(0, 10).map((artifact) => (
          <button
            key={artifact.id}
            type="button"
            onClick={() => openViewer(artifact.id, { entityType, entityId })}
            className="flex w-full items-center gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left transition-colors hover:bg-white/[0.05]"
          >
            <ArtifactListIcon />
            <div className="min-w-0 flex-1">
              <p className="truncate text-body text-primary">{artifact.name}</p>
              <span className="text-micro text-faint">
                {artifact.artifact_type}
              </span>
            </div>
            <span
              className="flex-shrink-0 rounded-full px-1.5 py-0.5 text-micro font-medium uppercase tracking-wider"
              style={{
                color: statusColors[artifact.status] ?? colors.textMuted,
                backgroundColor: `${statusColors[artifact.status] ?? colors.textMuted}15`,
              }}
            >
              {artifact.status}
            </span>
          </button>
        ))}
        {artifacts.length > 10 && (
          <p className="text-micro text-faint pl-2">
            +{artifacts.length - 10} more
          </p>
        )}
      </div>
    </div>
  );
}
