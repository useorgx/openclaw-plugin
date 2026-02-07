import { memo, useMemo, useState } from 'react';
import { colors } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import { resolveProvider } from '@/lib/providers';
import type { LiveActivityItem, SessionTreeNode } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { ProviderLogo } from '@/components/shared/ProviderLogo';

interface SessionInspectorProps {
  session: SessionTreeNode | null;
  activity: LiveActivityItem[];
  onContinueHighestPriority?: () => Promise<void> | void;
  onDispatchSession?: (session: SessionTreeNode) => Promise<void> | void;
  onStartInitiative?: () => Promise<void> | void;
  onStartWorkstream?: (initiativeId: string | null) => Promise<void> | void;
}

function resolveRunId(item: LiveActivityItem): string | null {
  if (item.runId) return item.runId;
  const metadata = item.metadata as Record<string, unknown> | undefined;
  if (!metadata) return null;
  const keys = ['runId', 'run_id', 'sessionId', 'session_id', 'agentRunId'];
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function pickFromMetadata(events: LiveActivityItem[], keys: string[]): string | null {
  for (const event of events) {
    const metadata = event.metadata as Record<string, unknown> | undefined;
    if (!metadata) continue;
    for (const key of keys) {
      const value = metadata[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  return null;
}

export const SessionInspector = memo(function SessionInspector({
  session,
  activity,
  onContinueHighestPriority,
  onDispatchSession,
  onStartInitiative,
  onStartWorkstream,
}: SessionInspectorProps) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const recentEvents = useMemo(() => {
    if (!session) return [] as LiveActivityItem[];

    return activity
      .filter((item) => resolveRunId(item) === session.runId)
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, 8);
  }, [activity, session]);

  const breadcrumbs = useMemo(() => {
    if (!session) return [] as Array<{ label: string; value: string }>;

    const initiative =
      pickFromMetadata(recentEvents, [
        'initiativeName',
        'initiative_name',
        'initiative',
        'groupLabel',
      ]) ??
      session.groupLabel;
    const workstream =
      pickFromMetadata(recentEvents, [
        'workstreamName',
        'workstream_name',
        'workstream',
        'stream',
      ]) ?? session.workstreamId;
    const milestone =
      pickFromMetadata(recentEvents, [
        'milestoneName',
        'milestone_name',
        'milestone',
        'phaseLabel',
        'phase_name',
      ]) ??
      session.phase ??
      null;
    const task =
      pickFromMetadata(recentEvents, ['taskName', 'task_name', 'task', 'title']) ??
      session.title;

    const output: Array<{ label: string; value: string }> = [];
    if (initiative) output.push({ label: 'Initiative', value: initiative });
    if (workstream) output.push({ label: 'Workstream', value: workstream });
    if (milestone) output.push({ label: 'Milestone', value: milestone });
    if (task) output.push({ label: 'Task', value: task });
    return output;
  }, [recentEvents, session]);

  const sessionSummary = useMemo(() => {
    if (!session) return null;
    const fromEvents = recentEvents[0]?.summary ?? recentEvents[0]?.description ?? null;
    const fromSession = session.lastEventSummary;
    const summary = fromSession ?? fromEvents ?? null;
    return summary && summary.trim().length > 0 ? summary.trim() : null;
  }, [recentEvents, session]);

  const provider = useMemo(() => {
    if (!session) return resolveProvider();
    return resolveProvider(
      session.agentName,
      session.title,
      session.lastEventSummary,
      sessionSummary,
      recentEvents[0]?.metadata
    );
  }, [recentEvents, session, sessionSummary]);

  const runAction = async (
    actionId: string,
    actionLabel: string,
    callback: (() => Promise<void> | void) | undefined
  ) => {
    if (!callback || busyAction) return;
    setBusyAction(actionId);
    setNotice(null);
    try {
      await callback();
      setNotice(`${actionLabel} requested.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : `${actionLabel} failed.`);
    } finally {
      setBusyAction(null);
    }
  };

  if (!session) {
    return (
      <PremiumCard className="flex flex-col fade-in-up">
        <div className="border-b border-white/[0.06] px-4 py-3">
          <h2 className="text-[13px] font-semibold text-white">Session Detail</h2>
        </div>
        <div className="space-y-2 p-4 text-[11px] text-white/45">
          <p>Select a session to inspect summary, breadcrumbs, blockers, and recent messages.</p>
          <button
            onClick={() =>
              runAction('continue-priority', 'Continue highest priority', onContinueHighestPriority)
            }
            disabled={!onContinueHighestPriority || !!busyAction}
            className="rounded-md border border-white/[0.12] bg-white/[0.04] px-2.5 py-1 text-[10px] text-white/70 transition-colors hover:bg-white/[0.08] disabled:opacity-45"
          >
            {busyAction === 'continue-priority' ? 'Dispatching…' : 'Continue highest priority'}
          </button>
          {notice && <p className="text-[10px] text-white/55">{notice}</p>}
        </div>
      </PremiumCard>
    );
  }

  const progressValue = session.progress === null ? null : Math.round(session.progress);
  const timelineInfo = [
    { label: 'Started', value: session.startedAt ? formatRelativeTime(session.startedAt) : '—' },
    { label: 'Updated', value: session.updatedAt ? formatRelativeTime(session.updatedAt) : '—' },
    { label: 'ETA', value: session.eta ?? '—' },
    {
      label: 'Checkpoints',
      value: session.checkpointCount !== null && session.checkpointCount !== undefined
        ? String(session.checkpointCount)
        : '—',
    },
  ];

  return (
    <PremiumCard className="flex flex-col fade-in-up">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
        <h2 className="text-[13px] font-semibold text-white">Session Detail</h2>
        <span className="chip text-[10px] uppercase">{session.status}</span>
      </div>

      <div className="space-y-3 p-4">
        <div className="flex items-start gap-2.5">
          <ProviderLogo provider={provider.id} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-medium text-white">{session.title}</p>
            <p className="mt-0.5 text-[10px] text-white/45">
              {session.agentName ?? 'Unassigned'} · {provider.label}
            </p>
          </div>
        </div>

        {breadcrumbs.length > 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-2.5">
            <p className="mb-1.5 text-[9px] uppercase tracking-[0.1em] text-white/35">
              Breadcrumb
            </p>
            <div className="flex flex-wrap items-center gap-1.5 text-[9px]">
              {breadcrumbs.map((crumb, index) => (
                <span key={`${crumb.label}-${crumb.value}`} className="inline-flex items-center gap-1.5">
                  <span className="rounded-full border border-white/[0.12] bg-white/[0.02] px-1.5 py-0.5 text-white/65">
                    {crumb.value}
                  </span>
                  {index < breadcrumbs.length - 1 && <span className="text-white/30">›</span>}
                </span>
              ))}
            </div>
          </div>
        )}

        {sessionSummary && (
          <p className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[10px] leading-relaxed text-white/65">
            {sessionSummary}
          </p>
        )}

        {progressValue !== null && (
          <div>
            <div className="mb-1 flex items-center justify-between text-[10px] text-white/55">
              <span>Progress</span>
              <span>{progressValue}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/[0.08]">
              <div
                className="h-1.5 rounded-full"
                style={{
                  width: `${progressValue}%`,
                  background: `linear-gradient(90deg, ${colors.lime}, ${colors.teal})`,
                }}
              />
            </div>
          </div>
        )}

        <dl className="grid grid-cols-1 gap-1 text-[10px] text-white/55 sm:grid-cols-2">
          {timelineInfo.map((row) => (
            <div key={row.label}>
              <dt className="text-white/35">{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() =>
              runAction('continue-priority', 'Continue highest priority', onContinueHighestPriority)
            }
            disabled={!onContinueHighestPriority || !!busyAction}
            className="rounded-md border border-white/[0.12] bg-white/[0.03] px-2 py-1.5 text-[10px] text-white/75 transition-colors hover:bg-white/[0.08] disabled:opacity-45"
          >
            {busyAction === 'continue-priority' ? 'Dispatching…' : 'Continue Priority'}
          </button>
          <button
            onClick={() => runAction('dispatch-session', 'Dispatch session', () => onDispatchSession?.(session))}
            disabled={!onDispatchSession || !!busyAction}
            className="rounded-md border border-lime/25 bg-lime/10 px-2 py-1.5 text-[10px] font-semibold text-lime transition-colors hover:bg-lime/20 disabled:opacity-45"
          >
            {busyAction === 'dispatch-session' ? 'Dispatching…' : 'Dispatch Session'}
          </button>
          <button
            onClick={() => runAction('start-initiative', 'Start initiative', onStartInitiative)}
            disabled={!onStartInitiative || !!busyAction}
            className="rounded-md border border-white/[0.12] bg-white/[0.03] px-2 py-1.5 text-[10px] text-white/75 transition-colors hover:bg-white/[0.08] disabled:opacity-45"
          >
            {busyAction === 'start-initiative' ? 'Creating…' : 'Start Initiative'}
          </button>
          <button
            onClick={() =>
              runAction('start-workstream', 'Start workstream', () =>
                onStartWorkstream?.(session.initiativeId)
              )
            }
            disabled={!onStartWorkstream || !!busyAction}
            className="rounded-md border border-white/[0.12] bg-white/[0.03] px-2 py-1.5 text-[10px] text-white/75 transition-colors hover:bg-white/[0.08] disabled:opacity-45"
          >
            {busyAction === 'start-workstream' ? 'Creating…' : 'Start Workstream'}
          </button>
        </div>

        {notice && (
          <p className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-[10px] text-white/55">
            {notice}
          </p>
        )}

        {session.blockers.length > 0 && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3">
            <h3 className="mb-1 text-[10px] uppercase tracking-[0.12em] text-red-200/70">
              Blockers
            </h3>
            <ul className="space-y-1 text-[11px] text-red-100/90">
              {session.blockers.map((blocker) => (
                <li key={blocker}>• {blocker}</li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <h3 className="mb-2 text-[10px] uppercase tracking-[0.12em] text-white/45">
            Recent Messages
          </h3>

          {recentEvents.length === 0 && (
            <p className="text-[11px] text-white/45">No recent messages for this run.</p>
          )}

          <div className="space-y-2">
            {recentEvents.map((event) => (
              <article
                key={event.id}
                className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2"
              >
                <p className="text-[11px] text-white/85">{event.title}</p>
                {(event.summary || event.description) && (
                  <p className="mt-0.5 line-clamp-2 text-[10px] text-white/55">
                    {event.summary ?? event.description}
                  </p>
                )}
                <p className="mt-1 text-[9px] text-white/35">
                  {new Date(event.timestamp).toLocaleString()} · {formatRelativeTime(event.timestamp)}
                </p>
              </article>
            ))}
          </div>
        </div>
      </div>
    </PremiumCard>
  );
});
