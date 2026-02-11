import { useEffect, useMemo, useState } from 'react';
import type { MissionControlEdge, MissionControlNode } from '@/types';
import { colors } from '@/lib/tokens';
import { formatEntityStatus, statusRank } from '@/lib/entityStatusColors';
import { completionPercent, isDoneStatus } from '@/lib/progress';
import { LevelIcon } from './LevelIcon';
import { DependencyEditorPopover } from './DependencyEditorPopover';
import { SearchInput } from '@/components/shared/SearchInput';
import type { useEntityMutations } from '@/hooks/useEntityMutations';

type EntityMutations = ReturnType<typeof useEntityMutations>;

interface HierarchyTreeTableProps {
  nodes: MissionControlNode[];
  edges: MissionControlEdge[];
  selectedNodeId: string | null;
  highlightedNodeIds: Set<string>;
  editMode: boolean;
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
  onSelectNode,
  onFocusWorkstream,
  onOpenNode,
  onUpdateNode,
  mutations,
}: HierarchyTreeTableProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeStatusFilters, setActiveStatusFilters] = useState<Set<string>>(new Set());
  const [sortField, setSortField] = useState<SortField>(null);
  const [sortDirection, setSortDirection] = useState<SortDir>('asc');

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const allNodeHints = useMemo(
    () => nodes.map((node) => ({ id: node.id, title: node.title })),
    [nodes]
  );

  // Compute which nodes match search/filter, plus their ancestors
  const matchingNodeIds = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const hasQuery = query.length > 0;
    const hasStatusFilter = activeStatusFilters.size > 0;

    if (!hasQuery && !hasStatusFilter) return null; // null = show all

    const directMatches = new Set<string>();
    for (const node of nodes) {
      const matchesQuery = !hasQuery || node.title.toLowerCase().includes(query) ||
        node.assignedAgents.some((a) => a.name.toLowerCase().includes(query));
      const matchesStatus = !hasStatusFilter || activeStatusFilters.has(normalizeStatusKey(node.status));

      if (matchesQuery && matchesStatus) {
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
  }, [nodes, searchQuery, activeStatusFilters]);

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

  const dependencyCount = (node: MissionControlNode) => node.dependencyIds.length;

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

  const SortChevron = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <span className="text-white/20 ml-0.5">↕</span>;
    return <span className="text-[#BFFF00] ml-0.5">{sortDirection === 'asc' ? '↑' : '↓'}</span>;
  };

  return (
    <section className="surface-tier-1 rounded-xl p-3">
      <div className="mb-2 text-[13px] font-semibold tracking-[-0.01em] text-white/82">
        Hierarchy
      </div>

      {/* Search */}
      <div className="mb-2 max-w-[320px]">
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search items or agents..."
        />
      </div>

      {/* Status filter chips */}
      <div className="mb-2 flex flex-wrap gap-1.5">
        {STATUS_OPTIONS.map((status) => {
          const isActive = activeStatusFilters.has(status);
          return (
            <button
              key={status}
              type="button"
              onClick={() => toggleStatusFilter(status)}
              data-state={isActive ? 'active' : 'idle'}
              className="control-pill h-7 rounded-full px-2.5 text-[10px] font-semibold"
            >
              {formatEntityStatus(status)}
            </button>
          );
        })}
        {activeStatusFilters.size > 0 && (
          <button
            type="button"
            onClick={() => setActiveStatusFilters(new Set())}
            className="rounded-full px-2 py-1 text-[10px] text-white/40 hover:text-white/70 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {editMode && (
        <div className="mb-2 text-[10px] text-white/45">
          Edit mode: select a row to edit its fields inline.
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1180px] border-separate border-spacing-y-1.5">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-white/42">
              <th className="px-2 py-1.5 cursor-pointer select-none" onClick={() => toggleSort('title')}>
                Item <SortChevron field="title" />
              </th>
              <th className="px-2 py-1.5">Assigned</th>
              <th className="px-2 py-1.5 cursor-pointer select-none" onClick={() => toggleSort('status')}>
                Status <SortChevron field="status" />
              </th>
              <th className="px-2 py-1.5">Progress</th>
              <th className="px-2 py-1.5 cursor-pointer select-none" onClick={() => toggleSort('priority')}>
                Priority <SortChevron field="priority" />
              </th>
              <th className="px-2 py-1.5 cursor-pointer select-none" onClick={() => toggleSort('eta')}>
                ETA <SortChevron field="eta" />
              </th>
              <th className="px-2 py-1.5">Duration (h)</th>
              <th className="px-2 py-1.5">Budget ($)</th>
              <th className="px-2 py-1.5">Dependencies</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ node, depth, canCollapse }) => {
              const selected = selectedNodeId === node.id;
              const highlighted = highlightedNodeIds.has(node.id);
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
                        : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.14] hover:bg-white/[0.05]'
                  }`}
                >
                  {/* Item */}
                  <td className="rounded-l-lg px-2 py-1.5">
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
                          className="rounded text-white/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#BFFF00]/35 focus-visible:ring-offset-2 focus-visible:ring-offset-[#02040A]"
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
                        className="max-w-[320px] truncate rounded text-[12px] text-white/88 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#BFFF00]/35 focus-visible:ring-offset-2 focus-visible:ring-offset-[#02040A]"
                      >
                        {node.title}
                      </button>

                      {/* Quick actions — hover revealed */}
                      {node.type === 'task' && mutations && !editMode && (
                        <div className="flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity ml-1">
                          {['not_started', 'todo', 'planned', 'pending', 'backlog'].includes(node.status.toLowerCase()) ? (
                            <button
                              type="button"
                              title="Start"
                              onClick={(event) => {
                                event.stopPropagation();
                                void onUpdateNode(node, { status: 'in_progress' });
                              }}
                              aria-label={`Start task: ${node.title}`}
                              className="flex items-center justify-center w-5 h-5 rounded text-white/40 transition-colors hover:text-[#BFFF00] hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#BFFF00]/35 focus-visible:ring-offset-2 focus-visible:ring-offset-[#02040A]"
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
                              className="flex items-center justify-center w-5 h-5 rounded text-white/40 transition-colors hover:text-emerald-400 hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#BFFF00]/35 focus-visible:ring-offset-2 focus-visible:ring-offset-[#02040A]"
                            >
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6 9 17l-5-5" /></svg>
                            </button>
                          ) : null}
                        </div>
                      )}
                    </div>
                  </td>

                  {/* Assigned (moved to position 2) */}
                  <td className="px-2 py-1.5 text-[11px] text-white/75">
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
                        className="w-[190px] rounded border border-white/[0.16] bg-white/[0.06] px-2 py-1 text-[10px] text-white/82"
                      />
                    ) : (
                      <div className="flex items-center gap-1.5">
                        {node.assignedAgents.length > 0 ? (
                          node.assignedAgents.slice(0, 3).map((agent) => (
                            <span
                              key={`${node.id}:${agent.id}`}
                              className="rounded-full border border-white/[0.12] bg-white/[0.04] px-2 py-0.5 text-[10px] text-white/70"
                            >
                              {agent.name}
                            </span>
                          ))
                        ) : (
                          <span className="text-white/35">Unassigned</span>
                        )}
                        {node.assignedAgents.length > 3 && (
                          <span className="text-[10px] text-white/45">
                            +{node.assignedAgents.length - 3}
                          </span>
                        )}
                      </div>
                    )}
                  </td>

                  {/* Status */}
                  <td className="px-2 py-1.5 text-[11px] text-white/75">
                    {editableRow ? (
                      <select
                        defaultValue={normalizeStatusKey(node.status)}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => {
                          void onUpdateNode(node, { status: event.target.value });
                        }}
                        className="rounded border border-white/[0.16] bg-white/[0.06] px-2 py-1 text-[10px] text-white/82"
                      >
                        {STATUS_OPTIONS.map((status) => (
                          <option key={status} value={status}>
                            {formatEntityStatus(status)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="status-pill" data-tone={statusTone(node.status)}>
                        {formatEntityStatus(node.status)}
                      </span>
                    )}
                  </td>

                  {/* Progress */}
                  <td className="px-2 py-1.5 text-[11px] text-white/75">
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
                        <span className="text-[10px] text-white/60" style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {completion}%
                        </span>
                      </div>
                    ) : (
                      <span className="text-white/35">—</span>
                    )}
                  </td>

                  {/* Priority */}
                  <td className="px-2 py-1.5 text-[11px] text-white/75">
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
                        className="w-[72px] rounded border border-white/[0.16] bg-white/[0.06] px-2 py-1 text-[10px] text-white/82"
                      />
                    ) : (
                      <span>P{node.priorityNum}</span>
                    )}
                  </td>

                  {/* ETA */}
                  <td className="px-2 py-1.5 text-[11px] text-white/75">
                    {editableRow ? (
                      <input
                        type="datetime-local"
                        defaultValue={toLocalInputValue(node.etaEndAt)}
                        onClick={(event) => event.stopPropagation()}
                        onBlur={(event) => {
                          const value = event.currentTarget.value;
                          void onUpdateNode(node, { eta_end_at: value ? new Date(value).toISOString() : null });
                        }}
                        className="w-[176px] rounded border border-white/[0.16] bg-white/[0.06] px-2 py-1 text-[10px] text-white/82"
                      />
                    ) : (
                      <span>{node.etaEndAt ? new Date(node.etaEndAt).toLocaleString() : '—'}</span>
                    )}
                  </td>

                  {/* Duration */}
                  <td className="px-2 py-1.5 text-[11px] text-white/75">
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
                        className="w-[82px] rounded border border-white/[0.16] bg-white/[0.06] px-2 py-1 text-[10px] text-white/82"
                      />
                    ) : (
                      <span>{node.expectedDurationHours}</span>
                    )}
                  </td>

                  {/* Budget */}
                  <td className="px-2 py-1.5 text-[11px] text-white/75">
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
                        className="w-[92px] rounded border border-white/[0.16] bg-white/[0.06] px-2 py-1 text-[10px] text-white/82"
                      />
                    ) : (
                      <span>
                        ${node.expectedBudgetUsd.toLocaleString()}
                        {editableRow && node.type === 'task' ? ' (from task spec)' : ''}
                      </span>
                    )}
                  </td>

                  {/* Dependencies */}
                  <td className="rounded-r-lg px-2 py-1.5 text-[11px] text-white/75">
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
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-white/20">
            <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
            <rect x="9" y="3" width="6" height="4" rx="1" />
            <path d="M9 14h6M9 18h4" />
          </svg>
          <div className="mt-3 text-[13px] font-medium text-white/50">
            {searchQuery || activeStatusFilters.size > 0
              ? 'No items match the current filters'
              : 'No work items yet'}
          </div>
          <div className="mt-1 text-[11px] text-white/30">
            {searchQuery || activeStatusFilters.size > 0
              ? 'Try adjusting your search or filter criteria.'
              : 'Workstreams, milestones, and tasks will appear here.'}
          </div>
        </div>
      )}
    </section>
  );
}
