import { useMemo } from 'react';
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

  const visibleNodes = nodes.filter((node) => visibleNodeIds.has(node.id));
  const grouped = {
    initiative: visibleNodes.filter((node) => node.type === 'initiative'),
    workstream: visibleNodes.filter((node) => node.type === 'workstream'),
    milestone: visibleNodes.filter((node) => node.type === 'milestone'),
    task: visibleNodes.filter((node) => node.type === 'task'),
  };

  const visibleEdges = edges.filter(
    (edge) => visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to)
  );

  if (visibleNodes.length === 0) return null;

  return (
    <section className="space-y-2 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[11px] uppercase tracking-[0.08em] text-white/45">
          Dependency map
        </h4>
        {focusedWorkstreamId && (
          <span className="text-[10px] rounded-full border border-[#BFFF00]/25 bg-[#BFFF00]/10 px-2 py-0.5 text-[#D8FFA1]">
            Focused workstream
          </span>
        )}
      </div>

      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {(Object.keys(grouped) as Array<keyof typeof grouped>).map((groupKey) => (
          <div key={groupKey} className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-2">
            <div className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-white/35">
              {groupLabel(groupKey)}
            </div>
            <div className="space-y-1">
              {grouped[groupKey].slice(0, 8).map((node) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => onSelectNode(node.id)}
                  className={`flex w-full items-center gap-1.5 rounded-md border px-2 py-1 text-left transition-colors ${
                    selectedNodeId === node.id
                      ? 'border-[#BFFF00]/35 bg-[#BFFF00]/10'
                      : 'border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.08]'
                  }`}
                >
                  <LevelIcon type={node.type} />
                  <span className="truncate text-[11px] text-white/80">{node.title}</span>
                </button>
              ))}
              {grouped[groupKey].length > 8 && (
                <div className="px-1 text-[10px] text-white/35">
                  +{grouped[groupKey].length - 8} more
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

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

