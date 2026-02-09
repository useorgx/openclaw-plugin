import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import { humanizeText, humanizeModel } from '@/lib/humanize';
import type { LiveActivityItem, LiveActivityType, SessionTreeNode } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { MarkdownText } from '@/components/shared/MarkdownText';
import { Modal } from '@/components/shared/Modal';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { ThreadView } from './ThreadView';

const itemVariants = {
  initial: { opacity: 0, y: 8, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -4, scale: 0.98 },
};

interface ActivityTimelineProps {
  activity: LiveActivityItem[];
  sessions: SessionTreeNode[];
  selectedRunIds: string[];
  selectedSessionLabel?: string | null;
  onClearSelection: () => void;
  onFocusRunId?: (runId: string) => void;
}

const MAX_RENDERED_ACTIVITY = 480;

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

const filterLabels: Record<ActivityFilterId, string> = {
  all: 'All',
  messages: 'Messages',
  artifacts: 'Artifacts',
  decisions: 'Decisions',
};

const typeColor: Record<LiveActivityType, string> = {
  run_started: colors.teal,
  run_completed: colors.lime,
  run_failed: colors.red,
  artifact_created: colors.cyan,
  decision_requested: colors.amber,
  decision_resolved: colors.lime,
  handoff_requested: colors.iris,
  handoff_claimed: colors.teal,
  handoff_fulfilled: colors.lime,
  blocker_created: colors.red,
  milestone_completed: colors.cyan,
  delegation: colors.iris,
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

function metadataToJson(metadata: Record<string, unknown> | undefined): string | null {
  if (!metadata || Object.keys(metadata).length === 0) return null;
  try {
    return JSON.stringify(metadata, null, 2);
  } catch {
    return null;
  }
}

type ArtifactPayload = {
  source: string;
  value: unknown;
};

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
  selectedRunIds,
  selectedSessionLabel = null,
  onClearSelection,
  onFocusRunId,
}: ActivityTimelineProps) {
  const [activeFilter, setActiveFilter] = useState<ActivityFilterId>('all');
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [detailDirection, setDetailDirection] = useState<1 | -1>(1);
  const [artifactViewMode, setArtifactViewMode] = useState<'structured' | 'json'>('structured');
  const [detailSummaryOverride, setDetailSummaryOverride] = useState<string | null>(null);
  const [detailSummarySource, setDetailSummarySource] = useState<'feed' | 'local' | 'missing'>('feed');
  const [detailHeadlineOverride, setDetailHeadlineOverride] = useState<string | null>(null);
  const [detailHeadlineSource, setDetailHeadlineSource] = useState<HeadlineSource>(null);
  const [headlineEndpointUnsupported, setHeadlineEndpointUnsupported] = useState(false);

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

  const { filtered, truncatedCount } = useMemo(() => {
    const visible: DecoratedActivityItem[] = [];
    let overflow = 0;
    const normalizedQuery = query.trim().toLowerCase();

    for (const decorated of decoratedActivity) {
      const runId = decorated.runId;
      if (hasSessionFilter && (!runId || !selectedRunIdSet.has(runId))) {
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

      if (visible.length < MAX_RENDERED_ACTIVITY) {
        visible.push(decorated);
      } else {
        overflow += 1;
      }
    }

    const sorted = [...visible].sort((a, b) => {
      const delta = b.timestampEpoch - a.timestampEpoch;
      return sortOrder === 'newest' ? delta : -delta;
    });

    return {
      filtered: sorted,
      truncatedCount: overflow,
    };
  }, [
    activeFilter,
    decoratedActivity,
    hasSessionFilter,
    query,
    runLabelById,
    selectedRunIdSet,
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

  const activeIndex = useMemo(() => {
    if (!activeItemId) return -1;
    return filtered.findIndex((decorated) => decorated.item.id === activeItemId);
  }, [activeItemId, filtered]);

  const activeDecorated = activeIndex >= 0 ? filtered[activeIndex] : null;
  const activeArtifact = useMemo(
    () => extractArtifactPayload(activeDecorated?.item ?? null),
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

  const renderItem = (decorated: DecoratedActivityItem, index: number) => {
    const item = decorated.item;
    const color = typeColor[item.type] ?? colors.iris;
    const isRecent = sortOrder === 'newest' && index < 2;
    const bucket = decorated.bucket;
    const runId = decorated.runId;
    const runLabel = runId ? runLabelById.get(runId) ?? humanizeText(runId) : 'Workspace';
    const sessionStatus = runId ? sessionStatusById.get(runId) ?? null : null;

    const displayTitle = humanizeText(item.title ?? '');
    const displaySummary = humanizeActivityBody(item.summary);
    const displayDesc = humanizeActivityBody(item.description);
    const kindColor = bucketColor(bucket);
    const kindLabel = bucketLabel(bucket);
    const metadataJson = metadataToJson(item.metadata as Record<string, unknown> | undefined);
    const timeLabel = new Date(item.timestamp).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });

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
        className="group w-full rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover:border-white/[0.14] hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BFFF00]/45"
        aria-label={`Open activity details for ${displayTitle || labelForType(item.type)}`}
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex flex-col items-center gap-1.5">
            <AgentAvatar
              name={item.agentName ?? 'OrgX'}
              hint={`${item.agentId ?? ''} ${runLabel} ${item.title ?? ''}`}
              size="xs"
            />
            <span
              className={cn('h-2.5 w-2.5 rounded-full', isRecent && 'pulse-soft')}
              style={{
                backgroundColor: color,
                boxShadow: `0 0 16px ${color}77`,
              }}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="line-clamp-2 break-words text-[13px] font-semibold leading-snug text-white/90">
                  {displayTitle || humanizeText(item.title || labelForType(item.type))}
                </p>
                <p className="mt-0.5 text-[11px] text-white/45">
                  {item.agentName ?? 'OrgX'}
                  {sessionStatus ? ` · ${sessionStatus}` : ''}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1 text-right">
                <span className="text-[10px] uppercase tracking-[0.1em] text-white/35">
                  {labelForType(item.type)}
                </span>
                <span className="text-[11px] text-white/55">{timeLabel}</span>
              </div>
            </div>

            {(displaySummary || displayDesc) && (
              <div className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-white/55">
                <MarkdownText
                  mode="inline"
                  text={displaySummary ?? displayDesc ?? ''}
                />
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
              <span
                className="rounded-full border px-1.5 py-0.5 uppercase tracking-[0.08em]"
                style={{
                  borderColor: `${kindColor}66`,
                  color: kindColor,
                }}
              >
                {kindLabel}
              </span>
              <span className="rounded-full border border-white/[0.12] px-1.5 py-0.5 text-white/55">
                {runLabel}
              </span>
              {sessionStatus && (
                <span className="rounded-full border border-white/[0.12] bg-white/[0.02] px-1.5 py-0.5 uppercase tracking-[0.08em] text-white/50">
                  {sessionStatus}
                </span>
              )}
              <span className="text-white/50">{formatRelativeTime(item.timestamp)}</span>
              {metadataJson && (
                <span className="text-white/35">meta</span>
              )}
            </div>
          </div>
        </div>
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
      <div className="border-b border-white/[0.06] px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="text-[14px] font-semibold text-white">Activity</h2>
            <span className="chip">{filtered.length}</span>
            {truncatedCount > 0 && (
              <span className="chip text-white/60">+{truncatedCount} hidden</span>
            )}
            <span
              className={cn('h-1.5 w-1.5 rounded-full', isLive && 'pulse-soft')}
              style={{ backgroundColor: colors.lime }}
              aria-label="Live"
              title={isLive ? 'New activity within the last minute' : 'Live activity feed'}
            />

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
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSortOrder((prev) => (prev === 'newest' ? 'oldest' : 'newest'))}
              className="rounded-full border border-white/[0.12] bg-white/[0.03] px-3 py-1 text-[11px] font-medium text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white"
              aria-label={sortOrder === 'newest' ? 'Sort oldest first' : 'Sort newest first'}
            >
              {sortOrder === 'newest' ? 'Newest' : 'Oldest'}
            </button>
            <button
              type="button"
              onClick={() => setCollapsed((prev) => !prev)}
              className="rounded-full border border-white/[0.12] bg-white/[0.03] px-3 py-1 text-[11px] font-medium text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white"
              aria-pressed={collapsed}
            >
              {collapsed ? 'Expand' : 'Compact'}
            </button>
          </div>
        </div>

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
              className="w-full rounded-lg border border-white/[0.1] bg-black/30 py-1.5 pl-9 pr-2 text-[12px] text-white/80 placeholder:text-white/35 focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/30"
              aria-label="Search activity"
            />
          </div>

          <div
            className="inline-flex items-center gap-1 rounded-full border border-white/[0.12] bg-black/30 p-0.5"
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
                    'rounded-full px-3 py-1 text-[10px] font-semibold transition-colors',
                    active
                      ? 'border border-lime/25 bg-lime/[0.12] text-lime'
                      : 'border border-transparent text-white/60 hover:bg-white/[0.06] hover:text-white/80'
                  )}
                >
                  {filterLabels[filterId]}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
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
                : 'No matching activity right now.'}
            </p>
            {hasSessionFilter && (
              <button
                onClick={onClearSelection}
                className="rounded-md border border-white/[0.12] bg-white/[0.04] px-3 py-1.5 text-[11px] text-white/70 transition-colors hover:bg-white/[0.08]"
              >
                Show all sessions
              </button>
            )}
          </div>
        )}

        {filtered.length > 0 && (
          <div className="space-y-4">
            {grouped.map((group) => {
              const visibleItems = collapsed ? group.items.slice(0, 4) : group.items;
              return (
                <section key={group.key}>
                  <h3 className="mb-2.5 border-b border-white/[0.06] pb-1.5 text-[11px] uppercase tracking-[0.12em] text-white/35">
                    {group.label}
                  </h3>
                  <AnimatePresence mode="popLayout">
                    <div className="space-y-2">
                      {visibleItems.map((item, index) => renderItem(item, index))}
                    </div>
                  </AnimatePresence>
                  {collapsed && group.items.length > visibleItems.length && (
                    <p className="mt-1.5 text-[11px] text-white/35">
                      +{group.items.length - visibleItems.length} more
                    </p>
                  )}
                </section>
              );
            })}

            {truncatedCount > 0 && (
              <p className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px] text-white/45">
                Showing latest {filtered.length} events ({truncatedCount} older events omitted for smooth rendering).
              </p>
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
	                {activeDecorated.item.agentId && (
	                  <button
	                    type="button"
	                    onClick={() => void copyText('Agent id', activeDecorated.item.agentId ?? '')}
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
                      {activeDecorated.item.agentName && (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.12] px-1.5 py-0.5 text-white/65">
                          <AgentAvatar
                            name={activeDecorated.item.agentName}
                            hint={`${activeDecorated.item.agentId ?? ''} ${activeDecorated.item.title ?? ''}`}
                            size="xs"
                          />
                          <span>{activeDecorated.item.agentName}</span>
                        </span>
                      )}
                      {activeDecorated.runId && (
                        <span className="rounded-full border border-white/[0.12] px-2 py-0.5 text-white/65">
                          {runLabelById.get(activeDecorated.runId) ?? humanizeText(activeDecorated.runId)}
                        </span>
                      )}
                    </div>

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
                      <div className="rounded-xl border border-white/[0.08] bg-black/35 p-3">
                        <p className="text-[11px] uppercase tracking-[0.11em] text-white/45">Metadata</p>
                        <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-white/65">
                          {activeMetadataJson}
                        </pre>
                      </div>
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
