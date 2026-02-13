import type { MissionControlNode } from '@/types';
import { colors } from '@/lib/tokens';
import { LevelIcon } from './LevelIcon';

interface RecentTodosRailProps {
  recentTodoIds: string[];
  nodesById: Map<string, MissionControlNode>;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}

function dueLabel(value: string | null): string {
  if (!value) return 'No target date';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'No target date';
  return `Due ${parsed.toLocaleDateString()}`;
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
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-micro uppercase tracking-[0.08em] text-muted">
          Queue overview
        </span>
        <span className="rounded-full border border-white/15 bg-black/20 px-2 py-0.5 text-micro text-secondary">
          {recentNodes.length} in queue
        </span>
      </div>

      <button
        type="button"
        onClick={() => onSelectNode(primary.id)}
        className={`surface-hero group w-full rounded-xl border px-3.5 py-3 text-left transition-colors ${
          selectedNodeId === primary.id
            ? 'border-[#BFFF00]/35 bg-[#BFFF00]/14'
            : 'border-white/15 bg-black/25 hover:border-white/30 hover:bg-white/[0.08]'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="inline-flex items-center gap-1.5 text-micro uppercase tracking-[0.1em] text-secondary">
              <LevelIcon type={primary.type} />
              <span>Priority task</span>
            </div>
            <p className="mt-1 line-clamp-2 text-body font-semibold leading-snug text-white">
              {primary.title}
            </p>
            <p className="mt-1 text-caption text-secondary">{dueLabel(primary.dueDate)}</p>
          </div>
          <span
            className="inline-flex flex-shrink-0 rounded-full border px-2 py-0.5 text-micro font-semibold"
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

      {queued.length > 0 && (
        <div className="space-y-1.5">
          {queued.map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => onSelectNode(node.id)}
              className={`flex min-h-[62px] min-w-0 items-start justify-between gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                selectedNodeId === node.id
                  ? 'border-[#BFFF00]/30 bg-[#BFFF00]/12'
                  : 'border-strong bg-black/20 hover:bg-white/[0.08]'
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="inline-flex items-center gap-1.5 text-micro uppercase tracking-[0.08em] text-secondary">
                  <LevelIcon type={node.type} />
                  <span>Queued</span>
                </div>
                <p className="mt-1 line-clamp-1 break-words text-caption leading-snug text-bright" title={node.title}>
                  {node.title}
                </p>
                <p className="mt-1 text-micro text-secondary">{dueLabel(node.dueDate)}</p>
              </div>
              <span
                className="inline-flex flex-shrink-0 rounded-full px-1.5 py-0.5 text-micro"
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
      )}
    </section>
  );
}
