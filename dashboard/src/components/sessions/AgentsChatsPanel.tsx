import { memo, useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { colors, getAgentRole } from '@/lib/tokens';
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/time';
import { statusColor } from '@/lib/entityStatusColors';
import { resolveProvider, type ProviderId } from '@/lib/providers';
import { isSyntheticInitiativeId } from '@/lib/initiativeIds';
import type {
  ConnectionStatus,
  LiveActivityItem,
  RuntimeInstance,
  SessionTreeNode,
  SessionTreeResponse,
} from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { ProviderLogo } from '@/components/shared/ProviderLogo';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { AgentHealthRing } from '@/components/agents/AgentHealthRing';
import { AgentLaunchModal } from './AgentLaunchModal';
import { AgentDetailModal } from './AgentDetailModal';
import { useAgentCatalog, type OpenClawCatalogAgent } from '@/hooks/useAgentCatalog';
import type { ActivityTimeFilterId } from '@/lib/activityTimeFilters';
import { cutoffEpochForActivityFilter, resolveActivityTimeFilter } from '@/lib/activityTimeFilters';

interface AgentsChatsPanelProps {
  sessions: SessionTreeResponse;
  activity: LiveActivityItem[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  timeFilterId: ActivityTimeFilterId;
  onAgentFilter?: (agentName: string | null) => void;
  agentFilter?: string | null;
  onReconnect?: () => void;
  connectionStatus?: ConnectionStatus;
  runtimeInstances?: RuntimeInstance[];
  showSyntheticEntities?: boolean;
}

const MAX_VISIBLE_GROUPS = 120;
const MAX_VISIBLE_CHILD_SESSIONS = 10;
const AGENT_VIRTUALIZATION_THRESHOLD = 24;
const AGENT_VIRTUAL_OVERSCAN_PX = 520;
const AGENT_ROW_BASE_HEIGHT = 58;
const AGENT_ROW_CHILD_HEIGHT = 56;
const AGENT_ROW_CONTAINER_PADDING = 20;
const AGENT_ROW_ESTIMATED_GAP = 8;
const ACTIVE_STATUSES = new Set([
  'running',
  'active',
  'in_progress',
  'working',
  'planning',
  'handoff',
  'review',
]);
const ATTENTION_STATUSES = new Set(['blocked', 'failed']);
const ARCHIVED_PAGE_SIZE = 10;

const DEFAULT_ORGX_AGENTS = [
  { id: 'orchestrator', name: 'Orchestrator', role: 'Coordinates cross-team execution' },
  { id: 'engineering', name: 'Engineering', role: 'Builds and ships technical work' },
  { id: 'product', name: 'Product', role: 'Defines features and requirements' },
  { id: 'marketing', name: 'Marketing', role: 'Drives campaigns and content' },
  { id: 'design', name: 'Design', role: 'Creates interfaces and experiences' },
  { id: 'operations', name: 'Operations', role: 'Manages reliability and processes' },
] as const;

const UUID_LIKE_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CanonicalOrgxAgent = {
  id: 'eli' | 'dana' | 'mark' | 'sage' | 'orion' | 'xandy' | 'pace';
  name: string;
  role: string;
  aliases: RegExp[];
};

const CANONICAL_ORGX_AGENTS: CanonicalOrgxAgent[] = [
  {
    id: 'eli',
    name: 'Eli',
    role: 'Engineering',
    aliases: [/\beli\b/i, /\borgx[\s_-]*engineering\b/i, /^\s*engineering\s*$/i],
  },
  {
    id: 'dana',
    name: 'Dana',
    role: 'Product Design',
    aliases: [
      /\bdana\b/i,
      /\borgx[\s_-]*design\b/i,
      /\borgx[\s_-]*product\b/i,
      /\bproduct[\s_-]*design\b/i,
    ],
  },
  {
    id: 'mark',
    name: 'Mark',
    role: 'Marketing',
    aliases: [/\bmark\b/i, /\borgx[\s_-]*marketing\b/i, /^\s*marketing\s*$/i],
  },
  {
    id: 'sage',
    name: 'Sage',
    role: 'Sales',
    aliases: [/\bsage\b/i, /\borgx[\s_-]*sales\b/i, /^\s*sales\s*$/i],
  },
  {
    id: 'orion',
    name: 'Orion',
    role: 'Operations',
    aliases: [/\borion\b/i, /\borgx[\s_-]*operations\b/i, /^\s*operations\s*$/i],
  },
  {
    id: 'xandy',
    name: 'Xandy',
    role: 'Orchestrator',
    aliases: [/\bxandy\b/i, /\borgx[\s_-]*orchestrator\b/i, /^\s*orchestrator\s*$/i],
  },
  {
    id: 'pace',
    name: 'Pace',
    role: 'Engineering',
    aliases: [/\bpace\b/i, /\borgx[\s_-]*pace\b/i],
  },
];

type AgentGroup = {
  groupKey: string;
  agentId: string | null;
  agentName: string;
  nodes: SessionTreeNode[];
  latest: SessionTreeNode | null;
  catalogAgent?: OpenClawCatalogAgent | null;
  runtime?: RuntimeInstance | null;
  runtimeActiveCount?: number;
  runtimeOnly?: boolean;
};

function normalizeIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function canonicalizeOrgxIdentity(
  agentId: string | null | undefined,
  agentName: string | null | undefined
): { agentId: string; agentName: string; role: string } | null {
  const normalizedId = normalizeIdentity(agentId);
  const normalizedName = normalizeIdentity(agentName);
  if (!normalizedId && !normalizedName) return null;

  const haystack = [normalizedId, normalizedName].filter(Boolean).join(' ');
  if (!haystack) return null;

  for (const candidate of CANONICAL_ORGX_AGENTS) {
    if (candidate.aliases.some((pattern) => pattern.test(haystack))) {
      return {
        agentId: `orgx:${candidate.id}`,
        agentName: candidate.name,
        role: candidate.role,
      };
    }
  }

  return null;
}

function canonicalizeOrgxIdentityFromNode(
  node: SessionTreeNode
): { agentId: string; agentName: string; role: string } | null {
  const direct = canonicalizeOrgxIdentity(node.agentId, node.agentName);
  if (direct) return direct;

  const fallbackHints = [
    node.groupLabel,
    node.title,
    node.runtimeLabel,
    node.lastEventSummary,
  ];
  for (const hint of fallbackHints) {
    const match = canonicalizeOrgxIdentity(null, hint);
    if (match) return match;
  }
  return null;
}

function inferRuntimeSourceFromNode(node: SessionTreeNode): 'codex' | 'claude-code' | 'openclaw' | 'api' | null {
  const explicit = normalizeIdentity(node.runtimeClient);
  if (explicit === 'codex') return 'codex';
  if (explicit === 'claude-code') return 'claude-code';
  if (explicit === 'openclaw') return 'openclaw';
  if (explicit === 'api') return 'api';

  const searchText = [
    node.title,
    node.lastEventSummary,
    node.runtimeLabel,
    node.runtimeProvider,
    node.groupLabel,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();

  if (searchText.includes('claude-code') || searchText.includes('anthropic') || searchText.includes('claude')) {
    return 'claude-code';
  }
  if (searchText.includes('openclaw')) return 'openclaw';
  if (searchText.includes('codex') || searchText.includes('openai')) return 'codex';
  if (searchText.includes('orgx api') || searchText.includes('source_client=api')) return 'api';
  return null;
}

function inferredAgentIdentity(node: SessionTreeNode): { agentId: string | null; agentName: string | null } {
  const canonical = canonicalizeOrgxIdentityFromNode(node);
  if (canonical) {
    return {
      agentId: canonical.agentId,
      agentName: canonical.agentName,
    };
  }

  const normalizedId = normalizeIdentity(node.agentId);
  const normalizedName = normalizeIdentity(node.agentName);
  if (normalizedId || normalizedName) {
    return {
      agentId: node.agentId ?? null,
      agentName: node.agentName ?? null,
    };
  }

  const runtimeSource = inferRuntimeSourceFromNode(node);
  if (runtimeSource === 'codex') {
    return { agentId: 'runtime:codex', agentName: 'Codex' };
  }
  if (runtimeSource === 'claude-code') {
    return { agentId: 'runtime:claude-code', agentName: 'Claude Code' };
  }
  if (runtimeSource === 'openclaw') {
    return { agentId: 'runtime:openclaw', agentName: 'OpenClaw' };
  }
  if (runtimeSource === 'api') {
    return { agentId: 'runtime:api', agentName: 'OrgX API' };
  }
  return { agentId: null, agentName: null };
}

function sessionGroupKey(node: SessionTreeNode): string {
  const inferred = inferredAgentIdentity(node);
  const id = normalizeIdentity(inferred.agentId);
  if (id) return `id:${id}`;

  const name = normalizeIdentity(inferred.agentName);
  if (name) return `name:${name}`;

  return 'unassigned';
}

function compactAgentDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "OrgX";
  if (UUID_LIKE_NAME.test(trimmed)) {
    return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
  }
  if (!trimmed.includes(" ") && trimmed.length > 64) {
    return `${trimmed.slice(0, 48)}…`;
  }
  return trimmed;
}

function isSyntheticInitiativeForVisibility(value: string | null | undefined): boolean {
  const normalized = (value ?? '').trim();
  if (!normalized) return false;
  return isSyntheticInitiativeId(normalized);
}

function isSyntheticCatalogAgent(agent: OpenClawCatalogAgent): boolean {
  if (isSyntheticInitiativeForVisibility(agent.context?.initiativeId)) return true;
  if (isSyntheticInitiativeForVisibility(agent.run?.initiativeId ?? null)) return true;
  return false;
}

function isOrgxGroup(group: AgentGroup): boolean {
  const canonical = canonicalizeOrgxIdentity(group.agentId, group.agentName);
  if (canonical) return true;
  const normalizedId = normalizeIdentity(group.agentId);
  if (normalizedId?.startsWith('orgx')) return true;
  return false;
}

function effectiveSessionStatus(node: SessionTreeNode): string {
  const status = normalizeIdentity(node.status) ?? 'archived';
  if (status === 'blocked' || status === 'failed' || status === 'completed' || status === 'cancelled') {
    return status;
  }

  const phase = normalizeIdentity(node.phase);
  if (phase === 'blocked') return 'blocked';
  if (phase === 'handoff') return 'handoff';
  if (phase === 'completed') return 'completed';
  if (phase === 'review') return 'review';

  const state = normalizeIdentity(node.state);
  if (state === 'error') return 'failed';
  if (state === 'stopped') return 'paused';
  if (state === 'stale') return 'queued';

  if (ACTIVE_STATUSES.has(status)) return status;
  if (Array.isArray(node.blockers) && node.blockers.length > 0) return 'blocked';

  return status;
}

function isLiveStatus(status: string | null | undefined): boolean {
  const normalized = normalizeIdentity(status);
  return normalized
    ? ACTIVE_STATUSES.has(normalized) || ATTENTION_STATUSES.has(normalized)
    : false;
}

function isActiveStatus(status: string | null | undefined): boolean {
  const normalized = normalizeIdentity(status);
  return normalized ? ACTIVE_STATUSES.has(normalized) : false;
}

function isCatalogAgentLive(agent: OpenClawCatalogAgent | null | undefined): boolean {
  if (!agent) return false;
  if (isLiveStatus(agent.status)) return true;
  if (agent.runId && agent.runId.trim().length > 0) return true;
  if (agent.currentTask && agent.currentTask.trim().length > 0) return true;
  return false;
}

function isRuntimeActive(runtime: RuntimeInstance | null | undefined): boolean {
  if (!runtime) return false;
  return runtime.state === 'active';
}

function runtimeProviderIdFromLogo(
  provider: RuntimeInstance['providerLogo'] | SessionTreeNode['runtimeProvider'] | null | undefined
): ProviderId {
  if (provider === 'codex') return 'codex';
  if (provider === 'openai') return 'openai';
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'openclaw') return 'openclaw';
  if (provider === 'orgx') return 'orgx';
  return 'unknown';
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

function CollapsedSessionGroup({
  status,
  nodes,
  onSelectSession,
  selectedSessionId,
}: {
  status: string;
  nodes: SessionTreeNode[];
  onSelectSession: (id: string) => void;
  selectedSessionId: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const dotColor = statusColor(status);
  const label =
    status === 'blocked' ? 'blocked' : status === 'failed' ? 'failed' : 'paused';

  return (
    <div>
      <button
        onClick={() => setExpanded((p) => !p)}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/[0.05]"
      >
        <span
          className="h-2 w-2 flex-shrink-0 rounded-full"
          style={{ backgroundColor: dotColor }}
        />
        <span className="flex-1 text-body text-secondary">
          {nodes.length} {label} sessions
        </span>
        <motion.span
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={{ duration: 0.15 }}
          className="text-micro text-muted"
        >
          ▸
        </motion.span>
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden pl-4"
          >
            {nodes.map((node, i) => {
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
                  transition={{ duration: 0.12, delay: Math.min(i * 0.02, 0.1) }}
                  className={cn(
                    'w-full rounded-lg px-2.5 py-1.5 text-left transition-colors',
                    childActive
                      ? 'bg-white/[0.09]'
                      : 'bg-white/[0.02] hover:bg-white/[0.05]'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <ProviderLogo provider={childProvider.id} size="xs" />
                    <p className="min-w-0 flex-1 truncate text-body text-bright" title={node.title}>
                      {node.title}
                    </p>
                    <span className="text-micro text-muted">
                      {formatRelativeTime(node.updatedAt ?? node.lastEventAt ?? node.startedAt ?? Date.now())}
                    </span>
                  </div>
                </motion.button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export const AgentsChatsPanel = memo(function AgentsChatsPanel({
  sessions,
  activity,
  selectedSessionId,
  onSelectSession,
  timeFilterId,
  onAgentFilter,
  agentFilter,
  onReconnect,
  connectionStatus,
  runtimeInstances = [],
  showSyntheticEntities = false,
}: AgentsChatsPanelProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [launchModalOpen, setLaunchModalOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedPage, setArchivedPage] = useState(0);
  const [detailAgentKey, setDetailAgentKey] = useState<string | null>(null);

  const catalogQuery = useAgentCatalog({ enabled: true });
  const catalogAgents = catalogQuery.data?.agents ?? [];

  const activityCutoffEpoch = useMemo(
    () => cutoffEpochForActivityFilter(timeFilterId),
    [timeFilterId]
  );

  const activityWithinWindow = useMemo(() => {
    if (activityCutoffEpoch === null) return activity;
    return activity.filter((item) => toEpoch(item.timestamp) >= activityCutoffEpoch);
  }, [activity, activityCutoffEpoch]);

  const summaryByRunId = useMemo(() => {
    const map = new Map<string, string>();
    const ordered = [...activityWithinWindow].sort((a, b) => toEpoch(b.timestamp) - toEpoch(a.timestamp));

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
  }, [activityWithinWindow]);

  const {
    agents,
    hiddenGroupCount,
    filteredOutGroupsByDate,
    filteredOutSessionsByDate,
    visibleSessionCount,
    archivedGroups,
    sessionCountInScope,
  } = useMemo(() => {
    const sessionNodes = showSyntheticEntities
      ? sessions.nodes
      : sessions.nodes.filter(
          (node) => !isSyntheticInitiativeForVisibility(node.initiativeId)
        );
    const catalogAgentsInScope = showSyntheticEntities
      ? catalogAgents
      : catalogAgents.filter((agent) => !isSyntheticCatalogAgent(agent));
    const runtimeInstancesInScope = showSyntheticEntities
      ? runtimeInstances
      : runtimeInstances.filter(
          (runtime) => !isSyntheticInitiativeForVisibility(runtime.initiativeId)
        );

    const runtimeByRunId = new Map<string, RuntimeInstance>();
    const runtimeByAgentId = new Map<string, RuntimeInstance[]>();
    const sortedRuntime = [...runtimeInstancesInScope].sort(
      (a, b) => toEpoch(b.lastEventAt ?? b.lastHeartbeatAt) - toEpoch(a.lastEventAt ?? a.lastHeartbeatAt)
    );
    for (const runtime of sortedRuntime) {
      if (runtime.runId && !runtimeByRunId.has(runtime.runId)) {
        runtimeByRunId.set(runtime.runId, runtime);
      }
      const canonicalRuntime = canonicalizeOrgxIdentity(
        runtime.agentId,
        runtime.agentName ?? runtime.displayName
      );
      const normalizedAgentId = normalizeIdentity(
        canonicalRuntime?.agentId ?? runtime.agentId
      );
      if (normalizedAgentId) {
        const list = runtimeByAgentId.get(normalizedAgentId) ?? [];
        list.push(runtime);
        runtimeByAgentId.set(normalizedAgentId, list);
      }
    }

    const map = new Map<string, AgentGroup>();

    for (const node of sessionNodes) {
      const inferred = inferredAgentIdentity(node);
      const preferredKey = sessionGroupKey(node);
      const normalizedId = normalizeIdentity(inferred.agentId);
      const normalizedName = normalizeIdentity(inferred.agentName);
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
        if (!existing.agentId && inferred.agentId) {
          existing.agentId = inferred.agentId;
        }
        if (
          (existing.agentName === 'OrgX' || !existing.agentName) &&
          inferred.agentName
        ) {
          existing.agentName = inferred.agentName;
        }
      } else {
        map.set(preferredKey, {
          groupKey: preferredKey,
          agentId: inferred.agentId,
          agentName: inferred.agentName ?? inferred.agentId ?? 'OrgX',
          nodes: [node],
          latest: node,
          runtime: null,
          runtimeActiveCount: 0,
        });
      }
    }

    // Merge catalog agents: add groups for agents not already in the session map
    for (const catAgent of catalogAgentsInScope) {
      const canonicalCatalog = canonicalizeOrgxIdentity(catAgent.id, catAgent.name);
      const catalogId = canonicalCatalog?.agentId ?? catAgent.id;
      const catalogName = canonicalCatalog?.agentName ?? catAgent.name;
      const normalizedCatalogId = normalizeIdentity(catalogId);
      const normalizedCatalogName = normalizeIdentity(catalogName);
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
        if (!group.agentId && catalogId) {
          group.agentId = catalogId;
        }
        if (
          (group.agentName === 'OrgX' || !group.agentName) &&
          catalogName
        ) {
          group.agentName = catalogName;
        }

        if (idKey && group.groupKey !== idKey && !map.has(idKey)) {
          map.delete(group.groupKey);
          group.groupKey = idKey;
          map.set(idKey, group);
        }
      } else {
        // Synthetic group for catalog-only agent (0 sessions)
        const syntheticKey =
          idKey ?? nameKey ?? `catalog:${catalogName.toLowerCase()}`;
        map.set(syntheticKey, {
          groupKey: syntheticKey,
          agentId: catalogId,
          agentName: catalogName,
          nodes: [],
          latest: null,
          catalogAgent: catAgent,
          runtime: null,
          runtimeActiveCount: 0,
        });
      }
    }

    for (const canonical of CANONICAL_ORGX_AGENTS) {
      const canonicalAgentId = `orgx:${canonical.id}`;
      const canonicalKey = `id:${canonicalAgentId}`;
      let group = map.get(canonicalKey) ?? null;

      if (!group) {
        const aliasMatch = Array.from(map.entries()).find(([, candidate]) => {
          const matched = canonicalizeOrgxIdentity(
            candidate.agentId,
            candidate.agentName
          );
          return normalizeIdentity(matched?.agentId) === normalizeIdentity(canonicalAgentId);
        });
        if (aliasMatch) {
          map.delete(aliasMatch[0]);
          group = aliasMatch[1];
          group.groupKey = canonicalKey;
          map.set(canonicalKey, group);
        }
      }

      if (!group) {
        group = {
          groupKey: canonicalKey,
          agentId: canonicalAgentId,
          agentName: canonical.name,
          nodes: [],
          latest: null,
          runtime: null,
          runtimeActiveCount: 0,
        };
        map.set(canonicalKey, group);
      }

      group.agentId = canonicalAgentId;
      group.agentName = canonical.name;
      if (!group.catalogAgent) {
        const matchedCatalog = catalogAgentsInScope.find((agent) => {
          const identity = canonicalizeOrgxIdentity(agent.id, agent.name);
          return normalizeIdentity(identity?.agentId) === normalizeIdentity(canonicalAgentId);
        });
        if (matchedCatalog) {
          group.catalogAgent = matchedCatalog;
        }
      }
    }

    const canonicalOrder = new Map(
      CANONICAL_ORGX_AGENTS.map((candidate, index) => [
        normalizeIdentity(`orgx:${candidate.id}`),
        index,
      ])
    );

    for (const group of map.values()) {
      if (group.nodes.length > 0) {
        group.nodes.sort(sortByUpdated);
        group.latest = group.nodes[0];
      }

      const runtimeCandidates: RuntimeInstance[] = [];
      const seenRuntime = new Set<string>();

      if (group.latest?.runId) {
        const byRun = runtimeByRunId.get(group.latest.runId);
        if (byRun && !seenRuntime.has(byRun.id)) {
          runtimeCandidates.push(byRun);
          seenRuntime.add(byRun.id);
        }
      }

      for (const node of group.nodes) {
        if (!node.runId) continue;
        const byRun = runtimeByRunId.get(node.runId);
        if (byRun && !seenRuntime.has(byRun.id)) {
          runtimeCandidates.push(byRun);
          seenRuntime.add(byRun.id);
        }
      }

      const groupAgentId = normalizeIdentity(group.agentId);
      if (groupAgentId) {
        for (const runtime of runtimeByAgentId.get(groupAgentId) ?? []) {
          if (seenRuntime.has(runtime.id)) continue;
          runtimeCandidates.push(runtime);
          seenRuntime.add(runtime.id);
        }
      }

      runtimeCandidates.sort(
        (a, b) =>
          toEpoch(b.lastEventAt ?? b.lastHeartbeatAt) -
          toEpoch(a.lastEventAt ?? a.lastHeartbeatAt)
      );
      group.runtime = runtimeCandidates[0] ?? null;
      group.runtimeActiveCount = runtimeCandidates.filter((runtime) =>
        isRuntimeActive(runtime)
      ).length;
    }

    // Sort: groups with sessions first (by latest update), then 0-session groups
    const sortedGroups = Array.from(map.values()).sort((a, b) => {
      const aOrgx = isOrgxGroup(a);
      const bOrgx = isOrgxGroup(b);
      if (aOrgx !== bOrgx) return aOrgx ? -1 : 1;
      if (aOrgx && bOrgx) {
        const aCanonical = canonicalizeOrgxIdentity(a.agentId, a.agentName);
        const bCanonical = canonicalizeOrgxIdentity(b.agentId, b.agentName);
        const aIdx =
          canonicalOrder.get(normalizeIdentity(aCanonical?.agentId ?? a.agentId)) ?? 999;
        const bIdx =
          canonicalOrder.get(normalizeIdentity(bCanonical?.agentId ?? b.agentId)) ?? 999;
        if (aIdx !== bIdx) return aIdx - bIdx;
      }
      if (a.latest && b.latest) return sortByUpdated(a.latest, b.latest);
      if (a.latest && !b.latest) return -1;
      if (!a.latest && b.latest) return 1;
      return a.agentName.localeCompare(b.agentName);
    });

    const selectedWindow = resolveActivityTimeFilter(timeFilterId);
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
      const runtimeIsLive = (group.runtimeActiveCount ?? 0) > 0;
      const isOrgxCanonicalGroup = isOrgxGroup(group);
      // Keep zero-session roster noise out of historical views.
      if (group.nodes.length === 0) {
        const catalogIsLive = isCatalogAgentLive(group.catalogAgent);
        if (isOrgxCanonicalGroup || (isLiveWindow && (catalogIsLive || runtimeIsLive))) {
          filteredGroups.push(group);
        }
        continue;
      }

      if (isLiveWindow) {
        const visibleNodes = group.nodes.filter((node) =>
          isLiveStatus(effectiveSessionStatus(node))
        );
        const archivedNodes = group.nodes.filter((node) =>
          !isLiveStatus(effectiveSessionStatus(node))
        );
        const catalogIsLive = isCatalogAgentLive(group.catalogAgent);

        if (visibleNodes.length === 0) {
          if (isOrgxCanonicalGroup || catalogIsLive || runtimeIsLive) {
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
        // Treat only actively progressing runs as "always visible" within time windows.
        // Blocked/failed runs should respect the selected time filter so "24h/7d" feels real.
        if (isActiveStatus(effectiveSessionStatus(node))) return true;
        const nodeEpoch = toEpoch(node.updatedAt ?? node.lastEventAt ?? node.startedAt);
        return nodeEpoch >= cutoffEpoch;
      });

      const catalogIsLive = isCatalogAgentLive(group.catalogAgent);

      if (visibleNodes.length === 0) {
        if (isOrgxCanonicalGroup || catalogIsLive || runtimeIsLive) {
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
        if (isActiveStatus(effectiveSessionStatus(node))) return false;
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
      sessionCountInScope: sessionNodes.length,
    };
  }, [timeFilterId, sessions.nodes, catalogAgents, runtimeInstances, showSyntheticEntities]);

  // Reset archived disclosure when filter changes
  useEffect(() => {
    setShowArchived(false);
    setArchivedPage(0);
  }, [timeFilterId]);

  const archivedSessionCount = useMemo(
    () => archivedGroups.reduce((sum, g) => sum + g.nodes.length, 0),
    [archivedGroups]
  );

  const groupKeysWithSessions = useMemo(
    () => agents.filter((group) => group.nodes.length > 0).map((group) => group.groupKey),
    [agents]
  );

  const collapseAllState = useMemo(() => {
    if (groupKeysWithSessions.length === 0) {
      return { allCollapsed: false, allExpanded: true };
    }
    let collapsedCount = 0;
    for (const key of groupKeysWithSessions) {
      if (collapsed.has(key)) collapsedCount += 1;
    }
    return {
      allCollapsed: collapsedCount === groupKeysWithSessions.length,
      allExpanded: collapsedCount === 0,
    };
  }, [collapsed, groupKeysWithSessions]);

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

  const toggleCollapseAll = () => {
    setCollapsed(() => {
      if (collapseAllState.allCollapsed) {
        return new Set();
      }
      return new Set(groupKeysWithSessions);
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
      const detailCanonical = canonicalizeOrgxIdentity(detailGroup.agentId, detailGroup.agentName);
      return activityWithinWindow.filter((item) => {
        const itemName = normalizeIdentity(item.agentName);
        const itemId = normalizeIdentity(item.agentId);
        const itemCanonical = canonicalizeOrgxIdentity(item.agentId, item.agentName);
        return (
          (detailName !== null && itemName === detailName) ||
          (detailId !== null && itemId === detailId) ||
          (
            detailCanonical !== null &&
            itemCanonical !== null &&
            normalizeIdentity(detailCanonical.agentId) === normalizeIdentity(itemCanonical.agentId)
          )
        );
      });
    },
    [activityWithinWindow, detailGroup]
  );

  const hasNoSessions = sessionCountInScope === 0;
  const hasCatalogAgents = catalogAgents.length > 0;
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const [listScrollTop, setListScrollTop] = useState(0);
  const [listViewportHeight, setListViewportHeight] = useState(0);

  const handleListScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const nextTop = event.currentTarget.scrollTop;
    setListScrollTop((prev) => (Math.abs(prev - nextTop) < 1 ? prev : nextTop));
  }, []);

  useEffect(() => {
    const node = listScrollRef.current;
    if (!node) return;

    const syncMetrics = () => {
      const nextHeight = node.clientHeight;
      const nextTop = node.scrollTop;
      setListViewportHeight((prev) => (prev === nextHeight ? prev : nextHeight));
      setListScrollTop((prev) => (Math.abs(prev - nextTop) < 1 ? prev : nextTop));
    };

    syncMetrics();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => syncMetrics());
      observer.observe(node);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', syncMetrics);
    return () => window.removeEventListener('resize', syncMetrics);
  }, [agents.length]);

  const {
    visibleAgentGroups,
    topVirtualSpacerPx,
    bottomVirtualSpacerPx,
    virtualizationEnabled,
  } = useMemo(() => {
    const canVirtualize =
      agents.length > AGENT_VIRTUALIZATION_THRESHOLD && listViewportHeight > 0;
    if (!canVirtualize) {
      return {
        visibleAgentGroups: agents,
        topVirtualSpacerPx: 0,
        bottomVirtualSpacerPx: 0,
        virtualizationEnabled: false,
      };
    }

    const estimatedHeights = agents.map((group) => {
      const collapsedGroup = collapsed.has(group.groupKey);
      const visibleChildCount = collapsedGroup
        ? 0
        : Math.min(group.nodes.length, MAX_VISIBLE_CHILD_SESSIONS);
      let estimated = AGENT_ROW_BASE_HEIGHT;
      if (visibleChildCount > 0) {
        estimated += AGENT_ROW_CONTAINER_PADDING + visibleChildCount * AGENT_ROW_CHILD_HEIGHT;
        if (group.nodes.length > visibleChildCount) estimated += 20;
      }
      return estimated + AGENT_ROW_ESTIMATED_GAP;
    });

    const prefixHeights = new Array(estimatedHeights.length + 1).fill(0);
    for (let i = 0; i < estimatedHeights.length; i += 1) {
      prefixHeights[i + 1] = prefixHeights[i] + estimatedHeights[i];
    }

    const totalHeight = prefixHeights[prefixHeights.length - 1];
    const startBoundary = Math.max(0, listScrollTop - AGENT_VIRTUAL_OVERSCAN_PX);
    const endBoundary = listScrollTop + listViewportHeight + AGENT_VIRTUAL_OVERSCAN_PX;

    let startIndex = 0;
    while (
      startIndex < agents.length &&
      prefixHeights[startIndex + 1] < startBoundary
    ) {
      startIndex += 1;
    }

    let endIndex = startIndex;
    while (endIndex < agents.length && prefixHeights[endIndex] < endBoundary) {
      endIndex += 1;
    }
    if (endIndex <= startIndex) endIndex = Math.min(agents.length, startIndex + 1);

    return {
      visibleAgentGroups: agents.slice(startIndex, endIndex),
      topVirtualSpacerPx: prefixHeights[startIndex],
      bottomVirtualSpacerPx: Math.max(0, totalHeight - prefixHeights[endIndex]),
      virtualizationEnabled: true,
    };
  }, [agents, collapsed, listScrollTop, listViewportHeight]);

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
      <div className="border-b border-subtle px-4 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="min-w-0 truncate text-heading font-semibold text-white">
              Agents
            </h2>
            <span className="chip flex-shrink-0 text-caption tabular-nums">
              {visibleSessionCount} of {sessionCountInScope}
            </span>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={toggleCollapseAll}
              disabled={groupKeysWithSessions.length === 0}
              className="control-pill hidden flex-shrink-0 px-3 text-caption font-semibold sm:inline-flex"
              title={
                collapseAllState.allCollapsed ? 'Expand all agent groups' : 'Collapse all agent groups'
              }
            >
              {collapseAllState.allCollapsed ? 'Expand' : 'Collapse'}
            </button>
            <button
              type="button"
              onClick={() => setLaunchModalOpen(true)}
              className="control-pill flex-shrink-0 px-3 text-caption font-semibold"
            >
              Launch
            </button>
          </div>
        </div>
      </div>

      <div
        ref={listScrollRef}
        onScroll={handleListScroll}
        className="flex-1 space-y-2 overflow-y-auto p-3"
      >
        {agents.length === 0 && !hasNoSessions && (
          <div className="flex flex-col items-center gap-2.5 rounded-xl border border-subtle bg-white/[0.02] px-3 py-6 text-center">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-faint"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p className="text-body text-secondary">
              No sessions match the selected activity window.
            </p>
          </div>
        )}

        {agents.length === 0 && hasNoSessions && !onReconnect && (
          <div className="flex flex-col items-center gap-2.5 rounded-xl border border-subtle bg-white/[0.02] px-3 py-6 text-center">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-faint"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p className="text-body text-secondary">
              No active chats yet. Start a session to see agents here.
            </p>
          </div>
        )}

        {agentFilter && onAgentFilter && (
          <div className="flex items-center justify-between rounded-lg bg-[#0AD4C4]/[0.08] px-3 py-1.5 text-caption text-[#0AD4C4]">
            <span>Filtered: {agentFilter}</span>
            <button
              type="button"
              onClick={() => onAgentFilter(null)}
              className="text-micro underline underline-offset-2"
            >
              Clear
            </button>
          </div>
        )}

        <div className="space-y-2">
          {virtualizationEnabled && topVirtualSpacerPx > 0 && (
            <div
              aria-hidden="true"
              style={{ height: topVirtualSpacerPx }}
            />
          )}

          {visibleAgentGroups.map((group) => {
          const agentKey = group.groupKey;
          const isCollapsed = collapsed.has(agentKey);
          const lead = group.latest;
          const leadStatus = lead ? effectiveSessionStatus(lead) : null;
          const hasSessions = group.nodes.length > 0;
          const hasSingleSession = group.nodes.length === 1;
          const catalogIsLive = isCatalogAgentLive(group.catalogAgent);
          const runtime = group.runtime ?? null;
          const runtimeIsLive = (group.runtimeActiveCount ?? 0) > 0;
          const hasRuntimeSession = !hasSessions && runtimeIsLive && runtime !== null;
          const hasExpandableContent = hasSessions || hasRuntimeSession;
          const active = lead ? selectedSessionId === lead.id : false;
          const displayNameRaw =
            group.agentName || group.catalogAgent?.name || group.agentId || 'OrgX';
          const canonicalOrgx = canonicalizeOrgxIdentity(group.agentId, displayNameRaw);
          const displayName = canonicalOrgx?.agentName ?? compactAgentDisplayName(displayNameRaw);
          const roleLabel = canonicalOrgx?.role ?? getAgentRole(displayName);
          const headerProvider = resolveProvider(
            group.agentId,
            displayName,
            runtime?.displayName,
            lead?.runtimeProvider,
            lead?.runtimeClient
          );
          const showProviderAvatar =
            canonicalOrgx === null &&
            (headerProvider.id === 'codex' ||
              headerProvider.id === 'openai' ||
              headerProvider.id === 'anthropic' ||
              headerProvider.id === 'openclaw');
          const filterLabel = roleLabel ? `${displayNameRaw} — ${roleLabel}` : displayNameRaw;
          const visibleChildren = isCollapsed
            ? []
            : hasSessions
              ? group.nodes.slice(0, MAX_VISIBLE_CHILD_SESSIONS)
              : [];
          const hiddenChildren = Math.max(
            0,
            hasSessions ? group.nodes.length - visibleChildren.length : 0
          );
          const isFiltered =
            normalizeIdentity(agentFilter) === normalizeIdentity(displayName) ||
            normalizeIdentity(agentFilter) === normalizeIdentity(filterLabel);

          return (
            <motion.div
              key={agentKey}
              layout
              transition={{ type: 'spring', stiffness: 260, damping: 30, mass: 0.75 }}
              className={cn(
                'overflow-hidden rounded-xl border border-subtle bg-white/[0.02] transition-all',
                active && 'border-white/20 bg-white/[0.05]',
                isFiltered && 'border-[#0AD4C4]/30',
                !hasSessions && !catalogIsLive && !runtimeIsLive && 'opacity-55'
              )}
            >
              {/* Agent group header: avatar + name + status dot + session count + detail + collapse */}
              <div className="flex items-center gap-2.5 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => {
                    if (hasSingleSession) {
                      onSelectSession(group.nodes[0].id);
                    } else if (hasRuntimeSession) {
                      toggleCollapse(agentKey);
                    } else if (!hasSessions && catalogIsLive) {
                      setDetailAgentKey(agentKey);
                    } else if (onAgentFilter) {
                      onAgentFilter(isFiltered ? null : displayName);
                    } else if (lead) {
                      onSelectSession(lead.id);
                    }
                  }}
                  className="flex flex-1 items-center gap-2.5 rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-white/[0.03]"
                >
                  <div className="relative flex-shrink-0">
                    {showProviderAvatar ? (
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-strong bg-white/[0.03]">
                        <ProviderLogo provider={headerProvider.id} size="sm" showRing={false} />
                      </span>
                    ) : (
                      <AgentHealthRing
                        running={group.nodes.filter((n) => { const s = effectiveSessionStatus(n); return s === 'running' || s === 'handoff' || s === 'review'; }).length}
                        blocked={group.nodes.filter((n) => { const s = effectiveSessionStatus(n); return s === 'blocked' || s === 'failed'; }).length}
                        paused={group.nodes.filter((n) => { const s = effectiveSessionStatus(n); return s === 'paused' || s === 'cancelled'; }).length}
                        size={36}
                      >
                        <AgentAvatar
                          name={displayName}
                          size="sm"
                          hint={`${group.agentId ?? ''} ${displayName}`}
                        />
                      </AgentHealthRing>
                    )}
                    {canonicalOrgx && (
                      <span className="absolute -bottom-0.5 -left-0.5 inline-flex h-3 w-3 items-center justify-center rounded-full border border-[#08090D] bg-[#08090D]">
                        <img
                          src="/orgx/live/brand/orgx-logo.png"
                          alt=""
                          aria-hidden="true"
                          className="h-2.5 w-2.5 rounded-full object-contain"
                          loading="lazy"
                        />
                      </span>
                    )}
                    {lead && (
                      <span
                        className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2"
                        style={{
                          backgroundColor: statusColor(leadStatus ?? lead.status),
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
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-baseline gap-1.5">
                        <span
                          className={cn(
                            'min-w-0 truncate text-body font-semibold text-white',
                            roleLabel ? 'flex-[1.15]' : 'flex-1'
                          )}
                          title={displayNameRaw}
                        >
                          {displayName}
                        </span>
                        {roleLabel && (
                          <span
                            className="min-w-0 flex-1 truncate text-caption font-normal text-muted"
                            title={roleLabel}
                          >
                            — {roleLabel}
                          </span>
                        )}
                      </div>
                    </div>
                  {hasSessions ? (
                    <span className="inline-flex min-w-[76px] items-center justify-end gap-1.5">
                      <span
                        className="flex h-1.5 w-12 overflow-hidden rounded-full"
                        title={(() => {
                          const counts: Record<string, number> = {};
                          for (const node of group.nodes) {
                            const nodeStatus = effectiveSessionStatus(node);
                            counts[nodeStatus] = (counts[nodeStatus] ?? 0) + 1;
                          }
                          return Object.entries(counts).map(([s, c]) => `${c} ${s}`).join(' · ');
                        })()}
                      >
                        {(() => {
                          const counts: Record<string, number> = {};
                          for (const node of group.nodes) {
                            const nodeStatus = effectiveSessionStatus(node);
                            counts[nodeStatus] = (counts[nodeStatus] ?? 0) + 1;
                          }
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
                      <span className="text-micro text-secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {group.nodes.length}
                      </span>
                    </span>
                  ) : catalogIsLive || runtimeIsLive ? (
                    <span className="inline-flex min-w-[76px] items-center justify-end gap-1.5">
                      <span className="flex h-1.5 w-12 overflow-hidden rounded-full bg-white/[0.06]">
                        <span
                          className="h-1.5 w-full"
                          style={{ backgroundColor: statusColor('running') }}
                        />
                      </span>
                      <span className="text-micro text-secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {Math.max(1, group.runtimeActiveCount ?? 0)}
                      </span>
                    </span>
                  ) : (
                    <span className="inline-flex min-w-[76px] items-center justify-end gap-1.5">
                      <span className="flex h-1.5 w-12 overflow-hidden rounded-full bg-white/[0.06]" />
                      <span className="text-micro text-muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
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
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-white/[0.05] hover:text-primary"
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

                <button
                  type="button"
                  onClick={() => {
                    if (!hasExpandableContent) return;
                    toggleCollapse(agentKey);
                  }}
                  disabled={!hasExpandableContent}
                  aria-label={
                    hasExpandableContent
                      ? isCollapsed
                        ? 'Expand sessions'
                        : 'Collapse sessions'
                      : 'No sessions to expand'
                  }
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors',
                    hasExpandableContent
                      ? 'hover:bg-white/[0.05] hover:text-primary'
                      : 'cursor-default opacity-35'
                  )}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className={cn(
                      'transition-transform',
                      hasExpandableContent && !isCollapsed ? 'rotate-0' : '-rotate-90'
                    )}
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
              </div>

              <AnimatePresence initial={false}>
                {hasExpandableContent && !isCollapsed && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                    className="overflow-hidden border-t border-subtle"
                  >
                    <div className="max-h-[500px] space-y-1.5 overflow-y-auto p-2">
                      {(() => {
                        // Group identical blocked/paused sessions (>3 with same status)
                        const groupedByStatus = new Map<string, SessionTreeNode[]>();
                        const ungrouped: SessionTreeNode[] = [];
                        for (const node of visibleChildren) {
                          const nodeStatus = effectiveSessionStatus(node);
                          if (nodeStatus === 'blocked' || nodeStatus === 'paused' || nodeStatus === 'failed') {
                            const gKey = `${nodeStatus}:${node.blockerReason ?? ''}`;
                            const arr = groupedByStatus.get(gKey) ?? [];
                            arr.push(node);
                            groupedByStatus.set(gKey, arr);
                          } else {
                            ungrouped.push(node);
                          }
                        }
                        const collapsedGroups: Array<{ status: string; nodes: SessionTreeNode[] }> = [];
                        for (const [gKey, nodes] of groupedByStatus) {
                          if (nodes.length > 3) {
                            collapsedGroups.push({ status: gKey.split(':')[0], nodes });
                          } else {
                            ungrouped.push(...nodes);
                          }
                        }
                        const renderSessionButton = (node: SessionTreeNode, index: number) => {
                          const childActive = selectedSessionId === node.id;
                          const nodeStatus = effectiveSessionStatus(node);
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
                                  <p className="truncate text-body text-bright" title={node.title}>
                                    {node.title}
                                  </p>
                                  <div className="flex items-center gap-1.5 text-micro text-secondary">
                                    <span
                                      className="font-semibold uppercase tracking-[0.08em]"
                                      style={{ color: childProvider.accent }}
                                    >
                                      {childProvider.label}
                                    </span>
                                    <span className="uppercase tracking-[0.08em]">{nodeStatus}</span>
                                    <span title={formatAbsoluteTime(node.updatedAt ?? node.lastEventAt ?? node.startedAt ?? Date.now())}>
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
                                  style={{ backgroundColor: statusColor(nodeStatus) }}
                                  aria-label={nodeStatus}
                                  title={nodeStatus}
                                />
                              </div>
                            </motion.button>
                          );
                        };
                        return (
                          <>
                            {ungrouped.map((node, i) => renderSessionButton(node, i))}
                            {collapsedGroups.map((cg) => (
                              <CollapsedSessionGroup
                                key={`cg-${cg.status}-${cg.nodes.length}`}
                                status={cg.status}
                                nodes={cg.nodes}
                                onSelectSession={onSelectSession}
                                selectedSessionId={selectedSessionId}
                              />
                            ))}
                          </>
                        );
                      })()}

                      {hiddenChildren > 0 && (
                        <p className="px-1 text-micro text-muted">
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

          {virtualizationEnabled && bottomVirtualSpacerPx > 0 && (
            <div
              aria-hidden="true"
              style={{ height: bottomVirtualSpacerPx }}
            />
          )}
        </div>

        {hiddenGroupCount > 0 && (
          <div className="rounded-xl border border-subtle bg-white/[0.02] px-3 py-2 text-caption text-secondary">
            Showing {MAX_VISIBLE_GROUPS} most recent agent groups ({hiddenGroupCount} older groups omitted).
          </div>
        )}

        {onReconnect && connectionStatus !== 'connected' && !hasCatalogAgents && (
          <div className="rounded-xl border border-subtle bg-white/[0.02] text-caption text-secondary">
            <p className="px-3 pt-2 pb-1.5 text-micro uppercase tracking-[0.1em] text-muted">
              OrgX Agent Roster
            </p>
            <div className="space-y-1 px-2 pb-2">
              {DEFAULT_ORGX_AGENTS.map((agent) => (
                <div
                  key={agent.id}
                  className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 opacity-55"
                >
                  <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03]">
                    <span className="text-micro font-semibold text-secondary">
                      {agent.name.charAt(0)}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-caption font-medium text-secondary">{agent.name}</p>
                    <p className="text-micro text-muted">{agent.role}</p>
                  </div>
                  <button
                    onClick={onReconnect}
                    className="rounded-md border border-lime/25 bg-lime/10 px-2 py-0.5 text-micro font-semibold text-lime transition-colors hover:bg-lime/20"
                  >
                    Connect
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {filteredOutSessionsByDate > 0 && (
          <div className="rounded-xl border border-subtle bg-white/[0.02] text-caption text-secondary">
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
              <div className="space-y-1.5 border-t border-subtle p-2">
                {paginatedArchivedSessions.map(({ node, agentName }) => {
                  const nodeStatus = effectiveSessionStatus(node);
                  const provider = node.runtimeProvider
                    ? { id: runtimeProviderIdFromLogo(node.runtimeProvider) }
                    : resolveProvider(node.agentName, node.title, node.lastEventSummary, node);
                  return (
                    <button
                      key={node.id}
                      onClick={() => onSelectSession(node.id)}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left opacity-60 transition-colors hover:bg-white/[0.05] hover:opacity-80"
                    >
                      <ProviderLogo provider={provider.id} size="xs" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-caption font-medium text-primary">{agentName}</p>
                          <span className="text-micro text-muted" title={formatAbsoluteTime(node.updatedAt ?? node.lastEventAt ?? node.startedAt ?? Date.now())}>
                            {formatRelativeTime(node.updatedAt ?? node.lastEventAt ?? node.startedAt ?? Date.now())}
                          </span>
                        </div>
                        <p className="truncate text-micro text-secondary">{node.title}</p>
                        <span className="text-micro uppercase tracking-[0.08em] text-muted">{nodeStatus}</span>
                      </div>
                    </button>
                  );
                })}

                {paginatedArchivedSessions.length < archivedSessionCount && (
                  <button
                    onClick={() => setArchivedPage((prev) => prev + 1)}
                    className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-micro text-secondary transition-colors hover:bg-white/[0.05]"
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
