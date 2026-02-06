import { memo, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';
import type { SessionTreeNode, SessionTreeResponse } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';

interface AgentsChatsPanelProps {
  sessions: SessionTreeResponse;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
}

const MAX_VISIBLE_GROUPS = 120;
const MAX_VISIBLE_CHILD_SESSIONS = 10;
const ONLINE_STATUSES = new Set(['running', 'queued', 'pending', 'blocked']);
const OFFLINE_DATE_FILTERS = [
  { id: 'all', label: 'All offline', minutes: null },
  { id: '24h', label: '24h', minutes: 24 * 60 },
  { id: '3d', label: '3d', minutes: 3 * 24 * 60 },
  { id: '7d', label: '7d', minutes: 7 * 24 * 60 },
  { id: '30d', label: '30d', minutes: 30 * 24 * 60 },
] as const;

const statusColors: Record<string, string> = {
  running: colors.lime,
  queued: colors.amber,
  pending: colors.amber,
  blocked: colors.red,
  failed: colors.red,
  cancelled: colors.red,
  completed: colors.teal,
  archived: 'rgba(255,255,255,0.5)',
};

function statusColor(status: string): string {
  return statusColors[status] ?? colors.iris;
}

type AgentGroup = {
  agentId: string | null;
  agentName: string;
  nodes: SessionTreeNode[];
  latest: SessionTreeNode;
};

function sortByUpdated(a: SessionTreeNode, b: SessionTreeNode) {
  const toEpoch = (value: string | null | undefined) =>
    value ? new Date(value).getTime() : 0;
  return (
    toEpoch(b.updatedAt ?? b.lastEventAt ?? b.startedAt) -
    toEpoch(a.updatedAt ?? a.lastEventAt ?? a.startedAt)
  );
}

export const AgentsChatsPanel = memo(function AgentsChatsPanel({
  sessions,
  selectedSessionId,
  onSelectSession,
}: AgentsChatsPanelProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [offlineDateFilter, setOfflineDateFilter] =
    useState<(typeof OFFLINE_DATE_FILTERS)[number]['id']>('all');

  const { agents, hiddenGroupCount, filteredOutByDate } = useMemo(() => {
    const map = new Map<string, AgentGroup>();

    for (const node of sessions.nodes) {
      const key = node.agentId ?? 'unassigned';
      const existing = map.get(key);

      if (existing) {
        existing.nodes.push(node);
      } else {
        map.set(key, {
          agentId: node.agentId,
          agentName: node.agentName ?? 'Unassigned',
          nodes: [node],
          latest: node,
        });
      }
    }

    for (const group of map.values()) {
      group.nodes.sort(sortByUpdated);
      group.latest = group.nodes[0];
    }

    const sortedGroups = Array.from(map.values()).sort((a, b) =>
      sortByUpdated(a.latest, b.latest)
    );

    const selectedWindow =
      OFFLINE_DATE_FILTERS.find((item) => item.id === offlineDateFilter) ??
      OFFLINE_DATE_FILTERS[0];
    const cutoffEpoch =
      selectedWindow.minutes === null
        ? null
        : Date.now() - selectedWindow.minutes * 60_000;
    const toEpoch = (value: string | null | undefined) =>
      value ? new Date(value).getTime() : 0;

    const filteredGroups = sortedGroups.filter((group) => {
      if (cutoffEpoch === null) return true;

      const latest = group.latest;
      if (ONLINE_STATUSES.has(latest.status)) return true;

      const latestEpoch = toEpoch(latest.updatedAt ?? latest.lastEventAt ?? latest.startedAt);
      return latestEpoch >= cutoffEpoch;
    });

    const filteredOutByDate =
      cutoffEpoch === null
        ? 0
        : sortedGroups.filter((group) => {
            if (ONLINE_STATUSES.has(group.latest.status)) return false;
            const latestEpoch = toEpoch(
              group.latest.updatedAt ?? group.latest.lastEventAt ?? group.latest.startedAt
            );
            return latestEpoch < cutoffEpoch;
          }).length;

    return {
      agents: filteredGroups.slice(0, MAX_VISIBLE_GROUPS),
      hiddenGroupCount: Math.max(0, filteredGroups.length - MAX_VISIBLE_GROUPS),
      filteredOutByDate,
    };
  }, [offlineDateFilter, sessions.nodes]);

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <PremiumCard className="flex min-h-0 flex-col fade-in-up">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
        <div>
          <h2 className="text-[13px] font-semibold text-white">Agents / Chats</h2>
          <p className="text-[10px] text-white/45">Grouped by agent identity</p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="offline-date-filter" className="text-[10px] text-white/45">
            Offline
          </label>
          <select
            id="offline-date-filter"
            value={offlineDateFilter}
            onChange={(event) =>
              setOfflineDateFilter(
                event.target.value as (typeof OFFLINE_DATE_FILTERS)[number]['id']
              )
            }
            className="rounded-md border border-white/[0.1] bg-black/30 px-1.5 py-1 text-[10px] text-white/75 focus:outline-none focus:ring-1 focus:ring-white/30"
          >
            {OFFLINE_DATE_FILTERS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="chip">{sessions.nodes.length} sessions</span>
        </div>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {agents.length === 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-4 text-center text-[11px] text-white/45">
            {filteredOutByDate > 0
              ? 'No sessions match the selected offline date filter.'
              : 'No active chats yet.'}
          </div>
        )}

        {agents.map((group) => {
          const agentKey = group.agentId ?? 'unassigned';
          const isCollapsed = collapsed.has(agentKey);
          const hasChildren = group.nodes.length > 1;
          const lead = group.latest;
          const active = selectedSessionId === lead.id;
          const visibleChildren = isCollapsed
            ? []
            : group.nodes.slice(1, 1 + MAX_VISIBLE_CHILD_SESSIONS);
          const hiddenChildren = Math.max(
            0,
            group.nodes.length - 1 - visibleChildren.length
          );

          return (
            <div
              key={agentKey}
              className={cn(
                'overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.02] transition-all',
                active && 'border-white/20 bg-white/[0.05]'
              )}
            >
              <div className="flex items-stretch">
                <button
                  onClick={() => onSelectSession(lead.id)}
                  className={cn(
                    'flex-1 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03]'
                  )}
                >
                  <div className="flex items-start gap-2">
                    <span
                      className="mt-1.5 h-2 w-2 rounded-full"
                      style={{ backgroundColor: statusColor(lead.status) }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[11px] font-semibold text-white">
                          {group.agentName}
                        </span>
                        {lead.progress !== null && (
                          <span className="text-[10px] font-medium text-white/60">
                            {Math.round(lead.progress)}%
                          </span>
                        )}
                      </div>
                      <p className="truncate text-[10px] text-white/70">{lead.title}</p>
                      {lead.lastEventSummary && (
                        <p className="truncate text-[9px] text-white/40">
                          {lead.lastEventSummary}
                        </p>
                      )}
                    </div>
                  </div>
                </button>

                {hasChildren && (
                  <button
                    type="button"
                    onClick={() => toggleCollapse(agentKey)}
                    aria-label={isCollapsed ? 'Expand sessions' : 'Collapse sessions'}
                    className="flex w-9 items-center justify-center border-l border-white/[0.06] text-white/50 transition-colors hover:bg-white/[0.05] hover:text-white/80"
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className={cn('transition-transform', isCollapsed ? '-rotate-90' : 'rotate-0')}
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                )}
              </div>

              {hasChildren && (
                <div
                  className={cn(
                    'overflow-hidden border-t border-white/[0.06] transition-all',
                    isCollapsed ? 'max-h-0 opacity-0' : 'max-h-[360px] opacity-100'
                  )}
                >
                  <div className="space-y-1.5 p-2">
                    {visibleChildren.map((node) => {
                      const childActive = selectedSessionId === node.id;
                      return (
                        <button
                          key={node.id}
                          onClick={() => onSelectSession(node.id)}
                          className={cn(
                            'w-full rounded-lg px-2.5 py-2 text-left transition-colors',
                            childActive
                              ? 'bg-white/[0.09]'
                              : 'bg-white/[0.02] hover:bg-white/[0.05]'
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className="h-1.5 w-1.5 rounded-full"
                              style={{ backgroundColor: statusColor(node.status) }}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[10px] text-white/90">{node.title}</p>
                              <p className="text-[9px] uppercase tracking-[0.08em] text-white/45">
                                {node.status}
                              </p>
                            </div>
                          </div>
                        </button>
                      );
                    })}

                    {hiddenChildren > 0 && !isCollapsed && (
                      <p className="px-1 text-[9px] text-white/40">
                        +{hiddenChildren} older sessions hidden for smooth rendering
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {hiddenGroupCount > 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[10px] text-white/45">
            Showing {MAX_VISIBLE_GROUPS} most recent agent groups ({hiddenGroupCount} older groups omitted).
          </div>
        )}

        {filteredOutByDate > 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[10px] text-white/45">
            {filteredOutByDate} offline group{filteredOutByDate === 1 ? '' : 's'} hidden by date filter.
          </div>
        )}
      </div>
    </PremiumCard>
  );
});
