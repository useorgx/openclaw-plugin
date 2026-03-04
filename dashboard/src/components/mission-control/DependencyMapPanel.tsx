import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MissionControlEdge, MissionControlNode } from '@/types';
import { colors } from '@/lib/tokens';
import { LevelIcon } from './LevelIcon';

interface DependencyMapPanelProps {
  nodes: MissionControlNode[];
  edges: MissionControlEdge[];
  selectedNodeId: string | null;
  focusedWorkstreamId: string | null;
  onSelectNode: (nodeId: string) => void;
}

const COLUMN_ORDER: MissionControlNode['type'][] = ['initiative', 'workstream', 'milestone', 'task'];
const COLUMN_LABELS: Record<string, string> = {
  initiative: 'Initiatives',
  workstream: 'Workstreams',
  milestone: 'Milestones',
  task: 'Tasks',
};
const MAX_PER_COLUMN = 8;
const MAX_NODES = 30;

function statusDotColor(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'blocked') return colors.red ?? '#f87171';
  if (normalized === 'done' || normalized === 'completed') return colors.teal;
  if (['in_progress', 'active', 'running', 'queued'].includes(normalized)) return colors.lime;
  return 'rgba(255,255,255,0.35)';
}

export function DependencyMapPanel({
  nodes,
  edges,
  selectedNodeId,
  focusedWorkstreamId,
  onSelectNode,
}: DependencyMapPanelProps) {
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pillRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [paths, setPaths] = useState<Array<{ key: string; d: string; highlighted: boolean }>>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const visibleNodeIds = useMemo(() => {
    if (!focusedWorkstreamId) {
      return new Set(nodes.map((node) => node.id));
    }

    const ids = new Set<string>();
    for (const node of nodes) {
      if (
        node.type === 'initiative' ||
        node.id === focusedWorkstreamId ||
        node.workstreamId === focusedWorkstreamId
      ) {
        ids.add(node.id);
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges) {
        if ((ids.has(edge.from) || ids.has(edge.to)) && (!ids.has(edge.from) || !ids.has(edge.to))) {
          ids.add(edge.from);
          ids.add(edge.to);
          changed = true;
        }
      }
    }

    return ids;
  }, [focusedWorkstreamId, nodes, edges]);

  // Group visible nodes by type, capped
  const grouped = useMemo(() => {
    const visibleNodes = nodes.filter((node) => visibleNodeIds.has(node.id));
    const capped = visibleNodes.slice(0, MAX_NODES);
    const groups: Record<string, MissionControlNode[]> = {
      initiative: [],
      workstream: [],
      milestone: [],
      task: [],
    };
    for (const node of capped) {
      groups[node.type]?.push(node);
    }
    return groups;
  }, [nodes, visibleNodeIds]);

  const totalVisible = Object.values(grouped).reduce((sum, g) => sum + g.length, 0);
  const overCap = nodes.filter((node) => visibleNodeIds.has(node.id)).length > MAX_NODES;

  const visibleEdges = useMemo(() => {
    const nodeIdSet = new Set(
      Object.values(grouped)
        .flat()
        .map((n) => n.id)
    );
    return edges.filter((edge) => nodeIdSet.has(edge.from) && nodeIdSet.has(edge.to));
  }, [edges, grouped]);

  // Selected node's dependency chain
  const selectedChain = useMemo(() => {
    if (!selectedNodeId) return new Set<string>();
    const ids = new Set<string>([selectedNodeId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of visibleEdges) {
        if (ids.has(edge.from) && !ids.has(edge.to)) {
          ids.add(edge.to);
          changed = true;
        }
        if (ids.has(edge.to) && !ids.has(edge.from)) {
          ids.add(edge.from);
          changed = true;
        }
      }
    }
    return ids;
  }, [selectedNodeId, visibleEdges]);

  // Compute SVG paths between connected pills
  const computePaths = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const newPaths: Array<{ key: string; d: string; highlighted: boolean }> = [];

    for (const edge of visibleEdges) {
      const fromEl = pillRefs.current.get(edge.from);
      const toEl = pillRefs.current.get(edge.to);
      if (!fromEl || !toEl) continue;

      const fromRect = fromEl.getBoundingClientRect();
      const toRect = toEl.getBoundingClientRect();

      const x1 = fromRect.right - containerRect.left;
      const y1 = fromRect.top + fromRect.height / 2 - containerRect.top;
      const x2 = toRect.left - containerRect.left;
      const y2 = toRect.top + toRect.height / 2 - containerRect.top;

      const cpOffset = Math.min(Math.abs(x2 - x1) * 0.4, 60);
      const d = `M ${x1} ${y1} C ${x1 + cpOffset} ${y1}, ${x2 - cpOffset} ${y2}, ${x2} ${y2}`;
      const highlighted =
        selectedNodeId !== null &&
        (selectedChain.has(edge.from) && selectedChain.has(edge.to));

      newPaths.push({ key: `${edge.from}-${edge.to}`, d, highlighted });
    }

    setPaths(newPaths);
  }, [visibleEdges, selectedNodeId, selectedChain]);

  useLayoutEffect(() => {
    computePaths();
  }, [computePaths, grouped, expanded]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => computePaths());
    observer.observe(container);
    return () => observer.disconnect();
  }, [computePaths]);

  const activeColumns = COLUMN_ORDER.filter((type) => (grouped[type]?.length ?? 0) > 0);

  if (totalVisible === 0) {
    return (
      <div className="rounded-xl border border-white/[0.07] bg-black/[0.14] px-3 py-3 text-caption text-secondary">
        No dependencies mapped
      </div>
    );
  }

  const setPillRef = (nodeId: string, el: HTMLButtonElement | null) => {
    if (el) {
      pillRefs.current.set(nodeId, el);
    } else {
      pillRefs.current.delete(nodeId);
    }
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-micro uppercase tracking-[0.08em] text-muted">
          {totalVisible} nodes · {visibleEdges.length} links
        </span>
        {focusedWorkstreamId && (
          <span className="status-pill" data-tone="active">
            Focused workstream
          </span>
        )}
      </div>

      <div
        ref={containerRef}
        className="relative overflow-x-auto rounded-xl border border-white/[0.07] bg-black/[0.14] p-3"
      >
        {/* SVG connection lines */}
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          style={{ zIndex: 1 }}
        >
          {paths.map(({ key, d, highlighted }) => (
            <path
              key={key}
              d={d}
              fill="none"
              stroke={highlighted ? colors.lime : 'rgba(255,255,255,0.12)'}
              strokeWidth={highlighted ? 1.5 : 1}
              strokeDasharray={highlighted ? undefined : '4 3'}
              opacity={highlighted ? 0.85 : 0.5}
            />
          ))}
        </svg>

        {/* Swimlane columns */}
        <div className="relative z-[2] flex gap-3" style={{ minWidth: activeColumns.length * 160 }}>
          {activeColumns.map((type) => {
            const items = grouped[type] ?? [];
            const isExpanded = expanded.has(type);
            const visible = isExpanded ? items : items.slice(0, MAX_PER_COLUMN);
            const hiddenCount = items.length - visible.length;

            return (
              <div key={type} className="flex-1 min-w-[140px]">
                <div className="mb-2 text-micro uppercase tracking-[0.09em] text-secondary">
                  {COLUMN_LABELS[type]} ({items.length})
                </div>
                <div className="space-y-1">
                  {visible.map((node) => {
                    const selected = selectedNodeId === node.id;
                    const inChain = !selected && selectedChain.has(node.id);

                    return (
                      <button
                        key={node.id}
                        ref={(el) => setPillRef(node.id, el)}
                        type="button"
                        onClick={() => onSelectNode(node.id)}
                        title={node.title}
                        className={`flex w-full items-center gap-1.5 rounded-md border px-2 py-1 text-left transition-colors ${
                          selected
                            ? 'border-[#BFFF00]/35 bg-[#BFFF00]/12'
                            : inChain
                              ? 'border-[#BFFF00]/20 bg-[#BFFF00]/[0.06]'
                              : 'border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.08]'
                        }`}
                      >
                        <span
                          className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                          style={{ backgroundColor: statusDotColor(node.status) }}
                        />
                        <span className="max-w-[140px] truncate text-micro text-primary">
                          {node.title}
                        </span>
                      </button>
                    );
                  })}
                  {hiddenCount > 0 && !isExpanded && (
                    <button
                      type="button"
                      onClick={() => setExpanded((prev) => new Set([...prev, type]))}
                      className="w-full rounded-md px-2 py-1 text-center text-micro text-muted transition-colors hover:bg-white/[0.04] hover:text-secondary"
                    >
                      Show all ({items.length})
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {overCap && (
        <div className="text-micro text-muted">
          Showing {MAX_NODES} of {nodes.filter((n) => visibleNodeIds.has(n.id)).length} nodes. Focus a workstream to narrow scope.
        </div>
      )}
    </section>
  );
}
