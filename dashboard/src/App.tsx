import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveData } from '@/hooks/useLiveData';
import { colors } from '@/lib/tokens';
import { Badge } from '@/components/shared/Badge';
import { AgentsChatsPanel } from '@/components/sessions/AgentsChatsPanel';
import { SessionInspector } from '@/components/sessions/SessionInspector';
import { ActivityTimeline } from '@/components/activity/ActivityTimeline';
import { HandoffPanel } from '@/components/handoffs/HandoffPanel';
import { DecisionQueue } from '@/components/decisions/DecisionQueue';

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

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2">
      <p className="text-[9px] uppercase tracking-[0.12em] text-white/40">{label}</p>
      <p className="mt-0.5 text-[12px] font-semibold text-white">{value}</p>
    </div>
  );
}

export function App() {
  const { data, isLoading, error, refetch, approveDecision, approveAllDecisions } = useLiveData({
    useMock: false,
  });
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
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
      {(import.meta.env.DEV ||
        (typeof window !== 'undefined' && window.location.port === '5173')) && (
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
        <div
          className="ambient-orb orb-lime"
          style={{ width: 460, height: 460, top: -180, left: -120 }}
        />
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
          <div className="flex min-w-0 items-center gap-2.5">
            <h1 className="text-[18px] font-semibold text-white">OrgX Live</h1>
            <Badge color={CONNECTION_COLOR[data.connection]}>
              {CONNECTION_LABEL[data.connection] ?? 'Unknown'}
            </Badge>
          </div>

          <div className="flex items-center gap-2">
            {data.lastActivity && (
              <span className="hidden text-[11px] text-white/45 sm:inline">
                Last activity: {data.lastActivity}
              </span>
            )}
            <button
              onClick={refetch}
              className="rounded-lg border border-white/[0.1] bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-white/80 transition-colors hover:bg-white/[0.07]"
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <StatTile label="Sessions" value={data.sessions.nodes.length} />
          <StatTile label="Active" value={activeSessionCount} />
          <StatTile label="Blocked" value={blockedCount} />
          <StatTile label="Pending Decisions" value={data.decisions.length} />
          <StatTile label="Open Handoffs" value={data.handoffs.length} />
        </div>

        {error && (
          <div className="mt-2 rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
            Live stream degraded: {error}
          </div>
        )}
      </header>

      <main className="relative z-10 grid flex-1 min-h-0 grid-cols-1 gap-3 p-3 sm:gap-4 sm:p-4 lg:grid-cols-12">
        <section className="min-h-0 lg:col-span-3">
          <AgentsChatsPanel
            sessions={data.sessions}
            selectedSessionId={selectedSessionId}
            onSelectSession={setSelectedSessionId}
          />
        </section>

        <section className="min-h-0 lg:col-span-6">
          <ActivityTimeline
            activity={data.activity}
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
          <SessionInspector session={selectedSession} activity={data.activity} />
          <HandoffPanel handoffs={data.handoffs} />
        </section>
      </main>
    </div>
  );
}
