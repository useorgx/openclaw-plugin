import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveData } from '@/hooks/useLiveData';
import { colors } from '@/lib/tokens';
import type { Initiative, SessionTreeNode } from '@/types';
import { Badge } from '@/components/shared/Badge';
import { AgentsChatsPanel } from '@/components/sessions/AgentsChatsPanel';
import { SessionInspector } from '@/components/sessions/SessionInspector';
import { ActivityTimeline } from '@/components/activity/ActivityTimeline';
import { DecisionQueue } from '@/components/decisions/DecisionQueue';
import { InitiativePanel } from '@/components/initiatives/InitiativePanel';

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
      className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2"
      style={accent ? { borderTopColor: `${accent}50`, borderTopWidth: 2 } : undefined}
    >
      <p className="text-[9px] uppercase tracking-[0.12em] text-white/40">{label}</p>
      <p className="mt-0.5 text-[12px] font-semibold" style={{ color: accent ?? '#fff' }}>
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

export function App() {
  const { data, isLoading, error, refetch, approveDecision, approveAllDecisions } = useLiveData({
    useMock: false,
  });
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [opsNotice, setOpsNotice] = useState<string | null>(null);

  const clearSelectedSession = useCallback(() => {
    setSelectedSessionId(null);
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
        existing.workstreams.set(node.workstreamId, node.workstreamId);
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
  }, [data.sessions.nodes]);

  const continueHighestPriority = useCallback(async () => {
    if (data.sessions.nodes.length === 0) {
      setOpsNotice('No sessions available to continue.');
      return;
    }

    const target = [...data.sessions.nodes].sort(compareSessionPriority)[0];
    setSelectedSessionId(target.id);

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

  const createEntity = useCallback(
    async (type: 'initiative' | 'workstream', initiativeId?: string | null) => {
      const title = window.prompt(
        type === 'initiative'
          ? 'Name the new initiative'
          : 'Name the new workstream'
      );
      if (!title || title.trim().length === 0) return;

      const payload: Record<string, unknown> = {
        type,
        title: title.trim(),
        status: 'active',
      };

      if (type === 'workstream') {
        const parentInitiative =
          initiativeId ?? selectedSession?.initiativeId ?? initiatives[0]?.id ?? null;
        if (!parentInitiative) {
          setOpsNotice('Select an initiative first to start a workstream.');
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

      setOpsNotice(`Created ${type}: ${title.trim()}`);
      await refetch();
    },
    [initiatives, refetch, selectedSession?.initiativeId]
  );

  const startInitiative = useCallback(async () => {
    try {
      await createEntity('initiative');
    } catch (err) {
      setOpsNotice(err instanceof Error ? err.message : 'Failed to create initiative.');
    }
  }, [createEntity]);

  const startWorkstream = useCallback(
    async (initiativeId?: string | null) => {
      try {
        await createEntity('workstream', initiativeId);
      } catch (err) {
        setOpsNotice(err instanceof Error ? err.message : 'Failed to create workstream.');
      }
    },
    [createEntity]
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
        setOpsNotice(`Focused initiative: ${initiative.name}`);
      }
    },
    [data.sessions.nodes]
  );

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ backgroundColor: colors.background }}>
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-5 py-4 text-sm text-white/65">
          Loading live workspace...
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen flex-col" style={{ backgroundColor: colors.background }}>
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
            <Badge color={CONNECTION_COLOR[data.connection]}>
              {CONNECTION_LABEL[data.connection] ?? 'Unknown'}
            </Badge>
          </div>

          <div className="flex items-center gap-2.5">
            {data.lastActivity && (
              <span className="hidden text-[11px] text-white/45 sm:inline">
                Last activity: {data.lastActivity}
              </span>
            )}
            <a
              href="https://mcp.useorgx.com"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden rounded-lg border border-white/[0.1] bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-white/55 transition-colors hover:bg-white/[0.07] hover:text-white/80 sm:inline-flex"
            >
              Docs
            </a>
            <button
              onClick={refetch}
              className="group flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-white/80 transition-colors hover:bg-white/[0.07]"
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
            value={data.decisions.length}
            accent={data.decisions.length > 0 ? colors.amber : undefined}
          />
          <StatTile label="Open Handoffs" value={data.handoffs.length} accent={data.handoffs.length > 0 ? colors.iris : undefined} />
        </div>

        {opsNotice && (
          <div className="mt-2 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[11px] text-white/75">
            {opsNotice}
          </div>
        )}

        {error && (
          <div className="mt-2 rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
            Live stream degraded: {error}
          </div>
        )}
      </header>

      <main className="relative z-10 grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 sm:gap-4 sm:p-4 lg:grid-cols-12">
        <section className="min-h-0 lg:col-span-3">
          <AgentsChatsPanel
            sessions={data.sessions}
            activity={data.activity}
            selectedSessionId={selectedSessionId}
            onSelectSession={setSelectedSessionId}
          />
        </section>

        <section className="min-h-0 lg:col-span-6">
          <ActivityTimeline
            activity={data.activity}
            sessions={data.sessions.nodes}
            selectedRunId={selectedSession?.runId ?? null}
            onClearSelection={clearSelectedSession}
          />
        </section>

        <section className="flex min-h-0 flex-col gap-3 lg:col-span-3">
          <DecisionQueue
            decisions={data.decisions}
            onApproveDecision={approveDecision}
            onApproveAll={approveAllDecisions}
          />
          <SessionInspector
            session={selectedSession}
            activity={data.activity}
            onContinueHighestPriority={continueHighestPriority}
            onDispatchSession={dispatchSession}
            onStartInitiative={startInitiative}
            onStartWorkstream={startWorkstream}
          />
          <InitiativePanel
            initiatives={initiatives}
            onInitiativeClick={handleInitiativeClick}
            onCreateInitiative={startInitiative}
            onCreateWorkstream={startWorkstreamFromSelection}
          />
        </section>
      </main>
    </div>
  );
}
