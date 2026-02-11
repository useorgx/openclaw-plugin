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
    .sort((a, b) => {
      if (a.priorityNum !== b.priorityNum) return a.priorityNum - b.priorityNum;
      const aDue = a.dueDate ? Date.parse(a.dueDate) : Number.POSITIVE_INFINITY;
      const bDue = b.dueDate ? Date.parse(b.dueDate) : Number.POSITIVE_INFINITY;
      return aDue - bDue;
    })
    .slice(0, 14);

  if (recentNodes.length === 0) return null;

  const primary = recentNodes[0];
  const queued = recentNodes.slice(1, 7);

  return (
    <section className="surface-hero space-y-2 rounded-xl p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[11px] uppercase tracking-[0.11em] text-white/65">
          Next Up
        </h4>
        <span className="rounded-full border border-white/15 bg-black/20 px-2 py-0.5 text-[10px] text-white/65">
          {recentNodes.length} in queue
        </span>
      </div>

      <button
        type="button"
        onClick={() => onSelectNode(primary.id)}
        className={`group w-full rounded-xl border px-3.5 py-3 text-left transition-colors ${
          selectedNodeId === primary.id
            ? 'border-[#BFFF00]/35 bg-[#BFFF00]/14'
            : 'border-white/15 bg-black/25 hover:border-white/30 hover:bg-white/[0.08]'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] text-white/50">
              <LevelIcon type={primary.type} />
              <span>Priority task</span>
            </div>
            <p className="mt-1 line-clamp-2 text-[13px] font-semibold leading-snug text-white">
              {primary.title}
            </p>
            <p className="mt-1 text-[11px] text-white/60">
              {primary.dueDate
                ? `Due ${new Date(primary.dueDate).toLocaleDateString()}`
                : 'No target date set'}
            </p>
          </div>
          <span
            className="rounded-full border px-2 py-0.5 text-[10px] font-semibold"
            style={{
              borderColor: `${colors.amber}44`,
              backgroundColor: `${colors.amber}22`,
              color: colors.amber,
            }}
          >
            P{primary.priorityNum}
          </span>
        </div>
      </button>

      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {queued.map((node) => (
          <button
            key={node.id}
            type="button"
            onClick={() => onSelectNode(node.id)}
            className={`flex flex-shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
              selectedNodeId === node.id
                ? 'border-[#BFFF00]/30 bg-[#BFFF00]/12'
                : 'border-white/[0.14] bg-black/20 hover:bg-white/[0.08]'
            }`}
          >
            <LevelIcon type={node.type} />
            <span className="max-w-[220px] truncate text-[11px] text-white/82">
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
