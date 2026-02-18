import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import { humanizeText, humanizeModel } from '@/lib/humanize';
import type { Initiative, LiveActivityItem, LiveActivityType, SessionTreeNode } from '@/types';
import { MarkdownText } from '@/components/shared/MarkdownText';
import { Modal } from '@/components/shared/Modal';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { Pill } from '@/components/shared/Pill';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { ThreadView } from './ThreadView';
import type { ActivityTimeFilterId } from '@/lib/activityTimeFilters';
import { ACTIVITY_TIME_FILTERS, resolveActivityTimeFilter } from '@/lib/activityTimeFilters';
import { useArtifactViewer } from '@/components/artifacts/ArtifactViewerContext';

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
  onTimeFilterChange?: (next: ActivityTimeFilterId) => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  onClearSelection: () => void;
  onClearWorkstreamFilter?: () => void;
  onClearAgentFilter?: () => void;
  onFocusRunId?: (runId: string) => void;
  onPlayNextUp?: () => Promise<void> | void;
  onStartAutopilot?: () => Promise<void> | void;
  onCreateInitiative?: () => void;
  onOpenMissionControl?: () => void;
  isLoading?: boolean;
}

const INITIAL_RENDER_COUNT = 50;
const RENDER_STEP = 50;
const CLUSTER_EXPANDED_BATCH_SIZE = 20;
const MAX_RENDER_COUNT = 3_600;
const MAX_FILTER_POOL = 12_000;

type ActivityBucket = 'message' | 'artifact' | 'decision';
type ActivityFilterId = 'all' | 'messages' | 'artifacts' | 'decisions';
type SortOrder = 'newest' | 'oldest';
type DetailTabId = 'overview' | 'flow' | 'technical';
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

function asMetadataRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeActivityMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  // OrgX activity payloads may arrive wrapped as
  // { source_client, ..., metadata: { ...eventFields, metadata: {...} } }.
  // Flatten a few nested levels so extractors can consume event fields consistently.
  let flattened: Record<string, unknown> = { ...metadata };
  let cursor: Record<string, unknown> | undefined = asMetadataRecord(flattened.metadata);
  let depth = 0;
  while (cursor && depth < 4) {
    flattened = { ...flattened, ...cursor };
    cursor = asMetadataRecord(cursor.metadata);
    depth += 1;
  }
  return flattened;
}

function metadataForItem(item: LiveActivityItem | null | undefined): Record<string, unknown> | undefined {
  const raw = asMetadataRecord(item?.metadata);
  return normalizeActivityMetadata(raw);
}

function textFromMetadata(metadata: Record<string, unknown> | undefined): string {
  const normalized = normalizeActivityMetadata(metadata);
  if (!normalized) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(normalized)) {
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
  const metadata = metadataForItem(item);
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
  const metadata = metadataForItem(item);
  if (!metadata) return { agentId: null, agentName: null };

  const agentId =
    (typeof metadata.agent_id === 'string' && metadata.agent_id.trim().length > 0
      ? metadata.agent_id.trim()
      : null) ??
    (typeof metadata.agentId === 'string' && metadata.agentId.trim().length > 0
      ? metadata.agentId.trim()
      : null) ??
    (typeof item.agentId === 'string' && item.agentId.trim().length > 0 ? item.agentId.trim() : null);
  const agentName =
    (typeof metadata.agent_name === 'string' && metadata.agent_name.trim().length > 0
      ? metadata.agent_name.trim()
      : null) ??
    (typeof metadata.agentName === 'string' && metadata.agentName.trim().length > 0
      ? metadata.agentName.trim()
      : null) ??
    (typeof item.agentName === 'string' && item.agentName.trim().length > 0 ? item.agentName.trim() : null);

  return { agentId, agentName };
}

type ActivityActor = {
  id: string | null;
  name: string | null;
  label: string;
};

type ActivityActorMode = 'single' | 'handoff' | 'requested' | 'system';

type ActivityActorFlow = {
  requester: ActivityActor | null;
  executor: ActivityActor | null;
  mode: ActivityActorMode;
  primaryLabel: string;
  subtitle: string;
};

function normalizeActorValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveActorFromMetadata(
  metadata: Record<string, unknown> | undefined,
  idKeys: string[],
  nameKeys: string[]
): ActivityActor | null {
  if (!metadata) return null;

  let id: string | null = null;
  for (const key of idKeys) {
    const value = normalizeActorValue(metadata[key]);
    if (value) {
      id = value;
      break;
    }
  }

  let name: string | null = null;
  for (const key of nameKeys) {
    const value = normalizeActorValue(metadata[key]);
    if (value) {
      name = value;
      break;
    }
  }

  if (!id && !name) return null;
  return {
    id,
    name,
    label: name ?? id ?? 'System',
  };
}

function sameActor(a: ActivityActor | null, b: ActivityActor | null): boolean {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id.trim().toLowerCase() === b.id.trim().toLowerCase();
  if (!a.name || !b.name) return false;
  return a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
}

function resolveActivityActorFlow(item: LiveActivityItem): ActivityActorFlow {
  const metadata = metadataForItem(item);
  const identity = resolveAgentIdentity(item);
  const cleaned = cleanSystemTitle(item);

  const explicitRequester =
    item.requesterAgentId || item.requesterAgentName
      ? {
          id: item.requesterAgentId ?? null,
          name: item.requesterAgentName ?? null,
          label: item.requesterAgentName ?? item.requesterAgentId ?? 'System',
        }
      : null;

  const requester =
    explicitRequester ??
    resolveActorFromMetadata(
      metadata,
      [
        'requested_by_agent_id',
        'requestedByAgentId',
        'requester_agent_id',
        'requesterAgentId',
        'requester_id',
        'requesterId',
        'runner_agent_id',
        'runnerAgentId',
      ],
      [
        'requested_by_agent_name',
        'requestedByAgentName',
        'requester_agent_name',
        'requesterAgentName',
        'requester_name',
        'requesterName',
        'runner_agent_name',
        'runnerAgentName',
      ]
    ) ?? null;

  const explicitExecutor =
    item.executorAgentId || item.executorAgentName
      ? {
          id: item.executorAgentId ?? null,
          name: item.executorAgentName ?? null,
          label: item.executorAgentName ?? item.executorAgentId ?? 'Agent',
        }
      : null;

  const executor =
    explicitExecutor ??
    resolveActorFromMetadata(
      metadata,
      [
        'executed_by_agent_id',
        'executedByAgentId',
        'executor_agent_id',
        'executorAgentId',
        'delegated_to_agent_id',
        'delegatedToAgentId',
        'handoff_to_agent_id',
        'handoffToAgentId',
        'agent_id',
        'agentId',
      ],
      [
        'executed_by_agent_name',
        'executedByAgentName',
        'executor_agent_name',
        'executorAgentName',
        'delegated_to_agent_name',
        'delegatedToAgentName',
        'handoff_to_agent_name',
        'handoffToAgentName',
        'agent_name',
        'agentName',
      ]
    ) ??
    (identity.agentId || identity.agentName
      ? {
          id: identity.agentId,
          name: identity.agentName,
          label: identity.agentName ?? identity.agentId ?? 'Agent',
        }
      : null);

  if (requester && executor) {
    if (sameActor(requester, executor)) {
      return {
        requester,
        executor,
        mode: 'single',
        primaryLabel: executor.label,
        subtitle: executor.label,
      };
    }
    return {
      requester,
      executor,
      mode: 'handoff',
      primaryLabel: executor.label,
      subtitle: `${requester.label} -> ${executor.label}`,
    };
  }

  if (requester && !executor) {
    return {
      requester,
      executor: null,
      mode: 'requested',
      primaryLabel: requester.label,
      subtitle: `${requester.label} requested dispatch`,
    };
  }

  if (!requester && executor) {
    return {
      requester: null,
      executor,
      mode: 'single',
      primaryLabel: executor.label,
      subtitle: executor.label,
    };
  }

  if (cleaned.isSystem) {
    return {
      requester: null,
      executor: null,
      mode: 'system',
      primaryLabel: 'System',
      subtitle: 'System',
    };
  }

  return {
    requester: null,
    executor: null,
    mode: 'system',
    primaryLabel: item.agentName ?? item.agentId ?? 'OrgX',
    subtitle: item.agentName ?? item.agentId ?? 'System',
  };
}

function actorAvatarHint(actor: ActivityActor | null): string {
  if (!actor) return '';
  return [actor.id, actor.name, actor.label].filter(Boolean).join(' ');
}

function extractWorkstreamId(item: LiveActivityItem): string | null {
  const metadata = metadataForItem(item);
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

function extractArtifactId(item: LiveActivityItem | null | undefined): string | null {
  const metadata = metadataForItem(item);
  if (!metadata) return null;
  const candidates = ['artifact_id', 'artifactId', 'work_artifact_id'];
  for (const key of candidates) {
    const val = metadata[key];
    if (typeof val === 'string' && val.length > 0) return val;
  }
  return null;
}

const ACTIVITY_BUCKET_BY_EVENT = new Map<string, ActivityBucket>([
  ['autopilot_slice_artifact_buffered', 'artifact'],
  ['decision_buffered', 'decision'],
  ['auto_continue_spawn_guard_blocked', 'decision'],
  ['autopilot_slice_mcp_handshake_failed', 'decision'],
  ['autopilot_slice_timeout', 'decision'],
  ['autopilot_slice_log_stall', 'decision'],
]);

function normalizeActivityBucket(value: unknown): ActivityBucket | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'artifact') return 'artifact';
  if (normalized === 'decision') return 'decision';
  if (normalized === 'message') return 'message';
  return null;
}

function metadataBoolean(metadata: Record<string, unknown> | undefined, keys: string[]): boolean | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
  }
  return null;
}

function metadataCount(metadata: Record<string, unknown> | undefined, keys: string[]): number | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return Math.max(0, parsed);
    }
  }
  return null;
}

function metadataEventName(metadata: Record<string, unknown> | undefined): string | null {
  if (!metadata) return null;
  const raw = metadata.event;
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function classifyActivity(item: LiveActivityItem): ActivityBucket {
  const metadata = metadataForItem(item);
  const explicitBucket =
    normalizeActivityBucket(item.kind) ??
    normalizeActivityBucket(metadata?.activity_bucket) ??
    normalizeActivityBucket(metadata?.activityBucket) ??
    normalizeActivityBucket(metadata?.bucket);
  if (explicitBucket) return explicitBucket;

  if (item.type === 'artifact_created') return 'artifact';
  if (item.type === 'decision_requested' || item.type === 'decision_resolved') return 'decision';

  const eventName = metadataEventName(metadata);
  const decisionRequired =
    item.decisionRequired === true ||
    metadataBoolean(metadata, ['decision_required', 'decisionRequired']) === true;
  const artifacts = metadataCount(metadata, ['artifacts', 'artifact_count', 'artifactCount']) ?? 0;
  const decisions = metadataCount(metadata, ['decisions', 'decision_count', 'decisionCount']) ?? 0;
  const blockingDecisions =
    metadataCount(metadata, [
      'blocking_decisions',
      'blockingDecisions',
      'blocking_decision_count',
      'blockingDecisionCount',
    ]) ?? 0;
  const nonBlockingDecisions =
    metadataCount(metadata, [
      'non_blocking_decisions',
      'nonBlockingDecisions',
      'non_blocking_decision_count',
      'nonBlockingDecisionCount',
    ]) ?? 0;

  if (eventName === 'autopilot_slice_result') {
    if (decisionRequired || blockingDecisions > 0) return 'decision';
    if (artifacts > 0) return 'artifact';
    if (decisions > 0 || nonBlockingDecisions > 0) return 'decision';
    return 'message';
  }

  if (eventName && ACTIVITY_BUCKET_BY_EVENT.has(eventName)) {
    return ACTIVITY_BUCKET_BY_EVENT.get(eventName)!;
  }

  const hasArtifactReference =
    typeof metadata?.artifact_id === 'string' ||
    typeof metadata?.artifactId === 'string' ||
    typeof metadata?.work_artifact_id === 'string';
  if (hasArtifactReference || artifacts > 0) return 'artifact';

  if (decisionRequired || decisions > 0 || blockingDecisions > 0 || nonBlockingDecisions > 0) {
    return 'decision';
  }

  return 'message';
}

function labelForType(type: LiveActivityType): string {
  const labels: Partial<Record<LiveActivityType, string>> = {
    run_started: 'Run started',
    run_completed: 'Run completed',
    run_failed: 'Run failed',
    artifact_created: 'Artifact created',
    decision_requested: 'Decision requested',
    decision_resolved: 'Decision resolved',
    handoff_requested: 'Handoff requested',
    handoff_claimed: 'Handoff claimed',
    handoff_fulfilled: 'Handoff fulfilled',
    blocker_created: 'Blocker created',
    milestone_completed: 'Milestone completed',
    delegation: 'Delegation',
  };
  return labels[type] ?? humanizeText(type.split('_').join(' '));
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
  if (bucket === 'artifact') return 'Artifact';
  if (bucket === 'decision') return 'Decision';
  return 'Message';
}

function bucketColor(bucket: ActivityBucket): string {
  if (bucket === 'artifact') return colors.cyan;
  if (bucket === 'decision') return colors.amber;
  return colors.teal;
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

function numericFromValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function countFromValue(value: unknown): number | null {
  const numeric = numericFromValue(value);
  if (numeric !== null) return Math.max(0, Math.round(numeric));
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const nested = numericFromValue(record.count ?? record.total ?? record.size);
    if (nested !== null) return Math.max(0, Math.round(nested));
  }
  return null;
}

function percentFromValue(value: unknown): number | null {
  const numeric = numericFromValue(value);
  if (numeric === null) return null;
  const normalized = numeric > 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function metadataPercent(metadata: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const candidate = percentFromValue(metadata[key]);
    if (candidate !== null) return candidate;
  }
  return null;
}

type AutopilotSliceDetail = {
  event: string;
  agentId: string | null;
  agentName: string | null;
  requesterAgentId: string | null;
  requesterAgentName: string | null;
  dispatcherClient: string | null;
  initiativeId: string | null;
  domain: string | null;
  phase: string | null;
  progressPct: number | null;
  nextStep: string | null;
  requiredSkills: string[];
  initiativeStatus: string | null;
  initiativeTitle: string | null;
  workstreamId: string | null;
  workstreamStatus: string | null;
  workstreamTitle: string | null;
  taskTitle: string | null;
  milestoneTitle: string | null;
  taskIds: string[];
  milestoneIds: string[];
  parsedStatus: string | null;
  hasOutput: boolean | null;
  artifacts: number | null;
  decisions: number | null;
  blockingDecisions: number | null;
  nonBlockingDecisions: number | null;
  statusUpdatesApplied: number | null;
  statusUpdatesBuffered: number | null;
  stopReason: string | null;
  tokenBudget: number | null;
  tokensUsed: number | null;
  logPath: string | null;
  outputPath: string | null;
  error: string | null;
};

function extractAutopilotSliceDetail(item: LiveActivityItem | null): AutopilotSliceDetail | null {
  if (!item) return null;
  const metadata = metadataForItem(item);
  if (!metadata) return null;
  const event =
    typeof metadata.event === 'string' && metadata.event.trim().length > 0
      ? metadata.event.trim()
      : null;
  const eventName = event ?? '';
  const isAutopilotSliceEvent =
    eventName.startsWith('autopilot_slice') &&
    !eventName.includes('artifact');
  if (
    !event ||
    (!isAutopilotSliceEvent &&
      event !== 'auto_continue_stopped' &&
      event !== 'next_up_manual_dispatch_started')
  ) {
    return null;
  }

  const identity = resolveAgentIdentity(item);
  const requesterAgentId =
    (typeof metadata.requested_by_agent_id === 'string' && metadata.requested_by_agent_id.trim().length > 0
      ? metadata.requested_by_agent_id.trim()
      : null) ??
    (typeof metadata.requestedByAgentId === 'string' && metadata.requestedByAgentId.trim().length > 0
      ? metadata.requestedByAgentId.trim()
      : null) ??
    (typeof metadata.runner_agent_id === 'string' && metadata.runner_agent_id.trim().length > 0
      ? metadata.runner_agent_id.trim()
      : null) ??
    (typeof metadata.runnerAgentId === 'string' && metadata.runnerAgentId.trim().length > 0
      ? metadata.runnerAgentId.trim()
      : null) ??
    identity.agentId;
  const requesterAgentName =
    (typeof metadata.requested_by_agent_name === 'string' && metadata.requested_by_agent_name.trim().length > 0
      ? metadata.requested_by_agent_name.trim()
      : null) ??
    (typeof metadata.requestedByAgentName === 'string' && metadata.requestedByAgentName.trim().length > 0
      ? metadata.requestedByAgentName.trim()
      : null) ??
    (typeof metadata.runner_agent_name === 'string' && metadata.runner_agent_name.trim().length > 0
      ? metadata.runner_agent_name.trim()
      : null) ??
    (typeof metadata.runnerAgentName === 'string' && metadata.runnerAgentName.trim().length > 0
      ? metadata.runnerAgentName.trim()
      : null) ??
    identity.agentName;
  const dispatcherClient =
    (typeof metadata.source_client === 'string' && metadata.source_client.trim().length > 0
      ? metadata.source_client.trim()
      : null) ??
    (typeof metadata.sourceClient === 'string' && metadata.sourceClient.trim().length > 0
      ? metadata.sourceClient.trim()
      : null) ??
    (typeof item.runtimeClient === 'string' && item.runtimeClient.trim().length > 0
      ? item.runtimeClient.trim()
      : null);
  const requiredSkillsRaw = (metadata.required_skills ?? metadata.requiredSkills) as unknown;
  const requiredSkills = Array.isArray(requiredSkillsRaw)
    ? requiredSkillsRaw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];
  const inferredAgentNameFromSkills = inferAgentNameFromSkills(requiredSkills);

  const taskIdsRaw = (metadata.task_ids ?? metadata.taskIds) as unknown;
  const taskIds = Array.isArray(taskIdsRaw)
    ? taskIdsRaw.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];

  const milestoneIdsRaw = (metadata.milestone_ids ?? metadata.milestoneIds) as unknown;
  const milestoneIds = Array.isArray(milestoneIdsRaw)
    ? milestoneIdsRaw.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];

  const initiativeId =
    metadataString(metadata, ['initiative_id', 'initiativeId']) ??
    (typeof item.initiativeId === 'string' && item.initiativeId.trim().length > 0
      ? item.initiativeId.trim()
      : null);
  const initiativeTitle = metadataString(metadata, ['initiative_title', 'initiativeTitle']);
  const initiativeStatus = metadataString(metadata, ['initiative_status', 'initiativeStatus']);
  const workstreamId = extractWorkstreamId(item);
  const workstreamTitle = metadataString(metadata, ['workstream_title', 'workstreamTitle']);
  const workstreamStatus = metadataString(metadata, ['workstream_status', 'workstreamStatus']);
  const taskTitle = metadataString(metadata, ['task_title', 'taskTitle']);
  const milestoneTitle = metadataString(metadata, ['milestone_title', 'milestoneTitle']);
  const domain = metadataString(metadata, ['domain']);
  const phase = metadataString(metadata, ['phase', 'slice_phase', 'slicePhase']);
  const nextStep = metadataString(metadata, ['next_step', 'nextStep']);
  const progressPct = metadataPercent(metadata, [
    'progress_pct',
    'progressPct',
    'progress_percent',
    'progressPercent',
    'completion_pct',
    'completionPct',
    'slice_progress_pct',
    'sliceProgressPct',
  ]);
  const parsedStatus =
    typeof metadata.parsed_status === 'string'
      ? metadata.parsed_status
      : typeof metadata.parsedStatus === 'string'
        ? metadata.parsedStatus
        : null;
  const hasOutput =
    typeof metadata.has_output === 'boolean'
      ? metadata.has_output
      : typeof metadata.hasOutput === 'boolean'
        ? metadata.hasOutput
        : null;

  const logPath =
    typeof metadata.log_path === 'string'
      ? metadata.log_path
      : typeof metadata.logPath === 'string'
        ? metadata.logPath
        : null;
  const outputPath =
    typeof metadata.output_path === 'string'
      ? metadata.output_path
      : typeof metadata.outputPath === 'string'
        ? metadata.outputPath
        : null;
  const error = typeof metadata.error === 'string' ? metadata.error : null;

  const artifacts = countFromValue(metadata.artifacts ?? metadata.artifact_count ?? metadata.artifactCount);
  const decisions = countFromValue(metadata.decisions ?? metadata.decision_count ?? metadata.decisionCount);
  const decisionsNeededRaw = (metadata.decisions_needed ?? metadata.decisionsNeeded) as unknown;
  let blockingDecisions = countFromValue(
    metadata.blocking_decisions ??
      metadata.blockingDecisions ??
      metadata.blocking_decision_count ??
      metadata.blockingDecisionCount
  );
  let nonBlockingDecisions = countFromValue(
    metadata.non_blocking_decisions ??
      metadata.nonBlockingDecisions ??
      metadata.non_blocking_decision_count ??
      metadata.nonBlockingDecisionCount
  );
  if ((blockingDecisions === null || nonBlockingDecisions === null) && Array.isArray(decisionsNeededRaw)) {
    let blocking = 0;
    let nonBlocking = 0;
    for (const candidate of decisionsNeededRaw) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const record = candidate as Record<string, unknown>;
      if (record.blocking === false) nonBlocking += 1;
      else blocking += 1;
    }
    if (blockingDecisions === null) blockingDecisions = blocking;
    if (nonBlockingDecisions === null) nonBlockingDecisions = nonBlocking;
  }
  if (blockingDecisions === null && decisions !== null && item.decisionRequired === true) {
    blockingDecisions = decisions > 0 ? decisions : 1;
  }
  if (nonBlockingDecisions === null && decisions !== null && blockingDecisions !== null) {
    nonBlockingDecisions = Math.max(0, decisions - blockingDecisions);
  }
  if (blockingDecisions === null && decisions !== null && nonBlockingDecisions !== null) {
    blockingDecisions = Math.max(0, decisions - nonBlockingDecisions);
  }
  const statusUpdatesAppliedDirect = countFromValue(
    metadata.status_updates_applied ?? metadata.statusUpdatesApplied
  );
  const taskUpdates = countFromValue(metadata.task_updates ?? metadata.taskUpdates);
  const milestoneUpdates = countFromValue(metadata.milestone_updates ?? metadata.milestoneUpdates);
  const statusUpdatesApplied =
    statusUpdatesAppliedDirect ??
    (taskUpdates !== null || milestoneUpdates !== null
      ? (taskUpdates ?? 0) + (milestoneUpdates ?? 0)
      : null);
  const statusUpdatesBuffered = countFromValue(
    metadata.status_updates_buffered ?? metadata.statusUpdatesBuffered
  );
  const stopReason =
    typeof metadata.stop_reason === 'string'
      ? metadata.stop_reason
      : typeof metadata.stopReason === 'string'
        ? metadata.stopReason
        : null;
  const tokenBudget = numericFromValue(metadata.token_budget ?? metadata.tokenBudget);
  const tokensUsed = numericFromValue(metadata.tokens_used ?? metadata.tokensUsed);
  const rawAgentId =
    identity.agentId ??
    (typeof metadata.runner_agent_id === 'string' && metadata.runner_agent_id.trim().length > 0
      ? metadata.runner_agent_id.trim()
      : null) ??
    (typeof metadata.runnerAgentId === 'string' && metadata.runnerAgentId.trim().length > 0
      ? metadata.runnerAgentId.trim()
      : null);
  const agentName =
    identity.agentName ??
    (typeof metadata.runner_agent_name === 'string' && metadata.runner_agent_name.trim().length > 0
      ? metadata.runner_agent_name.trim()
      : null) ??
    (typeof metadata.runnerAgentName === 'string' && metadata.runnerAgentName.trim().length > 0
      ? metadata.runnerAgentName.trim()
      : null) ??
    inferredAgentNameFromSkills;
  const agentId = inferredAgentNameFromSkills && !identity.agentName ? null : rawAgentId;

  return {
    event,
    agentId,
    agentName,
    requesterAgentId,
    requesterAgentName,
    dispatcherClient,
    initiativeId,
    domain,
    phase,
    progressPct,
    nextStep,
    requiredSkills,
    initiativeStatus,
    initiativeTitle,
    workstreamId,
    workstreamStatus,
    workstreamTitle,
    taskTitle,
    milestoneTitle,
    taskIds,
    milestoneIds,
    parsedStatus,
    hasOutput,
    artifacts,
    decisions,
    blockingDecisions,
    nonBlockingDecisions,
    statusUpdatesApplied,
    statusUpdatesBuffered,
    stopReason,
    tokenBudget,
    tokensUsed,
    logPath,
    outputPath,
    error,
  };
}

type ArtifactPayload = {
  source: string;
  value: unknown;
};

type FileEvidencePath = {
  key: string;
  path: string;
};

function resolveFileEvidenceHref(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `/orgx/api/live/filesystem/open?path=${encodeURIComponent(trimmed)}`;
}

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
  const normalized = normalizeActivityMetadata(metadata);
  if (!normalized) return null;
  const metadataRecord = normalized;
  const nested = metadataRecord.orgx_provenance;
  const nestedRecord =
    nested && typeof nested === 'object' && !Array.isArray(nested) ? (nested as Record<string, unknown>) : null;
  const nestedSkill =
    nestedRecord?.skill_pack && typeof nestedRecord.skill_pack === 'object' && !Array.isArray(nestedRecord.skill_pack)
      ? (nestedRecord.skill_pack as Record<string, unknown>)
      : null;

  const pluginVersion =
    (typeof metadataRecord.orgx_plugin_version === 'string' ? metadataRecord.orgx_plugin_version : null) ??
    (typeof nestedRecord?.plugin_version === 'string' ? (nestedRecord.plugin_version as string) : null);

  const skillPackName =
    (typeof metadataRecord.skill_pack_name === 'string' ? metadataRecord.skill_pack_name : null) ??
    (typeof nestedSkill?.name === 'string' ? (nestedSkill.name as string) : null);
  const skillPackVersion =
    (typeof metadataRecord.skill_pack_version === 'string' ? metadataRecord.skill_pack_version : null) ??
    (typeof nestedSkill?.version === 'string' ? (nestedSkill.version as string) : null);
  const skillPackChecksum =
    (typeof metadataRecord.skill_pack_checksum === 'string' ? metadataRecord.skill_pack_checksum : null) ??
    (typeof nestedSkill?.checksum === 'string' ? (nestedSkill.checksum as string) : null);
  const skillPackSource =
    (typeof metadataRecord.skill_pack_source === 'string' ? metadataRecord.skill_pack_source : null) ??
    (typeof nestedSkill?.source === 'string' ? (nestedSkill.source as string) : null);

  const kickoffContextHash =
    typeof metadataRecord.kickoff_context_hash === 'string' ? metadataRecord.kickoff_context_hash : null;
  const kickoffContextSource =
    typeof metadataRecord.kickoff_context_source === 'string' ? metadataRecord.kickoff_context_source : null;
  const modelTier = typeof metadataRecord.spawn_guard_model_tier === 'string' ? metadataRecord.spawn_guard_model_tier : null;
  const provider = typeof metadataRecord.provider === 'string' ? metadataRecord.provider : null;
  const model = typeof metadataRecord.model === 'string' ? metadataRecord.model : null;
  const domain = typeof metadataRecord.domain === 'string' ? metadataRecord.domain : null;

  const requiredSkillsRaw = metadataRecord.required_skills ?? metadataRecord.requiredSkills;
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
  const metadata = metadataForItem(item);
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

function looksLikeFilesystemPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^[a-z]+:\/\//i.test(trimmed)) return false;
  if (/^data:/i.test(trimmed)) return false;
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('~/') ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    /^[.]{1,2}\//.test(trimmed)
  ) {
    return true;
  }
  return trimmed.includes('/') && !/\s{2,}/.test(trimmed);
}

function extractFileEvidencePaths(item: LiveActivityItem | null): FileEvidencePath[] {
  const metadata = metadataForItem(item);
  if (!metadata) return [];

  const entries: FileEvidencePath[] = [];
  const seen = new Set<string>();

  const pushPath = (key: string, value: unknown) => {
    if (typeof value !== 'string') return;
    const candidate = value.trim();
    if (!candidate || !looksLikeFilesystemPath(candidate)) return;
    const dedupeKey = `${key}:${candidate}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    entries.push({ key, path: candidate });
  };

  const visit = (record: Record<string, unknown>, prefix = '', depth = 0) => {
    if (depth > 2) return;
    for (const [rawKey, rawValue] of Object.entries(record)) {
      const key = prefix ? `${prefix}.${rawKey}` : rawKey;
      const keyLower = rawKey.toLowerCase();
      const keyLooksPathLike =
        keyLower.includes('path') ||
        keyLower === 'url' ||
        keyLower === 'uri' ||
        keyLower.endsWith('url') ||
        keyLower.endsWith('_file') ||
        keyLower.endsWith('file') ||
        keyLower.includes('artifact');

      if (keyLooksPathLike) {
        if (Array.isArray(rawValue)) {
          for (const value of rawValue) pushPath(key, value);
        } else {
          pushPath(key, rawValue);
        }
      }

      if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
        visit(rawValue as Record<string, unknown>, key, depth + 1);
      }
    }
  };

  visit(metadata);
  return entries;
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  keys: string[]
): string | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function inferAgentNameFromSkills(requiredSkills: string[]): string | null {
  if (requiredSkills.length !== 1) return null;
  const skill = requiredSkills[0]?.trim();
  if (!skill) return null;

  const directMap: Record<string, string> = {
    'orgx-marketing-agent': 'OrgX Marketing',
    'orgx-engineering-agent': 'OrgX Engineering',
    'orgx-design-agent': 'OrgX Design',
    'orgx-product-agent': 'OrgX Product',
    'orgx-sales-agent': 'OrgX Sales',
    'orgx-operations-agent': 'OrgX Operations',
    'orgx-orchestrator-agent': 'OrgX Orchestrator',
  };
  if (directMap[skill]) return directMap[skill];

  if (skill.endsWith('-agent')) {
    const stripped = skill.replace(/^orgx-/, '').replace(/-agent$/, '').trim();
    if (stripped.length === 0) return null;
    return `OrgX ${humanizeText(stripped)}`;
  }
  return null;
}

function formatAgentLabel(
  explicitName: string | null,
  explicitId: string | null,
  namesById?: Map<string, string>
): string {
  const normalizedName = typeof explicitName === 'string' && explicitName.trim().length > 0
    ? explicitName.trim()
    : null;
  const normalizedId = typeof explicitId === 'string' && explicitId.trim().length > 0
    ? explicitId.trim()
    : null;
  const defaultNameById: Record<string, string> = {
    main: 'Holt',
  };
  const inferredFromId = normalizedId
    ? namesById?.get(normalizedId) ?? defaultNameById[normalizedId] ?? null
    : null;
  const name = normalizedName ?? inferredFromId;

  if (name && normalizedId && normalizedId !== name) return `${name} · ${normalizedId}`;
  if (name) return name;
  return normalizedId ?? '—';
}

const UUID_LIKE_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_EXTRACT_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function collectActivityLinkIds(item: LiveActivityItem | null): Set<string> {
  const ids = new Set<string>();
  if (!item) return ids;

  for (const candidate of [item.title, item.summary, item.description]) {
    if (typeof candidate !== 'string') continue;
    for (const match of candidate.match(UUID_EXTRACT_REGEX) ?? []) {
      const normalized = match.trim().toLowerCase();
      if (UUID_LIKE_REGEX.test(normalized)) ids.add(normalized);
    }
  }

  if (typeof item.runId === 'string' && UUID_LIKE_REGEX.test(item.runId.trim())) {
    ids.add(item.runId.trim().toLowerCase());
  }

  const metadata = metadataForItem(item);
  if (!metadata) return ids;

  const scalarKeys = [
    'run_id',
    'runId',
    'last_run_id',
    'lastRunId',
    'active_run_id',
    'activeRunId',
    'slice_id',
    'sliceId',
    'worker_run_id',
    'workerRunId',
    'correlation_id',
    'correlationId',
    'initiative_id',
    'initiativeId',
    'workstream_id',
    'workstreamId',
    'task_id',
    'taskId',
    'milestone_id',
    'milestoneId',
    'outbox_event_id',
    'outboxEventId',
    'requester_id',
    'requesterId',
  ];

  const listKeys = [
    'task_ids',
    'taskIds',
    'milestone_ids',
    'milestoneIds',
    'allowed_workstream_ids',
    'allowedWorkstreamIds',
  ];

  for (const key of scalarKeys) {
    const value = metadata[key];
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (UUID_LIKE_REGEX.test(normalized)) ids.add(normalized);
    }
  }

  for (const key of listKeys) {
    const value = metadata[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry !== 'string') continue;
      const normalized = entry.trim().toLowerCase();
      if (UUID_LIKE_REGEX.test(normalized)) ids.add(normalized);
    }
  }

  return ids;
}

function extractNearestRelatedFileEvidencePaths(
  activeItem: LiveActivityItem | null,
  pool: LiveActivityItem[],
  existingPaths: Set<string>
): FileEvidencePath[] {
  if (!activeItem) return [];
  const activeMetadata = metadataForItem(activeItem);
  const activeWorkstreamId = metadataString(activeMetadata, ['workstream_id', 'workstreamId']);
  const activeInitiativeId = metadataString(activeMetadata, ['initiative_id', 'initiativeId']);
  const activeLinkIds = collectActivityLinkIds(activeItem);
  if (!activeWorkstreamId && !activeInitiativeId && activeLinkIds.size === 0) return [];

  const activeTimestamp = toEpoch(activeItem.timestamp);
  const relatedCandidates: Array<{
    priority: number;
    delta: number;
    evidence: FileEvidencePath[];
  }> = [];

  for (const candidate of pool) {
    if (candidate.id === activeItem.id) continue;
    const candidateMetadata = metadataForItem(candidate);
    if (!candidateMetadata) continue;

    const candidateWorkstreamId = metadataString(candidateMetadata, ['workstream_id', 'workstreamId']);
    const candidateInitiativeId = metadataString(candidateMetadata, ['initiative_id', 'initiativeId']);
    const candidateLinkIds = collectActivityLinkIds(candidate);
    const hasSharedId =
      activeLinkIds.size > 0 &&
      Array.from(activeLinkIds).some((id) => candidateLinkIds.has(id));

    const sameWorkstream =
      Boolean(activeWorkstreamId) &&
      Boolean(candidateWorkstreamId) &&
      activeWorkstreamId === candidateWorkstreamId;
    const sameInitiative =
      Boolean(activeInitiativeId) &&
      Boolean(candidateInitiativeId) &&
      activeInitiativeId === candidateInitiativeId;

    if (!hasSharedId && !sameWorkstream && !sameInitiative) continue;

    const candidateEvidence = extractFileEvidencePaths(candidate).filter(
      (entry) => !existingPaths.has(entry.path)
    );
    if (candidateEvidence.length === 0) continue;

    const delta = Math.abs(toEpoch(candidate.timestamp) - activeTimestamp);
    // Avoid attaching stale evidence from unrelated historical runs when we only
    // matched on broader context (initiative/workstream) instead of shared IDs.
    if (!hasSharedId && delta > 2 * 60 * 60 * 1000) continue;

    const priority = hasSharedId ? 0 : sameWorkstream ? 1 : 2;
    if (!hasSharedId && delta > 20 * 60 * 1000) continue;

    relatedCandidates.push({ priority, delta, evidence: candidateEvidence });
  }

  if (relatedCandidates.length === 0) return [];
  relatedCandidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.delta - b.delta;
  });

  const merged: FileEvidencePath[] = [];
  const seen = new Set(existingPaths);
  const topPriority = relatedCandidates[0].priority;
  for (const candidate of relatedCandidates) {
    if (candidate.priority !== topPriority) break;
    for (const entry of candidate.evidence) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      merged.push({ key: `related.${entry.key}`, path: entry.path });
      if (merged.length >= 8) return merged;
    }
  }
  return merged;
}

type RelatedAutopilotSliceDetail = {
  detail: AutopilotSliceDetail;
  relation: 'shared_id' | 'workstream' | 'initiative';
};

function extractNearestRelatedAutopilotSliceDetail(
  activeItem: LiveActivityItem | null,
  pool: LiveActivityItem[]
): RelatedAutopilotSliceDetail | null {
  if (!activeItem) return null;
  const activeMetadata = metadataForItem(activeItem);
  const activeWorkstreamId = metadataString(activeMetadata, ['workstream_id', 'workstreamId']);
  const activeInitiativeId = metadataString(activeMetadata, ['initiative_id', 'initiativeId']);
  const activeLinkIds = collectActivityLinkIds(activeItem);
  if (!activeWorkstreamId && !activeInitiativeId && activeLinkIds.size === 0) return null;

  const activeTimestamp = toEpoch(activeItem.timestamp);
  const candidates: Array<{
    priority: number;
    delta: number;
    relation: RelatedAutopilotSliceDetail['relation'];
    detail: AutopilotSliceDetail;
  }> = [];

  for (const candidate of pool) {
    if (candidate.id === activeItem.id) continue;
    const detail = extractAutopilotSliceDetail(candidate);
    if (!detail) continue;

    const candidateMetadata = metadataForItem(candidate);
    if (!candidateMetadata) continue;

    const candidateWorkstreamId = metadataString(candidateMetadata, ['workstream_id', 'workstreamId']);
    const candidateInitiativeId = metadataString(candidateMetadata, ['initiative_id', 'initiativeId']);
    const candidateLinkIds = collectActivityLinkIds(candidate);
    const hasSharedId =
      activeLinkIds.size > 0 &&
      Array.from(activeLinkIds).some((id) => candidateLinkIds.has(id));

    const sameWorkstream =
      Boolean(activeWorkstreamId) &&
      Boolean(candidateWorkstreamId) &&
      activeWorkstreamId === candidateWorkstreamId;
    const sameInitiative =
      Boolean(activeInitiativeId) &&
      Boolean(candidateInitiativeId) &&
      activeInitiativeId === candidateInitiativeId;

    if (!hasSharedId && !sameWorkstream && !sameInitiative) continue;

    const delta = Math.abs(toEpoch(candidate.timestamp) - activeTimestamp);
    if (!hasSharedId && delta > 20 * 60 * 1000) continue;

    const relation: RelatedAutopilotSliceDetail['relation'] = hasSharedId
      ? 'shared_id'
      : sameWorkstream
        ? 'workstream'
        : 'initiative';
    const priority = relation === 'shared_id' ? 0 : relation === 'workstream' ? 1 : 2;
    candidates.push({ priority, delta, relation, detail });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.delta - b.delta;
  });

  const winner = candidates[0];
  return { detail: winner.detail, relation: winner.relation };
}

type AutopilotProgressTone = 'neutral' | 'positive' | 'warning' | 'critical';

type AutopilotProgressDetail = {
  pct: number;
  source: 'metadata' | 'session' | 'lifecycle';
  label: string;
  tone: AutopilotProgressTone;
};

function normalizeStatusKey(value: string | null | undefined): string {
  if (!value) return '';
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function isDoneLikeStatus(value: string | null | undefined): boolean {
  const key = normalizeStatusKey(value);
  return ['done', 'complete', 'completed', 'stopped', 'success'].includes(key);
}

function progressToneForAutopilot(detail: AutopilotSliceDetail): AutopilotProgressTone {
  const statusKey = normalizeStatusKey(detail.parsedStatus);
  const eventKey = normalizeStatusKey(detail.event);
  if (
    statusKey === 'failed' ||
    statusKey === 'error' ||
    statusKey === 'timed_out' ||
    statusKey === 'timeout' ||
    statusKey === 'aborted' ||
    eventKey.includes('error') ||
    eventKey.includes('timeout')
  ) {
    return 'critical';
  }
  if (statusKey === 'blocked' || detail.stopReason === 'blocked') return 'warning';
  if (isDoneLikeStatus(statusKey) || detail.stopReason === 'completed') return 'positive';
  return 'neutral';
}

function inferLifecycleProgress(detail: AutopilotSliceDetail): number | null {
  if (isDoneLikeStatus(detail.parsedStatus) || detail.stopReason === 'completed') return 100;

  const statusKey = normalizeStatusKey(detail.parsedStatus);
  if (statusKey === 'blocked' || statusKey === 'error' || statusKey === 'failed') return 100;

  const event = detail.event;
  if (event === 'next_up_manual_dispatch_started') return 8;
  if (event === 'autopilot_slice_dispatched') return 14;
  if (event === 'autopilot_slice_status_updates_buffered') return 72;
  if (event === 'autopilot_slice_result') return 92;
  if (event === 'auto_continue_stopped') return 100;
  if (event.startsWith('autopilot_slice')) return 56;

  return null;
}

function coerceProgressPercent(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function resolveAutopilotProgress(
  detail: AutopilotSliceDetail | null,
  sessionProgress: number | null
): AutopilotProgressDetail | null {
  if (!detail && sessionProgress === null) return null;
  if (detail?.progressPct !== null && detail?.progressPct !== undefined) {
    return {
      pct: coerceProgressPercent(detail.progressPct) ?? 0,
      source: 'metadata',
      label: 'Reported by slice metadata',
      tone: detail ? progressToneForAutopilot(detail) : 'neutral',
    };
  }
  if (sessionProgress !== null) {
    return {
      pct: sessionProgress,
      source: 'session',
      label: 'Derived from runtime session',
      tone: detail ? progressToneForAutopilot(detail) : 'neutral',
    };
  }
  if (!detail) return null;
  const lifecycle = inferLifecycleProgress(detail);
  if (lifecycle === null) return null;
  return {
    pct: lifecycle,
    source: 'lifecycle',
    label: 'Estimated from dispatch lifecycle',
    tone: progressToneForAutopilot(detail),
  };
}

type DetailOutcomeTone = 'neutral' | 'warning' | 'critical' | 'positive';

type DetailOutcome = {
  label: string;
  summary: string;
  hint: string | null;
  tone: DetailOutcomeTone;
};

function describeDetailOutcome(
  item: LiveActivityItem,
  detail: AutopilotSliceDetail | null,
  breakdown: {
    decisions: number | null;
    blockingDecisions: number | null;
    nonBlockingDecisions: number | null;
    stopReason: string | null;
    parsedStatus: string | null;
  } | null
): DetailOutcome | null {
  const metadata = metadataForItem(item);
  const status = normalizeStatusKey(item.state ?? item.phase ?? item.kind ?? item.type);
  const parsedStatus = normalizeStatusKey(breakdown?.parsedStatus ?? detail?.parsedStatus ?? status);
  const stopReason = normalizeStatusKey(breakdown?.stopReason ?? detail?.stopReason);
  const blockedReason =
    metadataString(metadata, ['blocked_reason', 'blockedReason', 'error', 'message']) ??
    detail?.error ??
    item.description ??
    null;
  const decisionCount = Math.max(0, breakdown?.decisions ?? detail?.decisions ?? 0);
  const inferredBlockingDecisions = Math.max(
    0,
    breakdown?.blockingDecisions ?? detail?.blockingDecisions ?? (item.decisionRequired === true ? Math.max(1, decisionCount) : 0)
  );
  const inferredNonBlockingDecisions = Math.max(
    0,
    breakdown?.nonBlockingDecisions ??
      detail?.nonBlockingDecisions ??
      Math.max(0, decisionCount - inferredBlockingDecisions)
  );
  const decisionsNeeded =
    item.decisionRequired === true ||
    item.type === 'decision_requested' ||
    inferredBlockingDecisions > 0 ||
    parsedStatus === 'needs_decision';
  const completionLike =
    item.type === 'run_completed' ||
    item.type === 'milestone_completed' ||
    isDoneLikeStatus(parsedStatus) ||
    stopReason === 'completed';

  if (
    item.type === 'run_failed' ||
    item.type === 'blocker_created' ||
    parsedStatus === 'blocked' ||
    parsedStatus === 'failed' ||
    parsedStatus === 'error' ||
    stopReason === 'blocked' ||
    stopReason === 'error'
  ) {
    return {
      label: 'Blocked',
      summary: blockedReason
        ? humanizeActivityBody(blockedReason) ?? 'Execution is blocked.'
        : 'Execution is blocked and needs intervention.',
      hint: decisionsNeeded
        ? 'Resolve the pending decision, then resume the session.'
        : 'Open the session and retry after fixing the blocker.',
      tone: 'critical',
    };
  }

  if (decisionsNeeded) {
    return {
      label: 'Needs decision',
      summary: 'Execution paused pending approval or a human choice.',
      hint: 'Review the Decisions panel and approve the pending item to continue.',
      tone: 'warning',
    };
  }

  if (completionLike && inferredNonBlockingDecisions > 0) {
    return {
      label: 'Completed + follow-up',
      summary: `Execution completed. ${inferredNonBlockingDecisions} non-blocking decision${inferredNonBlockingDecisions === 1 ? '' : 's'} were logged for optional follow-up.`,
      hint: 'Review the decision for optimization, but no approval is required to mark this slice complete.',
      tone: 'positive',
    };
  }

  if (item.type === 'decision_resolved') {
    return {
      label: 'Decision resolved',
      summary: 'A pending decision was completed.',
      hint: null,
      tone: 'positive',
    };
  }

  if (completionLike) {
    return {
      label: 'Completed',
      summary: 'Execution completed successfully.',
      hint: null,
      tone: 'positive',
    };
  }

  if (item.type === 'run_started' || status === 'running' || status === 'in_progress') {
    return {
      label: 'In progress',
      summary: 'Execution is actively running.',
      hint: null,
      tone: 'neutral',
    };
  }

  return null;
}

function renderArtifactValue(value: unknown): ReactNode {
  if (typeof value === 'string') {
    return <MarkdownText mode="block" text={value} className="text-body leading-relaxed text-primary" />;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return <p className="text-body text-primary">{String(value)}</p>;
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
            <dt className="text-micro font-semibold tracking-[0.02em] text-secondary">
              {humanizeText(key)}
            </dt>
            <dd className="mt-1 text-body text-primary">
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

  return <p className="text-body text-secondary">No artifact payload.</p>;
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

const SYSTEM_NOISE_PATTERNS = [
  /^User:\s*System:/i,
  /Exec failed/i,
  /SIGKILL/i,
  /SIGTERM/i,
  /stack trace/i,
  /Traceback \(most recent/i,
  /^\s*\{[\s"]/,
  /Error: /,
  /execution policy/i,
  /outbox replay/i,
  /changeset replayed/i,
];

function isSystemNoise(title: string): boolean {
  return SYSTEM_NOISE_PATTERNS.some((pattern) => pattern.test(title));
}

function cleanSystemTitle(item: LiveActivityItem): { title: string; isSystem: boolean } {
  const raw = item.title ?? '';
  if (!isSystemNoise(raw)) {
    return { title: humanizeText(raw) || humanizeText(labelForType(item.type)), isSystem: false };
  }

  if (/Exec failed|SIGKILL|SIGTERM|Error: /i.test(raw)) {
    return { title: 'Execution failed', isSystem: true };
  }
  if (/outbox replay|changeset replayed/i.test(raw)) {
    return { title: 'Changes synced', isSystem: true };
  }
  if (/execution policy/i.test(raw)) {
    return { title: 'System directive', isSystem: true };
  }
  return { title: 'System event', isSystem: true };
}

const LOW_SIGNAL_SYNC_EVENTS = new Set([
  'changeset_replayed',
  'changeset_applied',
  'changeset.replayed',
  'changeset.applied',
  'outbox_replay_applied',
  'outbox_replayed',
  'sync_applied',
  'sync.applied',
  'sentinel_changeset_applied',
  'sentinel_decision_applied',
  'sentinel.changeset.applied',
  'sentinel.decision.applied',
]);

function isOutboxSyncReplayEvent(item: LiveActivityItem): boolean {
  const metadata = metadataForItem(item);
  if (!metadata) return false;

  const eventName =
    (typeof metadata.event === 'string' && metadata.event.trim().length > 0
      ? metadata.event.trim().toLowerCase()
      : null) ??
    (typeof metadata.event_name === 'string' && metadata.event_name.trim().length > 0
      ? metadata.event_name.trim().toLowerCase()
      : null) ??
    (typeof metadata.eventName === 'string' && metadata.eventName.trim().length > 0
      ? metadata.eventName.trim().toLowerCase()
      : null);

  const sourceClient =
    (typeof metadata.source_client === 'string' ? metadata.source_client : null) ??
    (typeof metadata.sourceClient === 'string' ? metadata.sourceClient : null);
  const sourceLower = sourceClient?.toLowerCase() ?? '';
  const kindLower =
    (typeof item.kind === 'string' && item.kind.trim().length > 0
      ? item.kind.trim().toLowerCase()
      : null) ??
    (typeof metadata.kind === 'string' && metadata.kind.trim().length > 0
      ? metadata.kind.trim().toLowerCase()
      : null) ??
    (typeof metadata.event_kind === 'string' && metadata.event_kind.trim().length > 0
      ? metadata.event_kind.trim().toLowerCase()
      : null) ??
    (typeof metadata.eventKind === 'string' && metadata.eventKind.trim().length > 0
      ? metadata.eventKind.trim().toLowerCase()
      : null) ??
    '';
  const hasChangesetKind = /(changeset[\._ ]?(applied|replayed)|sync[\._ ]?applied|sentinel[\._ ]?(changeset|decision)[\._ ]?applied)/i.test(
    kindLower
  );

  const replayed = metadata.replayed === true;
  const hasChangesetId =
    (typeof metadata.changeset_id === 'string' && metadata.changeset_id.trim().length > 0) ||
    (typeof metadata.changesetId === 'string' && metadata.changesetId.trim().length > 0);
  const hasSyncTitle = /changes synced|changeset replayed|changeset applied|outbox replay/i.test(
    `${item.title ?? ''} ${item.summary ?? ''} ${item.description ?? ''}`
  );

  if (eventName && LOW_SIGNAL_SYNC_EVENTS.has(eventName)) return true;
  if (hasChangesetKind) return true;
  if (replayed && (hasChangesetId || hasSyncTitle)) return true;
  if (hasChangesetId && (hasSyncTitle || sourceLower.includes('outbox') || sourceLower.includes('replay'))) {
    return true;
  }
  if (sourceLower.includes('outbox_replay') && hasSyncTitle) return true;
  return false;
}

function syncReplaySummary(item: LiveActivityItem | null): string | null {
  if (!item || !isOutboxSyncReplayEvent(item)) return null;
  const metadata = metadataForItem(item);
  const appliedCount = countFromValue(
    metadata?.applied_count ?? metadata?.appliedCount ?? metadata?.applied ?? null
  );
  const idempotencyKey =
    (typeof metadata?.idempotency_key === 'string' ? metadata.idempotency_key : null) ??
    (typeof metadata?.idempotencyKey === 'string' ? metadata.idempotencyKey : null);
  const idempotencyTarget = idempotencyKey?.match(/sentinel:([a-z_]+):/i)?.[1] ?? null;
  const entityType =
    metadataString(metadata, ['entity_type', 'entityType']) ??
    idempotencyTarget ??
    (item.type === 'milestone_completed' ? 'milestone' : null);

  const countLabel =
    appliedCount !== null
      ? `${appliedCount} change${appliedCount === 1 ? '' : 's'}`
      : 'Queued changes';
  const entityLabel = entityType ? ` for ${humanizeText(entityType).toLowerCase()}` : '';
  return `${countLabel}${entityLabel} were synced from local replay.`;
}

function getLocalTurnReference(item: LiveActivityItem | null): {
  turnId: string;
  sessionKey: string | null;
  runId: string | null;
} | null {
  if (!item) return null;
  const metadata = metadataForItem(item);
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
  timeFilterId = '30m',
  onTimeFilterChange,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  onClearSelection,
  onClearWorkstreamFilter,
  onClearAgentFilter,
  onFocusRunId,
  onPlayNextUp,
  onStartAutopilot,
  onCreateInitiative,
  onOpenMissionControl,
  isLoading = false,
}: ActivityTimelineProps) {
  const prefersReducedMotion = useReducedMotion();
  const { open: openArtifactViewer } = useArtifactViewer();
  const [activeFilter, setActiveFilter] = useState<ActivityFilterId>('all');
  const [showSyncEvents, setShowSyncEvents] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState('');
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set());
  const [clusterVisibleCounts, setClusterVisibleCounts] = useState<Record<string, number>>({});
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [renderCount, setRenderCount] = useState(INITIAL_RENDER_COUNT);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [detailMenuOpen, setDetailMenuOpen] = useState(false);
  const [detailDirection, setDetailDirection] = useState<1 | -1>(1);
  const [activeDetailTab, setActiveDetailTab] = useState<DetailTabId>('overview');
  const [artifactViewMode, setArtifactViewMode] = useState<'structured' | 'json'>('structured');
  const [detailSummaryOverride, setDetailSummaryOverride] = useState<string | null>(null);
  const [detailSummarySource, setDetailSummarySource] = useState<'feed' | 'local' | 'missing'>('feed');
  const [detailHeadlineOverride, setDetailHeadlineOverride] = useState<string | null>(null);
  const [detailHeadlineSource, setDetailHeadlineSource] = useState<HeadlineSource>(null);
  const [headlineEndpointUnsupported, setHeadlineEndpointUnsupported] = useState(false);
  const [emptyActionPending, setEmptyActionPending] = useState<'play' | 'autopilot' | null>(null);
  const [emptyActionError, setEmptyActionError] = useState<string | null>(null);
  const controlsMenuRef = useRef<HTMLDivElement | null>(null);
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
  const sessionProgressById = useMemo(() => {
    const map = new Map<string, number>();
    for (const session of sessions) {
      const progress = coerceProgressPercent(session.progress);
      if (progress === null) continue;
      map.set(session.runId, progress);
      map.set(session.id, progress);
    }
    return map;
  }, [sessions]);
  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of sessions) {
      if (!session.agentId || !session.agentName) continue;
      map.set(session.agentId, session.agentName);
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
  // "Next Up" queue controls live in the right sidebar, not in the Activity feed.

  const decoratedActivity = useMemo(() => {
    return activity.map((item) => {
      const runId = resolveRunId(item);
      const bucket = classifyActivity(item);
      const searchText = [
        item.title,
        item.description,
        item.summary,
        item.agentName,
        textFromMetadata(metadataForItem(item)),
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

  const selectedRunIdSet = useMemo(
    () => new Set(selectedRunIds.filter((value) => value && value.trim().length > 0)),
    [selectedRunIds]
  );

  const hasSessionFilter = selectedRunIdSet.size > 0;
  const emptyTimeFilters = useMemo(
    () =>
      ACTIVITY_TIME_FILTERS.filter((option) =>
        ['30m', 'live', '24h', '7d', 'all'].includes(option.id)
      ),
    []
  );
  const filteredSession = useMemo(() => {
    if (!hasSessionFilter) return null;
    for (const candidate of selectedRunIdSet) {
      const match = sessions.find((session) => session.runId === candidate || session.id === candidate);
      if (match) return match;
    }
    return null;
  }, [hasSessionFilter, selectedRunIdSet, sessions]);

  const { filtered, filteredTotal, hiddenCount, hiddenSyncCount } = useMemo(() => {
    const matched: DecoratedActivityItem[] = [];
    let overflow = 0;
    let filteredSyncEvents = 0;
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

      const identity = resolveAgentIdentity(decorated.item);
      if (agentFilter && identity.agentName !== agentFilter) {
        continue;
      }

      if (!showSyncEvents && isOutboxSyncReplayEvent(decorated.item)) {
        filteredSyncEvents += 1;
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
      hiddenSyncCount: filteredSyncEvents,
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
    showSyncEvents,
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
        const normalizedClusterTitle = cleanSystemTitle(decorated.item).title.trim().toLowerCase();
        const clusterKey = `${decorated.item.type}::${normalizedClusterTitle}`;
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
    setClusterVisibleCounts((prev) => {
      if (Object.prototype.hasOwnProperty.call(prev, clusterKey)) {
        const next = { ...prev };
        delete next[clusterKey];
        return next;
      }
      return {
        ...prev,
        [clusterKey]: CLUSTER_EXPANDED_BATCH_SIZE,
      };
    });
  }, []);

  const loadMoreClusterItems = useCallback((clusterKey: string, maxItems: number) => {
    setClusterVisibleCounts((prev) => {
      const current = prev[clusterKey] ?? CLUSTER_EXPANDED_BATCH_SIZE;
      const nextVisible = Math.min(maxItems, current + CLUSTER_EXPANDED_BATCH_SIZE);
      if (nextVisible === current) return prev;
      return {
        ...prev,
        [clusterKey]: nextVisible,
      };
    });
  }, []);

  const renderableTotal = useMemo(
    () => Math.min(MAX_RENDER_COUNT, Math.min(MAX_FILTER_POOL, filteredTotal)),
    [filteredTotal]
  );

  useEffect(() => {
    setRenderCount(INITIAL_RENDER_COUNT);
    setExpandedClusters(new Set());
    setClusterVisibleCounts({});
  }, [
    activeFilter,
    agentFilter,
    hasSessionFilter,
    query,
    selectedWorkstreamId,
    showSyncEvents,
    sortOrder,
    timeFilterId,
  ]);

  useEffect(() => {
    if (!viewMenuOpen) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (controlsMenuRef.current?.contains(target)) return;
      setViewMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setViewMenuOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [viewMenuOpen]);

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
  const activeArtifactId = useMemo(
    () => extractArtifactId(activeDecorated?.item ?? null),
    [activeDecorated]
  );
  const activeAutopilotSlice = useMemo(
    () => extractAutopilotSliceDetail(activeDecorated?.item ?? null),
    [activeDecorated]
  );
  const activeRelatedAutopilotSlice = useMemo(
    () =>
      activeAutopilotSlice
        ? null
        : extractNearestRelatedAutopilotSliceDetail(activeDecorated?.item ?? null, activity),
    [activeAutopilotSlice, activeDecorated, activity]
  );
  const activeActorFlow = useMemo(
    () => (activeDecorated ? resolveActivityActorFlow(activeDecorated.item) : null),
    [activeDecorated]
  );
  const activeAutopilotContext = activeAutopilotSlice ?? activeRelatedAutopilotSlice?.detail ?? null;
  const activeAutopilotRequesterLabel = useMemo(
    () =>
      formatAgentLabel(
        activeAutopilotContext?.requesterAgentName ?? activeActorFlow?.requester?.name ?? null,
        activeAutopilotContext?.requesterAgentId ?? activeActorFlow?.requester?.id ?? null,
        agentNameById
      ),
    [activeAutopilotContext, activeActorFlow, agentNameById]
  );
  const activeAutopilotExecutorLabel = useMemo(() => {
    const label = formatAgentLabel(
      activeAutopilotContext?.agentName ?? activeActorFlow?.executor?.name ?? null,
      activeAutopilotContext?.agentId ?? activeActorFlow?.executor?.id ?? null,
      agentNameById
    );
    return label === '—' ? activeActorFlow?.primaryLabel ?? 'Codex' : label;
  }, [activeAutopilotContext, activeActorFlow, agentNameById]);
  const activeSessionProgress = useMemo(() => {
    if (!activeDecorated?.runId) return null;
    return sessionProgressById.get(activeDecorated.runId) ?? null;
  }, [activeDecorated, sessionProgressById]);
  const activeAutopilotProgress = useMemo(
    () => resolveAutopilotProgress(activeAutopilotContext, activeSessionProgress),
    [activeAutopilotContext, activeSessionProgress]
  );
  const activeExecutionBreakdown = useMemo(() => {
    const context = activeAutopilotContext;
    if (!context) return null;

    const initiativeId = context.initiativeId ?? activeDecorated?.item.initiativeId ?? null;
    const initiative = initiativeId ? initiatives.find((entry) => entry.id === initiativeId) ?? null : null;
    const initiativeTitle = context.initiativeTitle ?? initiative?.name ?? null;
    const initiativeStatus = context.initiativeStatus ?? initiative?.status ?? null;

    const initiativeWorkstreams = initiative?.workstreams ?? [];
    const totalInitiativeWorkstreams = initiativeWorkstreams.length > 0 ? initiativeWorkstreams.length : null;
    const doneInitiativeWorkstreams =
      totalInitiativeWorkstreams !== null
        ? initiativeWorkstreams.filter((entry) => isDoneLikeStatus(entry.status)).length
        : null;
    const initiativeWorkstreamPct =
      totalInitiativeWorkstreams && doneInitiativeWorkstreams !== null
        ? Math.round((doneInitiativeWorkstreams / totalInitiativeWorkstreams) * 100)
        : null;

    const workstreamId = context.workstreamId ?? null;
    const workstreamFromInitiative =
      workstreamId && initiativeWorkstreams.length > 0
        ? initiativeWorkstreams.find((entry) => entry.id === workstreamId) ?? null
        : null;
    const workstreamTitle =
      context.workstreamTitle ??
      workstreamFromInitiative?.name ??
      (workstreamId ? workstreamNameById.get(workstreamId) ?? null : null);
    const workstreamStatus = context.workstreamStatus ?? workstreamFromInitiative?.status ?? null;

    return {
      initiativeId,
      initiativeTitle,
      initiativeStatus,
      totalInitiativeWorkstreams,
      doneInitiativeWorkstreams,
      initiativeWorkstreamPct,
      workstreamId,
      workstreamTitle,
      workstreamStatus,
      taskTitle: context.taskTitle,
      milestoneTitle: context.milestoneTitle,
      scopedTaskCount: context.taskIds.length,
      scopedMilestoneCount: context.milestoneIds.length,
      statusUpdatesApplied: context.statusUpdatesApplied,
      statusUpdatesBuffered: context.statusUpdatesBuffered,
      artifacts: context.artifacts,
      decisions: context.decisions,
      blockingDecisions: context.blockingDecisions,
      nonBlockingDecisions: context.nonBlockingDecisions,
      tokensUsed: context.tokensUsed,
      tokenBudget: context.tokenBudget,
      nextStep: context.nextStep,
      phase: context.phase,
      stopReason: context.stopReason,
      parsedStatus: context.parsedStatus,
    };
  }, [activeAutopilotContext, activeDecorated, initiatives, workstreamNameById]);
  const activeOutcome = useMemo(
    () =>
      activeDecorated
        ? describeDetailOutcome(
            activeDecorated.item,
            activeAutopilotContext,
            activeExecutionBreakdown
              ? {
                  decisions: activeExecutionBreakdown.decisions,
                  blockingDecisions: activeExecutionBreakdown.blockingDecisions,
                  nonBlockingDecisions: activeExecutionBreakdown.nonBlockingDecisions,
                  stopReason: activeExecutionBreakdown.stopReason,
                  parsedStatus: activeExecutionBreakdown.parsedStatus,
                }
              : null
          )
        : null,
    [activeAutopilotContext, activeDecorated, activeExecutionBreakdown]
  );
  const activeAutopilotProgressColor = useMemo(() => {
    if (!activeAutopilotProgress) return colors.teal;
    if (activeAutopilotProgress.tone === 'positive') return colors.lime;
    if (activeAutopilotProgress.tone === 'warning') return colors.amber;
    if (activeAutopilotProgress.tone === 'critical') return colors.red;
    return colors.teal;
  }, [activeAutopilotProgress]);
  const activeProvenance = useMemo(
    () => extractProvenance(metadataForItem(activeDecorated?.item ?? null)),
    [activeDecorated]
  );
  const activeMetadata = useMemo(
    () => metadataForItem(activeDecorated?.item ?? null),
    [activeDecorated]
  );
  const activeIdentity = useMemo(
    () =>
      activeDecorated
        ? resolveAgentIdentity(activeDecorated.item)
        : { agentId: null, agentName: null },
    [activeDecorated]
  );
  const activeMetadataJson = useMemo(
    () =>
      metadataToJson(
        asMetadataRecord(activeDecorated?.item.metadata) ?? undefined
      ),
    [activeDecorated]
  );
  const activeResolvedMetadataJson = useMemo(
    () => metadataToJson(activeMetadata),
    [activeMetadata]
  );
  const activeFileEvidence = useMemo(() => {
    const direct = extractFileEvidencePaths(activeDecorated?.item ?? null);
    if (direct.length > 0) return direct;
    return extractNearestRelatedFileEvidencePaths(
      activeDecorated?.item ?? null,
      activity,
      new Set()
    );
  }, [activeDecorated, activity]);
  const primaryEvidenceHref = useMemo(() => {
    if (activeFileEvidence.length === 0) return null;
    const first = activeFileEvidence[0];
    return first ? resolveFileEvidenceHref(first.path) : null;
  }, [activeFileEvidence]);
  const activeSummaryText = useMemo(() => {
    const override = humanizeActivityBody(detailSummaryOverride);
    if (override) return override;
    const syncSummary = syncReplaySummary(activeDecorated?.item ?? null);
    if (syncSummary) return syncSummary;
    return (
      humanizeActivityBody(activeDecorated?.item.summary) ??
      humanizeActivityBody(activeDecorated?.item.description)
    );
  }, [detailSummaryOverride, activeDecorated]);
  const activeIsSyncReplay = useMemo(
    () => (activeDecorated ? isOutboxSyncReplayEvent(activeDecorated.item) : false),
    [activeDecorated]
  );

  const closeDetail = useCallback(() => {
    setActiveItemId(null);
  }, []);

  const runEmptyAction = useCallback(
    async (action: 'play' | 'autopilot', handler: (() => Promise<void> | void) | undefined) => {
      if (!handler) return;
      setEmptyActionError(null);
      setEmptyActionPending(action);
      try {
        await handler();
      } catch (error) {
        setEmptyActionError(error instanceof Error ? error.message : 'Action failed');
      } finally {
        setEmptyActionPending((current) => (current === action ? null : current));
      }
    },
    []
  );

  useEffect(() => {
    if (!copyNotice) return undefined;
    const timer = window.setTimeout(() => setCopyNotice(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copyNotice]);

  useEffect(() => {
    setEmptyActionError(null);
  }, [activeFilter, query, timeFilterId]);

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
    setDetailMenuOpen(false);
    setActiveDetailTab('overview');
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

  const renderItem = (
    decorated: DecoratedActivityItem,
    index: number,
    keyOverride?: string
  ) => {
    const item = decorated.item;
    const renderKey = keyOverride ?? item.id;
    const identity = resolveAgentIdentity(item);
    const actorFlow = resolveActivityActorFlow(item);
    const displayAgentName = actorFlow.primaryLabel || identity.agentName || identity.agentId || item.agentName || 'OrgX';
    const severity = activitySeverity(item);
    const railColor = severityColor(severity);
    const isRecent = sortOrder === 'newest' && index < 2;
    const bucket = decorated.bucket;
    const runId = decorated.runId;
    const runLabel = runId ? runLabelById.get(runId) ?? humanizeText(runId) : 'Workspace';
    const sessionStatus = runId ? sessionStatusById.get(runId) ?? null : null;
    const syncSummary = syncReplaySummary(item);
    const isSyncReplay = syncSummary !== null;

    const { title: displayTitle, isSystem: isSystemEvent } = cleanSystemTitle(item);
    const actorSubtitle = isSystemEvent ? 'System' : actorFlow.subtitle;
    const showHandoffFlow =
      actorFlow.mode === 'handoff' && actorFlow.requester !== null && actorFlow.executor !== null;
    const displaySummary = syncSummary ?? humanizeActivityBody(item.summary);
    const displayDesc = humanizeActivityBody(item.description);
    const initiativeName = item.initiativeId ? initiativeNameById.get(item.initiativeId) ?? null : null;
    const workstreamId =
      extractWorkstreamId(item) ?? (runId ? sessionWorkstreamByRunId.get(runId) ?? null : null);
    const workstreamName = workstreamId
      ? workstreamNameById.get(workstreamId) ?? humanizeText(workstreamId)
      : null;
    const kindLabel = isSyncReplay ? 'Sync' : bucketLabel(bucket);
    const primaryTag = isSyncReplay
      ? 'Synced'
      : severity === 'critical'
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
      "group w-full rounded-xl border border-white/[0.08] bg-white/[0.02] px-3.5 py-3 text-left transition-colors hover:border-strong hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BFFF00]/45 cv-auto";

    const content = (
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          {showHandoffFlow ? (
            <div className="flex items-center gap-1">
              <div className="inline-flex -space-x-2">
                <span className="rounded-full bg-[#080808] p-[1px]">
                  <AgentAvatar
                    name={actorFlow.requester?.label ?? 'Requester'}
                    hint={actorAvatarHint(actorFlow.requester)}
                    size="xs"
                  />
                </span>
                <span className="rounded-full bg-[#080808] p-[1px]">
                  <AgentAvatar
                    name={actorFlow.executor?.label ?? 'Executor'}
                    hint={actorAvatarHint(actorFlow.executor)}
                    size="xs"
                  />
                </span>
              </div>
              <span className="text-micro text-muted">→</span>
            </div>
          ) : (
            <AgentAvatar
              name={displayAgentName}
              hint={`${identity.agentId ?? ''} ${runLabel} ${item.title ?? ''}`}
              size="xs"
            />
          )}
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
              <p className={`line-clamp-2 break-words text-body font-semibold leading-snug ${isSystemEvent ? 'text-muted' : 'text-bright'}`}>
                {displayTitle}
              </p>
              <p className="mt-0.5 truncate text-caption text-secondary" title={actorSubtitle}>
                {actorSubtitle}
                {sessionStatus ? ` · ${humanizeText(sessionStatus)}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className="text-micro font-semibold tracking-[0.02em] text-muted">
                {kindLabel}
              </span>
              <span className="text-caption text-secondary">{timeLabel}</span>
            </div>
          </div>

          {(displaySummary || displayDesc) && (
            <div className="mt-1.5 line-clamp-2 text-caption leading-relaxed text-secondary">
              <MarkdownText mode="inline" text={displaySummary ?? displayDesc ?? ''} />
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-micro">
            <span
	              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-semibold tracking-[0.01em]"
              style={{
                borderColor: `${railColor}55`,
                backgroundColor: `${railColor}1A`,
                color: railColor,
              }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: railColor }} />
              {primaryTag}
            </span>
            {showHandoffFlow && (
              <span className="inline-flex items-center gap-1 rounded-full border border-cyan-300/25 bg-cyan-500/[0.10] px-2 py-0.5 text-cyan-100">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-200" />
                Handoff
              </span>
            )}
            {initiativeName ? (
              <span
                className="inline-flex max-w-[220px] items-center gap-1 rounded-full border border-strong bg-white/[0.03] px-2 py-0.5 text-secondary"
                title={initiativeName}
              >
                <EntityIcon type="initiative" size={10} className="opacity-85" />
                <span className="truncate">{initiativeName}</span>
              </span>
            ) : workstreamName ? (
              <span
                className="inline-flex max-w-[220px] items-center gap-1 rounded-full border border-strong bg-white/[0.03] px-2 py-0.5 text-secondary"
                title={workstreamName}
              >
                <EntityIcon type="workstream" size={10} className="opacity-90" />
                <span className="truncate">{workstreamName}</span>
              </span>
            ) : null}
            <span className="text-secondary">{formatRelativeTime(item.timestamp)}</span>
          </div>
        </div>
      </div>
    );

    if (!enableItemMotion) {
      return (
        <button
          type="button"
          key={renderKey}
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
        key={renderKey}
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
    <div className="flex h-full min-h-0 flex-col">
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
          <div className="border-b border-subtle px-4 py-3.5">
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-wrap items-start justify-between gap-2.5">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h2 className="text-heading font-semibold text-white">Activity</h2>
                  <span className="rounded-full border border-strong bg-white/[0.05] px-2 py-0.5 text-micro text-primary tabular-nums">
                    {filteredTotal}
                  </span>
                  {hiddenCount > 0 && (
                    <span className="rounded-full border border-strong bg-white/[0.03] px-2 py-0.5 text-micro text-secondary tabular-nums">
                      +{hiddenCount} hidden
                    </span>
                  )}
                  {hiddenSyncCount > 0 && !showSyncEvents && (
                    <button
                      type="button"
                      onClick={() => setShowSyncEvents(true)}
                      className="rounded-full border border-white/[0.14] bg-white/[0.03] px-2 py-0.5 text-micro text-secondary tabular-nums transition-colors hover:bg-white/[0.08] hover:text-primary"
                      title="Show low-signal sync replay events"
                    >
                      {hiddenSyncCount} sync hidden
                    </button>
                  )}
                  {showSyncEvents && (
                    <button
                      type="button"
                      onClick={() => setShowSyncEvents(false)}
                      className="rounded-full border border-lime/30 bg-lime/[0.10] px-2 py-0.5 text-micro text-[#E1FFB2] transition-colors hover:bg-lime/[0.16]"
                      title="Hide low-signal sync replay events"
                    >
                      Sync visible
                    </button>
                  )}
                  {timeWindow.id !== 'all' && (
                    <span className="rounded-full border border-strong bg-white/[0.02] px-2 py-0.5 text-micro text-secondary">
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

                <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                  <div
                    className="inline-flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.02] p-0.5"
                    role="group"
                    aria-label="Activity type filters"
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
                            'rounded-full px-3 py-1.5 text-micro font-semibold transition-colors',
                            active
                              ? 'border border-lime/25 bg-lime/[0.10] text-[#E1FFB2]'
                              : 'border border-transparent text-secondary hover:bg-white/[0.08] hover:text-bright'
                          )}
                        >
                          {filterLabels[filterId]}
                        </button>
                      );
                    })}
                  </div>

                  <button
                    type="button"
                    onClick={() => setCollapsed((prev) => !prev)}
                    className={cn(
                      'inline-flex h-8 w-8 items-center justify-center rounded-full border bg-white/[0.03] text-muted transition-colors hover:bg-white/[0.08] hover:text-primary',
                      collapsed ? 'border-lime/30 text-lime' : 'border-white/[0.1]'
                    )}
                    aria-pressed={collapsed}
                    aria-label={collapsed ? 'Expand activity density' : 'Compact activity density'}
                    title={collapsed ? 'Expand activity density' : 'Compact activity density'}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                      <path d="M4 7h16" />
                      <path d={collapsed ? 'M4 12h16' : 'M4 12h10'} />
                      <path d="M4 17h16" />
                    </svg>
                  </button>

                  <div className="relative" ref={controlsMenuRef}>
                    <button
                      type="button"
                      onClick={() => setViewMenuOpen((prev) => !prev)}
                      aria-haspopup="menu"
                      aria-expanded={viewMenuOpen}
                      className={cn(
                        'inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-caption font-semibold transition-colors',
                        viewMenuOpen
                          ? 'border-lime/30 bg-lime/[0.10] text-[#E1FFB2]'
                          : 'border-white/[0.1] bg-white/[0.03] text-primary hover:bg-white/[0.08]'
                      )}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 6h16" />
                        <path d="M7 12h10" />
                        <path d="M10 18h4" />
                      </svg>
                      <span className="hidden sm:inline">Filters</span>
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        className={cn('transition-transform duration-200', viewMenuOpen && 'rotate-180')}
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>

                    <AnimatePresence>
                      {viewMenuOpen && (
                        <motion.div
                          initial={{ opacity: 0, y: -6, scale: 0.98 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -4, scale: 0.98 }}
                          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                          className="absolute right-0 z-20 mt-2 w-[290px] rounded-xl border border-white/[0.12] bg-[#0A0D14]/95 p-3 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl"
                          role="menu"
                          aria-label="Activity view controls"
                        >
                          <div className="space-y-3">
                            <div>
                              <p className="mb-1 text-micro font-semibold uppercase tracking-[0.08em] text-muted">
                                Sort
                              </p>
                              <div className="grid grid-cols-2 gap-1">
                                {([
                                  { id: 'newest', label: 'Newest' },
                                  { id: 'oldest', label: 'Oldest' },
                                ] as const).map((option) => (
                                  <button
                                    key={option.id}
                                    type="button"
                                    onClick={() => {
                                      setSortOrder(option.id);
                                      setViewMenuOpen(false);
                                    }}
                                    className={cn(
                                      'rounded-lg border px-2 py-1.5 text-caption font-medium transition-colors',
                                      sortOrder === option.id
                                        ? 'border-lime/30 bg-lime/[0.12] text-[#E1FFB2]'
                                        : 'border-white/[0.08] bg-white/[0.02] text-secondary hover:bg-white/[0.06] hover:text-primary'
                                    )}
                                  >
                                    {option.label}
                                  </button>
                                ))}
                              </div>
                            </div>

                            <div>
                              <p className="mb-1 text-micro font-semibold uppercase tracking-[0.08em] text-muted">
                                Date range
                              </p>
                              <div className="flex flex-wrap gap-1">
                                {ACTIVITY_TIME_FILTERS.map((option) => {
                                  const active = timeFilterId === option.id;
                                  return (
                                    <button
                                      key={option.id}
                                      type="button"
                                      onClick={() => {
                                        onTimeFilterChange?.(option.id);
                                        setViewMenuOpen(false);
                                      }}
                                      className={cn(
                                        'rounded-full border px-2.5 py-1 text-micro font-semibold transition-colors',
                                        active
                                          ? 'border-lime/30 bg-lime/[0.12] text-[#E1FFB2]'
                                          : 'border-white/[0.08] bg-white/[0.02] text-secondary hover:bg-white/[0.06] hover:text-primary'
                                      )}
                                    >
                                      {option.label}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>

                            <div>
                              <p className="mb-1 text-micro font-semibold uppercase tracking-[0.08em] text-muted">
                                Type
                              </p>
                              <div className="grid grid-cols-2 gap-1">
                                {(Object.keys(filterLabels) as ActivityFilterId[]).map((filterId) => {
                                  const active = activeFilter === filterId;
                                  return (
                                    <button
                                      key={filterId}
                                      type="button"
                                      onClick={() => {
                                        setActiveFilter(filterId);
                                        setViewMenuOpen(false);
                                      }}
                                      className={cn(
                                        'rounded-lg border px-2 py-1.5 text-caption font-medium transition-colors',
                                        active
                                          ? 'border-lime/30 bg-lime/[0.12] text-[#E1FFB2]'
                                          : 'border-white/[0.08] bg-white/[0.02] text-secondary hover:bg-white/[0.06] hover:text-primary'
                                      )}
                                    >
                                      {filterLabels[filterId]}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>

                            <div>
                              <p className="mb-1 text-micro font-semibold uppercase tracking-[0.08em] text-muted">
                                Signal
                              </p>
                              <button
                                type="button"
                                onClick={() => {
                                  setShowSyncEvents((prev) => !prev);
                                }}
                                className={cn(
                                  'w-full rounded-lg border px-2.5 py-2 text-left text-caption transition-colors',
                                  showSyncEvents
                                    ? 'border-lime/30 bg-lime/[0.12] text-[#E1FFB2]'
                                    : 'border-white/[0.08] bg-white/[0.02] text-secondary hover:bg-white/[0.06] hover:text-primary'
                                )}
                              >
                                {showSyncEvents ? 'Hide sync replay events' : 'Show sync replay events'}
                              </button>
                              <p className="mt-1 text-micro leading-relaxed text-muted">
                                Changeset replay and outbox sync events are low-signal operational noise for most users.
                              </p>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  {(hasSessionFilter || selectedWorkstreamId || agentFilter) && (
                    <>
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
                          <span className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-strong bg-white/[0.04] text-micro text-secondary">
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
                          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-strong bg-white/[0.04] text-micro">
                            ↳
                          </span>
                          <span className="min-w-0 truncate">
                            Workstream{selectedWorkstreamLabel ? `: ${selectedWorkstreamLabel}` : ''}
                          </span>
                          <span className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-strong bg-white/[0.04] text-micro text-secondary">
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
                          <span className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-strong bg-white/[0.04] text-micro text-secondary">
                            ×
                          </span>
                        </button>
                      )}
                    </>
                  )}
                </div>

                <div className="flex min-w-0 flex-1 items-center gap-2 sm:justify-end">
                  <div className="relative min-w-0 flex-1 sm:max-w-[360px]">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
                    >
                      <circle cx="11" cy="11" r="7" />
                      <path d="m20 20-3.5-3.5" />
                    </svg>
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search activity..."
                      className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] py-2 pl-9 pr-2 text-body text-primary placeholder:text-muted transition-colors focus:border-[#BFFF00]/30 focus:outline-none"
                      aria-label="Search activity"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-smooth px-4 py-3">
        {filtered.length === 0 && (
          <div className="rounded-xl border border-subtle bg-white/[0.02] px-4 py-5">
            <div className="mx-auto max-w-2xl">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.04] text-secondary">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                  </svg>
                </span>
                <div className="min-w-0">
                  <p className="text-body font-semibold text-primary">
                    {isLoading
                      ? 'Syncing activity feed...'
                      : hasSessionFilter
                        ? 'No activity yet for this session'
                        : selectedWorkstreamId
                          ? 'No activity yet for this workstream'
                          : 'No matching activity right now.'}
                  </p>
                  <p className="mt-1 text-caption leading-relaxed text-secondary">
                    {isLoading
                      ? 'Live updates usually appear within a few seconds after dispatch.'
                      : `Try widening the time window (${timeWindow.label}), changing filters, or launch the next workstream.`}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {emptyTimeFilters.map((option) => {
                  const active = timeFilterId === option.id;
                  return (
                    <button
                      key={`empty-time-${option.id}`}
                      type="button"
                      onClick={() => onTimeFilterChange?.(option.id)}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-caption font-semibold transition-colors',
                        active
                          ? 'border-lime/30 bg-lime/[0.12] text-[#E1FFB2]'
                          : 'border-white/[0.1] bg-white/[0.03] text-secondary hover:bg-white/[0.08] hover:text-primary'
                      )}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {(hasSessionFilter || selectedWorkstreamId || agentFilter) && (
                  <button
                    type="button"
                    onClick={() => {
                      if (hasSessionFilter) onClearSelection();
                      if (selectedWorkstreamId) onClearWorkstreamFilter?.();
                      if (agentFilter) onClearAgentFilter?.();
                    }}
                    className="rounded-full border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-primary transition hover:bg-white/[0.08]"
                  >
                    Clear filters
                  </button>
                )}
                {onPlayNextUp && (
                  <button
                    type="button"
                    onClick={() => void runEmptyAction('play', onPlayNextUp)}
                    disabled={emptyActionPending !== null}
                    className="rounded-full border border-[#BFFF00]/28 bg-[#BFFF00]/12 px-3 py-1.5 text-caption font-semibold text-[#D8FFA1] transition hover:bg-[#BFFF00]/18 disabled:opacity-45"
                  >
                    {emptyActionPending === 'play' ? 'Dispatching...' : 'Play Next Up'}
                  </button>
                )}
                {onStartAutopilot && (
                  <button
                    type="button"
                    onClick={() => void runEmptyAction('autopilot', onStartAutopilot)}
                    disabled={emptyActionPending !== null}
                    className="rounded-full border border-[#0AD4C4]/30 bg-[#0AD4C4]/10 px-3 py-1.5 text-caption font-semibold text-[#98FFF5] transition hover:bg-[#0AD4C4]/16 disabled:opacity-45"
                  >
                    {emptyActionPending === 'autopilot' ? 'Starting...' : 'Start Autopilot'}
                  </button>
                )}
                {onCreateInitiative && (
                  <button
                    type="button"
                    onClick={onCreateInitiative}
                    className="rounded-full border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-primary transition hover:bg-white/[0.08]"
                  >
                    Create initiative
                  </button>
                )}
                {onOpenMissionControl && (
                  <button
                    type="button"
                    onClick={onOpenMissionControl}
                    className="rounded-full border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-secondary transition hover:bg-white/[0.08] hover:text-primary"
                  >
                    Open Mission Control
                  </button>
                )}
              </div>

              {emptyActionError && (
                <p className="mt-2 text-caption text-amber-200/80">{emptyActionError}</p>
              )}
            </div>
          </div>
        )}

        {filtered.length > 0 && (
          <div className="space-y-4">
            {deduplicatedGrouped.map((group) => {
              const visibleClusters = collapsed ? group.clusters.slice(0, 4) : group.clusters;
	              return (
	                <section key={group.key}>
		                  <h3 className="mb-2.5 border-b border-subtle pb-1.5 text-caption font-semibold tracking-[0.01em] text-muted">
		                    {group.label}
		                  </h3>
	                  {enableItemMotion ? (
	                    <AnimatePresence mode="popLayout">
		                      <div className="space-y-2">
		                        {visibleClusters.map((cluster, index) => {
		                          const isExpanded = expandedClusters.has(cluster.key);
                              const expandedItems = cluster.allItems.slice(1);
                              const expandedTotal = expandedItems.length;
                              const expandedVisible = Math.min(
                                expandedTotal,
                                clusterVisibleCounts[cluster.key] ?? CLUSTER_EXPANDED_BATCH_SIZE
                              );
                              const visibleExpandedItems = expandedItems.slice(0, expandedVisible);
		                          if (cluster.count === 1) {
		                            return renderItem(cluster.representative, index);
		                          }
	                          const representativeKey = `cluster:${cluster.key}`;
	                          return (
	                            <div key={cluster.key}>
	                              {renderItem(cluster.representative, index, representativeKey)}
	                              <button
	                                type="button"
	                                onClick={(e) => { e.stopPropagation(); toggleCluster(cluster.key); }}
	                                className="mt-1 ml-8 inline-flex items-center gap-1.5 rounded-full border border-white/[0.1] bg-white/[0.03] px-2.5 py-1 text-micro text-secondary transition-colors hover:bg-white/[0.06] hover:text-primary"
	                              >
	                                <span className="font-semibold">×{cluster.count}</span>
	                                <span className="text-muted">·</span>
	                                <span>first seen {formatRelativeTime(cluster.firstTimestamp)}</span>
	                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cn('transition-transform', isExpanded ? 'rotate-0' : '-rotate-90')}>
	                                  <path d="m6 9 6 6 6-6" />
	                                </svg>
	                              </button>
		                              {isExpanded && (
		                                <div className="ml-8 mt-1 space-y-1.5 border-l border-subtle pl-3">
		                                  {visibleExpandedItems.map((item, subIndex) =>
		                                    renderItem(item, index + subIndex + 1)
		                                  )}
                                      {expandedVisible < expandedTotal && (
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            loadMoreClusterItems(cluster.key, expandedTotal);
                                          }}
                                          className="rounded-full border border-strong bg-white/[0.03] px-2.5 py-1 text-micro text-secondary transition-colors hover:bg-white/[0.06] hover:text-primary"
                                        >
                                          Load more ({expandedTotal - expandedVisible} remaining)
                                        </button>
                                      )}
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
                            const expandedItems = cluster.allItems.slice(1);
                            const expandedTotal = expandedItems.length;
                            const expandedVisible = Math.min(
                              expandedTotal,
                              clusterVisibleCounts[cluster.key] ?? CLUSTER_EXPANDED_BATCH_SIZE
                            );
                            const visibleExpandedItems = expandedItems.slice(0, expandedVisible);
		                        if (cluster.count === 1) {
		                          return renderItem(cluster.representative, index);
		                        }
	                        const representativeKey = `cluster:${cluster.key}`;
	                        return (
	                          <div key={cluster.key}>
	                            {renderItem(cluster.representative, index, representativeKey)}
	                            <button
	                              type="button"
	                              onClick={(e) => { e.stopPropagation(); toggleCluster(cluster.key); }}
	                              className="mt-1 ml-8 inline-flex items-center gap-1.5 rounded-full border border-white/[0.1] bg-white/[0.03] px-2.5 py-1 text-micro text-secondary transition-colors hover:bg-white/[0.06] hover:text-primary"
	                            >
	                              <span className="font-semibold">×{cluster.count}</span>
	                              <span className="text-muted">·</span>
	                              <span>first seen {formatRelativeTime(cluster.firstTimestamp)}</span>
	                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cn('transition-transform', isExpanded ? 'rotate-0' : '-rotate-90')}>
	                                <path d="m6 9 6 6 6-6" />
	                              </svg>
	                            </button>
		                            {isExpanded && (
		                              <div className="ml-8 mt-1 space-y-1.5 border-l border-subtle pl-3">
		                                {visibleExpandedItems.map((item, subIndex) =>
		                                  renderItem(item, index + subIndex + 1)
		                                )}
                                    {expandedVisible < expandedTotal && (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          loadMoreClusterItems(cluster.key, expandedTotal);
                                        }}
                                        className="rounded-full border border-strong bg-white/[0.03] px-2.5 py-1 text-micro text-secondary transition-colors hover:bg-white/[0.06] hover:text-primary"
                                      >
                                        Load more ({expandedTotal - expandedVisible} remaining)
                                      </button>
                                    )}
		                              </div>
		                            )}
	                          </div>
	                        );
	                      })}
	                    </div>
	                  )}
	                  {collapsed && group.clusters.length > visibleClusters.length && (
	                    <p className="mt-1.5 text-caption text-muted">
	                      +{group.clusters.length - visibleClusters.length} more
	                    </p>
	                  )}
	                </section>
              );
            })}

            {hiddenCount > 0 && (
              <p className="rounded-xl border border-subtle bg-white/[0.02] px-3 py-2 text-caption text-secondary">
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
                  className="rounded-full border border-strong bg-white/[0.03] px-4 py-2 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.08] disabled:opacity-45"
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

            <div className="relative z-10 flex items-center justify-between border-b border-subtle px-5 py-3 sm:px-6">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                  style={{
                    backgroundColor: bucketColor(activeDecorated.bucket),
                    boxShadow: `0 0 12px ${bucketColor(activeDecorated.bucket)}55`,
                  }}
                />
                <span className="text-caption text-secondary">
                  {bucketLabel(activeDecorated.bucket)} · {activeIndex + 1}/{filtered.length}
                </span>
                {copyNotice && (
                  <Pill tone="neutral" className="text-micro font-semibold tracking-[0.02em]">
                    {copyNotice}
                  </Pill>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                {activeDecorated.runId && onFocusRunId && (
                  <button
                    type="button"
                    onClick={() => {
                      onFocusRunId(activeDecorated.runId!);
                      closeDetail();
                    }}
                    className="rounded-full border border-lime/25 bg-lime/10 px-3 py-1 text-caption font-semibold text-lime transition hover:bg-lime/20"
                  >
                    Focus session
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => navigateDetail(-1)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-strong bg-white/[0.04] text-primary transition hover:bg-white/[0.1]"
                  aria-label="Previous activity item"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
                </button>
                <button
                  type="button"
                  onClick={() => navigateDetail(1)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-strong bg-white/[0.04] text-primary transition hover:bg-white/[0.1]"
                  aria-label="Next activity item"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
                </button>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setDetailMenuOpen((prev) => !prev)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-strong bg-white/[0.04] text-secondary transition hover:bg-white/[0.1] hover:text-primary"
                    aria-label="More actions"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" /></svg>
                  </button>
                  {detailMenuOpen && (
                    <>
                      <div className="fixed inset-0 z-30" onClick={() => setDetailMenuOpen(false)} />
                      <div className="absolute right-0 top-full z-40 mt-1 min-w-[160px] rounded-lg border border-strong bg-[#0d0f16] py-1 shadow-xl">
                        {activeDecorated.runId && (
                          <button
                            type="button"
                            onClick={() => { void copyText('Run id', activeDecorated.runId ?? ''); setDetailMenuOpen(false); }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-caption text-secondary transition-colors hover:bg-white/[0.06] hover:text-primary"
                          >
                            Copy run ID
                          </button>
                        )}
                        {activeIdentity.agentId && (
                          <button
                            type="button"
                            onClick={() => { void copyText('Agent id', activeIdentity.agentId ?? ''); setDetailMenuOpen(false); }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-caption text-secondary transition-colors hover:bg-white/[0.06] hover:text-primary"
                          >
                            Copy agent ID
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => { void copyText('Event id', activeDecorated.item.id); setDetailMenuOpen(false); }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-caption text-secondary transition-colors hover:bg-white/[0.06] hover:text-primary"
                        >
                          Copy event ID
                        </button>
                      </div>
                    </>
                  )}
                </div>
                <button
                  type="button"
                  onClick={closeDetail}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-strong bg-white/[0.04] text-secondary transition hover:bg-white/[0.1] hover:text-primary"
                  aria-label="Close activity detail"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
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
                      <h3 className="text-title font-semibold tracking-[-0.02em] text-white whitespace-pre-wrap break-words">
                        {detailHeadlineOverride ||
                          summarizeDetailHeadline(activeDecorated.item, detailSummaryOverride) ||
                          humanizeText(activeDecorated.item.title || labelForType(activeDecorated.item.type))}
                      </h3>
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-body text-secondary">
                        {new Date(activeDecorated.item.timestamp).toLocaleString()} · {formatRelativeTime(activeDecorated.item.timestamp)}
                        {detailHeadlineSource === 'llm' && (
                          <span className="text-muted">· AI title</span>
                        )}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-caption">
                      <Pill
                        tone="neutral"
                        className="font-semibold tracking-[0.02em]"
                        style={{
                          borderColor: `${bucketColor(activeDecorated.bucket)}55`,
                          color: bucketColor(activeDecorated.bucket),
                          backgroundColor: `${bucketColor(activeDecorated.bucket)}12`,
                        }}
                      >
                        {bucketLabel(activeDecorated.bucket)}
                      </Pill>
                      <Pill tone="muted">
                        {labelForType(activeDecorated.item.type)}
                      </Pill>
                      {activeIsSyncReplay && (
                        <Pill tone="lime">
                          Sync replay
                        </Pill>
                      )}
                      {activeActorFlow?.mode === 'handoff' &&
                        activeActorFlow.requester &&
                        activeActorFlow.executor && (
                          <Pill tone="cyan">
                            <AgentAvatar
                              name={activeActorFlow.requester.label}
                              hint={actorAvatarHint(activeActorFlow.requester)}
                              size="xs"
                            />
                            <span className="text-micro text-cyan-100/80">→</span>
                            <AgentAvatar
                              name={activeActorFlow.executor.label}
                              hint={actorAvatarHint(activeActorFlow.executor)}
                              size="xs"
                            />
                          </Pill>
                        )}
                      {activeActorFlow?.mode !== 'handoff' && activeIdentity.agentName && (
                        <Pill tone="muted">
                          <AgentAvatar
                            name={activeIdentity.agentName ?? 'Agent'}
                            hint={`${activeIdentity.agentId ?? ''} ${activeDecorated.item.title ?? ''}`}
                            size="xs"
                          />
                          <span>{activeIdentity.agentName}</span>
                        </Pill>
                      )}
                      {activeDecorated.runId && (
                        <Pill tone="muted">
                          {runLabelById.get(activeDecorated.runId) ?? humanizeText(activeDecorated.runId)}
                        </Pill>
                      )}
                    </div>

                    <div className="inline-flex rounded-full border border-white/[0.12] bg-white/[0.03] p-1 text-caption">
                      <button
                        type="button"
                        onClick={() => setActiveDetailTab('overview')}
                        aria-pressed={activeDetailTab === 'overview'}
                        className={cn(
                          'rounded-full px-2.5 py-1 font-semibold transition-colors',
                          activeDetailTab === 'overview'
                            ? 'bg-white/[0.14] text-primary'
                            : 'text-secondary hover:text-primary'
                        )}
                      >
                        Overview
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveDetailTab('flow')}
                        aria-pressed={activeDetailTab === 'flow'}
                        className={cn(
                          'rounded-full px-2.5 py-1 font-semibold transition-colors',
                          activeDetailTab === 'flow'
                            ? 'bg-cyan-500/[0.16] text-cyan-100'
                            : 'text-secondary hover:text-primary'
                        )}
                      >
                        Flow
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveDetailTab('technical')}
                        aria-pressed={activeDetailTab === 'technical'}
                        className={cn(
                          'rounded-full px-2.5 py-1 font-semibold transition-colors',
                          activeDetailTab === 'technical'
                            ? 'bg-lime/[0.16] text-[#E1FFB2]'
                            : 'text-secondary hover:text-primary'
                        )}
                      >
                        Technical
                      </button>
                    </div>

                    {activeDetailTab === 'overview' && activeOutcome && (
                      <div
                        className={cn(
                          'rounded-xl border px-3.5 py-3',
                          activeOutcome.tone === 'critical' &&
                            'border-red-400/28 bg-red-500/[0.09]',
                          activeOutcome.tone === 'warning' &&
                            'border-amber-400/28 bg-amber-500/[0.09]',
                          activeOutcome.tone === 'positive' &&
                            'border-lime/28 bg-lime/[0.08]',
                          activeOutcome.tone === 'neutral' &&
                            'border-cyan-400/22 bg-cyan-500/[0.07]'
                        )}
                      >
                        <p className="text-micro font-semibold uppercase tracking-[0.08em] text-white/78">
                          {activeOutcome.label}
                        </p>
                        <p className="mt-1 text-body text-primary">{activeOutcome.summary}</p>
                        {activeOutcome.hint && (
                          <p className="mt-1 text-caption text-secondary">{activeOutcome.hint}</p>
                        )}
                        <div className="mt-2 flex flex-wrap gap-2">
                          {activeDecorated.runId && onFocusRunId && (
                            <button
                              type="button"
                              onClick={() => {
                                onFocusRunId(activeDecorated.runId!);
                                closeDetail();
                              }}
                              className="rounded-full border border-strong bg-white/[0.04] px-3 py-1 text-caption font-semibold text-primary transition hover:bg-white/[0.1]"
                            >
                              Open session
                            </button>
                          )}
                          {activeArtifactId && (
                            <button
                              type="button"
                              onClick={() => openArtifactViewer(activeArtifactId)}
                              className="rounded-full border border-cyan-300/25 bg-cyan-500/[0.1] px-3 py-1 text-caption font-semibold text-cyan-100 transition hover:bg-cyan-500/[0.16]"
                            >
                              View artifact
                            </button>
                          )}
                          {primaryEvidenceHref && (
                            <a
                              href={primaryEvidenceHref}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="rounded-full border border-strong bg-white/[0.04] px-3 py-1 text-caption font-semibold text-primary transition hover:bg-white/[0.1]"
                            >
                              Open evidence
                            </a>
                          )}
                        </div>
                      </div>
                    )}

                    {activeDetailTab === 'flow' && activeActorFlow && (
                      <div className="rounded-xl border border-cyan-300/24 bg-cyan-500/[0.07] p-3">
                        <p className="text-caption font-semibold tracking-[0.02em] text-cyan-100/85">
                          Delegation flow
                        </p>
                        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                          <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
                            <div className="text-micro font-semibold tracking-[0.02em] text-secondary">Requester</div>
                            <div className="mt-1 flex items-center gap-2 text-body text-primary">
                              {activeActorFlow.requester ? (
                                <>
                                  <AgentAvatar
                                    name={activeActorFlow.requester.label}
                                    hint={actorAvatarHint(activeActorFlow.requester)}
                                    size="xs"
                                  />
                                  <span>{activeActorFlow.requester.label}</span>
                                </>
                              ) : (
                                <span className="text-secondary">System / unknown</span>
                              )}
                            </div>
                          </div>
                          <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
                            <div className="text-micro font-semibold tracking-[0.02em] text-secondary">Flow</div>
                            <p className="mt-1 text-body text-primary">
                              {activeActorFlow.mode === 'handoff'
                                ? 'Delegated handoff'
                                : activeActorFlow.mode === 'requested'
                                  ? 'Dispatch requested'
                                  : activeActorFlow.mode === 'single'
                                    ? 'Direct execution'
                                    : 'System event'}
                            </p>
                            <p className="mt-1 text-caption text-secondary">{activeActorFlow.subtitle}</p>
                          </div>
                          <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
                            <div className="text-micro font-semibold tracking-[0.02em] text-secondary">Executor</div>
                            <div className="mt-1 flex items-center gap-2 text-body text-primary">
                              {activeActorFlow.executor ? (
                                <>
                                  <AgentAvatar
                                    name={activeActorFlow.executor.label}
                                    hint={actorAvatarHint(activeActorFlow.executor)}
                                    size="xs"
                                  />
                                  <span>{activeActorFlow.executor.label}</span>
                                </>
                              ) : (
                                <span className="text-secondary">Not assigned</span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

	                    {activeDetailTab === 'flow' && activeAutopilotContext && (
	                      <div className="rounded-xl border border-lime/20 bg-lime/[0.08] p-3">
	                        <div className="flex flex-wrap items-center justify-between gap-2">
	                          <p className="text-caption font-semibold tracking-[0.02em] text-lime/80">
	                            {activeRelatedAutopilotSlice ? 'Related execution context' : 'Execution context'}
	                          </p>
	                          <span className="rounded-full border border-lime/30 bg-black/20 px-2 py-0.5 text-micro font-semibold text-lime/85">
	                            {humanizeText(activeAutopilotContext.event)}
	                          </span>
	                        </div>
	                        {activeRelatedAutopilotSlice && (
	                          <p className="mt-1 text-micro text-lime/70">
	                            Derived from nearest related slice event ({humanizeText(activeRelatedAutopilotSlice.relation)}).
	                          </p>
	                        )}

	                        {activeAutopilotProgress && (
	                          <div className="mt-3 rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2.5">
	                            <div className="flex items-center justify-between gap-2">
	                              <p className="text-micro font-semibold tracking-[0.02em] text-secondary">
	                                Slice progress
	                              </p>
	                              <p className="text-body font-semibold tabular-nums" style={{ color: activeAutopilotProgressColor }}>
	                                {activeAutopilotProgress.pct}%
	                              </p>
	                            </div>
	                            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.10]">
	                              <div
	                                className="h-full rounded-full transition-[width] duration-300"
	                                style={{
	                                  width: `${Math.max(4, activeAutopilotProgress.pct)}%`,
	                                  backgroundColor: activeAutopilotProgressColor,
	                                }}
	                              />
	                            </div>
	                            <p className="mt-1 text-micro text-secondary">
	                              {activeAutopilotProgress.label}
	                            </p>
	                          </div>
	                        )}

	                        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
	                          <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
	                            <div className="text-micro font-semibold tracking-[0.02em] text-secondary">Requested by</div>
	                            <div className="mt-1 text-body text-primary">{activeAutopilotRequesterLabel}</div>
	                          </div>
	                          <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
	                            <div className="text-micro font-semibold tracking-[0.02em] text-secondary">Executed by</div>
	                            <div className="mt-1 text-body text-primary">{activeAutopilotExecutorLabel}</div>
	                          </div>
	                          <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
	                            <div className="text-micro font-semibold tracking-[0.02em] text-secondary">Dispatched by</div>
	                            <div className="mt-1 text-body text-primary">
	                              {activeAutopilotContext.dispatcherClient
	                                ? humanizeText(activeAutopilotContext.dispatcherClient)
	                                : 'OpenClaw'}
	                            </div>
	                          </div>
	                          <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
	                            <div className="text-micro font-semibold tracking-[0.02em] text-secondary">Policy</div>
	                            <div className="mt-1 text-body text-primary">
	                              {activeAutopilotContext.domain ?? '—'}
	                              {activeAutopilotContext.requiredSkills.length > 0
	                                ? ` · ${activeAutopilotContext.requiredSkills.join(', ')}`
	                                : ''}
	                            </div>
	                          </div>
	                        </div>

	                        {activeExecutionBreakdown && (
	                          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
	                            <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
	                              <div className="flex items-center justify-between gap-2">
	                                <div className="text-micro font-semibold tracking-[0.02em] text-secondary">Initiative</div>
	                                {activeExecutionBreakdown.initiativeStatus && (
	                                  <span className="rounded-full border border-strong bg-white/[0.03] px-2 py-0.5 text-micro text-secondary">
	                                    {humanizeText(activeExecutionBreakdown.initiativeStatus)}
	                                  </span>
	                                )}
	                              </div>
	                              <p className="mt-1 text-body text-primary">
	                                {activeExecutionBreakdown.initiativeTitle ?? activeExecutionBreakdown.initiativeId ?? '—'}
	                              </p>
	                              {activeExecutionBreakdown.initiativeId && (
	                                <p className="mt-1 break-all font-mono text-micro text-secondary">
	                                  {activeExecutionBreakdown.initiativeId}
	                                </p>
	                              )}
	                              {activeExecutionBreakdown.initiativeWorkstreamPct !== null && (
	                                <div className="mt-2">
	                                  <div className="mb-1 flex items-center justify-between text-micro text-secondary">
	                                    <span>Workstreams complete</span>
	                                    <span className="tabular-nums">
	                                      {activeExecutionBreakdown.doneInitiativeWorkstreams ?? 0}/
	                                      {activeExecutionBreakdown.totalInitiativeWorkstreams ?? 0}
	                                    </span>
	                                  </div>
	                                  <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.10]">
	                                    <div
	                                      className="h-full rounded-full bg-[#BFFF00]/80"
	                                      style={{ width: `${Math.max(4, activeExecutionBreakdown.initiativeWorkstreamPct)}%` }}
	                                    />
	                                  </div>
	                                </div>
	                              )}
	                            </div>

	                            <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
	                              <div className="flex items-center justify-between gap-2">
	                                <div className="text-micro font-semibold tracking-[0.02em] text-secondary">Workstream</div>
	                                {activeExecutionBreakdown.workstreamStatus && (
	                                  <span className="rounded-full border border-strong bg-white/[0.03] px-2 py-0.5 text-micro text-secondary">
	                                    {humanizeText(activeExecutionBreakdown.workstreamStatus)}
	                                  </span>
	                                )}
	                              </div>
	                              <p className="mt-1 text-body text-primary">
	                                {activeExecutionBreakdown.workstreamTitle ?? activeExecutionBreakdown.workstreamId ?? '—'}
	                              </p>
	                              {activeExecutionBreakdown.workstreamId && (
	                                <p className="mt-1 break-all font-mono text-micro text-secondary">
	                                  {activeExecutionBreakdown.workstreamId}
	                                </p>
	                              )}
	                            </div>

	                            <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
	                              <div className="text-micro font-semibold tracking-[0.02em] text-secondary">
	                                Completion breakdown
	                              </div>
	                              <div className="mt-2 grid grid-cols-2 gap-2 text-caption text-primary">
	                                <div>
	                                  <div className="text-micro text-secondary">Tasks in slice</div>
	                                  <div className="mt-0.5 tabular-nums">
	                                    {activeExecutionBreakdown.scopedTaskCount}
	                                  </div>
	                                </div>
	                                <div>
	                                  <div className="text-micro text-secondary">Milestones in slice</div>
	                                  <div className="mt-0.5 tabular-nums">
	                                    {activeExecutionBreakdown.scopedMilestoneCount}
	                                  </div>
	                                </div>
	                                <div>
	                                  <div className="text-micro text-secondary">Status updates</div>
	                                  <div className="mt-0.5 tabular-nums">
	                                    {activeExecutionBreakdown.statusUpdatesApplied ?? '—'}
	                                  </div>
	                                </div>
	                                <div>
	                                  <div className="text-micro text-secondary">Buffered updates</div>
	                                  <div className="mt-0.5 tabular-nums">
	                                    {activeExecutionBreakdown.statusUpdatesBuffered ?? 0}
	                                  </div>
	                                </div>
	                              </div>
	                            </div>

	                            <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
	                              <div className="text-micro font-semibold tracking-[0.02em] text-secondary">
	                                Outputs
	                              </div>
	                              <div className="mt-2 grid grid-cols-2 gap-2 text-caption text-primary">
	                                <div>
	                                  <div className="text-micro text-secondary">Artifacts</div>
	                                  <div className="mt-0.5 tabular-nums">{activeExecutionBreakdown.artifacts ?? 0}</div>
	                                </div>
	                                <div>
	                                  <div className="text-micro text-secondary">Decisions</div>
	                                  <div className="mt-0.5 tabular-nums">{activeExecutionBreakdown.decisions ?? 0}</div>
	                                </div>
	                                <div>
	                                  <div className="text-micro text-secondary">Blocking decisions</div>
	                                  <div className="mt-0.5 tabular-nums">{activeExecutionBreakdown.blockingDecisions ?? 0}</div>
	                                </div>
	                                <div>
	                                  <div className="text-micro text-secondary">Non-blocking decisions</div>
	                                  <div className="mt-0.5 tabular-nums">{activeExecutionBreakdown.nonBlockingDecisions ?? 0}</div>
	                                </div>
	                                <div className="col-span-2">
	                                  <div className="text-micro text-secondary">Token usage</div>
	                                  <div className="mt-0.5 tabular-nums">
	                                    {activeExecutionBreakdown.tokensUsed !== null &&
	                                    activeExecutionBreakdown.tokenBudget !== null
	                                      ? `${Math.round(activeExecutionBreakdown.tokensUsed)}/${Math.round(activeExecutionBreakdown.tokenBudget)}`
	                                      : '—'}
	                                  </div>
	                                </div>
	                              </div>
	                            </div>
	                          </div>
	                        )}

	                        {(activeExecutionBreakdown?.taskTitle ||
	                          activeExecutionBreakdown?.milestoneTitle ||
	                          activeExecutionBreakdown?.phase ||
	                          activeExecutionBreakdown?.nextStep ||
	                          activeExecutionBreakdown?.parsedStatus ||
	                          activeExecutionBreakdown?.stopReason) && (
	                          <div className="mt-3 rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
	                            <div className="text-micro font-semibold tracking-[0.02em] text-secondary">
	                              Current scope
	                            </div>
	                            <div className="mt-1.5 space-y-1 text-caption text-primary">
	                              {activeExecutionBreakdown.taskTitle && (
	                                <p>
	                                  <span className="text-secondary">Task:</span> {activeExecutionBreakdown.taskTitle}
	                                </p>
	                              )}
	                              {activeExecutionBreakdown.milestoneTitle && (
	                                <p>
	                                  <span className="text-secondary">Milestone:</span> {activeExecutionBreakdown.milestoneTitle}
	                                </p>
	                              )}
	                              {activeExecutionBreakdown.phase && (
	                                <p>
	                                  <span className="text-secondary">Phase:</span> {humanizeText(activeExecutionBreakdown.phase)}
	                                </p>
	                              )}
	                              {activeExecutionBreakdown.nextStep && (
	                                <p>
	                                  <span className="text-secondary">Next step:</span> {activeExecutionBreakdown.nextStep}
	                                </p>
	                              )}
	                              {activeExecutionBreakdown.parsedStatus && (
	                                <p>
	                                  <span className="text-secondary">Slice status:</span>{' '}
	                                  {humanizeText(activeExecutionBreakdown.parsedStatus)}
	                                </p>
	                              )}
	                              {activeExecutionBreakdown.stopReason && (
	                                <p>
	                                  <span className="text-secondary">Stop reason:</span>{' '}
	                                  {humanizeText(activeExecutionBreakdown.stopReason)}
	                                </p>
	                              )}
	                            </div>
	                          </div>
	                        )}

	                        {(activeAutopilotContext.logPath || activeAutopilotContext.outputPath) && (
	                          <div className="mt-3 space-y-2 rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
	                            {activeAutopilotContext.logPath && (
	                              <p className="break-all font-mono text-caption text-secondary">
	                                log: {activeAutopilotContext.logPath}
	                              </p>
	                            )}
	                            {activeAutopilotContext.outputPath && (
	                              <p className="break-all font-mono text-caption text-secondary">
	                                output: {activeAutopilotContext.outputPath}
	                              </p>
	                            )}
	                            <div className="flex flex-wrap gap-2">
	                              {activeAutopilotContext.logPath && (
	                                <button
	                                  type="button"
	                                  onClick={() => void copyText('Log path', activeAutopilotContext.logPath ?? '')}
	                                  className="rounded-full border border-strong bg-white/[0.04] px-3 py-1 text-caption text-primary transition hover:bg-white/[0.1]"
	                                >
	                                  Copy log path
	                                </button>
	                              )}
	                              {activeAutopilotContext.outputPath && (
	                                <button
	                                  type="button"
	                                  onClick={() => void copyText('Output path', activeAutopilotContext.outputPath ?? '')}
	                                  className="rounded-full border border-strong bg-white/[0.04] px-3 py-1 text-caption text-primary transition hover:bg-white/[0.1]"
	                                >
	                                  Copy output path
	                                </button>
	                              )}
	                            </div>
	                          </div>
	                        )}

	                        {activeAutopilotContext.error && (
	                          <div className="mt-3 rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-body text-red-100/80">
	                            {activeAutopilotContext.error}
	                          </div>
	                        )}
	                      </div>
	                    )}

                    {activeDetailTab === 'technical' && activeProvenance && (
                      <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
	                        <p className="text-caption font-semibold tracking-[0.02em] text-secondary">Provenance</p>
                        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {activeProvenance.domain && (
                            <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
	                              <div className="text-micro font-semibold tracking-[0.02em] text-secondary">Domain</div>
                              <div className="mt-1 text-body text-primary">{humanizeText(activeProvenance.domain)}</div>
                            </div>
                          )}
                          {(activeProvenance.provider || activeProvenance.model) && (
                            <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
	                              <div className="text-micro font-semibold tracking-[0.02em] text-secondary">Model</div>
                              <div className="mt-1 text-body text-primary">
                                {activeProvenance.provider ? `${humanizeText(activeProvenance.provider)} · ` : ''}
                                {activeProvenance.model ? humanizeModel(activeProvenance.model) : '—'}
                              </div>
                            </div>
                          )}
                          {activeProvenance.modelTier && (
                            <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
	                              <div className="text-micro font-semibold tracking-[0.02em] text-secondary">Model tier</div>
                              <div className="mt-1 text-body text-primary">{humanizeText(activeProvenance.modelTier)}</div>
                            </div>
                          )}
                          {activeProvenance.pluginVersion && (
                            <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
	                              <div className="text-micro font-semibold tracking-[0.02em] text-secondary">Plugin</div>
                              <div className="mt-1 text-body text-primary">v{activeProvenance.pluginVersion}</div>
                            </div>
                          )}
                          {activeProvenance.skillPack && (
                            <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2 sm:col-span-2">
	                              <div className="text-micro font-semibold tracking-[0.02em] text-secondary">Skill pack</div>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-body text-primary">
                                <span>
                                  {activeProvenance.skillPack.name ?? '—'}
                                  {activeProvenance.skillPack.version ? `@${activeProvenance.skillPack.version}` : ''}
                                  {activeProvenance.skillPack.source ? ` · ${activeProvenance.skillPack.source}` : ''}
                                </span>
                                {activeProvenance.skillPack.checksum && (
                                  <button
                                    type="button"
                                    onClick={() => void copyText('Skill pack checksum', activeProvenance.skillPack?.checksum ?? '')}
                                    className="rounded-full border border-strong bg-white/[0.04] px-2.5 py-1 text-caption text-primary transition hover:bg-white/[0.1]"
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
	                                <div className="text-micro font-semibold tracking-[0.02em] text-secondary">Kickoff context</div>
                                <button
                                  type="button"
                                  onClick={() => void copyText('Kickoff context hash', activeProvenance.kickoffContextHash ?? '')}
                                  className="rounded-full border border-strong bg-white/[0.04] px-2.5 py-1 text-caption text-primary transition hover:bg-white/[0.1]"
                                >
                                  Copy hash
                                </button>
                              </div>
                              <div className="mt-1 text-body text-primary">
                                {activeProvenance.kickoffContextSource ? `${activeProvenance.kickoffContextSource} · ` : ''}
                                <span className="font-mono text-body text-primary">{activeProvenance.kickoffContextHash}</span>
                              </div>
                            </div>
                          )}
                          {activeProvenance.requiredSkills.length > 0 && (
                            <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2 sm:col-span-2">
	                              <div className="text-micro font-semibold tracking-[0.02em] text-secondary">Required skills</div>
                              <div className="mt-1 flex flex-wrap gap-1.5">
                                {activeProvenance.requiredSkills.map((skill) => (
                                  <span
                                    key={skill}
                                    className="rounded-full border border-strong bg-white/[0.03] px-2 py-0.5 text-caption text-secondary"
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

	                    {activeDetailTab === 'overview' && activeSummaryText && (
		                      <div className="rounded-xl border border-white/[0.08] bg-black/20 p-3">
		                        <p className="text-micro font-semibold tracking-[0.02em] text-secondary">Summary</p>
	                        {detailSummarySource === 'missing' && !activeIsSyncReplay && (
	                          <p className="mt-1 text-caption text-amber-200/75">
	                            Full local turn transcript was unavailable; showing the event summary payload.
	                          </p>
	                        )}
	                        <MarkdownText
	                          mode="block"
	                          text={activeSummaryText}
	                          className="mt-1.5 text-body leading-relaxed text-primary"
	                        />
	                      </div>
	                    )}

	                    {activeDetailTab === 'overview' && humanizeActivityBody(activeDecorated.item.description) && (
		                      <div className="rounded-xl border border-white/[0.08] bg-black/15 p-3">
		                        <p className="text-micro font-semibold tracking-[0.02em] text-secondary">Details</p>
	                        <MarkdownText
	                          mode="block"
	                          text={humanizeActivityBody(activeDecorated.item.description) ?? ''}
	                          className="mt-1.5 text-body leading-relaxed text-secondary"
	                        />
	                      </div>
	                    )}

                    {activeDetailTab === 'technical' && activeFileEvidence.length > 0 && (
                      <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
                        <p className="text-caption font-semibold tracking-[0.02em] text-secondary">
                          Filesystem evidence
                        </p>
	                        <div className="mt-2 space-y-2">
	                          {activeFileEvidence.map((entry, index) => {
	                            const evidenceHref = resolveFileEvidenceHref(entry.path);
	                            return (
	                            <div
	                              key={`${entry.key}:${entry.path}:${index}`}
	                              className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2"
	                            >
	                              <p className="text-micro font-semibold tracking-[0.02em] text-secondary">
                                {humanizeText(entry.key)}
                              </p>
	                              <p className="mt-1 break-all font-mono text-caption text-primary">
	                                {entry.path}
	                              </p>
	                              <div className="mt-2 flex flex-wrap gap-2">
	                                {evidenceHref ? (
	                                  <a
	                                    href={evidenceHref}
	                                    target="_blank"
	                                    rel="noopener noreferrer"
	                                    className="inline-flex items-center rounded-full border border-[#BFFF00]/25 bg-[#BFFF00]/10 px-2.5 py-1 text-caption font-semibold text-[#D8FFA1] transition hover:bg-[#BFFF00]/18"
	                                  >
	                                    Open in tab
	                                  </a>
	                                ) : null}
	                                <button
	                                  type="button"
	                                  onClick={() => void copyText(`${humanizeText(entry.key)} path`, entry.path)}
	                                  className="rounded-full border border-strong bg-white/[0.04] px-2.5 py-1 text-caption text-primary transition hover:bg-white/[0.1]"
	                                >
	                                  Copy path
	                                </button>
	                              </div>
	                            </div>
	                            );
	                          })}
	                        </div>
	                      </div>
	                    )}

                    {/* View registered artifact button (loop closure) */}
                    {activeDetailTab === 'overview' && activeDecorated && extractArtifactId(activeDecorated.item) && (
                      <button
                        type="button"
                        onClick={() => {
                          const aid = extractArtifactId(activeDecorated.item);
                          if (aid) openArtifactViewer(aid);
                        }}
                        className="flex w-full items-center gap-2.5 rounded-xl border border-cyan-400/25 bg-cyan-500/[0.08] px-3.5 py-2.5 text-left transition-colors hover:bg-cyan-500/[0.14]"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={colors.cyan} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                          <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                        </svg>
                        <span className="text-body font-medium" style={{ color: colors.cyan }}>
                          View registered artifact
                        </span>
                      </button>
                    )}

                    {activeDetailTab === 'technical' && activeArtifact && (
	                      <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/[0.06] p-3">
	                        <div className="flex items-center justify-between gap-2">
	                          <p className="text-caption font-semibold tracking-[0.02em] text-cyan-100/85">
	                            Artifact output
	                          </p>
                          <div className="inline-flex rounded-full border border-strong bg-black/30 p-0.5 text-caption">
                            <button
                              type="button"
                              onClick={() => setArtifactViewMode('structured')}
                              aria-pressed={artifactViewMode === 'structured'}
                              className={`rounded-full px-2.5 py-0.5 transition-colors ${
                                artifactViewMode === 'structured'
                                  ? 'bg-white/[0.12] text-white'
                                  : 'text-secondary hover:text-primary'
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
                                  : 'text-secondary hover:text-primary'
                              }`}
                            >
                              JSON
                            </button>
                          </div>
                        </div>
                        <p className="mt-1 text-micro text-cyan-100/55">Source: {activeArtifact.source}</p>
                        <div className="mt-2">
                          {artifactViewMode === 'structured' ? (
                            renderArtifactValue(activeArtifact.value)
                          ) : (
                            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-caption leading-relaxed text-primary">
                              {JSON.stringify(activeArtifact.value, null, 2)}
                            </pre>
                          )}
                        </div>
                      </div>
                    )}

	                    {activeDetailTab === 'technical' && activeResolvedMetadataJson && activeResolvedMetadataJson !== activeMetadataJson && (
	                      <details className="rounded-xl border border-white/[0.08] bg-black/35 p-3">
	                        <summary className="cursor-pointer select-none text-caption font-semibold tracking-[0.02em] text-secondary">
	                          Parsed metadata
	                        </summary>
	                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-caption leading-relaxed text-secondary">
	                          {activeResolvedMetadataJson}
	                        </pre>
	                      </details>
	                    )}

	                    {activeDetailTab === 'technical' && activeMetadataJson && (
		                      <details className="rounded-xl border border-white/[0.08] bg-black/35 p-3">
		                        <summary className="cursor-pointer select-none text-caption font-semibold tracking-[0.02em] text-secondary">
		                          Raw metadata
		                        </summary>
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-caption leading-relaxed text-secondary">
                          {activeMetadataJson}
                        </pre>
                      </details>
                    )}
                  </div>
                </motion.section>
              </AnimatePresence>
            </div>

            <div className="border-t border-subtle px-5 py-2.5 text-caption text-muted sm:px-6">
              Keyboard: ← previous · → next · Esc close
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
});
