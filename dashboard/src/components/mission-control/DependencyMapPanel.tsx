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
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-micro uppercase tracking-[0.08em] text-muted">
          {visibleNodes.length} nodes &middot; {visibleEdges.length} links
        </span>
        {focusedWorkstreamId && (
          <span className="status-pill" data-tone="active">
            Focused workstream
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter nodes..."
          className="h-9 flex-1 min-w-[200px] rounded-lg border border-strong bg-black/30 px-3 text-caption text-primary placeholder:text-faint transition-colors focus:border-[#BFFF00]/35 focus:outline-none"
        />
        {selectedNodeId && (
          <button
            type="button"
            onClick={() => setRelatedOnly((prev) => !prev)}
            aria-pressed={relatedOnly}
            data-state={relatedOnly ? 'active' : 'idle'}
            className="control-pill px-3 text-caption font-semibold"
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
            className="control-pill px-3 text-caption"
          >
            Reset
          </button>
        )}
      </div>

      {visibleNodes.length === 0 ? (
        <div className="rounded-xl border border-white/[0.07] bg-black/[0.14] px-3 py-3 text-caption text-secondary">
          No nodes match this view. Clear filters or select a different node to see connected work.
        </div>
      ) : (
        <div className={`grid gap-2 ${Object.values(grouped).filter(g => g.length > 0).length <= 2 ? 'grid-cols-1 sm:grid-cols-2' : 'md:grid-cols-2 xl:grid-cols-4'}`}>
          {(Object.keys(grouped) as Array<keyof typeof grouped>).filter((groupKey) => grouped[groupKey].length > 0).map((groupKey) => (
            <div key={groupKey} className="rounded-xl border border-white/[0.07] bg-black/[0.14] p-2.5">
              <div className="mb-1.5 text-micro uppercase tracking-[0.09em] text-secondary">
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
                          ? 'border-[#BFFF00]/35 bg-[#BFFF00]/12'
                          : related
                            ? 'border-[#14B8A6]/35 bg-[#14B8A6]/12'
                            : 'border-strong bg-white/[0.03] hover:bg-white/[0.08]'
                      }`}
                    >
                      <LevelIcon type={node.type} />
                      <span className="truncate text-caption text-primary">{node.title}</span>
                    </button>
                  );
                })}
                {grouped[groupKey].length > 10 && (
                  <div className="px-1 text-micro text-muted">
                    +{grouped[groupKey].length - 10} more
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {visibleEdges.length > 0 && (
        <div className="rounded-xl border border-white/[0.07] bg-black/[0.14] px-2.5 py-2">
          <div className="mb-1 text-micro uppercase tracking-[0.08em] text-muted">
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
                  <span className="truncate text-micro text-primary">{from.title}</span>
                  <span className="text-micro text-muted">→</span>
                  <span className="truncate text-micro text-primary">{to.title}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
