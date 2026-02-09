import { memo, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import { resolveProvider } from '@/lib/providers';
import type { LiveActivityItem, SessionTreeNode, SessionTreeResponse } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { ProviderLogo } from '@/components/shared/ProviderLogo';
import { AgentLaunchModal } from './AgentLaunchModal';

interface AgentsChatsPanelProps {
  sessions: SessionTreeResponse;
  activity: LiveActivityItem[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onReconnect?: () => void;
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

const ARCHIVED_PAGE_SIZE = 10;

const DEFAULT_ORGX_AGENTS = [
  { id: 'orchestrator', name: 'Orchestrator', role: 'Coordinates cross-team execution' },
  { id: 'engineering', name: 'Engineering', role: 'Builds and ships technical work' },
  { id: 'product', name: 'Product', role: 'Defines features and requirements' },
  { id: 'marketing', name: 'Marketing', role: 'Drives campaigns and content' },
  { id: 'design', name: 'Design', role: 'Creates interfaces and experiences' },
  { id: 'operations', name: 'Operations', role: 'Manages reliability and processes' },
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

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortByUpdated(a: SessionTreeNode, b: SessionTreeNode) {
  return (
    toEpoch(b.updatedAt ?? b.lastEventAt ?? b.startedAt) -
    toEpoch(a.updatedAt ?? a.lastEventAt ?? a.startedAt)
  );
}

function summaryForNode(node: SessionTreeNode, summaryByRunId: Map<string, string>): string {
  const fallback =
    node.lastEventSummary ??
    summaryByRunId.get(node.runId) ??
    summaryByRunId.get(node.id) ??
    '';

  const summary = fallback.trim();
  if (summary.length > 0) return summary;
  return 'No run summary yet. Open session to inspect messages and outputs.';
}

export const AgentsChatsPanel = memo(function AgentsChatsPanel({
  sessions,
  activity,
  selectedSessionId,
  onSelectSession,
  onReconnect,
}: AgentsChatsPanelProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [launchModalOpen, setLaunchModalOpen] = useState(false);
  const [offlineDateFilter, setOfflineDateFilter] =
    useState<(typeof OFFLINE_DATE_FILTERS)[number]['id']>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [archivedPage, setArchivedPage] = useState(0);

  const summaryByRunId = useMemo(() => {
    const map = new Map<string, string>();
    const ordered = [...activity].sort((a, b) => toEpoch(b.timestamp) - toEpoch(a.timestamp));

    for (const item of ordered) {
      const runId = item.runId;
      if (!runId || map.has(runId)) continue;

      const summary =
        item.summary?.trim() ??
        item.description?.trim() ??
        item.title?.trim() ??
        '';
      if (summary.length > 0) {
        map.set(runId, summary);
      }
    }

    return map;
  }, [activity]);

  const {
    agents,
    hiddenGroupCount,
    filteredOutGroupsByDate,
    filteredOutSessionsByDate,
    visibleSessionCount,
    archivedGroups,
  } = useMemo(() => {
    const map = new Map<string, AgentGroup>();

    for (const node of sessions.nodes) {
      const key = node.agentId ?? node.agentName ?? node.id;
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

    const filteredGroups: AgentGroup[] = [];
    const archivedGroupsList: AgentGroup[] = [];
    let filteredOutGroupsByDate = 0;
    let filteredOutSessionsByDate = 0;

    for (const group of sortedGroups) {
      if (cutoffEpoch === null) {
        filteredGroups.push(group);
        continue;
      }

      const visibleNodes = group.nodes.filter((node) => {
        if (ONLINE_STATUSES.has(node.status)) return true;
        const nodeEpoch = toEpoch(node.updatedAt ?? node.lastEventAt ?? node.startedAt);
        return nodeEpoch >= cutoffEpoch;
      });

      if (visibleNodes.length === 0) {
        filteredOutGroupsByDate += 1;
        filteredOutSessionsByDate += group.nodes.length;
        archivedGroupsList.push(group);
        continue;
      }

      const archivedNodes = group.nodes.filter((node) => {
        if (ONLINE_STATUSES.has(node.status)) return false;
        const nodeEpoch = toEpoch(node.updatedAt ?? node.lastEventAt ?? node.startedAt);
        return nodeEpoch < cutoffEpoch;
      });

      filteredOutSessionsByDate += archivedNodes.length;

      if (archivedNodes.length > 0) {
        archivedGroupsList.push({
          ...group,
          nodes: archivedNodes,
          latest: archivedNodes[0],
        });
      }

      filteredGroups.push({
        ...group,
        nodes: visibleNodes,
        latest: visibleNodes[0],
      });
    }

    return {
      agents: filteredGroups.slice(0, MAX_VISIBLE_GROUPS),
      hiddenGroupCount: Math.max(0, filteredGroups.length - MAX_VISIBLE_GROUPS),
      filteredOutGroupsByDate,
      filteredOutSessionsByDate,
      visibleSessionCount: filteredGroups
        .slice(0, MAX_VISIBLE_GROUPS)
        .reduce((sum, group) => sum + group.nodes.length, 0),
      archivedGroups: archivedGroupsList,
    };
  }, [offlineDateFilter, sessions.nodes]);

  // Reset archived disclosure when filter changes
  useEffect(() => {
    setShowArchived(false);
    setArchivedPage(0);
  }, [offlineDateFilter]);

  const archivedSessionCount = useMemo(
    () => archivedGroups.reduce((sum, g) => sum + g.nodes.length, 0),
    [archivedGroups]
  );

  const paginatedArchivedSessions = useMemo(() => {
    const allSessions: { node: SessionTreeNode; agentName: string }[] = [];
    for (const group of archivedGroups) {
      for (const node of group.nodes) {
        allSessions.push({ node, agentName: group.agentName });
      }
    }
    allSessions.sort((a, b) => sortByUpdated(a.node, b.node));
    return allSessions.slice(0, (archivedPage + 1) * ARCHIVED_PAGE_SIZE);
  }, [archivedGroups, archivedPage]);

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

  const hasNoSessions = sessions.nodes.length === 0;

  return (
    <PremiumCard className="flex h-full min-h-0 flex-col card-enter">
      <AgentLaunchModal
        open={launchModalOpen}
        onClose={() => setLaunchModalOpen(false)}
        onLaunched={() => onReconnect?.()}
      />
      <div className="border-b border-white/[0.06] px-4 py-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-[14px] font-semibold text-white">Agents / Chats</h2>
            <span className="chip text-[11px]">
              {visibleSessionCount}/{sessions.nodes.length}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setLaunchModalOpen(true)}
            className="rounded-lg border border-white/[0.12] bg-white/[0.03] px-3 py-1.5 text-[12px] font-medium text-white/65 transition-colors hover:bg-white/[0.08] hover:text-white"
          >
            Launch
          </button>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <label htmlFor="offline-date-filter" className="text-[11px] text-white/45">
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
            className="rounded-lg border border-white/[0.1] bg-black/30 px-2 py-1 text-[11px] text-white/75 focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/30"
          >
            {OFFLINE_DATE_FILTERS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {agents.length === 0 && !hasNoSessions && (
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
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p className="text-[12px] text-white/45">
              No sessions match the selected offline date filter.
            </p>
          </div>
        )}

        {agents.length === 0 && hasNoSessions && !onReconnect && (
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
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p className="text-[12px] text-white/45">
              No active chats yet. Start a session to see agents here.
            </p>
          </div>
        )}

        {agents.map((group) => {
          const agentKey = group.agentId ?? group.agentName;
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
          const summary = summaryForNode(lead, summaryByRunId);
          const provider = resolveProvider(
            group.agentName,
            lead.title,
            lead.lastEventSummary,
            summary,
            lead
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
                  className="flex-1 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03]"
                >
                  <div className="flex items-start gap-2.5">
                    <div className="relative mt-0.5 flex-shrink-0">
                      <ProviderLogo provider={provider.id} size="sm" />
                      <span
                        className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2"
                        style={{
                          backgroundColor: statusColor(lead.status),
                          borderColor: colors.cardBg,
                        }}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-semibold text-white">
                          {group.agentName}
                        </span>
                        {lead.progress !== null && (
                          <span className="text-[11px] font-medium text-white/60">
                            {Math.round(lead.progress)}%
                          </span>
                        )}
                      </div>
                      {lead.progress !== null && (
                        <div className="mt-1 h-0.5 rounded-full bg-white/[0.08]">
                          <div
                            className="h-0.5 rounded-full"
                            style={{
                              width: `${Math.round(lead.progress)}%`,
                              background: `linear-gradient(90deg, ${colors.lime}, ${colors.teal})`,
                            }}
                          />
                        </div>
                      )}
                      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-white/45">
                        <span
                          className="rounded-full border px-1.5 py-0.5 uppercase tracking-[0.08em]"
                          style={{
                            borderColor: `${provider.accent}66`,
                            color: provider.accent,
                            backgroundColor: provider.tint,
                          }}
                        >
                          {provider.label}
                        </span>
                        <span className="text-[11px]">{formatRelativeTime(lead.updatedAt ?? lead.lastEventAt ?? lead.startedAt ?? Date.now())}</span>
                      </div>
                      <p className="mt-1 truncate text-[12px] text-white/78">{lead.title}</p>
                      <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-white/48">
                        {summary}
                      </p>
                    </div>
                  </div>
                </button>

                {hasChildren && (
                  <button
                    type="button"
                    onClick={() => toggleCollapse(agentKey)}
                    aria-label={isCollapsed ? 'Expand sessions' : 'Collapse sessions'}
                    className="flex w-10 items-center justify-center border-l border-white/[0.06] text-white/50 transition-colors hover:bg-white/[0.05] hover:text-white/80"
                  >
                    <svg
                      width="14"
                      height="14"
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
                      const childProvider = resolveProvider(
                        node.agentName,
                        node.title,
                        node.lastEventSummary,
                        node
                      );
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
                            <ProviderLogo provider={childProvider.id} size="xs" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[12px] text-white/90">{node.title}</p>
                              <p className="text-[10px] uppercase tracking-[0.08em] text-white/45">
                                {childProvider.label} · {node.status}
                              </p>
                            </div>
                          </div>
                        </button>
                      );
                    })}

                    {hiddenChildren > 0 && !isCollapsed && (
                      <p className="px-1 text-[10px] text-white/40">
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
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px] text-white/45">
            Showing {MAX_VISIBLE_GROUPS} most recent agent groups ({hiddenGroupCount} older groups omitted).
          </div>
        )}

        {onReconnect && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] text-[11px] text-white/45">
            <p className="px-3 pt-2 pb-1.5 text-[10px] uppercase tracking-[0.1em] text-white/30">
              OrgX Agent Roster
            </p>
            <div className="space-y-1 px-2 pb-2">
              {DEFAULT_ORGX_AGENTS.map((agent) => (
                <div
                  key={agent.id}
                  className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 opacity-55"
                >
                  <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03]">
                    <span className="text-[9px] font-semibold text-white/50">
                      {agent.name.charAt(0)}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-medium text-white/60">{agent.name}</p>
                    <p className="text-[9px] text-white/35">{agent.role}</p>
                  </div>
                  <button
                    onClick={onReconnect}
                    className="rounded-md border border-lime/25 bg-lime/10 px-2 py-0.5 text-[9px] font-semibold text-lime transition-colors hover:bg-lime/20"
                  >
                    Connect
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {filteredOutSessionsByDate > 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] text-[11px] text-white/45">
            <button
              onClick={() => {
                setShowArchived((prev) => !prev);
                if (showArchived) setArchivedPage(0);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/[0.03]"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className={cn('transition-transform', showArchived ? 'rotate-0' : '-rotate-90')}
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
              <span>
                {archivedSessionCount} archived session{archivedSessionCount === 1 ? '' : 's'}
                {filteredOutGroupsByDate > 0
                  ? ` across ${filteredOutGroupsByDate} agent${filteredOutGroupsByDate === 1 ? '' : 's'}`
                  : ''}
              </span>
            </button>

            {showArchived && (
              <div className="space-y-1.5 border-t border-white/[0.06] p-2">
                {paginatedArchivedSessions.map(({ node, agentName }) => {
                  const provider = resolveProvider(node.agentName, node.title, node.lastEventSummary, node);
                  return (
                    <button
                      key={node.id}
                      onClick={() => onSelectSession(node.id)}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left opacity-60 transition-colors hover:bg-white/[0.05] hover:opacity-80"
                    >
                      <ProviderLogo provider={provider.id} size="xs" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-[11px] font-medium text-white/70">{agentName}</p>
                          <span className="text-[10px] text-white/35">
                            {formatRelativeTime(node.updatedAt ?? node.lastEventAt ?? node.startedAt ?? Date.now())}
                          </span>
                        </div>
                        <p className="truncate text-[10px] text-white/50">{node.title}</p>
                        <span className="text-[9px] uppercase tracking-[0.08em] text-white/35">{node.status}</span>
                      </div>
                    </button>
                  );
                })}

                {paginatedArchivedSessions.length < archivedSessionCount && (
                  <button
                    onClick={() => setArchivedPage((prev) => prev + 1)}
                    className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-[10px] text-white/50 transition-colors hover:bg-white/[0.05]"
                  >
                    Load more ({archivedSessionCount - paginatedArchivedSessions.length} remaining)
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </PremiumCard>
  );
});
