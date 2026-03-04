import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import DatePicker from 'react-datepicker';
import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import { humanizeText, humanizeModel, humanizeActorName, humanizeWarning, formatTokens, humanizeStopReason, humanizePath, humanizeId, isOpaqueId } from '@/lib/humanize';
import { EmptyState } from '@/components/shared/EmptyState';
import { projectRunStatus, type CanonicalRunProjection } from '@/lib/runStatusModel';
import type {
  ActivityEventName,
  Initiative,
  LiveChatSnapshot,
  LiveActivityItem,
  LiveActivityType,
  SessionTreeNode,
  SliceRunProjection,
  SliceTimelineNarrativeProjectionV2,
} from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { MarkdownText } from '@/components/shared/MarkdownText';
import { Pill } from '@/components/shared/Pill';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { ProviderLogo } from '@/components/shared/ProviderLogo';
import { resolveProvider, type ProviderId } from '@/lib/providers';
import { ActivityEventIcon } from './activityVisuals';
import { ThreadView } from './ThreadView';
import type { ActivityTimeFilterId } from '@/lib/activityTimeFilters';
import { ACTIVITY_TIME_FILTERS, resolveActivityTimeFilter } from '@/lib/activityTimeFilters';
import { useArtifactViewer } from '@/components/artifacts/ArtifactViewerContext';
import { WhileYouWereAway } from '@/components/activity/WhileYouWereAway';
import { ActivityTimelineItem, type ArtifactSnippet } from './ActivityTimelineItem';
import { ActivityDetailModal } from './ActivityDetailModal';
import { ActivityDetailSummary } from './ActivityDetailSummary';
import { ChatDockProvider } from './chat/ChatDockContext';
import { ActivityChatDock } from './chat/ActivityChatDock';
import { isDemoModeEnabled } from '@/lib/initiativeIds';
import 'react-datepicker/dist/react-datepicker.css';

interface ActivityTimelineProps {
  activity: LiveActivityItem[];
  sessions: SessionTreeNode[];
  sliceRuns?: SliceRunProjection[];
  initiatives?: Initiative[];
  timelineNarrative?: SliceTimelineNarrativeProjectionV2[];
  selectedRunIds: string[];
  selectedSessionLabel?: string | null;
  selectedWorkstreamId?: string | null;
  selectedWorkstreamLabel?: string | null;
  agentFilter?: string | null;
  timeFilterId?: ActivityTimeFilterId;
  onTimeFilterChange?: (next: ActivityTimeFilterId) => void;
  customTimeRange?: {
    startIso: string | null;
    endIso: string | null;
  };
  onCustomTimeRangeChange?: (next: { startIso: string | null; endIso: string | null }) => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  onClearSelection: () => void;
  onClearWorkstreamFilter?: () => void;
  onClearAgentFilter?: () => void;
  onFocusRunId?: (runId: string) => void;
  onOpenDecision?: (decisionId?: string | null) => void;
  requestedActivityItemId?: string | null;
  onActivityItemRequestHandled?: (itemId: string) => void;
  onPlayNextUp?: () => Promise<void> | void;
  onStartAutopilot?: () => Promise<void> | void;
  onPauseWorkstream?: (session: SessionTreeNode) => Promise<void> | void;
  onCreateInitiative?: () => void;
  onOpenMissionControl?: () => void;
  onOpenSettings?: () => void;
  workspaceId?: string | null;
  chatSnapshot?: LiveChatSnapshot;
  onRefreshData?: () => Promise<void> | void;
  isLoading?: boolean;
  onOpenNextUp?: () => void;
  devMode?: boolean;
}

const INITIAL_RENDER_COUNT = 50;
const RENDER_STEP = 50;
const CLUSTER_EXPANDED_BATCH_SIZE = 20;
const MAX_RENDER_COUNT = 3_600;
const MAX_FILTER_POOL = 12_000;

type ActivityBucket = 'message' | 'artifact' | 'decision';
type ActivityFilterId = 'all' | 'completed' | 'needs_attention' | 'in_progress';
type SortOrder = 'newest' | 'oldest';
type ActivityUserState = 'update' | 'needs_input' | 'completed' | 'issue' | 'in_progress';
interface DecoratedActivityItem {
  item: LiveActivityItem;
  bucket: ActivityBucket;
  userState: ActivityUserState;
  userStateWhy: string;
  canonicalProjection: CanonicalRunProjection;
  runId: string | null;
  timestampEpoch: number;
  searchText: string;
  runLabelSearch: string;
  scopeGroupId?: string | null;
  scope?: 'task' | 'milestone' | 'workstream';
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
  completed: 'Completed',
  needs_attention: 'Needs attention',
  in_progress: 'In progress',
};

const ACTIVITY_AUTO_EXPAND_ORDER: ActivityTimeFilterId[] = ['live', '24h', '7d', 'all'];

function nextActivityTimeFilter(current: ActivityTimeFilterId): ActivityTimeFilterId | null {
  if (current === 'custom' || current === 'all') return null;
  const index = ACTIVITY_AUTO_EXPAND_ORDER.indexOf(current);
  if (index < 0) return null;
  return ACTIVITY_AUTO_EXPAND_ORDER[index + 1] ?? null;
}

function mapsEqual<K, V extends Record<string, unknown>>(a: Map<K, V>, b: Map<K, V>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, valueA] of a) {
    const valueB = b.get(key);
    if (!valueB) return false;
    for (const prop of Object.keys(valueA)) {
      if (valueA[prop] !== valueB[prop]) return false;
    }
  }
  return true;
}

function runtimeProviderIdFromLogo(
  provider: SessionTreeNode['runtimeProvider'] | null | undefined
): ProviderId {
  if (provider === 'codex') return 'codex';
  if (provider === 'openai') return 'openai';
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'openclaw') return 'openclaw';
  if (provider === 'orgx') return 'orgx';
  return 'unknown';
}

function shouldUseProviderLogo(provider: ProviderId): boolean {
  return (
    provider === 'codex' ||
    provider === 'openai' ||
    provider === 'anthropic' ||
    provider === 'openclaw'
  );
}

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed);
}

function formatRangeLabel(value: Date | null): string {
  if (!value) return '—';
  return value.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function toDateTimeLocalValue(value: Date | null): string {
  if (!value) return '';
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function parseDateTimeLocalValue(value: string): Date | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed);
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
  const candidates = [
    'runId',
    'run_id',
    'sliceRunId',
    'slice_run_id',
    'sessionId',
    'session_id',
    'agentRunId',
  ];
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

const UUID_LIKE_ACTOR_VALUE_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_LIKE_ACTOR_VALUE_REGEX = /^[0-9a-f]{20,}$/i;
const NUMERIC_ONLY_ACTOR_VALUE_REGEX = /^\d+$/;
const EXTERNAL_USER_ACTOR_VALUE_REGEX = /^(user|usr|clerk)_[a-z0-9]+$/i;

function sanitizeActorDisplayValue(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (UUID_LIKE_ACTOR_VALUE_REGEX.test(trimmed)) return null;
  if (HEX_LIKE_ACTOR_VALUE_REGEX.test(trimmed)) return null;
  if (NUMERIC_ONLY_ACTOR_VALUE_REGEX.test(trimmed)) return null;
  if (EXTERNAL_USER_ACTOR_VALUE_REGEX.test(trimmed)) return null;
  return trimmed;
}

const GENERIC_REQUESTER_LABELS = new Set([
  'main',
  'system',
  'local',
  'cli',
  'openclaw',
  'runtime',
  'unknown',
]);

function normalizeRequesterDisplay(label: string | null): { primary: string; secondary: string | null } {
  if (!label || label.trim().length === 0 || label.trim() === '—') {
    return { primary: 'OrgX', secondary: null };
  }
  const trimmed = label.trim();
  const normalized = trimmed.toLowerCase();
  if (GENERIC_REQUESTER_LABELS.has(normalized)) {
    return { primary: 'You', secondary: trimmed };
  }
  return { primary: trimmed, secondary: null };
}

function resolveActorFromMetadata(
  metadata: Record<string, unknown> | undefined,
  idKeys: string[],
  nameKeys: string[]
): ActivityActor | null {
  if (!metadata) return null;

  let id: string | null = null;
  for (const key of idKeys) {
    const value = sanitizeActorDisplayValue(normalizeActorValue(metadata[key]));
    if (value) {
      id = value;
      break;
    }
  }

  let name: string | null = null;
  for (const key of nameKeys) {
    const value = sanitizeActorDisplayValue(normalizeActorValue(metadata[key]));
    if (value) {
      name = value;
      break;
    }
  }

  if (!id && !name) return null;
  return {
    id,
    name,
    label: name ?? id ?? 'OrgX',
  };
}

function sameActor(a: ActivityActor | null, b: ActivityActor | null): boolean {
  if (!a || !b) return false;
  if (a.id && b.id) {
    const aId = a.id.trim().toLowerCase();
    const bId = b.id.trim().toLowerCase();
    if (aId === bId) {
      const aName = a.name?.trim().toLowerCase() ?? null;
      const bName = b.name?.trim().toLowerCase() ?? null;
      if (aName && bName && aName !== bName) return false;
      if (['unknown', 'system', 'agent', 'none', 'null', 'undefined'].includes(aId)) {
        return Boolean(aName && bName && aName === bName);
      }
      return true;
    }
  }
  if (!a.name || !b.name) return false;
  return a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
}

function resolveActivityActorFlow(item: LiveActivityItem): ActivityActorFlow {
  const metadata = metadataForItem(item);
  const identity = resolveAgentIdentity(item);
  const cleaned = cleanSystemTitle(item);
  const identityAgentId = sanitizeActorDisplayValue(identity.agentId);
  const identityAgentName = sanitizeActorDisplayValue(identity.agentName);
  const explicitRequesterId = sanitizeActorDisplayValue(item.requesterAgentId ?? null);
  const explicitRequesterName = sanitizeActorDisplayValue(item.requesterAgentName ?? null);

  const explicitRequester =
    explicitRequesterId || explicitRequesterName
      ? {
          id: explicitRequesterId,
          name: explicitRequesterName,
          label: explicitRequesterName ?? explicitRequesterId ?? 'OrgX',
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

  const explicitExecutorId = sanitizeActorDisplayValue(item.executorAgentId ?? null);
  const explicitExecutorName = sanitizeActorDisplayValue(item.executorAgentName ?? null);

  const explicitExecutor =
    explicitExecutorId || explicitExecutorName
      ? {
          id: explicitExecutorId,
          name: explicitExecutorName,
          label: explicitExecutorName ?? explicitExecutorId ?? 'Agent',
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
    (identityAgentId || identityAgentName
      ? {
          id: identityAgentId,
          name: identityAgentName,
          label: identityAgentName ?? identityAgentId ?? 'Agent',
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
      subtitle: `${requester.label} handed off to ${executor.label}`,
    };
  }

  if (requester && !executor) {
    return {
      requester,
      executor: null,
      mode: 'requested',
      primaryLabel: requester.label,
      subtitle: `${requester.label} requested a run`,
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
      primaryLabel: 'OrgX',
      subtitle: 'OrgX',
    };
  }

  return {
    requester: null,
    executor: null,
    mode: 'system',
    primaryLabel:
      sanitizeActorDisplayValue(item.agentName ?? null) ??
      sanitizeActorDisplayValue(item.agentId ?? null) ??
      'OrgX',
    subtitle:
      sanitizeActorDisplayValue(item.agentName ?? null) ??
      sanitizeActorDisplayValue(item.agentId ?? null) ??
      'OrgX',
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

const ACTIVITY_BUCKET_BY_EVENT = new Map<ActivityEventName | string, ActivityBucket>([
  ['autopilot_slice_artifact_buffered', 'artifact'],
  ['decision_buffered', 'decision'],
  ['auto_continue_spawn_guard_blocked', 'decision'],
  ['auto_continue_spawn_guard_rate_limited', 'decision'],
  ['agent_launch_spawn_guard_blocked', 'decision'],
  ['agent_launch_spawn_guard_rate_limited', 'decision'],
  ['agent_restart_spawn_guard_blocked', 'decision'],
  ['agent_restart_spawn_guard_rate_limited', 'decision'],
  ['next_up_fallback_spawn_guard_blocked', 'decision'],
  ['next_up_fallback_spawn_guard_rate_limited', 'decision'],
  ['autopilot_slice_mcp_handshake_failed', 'decision'],
  ['autopilot_slice_timeout', 'decision'],
  ['autopilot_slice_log_stall', 'decision'],
  ['autopilot_autofix_scheduled', 'decision'],
  ['autopilot_autofix_executed', 'message'],
  ['autopilot_autofix_skipped', 'message'],
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

  if (eventName === 'auto_continue_stopped') {
    const stopReason = normalizeStatusKey(
      metadataString(metadata, ['stop_reason', 'stopReason']) ?? ''
    );
    if (stopReason === 'blocked' || stopReason === 'error') return 'decision';
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
  // Exhaustive Record — compile error if a new LiveActivityType is added
  // without a label entry here.
  const labels: Record<LiveActivityType, string> = {
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
  return labels[type];
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

function userStateLabel(state: ActivityUserState): string {
  if (state === 'completed') return 'Completed';
  if (state === 'needs_input') return 'Needs attention';
  if (state === 'issue') return 'Issue';
  if (state === 'in_progress') return 'In progress';
  return 'Update';
}

function userStateColor(state: ActivityUserState): string {
  if (state === 'completed') return colors.lime;
  if (state === 'needs_input') return colors.amber;
  if (state === 'issue') return colors.red;
  if (state === 'in_progress') return colors.teal;
  return colors.teal;
}

function resolveActivityUserState(
  bucket: ActivityBucket,
  projection: CanonicalRunProjection
): { state: ActivityUserState; why: string } {
  if (projection.status === 'failed') {
    return { state: 'issue', why: projection.sentence };
  }
  if (projection.status === 'needs_attention') {
    const nextAction = projection.nextAction?.toLowerCase() ?? '';
    const needsDecision = nextAction.includes('decision');
    return {
      state: needsDecision ? 'needs_input' : 'issue',
      why: projection.sentence,
    };
  }
  if (projection.status === 'in_progress') {
    return { state: 'in_progress', why: projection.sentence };
  }
  if (projection.status === 'completed') {
    return { state: 'completed', why: projection.sentence };
  }

  if (bucket === 'artifact') {
    return { state: 'completed', why: 'Produced an artifact output.' };
  }

  return { state: 'update', why: projection.sentence };
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

function metadataStringArray(
  metadata: Record<string, unknown>,
  keys: string[]
): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  const pushValue = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    const normalized = raw.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    values.push(normalized);
  };

  for (const key of keys) {
    const value = metadata[key];
    if (Array.isArray(value)) {
      for (const entry of value) pushValue(entry);
      continue;
    }
    pushValue(value);
  }

  return values;
}

function extractDecisionIdsFromMetadata(
  metadata: Record<string, unknown> | undefined
): {
  decisionIds: string[];
  blockingDecisionIds: string[];
  nonBlockingDecisionIds: string[];
} {
  if (!metadata) {
    return {
      decisionIds: [],
      blockingDecisionIds: [],
      nonBlockingDecisionIds: [],
    };
  }

  const blockingDecisionIds = metadataStringArray(metadata, [
    'blocking_decision_ids',
    'blockingDecisionIds',
  ]);
  const nonBlockingDecisionIds = metadataStringArray(metadata, [
    'non_blocking_decision_ids',
    'nonBlockingDecisionIds',
  ]);

  const directDecisionIds = metadataStringArray(metadata, [
    'decision_id',
    'decisionId',
    'decision_ids',
    'decisionIds',
  ]);

  const decisionIds = new Set<string>([
    ...directDecisionIds,
    ...blockingDecisionIds,
    ...nonBlockingDecisionIds,
  ]);

  const decisionsNeededRaw = metadata.decisions_needed ?? metadata.decisionsNeeded;
  if (Array.isArray(decisionsNeededRaw)) {
    for (const entry of decisionsNeededRaw) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const ids = metadataStringArray(record, ['id', 'decision_id', 'decisionId']);
      const isBlocking = record.blocking !== false;
      for (const id of ids) {
        decisionIds.add(id);
        if (isBlocking) {
          if (!blockingDecisionIds.includes(id)) blockingDecisionIds.push(id);
        } else if (!nonBlockingDecisionIds.includes(id)) {
          nonBlockingDecisionIds.push(id);
        }
      }
    }
  }

  return {
    decisionIds: Array.from(decisionIds),
    blockingDecisionIds,
    nonBlockingDecisionIds,
  };
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
  decisionIds: string[];
  blockingDecisionIds: string[];
  nonBlockingDecisionIds: string[];
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
    (eventName.startsWith('autopilot_slice') &&
      !eventName.includes('artifact')) ||
    eventName.startsWith('autopilot_autofix');
  if (
    !event ||
    (!isAutopilotSliceEvent &&
      event !== 'auto_continue_started' &&
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
  const decisionIdState = extractDecisionIdsFromMetadata(metadata);
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
    decisionIds: decisionIdState.decisionIds,
    blockingDecisionIds: decisionIdState.blockingDecisionIds,
    nonBlockingDecisionIds: decisionIdState.nonBlockingDecisionIds,
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

function extractArtifactSnippet(item: LiveActivityItem): ArtifactSnippet | null {
  const metadata = metadataForItem(item);
  const hasRegisteredId = !!(
    (metadata && typeof metadata.artifact_id === 'string') ||
    (metadata && typeof metadata.artifactId === 'string') ||
    (metadata && typeof metadata.work_artifact_id === 'string')
  );
  const payload = extractArtifactPayload(item);
  if (!payload && !hasRegisteredId) return null;

  let label = 'Artifact';
  if (item.type === 'artifact_created') label = 'Created artifact';
  else if (payload?.source === 'toolOutput' || payload?.source === 'toolOutputs') label = 'Tool output';
  else if (payload?.source === 'toolResult' || payload?.source === 'toolResults') label = 'Result';
  else if (payload?.source === 'output' || payload?.source === 'outputs') label = 'Output';
  else if (hasRegisteredId) label = 'Registered artifact';

  let preview = '';
  if (payload) {
    const v = payload.value;
    if (typeof v === 'string') {
      preview = v.length > 80 ? v.slice(0, 80) + '…' : v;
    } else if (Array.isArray(v)) {
      preview = `${v.length} item${v.length === 1 ? '' : 's'}`;
    } else if (v && typeof v === 'object') {
      const keys = Object.keys(v as Record<string, unknown>);
      preview = keys.length <= 4 ? keys.join(', ') : `${keys.length} fields`;
    }
  }

  return { label, preview, hasRegisteredId };
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

function readableContextLabel(
  value: string | null | undefined,
  idHint?: string | null
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalizedId = typeof idHint === 'string' ? idHint.trim().toLowerCase() : '';
  if (normalizedId && trimmed.toLowerCase() === normalizedId) return null;
  if (isOpaqueId(trimmed)) return null;
  return trimmed;
}

function firstReadableContextLabel(
  candidates: Array<{ value: string | null | undefined; idHint?: string | null }>
): string | null {
  for (const candidate of candidates) {
    const label = readableContextLabel(candidate.value, candidate.idHint);
    if (label) return label;
  }
  return null;
}

type SpawnGuardSnapshot = {
  event: string | null;
  blockedReason: string | null;
  domain: string | null;
  modelTier: string | null;
  domainCurrent: number | null;
  domainMax: number | null;
  totalCurrent: number | null;
  totalMax: number | null;
  retryAt: string | null;
  retryInMs: number | null;
  isRateLimited: boolean;
};

function parseSpawnGuardRateCounters(reason: string | null): {
  domainCurrent: number | null;
  domainMax: number | null;
  totalCurrent: number | null;
  totalMax: number | null;
} {
  if (!reason) {
    return {
      domainCurrent: null,
      domainMax: null,
      totalCurrent: null,
      totalMax: null,
    };
  }

  const match = reason.match(
    /rate limit:\s*(\d+)\s*\/\s*(\d+)\s*domain(?:\s*,\s*(\d+)\s*\/\s*(\d+)\s*total)?/i
  );
  if (!match) {
    return {
      domainCurrent: null,
      domainMax: null,
      totalCurrent: null,
      totalMax: null,
    };
  }

  return {
    domainCurrent: Number.isFinite(Number(match[1])) ? Number(match[1]) : null,
    domainMax: Number.isFinite(Number(match[2])) ? Number(match[2]) : null,
    totalCurrent: Number.isFinite(Number(match[3])) ? Number(match[3]) : null,
    totalMax: Number.isFinite(Number(match[4])) ? Number(match[4]) : null,
  };
}

function extractSpawnGuardSnapshot(
  item: LiveActivityItem | null,
  detail: AutopilotSliceDetail | null
): SpawnGuardSnapshot | null {
  if (!item) return null;
  const metadata = metadataForItem(item);
  if (!metadata) return null;

  const event = metadataString(metadata, ['event', 'event_name', 'eventName']);
  const spawnGuard = asMetadataRecord(metadata.spawn_guard);
  const checks = asMetadataRecord(spawnGuard?.checks);
  const rateLimit = asMetadataRecord(checks?.rateLimit ?? checks?.rate_limit);

  const blockedReason =
    metadataString(metadata, ['blocked_reason', 'blockedReason', 'last_error', 'lastError']) ??
    detail?.error ??
    null;

  const parsedCounters = parseSpawnGuardRateCounters(blockedReason);
  const domainCurrent = numericFromValue(rateLimit?.current) ?? parsedCounters.domainCurrent;
  const domainMax = numericFromValue(rateLimit?.max) ?? parsedCounters.domainMax;
  const totalCurrent = parsedCounters.totalCurrent;
  const totalMax = parsedCounters.totalMax;

  const rateLimitPassed = typeof rateLimit?.passed === 'boolean' ? rateLimit.passed : null;
  const isRateLimited =
    (event?.includes('rate_limited') ?? false) ||
    Boolean(blockedReason && /rate limit/i.test(blockedReason)) ||
    rateLimitPassed === false;
  const looksLikeSpawnGuardEvent = event?.includes('spawn_guard') ?? false;

  if (!looksLikeSpawnGuardEvent && !isRateLimited && !spawnGuard && !blockedReason) return null;

  return {
    event,
    blockedReason,
    domain:
      metadataString(metadata, ['domain']) ?? metadataString(spawnGuard, ['domain', 'task_domain']),
    modelTier:
      metadataString(metadata, ['spawn_guard_model_tier', 'model_tier']) ??
      metadataString(spawnGuard, ['modelTier', 'model_tier']),
    domainCurrent,
    domainMax,
    totalCurrent,
    totalMax,
    retryAt: metadataString(metadata, ['next_retry_at', 'nextRetryAt']),
    retryInMs: numericFromValue(metadata.next_retry_in_ms ?? metadata.nextRetryInMs),
    isRateLimited,
  };
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

function isGenericOrgxDomainLabel(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized.startsWith("orgx ")) return false;
  return (
    normalized === "orgx engineering" ||
    normalized === "orgx product" ||
    normalized === "orgx marketing" ||
    normalized === "orgx sales" ||
    normalized === "orgx operations" ||
    normalized === "orgx design" ||
    normalized === "orgx orchestrator"
  );
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
  const inferredFromId = normalizedId ? namesById?.get(normalizedId) ?? null : null;
  const resolvedName =
    normalizedName && inferredFromId && isGenericOrgxDomainLabel(normalizedName)
      ? inferredFromId
      : normalizedName ?? inferredFromId;
  if (resolvedName) return humanizeActorName(resolvedName);
  if (!normalizedId) return 'OrgX';
  const idKey = normalizedId.toLowerCase();
  if (
    idKey === 'main' ||
    idKey === 'system' ||
    idKey === 'unknown' ||
    idKey === 'runtime' ||
    idKey === 'orgx' ||
    idKey === 'openclaw' ||
    idKey === 'null' ||
    idKey === 'undefined'
  ) {
    return humanizeActorName(normalizedId);
  }
  if (
    UUID_LIKE_REGEX.test(normalizedId) ||
    HEX_LIKE_ID_REGEX.test(normalizedId) ||
    NUMERIC_ONLY_ACTOR_VALUE_REGEX.test(normalizedId) ||
    EXTERNAL_USER_ACTOR_VALUE_REGEX.test(normalizedId)
  ) {
    return 'OrgX';
  }
  return humanizeActorName(normalizedId);
}

const UUID_LIKE_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_LIKE_ID_REGEX = /^[0-9a-f]{20,}$/i;
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
    'decision_id',
    'decisionId',
    'outbox_event_id',
    'outboxEventId',
  ];

  const listKeys = [
    'task_ids',
    'taskIds',
    'milestone_ids',
    'milestoneIds',
    'decision_ids',
    'decisionIds',
    'blocking_decision_ids',
    'blockingDecisionIds',
    'non_blocking_decision_ids',
    'nonBlockingDecisionIds',
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

function extractActivityDecisionIds(item: LiveActivityItem | null): string[] {
  if (!item) return [];
  const metadata = metadataForItem(item);
  return extractDecisionIdsFromMetadata(metadata).decisionIds;
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
  terminalStop: boolean;
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
  if (event === 'auto_continue_started') return 3;
  if (event === 'next_up_manual_dispatch_started') return 8;
  if (event === 'autopilot_slice_dispatched') return 14;
  if (event === 'autopilot_slice_status_updates_buffered') return 72;
  if (event === 'autopilot_slice_result') return 92;
  if (event === 'autopilot_autofix_scheduled') return 6;
  if (event === 'autopilot_autofix_executed') return 18;
  if (event === 'autopilot_autofix_skipped') return 100;
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
  const tone = detail ? progressToneForAutopilot(detail) : 'neutral';
  const isTerminalStopFor = (pct: number) =>
    pct >= 100 && (tone === 'warning' || tone === 'critical');
  const stoppedLabel = 'Reached a terminal blocked state. Resolve blockers to continue.';
  if (detail?.progressPct !== null && detail?.progressPct !== undefined) {
    const pct = coerceProgressPercent(detail.progressPct) ?? 0;
    const terminalStop = isTerminalStopFor(pct);
    return {
      pct,
      source: 'metadata',
      label: terminalStop ? stoppedLabel : 'Progress',
      tone,
      terminalStop,
    };
  }
  if (sessionProgress !== null) {
    const terminalStop = isTerminalStopFor(sessionProgress);
    return {
      pct: sessionProgress,
      source: 'session',
      label: terminalStop ? stoppedLabel : 'Progress',
      tone,
      terminalStop,
    };
  }
  if (!detail) return null;
  const lifecycle = inferLifecycleProgress(detail);
  if (lifecycle === null) return null;
  const terminalStop = isTerminalStopFor(lifecycle);
  return {
    pct: lifecycle,
    source: 'lifecycle',
    label: terminalStop ? stoppedLabel : 'Progress',
    tone,
    terminalStop,
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
  } | null,
  canonicalProjection: CanonicalRunProjection | null = null
): DetailOutcome | null {
  const metadata = metadataForItem(item);
  const eventName = normalizeStatusKey(
    metadataString(metadata, ['event', 'event_name', 'eventName']) ?? detail?.event ?? ''
  );
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
    (parsedStatus === 'needs_decision' && inferredNonBlockingDecisions === 0);
  const completionLike =
    item.type === 'run_completed' ||
    item.type === 'milestone_completed' ||
    isDoneLikeStatus(parsedStatus) ||
    stopReason === 'completed';
  const spawnGuardRateLimited =
    eventName.includes('spawn_guard_rate_limited') ||
    Boolean(blockedReason && /rate limit/i.test(blockedReason));
  const spawnGuardBlocked = eventName.includes('spawn_guard_blocked');

  if (eventName === 'auto_continue_started') {
    return {
      label: 'Autopilot on',
      summary:
        humanizeActivityBody(item.title) ??
        'Autopilot is active and will continue dispatching work from the Next Up queue.',
      hint: 'Watch Activity and Next Up for newly dispatched slices.',
      tone: 'positive',
    };
  }

  if (eventName === 'auto_continue_stopped') {
    if (stopReason === 'budget_exhausted') {
      return {
        label: 'Budget exhausted',
        summary:
          humanizeActivityBody(item.title) ??
          'Autopilot stopped because the configured token budget was exhausted.',
        hint: 'Restart with an explicit token budget or a narrower workstream scope.',
        tone: 'warning',
      };
    }
    if (stopReason === 'completed') {
      return {
        label: 'Completed',
        summary:
          humanizeActivityBody(item.title) ??
          'Autopilot stopped because the current dispatch scope is complete.',
        hint: null,
        tone: 'positive',
      };
    }
    if (stopReason === 'stopped') {
      return {
        label: 'Stopped',
        summary:
          humanizeActivityBody(item.title) ??
          'Autopilot was stopped by request.',
        hint: 'Start again to resume continuous dispatch.',
        tone: 'neutral',
      };
    }
    if (stopReason === 'blocked') {
      return {
        label: decisionsNeeded ? 'Needs decision' : 'Blocked',
        summary:
          humanizeActivityBody(item.title) ??
          (decisionsNeeded
            ? 'Autopilot is paused pending a decision.'
            : 'Autopilot is blocked and needs intervention.'),
        hint: decisionsNeeded
          ? 'Open the Decisions panel and approve the pending item to continue.'
          : 'Resolve the blocker, then restart autopilot.',
        tone: decisionsNeeded ? 'warning' : 'critical',
      };
    }
    if (stopReason === 'error') {
      return {
        label: 'Error',
        summary:
          humanizeActivityBody(item.title) ??
          blockedReason ??
          'Autopilot stopped because of an error.',
        hint: 'Open evidence and logs, then retry or pause the workstream.',
        tone: 'critical',
      };
    }
  }

  // ── autopilot_transition ──
  if (eventName === "autopilot_transition") {
    const oldState = String(metadata?.old_state ?? "");
    const newState = String(metadata?.new_state ?? "");
    const reason = String(metadata?.reason ?? "");
    if (newState === "running") {
      return {
        label: "Autopilot activated",
        summary: `State changed from ${oldState} to running.`,
        hint: "Autopilot will dispatch work from the Next Up queue.",
        tone: "positive" as const,
      };
    }
    if (newState === "blocked" || newState === "error") {
      return {
        label: newState === "error" ? "Autopilot error" : "Autopilot blocked",
        summary: `State changed from ${oldState} to ${newState}${reason ? `: ${reason}` : ""}.`,
        hint: "Review the triage queue for actionable items.",
        tone: "critical" as const,
      };
    }
    return {
      label: "Autopilot state change",
      summary: `${oldState} → ${newState}${reason ? ` (${reason})` : ""}.`,
      hint: null,
      tone: "neutral" as const,
    };
  }

  if (spawnGuardRateLimited) {
    return {
      label: 'Rate limited',
      summary: blockedReason
        ? humanizeActivityBody(blockedReason) ?? 'Spawn guard rate limit reached.'
        : 'Spawn guard rate limit reached.',
      hint: 'Adjust limits in settings or wait for the window to reset before retrying.',
      tone: 'warning',
    };
  }

  if (spawnGuardBlocked) {
    return {
      label: 'Spawn guard blocked',
      summary: blockedReason
        ? humanizeActivityBody(blockedReason) ?? 'Spawn guard denied dispatch.'
        : 'Spawn guard denied dispatch.',
      hint: 'Review guard checks, then retry or approve an override.',
      tone: 'critical',
    };
  }

  if (canonicalProjection) {
    if (canonicalProjection.status === 'completed') {
      return {
        label: inferredNonBlockingDecisions > 0 ? 'Completed + follow-up' : 'Completed',
        summary:
          inferredNonBlockingDecisions > 0
            ? `Execution completed. ${inferredNonBlockingDecisions} non-blocking decision${inferredNonBlockingDecisions === 1 ? '' : 's'} were logged for optional follow-up.`
            : canonicalProjection.sentence,
        hint: canonicalProjection.nextAction,
        tone: 'positive',
      };
    }
    if (canonicalProjection.status === 'failed') {
      return {
        label: 'Failed',
        summary: blockedReason
          ? humanizeActivityBody(blockedReason) ?? canonicalProjection.sentence
          : canonicalProjection.sentence,
        hint: canonicalProjection.nextAction,
        tone: 'critical',
      };
    }
    if (canonicalProjection.status === 'needs_attention') {
      const decisionLike =
        decisionsNeeded ||
        (canonicalProjection.nextAction?.toLowerCase().includes('decision') ?? false);
      return {
        label: decisionLike ? 'Needs decision' : 'Needs attention',
        summary: canonicalProjection.sentence,
        hint:
          canonicalProjection.nextAction ??
          (decisionLike
            ? 'Review the Decisions panel and resolve the pending item.'
            : 'Review blocker details and resume when resolved.'),
        tone: decisionLike ? 'warning' : 'critical',
      };
    }
    if (canonicalProjection.status === 'in_progress') {
      return {
        label: 'In progress',
        summary: canonicalProjection.sentence,
        hint: null,
        tone: 'neutral',
      };
    }
  }

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

function syncReplayDedupKey(item: LiveActivityItem): string | null {
  if (!isOutboxSyncReplayEvent(item)) return null;
  const metadata = metadataForItem(item);
  if (!metadata) return null;

  const idempotencyKey = metadataString(metadata, ['idempotency_key', 'idempotencyKey']);
  if (idempotencyKey) {
    return `idem:${idempotencyKey.toLowerCase()}`;
  }

  const eventName = metadataString(metadata, ['event', 'event_name', 'eventName']) ?? '';
  const changesetId = metadataString(metadata, ['changeset_id', 'changesetId']) ?? '';
  const entityType = metadataString(metadata, ['entity_type', 'entityType']) ?? '';
  const entityId = metadataString(metadata, ['entity_id', 'entityId']) ?? '';
  const runId = resolveRunId(item) ?? '';
  const normalizedTitle = cleanSystemTitle(item).title.trim().toLowerCase();
  return `fallback:${eventName.toLowerCase()}:${changesetId.toLowerCase()}:${entityType.toLowerCase()}:${entityId.toLowerCase()}:${runId.toLowerCase()}:${normalizedTitle}`;
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
  sliceRuns = [],
  initiatives = [],
  timelineNarrative = [],
  selectedRunIds,
  selectedSessionLabel = null,
  selectedWorkstreamId = null,
  selectedWorkstreamLabel = null,
  agentFilter = null,
  timeFilterId = 'live',
  onTimeFilterChange,
  customTimeRange = { startIso: null, endIso: null },
  onCustomTimeRangeChange,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  onClearSelection,
  onClearWorkstreamFilter,
  onClearAgentFilter,
  onFocusRunId,
  onOpenDecision,
  requestedActivityItemId = null,
  onActivityItemRequestHandled,
  onPlayNextUp,
  onStartAutopilot,
  onPauseWorkstream,
  onCreateInitiative,
  onOpenMissionControl,
  onOpenSettings,
  workspaceId = null,
  chatSnapshot,
  onRefreshData,
  isLoading = false,
  onOpenNextUp,
  devMode = false,
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
  const [timeRangeMenuOpen, setTimeRangeMenuOpen] = useState(false);
  const [renderCount, setRenderCount] = useState(INITIAL_RENDER_COUNT);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [detailMenuOpen, setDetailMenuOpen] = useState(false);
  const [detailDirection, setDetailDirection] = useState<1 | -1>(1);
  const [artifactViewMode, setArtifactViewMode] = useState<'structured' | 'json'>('structured');
  const [detailSummaryOverride, setDetailSummaryOverride] = useState<string | null>(null);
  const [detailSummarySource, setDetailSummarySource] = useState<'feed' | 'local' | 'missing'>('feed');
  const [detailHeadlineOverride, setDetailHeadlineOverride] = useState<string | null>(null);
  const [detailHeadlineSource, setDetailHeadlineSource] = useState<HeadlineSource>(null);
  const [headlineEndpointUnsupported, setHeadlineEndpointUnsupported] = useState(false);
  const [emptyActionPending, setEmptyActionPending] = useState<'play' | 'autopilot' | 'pause' | null>(null);
  const [emptyActionError, setEmptyActionError] = useState<string | null>(null);
  const [autoFixPending, setAutoFixPending] = useState(false);
  const [autoFixNotice, setAutoFixNotice] = useState<string | null>(null);
  const [awayVisible, setAwayVisible] = useState(false);
  const lastInteractionRef = useRef(Date.now());
  const controlsMenuRef = useRef<HTMLDivElement | null>(null);
  const timeRangeMenuRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const handledRequestedItemIdRef = useRef<string | null>(null);
  const [customDraftStartAt, setCustomDraftStartAt] = useState<Date | null>(() =>
    parseIsoDate(customTimeRange.startIso)
  );
  const [customDraftEndAt, setCustomDraftEndAt] = useState<Date | null>(() =>
    parseIsoDate(customTimeRange.endIso)
  );
  const [isMobileDatePickerViewport, setIsMobileDatePickerViewport] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth <= 640;
  });

  const timeWindow = useMemo(() => resolveActivityTimeFilter(timeFilterId), [timeFilterId]);
  const customAppliedStartAt = useMemo(
    () => parseIsoDate(customTimeRange.startIso),
    [customTimeRange.startIso]
  );
  const customAppliedEndAt = useMemo(
    () => parseIsoDate(customTimeRange.endIso),
    [customTimeRange.endIso]
  );
  const customRangeValid = useMemo(() => {
    if (!customDraftStartAt || !customDraftEndAt) return false;
    return customDraftEndAt.getTime() >= customDraftStartAt.getTime();
  }, [customDraftEndAt, customDraftStartAt]);
  const selectedTimeLabel = useMemo(() => {
    if (timeFilterId !== 'custom') return timeWindow.label;
    if (customAppliedStartAt && customAppliedEndAt) {
      return `${formatRangeLabel(customAppliedStartAt)} - ${formatRangeLabel(customAppliedEndAt)}`;
    }
    return 'Custom range';
  }, [customAppliedEndAt, customAppliedStartAt, timeFilterId, timeWindow.label]);

  useEffect(() => {
    setCustomDraftStartAt(customAppliedStartAt);
    setCustomDraftEndAt(customAppliedEndAt);
  }, [customAppliedEndAt, customAppliedStartAt]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const syncViewport = () => setIsMobileDatePickerViewport(window.innerWidth <= 640);
    syncViewport();
    window.addEventListener('resize', syncViewport);
    return () => window.removeEventListener('resize', syncViewport);
  }, []);

  // "While you were away" — track inactivity and show summary on return
  useEffect(() => {
    const AWAY_THRESHOLD = 5 * 60_000; // 5 minutes
    const handler = () => { lastInteractionRef.current = Date.now(); };
    window.addEventListener('pointerdown', handler);
    window.addEventListener('keydown', handler);
    const interval = setInterval(() => {
      if (Date.now() - lastInteractionRef.current > AWAY_THRESHOLD) {
        setAwayVisible(true);
      }
    }, 30_000);
    return () => {
      window.removeEventListener('pointerdown', handler);
      window.removeEventListener('keydown', handler);
      clearInterval(interval);
    };
  }, []);

  const awaySummary = useMemo(() => {
    const completed = sessions.filter((s) => s.status === 'completed').length;
    const blocked = sessions.filter(
      (s) => s.status === 'blocked' || s.status === 'failed'
    ).length;
    const decisions = activity.filter(
      (a) =>
        a.type === 'decision_requested' &&
        (a.metadata as Record<string, unknown> | undefined)?.status === 'pending'
    ).length;
    return { completed, blocked, decisions };
  }, [sessions, activity]);

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
  const prevSessionSnapshotRef = useRef(new Map<string, { status: string | null; phase: string | null; state: string | null; blockerCount: number; blockerReason: string | null }>());
  const sessionSnapshotByRunId = useMemo(() => {
    const map = new Map<
      string,
      {
        status: string | null;
        phase: string | null;
        state: string | null;
        blockerCount: number;
        blockerReason: string | null;
      }
    >();
    for (const session of sessions) {
      const snapshot = {
        status: session.status ?? null,
        phase: session.phase ?? null,
        state: session.state ?? null,
        blockerCount: Array.isArray(session.blockers) ? session.blockers.length : 0,
        blockerReason: session.blockerReason ?? session.blockerDiagnostics?.reason ?? null,
      };
      map.set(session.runId, snapshot);
      map.set(session.id, snapshot);
    }
    if (mapsEqual(prevSessionSnapshotRef.current, map)) {
      return prevSessionSnapshotRef.current;
    }
    prevSessionSnapshotRef.current = map;
    return map;
  }, [sessions]);
  const prevSliceSnapshotRef = useRef(new Map<string, { status: string | null; blockingDecisions: number; nonBlockingDecisions: number; updatedEpoch: number }>());
  const sliceSnapshotByRunId = useMemo(() => {
    const map = new Map<
      string,
      {
        status: string | null;
        blockingDecisions: number;
        nonBlockingDecisions: number;
        updatedEpoch: number;
      }
    >();
    for (const slice of sliceRuns) {
      const snapshot = {
        status: slice.status ?? null,
        blockingDecisions: Math.max(0, slice.blockingDecisionCount ?? 0),
        nonBlockingDecisions: Math.max(
          0,
          (slice.decisionCount ?? 0) - (slice.blockingDecisionCount ?? 0)
        ),
        updatedEpoch: toEpoch(slice.updatedAt ?? slice.lastEventAt ?? slice.startedAt ?? null),
      };
      const keys = [slice.runId, slice.sliceRunId]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim());
      for (const key of keys) {
        const existing = map.get(key);
        if (!existing || snapshot.updatedEpoch >= existing.updatedEpoch) {
          map.set(key, snapshot);
        }
      }
    }
    if (mapsEqual(prevSliceSnapshotRef.current, map)) {
      return prevSliceSnapshotRef.current;
    }
    prevSliceSnapshotRef.current = map;
    return map;
  }, [sliceRuns]);
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

  const sliceWorkstreamTitleByRunId = useMemo(() => {
    const map = new Map<string, string>();
    for (const slice of sliceRuns) {
      const workstreamId = slice.workstreamId ?? null;
      const label = readableContextLabel(slice.workstreamTitle, workstreamId);
      if (!label) continue;
      const keys = [slice.runId, slice.sliceRunId]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim());
      for (const key of keys) {
        map.set(key, label);
      }
    }
    return map;
  }, [sliceRuns]);

  const initiativeNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const init of initiatives) {
      const label = readableContextLabel(init.name, init.id);
      if (!label) continue;
      map.set(init.id, label);
    }
    return map;
  }, [initiatives]);

  const workstreamNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const init of initiatives) {
      for (const workstream of init.workstreams ?? []) {
        const label = readableContextLabel(workstream.name, workstream.id);
        if (!label) continue;
        map.set(workstream.id, label);
      }
    }
    for (const slice of sliceRuns) {
      const workstreamId = slice.workstreamId ?? null;
      if (!workstreamId || map.has(workstreamId)) continue;
      const label = readableContextLabel(slice.workstreamTitle, workstreamId);
      if (!label) continue;
      map.set(workstreamId, label);
    }
    return map;
  }, [initiatives, sliceRuns]);
  const sessionsByRecency = useMemo(() => {
    const copy = [...sessions];
    copy.sort((left, right) => {
      const leftEpoch = toEpoch(left.updatedAt ?? left.lastEventAt ?? left.startedAt ?? null);
      const rightEpoch = toEpoch(right.updatedAt ?? right.lastEventAt ?? right.startedAt ?? null);
      return rightEpoch - leftEpoch;
    });
    return copy;
  }, [sessions]);

  const decoratedActivity = useMemo(() => {
    return activity.map((item) => {
      const runId = resolveRunId(item);
      const bucket = classifyActivity(item);
      const metadata = metadataForItem(item);
      const sessionSnapshot = runId ? sessionSnapshotByRunId.get(runId) ?? null : null;
      const sliceSnapshot = runId ? sliceSnapshotByRunId.get(runId) ?? null : null;
      const projection = projectRunStatus({
        sessionStatus: sessionSnapshot?.status ?? (runId ? sessionStatusById.get(runId) ?? null : null),
        sessionPhase: sessionSnapshot?.phase ?? null,
        sessionState: sessionSnapshot?.state ?? null,
        sliceStatus: sliceSnapshot?.status ?? null,
        activityType: item.type,
        activityStatus: metadataString(metadata, [
          'status',
          'state',
          'phase',
          'lifecycle_state',
          'lifecycleState',
          'parsed_status',
          'parsedStatus',
          'run_status',
          'runStatus',
        ]),
        stopReason: metadataString(metadata, ['stop_reason', 'stopReason']),
        decisionRequired: item.decisionRequired ?? false,
        blockingDecisionCount:
          metadataCount(metadata, [
            'blocking_decisions',
            'blockingDecisions',
            'blocking_decision_count',
            'blockingDecisionCount',
          ]) ?? sliceSnapshot?.blockingDecisions ?? 0,
        nonBlockingDecisionCount:
          metadataCount(metadata, [
            'non_blocking_decisions',
            'nonBlockingDecisions',
            'decision_count',
            'decisionCount',
            'decisions',
          ]) ?? sliceSnapshot?.nonBlockingDecisions ?? 0,
        blockerCount: sessionSnapshot?.blockerCount ?? 0,
        blockerReason: sessionSnapshot?.blockerReason ?? null,
      });
      const userState = resolveActivityUserState(bucket, projection);
      const searchText = [
        item.title,
        item.description,
        item.summary,
        item.agentName,
        textFromMetadata(metadata),
      ]
        .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        .join(' ')
        .toLowerCase();
      const runLabelSearch = runId
        ? (runLabelById.get(runId) ?? runId).toLowerCase()
        : '';

      const metaScope = metadata?.scope as string | undefined;
      const scopeVal =
        metaScope === 'milestone' || metaScope === 'workstream' ? metaScope : undefined;

      return {
        item,
        bucket,
        userState: userState.state,
        userStateWhy: userState.why,
        canonicalProjection: projection,
        runId,
        timestampEpoch: toEpoch(item.timestamp),
        searchText,
        runLabelSearch,
        scopeGroupId: scopeVal ? (runId ?? null) : null,
        scope: scopeVal,
      } satisfies DecoratedActivityItem;
    });
  }, [activity, runLabelById, sessionSnapshotByRunId, sessionStatusById, sliceSnapshotByRunId]);

  const decoratedByNewest = useMemo(() => {
    const sorted = [...decoratedActivity];
    sorted.sort((a, b) => {
      const delta = b.timestampEpoch - a.timestampEpoch;
      if (delta !== 0) return delta;
      return b.item.id.localeCompare(a.item.id);
    });
    return sorted;
  }, [decoratedActivity]);

  const decoratedByOldest = useMemo(() => [...decoratedByNewest].reverse(), [decoratedByNewest]);

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
        ['live', '24h', '7d', 'all'].includes(option.id)
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
  const filteredSessionProvider = useMemo(() => {
    if (!hasSessionFilter) return resolveProvider();
    if (filteredSession?.runtimeProvider) {
      return { id: runtimeProviderIdFromLogo(filteredSession.runtimeProvider) };
    }
    return resolveProvider(
      filteredSession?.agentId,
      filteredSession?.agentName,
      filteredSession?.title,
      filteredSession?.lastEventSummary,
      filteredSession?.runtimeClient,
      selectedSessionLabel
    );
  }, [filteredSession, hasSessionFilter, selectedSessionLabel]);
  const agentFilterProvider = useMemo(
    () => (agentFilter ? resolveProvider(agentFilter) : resolveProvider()),
    [agentFilter]
  );

  const { filtered, filteredTotal, hiddenCount, hiddenSyncCount } = useMemo(() => {
    const source = sortOrder === 'newest' ? decoratedByNewest : decoratedByOldest;
    const matched: DecoratedActivityItem[] = [];
    let overflow = 0;
    let filteredSyncEvents = 0;
    let skippedBySession = 0;
    let skippedByWorkstream = 0;
    let skippedByAgent = 0;
    const seenSyncReplayKeys = new Set<string>();
    const normalizedQuery = query.trim().toLowerCase();

    for (const decorated of source) {
      const runId = decorated.runId;
      if (hasSessionFilter && (!runId || !selectedRunIdSet.has(runId))) {
        skippedBySession++;
        continue;
      }

      if (selectedWorkstreamId) {
        const fromMetadata = extractWorkstreamId(decorated.item);
        const fromSession = runId ? sessionWorkstreamByRunId.get(runId) ?? null : null;
        const resolvedWorkstreamId = fromMetadata ?? fromSession;
        if (resolvedWorkstreamId !== selectedWorkstreamId) {
          skippedByWorkstream++;
          continue;
        }
      }

      const identity = resolveAgentIdentity(decorated.item);
      if (agentFilter && identity.agentName !== agentFilter) {
        skippedByAgent++;
        continue;
      }

      const syncReplayKey = syncReplayDedupKey(decorated.item);
      if (syncReplayKey) {
        if (seenSyncReplayKeys.has(syncReplayKey)) {
          filteredSyncEvents += 1;
          continue;
        }
        seenSyncReplayKeys.add(syncReplayKey);
        if (!showSyncEvents) {
          filteredSyncEvents += 1;
          continue;
        }
      } else if (!showSyncEvents && isOutboxSyncReplayEvent(decorated.item)) {
        filteredSyncEvents += 1;
        continue;
      }

      if (activeFilter === 'completed' && decorated.userState !== 'completed') continue;
      if (
        activeFilter === 'needs_attention' &&
        decorated.userState !== 'needs_input' &&
        decorated.userState !== 'issue'
      ) {
        continue;
      }
      if (activeFilter === 'in_progress' && decorated.userState !== 'in_progress') continue;

      if (normalizedQuery.length > 0) {
        const haystack = `${decorated.searchText} ${decorated.runLabelSearch}`;
        if (!haystack.includes(normalizedQuery)) continue;
      }

      if (matched.length < MAX_FILTER_POOL) {
        matched.push(decorated);
      } else {
        overflow += 1; // avoid unbounded CPU for huge windows
      }
    }

    if (typeof window !== 'undefined' && /[?&]debug_feed/.test(window.location.search)) {
      // eslint-disable-next-line no-console
      console.log(
        '%c[activity-timeline] FILTER',
        'color:#7dd3c0;font-weight:600',
        {
          inputCount: decoratedActivity.length,
          matchedCount: matched.length,
          skippedBySession,
          skippedByWorkstream,
          skippedByAgent,
          filteredSyncEvents,
          overflow,
          hasSessionFilter,
          selectedRunIds: hasSessionFilter ? Array.from(selectedRunIdSet) : null,
          selectedWorkstreamId: selectedWorkstreamId ?? null,
          agentFilter: agentFilter ?? null,
          activeFilter,
        }
      );
    }
    const targetCount = Math.min(
      Math.max(1, Math.min(MAX_RENDER_COUNT, renderCount)),
      matched.length
    );
    const rendered = matched.slice(0, targetCount);
    const total = matched.length + overflow;

    return {
      filtered: rendered,
      filteredTotal: total,
      hiddenCount: Math.max(0, total - rendered.length),
      hiddenSyncCount: filteredSyncEvents,
    };
  }, [
    activeFilter,
    agentFilter,
    decoratedByNewest,
    decoratedByOldest,
    hasSessionFilter,
    query,
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
        const syncReplayKey = syncReplayDedupKey(decorated.item);
        const clusterKey = syncReplayKey
          ? `${decorated.item.type}::sync::${syncReplayKey}`
          : `${decorated.item.type}::${normalizedClusterTitle}`;
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

  const applyCustomTimeRange = useCallback(() => {
    if (!onCustomTimeRangeChange || !onTimeFilterChange) return;
    if (!customDraftStartAt || !customDraftEndAt) return;
    if (customDraftEndAt.getTime() < customDraftStartAt.getTime()) return;
    onCustomTimeRangeChange({
      startIso: customDraftStartAt.toISOString(),
      endIso: customDraftEndAt.toISOString(),
    });
    onTimeFilterChange('custom');
    setTimeRangeMenuOpen(false);
  }, [
    customDraftEndAt,
    customDraftStartAt,
    onCustomTimeRangeChange,
    onTimeFilterChange,
  ]);

  const clearCustomTimeRange = useCallback(() => {
    setCustomDraftStartAt(null);
    setCustomDraftEndAt(null);
    onCustomTimeRangeChange?.({ startIso: null, endIso: null });
    if (timeFilterId === 'custom') {
      onTimeFilterChange?.('live');
    }
  }, [onCustomTimeRangeChange, onTimeFilterChange, timeFilterId]);

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
    if (!timeRangeMenuOpen) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (timeRangeMenuRef.current?.contains(target)) return;
      setTimeRangeMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setTimeRangeMenuOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [timeRangeMenuOpen]);

  // Prefetch-style infinite scroll: start loading well before the user sees
  // the bottom so new events materialise seamlessly.
  const loadMoreStableRef = useRef(onLoadMore);
  loadMoreStableRef.current = onLoadMore;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const isLoadingMoreRef = useRef(isLoadingMore);
  isLoadingMoreRef.current = isLoadingMore;
  const [sentinelInView, setSentinelInView] = useState(false);
  const pendingAutoExpandRef = useRef<ActivityTimeFilterId | null>(null);
  const lastKnownFilterRef = useRef<ActivityTimeFilterId>(timeFilterId);
  const manualFilterChangedAtRef = useRef<number>(Date.now());
  const userHasScrolledRef = useRef(false);

  useEffect(() => {
    if (lastKnownFilterRef.current === timeFilterId) return;
    lastKnownFilterRef.current = timeFilterId;
    pendingAutoExpandRef.current = null;
    manualFilterChangedAtRef.current = Date.now();
    userHasScrolledRef.current = false;
  }, [timeFilterId]);

  useEffect(() => {
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!root || !target) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries.some((entry) => entry.isIntersecting);
        setSentinelInView(hit);
      },
      // Large rootMargin so we begin fetching ~600px before the user
      // reaches the bottom — by the time they scroll there, items are
      // already in the DOM.
      { root, rootMargin: '0px 0px 600px 0px' }
    );

    observer.observe(target);
    const handleScroll = () => {
      userHasScrolledRef.current = true;
    };
    root.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      observer.disconnect();
      root.removeEventListener('scroll', handleScroll);
    };
    // Intentionally stable deps — hasMore/isLoadingMore/onLoadMore read
    // from refs so the observer doesn't get recreated on every poll cycle.
  }, []);

  useEffect(() => {
    if (!sentinelInView) return;

    if (filtered.length < renderableTotal) {
      setRenderCount((prev) =>
        Math.min(renderableTotal, Math.max(prev, INITIAL_RENDER_COUNT) + RENDER_STEP)
      );
      return;
    }

    if (hasMoreRef.current && !isLoadingMoreRef.current) {
      loadMoreStableRef.current?.();
      return;
    }
  }, [filtered.length, renderableTotal, sentinelInView]);

  useEffect(() => {
    if (!sentinelInView) return;
    if (hasMore || isLoadingMore) return;
    if (!onTimeFilterChange) return;
    // Don't auto-expand unless the user has actively scrolled — prevents
    // the sentinel from firing on mount when the list is short (e.g.
    // "Last hour" with few items) and silently overriding the chosen filter.
    const root = scrollRef.current;
    const listNotScrollable = root ? root.scrollHeight <= root.clientHeight + 4 : false;
    if (!userHasScrolledRef.current && !listNotScrollable) return;
    // Cooldown: don't auto-expand within 3s of a manual filter change to
    // avoid overriding the user's explicit selection.
    const msSinceManualChange = Date.now() - manualFilterChangedAtRef.current;
    if (msSinceManualChange < 3_000) return;
    const nextFilter = nextActivityTimeFilter(timeFilterId);
    if (!nextFilter) return;
    if (pendingAutoExpandRef.current === nextFilter) return;
    pendingAutoExpandRef.current = nextFilter;
    onTimeFilterChange(nextFilter);
  }, [filtered.length, hasMore, isLoadingMore, onTimeFilterChange, sentinelInView, timeFilterId]);

  const activeIndex = useMemo(() => {
    if (!activeItemId) return -1;
    return filtered.findIndex((decorated) => decorated.item.id === activeItemId);
  }, [activeItemId, filtered]);

  const activeDecorated = activeIndex >= 0 ? filtered[activeIndex] : null;
  const narrativeBySliceRunId = useMemo(() => {
    const map = new Map<string, SliceTimelineNarrativeProjectionV2>();
    for (const narrative of timelineNarrative) {
      const id = narrative?.sliceRunId?.trim();
      if (!id || map.has(id)) continue;
      map.set(id, narrative);
    }
    return map;
  }, [timelineNarrative]);
  const activeNarrative = useMemo(() => {
    if (!activeDecorated) return null;
    const runId = activeDecorated.runId ?? resolveRunId(activeDecorated.item);
    if (!runId) return null;
    return narrativeBySliceRunId.get(runId) ?? null;
  }, [activeDecorated, narrativeBySliceRunId]);
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
  const activePrimaryActor = useMemo(
    () => (activeActorFlow ? activeActorFlow.executor ?? activeActorFlow.requester : null),
    [activeActorFlow]
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
  const activeAutopilotRequesterDisplay = useMemo(
    () => normalizeRequesterDisplay(activeAutopilotRequesterLabel),
    [activeAutopilotRequesterLabel]
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
            : null,
          activeDecorated.canonicalProjection ?? null
        )
      : null,
    [activeAutopilotContext, activeDecorated, activeExecutionBreakdown]
  );
  const activeResultItems = useMemo(() => {
    if (!activeExecutionBreakdown) return [];
    const resultItems: Array<{ label: string; value: number | string; tone?: 'neutral' | 'critical' }> = [];
    if (activeOutcome) {
      resultItems.push({ label: 'Status', value: activeOutcome.label });
    }
    if (activeExecutionBreakdown.scopedTaskCount > 0) {
      resultItems.push({ label: 'Tasks', value: activeExecutionBreakdown.scopedTaskCount });
    }
    if (activeExecutionBreakdown.scopedMilestoneCount > 0) {
      resultItems.push({ label: 'Milestones', value: activeExecutionBreakdown.scopedMilestoneCount });
    }
    const artifactCount = activeExecutionBreakdown.artifacts ?? 0;
    if (artifactCount > 0) {
      resultItems.push({ label: 'Artifacts', value: artifactCount });
    }
    const decisionCount = activeExecutionBreakdown.decisions ?? 0;
    if (decisionCount > 0) {
      resultItems.push({ label: 'Decisions', value: decisionCount });
    }
    if (activeExecutionBreakdown.blockingDecisions && activeExecutionBreakdown.blockingDecisions > 0) {
      resultItems.push({
        label: 'Blocking',
        value: activeExecutionBreakdown.blockingDecisions,
        tone: 'critical',
      });
    }
    if (activeExecutionBreakdown.stopReason) {
      resultItems.push({ label: 'Stop reason', value: humanizeStopReason(activeExecutionBreakdown.stopReason) ?? humanizeText(activeExecutionBreakdown.stopReason) });
    }
    const tokenLabel = formatTokens(
      activeExecutionBreakdown.tokensUsed,
      activeExecutionBreakdown.tokenBudget,
    );
    if (tokenLabel) {
      resultItems.push({ label: 'Token usage', value: tokenLabel });
    }
    return resultItems;
  }, [activeExecutionBreakdown, activeOutcome]);
  const activeDecisionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of extractActivityDecisionIds(activeDecorated?.item ?? null)) {
      ids.add(id);
    }
    for (const id of activeAutopilotContext?.decisionIds ?? []) {
      ids.add(id);
    }
    for (const id of activeAutopilotContext?.blockingDecisionIds ?? []) {
      ids.add(id);
    }
    for (const id of activeAutopilotContext?.nonBlockingDecisionIds ?? []) {
      ids.add(id);
    }
    return Array.from(ids);
  }, [activeAutopilotContext, activeDecorated]);
  const canOpenDecisionFromDetail = useMemo(() => {
    if (!onOpenDecision) return false;
    if (activeDecisionIds.length > 0) return true;
    if (activeDecorated?.item.decisionRequired === true) return true;
    if ((activeExecutionBreakdown?.blockingDecisions ?? 0) > 0) return true;
    return activeOutcome?.label === 'Needs decision';
  }, [
    activeDecisionIds,
    activeDecorated,
    activeExecutionBreakdown,
    activeOutcome,
    onOpenDecision,
  ]);
  const activeAutopilotProgressColor = useMemo(() => {
    if (!activeAutopilotProgress) return colors.teal;
    if (activeAutopilotProgress.tone === 'positive') return colors.lime;
    if (activeAutopilotProgress.tone === 'warning') return colors.amber;
    if (activeAutopilotProgress.tone === 'critical') return colors.red;
    return colors.teal;
  }, [activeAutopilotProgress]);
  const activeAutopilotProgressIsTerminalStop = activeAutopilotProgress?.terminalStop === true;
  const activeProvenance = useMemo(
    () => extractProvenance(metadataForItem(activeDecorated?.item ?? null)),
    [activeDecorated]
  );
  const activeMetadata = useMemo(
    () => metadataForItem(activeDecorated?.item ?? null),
    [activeDecorated]
  );
  const activeSpawnGuard = useMemo(
    () => extractSpawnGuardSnapshot(activeDecorated?.item ?? null, activeAutopilotContext),
    [activeAutopilotContext, activeDecorated]
  );
  const activeSpawnGuardRetryLabel = useMemo(() => {
    if (!activeSpawnGuard?.retryAt) return null;
    const retryDate = new Date(activeSpawnGuard.retryAt);
    if (!Number.isFinite(retryDate.getTime())) return null;
    const absolute = retryDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const relative = formatRelativeTime(activeSpawnGuard.retryAt);
    return relative ? `${absolute} (${relative})` : absolute;
  }, [activeSpawnGuard]);
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
  const activeFileEvidenceUnique = useMemo(
    () =>
      activeFileEvidence.filter(
        (entry, index, all) => all.findIndex((candidate) => candidate.path === entry.path) === index
      ),
    [activeFileEvidence]
  );
  const activeFileEvidencePreview = useMemo(
    () => activeFileEvidenceUnique.slice(0, 4),
    [activeFileEvidenceUnique]
  );
  const activeFileEvidenceOverflow = useMemo(
    () => activeFileEvidenceUnique.slice(4),
    [activeFileEvidenceUnique]
  );
  const primaryEvidenceHref = useMemo(() => {
    if (activeFileEvidenceUnique.length === 0) return null;
    const first = activeFileEvidenceUnique[0];
    return first ? resolveFileEvidenceHref(first.path) : null;
  }, [activeFileEvidenceUnique]);
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
  const activeAutoFixTarget = useMemo(() => {
    if (!activeAutopilotContext || !activeDecorated) return null;

    const initiativeId =
      activeAutopilotContext.initiativeId ??
      activeDecorated.item.initiativeId ??
      null;
    const workstreamId =
      activeAutopilotContext.workstreamId ?? extractWorkstreamId(activeDecorated.item);
    if (!initiativeId || !workstreamId) return null;

    const parsedStatus = normalizeStatusKey(
      activeExecutionBreakdown?.parsedStatus ?? activeAutopilotContext.parsedStatus
    );
    const stopReason = normalizeStatusKey(
      activeExecutionBreakdown?.stopReason ?? activeAutopilotContext.stopReason
    );
    const blockingDecisions = Math.max(
      0,
      activeExecutionBreakdown?.blockingDecisions ??
        activeAutopilotContext.blockingDecisions ??
        (activeDecorated.item.decisionRequired ? 1 : 0)
    );
    const nonBlockingDecisions = Math.max(
      0,
      activeExecutionBreakdown?.nonBlockingDecisions ??
        activeAutopilotContext.nonBlockingDecisions ??
        0
    );
    const blockedLike =
      parsedStatus === "blocked" ||
      parsedStatus === "error" ||
      parsedStatus === "failed" ||
      stopReason === "blocked" ||
      stopReason === "error" ||
      activeDecorated.item.type === "blocker_created";
    const optionalDecisionLike =
      !blockedLike &&
      blockingDecisions === 0 &&
      nonBlockingDecisions > 0 &&
      (parsedStatus === "needs_decision" ||
        parsedStatus === "completed" ||
        stopReason === "completed");

    if (!blockedLike && !optionalDecisionLike) return null;

    return {
      initiativeId,
      workstreamId,
      runId: activeDecorated.runId ?? null,
      event: activeAutopilotContext.event,
      requestedByAgentId:
        activeAutopilotContext.requesterAgentId ?? activeDecorated.item.requesterAgentId ?? null,
      requestedByAgentName:
        activeAutopilotContext.requesterAgentName ?? activeDecorated.item.requesterAgentName ?? null,
      actionLabel: blockedLike ? "Auto-fix in 10s" : "Auto-continue in 10s",
      helperText: blockedLike
        ? "Pause this workstream within 10 seconds to cancel the auto-fix."
        : "Optional decision captured. Slice will continue automatically after the grace window.",
      isBlockedFlow: blockedLike,
    };
  }, [activeAutopilotContext, activeDecorated, activeExecutionBreakdown]);

  const closeDetail = useCallback(() => {
    setActiveItemId(null);
  }, []);

  const runEmptyAction = useCallback(
    async (
      action: 'play' | 'autopilot' | 'pause',
      handler: (() => Promise<void> | void) | undefined
    ) => {
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
  const runAutoFixAction = useCallback(async () => {
    if (!activeAutoFixTarget || autoFixPending) return;

    setAutoFixPending(true);
    setAutoFixNotice(null);
    try {
      const response = await fetch("/orgx/api/mission-control/activity/auto-fix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initiativeId: activeAutoFixTarget.initiativeId,
          workstreamId: activeAutoFixTarget.workstreamId,
          runId: activeAutoFixTarget.runId,
          event: activeAutoFixTarget.event,
          requestedByAgentId: activeAutoFixTarget.requestedByAgentId,
          requestedByAgentName: activeAutoFixTarget.requestedByAgentName,
          graceMs: 10_000,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; scheduled?: { dueAt?: string } }
        | null;
      if (!response.ok || body?.ok !== true) {
        throw new Error(body?.error || `Request failed (${response.status})`);
      }

      const dueAt = body?.scheduled?.dueAt ? new Date(body.scheduled.dueAt) : null;
      const dueLabel =
        dueAt && Number.isFinite(dueAt.getTime())
          ? dueAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
          : null;
      setAutoFixNotice(
        dueLabel
          ? `Scheduled. Auto action starts by ${dueLabel} unless you pause first.`
          : "Scheduled. Auto action starts in 10s unless you pause first."
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to schedule auto-fix";
      setAutoFixNotice(humanizeWarning(message) || message);
    } finally {
      setAutoFixPending(false);
    }
  }, [activeAutoFixTarget, autoFixPending]);

  useEffect(() => {
    if (!copyNotice) return undefined;
    const timer = window.setTimeout(() => setCopyNotice(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copyNotice]);

  useEffect(() => {
    setEmptyActionError(null);
  }, [activeFilter, query, timeFilterId]);

  useEffect(() => {
    if (!requestedActivityItemId) {
      handledRequestedItemIdRef.current = null;
      return;
    }

    const requestedId = requestedActivityItemId.trim();
    if (!requestedId || handledRequestedItemIdRef.current === requestedId) {
      return;
    }

    const exists = activity.some((item) => item.id === requestedId);
    if (!exists) return;

    handledRequestedItemIdRef.current = requestedId;
    setCollapsed(false);
    setActiveFilter('all');
    setQuery('');
    setDetailDirection(1);
    setActiveItemId(requestedId);
    onActivityItemRequestHandled?.(requestedId);
  }, [activity, onActivityItemRequestHandled, requestedActivityItemId]);

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
    setAutoFixPending(false);
    setAutoFixNotice(null);
  }, [activeItemId]);

  useEffect(() => {
    setDetailSummaryOverride(null);
    setDetailSummarySource('feed');

    const reference = getLocalTurnReference(activeDecorated?.item ?? null);
    if (!reference) return;
    if (isDemoModeEnabled()) return;

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
    if (isDemoModeEnabled()) return;

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
    const items: LiveActivityItem[] = [];
    const seenSyncReplayKeys = new Set<string>();
    for (const decorated of decoratedActivity) {
      if (!decorated.runId || !selectedRunIdSet.has(decorated.runId)) continue;

      const syncReplayKey = syncReplayDedupKey(decorated.item);
      if (syncReplayKey) {
        if (seenSyncReplayKeys.has(syncReplayKey)) continue;
        seenSyncReplayKeys.add(syncReplayKey);
        if (!showSyncEvents) continue;
      } else if (!showSyncEvents && isOutboxSyncReplayEvent(decorated.item)) {
        continue;
      }

      items.push(decorated.item);
    }
    return items;
  }, [isSingleSession, decoratedActivity, selectedRunIdSet, showSyncEvents]);

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
    const primaryActor = actorFlow.executor ?? actorFlow.requester;
    const displayAgentName =
      formatAgentLabel(
        sanitizeActorDisplayValue(primaryActor?.name ?? actorFlow.primaryLabel ?? item.agentName ?? identity.agentName ?? null),
        sanitizeActorDisplayValue(primaryActor?.id ?? item.agentId ?? identity.agentId ?? null),
        agentNameById
      ) || 'OrgX';
    const railColor = userStateColor(decorated.userState);
    const isRecent = sortOrder === 'newest' && index < 2;
    const runId = decorated.runId;
    const syncSummary = syncReplaySummary(item);
    const { title: displayTitle } = cleanSystemTitle(item);
    const displaySummary = syncSummary ?? humanizeActivityBody(item.summary);
    const displayDesc = humanizeActivityBody(item.description);
    const headline = summarizeDetailHeadline(item, displaySummary ?? displayDesc ?? null);
    const metadata = metadataForItem(item);
    const initiativeName = firstReadableContextLabel([
      {
        value: metadataString(metadata, ['initiative_title', 'initiativeTitle']),
        idHint: item.initiativeId,
      },
      {
        value: item.initiativeId ? initiativeNameById.get(item.initiativeId) ?? null : null,
        idHint: item.initiativeId,
      },
    ]);
    const workstreamId =
      extractWorkstreamId(item) ?? (runId ? sessionWorkstreamByRunId.get(runId) ?? null : null);
    const workstreamName = firstReadableContextLabel([
      {
        value: metadataString(metadata, ['workstream_title', 'workstreamTitle']),
        idHint: workstreamId,
      },
      {
        value: workstreamId ? workstreamNameById.get(workstreamId) ?? null : null,
        idHint: workstreamId,
      },
      {
        value: runId ? sliceWorkstreamTitleByRunId.get(runId) ?? null : null,
        idHint: workstreamId,
      },
    ]);
    const breadcrumb = [initiativeName, workstreamName].filter(Boolean).join(' > ');
    const contextLabel = breadcrumb || initiativeName || workstreamName || humanizeText(item.type);
    const primaryTag = userStateLabel(decorated.userState);
    const timeLabel = new Date(item.timestamp).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
    const relativeTime = formatRelativeTime(item.timestamp);
    const artifactSnippet = decorated.bucket === 'artifact' ? extractArtifactSnippet(item) : null;

    return (
      <ActivityTimelineItem
        key={renderKey}
        renderKey={renderKey}
        displayTitle={displayTitle}
        headline={headline}
        contextLabel={contextLabel}
        detailText={(displaySummary ?? displayDesc) !== headline ? displaySummary ?? displayDesc : null}
        displayAgentName={displayAgentName}
        railColor={railColor}
        userStateLabel={primaryTag}
        userStateWhy={decorated.userStateWhy}
        relativeTime={relativeTime}
        timeLabel={timeLabel}
        isRecent={isRecent}
        enableMotion={enableItemMotion}
        onOpen={() => {
          setDetailDirection(1);
          setActiveItemId(item.id);
        }}
        ariaLabel={`Open activity details for ${displayTitle || labelForType(item.type)}`}
        artifactSnippet={artifactSnippet}
      />
    );
  };

  return (
    <ChatDockProvider
      sessions={sessions}
      initiatives={initiatives ?? []}
      workspaceId={workspaceId ?? null}
      query={query}
      statusFilter={activeFilter as 'all' | 'completed' | 'needs_attention' | 'in_progress'}
      sortOrder={sortOrder as 'newest' | 'oldest'}
      timeFilterId={timeFilterId}
      customTimeRange={customTimeRange}
      snapshot={chatSnapshot}
      onRequestRefresh={onRefreshData}
    >
    <div className="flex h-full min-h-0 flex-col">
      {/* Thread view for single-session selection */}
      {isSingleSession && singleSessionItems.length > 0 ? (
        <ThreadView
          items={singleSessionItems}
          session={singleSession}
          agentName={singleSessionItems[0]?.agentName ?? null}
          onBack={onClearSelection}
          onOpenItem={(item) => {
            setDetailDirection(1);
            setActiveItemId(item.id);
          }}
        />
      ) : (
        <>
          <div className="border-b border-subtle px-4 py-3">
            <div className="flex flex-col gap-2">
              {/* Row 1: Title + badges + search */}
              <div className="flex items-center gap-2">
                <h2 className="flex-shrink-0 text-heading font-semibold text-white">Activity</h2>
                <span className="flex-shrink-0 rounded-full border border-strong bg-white/[0.05] px-2 py-0.5 text-micro text-primary tabular-nums">
                  {filteredTotal}
                </span>
                {hiddenCount > 0 && (
                  <span className="hidden flex-shrink-0 rounded-full border border-strong bg-white/[0.03] px-2 py-0.5 text-micro text-secondary tabular-nums sm:inline-flex">
                    +{hiddenCount} hidden
                  </span>
                )}
                {hiddenSyncCount > 0 && !showSyncEvents && (
                  <button
                    type="button"
                    onClick={() => setShowSyncEvents(true)}
                    className="hidden flex-shrink-0 rounded-full border border-white/[0.14] bg-white/[0.03] px-2 py-0.5 text-micro text-secondary tabular-nums transition-colors hover:bg-white/[0.08] hover:text-primary sm:inline-flex"
                    title="Show low-signal sync replay events"
                  >
                    {hiddenSyncCount} sync hidden
                  </button>
                )}
                {showSyncEvents && (
                  <button
                    type="button"
                    onClick={() => setShowSyncEvents(false)}
                    className="hidden flex-shrink-0 rounded-full border border-lime/30 bg-lime/[0.10] px-2 py-0.5 text-micro text-[#E1FFB2] transition-colors hover:bg-lime/[0.16] sm:inline-flex"
                    title="Hide low-signal sync replay events"
                  >
                    Sync visible
                  </button>
                )}
                <span
                  className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', isLive && 'pulse-soft')}
                  style={{ backgroundColor: colors.lime }}
                  aria-label="Live"
                  title={isLive ? 'New activity within the last minute' : 'Live activity feed'}
                />
                <div className="ml-auto w-[180px] flex-shrink-0 sm:w-[220px]">
                  <div className="relative">
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
                    >
                      <circle cx="11" cy="11" r="7" />
                      <path d="m20 20-3.5-3.5" />
                    </svg>
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search..."
                      className="h-7 w-full rounded-full border border-white/[0.08] bg-white/[0.03] pl-7 pr-2 text-micro text-primary placeholder:text-muted transition-colors focus:border-[#BFFF00]/30 focus:outline-none"
                      aria-label="Search activity"
                    />
                  </div>
                </div>
              </div>

              {/* Row 2: Status tabs + time range + density + filters */}
              <div className="flex flex-wrap items-center gap-1.5">
                <div className="relative" ref={timeRangeMenuRef}>
                  <button
                    type="button"
                    onClick={() => {
                      setTimeRangeMenuOpen((previous) => !previous);
                      setViewMenuOpen(false);
                    }}
                    aria-haspopup="menu"
                    aria-expanded={timeRangeMenuOpen}
                    className={cn(
                      'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-micro font-semibold transition-colors',
                      timeRangeMenuOpen
                        ? 'border-lime/30 bg-lime/[0.10] text-[#E1FFB2]'
                        : 'border-white/[0.14] bg-white/[0.03] text-secondary hover:bg-white/[0.08] hover:text-primary'
                    )}
                  >
                    <span className="max-w-[120px] truncate">{selectedTimeLabel}</span>
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      className={cn('transition-transform duration-200', timeRangeMenuOpen && 'rotate-180')}
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>

                    <AnimatePresence>
                      {timeRangeMenuOpen && (
                        <motion.div
                          initial={{ opacity: 0, y: -6, scale: 0.98 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -4, scale: 0.98 }}
                          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                          className="absolute left-0 z-30 mt-2 w-[min(92vw,380px)] rounded-xl border border-white/[0.12] bg-[#0A0D14]/95 p-3 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl"
                          role="menu"
                          aria-label="Activity time range"
                        >
                          <div className="space-y-3">
                            <div>
                              <p className="mb-1 text-micro font-semibold uppercase tracking-[0.08em] text-muted">
                                Presets
                              </p>
                              <div className="flex flex-wrap gap-1">
                                {ACTIVITY_TIME_FILTERS.filter((option) => option.id !== 'custom').map((option) => {
                                  const active = timeFilterId === option.id;
                                  return (
                                    <button
                                      key={option.id}
                                      type="button"
                                      onClick={() => {
                                        onTimeFilterChange?.(option.id);
                                        setTimeRangeMenuOpen(false);
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

                            <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-2.5">
                              <p className="mb-2 text-micro font-semibold uppercase tracking-[0.08em] text-muted">
                                Custom range
                              </p>
                              <div className="space-y-2">
                                <label className="block text-micro uppercase tracking-[0.06em] text-secondary">
                                  Start
                                </label>
                                {isMobileDatePickerViewport ? (
                                  <input
                                    type="datetime-local"
                                    step={300}
                                    value={toDateTimeLocalValue(customDraftStartAt)}
                                    onChange={(event) =>
                                      setCustomDraftStartAt(
                                        parseDateTimeLocalValue(event.target.value)
                                      )
                                    }
                                    className="orgx-datepicker-input w-full rounded-lg border border-white/[0.12] bg-black/30 px-2.5 py-1.5 text-caption text-primary outline-none transition-colors focus:border-lime/35"
                                  />
                                ) : (
                                  <DatePicker
                                    selected={customDraftStartAt}
                                    onChange={(date) =>
                                      setCustomDraftStartAt(date instanceof Date ? date : null)
                                    }
                                    selectsStart
                                    startDate={customDraftStartAt}
                                    endDate={customDraftEndAt}
                                    showTimeSelect
                                    timeIntervals={5}
                                    dateFormat="MMM d, yyyy h:mm aa"
                                    className="orgx-datepicker-input w-full rounded-lg border border-white/[0.12] bg-black/30 px-2.5 py-1.5 text-caption text-primary outline-none transition-colors focus:border-lime/35"
                                    calendarClassName="orgx-datepicker"
                                    popperClassName="orgx-datepicker-popper"
                                    popperPlacement="bottom-start"
                                    showPopperArrow={false}
                                  />
                                )}

                                <label className="block text-micro uppercase tracking-[0.06em] text-secondary">
                                  End
                                </label>
                                {isMobileDatePickerViewport ? (
                                  <input
                                    type="datetime-local"
                                    step={300}
                                    min={toDateTimeLocalValue(customDraftStartAt)}
                                    value={toDateTimeLocalValue(customDraftEndAt)}
                                    onChange={(event) =>
                                      setCustomDraftEndAt(parseDateTimeLocalValue(event.target.value))
                                    }
                                    className="orgx-datepicker-input w-full rounded-lg border border-white/[0.12] bg-black/30 px-2.5 py-1.5 text-caption text-primary outline-none transition-colors focus:border-lime/35"
                                  />
                                ) : (
                                  <DatePicker
                                    selected={customDraftEndAt}
                                    onChange={(date) =>
                                      setCustomDraftEndAt(date instanceof Date ? date : null)
                                    }
                                    selectsEnd
                                    minDate={customDraftStartAt ?? undefined}
                                    startDate={customDraftStartAt}
                                    endDate={customDraftEndAt}
                                    showTimeSelect
                                    timeIntervals={5}
                                    dateFormat="MMM d, yyyy h:mm aa"
                                    className="orgx-datepicker-input w-full rounded-lg border border-white/[0.12] bg-black/30 px-2.5 py-1.5 text-caption text-primary outline-none transition-colors focus:border-lime/35"
                                    calendarClassName="orgx-datepicker"
                                    popperClassName="orgx-datepicker-popper"
                                    popperPlacement="bottom-start"
                                    showPopperArrow={false}
                                  />
                                )}
                              </div>
                              <div className="mt-2 flex items-center justify-between gap-2">
                                <p className="text-micro text-secondary">
                                  {customRangeValid
                                    ? `${formatRangeLabel(customDraftStartAt)} - ${formatRangeLabel(customDraftEndAt)}`
                                    : 'Pick start and end to apply'}
                                </p>
                                <div className="flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={clearCustomTimeRange}
                                    className="rounded-full border border-white/[0.14] bg-white/[0.03] px-2.5 py-1 text-micro font-semibold text-secondary transition-colors hover:bg-white/[0.06] hover:text-primary"
                                  >
                                    Clear
                                  </button>
                                  <button
                                    type="button"
                                    onClick={applyCustomTimeRange}
                                    disabled={!customRangeValid}
                                    className="rounded-full border border-lime/30 bg-lime/[0.14] px-2.5 py-1 text-micro font-semibold text-[#E1FFB2] transition-colors hover:bg-lime/[0.2] disabled:opacity-45"
                                  >
                                    Apply
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                </div>

                <div className="mx-0.5 h-3.5 w-px flex-shrink-0 bg-white/[0.08]" />
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  {(hasSessionFilter || selectedWorkstreamId || agentFilter) && (
                    <>
                      {hasSessionFilter && (
                        <button
                          onClick={onClearSelection}
                          className="chip chip-avatar inline-flex min-w-0 items-center"
                          aria-label="Clear session filter"
                        >
                          {shouldUseProviderLogo(filteredSessionProvider.id) ? (
                            <ProviderLogo provider={filteredSessionProvider.id} size="xs" />
                          ) : (
                            <AgentAvatar
                              name={filteredSession?.agentName ?? 'OrgX'}
                              hint={selectedSessionLabel ?? null}
                              size="xs"
                            />
                          )}
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
                          className="chip chip-avatar inline-flex min-w-0 items-center"
                          style={{ borderColor: 'rgba(10,212,196,0.3)', color: '#0AD4C4' }}
                          aria-label="Clear agent filter"
                        >
                          {shouldUseProviderLogo(agentFilterProvider.id) ? (
                            <ProviderLogo provider={agentFilterProvider.id} size="xs" />
                          ) : (
                            <AgentAvatar name={agentFilter} hint={agentFilter} size="xs" />
                          )}
                          <span className="min-w-0 truncate">Agent: {agentFilter}</span>
                          <span className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-strong bg-white/[0.04] text-micro text-secondary">
                            ×
                          </span>
                        </button>
                      )}
                    </>
                  )}

                  <div
                    className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.02] p-0.5"
                    role="group"
                    aria-label="Activity status filters"
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
                      'inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border bg-white/[0.03] text-muted transition-colors hover:bg-white/[0.08] hover:text-primary',
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

                  <div className="relative flex-shrink-0" ref={controlsMenuRef}>
                    <button
                      type="button"
                      onClick={() => {
                        setViewMenuOpen((prev) => !prev);
                        setTimeRangeMenuOpen(false);
                      }}
                      aria-haspopup="menu"
                      aria-expanded={viewMenuOpen}
                      aria-label="Activity filters"
                      title="Activity filters"
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

                            <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-2">
                              <p className="text-micro font-semibold uppercase tracking-[0.08em] text-muted">
                                Time window
                              </p>
                              <p className="mt-1 text-caption text-secondary">
                                Use the time dropdown beside Activity count for presets and custom date/time ranges.
                              </p>
                            </div>

                            <div>
                              <p className="mb-1 text-micro font-semibold uppercase tracking-[0.08em] text-muted">
                                Status
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
                                {showSyncEvents ? 'Hide background sync events' : 'Show background sync events'}
                              </button>
                              <p className="mt-1 text-micro leading-relaxed text-muted">
                                Background sync events are routine system operations that most users can safely ignore.
                              </p>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

              </div>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-y-contain scroll-smooth px-4 py-3 pb-24">
            {filtered.length === 0 && (
              <div className="rounded-xl border border-subtle bg-white/[0.02] px-4 py-5">
                <div className="mx-auto max-w-2xl">
                  <EmptyState
                    icon="activity"
                    headline={
                      isLoading
                        ? 'Syncing activity feed...'
                        : hasSessionFilter
                          ? 'No activity yet for this session'
                          : selectedWorkstreamId
                            ? 'No activity yet for this workstream'
                            : 'No matching activity right now.'
                    }
                    description={
                      isLoading
                        ? 'Live updates usually appear within a few seconds after dispatch.'
                        : `Try widening the time window (${selectedTimeLabel}), changing filters, or launch the next workstream.`
                    }
                    className="py-6"
                  />

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
                        {emptyActionPending === 'play' ? 'Starting...' : 'Start next session'}
                      </button>
                    )}
                    {!onPlayNextUp && onOpenMissionControl && (
                      <button
                        type="button"
                        onClick={onOpenMissionControl}
                        className="rounded-full border border-[#BFFF00]/28 bg-[#BFFF00]/12 px-3 py-1.5 text-caption font-semibold text-[#D8FFA1] transition hover:bg-[#BFFF00]/18"
                      >
                        Browse initiatives
                      </button>
                    )}
                  </div>

                  {emptyActionError && (
                    <p className="mt-2 text-caption text-amber-200/80">{emptyActionError}</p>
                  )}
                </div>
              </div>
            )}

        <WhileYouWereAway
          completedCount={awaySummary.completed}
          decisionsCount={awaySummary.decisions}
          blockerCount={awaySummary.blocked}
          visible={awayVisible}
          onDismiss={() => {
            setAwayVisible(false);
            lastInteractionRef.current = Date.now();
          }}
        />

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
	                                <span>{isExpanded ? 'hide' : `and ${cluster.count - 1} similar`}</span>
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
	                              <span>{isExpanded ? 'hide' : `and ${cluster.count - 1} similar`}</span>
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

            {/* Infinite-scroll sentinel — positioned well above the visual
                bottom so the IntersectionObserver fires early (600px margin). */}
            <div ref={sentinelRef} className="pointer-events-none h-px" aria-hidden />

            {/* Minimal loading affordance — fades in/out without layout shift. */}
            <div
              className={cn(
                'flex items-center justify-center py-6 transition-opacity duration-500 ease-out',
                isLoadingMore ? 'opacity-100' : hasMore ? 'opacity-0' : 'opacity-0 pointer-events-none'
              )}
            >
              <div className="flex items-center gap-2.5">
                <div className="flex gap-1" aria-label="Loading older events">
                  <span className="h-1 w-1 rounded-full bg-[#BFFF00]/70 animate-[pulse_1.4s_ease-in-out_infinite]" />
                  <span className="h-1 w-1 rounded-full bg-[#BFFF00]/50 animate-[pulse_1.4s_ease-in-out_0.2s_infinite]" />
                  <span className="h-1 w-1 rounded-full bg-[#BFFF00]/30 animate-[pulse_1.4s_ease-in-out_0.4s_infinite]" />
                </div>
              </div>
            </div>

            {!hasMore &&
              !isLoadingMore &&
              filtered.length > 0 &&
              !nextActivityTimeFilter(timeFilterId) && (
              <p className="pb-4 text-center text-micro tracking-wide text-muted/50">
                {hiddenCount > 0
                  ? `${filtered.length} of ${filteredTotal} events`
                  : 'You\u2019ve reached the beginning'}
              </p>
            )}
          </div>
        )}
          </div>
        </>
      )}

      {devMode ? <ActivityChatDock /> : null}

      <ActivityDetailModal open={activeDecorated !== null} onClose={closeDetail}>
        {activeDecorated && (
          <div className="relative flex h-[100dvh] w-full min-h-0 flex-col sm:h-[86vh] sm:max-h-[86vh]">
            <div className="absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-lime/10 via-cyan/5 to-transparent" />

            <div className="relative z-10 flex items-center justify-between border-b border-subtle px-5 py-3 sm:px-6">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                  style={{
                    backgroundColor: userStateColor(activeDecorated.userState),
                    boxShadow: `0 0 12px ${userStateColor(activeDecorated.userState)}55`,
                  }}
                />
                <span className="text-caption text-secondary">
                  {userStateLabel(activeDecorated.userState)} · {activeIndex + 1}/{filtered.length} sessions
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
                  <div className="space-y-6 pb-1">
                    {/* Header group — title, timestamp, breadcrumbs */}
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

                    <div className="mt-3 flex flex-wrap items-center gap-2 text-caption">
                      {(() => {
                        const metadata = metadataForItem(activeDecorated.item);
                        const workstreamId =
                          activeAutopilotContext?.workstreamId ??
                          extractWorkstreamId(activeDecorated.item) ??
                          (activeDecorated.runId ? sessionWorkstreamByRunId.get(activeDecorated.runId) ?? null : null);
                        const workstreamName = firstReadableContextLabel([
                          { value: activeAutopilotContext?.workstreamTitle ?? null, idHint: workstreamId },
                          {
                            value: metadataString(metadata, ['workstream_title', 'workstreamTitle']),
                            idHint: workstreamId,
                          },
                          {
                            value: workstreamId ? workstreamNameById.get(workstreamId) ?? null : null,
                            idHint: workstreamId,
                          },
                          {
                            value: activeDecorated.runId ? sliceWorkstreamTitleByRunId.get(activeDecorated.runId) ?? null : null,
                            idHint: workstreamId,
                          },
                        ]);
                        const initiativeTitle = firstReadableContextLabel([
                          {
                            value: activeAutopilotContext?.initiativeTitle ?? null,
                            idHint: activeDecorated.item.initiativeId,
                          },
                          {
                            value: metadataString(metadata, ['initiative_title', 'initiativeTitle']),
                            idHint: activeDecorated.item.initiativeId,
                          },
                          {
                            value: activeDecorated.item.initiativeId
                              ? initiativeNameById.get(activeDecorated.item.initiativeId) ?? null
                              : null,
                            idHint: activeDecorated.item.initiativeId,
                          },
                        ]);
                        const breadcrumb = [initiativeTitle, workstreamName].filter(Boolean).join(' > ');
                        if (!breadcrumb) return null;
                        return (
                          <Pill tone="muted" className="max-w-full">
                            <span className="truncate">{breadcrumb}</span>
                          </Pill>
                        );
                      })()}
                      <Pill tone="neutral" className="font-semibold tracking-[0.02em]">
                        {userStateLabel(activeDecorated.userState)}
                      </Pill>
                      <Pill tone="muted">
                        <AgentAvatar
                          name={activePrimaryActor?.label ?? activeActorFlow?.primaryLabel ?? 'OrgX'}
                          hint={activePrimaryActor ? actorAvatarHint(activePrimaryActor) : activeActorFlow?.primaryLabel ?? 'OrgX'}
                          size="xs"
                        />
                        <span>{activePrimaryActor?.label ?? activeActorFlow?.primaryLabel ?? 'OrgX'}</span>
                      </Pill>
                      {activeIsSyncReplay && <Pill tone="lime">Sync replay</Pill>}
                    </div>
                    </div>

                    {/* Activity summary card */}
                    <ActivityDetailSummary item={activeDecorated.item} />

                    {/* Artifact hero — promoted from bottom */}
                    {activeArtifact && (
                      <div className="rounded-xl border border-cyan-400/25 bg-gradient-to-b from-cyan-500/[0.10] to-cyan-500/[0.04]">
                        <div className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-2">
                          <div className="flex items-center gap-2">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#67e8f9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                              <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                              <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                            </svg>
                            <span className="text-micro font-semibold uppercase tracking-wider text-cyan-200/80">
                              {activeArtifact.source === 'metadata' ? 'Artifact' : humanizeText(activeArtifact.source)}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="inline-flex rounded-full border border-cyan-400/20 bg-black/30 p-0.5 text-caption">
                              <button
                                type="button"
                                onClick={() => setArtifactViewMode('structured')}
                                aria-pressed={artifactViewMode === 'structured'}
                                className={`rounded-full px-2.5 py-0.5 transition-colors ${
                                  artifactViewMode === 'structured'
                                    ? 'bg-cyan-500/[0.25] text-cyan-100'
                                    : 'text-cyan-300/50 hover:text-cyan-200'
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
                                    ? 'bg-cyan-500/[0.25] text-cyan-100'
                                    : 'text-cyan-300/50 hover:text-cyan-200'
                                }`}
                              >
                                JSON
                              </button>
                            </div>
                            {activeArtifactId && (
                              <button
                                type="button"
                                onClick={() => openArtifactViewer(activeArtifactId)}
                                className="rounded-full border border-cyan-400/25 bg-cyan-500/[0.12] px-2.5 py-0.5 text-caption font-semibold text-cyan-100 transition hover:bg-cyan-500/[0.2]"
                              >
                                Open full artifact
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="max-h-[320px] overflow-y-auto px-4 pb-4">
                          <div className="rounded-lg border border-white/[0.06] bg-black/20 p-3.5">
                            {artifactViewMode === 'structured' ? (
                              renderArtifactValue(activeArtifact.value)
                            ) : (
                              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-caption leading-relaxed text-primary">
                                {JSON.stringify(activeArtifact.value, null, 2)}
                              </pre>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {activeOutcome && (
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
                              Open work session
                            </button>
                          )}
                          {canOpenDecisionFromDetail && (
                            <button
                              type="button"
                              onClick={() => {
                                onOpenDecision?.(activeDecisionIds[0] ?? null);
                                closeDetail();
                              }}
                              className="rounded-full border border-amber-300/30 bg-amber-400/[0.10] px-3 py-1 text-caption font-semibold text-amber-100 transition hover:bg-amber-400/[0.16]"
                            >
                              {activeDecisionIds.length > 0 ? 'Resolve decision' : 'Resolve decisions'}
                            </button>
                          )}
                          {activeArtifactId && !activeArtifact && (
                            <button
                              type="button"
                              onClick={() => openArtifactViewer(activeArtifactId)}
                              className="rounded-full border border-cyan-300/25 bg-cyan-500/[0.1] px-3 py-1 text-caption font-semibold text-cyan-100 transition hover:bg-cyan-500/[0.16]"
                            >
                              Open artifact
                            </button>
                          )}
                          {primaryEvidenceHref && (
                            <a
                              href={primaryEvidenceHref}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="rounded-full border border-strong bg-white/[0.04] px-3 py-1 text-caption font-semibold text-primary transition hover:bg-white/[0.1]"
                            >
                              Review evidence
                            </a>
                          )}
                          {activeAutoFixTarget && (
                            <button
                              type="button"
                              onClick={() => void runAutoFixAction()}
                              disabled={autoFixPending}
                              className={cn(
                                "rounded-full border px-3 py-1 text-caption font-semibold transition disabled:opacity-50",
                                activeAutoFixTarget.isBlockedFlow
                                  ? "border-amber-300/30 bg-amber-500/[0.12] text-amber-100 hover:bg-amber-500/[0.18]"
                                  : "border-lime/30 bg-lime/[0.12] text-[#D8FFA1] hover:bg-lime/[0.18]"
                              )}
                            >
                              {autoFixPending ? "Scheduling..." : activeAutoFixTarget.actionLabel}
                            </button>
                          )}
                        </div>
                        {activeAutoFixTarget && (
                          <p className="mt-2 text-caption text-secondary">
                            {autoFixNotice ?? activeAutoFixTarget.helperText}
                          </p>
                        )}
                      </div>
                    )}

                    {activeSpawnGuard && (
                      <div className="mt-3 rounded-xl border border-amber-300/26 bg-amber-500/[0.08] px-3.5 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-micro font-semibold uppercase tracking-[0.08em] text-amber-100/85">
                            Spawn guard
                          </p>
                          <Pill tone={activeSpawnGuard.isRateLimited ? 'muted' : 'red'}>
                            {activeSpawnGuard.isRateLimited ? 'Rate limited' : 'Blocked'}
                          </Pill>
                        </div>
                        <p className="mt-1 text-caption text-amber-100/80">
                          Dispatch was stopped before launch. Adjust limits or retry after the window resets.
                        </p>
                        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
                            <div className="text-micro font-semibold tracking-[0.02em] text-secondary">Domain window</div>
                            <div className="mt-1 text-body font-semibold tabular-nums text-primary">
                              {activeSpawnGuard.domainCurrent !== null && activeSpawnGuard.domainMax !== null
                                ? `${activeSpawnGuard.domainCurrent}/${activeSpawnGuard.domainMax} per hour`
                                : 'Not provided'}
                            </div>
                          </div>
                          <div className="rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2">
                            <div className="text-micro font-semibold tracking-[0.02em] text-secondary">Global window</div>
                            <div className="mt-1 text-body font-semibold tabular-nums text-primary">
                              {activeSpawnGuard.totalCurrent !== null && activeSpawnGuard.totalMax !== null
                                ? `${activeSpawnGuard.totalCurrent}/${activeSpawnGuard.totalMax} per hour`
                                : 'Not provided'}
                            </div>
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2 text-caption text-secondary">
                          {activeSpawnGuard.domain && (
                            <Pill tone="muted">Domain: {humanizeText(activeSpawnGuard.domain)}</Pill>
                          )}
                          {activeSpawnGuard.modelTier && (
                            <Pill tone="muted">Tier: {humanizeText(activeSpawnGuard.modelTier)}</Pill>
                          )}
                          {activeSpawnGuardRetryLabel && (
                            <Pill tone="muted">Retry: {activeSpawnGuardRetryLabel}</Pill>
                          )}
                          {!activeSpawnGuardRetryLabel && activeSpawnGuard.retryInMs !== null && (
                            <Pill tone="muted">
                              Retry in ~{Math.max(1, Math.round(activeSpawnGuard.retryInMs / 1000))}s
                            </Pill>
                          )}
                        </div>
                        {activeSpawnGuard.blockedReason && (
                          <p className="mt-2 rounded-lg border border-white/[0.10] bg-black/20 px-3 py-2 text-caption text-primary">
                            {humanizeActivityBody(activeSpawnGuard.blockedReason) ?? activeSpawnGuard.blockedReason}
                          </p>
                        )}
                        <div className="mt-2 flex flex-wrap gap-2">
                          {onOpenSettings && (
                            <button
                              type="button"
                              onClick={onOpenSettings}
                              className="rounded-full border border-amber-300/32 bg-amber-500/[0.14] px-3 py-1 text-caption font-semibold text-amber-100 transition hover:bg-amber-500/[0.2]"
                            >
                              Edit limits
                            </button>
                          )}
                          {activeAutoFixTarget && (
                            <button
                              type="button"
                              onClick={() => void runAutoFixAction()}
                              disabled={autoFixPending}
                              className="rounded-full border border-lime/30 bg-lime/[0.12] px-3 py-1 text-caption font-semibold text-[#D8FFA1] transition hover:bg-lime/[0.18] disabled:opacity-50"
                            >
                              {autoFixPending ? 'Scheduling...' : 'Retry now'}
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {activeResultItems.length > 0 && (
                      <div>
                        <p className="mb-2 px-1 text-micro font-semibold uppercase tracking-wider text-muted">
                          Results
                        </p>
                        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-caption sm:grid-cols-3">
                          {activeResultItems.map((item) => (
                            <div key={item.label} className="py-1">
                              <div className="text-micro text-muted">{item.label}</div>
                              <div className={`mt-0.5 break-words tabular-nums ${item.tone === 'critical' ? 'text-red-300' : 'text-primary'}`}>
                                {item.value}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* --- Execution context (flat layout) --- */}
                    {activeActorFlow && !activeAutopilotContext && (
                      <div>
                        <p className="mb-2 px-1 text-micro font-semibold uppercase tracking-wider text-muted">
                          Delegation
                        </p>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body text-secondary">
                          <span className="flex items-center gap-1.5">
                            {activeActorFlow.requester ? (
                              <>
                                <AgentAvatar
                                  name={activeActorFlow.requester.label}
                                  hint={actorAvatarHint(activeActorFlow.requester)}
                                  size="xs"
                                />
                                <span className="text-primary">{activeActorFlow.requester.label}</span>
                              </>
                            ) : (
                              <span>{humanizeActorName('System / unknown')}</span>
                            )}
                          </span>
                          <span className="text-white/[0.15]">→</span>
                          <span className="text-primary">
                            {activeActorFlow.mode === 'handoff'
                              ? 'Delegated handoff'
                              : activeActorFlow.mode === 'requested'
                                ? 'Dispatch requested'
                                : activeActorFlow.mode === 'single'
                                  ? 'Direct execution'
                                  : 'System event'}
                          </span>
                          <span className="text-white/[0.15]">→</span>
                          <span className="flex items-center gap-1.5">
                            {activeActorFlow.executor ? (
                              <>
                                <AgentAvatar
                                  name={activeActorFlow.executor.label}
                                  hint={actorAvatarHint(activeActorFlow.executor)}
                                  size="xs"
                                />
                                <span className="text-primary">{activeActorFlow.executor.label}</span>
                              </>
                            ) : (
                              <span>{humanizeActorName('Not assigned')}</span>
                            )}
                          </span>
                        </div>
                        {activeActorFlow.subtitle && (
                          <p className="mt-1 text-caption text-muted">{activeActorFlow.subtitle}</p>
                        )}
                      </div>
                    )}

                    {activeAutopilotContext && (
                      <div className="space-y-5">
                        {/* C1: Promoted ACTION NEEDED card — when blocked with a next step */}
                        {activeExecutionBreakdown?.nextStep && (activeAutopilotProgress?.tone === 'critical' || activeAutopilotProgress?.tone === 'warning') && (
                          <div className="rounded-xl border border-red-400/25 bg-red-500/[0.08] px-4 py-3">
                            <div className="flex items-center gap-2 mb-2">
                              <span className="inline-block h-2 w-2 rounded-full bg-red-400" />
                              <p className="text-micro font-semibold uppercase tracking-wider text-red-200">Action needed</p>
                            </div>
                            <p className="text-body text-primary leading-relaxed">
                              {activeExecutionBreakdown.nextStep}
                            </p>
                          </div>
                        )}

                        {/* Session status — compact inline */}
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="px-1 text-micro font-semibold uppercase tracking-wider text-muted">
                              Session
                            </p>
                            <span className="rounded-full border border-lime/30 bg-lime/[0.08] px-2 py-0.5 text-micro font-semibold text-lime/85">
                              {humanizeStopReason(activeAutopilotContext.event) ?? humanizeText(activeAutopilotContext.event)}
                            </span>
                          </div>
                        </div>

                        {/* Progress bar — inline, no card wrapper */}
                        {activeAutopilotProgress && (
                          <div>
                            <div className="flex items-center justify-between gap-2">
                              <p className="px-1 text-micro font-semibold uppercase tracking-wider text-muted">
                                {activeAutopilotProgressIsTerminalStop ? 'Terminal state' : 'Progress'}
                              </p>
                              <p className="text-body font-semibold tabular-nums" style={{ color: activeAutopilotProgressColor }}>
                                {activeAutopilotProgressIsTerminalStop
                                  ? activeOutcome?.label ?? 'Stopped'
                                  : `${activeAutopilotProgress.pct}%`}
                              </p>
                            </div>
                            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.10]">
                              <div
                                className="h-full rounded-full transition-[width] duration-300"
                                style={{
                                  width: `${Math.max(4, activeAutopilotProgress.pct)}%`,
                                  backgroundColor: activeAutopilotProgressColor,
                                }}
                              />
                            </div>
                            <p className="mt-1 text-micro text-muted">
                              {activeAutopilotProgress.label}
                            </p>
                          </div>
                        )}

                        {/* People — flat inline row */}
                        <div>
                          <p className="mb-2 px-1 text-micro font-semibold uppercase tracking-wider text-muted">
                            People
                          </p>
                          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                            <div>
                              <div className="text-micro text-muted">Requester</div>
                              <div className="mt-0.5 flex items-center gap-1.5 text-body text-primary">
                                <AgentAvatar
                                  name={activeAutopilotRequesterDisplay.primary}
                                  hint={activeAutopilotRequesterDisplay.secondary ?? activeAutopilotRequesterDisplay.primary}
                                  size="xs"
                                />
                                <span>{activeAutopilotRequesterDisplay.primary}</span>
                              </div>
                              {activeAutopilotRequesterDisplay.secondary && (
                                <p className="mt-0.5 text-micro text-muted">
                                  via {activeAutopilotRequesterDisplay.secondary}
                                </p>
                              )}
                            </div>
                            <div>
                              <div className="text-micro text-muted">Executor</div>
                              <div className="mt-0.5 flex items-center gap-1.5 text-body text-primary">
                                <AgentAvatar
                                  name={activeAutopilotExecutorLabel}
                                  hint={activeAutopilotExecutorLabel}
                                  size="xs"
                                />
                                <span>{activeAutopilotExecutorLabel}</span>
                              </div>
                            </div>
                            {activeAutopilotContext.dispatcherClient && activeAutopilotContext.dispatcherClient !== 'unknown' && (
                              <div>
                                <div className="text-micro text-muted">Dispatcher</div>
                                <div className="mt-0.5 text-body text-primary">
                                  {humanizeText(activeAutopilotContext.dispatcherClient)}
                                </div>
                              </div>
                            )}
                            {(activeAutopilotContext.domain || activeAutopilotContext.requiredSkills.length > 0) && (
                              <div>
                                <div className="text-micro text-muted">Policy</div>
                                <div className="mt-0.5 text-body text-primary">
                                  {activeAutopilotContext.domain ?? ''}
                                  {activeAutopilotContext.requiredSkills.length > 0
                                    ? `${activeAutopilotContext.domain ? ' · ' : ''}${activeAutopilotContext.requiredSkills.join(', ')}`
                                    : ''}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Scope — flat inline */}
                        {activeExecutionBreakdown && (
                          <div>
                            <p className="mb-2 px-1 text-micro font-semibold uppercase tracking-wider text-muted">
                              Scope
                            </p>
                            <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                              <div className="flex items-center justify-between gap-2 py-1">
                                <div>
                                  <div className="text-micro text-muted">Initiative</div>
                                  <p className="mt-0.5 text-body text-primary">
                                    {activeExecutionBreakdown.initiativeTitle ?? (activeExecutionBreakdown.initiativeId ? humanizeId(activeExecutionBreakdown.initiativeId) : '\u2014')}
                                  </p>
                                </div>
                                {activeExecutionBreakdown.initiativeStatus && (
                                  <span className="flex-shrink-0 text-micro text-muted">
                                    {humanizeText(activeExecutionBreakdown.initiativeStatus)}
                                  </span>
                                )}
                              </div>
                              {(activeExecutionBreakdown.workstreamTitle || activeExecutionBreakdown.workstreamId) && (
                                <div className="flex items-center justify-between gap-2 py-1">
                                  <div>
                                    <div className="text-micro text-muted">Workstream</div>
                                    <p className="mt-0.5 text-body text-primary">
                                      {activeExecutionBreakdown.workstreamTitle ?? humanizeId(activeExecutionBreakdown.workstreamId!)}
                                    </p>
                                  </div>
                                  {activeExecutionBreakdown.workstreamStatus && (
                                    <span className="flex-shrink-0 text-micro text-muted">
                                      {humanizeText(activeExecutionBreakdown.workstreamStatus)}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                            {activeExecutionBreakdown.initiativeWorkstreamPct !== null && (
                              <div className="mt-3">
                                <div className="mb-1 flex items-center justify-between text-micro text-muted">
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
                        )}

                        {/* Current step — simple key-value */}
                        {(activeExecutionBreakdown?.taskTitle ||
                          activeExecutionBreakdown?.milestoneTitle ||
                          activeExecutionBreakdown?.phase ||
                          activeExecutionBreakdown?.nextStep ||
                          activeExecutionBreakdown?.parsedStatus ||
                          activeExecutionBreakdown?.stopReason) && (
                          <div>
                            <p className="mb-2 px-1 text-micro font-semibold uppercase tracking-wider text-muted">
                              Current step
                            </p>
                            <div className="space-y-1 text-caption">
                              {activeExecutionBreakdown?.taskTitle && (
                                <p>
                                  <span className="text-muted">Task</span>{' '}
                                  <span className="text-primary">{activeExecutionBreakdown.taskTitle}</span>
                                </p>
                              )}
                              {activeExecutionBreakdown?.milestoneTitle && (
                                <p>
                                  <span className="text-muted">Milestone</span>{' '}
                                  <span className="text-primary">{activeExecutionBreakdown.milestoneTitle}</span>
                                </p>
                              )}
                              {activeExecutionBreakdown?.phase && (
                                <p>
                                  <span className="text-muted">Phase</span>{' '}
                                  <span className="text-primary">{humanizeStopReason(activeExecutionBreakdown.phase) ?? humanizeText(activeExecutionBreakdown.phase)}</span>
                                </p>
                              )}
                              {activeExecutionBreakdown?.nextStep && (
                                <p>
                                  <span className="text-muted">Next step</span>{' '}
                                  <span className="text-primary">{activeExecutionBreakdown.nextStep}</span>
                                </p>
                              )}
                              {activeExecutionBreakdown?.parsedStatus &&
                                activeExecutionBreakdown.parsedStatus !== activeExecutionBreakdown?.phase && (
                                <p>
                                  <span className="text-muted">Status</span>{' '}
                                  <span className="text-primary">{humanizeStopReason(activeExecutionBreakdown.parsedStatus) ?? humanizeText(activeExecutionBreakdown.parsedStatus)}</span>
                                </p>
                              )}
                              {activeExecutionBreakdown?.stopReason &&
                                activeExecutionBreakdown.stopReason !== activeExecutionBreakdown?.phase &&
                                activeExecutionBreakdown.stopReason !== activeExecutionBreakdown?.parsedStatus && (
                                <p>
                                  <span className="text-muted">Stop reason</span>{' '}
                                  <span className="text-primary">{humanizeStopReason(activeExecutionBreakdown.stopReason) ?? humanizeText(activeExecutionBreakdown.stopReason)}</span>
                                </p>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Error — stays prominent */}
                        {activeAutopilotContext.error && (
                          <div className="rounded-lg border border-red-400/20 bg-red-500/10 px-4 py-3 text-body text-red-100/80">
                            {activeAutopilotContext.error}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Summary — flat, no card wrapper */}
                    {activeSummaryText && (
                      <div>
                        <p className="mb-2 px-1 text-micro font-semibold uppercase tracking-wider text-muted">
                          Summary
                        </p>
                        {detailSummarySource === 'missing' && !activeIsSyncReplay && (
                          <p className="mb-1 text-caption text-amber-200/75">
                            Full local turn transcript was unavailable; showing the event summary payload.
                          </p>
                        )}
                        <MarkdownText
                          mode="block"
                          text={activeSummaryText}
                          className="text-body leading-relaxed text-primary"
                        />
                      </div>
                    )}

                    {/* Details — flat, no card wrapper */}
                    {humanizeActivityBody(activeDecorated.item.description) &&
                      humanizeActivityBody(activeDecorated.item.description) !== activeSummaryText && (
                      <div>
                        <p className="mb-2 px-1 text-micro font-semibold uppercase tracking-wider text-muted">
                          Details
                        </p>
                        <MarkdownText
                          mode="block"
                          text={humanizeActivityBody(activeDecorated.item.description) ?? ''}
                          className="text-body leading-relaxed text-secondary"
                        />
                      </div>
                    )}

                    {/* Slice narrative — flat */}
                    {activeNarrative && (
                      <div>
                        <p className="mb-2 px-1 text-micro font-semibold uppercase tracking-wider text-muted">
                          Narrative
                        </p>
                        <div className="space-y-1.5 text-caption">
                          <p>
                            <span className="text-muted">Intent</span>{' '}
                            <span className="text-primary">{activeNarrative.intent}</span>
                          </p>
                          <p>
                            <span className="text-muted">Dispatch</span>{' '}
                            <span className="text-primary">{activeNarrative.dispatch}</span>
                          </p>
                          {activeNarrative.highlights.length > 0 && (
                            <div>
                              <span className="text-muted">Highlights</span>
                              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-primary">
                                {activeNarrative.highlights.slice(0, 3).map((highlight, index) => (
                                  <li key={`${activeNarrative.sliceRunId}:highlight:${index}`}>
                                    {highlight}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          <p>
                            <span className="text-muted">Outcome</span>{' '}
                            <span className="text-primary">{activeNarrative.outcome.summary}</span>
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Evidence files — flat rows, deduplicated */}
                    {activeFileEvidenceUnique.length > 0 && (
                      <div>
                        <p className="mb-2 px-1 text-micro font-semibold uppercase tracking-wider text-muted">
                          Evidence
                        </p>
                        <p className="mb-2 px-1 text-caption text-secondary">
                          {activeFileEvidenceUnique.length}{' '}
                          {activeFileEvidenceUnique.length === 1 ? 'file' : 'files'} captured for this run.
                        </p>
                        <div className="space-y-2">
                          {activeFileEvidencePreview.map((entry, index) => {
                              const evidenceHref = resolveFileEvidenceHref(entry.path);
                              return (
                                <div
                                  key={`${entry.key}:${entry.path}:${index}`}
                                  className="flex items-center justify-between gap-3 py-1"
                                >
                                  <div className="min-w-0 flex-1">
                                    <p className="text-micro text-muted">{humanizeText(entry.key)}</p>
                                    <p className="mt-0.5 truncate font-mono text-caption text-primary">
                                      {humanizePath(entry.path)}
                                    </p>
                                  </div>
                                  <div className="flex flex-shrink-0 items-center gap-1.5">
                                    {evidenceHref && (
                                      <a
                                        href={evidenceHref}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="rounded-full border border-strong bg-white/[0.04] px-2.5 py-1 text-caption text-primary transition hover:bg-white/[0.1]"
                                      >
                                        Open
                                      </a>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => void copyText(`${humanizeText(entry.key)} path`, entry.path)}
                                      className="rounded-full border border-strong bg-white/[0.04] px-2.5 py-1 text-caption text-primary transition hover:bg-white/[0.1]"
                                    >
                                      Copy
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          {activeFileEvidenceOverflow.length > 0 && (
                            <details className="group rounded-lg border border-white/[0.08] bg-black/15 px-2.5 py-2">
                              <summary className="cursor-pointer list-none text-caption font-semibold text-secondary">
                                View {activeFileEvidenceOverflow.length} additional evidence file
                                {activeFileEvidenceOverflow.length === 1 ? '' : 's'}
                              </summary>
                              <div className="mt-2 space-y-2">
                                {activeFileEvidenceOverflow.map((entry, index) => {
                                  const evidenceHref = resolveFileEvidenceHref(entry.path);
                                  return (
                                    <div
                                      key={`${entry.key}:${entry.path}:overflow:${index}`}
                                      className="flex items-center justify-between gap-3 py-1"
                                    >
                                      <div className="min-w-0 flex-1">
                                        <p className="text-micro text-muted">{humanizeText(entry.key)}</p>
                                        <p className="mt-0.5 truncate font-mono text-caption text-primary">
                                          {humanizePath(entry.path)}
                                        </p>
                                      </div>
                                      <div className="flex flex-shrink-0 items-center gap-1.5">
                                        {evidenceHref && (
                                          <a
                                            href={evidenceHref}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="rounded-full border border-strong bg-white/[0.04] px-2.5 py-1 text-caption text-primary transition hover:bg-white/[0.1]"
                                          >
                                            Open
                                          </a>
                                        )}
                                        <button
                                          type="button"
                                          onClick={() =>
                                            void copyText(`${humanizeText(entry.key)} path`, entry.path)
                                          }
                                          className="rounded-full border border-strong bg-white/[0.04] px-2.5 py-1 text-caption text-primary transition hover:bg-white/[0.1]"
                                        >
                                          Copy
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </details>
                          )}
                        </div>
                      </div>
                    )}

                    {/* View registered artifact — only when there's no inline artifact already shown in hero */}
                    {activeDecorated && extractArtifactId(activeDecorated.item) && !activeArtifact && (
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

                    {/* Separator before debug sections */}
                    {(activeProvenance ||
                      activeAutopilotContext?.logPath ||
                      activeMetadataJson) && (
                      <div className="border-t border-white/[0.06]" />
                    )}

                    {/* --- Technical & Provenance — collapsible near bottom --- */}
                    {(activeProvenance ||
                      activeAutopilotContext?.logPath ||
                      activeAutopilotContext?.outputPath ||
                      activeExecutionBreakdown?.initiativeId ||
                      activeExecutionBreakdown?.workstreamId) && (
                      <details className="group">
                        <summary className="flex cursor-pointer items-center gap-1.5 px-1 text-micro font-semibold uppercase tracking-wider text-muted select-none">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="transition-transform group-open:rotate-90">
                            <path d="m9 18 6-6-6-6" />
                          </svg>
                          Technical
                        </summary>
                        <div className="mt-3 space-y-3 text-caption">
                          {activeProvenance && (
                            <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
                              {activeProvenance.domain && (
                                <div className="py-1">
                                  <div className="text-micro text-muted">Domain</div>
                                  <div className="mt-0.5 text-primary">{humanizeText(activeProvenance.domain)}</div>
                                </div>
                              )}
                              {(activeProvenance.provider || activeProvenance.model) && (
                                <div className="py-1">
                                  <div className="text-micro text-muted">Model</div>
                                  <div className="mt-0.5 text-primary">
                                    {activeProvenance.provider ? `${humanizeText(activeProvenance.provider)} · ` : ''}
                                    {activeProvenance.model ? humanizeModel(activeProvenance.model) : '\u2014'}
                                  </div>
                                </div>
                              )}
                              {activeProvenance.modelTier && (
                                <div className="py-1">
                                  <div className="text-micro text-muted">Model tier</div>
                                  <div className="mt-0.5 text-primary">{humanizeText(activeProvenance.modelTier)}</div>
                                </div>
                              )}
                              {activeProvenance.pluginVersion && (
                                <div className="py-1">
                                  <div className="text-micro text-muted">Plugin</div>
                                  <div className="mt-0.5 text-primary">v{activeProvenance.pluginVersion}</div>
                                </div>
                              )}
                            </div>
                          )}
                          {activeProvenance?.skillPack && (
                            <div className="flex flex-wrap items-center gap-2 py-1">
                              <span className="text-micro text-muted">Skill pack</span>
                              <span className="text-primary">
                                {activeProvenance.skillPack.name ?? '\u2014'}
                                {activeProvenance.skillPack.version ? `@${activeProvenance.skillPack.version}` : ''}
                                {activeProvenance.skillPack.source ? ` · ${activeProvenance.skillPack.source}` : ''}
                              </span>
                              {activeProvenance.skillPack.checksum && (
                                <button
                                  type="button"
                                  onClick={() => void copyText('Skill pack checksum', activeProvenance.skillPack?.checksum ?? '')}
                                  className="rounded-full border border-strong bg-white/[0.04] px-2 py-0.5 text-micro text-muted transition hover:bg-white/[0.1] hover:text-primary"
                                >
                                  sha {activeProvenance.skillPack.checksum.slice(0, 12)}
                                </button>
                              )}
                            </div>
                          )}
                          {activeProvenance && activeProvenance.requiredSkills.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5 py-1">
                              <span className="text-micro text-muted">Skills</span>
                              {activeProvenance.requiredSkills.map((skill) => (
                                <span key={skill} className="rounded-full border border-strong bg-white/[0.03] px-2 py-0.5 text-micro text-secondary">
                                  {skill}
                                </span>
                              ))}
                            </div>
                          )}
                          {activeProvenance?.kickoffContextHash && (
                            <div className="flex items-center justify-between gap-2 py-1">
                              <div>
                                <span className="text-micro text-muted">Kickoff context</span>{' '}
                                <span className="font-mono text-muted">
                                  {activeProvenance.kickoffContextSource ? `${activeProvenance.kickoffContextSource} · ` : ''}
                                  {activeProvenance.kickoffContextHash.slice(0, 16)}
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={() => void copyText('Kickoff context hash', activeProvenance.kickoffContextHash ?? '')}
                                className="rounded-full border border-strong bg-white/[0.04] px-2 py-0.5 text-micro text-muted transition hover:bg-white/[0.1] hover:text-primary"
                              >
                                Copy
                              </button>
                            </div>
                          )}
                          {(activeAutopilotContext?.logPath || activeAutopilotContext?.outputPath) && (
                            <div className="space-y-1 border-t border-white/[0.06] pt-3">
                              {activeAutopilotContext?.logPath && (
                                <div className="flex items-center justify-between gap-2">
                                  <p className="min-w-0 truncate font-mono text-muted">
                                    log: {humanizePath(activeAutopilotContext.logPath)}
                                  </p>
                                  <button
                                    type="button"
                                    onClick={() => void copyText('Log path', activeAutopilotContext?.logPath ?? '')}
                                    className="flex-shrink-0 rounded-full border border-strong bg-white/[0.04] px-2 py-0.5 text-micro text-muted transition hover:bg-white/[0.1] hover:text-primary"
                                  >
                                    Copy
                                  </button>
                                </div>
                              )}
                              {activeAutopilotContext?.outputPath && (
                                <div className="flex items-center justify-between gap-2">
                                  <p className="min-w-0 truncate font-mono text-muted">
                                    output: {humanizePath(activeAutopilotContext.outputPath)}
                                  </p>
                                  <button
                                    type="button"
                                    onClick={() => void copyText('Output path', activeAutopilotContext?.outputPath ?? '')}
                                    className="flex-shrink-0 rounded-full border border-strong bg-white/[0.04] px-2 py-0.5 text-micro text-muted transition hover:bg-white/[0.1] hover:text-primary"
                                  >
                                    Copy
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                          {(activeExecutionBreakdown?.initiativeId || activeExecutionBreakdown?.workstreamId) && (
                            <div className="space-y-1 border-t border-white/[0.06] pt-3">
                              {activeExecutionBreakdown?.initiativeId && (
                                <p className="break-all font-mono text-muted">
                                  initiative: {humanizeId(activeExecutionBreakdown.initiativeId)}
                                </p>
                              )}
                              {activeExecutionBreakdown?.workstreamId && (
                                <p className="break-all font-mono text-muted">
                                  workstream: {humanizeId(activeExecutionBreakdown.workstreamId)}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      </details>
                    )}

                    {/* Raw metadata — single collapsible for power users */}
                    {activeMetadataJson && (
                      <details className="group">
                        <summary className="flex cursor-pointer items-center gap-1.5 px-1 text-micro font-semibold uppercase tracking-wider text-muted select-none">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="transition-transform group-open:rotate-90">
                            <path d="m9 18 6-6-6-6" />
                          </svg>
                          Raw metadata
                        </summary>
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-caption leading-relaxed text-muted">
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
      </ActivityDetailModal>
    </div>
    </ChatDockProvider>
  );
});
