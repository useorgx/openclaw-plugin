import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import { humanizeText, humanizeModel } from '@/lib/humanize';
import type { Initiative, LiveActivityItem, LiveActivityType, SessionTreeNode } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { MarkdownText } from '@/components/shared/MarkdownText';
import { Modal } from '@/components/shared/Modal';
import { EntityIcon, type EntityIconType } from '@/components/shared/EntityIcon';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { ThreadView } from './ThreadView';
import type { ActivityTimeFilterId } from '@/lib/activityTimeFilters';
import { resolveActivityTimeFilter } from '@/lib/activityTimeFilters';

const itemVariants = {
  initial: { opacity: 0, y: 8, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -4, scale: 0.98 },
};

interface ActivityTimelineProps {
  activity: LiveActivityItem[];
  sessions: SessionTreeNode[];
  initiatives?: Initiative[];
  selectedRunIds: string[];
  selectedSessionLabel?: string | null;
  selectedWorkstreamId?: string | null;
  selectedWorkstreamLabel?: string | null;
  agentFilter?: string | null;
  timeFilterId?: ActivityTimeFilterId;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  onClearSelection: () => void;
  onClearWorkstreamFilter?: () => void;
  onClearAgentFilter?: () => void;
  onFocusRunId?: (runId: string) => void;
}

const INITIAL_RENDER_COUNT = 240;
const RENDER_STEP = 240;
const MAX_RENDER_COUNT = 3_600;
const MAX_FILTER_POOL = 12_000;

type ActivityBucket = 'message' | 'artifact' | 'decision';
type ActivityFilterId = 'all' | 'messages' | 'artifacts' | 'decisions';
type SortOrder = 'newest' | 'oldest';
interface DecoratedActivityItem {
  item: LiveActivityItem;
  bucket: ActivityBucket;
  runId: string | null;
  timestampEpoch: number;
  searchText: string;
}
type HeadlineSource = 'llm' | 'heuristic' | null;

interface DeduplicatedCluster {
  key: string;
  representative: DecoratedActivityItem;
  count: number;
  firstTimestamp: number;
  allItems: DecoratedActivityItem[];
}

const filterLabels: Record<ActivityFilterId, string> = {
  all: 'All',
  messages: 'Messages',
  artifacts: 'Artifacts',
  decisions: 'Decisions',
};

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textFromMetadata(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (
      typeof value === 'string' &&
      (key.toLowerCase().includes('type') ||
        key.toLowerCase().includes('kind') ||
        key.toLowerCase().includes('summary') ||
        key.toLowerCase().includes('message') ||
        key.toLowerCase().includes('artifact') ||
        key.toLowerCase().includes('decision') ||
        key.toLowerCase().includes('run') ||
        key.toLowerCase().includes('title') ||
        key.toLowerCase().includes('task') ||
        key.toLowerCase().includes('workstream') ||
        key.toLowerCase().includes('milestone'))
    ) {
      parts.push(value);
    }
  }
  return parts.join(' ');
}

function resolveRunId(item: LiveActivityItem): string | null {
  if (item.runId) return item.runId;
  const metadata = item.metadata as Record<string, unknown> | undefined;
  if (!metadata) return null;
  const candidates = ['runId', 'run_id', 'sessionId', 'session_id', 'agentRunId'];
  for (const key of candidates) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function resolveAgentIdentity(item: LiveActivityItem): { agentId: string | null; agentName: string | null } {
  const agentIdFromItem =
    typeof item.agentId === 'string' && item.agentId.trim().length > 0 ? item.agentId.trim() : null;
  const agentNameFromItem =
    typeof item.agentName === 'string' && item.agentName.trim().length > 0 ? item.agentName.trim() : null;
  if (agentIdFromItem || agentNameFromItem) {
    return { agentId: agentIdFromItem, agentName: agentNameFromItem };
  }

  const metadata = item.metadata as Record<string, unknown> | undefined;
  if (!metadata) return { agentId: null, agentName: null };

  const agentId =
    (typeof metadata.agent_id === 'string' && metadata.agent_id.trim().length > 0
      ? metadata.agent_id.trim()
      : null) ??
    (typeof metadata.agentId === 'string' && metadata.agentId.trim().length > 0
      ? metadata.agentId.trim()
      : null);
  const agentName =
    (typeof metadata.agent_name === 'string' && metadata.agent_name.trim().length > 0
      ? metadata.agent_name.trim()
      : null) ??
    (typeof metadata.agentName === 'string' && metadata.agentName.trim().length > 0
      ? metadata.agentName.trim()
      : null);

  return { agentId, agentName };
}

function extractWorkstreamId(item: LiveActivityItem): string | null {
  const metadata = item.metadata as Record<string, unknown> | undefined;
  if (!metadata) return null;

  const directCandidates = ['workstreamId', 'workstream_id'];
  for (const key of directCandidates) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  const orgxContext = metadata.orgx_context;
  if (orgxContext && typeof orgxContext === 'object' && !Array.isArray(orgxContext)) {
    const record = orgxContext as Record<string, unknown>;
    const value = record.workstreamId ?? record.workstream_id;
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function hasArtifactMetadata(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  const keys = [
    'artifact',
    'artifacts',
    'artifact_type',
    'artifactType',
    'output',
    'outputs',
    'result',
    'results',
    'payload',
    'toolOutput',
    'toolOutputs',
    'toolResult',
    'toolResults',
  ];
  return keys.some((key) => key in metadata);
}

function classifyActivity(item: LiveActivityItem): ActivityBucket {
  const metadata = item.metadata as Record<string, unknown> | undefined;
  const metadataText = textFromMetadata(item.metadata as Record<string, unknown> | undefined);
  const combined = [item.type, item.kind, item.summary, item.title, item.description, metadataText]
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .join(' ')
    .toLowerCase();

  const looksLikeArtifact =
    item.type === 'artifact_created' ||
    hasArtifactMetadata(metadata) ||
    /artifact|deliverable|output payload/.test(combined);
  if (looksLikeArtifact) return 'artifact';

  const looksLikeDecision =
    item.type === 'decision_requested' ||
    item.type === 'decision_resolved' ||
    item.decisionRequired === true ||
    /decision|approve|approval|reject|review request|request changes/.test(combined);
  if (looksLikeDecision) return 'decision';

  return 'message';
}

function labelForType(type: LiveActivityType): string {
  return type.split('_').join(' ');
}

function toDayKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return String(local.getTime());
}

function dayLabel(dayKey: string): string {
  const epoch = Number(dayKey);
  if (!Number.isFinite(epoch)) return 'Unknown day';
  const day = new Date(epoch);

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (day.getTime() === today.getTime()) return 'Today';
  if (day.getTime() === yesterday.getTime()) return 'Yesterday';

  return day.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: day.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

function bucketLabel(bucket: ActivityBucket): string {
  if (bucket === 'artifact') return 'artifact';
  if (bucket === 'decision') return 'decision';
  return 'message';
}

function bucketColor(bucket: ActivityBucket): string {
  if (bucket === 'artifact') return colors.cyan;
  if (bucket === 'decision') return colors.amber;
  return colors.teal;
}

function iconTypeForActivity(item: LiveActivityItem): EntityIconType {
  if (item.type === 'milestone_completed') return 'milestone';
  if (item.type === 'decision_requested' || item.type === 'decision_resolved') return 'decision';
  if (
    item.type === 'handoff_requested' ||
    item.type === 'handoff_claimed' ||
    item.type === 'handoff_fulfilled' ||
    item.type === 'delegation'
  ) {
    return 'workstream';
  }
  if (item.type === 'artifact_created') return 'task';
  if (item.initiativeId) return 'initiative';
  return 'notification';
}

type ActivitySeverity = 'critical' | 'positive' | 'warning' | 'neutral';

function activitySeverity(item: LiveActivityItem): ActivitySeverity {
  if (item.type === 'run_failed' || item.type === 'blocker_created') return 'critical';
  if (item.type === 'decision_requested') return 'warning';
  if (
    item.type === 'run_completed' ||
    item.type === 'milestone_completed' ||
    item.type === 'decision_resolved'
  ) {
    return 'positive';
  }
  return 'neutral';
}

function severityColor(severity: ActivitySeverity): string {
  if (severity === 'critical') return colors.red;
  if (severity === 'warning') return colors.amber;
  if (severity === 'positive') return colors.lime;
  return colors.teal;
}

function metadataToJson(metadata: Record<string, unknown> | undefined): string | null {
  if (!metadata || Object.keys(metadata).length === 0) return null;
  try {
    return JSON.stringify(metadata, null, 2);
  } catch {
    return null;
  }
}

type AutopilotSliceDetail = {
  event: string;
  agentId: string | null;
  agentName: string | null;
  domain: string | null;
  requiredSkills: string[];
  initiativeTitle: string | null;
  workstreamId: string | null;
  workstreamTitle: string | null;
  taskIds: string[];
  milestoneIds: string[];
  parsedStatus: string | null;
  hasOutput: boolean | null;
  artifacts: number | null;
  decisions: number | null;
  statusUpdatesApplied: number | null;
  statusUpdatesBuffered: number | null;
  logPath: string | null;
  outputPath: string | null;
  error: string | null;
};

function extractAutopilotSliceDetail(item: LiveActivityItem | null): AutopilotSliceDetail | null {
  if (!item) return null;
  const metadata = item.metadata as Record<string, unknown> | undefined;
  if (!metadata) return null;
  const event =
    typeof metadata.event === 'string' && metadata.event.trim().length > 0
      ? metadata.event.trim()
      : null;
  if (!event || !event.startsWith('autopilot_slice')) return null;

  const identity = resolveAgentIdentity(item);
  const requiredSkillsRaw = (metadata.required_skills ?? metadata.requiredSkills) as unknown;
  const requiredSkills = Array.isArray(requiredSkillsRaw)
    ? requiredSkillsRaw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];

  const taskIdsRaw = (metadata.task_ids ?? metadata.taskIds) as unknown;
  const taskIds = Array.isArray(taskIdsRaw)
    ? taskIdsRaw.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];

  const milestoneIdsRaw = (metadata.milestone_ids ?? metadata.milestoneIds) as unknown;
  const milestoneIds = Array.isArray(milestoneIdsRaw)
    ? milestoneIdsRaw.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];

  const workstreamId =
    typeof metadata.workstream_id === 'string'
      ? metadata.workstream_id
      : typeof metadata.workstreamId === 'string'
        ? metadata.workstreamId
        : null;

  const workstreamTitle =
    typeof metadata.workstream_title === 'string'
      ? metadata.workstream_title
      : typeof metadata.workstreamTitle === 'string'
        ? metadata.workstreamTitle
        : null;

  const initiativeTitle =
    typeof metadata.initiative_title === 'string'
      ? metadata.initiative_title
      : typeof metadata.initiativeTitle === 'string'
        ? metadata.initiativeTitle
        : null;

  const domain = typeof metadata.domain === 'string' ? metadata.domain : null;
  const parsedStatus =
    typeof metadata.parsed_status === 'string'
      ? metadata.parsed_status
      : typeof metadata.parsedStatus === 'string'
        ? metadata.parsedStatus
        : null;
  const hasOutput = typeof metadata.has_output === 'boolean' ? metadata.has_output : null;

  const logPath = typeof metadata.log_path === 'string' ? metadata.log_path : null;
  const outputPath = typeof metadata.output_path === 'string' ? metadata.output_path : null;
  const error = typeof metadata.error === 'string' ? metadata.error : null;

  const artifacts = typeof metadata.artifacts === 'number' ? metadata.artifacts : null;
  const decisions = typeof metadata.decisions === 'number' ? metadata.decisions : null;
  const statusUpdatesApplied =
    typeof metadata.status_updates_applied === 'number' ? metadata.status_updates_applied : null;
  const statusUpdatesBuffered =
    typeof metadata.status_updates_buffered === 'number' ? metadata.status_updates_buffered : null;

  return {
    event,
    agentId: identity.agentId,
    agentName: identity.agentName,
    domain,
    requiredSkills,
    initiativeTitle,
    workstreamId,
    workstreamTitle,
    taskIds,
    milestoneIds,
    parsedStatus,
    hasOutput,
    artifacts,
    decisions,
    statusUpdatesApplied,
    statusUpdatesBuffered,
    logPath,
    outputPath,
    error,
  };
}

type ArtifactPayload = {
  source: string;
  value: unknown;
};

type ProvenanceDetail = {
  pluginVersion: string | null;
  skillPack: { name: string | null; version: string | null; checksum: string | null; source: string | null } | null;
  kickoffContextHash: string | null;
  kickoffContextSource: string | null;
  modelTier: string | null;
  provider: string | null;
  model: string | null;
  domain: string | null;
  requiredSkills: string[];
};

function extractProvenance(metadata: Record<string, unknown> | undefined): ProvenanceDetail | null {
  if (!metadata) return null;
  const nested = metadata.orgx_provenance;
  const nestedRecord =
    nested && typeof nested === 'object' && !Array.isArray(nested) ? (nested as Record<string, unknown>) : null;
  const nestedSkill =
    nestedRecord?.skill_pack && typeof nestedRecord.skill_pack === 'object' && !Array.isArray(nestedRecord.skill_pack)
      ? (nestedRecord.skill_pack as Record<string, unknown>)
      : null;

  const pluginVersion =
    (typeof metadata.orgx_plugin_version === 'string' ? metadata.orgx_plugin_version : null) ??
    (typeof nestedRecord?.plugin_version === 'string' ? (nestedRecord.plugin_version as string) : null);

  const skillPackName =
    (typeof metadata.skill_pack_name === 'string' ? metadata.skill_pack_name : null) ??
    (typeof nestedSkill?.name === 'string' ? (nestedSkill.name as string) : null);
  const skillPackVersion =
    (typeof metadata.skill_pack_version === 'string' ? metadata.skill_pack_version : null) ??
    (typeof nestedSkill?.version === 'string' ? (nestedSkill.version as string) : null);
  const skillPackChecksum =
    (typeof metadata.skill_pack_checksum === 'string' ? metadata.skill_pack_checksum : null) ??
    (typeof nestedSkill?.checksum === 'string' ? (nestedSkill.checksum as string) : null);
  const skillPackSource =
    (typeof metadata.skill_pack_source === 'string' ? metadata.skill_pack_source : null) ??
    (typeof nestedSkill?.source === 'string' ? (nestedSkill.source as string) : null);

  const kickoffContextHash =
    typeof metadata.kickoff_context_hash === 'string' ? metadata.kickoff_context_hash : null;
  const kickoffContextSource =
    typeof metadata.kickoff_context_source === 'string' ? metadata.kickoff_context_source : null;
  const modelTier = typeof metadata.spawn_guard_model_tier === 'string' ? metadata.spawn_guard_model_tier : null;
  const provider = typeof metadata.provider === 'string' ? metadata.provider : null;
  const model = typeof metadata.model === 'string' ? metadata.model : null;
  const domain = typeof metadata.domain === 'string' ? metadata.domain : null;

  const requiredSkillsRaw = metadata.required_skills ?? metadata.requiredSkills;
  const requiredSkills = Array.isArray(requiredSkillsRaw)
    ? requiredSkillsRaw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];

  const hasAny =
    Boolean(pluginVersion) ||
    Boolean(skillPackName || skillPackVersion || skillPackChecksum) ||
    Boolean(kickoffContextHash) ||
    Boolean(modelTier || provider || model || domain) ||
    requiredSkills.length > 0;

  if (!hasAny) return null;

  return {
    pluginVersion,
    skillPack: skillPackName || skillPackVersion || skillPackChecksum || skillPackSource
      ? { name: skillPackName, version: skillPackVersion, checksum: skillPackChecksum, source: skillPackSource }
      : null,
    kickoffContextHash,
    kickoffContextSource,
    modelTier,
    provider,
    model,
    domain,
    requiredSkills,
  };
}

function extractArtifactPayload(item: LiveActivityItem | null): ArtifactPayload | null {
  if (!item) return null;
  const metadata = item.metadata as Record<string, unknown> | undefined;
  if (!metadata || typeof metadata !== 'object') return null;

  const candidates = [
    'artifact',
    'artifacts',
    'output',
    'outputs',
    'result',
    'results',
    'payload',
    'toolOutput',
    'toolOutputs',
    'toolResult',
    'toolResults',
  ];

  for (const key of candidates) {
    const value = metadata[key];
    if (value !== undefined && value !== null) {
      return { source: key, value };
    }
  }

  if (item.type === 'artifact_created') {
    return { source: 'metadata', value: metadata };
  }

  return null;
}

function renderArtifactValue(value: unknown): ReactNode {
  if (typeof value === 'string') {
    return <MarkdownText mode="block" text={value} className="text-[13px] leading-relaxed text-white/82" />;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return <p className="text-[13px] text-white/82">{String(value)}</p>;
  }

  if (Array.isArray(value)) {
    return (
      <div className="space-y-1.5">
        {value.map((entry, index) => (
          <div key={`artifact-list-${index}`} className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-2">
            {renderArtifactValue(entry)}
          </div>
        ))}
      </div>
    );
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <dl className="space-y-1.5">
        {entries.map(([key, entry]) => (
          <div key={key} className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-2">
            <dt className="text-[10px] uppercase tracking-[0.1em] text-white/45">{humanizeText(key)}</dt>
            <dd className="mt-1 text-[13px] text-white/82">
              {typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean'
                ? String(entry)
                : Array.isArray(entry)
                  ? `${entry.length} item${entry.length === 1 ? '' : 's'}`
                  : entry && typeof entry === 'object'
                    ? `${Object.keys(entry as Record<string, unknown>).length} field${Object.keys(entry as Record<string, unknown>).length === 1 ? '' : 's'}`
                    : '—'}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  return <p className="text-[13px] text-white/55">No artifact payload.</p>;
}

function humanizeActivityBody(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const modelOnly = humanizeModel(trimmed);
  if (modelOnly && modelOnly !== trimmed && /^[a-z0-9._/-]+$/i.test(trimmed)) {
    return modelOnly;
  }
  return humanizeText(trimmed);
}

function getLocalTurnReference(item: LiveActivityItem | null): {
  turnId: string;
  sessionKey: string | null;
  runId: string | null;
} | null {
  if (!item) return null;
  const metadata = item.metadata as Record<string, unknown> | undefined;
  if (!metadata || typeof metadata !== 'object') return null;

  const source = typeof metadata.source === 'string' ? metadata.source.trim() : '';
  const turnId = typeof metadata.turnId === 'string' ? metadata.turnId.trim() : '';
  if (source !== 'local_openclaw' || !turnId) return null;

  const sessionKey =
    typeof metadata.sessionKey === 'string' && metadata.sessionKey.trim().length > 0
      ? metadata.sessionKey.trim()
      : null;

  return {
    turnId,
    sessionKey,
    runId: item.runId ?? null,
  };
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1');
}

function summarizeDetailHeadline(
  item: LiveActivityItem,
  summaryOverride?: string | null
): string {
  const source =
    humanizeActivityBody(summaryOverride ?? item.summary) ??
    humanizeActivityBody(item.description) ??
    humanizeText(item.title || labelForType(item.type));

  const normalized = source
    .replace(/\r\n/g, '\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  const lines = normalized
    .split('\n')
    .map((line) => stripInlineMarkdown(line).trim())
    .filter((line) => line.length > 0 && !/^\|?[:\-| ]+\|?$/.test(line));

  let headline = lines[0] ?? stripInlineMarkdown(normalized);
  if (headline.length < 24 && lines.length > 1) {
    headline = `${headline} ${lines[1]}`.trim();
  }

  if (headline.length > 108) {
    return `${headline.slice(0, 107).trimEnd()}…`;
  }
  return headline;
}

export const ActivityTimeline = memo(function ActivityTimeline({
  activity,
  sessions,
  initiatives = [],
  selectedRunIds,
  selectedSessionLabel = null,
  selectedWorkstreamId = null,
  selectedWorkstreamLabel = null,
  agentFilter = null,
  timeFilterId = 'live',
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  onClearSelection,
  onClearWorkstreamFilter,
  onClearAgentFilter,
  onFocusRunId,
}: ActivityTimelineProps) {
  const prefersReducedMotion = useReducedMotion();
  const [activeFilter, setActiveFilter] = useState<ActivityFilterId>('all');
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState('');
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set());
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [renderCount, setRenderCount] = useState(INITIAL_RENDER_COUNT);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [detailDirection, setDetailDirection] = useState<1 | -1>(1);
  const [artifactViewMode, setArtifactViewMode] = useState<'structured' | 'json'>('structured');
  const [detailSummaryOverride, setDetailSummaryOverride] = useState<string | null>(null);
  const [detailSummarySource, setDetailSummarySource] = useState<'feed' | 'local' | 'missing'>('feed');
  const [detailHeadlineOverride, setDetailHeadlineOverride] = useState<string | null>(null);
  const [detailHeadlineSource, setDetailHeadlineSource] = useState<HeadlineSource>(null);
  const [headlineEndpointUnsupported, setHeadlineEndpointUnsupported] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const timeWindow = useMemo(() => resolveActivityTimeFilter(timeFilterId), [timeFilterId]);

  const runLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of sessions) {
      map.set(session.runId, session.title);
      map.set(session.id, session.title);
    }
    return map;
  }, [sessions]);

  const sessionStatusById = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of sessions) {
      if (session.status) {
        map.set(session.runId, session.status);
        map.set(session.id, session.status);
      }
    }
    return map;
  }, [sessions]);

  const sessionWorkstreamByRunId = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const session of sessions) {
      const workstreamId = session.workstreamId ?? null;
      map.set(session.runId, workstreamId);
      map.set(session.id, workstreamId);
    }
    return map;
  }, [sessions]);

  const initiativeNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const init of initiatives) {
      map.set(init.id, init.name);
    }
    return map;
  }, [initiatives]);

  const workstreamNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const init of initiatives) {
      for (const workstream of init.workstreams ?? []) {
        map.set(workstream.id, workstream.name);
      }
    }
    return map;
  }, [initiatives]);

  const runningSessions = useMemo(
    () => sessions.filter((s) => s.status === 'running'),
    [sessions]
  );

  const decoratedActivity = useMemo(() => {
    return activity.map((item) => {
      const runId = resolveRunId(item);
      const bucket = classifyActivity(item);
      const searchText = [
        item.title,
        item.description,
        item.summary,
        item.agentName,
        textFromMetadata(item.metadata as Record<string, unknown> | undefined),
      ]
        .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        .join(' ')
        .toLowerCase();

      return {
        item,
        bucket,
        runId,
        timestampEpoch: toEpoch(item.timestamp),
        searchText,
      } satisfies DecoratedActivityItem;
    });
  }, [activity]);

  const isLive = useMemo(() => {
    let newest = 0;
    for (const item of decoratedActivity) {
      newest = Math.max(newest, item.timestampEpoch);
    }
    if (newest <= 0) return false;
    return Date.now() - newest < 60_000;
  }, [decoratedActivity]);

  const typeSummary = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const decorated of decoratedActivity) {
      counts[decorated.item.type] = (counts[decorated.item.type] ?? 0) + 1;
    }
    const buckets: Array<{ id: string; label: string; count: number; color: string; types: string[] }> = [];
    const errorCount = (counts['run_failed'] ?? 0) + (counts['blocker_created'] ?? 0);
    if (errorCount > 0) buckets.push({ id: 'errors', label: 'errors', count: errorCount, color: colors.red, types: ['run_failed', 'blocker_created'] });
    const completionCount = (counts['run_completed'] ?? 0) + (counts['milestone_completed'] ?? 0);
    if (completionCount > 0) buckets.push({ id: 'completions', label: 'completions', count: completionCount, color: colors.lime, types: ['run_completed', 'milestone_completed'] });
    const artifactCount = counts['artifact_created'] ?? 0;
    if (artifactCount > 0) buckets.push({ id: 'artifacts', label: 'artifacts', count: artifactCount, color: colors.cyan, types: ['artifact_created'] });
    const decisionCount = (counts['decision_requested'] ?? 0) + (counts['decision_resolved'] ?? 0);
    if (decisionCount > 0) buckets.push({ id: 'decisions', label: 'decisions', count: decisionCount, color: colors.amber, types: ['decision_requested', 'decision_resolved'] });
    const handoffCount = (counts['handoff_requested'] ?? 0) + (counts['handoff_claimed'] ?? 0) + (counts['handoff_fulfilled'] ?? 0);
    if (handoffCount > 0) buckets.push({ id: 'handoffs', label: 'handoffs', count: handoffCount, color: colors.iris, types: ['handoff_requested', 'handoff_claimed', 'handoff_fulfilled'] });
    return buckets;
  }, [decoratedActivity]);

  const selectedRunIdSet = useMemo(
    () => new Set(selectedRunIds.filter((value) => value && value.trim().length > 0)),
    [selectedRunIds]
  );

  const hasSessionFilter = selectedRunIdSet.size > 0;
  const filteredSession = useMemo(() => {
    if (!hasSessionFilter) return null;
    for (const candidate of selectedRunIdSet) {
      const match = sessions.find((session) => session.runId === candidate || session.id === candidate);
      if (match) return match;
    }
    return null;
  }, [hasSessionFilter, selectedRunIdSet, sessions]);

  const { filtered, filteredTotal, hiddenCount } = useMemo(() => {
    const matched: DecoratedActivityItem[] = [];
    let overflow = 0;
    const normalizedQuery = query.trim().toLowerCase();

    for (const decorated of decoratedActivity) {
      const runId = decorated.runId;
      if (hasSessionFilter && (!runId || !selectedRunIdSet.has(runId))) {
        continue;
      }

      if (selectedWorkstreamId) {
        const fromMetadata = extractWorkstreamId(decorated.item);
        const fromSession = runId ? sessionWorkstreamByRunId.get(runId) ?? null : null;
        const resolvedWorkstreamId = fromMetadata ?? fromSession;
        if (resolvedWorkstreamId !== selectedWorkstreamId) {
          continue;
        }
      }

      if (agentFilter && decorated.item.agentName !== agentFilter) {
        continue;
      }

      const bucket = decorated.bucket;
      if (activeFilter === 'messages' && bucket !== 'message') continue;
      if (activeFilter === 'artifacts' && bucket !== 'artifact') continue;
      if (activeFilter === 'decisions' && bucket !== 'decision') continue;

      if (normalizedQuery.length > 0) {
        const runLabel = runId ? runLabelById.get(runId) ?? runId : '';
        const haystack = `${decorated.searchText} ${runLabel.toLowerCase()}`;
        if (!haystack.includes(normalizedQuery)) continue;
      }

      if (matched.length < MAX_FILTER_POOL) {
        matched.push(decorated);
      } else {
        overflow += 1; // avoid unbounded CPU for huge windows
      }
    }

    const sortedAll = [...matched].sort((a, b) => {
      const delta = b.timestampEpoch - a.timestampEpoch;
      return sortOrder === 'newest' ? delta : -delta;
    });

    const targetCount = Math.min(
      Math.max(1, Math.min(MAX_RENDER_COUNT, renderCount)),
      sortedAll.length
    );
    const rendered = sortedAll.slice(0, targetCount);
    const total = sortedAll.length + overflow;

    return {
      filtered: rendered,
      filteredTotal: total,
      hiddenCount: Math.max(0, total - rendered.length),
    };
  }, [
    activeFilter,
    agentFilter,
    decoratedActivity,
    hasSessionFilter,
    query,
    runLabelById,
    renderCount,
    selectedWorkstreamId,
    selectedRunIdSet,
    sessionWorkstreamByRunId,
    sortOrder,
  ]);

  const grouped = useMemo(() => {
    const map = new Map<string, DecoratedActivityItem[]>();
    for (const decorated of filtered) {
      const key = toDayKey(decorated.item.timestamp);
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(decorated);
      } else {
        map.set(key, [decorated]);
      }
    }

    const keys = Array.from(map.keys()).sort((a, b) => {
      const delta = Number(b) - Number(a);
      return sortOrder === 'newest' ? delta : -delta;
    });

    return keys.map((key) => ({
      key,
      label: dayLabel(key),
      items: map.get(key) ?? [],
    }));
  }, [filtered, sortOrder]);

  const deduplicatedGrouped = useMemo(() => {
    return grouped.map((group) => {
      const clusterMap = new Map<string, DeduplicatedCluster>();
      for (const decorated of group.items) {
        const clusterKey = `${decorated.item.type}::${decorated.item.title}`;
        const existing = clusterMap.get(clusterKey);
        if (existing) {
          existing.count += 1;
          existing.firstTimestamp = Math.min(existing.firstTimestamp, decorated.timestampEpoch);
          existing.allItems.push(decorated);
          // Keep the latest item as representative (items are already sorted)
          if (decorated.timestampEpoch > existing.representative.timestampEpoch) {
            existing.representative = decorated;
          }
        } else {
          clusterMap.set(clusterKey, {
            key: clusterKey,
            representative: decorated,
            count: 1,
            firstTimestamp: decorated.timestampEpoch,
            allItems: [decorated],
          });
        }
      }
      return {
        ...group,
        clusters: Array.from(clusterMap.values()),
      };
    });
  }, [grouped]);

  const toggleCluster = useCallback((clusterKey: string) => {
    setExpandedClusters((prev) => {
      const next = new Set(prev);
      if (next.has(clusterKey)) {
        next.delete(clusterKey);
      } else {
        next.add(clusterKey);
      }
      return next;
    });
  }, []);

  const renderableTotal = useMemo(
    () => Math.min(MAX_RENDER_COUNT, Math.min(MAX_FILTER_POOL, filteredTotal)),
    [filteredTotal]
  );

  useEffect(() => {
    setRenderCount(INITIAL_RENDER_COUNT);
  }, [
    activeFilter,
    agentFilter,
    hasSessionFilter,
    query,
    selectedWorkstreamId,
    sortOrder,
    timeFilterId,
  ]);

  useEffect(() => {
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!root || !target) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries.some((entry) => entry.isIntersecting);
        if (!hit) return;

        if (filtered.length < renderableTotal) {
          setRenderCount((prev) =>
            Math.min(renderableTotal, Math.max(prev, INITIAL_RENDER_COUNT) + RENDER_STEP)
          );
          return;
        }

        if (hasMore && !isLoadingMore) {
          onLoadMore?.();
        }
      },
      { root, rootMargin: '240px' }
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [filtered.length, hasMore, isLoadingMore, onLoadMore, renderableTotal]);

  const activeIndex = useMemo(() => {
    if (!activeItemId) return -1;
    return filtered.findIndex((decorated) => decorated.item.id === activeItemId);
  }, [activeItemId, filtered]);

  const activeDecorated = activeIndex >= 0 ? filtered[activeIndex] : null;
  const activeArtifact = useMemo(
    () => extractArtifactPayload(activeDecorated?.item ?? null),
    [activeDecorated]
  );
  const activeAutopilotSlice = useMemo(
    () => extractAutopilotSliceDetail(activeDecorated?.item ?? null),
    [activeDecorated]
  );
  const activeProvenance = useMemo(
    () => extractProvenance((activeDecorated?.item.metadata as Record<string, unknown> | undefined) ?? undefined),
    [activeDecorated]
  );
  const activeMetadataJson = useMemo(
    () =>
      metadataToJson(
        (activeDecorated?.item.metadata as Record<string, unknown> | undefined) ?? undefined
      ),
    [activeDecorated]
  );
  const activeSummaryText = useMemo(() => {
    const override = humanizeActivityBody(detailSummaryOverride);
    if (override) return override;
    return (
      humanizeActivityBody(activeDecorated?.item.summary) ??
      humanizeActivityBody(activeDecorated?.item.description)
    );
  }, [detailSummaryOverride, activeDecorated]);

  const closeDetail = useCallback(() => {
    setActiveItemId(null);
  }, []);

  useEffect(() => {
    if (!copyNotice) return undefined;
    const timer = window.setTimeout(() => setCopyNotice(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copyNotice]);

  const copyText = useCallback(async (label: string, value: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopyNotice(`${label} copied`);
    } catch {
      setCopyNotice('Copy failed');
    }
  }, []);

  useEffect(() => {
    setArtifactViewMode('structured');
  }, [activeItemId]);

  useEffect(() => {
    setDetailSummaryOverride(null);
    setDetailSummarySource('feed');

    const reference = getLocalTurnReference(activeDecorated?.item ?? null);
    if (!reference) return;

    const query = new URLSearchParams({ turnId: reference.turnId });
    if (reference.sessionKey) query.set('sessionKey', reference.sessionKey);
    if (reference.runId) query.set('run', reference.runId);

    const controller = new AbortController();

    fetch(`/orgx/api/live/activity/detail?${query.toString()}`, {
      method: 'GET',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          if (response.status === 404) {
            setDetailSummarySource('missing');
          }
          return null;
        }
        const payload = (await response.json()) as {
          detail?: { summary?: string | null };
        };
        return payload.detail?.summary ?? null;
      })
      .then((summary) => {
        if (typeof summary === 'string' && summary.trim().length > 0) {
          setDetailSummaryOverride(summary);
          setDetailSummarySource('local');
        } else {
          setDetailSummarySource('missing');
        }
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setDetailSummarySource('missing');
      });

    return () => controller.abort();
  }, [activeDecorated]);

  useEffect(() => {
    setDetailHeadlineOverride(null);
    setDetailHeadlineSource(null);

    const item = activeDecorated?.item;
    if (!item || headlineEndpointUnsupported) return;

    const headlineInputText = (
      detailSummaryOverride ??
      item.summary ??
      item.description ??
      item.title ??
      ''
    ).trim();
    if (!headlineInputText) return;

    const controller = new AbortController();

    fetch('/orgx/api/live/activity/headline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        text: headlineInputText,
        title: item.title ?? null,
        type: item.type,
      }),
    })
      .then(async (response) => {
        if (!response.ok) {
          if (response.status === 404 || response.status === 405) {
            setHeadlineEndpointUnsupported(true);
          }
          return null;
        }
        const payload = (await response.json()) as {
          headline?: string | null;
          source?: 'llm' | 'heuristic' | null;
        };
        return payload;
      })
      .then((payload) => {
        const headline = payload?.headline;
        if (typeof headline === 'string' && headline.trim().length > 0) {
          setHeadlineEndpointUnsupported(false);
          setDetailHeadlineOverride(headline.trim());
          setDetailHeadlineSource(payload?.source ?? null);
        }
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
      });

    return () => controller.abort();
  }, [activeDecorated, detailSummaryOverride, headlineEndpointUnsupported]);

  const navigateDetail = useCallback(
    (direction: 1 | -1) => {
      if (filtered.length === 0) return;
      const startIndex = activeIndex >= 0 ? activeIndex : 0;
      const nextIndex = (startIndex + direction + filtered.length) % filtered.length;
      setDetailDirection(direction);
      setActiveItemId(filtered[nextIndex]?.item.id ?? null);
    },
    [activeIndex, filtered]
  );

  useEffect(() => {
    if (!activeItemId) return;
    if (activeIndex >= 0) return;
    setActiveItemId(null);
  }, [activeIndex, activeItemId]);

  useEffect(() => {
    if (!activeItemId) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'l') {
        event.preventDefault();
        navigateDetail(1);
      } else if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'h') {
        event.preventDefault();
        navigateDetail(-1);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeItemId, navigateDetail]);

  // Detect single-session thread mode
  const isSingleSession = selectedRunIdSet.size === 1;
  const singleRunId = isSingleSession ? [...selectedRunIdSet][0] : null;
  const singleSession = singleRunId
    ? sessions.find((s) => s.runId === singleRunId || s.id === singleRunId) ?? null
    : null;
  const singleSessionItems = useMemo(() => {
    if (!isSingleSession) return [];
    return decoratedActivity
      .filter((d) => d.runId && selectedRunIdSet.has(d.runId))
      .map((d) => d.item);
  }, [isSingleSession, decoratedActivity, selectedRunIdSet]);

  const enableItemMotion = !prefersReducedMotion && filtered.length <= 160;

  const renderItem = (decorated: DecoratedActivityItem, index: number) => {
    const item = decorated.item;
    const severity = activitySeverity(item);
    const railColor = severityColor(severity);
    const isRecent = sortOrder === 'newest' && index < 2;
    const bucket = decorated.bucket;
    const runId = decorated.runId;
    const runLabel = runId ? runLabelById.get(runId) ?? humanizeText(runId) : 'Workspace';
    const sessionStatus = runId ? sessionStatusById.get(runId) ?? null : null;

    const displayTitle = humanizeText(item.title ?? '');
    const displaySummary = humanizeActivityBody(item.summary);
    const displayDesc = humanizeActivityBody(item.description);
    const initiativeName = item.initiativeId ? initiativeNameById.get(item.initiativeId) ?? null : null;
    const workstreamId =
      extractWorkstreamId(item) ?? (runId ? sessionWorkstreamByRunId.get(runId) ?? null : null);
    const workstreamName = workstreamId
      ? workstreamNameById.get(workstreamId) ?? humanizeText(workstreamId)
      : null;
    const kindColor = bucketColor(bucket);
    const kindLabel = bucketLabel(bucket);
    const primaryTag = severity === 'critical'
      ? 'Error'
      : severity === 'warning'
        ? 'Needs review'
        : severity === 'positive'
          ? 'Completed'
          : 'Update';
    const timeLabel = new Date(item.timestamp).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });

    const commonClassName =
      "group w-full rounded-xl border border-white/[0.08] bg-white/[0.02] px-3.5 py-3 text-left transition-colors hover:border-white/[0.16] hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BFFF00]/45 cv-auto";

    const content = (
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          <AgentAvatar
            name={item.agentName ?? 'OrgX'}
            hint={`${item.agentId ?? ''} ${runLabel} ${item.title ?? ''}`}
            size="xs"
          />
        </div>
        <div className="relative min-w-0 flex-1 pl-3">
          <span
            className={cn('absolute inset-y-0 left-0 w-[2px] rounded-full', isRecent && 'pulse-soft')}
            style={{
              backgroundColor: railColor,
              boxShadow: `0 0 14px ${railColor}66`,
            }}
          />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="line-clamp-2 break-words text-[13px] font-semibold leading-snug text-white/92">
                {displayTitle || humanizeText(item.title || labelForType(item.type))}
              </p>
              <p className="mt-0.5 text-[11px] text-white/48">
                {item.agentName ?? 'OrgX'}
                {sessionStatus ? ` · ${humanizeText(sessionStatus)}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className="text-[10px] uppercase tracking-[0.09em] text-white/42">
                {kindLabel}
              </span>
              <span className="text-[11px] text-white/55">{timeLabel}</span>
            </div>
          </div>

          {(displaySummary || displayDesc) && (
            <div className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-white/62">
              <MarkdownText mode="inline" text={displaySummary ?? displayDesc ?? ''} />
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
            <span
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 uppercase tracking-[0.08em]"
              style={{
                borderColor: `${railColor}55`,
                backgroundColor: `${railColor}1A`,
                color: railColor,
              }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: railColor }} />
              {primaryTag}
            </span>
            <span className="rounded-full border border-white/[0.12] bg-white/[0.02] px-2 py-0.5 text-white/60">
              {runLabel}
            </span>
            <span
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-white/62"
              style={{ borderColor: `${kindColor}44`, color: kindColor }}
            >
              <EntityIcon type={iconTypeForActivity(item)} size={10} className="opacity-90" />
              {humanizeText(labelForType(item.type))}
            </span>
            <span className="text-white/55">{formatRelativeTime(item.timestamp)}</span>
            {initiativeName && (
              <span
                className="inline-flex max-w-[220px] items-center gap-1 rounded-full border border-white/[0.12] bg-white/[0.03] px-2 py-0.5 text-white/54"
                title={initiativeName}
              >
                <EntityIcon type="initiative" size={10} className="opacity-85" />
                <span className="truncate">{initiativeName}</span>
              </span>
            )}
            {workstreamName && (
              <span
                className="inline-flex max-w-[220px] items-center gap-1 rounded-full border border-white/[0.12] bg-white/[0.03] px-2 py-0.5 text-white/54"
                title={workstreamName}
              >
                <EntityIcon type="workstream" size={10} className="opacity-90" />
                <span className="truncate">{workstreamName}</span>
              </span>
            )}
          </div>
        </div>
      </div>
    );

    if (!enableItemMotion) {
      return (
        <button
          type="button"
          key={item.id}
          onClick={() => {
            setDetailDirection(1);
            setActiveItemId(item.id);
          }}
          className={cn(
            commonClassName,
            "transform-gpu transition-[transform,background-color,border-color,color] hover:-translate-y-[1px] active:scale-[0.995]"
          )}
          aria-label={`Open activity details for ${displayTitle || labelForType(item.type)}`}
        >
          {content}
        </button>
      );
    }

    return (
      <motion.button
        type="button"
        key={item.id}
        variants={itemVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
        whileHover={{ y: -1.5 }}
        whileTap={{ scale: 0.995 }}
        onClick={() => {
          setDetailDirection(1);
          setActiveItemId(item.id);
        }}
        className={commonClassName}
        aria-label={`Open activity details for ${displayTitle || labelForType(item.type)}`}
      >
        {content}
      </motion.button>
    );
  };

  return (
    <PremiumCard className="flex h-full min-h-0 flex-col card-enter">
      {/* Thread view for single-session selection */}
      {isSingleSession && singleSessionItems.length > 0 ? (
        <ThreadView
          items={singleSessionItems}
          session={singleSession}
          agentName={singleSessionItems[0]?.agentName ?? null}
          onBack={onClearSelection}
        />
      ) : (
      <>
      {runningSessions.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto border-b border-white/[0.06] px-4 py-2 scrollbar-none">
          <span className="flex-shrink-0 text-[10px] uppercase tracking-[0.08em] text-white/35">In Progress</span>
          {runningSessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => onFocusRunId?.(session.runId)}
              className="flex flex-shrink-0 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 transition-colors hover:bg-white/[0.06]"
            >
              <AgentAvatar name={session.agentName ?? 'OrgX'} size="xs" hint={session.agentName} />
              <span className="max-w-[140px] truncate text-[11px] text-white/70">{session.title}</span>
            </button>
          ))}
        </div>
      )}
      <div className="border-b border-white/[0.06] px-4 py-3.5">
        <div className="toolbar-shell flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="text-[14px] font-semibold text-white">Activity</h2>
              <span className="rounded-full border border-white/[0.14] bg-white/[0.05] px-2 py-0.5 text-[10px] text-white/75 tabular-nums">
                {filteredTotal}
              </span>
              {hiddenCount > 0 && (
                <span className="rounded-full border border-white/[0.14] bg-white/[0.03] px-2 py-0.5 text-[10px] text-white/55 tabular-nums">
                  +{hiddenCount} hidden
                </span>
              )}
              {timeWindow.id !== 'all' && (
                <span className="rounded-full border border-white/[0.12] bg-white/[0.02] px-2 py-0.5 text-[10px] text-white/55">
                  {timeWindow.label}
                </span>
              )}
              <span
                className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', isLive && 'pulse-soft')}
                style={{ backgroundColor: colors.lime }}
                aria-label="Live"
                title={isLive ? 'New activity within the last minute' : 'Live activity feed'}
              />
            </div>

            <div className="flex flex-shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setSortOrder((prev) => (prev === 'newest' ? 'oldest' : 'newest'))}
                className="control-pill px-3 text-[11px] font-medium"
                aria-label={sortOrder === 'newest' ? 'Sort oldest first' : 'Sort newest first'}
              >
                {sortOrder === 'newest' ? 'Newest' : 'Oldest'}
              </button>
              <button
                type="button"
                onClick={() => setCollapsed((prev) => !prev)}
                data-state={collapsed ? 'active' : 'idle'}
                className="control-pill px-3 text-[11px] font-medium"
                aria-pressed={collapsed}
              >
                {collapsed ? 'Expand' : 'Compact'}
              </button>
            </div>
          </div>

          {(hasSessionFilter || selectedWorkstreamId || agentFilter) && (
            <div className="flex flex-wrap items-center gap-2">
              {hasSessionFilter && (
                <button
                  onClick={onClearSelection}
                  className="chip inline-flex min-w-0 items-center gap-2"
                  aria-label="Clear session filter"
                >
                  <AgentAvatar
                    name={filteredSession?.agentName ?? 'OrgX'}
                    hint={selectedSessionLabel ?? null}
                    size="xs"
                  />
                  <span className="min-w-0 truncate">
                    Session{selectedSessionLabel ? `: ${selectedSessionLabel}` : ''}
                  </span>
                  <span className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.04] text-[10px] text-white/60">
                    ×
                  </span>
                </button>
              )}
              {selectedWorkstreamId && (
                <button
                  onClick={onClearWorkstreamFilter}
                  className="chip inline-flex min-w-0 items-center gap-2"
                  style={{ borderColor: 'rgba(191,255,0,0.28)', color: '#D8FFA1' }}
                  aria-label="Clear workstream filter"
                >
                  <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.04] text-[10px]">
                    ↳
                  </span>
                  <span className="min-w-0 truncate">
                    Workstream{selectedWorkstreamLabel ? `: ${selectedWorkstreamLabel}` : ''}
                  </span>
                  <span className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.04] text-[10px] text-white/60">
                    ×
                  </span>
                </button>
              )}
              {agentFilter && (
                <button
                  onClick={onClearAgentFilter}
                  className="chip inline-flex min-w-0 items-center gap-2"
                  style={{ borderColor: 'rgba(10,212,196,0.3)', color: '#0AD4C4' }}
                  aria-label="Clear agent filter"
                >
                  <AgentAvatar name={agentFilter} hint={agentFilter} size="xs" />
                  <span className="min-w-0 truncate">Agent: {agentFilter}</span>
                  <span className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.04] text-[10px] text-white/60">
                    ×
                  </span>
                </button>
              )}
            </div>
          )}
        </div>

        {typeSummary.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {typeSummary.map((bucket) => (
              <button
                key={bucket.id}
                type="button"
                onClick={() => {
                  if (bucket.id === 'errors') setActiveFilter('messages');
                  else if (bucket.id === 'completions') setActiveFilter('messages');
                  else if (bucket.id === 'artifacts') setActiveFilter('artifacts');
                  else if (bucket.id === 'decisions') setActiveFilter('decisions');
                  else setActiveFilter('all');
                }}
                  className="inline-flex items-center gap-1 rounded-full border border-white/[0.12] bg-white/[0.03] px-2 py-0.5 text-[10px] transition-colors hover:bg-white/[0.08]"
                >
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: bucket.color }} />
                <span className="font-semibold text-white" style={{ fontVariantNumeric: 'tabular-nums' }}>{bucket.count}</span>
                <span className="text-white/45">{bucket.label}</span>
              </button>
            ))}
          </div>
        )}

        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-white/35"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search activity..."
              className="w-full rounded-lg border border-white/[0.12] bg-black/25 py-2 pl-9 pr-2 text-[12px] text-white/82 placeholder:text-white/35 transition-colors focus:border-[#BFFF00]/35 focus:outline-none"
              aria-label="Search activity"
            />
          </div>

          <div
            className="inline-flex items-center gap-1 rounded-full border border-white/[0.12] bg-black/20 p-0.5"
            role="group"
            aria-label="Activity filters"
          >
            {(Object.keys(filterLabels) as ActivityFilterId[]).map((filterId) => {
              const active = activeFilter === filterId;
              return (
                <button
                  type="button"
                  key={filterId}
                  onClick={() => setActiveFilter(filterId)}
                  aria-pressed={active}
                  className={cn(
                    'rounded-full px-3 py-1.5 text-[10px] font-semibold transition-colors',
                    active
                      ? 'border border-lime/25 bg-lime/[0.13] text-lime'
                      : 'border border-transparent text-white/60 hover:bg-white/[0.08] hover:text-white/85'
                  )}
                >
                  {filterLabels[filterId]}
                </button>
              );
            })}
          </div>
        </div>
      </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
        {filtered.length === 0 && (
          <div className="flex flex-col items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-6 text-center">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-white/25"
            >
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
            <p className="text-[12px] text-white/45">
              {hasSessionFilter
                ? `No ${filterLabels[activeFilter].toLowerCase()} for the selected session.`
                : selectedWorkstreamId
                  ? `No ${filterLabels[activeFilter].toLowerCase()} for the selected workstream.`
                  : 'No matching activity right now.'}
            </p>
            {(hasSessionFilter || selectedWorkstreamId) && (
              <button
                onClick={hasSessionFilter ? onClearSelection : onClearWorkstreamFilter}
                className="rounded-md border border-white/[0.12] bg-white/[0.04] px-3 py-1.5 text-[11px] text-white/70 transition-colors hover:bg-white/[0.08]"
              >
                {hasSessionFilter ? 'Show all sessions' : 'Show all workstreams'}
              </button>
            )}
          </div>
        )}

        {filtered.length > 0 && (
          <div className="space-y-4">
            {deduplicatedGrouped.map((group) => {
              const visibleClusters = collapsed ? group.clusters.slice(0, 4) : group.clusters;
	              return (
	                <section key={group.key}>
	                  <h3 className="mb-2.5 border-b border-white/[0.06] pb-1.5 text-[11px] uppercase tracking-[0.12em] text-white/35">
	                    {group.label}
	                  </h3>
	                  {enableItemMotion ? (
	                    <AnimatePresence mode="popLayout">
	                      <div className="space-y-2">
	                        {visibleClusters.map((cluster, index) => {
	                          const isExpanded = expandedClusters.has(cluster.key);
	                          if (cluster.count === 1) {
	                            return renderItem(cluster.representative, index);
	                          }
	                          return (
	                            <div key={cluster.key}>
	                              {renderItem(cluster.representative, index)}
	                              <button
	                                type="button"
	                                onClick={(e) => { e.stopPropagation(); toggleCluster(cluster.key); }}
	                                className="mt-1 ml-8 inline-flex items-center gap-1.5 rounded-full border border-white/[0.1] bg-white/[0.03] px-2.5 py-1 text-[10px] text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white/75"
	                              >
	                                <span className="font-semibold">×{cluster.count}</span>
	                                <span className="text-white/35">·</span>
	                                <span>first seen {formatRelativeTime(cluster.firstTimestamp)}</span>
	                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cn('transition-transform', isExpanded ? 'rotate-0' : '-rotate-90')}>
	                                  <path d="m6 9 6 6 6-6" />
	                                </svg>
	                              </button>
	                              {isExpanded && (
	                                <div className="ml-8 mt-1 space-y-1.5 border-l border-white/[0.06] pl-3">
	                                  {cluster.allItems.slice(1).map((item, subIndex) => renderItem(item, index + subIndex + 1))}
	                                </div>
	                              )}
	                            </div>
	                          );
	                        })}
	                      </div>
	                    </AnimatePresence>
	                  ) : (
	                    <div className="space-y-2">
	                      {visibleClusters.map((cluster, index) => {
	                        const isExpanded = expandedClusters.has(cluster.key);
	                        if (cluster.count === 1) {
	                          return renderItem(cluster.representative, index);
	                        }
	                        return (
	                          <div key={cluster.key}>
	                            {renderItem(cluster.representative, index)}
	                            <button
	                              type="button"
	                              onClick={(e) => { e.stopPropagation(); toggleCluster(cluster.key); }}
	                              className="mt-1 ml-8 inline-flex items-center gap-1.5 rounded-full border border-white/[0.1] bg-white/[0.03] px-2.5 py-1 text-[10px] text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white/75"
	                            >
	                              <span className="font-semibold">×{cluster.count}</span>
	                              <span className="text-white/35">·</span>
	                              <span>first seen {formatRelativeTime(cluster.firstTimestamp)}</span>
	                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cn('transition-transform', isExpanded ? 'rotate-0' : '-rotate-90')}>
	                                <path d="m6 9 6 6 6-6" />
	                              </svg>
	                            </button>
	                            {isExpanded && (
	                              <div className="ml-8 mt-1 space-y-1.5 border-l border-white/[0.06] pl-3">
	                                {cluster.allItems.slice(1).map((item, subIndex) => renderItem(item, index + subIndex + 1))}
	                              </div>
	                            )}
	                          </div>
	                        );
	                      })}
	                    </div>
	                  )}
	                  {collapsed && group.clusters.length > visibleClusters.length && (
	                    <p className="mt-1.5 text-[11px] text-white/35">
	                      +{group.clusters.length - visibleClusters.length} more
	                    </p>
	                  )}
	                </section>
              );
            })}

            {hiddenCount > 0 && (
              <p className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px] text-white/45">
                Showing {filtered.length}/{filteredTotal} matched events (load more to see older).
              </p>
            )}

            <div ref={sentinelRef} className="h-6" />

            {(hasMore || isLoadingMore) && (
              <div className="flex items-center justify-center">
                <button
                  type="button"
                  onClick={() => onLoadMore?.()}
                  disabled={!hasMore || isLoadingMore}
                  className="rounded-full border border-white/[0.12] bg-white/[0.03] px-4 py-2 text-[11px] font-semibold text-white/70 transition-colors hover:bg-white/[0.08] disabled:opacity-45"
                >
                  {isLoadingMore ? 'Loading older…' : 'Load older'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      </>
      )}

      <Modal open={activeDecorated !== null} onClose={closeDetail} maxWidth="max-w-3xl">
        {activeDecorated && (
          <div className="relative flex h-[100dvh] w-full min-h-0 flex-col sm:h-[86vh] sm:max-h-[86vh]">
            <div className="absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-lime/10 via-cyan/5 to-transparent" />

	            <div className="relative z-10 flex items-center justify-between border-b border-white/[0.06] px-5 py-4 sm:px-6">
	              <div className="min-w-0">
	                <p className="text-[11px] uppercase tracking-[0.12em] text-white/40">Activity Detail</p>
	                <div className="mt-1 flex items-center gap-2">
	                  <span
	                    className="h-2.5 w-2.5 rounded-full"
                    style={{
                      backgroundColor: bucketColor(activeDecorated.bucket),
                      boxShadow: `0 0 16px ${bucketColor(activeDecorated.bucket)}77`,
                    }}
	                  />
	                  <span className="text-[12px] text-white/70">
	                    {bucketLabel(activeDecorated.bucket)} · {activeIndex + 1}/{filtered.length}
	                  </span>
	                  {copyNotice && (
	                    <span className="rounded-full border border-white/[0.12] bg-white/[0.04] px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-white/60">
	                      {copyNotice}
	                    </span>
	                  )}
	                </div>
	              </div>

	              <div className="flex flex-wrap items-center justify-end gap-2">
	                {activeDecorated.runId && onFocusRunId && (
	                  <button
		                    type="button"
		                    onClick={() => {
		                      onFocusRunId(activeDecorated.runId!);
		                      closeDetail();
		                    }}
	                    className="rounded-full border border-lime/25 bg-lime/10 px-3 py-1 text-[11px] font-semibold text-lime transition hover:bg-lime/20"
	                  >
	                    Focus session
	                  </button>
	                )}
	                {activeDecorated.runId && (
	                  <button
	                    type="button"
	                    onClick={() => void copyText('Run id', activeDecorated.runId ?? '')}
	                    className="rounded-full border border-white/[0.12] bg-white/[0.04] px-2.5 py-1 text-[11px] text-white/70 transition hover:bg-white/[0.1]"
	                    aria-label="Copy run id"
	                  >
	                    Copy run
	                  </button>
	                )}
	                {resolveAgentIdentity(activeDecorated.item).agentId && (
	                  <button
	                    type="button"
	                    onClick={() =>
	                      void copyText(
	                        'Agent id',
	                        resolveAgentIdentity(activeDecorated.item).agentId ?? ''
	                      )
	                    }
	                    className="rounded-full border border-white/[0.12] bg-white/[0.04] px-2.5 py-1 text-[11px] text-white/70 transition hover:bg-white/[0.1]"
	                    aria-label="Copy agent id"
	                  >
	                    Copy agent
	                  </button>
	                )}
	                <button
	                  type="button"
	                  onClick={() => void copyText('Event id', activeDecorated.item.id)}
	                  className="rounded-full border border-white/[0.12] bg-white/[0.04] px-2.5 py-1 text-[11px] text-white/70 transition hover:bg-white/[0.1]"
	                  aria-label="Copy event id"
	                >
	                  Copy event
	                </button>

	                <button
	                  type="button"
	                  onClick={() => navigateDetail(-1)}
	                  className="rounded-full border border-white/[0.12] bg-white/[0.04] px-2.5 py-1 text-[11px] text-white/70 transition hover:bg-white/[0.1]"
	                  aria-label="Previous activity item"
	                >
	                  ← Prev
	                </button>
                <button
                  type="button"
                  onClick={() => navigateDetail(1)}
                  className="rounded-full border border-white/[0.12] bg-white/[0.04] px-2.5 py-1 text-[11px] text-white/70 transition hover:bg-white/[0.1]"
                  aria-label="Next activity item"
                >
                  Next →
                </button>
                <button
                  type="button"
                  onClick={closeDetail}
                  className="rounded-full border border-white/[0.12] bg-white/[0.04] px-2 py-1 text-[11px] text-white/60 transition hover:bg-white/[0.1] hover:text-white/90"
                  aria-label="Close activity detail"
                >
                  Esc
                </button>
              </div>
            </div>

            <div className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 pb-5 pt-4 sm:px-6">
              <AnimatePresence mode="wait" custom={detailDirection}>
                <motion.section
                  key={activeDecorated.item.id}
                  custom={detailDirection}
                  initial={{ opacity: 0, x: detailDirection * 44, scale: 0.985 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={{ opacity: 0, x: detailDirection * -32, scale: 0.985 }}
                  transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                  className="min-h-full w-full overscroll-contain"
                >
                  <div className="space-y-4 pb-1">
                    <div>
                      <h3 className="text-[20px] font-semibold tracking-[-0.02em] text-white whitespace-pre-wrap break-words">
                        {detailHeadlineOverride ||
                          summarizeDetailHeadline(activeDecorated.item, detailSummaryOverride) ||
                          humanizeText(activeDecorated.item.title || labelForType(activeDecorated.item.type))}
                      </h3>
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-white/45">
                        {new Date(activeDecorated.item.timestamp).toLocaleString()} · {formatRelativeTime(activeDecorated.item.timestamp)}
                        {detailHeadlineSource === 'llm' && (
                          <span className="text-white/35">· AI title</span>
                        )}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-1.5 text-[11px]">
                      <span
                        className="rounded-full border px-2 py-0.5 uppercase tracking-[0.1em]"
                        style={{
                          borderColor: `${bucketColor(activeDecorated.bucket)}55`,
                          color: bucketColor(activeDecorated.bucket),
                        }}
                      >
                        {bucketLabel(activeDecorated.bucket)}
                      </span>
                      <span className="rounded-full border border-white/[0.12] px-2 py-0.5 text-white/65">
                        {labelForType(activeDecorated.item.type)}
                      </span>
                      {resolveAgentIdentity(activeDecorated.item).agentName && (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.12] px-1.5 py-0.5 text-white/65">
                          <AgentAvatar
                            name={resolveAgentIdentity(activeDecorated.item).agentName ?? 'Agent'}
                            hint={`${resolveAgentIdentity(activeDecorated.item).agentId ?? ''} ${activeDecorated.item.title ?? ''}`}
                            size="xs"
                          />
                          <span>{resolveAgentIdentity(activeDecorated.item).agentName}</span>
                        </span>
                      )}
                      {activeDecorated.runId && (
                        <span className="rounded-full border border-white/[0.12] px-2 py-0.5 text-white/65">
                          {runLabelById.get(activeDecorated.runId) ?? humanizeText(activeDecorated.runId)}
                        </span>
                      )}
                    </div>

                    {activeAutopilotSlice && (
                      <div className="rounded-xl border border-lime/20 bg-lime/10 p-3">
                        <p className="text-[11px] uppercase tracking-[0.11em] text-lime/80">
                          Autopilot Slice
                        </p>
                        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
                            <div className="text-[10px] uppercase tracking-[0.1em] text-white/45">Dispatcher</div>
                            <div className="mt-1 text-[13px] text-white/80">OpenClaw</div>
                          </div>
                          <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
                            <div className="text-[10px] uppercase tracking-[0.1em] text-white/45">Executor</div>
                            <div className="mt-1 text-[13px] text-white/80">
                              {activeAutopilotSlice.agentName ?? 'Codex'}
                              {activeAutopilotSlice.agentId ? ` · ${activeAutopilotSlice.agentId}` : ''}
                            </div>
                          </div>
                          <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
                            <div className="text-[10px] uppercase tracking-[0.1em] text-white/45">Workstream</div>
                            <div className="mt-1 text-[13px] text-white/80">
                              {activeAutopilotSlice.workstreamTitle ?? activeAutopilotSlice.workstreamId ?? '—'}
                            </div>
                          </div>
                          <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
                            <div className="text-[10px] uppercase tracking-[0.1em] text-white/45">Policy</div>
                            <div className="mt-1 text-[13px] text-white/80">
                              {activeAutopilotSlice.domain ?? '—'}
                              {activeAutopilotSlice.requiredSkills.length > 0 ? ` · ${activeAutopilotSlice.requiredSkills.join(', ')}` : ''}
                            </div>
                          </div>
                        </div>

                        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-white/60">
                          <span className="rounded-full border border-white/[0.12] bg-black/20 px-2 py-0.5">
                            {activeAutopilotSlice.event}
                          </span>
                          {activeAutopilotSlice.parsedStatus && (
                            <span className="rounded-full border border-white/[0.12] bg-black/20 px-2 py-0.5">
                              status: {activeAutopilotSlice.parsedStatus}
                            </span>
                          )}
                          {typeof activeAutopilotSlice.hasOutput === 'boolean' && (
                            <span className="rounded-full border border-white/[0.12] bg-black/20 px-2 py-0.5">
                              output: {activeAutopilotSlice.hasOutput ? 'yes' : 'no'}
                            </span>
                          )}
                          {typeof activeAutopilotSlice.artifacts === 'number' && (
                            <span className="rounded-full border border-white/[0.12] bg-black/20 px-2 py-0.5">
                              artifacts: {activeAutopilotSlice.artifacts}
                            </span>
                          )}
                          {typeof activeAutopilotSlice.decisions === 'number' && (
                            <span className="rounded-full border border-white/[0.12] bg-black/20 px-2 py-0.5">
                              decisions: {activeAutopilotSlice.decisions}
                            </span>
                          )}
                          {typeof activeAutopilotSlice.statusUpdatesApplied === 'number' && (
                            <span className="rounded-full border border-white/[0.12] bg-black/20 px-2 py-0.5">
                              status updates: {activeAutopilotSlice.statusUpdatesApplied}
                            </span>
                          )}
                          {typeof activeAutopilotSlice.statusUpdatesBuffered === 'number' && activeAutopilotSlice.statusUpdatesBuffered > 0 && (
                            <span className="rounded-full border border-amber-400/25 bg-amber-500/10 px-2 py-0.5 text-amber-100/80">
                              buffered: {activeAutopilotSlice.statusUpdatesBuffered}
                            </span>
                          )}
                        </div>

                        {(activeAutopilotSlice.logPath || activeAutopilotSlice.outputPath) && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {activeAutopilotSlice.logPath && (
                              <button
                                type="button"
                                onClick={() => void copyText('Log path', activeAutopilotSlice.logPath ?? '')}
                                className="rounded-full border border-white/[0.12] bg-white/[0.04] px-3 py-1 text-[11px] text-white/70 transition hover:bg-white/[0.1]"
                              >
                                Copy log path
                              </button>
                            )}
                            {activeAutopilotSlice.outputPath && (
                              <button
                                type="button"
                                onClick={() => void copyText('Output path', activeAutopilotSlice.outputPath ?? '')}
                                className="rounded-full border border-white/[0.12] bg-white/[0.04] px-3 py-1 text-[11px] text-white/70 transition hover:bg-white/[0.1]"
                              >
                                Copy output path
                              </button>
                            )}
                          </div>
                        )}

                        {activeAutopilotSlice.error && (
                          <div className="mt-3 rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-[12px] text-red-100/80">
                            {activeAutopilotSlice.error}
                          </div>
                        )}
                      </div>
                    )}

                    {activeProvenance && (
                      <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
                        <p className="text-[11px] uppercase tracking-[0.11em] text-white/45">
                          Provenance
                        </p>
                        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {activeProvenance.domain && (
                            <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
                              <div className="text-[10px] uppercase tracking-[0.1em] text-white/45">Domain</div>
                              <div className="mt-1 text-[13px] text-white/80">{humanizeText(activeProvenance.domain)}</div>
                            </div>
                          )}
                          {(activeProvenance.provider || activeProvenance.model) && (
                            <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
                              <div className="text-[10px] uppercase tracking-[0.1em] text-white/45">Model</div>
                              <div className="mt-1 text-[13px] text-white/80">
                                {activeProvenance.provider ? `${humanizeText(activeProvenance.provider)} · ` : ''}
                                {activeProvenance.model ? humanizeModel(activeProvenance.model) : '—'}
                              </div>
                            </div>
                          )}
                          {activeProvenance.modelTier && (
                            <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
                              <div className="text-[10px] uppercase tracking-[0.1em] text-white/45">Model tier</div>
                              <div className="mt-1 text-[13px] text-white/80">{humanizeText(activeProvenance.modelTier)}</div>
                            </div>
                          )}
                          {activeProvenance.pluginVersion && (
                            <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
                              <div className="text-[10px] uppercase tracking-[0.1em] text-white/45">Plugin</div>
                              <div className="mt-1 text-[13px] text-white/80">v{activeProvenance.pluginVersion}</div>
                            </div>
                          )}
                          {activeProvenance.skillPack && (
                            <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2 sm:col-span-2">
                              <div className="text-[10px] uppercase tracking-[0.1em] text-white/45">Skill pack</div>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-white/80">
                                <span>
                                  {activeProvenance.skillPack.name ?? '—'}
                                  {activeProvenance.skillPack.version ? `@${activeProvenance.skillPack.version}` : ''}
                                  {activeProvenance.skillPack.source ? ` · ${activeProvenance.skillPack.source}` : ''}
                                </span>
                                {activeProvenance.skillPack.checksum && (
                                  <button
                                    type="button"
                                    onClick={() => void copyText('Skill pack checksum', activeProvenance.skillPack?.checksum ?? '')}
                                    className="rounded-full border border-white/[0.12] bg-white/[0.04] px-2.5 py-1 text-[11px] text-white/70 transition hover:bg-white/[0.1]"
                                  >
                                    sha {activeProvenance.skillPack.checksum.slice(0, 12)}…
                                  </button>
                                )}
                              </div>
                            </div>
                          )}
                          {activeProvenance.kickoffContextHash && (
                            <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2 sm:col-span-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-[10px] uppercase tracking-[0.1em] text-white/45">Kickoff context</div>
                                <button
                                  type="button"
                                  onClick={() => void copyText('Kickoff context hash', activeProvenance.kickoffContextHash ?? '')}
                                  className="rounded-full border border-white/[0.12] bg-white/[0.04] px-2.5 py-1 text-[11px] text-white/70 transition hover:bg-white/[0.1]"
                                >
                                  Copy hash
                                </button>
                              </div>
                              <div className="mt-1 text-[13px] text-white/80">
                                {activeProvenance.kickoffContextSource ? `${activeProvenance.kickoffContextSource} · ` : ''}
                                <span className="font-mono text-[12px] text-white/70">{activeProvenance.kickoffContextHash}</span>
                              </div>
                            </div>
                          )}
                          {activeProvenance.requiredSkills.length > 0 && (
                            <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2 sm:col-span-2">
                              <div className="text-[10px] uppercase tracking-[0.1em] text-white/45">Required skills</div>
                              <div className="mt-1 flex flex-wrap gap-1.5">
                                {activeProvenance.requiredSkills.map((skill) => (
                                  <span
                                    key={skill}
                                    className="rounded-full border border-white/[0.12] bg-white/[0.03] px-2 py-0.5 text-[11px] text-white/65"
                                  >
                                    {skill}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {activeSummaryText && (
                      <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
                        <p className="text-[11px] uppercase tracking-[0.11em] text-white/45">Summary</p>
                        {detailSummarySource === 'missing' && (
                          <p className="mt-1 text-[11px] text-amber-200/75">
                            Full local turn transcript was unavailable; showing the event summary payload.
                          </p>
                        )}
                        <MarkdownText
                          mode="block"
                          text={activeSummaryText}
                          className="mt-1.5 text-[14px] leading-relaxed text-white/82"
                        />
                      </div>
                    )}

                    {humanizeActivityBody(activeDecorated.item.description) && (
                      <div className="rounded-xl border border-white/[0.08] bg-black/25 p-3">
                        <p className="text-[11px] uppercase tracking-[0.11em] text-white/45">Details</p>
                        <MarkdownText
                          mode="block"
                          text={humanizeActivityBody(activeDecorated.item.description) ?? ''}
                          className="mt-1.5 text-[13px] leading-relaxed text-white/75"
                        />
                      </div>
                    )}

                    {activeArtifact && (
                      <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/[0.06] p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[11px] uppercase tracking-[0.11em] text-cyan-100/85">
                            Artifact Output
                          </p>
                          <div className="inline-flex rounded-full border border-white/[0.12] bg-black/30 p-0.5 text-[11px]">
                            <button
                              type="button"
                              onClick={() => setArtifactViewMode('structured')}
                              aria-pressed={artifactViewMode === 'structured'}
                              className={`rounded-full px-2.5 py-0.5 transition-colors ${
                                artifactViewMode === 'structured'
                                  ? 'bg-white/[0.12] text-white'
                                  : 'text-white/55 hover:text-white/80'
                              }`}
                            >
                              Structured
                            </button>
                            <button
                              type="button"
                              onClick={() => setArtifactViewMode('json')}
                              aria-pressed={artifactViewMode === 'json'}
                              className={`rounded-full px-2.5 py-0.5 transition-colors ${
                                artifactViewMode === 'json'
                                  ? 'bg-white/[0.12] text-white'
                                  : 'text-white/55 hover:text-white/80'
                              }`}
                            >
                              JSON
                            </button>
                          </div>
                        </div>
                        <p className="mt-1 text-[10px] text-cyan-100/55">Source: {activeArtifact.source}</p>
                        <div className="mt-2">
                          {artifactViewMode === 'structured' ? (
                            renderArtifactValue(activeArtifact.value)
                          ) : (
                            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-white/70">
                              {JSON.stringify(activeArtifact.value, null, 2)}
                            </pre>
                          )}
                        </div>
                      </div>
                    )}

                    {activeMetadataJson && (
                      <details className="rounded-xl border border-white/[0.08] bg-black/35 p-3">
                        <summary className="cursor-pointer select-none text-[11px] uppercase tracking-[0.11em] text-white/45">
                          Raw metadata
                        </summary>
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-white/65">
                          {activeMetadataJson}
                        </pre>
                      </details>
                    )}
                  </div>
                </motion.section>
              </AnimatePresence>
            </div>

            <div className="border-t border-white/[0.06] px-5 py-2.5 text-[11px] text-white/40 sm:px-6">
              Keyboard: ← previous · → next · Esc close
            </div>
          </div>
        )}
      </Modal>
    </PremiumCard>
  );
});
