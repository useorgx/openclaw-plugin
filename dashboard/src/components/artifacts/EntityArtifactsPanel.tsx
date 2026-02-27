import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { colors, listItemVariants } from '@/lib/tokens';
import { queryKeys } from '@/lib/queryKeys';
import { buildOrgxHeaders } from '@/lib/http';
import { useArtifactViewer } from './ArtifactViewerContext';
import { isDemoModeEnabled } from '@/lib/initiativeIds';

/* ────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────── */

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

/* ────────────────────────────────────────────────────────────────────
 * Constants
 * ──────────────────────────────────────────────────────────────────── */

const statusColors: Record<string, string> = {
  draft: colors.textMuted,
  in_review: colors.amber,
  approved: colors.lime,
  changes_requested: colors.red,
  superseded: colors.textMuted,
  archived: colors.textMuted,
};

/* ────────────────────────────────────────────────────────────────────
 * Artifact type detection and icons
 * ──────────────────────────────────────────────────────────────────── */

type ArtifactCategory = 'code' | 'document' | 'schema' | 'test' | 'generic';

function categorizeArtifact(type: string, name: string): ArtifactCategory {
  const t = type.toLowerCase();
  const n = name.toLowerCase();

  // Code
  if (
    t.includes('code') ||
    t.includes('script') ||
    t.includes('implementation') ||
    /\.(ts|tsx|js|jsx|py|rb|go|rs|sh)$/i.test(n)
  )
    return 'code';

  // Schema
  if (
    t.includes('schema') ||
    t.includes('config') ||
    t.includes('spec') ||
    /\.(json|yaml|yml|toml)$/i.test(n)
  )
    return 'schema';

  // Test
  if (
    t.includes('test') ||
    t.includes('spec') ||
    n.includes('.test.') ||
    n.includes('.spec.') ||
    n.includes('_test.')
  )
    return 'test';

  // Document
  if (
    t.includes('document') ||
    t.includes('report') ||
    t.includes('brief') ||
    t.includes('handbook') ||
    t.includes('copy') ||
    /\.(md|mdx|txt|pdf|doc)$/i.test(n)
  )
    return 'document';

  return 'generic';
}

/** Monoline SVG icons for each artifact category */
function ArtifactTypeIcon({
  category,
  size = 16,
}: {
  category: ArtifactCategory;
  size?: number;
}) {
  const props = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  switch (category) {
    case 'code':
      return (
        <svg {...props} className="flex-shrink-0 text-[#BFFF00]">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      );
    case 'schema':
      return (
        <svg {...props} className="flex-shrink-0 text-[#F5B700]">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
      );
    case 'test':
      return (
        <svg {...props} className="flex-shrink-0 text-[#0AD4C4]">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <polyline points="14 2 14 8 20 8" />
          <path d="m9 15 2 2 4-4" />
        </svg>
      );
    case 'document':
      return (
        <svg {...props} className="flex-shrink-0 text-[#7C7CFF]">
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
          <path d="M14 2v4a2 2 0 0 0 2 2h4" />
          <path d="M10 9H8" />
          <path d="M16 13H8" />
          <path d="M16 17H8" />
        </svg>
      );
    default:
      return (
        <svg {...props} className="flex-shrink-0 text-white/50">
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
          <path d="M14 2v4a2 2 0 0 0 2 2h4" />
        </svg>
      );
  }
}

/* ────────────────────────────────────────────────────────────────────
 * Format / size metadata helpers
 * ──────────────────────────────────────────────────────────────────── */

function detectFormatLabel(type: string, name: string): string {
  const n = name.toLowerCase();
  const ext = n.split('.').pop();

  // Check extension first
  const extMap: Record<string, string> = {
    ts: 'TypeScript',
    tsx: 'TypeScript',
    js: 'JavaScript',
    jsx: 'JavaScript',
    json: 'JSON',
    yaml: 'YAML',
    yml: 'YAML',
    md: 'Markdown',
    mdx: 'Markdown',
    py: 'Python',
    go: 'Go',
    rs: 'Rust',
    sh: 'Shell',
    txt: 'Plain Text',
  };
  if (ext && extMap[ext]) return extMap[ext];

  // Fallback to type
  const t = type.toLowerCase();
  if (t.includes('json') || t.includes('schema')) return 'JSON';
  if (t.includes('yaml')) return 'YAML';
  if (t.includes('typescript') || t.includes('code')) return 'TypeScript';
  if (t.includes('markdown')) return 'Markdown';
  if (t.includes('document') || t.includes('brief') || t.includes('handbook')) return 'Document';

  return type.replace(/[._-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatSize(content: string | null): string | null {
  if (!content) return null;
  const bytes = new Blob([content]).size;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getContentFromMetadata(metadata: Record<string, unknown>): string | null {
  const candidates = [
    metadata.content,
    metadata.body,
    metadata.code,
    metadata.source,
    metadata.text,
    metadata.preview_markdown,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c;
  }
  return null;
}

function getContentLines(metadata: Record<string, unknown>): number | null {
  const content = getContentFromMetadata(metadata);
  if (!content) return null;
  return content.split('\n').length;
}

/* ────────────────────────────────────────────────────────────────────
 * Inline content preview (first 3 lines, monospaced)
 * ──────────────────────────────────────────────────────────────────── */

function InlinePreview({ metadata }: { metadata: Record<string, unknown> }) {
  const content = getContentFromMetadata(metadata);
  if (!content) return null;

  const previewLines = content.split('\n').slice(0, 3);
  const preview = previewLines.join('\n');

  return (
    <div className="mt-1.5 overflow-hidden rounded-md border border-white/[0.05] bg-white/[0.02]">
      <pre className="px-2 py-1.5 font-mono text-[10px] leading-[14px] text-white/40 overflow-hidden whitespace-pre text-ellipsis max-h-[42px]">
        {preview}
      </pre>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * Demo data
 * ──────────────────────────────────────────────────────────────────── */

function buildDemoArtifactsByEntity(entityType: string, entityId: string): ArtifactSummary[] {
  const now = new Date().toISOString();

  if (entityType === 'initiative' && entityId === 'init-1') {
    return [
      {
        id: 'artifact-demo-init-1-brief',
        name: 'Q4 dashboard polish brief',
        description: 'Summary of final polish checklist and open items.',
        artifact_url: '#',
        artifact_type: 'shared.project_handbook',
        status: 'approved',
        metadata: {
          source: 'demo',
          content: '# Q4 Dashboard Polish\n\n## Open Items\n- Fix responsive layout on mobile\n- Add loading skeletons\n- Performance audit',
        },
        created_at: now,
        updated_at: now,
      },
      {
        id: 'artifact-demo-init-1-copy',
        name: 'Launch copy variants',
        description: 'Three launch-ready copy variants for review.',
        artifact_url: '#',
        artifact_type: 'document',
        status: 'in_review',
        metadata: {
          source: 'demo',
          content: 'Variant A: "Ship faster with OrgX"\nVariant B: "Your AI-powered org brain"\nVariant C: "From chaos to clarity"',
        },
        created_at: now,
        updated_at: now,
      },
    ];
  }

  if (entityType === 'initiative' && entityId === 'init-2') {
    return [
      {
        id: 'artifact-demo-init-2-subjects',
        name: 'Subject line variants',
        description: 'Email subject line candidates with performance notes.',
        artifact_url: '#',
        artifact_type: 'document',
        status: 'approved',
        metadata: { source: 'demo' },
        created_at: now,
        updated_at: now,
      },
    ];
  }

  return [];
}

/* ────────────────────────────────────────────────────────────────────
 * Fetch
 * ──────────────────────────────────────────────────────────────────── */

async function fetchArtifactsByEntity(
  entityType: string,
  entityId: string,
  opts: { authToken?: string | null; embedMode?: boolean }
): Promise<ArtifactSummary[]> {
  if (isDemoModeEnabled()) {
    return buildDemoArtifactsByEntity(entityType, entityId);
  }
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

/* ────────────────────────────────────────────────────────────────────
 * Main Panel Component
 * ──────────────────────────────────────────────────────────────────── */

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
        {artifacts.slice(0, 10).map((artifact, index) => (
          <ArtifactListItem
            key={artifact.id}
            artifact={artifact}
            index={index}
            onOpen={() => openViewer(artifact.id, { entityType, entityId })}
          />
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

/* ────────────────────────────────────────────────────────────────────
 * Individual artifact list item
 * ──────────────────────────────────────────────────────────────────── */

function ArtifactListItem({
  artifact,
  index,
  onOpen,
}: {
  artifact: ArtifactSummary;
  index: number;
  onOpen: () => void;
}) {
  const category = useMemo(
    () => categorizeArtifact(artifact.artifact_type, artifact.name),
    [artifact.artifact_type, artifact.name]
  );
  const formatLabel = useMemo(
    () => detectFormatLabel(artifact.artifact_type, artifact.name),
    [artifact.artifact_type, artifact.name]
  );
  const content = useMemo(
    () => getContentFromMetadata(artifact.metadata),
    [artifact.metadata]
  );
  const lineCount = useMemo(
    () => getContentLines(artifact.metadata),
    [artifact.metadata]
  );
  const sizeLabel = useMemo(() => formatSize(content), [content]);

  // Build metadata string: "JSON . 2.4 KB" or "TypeScript . 156 lines"
  const metaString = useMemo(() => {
    const parts = [formatLabel];
    if (sizeLabel) parts.push(sizeLabel);
    else if (lineCount != null) parts.push(`${lineCount} line${lineCount !== 1 ? 's' : ''}`);
    return parts.join(' \u00B7 ');
  }, [formatLabel, sizeLabel, lineCount]);

  return (
    <motion.button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.05] hover:border-white/[0.10]"
      variants={listItemVariants}
      initial="hidden"
      animate="visible"
      custom={index}
    >
      {/* Type icon */}
      <div className="mt-0.5">
        <ArtifactTypeIcon category={category} size={16} />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-body font-medium text-primary">{artifact.name}</p>
        <span className="text-micro text-faint">
          {metaString}
        </span>

        {/* Inline 3-line preview */}
        <InlinePreview metadata={artifact.metadata} />
      </div>

      {/* Status badge */}
      <span
        className="mt-0.5 flex-shrink-0 rounded-full px-1.5 py-0.5 text-micro font-medium uppercase tracking-wider"
        style={{
          color: statusColors[artifact.status] ?? colors.textMuted,
          backgroundColor: `${statusColors[artifact.status] ?? colors.textMuted}15`,
        }}
      >
        {artifact.status}
      </span>
    </motion.button>
  );
}
