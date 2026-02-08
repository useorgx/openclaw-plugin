import type { MissionControlNode } from '@/types';
import { colors } from '@/lib/tokens';
import { LevelIcon } from './LevelIcon';

interface RecentTodosRailProps {
  recentTodoIds: string[];
  nodesById: Map<string, MissionControlNode>;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}

export function RecentTodosRail({
  recentTodoIds,
  nodesById,
  selectedNodeId,
  onSelectNode,
}: RecentTodosRailProps) {
  const recentNodes = recentTodoIds
    .map((id) => nodesById.get(id))
    .filter((node): node is MissionControlNode => Boolean(node))
    .slice(0, 14);

  if (recentNodes.length === 0) return null;

  return (
    <section className="space-y-1.5 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[11px] uppercase tracking-[0.08em] text-white/45">
          Next-up tasks
        </h4>
        <span className="text-[10px] text-white/35">{recentNodes.length}</span>
      </div>
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {recentNodes.map((node) => (
          <button
            key={node.id}
            type="button"
            onClick={() => onSelectNode(node.id)}
            className={`flex flex-shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
              selectedNodeId === node.id
                ? 'border-[#BFFF00]/30 bg-[#BFFF00]/12'
                : 'border-white/[0.1] bg-white/[0.02] hover:bg-white/[0.08]'
            }`}
          >
            <LevelIcon type={node.type} />
            <span className="max-w-[220px] truncate text-[11px] text-white/80">
              {node.title}
            </span>
            <span
              className="rounded-full px-1.5 py-0.5 text-[9px]"
              style={{
                backgroundColor: `${colors.amber}22`,
                color: `${colors.amber}`,
              }}
            >
              P{node.priorityNum}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
