import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { useLiveData } from '@/hooks/useLiveData';
import { useOnboarding } from '@/hooks/useOnboarding';
import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';
import type { Agent, Initiative, NextUpQueueItem, SessionTreeNode } from '@/types';
import { OnboardingGate } from '@/components/onboarding/OnboardingGate';
import { FirstRunGuideModal, getFirstRunGuideDismissed } from '@/components/onboarding/FirstRunGuideModal';
import { Badge } from '@/components/shared/Badge';
import { Modal } from '@/components/shared/Modal';
import { MobileTabBar } from '@/components/shared/MobileTabBar';
import type { MobileTab } from '@/components/shared/MobileTabBar';
import { AgentsChatsPanel } from '@/components/sessions/AgentsChatsPanel';
import { ActivityTimeline } from '@/components/activity/ActivityTimeline';
import { DecisionQueue } from '@/components/decisions/DecisionQueue';
import { NextUpPanel } from '@/components/mission-control/NextUpPanel';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { EntityIcon, type EntityIconType } from '@/components/shared/EntityIcon';
import { useEntityInitiatives } from '@/hooks/useEntityInitiatives';
import { useLiveInitiatives } from '@/hooks/useLiveInitiatives';
import { SettingsModal, type SettingsTab } from '@/components/settings/SettingsModal';
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

const MC_WELCOME_DISMISS_KEY = 'orgx.mission_control.welcome.dismissed';
const DEMO_MODE_KEY = 'orgx.demo_mode';
const FIRST_RUN_GUIDE_SESSION_KEY = 'orgx.first_run_guide.shown_session';

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

type HeaderNotification = {
  id: string;
  kind: 'error' | 'info';
  icon: EntityIconType;
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
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

function compareSessionPriority(a: SessionTreeNode, b: SessionTreeNode): number {
  const aPriority = SESSION_PRIORITY[a.status] ?? 99;
  const bPriority = SESSION_PRIORITY[b.status] ?? 99;
  if (aPriority !== bPriority) return aPriority - bPriority;
  return (
    toEpoch(a.updatedAt ?? a.lastEventAt ?? a.startedAt) -
    toEpoch(b.updatedAt ?? b.lastEventAt ?? b.startedAt)
  );
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
    <DashboardShell onboarding={onboarding} />
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
    <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg border border-white/[0.12] bg-white/[0.04] p-0.5">
      <img src={orgxLogo} alt="OrgX" className="h-full w-full rounded-md object-contain" />
    </span>
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

  const shouldAttemptDecisions =
    demoMode || (onboarding.state.hasApiKey && onboarding.state.connectionVerified);

  const { data, isLoading, error, refetch, approveDecision, approveAllDecisions } = useLiveData({
    useMock: demoMode,
    enabled: true,
    enableDecisions: shouldAttemptDecisions,
  });
  const decisionsVisible = shouldAttemptDecisions && data.connection === 'connected';
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionDrawerOpen, setSessionDrawerOpen] = useState(false);
  const [activityFilterSessionId, setActivityFilterSessionId] = useState<string | null>(null);
  const [activityFilterWorkstreamId, setActivityFilterWorkstreamId] = useState<string | null>(null);
  const [activityFilterWorkstreamLabel, setActivityFilterWorkstreamLabel] = useState<string | null>(null);
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [opsNotice, setOpsNotice] = useState<string | null>(null);
  const [notificationTrayOpen, setNotificationTrayOpen] = useState(false);
  const [dismissedNotificationIds, setDismissedNotificationIds] = useState<string[]>([]);
  const notificationButtonRef = useRef<HTMLButtonElement | null>(null);
  const notificationTrayRef = useRef<HTMLDivElement | null>(null);
  const [settingsState, setSettingsState] = useState<{ open: boolean; tab: SettingsTab }>({
    open: false,
    tab: 'orgx',
  });
  const [firstRunGuideOpen, setFirstRunGuideOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>('agents');
  const [expandedRightPanel, setExpandedRightPanel] = useState<string>('decisions');
  const [dismissedMissionControlWelcome, setDismissedMissionControlWelcome] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(MC_WELCOME_DISMISS_KEY) === '1';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (dismissedMissionControlWelcome) {
      window.localStorage.setItem(MC_WELCOME_DISMISS_KEY, '1');
    } else {
      window.localStorage.removeItem(MC_WELCOME_DISMISS_KEY);
    }
  }, [dismissedMissionControlWelcome]);

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
    if (firstRunGuideOpen) return;
    if (getFirstRunGuideDismissed()) return;
    // Auto-open only once per browser session so users can dismiss without
    // being forced into "dismiss forever".
    try {
      if (window.sessionStorage.getItem(FIRST_RUN_GUIDE_SESSION_KEY) === '1') return;
    } catch {
      // ignore
    }
    if (demoMode || onboarding.state.connectionVerified) {
      setFirstRunGuideOpen(true);
      try {
        window.sessionStorage.setItem(FIRST_RUN_GUIDE_SESSION_KEY, '1');
      } catch {
        // ignore
      }
    }
  }, [demoMode, firstRunGuideOpen, onboarding.state.connectionVerified]);

  const openSettings = useCallback((tab?: SettingsTab) => {
    setSettingsState((previous) => ({
      open: true,
      tab: tab ?? previous.tab,
    }));
  }, []);

  const handleReconnect = useCallback(() => {
    openSettings('orgx');
  }, [openSettings]);

  const prefetchMissionControl = useCallback(() => {
    void import('@/components/mission-control/MissionControlView');
  }, []);

  // Dashboard view toggle: Activity (3-column) vs Mission Control
  const [dashboardView, setDashboardView] = useState<DashboardView>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('view') === 'mission-control') return 'mission-control';
    try {
      if (localStorage.getItem('orgx-dashboard-view') === 'mission-control') return 'mission-control';
    } catch { /* ignore */ }
    return 'activity';
  });

  const switchDashboardView = useCallback((v: DashboardView) => {
    setDashboardView(v);
    try { localStorage.setItem('orgx-dashboard-view', v); } catch { /* ignore */ }
  }, []);

  // Fetch entity-based initiatives for Mission Control (only when view is active)
  const { data: entityInitiatives } = useEntityInitiatives(dashboardView === 'mission-control');
  const { data: liveInitiatives } = useLiveInitiatives(dashboardView === 'mission-control');
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

  useEffect(() => {
    const firstSessionId = data.sessions.nodes[0]?.id ?? null;
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

    const selectedExists = data.sessions.nodes.some((node) => node.id === selectedSessionId);
    if (!selectedExists) {
      setSelectedSessionId(firstSessionId);
    }
  }, [data.sessions.nodes, selectedSessionId]);

  useEffect(() => {
    if (!activityFilterSessionId) return;
    const stillExists = data.sessions.nodes.some((node) => node.id === activityFilterSessionId);
    if (!stillExists) {
      setActivityFilterSessionId(null);
    }
  }, [activityFilterSessionId, data.sessions.nodes]);

  const handleSelectSession = useCallback((sessionId: string) => {
    void import('@/components/sessions/SessionInspector');
    setSelectedSessionId(sessionId);
    setSessionDrawerOpen(true);
    setActivityFilterSessionId(sessionId);
    setActivityFilterWorkstreamId(null);
    setActivityFilterWorkstreamLabel(null);
  }, []);

  const focusActivityRunId = useCallback(
    (runId: string) => {
      const trimmed = runId.trim();
      if (!trimmed) return;
      const session =
        data.sessions.nodes.find((node) => node.runId === trimmed || node.id === trimmed) ?? null;
      if (!session) return;
      handleSelectSession(session.id);
      setOpsNotice(`Focused session: ${session.title}`);
    },
    [data.sessions.nodes, handleSelectSession]
  );

  const selectedActivitySession = useMemo(
    () => data.sessions.nodes.find((n) => n.id === activityFilterSessionId) ?? null,
    [activityFilterSessionId, data.sessions.nodes]
  );

  const selectedSession = useMemo(
    () => data.sessions.nodes.find((n) => n.id === selectedSessionId) ?? null,
    [data.sessions.nodes, selectedSessionId]
  );

  const activeSessionCount = useMemo(
    () => data.sessions.nodes.filter((node) => ['running', 'queued', 'pending'].includes(node.status)).length,
    [data.sessions.nodes]
  );

  const blockedCount = useMemo(
    () => data.sessions.nodes.filter((node) => node.status === 'blocked' || node.blockers.length > 0).length,
    [data.sessions.nodes]
  );

  const failedCount = useMemo(
    () => data.sessions.nodes.filter((node) => node.status === 'failed').length,
    [data.sessions.nodes]
  );

  const compactMetrics = useMemo(() => {
    const metrics: Array<{
      id: string;
      label: string;
      value: number;
      color: string;
    }> = [
      {
        id: 'sessions',
        label: 'Sessions',
        value: data.sessions.nodes.length,
        color: colors.teal,
      },
      {
        id: 'active',
        label: 'Active',
        value: activeSessionCount,
        color: activeSessionCount > 0 ? colors.lime : colors.textMuted,
      },
      {
        id: 'blocked',
        label: 'Blocked',
        value: blockedCount,
        color: blockedCount > 0 ? colors.red : colors.textMuted,
      },
      {
        id: 'failed',
        label: 'Failed',
        value: failedCount,
        color: failedCount > 0 ? colors.red : colors.textMuted,
      },
      {
        id: 'decisions',
        label: 'Decisions',
        value: decisionsVisible ? data.decisions.length : 0,
        color:
          decisionsVisible && data.decisions.length > 0
            ? colors.amber
            : colors.textMuted,
      },
      {
        id: 'outbox',
        label: 'Outbox',
        value: data.outbox.pendingTotal,
        color:
          data.outbox.replayStatus === 'error'
            ? colors.red
            : data.outbox.pendingTotal > 0
              ? colors.amber
              : colors.textMuted,
      },
    ];
    if (data.handoffs.length > 0) {
      metrics.push({
        id: 'handoffs',
        label: 'Handoffs',
        value: data.handoffs.length,
        color: colors.iris,
      });
    }
    return metrics;
  }, [
    activeSessionCount,
    blockedCount,
    failedCount,
    data.decisions.length,
    data.handoffs.length,
    data.outbox.pendingTotal,
    data.outbox.replayStatus,
    data.sessions.nodes.length,
    decisionsVisible,
  ]);

  const longestWaitMinutes = useMemo(
    () => data.decisions.length > 0 ? Math.max(0, ...data.decisions.map((d) => d.waitingMinutes)) : 0,
    [data.decisions]
  );

  const headerNotifications = useMemo(() => {
    const items: HeaderNotification[] = [];
    if (error) {
      items.push({
        id: `stream-error:${error}`,
        kind: 'error',
        icon: 'notification',
        title: 'Live stream degraded',
        message: error,
        actionLabel: 'Settings',
        onAction: () => openSettings('orgx'),
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
            ? 'Dashboard is offline. Some data may be stale.'
            : 'Live data is recovering. Some sections may be delayed.',
        actionLabel: 'Reconnect',
        onAction: handleReconnect,
      });
    }
    if (data.outbox.pendingTotal > 0) {
      items.push({
        id: `outbox:pending:${data.outbox.pendingTotal}`,
        kind: 'info',
        icon: 'notification',
        title: 'Buffered updates pending',
        message: `${data.outbox.pendingTotal} event(s) queued for replay.`,
      });
    }
    if (data.outbox.replayStatus === 'error' && data.outbox.lastReplayError) {
      items.push({
        id: `outbox:error:${data.outbox.lastReplayError}`,
        kind: 'error',
        icon: 'notification',
        title: 'Outbox replay failed',
        message: data.outbox.lastReplayError,
        actionLabel: 'Settings',
        onAction: () => openSettings('orgx'),
      });
    }
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
    handleReconnect,
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

    for (const node of data.sessions.nodes) {
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
        description: `${entry.workstreams.size} workstreams are active right now.`,
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
  }, [data.sessions.nodes, data.sessions.groups]);

  // Merge session-derived + entity-based initiatives for Mission Control
  const mcInitiatives = useMemo(() => {
    const mergeInitiative = (base: Initiative, incoming: Initiative): Initiative => ({
      ...base,
      ...incoming,
      health: incoming.health > 0 ? incoming.health : base.health,
      activeAgents: Math.max(base.activeAgents, incoming.activeAgents),
      totalAgents: Math.max(base.totalAgents, incoming.totalAgents),
      avatars: base.avatars?.length ? base.avatars : incoming.avatars,
      workstreams: base.workstreams?.length ? base.workstreams : incoming.workstreams,
      description: base.description ?? incoming.description,
      rawStatus: incoming.rawStatus ?? base.rawStatus ?? null,
      targetDate: incoming.targetDate ?? base.targetDate ?? null,
      createdAt: incoming.createdAt ?? base.createdAt ?? null,
      updatedAt: incoming.updatedAt ?? base.updatedAt ?? null,
    });

    const merged = new Map<string, Initiative>();
    for (const init of initiatives) merged.set(init.id, init);

    // Apply live snapshot first, then entity records so user-initiated status
    // mutations (pause/resume/delete/archive) win immediately in Mission Control.
    for (const init of [...(liveInitiatives ?? []), ...(entityInitiatives ?? [])]) {
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
  }, [initiatives, entityInitiatives, liveInitiatives, initiativeTombstones]);

  const selectedActivitySessionLabel = useMemo(() => {
    if (!selectedActivitySession) return null;

    const agentName = selectedActivitySession.agentName;
    const title = selectedActivitySession.title;

    // Try agent name first
    if (agentName) {
      // Find latest activity summary for this session
      const latestActivity = data.activity.find(
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
  }, [data.activity, selectedActivitySession]);

  const missionControlAgents = useMemo<Agent[]>(() => {
    const byAgentId = new Map<string, Agent>();

    for (const node of data.sessions.nodes) {
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
  }, [data.sessions.nodes]);

  const showMissionControlWelcome =
    onboarding.state.connectionVerified && !dismissedMissionControlWelcome;

  const continueHighestPriority = useCallback(async () => {
    if (data.sessions.nodes.length === 0) {
      setOpsNotice('No sessions available to continue.');
      return;
    }

    const target = [...data.sessions.nodes].sort(compareSessionPriority)[0];
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

    setOpsNotice(`Focused highest priority session: ${target.title}`);
    await refetch();
  }, [data.sessions.nodes, refetch]);

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

      setOpsNotice(`Dispatch requested: ${session.title}`);
      await refetch();
    },
    [refetch]
  );

  const runControlAction = useCallback(
    async (
      session: SessionTreeNode,
      action: 'pause' | 'resume' | 'cancel' | 'rollback',
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

      setOpsNotice(
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
      setOpsNotice(`Pause requested: ${session.title}`);
      await refetch();
    },
    [refetch, runControlAction]
  );

  const resumeSession = useCallback(
    async (session: SessionTreeNode) => {
      await runControlAction(session, 'resume', { reason: 'resume_from_dashboard' });
      setOpsNotice(`Resume requested: ${session.title}`);
      await refetch();
    },
    [refetch, runControlAction]
  );

  const cancelSession = useCallback(
    async (session: SessionTreeNode) => {
      await runControlAction(session, 'cancel', { reason: 'cancel_from_dashboard' });
      setOpsNotice(`Cancel requested: ${session.title}`);
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
      setOpsNotice(`Rollback requested for ${session.title}.`);
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
          setOpsNotice('Select an initiative first to start a workstream.');
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

      setOpsNotice(`Created ${type}: ${title}`);
      closeEntityModal();
      await refetch();
    } catch (err) {
      setOpsNotice(err instanceof Error ? err.message : `Failed to create ${type}.`);
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
      const candidate = [...data.sessions.nodes]
        .filter((node) => (node.initiativeId ?? node.groupId) === initiative.id)
        .sort(compareSessionPriority)[0];
      if (candidate) {
        setSelectedSessionId(candidate.id);
        setActivityFilterSessionId(candidate.id);
        setActivityFilterWorkstreamId(null);
        setActivityFilterWorkstreamLabel(null);
        setOpsNotice(`Focused initiative: ${initiative.name}`);
      }
    },
    [data.sessions.nodes]
  );

  const followQueuedWorkstream = useCallback(
    (item: NextUpQueueItem) => {
      setActivityFilterSessionId(null);
      setActivityFilterWorkstreamId(item.workstreamId);
      setActivityFilterWorkstreamLabel(item.workstreamTitle);
      setAgentFilter(null);
      switchDashboardView('activity');
      setOpsNotice(`Following workstream: ${item.workstreamTitle}`);
    },
    [switchDashboardView]
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

  const focusActivitySessionByStatus = useCallback(
    (statuses: string[]) => {
      const statusSet = new Set(statuses);
      const candidate = [...data.sessions.nodes]
        .filter((node) => statusSet.has(node.status))
        .sort(compareSessionPriority)[0];
      if (!candidate) {
        setOpsNotice('No matching sessions for that metric right now.');
        return;
      }
      handleSelectSession(candidate.id);
      setMobileTab('activity');
    },
    [data.sessions.nodes, handleSelectSession]
  );

  const handleCompactMetricClick = useCallback(
    (metricId: string) => {
      if (dashboardView !== 'activity') return;

      if (metricId === 'sessions') {
        setAgentFilter(null);
        setActivityFilterSessionId(null);
        setActivityFilterWorkstreamId(null);
        setActivityFilterWorkstreamLabel(null);
        setMobileTab('agents');
        return;
      }
      if (metricId === 'active') {
        focusActivitySessionByStatus(['running', 'active', 'queued', 'pending', 'in_progress']);
        return;
      }
      if (metricId === 'blocked') {
        focusActivitySessionByStatus(['blocked']);
        return;
      }
      if (metricId === 'failed') {
        focusActivitySessionByStatus(['failed']);
        return;
      }
      if (metricId === 'decisions') {
        setExpandedRightPanel('decisions');
        setMobileTab('decisions');
        return;
      }
      if (metricId === 'outbox') {
        openSettings('orgx');
        return;
      }
      if (metricId === 'handoffs') {
        setMobileTab('agents');
      }
    },
    [dashboardView, focusActivitySessionByStatus, openSettings]
  );

  if (isLoading) {
    return (
      <div className="flex min-h-screen flex-col lg:h-screen" style={{ backgroundColor: colors.background }}>
        <div className="border-b border-white/[0.06] px-4 py-2.5 sm:px-6">
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
          <div className="rounded-full border border-white/[0.12] bg-white/[0.06] px-4 py-2 text-[11px] text-white/80 shadow-[0_10px_30px_rgba(0,0,0,0.35)] backdrop-blur">
            Dev preview on 5173. Installed plugin runs on OpenClaw port{' '}
            <a
              href="http://127.0.0.1:18789/orgx/live/"
              className="text-white underline underline-offset-4 hover:text-white/60"
            >
              18789
            </a>
            .
          </div>
        </div>
      )}


      <header className="relative z-[180] border-b border-white/[0.06] px-4 py-1.5 sm:px-6">
        <div className="flex items-center justify-between gap-2.5 lg:grid lg:grid-cols-[1fr_auto_1fr]">
          <div className="flex min-w-0 items-center gap-2.5">
            <OrgXLogo />
            <h1 className="text-[16px] font-semibold tracking-tight text-white sm:text-[17px]">
              OrgX<span className="ml-1.5 text-white/50">Live</span>
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
                error ? `Error: ${error}` : null,
              ]
                .filter(Boolean)
                .join('\n')}
            >
              {CONNECTION_LABEL[data.connection] ?? 'Unknown'}
            </Badge>
            {(data.outbox.pendingTotal > 0 || data.outbox.replayStatus === 'error') && (
              <div className="hidden sm:block">
                <Badge
                  color={data.outbox.replayStatus === 'error' ? colors.red : colors.amber}
                  pulse={data.outbox.pendingTotal > 0 && data.outbox.replayStatus !== 'error'}
                >
                  Outbox {data.outbox.pendingTotal}
                </Badge>
              </div>
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
                className={`rounded-full px-3 py-1 text-[12px] font-medium transition-all ${
                  dashboardView === 'activity'
                    ? 'bg-white/[0.1] text-white'
                    : 'text-white/55 hover:text-white/85'
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
	              className={`rounded-full px-3 py-1 text-[12px] font-medium transition-all ${
	                dashboardView === 'mission-control'
	                  ? 'bg-white/[0.1] text-white'
	                  : 'text-white/55 hover:text-white/85'
	              }`}
	            >
	              Mission Control
	            </button>
            </div>
          </div>

          <div className="relative isolate flex items-center justify-end gap-1.5 sm:gap-2">
            {data.lastActivity && (
              <span className="hidden text-[12px] text-white/45 xl:inline">
                Last activity: {data.lastActivity}
              </span>
            )}
            {data.outbox.pendingTotal > 0 && (
              <span className="hidden text-[12px] text-white/45 xl:inline">
                Replay: {data.outbox.replayStatus}
              </span>
            )}
            {demoMode && (
              <button
                type="button"
                onClick={() => {
                  setDemoMode(false);
                  handleReconnect();
                }}
                className="hidden rounded-full border border-amber-200/25 bg-amber-200/10 px-3 py-1.5 text-[11px] font-semibold text-amber-100 transition-colors hover:bg-amber-200/15 sm:inline"
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
              className="relative inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.03] text-white/80 transition-colors hover:bg-white/[0.08]"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 17h5l-1.4-1.4a2 2 0 0 1-.6-1.4V11a6 6 0 1 0-12 0v3.2c0 .53-.21 1.04-.59 1.42L4 17h5" />
                <path d="M9 17a3 3 0 0 0 6 0" />
              </svg>
              {visibleNotifications.length > 0 && (
                <span className="absolute -right-1 -top-1 inline-flex min-h-[16px] min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                  {visibleNotifications.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => openSettings('orgx')}
              title="Settings"
              className="relative inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.03] text-white/80 transition-colors hover:bg-white/[0.08]"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />
                <path d="M19.4 15a1.8 1.8 0 0 0 .36 2l.05.05a2.2 2.2 0 0 1-1.56 3.76 2.2 2.2 0 0 1-1.56-.64l-.05-.05a1.8 1.8 0 0 0-2-.36 1.8 1.8 0 0 0-1.1 1.63V22a2.2 2.2 0 0 1-4.4 0v-.07a1.8 1.8 0 0 0-1.1-1.63 1.8 1.8 0 0 0-2 .36l-.05.05a2.2 2.2 0 1 1-3.12-3.12l.05-.05a1.8 1.8 0 0 0 .36-2 1.8 1.8 0 0 0-1.63-1.1H2a2.2 2.2 0 0 1 0-4.4h.07a1.8 1.8 0 0 0 1.63-1.1 1.8 1.8 0 0 0-.36-2l-.05-.05a2.2 2.2 0 1 1 3.12-3.12l.05.05a1.8 1.8 0 0 0 2 .36 1.8 1.8 0 0 0 1.1-1.63V2a2.2 2.2 0 0 1 4.4 0v.07a1.8 1.8 0 0 0 1.1 1.63 1.8 1.8 0 0 0 2-.36l.05-.05a2.2 2.2 0 0 1 3.12 3.12l-.05.05a1.8 1.8 0 0 0-.36 2 1.8 1.8 0 0 0 1.63 1.1H22a2.2 2.2 0 0 1 0 4.4h-.07a1.8 1.8 0 0 0-1.63 1.1z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => {
                setFirstRunGuideOpen(true);
                try { window.sessionStorage.setItem(FIRST_RUN_GUIDE_SESSION_KEY, '1'); } catch { /* ignore */ }
              }}
              title="Help"
              className="relative inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.03] text-white/80 transition-colors hover:bg-white/[0.08]"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4" />
                <path d="M12 17h.01" />
                <circle cx="12" cy="12" r="9" />
              </svg>
            </button>
            <button
              type="button"
              onClick={refetch}
              className="group inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.03] text-[12px] text-white/80 transition-colors hover:bg-white/[0.08] sm:w-auto sm:gap-1.5 sm:px-3"
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
                className="absolute right-0 top-[calc(100%+8px)] z-[320] w-[min(92vw,380px)] rounded-2xl border border-white/[0.12] bg-[#070a11]/95 p-2 shadow-[0_20px_50px_rgba(0,0,0,0.45)] backdrop-blur"
              >
                <div className="mb-1.5 flex items-center justify-between px-2 py-1">
                  <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-white/55">Notifications</p>
                  <div className="flex items-center gap-2">
                    {visibleNotifications.length > 0 && (
                      <button
                        type="button"
                        onClick={clearNotifications}
                        className="text-[11px] text-white/45 transition-colors hover:text-white/80"
                      >
                        Dismiss all
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setNotificationTrayOpen(false)}
                      className="rounded-md px-1.5 py-0.5 text-[11px] text-white/45 transition-colors hover:bg-white/[0.08] hover:text-white/80"
                      aria-label="Close notifications"
                    >
                      Close
                    </button>
                  </div>
                </div>

                <div className="mb-1.5 flex flex-wrap items-center gap-1.5 px-1.5">
                  {compactMetrics.map((metric) => (
                    <span
                      key={metric.id}
                      className="inline-flex items-center gap-1 rounded-full border border-white/[0.1] bg-white/[0.03] px-2 py-0.5 text-[10px]"
                    >
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: metric.color }} />
                      <span className="uppercase tracking-[0.08em] text-white/45">{metric.label}</span>
                      <span className="font-semibold text-white" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {metric.value}
                      </span>
                    </span>
                  ))}
                </div>

                {visibleNotifications.length === 0 ? (
                  <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-3 text-[12px] text-white/45">
                    Everything looks clear.
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
                              className="inline-flex items-center gap-1.5 text-[12px] font-semibold"
                              style={{ color: item.kind === 'error' ? '#fecaca' : '#e2e8f0' }}
                            >
                              <EntityIcon type={item.icon} size={12} className="opacity-90" />
                              <span className="truncate">{item.title}</span>
                            </p>
                            <p className="mt-0.5 text-[12px] leading-snug text-white/65">{item.message}</p>
                            {item.onAction && (
                              <button
                                type="button"
                                onClick={() => { item.onAction?.(); setNotificationTrayOpen(false); }}
                                className="mt-1.5 rounded-md border border-white/[0.12] bg-white/[0.05] px-2.5 py-1 text-[11px] font-medium text-white/75 transition-colors hover:bg-white/[0.1] hover:text-white"
                              >
                                {item.actionLabel ?? 'View'}
                              </button>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => dismissNotification(item.id)}
                            className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-white/45 transition-colors hover:bg-white/[0.08] hover:text-white/80"
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

        <div className="mt-2 flex items-center justify-center lg:hidden">
          <div
            className="flex w-full max-w-[340px] rounded-full border border-white/[0.1] bg-white/[0.03] p-0.5"
            role="group"
            aria-label="Dashboard view"
          >
            <button
              type="button"
              onClick={() => switchDashboardView('activity')}
              aria-pressed={dashboardView === 'activity'}
              className={`flex-1 rounded-full px-3 py-1.5 text-[12px] font-medium transition-all ${
                dashboardView === 'activity'
                  ? 'bg-white/[0.1] text-white'
                  : 'text-white/55 hover:text-white/85'
              }`}
            >
              Activity
            </button>
            <button
              type="button"
              onClick={() => switchDashboardView('mission-control')}
              aria-pressed={dashboardView === 'mission-control'}
              className={`flex-1 rounded-full px-3 py-1.5 text-[12px] font-medium transition-all ${
                dashboardView === 'mission-control'
                  ? 'bg-white/[0.1] text-white'
                  : 'text-white/55 hover:text-white/85'
              }`}
            >
              Mission Control
            </button>
          </div>
        </div>

        {showMissionControlWelcome && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#7C7CFF]/30 bg-[#7C7CFF]/10 px-3 py-2 text-[12px] text-[#E6E4FF]">
            <span>
              Mission Control now includes a dependency map plus expandable hierarchy rows for initiatives, workstreams, milestones, and tasks.
            </span>
            <div className="flex items-center gap-2">
	              <button
	                type="button"
	                onClick={() => switchDashboardView('mission-control')}
	                onMouseEnter={prefetchMissionControl}
	                onFocus={prefetchMissionControl}
	                className="rounded-full border border-[#BFFF00]/30 bg-[#BFFF00]/15 px-2.5 py-1 text-[11px] text-[#D8FFA1]"
	              >
	                Open
	              </button>
              <button
                type="button"
                onClick={() => setDismissedMissionControlWelcome(true)}
                className="text-[11px] text-white/65 underline underline-offset-2"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </header>

      {/* Activity-only quick metric actions */}
      {dashboardView === 'activity' && (
        <div className="flex items-center gap-1.5 overflow-x-auto border-b border-white/[0.06] px-4 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:px-6">
          {compactMetrics.map((metric) => (
            <button
              key={metric.id}
              type="button"
              onClick={() => handleCompactMetricClick(metric.id)}
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/[0.1] bg-white/[0.03] px-2 py-0.5 text-[10px] transition-colors hover:bg-white/[0.08]"
              title={`Focus ${metric.label.toLowerCase()}`}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: metric.color }} />
              <span className="font-semibold text-white" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {metric.value}
              </span>
              <span className="uppercase tracking-[0.08em] text-white/45">{metric.label}</span>
            </button>
          ))}
        </div>
      )}

	      {dashboardView === 'mission-control' ? (
	        <div className="relative z-0 flex-1 min-h-0 flex flex-col overflow-hidden">
	          <Suspense
	            fallback={
	              <div className="flex flex-1 items-center justify-center text-[12px] text-white/50">
	                Loading Mission Control…
	              </div>
	            }
	          >
	            <LazyMissionControlView
	              initiatives={mcInitiatives}
	              activities={data.activity}
	              agents={missionControlAgents}
              runtimeInstances={data.runtimeInstances ?? []}
	              isLoading={isLoading}
	              authToken={null}
	              embedMode={false}
	              connection={data.connection}
	              lastSnapshotAt={data.lastSnapshotAt}
	              error={error}
	              hasApiKey={onboarding.state.hasApiKey}
	              onOpenSettings={() => openSettings('orgx')}
	              onRefresh={refetch}
                onFollowWorkstream={followQueuedWorkstream}
	            />
	          </Suspense>
	        </div>
	      ) : (
      <main className="relative z-0 grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 pb-20 sm:p-5 sm:pb-20 lg:grid-cols-12 lg:overflow-hidden lg:pb-5">
        {/* Decision Urgency Banner */}
        {decisionsVisible && data.decisions.length > 0 && expandedRightPanel !== 'decisions' && (
          <button
            type="button"
            onClick={() => setExpandedRightPanel('decisions')}
            className={cn(
              'col-span-full flex items-center gap-2 rounded-xl border px-4 py-2.5 text-left transition-colors hover:bg-white/[0.03]',
              data.decisions.length >= 20
                ? 'border-red-400/30 bg-red-500/[0.08]'
                : 'border-amber-300/30 bg-amber-400/[0.08]'
            )}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={data.decisions.length >= 20 ? 'text-red-300' : 'text-amber-300'}>
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span className={`text-[12px] font-medium ${data.decisions.length >= 20 ? 'text-red-200' : 'text-amber-200'}`}>
              {data.decisions.length} decision{data.decisions.length === 1 ? '' : 's'} waiting
              {longestWaitMinutes > 0 ? ` · longest: ${longestWaitMinutes}m` : ''}
            </span>
            <span className={`ml-auto text-[11px] ${data.decisions.length >= 20 ? 'text-red-300/70' : 'text-amber-300/70'}`}>
              Click to review →
            </span>
          </button>
        )}

        <section className={`min-h-0 lg:col-span-3 lg:flex lg:flex-col lg:[&>section]:h-full ${mobileTab !== 'agents' ? 'hidden lg:flex' : ''}`}>
	          <AgentsChatsPanel
	            sessions={data.sessions}
	            activity={data.activity}
            runtimeInstances={data.runtimeInstances ?? []}
	            selectedSessionId={selectedSessionId}
	            onSelectSession={handleSelectSession}
	            onAgentFilter={setAgentFilter}
            agentFilter={agentFilter}
            onReconnect={handleReconnect}
            connectionStatus={data.connection}
          />
        </section>

        <section className={`min-h-0 lg:col-span-6 lg:flex lg:flex-col lg:[&>section]:h-full ${mobileTab !== 'activity' ? 'hidden lg:flex' : ''}`}>
	          <ActivityTimeline
	            activity={data.activity}
	            sessions={data.sessions.nodes}
	            initiatives={initiatives}
	            selectedRunIds={
	              selectedActivitySession
	                ? [selectedActivitySession.runId, selectedActivitySession.id]
	                : []
	            }
	            selectedSessionLabel={selectedActivitySessionLabel}
              selectedWorkstreamId={activityFilterWorkstreamId}
              selectedWorkstreamLabel={activityFilterWorkstreamLabel}
	            agentFilter={agentFilter}
	            onClearSelection={clearActivitySessionFilter}
              onClearWorkstreamFilter={clearActivityWorkstreamFilter}
	            onClearAgentFilter={() => setAgentFilter(null)}
	            onFocusRunId={focusActivityRunId}
	          />
	        </section>

        <section className={`flex min-h-0 flex-col gap-2 lg:col-span-3 lg:gap-2 ${mobileTab !== 'decisions' && mobileTab !== 'initiatives' ? 'hidden lg:flex' : ''}`}>
          {/* Next Up — accordion panel (single-expand: one panel open at a time) */}
          <div className={`min-h-0 ${expandedRightPanel === 'initiatives' ? 'flex-1' : 'flex-shrink-0'} ${mobileTab === 'decisions' ? '' : mobileTab === 'initiatives' ? '' : ''}`}>
            {expandedRightPanel === 'initiatives' ? (
              <NextUpPanel
                title="Next Up"
                onFollowWorkstream={followQueuedWorkstream}
                onOpenInitiative={openInitiativeFromNextUp}
              />
            ) : (
              <PremiumCard className="card-enter">
                <button
                  onClick={() => setExpandedRightPanel('initiatives')}
                  className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-white/[0.03]"
                >
                  <div className="flex items-center gap-2">
                    <h2 className="text-[14px] font-semibold text-white">Next Up</h2>
                  </div>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="-rotate-90 text-white/40">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
              </PremiumCard>
            )}
          </div>

          {/* Decisions — accordion panel */}
          <div className={`min-h-0 ${expandedRightPanel === 'decisions' ? 'flex-1' : 'flex-shrink-0'} ${mobileTab === 'initiatives' ? 'hidden lg:block' : ''}`}>
            {expandedRightPanel === 'decisions' ? (
              decisionsVisible ? (
                <DecisionQueue
                  decisions={data.decisions}
                  onApproveDecision={approveDecision}
                  onApproveAll={approveAllDecisions}
                />
              ) : (
                <PremiumCard className="flex h-full min-h-[220px] flex-col card-enter">
                  <div className="space-y-2 border-b border-white/[0.06] px-4 py-3.5">
                    <h2 className="text-[14px] font-semibold text-white">Decisions</h2>
                    <p className="text-[12px] text-white/45">
                      OrgX is not connected. Pending decision data is hidden in local-only mode.
                    </p>
                  </div>
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
                    <p className="text-[12px] text-white/45">Connect OrgX to review and approve live decisions.</p>
                    <button
                      onClick={handleReconnect}
                      className="rounded-md border border-lime/25 bg-lime/10 px-3 py-1.5 text-[11px] font-semibold text-lime transition-colors hover:bg-lime/20"
                    >
                      Connect OrgX
                    </button>
                  </div>
                </PremiumCard>
              )
            ) : (
              <PremiumCard className="card-enter">
                <button
                  onClick={() => setExpandedRightPanel('decisions')}
                  className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-white/[0.03]"
                >
                  <div className="flex items-center gap-2">
                    <h2 className="text-[14px] font-semibold text-white">Decisions</h2>
                    {decisionsVisible && data.decisions.length > 0 && (
                      <span className="chip text-[10px]" style={{ borderColor: `${colors.amber}44`, color: colors.amber }}>
                        {data.decisions.length}
                      </span>
                    )}
                    {!decisionsVisible && (
                      <span className="text-[10px] text-white/30">disconnected</span>
                    )}
                  </div>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="-rotate-90 text-white/40">
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
              className="fixed inset-0 z-[200] bg-black/40 backdrop-blur-sm hidden lg:block"
              onClick={() => setSessionDrawerOpen(false)}
            />
            <motion.div
              key="session-drawer-panel"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', stiffness: 400, damping: 35 }}
              className="fixed inset-y-0 right-0 z-[210] hidden w-[480px] flex-col lg:flex"
              style={{ backgroundColor: colors.cardBg }}
            >
              <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
                <h3 className="text-[13px] font-semibold text-white/70">Session Detail</h3>
                <button
                  type="button"
                  onClick={() => setSessionDrawerOpen(false)}
                  aria-label="Close session inspector"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.03] text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6L6 18" /><path d="M6 6l12 12" />
                  </svg>
                </button>
	              </div>
	              <div className="flex-1 min-h-0 overflow-y-auto">
	                <Suspense
	                  fallback={
	                    <div className="p-4 text-[12px] text-white/50">Loading session detail…</div>
	                  }
	                >
	                  <LazySessionInspector
	                    session={selectedSession}
	                    activity={data.activity}
	                    initiatives={initiatives}
	                    onContinueHighestPriority={continueHighestPriority}
	                    onDispatchSession={dispatchSession}
	                    onPauseSession={pauseSession}
	                    onResumeSession={resumeSession}
	                    onCancelSession={cancelSession}
	                    onCreateCheckpoint={createSessionCheckpoint}
	                    onRollbackSession={rollbackSession}
	                    onStartInitiative={startInitiative}
	                    onStartWorkstream={startWorkstream}
	                  />
	                </Suspense>
	              </div>
	            </motion.div>
	          </>
	        )}
      </AnimatePresence>

      <MobileTabBar
        activeTab={mobileTab}
        onTabChange={setMobileTab}
        pendingDecisionCount={decisionsVisible ? data.decisions.length : 0}
      />

      <Modal
        open={entityModal !== null}
        onClose={closeEntityModal}
        maxWidth="max-w-sm"
        fitContent
      >
        <div className="flex w-full flex-col">
          <div className="px-5 pt-5 pb-1">
            <h3 className="text-[15px] font-semibold text-white">
              {entityModal?.type === 'workstream' ? 'New Workstream' : 'New Initiative'}
            </h3>
            <p className="mt-1 text-[12px] leading-relaxed text-white/45">
              {entityModal?.type === 'workstream'
                ? 'Create a new workstream under the selected initiative.'
                : 'Create a new initiative to organize your work.'}
            </p>
          </div>
          <div className="px-5 py-4">
            <label className="mb-1.5 block text-[11px] uppercase tracking-[0.1em] text-white/45">
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
              className="w-full rounded-lg border border-white/[0.12] bg-black/30 px-3 py-2.5 text-[13px] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/40"
            />
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-3">
            <button
              onClick={closeEntityModal}
              className="rounded-md px-3 py-1.5 text-[12px] text-white/60 transition-colors hover:text-white"
            >
              Cancel
            </button>
            <button
              onClick={confirmCreateEntity}
              disabled={entityName.trim().length === 0 || entityCreating}
              className="rounded-md border border-lime/25 bg-lime/10 px-4 py-1.5 text-[12px] font-semibold text-lime transition-colors hover:bg-lime/20 disabled:opacity-45"
            >
              {entityCreating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      </Modal>

      <SettingsModal
        open={settingsState.open}
        onClose={() => setSettingsState((previous) => ({ ...previous, open: false }))}
        activeTab={settingsState.tab}
        onChangeTab={(tab) => setSettingsState((previous) => ({ ...previous, tab }))}
        onboarding={onboarding}
        authToken={null}
        embedMode={false}
      />

      <FirstRunGuideModal
        open={firstRunGuideOpen}
        onClose={() => setFirstRunGuideOpen(false)}
        onOpenSettings={() => openSettings('providers')}
        onOpenOrgxSettings={() => openSettings('orgx')}
        onOpenMissionControl={() => {
          switchDashboardView('mission-control');
          setFirstRunGuideOpen(false);
        }}
        demoMode={demoMode}
        connectionVerified={onboarding.state.connectionVerified}
        hasSessions={data.sessions.nodes.length > 0}
      />
    </div>
  );
}
