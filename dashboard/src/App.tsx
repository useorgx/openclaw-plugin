import { useCallback, useEffect, useMemo, useState } from 'react';
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

function StatTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: string;
}) {
  return (
    <div
      className="min-w-0 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5"
      style={accent ? { borderTopColor: `${accent}50`, borderTopWidth: 2 } : undefined}
    >
      <p className="text-[11px] uppercase tracking-[0.12em] text-white/40">{label}</p>
      <p className="mt-0.5 text-[16px] font-semibold" style={{ color: accent ?? '#fff', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </p>
    </div>
  );
}

function OrgXLogo() {
  return (
    <svg width="24" height="24" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="32" height="32" rx="8" fill={colors.lime} fillOpacity="0.12" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" stroke={colors.lime} strokeOpacity="0.3" />
      <path
        d="M10 16C10 12.686 12.686 10 16 10C19.314 10 22 12.686 22 16C22 19.314 19.314 22 16 22C12.686 22 10 19.314 10 16Z"
        stroke={colors.lime}
        strokeWidth="1.8"
      />
      <path
        d="M12.5 12.5L19.5 19.5M19.5 12.5L12.5 19.5"
        stroke={colors.lime}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
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
  const [mobileTab, setMobileTab] = useState<MobileTab>('agents');
  const [expandedRightPanel, setExpandedRightPanel] = useState<'initiatives' | 'decisions' | 'session'>('initiatives');

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

  useEffect(() => {
    if (!opsNotice) return undefined;
    const timer = setTimeout(() => setOpsNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [opsNotice]);

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
        category,
        health: Math.max(0, Math.min(100, health)),
        phases,
        currentPhase: completed ? phaseNames.length - 1 : phasePosition,
        daysRemaining: 0,
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
        <div className="border-b border-white/[0.06] px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="shimmer-skeleton h-6 w-6 rounded-lg" />
            <div className="shimmer-skeleton h-5 w-28 rounded-md" />
            <div className="shimmer-skeleton h-5 w-14 rounded-full" />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="shimmer-skeleton h-14 rounded-xl" />
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

      <header className="relative z-10 border-b border-white/[0.06] px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <OrgXLogo />
            <h1 className="text-[18px] font-semibold tracking-tight text-white">
              OrgX<span className="ml-1.5 text-white/50">Live</span>
            </h1>
            <Badge color={CONNECTION_COLOR[data.connection]} pulse={data.connection === 'connected'}>
              {CONNECTION_LABEL[data.connection] ?? 'Unknown'}
            </Badge>
          </div>

          <div className="flex items-center gap-2.5">
            {data.lastActivity && (
              <span className="hidden text-[12px] text-white/45 sm:inline">
                Last activity: {data.lastActivity}
              </span>
            )}
            <a
              href="https://mcp.useorgx.com"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden rounded-lg border border-white/[0.1] bg-white/[0.03] px-3 py-1.5 text-[12px] text-white/55 transition-colors hover:bg-white/[0.07] hover:text-white/80 sm:inline-flex"
            >
              Docs
            </a>
            <button
              onClick={refetch}
              className="group flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.03] px-3 py-1.5 text-[12px] text-white/80 transition-colors hover:bg-white/[0.07]"
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
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <StatTile label="Sessions" value={data.sessions.nodes.length} accent={colors.teal} />
          <StatTile label="Active" value={activeSessionCount} accent={activeSessionCount > 0 ? colors.lime : undefined} />
          <StatTile label="Blocked" value={blockedCount} accent={blockedCount > 0 ? colors.red : undefined} />
          <StatTile
            label="Pending Decisions"
            value={decisionsVisible ? data.decisions.length : 0}
            accent={decisionsVisible && data.decisions.length > 0 ? colors.amber : undefined}
          />
          <StatTile label="Open Handoffs" value={data.handoffs.length} accent={data.handoffs.length > 0 ? colors.iris : undefined} />
        </div>

        {opsNotice && (
          <div className="mt-2 rounded-lg border border-[#BFFF00]/20 bg-white/[0.04] px-3 py-2 text-[12px] text-white/75">
            {opsNotice}
          </div>
        )}

        {error && (
          <div className="mt-2 rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
            Live stream degraded: {error}
          </div>
        )}
      </header>

      <main className="relative z-10 grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto pb-20 p-4 sm:p-5 sm:pb-20 lg:grid-cols-12 lg:overflow-hidden lg:pb-5">
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

          {/* Session Detail — collapsible accordion panel */}
          <div className={`min-h-0 ${expandedRightPanel === 'session' ? 'flex-1' : 'flex-shrink-0'} ${mobileTab === 'initiatives' ? 'hidden lg:block' : ''}`}>
            {expandedRightPanel === 'session' ? (
              <SessionInspector
                session={selectedSession}
                activity={data.activity}
                initiatives={initiatives}
                onContinueHighestPriority={continueHighestPriority}
                onDispatchSession={dispatchSession}
                onStartInitiative={startInitiative}
                onStartWorkstream={startWorkstream}
              />
            ) : (
              <PremiumCard className="card-enter">
                <button
                  onClick={() => setExpandedRightPanel('session')}
                  className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-white/[0.03]"
                >
                  <div className="flex items-center gap-2">
                    <h2 className="text-[14px] font-semibold text-white">Session Detail</h2>
                    {selectedSession && (
                      <span className="chip text-[10px] uppercase">{selectedSession.status}</span>
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
