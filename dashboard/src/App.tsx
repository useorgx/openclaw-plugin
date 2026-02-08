import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveData } from '@/hooks/useLiveData';
import { useOnboarding } from '@/hooks/useOnboarding';
import { colors } from '@/lib/tokens';
import type { Initiative, OnboardingState, SessionTreeNode } from '@/types';
import { OnboardingGate } from '@/components/onboarding/OnboardingGate';
import { Badge } from '@/components/shared/Badge';
import { Modal } from '@/components/shared/Modal';
import { MobileTabBar } from '@/components/shared/MobileTabBar';
import type { MobileTab } from '@/components/shared/MobileTabBar';
import { AgentsChatsPanel } from '@/components/sessions/AgentsChatsPanel';
import { SessionInspector } from '@/components/sessions/SessionInspector';
import { ActivityTimeline } from '@/components/activity/ActivityTimeline';
import { DecisionQueue } from '@/components/decisions/DecisionQueue';
import { InitiativePanel } from '@/components/initiatives/InitiativePanel';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { MissionControlView } from '@/components/mission-control';
import { useEntityInitiatives } from '@/hooks/useEntityInitiatives';
import { useLiveInitiatives } from '@/hooks/useLiveInitiatives';
import orgxLogo from '@/assets/orgx-logo.png';

type DashboardView = 'activity' | 'mission-control';

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
  title: string;
  message: string;
};

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
    <DashboardShell
      onboardingState={onboarding.state}
      onReconnect={onboarding.resumeGate}
    />
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
  onboardingState,
  onReconnect,
}: {
  onboardingState: OnboardingState;
  onReconnect?: () => void;
}) {
  const shouldAttemptDecisions = onboardingState.hasApiKey && onboardingState.connectionVerified;

  const { data, isLoading, error, refetch, approveDecision, approveAllDecisions } = useLiveData({
    useMock: false,
    enabled: true,
    enableDecisions: shouldAttemptDecisions,
  });
  const decisionsVisible = shouldAttemptDecisions && data.connection === 'connected';
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [activityFilterSessionId, setActivityFilterSessionId] = useState<string | null>(null);
  const [opsNotice, setOpsNotice] = useState<string | null>(null);
  const [notificationTrayOpen, setNotificationTrayOpen] = useState(false);
  const [dismissedNotificationIds, setDismissedNotificationIds] = useState<string[]>([]);
  const notificationButtonRef = useRef<HTMLButtonElement | null>(null);
  const notificationTrayRef = useRef<HTMLDivElement | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>('agents');
  const [expandedRightPanel, setExpandedRightPanel] = useState<'initiatives' | 'decisions'>('initiatives');
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
    setSelectedSessionId(sessionId);
    setActivityFilterSessionId(sessionId);
  }, []);

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
    data.decisions.length,
    data.handoffs.length,
    data.outbox.pendingTotal,
    data.outbox.replayStatus,
    data.sessions.nodes.length,
    decisionsVisible,
  ]);

  const headerNotifications = useMemo(() => {
    const items: HeaderNotification[] = [];
    if (error) {
      items.push({
        id: `stream-error:${error}`,
        kind: 'error',
        title: 'Live stream degraded',
        message: error,
      });
    }
    if (data.connection !== 'connected') {
      items.push({
        id: `connection:${data.connection}`,
        kind: data.connection === 'disconnected' ? 'error' : 'info',
        title: data.connection === 'disconnected' ? 'Connection lost' : 'Reconnecting',
        message:
          data.connection === 'disconnected'
            ? 'Dashboard is offline. Some data may be stale.'
            : 'Live data is recovering. Some sections may be delayed.',
      });
    }
    if (data.outbox.pendingTotal > 0) {
      items.push({
        id: `outbox:pending:${data.outbox.pendingTotal}`,
        kind: 'info',
        title: 'Buffered updates pending',
        message: `${data.outbox.pendingTotal} event(s) queued for replay.`,
      });
    }
    if (data.outbox.replayStatus === 'error' && data.outbox.lastReplayError) {
      items.push({
        id: `outbox:error:${data.outbox.lastReplayError}`,
        kind: 'error',
        title: 'Outbox replay failed',
        message: data.outbox.lastReplayError,
      });
    }
    if (opsNotice) {
      items.push({
        id: `ops:${opsNotice}`,
        kind: 'info',
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
        (entry.statusCounts.blocked ?? 0) === 0;

      const phases = phaseNames.map((name, index) => {
        let status: 'completed' | 'current' | 'upcoming' | 'warning' = 'upcoming';
        if (completed || index < phasePosition) status = 'completed';
        if (index === phasePosition && !completed) status = blocked ? 'warning' : 'current';
        return { name, status };
      });

      output.push({
        id: entry.id,
        name: entry.name,
        status: completed ? 'completed' : blocked ? 'blocked' : 'active',
        rawStatus: completed ? 'completed' : blocked ? 'blocked' : 'active',
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

    for (const init of [...(entityInitiatives ?? []), ...(liveInitiatives ?? [])]) {
      const existing = merged.get(init.id);
      merged.set(init.id, existing ? mergeInitiative(existing, init) : init);
    }

    return Array.from(merged.values()).sort((a, b) => {
      const statusPriority = (status: Initiative['status']) =>
        status === 'blocked' ? 0 : status === 'active' ? 1 : status === 'paused' ? 2 : 3;
      const statusDelta = statusPriority(a.status) - statusPriority(b.status);
      if (statusDelta !== 0) return statusDelta;

      const updatedDelta = toEpoch(b.updatedAt) - toEpoch(a.updatedAt);
      if (updatedDelta !== 0) return updatedDelta;

      const healthDelta = b.health - a.health;
      if (healthDelta !== 0) return healthDelta;

      return a.name.localeCompare(b.name);
    });
  }, [initiatives, entityInitiatives, liveInitiatives]);

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

  const showMissionControlWelcome =
    onboardingState.connectionVerified && !dismissedMissionControlWelcome;

  const continueHighestPriority = useCallback(async () => {
    if (data.sessions.nodes.length === 0) {
      setOpsNotice('No sessions available to continue.');
      return;
    }

    const target = [...data.sessions.nodes].sort(compareSessionPriority)[0];
    setSelectedSessionId(target.id);
    setActivityFilterSessionId(target.id);

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
        setOpsNotice(`Focused initiative: ${initiative.name}`);
      }
    },
    [data.sessions.nodes]
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
      className="relative flex min-h-screen flex-col lg:h-screen lg:min-h-0 lg:overflow-hidden"
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

      <div className="pointer-events-none absolute inset-0">
        <div className="ambient-orb orb-lime" style={{ width: 460, height: 460, top: -180, left: -120 }} />
        <div
          className="ambient-orb orb-teal"
          style={{ width: 520, height: 520, top: -220, right: -180, animationDelay: '2s' }}
        />
        <div
          className="ambient-orb orb-iris"
          style={{ width: 420, height: 420, bottom: -180, left: '30%', animationDelay: '4s' }}
        />
        <div className="grain-overlay absolute inset-0" />
      </div>

      <header className="relative z-[180] border-b border-white/[0.06] px-4 py-1.5 sm:px-6">
        <div className="grid items-center gap-2.5 lg:grid-cols-[1fr_auto_1fr]">
          <div className="flex min-w-0 items-center gap-2.5">
            <OrgXLogo />
            <h1 className="text-[17px] font-semibold tracking-tight text-white">
              OrgX<span className="ml-1.5 text-white/50">Live</span>
            </h1>
            <Badge color={CONNECTION_COLOR[data.connection]} pulse={data.connection === 'connected'}>
              {CONNECTION_LABEL[data.connection] ?? 'Unknown'}
            </Badge>
            {(data.outbox.pendingTotal > 0 || data.outbox.replayStatus === 'error') && (
              <Badge
                color={data.outbox.replayStatus === 'error' ? colors.red : colors.amber}
                pulse={data.outbox.pendingTotal > 0 && data.outbox.replayStatus !== 'error'}
              >
                Outbox {data.outbox.pendingTotal}
              </Badge>
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

          <div className="relative isolate flex items-center justify-end gap-2">
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
              onClick={refetch}
              className="group inline-flex h-8 items-center gap-1.5 rounded-full border border-white/[0.1] bg-white/[0.03] px-3 text-[12px] text-white/80 transition-colors hover:bg-white/[0.08]"
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
                              className="text-[12px] font-semibold"
                              style={{ color: item.kind === 'error' ? '#fecaca' : '#e2e8f0' }}
                            >
                              {item.title}
                            </p>
                            <p className="mt-0.5 text-[12px] leading-snug text-white/65">{item.message}</p>
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

        <div className="mt-1.5 flex items-center justify-center lg:hidden">
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

        {showMissionControlWelcome && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#7C7CFF]/30 bg-[#7C7CFF]/10 px-3 py-2 text-[12px] text-[#E6E4FF]">
            <span>
              Mission Control now includes a dependency map plus expandable hierarchy rows for initiatives, workstreams, milestones, and tasks.
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => switchDashboardView('mission-control')}
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

      {dashboardView === 'mission-control' ? (
        <div className="relative z-0 flex-1 min-h-0 flex flex-col overflow-hidden">
          <MissionControlView
            initiatives={mcInitiatives}
            activities={[]}
            agents={[]}
            isLoading={isLoading}
            authToken={null}
            embedMode={false}
          />
        </div>
      ) : (
      <main className="relative z-0 grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 pb-20 sm:p-5 sm:pb-20 lg:grid-cols-12 lg:overflow-hidden lg:pb-5">
        <section className={`min-h-0 lg:col-span-3 lg:flex lg:flex-col lg:[&>section]:h-full ${mobileTab !== 'agents' ? 'hidden lg:flex' : ''}`}>
          <AgentsChatsPanel
            sessions={data.sessions}
            activity={data.activity}
            selectedSessionId={selectedSessionId}
            onSelectSession={handleSelectSession}
            onReconnect={onReconnect}
          />
        </section>

        <section className={`min-h-0 lg:col-span-6 lg:flex lg:flex-col lg:[&>section]:h-full ${mobileTab !== 'activity' ? 'hidden lg:flex' : ''}`}>
          <ActivityTimeline
            activity={data.activity}
            sessions={data.sessions.nodes}
            selectedRunIds={
              selectedActivitySession
                ? [selectedActivitySession.runId, selectedActivitySession.id]
                : []
            }
            selectedSessionLabel={selectedActivitySessionLabel}
            onClearSelection={clearActivitySessionFilter}
          />
        </section>

        <section className={`flex min-h-0 flex-col gap-2 lg:col-span-3 lg:gap-2 ${mobileTab !== 'decisions' && mobileTab !== 'initiatives' ? 'hidden lg:flex' : ''}`}>
          {/* Initiatives — collapsible accordion panel */}
          <div className={`min-h-0 ${expandedRightPanel === 'initiatives' ? 'flex-1' : 'flex-shrink-0'} ${mobileTab === 'decisions' ? '' : mobileTab === 'initiatives' ? '' : ''}`}>
            {expandedRightPanel === 'initiatives' ? (
              <InitiativePanel
                initiatives={initiatives}
                onInitiativeClick={handleInitiativeClick}
                onCreateInitiative={startInitiative}
                onCreateWorkstream={startWorkstreamFromSelection}
              />
            ) : (
              <PremiumCard className="card-enter">
                <button
                  onClick={() => setExpandedRightPanel('initiatives')}
                  className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-white/[0.03]"
                >
                  <div className="flex items-center gap-2">
                    <h2 className="text-[14px] font-semibold text-white">Initiatives</h2>
                    {initiatives.length > 0 && (
                      <span className="chip text-[10px]">{initiatives.length}</span>
                    )}
                  </div>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="-rotate-90 text-white/40">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
              </PremiumCard>
            )}
          </div>

          {/* Decisions — collapsible accordion panel */}
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
                    {onReconnect && (
                      <button onClick={onReconnect}
                        className="rounded-md border border-lime/25 bg-lime/10 px-3 py-1.5 text-[11px] font-semibold text-lime transition-colors hover:bg-lime/20">
                        Connect OrgX
                      </button>
                    )}
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

          {/* Session Detail — always available on desktop to reduce context switching */}
          <div className="hidden min-h-0 lg:flex lg:flex-1">
            <SessionInspector
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
          </div>
        </section>
      </main>
      )}

      <MobileTabBar
        activeTab={mobileTab}
        onTabChange={setMobileTab}
        pendingDecisionCount={decisionsVisible ? data.decisions.length : 0}
      />

      <Modal
        open={entityModal !== null}
        onClose={closeEntityModal}
        maxWidth="max-w-sm"
      >
        <div className="px-5 pt-5 pb-1">
          <h3 className="text-[15px] font-semibold text-white">
            {entityModal?.type === 'workstream' ? 'New Workstream' : 'New Initiative'}
          </h3>
          <p className="mt-1 text-[12px] text-white/45">
            {entityModal?.type === 'workstream'
              ? 'Create a new workstream under the selected initiative.'
              : 'Create a new initiative to organize your work.'}
          </p>
        </div>
        <div className="px-5 py-3">
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
            placeholder={entityModal?.type === 'workstream' ? 'e.g. User Onboarding Flow' : 'e.g. Q1 Product Launch'}
            className="w-full rounded-lg border border-white/[0.12] bg-black/30 px-3 py-2 text-[13px] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/40"
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
      </Modal>
    </div>
  );
}
