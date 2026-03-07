import { useState } from 'react';
import type { MissionControlNode } from '@/types';
import { LevelIcon } from './LevelIcon';

interface RecentTodosRailProps {
  recentTodoIds: string[];
  nodesById: Map<string, MissionControlNode>;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}

function relativeEta(iso: string | null): { label: string; tone: 'overdue' | 'soon' | 'normal' | 'none' } {
  if (!iso) return { label: '—', tone: 'none' };
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { label: '—', tone: 'none' };
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < -1) return { label: `${Math.abs(diffDays)}d overdue`, tone: 'overdue' };
  if (diffDays === -1) return { label: 'Yesterday', tone: 'overdue' };
  if (diffDays === 0) return { label: 'Today', tone: 'soon' };
  if (diffDays === 1) return { label: 'Tomorrow', tone: 'soon' };
  if (diffDays <= 7) return { label: `In ${diffDays} days`, tone: 'soon' };
  const month = date.toLocaleString('en-US', { month: 'short' });
  const day = date.getDate();
  return { label: `${month} ${day}`, tone: 'normal' };
}

function dueLabel(value: string | null): { label: string; tone: 'overdue' | 'soon' | 'normal' | 'none' } {
  if (!value) return { label: 'No target date', tone: 'none' };
  const eta = relativeEta(value);
  if (eta.tone === 'none') return { label: 'No target date', tone: 'none' };
  return eta;
}

function isOverdue(dueDate: string | null): boolean {
  if (!dueDate) return false;
  const date = new Date(dueDate);
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() < Date.now();
}

function entityTypeLabel(type: MissionControlNode['type']): string {
  if (type === 'milestone') return 'Milestone';
  if (type === 'workstream') return 'Workstream';
  return 'Task';
}

const VISIBLE_QUEUE_COUNT = 5;

export function RecentTodosRail({
  recentTodoIds,
  nodesById,
  selectedNodeId,
  onSelectNode,
}: RecentTodosRailProps) {
  const [showAll, setShowAll] = useState(false);

  const recentNodes = recentTodoIds
    .map((id) => nodesById.get(id))
    .filter((node): node is MissionControlNode => Boolean(node))
    .sort((a, b) => {
      // Overdue items sort to top
      const aOverdue = isOverdue(a.dueDate);
      const bOverdue = isOverdue(b.dueDate);
      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
      if (a.priorityNum !== b.priorityNum) return a.priorityNum - b.priorityNum;
      const aDue = a.dueDate ? Date.parse(a.dueDate) : Number.POSITIVE_INFINITY;
      const bDue = b.dueDate ? Date.parse(b.dueDate) : Number.POSITIVE_INFINITY;
      return aDue - bDue;
    })
    .slice(0, 14);

  if (recentNodes.length === 0) return null;

  const primary = recentNodes[0];
  const primaryDue = dueLabel(primary.dueDate);
  const primaryOverdue = isOverdue(primary.dueDate);
  const allQueued = recentNodes.slice(1);
  const queued = showAll ? allQueued : allQueued.slice(0, VISIBLE_QUEUE_COUNT - 1);
  const hiddenCount = allQueued.length - queued.length;

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
          primaryOverdue ? 'border-l-2 border-l-red-400/60 ' : ''
        }${
          selectedNodeId === primary.id
            ? 'border-lime/35 bg-lime/14'
            : 'border-white/15 bg-black/25 hover:border-white/30 hover:bg-white/[0.08]'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="inline-flex items-center gap-1.5 text-micro uppercase tracking-[0.1em] text-secondary">
              <LevelIcon type={primary.type} />
              <span>{entityTypeLabel(primary.type)}</span>
            </div>
            <p className="mt-1 line-clamp-2 text-body font-semibold leading-snug text-white">
              {primary.title}
            </p>
            <p className={`mt-1 text-caption ${primaryDue.tone === 'overdue' ? 'text-red-300/90' : primaryDue.tone === 'soon' ? 'text-amber-200/85' : 'text-secondary'}`}>
              {primaryDue.label}
            </p>
          </div>
          {primary.priorityNum <= 30 && (
            <span
              className={`inline-flex flex-shrink-0 text-micro tracking-[0.02em] ${
                primary.priorityNum <= 12 ? 'font-bold text-red-200/90' : 'font-semibold text-amber-100/80'
              }`}
            >
              {primary.priorityNum <= 12 ? 'Urgent' : 'High'}
            </span>
          )}
        </div>
      </button>

      {queued.length > 0 && (
        <div className="space-y-1.5">
          {queued.map((node) => {
            const nodeDue = dueLabel(node.dueDate);
            const nodeOverdue = isOverdue(node.dueDate);
            return (
              <button
                key={node.id}
                type="button"
                onClick={() => onSelectNode(node.id)}
                className={`flex min-h-[54px] min-w-0 items-start justify-between gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                  nodeOverdue ? 'border-l-2 border-l-red-400/60 ' : ''
                }${
                  selectedNodeId === node.id
                    ? 'border-lime/30 bg-lime/12'
                    : 'border-strong bg-black/20 hover:bg-white/[0.08]'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="inline-flex items-center gap-1.5 text-micro uppercase tracking-[0.08em] text-secondary">
                    <LevelIcon type={node.type} />
                    <span>{entityTypeLabel(node.type)}</span>
                  </div>
                  <p className="mt-1 line-clamp-1 break-words text-caption leading-snug text-bright" title={node.title}>
                    {node.title}
                  </p>
                  <p className={`mt-1 text-micro ${nodeDue.tone === 'overdue' ? 'text-red-300/90' : nodeDue.tone === 'soon' ? 'text-amber-200/85' : 'text-secondary'}`}>
                    {nodeDue.label}
                  </p>
                </div>
                {node.priorityNum <= 30 && (
                  <span
                    className={`inline-flex flex-shrink-0 text-micro tracking-[0.02em] ${
                      node.priorityNum <= 12 ? 'font-bold text-red-200/90' : 'font-semibold text-amber-100/80'
                    }`}
                  >
                    {node.priorityNum <= 12 ? 'Urgent' : 'High'}
                  </span>
                )}
              </button>
            );
          })}
          {hiddenCount > 0 && !showAll && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="w-full rounded-lg px-2.5 py-1.5 text-center text-micro text-secondary transition-colors hover:bg-white/[0.04] hover:text-primary"
            >
              View all ({allQueued.length + 1})
            </button>
          )}
        </div>
      )}
    </section>
  );
}
