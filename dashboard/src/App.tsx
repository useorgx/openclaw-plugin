import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { useLiveData } from '@/hooks/useLiveData';
import { useActivityFeed } from '@/hooks/useActivityFeed';
import { useOnboarding } from '@/hooks/useOnboarding';
import { useNextUpQueue } from '@/hooks/useNextUpQueue';
import { useNextUpQueueActions } from '@/hooks/useNextUpQueueActions';
import { useTriageQueue } from '@/hooks/useTriageQueue';
import { cn } from '@/lib/utils';
import { colors, normalizeStatus } from '@/lib/tokens';
import { formatWaitingDuration } from '@/lib/time';
import { appendWorkspaceScopeParams as appendCanonicalWorkspaceScopeParams } from '@/lib/workspaceScope';
import { isSyntheticInitiativeId } from '@/lib/initiativeIds';
import { cutoffEpochForActivityFilter } from '@/lib/activityTimeFilters';
import { humanizeWarning } from '@/lib/humanize';
import type { ActivityTimeFilterId } from '@/lib/activityTimeFilters';
import type {
  Agent,
  AgentSuiteDomain,
  Initiative,
  LiveActivityItem,
  NextUpQueueItem,
  SessionTreeNode,
  SliceRunProjection,
} from '@/types';
import { OnboardingGate } from '@/components/onboarding/OnboardingGate';
import { Badge } from '@/components/shared/Badge';
import { Modal } from '@/components/shared/Modal';
import { MobileTabBar } from '@/components/shared/MobileTabBar';
import type { MobileTab } from '@/components/shared/MobileTabBar';
import {
  InProgressPanel,
  selectInProgressRows,
  type InProgressRow,
} from '@/components/mission-control/InProgressPanel';
import { NeedsInputPanel, selectNeedsInputRows } from '@/components/mission-control/NeedsInputPanel';
import type { SliceDetailTarget } from '@/components/mission-control/SliceDetailModal';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { EntityIcon, type EntityIconType } from '@/components/shared/EntityIcon';
import { useEntityInitiatives } from '@/hooks/useEntityInitiatives';
import { useLiveInitiatives } from '@/hooks/useLiveInitiatives';
import type { SettingsTab } from '@/components/settings/SettingsModal';
import type { BulkSessionsMode } from '@/components/bulk/BulkSessionsModal';
import { ArtifactViewerProvider, useArtifactViewer } from '@/components/artifacts/ArtifactViewerContext';
import { ContextualStatus } from '@/components/shared/ContextualStatus';
import { AgentsChatsPanel } from '@/components/sessions/AgentsChatsPanel';
import { ActivityTimeline } from '@/components/activity/ActivityTimeline';
import orgxLogo from '@/assets/orgx-logo.png';

type DashboardView = 'activity' | 'mission-control';
type OnboardingController = ReturnType<typeof useOnboarding>;

const LazyMissionControlView = lazy(async () => {
  const mod = await import('@/components/mission-control/MissionControlView');
  return { default: mod.MissionControlView };
});

const LazySessionInspector = lazy(async () => {
  const mod = await import('@/components/sessions/SessionInspector');
  return { default: mod.SessionInspector };
});

const LazyDecisionQueue = lazy(async () => {
  const mod = await import('@/components/decisions/DecisionQueue');
  return { default: mod.DecisionQueue };
});

const LazyTriageQueue = lazy(() =>
  import('@/components/triage/TriageQueue').then((m) => ({ default: m.TriageQueue }))
);
const LazyTriageDetailModal = lazy(() =>
  import('@/components/triage/TriageDetailModal').then((m) => ({ default: m.TriageDetailModal }))
);

const LazyNextUpPanel = lazy(async () => {
  const mod = await import('@/components/mission-control/NextUpPanel');
  return { default: mod.NextUpPanel };
});

const LazySettingsModal = lazy(async () => {
  const mod = await import('@/components/settings/SettingsModal');
  return { default: mod.SettingsModal };
});

const LazyBulkSessionsModal = lazy(async () => {
  const mod = await import('@/components/bulk/BulkSessionsModal');
  return { default: mod.BulkSessionsModal };
});

const LazyBulkDecisionsModal = lazy(async () => {
  const mod = await import('@/components/bulk/BulkDecisionsModal');
  return { default: mod.BulkDecisionsModal };
});

const LazyBulkOutboxModal = lazy(async () => {
  const mod = await import('@/components/bulk/BulkOutboxModal');
  return { default: mod.BulkOutboxModal };
});

const LazyBulkHandoffsModal = lazy(async () => {
  const mod = await import('@/components/bulk/BulkHandoffsModal');
  return { default: mod.BulkHandoffsModal };
});

const LazyArtifactViewerModal = lazy(async () => {
  const mod = await import('@/components/artifacts/ArtifactViewerModal');
  return { default: mod.ArtifactViewerModal };
});

const LazySliceDetailModal = lazy(async () => {
  const mod = await import('@/components/mission-control/SliceDetailModal');
  return { default: mod.SliceDetailModal };
});

const LazyRealtimeOrchestratorModal = lazy(async () => {
  const mod = await import('@/components/activity/RealtimeOrchestratorModal');
  return { default: mod.RealtimeOrchestratorModal };
});

const CONNECTION_LABEL: Record<string, string> = {
  connected: 'Live',
  reconnecting: 'Reconnecting',
  disconnected: 'Offline',
};

const CONNECTION_COLOR: Record<string, string> = {
  connected: colors.lime,
  reconnecting: colors.amber,
  disconnected: colors.red,
};

const DEMO_MODE_KEY = 'orgx.demo_mode';
const DEV_MODE_KEY = 'orgx.dev_mode';
const SHOW_SYNTHETIC_ENTITIES_KEY = 'orgx.show_synthetic_entities';
const SELECTED_WORKSPACE_ID_KEY = 'orgx.selected_workspace_id';

const SESSION_PRIORITY: Record<string, number> = {
  blocked: 0,
  pending: 1,
  queued: 2,
  running: 3,
  failed: 4,
  cancelled: 5,
  completed: 6,
  archived: 7,
};

const ACTIVE_SESSION_METRIC_STATUSES = new Set([
  'running',
  'active',
  'queued',
  'pending',
  'in_progress',
  'working',
  'planning',
]);
const CONFIGURE_ENGINEERING_AGENT_INTENT_RE =
  /^\s*configure\s+engineering\s+agent(?:\s*[.!?])?\s*$/i;

type HeaderNotification = {
  id: string;
  kind: 'error' | 'info';
  icon: EntityIconType;
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};

type WorkspaceOption = {
  id: string;
  title: string;
  status: string | null;
  isDefault: boolean;
  createdAt: string | null;
};

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatAbsoluteTimestamp(value: string | null | undefined): string {
  const epoch = toEpoch(value);
  if (!epoch) return 'unknown';
  try {
    return new Date(epoch).toLocaleString();
  } catch {
    return 'unknown';
  }
}

function compactErrorMessage(value: string, maxLength = 220): string {
  const segments = value
    .split('|')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => segment.replace(/^[^:]+:\s*/, '').trim());
  const unique = Array.from(new Set(segments.length > 0 ? segments : [value.trim()]));
  const joined = unique.slice(0, 2).join(' ');
  if (joined.length <= maxLength) return joined;
  return `${joined.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatLiveErrorCopy(raw: string): {
  title: string;
  message: string;
  action: 'settings' | 'refresh';
} {
  const normalized = raw.trim().toLowerCase();
  if (
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('request cancelled') ||
    normalized.includes('signal is aborted')
  ) {
    return {
      title: 'Live sync delayed',
      message:
        'OrgX Live is responding slowly. Initiatives and Next Up may look empty until sync recovers.',
      action: 'refresh',
    };
  }
  if (
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden') ||
    normalized.includes('api key') ||
    normalized.includes('auth')
  ) {
    return {
      title: 'OrgX auth required',
      message:
        'Reconnect your OrgX API key in Settings to restore live initiatives, activity, and Next Up.',
      action: 'settings',
    };
  }
  if (
    normalized.includes('unknown api endpoint') ||
    normalized.includes('missing required live routes') ||
    normalized.includes('runtime is missing required live routes')
  ) {
    return {
      title: 'Plugin update required',
      message:
        'This runtime is missing required live routes. Restart the plugin and update to the latest build.',
      action: 'settings',
    };
  }
  const friendly = humanizeWarning(raw);
  return {
    title: 'Live stream degraded',
    message: compactErrorMessage(friendly),
    action: 'settings',
  };
}

function resolveActivityRunId(item: LiveActivityItem): string | null {
  if (item.runId && item.runId.trim().length > 0) return item.runId.trim();
  if (!item.metadata || typeof item.metadata !== 'object' || Array.isArray(item.metadata)) {
    return null;
  }
  const metadata = item.metadata as Record<string, unknown>;
  const keys = ['runId', 'run_id', 'sessionId', 'session_id', 'agentRunId'];
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function resolveActivitySliceRunId(item: LiveActivityItem): string | null {
  const direct = (item as LiveActivityItem & { sliceRunId?: string | null }).sliceRunId;
  if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim();
  if (!item.metadata || typeof item.metadata !== 'object' || Array.isArray(item.metadata)) {
    return null;
  }
  const metadata = item.metadata as Record<string, unknown>;
  const keys = ['sliceRunId', 'slice_run_id', 'sliceId', 'slice_id', 'sliceRun', 'slice_run'];
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function resolveActivityMetadata(item: LiveActivityItem): Record<string, unknown> | null {
  if (!item.metadata || typeof item.metadata !== 'object' || Array.isArray(item.metadata)) {
    return null;
  }
  return item.metadata as Record<string, unknown>;
}

function readActivityMetadataString(
  metadata: Record<string, unknown> | null,
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

function resolveActivityInitiativeId(item: LiveActivityItem): string | null {
  const direct = typeof item.initiativeId === 'string' ? item.initiativeId.trim() : '';
  if (direct.length > 0) return direct;
  const metadata = resolveActivityMetadata(item);
  return readActivityMetadataString(metadata, ['initiative_id', 'initiativeId']);
}

function compareSessionPriority(a: SessionTreeNode, b: SessionTreeNode): number {
  const aPriority = SESSION_PRIORITY[a.status] ?? 99;
  const bPriority = SESSION_PRIORITY[b.status] ?? 99;
  if (aPriority !== bPriority) return aPriority - bPriority;
  return (
    toEpoch(a.updatedAt ?? a.lastEventAt ?? a.startedAt) -
    toEpoch(b.updatedAt ?? b.lastEventAt ?? b.startedAt)
  );
}

function selectStartableQueueItem(
  items: NextUpQueueItem[],
  preferredInitiativeId: string | null = null
): NextUpQueueItem | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const pick = (pool: NextUpQueueItem[]) =>
    pool.find((item) => item.queueState !== 'blocked' && item.queueState !== 'running') ??
    pool.find((item) => item.queueState !== 'blocked') ??
    null;

  if (preferredInitiativeId && preferredInitiativeId.trim().length > 0) {
    const scoped = items.filter((item) => item.initiativeId === preferredInitiativeId);
    const preferred = pick(scoped);
    if (preferred) return preferred;
  }

  return pick(items);
}

function autoContinueUpdatedEpoch(item: NextUpQueueItem): number {
  const iso = item.autoContinue?.updatedAt ?? item.updatedAt ?? null;
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toAgentStatus(value: string): Agent['status'] {
  const normalized = value.toLowerCase();
  if (normalized === 'blocked' || normalized === 'failed') return 'blocked';
  if (normalized === 'running' || normalized === 'active' || normalized === 'in_progress') {
    return 'working';
  }
  if (normalized === 'pending' || normalized === 'queued') return 'waiting';
  if (normalized === 'completed' || normalized === 'done') return 'done';
  return 'idle';
}

function isSyntheticSessionNode(node: SessionTreeNode): boolean {
  if (isSyntheticInitiativeId(node.initiativeId)) return true;
  const runId = (node.runId ?? '').trim().toLowerCase();
  if (/^run-\d+$/.test(runId)) return true;
  if (runId.startsWith('mock-')) return true;
  return false;
}

function isSyntheticActivityItem(item: LiveActivityItem): boolean {
  if (isSyntheticInitiativeId(item.initiativeId)) return true;
  const runId = (item.runId ?? '').trim().toLowerCase();
  if (/^run-\d+$/.test(runId)) return true;
  if (runId.startsWith('mock-')) return true;
  return false;
}

/** Items emitted by mock autopilot workers during test harness runs. */
function isMockActivityItem(item: LiveActivityItem): boolean {
  const meta = (item as any).metadata;
  return meta != null && typeof meta === 'object' && meta.mock === true;
}

function isConfigureEngineeringAgentIntent(value: string): boolean {
  return CONFIGURE_ENGINEERING_AGENT_INTENT_RE.test(value);
}

function pickString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized.length > 0) return normalized;
  }
  return null;
}

function isVisibleProjectStatus(rawStatus: string | null | undefined): boolean {
  const normalized = (rawStatus ?? '').trim().toLowerCase();
  if (!normalized) return true;
  return !['deleted', 'archived', 'cancelled'].includes(normalized);
}

function normalizeWorkspaceTitle(input: { title: string; isDefault: boolean }): string {
  const title = input.title.trim();
  if (title.length > 0) return title;
  return input.isDefault ? 'Default workspace' : 'Untitled workspace';
}

function readWorkspaceScopeParam(params: URLSearchParams): string | null {
  const value =
    params.get('workspace_id') ??
    params.get('workspaceId') ??
    params.get('command_center_id') ??
    params.get('commandCenterId') ??
    params.get('project_id') ??
    params.get('projectId') ??
    params.get('center');
  if (!value || value.trim().length === 0) return null;
  return value.trim();
}

function setWorkspaceScopeParams(params: URLSearchParams, workspaceId: string): void {
  appendCanonicalWorkspaceScopeParams(params, workspaceId);
}

function clearWorkspaceScopeParams(params: URLSearchParams): void {
  params.delete('workspace_id');
  // Clean up legacy aliases if present from old URLs
  params.delete('workspaceId');
  params.delete('command_center_id');
  params.delete('commandCenterId');
  params.delete('project_id');
  params.delete('projectId');
  params.delete('center');
}

function parseWorkspaceIdFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const workspaceId = readWorkspaceScopeParam(params);
    if (workspaceId) return workspaceId;
  } catch {
    // ignore
  }
  try {
    const stored = window.localStorage.getItem(SELECTED_WORKSPACE_ID_KEY);
    if (stored && stored.trim().length > 0) {
      return stored.trim();
    }
  } catch {
    // ignore
  }
  return null;
}

export function App() {
  const onboarding = useOnboarding();

  if (onboarding.showGate) {
    return (
      <OnboardingGate
        state={onboarding.state}
        isLoading={onboarding.isLoading}
        isStarting={onboarding.isStarting}
        isSubmittingManual={onboarding.isSubmittingManual}
        onRefresh={onboarding.refreshStatus}
        onStartPairing={onboarding.startPairing}
        onSubmitManualKey={onboarding.submitManualKey}
        onBackToPairing={onboarding.backToPairing}
        onUseManualKey={onboarding.setManualMode}
        onSkip={onboarding.skipGate}
      />
    );
  }

  return (
    <ArtifactViewerProvider>
      <DashboardShell onboarding={onboarding} />
    </ArtifactViewerProvider>
  );
}

function inferCategory(name: string): string {
  const lower = name.toLowerCase();
  if (/market|email|campaign|content|brand/.test(lower)) return 'Marketing';
  if (/product|feature|ux|discovery/.test(lower)) return 'Product';
  if (/engineer|infra|platform|api|backend|frontend|dev/.test(lower)) return 'Engineering';
  return 'Program';
}

function phaseTemplateForCategory(category: string): string[] {
  if (category === 'Marketing') return ['Brief', 'Draft', 'Review', 'Ship'];
  if (category === 'Engineering') return ['Spec', 'Dev', 'QA', 'Deploy'];
  if (category === 'Product') return ['Brief', 'Define', 'Build', 'Ship'];
  return ['Plan', 'Build', 'Review', 'Ship'];
}

function initiativePriorityRank(priority: string | null | undefined): number {
  const normalized = (priority ?? '').trim().toLowerCase();
  if (!normalized) return 4;
  if (normalized === 'critical' || normalized === 'p0' || normalized === 'urgent') return 0;
  if (normalized === 'high' || normalized === 'p1') return 1;
  if (normalized === 'medium' || normalized === 'normal' || normalized === 'p2') return 2;
  if (normalized === 'low' || normalized === 'p3') return 3;
  return 4;
}

function isVisibleInitiativeStatus(rawStatus: string | null | undefined): boolean {
  const normalized = (rawStatus ?? '').trim().toLowerCase();
  if (!normalized) return true;
  return !['deleted', 'archived', 'cancelled'].includes(normalized);
}

function OrgXLogo() {
  return (
    <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg border border-strong bg-white/[0.04] p-0.5">
      <img src={orgxLogo} alt="OrgX" className="h-full w-full rounded-md object-contain" />
    </span>
  );
}

function DeferredArtifactViewerModal() {
  const { state } = useArtifactViewer();
  if (!state.artifactId) return null;
  return (
    <Suspense fallback={null}>
      <LazyArtifactViewerModal />
    </Suspense>
  );
}

type EntityModalState = {
  type: 'initiative' | 'workstream';
  initiativeId?: string | null;
} | null;

function DashboardShell({
  onboarding,
}: {
  onboarding: OnboardingController;
}) {
  const [demoMode, setDemoMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') === '1') return true;
    try {
      return window.localStorage.getItem(DEMO_MODE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [showSyntheticEntities, setShowSyntheticEntities] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(SHOW_SYNTHETIC_ENTITIES_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [devMode, setDevMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(DEV_MODE_KEY) === '1';
    } catch {
      return false;
    }
  });

  // Dashboard view toggle: Activity (3-column) vs Mission Control
  const [dashboardView, setDashboardView] = useState<DashboardView>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('view') === 'mission-control') return 'mission-control';
    try {
      if (localStorage.getItem('orgx-dashboard-view') === 'mission-control') return 'mission-control';
    } catch {
      // ignore
    }
    return 'activity';
  });
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(() =>
    parseWorkspaceIdFromLocation()
  );

  const switchDashboardView = useCallback((v: DashboardView) => {
    setDashboardView(v);
    try {
      localStorage.setItem('orgx-dashboard-view', v);
    } catch {
      // ignore
    }
  }, []);

  const { data: workspaceOptions = [] } = useQuery<WorkspaceOption[]>({
    queryKey: ['workspace-options', demoMode ? 'demo' : 'live'],
    queryFn: async () => {
      if (demoMode) return [];
      const response = await fetch('/orgx/api/entities?type=command_center&limit=50');
      if (!response.ok) return [];
      const json = (await response.json().catch(() => null)) as {
        data?: Array<Record<string, unknown>>;
      } | null;
      const rows = Array.isArray(json?.data) ? json.data : [];
      const options: WorkspaceOption[] = [];
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        const id = pickString(row, ['id']);
        if (!id) continue;
        const status = pickString(row, ['status', 'priority']);
        if (!isVisibleProjectStatus(status)) continue;
        const rawTitle =
          pickString(row, ['title', 'name']) ??
          (id.length > 10 ? `${id.slice(0, 8)}…` : id);
        const isDefault = row.is_default === true;
        const title = normalizeWorkspaceTitle({ title: rawTitle, isDefault });
        const createdAt = pickString(row, ['created_at']);
        options.push({ id, title, status, isDefault, createdAt });
      }
      options.sort((a, b) => {
        if (a.isDefault !== b.isDefault) {
          return a.isDefault ? -1 : 1;
        }
        const createdDelta = toEpoch(a.createdAt) - toEpoch(b.createdAt);
        if (createdDelta !== 0) return createdDelta;
        return a.title.localeCompare(b.title);
      });
      return options;
    },
    staleTime: 60_000,
  });

  const selectedWorkspaceLabel = useMemo(() => {
    if (!selectedWorkspaceId) return 'All workspaces';
    return (
      workspaceOptions.find((option) => option.id === selectedWorkspaceId)?.title ??
      `Workspace ${selectedWorkspaceId.slice(0, 8)}`
    );
  }, [selectedWorkspaceId, workspaceOptions]);
  const workspaceSelectOptions = useMemo<WorkspaceOption[]>(() => {
    if (!selectedWorkspaceId) return workspaceOptions;
    if (workspaceOptions.some((option) => option.id === selectedWorkspaceId)) {
      return workspaceOptions;
    }
    return [
      {
        id: selectedWorkspaceId,
        title: selectedWorkspaceLabel,
        status: null,
        isDefault: false,
        createdAt: null,
      },
      ...workspaceOptions,
    ];
  }, [selectedWorkspaceId, selectedWorkspaceLabel, workspaceOptions]);
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    if (workspaceOptions.length === 0) return;
    if (workspaceOptions.some((option) => option.id === selectedWorkspaceId)) return;
    setSelectedWorkspaceId(null);
  }, [selectedWorkspaceId, workspaceOptions]);

  const shouldAttemptDecisions =
    demoMode || (onboarding.state.hasApiKey && onboarding.state.connectionVerified);

  const liveDataOptions = useMemo(() => {
    if (dashboardView === 'mission-control') {
      return {
        maxSessions: 240,
        maxActivityItems: 120,
        maxHandoffs: 60,
        maxDecisions: 80,
        batchWindowMs: 140,
      };
    }
    return {
      maxSessions: 320,
      maxActivityItems: 80,
      maxHandoffs: 80,
      maxDecisions: 80,
      batchWindowMs: 120,
    };
  }, [dashboardView]);

  const {
    data,
    isLoading,
    error,
    refetch,
    approveDecision,
    rejectDecision,
    approveAllDecisions,
    bulkDecisionAction,
    decisionMutation,
  } = useLiveData({
    useMock: demoMode,
    enabled: true,
    enableDecisions: true,
    projectId: selectedWorkspaceId,
    ...liveDataOptions,
  });
  const includeSyntheticEntities = demoMode || showSyntheticEntities;
  const sessionNodesInScope = useMemo(
    () =>
      includeSyntheticEntities
        ? data.sessions.nodes
        : data.sessions.nodes.filter((node) => !isSyntheticSessionNode(node)),
    [data.sessions.nodes, includeSyntheticEntities]
  );
  const activityInScope = useMemo(
    () =>
      data.activity.filter((item) => {
        if (!includeSyntheticEntities && isSyntheticActivityItem(item)) return false;
        if (!devMode && isMockActivityItem(item)) return false;
        return true;
      }),
    [data.activity, includeSyntheticEntities, devMode]
  );
  const decisionsVisible =
    data.connection === 'connected' || data.decisions.length > 0;
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionDrawerOpen, setSessionDrawerOpen] = useState(false);
  const [interventionDraft, setInterventionDraft] = useState<{
    workstreamId: string | null;
    text: string;
  } | null>(null);
  const [activityFilterSessionId, setActivityFilterSessionId] = useState<string | null>(null);
  const [activityFilterWorkstreamId, setActivityFilterWorkstreamId] = useState<string | null>(null);
  const [activityFilterWorkstreamLabel, setActivityFilterWorkstreamLabel] = useState<string | null>(null);
  const [activityTimeFilterId, setActivityTimeFilterId] =
    useState<ActivityTimeFilterId>('24h');
  const [activityCustomTimeRange, setActivityCustomTimeRange] = useState<{
    startIso: string | null;
    endIso: string | null;
  }>({
    startIso: null,
    endIso: null,
  });
  const autoResolvedActivityFilterScopesRef = useRef<Set<string>>(new Set());
  const [requestedActivityItemId, setRequestedActivityItemId] = useState<string | null>(null);
  const [requestedDecisionId, setRequestedDecisionId] = useState<string | null>(null);
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [opsNotice, setOpsNotice] = useState<string | null>(null);
  const opsNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showOpsNotice = useCallback((msg: string) => {
    if (opsNoticeTimerRef.current) clearTimeout(opsNoticeTimerRef.current);
    setOpsNotice(msg);
    opsNoticeTimerRef.current = setTimeout(() => setOpsNotice(null), 4000);
  }, []);
  const [sidebarAutopilotBusy, setSidebarAutopilotBusy] = useState(false);
  const [notificationTrayOpen, setNotificationTrayOpen] = useState(false);
  const [dismissedNotificationIds, setDismissedNotificationIds] = useState<string[]>([]);
  const notificationButtonRef = useRef<HTMLButtonElement | null>(null);
  const notificationTrayRef = useRef<HTMLDivElement | null>(null);
  const [settingsState, setSettingsState] = useState<{
    open: boolean;
    tab: SettingsTab;
    focusAgentDomain: AgentSuiteDomain | null;
  }>({
    open: false,
    tab: 'orgx',
    focusAgentDomain: null,
  });
  const [realtimeOrchestratorOpen, setRealtimeOrchestratorOpen] = useState(false);
  const [bulkModal, setBulkModal] = useState<
    BulkSessionsMode | 'decisions' | 'outbox' | 'handoffs' | null
  >(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>('activity');
  const [expandedRightPanel, setExpandedRightPanel] = useState<string>('initiatives');
  const [initiativesSidebarTab, setInitiativesSidebarTab] = useState<'in_progress' | 'next_up'>(
    'next_up'
  );
  const handleMobileTabChange = useCallback((tab: MobileTab) => {
    setMobileTab(tab);
    if (tab === 'initiatives') {
      setExpandedRightPanel('initiatives');
      setInitiativesSidebarTab('next_up');
      return;
    }
    if (tab === 'decisions') {
      setExpandedRightPanel('initiatives');
      setInitiativesSidebarTab('in_progress');
      setInProgressSubFilter('needs_attention');
    }
  }, []);
  const [inProgressSubFilter, setInProgressSubFilter] = useState<'all' | 'needs_attention'>('all');
  const actionableSliceRuns = useMemo<SliceRunProjection[]>(
    () => (Array.isArray(data.sliceRuns) ? data.sliceRuns : []),
    [data.sliceRuns]
  );
  const inProgressRows = useMemo(
    () =>
      selectInProgressRows({
        sessions: sessionNodesInScope,
        sliceRuns: actionableSliceRuns,
      }),
    [actionableSliceRuns, sessionNodesInScope]
  );
  const inProgressCount = inProgressRows.length;
  const needsInputRows = useMemo(
    () => selectNeedsInputRows(actionableSliceRuns),
    [actionableSliceRuns]
  );
  const needsInputCount = needsInputRows.length + (decisionsVisible ? data.decisions.length : 0);

  const [sliceDetailTarget, setSliceDetailTarget] = useState<SliceDetailTarget | null>(null);

  const openSliceDetailFromQueue = useCallback(
    (item: NextUpQueueItem) => {
      const linked =
        actionableSliceRuns.find(
          (sr) =>
            sr.initiativeId === item.initiativeId &&
            sr.workstreamId === item.workstreamId
        ) ?? null;
      setSliceDetailTarget({ source: 'queue', item, linkedSliceRun: linked });
    },
    [actionableSliceRuns]
  );

  const openSliceDetailFromInProgress = useCallback(
    (row: InProgressRow, sliceRun: SliceRunProjection | null) => {
      setSliceDetailTarget({ source: 'in_progress', row, sliceRun });
    },
    []
  );

  const openSliceDetailFromNeedsInput = useCallback((sliceRun: SliceRunProjection) => {
    console.debug('[NeedsInput] openSliceDetail', { sliceRunId: sliceRun.sliceRunId, status: sliceRun.status });
    setSliceDetailTarget({ source: 'needs_input', sliceRun });
  }, []);

  // Called by SliceDetailModal AFTER it has already completed the accept fetch.
  // This callback handles side effects only (notice + data refetch).
  const handleAcceptSlice = useCallback(async (_sliceRun: SliceRunProjection, _note?: string) => {
    showOpsNotice('Slice accepted and marked complete.');
    void refetch();
  }, [refetch, showOpsNotice]);

  // Called by SliceDetailModal AFTER it has already completed the reject fetch.
  // This callback handles side effects only (notice).
  const handleRejectSlice = useCallback(async (_sliceRun: SliceRunProjection, _note: string) => {
    showOpsNotice('Changes requested — feedback posted.');
  }, [showOpsNotice]);

  const handleResolveDecision = useCallback(
    async (decisionId: string, choice: string, note?: string) => {
      await approveDecision(decisionId, { optionId: choice, ...(note ? { note } : {}) });
      showOpsNotice('Decision resolved.');
    },
    [approveDecision, showOpsNotice]
  );

  const sharedNextUpQueue = useNextUpQueue({
    projectId: selectedWorkspaceId,
    limit: 40,
    authToken: null,
    embedMode: false,
    enabled: true,
    snapshotVersion: data.snapshotVersion,
  });
  const sharedNextUpActions = useNextUpQueueActions({ authToken: null, embedMode: false });

  // Triage queue
  const { model: triageModel, actions: triageActions } = useTriageQueue({
    enabled: true,
    workspaceId: selectedWorkspaceId,
    authToken: null,
    embedMode: false,
  });
  const triageDiagnosticsItems = useMemo(
    () => triageModel.items.filter((item) => item.kind === 'failure_diagnostic'),
    [triageModel.items]
  );
  const triageDiagnosticsModel = useMemo(
    () => ({
      ...triageModel,
      items: triageDiagnosticsItems,
      total: triageDiagnosticsItems.length,
    }),
    [triageDiagnosticsItems, triageModel]
  );
  const [triageDetailItem, setTriageDetailItem] = useState<import('@/types').LiveTriageItem | null>(null);
  const [triageDetailIndex, setTriageDetailIndex] = useState(0);

  const openTriageDetail = useCallback((item: import('@/types').LiveTriageItem) => {
    setTriageDetailItem(item);
    const idx = triageDiagnosticsItems.findIndex((i) => i.id === item.id);
    setTriageDetailIndex(idx >= 0 ? idx : 0);
  }, [triageDiagnosticsItems]);

  const navigateTriageDetail = useCallback((direction: 1 | -1) => {
    if (triageDiagnosticsItems.length === 0) return;
    const nextIdx =
      (triageDetailIndex + direction + triageDiagnosticsItems.length) % triageDiagnosticsItems.length;
    setTriageDetailIndex(nextIdx);
    setTriageDetailItem(triageDiagnosticsItems[nextIdx] ?? null);
  }, [triageDetailIndex, triageDiagnosticsItems]);

  const activityNextUpQueue = sharedNextUpQueue;
  const activityAutopilotContext = useMemo<{
    item: NextUpQueueItem;
    state: 'running' | 'stopping' | 'blocked';
  } | null>(() => {
    const candidates = sharedNextUpQueue.items.filter((item) => item.autoContinue);
    if (candidates.length === 0) return null;
    const byRecency = [...candidates].sort(
      (left, right) => autoContinueUpdatedEpoch(right) - autoContinueUpdatedEpoch(left)
    );
    const active =
      byRecency.find(
        (item) =>
          item.autoContinue?.status === 'running' ||
          item.autoContinue?.status === 'stopping'
      ) ?? null;
    if (active) {
      return {
        item: active,
        state:
          active.autoContinue?.status === 'stopping'
            ? ('stopping' as const)
            : ('running' as const),
      };
    }
    const blocked =
      byRecency.find(
        (item) =>
          item.autoContinue?.stopReason === 'blocked' ||
          item.autoContinue?.stopReason === 'error'
      ) ?? null;
    if (blocked) {
      return {
        item: blocked,
        state: 'blocked' as const,
      };
    }
    return null;
  }, [sharedNextUpQueue.items]);
  const activityAutopilotRun = activityAutopilotContext?.item ?? null;
  const activityAutopilotState: 'idle' | 'running' | 'stopping' | 'blocked' =
    activityAutopilotContext?.state ?? 'idle';
  const activityAutopilotActive =
    activityAutopilotState === 'running' || activityAutopilotState === 'stopping';
  const activityAutopilotButtonState =
    activityAutopilotState === 'blocked'
      ? 'blocked'
      : activityAutopilotActive
        ? 'active'
        : 'idle';
  const activityAutopilotBadgeLabel =
    activityAutopilotState === 'blocked'
      ? 'Hold'
      : activityAutopilotActive
        ? 'On'
        : 'Off';
  const activityAutopilotButtonTitle =
    activityAutopilotState === 'blocked'
      ? 'Resolve blockers, then resume autopilot'
      : activityAutopilotActive
        ? 'Stop autopilot'
        : 'Start autopilot';
  const activityAutopilotTone =
    activityAutopilotState === 'blocked' ? 'amber' : 'teal';

  const agentPanelAutopilotState = useMemo(() => {
    if (!activityAutopilotRun) return null;
    return {
      state: activityAutopilotState,
      reason:
        activityAutopilotRun.autoContinue?.stopReason ??
        activityAutopilotRun.blockReason ??
        null,
      activeRunId: activityAutopilotRun.autoContinue?.activeRunId ?? null,
      activeWorkstreamTitle: activityAutopilotRun.workstreamTitle ?? null,
    };
  }, [activityAutopilotRun, activityAutopilotState]);

  // Allow "In Progress" tab even when count is 0 — show empty state instead of force-redirect

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (demoMode) {
        window.localStorage.setItem(DEMO_MODE_KEY, '1');
      } else {
        window.localStorage.removeItem(DEMO_MODE_KEY);
      }
    } catch {
      // ignore
    }
  }, [demoMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (showSyntheticEntities) {
        window.localStorage.setItem(SHOW_SYNTHETIC_ENTITIES_KEY, '1');
      } else {
        window.localStorage.removeItem(SHOW_SYNTHETIC_ENTITIES_KEY);
      }
    } catch {
      // ignore
    }
  }, [showSyntheticEntities]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (devMode) {
        window.localStorage.setItem(DEV_MODE_KEY, '1');
      } else {
        window.localStorage.removeItem(DEV_MODE_KEY);
      }
    } catch {
      // ignore
    }
  }, [devMode]);

  useEffect(() => {
    if (devMode) return;
    setRealtimeOrchestratorOpen(false);
  }, [devMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (selectedWorkspaceId) {
        window.localStorage.setItem(SELECTED_WORKSPACE_ID_KEY, selectedWorkspaceId);
      } else {
        window.localStorage.removeItem(SELECTED_WORKSPACE_ID_KEY);
      }
    } catch {
      // ignore
    }
    try {
      const url = new URL(window.location.href);
      if (selectedWorkspaceId) {
        setWorkspaceScopeParams(url.searchParams, selectedWorkspaceId);
      } else {
        clearWorkspaceScopeParams(url.searchParams);
      }
      url.searchParams.delete('initiative');
      url.searchParams.delete('initiative_id');
      url.searchParams.delete('project');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // ignore
    }
  }, [selectedWorkspaceId]);

  const openSettings = useCallback((tab?: SettingsTab, opts?: { focusAgentDomain?: AgentSuiteDomain | null }) => {
    setSettingsState((previous) => ({
      open: true,
      tab: tab ?? previous.tab,
      focusAgentDomain: opts?.focusAgentDomain ?? null,
    }));
  }, []);

  const setDemoModeEnabled = useCallback((next: boolean) => {
    setDemoMode(next);
    if (typeof window === 'undefined') return;
    try {
      const url = new URL(window.location.href);
      if (next) {
        url.searchParams.set('demo', '1');
      } else {
        url.searchParams.delete('demo');
      }
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // ignore
    }
  }, []);

  const handleReconnect = useCallback(() => {
    openSettings('orgx');
  }, [openSettings]);

  const prefetchMissionControl = useCallback(() => {
    void import('@/components/mission-control/MissionControlView');
  }, []);

  // Fetch entity-based initiatives for Mission Control (only when view is active)
  const { data: entityInitiatives } = useEntityInitiatives(
    dashboardView === 'mission-control',
    selectedWorkspaceId
  );
  const { data: liveInitiatives } = useLiveInitiatives(
    dashboardView === 'mission-control',
    selectedWorkspaceId
  );
  const { data: initiativeTombstones = [] } = useQuery<string[]>({
    queryKey: ['initiative-tombstones'],
    queryFn: async () => [],
    initialData: [],
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Entity creation modal state
  const [entityModal, setEntityModal] = useState<EntityModalState>(null);
  const [entityName, setEntityName] = useState('');
  const [entityCreating, setEntityCreating] = useState(false);

  const openEntityModal = useCallback((type: 'initiative' | 'workstream', initiativeId?: string | null) => {
    setEntityModal({ type, initiativeId });
    setEntityName('');
    setEntityCreating(false);
  }, []);

  const closeEntityModal = useCallback(() => {
    setEntityModal(null);
    setEntityName('');
    setEntityCreating(false);
  }, []);

  const clearActivitySessionFilter = useCallback(() => {
    setActivityFilterSessionId(null);
  }, []);

  const clearActivityWorkstreamFilter = useCallback(() => {
    setActivityFilterWorkstreamId(null);
    setActivityFilterWorkstreamLabel(null);
  }, []);

  const clearAgentFilter = useCallback(() => {
    setAgentFilter(null);
  }, []);

  useEffect(() => {
    const firstSessionId = sessionNodesInScope[0]?.id ?? null;
    if (!firstSessionId) {
      if (selectedSessionId !== null) {
        setSelectedSessionId(null);
      }
      return;
    }

    if (selectedSessionId === null) {
      setSelectedSessionId(firstSessionId);
      return;
    }

    const selectedExists = sessionNodesInScope.some((node) => node.id === selectedSessionId);
    if (!selectedExists) {
      setSelectedSessionId(firstSessionId);
    }
  }, [sessionNodesInScope, selectedSessionId]);

  useEffect(() => {
    if (!activityFilterSessionId) return;
    const stillExists = sessionNodesInScope.some((node) => node.id === activityFilterSessionId);
    if (!stillExists) {
      setActivityFilterSessionId(null);
    }
  }, [activityFilterSessionId, sessionNodesInScope]);

  const handleSelectSession = useCallback((sessionId: string) => {
    void import('@/components/sessions/SessionInspector');
    setSelectedSessionId(sessionId);
    setSessionDrawerOpen(true);
    setInterventionDraft(null);
    setActivityFilterSessionId(sessionId);
    setActivityFilterWorkstreamId(null);
    setActivityFilterWorkstreamLabel(null);
  }, []);

  const openInterventionComposer = useCallback((session: SessionTreeNode) => {
    void import('@/components/sessions/SessionInspector');
    setSelectedSessionId(session.id);
    setSessionDrawerOpen(true);
    setActivityFilterSessionId(session.id);
    setActivityFilterWorkstreamId(session.workstreamId ?? null);
    setActivityFilterWorkstreamLabel(session.title);
    setInterventionDraft({
      workstreamId: session.workstreamId ?? null,
      text: `Intervention requested for "${session.title}". `,
    });
    showOpsNotice(`Opened intervention composer for ${session.title}.`);
  }, []);

  const focusActivityRunId = useCallback(
    (runId: string) => {
      const trimmed = runId.trim();
      if (!trimmed) return;
      const session =
        sessionNodesInScope.find((node) => node.runId === trimmed || node.id === trimmed) ?? null;
      if (!session) {
        showOpsNotice('Session not found — it may have ended or not started yet.');
        return;
      }
      handleSelectSession(session.id);
      showOpsNotice(`Focused session: ${session.title}`);
    },
    [sessionNodesInScope, handleSelectSession, showOpsNotice]
  );

  const openActivityItemFromSessionDetail = useCallback(
    (item: LiveActivityItem) => {
      const itemId = item.id?.trim();
      if (!itemId) return;

      const runId = resolveActivityRunId(item);
      if (runId) {
        const session =
          sessionNodesInScope.find((node) => node.runId === runId || node.id === runId) ?? null;
        if (session) {
          setSelectedSessionId(session.id);
          setActivityFilterSessionId(session.id);
        }
      }

      switchDashboardView('activity');
      setMobileTab('activity');
      setSessionDrawerOpen(false);
      setRequestedActivityItemId(itemId);
      showOpsNotice('Opened activity detail from session timeline.');
    },
    [sessionNodesInScope, switchDashboardView]
  );

  const selectedActivitySession = useMemo(
    () => sessionNodesInScope.find((n) => n.id === activityFilterSessionId) ?? null,
    [activityFilterSessionId, sessionNodesInScope]
  );

  const selectedActivityRunIds = useMemo(() => {
    const runId = selectedActivitySession?.runId?.trim() ?? '';
    const nodeId = selectedActivitySession?.id?.trim() ?? '';
    if (!runId || !nodeId) return [];
    return runId === nodeId ? [runId] : [runId, nodeId];
  }, [selectedActivitySession?.id, selectedActivitySession?.runId]);

  const selectedActivityRunIdSet = useMemo(() => {
    const set = new Set<string>();
    for (const value of selectedActivityRunIds) {
      const normalized = value.trim();
      if (normalized.length > 0) {
        set.add(normalized);
      }
    }
    return set;
  }, [selectedActivityRunIds]);

  const activityWorkstreamByRunId = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const node of sessionNodesInScope) {
      const workstreamId = node.workstreamId ?? null;
      if (node.runId) map.set(node.runId, workstreamId);
      if (node.id) map.set(node.id, workstreamId);
    }
    return map;
  }, [sessionNodesInScope]);

  const activityScopeKey = useMemo(() => {
    const runKey = selectedActivityRunIds.length > 0 ? selectedActivityRunIds.join('|') : '*';
    const workstreamKey = activityFilterWorkstreamId?.trim() || '*';
    const agentKey = agentFilter?.trim() || '*';
    return `${runKey}::${workstreamKey}::${agentKey}`;
  }, [activityFilterWorkstreamId, agentFilter, selectedActivityRunIds]);

  const handleActivityTimeFilterChange = useCallback(
    (next: ActivityTimeFilterId) => {
      autoResolvedActivityFilterScopesRef.current.add(activityScopeKey);
      setActivityTimeFilterId(next);
    },
    [activityScopeKey]
  );

  useEffect(() => {
    if (autoResolvedActivityFilterScopesRef.current.has(activityScopeKey)) return;
    if (isLoading) return;

    const now = Date.now();
    const inScopeItems = activityInScope.filter((item) => {
      const runId = resolveActivityRunId(item);
      if (selectedActivityRunIdSet.size > 0) {
        if (!runId || !selectedActivityRunIdSet.has(runId)) return false;
      }

      if (activityFilterWorkstreamId) {
        const metadata = resolveActivityMetadata(item);
        const metadataWorkstreamId = readActivityMetadataString(metadata, [
          'workstreamId',
          'workstream_id',
        ]);
        const resolvedWorkstreamId =
          metadataWorkstreamId ?? (runId ? activityWorkstreamByRunId.get(runId) ?? null : null);
        if (resolvedWorkstreamId !== activityFilterWorkstreamId) return false;
      }

      if (agentFilter) {
        const metadata = resolveActivityMetadata(item);
        const metadataAgent = readActivityMetadataString(metadata, ['agentName', 'agent_name']);
        const resolvedAgent = metadataAgent ?? item.agentName;
        if (resolvedAgent !== agentFilter) return false;
      }

      return true;
    });

    if (inScopeItems.length === 0) return;

    const orderedFilters: ActivityTimeFilterId[] = ['live', '24h', '7d', 'all'];
    const nextFilter =
      orderedFilters.find((filterId) => {
        const cutoff = cutoffEpochForActivityFilter(filterId, now);
        return inScopeItems.some((item) => {
          const epoch = toEpoch(item.timestamp);
          if (!epoch) return false;
          return cutoff === null || epoch >= cutoff;
        });
      }) ?? 'all';

    autoResolvedActivityFilterScopesRef.current.add(activityScopeKey);
    if (nextFilter !== activityTimeFilterId) {
      setActivityTimeFilterId(nextFilter);
    }
  }, [
    activityFilterWorkstreamId,
    activityInScope,
    activityScopeKey,
    activityTimeFilterId,
    activityWorkstreamByRunId,
    agentFilter,
    isLoading,
    selectedActivityRunIdSet,
  ]);

  const activityFeed = useActivityFeed({
    seed: activityInScope,
    timeFilterId: activityTimeFilterId,
    customSinceIso:
      activityTimeFilterId === 'custom' ? activityCustomTimeRange.startIso : null,
    customUntilIso:
      activityTimeFilterId === 'custom' ? activityCustomTimeRange.endIso : null,
    runId: selectedActivitySession?.runId ?? null,
    projectId: selectedWorkspaceId,
    pageSize: 50,
    demoMode,
  });

  const selectedSession = useMemo(
    () => sessionNodesInScope.find((n) => n.id === selectedSessionId) ?? null,
    [sessionNodesInScope, selectedSessionId]
  );

  const activeSessionCount = useMemo(
    () =>
      sessionNodesInScope.filter((node) => ACTIVE_SESSION_METRIC_STATUSES.has(node.status)).length,
    [sessionNodesInScope]
  );

  const blockedCount = useMemo(
    () => {
      if (actionableSliceRuns.length > 0) {
        return needsInputRows.length;
      }
      return sessionNodesInScope.filter((node) => {
        const status = normalizeStatus(node.status);
        const phase = normalizeStatus(node.phase ?? '');
        const state = normalizeStatus(node.state ?? '');
        if (status === 'completed' || status === 'cancelled' || status === 'archived') {
          return false;
        }

        if (status === 'blocked' || status === 'failed' || phase === 'blocked' || state === 'error') {
          return true;
        }
        if (ACTIVE_SESSION_METRIC_STATUSES.has(status) || status === 'handoff' || status === 'review') {
          return false;
        }
        return node.blockers.length > 0;
      }).length;
    },
    [actionableSliceRuns.length, needsInputRows.length, sessionNodesInScope]
  );

  const failedCount = useMemo(
    () => sessionNodesInScope.filter((node) => node.status === 'failed').length,
    [sessionNodesInScope]
  );

  const completedToday = useMemo(
    () => sessionNodesInScope.filter((n) => n.status === 'completed').length,
    [sessionNodesInScope]
  );

  const compactMetrics = useMemo(() => {
    const needsAttention = (decisionsVisible ? data.decisions.length : 0) + blockedCount;
    const metrics: Array<{
      id: string;
      label: string;
      value: number;
      color: string;
      icon: EntityIconType;
    }> = [
      {
        id: 'active',
        label: 'Running',
        value: activeSessionCount,
        color: activeSessionCount > 0 ? colors.lime : colors.textMuted,
        icon: 'active',
      },
      {
        id: 'attention',
        label: 'Needs attention',
        value: needsAttention,
        color: needsAttention > 0 ? colors.amber : colors.textMuted,
        icon: 'decision',
      },
      {
        id: 'completed',
        label: 'Done today',
        value: completedToday,
        color: colors.teal,
        icon: 'session',
      },
    ];
    return metrics;
  }, [
    activeSessionCount,
    blockedCount,
    completedToday,
    data.decisions.length,
    sessionNodesInScope,
    decisionsVisible,
  ]);

  const longestWaitMinutes = useMemo(
    () => data.decisions.length > 0 ? Math.max(0, ...data.decisions.map((d) => d.waitingMinutes)) : 0,
    [data.decisions]
  );
  const liveErrorCopy = useMemo(() => (error ? formatLiveErrorCopy(error) : null), [error]);

  const headerNotifications = useMemo(() => {
    const items: HeaderNotification[] = [];
    if (liveErrorCopy) {
      const useRefresh = liveErrorCopy.action === 'refresh' && typeof refetch === 'function';
      items.push({
        id: `stream-error:${error}`,
        kind: 'error',
        icon: 'notification',
        title: liveErrorCopy.title,
        message: liveErrorCopy.message,
        actionLabel: useRefresh ? 'Refresh' : 'Settings',
        onAction: useRefresh ? () => void refetch() : () => openSettings('orgx'),
      });
    }
    if (data.connection !== 'connected') {
      items.push({
        id: `connection:${data.connection}`,
        kind: data.connection === 'disconnected' ? 'error' : 'info',
        icon: 'notification',
        title: data.connection === 'disconnected' ? 'Connection lost' : 'Reconnecting',
        message:
          data.connection === 'disconnected'
            ? 'Live connection is offline. Initiatives and Next Up may stay stale until reconnect.'
            : 'Live connection is recovering. Fresh updates will resume automatically.',
        actionLabel: 'Reconnect',
        onAction: handleReconnect,
      });
    }
    /* Outbox sync is now invisible — only a subtle amber dot on settings gear when errored */
    if (opsNotice) {
      items.push({
        id: `ops:${opsNotice}`,
        kind: 'info',
        icon: /decision/i.test(opsNotice) ? 'decision' : 'workstream',
        title: 'Update',
        message: opsNotice,
      });
    }
    return items;
  }, [
    data.connection,
    data.outbox.lastReplayError,
    data.outbox.pendingTotal,
    data.outbox.replayStatus,
    error,
    liveErrorCopy,
    handleReconnect,
    refetch,
    openSettings,
    opsNotice,
  ]);

  useEffect(() => {
    const activeIds = new Set(headerNotifications.map((item) => item.id));
    setDismissedNotificationIds((previous) =>
      previous.filter((id) => activeIds.has(id))
    );
  }, [headerNotifications]);

  const visibleNotifications = useMemo(
    () =>
      headerNotifications.filter(
        (item) => !dismissedNotificationIds.includes(item.id)
      ),
    [dismissedNotificationIds, headerNotifications]
  );
  const notificationDecisionCount = decisionsVisible ? data.decisions.length : 0;
  const notificationAttentionCount =
    activeSessionCount + blockedCount + notificationDecisionCount;

  const dismissNotification = useCallback((id: string) => {
    setDismissedNotificationIds((previous) =>
      previous.includes(id) ? previous : previous.concat(id)
    );
  }, []);

  const clearNotifications = useCallback(() => {
    setDismissedNotificationIds(headerNotifications.map((item) => item.id));
  }, [headerNotifications]);

  useEffect(() => {
    if (!notificationTrayOpen) return;

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (notificationTrayRef.current?.contains(target)) return;
      if (notificationButtonRef.current?.contains(target)) return;
      setNotificationTrayOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNotificationTrayOpen(false);
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [notificationTrayOpen]);

  const initiatives = useMemo(() => {
    type InitiativeAccumulator = {
      id: string;
      name: string;
      category: string;
      progressTotal: number;
      progressCount: number;
      statusCounts: Record<string, number>;
      activeAgents: Set<string>;
      allAgents: Set<string>;
      workstreams: Map<string, string>;
      latestEpoch: number;
    };

    const map = new Map<string, InitiativeAccumulator>();

    for (const node of sessionNodesInScope) {
      const id = node.initiativeId ?? node.groupId ?? 'unscoped';
      const name =
        node.groupLabel && node.groupLabel.trim().length > 0
          ? node.groupLabel
          : node.initiativeId ?? 'Unscoped Initiative';
      const category = inferCategory(name);

      const existing = map.get(id) ?? {
        id,
        name,
        category,
        progressTotal: 0,
        progressCount: 0,
        statusCounts: {},
        activeAgents: new Set<string>(),
        allAgents: new Set<string>(),
        workstreams: new Map<string, string>(),
        latestEpoch: 0,
      };

      if (node.progress !== null) {
        existing.progressTotal += node.progress;
        existing.progressCount += 1;
      }
      existing.statusCounts[node.status] = (existing.statusCounts[node.status] ?? 0) + 1;
      if (node.agentName) {
        existing.allAgents.add(node.agentName);
        if (['running', 'queued', 'pending', 'blocked'].includes(node.status)) {
          existing.activeAgents.add(node.agentName);
        }
      }

      if (node.workstreamId) {
        const groupMatch = data.sessions.groups.find(g => g.id === node.workstreamId);
        const wsName = groupMatch?.label?.trim() || node.workstreamId;
        existing.workstreams.set(node.workstreamId, wsName);
      }

      existing.latestEpoch = Math.max(
        existing.latestEpoch,
        toEpoch(node.updatedAt ?? node.lastEventAt ?? node.startedAt)
      );

      map.set(id, existing);
    }

    const output: Initiative[] = [];
    for (const entry of map.values()) {
      const health =
        entry.progressCount > 0
          ? Math.round(entry.progressTotal / entry.progressCount)
          : entry.statusCounts.completed
            ? 100
            : entry.statusCounts.running
              ? 55
              : 0;

      const category = entry.category;
      const phaseNames = phaseTemplateForCategory(category);
      const phasePosition = Math.round((Math.max(0, Math.min(100, health)) / 100) * (phaseNames.length - 1));
      const blocked = (entry.statusCounts.blocked ?? 0) > 0;
      const completed =
        (entry.statusCounts.completed ?? 0) > 0 &&
        (entry.statusCounts.running ?? 0) === 0 &&
        (entry.statusCounts.queued ?? 0) === 0 &&
        (entry.statusCounts.pending ?? 0) === 0 &&
        (entry.statusCounts.blocked ?? 0) === 0 &&
        (entry.statusCounts.paused ?? 0) === 0;
      const paused =
        !completed &&
        !blocked &&
        (entry.statusCounts.paused ?? 0) > 0 &&
        (entry.statusCounts.running ?? 0) === 0 &&
        (entry.statusCounts.queued ?? 0) === 0 &&
        (entry.statusCounts.pending ?? 0) === 0;
      const activeWorkstreams =
        (entry.statusCounts.running ?? 0) +
        (entry.statusCounts.active ?? 0) +
        (entry.statusCounts.in_progress ?? 0);
      const queuedWorkstreams =
        (entry.statusCounts.queued ?? 0) + (entry.statusCounts.pending ?? 0);
      const linkedWorkstreamCount = entry.workstreams.size;
      const linkedWorkstreamLabel = `${linkedWorkstreamCount} workstream${linkedWorkstreamCount === 1 ? '' : 's'}`;
      const description =
        linkedWorkstreamCount === 0
          ? 'No workstreams linked yet.'
          : completed
            ? `${linkedWorkstreamLabel} completed.`
            : blocked
              ? `${linkedWorkstreamLabel} linked · resolve blockers to continue.`
              : paused
                ? `${linkedWorkstreamLabel} linked · initiative is paused.`
                : activeWorkstreams > 0
                  ? `${activeWorkstreams} workstream${activeWorkstreams === 1 ? '' : 's'} active right now.`
                  : queuedWorkstreams > 0
                    ? `${queuedWorkstreams} workstream${queuedWorkstreams === 1 ? '' : 's'} queued to start.`
                    : `${linkedWorkstreamLabel} linked · ready to run.`;

      const phases = phaseNames.map((name, index) => {
        let status: 'completed' | 'current' | 'upcoming' | 'warning' = 'upcoming';
        if (completed || index < phasePosition) status = 'completed';
        if (index === phasePosition && !completed) status = blocked ? 'warning' : 'current';
        return { name, status };
      });

      output.push({
        id: entry.id,
        name: entry.name,
        status: completed ? 'completed' : blocked ? 'blocked' : paused ? 'paused' : 'active',
        rawStatus: completed ? 'completed' : blocked ? 'blocked' : paused ? 'paused' : 'active',
        category,
        health: Math.max(0, Math.min(100, health)),
        phases,
        currentPhase: completed ? phaseNames.length - 1 : phasePosition,
        daysRemaining: 0,
        targetDate: null,
        createdAt: entry.latestEpoch > 0 ? new Date(entry.latestEpoch).toISOString() : null,
        updatedAt: entry.latestEpoch > 0 ? new Date(entry.latestEpoch).toISOString() : null,
        activeAgents: entry.activeAgents.size,
        totalAgents: entry.allAgents.size,
        avatars: Array.from(entry.activeAgents).slice(0, 3),
        description,
        workstreams: Array.from(entry.workstreams.entries()).map(([id, name]) => ({
          id,
          name,
          status: 'active',
        })),
      });
    }

    return output.sort((a, b) => {
      const aPriority = a.status === 'blocked' ? 0 : a.status === 'active' ? 1 : 2;
      const bPriority = b.status === 'blocked' ? 0 : b.status === 'active' ? 1 : 2;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return b.health - a.health;
    });
  }, [sessionNodesInScope, data.sessions.groups]);

  // Merge session-derived + entity-based initiatives for Mission Control
  const mcInitiatives = useMemo(() => {
    const mergeInitiative = (base: Initiative, incoming: Initiative): Initiative => {
      const incomingDescription =
        typeof incoming.description === 'string' && incoming.description.trim().length > 0
          ? incoming.description
          : null;
      const baseDescription =
        typeof base.description === 'string' && base.description.trim().length > 0
          ? base.description
          : null;
      return {
        ...base,
        ...incoming,
        health: incoming.health > 0 ? incoming.health : base.health,
        activeAgents: Math.max(base.activeAgents, incoming.activeAgents),
        totalAgents: Math.max(base.totalAgents, incoming.totalAgents),
        avatars: base.avatars?.length ? base.avatars : incoming.avatars,
        workstreams: base.workstreams?.length ? base.workstreams : incoming.workstreams,
        description: incomingDescription ?? baseDescription ?? undefined,
        rawStatus: incoming.rawStatus ?? base.rawStatus ?? null,
        targetDate: incoming.targetDate ?? base.targetDate ?? null,
        createdAt: incoming.createdAt ?? base.createdAt ?? null,
        updatedAt: incoming.updatedAt ?? base.updatedAt ?? null,
      };
    };

    const merged = new Map<string, Initiative>();
    for (const init of initiatives) merged.set(init.id, init);

    // Apply live snapshot first, then entity records so user-initiated status
    // mutations (pause/resume/delete/archive) win immediately in Mission Control.
    for (const init of [...(liveInitiatives ?? []), ...(entityInitiatives ?? [])]) {
      if (!includeSyntheticEntities && isSyntheticInitiativeId(init.id)) {
        merged.delete(init.id);
        continue;
      }
      const incomingRawStatus = init.rawStatus ?? init.status;
      if (!isVisibleInitiativeStatus(incomingRawStatus)) {
        merged.delete(init.id);
        continue;
      }
      const existing = merged.get(init.id);
      merged.set(init.id, existing ? mergeInitiative(existing, init) : init);
    }

    const tombstoneSet = new Set(initiativeTombstones);
    return Array.from(merged.values())
      .filter((initiative) => !tombstoneSet.has(initiative.id))
      .filter((initiative) =>
        isVisibleInitiativeStatus(initiative.rawStatus ?? initiative.status)
      )
      .sort((a, b) => {
      const statusPriority = (status: Initiative['status']) =>
        status === 'blocked' ? 0 : status === 'active' ? 1 : status === 'paused' ? 2 : 3;
      const statusDelta = statusPriority(a.status) - statusPriority(b.status);
      if (statusDelta !== 0) return statusDelta;

      const priorityDelta = initiativePriorityRank(a.priority) - initiativePriorityRank(b.priority);
      if (priorityDelta !== 0) return priorityDelta;

      const updatedDelta = toEpoch(b.updatedAt) - toEpoch(a.updatedAt);
      if (updatedDelta !== 0) return updatedDelta;

      const healthDelta = b.health - a.health;
      if (healthDelta !== 0) return healthDelta;

      return a.name.localeCompare(b.name);
    });
  }, [
    initiatives,
    entityInitiatives,
    includeSyntheticEntities,
    liveInitiatives,
    initiativeTombstones,
  ]);

  const initiativeNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const init of mcInitiatives) {
      if (init.id && init.name) {
        map[init.id] = init.name;
      }
    }
    return map;
  }, [mcInitiatives]);

  const selectedActivitySessionLabel = useMemo(() => {
    if (!selectedActivitySession) return null;

    const agentName = selectedActivitySession.agentName;
    const title = selectedActivitySession.title;

    // Try agent name first
    if (agentName) {
      // Find latest activity summary for this session
      const latestActivity = activityInScope.find(
        (a) => a.runId === selectedActivitySession.runId && a.summary?.trim()
      );
      if (latestActivity?.summary) {
        const truncated = latestActivity.summary.trim().length > 40
          ? latestActivity.summary.trim().slice(0, 40) + '…'
          : latestActivity.summary.trim();
        return `${agentName}: ${truncated}`;
      }
      return agentName;
    }

    // Strip protocol prefixes from title
    if (title) {
      const stripped = title.replace(/^(telegram|slack|discord|whatsapp|email|sms):/, '').trim();
      if (stripped.length > 0) return stripped;
    }

    return title ?? null;
  }, [activityInScope, selectedActivitySession]);

  const missionControlAgents = useMemo<Agent[]>(() => {
    const byAgentId = new Map<string, Agent>();

    for (const node of sessionNodesInScope) {
      const id = (node.agentId ?? '').trim() || `name:${(node.agentName ?? '').trim()}`;
      const name = (node.agentName ?? '').trim() || (node.agentId ?? '').trim();
      if (!name) continue;

      const lastActiveIso = node.updatedAt ?? node.lastEventAt ?? node.startedAt ?? new Date().toISOString();
      const lastActiveEpoch = toEpoch(lastActiveIso);
      const lastActiveMinutes = lastActiveEpoch
        ? Math.max(0, Math.floor((Date.now() - lastActiveEpoch) / 60_000))
        : 0;

      const existing = byAgentId.get(id);
      const candidate: Agent = {
        id,
        name,
        role: 'Agent',
        status: toAgentStatus(node.status),
        task: node.title ?? null,
        progress: node.progress ?? null,
        lastActive: lastActiveIso,
        lastActiveMinutes,
      };

      if (!existing || toEpoch(candidate.lastActive) > toEpoch(existing.lastActive)) {
        byAgentId.set(id, candidate);
      }
    }

    return Array.from(byAgentId.values());
  }, [sessionNodesInScope]);

  const continueHighestPriority = useCallback(async () => {
    if (sessionNodesInScope.length === 0) {
      showOpsNotice('No sessions available to continue.');
      return;
    }

    const target = [...sessionNodesInScope].sort(compareSessionPriority)[0];
    setSelectedSessionId(target.id);
    setActivityFilterSessionId(target.id);
    setActivityFilterWorkstreamId(null);
    setActivityFilterWorkstreamLabel(null);

    if (['blocked', 'pending', 'queued'].includes(target.status)) {
      try {
        await fetch(`/orgx/api/runs/${encodeURIComponent(target.runId)}/actions/resume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'continue_from_dashboard' }),
        });
      } catch {
        // Non-blocking: focusing the session is still useful even if resume fails.
      }
    }

    showOpsNotice(`Focused highest priority session: ${target.title}`);
    await refetch();
  }, [sessionNodesInScope, refetch]);

  const readApiErrorMessage = useCallback(
    async (response: Response, fallback: string): Promise<string> => {
      const body = (await response.json().catch(() => null)) as
        | { error?: string; message?: string }
        | null;
      const message =
        (typeof body?.error === 'string' && body.error.trim()) ||
        (typeof body?.message === 'string' && body.message.trim()) ||
        `${fallback} (${response.status})`;
      if (/unknown api endpoint/i.test(message)) {
        return `${fallback}. This route is unavailable in the running plugin build.`;
      }
      return humanizeWarning(message);
    },
    []
  );

  const formatOpsNoticeError = useCallback(
    (raw: string | null | undefined, fallback: string): string => {
      if (!raw || raw.trim().length === 0) return fallback;
      return humanizeWarning(raw.trim()) || fallback;
    },
    []
  );

  const playNextUpFromActivity = useCallback(async () => {
    const candidate = selectStartableQueueItem(sharedNextUpQueue.items);
    if (!candidate) {
      showOpsNotice('No startable Next Up workstream is available.');
      switchDashboardView('mission-control');
      return;
    }

    await sharedNextUpQueue.playWorkstream({
      initiativeId: candidate.initiativeId,
      workstreamId: candidate.workstreamId,
      agentId: candidate.runnerAgentId,
    });

    setActivityFilterSessionId(null);
    setActivityFilterWorkstreamId(candidate.workstreamId);
    setActivityFilterWorkstreamLabel(candidate.workstreamTitle);
    setAgentFilter(null);
    showOpsNotice(`Dispatched Next Up: ${candidate.workstreamTitle}`);
    await Promise.all([sharedNextUpQueue.refetch(), refetch()]);
  }, [refetch, sharedNextUpQueue, switchDashboardView]);

  const startAutopilotFromActivity = useCallback(
    async (preferredInitiativeId: string | null = null) => {
      const candidate = selectStartableQueueItem(
        sharedNextUpQueue.items,
        preferredInitiativeId
      );
      if (!candidate) {
        showOpsNotice('No startable initiative is ready for Autopilot yet.');
        switchDashboardView('mission-control');
        return;
      }

      await sharedNextUpActions.move({
        initiativeId: candidate.initiativeId,
        workstreamId: candidate.workstreamId,
        placement: 'top',
      });
      await sharedNextUpQueue.startWorkstreamAutoContinue({
        initiativeId: candidate.initiativeId,
        workstreamId: candidate.workstreamId,
        agentId: candidate.runnerAgentId,
        scope: 'initiative',
      });

      // Preserve existing activity filters so the feed doesn't flash empty
      // while autopilot initializes. Only clear session filter since the
      // user is starting a new run, not viewing a prior session.
      setActivityFilterSessionId(null);
      showOpsNotice(
        `Autopilot started for ${candidate.initiativeTitle}; queued from ${candidate.workstreamTitle}.`
      );
      await Promise.all([sharedNextUpQueue.refetch(), refetch()]);
    },
    [refetch, sharedNextUpActions, sharedNextUpQueue, switchDashboardView]
  );

  const toggleSidebarAutopilot = useCallback(async () => {
    setSidebarAutopilotBusy(true);
    try {
      if (!activityAutopilotRun || !activityAutopilotActive) {
        const preferredInitiativeId =
          activityAutopilotState === 'blocked'
            ? activityAutopilotRun?.initiativeId ?? null
            : null;
        await startAutopilotFromActivity(preferredInitiativeId);
        return;
      }
      await sharedNextUpQueue.stopInitiativeAutoContinue({
        initiativeId: activityAutopilotRun.initiativeId,
      });

      showOpsNotice(`Autopilot stopped for ${activityAutopilotRun.initiativeTitle}.`);
      await Promise.all([sharedNextUpQueue.refetch(), refetch()]);
    } finally {
      setSidebarAutopilotBusy(false);
    }
  }, [
    activityAutopilotActive,
    activityAutopilotRun,
    activityAutopilotState,
    refetch,
    sharedNextUpQueue,
    startAutopilotFromActivity,
  ]);

  const playSessionWorkstream = useCallback(
    async (session: SessionTreeNode) => {
      const initiativeId = (session.initiativeId ?? '').trim();
      const workstreamId = (session.workstreamId ?? '').trim();
      if (!initiativeId || !workstreamId) {
        throw new Error('Missing initiative/workstream metadata for this session.');
      }

      const response = await fetch('/orgx/api/mission-control/next-up/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initiativeId,
          workstreamId,
          agentId: session.agentId ?? undefined,
          fastAck: true,
          ignoreSpawnGuardRateLimit: true,
        }),
      });
      if (!response.ok) {
        throw new Error(
          await readApiErrorMessage(response, 'Failed to dispatch workstream from In Progress')
        );
      }

      setActivityFilterSessionId(null);
      setActivityFilterWorkstreamId(workstreamId);
      setActivityFilterWorkstreamLabel(session.title);
      showOpsNotice(`Dispatched ${session.title}.`);
      await Promise.all([sharedNextUpQueue.refetch(), refetch()]);
    },
    [readApiErrorMessage, refetch, sharedNextUpQueue]
  );

  const pauseSessionWorkstream = useCallback(
    async (session: SessionTreeNode) => {
      const initiativeId = (session.initiativeId ?? '').trim();
      const workstreamId = (session.workstreamId ?? '').trim();
      if (!initiativeId || !workstreamId) {
        throw new Error('Missing initiative/workstream metadata for this session.');
      }

      const response = await fetch('/orgx/api/mission-control/next-up/triage/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initiativeId,
          workstreamId,
          placement: 'bottom',
          resetToTodo: false,
        }),
      });

      if (!response.ok) {
        const message = await readApiErrorMessage(
          response,
          'Failed to pause workstream from In Progress'
        );
        if (!/running plugin build/i.test(message)) {
          throw new Error(message);
        }

        const fallback = await fetch('/orgx/api/mission-control/auto-continue/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initiativeId }),
        });
        if (!fallback.ok) {
          throw new Error(
            await readApiErrorMessage(
              fallback,
              'Failed to pause workstream using legacy fallback'
            )
          );
        }
      }

      showOpsNotice(`Paused ${session.title} and sent it to the bottom of queue.`);
      await Promise.all([sharedNextUpQueue.refetch(), refetch()]);
    },
    [readApiErrorMessage, refetch, sharedNextUpQueue]
  );

  const submitSessionIntervention = useCallback(
    async (input: { session: SessionTreeNode; workstreamId: string | null; text: string }) => {
      const workstreamId = (input.workstreamId ?? '').trim();
      if (!workstreamId) {
        throw new Error('This session is missing a workstream id for intervention notes.');
      }
      const interventionText = input.text.trim();
      if (isConfigureEngineeringAgentIntent(interventionText)) {
        openSettings('agents', { focusAgentDomain: 'engineering' });
        showOpsNotice('Opened agent settings for engineering runtime configuration.');
        return;
      }
      const response = await fetch(
        `/orgx/api/entities/workstream/${encodeURIComponent(workstreamId)}/comments`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: interventionText,
            commentType: 'intervention',
            severity: 'info',
            tags: ['intervention', 'in_progress'],
          }),
        }
      );
      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, 'Failed to submit intervention'));
      }
      showOpsNotice(`Intervention sent for ${input.session.title}.`);
      await refetch();
    },
    [openSettings, readApiErrorMessage, refetch]
  );

  const dispatchSession = useCallback(
    async (session: SessionTreeNode) => {
      setSelectedSessionId(session.id);
      setActivityFilterSessionId(session.id);
      setActivityFilterWorkstreamId(null);
      setActivityFilterWorkstreamLabel(null);

      if (!['running', 'completed', 'archived'].includes(session.status)) {
        try {
          await fetch(`/orgx/api/runs/${encodeURIComponent(session.runId)}/actions/resume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'dispatch_from_dashboard' }),
          });
        } catch {
          // Keep UI responsive even if resume endpoint is unavailable.
        }
      }

      showOpsNotice(`Dispatch requested: ${session.title}`);
      await refetch();
    },
    [refetch]
  );

  const runControlAction = useCallback(
    async (
      session: SessionTreeNode,
      action: 'pause' | 'resume' | 'cancel' | 'rollback' | 'complete',
      payload: Record<string, unknown> = {}
    ) => {
      const response = await fetch(
        `/orgx/api/runs/${encodeURIComponent(session.runId)}/actions/${action}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `${action} failed (${response.status})`);
      }
    },
    []
  );

  const createSessionCheckpoint = useCallback(
    async (session: SessionTreeNode) => {
      const response = await fetch(
        `/orgx/api/runs/${encodeURIComponent(session.runId)}/checkpoints`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'dashboard_manual_checkpoint' }),
        }
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Checkpoint creation failed (${response.status})`);
      }

      const body = (await response.json().catch(() => null)) as
        | { data?: { id?: string } }
        | { id?: string }
        | null;
      const checkpointId =
        (body && 'data' in body && body.data?.id) ||
        (body && 'id' in body && body.id) ||
        null;

      showOpsNotice(
        checkpointId
          ? `Checkpoint created: ${checkpointId.slice(0, 8)}`
          : 'Checkpoint created.'
      );
      await refetch();
    },
    [refetch]
  );

  const pauseSession = useCallback(
    async (session: SessionTreeNode) => {
      await runControlAction(session, 'pause', { reason: 'pause_from_dashboard' });
      showOpsNotice(`Pause requested: ${session.title}`);
      await refetch();
    },
    [refetch, runControlAction]
  );

  const resumeSession = useCallback(
    async (session: SessionTreeNode) => {
      await runControlAction(session, 'resume', { reason: 'resume_from_dashboard' });
      showOpsNotice(`Resume requested: ${session.title}`);
      await refetch();
    },
    [refetch, runControlAction]
  );

  const restartSessionWorkstream = useCallback(
    async (session: SessionTreeNode) => {
      await runControlAction(session, 'cancel', { reason: 'restart_from_in_progress' });
      await playSessionWorkstream(session);
      showOpsNotice(`Restarted ${session.title}.`);
      await refetch();
    },
    [playSessionWorkstream, refetch, runControlAction]
  );

  const cancelSession = useCallback(
    async (session: SessionTreeNode) => {
      await runControlAction(session, 'cancel', { reason: 'cancel_from_dashboard' });
      showOpsNotice(`Cancel requested: ${session.title}`);
      await refetch();
    },
    [refetch, runControlAction]
  );

  const rollbackSession = useCallback(
    async (session: SessionTreeNode) => {
      const listResponse = await fetch(
        `/orgx/api/runs/${encodeURIComponent(session.runId)}/checkpoints`,
        {
          method: 'GET',
        }
      );
      if (!listResponse.ok) {
        const body = (await listResponse.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Checkpoint list failed (${listResponse.status})`);
      }

      const body = (await listResponse.json().catch(() => null)) as
        | { data?: Array<Record<string, unknown>> }
        | Array<Record<string, unknown>>
        | null;
      const records = Array.isArray(body)
        ? body
        : Array.isArray(body?.data)
          ? body.data
          : [];
      const checkpoints = records
        .map((row) => ({
          id: typeof row.id === 'string' ? row.id : '',
          createdAt:
            typeof row.createdAt === 'string'
              ? row.createdAt
              : typeof row.created_at === 'string'
                ? row.created_at
                : '',
        }))
        .filter((row) => row.id.length > 0)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

      const checkpointId = checkpoints[0]?.id;
      if (!checkpointId) {
        throw new Error('No checkpoint available for rollback.');
      }

      await runControlAction(session, 'rollback', {
        checkpointId,
        reason: 'rollback_from_dashboard',
      });
      showOpsNotice(`Rollback requested for ${session.title}.`);
      await refetch();
    },
    [refetch, runControlAction]
  );

  const confirmCreateEntity = useCallback(async () => {
    if (!entityModal || entityName.trim().length === 0 || entityCreating) return;

    setEntityCreating(true);
    const type = entityModal.type;
    const title = entityName.trim();

    try {
      const payload: Record<string, unknown> = {
        type,
        title,
        status: 'active',
      };

      if (type === 'workstream') {
        const parentInitiative =
          entityModal.initiativeId ?? selectedSession?.initiativeId ?? initiatives[0]?.id ?? null;
        if (!parentInitiative) {
          showOpsNotice('Select an initiative first to start a workstream.');
          setEntityCreating(false);
          return;
        }
        payload.initiative_id = parentInitiative;
        payload.parentId = parentInitiative;
      }

      const response = await fetch('/orgx/api/entities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const payloadError = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payloadError?.error ?? `Failed to create ${type}.`);
      }

      showOpsNotice(`Created ${type}: ${title}`);
      closeEntityModal();
      await refetch();
    } catch (err) {
      showOpsNotice(
        formatOpsNoticeError(err instanceof Error ? err.message : '', `Failed to create ${type}.`)
      );
      setEntityCreating(false);
    }
  }, [closeEntityModal, entityCreating, entityModal, entityName, initiatives, refetch, selectedSession?.initiativeId]);

  const startInitiative = useCallback(() => {
    openEntityModal('initiative');
  }, [openEntityModal]);

  const startWorkstream = useCallback(
    (initiativeId?: string | null) => {
      openEntityModal('workstream', initiativeId);
    },
    [openEntityModal]
  );

  const startWorkstreamFromSelection = useCallback(() => {
    return startWorkstream(selectedSession?.initiativeId ?? initiatives[0]?.id ?? null);
  }, [initiatives, selectedSession?.initiativeId, startWorkstream]);

  const handleInitiativeClick = useCallback(
    (initiative: Initiative) => {
      const candidate = [...sessionNodesInScope]
        .filter((node) => (node.initiativeId ?? node.groupId) === initiative.id)
        .sort(compareSessionPriority)[0];
      if (candidate) {
        setSelectedSessionId(candidate.id);
        setActivityFilterSessionId(candidate.id);
        setActivityFilterWorkstreamId(null);
        setActivityFilterWorkstreamLabel(null);
        showOpsNotice(`Focused initiative: ${initiative.name}`);
      }
    },
    [sessionNodesInScope]
  );

  const openInitiativeFromNextUp = useCallback(
    (initiativeId: string) => {
      const initiative =
        initiatives.find((entry) => entry.id === initiativeId) ??
        mcInitiatives.find((entry) => entry.id === initiativeId) ??
        null;
      if (initiative) {
        handleInitiativeClick(initiative);
      }
    },
    [handleInitiativeClick, initiatives, mcInitiatives]
  );

  const openDecisionsFromActivity = useCallback(
    (decisionId?: string | null) => {
      const normalizedDecisionId = (decisionId ?? '').trim();
      switchDashboardView('activity');
      setExpandedRightPanel('initiatives');
      setMobileTab('initiatives');
      setInitiativesSidebarTab('in_progress');
      setInProgressSubFilter('needs_attention');
      setRequestedDecisionId(normalizedDecisionId.length > 0 ? normalizedDecisionId : null);
      showOpsNotice(
        normalizedDecisionId.length > 0
          ? 'Reviewing pending decision.'
          : 'Review needs attention.'
      );
    },
    [switchDashboardView]
  );

  const openReviewActivityForSlice = useCallback(
    (slice: SliceRunProjection) => {
      const runCandidates = new Set<string>();
      const runId = (slice.runId ?? '').trim();
      if (runId.length > 0) runCandidates.add(runId);
      runCandidates.add(slice.sliceRunId);

      const candidateSet = new Map<string, LiveActivityItem>();
      for (const item of activityInScope) {
        const candidateRunId = resolveActivityRunId(item);
        const candidateSliceRunId = resolveActivitySliceRunId(item);
        if (
          (candidateRunId && runCandidates.has(candidateRunId)) ||
          (candidateSliceRunId && candidateSliceRunId === slice.sliceRunId)
        ) {
          candidateSet.set(item.id, item);
        }
      }

      const candidates = Array.from(candidateSet.values());
      const scoreItem = (item: LiveActivityItem): number => {
        const normalizedType = item.type.trim().toLowerCase();
        let score = 0;
        if (normalizedType === 'decision_requested' || normalizedType === 'blocker_created') score += 80;
        if (normalizedType === 'run_failed' || normalizedType === 'autopilot_stopped') score += 70;
        if (normalizedType.includes('slice_completed') || normalizedType.includes('completed')) score += 60;
        if (normalizedType.includes('artifact')) score += 55;
        if (normalizedType.includes('progress') || normalizedType.includes('update')) score += 35;
        score += Math.floor(toEpoch(item.timestamp) / 1000);
        return score;
      };

      candidates.sort((left, right) => scoreItem(right) - scoreItem(left));
      const bestItem = candidates[0] ?? null;

      switchDashboardView('activity');
      setMobileTab('activity');
      setExpandedRightPanel('initiatives');

      const linkedSession =
        (runId
          ? sessionNodesInScope.find((node) => node.runId === runId || node.id === runId) ?? null
          : null) ??
        (slice.initiativeId && slice.workstreamId
          ? sessionNodesInScope.find(
              (node) =>
                node.initiativeId === slice.initiativeId && node.workstreamId === slice.workstreamId
            ) ?? null
          : null);

      if (linkedSession) {
        setSelectedSessionId(linkedSession.id);
        setActivityFilterSessionId(linkedSession.id);
        setActivityFilterWorkstreamId(null);
        setActivityFilterWorkstreamLabel(null);
      } else if (slice.workstreamId) {
        setActivityFilterSessionId(null);
        setActivityFilterWorkstreamId(slice.workstreamId);
        setActivityFilterWorkstreamLabel(slice.workstreamTitle ?? 'Work slice');
      }

      if (bestItem?.id) {
        setRequestedActivityItemId(bestItem.id);
        showOpsNotice(`Reviewing activity for ${slice.workstreamTitle ?? 'work slice'}.`);
        return;
      }

      if (slice.primaryAction === 'resolve_decision') {
        openDecisionsFromActivity();
        return;
      }

      if (runId.length > 0) {
        focusActivityRunId(runId);
        showOpsNotice('Opened the related work session. Timeline details were unavailable.');
        return;
      }

      showOpsNotice('No activity details were found for this slice yet.');
    },
    [
      activityInScope,
      focusActivityRunId,
      openDecisionsFromActivity,
      sessionNodesInScope,
      switchDashboardView,
    ]
  );

  const focusActivitySessionByStatus = useCallback(
    (statuses: string[]) => {
      const statusSet = new Set(statuses);
      const candidate = [...sessionNodesInScope]
        .filter((node) => statusSet.has(node.status))
        .sort(compareSessionPriority)[0];
      if (!candidate) {
        showOpsNotice('No matching sessions for that metric right now.');
        return;
      }
      handleSelectSession(candidate.id);
      setMobileTab('activity');
    },
    [sessionNodesInScope, handleSelectSession]
  );

  const handleCompactMetricClick = useCallback(
    (metricId: string) => {
      if (dashboardView !== 'activity') return;

      if (
        metricId === 'sessions' ||
        metricId === 'active' ||
        metricId === 'blocked' ||
        metricId === 'failed' ||
        metricId === 'decisions' ||
        metricId === 'outbox' ||
        metricId === 'handoffs'
      ) {
        setBulkModal(metricId as BulkSessionsMode | 'decisions' | 'outbox' | 'handoffs');
      }
    },
    [dashboardView]
  );

  if (isLoading) {
    return (
      <div className="flex min-h-screen flex-col lg:h-screen" style={{ backgroundColor: colors.background }}>
        <div className="border-b border-subtle px-4 py-2.5 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="shimmer-skeleton h-6 w-6 rounded-lg" />
            <div className="shimmer-skeleton h-5 w-28 rounded-md" />
            <div className="shimmer-skeleton h-5 w-14 rounded-full" />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="shimmer-skeleton h-7 w-24 rounded-full" />
            ))}
          </div>
        </div>
        <div className="grid flex-1 grid-cols-1 gap-4 p-4 sm:p-5 lg:grid-cols-12">
          <div className="shimmer-skeleton min-h-[240px] rounded-2xl lg:col-span-3" />
          <div className="shimmer-skeleton min-h-[240px] rounded-2xl lg:col-span-6" />
          <div className="flex flex-col gap-4 lg:col-span-3">
            <div className="shimmer-skeleton h-40 rounded-2xl" />
            <div className="shimmer-skeleton h-48 rounded-2xl" />
            <div className="shimmer-skeleton flex-1 rounded-2xl" style={{ minHeight: 160 }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative flex min-h-screen flex-col pb-[92px] lg:h-screen lg:min-h-0 lg:overflow-hidden lg:pb-0"
      style={{ backgroundColor: colors.background }}
    >
      {(import.meta.env.DEV || (typeof window !== 'undefined' && window.location.port === '5173')) && (
        <div className="absolute left-1/2 top-4 z-30 -translate-x-1/2">
          <div className="rounded-full border border-strong bg-white/[0.06] px-4 py-2 text-caption text-primary shadow-[0_10px_30px_rgba(0,0,0,0.35)] backdrop-blur">
            Dev preview on 5173. Installed plugin runs on OpenClaw port{' '}
            <a
              href="http://127.0.0.1:18789/orgx/live/"
              className="text-white underline underline-offset-4 hover:text-secondary"
            >
              18789
            </a>
            .
          </div>
        </div>
      )}


      <header className="relative z-[180] border-b border-subtle px-4 py-1.5 sm:px-6">
        <div className="flex items-center justify-between gap-2.5 lg:grid lg:grid-cols-[1fr_auto_1fr]">
          <div className="flex min-w-0 items-center gap-2.5">
            <OrgXLogo />
            <h1 className="text-title font-semibold tracking-tight text-white sm:text-[17px]">
              OrgX<span className="ml-1.5 text-secondary">Live</span>
            </h1>
                <Badge
              color={CONNECTION_COLOR[data.connection]}
              pulse={data.connection === 'connected'}
              title={[
                `Status: ${CONNECTION_LABEL[data.connection] ?? data.connection}`,
                data.connection === 'connected'
                  ? 'Meaning: receiving live updates.'
                  : data.connection === 'reconnecting'
                    ? 'Meaning: retrying live stream (data may be stale).'
                    : 'Meaning: offline (data is stale).',
                `Last snapshot: ${formatAbsoluteTimestamp(data.lastSnapshotAt)}`,
                liveErrorCopy ? `Details: ${liveErrorCopy.message}` : null,
              ]
                .filter(Boolean)
                .join('\n')}
            >
              {CONNECTION_LABEL[data.connection] ?? 'Unknown'}
            </Badge>
            {(activeSessionCount > 0 || blockedCount > 0) && (
              <ContextualStatus
                className="hidden md:flex"
                running={activeSessionCount}
                blocked={blockedCount}
                decisionsCount={decisionsVisible ? data.decisions.length : 0}
                completedToday={completedToday}
                onDecisionsClick={() => {
                  switchDashboardView('activity');
                  setExpandedRightPanel('initiatives');
                  setMobileTab('initiatives');
                  setInitiativesSidebarTab('in_progress');
                  setInProgressSubFilter('needs_attention');
                }}
                onBlockedClick={() => {
                  if (actionableSliceRuns.length > 0) {
                    switchDashboardView('mission-control');
                    setInitiativesSidebarTab('in_progress');
                    setInProgressSubFilter('needs_attention');
                  } else {
                    setBulkModal('blocked');
                  }
                }}
                onNewInitiative={startInitiative}
              />
            )}
          </div>

          <div className="hidden items-center justify-center lg:flex">
            <div
              className="flex rounded-full border border-white/[0.1] bg-white/[0.03] p-0.5"
              role="group"
              aria-label="Dashboard view"
            >
              <button
                type="button"
                onClick={() => switchDashboardView('activity')}
                aria-pressed={dashboardView === 'activity'}
                className={`rounded-full px-3 py-1 text-body font-medium transition-all ${
                  dashboardView === 'activity'
                    ? 'bg-white/[0.1] text-white'
                    : 'text-secondary hover:text-bright'
                }`}
              >
                Activity
              </button>
	            <button
	              type="button"
	              onClick={() => switchDashboardView('mission-control')}
	              onMouseEnter={prefetchMissionControl}
	              onFocus={prefetchMissionControl}
	              aria-pressed={dashboardView === 'mission-control'}
	              className={`rounded-full px-3 py-1 text-body font-medium transition-all ${
	                dashboardView === 'mission-control'
	                  ? 'bg-white/[0.1] text-white'
	                  : 'text-secondary hover:text-bright'
	              }`}
	            >
	              Mission Control
	            </button>
            </div>
          </div>

          <div className="relative isolate flex items-center justify-end gap-1.5 sm:gap-2">
            <div className="relative hidden md:block">
              <label htmlFor="workspace-switcher" className="sr-only">
                Workspace scope
              </label>
              <select
                id="workspace-switcher"
                value={selectedWorkspaceId ?? '__all__'}
                onChange={(event) => {
                  const next = event.target.value;
                  setSelectedWorkspaceId(next === '__all__' ? null : next);
                }}
                className="control-pill h-8 min-w-[170px] appearance-none justify-start bg-white/[0.03] pl-3 pr-8 text-caption font-semibold text-primary"
                title={`Workspace scope: ${selectedWorkspaceLabel}`}
              >
                <option value="__all__">All workspaces</option>
                {workspaceSelectOptions.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.title}
                  </option>
                ))}
              </select>
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-secondary"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </div>
            {data.lastActivity && (
              <span className="hidden text-body text-secondary xl:inline">
                Last activity: {data.lastActivity}
              </span>
            )}
            {/* Replay status hidden — sync is invisible */}
            {demoMode && (
              <button
                type="button"
                onClick={() => {
                  setDemoModeEnabled(false);
                  handleReconnect();
                }}
                className="hidden rounded-full border border-amber-200/25 bg-amber-200/10 px-3 py-1.5 text-caption font-semibold text-amber-100 transition-colors hover:bg-amber-200/15 sm:inline"
                title="Exit demo mode"
              >
                Exit demo
              </button>
            )}
            <button
              type="button"
              ref={notificationButtonRef}
              onClick={() => setNotificationTrayOpen((open) => !open)}
              title="Notifications"
              aria-haspopup="dialog"
              aria-expanded={notificationTrayOpen}
              aria-controls="header-notifications-panel"
              className="relative inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.03] text-primary transition-colors hover:bg-white/[0.08]"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 17h5l-1.4-1.4a2 2 0 0 1-.6-1.4V11a6 6 0 1 0-12 0v3.2c0 .53-.21 1.04-.59 1.42L4 17h5" />
                <path d="M9 17a3 3 0 0 0 6 0" />
              </svg>
              {visibleNotifications.length > 0 && (
                <span className="absolute -right-1 -top-1 inline-flex min-h-[16px] min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-micro font-semibold text-white">
                  {visibleNotifications.length}
                </span>
              )}
            </button>
            {devMode ? (
              <button
                type="button"
                onClick={() => setRealtimeOrchestratorOpen(true)}
                title="Realtime orchestrator"
                className="relative inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.03] text-primary transition-colors hover:bg-white/[0.08]"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 18a2.5 2.5 0 0 0 2.5-2.5v-7a2.5 2.5 0 1 0-5 0v7A2.5 2.5 0 0 0 12 18z" />
                  <path d="M6 12.5v2a6 6 0 0 0 12 0v-2" />
                  <path d="M12 20.5v2" />
                </svg>
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => openSettings('orgx')}
              title="Settings"
              className="relative inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.03] text-primary transition-colors hover:bg-white/[0.08]"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />
                <path d="M19.4 15a1.8 1.8 0 0 0 .36 2l.05.05a2.2 2.2 0 0 1-1.56 3.76 2.2 2.2 0 0 1-1.56-.64l-.05-.05a1.8 1.8 0 0 0-2-.36 1.8 1.8 0 0 0-1.1 1.63V22a2.2 2.2 0 0 1-4.4 0v-.07a1.8 1.8 0 0 0-1.1-1.63 1.8 1.8 0 0 0-2 .36l-.05.05a2.2 2.2 0 1 1-3.12-3.12l.05-.05a1.8 1.8 0 0 0 .36-2 1.8 1.8 0 0 0-1.63-1.1H2a2.2 2.2 0 0 1 0-4.4h.07a1.8 1.8 0 0 0 1.63-1.1 1.8 1.8 0 0 0-.36-2l-.05-.05a2.2 2.2 0 1 1 3.12-3.12l.05.05a1.8 1.8 0 0 0 2 .36 1.8 1.8 0 0 0 1.1-1.63V2a2.2 2.2 0 0 1 4.4 0v.07a1.8 1.8 0 0 0 1.1 1.63 1.8 1.8 0 0 0 2-.36l.05-.05a2.2 2.2 0 0 1 3.12 3.12l-.05.05a1.8 1.8 0 0 0-.36 2 1.8 1.8 0 0 0 1.63 1.1H22a2.2 2.2 0 0 1 0 4.4h-.07a1.8 1.8 0 0 0-1.63 1.1z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={refetch}
              className="group inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.03] text-body text-primary transition-colors hover:bg-white/[0.08] sm:w-auto sm:gap-1.5 sm:px-3"
              title="Refresh data"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="transition-transform group-hover:rotate-45"
              >
                <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
              </svg>
              <span className="hidden sm:inline">Refresh</span>
            </button>

            {notificationTrayOpen && (
              <div
                id="header-notifications-panel"
                ref={notificationTrayRef}
                role="dialog"
                aria-label="Notifications"
                className="absolute right-0 top-[calc(100%+8px)] z-[320] w-[min(92vw,380px)] rounded-2xl border border-strong bg-[#070a11]/95 p-2 shadow-[0_20px_50px_rgba(0,0,0,0.45)] backdrop-blur"
              >
                <div className="mb-1.5 flex items-center justify-between px-2 py-1">
                  <p className="text-body font-semibold uppercase tracking-[0.12em] text-secondary">Notifications</p>
                  <div className="flex items-center gap-2">
                    {visibleNotifications.length > 0 && (
                      <button
                        type="button"
                        onClick={clearNotifications}
                        className="text-caption text-secondary transition-colors hover:text-primary"
                      >
                        Dismiss all
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setNotificationTrayOpen(false)}
                      className="rounded-md px-1.5 py-0.5 text-caption text-secondary transition-colors hover:bg-white/[0.08] hover:text-primary"
                      aria-label="Close notifications"
                    >
                      Close
                    </button>
                  </div>
                </div>

                <div className="mb-1.5 px-1.5">
                  <ContextualStatus
                    className="max-w-full overflow-hidden"
                    running={activeSessionCount}
                    blocked={blockedCount}
                    decisionsCount={notificationDecisionCount}
                    completedToday={completedToday}
                    onDecisionsClick={() => {
                      switchDashboardView('activity');
                      setMobileTab('initiatives');
                      setExpandedRightPanel('initiatives');
                      setInitiativesSidebarTab('in_progress');
                      setInProgressSubFilter('needs_attention');
                      setNotificationTrayOpen(false);
                    }}
                    onBlockedClick={() => {
                      if (actionableSliceRuns.length > 0) {
                        switchDashboardView('mission-control');
                        setInitiativesSidebarTab('in_progress');
                        setInProgressSubFilter('needs_attention');
                      } else {
                        setBulkModal('blocked');
                      }
                      setNotificationTrayOpen(false);
                    }}
                  />
                </div>

                {visibleNotifications.length === 0 ? (
                  <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-3 text-body text-secondary">
                    {notificationAttentionCount > 0
                      ? 'No new notification banners. Active work is summarized above.'
                      : 'Everything looks clear.'}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {visibleNotifications.map((item) => (
                      <div
                        key={item.id}
                        className="rounded-xl border px-3 py-2"
                        style={{
                          borderColor: item.kind === 'error' ? 'rgba(239,68,68,0.35)' : 'rgba(255,255,255,0.1)',
                          backgroundColor: item.kind === 'error' ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.02)',
                        }}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p
                              className="inline-flex items-center gap-1.5 text-body font-semibold"
                              style={{ color: item.kind === 'error' ? '#fecaca' : '#e2e8f0' }}
                            >
                              <EntityIcon type={item.icon} size={12} className="opacity-90" />
                              <span className="truncate">{item.title}</span>
                            </p>
                            <p className="mt-0.5 text-body leading-snug text-secondary">{item.message}</p>
                            {item.onAction && (
                              <button
                                type="button"
                                onClick={() => { item.onAction?.(); setNotificationTrayOpen(false); }}
                                className="mt-1.5 rounded-md border border-strong bg-white/[0.05] px-2.5 py-1 text-caption font-medium text-primary transition-colors hover:bg-white/[0.1] hover:text-white"
                              >
                                {item.actionLabel ?? 'View'}
                              </button>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => dismissNotification(item.id)}
                            className="shrink-0 rounded-md px-1.5 py-0.5 text-caption text-secondary transition-colors hover:bg-white/[0.08] hover:text-primary"
                            title="Dismiss"
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="mt-2 flex items-center justify-center gap-2 lg:hidden">
          <div className="min-w-0 flex-1">
            <label htmlFor="workspace-switcher-mobile" className="sr-only">
              Workspace scope
            </label>
            <div className="relative">
              <select
                id="workspace-switcher-mobile"
                value={selectedWorkspaceId ?? '__all__'}
                onChange={(event) => {
                  const next = event.target.value;
                  setSelectedWorkspaceId(next === '__all__' ? null : next);
                }}
                className="control-pill h-8 w-full appearance-none justify-start bg-white/[0.03] pl-3 pr-8 text-caption font-semibold text-primary"
                title={`Workspace scope: ${selectedWorkspaceLabel}`}
              >
                <option value="__all__">All workspaces</option>
                {workspaceSelectOptions.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.title}
                  </option>
                ))}
              </select>
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-secondary"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </div>
          </div>
          <div
            className="flex w-full max-w-[248px] rounded-full border border-white/[0.1] bg-white/[0.03] p-0.5"
            role="group"
            aria-label="Dashboard view"
          >
            <button
              type="button"
              onClick={() => switchDashboardView('activity')}
              aria-pressed={dashboardView === 'activity'}
              className={`flex-1 rounded-full px-3 py-1.5 text-body font-medium transition-all ${
                dashboardView === 'activity'
                  ? 'bg-white/[0.1] text-white'
                  : 'text-secondary hover:text-bright'
              }`}
            >
              Activity
            </button>
            <button
              type="button"
              onClick={() => switchDashboardView('mission-control')}
              aria-pressed={dashboardView === 'mission-control'}
              className={`flex-1 rounded-full px-3 py-1.5 text-body font-medium transition-all ${
                dashboardView === 'mission-control'
                  ? 'bg-white/[0.1] text-white'
                  : 'text-secondary hover:text-bright'
              }`}
            >
              Mission Control
            </button>
          </div>
        </div>

      </header>

      {/* Contextual status moved into header */}

      {dashboardView === 'mission-control' ? (
        <div className="relative z-0 flex-1 min-h-0 flex flex-col overflow-hidden">
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center text-body text-secondary">
                Loading Mission Control…
              </div>
            }
          >
            <LazyMissionControlView
              initiatives={mcInitiatives}
              activities={activityInScope}
              agents={missionControlAgents}
              runtimeInstances={data.runtimeInstances ?? []}
              workspaceInitiativeId={selectedWorkspaceId}
              isLoading={isLoading}
              authToken={null}
              embedMode={false}
              connection={data.connection}
              lastSnapshotAt={data.lastSnapshotAt}
              error={error}
              hasApiKey={onboarding.state.hasApiKey}
              devMode={devMode}
              onOpenSettings={() => openSettings('orgx')}
              onRefresh={refetch}
              onCreateInitiative={startInitiative}
              onPlayNextUp={playNextUpFromActivity}
              onStartAutopilot={startAutopilotFromActivity}
              nextUpQueueModel={sharedNextUpQueue}
              nextUpActionsModel={sharedNextUpActions}
              snapshotVersion={data.snapshotVersion}
            />
          </Suspense>
        </div>
      ) : (
        <main className="relative z-0 grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 pb-20 sm:p-5 sm:pb-20 lg:grid-cols-12 lg:overflow-hidden lg:pb-5">
          <section className={`min-h-0 lg:col-span-3 lg:flex lg:flex-col lg:[&>section]:h-full ${mobileTab !== 'agents' ? 'hidden lg:flex' : ''}`}>
            <AgentsChatsPanel
              sessions={data.sessions}
              activity={activityInScope}
              runtimeInstances={data.runtimeInstances ?? []}
              showSyntheticEntities={demoMode || showSyntheticEntities}
              selectedSessionId={selectedSessionId}
              onSelectSession={handleSelectSession}
              onAgentFilter={setAgentFilter}
              agentFilter={agentFilter}
              timeFilterId={activityTimeFilterId}
              onReconnect={handleReconnect}
              onLaunched={refetch}
              connectionStatus={data.connection}
              autopilotState={agentPanelAutopilotState}
            />
          </section>

          <section className={`min-h-0 lg:col-span-6 lg:flex lg:flex-col lg:[&>section]:h-full ${mobileTab !== 'activity' ? 'hidden lg:flex' : ''}`}>
            <ActivityTimeline
              activity={activityFeed.items}
              sessions={sessionNodesInScope}
              sliceRuns={actionableSliceRuns}
              initiatives={initiatives}
              timelineNarrative={data.timelineNarrative ?? []}
              workspaceId={selectedWorkspaceId}
              chatSnapshot={data.chat}
              devMode={devMode}
              selectedRunIds={selectedActivityRunIds}
              selectedSessionLabel={selectedActivitySessionLabel}
              selectedWorkstreamId={activityFilterWorkstreamId}
              selectedWorkstreamLabel={activityFilterWorkstreamLabel}
              agentFilter={agentFilter}
              timeFilterId={activityTimeFilterId}
              onTimeFilterChange={handleActivityTimeFilterChange}
              customTimeRange={activityCustomTimeRange}
              onCustomTimeRangeChange={setActivityCustomTimeRange}
              hasMore={activityFeed.hasMore}
              isLoadingMore={activityFeed.isLoadingMore}
              onLoadMore={activityFeed.loadMore}
              onClearSelection={clearActivitySessionFilter}
              onClearWorkstreamFilter={clearActivityWorkstreamFilter}
              onClearAgentFilter={clearAgentFilter}
              onFocusRunId={focusActivityRunId}
              onOpenDecision={openDecisionsFromActivity}
              onResolveDecision={handleResolveDecision}
              requestedActivityItemId={requestedActivityItemId}
              onActivityItemRequestHandled={() => setRequestedActivityItemId(null)}
              onPlayNextUp={playNextUpFromActivity}
              onStartAutopilot={startAutopilotFromActivity}
              onPauseWorkstream={pauseSessionWorkstream}
              onCreateInitiative={startInitiative}
              onOpenMissionControl={() => switchDashboardView('mission-control')}
              onOpenNextUp={() => switchDashboardView('mission-control')}
              onOpenSettings={() => openSettings('orgx')}
              onRefreshData={refetch}
              isLoading={isLoading}
            />
          </section>

          <section className={`flex min-h-0 flex-col gap-3 lg:col-span-3 lg:gap-3 ${mobileTab !== 'decisions' && mobileTab !== 'initiatives' ? 'hidden lg:flex' : ''}`}>
          {/* Next Up — accordion panel (single-expand: one panel open at a time) */}
          <div className={`min-h-0 ${expandedRightPanel === 'initiatives' ? 'flex-1' : 'flex-shrink-0'} ${mobileTab === 'decisions' ? '' : mobileTab === 'initiatives' ? '' : ''}`}>
            {expandedRightPanel === 'initiatives' ? (
              <PremiumCard className="flex h-full min-h-0 flex-col card-enter">
                <div className="flex items-center justify-between gap-2 border-b border-subtle px-4 py-2.5">
                  <div className="flex min-w-0 items-center gap-3 overflow-x-auto">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={initiativesSidebarTab === 'in_progress'}
                      onClick={(e) => {
                        e.stopPropagation();
                        setInitiativesSidebarTab('in_progress');
                      }}
                      className={cn(
                        'relative inline-flex h-8 items-center gap-1.5 px-0.5 text-caption font-semibold transition-colors',
                        initiativesSidebarTab === 'in_progress'
                          ? 'text-white'
                          : 'text-secondary hover:text-bright'
                      )}
                    >
                      <span>In Progress</span>
                      <span className="text-micro tabular-nums text-muted">{inProgressCount}</span>
                      <span
                        className={cn(
                          'pointer-events-none absolute -bottom-px left-0 right-0 h-[2px] rounded-full bg-[#BFFF00] transition-opacity',
                          initiativesSidebarTab === 'in_progress' ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={initiativesSidebarTab === 'next_up'}
                      onClick={(e) => {
                        e.stopPropagation();
                        setInitiativesSidebarTab('next_up');
                      }}
                      className={cn(
                        'relative inline-flex h-8 items-center gap-1.5 px-0.5 text-caption font-semibold transition-colors',
                        initiativesSidebarTab === 'next_up'
                          ? 'text-white'
                          : 'text-secondary hover:text-bright'
                      )}
                    >
                      <span>Next Up</span>
                      <span className="text-micro tabular-nums text-muted">{activityNextUpQueue.total}</span>
                      <span
                        className={cn(
                          'pointer-events-none absolute -bottom-px left-0 right-0 h-[2px] rounded-full bg-[#BFFF00] transition-opacity',
                          initiativesSidebarTab === 'next_up' ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void toggleSidebarAutopilot().catch((error) => {
                        showOpsNotice(
                          formatOpsNoticeError(
                            error instanceof Error ? error.message : '',
                            'Autopilot action failed.'
                          )
                        );
                      });
                    }}
                    disabled={sidebarAutopilotBusy}
                    className="control-pill inline-flex h-8 items-center gap-1.5 px-2.5 text-caption font-semibold disabled:opacity-45"
                    data-tone={activityAutopilotTone}
                    data-state={activityAutopilotButtonState}
                    title={activityAutopilotButtonTitle}
                    aria-label={activityAutopilotButtonTitle}
                  >
                    <svg
                      viewBox="0 0 20 20"
                      fill="none"
                      className={cn('h-3.5 w-3.5', activityAutopilotActive ? 'animate-pulse' : '')}
                      aria-hidden
                    >
                      <path
                        d="M6.1 13.25C4.25 13.25 2.8 11.8 2.8 10s1.45-3.25 3.3-3.25c3.15 0 4.35 6.5 8.05 6.5 1.85 0 3.3-1.45 3.3-3.25s-1.45-3.25-3.3-3.25c-3.7 0-4.9 6.5-8.05 6.5Z"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span className="text-micro uppercase tracking-[0.12em]">Auto</span>
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                        activityAutopilotState === 'blocked'
                          ? 'bg-amber-400/18 text-amber-100'
                          : activityAutopilotActive
                          ? 'bg-[#BFFF00]/18 text-[#E3FFAE]'
                          : 'bg-white/[0.08] text-secondary'
                      )}
                    >
                      {activityAutopilotBadgeLabel}
                    </span>
                  </button>
                </div>

                {initiativesSidebarTab === 'in_progress' ? (
                  <div className="flex items-center gap-1.5 border-b border-subtle px-4 py-2">
                    <button
                      type="button"
                      onClick={() => setInProgressSubFilter('all')}
                      className={cn(
                        'inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-micro font-semibold transition-colors',
                        inProgressSubFilter === 'all'
                          ? 'bg-white/[0.09] text-primary'
                          : 'text-secondary hover:bg-white/[0.06] hover:text-bright'
                      )}
                    >
                      <span>All active</span>
                      <span className="tabular-nums opacity-75">{inProgressCount}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setInProgressSubFilter('needs_attention')}
                      className={cn(
                        'inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-micro font-semibold transition-colors',
                        inProgressSubFilter === 'needs_attention'
                          ? 'bg-[#F5B700]/14 text-[#FFE7A8]'
                          : 'text-secondary hover:bg-white/[0.06] hover:text-bright'
                      )}
                    >
                      <span>Needs attention</span>
                      <span className="tabular-nums opacity-80">{needsInputCount}</span>
                    </button>
                  </div>
                ) : null}

                <div className="min-h-0 flex-1" key={`${initiativesSidebarTab}:${inProgressSubFilter}`}>
                  {initiativesSidebarTab === 'in_progress' ? (
                    inProgressSubFilter === 'needs_attention' ? (
                      <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-2">
                        {/* Diagnostics only — decisions/blocked slices are handled by dedicated panels below. */}
                        {triageDiagnosticsModel.items.length > 0 && (
                          <div className="min-h-[180px] max-h-[34%]">
                            <Suspense fallback={<div className="p-4 text-body text-secondary">Loading triage…</div>}>
                              <LazyTriageQueue
                                model={triageDiagnosticsModel}
                                actions={triageActions}
                                onOpenDetail={openTriageDetail}
                              />
                            </Suspense>
                          </div>
                        )}

                        {decisionsVisible ? (
                          <section
                            className={cn(
                              'overflow-hidden rounded-xl border border-subtle bg-white/[0.02]',
                              needsInputRows.length === 0 ? 'flex-1 min-h-[220px]' : 'min-h-[220px] max-h-[50%]'
                            )}
                          >
                            <div className="border-b border-subtle px-3 py-2.5">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45">
                                  Decision queue
                                </p>
                                <span className="rounded-full bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white/55">
                                  {data.decisions.length}
                                </span>
                              </div>
                              <p className="mt-1 text-caption text-white/35">
                                Resolve blockers and approvals to keep dispatch moving.
                              </p>
                            </div>
                            <div className="min-h-0 p-2">
                              <Suspense
                                fallback={
                                  <div className="h-full min-h-[160px] rounded-lg border border-subtle bg-white/[0.02] p-4 text-body text-secondary">
                                    Loading decisions…
                                  </div>
                                }
                              >
                                <LazyDecisionQueue
                                  className="h-full min-h-0"
                                  showHeader={false}
                                  panelStyle="flat"
                                  decisions={data.decisions}
                                  focusDecisionId={requestedDecisionId}
                                  onFocusDecisionHandled={() => setRequestedDecisionId(null)}
                                  onApproveDecision={approveDecision}
                                  onRejectDecision={rejectDecision}
                                  onApproveAll={approveAllDecisions}
                                  onBulkDecisionAction={bulkDecisionAction}
                                  mutationState={decisionMutation}
                                  initiativeNames={initiativeNameMap}
                                />
                              </Suspense>
                            </div>
                          </section>
                        ) : (
                          <PremiumCard className="border border-subtle bg-white/[0.02] px-4 py-3 text-body text-secondary">
                            OrgX is not connected. Decision actions are hidden until connectivity returns.
                          </PremiumCard>
                        )}

                        <section
                          className={cn(
                            'flex min-h-[180px] flex-1 flex-col overflow-hidden rounded-xl border border-subtle bg-white/[0.02]'
                          )}
                        >
                          <div className="border-b border-subtle px-3 py-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45">
                                {decisionsVisible ? 'Blocked & review-required slices' : 'Needs attention'}
                              </p>
                              <span className="rounded-full bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white/55">
                                {needsInputRows.length}
                              </span>
                            </div>
                            <p className="mt-1 text-caption text-white/35">
                              Retry, approve, or manually intervene on execution slices.
                            </p>
                          </div>
                          <div className="min-h-0 flex-1 p-2">
                            <NeedsInputPanel
                              className={cn('h-full min-h-0')}
                              title={decisionsVisible ? 'Blocked & review-required slices' : 'Needs attention'}
                              showHeader={false}
                              panelStyle="flat"
                              sliceRuns={actionableSliceRuns}
                              initiatives={initiatives}
                              onOpenDecisions={() => openDecisionsFromActivity()}
                              onFocusRunId={focusActivityRunId}
                              onReviewActivity={openReviewActivityForSlice}
                              onOpenSliceDetail={openSliceDetailFromNeedsInput}
                            />
                          </div>
                        </section>
                      </div>
                    ) : (
                      <InProgressPanel
                        className="h-full min-h-0"
                        showHeader={false}
                        panelStyle="flat"
                        sessions={sessionNodesInScope}
                        sliceRuns={actionableSliceRuns}
                        initiatives={initiatives}
                        needsAttentionCount={needsInputCount}
                        onSwitchToNeedsAttention={() => setInProgressSubFilter('needs_attention')}
                        onOpenSession={handleSelectSession}
                        onFocusRunId={focusActivityRunId}
                        onPlayWorkstream={playSessionWorkstream}
                        onPauseWorkstream={pauseSessionWorkstream}
                        onResumeWorkstream={playSessionWorkstream}
                        onRestartSession={restartSessionWorkstream}
                        onIntervene={openInterventionComposer}
                        onOpenSliceDetail={openSliceDetailFromInProgress}
                      />
                    )
                  ) : (
                    <Suspense
                      fallback={
                        <div className="p-4 text-body text-secondary">Loading queue…</div>
                      }
                    >
                      <LazyNextUpPanel
                        projectId={selectedWorkspaceId}
                        title="Next Up"
                        showHeader={false}
                        panelStyle="flat"
                        className="h-full"
                        compact={false}
                        selectionEnabled
                        showQueueSettings
                        queueModel={sharedNextUpQueue}
                        queueActions={sharedNextUpActions}
                        snapshotVersion={data.snapshotVersion}
                        excludeRunning
                        onOpenInitiative={openInitiativeFromNextUp}
                        onOpenSliceDetail={openSliceDetailFromQueue}
                      />
                    </Suspense>
                  )}
                </div>
              </PremiumCard>
            ) : (
              <PremiumCard className="card-enter">
                <button
                  onClick={() => setExpandedRightPanel('initiatives')}
                  className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-white/[0.03]"
                >
                  <div className="flex items-center gap-2">
                    <h2 className="text-heading font-semibold text-white">Initiatives</h2>
                  </div>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="-rotate-90 text-muted">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
              </PremiumCard>
            )}
          </div>

        </section>
      </main>
      )}

      {/* Session Inspector slide-over drawer */}
      <AnimatePresence>
        {sessionDrawerOpen && selectedSession && (
          <>
            <motion.div
              key="session-drawer-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed bottom-0 left-0 right-0 top-[64px] z-[240] hidden bg-black/40 backdrop-blur-sm lg:block"
              onClick={() => setSessionDrawerOpen(false)}
            />
            <motion.div
              key="session-drawer-panel"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', stiffness: 400, damping: 35 }}
              className="glass-panel soft-shadow fixed bottom-0 right-0 top-[64px] z-[250] hidden w-[480px] flex-col lg:flex"
              style={{ backgroundColor: colors.cardBg, borderLeft: '1px solid rgba(255,255,255,0.08)' }}
            >
              <div className="flex-1 min-h-0">
                <Suspense
                  fallback={
                    <div className="p-4 text-body text-secondary">Loading session detail…</div>
                  }
                >
                  <LazySessionInspector
                    session={selectedSession}
                    activity={activityInScope}
                    initiatives={initiatives}
                    sliceRuns={actionableSliceRuns}
                    initialInterventionDraft={interventionDraft}
                    onSubmitIntervention={submitSessionIntervention}
                    onOpenActivityItem={openActivityItemFromSessionDetail}
                    onContinueHighestPriority={continueHighestPriority}
                    onDispatchSession={dispatchSession}
                    onPauseSession={pauseSession}
                    onResumeSession={resumeSession}
                    onCancelSession={cancelSession}
                    onCreateCheckpoint={createSessionCheckpoint}
                    onRollbackSession={rollbackSession}
                    onStartInitiative={startInitiative}
                    onStartWorkstream={startWorkstream}
                    onClose={() => setSessionDrawerOpen(false)}
                  />
                </Suspense>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {dashboardView === 'activity' ? (
        <MobileTabBar
          activeTab={mobileTab}
          onTabChange={handleMobileTabChange}
          pendingDecisionCount={decisionsVisible ? data.decisions.length : 0}
        />
      ) : null}

      <Modal
        open={entityModal !== null}
        onClose={closeEntityModal}
        maxWidth="max-w-sm"
        fitContent
      >
        <div className="flex w-full flex-col">
          <div className="px-5 pt-5 pb-1">
            <h3 className="text-heading font-semibold text-white">
              {entityModal?.type === 'workstream' ? 'New Workstream' : 'New Initiative'}
            </h3>
            <p className="mt-1 text-body leading-relaxed text-secondary">
              {entityModal?.type === 'workstream'
                ? 'Create a new workstream under the selected initiative.'
                : 'Create a new initiative to organize your work.'}
            </p>
          </div>
          <div className="px-5 py-4">
            <label className="mb-1.5 block text-caption uppercase tracking-[0.1em] text-secondary">
              Name
            </label>
            <input
              value={entityName}
              onChange={(e) => setEntityName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmCreateEntity();
              }}
              autoFocus
              data-modal-autofocus="true"
              placeholder={entityModal?.type === 'workstream' ? 'e.g. User Onboarding Flow' : 'e.g. Q1 Product Launch'}
              className="w-full rounded-lg border border-strong bg-black/30 px-3 py-2.5 text-body text-white placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/40"
            />
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-subtle px-5 py-3">
            <button
              onClick={closeEntityModal}
              className="rounded-md px-3 py-1.5 text-body text-secondary transition-colors hover:text-white"
            >
              Cancel
            </button>
            <button
              onClick={confirmCreateEntity}
              disabled={entityName.trim().length === 0 || entityCreating}
              className="rounded-md border border-lime/25 bg-lime/10 px-4 py-1.5 text-body font-semibold text-lime transition-colors hover:bg-lime/20 disabled:opacity-45"
            >
              {entityCreating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      </Modal>

      {settingsState.open && (
        <Suspense fallback={null}>
          <LazySettingsModal
            open={settingsState.open}
            onClose={() =>
              setSettingsState((previous) => ({ ...previous, open: false, focusAgentDomain: null }))
            }
            activeTab={settingsState.tab}
            onChangeTab={(tab) => setSettingsState((previous) => ({ ...previous, tab }))}
            agentBehaviorInitialDomain={settingsState.focusAgentDomain}
            demoMode={demoMode}
            onToggleDemoMode={(next) => {
              setDemoModeEnabled(next);
              if (!next) {
                handleReconnect();
              }
            }}
            devMode={devMode}
            onToggleDevMode={setDevMode}
            showSyntheticEntities={showSyntheticEntities}
            onToggleShowSyntheticEntities={setShowSyntheticEntities}
            workspaceOptions={workspaceSelectOptions}
            selectedWorkspaceId={selectedWorkspaceId}
            onSelectWorkspace={setSelectedWorkspaceId}
            onboarding={onboarding}
            authToken={null}
            embedMode={false}
          />
        </Suspense>
      )}

      {devMode && realtimeOrchestratorOpen && (
        <Suspense fallback={null}>
          <LazyRealtimeOrchestratorModal
            open={realtimeOrchestratorOpen}
            selectedWorkspaceId={selectedWorkspaceId}
            onClose={() => setRealtimeOrchestratorOpen(false)}
          />
        </Suspense>
      )}

      {(bulkModal === 'sessions' ||
        bulkModal === 'active' ||
        bulkModal === 'blocked' ||
        bulkModal === 'failed') && (
        <Suspense fallback={null}>
          <LazyBulkSessionsModal
            open={
              bulkModal === 'sessions' ||
              bulkModal === 'active' ||
              bulkModal === 'blocked' ||
              bulkModal === 'failed'
            }
            onClose={() => setBulkModal(null)}
            mode={
              bulkModal === 'active' || bulkModal === 'blocked' || bulkModal === 'failed'
                ? bulkModal
                : 'sessions'
            }
            sessions={sessionNodesInScope}
            onOpenSession={(session) => {
              handleSelectSession(session.id);
              setBulkModal(null);
            }}
            onRunAction={async (session, action) => {
              await runControlAction(session, action, { reason: `bulk_${action}_from_header` });
            }}
            onRefetch={async () => refetch()}
            onSetNotice={(message) => showOpsNotice(message)}
          />
        </Suspense>
      )}

      {bulkModal === 'decisions' && (
        <Suspense fallback={null}>
          <LazyBulkDecisionsModal
            open={bulkModal === 'decisions'}
            onClose={() => setBulkModal(null)}
            decisions={decisionsVisible ? data.decisions : []}
            onApproveDecision={approveDecision}
            onRejectDecision={rejectDecision}
            onApproveAll={approveAllDecisions}
            onBulkDecisionAction={bulkDecisionAction}
          />
        </Suspense>
      )}

      {bulkModal === 'outbox' && (
        <Suspense fallback={null}>
          <LazyBulkOutboxModal
            open={bulkModal === 'outbox'}
            onClose={() => setBulkModal(null)}
            outbox={data.outbox}
            onOpenSettings={() => {
              setBulkModal(null);
              openSettings('orgx');
            }}
            onRefresh={() => {
              void refetch();
            }}
          />
        </Suspense>
      )}

      {bulkModal === 'handoffs' && (
        <Suspense fallback={null}>
          <LazyBulkHandoffsModal
            open={bulkModal === 'handoffs'}
            onClose={() => setBulkModal(null)}
            handoffs={data.handoffs}
          />
        </Suspense>
      )}

      <DeferredArtifactViewerModal />

      {/* Triage Detail Modal */}
      {triageDetailItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="relative w-full max-w-lg max-h-[80vh] overflow-hidden rounded-xl border border-subtle bg-[#0E0F11] shadow-2xl">
            <Suspense fallback={<div className="p-8 text-center text-secondary">Loading…</div>}>
              <LazyTriageDetailModal
                item={triageDetailItem}
                actions={triageActions}
                onClose={() => setTriageDetailItem(null)}
                onNavigate={navigateTriageDetail}
                currentIndex={triageDetailIndex}
                totalCount={triageDiagnosticsItems.length}
                decisions={decisionsVisible ? data.decisions : undefined}
                onApproveDecision={approveDecision}
                onRejectDecision={rejectDecision}
              />
            </Suspense>
          </div>
        </div>
      )}

      {sliceDetailTarget && (
        <Suspense fallback={null}>
          <LazySliceDetailModal
            target={sliceDetailTarget}
            initiatives={initiatives}
            onClose={() => setSliceDetailTarget(null)}
            onPlayWorkstream={async (initiativeId, workstreamId, agentId) => {
          const response = await fetch('/orgx/api/mission-control/next-up/play', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              initiativeId,
              workstreamId,
              agentId: agentId ?? undefined,
              fastAck: true,
              ignoreSpawnGuardRateLimit: true,
            }),
          });
          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
            showOpsNotice(
              formatOpsNoticeError(
                body?.error ?? body?.message ?? null,
                `Failed to dispatch workstream (${response.status})`
              )
            );
            return;
          }
          showOpsNotice(`Dispatched workstream.`);
          void refetch();
        }}
        onStartAutoContinue={async (initiativeId, workstreamId, agentId) => {
          await fetch('/orgx/api/mission-control/next-up/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initiativeId, workstreamId, placement: 'top' }),
          });
          const response = await fetch('/orgx/api/mission-control/auto-continue/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              initiativeId,
              agentId: agentId ?? undefined,
              ignoreSpawnGuardRateLimit: true,
            }),
          });
          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
            showOpsNotice(
              formatOpsNoticeError(
                body?.error ?? body?.message ?? null,
                `Failed to start auto-continue (${response.status})`
              )
            );
            return;
          }
          showOpsNotice(`Auto-continue started.`);
          void refetch();
        }}
        onMoveWorkstream={async (initiativeId, workstreamId, placement) => {
          const response = await fetch('/orgx/api/mission-control/next-up/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initiativeId, workstreamId, placement }),
          });
          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
            showOpsNotice(
              formatOpsNoticeError(
                body?.error ?? body?.message ?? null,
                `Move failed (${response.status})`
              )
            );
            return;
          }
          showOpsNotice(`Moved workstream to ${placement}.`);
          void refetch();
        }}
            onRemoveFromQueue={async (initiativeId, workstreamId) => {
          const response = await fetch('/orgx/api/mission-control/next-up/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initiativeId, workstreamId }),
          });
          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
            showOpsNotice(
              formatOpsNoticeError(
                body?.error ?? body?.message ?? null,
                `Remove failed (${response.status})`
              )
            );
            return;
          }
          showOpsNotice(`Removed workstream from queue.`);
          void refetch();
        }}
            onOpenSession={handleSelectSession}
            onFocusRunId={focusActivityRunId}
            onOpenInitiative={openInitiativeFromNextUp}
            onReviewActivity={openReviewActivityForSlice}
            onOpenDecisions={() => openDecisionsFromActivity()}
            onAcceptSlice={handleAcceptSlice}
            onRejectSlice={handleRejectSlice}
          />
        </Suspense>
      )}
    </div>
  );
}
