import { useMemo, useState } from 'react';
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

function groupLabel(type: MissionControlNode['type']): string {
  if (type === 'initiative') return 'Initiatives';
  if (type === 'workstream') return 'Workstreams';
  if (type === 'milestone') return 'Milestones';
  return 'Tasks';
}

export function DependencyMapPanel({
  nodes,
  edges,
  selectedNodeId,
  focusedWorkstreamId,
  onSelectNode,
}: DependencyMapPanelProps) {
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const [query, setQuery] = useState('');
  const [relatedOnly, setRelatedOnly] = useState(false);
  const normalizedQuery = query.trim().toLowerCase();

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

  const baseVisibleNodes = nodes.filter((node) => visibleNodeIds.has(node.id));
  const baseVisibleEdges = edges.filter(
    (edge) => visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to)
  );

  const relatedNodeIds = useMemo(() => {
    if (!selectedNodeId) return new Set<string>();
    const ids = new Set<string>([selectedNodeId]);
    for (const edge of baseVisibleEdges) {
      if (edge.from === selectedNodeId) ids.add(edge.to);
      if (edge.to === selectedNodeId) ids.add(edge.from);
    }
    return ids;
  }, [selectedNodeId, baseVisibleEdges]);

  const filteredNodeIds = useMemo(() => {
    let ids = new Set<string>(Array.from(visibleNodeIds));

    if (relatedOnly && selectedNodeId) {
      ids = new Set(Array.from(ids).filter((id) => relatedNodeIds.has(id)));
    }

    if (normalizedQuery.length > 0) {
      ids = new Set(
        Array.from(ids).filter((id) => {
          const node = byId.get(id);
          if (!node) return false;
          return node.title.toLowerCase().includes(normalizedQuery);
        })
      );
    }

    return ids;
  }, [byId, normalizedQuery, relatedNodeIds, relatedOnly, selectedNodeId, visibleNodeIds]);

  const visibleNodes = nodes.filter((node) => filteredNodeIds.has(node.id));
  const visibleEdges = edges.filter(
    (edge) => filteredNodeIds.has(edge.from) && filteredNodeIds.has(edge.to)
  );

  const grouped = {
    initiative: visibleNodes.filter((node) => node.type === 'initiative'),
    workstream: visibleNodes.filter((node) => node.type === 'workstream'),
    milestone: visibleNodes.filter((node) => node.type === 'milestone'),
    task: visibleNodes.filter((node) => node.type === 'task'),
  };

  if (baseVisibleNodes.length === 0) return null;

  return (
    <section className="space-y-2 rounded-xl bg-white/[0.02] p-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h4 className="text-[13px] font-semibold tracking-[-0.01em] text-white/70">
            Dependency map
          </h4>
          <span className="text-[10px] text-white/30">
            {visibleNodes.length} nodes &middot; {visibleEdges.length} links
          </span>
        </div>
        {focusedWorkstreamId && (
          <span className="text-[10px] rounded-full border border-[#BFFF00]/25 bg-[#BFFF00]/10 px-2 py-0.5 text-[#D8FFA1]">
            Focused workstream
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter nodes..."
          className="h-9 flex-1 min-w-[200px] rounded-lg border border-white/[0.12] bg-black/30 px-3 text-[11px] text-white/80 placeholder:text-white/25 focus:border-[#BFFF00]/40 focus:outline-none"
        />
        {selectedNodeId && (
          <button
            type="button"
            onClick={() => setRelatedOnly((prev) => !prev)}
            aria-pressed={relatedOnly}
            className={`h-9 rounded-full border px-3 text-[11px] font-semibold transition-colors ${
              relatedOnly
                ? 'border-[#BFFF00]/30 bg-[#BFFF00]/15 text-[#D8FFA1]'
                : 'border-white/[0.12] bg-white/[0.03] text-white/70 hover:bg-white/[0.06]'
            }`}
            title="Show only the selected node and its direct neighbors"
          >
            Related only
          </button>
        )}
        {(query.trim().length > 0 || relatedOnly) && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setRelatedOnly(false);
            }}
            className="h-9 rounded-full border border-white/[0.12] bg-white/[0.03] px-3 text-[11px] text-white/70 transition-colors hover:bg-white/[0.06]"
          >
            Reset
          </button>
        )}
      </div>

      {visibleNodes.length === 0 ? (
        <div className="rounded-lg bg-white/[0.02] px-3 py-3 text-[11px] text-white/40">
          No nodes match the current filter.
        </div>
      ) : (
        <div className={`grid gap-2 ${Object.values(grouped).filter(g => g.length > 0).length <= 2 ? 'grid-cols-1 sm:grid-cols-2' : 'md:grid-cols-2 xl:grid-cols-4'}`}>
          {(Object.keys(grouped) as Array<keyof typeof grouped>).filter((groupKey) => grouped[groupKey].length > 0).map((groupKey) => (
            <div key={groupKey} className="rounded-lg bg-white/[0.02] p-2">
              <div className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-white/35">
                {groupLabel(groupKey)} ({grouped[groupKey].length})
              </div>
              <div className="space-y-1">
                {grouped[groupKey].slice(0, 10).map((node) => {
                  const selected = selectedNodeId === node.id;
                  const related = !selected && relatedNodeIds.has(node.id);

                  return (
                    <button
                      key={node.id}
                      type="button"
                      onClick={() => onSelectNode(node.id)}
                      title={node.title}
                      className={`flex w-full items-center gap-1.5 rounded-md border px-2 py-1 text-left transition-colors ${
                        selected
                          ? 'border-[#BFFF00]/35 bg-[#BFFF00]/10'
                          : related
                            ? 'border-[#14B8A6]/35 bg-[#14B8A6]/10'
                            : 'border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.08]'
                      }`}
                    >
                      <LevelIcon type={node.type} />
                      <span className="truncate text-[11px] text-white/80">{node.title}</span>
                    </button>
                  );
                })}
                {grouped[groupKey].length > 10 && (
                  <div className="px-1 text-[10px] text-white/35">
                    +{grouped[groupKey].length - 10} more
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {visibleEdges.length > 0 && (
        <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-white/35">
            Dependency links
          </div>
          <div className="max-h-[110px] space-y-1 overflow-auto pr-1">
            {visibleEdges.slice(0, 36).map((edge) => {
              const from = byId.get(edge.from);
              const to = byId.get(edge.to);
              if (!from || !to) return null;
              const highlighted =
                selectedNodeId === from.id || selectedNodeId === to.id;

              return (
                <button
                  key={`${edge.from}-${edge.to}`}
                  type="button"
                  onClick={() => onSelectNode(to.id)}
                  className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left hover:bg-white/[0.06]"
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: highlighted ? colors.lime : 'rgba(255,255,255,0.35)' }}
                  />
                  <span className="truncate text-[10px] text-white/70">{from.title}</span>
                  <span className="text-[10px] text-white/30">→</span>
                  <span className="truncate text-[10px] text-white/70">{to.title}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
