import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type {
  Initiative,
  InitiativeDetails,
  MissionControlNode,
  InitiativeWorkstream,
  InitiativeMilestone,
  InitiativeTask,
} from '@/types';
import {
  initiativeStatusClass,
  formatEntityStatus,
  statusColor,
} from '@/lib/entityStatusColors';
import { formatDueBadge } from '@/lib/initiativeDate';
import { Skeleton } from '@/components/shared/Skeleton';
import { InferredAgentAvatars } from './AgentInference';
import { useMissionControl } from './MissionControlContext';
import { useMissionControlGraph } from '@/hooks/useMissionControlGraph';
import { useInitiativeDetails } from '@/hooks/useInitiativeDetails';
import { DependencyMapPanel } from './DependencyMapPanel';
import { HierarchyTreeTable } from './HierarchyTreeTable';
import { RecentTodosRail } from './RecentTodosRail';
import { clampPercent, completionPercent, isDoneStatus } from '@/lib/progress';
import { CollapsibleSection } from './CollapsibleSection';

interface InitiativeSectionProps {
  initiative: Initiative;
  selected?: boolean;
  onSelectionChange?: (initiativeId: string, selected: boolean) => void;
}

function priorityFromLabel(value: string | null | undefined): {
  priorityNum: number;
  priorityLabel: string | null;
} {
  if (!value) return { priorityNum: 60, priorityLabel: null };
  const normalized = value.trim().toLowerCase();
  if (normalized === 'urgent' || normalized === 'p0') return { priorityNum: 10, priorityLabel: 'urgent' };
  if (normalized === 'high' || normalized === 'p1') return { priorityNum: 25, priorityLabel: 'high' };
  if (normalized === 'medium' || normalized === 'p2') return { priorityNum: 50, priorityLabel: 'medium' };
  if (normalized === 'low' || normalized === 'p3' || normalized === 'p4') {
    return { priorityNum: 75, priorityLabel: 'low' };
  }

  const numeric = Number(normalized.replace(/^p/, ''));
  if (Number.isFinite(numeric)) {
    const clamped = Math.max(1, Math.min(100, Math.round(numeric)));
    return { priorityNum: clamped, priorityLabel: null };
  }
  return { priorityNum: 60, priorityLabel: null };
}

function isTodoTaskStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return ['todo', 'not_started', 'planned', 'pending', 'backlog'].includes(normalized);
}

function isActiveTaskStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return ['in_progress', 'active', 'running', 'queued'].includes(normalized);
}

function buildLegacyGraphNodes(
  initiative: Initiative,
  details: InitiativeDetails
): {
  nodes: MissionControlNode[];
  edges: Array<{ from: string; to: string; kind: 'depends_on' }>;
  recentTodos: string[];
} {
  const initiativeNode: MissionControlNode = {
    id: initiative.id,
    type: 'initiative',
    title: initiative.name,
    status: initiative.rawStatus ?? initiative.status,
    parentId: null,
    initiativeId: initiative.id,
    workstreamId: null,
    milestoneId: null,
    priorityNum: 60,
    priorityLabel: null,
    dependencyIds: [],
    dueDate: initiative.targetDate ?? null,
    etaEndAt: initiative.targetDate ?? null,
    expectedDurationHours: 40,
    expectedBudgetUsd: 1500,
    assignedAgents: [],
    updatedAt: initiative.updatedAt ?? initiative.createdAt ?? null,
  };

  // Use entity workstreams if available, otherwise fall back to session-derived workstreams
  const workstreamSource = details.workstreams.length > 0
    ? details.workstreams
    : (initiative.workstreams ?? []).map((ws) => ({
        id: ws.id,
        name: ws.name,
        summary: null,
        status: ws.status,
        progress: null,
        initiativeId: initiative.id,
        createdAt: null,
      }));

  const workstreamNodes: MissionControlNode[] = workstreamSource.map((workstream) => ({
    id: workstream.id,
    type: 'workstream' as const,
    title: workstream.name,
    status: workstream.status,
    parentId: initiative.id,
    initiativeId: initiative.id,
    workstreamId: workstream.id,
    milestoneId: null,
    priorityNum: 50,
    priorityLabel: 'medium',
    dependencyIds: [],
    dueDate: null,
    etaEndAt: null,
    expectedDurationHours: 16,
    expectedBudgetUsd: 300,
    assignedAgents: [],
    updatedAt: workstream.createdAt,
  }));

  const workstreamIdSet = new Set(workstreamNodes.map((node) => node.id));
  const milestoneNodes: MissionControlNode[] = details.milestones.map((milestone) => ({
    id: milestone.id,
    type: 'milestone',
    title: milestone.title,
    status: milestone.status,
    parentId:
      milestone.workstreamId && workstreamIdSet.has(milestone.workstreamId)
        ? milestone.workstreamId
        : initiative.id,
    initiativeId: initiative.id,
    workstreamId:
      milestone.workstreamId && workstreamIdSet.has(milestone.workstreamId)
        ? milestone.workstreamId
        : null,
    milestoneId: milestone.id,
    priorityNum: 50,
    priorityLabel: 'medium',
    dependencyIds: [],
    dueDate: milestone.dueDate,
    etaEndAt: milestone.dueDate,
    expectedDurationHours: 6,
    expectedBudgetUsd: 120,
    assignedAgents: [],
    updatedAt: milestone.createdAt,
  }));

  const milestoneIdSet = new Set(milestoneNodes.map((node) => node.id));
  const taskNodes: MissionControlNode[] = details.tasks.map((task) => {
    const priority = priorityFromLabel(task.priority);
    const hasMilestone = task.milestoneId && milestoneIdSet.has(task.milestoneId);
    const hasWorkstream = task.workstreamId && workstreamIdSet.has(task.workstreamId);
    return {
      id: task.id,
      type: 'task',
      title: task.title,
      status: task.status,
      parentId: hasMilestone ? task.milestoneId : hasWorkstream ? task.workstreamId : initiative.id,
      initiativeId: initiative.id,
      workstreamId: hasWorkstream ? task.workstreamId : null,
      milestoneId: hasMilestone ? task.milestoneId : null,
      priorityNum: priority.priorityNum,
      priorityLabel: priority.priorityLabel,
      dependencyIds: [],
      dueDate: task.dueDate,
      etaEndAt: task.dueDate,
      expectedDurationHours: 2,
      expectedBudgetUsd: 40,
      assignedAgents: [],
      updatedAt: task.createdAt,
    };
  });

  const recentTodos = taskNodes
    .filter((task) =>
      ['todo', 'not_started', 'planned', 'pending', 'backlog'].includes(
        task.status.toLowerCase()
      )
    )
    .sort((a, b) => {
      const pr = a.priorityNum - b.priorityNum;
      if (pr !== 0) return pr;
      const aEta = a.etaEndAt ? Date.parse(a.etaEndAt) : Infinity;
      const bEta = b.etaEndAt ? Date.parse(b.etaEndAt) : Infinity;
      if (aEta !== bEta) return aEta - bEta;
      const aEpoch = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const bEpoch = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return bEpoch - aEpoch;
    })
    .map((task) => task.id);

  return {
    nodes: [initiativeNode, ...workstreamNodes, ...milestoneNodes, ...taskNodes],
    edges: [],
    recentTodos,
  };
}

function computeHighlightedPath(nodeId: string | null, nodes: MissionControlNode[]): Set<string> {
  if (!nodeId) return new Set();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const reverseDeps = new Map<string, string[]>();

  for (const node of nodes) {
    for (const depId of node.dependencyIds) {
      const dependents = reverseDeps.get(depId) ?? [];
      dependents.push(node.id);
      reverseDeps.set(depId, dependents);
    }
  }

  const highlighted = new Set<string>();
  const queue: string[] = [nodeId];

  while (queue.length > 0) {
    const currentId = queue.shift() as string;
    if (highlighted.has(currentId)) continue;
    highlighted.add(currentId);

    const currentNode = byId.get(currentId);
    if (!currentNode) continue;

    for (const depId of currentNode.dependencyIds) {
      if (!highlighted.has(depId)) queue.push(depId);
    }
    for (const dependentId of reverseDeps.get(currentId) ?? []) {
      if (!highlighted.has(dependentId)) queue.push(dependentId);
    }
  }

  return highlighted;
}

function toWorkstreamEntity(node: MissionControlNode, initiative: Initiative): InitiativeWorkstream {
  return {
    id: node.id,
    name: node.title,
    summary: null,
    status: node.status,
    progress: null,
    initiativeId: initiative.id,
    createdAt: node.updatedAt,
  };
}

function toMilestoneEntity(node: MissionControlNode, initiative: Initiative): InitiativeMilestone {
  return {
    id: node.id,
    title: node.title,
    description: null,
    status: node.status,
    dueDate: node.dueDate,
    initiativeId: initiative.id,
    workstreamId: node.workstreamId,
    createdAt: node.updatedAt,
  };
}

function toTaskEntity(node: MissionControlNode, initiative: Initiative): InitiativeTask {
  return {
    id: node.id,
    title: node.title,
    description: null,
    status: node.status,
    priority: node.priorityLabel ?? `p${node.priorityNum}`,
    dueDate: node.dueDate,
    initiativeId: initiative.id,
    milestoneId: node.milestoneId,
    workstreamId: node.workstreamId,
    createdAt: node.updatedAt,
  };
}

function humanizeWarning(raw: string): string {
  if (/unknown api endpoint/i.test(raw)) return 'Graph API unavailable — showing session-derived data';
  if (/401|unauthorized/i.test(raw)) return 'Auth expired — reconnect to load full data';
  if (/failed to list initiative/i.test(raw)) return 'Initiative data unavailable';
  if (/failed to list workstream/i.test(raw)) return 'Workstream data unavailable';
  if (/failed to list milestone/i.test(raw)) return 'Milestone data unavailable';
  if (/failed to list task/i.test(raw)) return 'Task data unavailable';
  if (/500 internal server/i.test(raw)) return 'Server error — some data may be incomplete';
  if (/entity data partially unavailable/i.test(raw)) return 'Entity data partially unavailable';
  if (raw.length > 80) return raw.slice(0, 72).replace(/[^a-zA-Z0-9]$/, '') + '...';
  return raw;
}

const staggerItem = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0 },
};

interface MetricChipProps {
  label: string;
  value: string;
}

function MetricChip({ label, value }: MetricChipProps) {
  return (
    <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-2">
      <div className="text-[10px] text-white/45">{label}</div>
      <div className="mt-0.5 text-[12px] font-semibold text-white/85">{value}</div>
    </div>
  );
}

export function InitiativeSection({
  initiative,
  selected = false,
  onSelectionChange,
}: InitiativeSectionProps) {
  const {
    expandedInitiatives,
    toggleExpanded,
    openModal,
    agentEntityMap,
    authToken,
    embedMode,
    mutations,
  } = useMissionControl();

  const [editMode, setEditMode] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [focusedWorkstreamId, setFocusedWorkstreamId] = useState<string | null>(null);
  const [warningsExpanded, setWarningsExpanded] = useState(false);

  const isExpanded = expandedInitiatives.has(initiative.id);
  const { graph, isLoading, degraded, error } = useMissionControlGraph({
    initiativeId: initiative.id,
    authToken,
    embedMode,
    enabled: isExpanded,
  });
  const {
    details,
    isLoading: isLegacyLoading,
    error: legacyError,
  } = useInitiativeDetails({
    initiativeId: initiative.id,
    authToken,
    embedMode,
    enabled: isExpanded,
  });

  const legacyGraph = useMemo(
    () => buildLegacyGraphNodes(initiative, details),
    [initiative, details]
  );

  const hasPrimaryGraphData = Boolean(graph && graph.nodes.length > 0);
  const hasLegacyGraphData = legacyGraph.nodes.length > 0;
  const useLegacyGraph = !hasPrimaryGraphData && hasLegacyGraphData;

  const nodes = useLegacyGraph ? legacyGraph.nodes : (hasPrimaryGraphData ? graph?.nodes ?? [] : legacyGraph.nodes);
  const edges = useLegacyGraph ? legacyGraph.edges : (hasPrimaryGraphData ? graph?.edges ?? [] : legacyGraph.edges);
  const recentTodoIds = useLegacyGraph ? legacyGraph.recentTodos : (hasPrimaryGraphData ? graph?.recentTodos ?? [] : legacyGraph.recentTodos);

  const authUnavailable =
    degraded.some((msg) => /401|unauthorized/i.test(msg)) ||
    Boolean(error && /401|unauthorized/i.test(error)) ||
    Boolean(legacyError && /401|unauthorized/i.test(legacyError));

  const graphErrorMessage =
    error && /unknown api endpoint/i.test(error)
      ? 'Graph API unavailable. Showing session-derived data.'
      : error;
  const legacyErrorMessage = legacyError;

  const warnings = [
    ...degraded,
    ...(graphErrorMessage ? [graphErrorMessage] : []),
    ...(legacyErrorMessage ? [`Entity data partially unavailable: ${legacyErrorMessage}`] : []),
    ...(authUnavailable
      ? ['OrgX auth is missing or expired in this local plugin instance. Reconnect in onboarding to load full workstreams/milestones/tasks.']
      : []),
  ];

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const highlightedNodeIds = useMemo(
    () => computeHighlightedPath(selectedNodeId, nodes),
    [selectedNodeId, nodes]
  );
  const hasRecentTodos = useMemo(
    () => recentTodoIds.some((id) => nodeById.has(id)),
    [nodeById, recentTodoIds]
  );

  useEffect(() => {
    if (!isExpanded) return;
    if (!selectedNodeId && nodes.length > 0) {
      setSelectedNodeId(nodes[0]?.id ?? null);
    }
  }, [isExpanded, nodes, selectedNodeId]);

  const explicitAgents = (graph?.initiative.assignedAgents ?? []).map((agent) => ({
    id: agent.id,
    name: agent.name,
    confidence: 'high' as const,
  }));

  const inferredAgents = agentEntityMap.get(initiative.id) ?? [];
  const agents = explicitAgents.length > 0 ? explicitAgents : inferredAgents;

  const taskNodes = nodes.filter((node) => node.type === 'task');
  const activeTaskCount = taskNodes.filter((node) => isActiveTaskStatus(node.status)).length;
  const todoTaskCount = taskNodes.filter((node) => isTodoTaskStatus(node.status)).length;
  const doneTaskCount = taskNodes.filter((node) => isDoneStatus(node.status)).length;
  const isExecutionActive = activeTaskCount > 0;
  const effectiveInitiativeStatus = initiative.status;
  const executionBadge =
    initiative.status === 'active'
      ? isExecutionActive
        ? { label: 'In Progress', className: 'border-[#BFFF00]/28 bg-[#BFFF00]/12 text-[#D8FFA1]' }
        : todoTaskCount > 0
          ? { label: 'Queued', className: 'border-white/[0.14] bg-white/[0.04] text-white/62' }
          : { label: 'Idle', className: 'border-white/[0.14] bg-white/[0.035] text-white/55' }
      : null;

  const budgetSourceNodes =
    taskNodes.length > 0
      ? taskNodes
      : nodes.some((node) => node.type === 'milestone')
        ? nodes.filter((node) => node.type === 'milestone')
        : nodes.filter((node) => node.type === 'workstream');
  const totalExpectedDurationHours = Math.round(
    budgetSourceNodes.reduce((sum, node) => sum + (node.expectedDurationHours || 0), 0) * 10
  ) / 10;
  const totalExpectedBudgetUsd = Math.round(
    budgetSourceNodes.reduce((sum, node) => sum + (node.expectedBudgetUsd || 0), 0) * 100
  ) / 100;

  const milestoneNodes = nodes.filter((node) => node.type === 'milestone');
  const workstreamNodes = nodes.filter((node) => node.type === 'workstream');
  const hasEntityHierarchy =
    isExpanded &&
    (hasPrimaryGraphData ||
      details.workstreams.length > 0 ||
      details.milestones.length > 0 ||
      details.tasks.length > 0);

  const computedProgress =
    taskNodes.length > 0
      ? completionPercent(doneTaskCount, taskNodes.length)
      : milestoneNodes.length > 0
        ? completionPercent(
            milestoneNodes.filter((node) => isDoneStatus(node.status)).length,
            milestoneNodes.length
          )
        : hasEntityHierarchy && workstreamNodes.length > 0
          ? completionPercent(
              workstreamNodes.filter((node) => isDoneStatus(node.status)).length,
              workstreamNodes.length
            )
          : null;
  const progress = clampPercent(
    computedProgress === null ? initiative.health : computedProgress
  );
  const progressFillPercent = progress === 0 ? 2 : progress;
  const dueBadge = formatDueBadge(initiative.targetDate);
  const dueBadgeClass =
    dueBadge.tone === 'danger'
      ? 'border-rose-400/35 bg-rose-500/10 text-rose-200'
      : dueBadge.tone === 'warning'
        ? 'border-amber-400/35 bg-amber-500/10 text-amber-200'
        : dueBadge.tone === 'success'
          ? 'border-emerald-400/35 bg-emerald-500/10 text-emerald-200'
          : 'border-white/[0.12] bg-white/[0.03] text-white/50';

  const openNodeModal = (node: MissionControlNode) => {
    if (node.type === 'initiative') {
      openModal({ type: 'initiative', entity: initiative });
      return;
    }
    if (node.type === 'workstream') {
      openModal({
        type: 'workstream',
        entity: toWorkstreamEntity(node, initiative),
        initiative,
      });
      return;
    }
    if (node.type === 'milestone') {
      openModal({
        type: 'milestone',
        entity: toMilestoneEntity(node, initiative),
        initiative,
      });
      return;
    }
    openModal({
      type: 'task',
      entity: toTaskEntity(node, initiative),
      initiative,
    });
  };

  const updateNode = async (
    node: MissionControlNode,
    updates: Record<string, unknown>
  ) => {
    await mutations.updateEntity.mutateAsync({
      type: node.type,
      id: node.id,
      ...updates,
    });
  };

  const handleAction = (action: string) => (event: React.MouseEvent) => {
    event.stopPropagation();
    mutations.entityAction.mutate({
      type: 'initiative',
      id: initiative.id,
      action,
    });
  };

  return (
    <div
      id={`initiative-${initiative.id}`}
      className={`surface-tier-1 overflow-hidden rounded-2xl transition-[background-color,border-color,box-shadow] duration-200 ${
        isExpanded ? 'bg-[--orgx-surface-elevated]' : 'bg-[--orgx-surface]'
      } ${selected ? 'ring-1 ring-[#BFFF00]/30 shadow-[0_0_0_1px_rgba(191,255,0,0.12)]' : ''}`}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onClick={() => toggleExpanded(initiative.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleExpanded(initiative.id);
          }
        }}
        className={`group flex w-full cursor-pointer items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-white/[0.035] ${
          isExpanded
            ? 'sticky z-30 border-b border-white/[0.06] bg-[#0C0E14]/95 backdrop-blur-xl'
            : ''
        }`}
        style={isExpanded ? { top: 'var(--mc-toolbar-offset, 88px)' } : undefined}
        >
          <motion.div
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ type: 'spring', stiffness: 400, damping: 25 }}
          className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-md transition-colors group-hover:bg-white/[0.06]"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="text-white/40"
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
          </motion.div>

        {onSelectionChange && (
          <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center">
            <input
              type="checkbox"
              checked={selected}
              onChange={(event) => onSelectionChange(initiative.id, event.currentTarget.checked)}
              onClick={(event) => event.stopPropagation()}
              aria-label={`Select initiative ${initiative.name}`}
              className="h-3.5 w-3.5 rounded border-white/20 bg-black/40 text-[#BFFF00] focus:ring-[#BFFF00]/35"
            />
          </div>
        )}

        {/* Breathing status dot */}
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${isExecutionActive ? 'status-breathe' : ''}`}
          style={{ backgroundColor: statusColor(effectiveInitiativeStatus) }}
        />

        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            openModal({ type: 'initiative', entity: initiative });
          }}
          className="min-w-0 flex-1 truncate text-left text-[14px] font-semibold text-white transition-colors hover:text-white/80"
          title={initiative.name}
        >
          {initiative.name}
        </button>

        <div className="flex w-[84px] flex-shrink-0 justify-center">
          <span
            className={`text-[10px] px-2 py-0.5 rounded-full border uppercase tracking-[0.08em] whitespace-nowrap ${initiativeStatusClass[effectiveInitiativeStatus]}`}
          >
            {formatEntityStatus(effectiveInitiativeStatus)}
          </span>
        </div>

        {executionBadge && (
          <div className="hidden w-[120px] flex-shrink-0 justify-center md:flex">
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full border tracking-[0.06em] whitespace-nowrap ${executionBadge.className}`}
              title="Execution state"
            >
              {executionBadge.label}
            </span>
          </div>
        )}

        <div className="hidden w-[116px] flex-shrink-0 justify-center md:flex">
          <span
            className={`inline-flex text-[10px] px-2 py-0.5 rounded-full border tracking-[0.06em] whitespace-nowrap ${dueBadgeClass}`}
            title={initiative.targetDate ? new Date(initiative.targetDate).toLocaleDateString() : 'No target date'}
          >
            {dueBadge.label}
          </span>
        </div>

        <div className="ml-2 flex min-w-[104px] items-center justify-end gap-1.5 sm:min-w-[220px] sm:gap-2">
          <div className="w-[92px] sm:w-[156px]">
            <div className="h-[2px] w-full overflow-hidden rounded-full bg-white/[0.06]">
              <motion.div
                className="h-full rounded-full transition-all"
                initial={false}
                animate={{
                  width: `${progressFillPercent}%`,
                  opacity: progress === 0 ? 0.45 : 1,
                }}
                transition={{ type: 'spring', stiffness: 260, damping: 34, mass: 0.75 }}
                style={{ backgroundColor: statusColor(effectiveInitiativeStatus) }}
              />
            </div>
          </div>
          <span className="w-8 text-right text-[10px] text-white/40 sm:w-10 sm:text-[11px]" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {progress}%
          </span>
        </div>

        <div className="ml-1 flex w-[64px] flex-shrink-0 items-center justify-end sm:w-[80px]">
          {agents.length > 0 ? (
            <InferredAgentAvatars agents={agents} max={5} />
          ) : (
            <span className="text-[10px] text-white/28">—</span>
          )}
        </div>

        {/* Quick actions */}
        <div className="flex w-[52px] flex-shrink-0 translate-x-1 items-center justify-end gap-1 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:translate-x-0 group-focus-within:opacity-100 sm:w-[58px]">
          {initiative.status === 'active' && (
            <button
              type="button"
              onClick={handleAction('pause')}
              title="Pause"
              className="flex items-center justify-center w-6 h-6 rounded-lg text-white/50 hover:text-white hover:bg-white/[0.08] transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
            </button>
          )}
          {initiative.status === 'paused' && (
            <button
              type="button"
              onClick={handleAction('resume')}
              title="Resume"
              className="flex items-center justify-center w-6 h-6 rounded-lg text-white/50 hover:text-white hover:bg-white/[0.08] transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            </button>
          )}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              openModal({ type: 'initiative', entity: initiative });
            }}
            title="Details"
            className="flex items-center justify-center w-6 h-6 rounded-lg text-white/50 hover:text-white hover:bg-white/[0.08] transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
          </button>
        </div>
      </div>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 35 }}
            className="overflow-hidden"
          >
            <div className="space-y-2.5 px-4 pb-4 pt-2.5">
              {/* Gradient divider instead of hard border */}
              <div className="section-divider" />

              {isLoading || (!hasPrimaryGraphData && isLegacyLoading) ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, index) => (
                    <Skeleton key={`mc-loading-${index}`} className="h-24 w-full rounded-xl" />
                  ))}
                </div>
              ) : (
                <motion.div
                  initial="hidden"
                  animate="show"
                  variants={{
                    hidden: {},
                    show: { transition: { staggerChildren: 0.08 } },
                }}
                  className="space-y-3.5"
                >
                  {warnings.length > 0 && (
                    <motion.div
                      variants={staggerItem}
                      className="overflow-hidden rounded-lg border border-amber-300/15 bg-amber-500/[0.06]"
                    >
                      <button
                        type="button"
                        onClick={() => setWarningsExpanded((prev) => !prev)}
                        className="flex w-full items-center justify-between px-3 py-2 text-left transition-colors hover:bg-white/[0.03]"
                      >
                        <span className="text-[11px] text-amber-100/85">
                          {warnings.length} data source{warnings.length > 1 ? 's' : ''} unavailable
                        </span>
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          className={`text-amber-100/55 transition-transform ${warningsExpanded ? 'rotate-180' : ''}`}
                        >
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </button>
                      <AnimatePresence>
                        {warningsExpanded && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.15 }}
                            className="overflow-hidden"
                          >
                            <div className="px-3 pb-2 space-y-1">
                              {warnings.map((w, i) => (
                                <div key={i} className="text-[10px] text-amber-100/72">
                                  {humanizeWarning(w)}
                                </div>
                              ))}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.div>
                  )}

                  {(todoTaskCount > 0 || activeTaskCount > 0 || totalExpectedDurationHours > 0 || totalExpectedBudgetUsd > 0) && (
                    <motion.div variants={staggerItem}>
                      <CollapsibleSection title="Stats" storageKey={`stats.${initiative.id}`} defaultOpen>
                        <div className="grid gap-2 py-0.5 sm:grid-cols-2 lg:grid-cols-4">
                          <MetricChip
                            label="Queue"
                            value={`${todoTaskCount} todo · ${activeTaskCount} active`}
                          />
                          <MetricChip
                            label="Completed"
                            value={`${doneTaskCount}/${taskNodes.length || 0}`}
                          />
                          <MetricChip
                            label="Duration"
                            value={`${totalExpectedDurationHours}h`}
                          />
                          <MetricChip
                            label="Budget"
                            value={`$${totalExpectedBudgetUsd.toLocaleString()}`}
                          />
                        </div>
                      </CollapsibleSection>
                    </motion.div>
                  )}

                  {focusedWorkstreamId && (
                    <div className="subsection-shell flex items-center justify-between rounded-lg px-3 py-2 text-[11px] text-[#D8FFA1]">
                      <span>
                        Focused on workstream {nodeById.get(focusedWorkstreamId)?.title ?? focusedWorkstreamId}
                      </span>
                      <button
                        type="button"
                        onClick={() => setFocusedWorkstreamId(null)}
                        className="text-[10px] underline underline-offset-2"
                      >
                        Clear focus
                      </button>
                    </div>
                  )}

                  <motion.div variants={staggerItem}>
                    <CollapsibleSection title="Dependency Map" storageKey={`depmap.${initiative.id}`} defaultOpen>
                      <DependencyMapPanel
                        nodes={nodes}
                        edges={edges}
                        selectedNodeId={selectedNodeId}
                        focusedWorkstreamId={focusedWorkstreamId}
                        onSelectNode={(nodeId) => {
                          setSelectedNodeId(nodeId);
                          const node = nodeById.get(nodeId);
                          if (node?.type === 'workstream') {
                            setFocusedWorkstreamId(node.id);
                          }
                        }}
                      />
                    </CollapsibleSection>
                  </motion.div>

                  {hasRecentTodos && (
                    <motion.div variants={staggerItem}>
                      <CollapsibleSection title="Next Up" storageKey={`nextup.${initiative.id}`} defaultOpen>
                        <RecentTodosRail
                          recentTodoIds={recentTodoIds}
                          nodesById={nodeById}
                          selectedNodeId={selectedNodeId}
                          onSelectNode={(nodeId) => {
                            setSelectedNodeId(nodeId);
                            const node = nodeById.get(nodeId);
                            if (node?.type === 'workstream') {
                              setFocusedWorkstreamId(node.id);
                            }
                          }}
                        />
                      </CollapsibleSection>
                    </motion.div>
                  )}

                  <motion.div variants={staggerItem}>
                    <CollapsibleSection
                      title="Hierarchy"
                      storageKey={`hierarchy.${initiative.id}`}
                      defaultOpen
                      sticky
                      stickyTop="calc(var(--mc-toolbar-offset, 88px) + 52px)"
                    >
                      <HierarchyTreeTable
                        nodes={nodes}
                        edges={edges}
                        selectedNodeId={selectedNodeId}
                        highlightedNodeIds={highlightedNodeIds}
                        editMode={editMode}
                        onSelectNode={setSelectedNodeId}
                        onFocusWorkstream={setFocusedWorkstreamId}
                        onOpenNode={openNodeModal}
                        onUpdateNode={updateNode}
                        onToggleEditMode={() => setEditMode((prev) => !prev)}
                        mutations={mutations}
                      />
                    </CollapsibleSection>
                  </motion.div>
                </motion.div>
              )}

              {/* Collapse hint at bottom */}
              <button
                type="button"
                onClick={() => toggleExpanded(initiative.id)}
                className="flex w-full items-center justify-center gap-1.5 py-1.5 text-[10px] text-white/35 transition-colors hover:text-white/65"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="m18 15-6-6-6 6" />
                </svg>
                Collapse
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
