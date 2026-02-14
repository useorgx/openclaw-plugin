import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { MissionControlEdge, MissionControlNode } from '@/types';
import { colors } from '@/lib/tokens';
import { formatEntityStatus, statusRank } from '@/lib/entityStatusColors';
import { completionPercent, isDoneStatus } from '@/lib/progress';
import { LevelIcon } from './LevelIcon';
import { DependencyEditorPopover } from './DependencyEditorPopover';
import { SearchInput } from '@/components/shared/SearchInput';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import type { useEntityMutations } from '@/hooks/useEntityMutations';
import { useNextUpQueueActions } from '@/hooks/useNextUpQueueActions';
import { useRangeSelection } from '@/hooks/useRangeSelection';
import { useMissionControl } from './MissionControlContext';

type EntityMutations = ReturnType<typeof useEntityMutations>;

interface HierarchyTreeTableProps {
  nodes: MissionControlNode[];
  edges: MissionControlEdge[];
  selectedNodeId: string | null;
  highlightedNodeIds: Set<string>;
  editMode: boolean;
  onToggleEditMode?: () => void;
  onSelectNode: (nodeId: string) => void;
  onFocusWorkstream: (workstreamId: string | null) => void;
  onOpenNode: (node: MissionControlNode) => void;
  onUpdateNode: (
    node: MissionControlNode,
    updates: Record<string, unknown>
  ) => Promise<void> | void;
  mutations?: EntityMutations;
}

type FlatRow = {
  node: MissionControlNode;
  depth: number;
  canCollapse: boolean;
};

type SortField = 'title' | 'status' | 'priority' | 'eta' | null;
type SortDir = 'asc' | 'desc';
type StatusScope = 'all' | 'open' | 'blocked' | 'done';

function toLocalInputValue(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

const STATUS_OPTIONS = ['not_started', 'planned', 'todo', 'in_progress', 'active', 'blocked', 'done'];

function statusTone(status: string): 'planned' | 'active' | 'blocked' | 'done' {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'blocked') return 'blocked';
  if (normalized === 'done' || normalized === 'completed') return 'done';
  if (normalized === 'in_progress' || normalized === 'active' || normalized === 'running' || normalized === 'queued') return 'active';
  return 'planned';
}

function normalizeStatusKey(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'completed') return 'done';
  if (normalized === 'running' || normalized === 'queued') return 'active';
  if (normalized === 'pending' || normalized === 'backlog') return 'todo';
  return normalized;
}

function matchesStatusScope(statusKey: string, scope: StatusScope): boolean {
  if (scope === 'all') return true;
  if (scope === 'blocked') return statusKey === 'blocked';
  if (scope === 'done') return statusKey === 'done';
  return statusKey !== 'blocked' && statusKey !== 'done';
}

function ancestorIds(nodeId: string, nodes: MissionControlNode[]): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ancestors = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = byId.get(id);
    if (!node) continue;
    if (node.parentId && !ancestors.has(node.parentId)) {
      ancestors.add(node.parentId);
      queue.push(node.parentId);
    }
    // Also include workstream/milestone parent chain
    if (node.workstreamId && !ancestors.has(node.workstreamId)) {
      ancestors.add(node.workstreamId);
      queue.push(node.workstreamId);
    }
    if (node.milestoneId && !ancestors.has(node.milestoneId)) {
      ancestors.add(node.milestoneId);
      queue.push(node.milestoneId);
    }
  }
  return ancestors;
}

function compareByField(a: MissionControlNode, b: MissionControlNode, field: SortField, dir: SortDir): number {
  let cmp = 0;
  if (field === 'title') {
    cmp = a.title.localeCompare(b.title);
  } else if (field === 'status') {
    cmp = statusRank(a.status) - statusRank(b.status);
  } else if (field === 'priority') {
    cmp = a.priorityNum - b.priorityNum;
  } else if (field === 'eta') {
    const aEta = a.etaEndAt ? Date.parse(a.etaEndAt) : Infinity;
    const bEta = b.etaEndAt ? Date.parse(b.etaEndAt) : Infinity;
    cmp = aEta - bEta;
  }
  return dir === 'desc' ? -cmp : cmp;
}

export function HierarchyTreeTable({
  nodes,
  edges,
  selectedNodeId,
  highlightedNodeIds,
  editMode,
  onToggleEditMode,
  onSelectNode,
  onFocusWorkstream,
  onOpenNode,
  onUpdateNode,
  mutations,
}: HierarchyTreeTableProps) {
  const { authToken, embedMode } = useMissionControl();
  const nextUpActions = useNextUpQueueActions({ authToken, embedMode });

  const [searchQuery, setSearchQuery] = useState('');
  const [activeStatusFilters, setActiveStatusFilters] = useState<Set<string>>(new Set());
  const [statusScope, setStatusScope] = useState<StatusScope>('all');
  const [showAdvancedStatusFilters, setShowAdvancedStatusFilters] = useState(false);
  const [sortField, setSortField] = useState<SortField>(null);
  const [sortDirection, setSortDirection] = useState<SortDir>('asc');
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkNotice, setBulkNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const hierarchyFilterRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!bulkNotice) return;
    const durationMs = bulkNotice.tone === 'success' ? 6500 : 9000;
    const timeout = window.setTimeout(() => setBulkNotice(null), durationMs);
    return () => window.clearTimeout(timeout);
  }, [bulkNotice?.message, bulkNotice?.tone]);

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const allNodeHints = useMemo(
    () => nodes.map((node) => ({ id: node.id, title: node.title })),
    [nodes]
  );

  const statusKeyCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      const key = normalizeStatusKey(node.status);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [nodes]);

  const statusScopeCounts = useMemo(() => {
    let open = 0;
    let blocked = 0;
    let done = 0;
    for (const node of nodes) {
      const key = normalizeStatusKey(node.status);
      if (key === 'blocked') blocked += 1;
      else if (key === 'done') done += 1;
      else open += 1;
    }
    return {
      all: nodes.length,
      open,
      blocked,
      done,
    };
  }, [nodes]);

  // Compute which nodes match search/filter, plus their ancestors
  const matchingNodeIds = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const hasQuery = query.length > 0;
    const hasStatusFilter = activeStatusFilters.size > 0;
    const hasScopeFilter = statusScope !== 'all';

    if (!hasQuery && !hasStatusFilter && !hasScopeFilter) return null; // null = show all

    const directMatches = new Set<string>();
    for (const node of nodes) {
      const normalizedStatus = normalizeStatusKey(node.status);
      const matchesQuery = !hasQuery || node.title.toLowerCase().includes(query) ||
        node.assignedAgents.some((a) => a.name.toLowerCase().includes(query));
      const matchesStatus = !hasStatusFilter || activeStatusFilters.has(normalizedStatus);
      const matchesScope = matchesStatusScope(normalizedStatus, statusScope);

      if (matchesQuery && matchesStatus && matchesScope) {
        directMatches.add(node.id);
      }
    }

    // Include all ancestors to preserve tree context
    const allVisible = new Set(directMatches);
    for (const id of directMatches) {
      for (const ancestorId of ancestorIds(id, nodes)) {
        allVisible.add(ancestorId);
      }
    }
    return allVisible;
  }, [activeStatusFilters, nodes, searchQuery, statusScope]);

  const workstreams = useMemo(
    () =>
      nodes
        .filter((node) => node.type === 'workstream')
        .sort((a, b) => a.priorityNum - b.priorityNum || a.title.localeCompare(b.title)),
    [nodes]
  );

  const milestonesByWorkstream = useMemo(() => {
    const map = new Map<string, MissionControlNode[]>();
    for (const milestone of nodes.filter((node) => node.type === 'milestone')) {
      const key = milestone.workstreamId ?? 'unscoped';
      const list = map.get(key) ?? [];
      list.push(milestone);
      map.set(key, list);
    }
    for (const value of map.values()) {
      value.sort((a, b) => a.priorityNum - b.priorityNum || a.title.localeCompare(b.title));
    }
    return map;
  }, [nodes]);

  const tasksByMilestone = useMemo(() => {
    const map = new Map<string, MissionControlNode[]>();
    for (const task of nodes.filter((node) => node.type === 'task' && node.milestoneId)) {
      const key = task.milestoneId ?? 'unscoped';
      const list = map.get(key) ?? [];
      list.push(task);
      map.set(key, list);
    }
    for (const value of map.values()) {
      value.sort((a, b) => a.priorityNum - b.priorityNum || a.title.localeCompare(b.title));
    }
    return map;
  }, [nodes]);

  const directTasksByWorkstream = useMemo(() => {
    const map = new Map<string, MissionControlNode[]>();
    for (const task of nodes.filter((node) => node.type === 'task' && !node.milestoneId)) {
      const key = task.workstreamId ?? 'unscoped';
      const list = map.get(key) ?? [];
      list.push(task);
      map.set(key, list);
    }
    for (const value of map.values()) {
      value.sort((a, b) => a.priorityNum - b.priorityNum || a.title.localeCompare(b.title));
    }
    return map;
  }, [nodes]);

  const defaultExpanded = useMemo(() => {
    const ids = new Set<string>();
    for (const ws of workstreams) ids.add(ws.id);
    for (const milestone of nodes.filter((node) => node.type === 'milestone')) ids.add(milestone.id);
    return ids;
  }, [nodes, workstreams]);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(defaultExpanded);

  useEffect(() => {
    setExpandedRows(defaultExpanded);
  }, [defaultExpanded]);

  const sortSiblings = (items: MissionControlNode[]): MissionControlNode[] => {
    if (!sortField) return items;
    return [...items].sort((a, b) => compareByField(a, b, sortField, sortDirection));
  };

  const rows = useMemo(() => {
    const flat: FlatRow[] = [];
    const isVisible = (id: string) => matchingNodeIds === null || matchingNodeIds.has(id);

    for (const ws of sortSiblings(workstreams)) {
      if (!isVisible(ws.id)) continue;
      const wsMilestones = sortSiblings(milestonesByWorkstream.get(ws.id) ?? []);
      const wsDirectTasks = sortSiblings(directTasksByWorkstream.get(ws.id) ?? []);
      const wsHasChildren = wsMilestones.length > 0 || wsDirectTasks.length > 0;
      flat.push({
        node: ws,
        depth: 0,
        canCollapse: wsHasChildren,
      });
      if (!expandedRows.has(ws.id)) continue;

      for (const milestone of wsMilestones) {
        if (!isVisible(milestone.id)) continue;
        const milestoneTasks = sortSiblings(tasksByMilestone.get(milestone.id) ?? []);
        flat.push({
          node: milestone,
          depth: 1,
          canCollapse: milestoneTasks.length > 0,
        });
        if (expandedRows.has(milestone.id)) {
          for (const task of milestoneTasks) {
            if (!isVisible(task.id)) continue;
            flat.push({ node: task, depth: 2, canCollapse: false });
          }
        }
      }

      for (const task of wsDirectTasks) {
        if (!isVisible(task.id)) continue;
        flat.push({
          node: task,
          depth: 1,
          canCollapse: false,
        });
      }
    }

    const unscopedMilestones = sortSiblings(milestonesByWorkstream.get('unscoped') ?? []);
    const unscopedTasks = sortSiblings(directTasksByWorkstream.get('unscoped') ?? []);
    for (const milestone of unscopedMilestones) {
      if (!isVisible(milestone.id)) continue;
      flat.push({
        node: milestone,
        depth: 0,
        canCollapse: (tasksByMilestone.get(milestone.id) ?? []).length > 0,
      });
      if (expandedRows.has(milestone.id)) {
        for (const task of sortSiblings(tasksByMilestone.get(milestone.id) ?? [])) {
          if (!isVisible(task.id)) continue;
          flat.push({ node: task, depth: 1, canCollapse: false });
        }
      }
    }
    for (const task of unscopedTasks) {
      if (!isVisible(task.id)) continue;
      flat.push({ node: task, depth: 0, canCollapse: false });
    }

    return flat;
  }, [
    directTasksByWorkstream,
    expandedRows,
    matchingNodeIds,
    milestonesByWorkstream,
    sortField,
    sortDirection,
    tasksByMilestone,
    workstreams,
  ]);

  const visibleRowIds = useMemo(() => rows.map(({ node }) => node.id), [rows]);
  const { handleSelect: handleRangeSelect } = useRangeSelection(visibleRowIds);
  const visibleRowIdSet = useMemo(() => new Set(visibleRowIds), [visibleRowIds]);
  const selectedRows = useMemo(
    () => rows.filter(({ node }) => selectedRowIds.has(node.id)),
    [rows, selectedRowIds]
  );
  const hierarchyFilterCount =
    (statusScope !== 'all' ? 1 : 0) + activeStatusFilters.size;
  const hasToolbarFilters =
    searchQuery.trim().length > 0 || statusScope !== 'all' || activeStatusFilters.size > 0;
  const selectedRowCount = selectedRows.length;
  const allVisibleSelected = rows.length > 0 && selectedRowCount === rows.length;
  const isBulkMutating = mutations?.bulkEntityMutation.isPending ?? false;

  useEffect(() => {
    setSelectedRowIds((previous) => {
      if (previous.size === 0) return previous;
      const next = new Set(Array.from(previous).filter((id) => visibleRowIdSet.has(id)));
      if (next.size === previous.size) return previous;
      return next;
    });
  }, [visibleRowIdSet]);

  useEffect(() => {
    if (!selectAllRef.current) return;
    selectAllRef.current.indeterminate = selectedRowCount > 0 && !allVisibleSelected;
  }, [allVisibleSelected, selectedRowCount]);

  useEffect(() => {
    if (selectedRowCount === 0 && confirmBulkDelete) {
      setConfirmBulkDelete(false);
    }
  }, [confirmBulkDelete, selectedRowCount]);

  useEffect(() => {
    if (!showAdvancedStatusFilters) return;

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (hierarchyFilterRef.current?.contains(target)) return;
      setShowAdvancedStatusFilters(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowAdvancedStatusFilters(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [showAdvancedStatusFilters]);

  const dependencyCount = (node: MissionControlNode) => node.dependencyIds.length;

  const addToNextUp = async (node: MissionControlNode) => {
    const initiativeId = node.initiativeId ?? '';
    const workstreamId =
      node.type === 'workstream' ? node.id : (node.workstreamId ?? '');
    const taskId = node.type === 'task' ? node.id : null;
    const milestoneId = node.type === 'milestone' ? node.id : null;

    if (!initiativeId || !workstreamId) {
      setBulkNotice({ tone: 'error', message: 'Cannot add to Next Up: missing initiative/workstream id.' });
      return;
    }

    try {
      await nextUpActions.pin({ initiativeId, workstreamId, taskId, milestoneId });
      setBulkNotice({
        tone: 'success',
        message:
          node.type === 'task'
            ? 'Pinned task workstream to Next Up.'
            : node.type === 'milestone'
              ? 'Pinned milestone workstream to Next Up.'
              : 'Pinned workstream to Next Up.',
      });
      window.setTimeout(() => setBulkNotice(null), 1800);
    } catch (err) {
      setBulkNotice({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Failed to pin to Next Up.',
      });
      window.setTimeout(() => setBulkNotice(null), 2400);
    }
  };

  const progressByNodeId = useMemo(() => {
    const map = new Map<string, number>();

    const progressFromTasks = (tasks: MissionControlNode[], fallbackStatus: string): number => {
      if (tasks.length > 0) {
        const doneCount = tasks.filter((task) => isDoneStatus(task.status)).length;
        return completionPercent(doneCount, tasks.length);
      }
      return isDoneStatus(fallbackStatus) ? 100 : 0;
    };

    for (const milestone of nodes.filter((node) => node.type === 'milestone')) {
      const tasks = tasksByMilestone.get(milestone.id) ?? [];
      map.set(milestone.id, progressFromTasks(tasks, milestone.status));
    }

    for (const ws of workstreams) {
      const wsMilestones = milestonesByWorkstream.get(ws.id) ?? [];
      const milestoneTasks = wsMilestones.flatMap(
        (milestone) => tasksByMilestone.get(milestone.id) ?? []
      );
      const directTasks = directTasksByWorkstream.get(ws.id) ?? [];
      map.set(ws.id, progressFromTasks([...directTasks, ...milestoneTasks], ws.status));
    }

    return map;
  }, [
    directTasksByWorkstream,
    milestonesByWorkstream,
    nodes,
    tasksByMilestone,
    workstreams,
  ]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const toggleStatusFilter = (status: string) => {
    setActiveStatusFilters((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  };

  const clearAllHierarchyFilters = () => {
    setSearchQuery('');
    setStatusScope('all');
    setActiveStatusFilters(new Set());
  };

  const toggleRowSelected = (nodeId: string, checked: boolean, shiftKey: boolean) => {
    setBulkNotice(null);
    setConfirmBulkDelete(false);
    handleRangeSelect(nodeId, checked, shiftKey, setSelectedRowIds);
  };

  const toggleSelectAllVisibleRows = () => {
    setBulkNotice(null);
    setConfirmBulkDelete(false);
    setSelectedRowIds(() => {
      if (rows.length === 0 || allVisibleSelected) return new Set();
      return new Set(visibleRowIds);
    });
  };

  const clearSelectedRows = () => {
    setConfirmBulkDelete(false);
    setSelectedRowIds(new Set());
  };

  const runBulkStatusUpdate = async (status: string) => {
    if (!mutations || selectedRows.length === 0) return;
    setConfirmBulkDelete(false);
    setBulkNotice(null);
    try {
      const result = await mutations.bulkEntityMutation.mutateAsync({
        items: selectedRows.map(({ node }) => ({
          type: node.type,
          id: node.id,
        })),
        mode: 'update',
        updates: { status },
      });

      if (result.failed > 0) {
        setBulkNotice({
          tone: 'error',
          message: `Updated ${result.updated}, failed ${result.failed}.`,
        });
      } else {
        setBulkNotice({
          tone: 'success',
          message: `Updated ${result.updated} item${result.updated === 1 ? '' : 's'} to ${formatEntityStatus(status)}.`,
        });
      }
    } catch (error) {
      setBulkNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Bulk status update failed.',
      });
    }
  };

  const runBulkDelete = async () => {
    if (!mutations || selectedRows.length === 0) return;
    setBulkNotice(null);
    try {
      const result = await mutations.bulkEntityMutation.mutateAsync({
        items: selectedRows.map(({ node }) => ({
          type: node.type,
          id: node.id,
        })),
        mode: 'delete',
      });

      if (result.failed > 0) {
        setBulkNotice({
          tone: 'error',
          message: `Deleted ${result.updated}, failed ${result.failed}.`,
        });
      } else {
        setBulkNotice({
          tone: 'success',
          message: `Deleted ${result.updated} item${result.updated === 1 ? '' : 's'}.`,
        });
        setSelectedRowIds(new Set());
        setConfirmBulkDelete(false);
      }
    } catch (error) {
      setBulkNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Bulk delete failed.',
      });
    }
  };

  const SortChevron = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <span className="text-faint ml-0.5">↕</span>;
    return <span className="text-[#BFFF00] ml-0.5">{sortDirection === 'asc' ? '↑' : '↓'}</span>;
  };

  // Only the table header should stick. The Hierarchy section header, search/filter row,
  // and bulk selection bar scroll normally with the table content.
  const tableHeaderStickyTop =
    'calc(var(--mc-toolbar-offset, 88px) + var(--mc-initiative-header-offset, 52px))';

  return (
    <section className="space-y-2.5">
      <div className="mb-3.5 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="w-full xl:max-w-[380px]">
          <SearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search items or agents..." />
        </div>
        <div className="flex min-h-[40px] min-w-0 flex-wrap items-center gap-2.5">
          {onToggleEditMode && (
            <button
              type="button"
              onClick={onToggleEditMode}
              data-state={editMode ? 'active' : 'idle'}
              className={`control-pill inline-flex h-8 items-center gap-1.5 px-3.5 text-caption font-semibold ${
                editMode ? 'text-[#D8FFA1]' : 'text-secondary hover:text-bright'
              }`}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
              </svg>
              {editMode ? 'Editing' : 'Edit'}
            </button>
          )}

          <div ref={hierarchyFilterRef} className="relative">
            <button
              type="button"
              onClick={() => setShowAdvancedStatusFilters((prev) => !prev)}
              data-state={showAdvancedStatusFilters || hierarchyFilterCount > 0 ? 'active' : 'idle'}
              className="control-pill flex items-center gap-1.5 px-3.5 text-caption font-semibold"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
              </svg>
              <span>Filters</span>
              {hierarchyFilterCount > 0 && (
                <span className="inline-flex min-w-[16px] items-center justify-center rounded-full border border-current/30 bg-black/25 px-1 text-micro leading-4">
                  {hierarchyFilterCount}
                </span>
              )}
            </button>
            <AnimatePresence>
              {showAdvancedStatusFilters && (
                <motion.div
                  initial={{ opacity: 0, y: -4, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.97 }}
                  transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                  className="surface-tier-2 absolute left-0 top-10 z-30 w-[360px] max-w-[86vw] rounded-xl p-3 shadow-[0_16px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl"
                >
                  <div className="mb-2">
                    <div className="text-micro font-semibold uppercase tracking-[0.08em] text-muted">Scope</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {([
                        { id: 'all', label: 'All', count: statusScopeCounts.all },
                        { id: 'open', label: 'Open', count: statusScopeCounts.open },
                        { id: 'blocked', label: 'Blocked', count: statusScopeCounts.blocked },
                        { id: 'done', label: 'Done', count: statusScopeCounts.done },
                      ] as Array<{ id: StatusScope; label: string; count: number }>).map((scope) => {
                        const active = statusScope === scope.id;
                        return (
                          <button
                            key={scope.id}
                            type="button"
                            onClick={() => setStatusScope(scope.id)}
                            className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-micro font-semibold transition-colors ${
                              active
                                ? 'border-[#BFFF00]/30 bg-[#BFFF00]/10 text-[#D8FFA1]'
                                : 'border-strong bg-white/[0.03] text-secondary hover:bg-white/[0.07] hover:text-white/82'
                            }`}
                          >
                            <span>{scope.label}</span>
                            <span className="text-micro text-current/80">{scope.count}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="mb-2 border-t border-white/[0.08] pt-2">
                    <div className="text-micro font-semibold uppercase tracking-[0.08em] text-muted">Status</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {STATUS_OPTIONS.map((status) => {
                        const isActive = activeStatusFilters.has(status);
                        const count = statusKeyCounts.get(status) ?? 0;
                        return (
                          <button
                            key={status}
                            type="button"
                            onClick={() => toggleStatusFilter(status)}
                            className={`inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-micro transition-colors ${
                              isActive
                                ? 'border-[#14B8A6]/35 bg-[#14B8A6]/12 text-[#8FF7EC]'
                                : 'border-strong bg-white/[0.03] text-white/58 hover:bg-white/[0.07] hover:text-bright'
                            }`}
                          >
                            <span>{formatEntityStatus(status)}</span>
                            <span className="text-micro text-current/75">{count}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {(statusScope !== 'all' || activeStatusFilters.size > 0) && (
                    <button
                      type="button"
                      onClick={() => {
                        setStatusScope('all');
                        setActiveStatusFilters(new Set());
                      }}
                      className="text-micro text-secondary transition-colors hover:text-primary"
                    >
                      Reset filters
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <AnimatePresence initial={false}>
            {hasToolbarFilters && (
              <motion.button
                key="hierarchy-clear-filters"
                type="button"
                onClick={clearAllHierarchyFilters}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -4 }}
                transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                className="control-pill inline-flex h-8 items-center px-2.5 text-caption font-medium text-primary hover:text-bright"
              >
                Clear
              </motion.button>
            )}
          </AnimatePresence>

          <button
            type="button"
            onClick={toggleSelectAllVisibleRows}
            data-state={allVisibleSelected ? 'active' : 'idle'}
            className="control-pill inline-flex h-8 items-center gap-1.5 px-3.5 text-caption font-semibold"
          >
            {allVisibleSelected ? 'Clear visible' : 'Select visible'}
          </button>
        </div>
      </div>

      <div className="mb-1.5">
        <div
          className={`rounded-xl border px-3 ${
            selectedRowCount > 0
              ? 'border-[#BFFF00]/24 bg-[#BFFF00]/[0.08]'
              : 'border-white/[0.08] bg-white/[0.02]'
          }`}
        >
          <div className="flex h-[48px] min-w-max flex-nowrap items-center gap-2 overflow-x-auto py-1 whitespace-nowrap">
            <label className="inline-flex flex-shrink-0 items-center gap-2 text-caption text-primary">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleSelectAllVisibleRows}
                className="h-3.5 w-3.5 rounded border-white/20 bg-black/40 text-[#BFFF00] focus:ring-[#BFFF00]/35"
              />
              Select all visible
            </label>
            <span className="flex-shrink-0 text-caption text-white/58">
              {selectedRowCount > 0 ? `${selectedRowCount} selected` : `${rows.length} visible`}
            </span>
            {selectedRowCount > 0 && (
              <div className="flex flex-shrink-0 items-center gap-2 whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => {
                    void runBulkStatusUpdate('planned');
                  }}
                  disabled={isBulkMutating}
                  className="control-pill h-8 flex-shrink-0 px-3 text-caption font-semibold disabled:opacity-45"
                >
                  Plan
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void runBulkStatusUpdate('in_progress');
                  }}
                  disabled={isBulkMutating}
                  className="control-pill h-8 flex-shrink-0 px-3 text-caption font-semibold disabled:opacity-45"
                  data-state="active"
                >
                  Start
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void runBulkStatusUpdate('blocked');
                  }}
                  disabled={isBulkMutating}
                  className="control-pill h-8 flex-shrink-0 px-3 text-caption font-semibold disabled:opacity-45"
                >
                  Block
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void runBulkStatusUpdate('done');
                  }}
                  disabled={isBulkMutating}
                  className="control-pill h-8 flex-shrink-0 px-3 text-caption font-semibold disabled:opacity-45"
                >
                  Complete
                </button>
                {confirmBulkDelete ? (
                  <div className="flex items-center gap-2">
                    <span className="text-micro text-white/58">Delete selected?</span>
                    <button
                      type="button"
                      onClick={() => {
                        void runBulkDelete();
                      }}
                      disabled={isBulkMutating}
                      className="control-pill h-8 flex-shrink-0 border-red-400/35 bg-red-500/14 px-3 text-caption font-semibold text-red-100 disabled:opacity-45"
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmBulkDelete(false)}
                      disabled={isBulkMutating}
                      className="control-pill h-8 flex-shrink-0 px-2.5 text-caption disabled:opacity-45"
                    >
                      Keep
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmBulkDelete(true)}
                    disabled={isBulkMutating}
                    className="control-pill h-8 flex-shrink-0 border-red-400/24 bg-red-500/[0.08] px-3 text-caption font-semibold text-red-100/85 disabled:opacity-45"
                  >
                    Delete
                  </button>
                )}
                <button
                  type="button"
                  onClick={clearSelectedRows}
                  disabled={isBulkMutating}
                  className="text-caption text-secondary transition-colors hover:text-primary disabled:opacity-45"
                >
                  Clear
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {bulkNotice && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-caption text-white/72"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2">
              <span
                aria-hidden
                className={`mt-[3px] h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                  bulkNotice.tone === 'success' ? 'bg-emerald-300/90' : 'bg-amber-300/90'
                }`}
              />
              <span className="min-w-0 leading-snug">{bulkNotice.message}</span>
            </div>
            <button
              type="button"
              onClick={() => setBulkNotice(null)}
              className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-white/[0.06] hover:text-primary"
              aria-label="Dismiss notice"
              title="Dismiss"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {editMode && (
        <div className="mb-2 text-micro text-secondary">
          Edit mode: select a row to edit its fields inline.
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-white/[0.07] bg-black/[0.14] p-2">
        <table className="w-full min-w-[1180px] border-separate border-spacing-y-1.5">
          <thead>
            <tr className="text-left text-micro uppercase tracking-[0.08em] text-muted">
              <th
                className="w-10 px-2 py-1.5 sticky z-10 bg-[#090B11]/92 backdrop-blur-xl border-b border-subtle"
                style={{ top: tableHeaderStickyTop }}
              >
                <span className="sr-only">Select rows</span>
              </th>
              <th
                className="px-2 py-1.5 cursor-pointer select-none sticky z-10 bg-[#090B11]/92 backdrop-blur-xl border-b border-subtle"
                style={{ top: tableHeaderStickyTop }}
                onClick={() => toggleSort('title')}
              >
                Item <SortChevron field="title" />
              </th>
              <th
                className="w-[188px] px-2 py-1.5 sticky z-10 bg-[#090B11]/92 backdrop-blur-xl border-b border-subtle"
                style={{ top: tableHeaderStickyTop }}
              >
                Assigned
              </th>
              <th
                className="px-2 py-1.5 cursor-pointer select-none sticky z-10 bg-[#090B11]/92 backdrop-blur-xl border-b border-subtle"
                style={{ top: tableHeaderStickyTop }}
                onClick={() => toggleSort('status')}
              >
                Status <SortChevron field="status" />
              </th>
              <th
                className="px-2 py-1.5 sticky z-10 bg-[#090B11]/92 backdrop-blur-xl border-b border-subtle"
                style={{ top: tableHeaderStickyTop }}
              >
                Progress
              </th>
              <th
                className="px-2 py-1.5 cursor-pointer select-none sticky z-10 bg-[#090B11]/92 backdrop-blur-xl border-b border-subtle"
                style={{ top: tableHeaderStickyTop }}
                onClick={() => toggleSort('priority')}
              >
                Priority <SortChevron field="priority" />
              </th>
              <th
                className="px-2 py-1.5 cursor-pointer select-none sticky z-10 bg-[#090B11]/92 backdrop-blur-xl border-b border-subtle"
                style={{ top: tableHeaderStickyTop }}
                onClick={() => toggleSort('eta')}
              >
                ETA <SortChevron field="eta" />
              </th>
              <th
                className="px-2 py-1.5 sticky z-10 bg-[#090B11]/92 backdrop-blur-xl border-b border-subtle"
                style={{ top: tableHeaderStickyTop }}
              >
                Duration (h)
              </th>
              <th
                className="px-2 py-1.5 sticky z-10 bg-[#090B11]/92 backdrop-blur-xl border-b border-subtle"
                style={{ top: tableHeaderStickyTop }}
              >
                Budget ($)
              </th>
              <th
                className="px-2 py-1.5 sticky z-10 bg-[#090B11]/92 backdrop-blur-xl border-b border-subtle"
                style={{ top: tableHeaderStickyTop }}
              >
                Dependencies
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ node, depth, canCollapse }) => {
              const selected = selectedNodeId === node.id;
              const highlighted = highlightedNodeIds.has(node.id);
              const isSelectedForBulk = selectedRowIds.has(node.id);
              const assignedNames = node.assignedAgents.map((agent) => agent.name).join(', ');
              const dependencyLabels = node.dependencyIds
                .map((id) => nodeById.get(id)?.title ?? id)
                .slice(0, 3)
                .join(', ');
              const completion = progressByNodeId.get(node.id);
              const editableRow = editMode && selected;

              return (
                <tr
                  key={node.id}
                  onClick={() => {
                    onSelectNode(node.id);
                    if (node.type === 'workstream') {
                      onFocusWorkstream(node.id);
                    }
                  }}
                  className={`group/row cursor-pointer rounded-lg border transition-colors ${
                    selected
                      ? 'border-[#BFFF00]/[0.22] bg-[#BFFF00]/[0.08]'
                      : highlighted
                        ? 'border-[#14B8A6]/[0.2] bg-[#14B8A6]/[0.08]'
                        : 'border-subtle bg-white/[0.02] hover:border-strong hover:bg-white/[0.05]'
                  }`}
                >
                  <td className="rounded-l-lg px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={isSelectedForBulk}
                      onChange={(event) => {
                        event.stopPropagation();
                        const shiftKey = (event.nativeEvent as MouseEvent).shiftKey ?? false;
                        toggleRowSelected(node.id, event.currentTarget.checked, shiftKey);
                      }}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`Select ${node.type}: ${node.title}`}
                      className="h-3.5 w-3.5 rounded border-white/20 bg-black/40 text-[#BFFF00] focus:ring-[#BFFF00]/35"
                    />
                  </td>
                  {/* Item */}
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <div style={{ width: depth * 14 }} />
                      {canCollapse ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setExpandedRows((prev) => {
                              const next = new Set(prev);
                              if (next.has(node.id)) next.delete(node.id);
                              else next.add(node.id);
                              return next;
                            });
                          }}
                          aria-label={`${expandedRows.has(node.id) ? 'Collapse' : 'Expand'} ${node.type}: ${node.title}`}
                          className="rounded text-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-[#BFFF00]/35 focus-visible:ring-offset-2 focus-visible:ring-offset-[#02040A]"
                        >
                          {expandedRows.has(node.id) ? '▾' : '▸'}
                        </button>
                      ) : (
                        <span className="w-2.5" />
                      )}
                      <LevelIcon type={node.type} />
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenNode(node);
                        }}
                        aria-label={`Open ${node.type} details: ${node.title}`}
                        className="max-w-[320px] truncate rounded text-body text-bright hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#BFFF00]/35 focus-visible:ring-offset-2 focus-visible:ring-offset-[#02040A]"
                      >
                        {node.title}
                      </button>

                      {/* Quick actions — hover revealed */}
                      {!editMode && (node.type === 'workstream' || node.type === 'milestone' || node.type === 'task') && (
                        <div className="flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity ml-1">
                          {node.type === 'task' && mutations ? (
                            <>
                              {['not_started', 'todo', 'planned', 'pending', 'backlog'].includes(node.status.toLowerCase()) ? (
                                <button
                                  type="button"
                                  title="Start"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void onUpdateNode(node, { status: 'in_progress' });
                                  }}
                                  aria-label={`Start task: ${node.title}`}
                                  className="flex items-center justify-center w-5 h-5 rounded text-muted transition-colors hover:text-[#BFFF00] hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#BFFF00]/35 focus-visible:ring-offset-2 focus-visible:ring-offset-[#02040A]"
                                >
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                                </button>
                              ) : ['in_progress', 'active'].includes(node.status.toLowerCase()) ? (
                                <button
                                  type="button"
                                  title="Mark done"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void onUpdateNode(node, { status: 'done' });
                                  }}
                                  aria-label={`Mark task done: ${node.title}`}
                                  className="flex items-center justify-center w-5 h-5 rounded text-muted transition-colors hover:text-emerald-400 hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#BFFF00]/35 focus-visible:ring-offset-2 focus-visible:ring-offset-[#02040A]"
                                >
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6 9 17l-5-5" /></svg>
                                </button>
                              ) : null}
                            </>
                          ) : null}

                          <button
                            type="button"
                            title="Add to Next Up"
                            onClick={(event) => {
                              event.stopPropagation();
                              void addToNextUp(node);
                            }}
                            aria-label={`Add to Next Up: ${node.type} ${node.title}`}
                            className="flex items-center justify-center w-5 h-5 rounded text-muted transition-colors hover:text-[#BFFF00] hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#BFFF00]/35 focus-visible:ring-offset-2 focus-visible:ring-offset-[#02040A]"
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round">
                              <path d="M12 5v14" />
                              <path d="M5 12h14" />
                            </svg>
                          </button>
                        </div>
                      )}
                    </div>
                  </td>

                  {/* Assigned (moved to position 2) */}
                  <td className="px-2 py-1.5 text-caption text-primary whitespace-nowrap">
                    {editableRow ? (
                      <input
                        type="text"
                        defaultValue={assignedNames}
                        placeholder="Agent A, Agent B"
                        onClick={(event) => event.stopPropagation()}
                        onBlur={(event) => {
                          const names = event.currentTarget.value
                            .split(',')
                            .map((item) => item.trim())
                            .filter(Boolean);
                          void onUpdateNode(node, {
                            assigned_agent_names: names,
                            assigned_agent_ids: names.map((name) => `name:${name}`),
                            assignment_source: 'manual',
                          });
                        }}
                        className="w-[190px] rounded border border-strong bg-white/[0.06] px-2 py-1 text-micro text-white/82"
                      />
                    ) : (
                      <div className="flex items-center gap-2">
                        {node.assignedAgents.length > 0 ? (
                          <>
                            <div className="flex items-center -space-x-1.5">
                              {node.assignedAgents.slice(0, 3).map((agent) => (
                                <div
                                  key={`${node.id}:${agent.id}`}
                                  title={agent.name}
                                  className="rounded-full ring-1 ring-[#02040A]"
                                >
                                  <AgentAvatar
                                    name={agent.name}
                                    hint={`${agent.id} ${node.title}`}
                                    size="xs"
                                  />
                                </div>
                              ))}
                            </div>
                            <span
                              className="max-w-[110px] truncate text-micro text-white/62"
                              title={assignedNames}
                            >
                              {node.assignedAgents[0]?.name}
                              {node.assignedAgents.length > 1
                                ? ` +${node.assignedAgents.length - 1}`
                                : ''}
                            </span>
                          </>
                        ) : (
                          <span className="text-muted">Unassigned</span>
                        )}
                      </div>
                    )}
                  </td>

                  {/* Status */}
                  <td className="px-2 py-1.5 text-caption text-primary">
                    {editableRow ? (
                      <select
                        defaultValue={normalizeStatusKey(node.status)}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => {
                          void onUpdateNode(node, { status: event.target.value });
                        }}
                        className="rounded border border-strong bg-white/[0.06] px-2 py-1 text-micro text-white/82"
                      >
                        {STATUS_OPTIONS.map((status) => (
                          <option key={status} value={status}>
                            {formatEntityStatus(status)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="status-pill whitespace-nowrap" data-tone={statusTone(node.status)}>
                        {formatEntityStatus(node.status)}
                      </span>
                    )}
                  </td>

                  {/* Progress */}
                  <td className="px-2 py-1.5 text-caption text-primary">
                    {completion !== undefined && (node.type === 'workstream' || node.type === 'milestone') ? (
                      <div className="flex items-center gap-2">
                        <div className="h-1 w-[72px] rounded-full bg-white/[0.06] overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${completion}%`,
                              backgroundColor: node.type === 'milestone' ? colors.teal : colors.lime,
                            }}
                          />
                        </div>
                        <span className="text-micro text-secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {completion}%
                        </span>
                      </div>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>

                  {/* Priority */}
                  <td className="px-2 py-1.5 text-caption text-primary">
                    {editableRow ? (
                      <input
                        type="number"
                        min={1}
                        max={100}
                        defaultValue={node.priorityNum}
                        onClick={(event) => event.stopPropagation()}
                        onBlur={(event) => {
                          const next = Number(event.currentTarget.value);
                          if (Number.isFinite(next)) {
                            void onUpdateNode(node, { priority_num: next });
                          }
                        }}
                        className="w-[72px] rounded border border-strong bg-white/[0.06] px-2 py-1 text-micro text-white/82"
                      />
                    ) : (
                      <span>P{node.priorityNum}</span>
                    )}
                  </td>

                  {/* ETA */}
                  <td className="px-2 py-1.5 text-caption text-primary">
                    {editableRow ? (
                      <input
                        type="datetime-local"
                        defaultValue={toLocalInputValue(node.etaEndAt)}
                        onClick={(event) => event.stopPropagation()}
                        onBlur={(event) => {
                          const value = event.currentTarget.value;
                          void onUpdateNode(node, { eta_end_at: value ? new Date(value).toISOString() : null });
                        }}
                        className="w-[176px] rounded border border-strong bg-white/[0.06] px-2 py-1 text-micro text-white/82"
                      />
                    ) : (
                      <span>{node.etaEndAt ? new Date(node.etaEndAt).toLocaleString() : '—'}</span>
                    )}
                  </td>

                  {/* Duration */}
                  <td className="px-2 py-1.5 text-caption text-primary">
                    {editableRow && node.type !== 'task' ? (
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        defaultValue={node.expectedDurationHours}
                        onClick={(event) => event.stopPropagation()}
                        onBlur={(event) => {
                          const value = Number(event.currentTarget.value);
                          if (Number.isFinite(value)) {
                            void onUpdateNode(node, { expected_duration_hours: value });
                          }
                        }}
                        className="w-[82px] rounded border border-strong bg-white/[0.06] px-2 py-1 text-micro text-white/82"
                      />
                    ) : (
                      <span>{node.expectedDurationHours}</span>
                    )}
                  </td>

                  {/* Budget */}
                  <td className="px-2 py-1.5 text-caption text-primary">
                    {editableRow && node.type !== 'task' ? (
                      <input
                        type="number"
                        min={0}
                        step={1}
                        defaultValue={node.expectedBudgetUsd}
                        onClick={(event) => event.stopPropagation()}
                        onBlur={(event) => {
                          const value = Number(event.currentTarget.value);
                          if (Number.isFinite(value)) {
                            void onUpdateNode(node, { expected_budget_usd: value });
                          }
                        }}
                        className="w-[92px] rounded border border-strong bg-white/[0.06] px-2 py-1 text-micro text-white/82"
                      />
                    ) : (
                      <span>
                        ${node.expectedBudgetUsd.toLocaleString()}
                        {editableRow && node.type === 'task' ? ' (from task spec)' : ''}
                      </span>
                    )}
                  </td>

                  {/* Dependencies */}
                  <td className="rounded-r-lg px-2 py-1.5 text-caption text-primary">
                    {editableRow ? (
                      <div onClick={(event) => event.stopPropagation()}>
                        <DependencyEditorPopover
                          dependencies={node.dependencyIds}
                          allNodes={allNodeHints}
                          onSave={(nextDependencyIds) =>
                            void onUpdateNode(node, { depends_on: nextDependencyIds })
                          }
                        />
                      </div>
                    ) : (
                      <div className="max-w-[250px] truncate">
                        {dependencyCount(node) > 0
                          ? `${dependencyCount(node)} · ${dependencyLabels}`
                          : '—'}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && (
        <div className="flex flex-col items-center py-10">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-faint">
            <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
            <rect x="9" y="3" width="6" height="4" rx="1" />
            <path d="M9 14h6M9 18h4" />
          </svg>
          <div className="mt-3 text-body font-medium text-secondary">
            {searchQuery || activeStatusFilters.size > 0 || statusScope !== 'all'
              ? 'No items match the current filters'
              : 'No work items yet'}
          </div>
          <div className="mt-1 text-caption text-muted">
            {searchQuery || activeStatusFilters.size > 0 || statusScope !== 'all'
              ? 'Try adjusting your search or filter criteria.'
              : 'Workstreams, milestones, and tasks will appear here.'}
          </div>
        </div>
      )}
    </section>
  );
}
