import { memo, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { colors, getAgentRole } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import { resolveProvider } from '@/lib/providers';
import type { ConnectionStatus, LiveActivityItem, SessionTreeNode, SessionTreeResponse } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { ProviderLogo } from '@/components/shared/ProviderLogo';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { AgentLaunchModal } from './AgentLaunchModal';
import { AgentDetailModal } from './AgentDetailModal';
import { useAgentCatalog, type OpenClawCatalogAgent } from '@/hooks/useAgentCatalog';

interface AgentsChatsPanelProps {
  sessions: SessionTreeResponse;
  activity: LiveActivityItem[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onAgentFilter?: (agentName: string | null) => void;
  agentFilter?: string | null;
  onReconnect?: () => void;
  connectionStatus?: ConnectionStatus;
}

const MAX_VISIBLE_GROUPS = 120;
const MAX_VISIBLE_CHILD_SESSIONS = 10;
const LIVE_STATUSES = new Set([
  'running',
  'active',
  'queued',
  'pending',
  'blocked',
  'in_progress',
  'working',
  'planning',
]);
const HISTORY_FILTERS = [
  { id: 'live', label: 'Live', minutes: null },
  { id: 'all', label: 'All', minutes: null },
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
  active: colors.lime,
  queued: colors.amber,
  pending: colors.amber,
  in_progress: colors.amber,
  working: colors.amber,
  planning: colors.amber,
  blocked: colors.red,
  failed: colors.red,
  cancelled: colors.red,
  paused: 'rgba(255,255,255,0.5)',
  draft: 'rgba(255,255,255,0.5)',
  completed: colors.teal,
  archived: 'rgba(255,255,255,0.5)',
};

function statusColor(status: string): string {
  return statusColors[status] ?? colors.iris;
}

type AgentGroup = {
  groupKey: string;
  agentId: string | null;
  agentName: string;
  nodes: SessionTreeNode[];
  latest: SessionTreeNode | null;
  catalogAgent?: OpenClawCatalogAgent | null;
};

function normalizeIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function sessionGroupKey(node: SessionTreeNode): string {
  const id = normalizeIdentity(node.agentId);
  if (id) return `id:${id}`;

  const name = normalizeIdentity(node.agentName);
  if (name) return `name:${name}`;

  return 'unassigned';
}

function isLiveStatus(status: string | null | undefined): boolean {
  const normalized = normalizeIdentity(status);
  return normalized ? LIVE_STATUSES.has(normalized) : false;
}

function isCatalogAgentLive(agent: OpenClawCatalogAgent | null | undefined): boolean {
  if (!agent) return false;
  if (isLiveStatus(agent.status)) return true;
  if (agent.runId && agent.runId.trim().length > 0) return true;
  if (agent.currentTask && agent.currentTask.trim().length > 0) return true;
  return false;
}

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
  return 'No summary yet. Open the session to inspect messages and outputs.';
}

export const AgentsChatsPanel = memo(function AgentsChatsPanel({
  sessions,
  activity,
  selectedSessionId,
  onSelectSession,
  onAgentFilter,
  agentFilter,
  onReconnect,
  connectionStatus,
}: AgentsChatsPanelProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [launchModalOpen, setLaunchModalOpen] = useState(false);
  const [offlineDateFilter, setOfflineDateFilter] =
    useState<(typeof HISTORY_FILTERS)[number]['id']>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [archivedPage, setArchivedPage] = useState(0);
  const [detailAgentKey, setDetailAgentKey] = useState<string | null>(null);

  const catalogQuery = useAgentCatalog({ enabled: true });
  const catalogAgents = catalogQuery.data?.agents ?? [];

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
      const preferredKey = sessionGroupKey(node);
      const normalizedId = normalizeIdentity(node.agentId);
      const normalizedName = normalizeIdentity(node.agentName);
      let existing = map.get(preferredKey) ?? null;

      if (!existing && normalizedId && normalizedName) {
        const nameKey = `name:${normalizedName}`;
        const byName = map.get(nameKey);
        if (byName) {
          map.delete(nameKey);
          byName.groupKey = preferredKey;
          map.set(preferredKey, byName);
          existing = byName;
        }
      }

      if (!existing && normalizedName) {
        const byNameAlias = Array.from(map.values()).find(
          (group) => normalizeIdentity(group.agentName) === normalizedName
        );
        if (byNameAlias) {
          existing = byNameAlias;
        }
      }

      if (existing) {
        existing.nodes.push(node);
        if (!existing.agentId && node.agentId) {
          existing.agentId = node.agentId;
        }
        if (
          (existing.agentName === 'Unassigned' || !existing.agentName) &&
          node.agentName
        ) {
          existing.agentName = node.agentName;
        }
      } else {
        map.set(preferredKey, {
          groupKey: preferredKey,
          agentId: node.agentId,
          agentName: node.agentName ?? node.agentId ?? 'Unassigned',
          nodes: [node],
          latest: node,
        });
      }
    }

    // Merge catalog agents: add groups for agents not already in the session map
    for (const catAgent of catalogAgents) {
      const normalizedCatalogId = normalizeIdentity(catAgent.id);
      const normalizedCatalogName = normalizeIdentity(catAgent.name);
      const idKey = normalizedCatalogId ? `id:${normalizedCatalogId}` : null;
      const nameKey = normalizedCatalogName ? `name:${normalizedCatalogName}` : null;

      let matchKey: string | null = null;
      if (idKey && map.has(idKey)) {
        matchKey = idKey;
      } else if (nameKey && map.has(nameKey)) {
        matchKey = nameKey;
      } else {
        const aliasMatch = Array.from(map.entries()).find(
          ([, group]) =>
            (normalizedCatalogId &&
              normalizeIdentity(group.agentId) === normalizedCatalogId) ||
            (normalizedCatalogName &&
              normalizeIdentity(group.agentName) === normalizedCatalogName)
        );
        matchKey = aliasMatch?.[0] ?? null;
      }

      if (matchKey) {
        // Attach catalog reference to existing group
        const group = map.get(matchKey)!;
        group.catalogAgent = catAgent;
        if (!group.agentId && catAgent.id) {
          group.agentId = catAgent.id;
        }
        if (
          (group.agentName === 'Unassigned' || !group.agentName) &&
          catAgent.name
        ) {
          group.agentName = catAgent.name;
        }

        if (idKey && group.groupKey !== idKey && !map.has(idKey)) {
          map.delete(group.groupKey);
          group.groupKey = idKey;
          map.set(idKey, group);
        }
      } else {
        // Synthetic group for catalog-only agent (0 sessions)
        const syntheticKey =
          idKey ?? nameKey ?? `catalog:${catAgent.name.toLowerCase()}`;
        map.set(syntheticKey, {
          groupKey: syntheticKey,
          agentId: catAgent.id,
          agentName: catAgent.name,
          nodes: [],
          latest: null,
          catalogAgent: catAgent,
        });
      }
    }

    for (const group of map.values()) {
      if (group.nodes.length > 0) {
        group.nodes.sort(sortByUpdated);
        group.latest = group.nodes[0];
      }
    }

    // Sort: groups with sessions first (by latest update), then 0-session groups
    const sortedGroups = Array.from(map.values()).sort((a, b) => {
      if (a.latest && b.latest) return sortByUpdated(a.latest, b.latest);
      if (a.latest && !b.latest) return -1;
      if (!a.latest && b.latest) return 1;
      return a.agentName.localeCompare(b.agentName);
    });

    const selectedWindow =
      HISTORY_FILTERS.find((item) => item.id === offlineDateFilter) ??
      HISTORY_FILTERS[0];
    const isLiveWindow = selectedWindow.id === 'live';
    const cutoffEpoch =
      selectedWindow.minutes === null || isLiveWindow
        ? null
        : Date.now() - selectedWindow.minutes * 60_000;

    const filteredGroups: AgentGroup[] = [];
    const archivedGroupsList: AgentGroup[] = [];
    let filteredOutGroupsByDate = 0;
    let filteredOutSessionsByDate = 0;

    for (const group of sortedGroups) {
      // Always include 0-session catalog agents
      if (group.nodes.length === 0) {
        const catalogIsLive = isCatalogAgentLive(group.catalogAgent);
        if (!isLiveWindow || catalogIsLive) {
          filteredGroups.push(group);
        }
        continue;
      }

      if (isLiveWindow) {
        const visibleNodes = group.nodes.filter((node) => isLiveStatus(node.status));
        const archivedNodes = group.nodes.filter((node) => !isLiveStatus(node.status));
        const catalogIsLive = isCatalogAgentLive(group.catalogAgent);

        if (visibleNodes.length === 0) {
          if (catalogIsLive) {
            filteredGroups.push({
              ...group,
              nodes: [],
              latest: null,
            });
          } else {
            filteredOutGroupsByDate += 1;
            filteredOutSessionsByDate += group.nodes.length;
            archivedGroupsList.push(group);
          }
          continue;
        }

        filteredOutSessionsByDate += archivedNodes.length;
        if (archivedNodes.length > 0) {
          archivedGroupsList.push({
            ...group,
            nodes: archivedNodes,
            latest: archivedNodes[0] ?? null,
          });
        }

        filteredGroups.push({
          ...group,
          nodes: visibleNodes,
          latest: visibleNodes[0] ?? null,
        });
        continue;
      }

      if (cutoffEpoch === null) {
        filteredGroups.push(group);
        continue;
      }

      const visibleNodes = group.nodes.filter((node) => {
        if (isLiveStatus(node.status)) return true;
        const nodeEpoch = toEpoch(node.updatedAt ?? node.lastEventAt ?? node.startedAt);
        return nodeEpoch >= cutoffEpoch;
      });

      const catalogIsLive = isCatalogAgentLive(group.catalogAgent);

      if (visibleNodes.length === 0) {
        if (catalogIsLive) {
          filteredGroups.push({
            ...group,
            nodes: [],
            latest: null,
          });
        } else {
          filteredOutGroupsByDate += 1;
          filteredOutSessionsByDate += group.nodes.length;
          archivedGroupsList.push(group);
        }
        continue;
      }

      const archivedNodes = group.nodes.filter((node) => {
        if (isLiveStatus(node.status)) return false;
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
  }, [offlineDateFilter, sessions.nodes, catalogAgents]);

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

  // Detail modal data
  const detailGroup = useMemo(
    () => (detailAgentKey ? agents.find((g) => g.groupKey === detailAgentKey) ?? null : null),
    [agents, detailAgentKey]
  );

  const detailSessions = useMemo(
    () => detailGroup?.nodes ?? [],
    [detailGroup]
  );

  const detailActivity = useMemo(
    () => {
      if (!detailGroup) return [];
      const detailName = normalizeIdentity(detailGroup.agentName);
      const detailId = normalizeIdentity(detailGroup.agentId);
      return activity.filter((item) => {
        const itemName = normalizeIdentity(item.agentName);
        const itemId = normalizeIdentity(item.agentId);
        return (
          (detailName !== null && itemName === detailName) ||
          (detailId !== null && itemId === detailId)
        );
      });
    },
    [activity, detailGroup]
  );

  const hasNoSessions = sessions.nodes.length === 0;
  const hasCatalogAgents = catalogAgents.length > 0;

  return (
    <PremiumCard className="flex h-full min-h-0 flex-col card-enter">
      <AgentLaunchModal
        open={launchModalOpen}
        onClose={() => setLaunchModalOpen(false)}
        onLaunched={() => onReconnect?.()}
      />
      <AgentDetailModal
        open={detailAgentKey !== null}
        onClose={() => setDetailAgentKey(null)}
        agentName={detailGroup?.agentName ?? ''}
        catalogAgent={detailGroup?.catalogAgent ?? null}
        sessions={detailSessions}
        activity={detailActivity}
        onSelectSession={onSelectSession}
        onRefresh={() => catalogQuery.refetch()}
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
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-white/45">History</span>
          <div
            className="hidden items-center gap-1 rounded-full border border-white/[0.08] bg-black/30 p-0.5 sm:inline-flex"
            role="group"
            aria-label="Session history filter"
          >
            {HISTORY_FILTERS.map((option) => {
              const active = offlineDateFilter === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setOfflineDateFilter(option.id)}
                  aria-pressed={active}
                  className={cn(
                    'rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-[-0.01em] transition-colors',
                    active
                      ? 'border border-lime/25 bg-lime/[0.12] text-lime'
                      : 'border border-transparent text-white/55 hover:bg-white/[0.06] hover:text-white/80'
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <label htmlFor="offline-date-filter" className="sr-only">
            Session history filter
          </label>
          <select
            id="offline-date-filter"
            value={offlineDateFilter}
            onChange={(event) =>
              setOfflineDateFilter(
                event.target.value as (typeof HISTORY_FILTERS)[number]['id']
              )
            }
            className="rounded-lg border border-white/[0.1] bg-black/30 px-2 py-1 text-[11px] text-white/75 focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/30 sm:hidden"
          >
            {HISTORY_FILTERS.map((option) => (
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
              No sessions match the selected history filter.
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

        {agentFilter && onAgentFilter && (
          <div className="flex items-center justify-between rounded-lg bg-[#0AD4C4]/[0.08] px-3 py-1.5 text-[11px] text-[#0AD4C4]">
            <span>Filtered: {agentFilter}</span>
            <button
              type="button"
              onClick={() => onAgentFilter(null)}
              className="text-[10px] underline underline-offset-2"
            >
              Clear
            </button>
          </div>
        )}

        {agents.map((group) => {
          const agentKey = group.groupKey;
          const isCollapsed = collapsed.has(agentKey);
          const lead = group.latest;
          const hasSessions = group.nodes.length > 0;
          const catalogIsLive = isCatalogAgentLive(group.catalogAgent);
          const active = lead ? selectedSessionId === lead.id : false;
          const displayName = group.agentName || group.catalogAgent?.name || group.agentId || 'Unassigned';
          const visibleChildren = isCollapsed
            ? []
            : group.nodes.slice(0, MAX_VISIBLE_CHILD_SESSIONS);
          const hiddenChildren = Math.max(
            0,
            group.nodes.length - visibleChildren.length
          );
          const isFiltered =
            normalizeIdentity(agentFilter) === normalizeIdentity(displayName);

          return (
            <motion.div
              key={agentKey}
              layout
              transition={{ type: 'spring', stiffness: 260, damping: 30, mass: 0.75 }}
              className={cn(
                'overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.02] transition-all',
                active && 'border-white/20 bg-white/[0.05]',
                isFiltered && 'border-[#0AD4C4]/30',
                !hasSessions && !catalogIsLive && 'opacity-55'
              )}
            >
              {/* Agent group header: avatar + name + status dot + session count + detail + collapse */}
              <div className="flex items-center gap-2.5 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => {
                    if (onAgentFilter) {
                      onAgentFilter(isFiltered ? null : displayName);
                    } else if (lead) {
                      onSelectSession(lead.id);
                    }
                  }}
                  className="flex flex-1 items-center gap-2.5 text-left transition-colors hover:opacity-80"
                >
                  <div className="relative flex-shrink-0">
                    <AgentAvatar name={displayName} size="sm" hint={displayName} />
                    {lead && (
                      <span
                        className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2"
                        style={{
                          backgroundColor: statusColor(lead.status),
                          borderColor: colors.cardBg,
                        }}
                      />
                    )}
                    {!lead && (
                      <span
                        className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2"
                        style={{
                          backgroundColor: catalogIsLive
                            ? statusColor('running')
                            : 'rgba(255,255,255,0.2)',
                          borderColor: colors.cardBg,
                        }}
                      />
                    )}
                  </div>
                  <span className="min-w-0 truncate">
                    <span className="text-[13px] font-semibold text-white">{displayName}</span>
                    {getAgentRole(displayName) && (
                      <span className="ml-1 text-[11px] text-white/40">— {getAgentRole(displayName)}</span>
                    )}
                  </span>
                  {hasSessions ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="flex h-1.5 w-12 overflow-hidden rounded-full">
                        {(() => {
                          const counts: Record<string, number> = {};
                          for (const node of group.nodes) counts[node.status] = (counts[node.status] ?? 0) + 1;
                          const total = group.nodes.length;
                          return Object.entries(counts).map(([status, count]) => (
                            <span
                              key={status}
                              style={{
                                width: `${(count / total) * 100}%`,
                                backgroundColor: statusColor(status),
                              }}
                            />
                          ));
                        })()}
                      </span>
                      <span className="text-[10px] text-white/55" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {group.nodes.length}
                      </span>
                    </span>
                  ) : catalogIsLive ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="flex h-1.5 w-12 overflow-hidden rounded-full bg-white/[0.06]">
                        <span
                          className="h-1.5 w-full"
                          style={{ backgroundColor: statusColor('running') }}
                        />
                      </span>
                      <span className="text-[10px] uppercase tracking-[0.08em] text-lime/80">
                        live
                      </span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="flex h-1.5 w-12 overflow-hidden rounded-full bg-white/[0.06]" />
                      <span className="text-[10px] text-white/35" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        0
                      </span>
                    </span>
                  )}
                </button>

                {/* Info/detail button */}
                <button
                  type="button"
                  onClick={() => setDetailAgentKey(agentKey)}
                  aria-label={`View ${displayName} details`}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-white/40 transition-colors hover:bg-white/[0.05] hover:text-white/70"
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
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4" />
                    <path d="M12 8h.01" />
                  </svg>
                </button>

                {hasSessions && (
                  <button
                    type="button"
                    onClick={() => toggleCollapse(agentKey)}
                    aria-label={isCollapsed ? 'Expand sessions' : 'Collapse sessions'}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-white/40 transition-colors hover:bg-white/[0.05] hover:text-white/70"
                  >
                    <svg
                      width="12"
                      height="12"
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

              <AnimatePresence initial={false}>
                {hasSessions && !isCollapsed && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                    className="overflow-hidden border-t border-white/[0.06]"
                  >
                    <div className="max-h-[500px] space-y-1.5 overflow-y-auto p-2">
                      {visibleChildren.map((node, index) => {
                        const childActive = selectedSessionId === node.id;
                        const childProvider = resolveProvider(
                          node.agentName,
                          node.title,
                          node.lastEventSummary,
                          node
                        );
                        return (
                          <motion.button
                            key={node.id}
                            onClick={() => onSelectSession(node.id)}
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.16, delay: Math.min(index * 0.015, 0.12) }}
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
                                <div className="flex items-center gap-1.5 text-[10px] text-white/45">
                                  <span
                                    className="rounded-full border px-1.5 py-0.5 uppercase tracking-[0.08em]"
                                    style={{
                                      borderColor: `${childProvider.accent}66`,
                                      color: childProvider.accent,
                                      backgroundColor: childProvider.tint,
                                    }}
                                  >
                                    {childProvider.label}
                                  </span>
                                  <span className="uppercase tracking-[0.08em]">{node.status}</span>
                                  <span>
                                    {formatRelativeTime(node.updatedAt ?? node.lastEventAt ?? node.startedAt ?? Date.now())}
                                  </span>
                                </div>
                                {node.progress !== null && (
                                  <div className="mt-1 h-0.5 rounded-full bg-white/[0.08]">
                                    <div
                                      className="h-0.5 rounded-full"
                                      style={{
                                        width: `${Math.round(node.progress)}%`,
                                        background: `linear-gradient(90deg, ${colors.lime}, ${colors.teal})`,
                                      }}
                                    />
                                  </div>
                                )}
                              </div>
                              <span
                                className="h-2 w-2 flex-shrink-0 rounded-full"
                                style={{ backgroundColor: statusColor(node.status) }}
                                aria-label={node.status}
                                title={node.status}
                              />
                            </div>
                          </motion.button>
                        );
                      })}

                      {hiddenChildren > 0 && (
                        <p className="px-1 text-[10px] text-white/40">
                          +{hiddenChildren} older sessions hidden
                        </p>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}

        {hiddenGroupCount > 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px] text-white/45">
            Showing {MAX_VISIBLE_GROUPS} most recent agent groups ({hiddenGroupCount} older groups omitted).
          </div>
        )}

        {onReconnect && connectionStatus !== 'connected' && !hasCatalogAgents && (
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

            <AnimatePresence initial={false}>
              {showArchived && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
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
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>
    </PremiumCard>
  );
});
