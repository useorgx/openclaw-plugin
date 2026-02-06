import { memo, useMemo } from 'react';
import { colors } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import type { LiveActivityItem, SessionTreeNode } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';

interface SessionInspectorProps {
  session: SessionTreeNode | null;
  activity: LiveActivityItem[];
}

export const SessionInspector = memo(function SessionInspector({ session, activity }: SessionInspectorProps) {
  const recentEvents = useMemo(() => {
    if (!session) return [] as LiveActivityItem[];

    const items: LiveActivityItem[] = [];
    for (const item of activity) {
      if (item.runId !== session.runId) continue;
      items.push(item);
      if (items.length >= 5) break;
    }

    return items;
  }, [activity, session?.runId]);

  if (!session) {
    return (
      <PremiumCard className="flex flex-col fade-in-up">
        <div className="border-b border-white/[0.06] px-4 py-3">
          <h2 className="text-[13px] font-semibold text-white">Session Detail</h2>
        </div>
        <div className="p-4 text-[11px] text-white/45">
          Select a session to inspect run status, blockers, and recent events.
        </div>
      </PremiumCard>
    );
  }

  const progressValue = session.progress === null ? null : Math.round(session.progress);

  return (
    <PremiumCard className="flex flex-col fade-in-up">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
        <h2 className="text-[13px] font-semibold text-white">Session Detail</h2>
        <span className="chip text-[10px] uppercase">{session.status}</span>
      </div>

      <div className="space-y-3 p-4">
        <div>
          <p className="text-[12px] font-medium text-white">{session.title}</p>
          <p className="mt-0.5 text-[10px] text-white/45">
            {session.agentName ?? 'Unassigned'} · {session.groupLabel}
          </p>
        </div>

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
          <div>
            <dt className="text-white/35">Started</dt>
            <dd>{session.startedAt ? formatRelativeTime(session.startedAt) : '—'}</dd>
          </div>
          <div>
            <dt className="text-white/35">Updated</dt>
            <dd>{session.updatedAt ? formatRelativeTime(session.updatedAt) : '—'}</dd>
          </div>
        </dl>

        {session.blockers.length > 0 && (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
            <h3 className="mb-1 text-[10px] uppercase tracking-[0.12em] text-white/45">
              Blockers
            </h3>
            <ul className="space-y-1 text-[11px] text-white/75">
              {session.blockers.map((blocker) => (
                <li key={blocker}>• {blocker}</li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <h3 className="mb-2 text-[10px] uppercase tracking-[0.12em] text-white/45">
            Recent Events
          </h3>

          {recentEvents.length === 0 && (
            <p className="text-[11px] text-white/45">No recent events for this run.</p>
          )}

          <div className="space-y-2">
            {recentEvents.map((event) => (
              <article
                key={event.id}
                className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2"
              >
                <p className="text-[11px] text-white/85">{event.title}</p>
                <p className="mt-0.5 text-[9px] text-white/35">
                  {formatRelativeTime(event.timestamp)}
                </p>
              </article>
            ))}
          </div>
        </div>
      </div>
    </PremiumCard>
  );
});
