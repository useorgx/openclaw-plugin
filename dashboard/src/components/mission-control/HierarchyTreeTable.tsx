import { useEffect, useMemo, useState } from 'react';
import type { MissionControlEdge, MissionControlNode } from '@/types';
import { colors } from '@/lib/tokens';
import { formatEntityStatus } from '@/lib/entityStatusColors';
import { LevelIcon } from './LevelIcon';
import { DependencyEditorPopover } from './DependencyEditorPopover';
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
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const allNodeHints = useMemo(
    () => nodes.map((node) => ({ id: node.id, title: node.title })),
    [nodes]
  );

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

  const rows = useMemo(() => {
    const flat: FlatRow[] = [];
    for (const ws of workstreams) {
      const wsMilestones = milestonesByWorkstream.get(ws.id) ?? [];
      const wsDirectTasks = directTasksByWorkstream.get(ws.id) ?? [];
      const wsHasChildren = wsMilestones.length > 0 || wsDirectTasks.length > 0;
      flat.push({
        node: ws,
        depth: 0,
        canCollapse: wsHasChildren,
      });
      if (!expandedRows.has(ws.id)) continue;

      for (const milestone of wsMilestones) {
        const milestoneTasks = tasksByMilestone.get(milestone.id) ?? [];
        flat.push({
          node: milestone,
          depth: 1,
          canCollapse: milestoneTasks.length > 0,
        });
        if (expandedRows.has(milestone.id)) {
          for (const task of milestoneTasks) {
            flat.push({ node: task, depth: 2, canCollapse: false });
          }
        }
      }

      for (const task of wsDirectTasks) {
        flat.push({
          node: task,
          depth: 1,
          canCollapse: false,
        });
      }
    }

    const unscopedMilestones = milestonesByWorkstream.get('unscoped') ?? [];
    const unscopedTasks = directTasksByWorkstream.get('unscoped') ?? [];
    for (const milestone of unscopedMilestones) {
      flat.push({
        node: milestone,
        depth: 0,
        canCollapse: (tasksByMilestone.get(milestone.id) ?? []).length > 0,
      });
      if (expandedRows.has(milestone.id)) {
        for (const task of tasksByMilestone.get(milestone.id) ?? []) {
          flat.push({ node: task, depth: 1, canCollapse: false });
        }
      }
    }
    for (const task of unscopedTasks) {
      flat.push({ node: task, depth: 0, canCollapse: false });
    }

    return flat;
  }, [
    directTasksByWorkstream,
    expandedRows,
    milestonesByWorkstream,
    tasksByMilestone,
    workstreams,
  ]);

  const dependencyCount = (node: MissionControlNode) => node.dependencyIds.length;

  return (
    <section className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
      <div className="mb-2 text-[11px] uppercase tracking-[0.08em] text-white/45">
        Hierarchy table
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1080px] border-separate border-spacing-y-1.5">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-white/35">
              <th className="px-2 py-1.5">Item</th>
              <th className="px-2 py-1.5">Status</th>
              <th className="px-2 py-1.5">Priority</th>
              <th className="px-2 py-1.5">ETA</th>
              <th className="px-2 py-1.5">Duration (h)</th>
              <th className="px-2 py-1.5">Dependencies</th>
              <th className="px-2 py-1.5">Assigned</th>
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
                      ? 'bg-[#BFFF00]/10'
                      : highlighted
                        ? 'bg-[#14B8A6]/10'
                        : 'bg-white/[0.02] hover:bg-white/[0.07]'
                  }`}
                >
                  <td className="rounded-l-lg border border-white/[0.08] border-r-0 px-2 py-2">
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
                          className="text-white/50"
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
                        className="max-w-[320px] truncate text-[12px] text-white/85 hover:text-white"
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
                              className="flex items-center justify-center w-5 h-5 rounded text-white/40 hover:text-[#BFFF00] hover:bg-white/[0.06] transition-colors"
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
                              className="flex items-center justify-center w-5 h-5 rounded text-white/40 hover:text-emerald-400 hover:bg-white/[0.06] transition-colors"
                            >
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6 9 17l-5-5" /></svg>
                            </button>
                          ) : null}
                        </div>
                      )}
                    </div>
                  </td>

                  <td className="border border-white/[0.08] border-l-0 border-r-0 px-2 py-2 text-[11px] text-white/75">
                    {editMode ? (
                      <select
                        defaultValue={node.status}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => {
                          void onUpdateNode(node, { status: event.target.value });
                        }}
                        className="rounded border border-white/[0.14] bg-white/[0.05] px-1.5 py-1 text-[10px] text-white/80"
                      >
                        {STATUS_OPTIONS.map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span>{formatEntityStatus(node.status)}</span>
                    )}
                  </td>

                  <td className="border border-white/[0.08] border-l-0 border-r-0 px-2 py-2 text-[11px] text-white/75">
                    {editMode ? (
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
                        className="w-[66px] rounded border border-white/[0.14] bg-white/[0.05] px-1.5 py-1 text-[10px] text-white/80"
                      />
                    ) : (
                      <span>P{node.priorityNum}</span>
                    )}
                  </td>

                  <td className="border border-white/[0.08] border-l-0 border-r-0 px-2 py-2 text-[11px] text-white/75">
                    {editMode ? (
                      <input
                        type="datetime-local"
                        defaultValue={toLocalInputValue(node.etaEndAt)}
                        onClick={(event) => event.stopPropagation()}
                        onBlur={(event) => {
                          const value = event.currentTarget.value;
                          void onUpdateNode(node, { eta_end_at: value ? new Date(value).toISOString() : null });
                        }}
                        className="w-[170px] rounded border border-white/[0.14] bg-white/[0.05] px-1.5 py-1 text-[10px] text-white/80"
                      />
                    ) : (
                      <span>{node.etaEndAt ? new Date(node.etaEndAt).toLocaleString() : '—'}</span>
                    )}
                  </td>

                  <td className="border border-white/[0.08] border-l-0 border-r-0 px-2 py-2 text-[11px] text-white/75">
                    {editMode ? (
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
                        className="w-[82px] rounded border border-white/[0.14] bg-white/[0.05] px-1.5 py-1 text-[10px] text-white/80"
                      />
                    ) : (
                      <span>{node.expectedDurationHours}</span>
                    )}
                  </td>

                  <td className="border border-white/[0.08] border-l-0 border-r-0 px-2 py-2 text-[11px] text-white/75">
                    {editMode ? (
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

                  <td className="rounded-r-lg border border-white/[0.08] border-l-0 px-2 py-2 text-[11px] text-white/75">
                    {editMode ? (
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
                        className="w-[220px] rounded border border-white/[0.14] bg-white/[0.05] px-1.5 py-1 text-[10px] text-white/80"
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {edges.length > 0 && (
        <div className="mt-2 text-[10px] text-white/35">
          Showing {rows.length} rows and {edges.length} dependency links.
        </div>
      )}
      <div className="mt-1 text-[10px] text-white/30">
        Workstream rows set dependency-map focus. Milestone/task rows highlight dependency path.
      </div>
    </section>
  );
}

